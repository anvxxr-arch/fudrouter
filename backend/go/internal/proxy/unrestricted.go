package proxy

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"strings"
)

// The `-unrestricted` virtual suffix (adapted from the jerouter pattern,
// analysed 2026-10-26): a model slug carrying this suffix resolves to the
// SAME model set as its base slug — same mappings, same credentials, same
// pricing, same failover — and the request is sent upstream with the
// unrestricted system prompt prepended to the message list. Nothing about
// routing, billing or health changes; only the system prompt the upstream
// model sees.
//
// The suffix is stripped before model resolution (lifecycle.begin), so the
// catalogue, the status poll and every DB read keep seeing canonical slugs
// only. The twins are rendered into /v1/models from the canonical list
// (models.go) — no database rows exist for them.
//
//go:embed unrestricted_prompt.txt
var unrestrictedPrompt []byte

// unrestrictedSuffix marks a virtual unrestricted variant of a model.
const unrestrictedSuffix = "-unrestricted"

// stripUnrestricted reports whether slug carries the unrestricted suffix and
// returns the base slug to resolve. The match is case-insensitive so
// `GLM-5.3-Flash-Unrestricted` resolves too.
func stripUnrestricted(slug string) (string, bool) {
	if len(slug) > len(unrestrictedSuffix) && strings.EqualFold(slug[len(slug)-len(unrestrictedSuffix):], unrestrictedSuffix) {
		return slug[:len(slug)-len(unrestrictedSuffix)], true
	}
	return slug, false
}

// unrestrictedTwin clones a rendered catalogue object under its
// `-unrestricted` slug. The clone is taken from the object AFTER
// attachHealth, so the twin inherits the base model's health entry — it
// dials the same upstream. Returns nil when the base slug already carries
// the suffix (never twin a twin).
func unrestrictedTwin(obj map[string]any) map[string]any {
	id, _ := obj["id"].(string)
	if id == "" || strings.HasSuffix(strings.ToLower(id), unrestrictedSuffix) {
		return nil
	}
	twin := make(map[string]any, len(obj)+1)
	for k, v := range obj {
		twin[k] = v
	}
	twin["id"] = id + unrestrictedSuffix
	return twin
}

// injectUnrestricted returns body with the unrestricted system prompt
// prepended to its messages array. A caller-supplied system message is kept
// and layered after the prompt (the persona dominates, the caller's
// instruction still applies on top — same behaviour as the reference
// implementation). Bodies that are not JSON objects, carry no messages array,
// or fail to re-encode pass through untouched: an injection must never be
// the reason a request fails.
func injectUnrestricted(body []byte) []byte {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(body, &m); err != nil {
		return body
	}
	raw, ok := m["messages"]
	if !ok {
		return body
	}
	var msgs []json.RawMessage
	if err := json.Unmarshal(raw, &msgs); err != nil || len(msgs) == 0 {
		return body
	}
	sys, err := json.Marshal(map[string]string{
		"role":    "system",
		"content": string(unrestrictedPrompt),
	})
	if err != nil {
		return body
	}
	out := make([]json.RawMessage, 0, len(msgs)+1)
	out = append(out, sys)
	out = append(out, msgs...)
	enc, err := json.Marshal(out)
	if err != nil {
		return body
	}
	m["messages"] = enc
	// Compact re-encode with HTML escaping off: the prompt is full of
	// angle-bracket tags and upstream parsers do not need \u003c noise.
	var buf bytes.Buffer
	enc2 := json.NewEncoder(&buf)
	enc2.SetEscapeHTML(false)
	if err := enc2.Encode(m); err != nil {
		return body
	}
	return bytes.TrimRight(buf.Bytes(), "\n")
}
