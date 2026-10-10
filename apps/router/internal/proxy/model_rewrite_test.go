package proxy

import (
	"encoding/json"
	"reflect"
	"testing"
)

// The upstream must receive the provider's OWN model id, never the string the
// client asked for. A `fudrouter/*` virtual (or an alias) resolves to a concrete
// canonical model, so forwarding the client's body verbatim made every virtual
// answer 400 INVALID_REQUEST ("Model 'fudrouter/auto' not found") while the same
// canonical slug called directly worked.
func TestRewriteModelField(t *testing.T) {
	// Pass-through: the body must come back byte-identical.
	for _, tc := range []struct{ name, in, to string }{
		{"no model key", `{"messages":[]}`, "x"},
		{"empty target", `{"model":"a"}`, ""},
		{"non-json", `not json`, "x"},
		{"json array", `[1,2]`, "x"},
		{"json null", `null`, "x"},
	} {
		t.Run("passthrough/"+tc.name, func(t *testing.T) {
			if got := string(rewriteModelField([]byte(tc.in), tc.to)); got != tc.in {
				t.Fatalf("got %q want %q (body must be untouched)", got, tc.in)
			}
		})
	}

	// Rewrite: `model` is replaced, every other key survives.
	for _, tc := range []struct{ name, in, to string }{
		{"virtual", `{"model":"fudrouter/auto","messages":[]}`, "DeepSeek-V4.1-Flash"},
		{"keeps keys", `{"model":"a","temperature":0.5,"messages":[{"role":"user","content":"hi"}]}`, "b"},
	} {
		t.Run("rewrite/"+tc.name, func(t *testing.T) {
			var before, after map[string]any
			if err := json.Unmarshal([]byte(tc.in), &before); err != nil {
				t.Fatal(err)
			}
			out := rewriteModelField([]byte(tc.in), tc.to)
			if err := json.Unmarshal(out, &after); err != nil {
				t.Fatalf("result is not JSON: %v (%s)", err, out)
			}
			if after["model"] != tc.to {
				t.Errorf("model = %v, want %q", after["model"], tc.to)
			}
			delete(before, "model")
			delete(after, "model")
			if !reflect.DeepEqual(before, after) {
				t.Errorf("other keys changed: %v -> %v", before, after)
			}
		})
	}
}
