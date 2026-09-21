package protocol

import (
	"bytes"
	"testing"
)

func TestEventStreamRoundTrip(t *testing.T) {
	frame := EncodeFrame(map[string]string{
		":message-type": "event",
		":event-type":   "assistantResponseEvent",
		":content-type": "application/json",
	}, []byte(`{"content":"hi"}`))
	frames, rest, err := DecodeFrames(frame)
	if err != nil {
		t.Fatal(err)
	}
	if len(rest) != 0 || len(frames) != 1 {
		t.Fatalf("frames=%d rest=%d", len(frames), len(rest))
	}
	if frames[0].Headers[":event-type"] != "assistantResponseEvent" {
		t.Fatalf("headers=%v", frames[0].Headers)
	}
	if string(frames[0].Payload) != `{"content":"hi"}` {
		t.Fatalf("payload=%s", frames[0].Payload)
	}
}

func TestKiroRequestToOpenAI(t *testing.T) {
	body := []byte(`{"conversationState":{"currentMessage":{"userInputMessage":{"content":"hello","modelId":"claude-sonnet-4"}}}}`)
	model, msgs, err := KiroRequestToOpenAI(body)
	if err != nil {
		t.Fatal(err)
	}
	if model != "claude-sonnet-4" {
		t.Fatalf("model=%s", model)
	}
	if len(msgs) != 1 || msgs[0]["content"] != "hello" {
		t.Fatalf("msgs=%v", msgs)
	}
}

func TestOpenAIToKiroES(t *testing.T) {
	openai := []byte(`{"choices":[{"message":{"role":"assistant","content":"pong"}}]}`)
	es, err := OpenAIChatToKiroEventStream(openai)
	if err != nil {
		t.Fatal(err)
	}
	frames, _, err := DecodeFrames(es)
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) < 2 {
		t.Fatalf("expected multiple frames got %d", len(frames))
	}
	found := false
	for _, f := range frames {
		if f.Headers[":event-type"] == "assistantResponseEvent" {
			found = true
		}
	}
	if !found {
		t.Fatal("missing assistantResponseEvent")
	}
}

func TestCursorRequestExtract(t *testing.T) {
	body := []byte(`{"prompt":"hello from cursor"}`)
	model, msgs, err := CursorRequestToOpenAI(body, "/RunSSE")
	if err != nil || model == "" || len(msgs) != 1 || msgs[0]["content"] != "hello from cursor" {
		t.Fatalf("model=%s msgs=%v err=%v", model, msgs, err)
	}
	bin := append([]byte{0x0a, 0x10}, []byte("this is a long enough cursor protobuf-ish string payload")...)
	_, msgs2, err := CursorRequestToOpenAI(bin, "/BidiAppend")
	if err != nil || len(msgs2) != 1 || len(msgs2[0]["content"]) < 20 {
		t.Fatalf("bin msgs=%v err=%v", msgs2, err)
	}
}

func TestCursorSSE(t *testing.T) {
	out := OpenAIChatToCursorSSE([]byte(`{"choices":[{"message":{"content":"hi"}}]}`))
	if !bytes.Contains(out, []byte("data:")) || !bytes.Contains(out, []byte("[DONE]")) {
		t.Fatalf("bad sse: %s", out)
	}
}
