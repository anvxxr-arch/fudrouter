package cfp

import (
	"encoding/json"
	"testing"
)

// The playground's `content` field arrives in two wire shapes and both must
// parse: the OpenAI string form, and the multimodal ARRAY form that every
// OpenAI-compatible SDK sends once a caller passes a part list. The array form
// used to reject the whole request with
//
//	cannot unmarshal array into Go struct field Message.messages.content
//
// (measured live on two customer keys, 2026-11-02) — a 400 for a request the
// upstream would have accepted.
func TestMessageUnmarshalAcceptsBothContentShapes(t *testing.T) {
	t.Run("string form", func(t *testing.T) {
		var m Message
		if err := json.Unmarshal([]byte(`{"role":"user","content":"hello"}`), &m); err != nil {
			t.Fatalf("string content rejected: %v", err)
		}
		if m.Role != "user" || m.Content != "hello" {
			t.Errorf("got %+v, want user/hello", m)
		}
		if len(m.Parts) != 0 {
			t.Errorf("string form populated Parts: %+v", m.Parts)
		}
	})

	t.Run("array form folds to text", func(t *testing.T) {
		body := `{"role":"user","content":[{"type":"text","text":"line one"},{"type":"text","text":"line two"}]}`
		var m Message
		if err := json.Unmarshal([]byte(body), &m); err != nil {
			t.Fatalf("array content rejected: %v", err)
		}
		if m.Content != "line one\nline two" {
			t.Errorf("folded content = %q, want %q", m.Content, "line one\nline two")
		}
		if len(m.Parts) != 2 {
			t.Errorf("Parts = %d, want 2", len(m.Parts))
		}
	})

	// Non-text parts (images) are dropped, not rejected: the protocol carries
	// text only, and failing over a part we would ignore is worse than
	// answering the text the caller did send.
	t.Run("array with non-text parts drops them", func(t *testing.T) {
		body := `{"role":"user","content":[{"type":"text","text":"describe"},{"type":"image_url","image_url":{"url":"http://x/y.png"}},{"type":"text","text":"this"}]}`
		var m Message
		if err := json.Unmarshal([]byte(body), &m); err != nil {
			t.Fatalf("mixed parts rejected: %v", err)
		}
		if m.Content != "describe\nthis" {
			t.Errorf("folded content = %q, want %q", m.Content, "describe\nthis")
		}
	})

	t.Run("missing and null content are empty", func(t *testing.T) {
		for _, body := range []string{`{"role":"user"}`, `{"role":"user","content":null}`, `{"role":"user","content":""}`} {
			var m Message
			if err := json.Unmarshal([]byte(body), &m); err != nil {
				t.Fatalf("%s rejected: %v", body, err)
			}
			if m.Content != "" {
				t.Errorf("%s → content %q, want empty", body, m.Content)
			}
		}
	})

	t.Run("a content object is a clear error", func(t *testing.T) {
		var m Message
		err := json.Unmarshal([]byte(`{"role":"user","content":{"type":"text"}}`), &m)
		if err == nil {
			t.Fatal("an object content must be rejected, not silently emptied")
		}
	})
}

// A whole request body with the array shape must survive decoding into Options
// — this is the exact payload the two live keys sent.
func TestOptionsUnmarshalMultimodalRequest(t *testing.T) {
	body := `{"model":"@cf/x","messages":[{"role":"system","content":"be brief"},{"role":"user","content":[{"type":"text","text":"PONG"}]}]}`
	var opt Options
	if err := json.Unmarshal([]byte(body), &opt); err != nil {
		t.Fatalf("request rejected: %v", err)
	}
	if len(opt.Messages) != 2 {
		t.Fatalf("decoded %d messages, want 2", len(opt.Messages))
	}
	if opt.Messages[1].Content != "PONG" {
		t.Errorf("user content = %q, want PONG", opt.Messages[1].Content)
	}
}
