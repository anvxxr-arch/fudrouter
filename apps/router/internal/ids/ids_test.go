package ids

import (
	"regexp"
	"strings"
	"testing"
)

// The wire shape is a cross-plane contract: the TS control plane mints the same
// format and both planes parse it back (spec §1). A change here silently breaks
// every id the other plane wrote, so the shape is pinned by regex, not by
// round-trip alone.
func TestNewShape(t *testing.T) {
	id := New("req")
	re := regexp.MustCompile(`^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	if !re.MatchString(id) {
		t.Fatalf("New(\"req\") = %q, want req_<uuidv7-lowercase>", id)
	}
	if Prefix(id) != "req" {
		t.Fatalf("Prefix(%q) = %q, want req", id, Prefix(id))
	}
}

func TestNewIsUnique(t *testing.T) {
	seen := map[string]bool{}
	for range 1000 {
		id := New("req")
		if seen[id] {
			t.Fatalf("duplicate id minted: %s", id)
		}
		seen[id] = true
	}
}

// UUIDv7 embeds a millisecond timestamp in the first 48 bits, so ids minted
// later sort later. The router writes request_log append-only and dashboards
// page by (created_at, id) — a non-time-ordered id would make that tie-break
// arbitrary.
func TestNewIsTimeOrdered(t *testing.T) {
	a := New("req")
	b := New("req")
	if a >= b {
		t.Fatalf("ids not time-ordered: %s !< %s (a uuidv7 regression?)", a, b)
	}
}

// Backfilled ids wrap a legacy id verbatim (`prv_mingles`, spec §1), so the
// prefix is "before the first underscore", not "before the last".
func TestPrefixSplitsOnFirstUnderscore(t *testing.T) {
	cases := []struct{ in, want string }{
		{"usr_u_apkpg2yCQHFi", "usr"},
		{"prv_mingles", "prv"},
		{"req_0199f0d3-9c0a-7b00-8b60-7f4d9c2b1a00", "req"},
		{"nounderscore", "nounderscore"},
	}
	for _, c := range cases {
		if got := Prefix(c.in); got != c.want {
			t.Errorf("Prefix(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// The prefix table is documentation the code can check against: every prefix a
// test mints must exist in it, or the table is drifting from reality.
func TestPrefixTableCoversMintedPrefixes(t *testing.T) {
	for _, p := range []string{"req", "rta", "txn", "evt", "ale"} {
		if _, ok := ID_PREFIXES[p]; !ok {
			t.Errorf("ID_PREFIXES is missing %q", p)
		}
	}
	if !strings.Contains(ID_PREFIXES["req"], "request") {
		t.Error("ID_PREFIXES[req] should name request_log")
	}
}
