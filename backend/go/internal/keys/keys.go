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
	// M-b: both halves must be plain [A-Za-z0-9]. Anything else reached the
	// sha256 and the prefix lookup with attacker-chosen bytes — unbounded
	// length hashed per request (a cheap DoS), and control/whitespace
	// characters in the prefix flowed into logs and SQL lookups. The wire
	// format is ids.New output, so this rejects nothing legitimate.
	if !isKeyChars(prefix) || !isKeyChars(secret) {
		return Key{}, false
	}
	return Key{Prefix: prefix, Secret: secret}, true
}

// isKeyChars reports whether s is entirely [A-Za-z0-9] (M-b).
func isKeyChars(s string) bool {
	for i := range len(s) {
		c := s[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9') {
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
