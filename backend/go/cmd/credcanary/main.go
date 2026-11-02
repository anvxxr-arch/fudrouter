// credcanary plants a KNOWN-DEAD credential at the head of a provider's keyed
// pool so the rotation path (401/403 → next account) can be proven end to end:
// the picker walks `order by priority asc, weight desc, id`, so an id that
// sorts below every real key is always picked first.
//
//	go run ./cmd/credcanary plant mistral [key]
//	go run ./cmd/credcanary status mistral
//	go run ./cmd/credcanary drop   mistral
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/crypt"
)

const canaryID = "cred_canary_0000000000000000"

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: credcanary plant|status|drop <provider-slug-without-prv_> [key]")
		os.Exit(2)
	}
	action, provider := os.Args[1], os.Args[2]

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, mustEnv("DATABASE_URL"))
	if err != nil {
		fatal("pgxpool", err)
	}
	defer pool.Close()

	connID := "con_prv_" + provider + "-default"

	switch action {
	case "plant":
		key := "sk-canary-dead-key-00000000000000000000000000000000000000000000"
		if len(os.Args) > 3 {
			key = os.Args[3]
		}
		// accountFromSecret (internal/proxy/targets.go) requires JSON with
		// access_token/refresh_token or api_key — a bare key string is dropped
		// as "malformed" and never enters the pool.
		secret := fmt.Sprintf(`{"api_key":%q,"email":"canary@fudrouter.invalid"}`, key)
		c, err := crypt.FromEnv()
		if err != nil {
			fatal("crypt", err)
		}
		enc, err := c.Encrypt(secret)
		if err != nil {
			fatal("encrypt", err)
		}
		_, err = pool.Exec(ctx, `
			insert into credential (id, connection_id, name, secret_enc, status, priority, weight, metadata)
			values ($1, $2, 'canary-dead-key', $3, 'healthy', 100, 100, '{"canary":true}'::jsonb)
			on conflict (id) do update set secret_enc = excluded.secret_enc, status='healthy',
			                               cooldown_until = null, updated_at = now()`,
			canaryID, connID, enc)
		if err != nil {
			fatal("insert", err)
		}
		fmt.Printf("planted %s on %s (enc %d bytes)\n", canaryID, connID, len(enc))
	case "status":
		var status, cooldown string
		err := pool.QueryRow(ctx,
			`select status, coalesce(to_char(cooldown_until,'HH24:MI:SS'),'-') from credential where id=$1`,
			canaryID).Scan(&status, &cooldown)
		if err != nil {
			fatal("status", err)
		}
		fmt.Printf("canary status=%s cooldown_until=%s\n", status, cooldown)
	case "drop":
		tag, err := pool.Exec(ctx, `delete from credential where id = $1`, canaryID)
		if err != nil {
			fatal("delete", err)
		}
		fmt.Printf("dropped %s (rows %d)\n", canaryID, tag.RowsAffected())
	default:
		fmt.Fprintln(os.Stderr, "unknown action", action)
		os.Exit(2)
	}
}

func mustEnv(k string) string {
	v := os.Getenv(k)
	if v == "" {
		fatal("env", fmt.Errorf("%s is empty (source ../../.env first)", k))
	}
	return v
}

func fatal(what string, err error) {
	fmt.Fprintf(os.Stderr, "credcanary: %s: %v\n", what, err)
	os.Exit(1)
}
