package proxy_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/ids"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
	"github.com/jackc/pgx/v5"
)

// The economic layer (design §5) splits the customer debit (`cost`), the
// three-valued COGS (`provider_cost_micro`) and the frsubs retail-equivalent
// meter (`quota_usage_micro`). These end-to-end cases pin the three bucket
// shapes at the ledger: a flat-fee bucket debits 0 and (only for frsubs)
// meters, while frpayg + real COGS adds markup on top of the provider cost
// rather than passing through retail.

type econRow struct {
	Bucket, BillingBasis, CostBasis string
	MarkupMillionths, Cost          int64
	QuotaUsageMicro                 *int64
	ProviderCostMicro               *int64
}

func econRowFor(t *testing.T, dsn, apiKeyID string) econRow {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var r econRow
	err = conn.QueryRow(ctx, `
		select coalesce(bucket,''), coalesce(billing_basis,''), coalesce(cost_basis,''),
		       markup_millionths, cost, quota_usage_micro, provider_cost_micro
		from request_log
		where api_key_id = $1 order by created_at desc, id desc limit 1`, apiKeyID).
		Scan(&r.Bucket, &r.BillingBasis, &r.CostBasis, &r.MarkupMillionths, &r.Cost,
			&r.QuotaUsageMicro, &r.ProviderCostMicro)
	if err != nil {
		t.Fatalf("economic row: %v", err)
	}
	return r
}

func setAccountBucket(t *testing.T, dsn, userID, bucket string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx,
		`update billing_account set bucket = $2 where user_id = $1`, userID, bucket); err != nil {
		t.Fatalf("set bucket %s: %v", bucket, err)
	}
}

func insertProviderCostRule(t *testing.T, dsn, providerModelID, source, inputPrice string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `
		insert into provider_cost_rule (provider_model_id, version, currency, input_price, output_price, source, effective_from)
		values ($1, 1, 'USD', $2::numeric, $2::numeric, $3, now() - interval '1 minute')`,
		providerModelID, inputPrice, source); err != nil {
		t.Fatalf("seed provider_cost_rule: %v", err)
	}
}

func insertBucketMargin(t *testing.T, dsn, bucket, modelID string, markupMillionths int64) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `
		insert into bucket_margin (id, bucket, model_id, markup_millionths, effective_from)
		values ($1, $2, $3, $4, now() - interval '1 minute')`,
		ids.New("bm"), bucket, modelID, markupMillionths); err != nil {
		t.Fatalf("seed bucket_margin: %v", err)
	}
}

func callChat(t *testing.T, p interface {
	ServeCompletions(http.ResponseWriter, *http.Request)
}, env *tests.Env) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	body := `{"model":"` + env.Slug + `","stream":false,"messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeCompletions(rec, req)
	return rec
}

const economicUsageBody = `{"id":"c1","object":"chat.completion","choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":1000,"completion_tokens":0,"total_tokens":1000}}`

func TestEconomicFlatFeeDebitsZero(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := jsonUpstream(t, economicUsageBody, nil, 200)
	defer up.Close()

	t.Run("frcheap cost=0 and no meter", func(t *testing.T) {
		env := tests.SeedEnv(t, dsn, up.URL)
		setAccountBucket(t, dsn, env.UserID, "frcheap")
		p := tests.NewProxy(t, dsn, up.URL)
		if rec := callChat(t, p, env); rec.Code != http.StatusOK {
			t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
		}
		r := econRowFor(t, dsn, env.APIKeyID)
		if r.Cost != 0 {
			t.Errorf("frcheap cost = %d, want 0 (flat fee arrives via credit_purchase)", r.Cost)
		}
		if r.Bucket != "frcheap" {
			t.Errorf("bucket = %q, want frcheap", r.Bucket)
		}
		if r.QuotaUsageMicro != nil {
			t.Errorf("frcheap quota_usage_micro = %v, want NULL (not a metered bucket)", *r.QuotaUsageMicro)
		}
	})

	t.Run("frsubs cost=0 but meters retail-equivalent usage", func(t *testing.T) {
		env := tests.SeedEnv(t, dsn, up.URL)
		setAccountBucket(t, dsn, env.UserID, "frsubs")
		p := tests.NewProxy(t, dsn, up.URL)
		if rec := callChat(t, p, env); rec.Code != http.StatusOK {
			t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
		}
		r := econRowFor(t, dsn, env.APIKeyID)
		if r.Cost != 0 {
			t.Errorf("frsubs cost = %d, want 0 (time-based plan)", r.Cost)
		}
		if r.CostBasis != "subscription_flat" {
			t.Errorf("cost_basis = %q, want subscription_flat", r.CostBasis)
		}
		if r.ProviderCostMicro != nil {
			t.Errorf("frsubs provider_cost_micro = %v, want NULL (flat already paid)", *r.ProviderCostMicro)
		}
		if r.QuotaUsageMicro == nil {
			t.Fatalf("frsubs quota_usage_micro is NULL, want the retail-equivalent meter")
		}
		// 1000 input tokens at 150000 micro-USD/1M = 150 micro-USD.
		if *r.QuotaUsageMicro != 150 {
			t.Errorf("frsubs quota_usage_micro = %d, want 150", *r.QuotaUsageMicro)
		}
	})
}

func TestEconomicPaygMarkupOverRealCogs(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := jsonUpstream(t, economicUsageBody, nil, 200)
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	// Real COGS: $0.003/1M -> 1000 tokens = 3 micro-USD of provider cost.
	insertProviderCostRule(t, dsn, env.ProviderModelID, "invoice", "3000.000000")
	// 1.3x markup on the provider cost only.
	insertBucketMargin(t, dsn, "frpayg", env.ModelID, 1_300_000)

	p := tests.NewProxy(t, dsn, up.URL)
	if rec := callChat(t, p, env); rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	r := econRowFor(t, dsn, env.APIKeyID)

	if r.ProviderCostMicro == nil {
		t.Fatalf("frpayg provider_cost_micro is NULL, want 3 (real COGS)")
	}
	if *r.ProviderCostMicro != 3 {
		t.Errorf("provider_cost_micro = %d, want 3", *r.ProviderCostMicro)
	}
	// MarkupMicro(3, 1_300_000) = (3*1_300_000 + 500_000)/1_000_000 = 4.
	if r.Cost != 4 {
		t.Errorf("frpayg cost = %d, want 4 (marked-up COGS, not the 150 retail passthrough)", r.Cost)
	}
	if r.BillingBasis != "provider" {
		t.Errorf("billing_basis = %q, want provider", r.BillingBasis)
	}
	if r.CostBasis != "provider" {
		t.Errorf("cost_basis = %q, want provider", r.CostBasis)
	}
	if r.MarkupMillionths != 1_300_000 {
		t.Errorf("markup_millionths = %d, want 1300000", r.MarkupMillionths)
	}
	if r.QuotaUsageMicro != nil {
		t.Errorf("frpayg quota_usage_micro = %v, want NULL (metered by cost, not retail)", *r.QuotaUsageMicro)
	}
}
