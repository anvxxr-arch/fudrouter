package proxy

// The token-saver is the one feature that rewrites what the MODEL sees before
// the request leaves the router, so its failure modes are asymmetric: a bad
// compression costs a few hundred billed tokens, but a compression that drops
// the wrong bytes or changes the message shape makes the model answer
// confidently about code it cannot see. These cases pin the three properties
// that make it safe to leave on by default:
//
//  1. it never grows a payload, and never touches a message it did not shrink;
//  2. it preserves the conversation SHAPE (roles, tool_call_id, message count)
//     and only rewrites the text of a `role:"tool"` message;
//  3. every failure path returns the original bytes unchanged.
//
// Verified by mutation: making compressToolResults return `nil` for `out` (or
// dropping the `after >= before` guard) turns the growth and shape cases red.

import (
	"encoding/json"
	"strings"
	"testing"
)

// chatBody builds a one-tool-result [OI] body around `content`.
func chatBody(content string) []byte {
	b, _ := json.Marshal(map[string]any{
		"model": "m",
		"messages": []any{
			map[string]any{"role": "user", "content": "what changed?"},
			map[string]any{"role": "tool", "tool_call_id": "call_1", "content": content},
		},
	})
	return b
}

func TestCompressLeavesShortResultsAlone(t *testing.T) {
	content := strings.Repeat("short line\n", 20) // well under the 8 KiB floor
	body := chatBody(content)
	out, saved := compressToolResults(body)
	if saved != 0 {
		t.Fatalf("saved %d on a short result; the floor should leave it alone", saved)
	}
	if string(out) != string(body) {
		t.Fatal("short result was rewritten")
	}
}

func TestCompressElidesALargePayload(t *testing.T) {
	// One huge line: no duplicate runs, so only the middle-elision applies.
	content := strings.Repeat("x", 200<<10)
	body := chatBody(content)
	out, saved := compressToolResults(body)
	if saved <= 0 {
		t.Fatal("no saving reported for a 200 KiB tool result")
	}
	if len(out) >= len(body) {
		t.Fatalf("body grew: %d >= %d", len(out), len(body))
	}

	var req map[string]any
	if err := json.Unmarshal(out, &req); err != nil {
		t.Fatalf("compressed body is not valid JSON: %v", err)
	}
	msgs := req["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("message count changed: %d", len(msgs))
	}
	first := msgs[0].(map[string]any)
	if first["role"] != "user" || first["content"] != "what changed?" {
		t.Fatalf("a non-tool message was modified: %+v", first)
	}
	tool := msgs[1].(map[string]any)
	if tool["role"] != "tool" || tool["tool_call_id"] != "call_1" {
		t.Fatalf("tool message shape changed: %+v", tool)
	}
	got := tool["content"].(string)
	if !strings.Contains(got, "bytes elided") {
		t.Fatal("no elision marker; the model cannot tell content is missing")
	}
	// Head and tail survive: the marker sits between them, not in place of them.
	if !strings.HasPrefix(got, "xxxx") || !strings.HasSuffix(got, "xxxx") {
		t.Fatal("head or tail was dropped; an agent reasons from both ends")
	}
}

func TestCompressCollapsesIdenticalLineRuns(t *testing.T) {
	// 400 identical log lines plus a real tail: the run must collapse and the
	// tail must survive.
	content := strings.Repeat("ERROR connection reset\n", 400) + "done\n"
	body := chatBody(content)
	out, saved := compressToolResults(body)
	if saved <= 0 {
		t.Fatal("no saving reported for a repeated-line log dump")
	}
	var req map[string]any
	if err := json.Unmarshal(out, &req); err != nil {
		t.Fatalf("not valid JSON: %v", err)
	}
	got := req["messages"].([]any)[1].(map[string]any)["content"].(string)
	if strings.Count(got, "ERROR connection reset") != 1 {
		t.Fatalf("run not collapsed: %d copies", strings.Count(got, "ERROR connection reset"))
	}
	if !strings.Contains(got, "identical lines elided") {
		t.Fatal("no run marker")
	}
	if !strings.HasSuffix(got, "done\n") {
		t.Fatal("the line after the run was dropped")
	}
}

func TestCompressKeepsNonStringContent(t *testing.T) {
	// A block array is a different message shape. The contract forwards the body
	// essentially verbatim, so rewriting it is out of scope even when large.
	big := strings.Repeat("y", 100<<10)
	body, _ := json.Marshal(map[string]any{
		"model": "m",
		"messages": []any{
			map[string]any{"role": "tool", "tool_call_id": "c",
				"content": []any{map[string]any{"type": "text", "text": big}}},
		},
	})
	out, saved := compressToolResults(body)
	if saved != 0 || string(out) != string(body) {
		t.Fatal("a non-string tool content was rewritten")
	}
}

func TestCompressFailsOpenOnBadJSON(t *testing.T) {
	body := []byte(`{"messages": not-json`)
	out, saved := compressToolResults(body)
	if saved != 0 || string(out) != string(body) {
		t.Fatal("invalid JSON must be returned unchanged")
	}
}

// A payload ABOVE the floor that compression cannot shrink must come back byte
// identical. This is the growth guard's only real test.
//
// The fixture is many runs of exactly THREE short identical lines. The collapse
// rule fires at 3, and the marker it writes costs far more than the two lines it
// replaces (`"a\na\na\n"` is 6 bytes; the marker is ~40), so a guard-less
// implementation GROWS this payload. Short runs are the realistic shape too:
// `}` or `ok` repeated three times is normal output.
//
// Verified by mutation: removing the `after >= before` guard turns this red
// (saved > 0 and the body is longer than the input).
func TestCompressKeepsIncompressiblePayloadVerbatim(t *testing.T) {
	var b strings.Builder
	for b.Len() < 12<<10 {
		// Alternate the letter so adjacent runs stay 3 long instead of merging
		// into one long run, which WOULD compress and hide the regression.
		b.WriteString("a\na\na\nb\nb\nb\n")
	}
	body := chatBody(b.String())
	out, saved := compressToolResults(body)
	if saved != 0 {
		t.Fatalf("saved %d on a payload compression makes BIGGER", saved)
	}
	if string(out) != string(body) {
		t.Fatal("a payload that grows under compression was not returned verbatim")
	}
	if len(out) > len(body) {
		t.Fatalf("body grew: %d > %d", len(out), len(body))
	}
}

func TestCompressHandler(t *testing.T) {
	for _, off := range []string{"off", "OFF", " 0 ", "false", "no"} {
		if !tokenSaverDisabled(off) {
			t.Errorf("%q should disable the saver", off)
		}
	}
	for _, on := range []string{"", "on", "1", "true"} {
		if tokenSaverDisabled(on) {
			t.Errorf("%q should keep the saver on", on)
		}
	}
}

// The saving is an estimate derived from bytes, so it must never exceed the
// provider-visible input delta it claims to describe, and must never be
// negative — a negative would read as a credit on the dashboard.
func TestCompressSavingIsSane(t *testing.T) {
	content := strings.Repeat("z", 64<<10)
	_, saved := compressToolResults(chatBody(content))
	if saved < 0 {
		t.Fatalf("negative saving %d", saved)
	}
	if saved > int64(len(content)/charsPerToken) {
		t.Fatalf("saving %d exceeds the whole payload's estimate", saved)
	}
}
