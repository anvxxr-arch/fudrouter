package proxy

import (
	"context"
	"net"
	"net/http"
	"net/http/httptrace"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/egress"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/netguard"
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

// ipTracker records the socket actually selected by http.Transport. Dial-only
// attribution missed every keep-alive reuse (measured by the two-request test:
// the second tracker was nil) and could report a losing Happy-Eyeballs dial.
// GotConn covers both a new socket and reuse, so a burn retires the real source.
type ipTracker struct {
	mu sync.Mutex
	ip net.IP
}

func (t *ipTracker) set(ip net.IP) {
	if t == nil || ip == nil {
		return
	}
	t.mu.Lock()
	t.ip = append(net.IP(nil), ip...)
	t.mu.Unlock()
}

func (t *ipTracker) get() net.IP {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return append(net.IP(nil), t.ip...)
}

type trackerKey struct{}

// withIPTracker returns a context whose dials report their source address.
func withIPTracker(ctx context.Context) (context.Context, *ipTracker) {
	t := &ipTracker{}
	ctx = context.WithValue(ctx, trackerKey{}, t)
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
		GotConn: func(info httptrace.GotConnInfo) {
			if local, ok := info.Conn.LocalAddr().(*net.TCPAddr); ok {
				t.set(local.IP)
			}
		},
	})
	return ctx, t
}

func (h *Handler) prepareEgress(policy egress.Policy, credentialID string) (*egress.Route, error) {
	h.egressOnce.Do(func() { h.egressManager = egress.New(h.client) })
	return h.egressManager.Prepare(policy, credentialID)
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
		// An inherited HTTP_PROXY would guard/bind the proxy socket, not the
		// provider. Only the explicit, target-pinning pool policy may use one.
		tr.Proxy = nil
		tr.ResponseHeaderTimeout = rotatingHeaderTimeout
		tr.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			return egress.DialSource(ctx, network, addr, sourceip.Pick(), true)
		}
		rotClient = &http.Client{Transport: tr, CheckRedirect: netguard.RedirectPolicy}
	})
	return rotClient
}
