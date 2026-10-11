package tests

import "testing"

// databaseName must read the target out of every DSN shape a developer or CI
// might actually use, because the guard silently trusts a wrong answer by
// returning "" (treated as "not production", i.e. allowed).
func TestDatabaseName(t *testing.T) {
	cases := []struct {
		dsn  string
		want string
	}{
		{"postgres://u:p@127.0.0.1:5432/fudrouter", "fudrouter"},
		{"postgresql://u:p@127.0.0.1:5432/fudrouter", "fudrouter"},
		{"postgres://u:p@127.0.0.1:5432/fudrouter?sslmode=disable", "fudrouter"},
		{"postgres://u:p@127.0.0.1:5432/fudrouter_audit", "fudrouter_audit"},
		// a slash inside the password must not be mistaken for the path
		{"postgres://u:pa/ss@127.0.0.1:5432/fudrouter", "fudrouter"},
		// key=value form
		{"host=127.0.0.1 port=5432 dbname=fudrouter user=u", "fudrouter"},
		{"dbname=fudrouter_audit host=127.0.0.1", "fudrouter_audit"},
	}
	for _, c := range cases {
		if got := databaseName(c.dsn); got != c.want {
			t.Errorf("databaseName(%q) = %q, want %q", c.dsn, got, c.want)
		}
	}
}

func TestDatabaseNameUnknownStaysEmpty(t *testing.T) {
	// An unreadable DSN must not be mistaken for a known name.
	for _, dsn := range []string{"", "not-a-dsn", "postgres://", "host=127.0.0.1"} {
		if got := databaseName(dsn); got != "" {
			t.Errorf("databaseName(%q) = %q, want \"\"", dsn, got)
		}
	}
}
