package mitm

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudrouter/internal/protocol"
)

// Server is an HTTPS MITM that intercepts AI-tool chat calls and rewrites them
// to the local fudrouter OpenAI-compatible gateway.
type Server struct {
	Addr       string // default :443
	RouterBase string // e.g. http://127.0.0.1:8011
	DataDir    string
	Logger     *log.Logger

	caCert *x509.Certificate
	caKey  *ecdsa.PrivateKey
	leafMu sync.Mutex
	leafs  map[string]*tls.Certificate

	httpClient *http.Client
	dns        *net.Resolver
}

type chatMatch struct {
	tool string
	kind string
}

func New(dataDir, addr, routerBase string) (*Server, error) {
	if addr == "" {
		addr = ":443"
	}
	if routerBase == "" {
		routerBase = "http://127.0.0.1:8011"
	}
	s := &Server{
		Addr:       addr,
		RouterBase: strings.TrimRight(routerBase, "/"),
		DataDir:    dataDir,
		Logger:     log.New(os.Stderr, "[mitm] ", log.LstdFlags),
		leafs:      map[string]*tls.Certificate{},
		httpClient: &http.Client{Timeout: 120 * time.Second},
		dns: &net.Resolver{
			PreferGo: true,
			Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
				d := net.Dialer{Timeout: 3 * time.Second}
				return d.DialContext(ctx, "udp", "8.8.8.8:53")
			},
		},
	}
	if err := s.loadOrCreateCA(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Server) loadOrCreateCA() error {
	dir := filepath.Join(s.DataDir, "mitm")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	certPath := filepath.Join(dir, "rootCA.crt")
	keyPath := filepath.Join(dir, "rootCA.key")
	if _, err := os.Stat(certPath); err == nil {
		if _, err := os.Stat(keyPath); err == nil {
			return s.loadCA(certPath, keyPath)
		}
	}
	return s.createCA(certPath, keyPath)
}

func (s *Server) loadCA(certPath, keyPath string) error {
	cb, err := os.ReadFile(certPath)
	if err != nil {
		return err
	}
	kb, err := os.ReadFile(keyPath)
	if err != nil {
		return err
	}
	cp, _ := pem.Decode(cb)
	kp, _ := pem.Decode(kb)
	if cp == nil || kp == nil {
		return fmt.Errorf("invalid CA pem")
	}
	cert, err := x509.ParseCertificate(cp.Bytes)
	if err != nil {
		return err
	}
	key, err := x509.ParseECPrivateKey(kp.Bytes)
	if err != nil {
		return err
	}
	s.caCert, s.caKey = cert, key
	s.Logger.Printf("loaded root CA %s", certPath)
	return nil
}

func (s *Server) createCA(certPath, keyPath string) error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serial, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   "fudrouter MITM Root CA",
			Organization: []string{"fudrouter"},
		},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            1,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return err
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := os.WriteFile(certPath, certPEM, 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		return err
	}
	s.caCert, s.caKey = cert, key
	s.Logger.Printf("created root CA %s (install into system/browser trust)", certPath)
	return nil
}

func (s *Server) leafFor(host string) (*tls.Certificate, error) {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	s.leafMu.Lock()
	defer s.leafMu.Unlock()
	if c, ok := s.leafs[host]; ok {
		return c, nil
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: host},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(825 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{host},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, s.caCert, &key.PublicKey, s.caKey)
	if err != nil {
		return nil, err
	}
	leaf := &tls.Certificate{
		Certificate: [][]byte{der, s.caCert.Raw},
		PrivateKey:  key,
	}
	s.leafs[host] = leaf
	return leaf, nil
}

func isTargetHost(host string) bool {
	host = strings.ToLower(host)
	targets := []string{
		"daily-cloudcode-pa.googleapis.com",
		"cloudcode-pa.googleapis.com",
		"api.individual.githubcopilot.com",
		"runtime.us-east-1.kiro.dev",
		"q.us-east-1.amazonaws.com",
		"codewhisperer.us-east-1.amazonaws.com",
		"api2.cursor.sh",
		"api3.cursor.sh",
		"agent.api5.cursor.sh",
		"agentn.api5.cursor.sh",
	}
	for _, t := range targets {
		if host == t || strings.HasSuffix(host, "."+t) {
			return true
		}
	}
	return false
}

func classifyChat(method, path, amzTarget string) (chatMatch, bool) {
	p := strings.ToLower(path)
	if strings.Contains(p, "generatecontent") || strings.Contains(p, "streamgeneratecontent") {
		return chatMatch{tool: "antigravity", kind: "generateContent"}, true
	}
	if strings.Contains(p, "/chat/completions") || strings.Contains(p, "/v1/messages") || strings.HasSuffix(p, "/responses") {
		return chatMatch{tool: "copilot", kind: "chat"}, true
	}
	if strings.Contains(strings.ToLower(amzTarget), "generateassistantresponse") || strings.Contains(p, "generateassistantresponse") {
		return chatMatch{tool: "kiro", kind: "generateAssistantResponse"}, true
	}
	if strings.Contains(p, "bidiaappend") || strings.Contains(p, "bidiappend") || strings.Contains(p, "/run") || strings.Contains(p, "runsse") || strings.Contains(p, "runpoll") || strings.Contains(p, "streamunifiedchat") || strings.Contains(p, "chatservice") {
		return chatMatch{tool: "cursor", kind: "run"}, true
	}
	_ = method
	return chatMatch{}, false
}

func (s *Server) ListenAndServe() error {
	cfg := &tls.Config{
		MinVersion: tls.VersionTLS12,
		NextProtos: []string{"http/1.1"},
		GetCertificate: func(info *tls.ClientHelloInfo) (*tls.Certificate, error) {
			return s.leafFor(info.ServerName)
		},
	}
	ln, err := tls.Listen("tcp", s.Addr, cfg)
	if err != nil {
		return err
	}
	s.Logger.Printf("listening %s → router %s", s.Addr, s.RouterBase)
	srv := &http.Server{
		Handler:           http.HandlerFunc(s.serveHTTP),
		ReadHeaderTimeout: 10 * time.Second,
	}
	return srv.Serve(ln)
}

func (s *Server) serveHTTP(w http.ResponseWriter, r *http.Request) {
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	match, isChat := classifyChat(r.Method, r.URL.Path, r.Header.Get("X-Amz-Target"))
	if isTargetHost(host) && isChat && r.Method == http.MethodPost {
		s.handleChat(w, r, match)
		return
	}
	s.passthrough(w, r, host)
}

func (s *Server) handleChat(w http.ResponseWriter, r *http.Request, m chatMatch) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil {
		http.Error(w, "read body", 400)
		return
	}
	payload := body
	wantKiroES := m.tool == "kiro"
	wantCursor := m.tool == "cursor"
	if wantKiroES {
		model, messages, _ := protocol.KiroRequestToOpenAI(body)
		wrapped, _ := json.Marshal(map[string]any{
			"model":    model,
			"messages": messages,
			"stream":   false,
			"metadata": map[string]any{"mitm_tool": m.tool, "mitm_kind": m.kind, "path": r.URL.Path},
		})
		payload = wrapped
	} else if wantCursor {
		model, messages, _ := protocol.CursorRequestToOpenAI(body, r.URL.Path)
		wrapped, _ := json.Marshal(map[string]any{
			"model":    model,
			"messages": messages,
			"stream":   false,
			"metadata": map[string]any{"mitm_tool": m.tool, "mitm_kind": m.kind, "path": r.URL.Path},
		})
		payload = wrapped
	} else if !bytes.Contains(body, []byte(`"messages"`)) {
		wrapped, _ := json.Marshal(map[string]any{
			"model": m.tool + "/auto",
			"messages": []map[string]string{
				{"role": "user", "content": string(body)},
			},
			"stream": false,
			"metadata": map[string]any{
				"mitm_tool": m.tool,
				"mitm_kind": m.kind,
				"path":      r.URL.Path,
			},
		})
		payload = wrapped
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, s.RouterBase+"/v1/chat/completions", bytes.NewReader(payload))
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if auth := r.Header.Get("Authorization"); auth != "" {
		req.Header.Set("Authorization", auth)
	}
	if bearer := r.Header.Get("x-amz-sso-bearer"); bearer != "" && req.Header.Get("Authorization") == "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	req.Header.Set("X-Nprouter-MITM-Tool", m.tool)
	resp, err := s.httpClient.Do(req)
	if err != nil {
		s.Logger.Printf("router error tool=%s: %v", m.tool, err)
		http.Error(w, "router unavailable: "+err.Error(), 502)
		return
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<20))

	if wantKiroES && resp.StatusCode < 300 {
		es, err := protocol.OpenAIChatToKiroEventStream(respBody)
		if err != nil {
			http.Error(w, "kiro encode: "+err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/vnd.amazon.eventstream")
		w.Header().Set("X-Nprouter-MITM", m.tool)
		w.WriteHeader(200)
		_, _ = w.Write(es)
		s.Logger.Printf("intercept %s %s %s → eventstream %dB", m.tool, r.Method, r.URL.Path, len(es))
		return
	}

	if wantCursor && resp.StatusCode < 300 {
		p := strings.ToLower(r.URL.Path)
		w.Header().Set("X-Nprouter-MITM", m.tool)
		if strings.Contains(p, "runsse") || strings.Contains(p, "stream") {
			out := protocol.OpenAIChatToCursorSSE(respBody)
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-cache")
			w.WriteHeader(200)
			_, _ = w.Write(out)
			s.Logger.Printf("intercept %s %s → cursor-sse %dB", m.tool, r.URL.Path, len(out))
			return
		}
		out := protocol.OpenAIChatToCursorJSON(respBody)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write(out)
		s.Logger.Printf("intercept %s %s → cursor-json %dB", m.tool, r.URL.Path, len(out))
		return
	}

	for k, vv := range resp.Header {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.Header().Set("X-Nprouter-MITM", m.tool)
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(respBody)
	s.Logger.Printf("intercept %s %s %s → %d", m.tool, r.Method, r.URL.Path, resp.StatusCode)
}

func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, host string) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	ips, err := s.dns.LookupHost(ctx, host)
	if err != nil || len(ips) == 0 {
		ips, err = net.LookupHost(host)
	}
	if err != nil || len(ips) == 0 {
		http.Error(w, "dns resolve failed: "+host, 502)
		return
	}
	target := "https://" + net.JoinHostPort(ips[0], "443") + r.URL.RequestURI()
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target, r.Body)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	req.Host = host
	for k, vv := range r.Header {
		if strings.EqualFold(k, "Host") {
			continue
		}
		for _, v := range vv {
			req.Header.Add(k, v)
		}
	}
	client := &http.Client{
		Timeout: 60 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12},
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, "origin error: "+err.Error(), 502)
		return
	}
	defer resp.Body.Close()
	for k, vv := range resp.Header {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// HostsEntries returns /etc/hosts lines for MITM targets.
func HostsEntries() []string {
	return []string{
		"127.0.0.1 daily-cloudcode-pa.googleapis.com",
		"127.0.0.1 cloudcode-pa.googleapis.com",
		"127.0.0.1 api.individual.githubcopilot.com",
		"127.0.0.1 runtime.us-east-1.kiro.dev",
		"127.0.0.1 q.us-east-1.amazonaws.com",
		"127.0.0.1 codewhisperer.us-east-1.amazonaws.com",
		"127.0.0.1 api2.cursor.sh",
	}
}

func EnsureHosts() error {
	path := "/etc/hosts"
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	content := string(b)
	var add []string
	for _, line := range HostsEntries() {
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		if !strings.Contains(content, parts[1]) {
			add = append(add, line)
		}
	}
	if len(add) == 0 {
		return nil
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString("\n# fudrouter mitm\n" + strings.Join(add, "\n") + "\n")
	return err
}

func CAPath(dataDir string) string {
	return filepath.Join(dataDir, "mitm", "rootCA.crt")
}
