// Package keys parses and validates sk-ar- API keys.
// Wire format: sk-ar-<prefix>_<secret>. Only sha256(secret) is stored.
package keys

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"strings"
)

type Key struct {
	Prefix string
	Secret string
}

func Parse(k string) (Key, bool) {
	const marker = "sk-ar-"
	if !strings.HasPrefix(k, marker) {
		return Key{}, false
	}
	rest := k[len(marker):]
	i := strings.IndexByte(rest, '_')
	if i < 4 {
		return Key{}, false
	}
	prefix, secret := rest[:i], rest[i+1:]
	if len(secret) < 16 || len(secret) > 128 {
		return Key{}, false
	}
	// M-b: both halves must be bounded, printable ASCII. Anything else reached
	// the sha256 and the prefix lookup with attacker-chosen bytes — unbounded
	// length hashed per request (a cheap DoS), and control/whitespace
	// characters in the prefix flowed into logs and SQL lookups.
	//
	// The charset is base64url, not [A-Za-z0-9]: `generateApiKey` in
	// apps/web/server/pages.mjs:22 (and playground.mjs:258) mints BOTH halves
	// with `randomBytes(N).toString('base64url')`, whose alphabet is
	// [A-Za-z0-9_-]. The alphanumeric-only check that shipped here rejected
	// every key whose 8-char prefix happened to contain `-` or `_`, and roughly
	// half of all minted prefixes do — measured on the live table, 5 of 69
	// active keys had a `-`. Those customers got "malformed api key", a 401
	// with no way to recover, because their key was minted by us and is valid.
	//
	// The two halves differ on `_` only because the FIRST `_` is the delimiter:
	// the minter loops until the prefix excludes it (`while (prefix.includes('_'))`),
	// while the secret may contain it. `-` is legal in both.
	if !isPrefixChars(prefix) || !isSecretChars(secret) {
		return Key{}, false
	}
	return Key{Prefix: prefix, Secret: secret}, true
}

// isPrefixChars reports whether s is entirely [A-Za-z0-9-] (base64url minus the
// `_` delimiter).
func isPrefixChars(s string) bool {
	for i := range len(s) {
		c := s[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}

// isSecretChars reports whether s is entirely [A-Za-z0-9_-] (the full base64url
// alphabet).
func isSecretChars(s string) bool {
	for i := range len(s) {
		c := s[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func Hash(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

// Equal compares two hex hashes in constant time.
func Equal(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
