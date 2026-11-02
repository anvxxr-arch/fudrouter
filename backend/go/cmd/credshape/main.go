// credshape reports the SHAPE of credential secrets (JSON keys, lengths,
// character classes) with every value masked, so a routing-pool blob can be
// rebuilt from the credential table without leaking a single key.
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

func mask(s string) string {
	if len(s) <= 6 {
		return fmt.Sprintf("<%d chars>", len(s))
	}
	return s[:3] + "..." + s[len(s)-2:] + fmt.Sprintf(" (%d chars)", len(s))
}

func main() {
	c, err := crypt.New(os.Getenv("CREDENTIALS_MASTER_KEY"))
	if err != nil { fmt.Println("crypt:", err); os.Exit(1) }
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, os.Getenv("DATABASE_URL"))
	if err != nil { fmt.Println("db:", err); os.Exit(1) }
	defer conn.Close(ctx)

	rows, err := conn.Query(ctx, `select cr.name, cr.status, cr.secret_enc, cr.metadata
		from credential cr join connection cn on cn.id = cr.connection_id
		where cn.provider_id = $1 and cr.status = 'healthy' limit 3`, os.Args[1])
	if err != nil { fmt.Println("query:", err); os.Exit(1) }
	defer rows.Close()
	for rows.Next() {
		var name, status, sec string
		var meta []byte
		if err := rows.Scan(&name, &status, &sec, &meta); err != nil { continue }
		dec, err := c.Decrypt(sec)
		if err != nil { fmt.Printf("name=%s status=%s DECRYPT_FAIL\n", mask(name), status); continue }
		fmt.Printf("name=%s status=%s\n", mask(name), status)
		var obj map[string]any
		if json.Unmarshal([]byte(dec), &obj) == nil {
			var ks []string
			for k := range obj { ks = append(ks, k) }
			sort.Strings(ks)
			fmt.Printf("  JSON keys: %v\n", ks)
			for _, k := range ks {
				if sv, ok := obj[k].(string); ok {
					fmt.Printf("    %-14s %s\n", k, mask(sv))
				} else {
					fmt.Printf("    %-14s %T\n", k, obj[k])
				}
			}
		} else {
			fmt.Printf("  not JSON: %s\n", mask(dec))
		}
		fmt.Printf("  metadata: %s\n", string(meta))
	}
}
