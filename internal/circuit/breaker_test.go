package circuit

import (
	"testing"
	"time"
)

func TestBreaker_Closed_AllowsRequests(t *testing.T) {
	b := New(3, 2, time.Second)
	if !b.Allow() {
		t.Error("expected breaker to allow request when closed")
	}
}

func TestBreaker_Open_BlocksRequests(t *testing.T) {
	b := New(2, 1, time.Second)
	b.RecordFailure()
	b.RecordFailure()

	if b.Allow() {
		t.Error("expected breaker to block request when open")
	}
}

func TestBreaker_HalfOpen_AllowsProbe(t *testing.T) {
	b := New(2, 1, time.Second)
	b.RecordFailure()
	b.RecordFailure()

	// Wait for timeout
	time.Sleep(1100 * time.Millisecond)

	if !b.Allow() {
		t.Error("expected breaker to allow probe request in half-open state")
	}
}

func TestBreaker_HalfOpen_SuccessCloses(t *testing.T) {
	b := New(2, 2, time.Second)
	b.RecordFailure()
	b.RecordFailure()

	time.Sleep(1100 * time.Millisecond)
	b.Allow() // probe
	b.RecordSuccess()
	b.RecordSuccess()

	if b.State() != StateClosed {
		t.Errorf("expected breaker to be closed, got %s", b.State())
	}
}

func TestBreaker_HalfOpen_FailureReopens(t *testing.T) {
	b := New(2, 2, time.Second)
	b.RecordFailure()
	b.RecordFailure()

	time.Sleep(1100 * time.Millisecond)
	b.Allow() // probe
	b.RecordFailure()

	if b.State() != StateOpen {
		t.Errorf("expected breaker to be open, got %s", b.State())
	}
}

func TestBreaker_Stats(t *testing.T) {
	b := New(3, 2, time.Second)
	b.RecordFailure()
	// Note: RecordSuccess in closed state resets failures to 0
	b.RecordSuccess()

	stats := b.Stats()
	if stats["failures"] != 0 {
		t.Errorf("expected 0 failures (reset on success), got %v", stats["failures"])
	}
	// In closed state, successes are not tracked (only in half-open)
	if stats["successes"] != 0 {
		t.Errorf("expected 0 successes (not tracked in closed state), got %v", stats["successes"])
	}
}

func TestManager_Get_CreatesBreaker(t *testing.T) {
	m := NewManager(Config{FailureThreshold: 3, SuccessThreshold: 2, Timeout: time.Second})
	b := m.Get("test-provider")
	if b == nil {
		t.Fatal("expected breaker to be created")
	}
}

func TestManager_Allow(t *testing.T) {
	m := NewManager(Config{FailureThreshold: 3, SuccessThreshold: 2, Timeout: time.Second})
	if !m.Allow("test-provider") {
		t.Error("expected manager to allow request")
	}
}

func TestManager_RecordSuccessAndFailure(t *testing.T) {
	m := NewManager(Config{FailureThreshold: 3, SuccessThreshold: 2, Timeout: time.Second})
	m.RecordSuccess("test-provider")
	m.RecordFailure("test-provider")

	if m.State("test-provider") != StateClosed {
		t.Errorf("expected state to be closed, got %s", m.State("test-provider"))
	}
}

func TestManager_Stats(t *testing.T) {
	m := NewManager(Config{FailureThreshold: 3, SuccessThreshold: 2, Timeout: time.Second})
	m.RecordSuccess("provider-a")
	m.RecordFailure("provider-b")

	stats := m.Stats()
	if len(stats) != 2 {
		t.Errorf("expected 2 providers in stats, got %d", len(stats))
	}
}
