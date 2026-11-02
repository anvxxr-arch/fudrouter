// blobshape prints the FIELDS (never the values) of a provider's routing pool
// blob and of one credential row, so a blob can be rebuilt from the credential
// table without guessing the schema.
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
	pid := os.Args[1]

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
	var obj map[string]json.RawMessage
	if err := json.Unmarshal([]byte(plain), &obj); err != nil {
		fmt.Println("not object:", err)
		os.Exit(1)
	}
	fmt.Println("top-level keys:")
	for k, v := range obj {
		fmt.Printf("  %s (raw %d bytes)\n", k, len(v))
	}
	var accts []map[string]any
	for _, v := range obj {
		if json.Unmarshal(v, &accts) == nil && len(accts) > 0 {
			break
		}
	}
	if len(accts) == 0 {
		fmt.Println("no account array found")
		return
	}
	fmt.Printf("account[0] fields (%d accounts):\n", len(accts))
	var fields []string
	for k := range accts[0] {
		fields = append(fields, k)
	}
	sort.Strings(fields)
	for _, f := range fields {
		switch v := accts[0][f].(type) {
		case string:
			fmt.Printf("  %-16s string(len=%d)\n", f, len(v))
		default:
			fmt.Printf("  %-16s %T\n", f, v)
		}
	}

	fmt.Println("\ncredential table row for the same provider:")
	rows, err := conn.Query(ctx, `select cr.name, cr.secret_enc, cr.metadata from credential cr
		join connection c on c.id = cr.connection_id
		where c.provider_id = $1 and cr.status = 'healthy' limit 1`, pid)
	if err != nil {
		fmt.Println("cred query:", err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var name, sec string
		var meta []byte
		if err := rows.Scan(&name, &sec, &meta); err != nil {
			continue
		}
		dec, err := c.Decrypt(sec)
		if err != nil {
			fmt.Printf("  secret_enc: DECRYPT_FAIL %v\n", err)
		} else {
			fmt.Printf("  secret_enc: decrypts to a %d byte string\n", len(dec))
		}
		var m map[string]any
		json.Unmarshal(meta, &m)
		var mk []string
		for k := range m {
			mk = append(mk, k)
		}
		sort.Strings(mk)
		fmt.Printf("  metadata keys: %v\n", mk)
	}
}