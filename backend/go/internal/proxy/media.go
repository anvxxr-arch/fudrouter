// media.go — the MEDIA surface (images, videos, and the byte fetch that backs
// their URLs) as a NATIVE inbound surface.
//
// The bridge this serves (muse2api, loopback) answers four shapes the rest of
// the router did not model:
//
//	POST /v1/images/generations             buffered image answer
//	POST /v1/images/edits                   multipart edit
//	GET  /v1/images/generations/{task_id}   image task poll
//	POST /v1/videos                         ALWAYS an async task
//	GET  /v1/videos/{task_id}               video task poll
//	GET  /v1/media/{name}                   the bytes a generation produced
//
// Before this file every one of those died: `POST /v1/images/generations` fell
// into the generic catch-all (which only forwards when the operator raised the
// passthrough hatch), and the GET paths could not be reached at all — the
// catch-all reads a JSON body, so a GET without one was a 400 regardless of the
// hatch. The endpoint-surface spec §8 named media as explicitly out of scope;
// this file closes that gap as its own surface rather than widening
// `modelAddressed`, because these paths differ from a chat call in two ways the
// generic path cannot express:
//
//  1. The URL a generation returns points AT THE BRIDGE
//     (`http://127.0.0.1:18610/v1/media/...`) whenever the bridge's
//     `public_base` is unset, because the bridge mints its media URLs from the
//     Host header of the request it received. A loopback URL is unreachable for
//     the client, so every media URL in every response is REWRITTEN here to the
//     router's own public base, and the bytes are served back through
//     /v1/media/{name}. The router is the only address in the exchange the
//     client can actually reach, so it must be the one it hands out.
//
//  2. The byte fetch must NOT be billed or budget-gated. The image was paid for
//     when it was generated; charging the fetch that delivers it would make
//     retrieving what you already bought cost extra, and a drained balance
//     would make an already-generated image undownloadable. That is why
//     ServeMedia is the ONE /v1 handler in this package that never calls
//     begin(): no model, no ledger row, no budget gate — just bytes.
//
// The generation paths DO run the full lifecycle (auth → limits → budget →
// resolve → route → attempt → bill): they are model-addressed, they reach a
// real upstream, and they belong in the ledger like any other call.
package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/routing"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
)

// mediaNameRe mirrors the bridge's own `_SAFE_NAME` (core/media.py): a media
// name is `<prefix>_<hex>.<ext>` and nothing else. Validating here means a
// traversal attempt never becomes an outbound request at all — the bridge would
// reject it too, and doing it twice is the point (spec §8: the router validates
// its own path inputs rather than delegating that to an upstream).
var mediaNameRe = regexp.MustCompile(`^[A-Za-z0-9_\-]+\.[A-Za-z0-9]+$`)

// mediaProviderSlug is the provider whose connection backs this surface. The
// bridge is a loopback connection, not a routable cloud provider, so the byte
// fetch resolves it by slug rather than by model.
func mediaProviderSlug() string {
	if v := strings.TrimSpace(os.Getenv("ROUTER_MEDIA_PROVIDER")); v != "" {
		return v
	}
	return "muse2api"
}

// mediaDefaultModel is the routing key for requests that name no model (a task
// poll carries only a task id) and the fallback for a generation with an empty
// `model`. It must be a model whose provider_model row maps to the media
// upstream ids, or resolution 404s.
func mediaDefaultModel(kind string) string {
	envKey := "ROUTER_MEDIA_IMAGE_MODEL"
	if kind == "video" {
		envKey = "ROUTER_MEDIA_VIDEO_MODEL"
	}
	if v := strings.TrimSpace(os.Getenv(envKey)); v != "" {
		return v
	}
	return "muse-" + kind
}

// mediaPublicBase is the base every returned media URL is rewritten onto.
//
// PUBLIC_API_BASE_URL is the deployment's own address and the only value that
// is right in every hop (the router sits behind Caddy behind a Cloudflare
// tunnel, so r.Host is the tunnel host and the scheme is not on the request the
// router sees). The header fallback exists for a direct-to-router deployment;
// it is a fallback because trusting a client-supplied Host to mint a URL is
// acceptable only when nothing authoritative was configured.
func mediaPublicBase(r *http.Request) string {
	if v := strings.TrimRight(strings.TrimSpace(os.Getenv("PUBLIC_API_BASE_URL")), "/"); v != "" {
		return v
	}
	scheme := "http"
	if p := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")); p != "" {
		scheme = p
	} else if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

// rewriteMediaURLs rewrites every media URL inside a response body onto the
// router's public base, recursively.
//
// Recursive, not a regex over the raw bytes: media URLs appear at different
// depths in different shapes — `data[].url` on an image answer, `result.url` on
// a video task, and whatever the bridge nests those in — and a byte-level
// substitution would also rewrite a URL that appears inside a prompt echoed
// back by the model. Walking the decoded document rewrites exactly the string
// values, so a `{"data":[{"url":...}]}` and a `{"result":{"url":...}}` are
// handled by the same code.
//
// A body that does not decode, or a deployment with no public base, is returned
// untouched: a failure here must not corrupt a successful generation.
func rewriteMediaURLs(body []byte, publicBase string) []byte {
	if publicBase == "" || !bytes.Contains(body, []byte(mediaPathPrefix)) {
		return body
	}
	var doc any
	if err := json.Unmarshal(body, &doc); err != nil {
		return body
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	// The upstream's own escaping must survive: the default encoder escapes
	// `<`, `>` and `&` into \uXXXX, which would rewrite byte-for-byte a body
	// that was merely being passed through.
	enc.SetEscapeHTML(false)
	if err := enc.Encode(rewriteMediaValue(doc, publicBase)); err != nil {
		return body
	}
	return bytes.TrimRight(buf.Bytes(), "\n")
}

const mediaPathPrefix = "/v1/media/"

func rewriteMediaValue(v any, base string) any {
	switch t := v.(type) {
	case string:
		return rewriteMediaString(t, base)
	case []any:
		for i := range t {
			t[i] = rewriteMediaValue(t[i], base)
		}
		return t
	case map[string]any:
		for k := range t {
			t[k] = rewriteMediaValue(t[k], base)
		}
		return t
	}
	return v
}

// rewriteMediaString swaps the ORIGIN of a URL whose path is a media path. Only
// the origin moves: the path (and therefore the name) is what the bridge minted
// and what our own /v1/media/{name} handler will look up, so rewriting it would
// break the fetch that follows. A string whose prefix carries no scheme (a bare
// path, a model echoing "/v1/media/" in prose) is left alone — only a real
// absolute URL has an origin to replace.
func rewriteMediaString(s, base string) string {
	i := strings.Index(s, mediaPathPrefix)
	if i < 0 {
		return s
	}
	if !strings.Contains(s[:i], "://") {
		return s
	}
	return base + s[i:]
}

// --- request model extraction ---

// mediaModelFromJSON reads the `model` field of a JSON body. An empty body (a
// GET task poll) and an absent `model` both fall through to the caller's
// default, which is what makes a poll routable at all.
func mediaModelFromJSON(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	var probe struct {
		Model string `json:"model"`
	}
	if json.Unmarshal(body, &probe) != nil {
		return ""
	}
	return strings.TrimSpace(probe.Model)
}

// mediaModelFromMultipart reads the `model` form field of a multipart body
// (POST /v1/images/edits).
//
// The body bytes are forwarded VERBATIM after this — the boundary in the client's
// Content-Type still refers to these exact bytes — so this only peeks. File
// parts are skipped entirely: reading one would buffer an image into memory to
// find a field that is never in one.
func mediaModelFromMultipart(r *http.Request, body []byte) string {
	ct := r.Header.Get("Content-Type")
	mediatype, params, err := mime.ParseMediaType(ct)
	if err != nil || !strings.HasPrefix(mediatype, "multipart/") {
		return ""
	}
	boundary, ok := params["boundary"]
	if !ok {
		return ""
	}
	mr := multipart.NewReader(bytes.NewReader(body), boundary)
	for {
		part, err := mr.NextPart()
		if err != nil {
			return ""
		}
		if part.FormName() != "model" || part.FileName() != "" {
			_ = part.Close()
			continue
		}
		// A form field is small by contract; cap it so a malformed body cannot
		// turn a peek into an allocation.
		val, _ := io.ReadAll(io.LimitReader(part, 4<<10))
		_ = part.Close()
		return strings.TrimSpace(string(val))
	}
}

// mediaImageTimeout and mediaVideoTimeout bound a generation.
//
// The generic bound is 120s (nonStreamTimeout), which is a chat turn. The
// bridge drives a real browser against muse.ai: its own configured ceilings are
// image_timeout=240s and video_timeout=600s, so reusing the chat bound would
// abort a generation the upstream was still working on and bill the client for
// a failure it did not cause. Video is capped lower than the bridge's own
// because the bridge's video path is a TASK SUBMIT — it returns in seconds —
// and only the poll needs to survive a slow task lookup.
const (
	mediaImageTimeout = 240 * time.Second
	mediaVideoTimeout = 300 * time.Second
)

// mediaUpstreamContext is upstreamContext with the media bound.
//
// The routing policy's own deadline still wins when it is SHORTER: the policy
// is the operator's stated appetite for how long a request may hold resources,
// and a media call is not exempt from it.
func (lc *lifecycle) mediaUpstreamContext(r *http.Request, kind string) context.Context {
	bound := mediaImageTimeout
	if kind == "video" {
		bound = mediaVideoTimeout
	}
	if d := time.Until(lc.deadline); !lc.deadline.IsZero() && d > 0 && d < bound {
		bound = d
	}
	ctx, cancel := context.WithTimeout(r.Context(), bound)
	lc.cancelUpstream = cancel
	return ctx
}

// --- handlers ---

// ServeImages serves the image endpoints. The bridge keeps its own routes, so
// this dispatches on the path and hands the same lifecycle an upstream path.
func (h *Handler) ServeImages(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimSuffix(r.URL.Path, "/")
	switch {
	case path == "/v1/images/edits":
		h.serveMediaGenerate(w, r, "image", "/images/edits")
	case path == "/v1/images/generations":
		h.serveMediaGenerate(w, r, "image", "/images/generations")
	case strings.HasPrefix(path, "/v1/images/generations/"):
		taskID := strings.TrimPrefix(path, "/v1/images/generations/")
		h.serveMediaTask(w, r, "image", taskID, "/images/generations/"+taskID)
	default:
		h.writeErrCode(w, "MODEL_NOT_FOUND",
			fmt.Sprintf("%s is not implemented on this router", r.URL.Path))
	}
}

// ServeVideos serves the video endpoints. Video generation is ALWAYS a task on
// the bridge (a video takes minutes), so there is no buffered branch here.
func (h *Handler) ServeVideos(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimSuffix(r.URL.Path, "/")
	switch {
	case path == "/v1/videos":
		h.serveMediaGenerate(w, r, "video", "/videos")
	case strings.HasPrefix(path, "/v1/videos/"):
		taskID := strings.TrimPrefix(path, "/v1/videos/")
		h.serveMediaTask(w, r, "video", taskID, "/videos/"+taskID)
	default:
		h.writeErrCode(w, "MODEL_NOT_FOUND",
			fmt.Sprintf("%s is not implemented on this router", r.URL.Path))
	}
}

// serveMediaGenerate runs a generation through the full lifecycle.
//
// `kind` is "image" or "video"; `upstreamPath` is the bridge's own path for it.
// The body is forwarded VERBATIM (including a multipart body) — the router
// models no media parameter, and the bridge is the authority on its own shape.
func (h *Handler) serveMediaGenerate(w http.ResponseWriter, r *http.Request, kind, upstreamPath string) {
	start := time.Now()

	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBytes))
	if err != nil {
		h.writeErrCode(w, routing.ErrCodeInvalidRequest, "cannot read body")
		return
	}

	fallback := mediaDefaultModel(kind)
	validate := func(b []byte) (string, *apiError) {
		slug := mediaModelFromJSON(b)
		if slug == "" {
			slug = mediaModelFromMultipart(r, b)
		}
		if slug == "" {
			// The bridge has a default model per kind and so do we; substituting
			// it here (rather than rejecting) keeps a client that relies on the
			// upstream's default working, and gives routing a target to pick.
			return fallback, nil
		}
		return slug, nil
	}

	lc, ok := h.begin(w, r, start, r.URL.Path, body, validate, "")
	if !ok {
		return
	}
	defer lc.finish()

	// Streaming is meaningless on this surface: the bridge answers a buffered
	// JSON body, or a task view that the client polls. Leaving lc.stream false
	// also keeps the upstream bound a real timeout (nonStreamTimeout) instead
	// of the unbounded stream context.
	upCtx := lc.mediaUpstreamContext(r, kind)
	resp, err := lc.dispatch(upCtx, body, r.Method, r.URL.RawQuery, upstreamPath)
	if err != nil || resp == nil {
		lc.fail(err)
		return
	}
	defer resp.Body.Close()
	lc.logTarget(resp.StatusCode)

	respBody, err := lc.readUpstreamBody(resp)
	if err != nil {
		lc.fail(fmt.Errorf("read upstream: %w", err))
		return
	}
	// An error envelope must reach the client as an error, not as a 200 with a
	// loopback URL rewritten into it. The bridge answers 4xx/5xx with a JSON
	// error, so the status is the discriminator; rewriting only a success body
	// also means a failure is relayed byte-for-byte.
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		respBody = rewriteMediaURLs(respBody, mediaPublicBase(r))
	}
	lc.serveBuffered(w, respBody, resp.Header)
}

// serveMediaTask polls a generation task. A poll names no model, so the routing
// key is the surface's default for that kind — the bridge is the only provider
// that serves media, and a task id alone does not identify a model.
func (h *Handler) serveMediaTask(w http.ResponseWriter, r *http.Request, kind, taskID, upstreamPath string) {
	start := time.Now()

	if strings.TrimSpace(taskID) == "" {
		h.writeErrCode(w, routing.ErrCodeInvalidRequest, "task id is required")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBytes))
	if err != nil {
		h.writeErrCode(w, routing.ErrCodeInvalidRequest, "cannot read body")
		return
	}

	fallback := mediaDefaultModel(kind)
	validate := func([]byte) (string, *apiError) { return fallback, nil }

	lc, ok := h.begin(w, r, start, r.URL.Path, body, validate, "")
	if !ok {
		return
	}
	defer lc.finish()

	upCtx := lc.mediaUpstreamContext(r, kind)
	resp, err := lc.dispatch(upCtx, body, r.Method, r.URL.RawQuery, upstreamPath)
	if err != nil || resp == nil {
		lc.fail(err)
		return
	}
	defer resp.Body.Close()
	lc.logTarget(resp.StatusCode)

	respBody, err := lc.readUpstreamBody(resp)
	if err != nil {
		lc.fail(fmt.Errorf("read upstream: %w", err))
		return
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		respBody = rewriteMediaURLs(respBody, mediaPublicBase(r))
	}
	lc.serveBuffered(w, respBody, resp.Header)
}

// ServeMedia streams the bytes a generation produced.
//
// This is the ONE /v1 handler that does not run `begin`, and the omission is
// deliberate and load-bearing (see the file header): the generation was already
// billed, so fetching its output must not bill again, must not consume a
// concurrency slot, and must not be refused by a budget gate that the balance
// state of a DIFFERENT request happens to trip. It also has no model to resolve
// and no candidate to route — the bridge is a single loopback connection, so it
// is looked up directly.
//
// The route is public on the bridge because a media URL has to be embeddable in
// a client that cannot send headers (an <img> tag). The router keeps its own
// surface honest: the name is validated against the bridge's own pattern, and
// the fetch is the router's own outbound request — a client never gets to name
// an arbitrary URL, only a name the bridge could have minted.
func (h *Handler) ServeMedia(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, mediaPathPrefix)
	if !mediaNameRe.MatchString(name) {
		// Same answer the bridge gives an unsafe name (NotFound), so a probe
		// learns nothing here that it would not learn upstream.
		h.writeErrCode(w, routing.ErrCodeModelNotFound, "media not found")
		return
	}

	target, err := h.store.MediaBridge(r.Context(), mediaProviderSlug())
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			h.writeErrCode(w, routing.ErrCodeModelNotFound, "media not found")
			return
		}
		h.writeErrCode(w, routing.ErrCodeInternalError, "media bridge lookup failed")
		return
	}
	token, err := h.mediaBridgeToken(target.SecretEnc)
	if err != nil {
		h.writeErrCode(w, routing.ErrCodeInternalError, "media bridge credential failed")
		return
	}

	upURL := strings.TrimRight(target.BaseURL, "/") + "/media/" + name
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, upURL, nil)
	if err != nil {
		h.writeErrCode(w, routing.ErrCodeInternalError, "media request failed")
		return
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := h.client.Do(req)
	if err != nil {
		h.writeErrCode(w, routing.ErrCodeUpstreamError, "media fetch failed")
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		h.writeErrCode(w, routing.ErrCodeModelNotFound, "media not found")
		return
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		h.writeErrCode(w, routing.ErrCodeUpstreamError, "media fetch failed")
		return
	}

	// A media byte stream is not a JSON document: only the allowlisted response
	// headers are relayed (copyUpstreamHeaders), which for this response is
	// Content-Type and Cache-Control — the bridge's own
	// `public, max-age=86400` survives, so a repeated fetch is answered from
	// the client's cache instead of re-crossing the tunnel.
	copyUpstreamHeaders(w, resp.Header)
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, resp.Body)
}

// mediaBridgeToken decrypts the bridge credential blob and returns its bearer
// token.
//
// The blob is what onboard-muse2api.mjs wrote: the JSON `{"api_key": "..."}`
// under the same Crypt the pool uses, so a bridge key is stored, rotated and
// read exactly like any other provider secret — no second secret convention.
func (h *Handler) mediaBridgeToken(secretEnc string) (string, error) {
	if secretEnc == "" {
		return "", errors.New("empty secret")
	}
	if h.crypt == nil {
		return "", errors.New("no crypt configured")
	}
	plain, err := h.crypt.Decrypt(secretEnc)
	if err != nil {
		return "", err
	}
	var blob struct {
		APIKey string `json:"api_key"`
	}
	if err := json.Unmarshal([]byte(plain), &blob); err != nil {
		return "", err
	}
	return blob.APIKey, nil
}
