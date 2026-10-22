package keys

import (
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	p, ok := Parse("sk-ar-abcdefgh_0123456789abcdef0123456789abcdef")
	if !ok || p.Prefix != "abcdefgh" || p.Secret != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("got %+v ok=%v", p, ok)
	}
	// M-b: the 128-character cap and the bounded printable charset. Before
	// this, arbitrary bytes reached the sha256 and the prefix lookup —
	// unbounded length hashed per request, and control characters in the
	// prefix flowed into logs and SQL. The charset is base64url because that
	// is what generateApiKey mints (pages.mjs:22, playground.mjs:258); see
	// Parse for why the two halves differ on `_`.
	for _, bad := range []string{
		"",
		"sk-wrong-x_y",
		"sk-ar-abc_short",
		"sk-ar-abc_0123456789abcdef",
		"sk-ar-abcdefgh_0123456789abcde",
		"sk-ar-abcdefgh_" + strings.Repeat("a", 129), // secret over the 128 cap
		"sk-ar-abcdefgh_0123456789abcdef\n",          // control char in secret
		"sk-ar-abc def_0123456789abcdef",             // space in prefix
		"sk-ar-abcdefgh_0123456789abcde+f",           // '+' in secret
		"sk-ar-abc\u00e9fgh_0123456789abcdef",
		"sk-ar-abc_def_0123456789abcdef", // '_' in prefix: it is the delimiter
		"sk-ar-abcdefgh_0123456789abcdef/", // '/' in secret: not base64url
	} {
		if _, ok := Parse(bad); ok {
			t.Errorf("accepted bad key %q", bad)
		}
	}
	// The regression this pins: the alphanumeric-only check rejected every
	// minted key whose prefix or secret contained `-` (base64url alphabet),
	// which is roughly half of them — 5 of 69 live keys were unauthenticatable
	// with "malformed api key". Both halves must accept `-`, and the secret
	// must accept `_`.
	for _, good := range []string{
		"sk-ar-abcdefgh_0123456789abcdef0123456789abcdef",
		"sk-ar-ab-cd-efg_0123456789abcdef0123456789abcdef", // '-' in prefix
		"sk-ar-abcdefgh_0123456789abcdef-0123456789abcde",  // '-' in secret
		"sk-ar-abcdefgh_0123456789abcdef_0123456789abcde",  // '_' in secret
	} {
		if _, ok := Parse(good); !ok {
			t.Errorf("rejected minted key %q", good)
		}
	}
}

func TestHashAndEqualConstantTime(t *testing.T) {
	h := Hash("0123456789abcdef0123456789abcdef")
	if len(h) != 64 {
		t.Fatalf("hash length %d", len(h))
	}
	if !Equal(h, Hash("0123456789abcdef0123456789abcdef")) {
		t.Error("same secret should match")
	}
	if Equal(h, Hash("different-secret-0123456789abcdef")) {
		t.Error("different secret should not match")
	}
}

// TestNoPlaintextSecretAtRest pins the property that separates this router from
// gateways that store the working key verbatim (9Router keeps the plaintext in
// its apiKeys.key column and emits it from exportDb(), so any backup file
// contains live credentials). The stored value must be the sha256 of the secret
// and nothing else: it must not contain the secret, and the secret must not be
// recoverable from it. Verified by mutation: changing Hash to return the secret
// unchanged fails the first assertion.
func TestNoPlaintextSecretAtRest(t *testing.T) {
	secret := "0123456789abcdef0123456789abcdef"
	stored := Hash(secret)
	if strings.Contains(stored, secret) {
		t.Fatal("the stored hash contains the plaintext secret")
	}
	if len(stored) != 64 {
		t.Fatalf("stored value is not a sha256 hex digest: %d chars", len(stored))
	}
	// A sha256 digest is preimage-resistant, but the property that actually
	// protects a leaked dump is that the stored value is not the secret and
	// cannot be replayed as one: authentication compares Hash(presented),
	// never the stored value directly.
	if Equal(stored, secret) {
		t.Fatal("the stored value authenticates as the secret itself")
	}
}
