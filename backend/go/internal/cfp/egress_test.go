package cfp_test

// The native playground path must honor an injected egress dialer and burn the
// socket it actually used. These tests exercise dispatch/rejection hooks only;
// they do not claim a Cloudflare WS session or the operator pool worked live.

import (
	"context"
	"errors"
	"fmt"
	"net"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/cfp"
)

func TestCFPUsesConfiguredEgressDial(t *testing.T) {
	calls, rejects := 0, 0
	_, err := cfp.Chat(context.Background(), cfp.Options{
		Model: "test-model", Messages: []cfp.Message{{Role: "user", Content: "hi"}},
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			calls++
			if network != "tcp" || address != "playground.ai.cloudflare.com:443" {
				t.Fatalf("native dial target changed: %s %s", network, address)
			}
			return nil, errors.New("injected dial intentionally blocked")
		},
		OnReject: func(net.IP, int) { rejects++ },
	})
	if err == nil || calls != 1 || rejects != 0 {
		t.Fatalf("native egress hook: calls=%d rejects=%d err=%v", calls, rejects, err)
	}
}

func TestCFPRejectReportsActualSource(t *testing.T) {
	actual := net.ParseIP("2404:c0:b204:a199::abc")
	for _, status := range []int{402, 429, 403, 502} {
		calls := 0
		opt := cfp.Options{OnReject: func(ip net.IP, got int) {
			calls++
			if !actual.Equal(ip) || got != status {
				t.Fatalf("native burn changed identity: %s status=%d", ip, got)
			}
		}}
		cfp.RejectSourceForTest(opt, actual, fmt.Errorf("wrapped: %w", &cfp.Error{Status: status, Msg: "fixture rejection"}))
		want := 1
		if status == 502 {
			want = 0
		}
		if calls != want {
			t.Fatalf("status %d: native burn callback calls=%d want=%d", status, calls, want)
		}
	}
}
