package egress

import (
	"net"
	"net/http"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/sourceip"
)

// Source injection is test-only: production must use the assigned-address and
// burn table together, while socket tests use 127/8 without changing interfaces.
func NewWithSourcesForTest(base *http.Client, pick func() net.IP, usable func(net.IP) bool, burn func(net.IP, time.Duration), fixed func() net.IP) *Manager {
	m := New(base)
	m.affinity = sourceip.NewAffinity(pick, usable)
	m.burn, m.fixed = burn, fixed
	return m
}

func ClientCountForTest(m *Manager) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.clients)
}

func CloseForTest(m *Manager) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, entry := range m.clients {
		entry.client.CloseIdleConnections()
	}
}
