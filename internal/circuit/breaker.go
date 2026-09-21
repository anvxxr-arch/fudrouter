package circuit

import (
	"sync"
	"time"
)

// State represents the state of a circuit breaker.
type State int

const (
	StateClosed State = iota
	StateOpen
	StateHalfOpen
)

// Breaker is a circuit breaker implementation.
type Breaker struct {
	mu sync.RWMutex

	// Configuration
	failureThreshold int
	successThreshold int
	timeout          time.Duration

	// State
	state           State
	failures        int
	successes       int
	lastFailureTime time.Time
}

// New creates a new circuit Breaker.
func New(failureThreshold, successThreshold int, timeout time.Duration) *Breaker {
	return &Breaker{
		failureThreshold: failureThreshold,
		successThreshold: successThreshold,
		timeout:          timeout,
		state:            StateClosed,
	}
}

// Allow returns true if the circuit breaker allows the request.
func (b *Breaker) Allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	switch b.state {
	case StateClosed:
		return true
	case StateOpen:
		if time.Since(b.lastFailureTime) > b.timeout {
			b.state = StateHalfOpen
			return true
		}
		return false
	case StateHalfOpen:
		return true
	}
	return false
}

// RecordSuccess records a successful request.
func (b *Breaker) RecordSuccess() {
	b.mu.Lock()
	defer b.mu.Unlock()

	switch b.state {
	case StateHalfOpen:
		b.successes++
		if b.successes >= b.successThreshold {
			b.state = StateClosed
			b.failures = 0
			b.successes = 0
		}
	case StateClosed:
		b.failures = 0
	}
}

// RecordFailure records a failed request.
func (b *Breaker) RecordFailure() {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.lastFailureTime = time.Now()

	switch b.state {
	case StateHalfOpen:
		b.state = StateOpen
		b.successes = 0
	case StateClosed:
		b.failures++
		if b.failures >= b.failureThreshold {
			b.state = StateOpen
		}
	}
}

// State returns the current state of the circuit breaker.
func (b *Breaker) State() State {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.state
}

// Stats returns the current statistics of the circuit breaker.
func (b *Breaker) Stats() map[string]any {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return map[string]any{
		"state":            b.state.String(),
		"failures":         b.failures,
		"successes":        b.successes,
		"last_failure_time": b.lastFailureTime,
	}
}

func (s State) String() string {
	switch s {
	case StateClosed:
		return "closed"
	case StateOpen:
		return "open"
	case StateHalfOpen:
		return "half-open"
	}
	return "unknown"
}

// Manager manages circuit breakers for multiple providers.
type Manager struct {
	mu       sync.RWMutex
	breakers map[string]*Breaker
	config   Config
}

// Config holds the circuit breaker configuration.
type Config struct {
	FailureThreshold int
	SuccessThreshold int
	Timeout          time.Duration
}

// NewManager creates a new circuit breaker Manager.
func NewManager(config Config) *Manager {
	return &Manager{
		breakers: make(map[string]*Breaker),
		config:   config,
	}
}

// Get returns the circuit breaker for a provider, creating one if needed.
func (m *Manager) Get(providerID string) *Breaker {
	m.mu.RLock()
	b, ok := m.breakers[providerID]
	m.mu.RUnlock()
	if ok {
		return b
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	b = New(m.config.FailureThreshold, m.config.SuccessThreshold, m.config.Timeout)
	m.breakers[providerID] = b
	return b
}

// Allow returns true if the circuit breaker for a provider allows the request.
func (m *Manager) Allow(providerID string) bool {
	return m.Get(providerID).Allow()
}

// RecordSuccess records a successful request for a provider.
func (m *Manager) RecordSuccess(providerID string) {
	m.Get(providerID).RecordSuccess()
}

// RecordFailure records a failed request for a provider.
func (m *Manager) RecordFailure(providerID string) {
	m.Get(providerID).RecordFailure()
}

// State returns the state of the circuit breaker for a provider.
func (m *Manager) State(providerID string) State {
	return m.Get(providerID).State()
}

// Stats returns the statistics for all circuit breakers.
func (m *Manager) Stats() map[string]map[string]any {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make(map[string]map[string]any)
	for id, b := range m.breakers {
		out[id] = b.Stats()
	}
	return out
}
