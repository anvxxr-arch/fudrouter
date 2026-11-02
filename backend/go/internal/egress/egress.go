// Package egress separates credential identity from anonymous IP rotation.
// The existing keyless ceilings (~3 concurrent requests/IP) justify rotation;
// they do not justify one bearer credential appearing from hundreds of /128s
// per minute. Explicit connection policy decides which identity a dial retains.
package egress

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/netguard"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/sourceip"
)

const (
	Direct     = "direct"
	IPv6Rotate = "ipv6_rotate"
	StickyOwn  = "sticky_own"
	Pool       = "pool"

	PoolEnabledEnv = "ROUTER_EGRESS_POOL_ENABLED"
	PoolURLEnv     = "ROUTER_EGRESS_POOL_URL"
	PoolKeyEnv     = "ROUTER_EGRESS_POOL_CONSUMER_KEY"
	DirectIPEnv    = "ROUTER_DIRECT_SOURCE_IP"

	// 74,242 catalogue credentials must not mean 74,242 transport pools. A
	// bounded client cache shares local transports by /128, remote transports
	// by sticky session, and evicts only idle sockets (never active streams).
	maxClients = 256
	idleTTL    = 90 * time.Second
)

type Policy struct {
	Mode             string
	StickyTTLSeconds int
	ProxyURL         string
}

type cachedClient struct {
	client *http.Client
	used   time.Time
}

type poolSession struct {
	key     string
	expires time.Time
	ttl     time.Duration
}

type Manager struct {
	base     *http.Client
	affinity *sourceip.Affinity
	burn     func(net.IP, time.Duration)
	fixed    func() net.IP

	fixedOnce sync.Once
	fixedIP   net.IP
	fixedErr  error

	mu       sync.Mutex
	clients  map[string]cachedClient
	sessions map[string]poolSession
	swept    time.Time
}

func New(base *http.Client) *Manager {
	if base == nil {
		base = &http.Client{}
	}
	return &Manager{
		base: base, affinity: sourceip.NewAffinity(sourceip.Pick, sourceip.Usable),
		burn: sourceip.Burn, fixed: sourceip.Fixed,
		clients: make(map[string]cachedClient), sessions: make(map[string]poolSession),
	}
}

// Route is one attempt's immutable egress identity. A transport must be keyed
// by this identity, not merely the destination: otherwise HTTP keep-alive/h2
// can send credential B on credential A's already-bound socket.
type Route struct {
	Client *http.Client

	manager      *Manager
	mode         string
	ip           net.IP
	sessionID    string
	sessionKey   string
	poolEndpoint *poolEndpoint
	consumerKey  string
}

// Prepare returns nil for the historical default (including an inert pool).
// Keeping that distinction lets the proxy retain its injected client for keyed
// defaults and its existing rotating client for anonymous defaults. An opted-in
// sticky/direct route fails closed if its chosen address cannot bind; silently
// falling back would destroy the policy's identity guarantee.
func (m *Manager) Prepare(policy Policy, credentialID string) (*Route, error) {
	mode := policy.Mode
	if mode == "" {
		mode = IPv6Rotate
	}
	if mode == IPv6Rotate {
		return nil, nil
	}
	r := &Route{manager: m, mode: mode}
	ttl := stickyTTL(policy.StickyTTLSeconds)
	switch mode {
	case Direct:
		m.fixedOnce.Do(func() {
			if raw := strings.TrimSpace(os.Getenv(DirectIPEnv)); raw != "" {
				m.fixedIP = net.ParseIP(raw)
				if m.fixedIP == nil || m.fixedIP.IsUnspecified() || m.fixedIP.IsMulticast() {
					m.fixedErr = errors.New("direct egress: invalid configured source address")
				}
			} else {
				m.fixedIP = m.fixed()
			}
		})
		if m.fixedErr != nil {
			return nil, m.fixedErr
		}
		if m.fixedIP == nil {
			return nil, errors.New("direct egress: configure a local source address")
		}
		r.ip = append(net.IP(nil), m.fixedIP...)
	case StickyOwn:
		if credentialID == "" {
			return nil, errors.New("sticky egress requires a credential row ID")
		}
		r.ip = m.affinity.Pick(credentialID, ttl)
		if r.ip == nil {
			return nil, errors.New("sticky egress: no usable local source address")
		}
	case Pool:
		endpoint, consumer, enabled, err := configuredPool(policy.ProxyURL)
		if err != nil {
			return nil, err
		}
		if !enabled {
			return nil, nil
		}
		if credentialID == "" {
			return nil, errors.New("pool egress requires a credential row ID")
		}
		r.poolEndpoint, r.consumerKey = endpoint, consumer
		// Endpoint qualification prevents an operator changing pools from
		// inheriting an old remote session. The row ID, never its bearer token,
		// is the account identity across models and OAuth refreshes.
		r.sessionID = endpoint.address + "\x00" + credentialID
		r.sessionKey, err = m.session(r.sessionID, credentialID, ttl)
		if err != nil {
			return nil, err
		}
	default:
		return nil, errors.New("egress: unsupported connection mode")
	}
	client, err := m.clientFor(r)
	if err != nil {
		return nil, err
	}
	r.Client = client
	return r, nil
}

func stickyTTL(seconds int) time.Duration {
	if seconds <= 0 {
		return sourceip.DefaultStickyTTL
	}
	if seconds > int(sourceip.MaxStickyTTL/time.Second) {
		return sourceip.MaxStickyTTL
	}
	return time.Duration(seconds) * time.Second
}

func (m *Manager) session(id, credentialID string, ttl time.Duration) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	m.sweepLocked(now)
	if s, ok := m.sessions[id]; ok && s.ttl == ttl && now.Before(s.expires) {
		return s.key, nil
	}
	var nonce [12]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", errors.New("pool egress: cannot generate sticky session")
	}
	sum := sha256.Sum256([]byte(credentialID))
	// The operator sees a short, non-secret account digest plus a 96-bit
	// generation. Burn replaces the generation; ttl is absolute, not sliding.
	// This fits SOCKS5's 255-byte username limit without disclosing row IDs.
	key := "fr-" + hex.EncodeToString(sum[:8]) + "-" + hex.EncodeToString(nonce[:])
	m.sessions[id] = poolSession{key: key, expires: now.Add(ttl), ttl: ttl}
	return key, nil
}

func (m *Manager) sweepLocked(now time.Time) {
	if now.Sub(m.swept) < time.Minute {
		return
	}
	for key, entry := range m.clients {
		if now.Sub(entry.used) >= idleTTL {
			entry.client.CloseIdleConnections()
			delete(m.clients, key)
		}
	}
	for key, session := range m.sessions {
		if !now.Before(session.expires) {
			delete(m.sessions, key)
		}
	}
	m.swept = now
}

func (m *Manager) clientFor(r *Route) (*http.Client, error) {
	key := "local:" + r.ip.String()
	if r.mode == Pool {
		// A rotated consumer key must not reuse a closure holding the old
		// password. Only its digest joins the cache key; nothing logs it.
		digest := sha256.Sum256([]byte(r.consumerKey))
		key = r.poolEndpoint.scheme + ":" + r.sessionID + ":" + r.sessionKey + ":" + hex.EncodeToString(digest[:])
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	m.sweepLocked(now)
	if entry, ok := m.clients[key]; ok {
		entry.used = now
		m.clients[key] = entry
		return entry.client, nil
	}
	base := m.base.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	transport, ok := base.(*http.Transport)
	if !ok {
		return nil, errors.New("egress requires an HTTP transport")
	}
	tr := transport.Clone()
	tr.Proxy = nil
	tr.DialTLSContext, tr.DialTLS = nil, nil
	tr.DialContext = r.DialContext
	tr.ResponseHeaderTimeout = 120 * time.Second
	tr.TLSHandshakeTimeout = 15 * time.Second
	tr.IdleConnTimeout = idleTTL
	tr.MaxIdleConns, tr.MaxIdleConnsPerHost = 20, 2
	tr.ForceAttemptHTTP2 = true
	client := *m.base
	client.Transport = tr
	client.CheckRedirect = netguard.RedirectPolicy
	if len(m.clients) >= maxClients {
		var oldestKey string
		var oldest time.Time
		for k, entry := range m.clients {
			if oldestKey == "" || entry.used.Before(oldest) {
				oldestKey, oldest = k, entry.used
			}
		}
		m.clients[oldestKey].client.CloseIdleConnections()
		delete(m.clients, oldestKey)
	}
	m.clients[key] = cachedClient{client: &client, used: now}
	return &client, nil
}

func (r *Route) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	if r.mode == Pool {
		return r.poolEndpoint.dial(ctx, network, address, r.sessionKey, r.consumerKey)
	}
	return DialSource(ctx, network, address, r.ip, false)
}

// BurnDuration preserves the existing 429=60s / 402=15m distinction. A 403
// on an explicitly sticky route also retires its identity for 15m; ordinary
// keyed rotation still classifies that response as a rejected credential.
func BurnDuration(status int) time.Duration {
	switch status {
	case http.StatusTooManyRequests:
		return time.Minute
	case http.StatusPaymentRequired, http.StatusForbidden:
		return 15 * time.Minute
	}
	return 0
}

// Reject retires the ACTUAL socket source (supplied by GotConn), not another
// random Pick. Pool sockets bind to the proxy locally, so a pool rejection
// invalidates its remote username generation, never burns the loopback gateway.
func (r *Route) Reject(actualIP net.IP, status int) {
	if r == nil || BurnDuration(status) == 0 || r.mode == Direct {
		return
	}
	if r.mode == Pool {
		r.manager.mu.Lock()
		if current, ok := r.manager.sessions[r.sessionID]; ok && current.key == r.sessionKey {
			delete(r.manager.sessions, r.sessionID)
		}
		r.manager.mu.Unlock()
	} else {
		r.manager.burn(actualIP, BurnDuration(status))
	}
	r.Client.CloseIdleConnections()
}

// DialSource retains the dial-time SSRF guard on BOTH the bound dial and the
// historical fallback. Only ipv6_rotate callers opt into fallback; a sticky
// policy must never trade an identity guarantee for an unnoticed unbound dial.
func DialSource(ctx context.Context, network, address string, ip net.IP, fallback bool) (net.Conn, error) {
	d := &net.Dialer{
		Timeout: 20 * time.Second, KeepAlive: 30 * time.Second,
		Control: netguard.DialControl(netguard.AllowPrivate()),
	}
	if ip != nil && strings.HasPrefix(network, "tcp") {
		bound := *d
		bound.LocalAddr = &net.TCPAddr{IP: ip}
		conn, err := bound.DialContext(ctx, network, address)
		if err == nil || !fallback {
			return conn, err
		}
	}
	return d.DialContext(ctx, network, address)
}
