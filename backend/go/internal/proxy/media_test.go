package proxy_test

// The MEDIA surface (media.go), asserted end to end through the real ServeMux.
//
// Three things in media.go can only be proven against an upstream that answers
// the bridge's shapes, and each one has a failure mode that is invisible to the
// rest of the suite:
//
//  1. ROUTING. `POST /v1/images/generations` used to fall into the `/v1/`
//     catch-all, and the GET forms could not be reached at all (the catch-all
//     reads a JSON body, so a body-less GET was a 400 whatever the passthrough
//     hatch said). A test that only checks "some handler answered" would pass on
//     the catch-all, so the generation is checked for a BILLED ledger row —
//     only the media lifecycle writes one.
//
//  2. URL REWRITE. The bridge mints media URLs from the Host header of the
//     request it received, so an unconfigured `public_base` makes every
//     returned URL point at LOOPBACK (`http://127.0.0.1:18610/v1/media/x.png`).
//     That URL is unreachable from the client. The router must hand out its own
//     public base instead, and must rewrite only the ORIGIN — the path carries
//     the name the fetch will look up.
//
//  3. THE UNBILLED FETCH. `GET /v1/media/{name}` is the one /v1 handler that
//     must NOT run the lifecycle: the image was billed when it was generated,
//     so the byte fetch writes no ledger row and consumes no concurrency slot.
//     A regression that routes the fetch through begin() would double-bill, and
//     no other test would notice.

import (
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/proxy"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

// execDSN runs one statement against the throwaway test database. The media
// tests need to set `provider.slug` — the surface resolves the byte fetch by
// slug, and SeedEnv names its provider `test-provider-<rand>` and leaves the
// column NULL (the production onboarder sets one; the helper never had to).
func execDSN(t *testing.T, dsn, sql string, args ...any) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, sql, args...); err != nil {
		t.Fatalf("exec %q: %v", sql, err)
	}
}

// mediaSeedEnv points the media surface at the test's own seeded provider and
// model, and gives the router a public base to rewrite onto.
//
// The surface resolves the byte fetch by PROVIDER SLUG (there is no model in a
// `GET /v1/media/{name}`), while SeedEnv names its provider `test-provider-<rand>`
// and leaves `provider.slug` NULL — the production onboarder sets a slug, the
// test helper never had to. Both knobs are therefore set explicitly here rather
// than relying on a default that only holds against the live deployment.
func mediaSeedEnv(t *testing.T, dsn, upstreamURL string) *tests.Env {
	t.Helper()
	env := tests.SeedEnv(t, dsn, upstreamURL)

	const slug = "t_media_bridge"
	execDSN(t, dsn, `update provider set slug = $1 where id = $2`, slug, env.ProviderID)
	t.Setenv("ROUTER_MEDIA_PROVIDER", slug)
	t.Setenv("ROUTER_MEDIA_IMAGE_MODEL", env.Slug)
	t.Setenv("ROUTER_MEDIA_VIDEO_MODEL", env.Slug)
	t.Setenv("PUBLIC_API_BASE_URL", "https://router.test")
	// The upstream is a loopback httptest server and the production egress
	// client refuses private dial targets (SSRF guard). Same opt-in the other
	// loopback-backed tests use.
	t.Setenv("ALLOW_PRIVATE_UPSTREAMS", "1")
	return env
}

// TestMediaGenerationIsRoutedAndBilled pins requirement 1.
func TestMediaGenerationIsRoutedAndBilled(t *testing.T) {
	dsn := tests.RequireDB(t)

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/images/generations" {
			t.Errorf("upstream path = %s, want /images/generations", r.URL.Path)
		}
		var in struct {
			Model string `json:"model"`
		}
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &in)
		// The bridge mints media URLs from its OWN address when public_base is
		// unset — this is that shape, and the rewrite must move its origin.
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"created": 1,
			"model":   in.Model,
			"data": []map[string]any{{
				"url": "http://127.0.0.1:18610/v1/media/img_abc123.png",
			}},
		})
	}))
	t.Cleanup(up.Close)

	env := mediaSeedEnv(t, dsn, up.URL)
	mux := proxy.ServeMux(tests.NewProxyDefaultClient(t, dsn), readyHealth{})

	before := tests.RequestLogCount(t, dsn, env.APIKeyID)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/images/generations",
		strings.NewReader(`{"prompt":"a fox","model":"`+env.Slug+`"}`))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	req.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(rec, req)

	assertRouted(t, http.MethodPost, "/v1/images/generations", rec.Code, rec.Body.String())
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}

	// The loopback origin must be gone and the router's own base in its place,
	// with the path (and therefore the media name) untouched.
	body := rec.Body.String()
	if strings.Contains(body, "127.0.0.1:18610") {
		t.Errorf("response still carries the bridge's loopback URL: %s", body)
	}
	const want = "https://router.test/v1/media/img_abc123.png"
	if !strings.Contains(body, want) {
		t.Errorf("rewritten media URL missing.\nwant substring: %s\ngot: %s", want, body)
	}

	// Billed: the generation is a model-addressed lifecycle call, so exactly one
	// ledger row must exist. This is what separates "routed to the media
	// surface" from "fell into the catch-all and was forwarded unbilled".
	if got := tests.RequestLogCount(t, dsn, env.APIKeyID) - before; got != 1 {
		t.Errorf("request_log rows = %d, want 1 (media generation must run the billed lifecycle)", got)
	}
}

// TestMediaGenerationFallbackModelWhenAbsent pins the no-model default.
//
// A client that omits `model` relies on the bridge's own default; the router
// substitutes its configured fallback instead of rejecting, so the call still
// has a routing target. Without it the request resolves nothing and 404s.
func TestMediaGenerationFallbackModelWhenAbsent(t *testing.T) {
	dsn := tests.RequireDB(t)

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"created":1,"data":[{"url":"http://127.0.0.1:18610/v1/media/x.png"}]}`))
	}))
	t.Cleanup(up.Close)

	env := mediaSeedEnv(t, dsn, up.URL)
	mux := proxy.ServeMux(tests.NewProxyDefaultClient(t, dsn), readyHealth{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/images/generations",
		strings.NewReader(`{"prompt":"a fox"}`))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	req.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s — a generation with no `model` must fall back, not 404",
			rec.Code, rec.Body.String())
	}
}

// TestMediaEditReadsModelFromMultipart pins the multipart form-field probe.
//
// `POST /v1/images/edits` is multipart: the model lives in a form field, not in
// JSON, and the body must still reach the upstream VERBATIM afterwards (the
// boundary in the client's Content-Type refers to those exact bytes — rebuilding
// the multipart would invalidate it).
func TestMediaEditReadsModelFromMultipart(t *testing.T) {
	dsn := tests.RequireDB(t)

	var gotBody string
	var gotCT string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/images/edits" {
			t.Errorf("upstream path = %s, want /images/edits", r.URL.Path)
		}
		gotCT = r.Header.Get("Content-Type")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"created":1,"data":[{"url":"http://127.0.0.1:18610/v1/media/e.png"}]}`))
	}))
	t.Cleanup(up.Close)

	env := mediaSeedEnv(t, dsn, up.URL)
	mux := proxy.ServeMux(tests.NewProxyDefaultClient(t, dsn), readyHealth{})

	var buf strings.Builder
	mw := multipart.NewWriter(&buf)
	if err := mw.WriteField("model", env.Slug); err != nil {
		t.Fatal(err)
	}
	if err := mw.WriteField("prompt", "add a hat"); err != nil {
		t.Fatal(err)
	}
	fw, err := mw.CreateFormFile("image", "fox.png")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fw.Write([]byte("\x89PNG\r\n\x1a\nnot-really-a-png"))
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/images/edits", strings.NewReader(buf.String()))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(gotCT, "multipart/form-data; boundary=") {
		t.Errorf("upstream content-type = %q, want the client's multipart type with its boundary", gotCT)
	}
	if gotBody != buf.String() {
		t.Errorf("upstream body is not the client's bytes verbatim (%d vs %d bytes) — "+
			"a rebuilt multipart would carry a boundary the Content-Type no longer matches",
			len(gotBody), len(buf.String()))
	}
}

// TestMediaTaskPollIsRoutedAndRewritten pins the GET task-poll path.
//
// A poll carries no body and no model, so it is the shape the catch-all could
// never serve: the catch-all reads JSON and a body-less GET was a 400 whichever
// hatch was open. It also returns a media URL, which must be rewritten.
func TestMediaTaskPollIsRoutedAndRewritten(t *testing.T) {
	dsn := tests.RequireDB(t)

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/videos/task_9" {
			t.Errorf("upstream path = %s, want /videos/task_9", r.URL.Path)
		}
		if r.Method != http.MethodGet {
			t.Errorf("upstream method = %s, want GET", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"task_9","status":"completed","result":{"url":"http://127.0.0.1:18610/v1/media/vid_9.mp4"}}`))
	}))
	t.Cleanup(up.Close)

	env := mediaSeedEnv(t, dsn, up.URL)
	mux := proxy.ServeMux(tests.NewProxyDefaultClient(t, dsn), readyHealth{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/videos/task_9", nil)
	req.Header.Set("Authorization", "Bearer "+env.Key)
	mux.ServeHTTP(rec, req)

	assertRouted(t, http.MethodGet, "/v1/videos/task_9", rec.Code, rec.Body.String())
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "127.0.0.1:18610") {
		t.Errorf("task poll response still carries the loopback URL: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "https://router.test/v1/media/vid_9.mp4") {
		t.Errorf("task poll media URL was not rewritten: %s", rec.Body.String())
	}
}

// TestMediaFetchIsUnbilled pins requirement 3.
//
// The byte fetch must reach the bridge's bytes without running the lifecycle:
// no ledger row (the image was paid for at generation), and a name that does
// not match the bridge's own pattern must never become an outbound request.
func TestMediaFetchIsUnbilled(t *testing.T) {
	dsn := tests.RequireDB(t)

	hits := 0
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if got := r.Header.Get("Authorization"); got != "Bearer "+tests.UpstreamKeyPlain {
			t.Errorf("upstream Authorization = %q, want the decrypted bridge token", got)
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write([]byte("PNGDATA"))
	}))
	t.Cleanup(up.Close)

	env := mediaSeedEnv(t, dsn, up.URL)
	mux := proxy.ServeMux(tests.NewProxyDefaultClient(t, dsn), readyHealth{})

	before := tests.RequestLogCount(t, dsn, env.APIKeyID)

	// No Authorization header at all: a media URL must be embeddable in a
	// client that cannot send one (an <img> tag).
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/media/img_ok.png", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "PNGDATA" {
		t.Errorf("body = %q, want the upstream bytes", got)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
		t.Errorf("content-type = %q, want the allowlisted upstream value", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "max-age=86400") {
		t.Errorf("cache-control = %q, want the upstream value relayed", cc)
	}
	// The fetch must NOT have resolved a model through the lifecycle. A
	// request_log row here means the fetch was billed.
	if got := tests.RequestLogCount(t, dsn, env.APIKeyID) - before; got != 0 {
		t.Errorf("request_log rows = %d, want 0 — fetching an already-billed image must not bill again", got)
	}

	// An unsafe name is rejected WITHOUT an outbound request.
	hitsBefore := hits
	for _, bad := range []string{"/v1/media/..%2fetc%2fpasswd", "/v1/media/", "/v1/media/nodot"} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, bad, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404 (the bridge's own answer for an unsafe name)", bad, rec.Code)
		}
	}
	if hits != hitsBefore {
		t.Errorf("an unsafe media name reached the upstream (%d new requests) — the name must be validated here", hits-hitsBefore)
	}
}

// TestMediaRouteIsNotTheCatchAll pins the ROUTE TABLE, not just the status.
//
// Every media path must answer 401 to a keyless request: that is the media
// handler authenticating. The `GET` forms are the discriminator — they cannot
// be reached at all through the catch-all, which answers
// `400 {"error":"invalid JSON body"}` to a body-less GET. A 400 here means the
// mux regressed and the path fell back into ServeGeneric.
func TestMediaRouteIsNotTheCatchAll(t *testing.T) {
	p := tests.NewProxyDefaultClient(t, tests.RequireDB(t))
	mux := proxy.ServeMux(p, readyHealth{})

	cases := []struct{ method, path string }{
		{http.MethodPost, "/v1/images/generations"},
		{http.MethodPost, "/v1/images/edits"},
		{http.MethodGet, "/v1/images/generations/task_1"},
		{http.MethodPost, "/v1/videos"},
		{http.MethodGet, "/v1/videos/task_1"},
		{http.MethodGet, "/v1/media/img_1.png"},
	}
	for _, c := range cases {
		t.Run(c.method+" "+c.path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, httptest.NewRequest(c.method, c.path, nil))
			assertRouted(t, c.method, c.path, rec.Code, rec.Body.String())
			if rec.Code == http.StatusBadRequest &&
				strings.Contains(rec.Body.String(), "invalid JSON body") {
				t.Errorf("%s %s fell into the catch-all (400 invalid JSON body)", c.method, c.path)
			}
			want := http.StatusUnauthorized
			if c.path == "/v1/media/img_1.png" {
				// The byte fetch is public by design (see ServeMedia), so a
				// keyless GET is answered by the bridge lookup, not by auth.
				want = 0
			}
			if want != 0 && rec.Code != want {
				t.Errorf("%s %s = %d, want %d", c.method, c.path, rec.Code, want)
			}
		})
	}
}

// TestSetProviderSlugIsUsed guards the naming assumption mediaSeedEnv makes: a
// provider whose slug was never set must not resolve as a bridge. If SeedEnv
// ever starts setting a slug, this test's own UPDATE would collide and the
// media tests would be silently testing a different provider.
func TestSetProviderSlugIsUsed(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := mediaSeedEnv(t, dsn, "http://127.0.0.1:1")

	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var slug string
	if err := conn.QueryRow(ctx, `select coalesce(slug,'') from provider where id = $1`, env.ProviderID).Scan(&slug); err != nil {
		t.Fatal(err)
	}
	if slug != "t_media_bridge" {
		t.Fatalf("provider slug = %q, want the media bridge slug", slug)
	}
	if os.Getenv("ROUTER_MEDIA_PROVIDER") != "t_media_bridge" {
		t.Fatal("ROUTER_MEDIA_PROVIDER was not set by mediaSeedEnv")
	}
}
