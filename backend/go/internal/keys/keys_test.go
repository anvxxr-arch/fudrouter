package keys

import "testing"

func TestParse(t *testing.T) {
	p, ok := Parse("sk-ar-abcdefgh_0123456789abcdef0123456789abcdef")
	if !ok || p.Prefix != "abcdefgh" || p.Secret != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("got %+v ok=%v", p, ok)
	}
	for _, bad := range []string{
		"",
		"sk-wrong-x_y",
		"sk-ar-abc_short",
		"sk-ar-abc_0123456789abcdef",
		"sk-ar-abcdefgh_0123456789abcde",
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
