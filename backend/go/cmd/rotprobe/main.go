// Throwaway: hammer the rotating client against OVH's gpt-oss-120b and print
// the verbatim transport error (the router only stores the error code).
package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/sourceip"
)

func main() {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		d := &net.Dialer{Timeout: 20 * time.Second, KeepAlive: 30 * time.Second}
		if ip := sourceip.Pick(); ip != nil && strings.HasPrefix(network, "tcp") {
			bound := *d
			bound.LocalAddr = &net.TCPAddr{IP: ip}
			if conn, err := bound.DialContext(ctx, network, addr); err == nil {
				return conn, nil
			} else {
				fmt.Printf("    bindfail: %v\n", err)
			}
		}
		return d.DialContext(ctx, network, addr)
	}
	body := `{"model":"gpt-oss-120b","messages":[{"role":"user","content":"say PONG"}],"max_tokens":16}`
	for i := 1; i <= 6; i++ {
		req, _ := http.NewRequest("POST", "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		t0 := time.Now()
		resp, err := (&http.Client{Transport: tr, Timeout: 40 * time.Second}).Do(req)
		if err != nil {
			fmt.Printf("try%d %s TRANSPORT: %v\n", i, time.Since(t0).Round(time.Millisecond), err)
			continue
		}
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 120))
		resp.Body.Close()
		fmt.Printf("try%d %s status=%d %s\n", i, time.Since(t0).Round(time.Millisecond), resp.StatusCode, b)
		time.Sleep(1500 * time.Millisecond)
	}
}