package proxy

import (
	"context"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"
)

// F6 (HA hardening): the rotating client cloned http.DefaultTransport with no
// ResponseHeaderTimeout, so a keyless upstream that accepted the connection and
// then never sent a header held the request open until the caller's context
// expired — and the streaming path gives it r.Context() with NO deadline at all
// (lifecycle.go upstreamContext). The bound must fire.
func TestRotatingClientBoundsResponseHeader(t *testing.T) {
	// A listener that accepts and never writes: the header phase can only end by
	// timeout, never by data or EOF.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			defer c.Close() // hold the connection open, never write headers
		}
	}()
	t.Cleanup(func() {
		ln.Close()
		wg.Wait()
	})

	// Shorten the bound and reset the once so this test does not wait two
	// minutes. sync.Once is not copyable (vet copylocks), so the once is reset
	// in place rather than saved and restored; the client is rebuilt lazily by
	// the next rotatingClient() call with the restored timeout.
	const bound = 200 * time.Millisecond
	origTimeout := rotatingHeaderTimeout
	rotOnce = sync.Once{}
	rotClient = nil
	rotatingHeaderTimeout = bound
	t.Cleanup(func() {
		rotatingHeaderTimeout = origTimeout
		rotOnce = sync.Once{}
		rotClient = nil
	})

	cl := rotatingClient()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://"+ln.Addr().String()+"/", nil)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	start := time.Now()
	_, err = cl.Do(req)
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("request succeeded against a listener that never sends headers")
	}
	if elapsed < 100*time.Millisecond {
		t.Fatalf("request errored in %v, want it to wait out the header phase", elapsed)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("request hung %v before the header bound fired — ResponseHeaderTimeout is not set", elapsed)
	}
}
