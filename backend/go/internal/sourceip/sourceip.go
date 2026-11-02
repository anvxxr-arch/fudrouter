// Package sourceip hands out a random local global-IPv6 address so an outbound
// connection can leave from a different /128 than its neighbours.
//
// Why it exists: keyless providers rate-limit per SOURCE IP, not per credential
// (there is no credential to rotate). Observed ceilings without rotation:
// Cloudflare AI Playground stalls once ~a dozen WebSockets are in flight, and
// pollinations answers 429 "concurrency limit exceeded ... (3 concurrent
// requests)". Rotating the /128 per connection turns both into non-issues.
//
// The host is expected to hold a routed /64 whose addresses are kept assigned by
// the iprotate/warp engines; the list is re-read once a minute so newly added
// addresses are picked up without a restart.
package sourceip

import (
	"crypto/rand"
	"encoding/binary"
	"net"
	"os"
	"sync"
	"time"
)

var (
	mu       sync.Mutex
	ips      []net.IP
	loaded   time.Time
	disabled = false
	// burned holds addresses that a provider has just rejected (402 credits,
	// 429 throttle) with the moment they become usable again. Rotation is only
	// useful if it rotates AWAY from a poisoned source: handing the same /128
	// back on the retry turns one 429 into a 429 storm.
	burned = map[string]time.Time{}
)

const refreshEvery = time.Minute

// Pick returns a random local global IPv6 address, or nil when rotation is off
// (SOURCE_ROTATE=0) or the host has no global IPv6 assigned.
func Pick() net.IP {
	if disabled || os.Getenv("SOURCE_ROTATE") == "0" {
		return nil
	}
	mu.Lock()
	defer mu.Unlock()
	if len(ips) == 0 || time.Since(loaded) > refreshEvery {
		var found []net.IP
		if addrs, err := net.InterfaceAddrs(); err == nil {
			for _, a := range addrs {
				ipn, ok := a.(*net.IPNet)
				if !ok || ipn.IP.To4() != nil {
					continue
				}
				ip := ipn.IP.To16()
				if ip != nil && ip.IsGlobalUnicast() && !ip.IsPrivate() {
					found = append(found, ip)
				}
			}
		}
		ips, loaded = found, time.Now()
	}
	if len(ips) == 0 {
		return nil
	}
	now := time.Now()
	usable := make([]net.IP, 0, len(ips))
	for _, ip := range ips {
		if until, ok := burned[ip.String()]; ok {
			if now.Before(until) {
				continue
			}
			delete(burned, ip.String())
		}
		usable = append(usable, ip)
	}
	// Every address is in cooldown: return nil so the caller dials from the
	// kernel's default source instead of blocking on a poisoned pool.
	if len(usable) == 0 {
		return nil
	}
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return usable[0]
	}
	return usable[binary.BigEndian.Uint64(buf)%uint64(len(usable))]
}

// Burn parks one source address for d. Called when an upstream answers with a
// per-IP rejection: the address is fine, it is just out of budget right now.
func Burn(ip net.IP, d time.Duration) {
	if ip == nil || d <= 0 {
		return
	}
	mu.Lock()
	defer mu.Unlock()
	key := ip.String()
	until := time.Now().Add(d)
	if cur, ok := burned[key]; !ok || cur.Before(until) {
		burned[key] = until
	}
}

// Burned reports how many addresses are currently parked (diagnostics).
func Burned() int {
	mu.Lock()
	defer mu.Unlock()
	now := time.Now()
	n := 0
	for k, until := range burned {
		if now.Before(until) {
			n++
		} else {
			delete(burned, k)
		}
	}
	return n
}

// Count reports how many addresses the pool currently knows about (0 before the
// first Pick). Used by tests and diagnostics.
func Count() int {
	mu.Lock()
	defer mu.Unlock()
	return len(ips)
}
