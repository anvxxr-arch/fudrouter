package sourceip

import (
	"net"
	"sync"
	"time"
)

const (
	// A 60s throttle window was enough to burn an anonymous address. Holding a
	// credential for sixty such windows avoids the hundreds-of-IPs/minute
	// signature without retaining abandoned credentials indefinitely.
	DefaultStickyTTL = time.Hour
	MaxStickyTTL     = 24 * time.Hour
)

type affinityEntry struct {
	ip      net.IP
	expires time.Time
	ttl     time.Duration
}

// Affinity is host-local because the /128s and Burn's cooldowns are host-local.
// Sharing a bare credential->IP value in Valkey would let a second router bind
// an address it does not own. This cache deliberately resets on process restart;
// preserving affinity across hosts needs a host-qualified, atomic shared lease,
// not an unguarded GetJSON/SetJSON pair. No secrets or refreshed tokens are keys.
type Affinity struct {
	mu      sync.Mutex
	entries map[string]affinityEntry
	swept   time.Time
	pick    func() net.IP
	usable  func(net.IP) bool
}

// NewAffinity takes the source pool explicitly so socket tests can exercise
// affinity without assigning extra addresses or changing the host's network.
func NewAffinity(pick func() net.IP, usable func(net.IP) bool) *Affinity {
	return &Affinity{entries: make(map[string]affinityEntry), pick: pick, usable: usable}
}

func StickyTTL(ttl time.Duration) time.Duration {
	if ttl <= 0 {
		return DefaultStickyTTL
	}
	if ttl > MaxStickyTTL {
		return MaxStickyTTL
	}
	return ttl
}

// Pick keys by credential row ID, not API key/token/model: an OAuth refresh must
// not change a provider account's address, and two models served by that account
// must not create two identities. The lock includes the first pick, so concurrent
// misses cannot assign different /128s to the same credential.
func (a *Affinity) Pick(credentialID string, ttl time.Duration) net.IP {
	if credentialID == "" {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	ttl = StickyTTL(ttl)
	now := time.Now()
	if now.Sub(a.swept) >= refreshEvery {
		for id, entry := range a.entries {
			if !now.Before(entry.expires) {
				delete(a.entries, id)
			}
		}
		a.swept = now
	}
	if entry, ok := a.entries[credentialID]; ok && entry.ttl == ttl && now.Before(entry.expires) && a.usable(entry.ip) {
		return append(net.IP(nil), entry.ip...)
	}
	delete(a.entries, credentialID)
	ip := a.pick()
	if ip == nil || !a.usable(ip) {
		return nil
	}
	a.entries[credentialID] = affinityEntry{
		ip: append(net.IP(nil), ip...), expires: now.Add(ttl), ttl: ttl,
	}
	return append(net.IP(nil), ip...)
}
