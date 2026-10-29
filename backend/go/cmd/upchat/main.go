// Command upchat asks an upstream what it can actually serve, using the very
// credential the router would use.
//
// Why this exists: our model rows are cached snapshots of upstream catalogues,
// and they rot. Probing a provider by flipping its stale rows on reports 404 /
// 502 and looks like "provider dead", when the truth is usually "we are asking
// for a model id the upstream no longer has". upchat reads the live /models
// list with the real credential, then chats ids taken from THAT list, so a
// verdict of dead means dead.
//
// Usage: go run ./cmd/upchat <provider_id> [model_filter]
package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/crypt"
)

type credRow struct {
	BaseURL string
	Config  []byte
	Secret  string
	Name    string
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: upchat <provider_id> [filter]")
		os.Exit(2)
	}
	provider := os.Args[1]
	filter := ""
	if len(os.Args) > 2 {
		filter = strings.ToLower(os.Args[2])
	}
	db, err := sql.Open("pgx", os.Getenv("DATABASE_URL"))
	if err != nil {
		panic(err)
	}
	defer db.Close()
	box, err := crypt.New(os.Getenv("CREDENTIALS_MASTER_KEY"))
	if err != nil {
		panic(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	rows, err := db.QueryContext(ctx, `
		select c.base_url, coalesce(c.config::text,'{}'), cr.secret_enc, coalesce(cr.name,'')
		from connection c
		join credential cr on cr.connection_id = c.id
		where c.provider_id = $1 and c.enabled
		  and cr.status not in ('disabled','invalid')
		order by cr.id limit 3`, provider)
	if err != nil {
		panic(err)
	}
	var creds []credRow
	for rows.Next() {
		var r credRow
		var cfg string
		if err := rows.Scan(&r.BaseURL, &cfg, &r.Secret, &r.Name); err != nil {
			panic(err)
		}
		r.Config = []byte(cfg)
		creds = append(creds, r)
	}
	rows.Close()
	if len(creds) == 0 {
		fmt.Printf("%s: no usable credential rows\n", provider)
		return
	}
	base := strings.TrimRight(creds[0].BaseURL, "/")
	var cfg struct {
		AuthKind       string            `json:"auth_kind"`
		Protocol       string            `json:"protocol"`
		DefaultHeaders map[string]string `json:"default_headers"`
	}
	_ = json.Unmarshal(creds[0].Config, &cfg)
	fmt.Printf("%s  base=%s auth_kind=%s proto=%s creds=%d\n", provider, base, cfg.AuthKind, cfg.Protocol, len(creds))

	var apiKey string
	for _, c := range creds {
		plain, err := box.Decrypt(c.Secret)
		if err != nil {
			continue
		}
		var s struct {
			APIKey      string `json:"api_key"`
			AccessToken string `json:"access_token"`
		}
		if json.Unmarshal([]byte(plain), &s) == nil {
			if s.APIKey != "" {
				apiKey = s.APIKey
				break
			}
			if s.AccessToken != "" {
				apiKey = s.AccessToken
				break
			}
		}
	}
	hdrs := func() map[string]string {
		h := map[string]string{"Content-Type": "application/json", "User-Agent": "fudrouter-upchat/1"}
		if cfg.AuthKind != "noauth" && apiKey != "" {
			h["Authorization"] = "Bearer " + apiKey
		}
		for k, v := range cfg.DefaultHeaders {
			h[k] = v
		}
		return h
	}
	client := &http.Client{Timeout: 45 * time.Second}

	// 1) live catalogue
	req, _ := http.NewRequest("GET", base+"/models", nil)
	for k, v := range hdrs() {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("  /models transport: %v\n", err)
		return
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	fmt.Printf("  /models -> %d (%d bytes)\n", resp.StatusCode, len(body))
	var cat struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
		Models []struct {
			ID string `json:"id"`
		} `json:"models"`
	}
	_ = json.Unmarshal(body, &cat)
	var ids []string
	for _, m := range cat.Data {
		ids = append(ids, m.ID)
	}
	for _, m := range cat.Models {
		ids = append(ids, m.ID)
	}
	sort.Strings(ids)
	if filter != "" {
		var keep []string
		for _, id := range ids {
			if strings.Contains(strings.ToLower(id), filter) {
				keep = append(keep, id)
			}
		}
		ids = keep
	}
	fmt.Printf("  catalogue: %d ids\n", len(ids))
	if len(ids) > 0 {
		show := ids
		if len(show) > 12 {
			show = show[:12]
		}
		fmt.Printf("  e.g. %s\n", strings.Join(show, ", "))
	}

	// 2) chat the first few ids that look like chat models
	tried, ok := 0, 0
	for _, id := range ids {
		if tried >= 4 {
			break
		}
		low := strings.ToLower(id)
		if strings.Contains(low, "embed") || strings.Contains(low, "whisper") || strings.Contains(low, "tts") || strings.Contains(low, "image") {
			continue
		}
		tried++
		payload, _ := json.Marshal(map[string]any{
			"model":      id,
			"messages":   []map[string]string{{"role": "user", "content": "reply with the single word OK"}},
			"max_tokens": 16,
		})
		creq, _ := http.NewRequest("POST", base+"/chat/completions", bytes.NewReader(payload))
		for k, v := range hdrs() {
			creq.Header.Set(k, v)
		}
		t0 := time.Now()
		cresp, err := client.Do(creq)
		if err != nil {
			fmt.Printf("  chat %-44s TRANSPORT %v\n", id, err)
			continue
		}
		cb, _ := io.ReadAll(cresp.Body)
		cresp.Body.Close()
		snippet := strings.ReplaceAll(string(cb), "\n", " ")
		if len(snippet) > 90 {
			snippet = snippet[:90]
		}
		status := "DEAD"
		if cresp.StatusCode == 200 {
			status = "SERVES"
			ok++
		}
		fmt.Printf("  chat %-44s %s %5.2fs %s\n", id, status, time.Since(t0).Seconds(), snippet)
	}
	fmt.Printf("  verdict: %d/%d chat-capable\n", ok, tried)
}