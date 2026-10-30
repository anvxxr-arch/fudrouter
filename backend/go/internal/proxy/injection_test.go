package proxy

import (
	"encoding/json"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
)

func decodeMessages(t *testing.T, body []byte) []map[string]string {
	t.Helper()
	var doc struct {
		Messages []map[string]string `json:"messages"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		t.Fatalf("decode rewritten body: %v", err)
	}
	return doc.Messages
}

func TestApplyInjectionsOrderAndModes(t *testing.T) {
	body := []byte(`{"model":"x","messages":[{"role":"system","content":"client rules"},{"role":"user","content":"hi"}]}`)
	injs := []store.PromptInjection{
		{ID: "acct", Mode: injSystemPrepend, Content: "ACCOUNT PERSONA"},
		{ID: "key", Mode: injSystemAppend, Content: "KEY RULE"},
		{ID: "model", Mode: injChatScript, Content: "user: who are you?\nbot: I am ENI."},
	}
	msgs := decodeMessages(t, applyInjections(body, injs))
	// account prepend → client system → key append → script → real history
	want := []struct{ role, content string }{
		{"system", "ACCOUNT PERSONA"},
		{"system", "client rules"},
		{"system", "KEY RULE"},
		{"user", "who are you?"},
		{"assistant", "I am ENI."},
		{"user", "hi"},
	}
	if len(msgs) != len(want) {
		t.Fatalf("got %d messages, want %d: %v", len(msgs), len(want), msgs)
	}
	for i, w := range want {
		if msgs[i]["role"] != w.role || msgs[i]["content"] != w.content {
			t.Errorf("message %d = %v, want %s/%s", i, msgs[i], w.role, w.content)
		}
	}
}

func TestApplyInjectionsNoOpCases(t *testing.T) {
	cases := map[string][]byte{
		"no messages":    []byte(`{"model":"x"}`),
		"not json":       []byte(`model=x`),
		"messages array": []byte(`{"messages":"nope"}`),
		"empty body":     nil,
	}
	for name, body := range cases {
		got := applyInjections(body, []store.PromptInjection{{Mode: injSystemPrepend, Content: "X"}})
		if string(got) != string(body) {
			t.Errorf("%s: body changed (fail-open violated): %s", name, got)
		}
	}
	// no injections at all
	body := []byte(`{"messages":[{"role":"user","content":"hi"}]}`)
	if got := applyInjections(body, nil); string(got) != string(body) {
		t.Errorf("no injections: body changed")
	}
}

func TestApplyInjectionsEmptyContentIsSkippedNotFatal(t *testing.T) {
	body := []byte(`{"messages":[{"role":"user","content":"hi"}]}`)
	injs := []store.PromptInjection{
		{ID: "blank", Mode: injSystemPrepend, Content: "   "},
		{ID: "ok", Mode: injSystemAppend, Content: "REAL"},
	}
	msgs := decodeMessages(t, applyInjections(body, injs))
	if len(msgs) != 2 || msgs[0]["content"] != "REAL" || msgs[1]["content"] != "hi" {
		t.Fatalf("blank injection must be skipped, real one applied: %v", msgs)
	}
}

func TestScriptMessagesParsing(t *testing.T) {
	turns := scriptMessages("# comment\nuser: line one\ncontinued\n\nAssistant: reply\nbot: second\nsystem: rule")
	if len(turns) != 4 {
		t.Fatalf("got %d turns, want 4: %s", len(turns), turns)
	}
	roles := []string{"user", "assistant", "assistant", "system"}
	for i, r := range roles {
		var m map[string]string
		_ = json.Unmarshal(turns[i], &m)
		if m["role"] != r {
			t.Errorf("turn %d role = %s, want %s", i, m["role"], r)
		}
	}
	var first map[string]string
	_ = json.Unmarshal(turns[0], &first)
	if first["content"] != "line one\ncontinued" {
		t.Errorf("continuation lines must append: %q", first["content"])
	}
	if scriptMessages("nothing here") != nil {
		t.Errorf("a script with no turn must yield nil")
	}
}
