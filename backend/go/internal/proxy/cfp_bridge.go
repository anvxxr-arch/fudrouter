// CFP bridge: routes a chat completion through Cloudflare AI Playground's
// anonymous WebSocket agent instead of an OpenAI-compatible HTTP endpoint.
//
// The playground needs no credential, so the picked account is irrelevant to
// the upstream call; it is still picked (and reported) so fudrouter's normal
// pool/failover/accounting path stays intact.
package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/cfp"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/egress"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/routing"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/sourceip"
)

var cfpSeq uint64

type cfpClientRequest struct {
	Model       string        `json:"model"`
	Messages    []cfp.Message `json:"messages"`
	Temperature float64       `json:"temperature"`
}

// exchangeCFP performs the completion over the playground WS agent and returns
// an Attempt carrying either a synthesized OpenAI response (2xx) or a
// classified error.
func (lc *lifecycle) exchangeCFP(ctx context.Context, cand *routing.Candidate, a *routing.Attempt, upBody []byte, target *target) *routing.Attempt {
	var creq cfpClientRequest
	if err := json.Unmarshal(upBody, &creq); err != nil {
		a.ErrorCode, a.Retryable = routing.ErrCodeInvalidRequest, false
		a.RawMessage = "cfp: bad request body: " + err.Error()
		return a
	}
	model := cand.Store.UpstreamModel
	if model == "" {
		model = creq.Model
	}

	reqID := fmt.Sprintf("chatcmpl-cfp-%d-%d", time.Now().Unix(), atomic.AddUint64(&cfpSeq, 1))
	created := time.Now().Unix()
	opt := cfp.Options{Model: model, Messages: creq.Messages, Temperature: creq.Temperature}
	var route *egress.Route
	opt.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		var err error
		// Prepare on EACH WS retry, after the previous rejection burned its
		// identity; preparing once would pin all three retries to the bad source.
		route, err = lc.h.prepareEgress(target.egress, a.CredentialID)
		if err != nil {
			return nil, err
		}
		if route == nil {
			return egress.DialSource(ctx, network, address, sourceip.Pick(), true)
		}
		return route.DialContext(ctx, network, address)
	}
	opt.OnReject = func(actualIP net.IP, status int) {
		if route != nil {
			route.Reject(actualIP, status)
		} else {
			sourceip.Burn(actualIP, egress.BurnDuration(status))
		}
	}

	if !lc.stream {
		res, err := cfpChatWithRetry(ctx, opt, nil)
		a.FinishedAt = time.Now()
		a.LatencyMs = a.FinishedAt.Sub(a.StartedAt).Milliseconds()
		if err != nil {
			a.Transport = err
			a.ErrorCode, a.Retryable = classifyCFP(err)
			a.RawMessage = err.Error()
			return a
		}
		if res.Finish == "" {
			res.Finish = "stop"
		}
		payload := map[string]any{
			"id":      reqID,
			"object":  "chat.completion",
			"created": created,
			"model":   res.Model,
			"choices": []any{map[string]any{
				"index": 0,
				"message": map[string]any{
					"role":              "assistant",
					"content":           res.Text,
					"reasoning_content": res.Reasoning,
				},
				"finish_reason": res.Finish,
			}},
			"usage": map[string]any{
				"prompt_tokens":     cfpEstimateMessages(creq.Messages),
				"completion_tokens": cfpEstimateText(res.Text),
				"total_tokens":      cfpEstimateMessages(creq.Messages) + cfpEstimateText(res.Text),
			},
		}
		raw, _ := json.Marshal(payload)
		a.HTTPStatus = http.StatusOK
		a.Payload = &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": {"application/json"}},
			Body:       io.NopCloser(bytes.NewReader(raw)),
		}
		return a
	}

	// Streaming: hold the 200 until the first fragment lands, so an upstream
	// refusal (rate limit, model gone) still reaches the router as a real
	// status code and can fail over.
	pr, pw := io.Pipe()
	ready := make(chan error, 1)
	var started atomic.Bool

	// The stream goroutine runs cfpChatWithRetry, whose retry loop can hold an
	// upstream connection for up to 120s x retries. When the first-token wait
	// below times out (or the caller gives up and fails over), this attempt is
	// abandoned: without our own cancel the goroutine would keep the upstream
	// dial alive until its own deadline, outliving the attempt. streamCtx is
	// cancelled on BOTH paths (abandon and normal return via defer).
	streamCtx, streamCancel := context.WithCancel(ctx)
	defer streamCancel()

	go func() {
		emit := func(v any) error {
			b, err := json.Marshal(v)
			if err != nil {
				return err
			}
			_, err = fmt.Fprintf(pw, "data: %s\n\n", b)
			return err
		}
		markReady := func(err error) {
			select {
			case ready <- err:
			default:
			}
		}
		delta := func(kind, d string) {
			if !started.Swap(true) {
				markReady(nil)
			}
			key := "content"
			if kind == "reasoning" {
				key = "reasoning_content"
			}
			_ = emit(map[string]any{
				"id": reqID, "object": "chat.completion.chunk", "created": created, "model": model,
				"choices": []any{map[string]any{"index": 0, "delta": map[string]any{key: d}, "finish_reason": nil}},
			})
		}
		opt.OnDelta = delta
		res, err := cfpChatWithRetry(streamCtx, opt, func() bool { return started.Load() })
		if err != nil {
			if !started.Load() {
				markReady(err)
				_ = pw.CloseWithError(err)
				return
			}
			_ = emit(map[string]any{"error": map[string]any{"message": err.Error(), "type": "upstream_error"}})
			_ = pw.Close()
			return
		}
		if !started.Swap(true) {
			markReady(nil)
		}
		finish := res.Finish
		if finish == "" {
			finish = "stop"
		}
		_ = emit(map[string]any{
			"id": reqID, "object": "chat.completion.chunk", "created": created, "model": model,
			"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": finish}},
			"usage": map[string]any{
				"prompt_tokens":     cfpEstimateMessages(creq.Messages),
				"completion_tokens": cfpEstimateText(res.Text),
				"total_tokens":      cfpEstimateMessages(creq.Messages) + cfpEstimateText(res.Text),
			},
		})
		_, _ = io.WriteString(pw, "data: [DONE]\n\n")
		_ = pw.Close()
	}()

	wait, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	select {
	case err := <-ready:
		if err != nil {
			_ = pr.CloseWithError(err)
			a.FinishedAt = time.Now()
			a.LatencyMs = a.FinishedAt.Sub(a.StartedAt).Milliseconds()
			a.Transport = err
			a.ErrorCode, a.Retryable = classifyCFP(err)
			a.RawMessage = err.Error()
			return a
		}
	case <-wait.Done():
		_ = pr.CloseWithError(wait.Err())
		a.ErrorCode, a.Retryable = routing.ErrCodeProviderTimeout, true
		a.RawMessage = "cfp: no first token within 90s"
		return a
	}

	a.HTTPStatus = http.StatusOK
	a.Payload = &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"text/event-stream"}},
		Body:       pr,
	}
	return a
}

// cfpChatWithRetry wraps cfp.Chat with bounded retries for transient upstream
// faults. The playground's safety layer answers "Safety check unavailable.
// Please try again shortly." with no account to fail over to (keyless = a
// single logical account), so the retry has to live here.
func cfpChatWithRetry(ctx context.Context, opt cfp.Options, started func() bool) (*cfp.Result, error) {
	var last error
	for i := 0; i < 3; i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Duration(i) * 1200 * time.Millisecond):
			}
			if started != nil && started() {
				// Already streamed to the client: a retry would duplicate text.
				return nil, last
			}
		}
		res, err := cfp.Chat(ctx, opt)
		if err == nil {
			return res, nil
		}
		last = err
		var e *cfp.Error
		if asCFPError(err, &e) && e.Status == 400 {
			return nil, err
		}
	}
	return nil, last
}

func classifyCFP(err error) (string, bool) {
	var e *cfp.Error
	if ok := asCFPError(err, &e); ok {
		switch {
		case e.Status == 429:
			return routing.ErrCodeRateLimited, true
		case e.Status == 400:
			return routing.ErrCodeInvalidRequest, false
		case e.Status == 504 || e.Status == 408:
			return routing.ErrCodeProviderTimeout, true
		}
	}
	return routing.ErrCodeUpstreamError, true
}

func asCFPError(err error, target **cfp.Error) bool {
	for err != nil {
		if e, ok := err.(*cfp.Error); ok {
			*target = e
			return true
		}
		un, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = un.Unwrap()
	}
	return false
}

func cfpEstimateMessages(msgs []cfp.Message) int {
	n := 0
	for _, m := range msgs {
		n += cfpEstimateText(m.Content)
	}
	return n
}

func cfpEstimateText(s string) int {
	if s == "" {
		return 0
	}
	// ~4 chars/token, the usual rough cut when the upstream reports nothing.
	return len([]rune(strings.TrimSpace(s)))/4 + 1
}
