// Package cfp speaks Cloudflare AI Playground's anonymous `cf_agent` WebSocket
// protocol. The playground exposes 20 open-weight models (GLM, DeepSeek V4,
// Kimi, GPT-OSS, Llama, Qwen, ...) with no account and no API key; the only
// gate is a browser-grade TLS fingerprint on the WS upgrade, which this client
// satisfies with a uTLS Chrome ClientHello instead of a headless browser.
//
// Protocol (captured from the playground web app):
//
//	wss://playground.ai.cloudflare.com/agents/playground/<room>?_pk=<uuid>
//	→ {"type":"cf_agent_stream_resume_request"}
//	→ {"type":"rpc","id":"cfg","method":"setConfig","args":[{model,temperature,stream}]}
//	← {"type":"rpc","id":"cfg","done":true,"success":true}   (chat must wait for this ack)
//	→ {"id":<chatID>,"type":"cf_agent_use_chat_request","init":{"method":"POST","body":"<json>"}}
//	← cf_agent_use_chat_response frames: body is a JSON *string* holding
//	  {"type":"start"|"text-delta"|"reasoning-delta"|"finish", ...}
//
// Upstream rate limits arrive in-band as error frames.
package cfp

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	utls "github.com/refraction-networking/utls"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/egress"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/sourceip"
)

const (
	wsHost   = "playground.ai.cloudflare.com:443"
	wsOrigin = "https://playground.ai.cloudflare.com"
	wsPath   = "/agents/playground/"
	// ModelPrefix is what the playground expects on its upstream model ids.
	ModelPrefix = "@cf/"
	userAgent   = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
)

// Message is one chat turn.
//
// `content` arrives in TWO wire shapes and both must parse. The string form is
// the canonical one; the ARRAY form ({[{"type":"text","text":"..."}, ...]}) is
// what every OpenAI-compatible SDK sends once a caller passes a part list, and
// a plain `Content string` rejected the whole request with
// "cannot unmarshal array into Go struct field Message.messages.content" —
// measured live on two customer keys. The array is folded to text at decode
// time (the playground has no image input), so the rest of the client keeps
// reading Content and never learns which shape arrived.
//
// The playground drops system turns (its persona is server-side), so callers
// should fold instructions into the user turn.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
	// Parts is populated only when the request used the array form; Content is
	// the folded text either way.
	Parts []ContentPart `json:"-"`
}

// ContentPart is one element of the OpenAI multimodal content array.
type ContentPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// UnmarshalJSON accepts `content` as a string OR an array of parts.
func (m *Message) UnmarshalJSON(b []byte) error {
	var raw struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	m.Role = raw.Role
	m.Content = ""
	m.Parts = nil
	c := bytes.TrimSpace(raw.Content)
	switch {
	case len(c) == 0 || string(c) == "null":
		return nil
	case c[0] == '"':
		return json.Unmarshal(c, &m.Content)
	case c[0] == '[':
		var parts []ContentPart
		if err := json.Unmarshal(c, &parts); err != nil {
			return err
		}
		m.Parts = parts
		m.Content = foldParts(parts)
		return nil
	default:
		return fmt.Errorf("cfp: unsupported content shape %s", truncate(string(c), 32))
	}
}

// foldParts joins a multimodal content array's text members. Non-text parts
// (images, audio) are dropped rather than rejected: the playground protocol
// carries text only, and failing the request over a part we would ignore is
// worse than answering the text the caller did send.
func foldParts(parts []ContentPart) string {
	var b strings.Builder
	for _, p := range parts {
		if p.Text == "" {
			continue
		}
		if b.Len() > 0 {
			b.WriteString("\n")
		}
		b.WriteString(p.Text)
	}
	return b.String()
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// Options is one completion request.
type Options struct {
	Model       string
	Messages    []Message
	Temperature float64
	// OnDelta receives streamed fragments. kind is "text" or "reasoning".
	OnDelta func(kind, delta string)
	// The router supplies the SAME connection policy as HTTP; a native WS
	// path must not silently keep rotating when its connection opts into sticky.
	DialContext func(context.Context, string, string) (net.Conn, error)
	OnReject    func(actualIP net.IP, status int)
}

// Result is the aggregated completion.
type Result struct {
	Text      string
	Reasoning string
	Finish    string
	Model     string
}

// Error carries an HTTP-ish status so the router can classify it (429 for rate
// limits, 502 for upstream faults).
type Error struct {
	Status int
	Msg    string
}

func (e *Error) Error() string { return e.Msg }

func newUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// dialTLS opens a TCP connection carrying a Chrome-fingerprinted TLS session.
// Chrome's baked ClientHello advertises h2; a WebSocket upgrade needs
// HTTP/1.1, so ALPN is patched to http/1.1 and nothing else is touched.
//
// Each dial binds a DIFFERENT local IPv6 source address from the host's pool.
// Cloudflare rate-limits concurrent playground sessions per source IP, so a
// single address stalls once ~a dozen sockets are in flight; rotating the /128
// per connection turns that wall into a non-issue.
func dialTLS(ctx context.Context, dial func(context.Context, string, string) (net.Conn, error)) (net.Conn, error) {
	raw, err := dial(ctx, "tcp", wsHost)
	if err != nil {
		return nil, err
	}
	spec, err := utls.UTLSIdToSpec(utls.HelloChrome_Auto)
	if err != nil {
		raw.Close()
		return nil, err
	}
	for i := range spec.Extensions {
		if alpn, ok := spec.Extensions[i].(*utls.ALPNExtension); ok {
			alpn.AlpnProtocols = []string{"http/1.1"}
		}
	}
	cfg := &utls.Config{ServerName: "playground.ai.cloudflare.com", NextProtos: []string{"http/1.1"}}
	c := utls.UClient(raw, cfg, utls.HelloCustom)
	if err := c.ApplyPreset(&spec); err != nil {
		raw.Close()
		return nil, err
	}
	if err := c.HandshakeContext(ctx); err != nil {
		raw.Close()
		return nil, err
	}
	return c, nil
}

func uptreamModel(model string) string {
	if strings.HasPrefix(model, ModelPrefix) {
		return model
	}
	return ModelPrefix + model
}

// Chat runs one completion over a fresh playground session.
func Chat(ctx context.Context, opt Options) (result *Result, chatErr error) {
	model := strings.TrimSpace(opt.Model)
	if model == "" {
		return nil, &Error{Status: 400, Msg: "cfp: model is required"}
	}
	temp := opt.Temperature
	if temp <= 0 {
		temp = 0.7
	}
	chatID := newUUID()
	room := "playground-" + strings.ReplaceAll(newUUID(), "-", "")[:25]
	url := "ws://" + "playground.ai.cloudflare.com" + wsPath + room + "?_pk=" + newUUID()

	var actualIP net.IP
	rawDial := func(ctx context.Context, network, address string) (net.Conn, error) {
		var conn net.Conn
		var err error
		if opt.DialContext != nil {
			conn, err = opt.DialContext(ctx, network, address)
		} else {
			conn, err = egress.DialSource(ctx, network, address, sourceip.Pick(), true)
		}
		if err == nil {
			if local, ok := conn.LocalAddr().(*net.TCPAddr); ok {
				actualIP = append(net.IP(nil), local.IP...)
			}
		}
		return conn, err
	}
	defer func() {
		rejectSource(opt, actualIP, chatErr)
	}()

	dialer := websocket.Dialer{
		HandshakeTimeout: 25 * time.Second,
		NetDialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialTLS(ctx, rawDial)
		},
	}
	hdr := map[string][]string{"User-Agent": {userAgent}, "Origin": {wsOrigin}}
	ws, resp, err := dialer.DialContext(ctx, url, hdr)
	if err != nil {
		status := 502
		if resp != nil {
			if egress.BurnDuration(resp.StatusCode) > 0 {
				status = resp.StatusCode
			}
			if resp.Body != nil {
				_ = resp.Body.Close()
			}
		}
		return nil, &Error{Status: status, Msg: fmt.Sprintf("cfp: ws upgrade failed: %v", err)}
	}
	defer ws.Close()

	// Fold system turns into the first user turn: the playground drops them.
	var msgs []map[string]any
	var sys []string
	for _, m := range opt.Messages {
		role := strings.ToLower(m.Role)
		if m.Content == "" {
			continue
		}
		if role == "system" || role == "developer" {
			sys = append(sys, m.Content)
			continue
		}
		if role != "user" && role != "assistant" {
			continue
		}
		text := m.Content
		if role == "user" && len(sys) > 0 {
			text = strings.Join(sys, "\n\n") + "\n\n" + text
			sys = nil
		}
		msgs = append(msgs, map[string]any{
			"id":    fmt.Sprintf("m%d", len(msgs)+1),
			"role":  role,
			"parts": []map[string]any{{"type": "text", "text": text}},
		})
	}
	if len(msgs) == 0 {
		return nil, &Error{Status: 400, Msg: "cfp: no user message"}
	}
	body, _ := json.Marshal(map[string]any{"messages": msgs, "trigger": "submit-message"})

	send := func(v any) error {
		b, _ := json.Marshal(v)
		return ws.WriteMessage(websocket.TextMessage, b)
	}
	if err := send(map[string]any{"type": "cf_agent_stream_resume_request"}); err != nil {
		return nil, &Error{Status: 502, Msg: "cfp: " + err.Error()}
	}
	if err := send(map[string]any{
		"type": "rpc", "id": "cfp-config", "method": "setConfig",
		"args": []any{map[string]any{"model": uptreamModel(model), "temperature": temp, "stream": true}},
	}); err != nil {
		return nil, &Error{Status: 502, Msg: "cfp: " + err.Error()}
	}

	res := &Result{Model: model}
	seenStart, chatSent := false, false
	for {
		if dl, ok := ctx.Deadline(); ok {
			_ = ws.SetReadDeadline(dl)
		} else {
			_ = ws.SetReadDeadline(time.Now().Add(120 * time.Second))
		}
		_, raw, rerr := ws.ReadMessage()
		if rerr != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if res.Text != "" {
				// Partial answer already streamed: treat as a clean finish.
				if res.Finish == "" {
					res.Finish = "stop"
				}
				return res, nil
			}
			return nil, &Error{Status: 504, Msg: "cfp: read: " + rerr.Error()}
		}
		var fr struct {
			ID    string          `json:"id"`
			Type  string          `json:"type"`
			Error bool            `json:"error"`
			Done  bool            `json:"done"`
			Body  json.RawMessage `json:"body"`
		}
		if json.Unmarshal(raw, &fr) != nil {
			continue
		}
		if fr.Type == "rpc" && fr.ID == "cfp-config" && fr.Done && !chatSent {
			if err := send(map[string]any{
				"id": chatID, "type": "cf_agent_use_chat_request",
				"init": map[string]any{"method": "POST", "body": string(body)},
			}); err != nil {
				return nil, &Error{Status: 502, Msg: "cfp: " + err.Error()}
			}
			chatSent = true
			continue
		}
		if fr.Type != "cf_agent_use_chat_response" || fr.ID != chatID {
			continue
		}
		if fr.Error {
			return nil, classify(fr.Body)
		}
		if fr.Done {
			if !seenStart {
				continue
			}
			if res.Finish == "" {
				res.Finish = "stop"
			}
			return res, nil
		}
		bodyStr := string(fr.Body)
		var inner string
		if json.Unmarshal(fr.Body, &inner) == nil {
			bodyStr = inner
		}
		var ev struct {
			Type            string `json:"type"`
			Delta           string `json:"delta"`
			MessageMetadata struct {
				FinishReason string `json:"finishReason"`
			} `json:"messageMetadata"`
		}
		if json.Unmarshal([]byte(bodyStr), &ev) != nil {
			continue
		}
		switch ev.Type {
		case "start":
			seenStart = true
		case "text-delta":
			if ev.Delta == "" {
				continue
			}
			res.Text += ev.Delta
			if opt.OnDelta != nil {
				opt.OnDelta("text", ev.Delta)
			}
		case "reasoning-delta":
			if ev.Delta == "" {
				continue
			}
			res.Reasoning += ev.Delta
			if opt.OnDelta != nil {
				opt.OnDelta("reasoning", ev.Delta)
			}
		case "finish":
			if ev.MessageMetadata.FinishReason != "" {
				res.Finish = ev.MessageMetadata.FinishReason
			}
		}
	}
}

// A rejection must retire the address that actually completed the dial, not a
// fresh Pick; pool routes instead use the callback to retire a remote session.
func rejectSource(opt Options, actualIP net.IP, err error) {
	var rejection *Error
	if errors.As(err, &rejection) && egress.BurnDuration(rejection.Status) > 0 {
		if opt.OnReject != nil {
			opt.OnReject(actualIP, rejection.Status)
		} else {
			sourceip.Burn(actualIP, egress.BurnDuration(rejection.Status))
		}
	}
}

func classify(raw json.RawMessage) error {
	detail := strings.Trim(string(raw), "\"")
	var obj struct {
		Message string `json:"message"`
		Details string `json:"details"`
	}
	if json.Unmarshal(raw, &obj) == nil {
		if obj.Details != "" {
			detail = obj.Details
		} else if obj.Message != "" {
			detail = obj.Message
		}
	}
	status := 502
	low := strings.ToLower(detail)
	if strings.Contains(low, "rate") || strings.Contains(low, "limit") || strings.Contains(low, "quota") || strings.Contains(low, "throttl") {
		status = 429
	}
	return &Error{Status: status, Msg: "cfp upstream: " + detail}
}

// IsRateLimited reports whether err is an upstream rate limit.
func IsRateLimited(err error) bool {
	var e *Error
	if errors.As(err, &e) {
		return e.Status == 429
	}
	return false
}
