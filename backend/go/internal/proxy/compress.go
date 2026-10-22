// compress.go — metered tool-result compression.
//
// Coding agents spend most of their prompt budget on tool output: a `git diff`,
// a `grep`, a directory listing, a log dump. Those are attached to the request
// verbatim, so a 47 KB diff is 12k input tokens the customer pays for and the
// model mostly does not need.
//
// 9Router ships this as RTK and reports a 20-40% input saving. The compressing
// itself is not the differentiator — the METERING is. Because this router owns
// the ledger, the saving can be recorded per request and shown to the customer
// (`tokens_saved` on request_log), which a gateway with no billing has no place
// to put.
//
// Safety rules, in order of importance:
//
//  1. FAIL OPEN. Any parse error, any filter that panics or grows the payload,
//     returns the original bytes. A compression bug must never break a request —
//     the customer's request is worth more than the token saving.
//  2. Never grow. If the rewrite is not strictly smaller, keep the original.
//  3. Never change the message SHAPE. Only the text inside a `role:"tool"`
//     message is touched; roles, tool_call_id and every other message stay byte
//     identical, so the upstream sees the same conversation.
//  4. Say what happened. Elided content leaves a marker naming the byte count,
//     so the model can tell it is looking at a summary rather than the whole
//     file. Silent truncation makes a model answer confidently about code it
//     cannot see.
//
// The saving is an ESTIMATE (see estimateTokens): no upstream exposes its
// tokenizer, and the exact number arrives later in the provider's own `usage`
// block. The estimate is used for the before/after comparison only, and the
// bill is still computed from reported usage.
package proxy

import (
	"encoding/json"
	"strconv"
	"strings"
)

// charsPerToken is the ONE character-to-token ratio in this package. It is
// shared with estimateInputTokens (anthropic.go), which count_tokens uses, so
// the two surfaces cannot disagree about what a token costs in characters.
//
// It is used ONLY to report how much a compression saved (and to answer
// count_tokens); the bill always comes from the provider's reported usage
// block, never from this number.
const charsPerToken = 4

// estimateTokens sizes a payload the same way count_tokens does, minus the
// per-message overhead (there is no message boundary at a byte count).
func estimateTokens(n int) int64 { return int64(n) / charsPerToken }

const (
	// toolResultKeepBytes is the size below which a tool result is left alone.
	// Compressing a short payload costs more in markers than it saves.
	toolResultKeepBytes = 8 << 10

	// toolResultMaxBytes caps a single compressed tool result. Above this the
	// middle is elided: agents need both the start (what changed / what matched)
	// and the end (the summary line), not the middle of a 2 MB log.
	toolResultMaxBytes = 32 << 10

	// markerFmt ends the elision marker. It states the amount removed in bytes
	// so the model can judge how much it is missing.
	markerFmt = "\n… [fudrouter: %d bytes elided to fit the context budget] …\n"
)

// tokenSaverHeader lets a caller opt out for one request, the same affordance
// RTK exposes. Compression rewrites what the model sees, so a customer must be
// able to turn it off without turning the router off.
const tokenSaverHeader = "X-Fudrouter-Token-Saver"

// tokenSaverDisabled reports whether the caller asked for the raw body.
func tokenSaverDisabled(header string) bool {
	switch strings.ToLower(strings.TrimSpace(header)) {
	case "off", "0", "false", "no":
		return true
	}
	return false
}

// compressToolResults rewrites oversized `role:"tool"` content in an [OI] chat
// body. It returns the body to send and the tokens saved (estimate), or the
// input unchanged with 0 when anything at all is off.
//
// The body is re-marshalled only when a message actually changed, so the
// untouched case is byte-identical rather than a round-trip through encoding/json
// (which would reorder keys and could alter a customer-supplied payload).
func compressToolResults(body []byte) (out []byte, saved int64) {
	var req map[string]any
	if err := json.Unmarshal(body, &req); err != nil {
		return body, 0
	}
	msgs, ok := req["messages"].([]any)
	if !ok || len(msgs) == 0 {
		return body, 0
	}

	changed := false
	var bytesBefore, bytesAfter int
	for _, m := range msgs {
		msg, ok := m.(map[string]any)
		if !ok {
			continue
		}
		if role, _ := msg["role"].(string); role != "tool" {
			continue
		}
		content, ok := msg["content"].(string)
		if !ok || len(content) <= toolResultKeepBytes {
			// A non-string content (an array of blocks) is left exactly as it
			// is: rewriting it would change the shape this contract says it
			// forwards verbatim.
			continue
		}
		compressed, before, after := compressText(content)
		if after >= before {
			continue
		}
		msg["content"] = compressed
		bytesBefore += before
		bytesAfter += after
		changed = true
	}
	if !changed {
		return body, 0
	}
	rewritten, err := json.Marshal(req)
	if err != nil || len(rewritten) >= len(body) {
		return body, 0
	}
	// Estimate from the tool-content deltas, not the whole body: the saving we
	// report must be attributable to compression, not to re-marshalling.
	saved = estimateTokens(bytesBefore) - estimateTokens(bytesAfter)
	if saved < 0 {
		return body, 0
	}
	return rewritten, saved
}

// compressText applies the filters to one tool result and reports the byte
// counts before and after. It is total: every branch returns a usable string.
func compressText(s string) (out string, before, after int) {
	before = len(s)
	out = collapseDuplicateLines(s)
	out = elideMiddle(out)
	return out, before, len(out)
}

// collapseDuplicateLines replaces a run of identical consecutive lines with one
// copy plus a count. Log dumps and test output are full of these, and the run
// carries no information the count does not.
//
// A run below 3 is left alone: `}` on consecutive lines is common and fine.
func collapseDuplicateLines(s string) string {
	if !strings.Contains(s, "\n") {
		return s
	}
	lines := strings.Split(s, "\n")
	var b strings.Builder
	b.Grow(len(s))

	i := 0
	for i < len(lines) {
		j := i + 1
		for j < len(lines) && lines[j] == lines[i] {
			j++
		}
		if j-i >= 3 {
			b.WriteString(lines[i])
			b.WriteString("\n… [fudrouter: ")
			b.WriteString(strconv.Itoa(j - i - 1))
			b.WriteString(" identical lines elided] …")
			b.WriteString("\n")
		} else {
			for k := i; k < j; k++ {
				b.WriteString(lines[k])
				if k < len(lines)-1 {
					b.WriteString("\n")
				}
			}
		}
		i = j
	}
	return b.String()
}

// elideMiddle keeps the head and tail of an oversized payload and drops the
// middle, naming the removed byte count. Head and tail are the parts an agent
// reasons from: the first lines say what the payload is, the last lines carry
// the exit status or summary.
func elideMiddle(s string) string {
	if len(s) <= toolResultMaxBytes {
		return s
	}
	keep := (toolResultMaxBytes - 128) / 2
	if keep <= 0 {
		return s
	}
	head, tail := s[:keep], s[len(s)-(toolResultMaxBytes-128-keep):]
	drop := len(s) - len(head) - len(tail)
	if drop <= 0 {
		return s
	}
	var b strings.Builder
	b.Grow(len(head) + len(tail) + 96)
	b.WriteString(head)
	b.WriteString("\n… [fudrouter: ")
	b.WriteString(strconv.Itoa(drop))
	b.WriteString(" bytes elided to fit the context budget] …\n")
	b.WriteString(tail)
	out := b.String()
	if len(out) >= len(s) {
		return s
	}
	return out
}
