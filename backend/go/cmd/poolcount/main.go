// pool_count reports how many credential ACCOUNTS each keyed provider actually
// carries in its routing pool.
//
// Why it matters: the router builds a connection's pool from
// provider.credentials_enc (a single encrypted blob), NOT from the credential
// table. The credential table can say "20,006 healthy" while the routing pool
// holds a few hundred accounts — and a pool that MarkFailed parks on its first
// 429 dies after one pass, which reads at the API as "the provider is
// unavailable" and at the load probe as ~1 rps.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/crypt"
	"github.com/jackc/pgx/v5"
)

func main() {
	key := os.Getenv("CREDENTIALS_MASTER_KEY")
	if key == "" {
		fmt.Println("CREDENTIALS_MASTER_KEY missing")
		os.Exit(1)
	}
	c, err := crypt.New(key)
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

	rows, err := conn.Query(ctx, `select id, credentials_enc from provider where credentials_enc is not null and length(credentials_enc) > 0`)
	if err != nil {
		fmt.Println("query:", err)
		os.Exit(1)
	}
	type res struct {
		ID    string
		Blob  int
		Count int
		Shape string
		Emails int
	}
	var out []res
	for rows.Next() {
		var id, enc string
		if err := rows.Scan(&id, &enc); err != nil {
			continue
		}
		plain, err := c.Decrypt(enc)
		if err != nil {
			out = append(out, res{ID: id, Blob: len(enc), Shape: "DECRYPT_FAIL"})
			continue
		}
		r := res{ID: id, Blob: len(enc)}
		// The blob is either a JSON array of account objects or a JSON object
		// with an "accounts" key; count entries either way.
		var arr []map[string]any
		var obj map[string]json.RawMessage
		switch {
		case json.Unmarshal([]byte(plain), &arr) == nil:
			r.Count, r.Shape = len(arr), "array"
			for _, a := range arr {
				if _, ok := a["email"]; ok {
					r.Emails++
				}
			}
		case json.Unmarshal([]byte(plain), &obj) == nil:
			r.Shape = "object"
			for k, v := range obj {
				var sub []map[string]any
				if json.Unmarshal(v, &sub) == nil {
					r.Shape = "object." + k
					r.Count += len(sub)
					for _, a := range sub {
						if _, ok := a["email"]; ok {
							r.Emails++
						}
					}
				}
			}
		default:
			r.Shape = "unparsed"
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Count > out[j].Count })
	fmt.Printf("%-14s %10s %8s %6s  %s\n", "provider", "blob_bytes", "accounts", "emails", "shape")
	for _, r := range out {
		if r.Count == 0 && r.Blob < 5000 {
			continue
		}
		fmt.Printf("%-14s %10d %8d %6d  %s\n", r.ID, r.Blob, r.Count, r.Emails, r.Shape)
	}
}