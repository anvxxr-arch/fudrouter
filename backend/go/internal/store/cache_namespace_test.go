package store

import "testing"

// TestCacheNamespaceMatchesConsole pins the namespace derivation against the
// console's reproduction (packages/platform/server/vk.ts cacheNamespace).
//
// Why it exists: the console DELETES the router's cached API key row on revoke
// to honour "revocation takes effect immediately for new requests". If the two
// planes derive the namespace differently the delete silently removes nothing
// and a revoked key keeps authenticating for the TTL — a security regression
// with no error anywhere. The two implementations are in different languages,
// so this is the only place the agreement can be asserted.
//
// The expected value is computed by the TS function, not by this one: copying
// the Go output here would make the test a tautology.
func TestCacheNamespaceMatchesConsole(t *testing.T) {
	cases := []struct {
		dsn  string
		want string
	}{
		// node -e "…vk.ts cacheNamespace('postgres://u:p@127.0.0.1:5432/fudrouter')"
		{"postgres://u:p@127.0.0.1:5432/fudrouter", "78e66ece2b"},
		// A different database must not collide with the first.
		{"postgres://u:p@127.0.0.1:5432/other", "692ef0ec3e"},
	}
	for _, tc := range cases {
		if got := cacheNamespaceFor(tc.dsn); got != tc.want {
			t.Errorf("cacheNamespaceFor(%q) = %q, want %q (the console's value)", tc.dsn, got, tc.want)
		}
	}
}
