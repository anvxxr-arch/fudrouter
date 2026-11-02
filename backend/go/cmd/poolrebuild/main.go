// poolrebuild rebuilds a provider's ROUTING pool blob from its credential table.
//
// The problem it fixes: the router serves a connection from
// provider.credentials_enc (one encrypted blob), while the farm writes its keys
// into the `credential` table. For prv_tokenharbor the blob held 171 accounts
// against 19,281 healthy credential rows — 1% of the pool existed as far as
// routing was concerned, and because MarkFailed parks an account on its first
// 429, those 171 died after ~36 successful requests and the API answered
// PROVIDER_UNAVAILABLE at ~1 rps.
//
// Only the "accounts" key is replaced; api_key / auth_kind / default_headers
// from the existing blob are preserved. The old blob is written to
// /home/dwizzy/backups/pool-<provider>-<ts>.enc before the UPDATE.
//
// Usage: poolrebuild [-n] <provider_id>
//   -n   dry run: report what would be written, change nothing
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/crypt"
	"github.com/jackc/pgx/v5"
)

type account struct {
	AccessToken  string  `json:"access_token"`
	Email        string  `json:"email"`
	Expired      string  `json:"expired"`
	RefreshToken *string `json:"refresh_token"`
}

func main() {
	dry := flag.Bool("n", false, "dry run")
	flag.Parse()
	if flag.NArg() < 1 {
		fmt.Println("usage: poolrebuild [-n] <provider_id>")
		os.Exit(2)
	}
	pid := flag.Arg(0)

	c, err := crypt.New(os.Getenv("CREDENTIALS_MASTER_KEY"))
	if err != nil {
		fmt.Println("crypt:", err)
		os.Exit(1)
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		fmt.Println("db:", err)
		os.Exit(1)
	}
	defer conn.Close(ctx)

	var enc string
	if err := conn.QueryRow(ctx, `select credentials_enc from provider where id=$1`, pid).Scan(&enc); err != nil {
		fmt.Println("provider:", err)
		os.Exit(1)
	}
	plain, err := c.Decrypt(enc)
	if err != nil {
		fmt.Println("decrypt:", err)
		os.Exit(1)
	}
	var blob map[string]json.RawMessage
	if err := json.Unmarshal([]byte(plain), &blob); err != nil {
		fmt.Println("blob not an object:", err)
		os.Exit(1)
	}
	var before []account
	json.Unmarshal(blob["accounts"], &before)

	rows, err := conn.Query(ctx, `select cr.id, cr.name, cr.secret_enc
		from credential cr join connection cn on cn.id = cr.connection_id
		where cn.provider_id = $1 and cr.status = 'healthy'
		order by cr.id`, pid)
	if err != nil {
		fmt.Println("cred query:", err)
		os.Exit(1)
	}
	defer rows.Close()

	// Long-lived API keys: an expiry far in the future means the pool never tries
	// to refresh a key it cannot refresh.
	far := time.Now().UTC().AddDate(20, 0, 0).Format(time.RFC3339)
	var accts []account
	var unreadable int
	seen := map[string]bool{}
	for rows.Next() {
		var id, name, sec string
		if err := rows.Scan(&id, &name, &sec); err != nil {
			continue
		}
		dec, err := c.Decrypt(sec)
		if err != nil {
			unreadable++
			continue
		}
		var sk map[string]any
		if json.Unmarshal([]byte(dec), &sk) != nil {
			unreadable++
			continue
		}
		tok, _ := sk["api_key"].(string)
		if tok == "" {
			// Some providers store the raw token rather than {"api_key": ...}.
			tok = dec
		}
		if tok == "" || seen[tok] {
			continue
		}
		seen[tok] = true
		mail, _ := sk["email"].(string)
		if mail == "" {
			mail = name
		}
		accts = append(accts, account{AccessToken: tok, Email: mail, Expired: far})
	}
	sort.Slice(accts, func(i, j int) bool { return accts[i].Email < accts[j].Email })

	fmt.Printf("%s: blob accounts %d -> %d (decrypt failures %d, duplicates skipped %d)\n",
		pid, len(before), len(accts), unreadable, len(seen)-len(accts))
	if len(accts) == 0 {
		fmt.Println("refusing to write an empty pool")
		os.Exit(1)
	}
	if *dry {
		fmt.Println("dry run: nothing written")
		return
	}

	raw, err := json.Marshal(accts)
	if err != nil {
		fmt.Println("marshal:", err)
		os.Exit(1)
	}
	blob["accounts"] = raw
	out, err := json.Marshal(blob)
	if err != nil {
		fmt.Println("marshal blob:", err)
		os.Exit(1)
	}
	newEnc, err := c.Encrypt(string(out))
	if err != nil {
		fmt.Println("encrypt:", err)
		os.Exit(1)
	}

	backupDir := "/home/dwizzy/backups"
	os.MkdirAll(backupDir, 0o700)
	backup := filepath.Join(backupDir, fmt.Sprintf("pool-%s-%s.enc", pid, time.Now().Format("20060102-150405")))
	if err := os.WriteFile(backup, []byte(enc), 0o600); err != nil {
		fmt.Println("backup:", err)
		os.Exit(1)
	}
	if _, err := conn.Exec(ctx, `update provider set credentials_enc=$2, updated_at=now() where id=$1`, pid, newEnc); err != nil {
		fmt.Println("update:", err)
		os.Exit(1)
	}
	fmt.Printf("written: blob accounts now %d, backup at %s\n", len(accts), backup)
	fmt.Println("NOTE: restart the router — the pool is loaded into memory at boot.")
}