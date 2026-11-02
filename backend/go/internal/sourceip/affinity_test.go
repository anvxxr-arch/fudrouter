package sourceip_test

// The anonymous-provider ceiling (~3 concurrent requests/IP) justifies random
// rotation, not one credential moving between hundreds of addresses/minute.
// These tests pin the distinct credential policy: one first pick under concurrent
// misses, absolute TTL, and immediate invalidation of a rejected address.

import (
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/sourceip"
)

func TestAffinitySameCredentialAndIndependentRows(t *testing.T) {
	var picks atomic.Int32
	a := sourceip.NewAffinity(func() net.IP {
		return net.IPv4(127, 0, 0, byte(picks.Add(1)+1))
	}, func(net.IP) bool { return true })
	first := a.Pick("cred-a", time.Hour)
	for i := 0; i < 100; i++ {
		if next := a.Pick("cred-a", time.Hour); !first.Equal(next) {
			t.Fatalf("credential changed address: %s -> %s", first, next)
		}
	}
	if second := a.Pick("cred-b", time.Hour); first.Equal(second) {
		t.Fatal("different credential reused the first row's affinity entry")
	}
	if n := picks.Load(); n != 2 {
		t.Fatalf("100 hits and a new credential made %d picks, want 2", n)
	}
	first[0] ^= 0xff
	if got := a.Pick("cred-a", time.Hour); !got.Equal(net.IPv4(127, 0, 0, 2)) {
		t.Fatal("caller mutated a cached source address")
	}
	if got := a.Pick("", time.Hour); got != nil {
		t.Fatal("missing credential ID must not become one global affinity")
	}
}

func TestAffinityConcurrentFirstPick(t *testing.T) {
	var picks atomic.Int32
	a := sourceip.NewAffinity(func() net.IP {
		return net.IPv4(127, 0, 0, byte(picks.Add(1)+1))
	}, func(net.IP) bool { return true })
	var wg sync.WaitGroup
	results := make(chan string, 64)
	for i := 0; i < cap(results); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- a.Pick("cred-concurrent", time.Hour).String()
		}()
	}
	wg.Wait()
	close(results)
	for ip := range results {
		if ip != "127.0.0.2" {
			t.Fatalf("concurrent credential used %s, want 127.0.0.2", ip)
		}
	}
	if n := picks.Load(); n != 1 {
		t.Fatalf("concurrent first requests picked %d addresses, want 1", n)
	}
}

func TestAffinityBurnAndAbsoluteTTL(t *testing.T) {
	var picks int
	usable := map[string]bool{}
	a := sourceip.NewAffinity(func() net.IP {
		picks++
		ip := net.IPv4(127, 0, 1, byte(picks))
		usable[ip.String()] = true
		return ip
	}, func(ip net.IP) bool { return usable[ip.String()] })
	first := a.Pick("cred-burn", time.Hour)
	usable[first.String()] = false
	if next := a.Pick("cred-burn", time.Hour); first.Equal(next) {
		t.Fatal("burned address survived the next credential pick")
	}
	const ttl = 60 * time.Millisecond
	first = a.Pick("cred-expire", ttl)
	time.Sleep(ttl / 2)
	if next := a.Pick("cred-expire", ttl); !first.Equal(next) {
		t.Fatal("unexpired affinity changed")
	}
	time.Sleep(ttl)
	if next := a.Pick("cred-expire", ttl); first.Equal(next) {
		t.Fatal("a cache hit extended the absolute TTL")
	}
}

func TestAffinityPolicyTTLChange(t *testing.T) {
	var picks int
	a := sourceip.NewAffinity(func() net.IP {
		picks++
		return net.IPv4(127, 0, 2, byte(picks))
	}, func(net.IP) bool { return true })
	first := a.Pick("cred-policy", time.Hour)
	if next := a.Pick("cred-policy", time.Second); first.Equal(next) {
		t.Fatal("operator's shorter TTL retained the hour-long lease")
	}
}

func TestStickyTTLBounds(t *testing.T) {
	for _, tc := range []struct{ in, want time.Duration }{
		{0, time.Hour}, {-time.Second, time.Hour}, {time.Second, time.Second},
		{48 * time.Hour, 24 * time.Hour},
	} {
		if got := sourceip.StickyTTL(tc.in); got != tc.want {
			t.Errorf("StickyTTL(%v) = %v, want %v", tc.in, got, tc.want)
		}
	}
}
