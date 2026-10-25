package proxy

import (
	"net/http"
	"syscall"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/netguard"
)

// The data plane's SSRF guard lives in internal/netguard so every outbound
// upstream client enforces one rule. It was once implemented here alone, which
// left a second upstream client unguarded: a provider whose blob named that
// protocol could dial the internal network. See internal/netguard for the
// rationale.
//
// These aliases exist so the guard stays callable by its original name at the
// construction sites in proxy.go. They are one line each and add no behaviour.

// allowPrivateUpstreams reads the escape hatch from the environment.
func allowPrivateUpstreams() bool { return netguard.AllowPrivate() }

// dialControl is the dial-time SSRF hook for the [OI] upstream client.
func dialControl(allowPrivate bool) func(network, address string, c syscall.RawConn) error {
	return netguard.DialControl(allowPrivate)
}

// guardedRedirectPolicy bounds and screens the [OI] client's redirect chain.
func guardedRedirectPolicy(req *http.Request, via []*http.Request) error {
	return netguard.RedirectPolicy(req, via)
}
