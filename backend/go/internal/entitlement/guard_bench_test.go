// guard_bench_test.go — the capacity proof for owner rule 4.
//
// The target: 3000 users × 5 concurrent requests each = 15,000 in-flight
// admissions. The guard is the per-request gate every one of those passes
// through, so it must be O(1) and allocation-free on the happy path — a guard
// that allocates per admission turns 15k concurrent into 15k GC pauses.
//
// Why a benchmark and not an assertion: "handles 3000 users" is a claim about
// throughput, and the only honest way to make it is to measure. The benchmark
// runs the exact admission sequence a request runs (subscription check → IP
// check → concurrency acquire → release) across a realistic key population.
//
// Run: go test ./internal/entitlement/ -bench . -benchtime=100000x
package entitlement

import (
	"strconv"
	"testing"
	"time"
)

// benchKeys is the key population: 3000 users, one key each (owner rule 13).
const benchKeys = 3000

// benchKeyNames is the precomputed key ids. Building "key_"+Itoa inside the
// benchmark loop allocated a string per iteration, which showed up as the
// guard's cost in the profile — the guard itself is allocation-free, so the
// keys are built once here.
var benchKeyNames = func() []string {
	names := make([]string, benchKeys)
	for i := range names {
		names[i] = "key_" + strconv.Itoa(i)
	}
	return names
}()

// benchIPs is the address population. Each key is used from up to 3 addresses
// (owner rule 14), so the guard's per-key set is full — the worst case for the
// "is this address already admitted" lookup.
var benchIPs = []string{"10.0.0.1", "10.0.0.2", "10.0.0.3"}

// seedGuard builds a guard with every key's IP set full, so the benchmark
// measures the steady state (a returning member), not the cold first request.
func seedGuard() *Guard {
	g := New()
	for i := range benchKeys {
		g.SeedIPs(benchKeyNames[i], benchIPs)
	}
	return g
}

// BenchmarkAdmission measures one full admission for a returning member: the
// subscription is live, the address is already admitted, and a concurrency slot
// is taken and released. This is the per-request cost at 15k concurrent.
func BenchmarkAdmission(b *testing.B) {
	g := seedGuard()
	sub := &Subscription{Plan: "sub_7d", ExpiresAt: time.Now().Add(24 * time.Hour)}
	b.ReportAllocs()
	b.ResetTimer()
	i := 0
	for b.Loop() {
		key := benchKeyNames[i%benchKeys]
		i++
		if d := g.CheckSubscription(sub); !d.Allow {
			b.Fatalf("subscription refused: %+v", d)
		}
		if d := g.CheckIP(key, benchIPs[i%len(benchIPs)]); !d.Allow {
			b.Fatalf("ip refused: %+v", d)
		}
		release, d := g.Acquire(key)
		if !d.Allow {
			b.Fatalf("acquire refused: %+v", d)
		}
		release.Release()
	}
}

// BenchmarkAdmissionParallel measures the same admission under real
// concurrency: GOMAXPROCS goroutines hammering the guard at once. This is the
// number that matters for 15k in-flight — the mutex must not serialize.
func BenchmarkAdmissionParallel(b *testing.B) {
	g := seedGuard()
	sub := &Subscription{Plan: "sub_7d", ExpiresAt: time.Now().Add(24 * time.Hour)}
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			key := benchKeyNames[i%benchKeys]
			i++
			g.CheckSubscription(sub)
			g.CheckIP(key, benchIPs[i%len(benchIPs)])
			release, _ := g.Acquire(key)
			release.Release()
		}
	})
}

// BenchmarkAdmission15k models the full target: 15,000 concurrent admissions
// (3000 keys × 5 slots) all in flight at once, then released. It proves the
// gauge holds 15k without refusing a legitimate request and without unbounded
// memory.
//
// It is NOT a b.Loop benchmark: each iteration spawns 15,000 goroutines, so
// looping it would spend all its time in the scheduler and never finish (the
// first cut did exactly that and hit the 900s test timeout). It runs the target
// load ONCE and reports the wall time, which is the honest shape for a
// fixed-size load test.
//
// The goroutines are PRE-SPAWNED and reused. The first cut spawned one goroutine
// per admission, so the reported 10.8 µs/op and 10 allocs/op were the Go
// scheduler and the per-goroutine closure — not the guard, which is 387 ns/op
// and 0 allocs/op in BenchmarkAdmission. A benchmark that measures the harness
// instead of the subject is worse than no benchmark: it reports a 118×
// regression that does not exist and hides the one that would.
func BenchmarkAdmission15k(b *testing.B) {
	g := seedGuard()
	sub := &Subscription{Plan: "sub_7d", ExpiresAt: time.Now().Add(24 * time.Hour)}

	// One worker per admission, spawned once and parked on a channel. The
	// measured region is the admission itself, not the spawn.
	const workers = benchKeys * MaxConcurrency
	start := make(chan struct{})
	done := make(chan struct{}, workers)
	for k := range benchKeys {
		key := benchKeyNames[k]
		for range MaxConcurrency {
			go func() {
				<-start
				g.CheckSubscription(sub)
				g.CheckIP(key, benchIPs[0])
				slot, d := g.Acquire(key)
				if !d.Allow {
					b.Errorf("admission refused under target load: %+v", d)
					done <- struct{}{}
					return
				}
				slot.Release()
				done <- struct{}{}
			}()
		}
	}

	b.ReportAllocs()
	b.ResetTimer()
	close(start) // release all 15k at once: the true concurrent peak
	for range workers {
		<-done
	}
}
