package crypt

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	key := make([]byte, 32)
	rand.Read(key)
	c, err := New(base64.StdEncoding.EncodeToString(key))
	if err != nil {
		t.Fatal(err)
	}
	enc, err := c.Encrypt(`{"api_key":"sk-test"}`)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains([]byte(enc), []byte("sk-test")) {
		t.Fatal("plaintext leaked")
	}
	dec, err := c.Decrypt(enc)
	if err != nil || dec != `{"api_key":"sk-test"}` {
		t.Fatalf("dec=%q err=%v", dec, err)
	}
}

func TestTamperFails(t *testing.T) {
	key := make([]byte, 32)
	rand.Read(key)
	c, _ := New(base64.StdEncoding.EncodeToString(key))
	enc, _ := c.Encrypt("hello")
	raw, _ := base64.StdEncoding.DecodeString(enc)
	raw[len(raw)-1] ^= 0xff
	if _, err := c.Decrypt(base64.StdEncoding.EncodeToString(raw)); err == nil {
		t.Fatal("tampered ciphertext must fail")
	}
}

// TestWireFormatMatchesTS pins the exact layout the TypeScript side produces:
// base64(iv[12] || ciphertext || tag[16]).
func TestWireFormatMatchesTS(t *testing.T) {
	key := make([]byte, 32)
	rand.Read(key)
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	iv := make([]byte, 12)
	rand.Read(iv)
	ct := gcm.Seal(nil, iv, []byte(`{"api_key":"x"}`), nil)
	wire := base64.StdEncoding.EncodeToString(append(append([]byte{}, iv...), ct...))
	// gcm.Seal appends the 16-byte tag to ct, so wire == iv||ct||tag already.

	c, _ := New(base64.StdEncoding.EncodeToString(key))
	dec, err := c.Decrypt(wire)
	if err != nil || dec != `{"api_key":"x"}` {
		t.Fatalf("TS-format decrypt failed: %q %v", dec, err)
	}
}

// The data plane must reject a malformed master key rather than run with a
// silently truncated one.
func TestBadMasterKey(t *testing.T) {
	for _, bad := range []string{"", "not-base64!!", base64.StdEncoding.EncodeToString([]byte("short"))} {
		if _, err := New(bad); err == nil {
			t.Errorf("accepted bad master key %q", bad)
		}
	}
}
