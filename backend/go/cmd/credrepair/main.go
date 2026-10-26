// Command credrepair repairs credential rows whose secret was stored as a
// BARE KEY instead of the account JSON the data plane parses
// (proxy/targets.go accountFromSecret: {"api_key"|"access_token"|
// "refresh_token": ...}).
//
// Why this exists: a farm batch (metadata {"source":"farm"}) wrote 9805 dahl
// rows at 2026-10-26 14:00 as raw `dahl_<key>` strings. AES decryption
// succeeds, so the rows sit marked healthy in the DB, but every routing
// attempt logs `credential <id> malformed` and skips them — 3.8M log lines
// and a dead 10k-account pool.
//
// The repair is format-only: a decrypted plaintext that is not account JSON
// but is a non-empty bare string is exactly a static API key, so it is
// re-encrypted as {"api_key": "<bare>"}. Rows that already parse as account
// JSON are untouched. Nothing is deleted; an empty secret is reported and
// skipped, never silently "fixed".
//
// Usage:
//   credrepair --provider prv-dahl [--apply]
// Dry-run is the default; --apply writes. Idempotent: a repaired row parses
// as JSON on the next run.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/crypt"
	"github.com/jackc/pgx/v5/pgxpool"
)

// accountFields mirrors proxy/targets.go accountFromSecret: the JSON shape
// the data plane accepts.
type accountFields struct {
	APIKey       string `json:"api_key"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
}

func main() {
	provider := flag.String("provider", "", "provider slug to repair (e.g. prv-dahl)")
	apply := flag.Bool("apply", false, "write repairs (default: dry-run)")
	flag.Parse()
	if *provider == "" {
		fmt.Fprintln(os.Stderr, "usage: credrepair --provider <slug> [--apply]")
		os.Exit(2)
	}

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		fmt.Fprintln(os.Stderr, "DATABASE_URL is not set")
		os.Exit(1)
	}
	c, err := crypt.New(os.Getenv("CREDENTIALS_MASTER_KEY"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "crypt:", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		fmt.Fprintln(os.Stderr, "pgxpool:", err)
		os.Exit(1)
	}
	defer pool.Close()

	rows, err := pool.Query(ctx, `
		select c.id, c.secret_enc
		from credential c
		join connection cn on c.connection_id = cn.id
		join provider p on cn.provider_id = p.id
		where p.slug = $1`, *provider)
	if err != nil {
		fmt.Fprintln(os.Stderr, "query:", err)
		os.Exit(1)
	}

	var scanned, jsonOK, bare, empty, undecryptable, other int
	type fix struct{ id, plain string }
	var fixes []fix

	for rows.Next() {
		var id, enc string
		if err := rows.Scan(&id, &enc); err != nil {
			fmt.Fprintln(os.Stderr, "scan:", err)
			os.Exit(1)
		}
		scanned++
		plain, err := c.Decrypt(enc)
		if err != nil {
			undecryptable++
			continue
		}
		var f accountFields
		if err := json.Unmarshal([]byte(plain), &f); err == nil {
			if f.APIKey != "" || f.AccessToken != "" || f.RefreshToken != "" {
				jsonOK++
			} else {
				other++
			}
			continue
		}
		// Not account JSON. A non-empty bare string is a static API key.
		if strings.TrimSpace(plain) == "" {
			empty++
			continue
		}
		bare++
		fixes = append(fixes, fix{id, plain})
	}
	rows.Close()

	fmt.Printf("scanned=%d already_json=%d bare_key=%d empty=%d undecryptable=%d json_without_fields=%d\n",
		scanned, jsonOK, bare, empty, undecryptable, other)

	if len(fixes) == 0 {
		fmt.Println("nothing to repair")
		return
	}
	if !*apply {
		fmt.Printf("dry-run: %d row(s) would be re-encrypted as {\"api_key\": ...}\n", len(fixes))
		for i, f := range fixes {
			if i == 3 {
				fmt.Println("  ...")
				break
			}
			head := f.plain
			if len(head) > 6 {
				head = head[:6]
			}
			fmt.Printf("  %s -> {\"api_key\": %q…}\n", f.id, head)
		}
		return
	}

	done := 0
	for _, f := range fixes {
		wrapped, err := json.Marshal(map[string]string{"api_key": f.plain})
		if err != nil {
			fmt.Fprintln(os.Stderr, "marshal:", err)
			os.Exit(1)
		}
		enc, err := c.Encrypt(string(wrapped))
		if err != nil {
			fmt.Fprintln(os.Stderr, "encrypt:", err)
			os.Exit(1)
		}
		if _, err := pool.Exec(ctx,
			`update credential set secret_enc = $2, updated_at = now() where id = $1`,
			f.id, enc); err != nil {
			fmt.Fprintf(os.Stderr, "update %s: %v\n", f.id, err)
			os.Exit(1)
		}
		done++
		if done%1000 == 0 {
			fmt.Printf("  %d/%d\n", done, len(fixes))
		}
	}
	fmt.Printf("repaired=%d\n", done)
}
