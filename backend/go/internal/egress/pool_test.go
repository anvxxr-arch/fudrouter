package egress_test

// Pool sockets are shared by destination unless the sticky username is part of
// the transport identity. These fixtures implement real HTTP CONNECT/SOCKS5
// tunnels, including TLS and proxy authentication, to catch a map-only affinity
// test that still puts every credential on one remote proxy session. They are
// not evidence that the operator's authenticated pool works end-to-end.

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/egress"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/netguard"
)

type poolObservation struct {
	username string
	password string
	target   string
}

type poolFixture struct {
	mu    sync.Mutex
	seen  []poolObservation
	conns []net.Conn
	url   string
}

func (p *poolFixture) record(observation poolObservation) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.seen = append(p.seen, observation)
}

func (p *poolFixture) track(conn net.Conn) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.conns = append(p.conns, conn)
}

func (p *poolFixture) observations() []poolObservation {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]poolObservation(nil), p.seen...)
}

func (p *poolFixture) close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, c := range p.conns {
		_ = c.Close()
	}
}

func httpPool(t *testing.T) *poolFixture {
	t.Helper()
	p := &poolFixture{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			t.Errorf("pool got %s, want CONNECT", r.Method)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		auth, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(r.Header.Get("Proxy-Authorization"), "Basic "))
		parts := strings.SplitN(string(auth), ":", 2)
		if err != nil || len(parts) != 2 {
			t.Errorf("invalid fixture proxy authentication")
			w.WriteHeader(http.StatusProxyAuthRequired)
			return
		}
		host, _, _ := net.SplitHostPort(r.Host)
		if net.ParseIP(host) == nil {
			t.Errorf("pool was asked to resolve hostname %s", host)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		p.record(poolObservation{username: parts[0], password: parts[1], target: r.Host})
		up, err := net.DialTimeout("tcp", r.Host, time.Second)
		if err != nil {
			t.Errorf("fixture upstream dial: %v", err)
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		p.track(up)
		defer up.Close()
		conn, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Errorf("hijack: %v", err)
			return
		}
		p.track(conn)
		defer conn.Close()
		_, _ = rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		_ = rw.Flush()
		go func() { _, _ = io.Copy(conn, up); _ = conn.Close() }()
		_, _ = io.Copy(up, rw)
	}))
	p.url = server.URL
	t.Cleanup(func() { p.close(); server.Close() })
	return p
}

func socksPool(t *testing.T) *poolFixture {
	t.Helper()
	p := &poolFixture{}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p.url = "socks5://" + ln.Addr().String()
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			p.track(conn)
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer conn.Close()
				if err := serveSOCKS(p, conn); err != nil {
					t.Errorf("SOCKS5 fixture: %v", err)
				}
			}()
		}
	}()
	t.Cleanup(func() { _ = ln.Close(); p.close(); wg.Wait() })
	return p
}

func serveSOCKS(p *poolFixture, c net.Conn) error {
	read := func(n int) ([]byte, error) {
		b := make([]byte, n)
		_, err := io.ReadFull(c, b)
		return b, err
	}
	greeting, err := read(2)
	if err != nil || greeting[0] != 5 {
		return fmt.Errorf("greeting: %v", err)
	}
	if _, err := read(int(greeting[1])); err != nil {
		return err
	}
	if _, err := c.Write([]byte{5, 2}); err != nil {
		return err
	}
	header, err := read(2)
	if err != nil || header[0] != 1 {
		return fmt.Errorf("auth: %v", err)
	}
	username, err := read(int(header[1]))
	if err != nil {
		return err
	}
	length, err := read(1)
	if err != nil {
		return err
	}
	password, err := read(int(length[0]))
	if err != nil {
		return err
	}
	if _, err := c.Write([]byte{1, 0}); err != nil {
		return err
	}
	request, err := read(4)
	if err != nil || request[0] != 5 || request[1] != 1 {
		return fmt.Errorf("CONNECT: %v", err)
	}
	var size int
	switch request[3] {
	case 1:
		size = net.IPv4len
	case 4:
		size = net.IPv6len
	default:
		return fmt.Errorf("unverified hostname sent to SOCKS5 (ATYP %d)", request[3])
	}
	ip, err := read(size)
	if err != nil {
		return err
	}
	port, err := read(2)
	if err != nil {
		return err
	}
	target := net.JoinHostPort(net.IP(ip).String(), fmt.Sprint(binary.BigEndian.Uint16(port)))
	p.record(poolObservation{username: string(username), password: string(password), target: target})
	up, err := net.DialTimeout("tcp", target, time.Second)
	if err != nil {
		return err
	}
	p.track(up)
	defer up.Close()
	if _, err := c.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0}); err != nil {
		return err
	}
	go func() { _, _ = io.Copy(c, up); _ = c.Close() }()
	_, _ = io.Copy(up, c)
	return nil
}

func configurePool(t *testing.T, endpoint string) {
	t.Helper()
	t.Setenv(egress.PoolEnabledEnv, "1")
	t.Setenv(egress.PoolURLEnv, endpoint)
	t.Setenv(egress.PoolKeyEnv, "test-consumer")
}

func TestPoolStickySessionRotatesOnReject(t *testing.T) {
	for _, kind := range []string{"http", "socks5"} {
		t.Run(kind, func(t *testing.T) {
			t.Setenv(netguard.AllowPrivateEnv, "1")
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "ok") }))
			t.Cleanup(up.Close)
			var pool *poolFixture
			if kind == "http" {
				pool = httpPool(t)
			} else {
				pool = socksPool(t)
			}
			configurePool(t, pool.url)
			m := egress.New(up.Client())
			t.Cleanup(func() { egress.CloseForTest(m) })
			policy := egress.Policy{Mode: egress.Pool, StickyTTLSeconds: 3600}
			_, actual, old, _ := send(t, m, policy, "credential-row-never-disclosed", up.URL)
			_, _, _, reused := send(t, m, policy, "credential-row-never-disclosed", up.URL)
			seen := pool.observations()
			if len(seen) != 1 || !reused || seen[0].password != "test-consumer" || strings.Contains(seen[0].username, "credential-row") {
				t.Fatalf("pool did not retain a non-secret sticky username: tunnels=%d reused=%v", len(seen), reused)
			}
			old.Reject(actual, http.StatusTooManyRequests)
			_, _, fresh, reused := send(t, m, policy, "credential-row-never-disclosed", up.URL)
			seen = pool.observations()
			if len(seen) != 2 || reused || seen[0].username == seen[1].username || fresh.Client == old.Client {
				t.Fatal("burn reused the rejected remote session/transport")
			}
			// An in-flight rejection from the OLD generation must not evict the
			// replacement that a concurrent request already established.
			old.Reject(actual, http.StatusForbidden)
			_, _, stillFresh, _ := send(t, m, policy, "credential-row-never-disclosed", up.URL)
			if stillFresh.Client != fresh.Client || len(pool.observations()) != 2 {
				t.Fatal("stale rejection invalidated a replacement session")
			}
			_, _, other, _ := send(t, m, policy, "cred-b", up.URL)
			seen = pool.observations()
			if len(seen) != 3 || seen[2].username == seen[1].username || other.Client == fresh.Client {
				t.Fatal("different credentials shared a remote pool session")
			}
		})
	}
}

func TestPoolTunnelsPreserveTLSAndProviderHeaders(t *testing.T) {
	for _, kind := range []string{"http", "socks5"} {
		t.Run(kind, func(t *testing.T) {
			t.Setenv(netguard.AllowPrivateEnv, "1")
			up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer test-provider-token" || r.Header.Get("Proxy-Authorization") != "" {
					t.Error("pool auth leaked upstream or provider auth was lost")
				}
				_, _ = io.WriteString(w, "tls-ok")
			}))
			t.Cleanup(up.Close)
			var pool *poolFixture
			if kind == "http" {
				pool = httpPool(t)
			} else {
				pool = socksPool(t)
			}
			configurePool(t, pool.url)
			m := egress.New(up.Client())
			t.Cleanup(func() { egress.CloseForTest(m) })
			body, _, _, _ := send(t, m, egress.Policy{Mode: egress.Pool}, "cred-tls", up.URL)
			if body != "tls-ok" {
				t.Fatalf("TLS tunnel response %q", body)
			}
		})
	}
}

func TestPoolSSRFAndEndpointApproval(t *testing.T) {
	pool := httpPool(t)
	configurePool(t, pool.url)
	t.Setenv(netguard.AllowPrivateEnv, "0")
	m := egress.New(nil)
	t.Cleanup(func() { egress.CloseForTest(m) })
	route, err := m.Prepare(egress.Policy{Mode: egress.Pool}, "cred-a")
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{"http://127.0.0.1:1", "http://localhost:1", "http://169.254.169.254:80"} {
		if resp, err := route.Client.Get(target); err == nil {
			resp.Body.Close()
			t.Fatalf("SSRF through pool accepted %s", target)
		}
	}
	if len(pool.observations()) != 0 {
		t.Fatal("private target reached the trusted proxy before validation")
	}
	for _, invalid := range []string{
		"http://127.0.0.1:3130", "http://user:password@127.0.0.1:3128",
		"http://localhost:3128", "https://127.0.0.1:3128", pool.url + "/path",
	} {
		if _, err := m.Prepare(egress.Policy{Mode: egress.Pool, ProxyURL: invalid}, "cred-a"); err == nil {
			t.Errorf("unapproved/credential-bearing proxy URL accepted: %s", invalid)
		}
	}
	// The operator's HTTP/SOCKS5 frontends share a port. DB selection may
	// choose the other protocol on the approved socket, not another socket.
	if _, err := m.Prepare(egress.Policy{Mode: egress.Pool, ProxyURL: strings.Replace(pool.url, "http://", "socks5://", 1)}, "cred-a"); err != nil {
		t.Fatalf("approved same-port SOCKS5 selection rejected: %v", err)
	}
}

func TestPoolCONNECTCancellationAndRedaction(t *testing.T) {
	entered := make(chan struct{}, 1)
	pool := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entered <- struct{}{}
		<-r.Context().Done()
	}))
	t.Cleanup(pool.Close)
	configurePool(t, pool.URL)
	m := egress.New(nil)
	t.Cleanup(func() { egress.CloseForTest(m) })
	route, err := m.Prepare(egress.Policy{Mode: egress.Pool}, "cred-a")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://8.8.8.8:80/", nil)
	start := time.Now()
	_, err = route.Client.Do(req)
	if err == nil || time.Since(start) > 2*time.Second || strings.Contains(err.Error(), "test-consumer") {
		t.Fatalf("CONNECT cancellation/redaction failed: %v", err)
	}
	select {
	case <-entered:
	default:
		t.Fatal("CONNECT phase was not reached")
	}
}

func TestPoolRejectsPrivateRedirect(t *testing.T) {
	var mu sync.Mutex
	tunnels := 0
	// The fixture terminates a tunnel to a PUBLIC numeric target locally, then
	// redirects it onto loopback. No bytes may reach the proxy on that hop.
	pool := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			t.Errorf("proxy got %s, want CONNECT", r.Method)
			return
		}
		mu.Lock()
		tunnels++
		mu.Unlock()
		conn, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		_, _ = rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		_ = rw.Flush()
		if _, err := http.ReadRequest(rw.Reader); err != nil {
			t.Error(err)
			return
		}
		_, _ = rw.WriteString("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
		_ = rw.Flush()
	}))
	t.Cleanup(pool.Close)
	configurePool(t, pool.URL)
	t.Setenv(netguard.AllowPrivateEnv, "0")
	m := egress.New(nil)
	t.Cleanup(func() { egress.CloseForTest(m) })
	route, err := m.Prepare(egress.Policy{Mode: egress.Pool}, "cred-redirect")
	if err != nil {
		t.Fatal(err)
	}
	resp, err := route.Client.Get("http://8.8.8.8:80/")
	if err == nil {
		resp.Body.Close()
		t.Fatal("private redirect passed through the pool")
	}
	mu.Lock()
	defer mu.Unlock()
	if tunnels != 1 || !strings.Contains(err.Error(), "ssrf guard") {
		t.Fatalf("redirect guard: tunnels=%d error=%v", tunnels, err)
	}
}

func TestPoolSessionTTLAndPolicyChange(t *testing.T) {
	t.Setenv(netguard.AllowPrivateEnv, "1")
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "ok") }))
	t.Cleanup(up.Close)
	pool := httpPool(t)
	configurePool(t, pool.url)
	m := egress.New(nil)
	t.Cleanup(func() { egress.CloseForTest(m) })
	policy := egress.Policy{Mode: egress.Pool, StickyTTLSeconds: 1}
	_, _, first, _ := send(t, m, policy, "cred-ttl", up.URL)
	time.Sleep(400 * time.Millisecond)
	_, _, hit, _ := send(t, m, policy, "cred-ttl", up.URL)
	if first.Client != hit.Client {
		t.Fatal("remote affinity expired before its TTL")
	}
	time.Sleep(800 * time.Millisecond)
	_, _, expired, _ := send(t, m, policy, "cred-ttl", up.URL)
	if first.Client == expired.Client || len(pool.observations()) != 2 {
		t.Fatal("a session cache hit extended its absolute TTL or reused an expired tunnel")
	}
	policy.StickyTTLSeconds = 900
	_, _, changed, _ := send(t, m, policy, "cred-ttl", up.URL)
	if changed.Client == expired.Client || len(pool.observations()) != 3 {
		t.Fatal("updated connection TTL retained the previous remote lease")
	}
}

func TestEgressClientCacheIsBounded(t *testing.T) {
	configurePool(t, "http://127.0.0.1:3128")
	m := egress.New(nil)
	t.Cleanup(func() { egress.CloseForTest(m) })
	for i := 0; i < 300; i++ {
		if _, err := m.Prepare(egress.Policy{Mode: egress.Pool}, fmt.Sprintf("cred-%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	if n := egress.ClientCountForTest(m); n != 256 {
		t.Fatalf("300 credential identities retained %d transports, want bounded 256", n)
	}
}
