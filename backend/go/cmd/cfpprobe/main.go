// cfpprobe breaks one playground call into its phases so optimisation targets
// the real cost instead of the imagined one.
//
// A cfp request is: TCP+TLS dial (Chrome fingerprint, own /128) → WebSocket
// upgrade → cf_agent_stream_resume_request → setConfig RPC ack → chat POST →
// streamed tokens. Sequential p50 is ~5s; if most of that is handshake, the win
// is a warm session pool. If it is model latency, only more parallelism helps.
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/cfp"
)

func main() {
	n := 5
	if len(os.Args) > 1 {
		fmt.Sscanf(os.Args[1], "%d", &n)
	}
	model := "cfp/gpt-oss-20b"
	var total time.Duration
	for i := 0; i < n; i++ {
		start := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		// OnDelta timestamps the first streamed byte, which splits "connect and
		// negotiate" from "the model is thinking".
		var firstByte time.Duration
		res, err := cfp.Chat(ctx, cfp.Options{
			Model: model,
			Messages: []cfp.Message{
				{Role: "user", Content: "Reply with exactly: PONG"},
			},
			OnDelta: func(kind, _ string) {
				if firstByte == 0 {
					firstByte = time.Since(start)
				}
			},
		})
		cancel()
		elapsed := time.Since(start)
		total += elapsed
		if err != nil {
			fmt.Printf("%d  ERR after %-8s %v\n", i+1, elapsed.Round(time.Millisecond), err)
			continue
		}
		fmt.Printf("%d  total=%-8s first_token=%-8s text=%q\n",
			i+1, elapsed.Round(time.Millisecond), firstByte.Round(time.Millisecond), res.Text)
	}
	fmt.Printf("mean=%.2fs over %d\n", total.Seconds()/float64(n), n)
}