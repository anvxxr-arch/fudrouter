package proxy

import (
	"context"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/sourceip"
)

var (
	rotOnce   sync.Once
	rotClient *http.Client
	// coarse burn bookkeeping: the transport pools connections, so a retry can
	// silently reuse the socket (and its source address) that the provider just
	// rejected. Closing idle conns after a burn forces the next attempt to dial.
	rotMu sync.Mutex
)

// rotatingHeaderTimeout bounds the response-HEADER phase of the rotating
// client. The streaming path hands this client r.Context() with no deadline
// (lifecycle.go upstreamContext), so without this a keyless upstream that
// accepts the connection and then never sends a header holds the request open
// indefinitely (F6). 120s matches newUpstreamClient, so the two clients agree
// on what "a dead upstream" means. A var, not a const, so a test can shorten it.
var rotatingHeaderTimeout = 120 * time.Second

// ipTracker records which local source address the LAST dial for one request
// bound. http.Transport passes the request context to DialContext, so a tracker
// carried in the context is filled in by the dial itself — no guessing, no
// second lookup that could disagree with the socket that actually connected.
type ipTracker struct {
	mu sync.Mutex
	ip net.IP
}

func (t *ipTracker) set(ip net.IP) {
	if t == nil || ip == nil {
		return
	}
	t.mu.Lock()
	t.ip = ip
	t.mu.Unlock()
}

func (t *ipTracker) get() net.IP {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.ip
}

type trackerKey struct{}

// withIPTracker returns a context whose dials report their source address.
func withIPTracker(ctx context.Context) (context.Context, *ipTracker) {
	t := &ipTracker{}
	return context.WithValue(ctx, trackerKey{}, t), t
}

// dropIdleConnections forces the next attempt to open a new socket, which is the
// only way a rotation retry actually leaves from a different address.
func dropIdleConnections() {
	rotMu.Lock()
	defer rotMu.Unlock()
	if rotClient != nil {
		rotClient.CloseIdleConnections()
	}
}

// rotatingClient is the upstream client used by keyless connections: every dial
// binds a random local global IPv6 address, so the provider sees a fresh source
// IP per request.
//
// It exists because keyless endpoints rate-limit per source IP (pollinations
// answers 429 "concurrency limit exceeded ... (3 concurrent requests)" from a
// single address), and there is no credential to rotate instead. It is built
// once and shared: the transport keeps its own connection pool, which is what we
// want — a pooled connection can be reused, but a NEW dial gets a new address.
//
// If binding the IPv6 source fails (IPv4-only upstream, or the address vanished
// between Pick and dial) the dial is retried with the kernel's default source so
// a rotation problem never becomes an outage.
func rotatingClient() *http.Client {
	rotOnce.Do(func() {
		tr := http.DefaultTransport.(*http.Transport).Clone()
		tr.ResponseHeaderTimeout = rotatingHeaderTimeout
		tr.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			d := &net.Dialer{Timeout: 20 * time.Second, KeepAlive: 30 * time.Second}
			if ip := sourceip.Pick(); ip != nil && strings.HasPrefix(network, "tcp") {
				bound := *d
				bound.LocalAddr = &net.TCPAddr{IP: ip}
				conn, err := bound.DialContext(ctx, network, addr)
				if err == nil {
					if t, ok := ctx.Value(trackerKey{}).(*ipTracker); ok {
						t.set(ip)
					}
					return conn, nil
				}
			}
			return d.DialContext(ctx, network, addr)
		}
		rotClient = &http.Client{Transport: tr}
	})
	return rotClient
}
