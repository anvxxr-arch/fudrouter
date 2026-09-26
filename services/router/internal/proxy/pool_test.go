package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeRefresher stands in for xAI's token endpoint. It counts exchanges per
// refresh token so a test can assert that a valid token is NOT re-exchanged and
// that concurrent callers do not stampede the same account.
type fakeRefresher struct {
	mu    sync.Mutex
	calls map[string]int
	fail  map[string]error
	seq   int
}

func newFakeRefresher() *fakeRefresher {
	return &fakeRefresher{calls: map[string]int{}, fail: map[string]error{}}
}

func (f *fakeRefresher) Refresh(_ context.Context, rt string) (string, string, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls[rt]++
	if err, ok := f.fail[rt]; ok {
		return "", "", 0, err
	}
	f.seq++
	return fmt.Sprintf("access-%d", f.seq), fmt.Sprintf("refresh-%d", f.seq), 21600, nil
}

func (f *fakeRefresher) count(rt string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[rt]
}

type persistedBlob struct {
	mu     sync.Mutex
	blobs  []string
	cur    credentials
	encErr error
}

// seed stands in for another writer (a maintenance rotation, an import) having
// rewritten the blob since this pool was built.
func (p *persistedBlob) seed(c credentials) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.cur = c
}

// load is the read side save merges into.
func (p *persistedBlob) load(_ context.Context) (credentials, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.cur, nil
}

func (p *persistedBlob) encrypt(plain string) (string, error) {
	if p.encErr != nil {
		return "", p.encErr
	}
	return "ENC:" + plain, nil
}

func (p *persistedBlob) persist(_ context.Context, blob string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.blobs = append(p.blobs, blob)
	var c credentials
	if err := json.Unmarshal([]byte(strings.TrimPrefix(blob, "ENC:")), &c); err == nil {
		p.cur = c
	}
	return nil
}

func (p *persistedBlob) last() (credentials, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.blobs) == 0 {
		return credentials{}, false
	}
	raw := strings.TrimPrefix(p.blobs[len(p.blobs)-1], "ENC:")
	var c credentials
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		return credentials{}, false
	}
	return c, true
}

// A rotation that landed from another writer must survive this pool's save. The
// pool's snapshot is not the whole truth: a maintenance rotation holds a newer
// chain for accounts this pool has not touched, and an import adds accounts it
// has never seen. Overwriting the blob with the snapshot loses both.
func TestSaveMergesAnotherWritersRotation(t *testing.T) {
	pb := &persistedBlob{}
	p := testPool([]account{
		{Email: "a@x", AccessToken: "ours", RefreshToken: "rt-ours", Expired: "2026-01-01T00:00:00Z"},
	}, newFakeRefresher(), pb)
	pb.seed(credentials{APIKey: "k", Accounts: []account{
		{Email: "a@x", AccessToken: "theirs", RefreshToken: "rt-theirs", Expired: "2026-02-01T00:00:00Z"},
		{Email: "b@x", AccessToken: "imported", RefreshToken: "rt-b", Expired: "2026-03-01T00:00:00Z"},
	}})

	if err := p.save(context.Background()); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, ok := pb.last()
	if !ok {
		t.Fatal("nothing persisted")
	}
	byEmail := map[string]account{}
	for _, a := range got.Accounts {
		byEmail[a.Email] = a
	}
	if byEmail["a@x"].RefreshToken != "rt-theirs" {
		t.Errorf("a@x kept our older chain (%q), the later rotation was clobbered", byEmail["a@x"].RefreshToken)
	}
	if byEmail["b@x"].AccessToken != "imported" {
		t.Errorf("an account this pool never saw was dropped: %+v", byEmail)
	}
	if len(got.Accounts) != 2 {
		t.Errorf("merged pool has %d accounts, want exactly 2 (no duplicates)", len(got.Accounts))
	}
}

// The mirror case: when this pool holds the later rotation it wins, so a merge
// cannot resurrect the token the pool just rotated away from.
func TestSaveKeepsOurNewerRotation(t *testing.T) {
	pb := &persistedBlob{}
	p := testPool([]account{
		{Email: "a@x", AccessToken: "ours", RefreshToken: "rt-ours", Expired: "2026-02-01T00:00:00Z"},
	}, newFakeRefresher(), pb)
	pb.seed(credentials{APIKey: "k", Accounts: []account{
		{Email: "a@x", AccessToken: "theirs", RefreshToken: "rt-theirs", Expired: "2026-01-01T00:00:00Z"},
	}})

	if err := p.save(context.Background()); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, _ := pb.last()
	if len(got.Accounts) != 1 || got.Accounts[0].RefreshToken != "rt-ours" {
		t.Errorf("our rotation lost to a stale external copy: %+v", got.Accounts)
	}
}

// With no loader wired the old behaviour stands: the snapshot is written.
func TestSaveWithoutLoaderWritesSnapshot(t *testing.T) {
	pb := &persistedBlob{}
	p := newPool(credentials{APIKey: "static-key", Accounts: []account{
		{Email: "a@x", AccessToken: "tok", RefreshToken: "rt", Expired: "2026-01-01T00:00:00Z"},
	}}, newFakeRefresher(), pb.encrypt, pb.persist, nil)
	if err := p.save(context.Background()); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, ok := pb.last()
	if !ok || len(got.Accounts) != 1 {
		t.Fatalf("snapshot not written: %+v", got)
	}
}

func future() string { return time.Now().Add(time.Hour).UTC().Format(time.RFC3339) }
func past() string   { return time.Now().Add(-time.Hour).UTC().Format(time.RFC3339) }

func testPool(accts []account, r TokenRefresher, pb *persistedBlob) *Pool {
	return newPool(credentials{APIKey: "static-key", Accounts: accts}, r, pb.encrypt, pb.persist, pb.load)
}

// Pick must spread requests over the pool instead of hammering one account.
func TestPickRoundRobinsAccounts(t *testing.T) {
	pb := &persistedBlob{}
	p := testPool([]account{
		{Email: "a@x", AccessToken: "tok-a", RefreshToken: "rt-a", Expired: future()},
		{Email: "b@x", AccessToken: "tok-b", RefreshToken: "rt-b", Expired: future()},
	}, newFakeRefresher(), pb)

	got := make([]string, 0, 4)
	for i := 0; i < 4; i++ {
		tok, err := p.Pick(context.Background())
		if err != nil {
			t.Fatalf("Pick: %v", err)
		}
		got = append(got, tok.Token)
	}
	want := []string{"tok-a", "tok-b", "tok-a", "tok-b"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("round-robin order = %v, want %v", got, want)
		}
	}
}

// Pick must attribute the credential to its account: without the email there is
// no way to tell a pool that spreads from one that collapsed onto a single
// account, because request_log has no account column.
func TestPickReportsServingAccount(t *testing.T) {
	pb := &persistedBlob{}
	p := testPool([]account{
		{Email: "a@x", AccessToken: "tok-a", RefreshToken: "rt-a", Expired: future()},
		{Email: "b@x", AccessToken: "tok-b", RefreshToken: "rt-b", Expired: future()},
	}, newFakeRefresher(), pb)

	first, err := p.Pick(context.Background())
	if err != nil {
		t.Fatalf("Pick: %v", err)
	}
	if first.Email != "a@x" {
		t.Fatalf("first Pick email = %q, want a@x", first.Email)
	}
	second, err := p.Pick(context.Background())
	if err != nil {
		t.Fatalf("Pick: %v", err)
	}
	if second.Email != "b@x" {
		t.Fatalf("second Pick email = %q, want b@x", second.Email)
	}
	// The static-key fallback must still be attributable.
	sp := testPool(nil, newFakeRefresher(), pb)
	fb, err := sp.Pick(context.Background())
	if err != nil {
		t.Fatalf("static Pick: %v", err)
	}
	if fb.Email == "" {
		t.Fatal("static api_key pick has no account label")
	}
}

// An expired access token must be exchanged, and because xAI rotates the
// refresh token the new one must be written back — otherwise the account is
// dead at the next expiry.
func TestPickRefreshesExpiredTokenAndPersistsRotation(t *testing.T) {
	fr := newFakeRefresher()
	pb := &persistedBlob{}
	p := testPool([]account{
		{Email: "a@x", AccessToken: "stale", RefreshToken: "rt-old", Expired: past()},
	}, fr, pb)

	tok, err := p.Pick(context.Background())
	if err != nil {
		t.Fatalf("Pick: %v", err)
	}
	if tok.Token == "stale" || tok.Token == "" {
		t.Fatalf("Pick returned %q, want a freshly exchanged token", tok)
	}
	if n := fr.count("rt-old"); n != 1 {
		t.Fatalf("refresh calls = %d, want 1", n)
	}

	c, ok := pb.last()
	if !ok {
		t.Fatal("rotated credentials were never persisted")
	}
	if len(c.Accounts) != 1 {
		t.Fatalf("persisted %d accounts, want 1", len(c.Accounts))
	}
	if c.Accounts[0].RefreshToken == "rt-old" {
		t.Fatal("persisted blob still holds the pre-rotation refresh token")
	}
	if c.Accounts[0].AccessToken != tok.Token {
		t.Fatalf("persisted access token %q != served token %q", c.Accounts[0].AccessToken, tok)
	}
	if c.APIKey != "static-key" {
		t.Fatalf("api_key fallback lost during persist: %q", c.APIKey)
	}
}

// A token that is still valid must not be exchanged — every exchange burns a
// rotation and a network round-trip.
func TestPickDoesNotRefreshValidToken(t *testing.T) {
	fr := newFakeRefresher()
	pb := &persistedBlob{}
	p := testPool([]account{
		{Email: "a@x", AccessToken: "good", RefreshToken: "rt-a", Expired: future()},
	}, fr, pb)

	for i := 0; i < 3; i++ {
		tok, err := p.Pick(context.Background())
		if err != nil {
			t.Fatalf("Pick: %v", err)
		}
		if tok.Token != "good" {
			t.Fatalf("Pick = %q, want the stored valid token", tok)
		}
	}
	if n := fr.count("rt-a"); n != 0 {
		t.Fatalf("refresh calls = %d, want 0 for a valid token", n)
	}
	if _, ok := pb.last(); ok {
		t.Fatal("a valid token must not trigger a persist")
	}
}

// One unusable account must not fail the request while another can serve it.
func TestPickSkipsAccountThatCannotRefresh(t *testing.T) {
	fr := newFakeRefresher()
	fr.fail["rt-dead"] = errors.New("invalid_grant: Refresh token has been revoked")
	pb := &persistedBlob{}
	p := testPool([]account{
		{Email: "dead@x", AccessToken: "stale", RefreshToken: "rt-dead", Expired: past()},
		{Email: "live@x", AccessToken: "live-tok", RefreshToken: "rt-live", Expired: future()},
	}, fr, pb)

	for i := 0; i < 4; i++ {
		tok, err := p.Pick(context.Background())
		if err != nil {
			t.Fatalf("Pick %d: %v", i, err)
		}
		if tok.Token != "live-tok" {
			t.Fatalf("Pick %d = %q, want the healthy account", i, tok)
		}
	}
	// The revoked account is parked, so it is not retried on every request.
	if n := fr.count("rt-dead"); n != 1 {
		t.Fatalf("dead account refresh attempts = %d, want 1 (then parked)", n)
	}
}

// A provider with only a static key keeps working — the pool must not be a
// requirement.
func TestPickFallsBackToStaticAPIKey(t *testing.T) {
	pb := &persistedBlob{}
	p := testPool(nil, newFakeRefresher(), pb)

	tok, err := p.Pick(context.Background())
	if err != nil {
		t.Fatalf("Pick: %v", err)
	}
	if tok.Token != "static-key" {
		t.Fatalf("Pick = %q, want the static api_key", tok)
	}
}

// Concurrent requests must not stampede the token endpoint for one account.
func TestConcurrentPickRefreshesOncePerAccount(t *testing.T) {
	fr := newFakeRefresher()
	pb := &persistedBlob{}
	p := testPool([]account{
		{Email: "a@x", AccessToken: "stale", RefreshToken: "rt-a", Expired: past()},
	}, fr, pb)

	const n = 32
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := p.Pick(context.Background()); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent Pick: %v", err)
	}
	if c := fr.count("rt-a"); c != 1 {
		t.Fatalf("refresh calls = %d, want exactly 1 for a single account", c)
	}
}

// A credential the upstream rejects must be parked so the next request picks a
// different account.
func TestMarkFailedParksAccount(t *testing.T) {
	fr := newFakeRefresher()
	pb := &persistedBlob{}
	p := testPool([]account{
		{Email: "a@x", AccessToken: "tok-a", RefreshToken: "rt-a", Expired: future()},
		{Email: "b@x", AccessToken: "tok-b", RefreshToken: "rt-b", Expired: future()},
	}, fr, pb)

	first, err := p.Pick(context.Background())
	if err != nil {
		t.Fatalf("Pick: %v", err)
	}
	p.MarkFailed(first.Token)

	for i := 0; i < 3; i++ {
		tok, err := p.Pick(context.Background())
		if err != nil {
			t.Fatalf("Pick after MarkFailed: %v", err)
		}
		if tok.Token == first.Token {
			t.Fatalf("Pick returned the parked credential %q", tok)
		}
	}
}

// An unparseable expiry must force a refresh rather than be trusted as valid.
func TestParseExpiryTreatsGarbageAsExpired(t *testing.T) {
	for _, in := range []string{"", "   ", "not-a-date", "2026-13-45T99:99:99Z"} {
		if got := parseExpiry(in); !got.IsZero() {
			t.Fatalf("parseExpiry(%q) = %v, want zero time", in, got)
		}
	}
	ok := time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)
	if parseExpiry(ok).IsZero() {
		t.Fatalf("parseExpiry(%q) = zero, want a parsed time", ok)
	}
}
