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
	// M-b: the 128-character cap and the [A-Za-z0-9] charset. Before this,
	// arbitrary bytes reached the sha256 and the prefix lookup — unbounded
	// length hashed per request, and control characters in the prefix flowed
	// into logs and SQL. The wire format is ids.New output, so none of these
	// is a legitimate key.
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
	} {
		if _, ok := Parse(bad); ok {
			t.Errorf("accepted bad key %q", bad)
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
