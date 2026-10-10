package crypt

import (
	"crypto/rand"
	"encoding/base64"
	"testing"
)

// A rotation window must read old rows: ciphertext sealed under the PREVIOUS
// key decrypts through a dual-key Crypt, while Encrypt always uses active.
func TestDecryptPrevKey(t *testing.T) {
	oldRaw := make([]byte, 32)
	rand.Read(oldRaw)
	oldB64 := base64.StdEncoding.EncodeToString(oldRaw)
	newRaw := make([]byte, 32)
	rand.Read(newRaw)
	newB64 := base64.StdEncoding.EncodeToString(newRaw)

	oldOnly, err := New(oldB64)
	if err != nil {
		t.Fatal(err)
	}
	wire, err := oldOnly.Encrypt(`{"api_key":"sk-old"}`)
	if err != nil {
		t.Fatal(err)
	}

	dual, err := NewWithPrev(newB64, oldB64)
	if err != nil {
		t.Fatal(err)
	}
	if dec, err := dual.Decrypt(wire); err != nil || dec != `{"api_key":"sk-old"}` {
		t.Fatalf("prev-key decrypt failed: dec=%q err=%v", dec, err)
	}
	// Encrypt uses active: the new-only Crypt must read what dual wrote.
	fresh, err := dual.Encrypt("hello-new")
	if err != nil {
		t.Fatal(err)
	}
	newOnly, err := New(newB64)
	if err != nil {
		t.Fatal(err)
	}
	if dec, err := newOnly.Decrypt(fresh); err != nil || dec != "hello-new" {
		t.Fatalf("active-key encrypt mismatch: dec=%q err=%v", dec, err)
	}
	// Old-only must NOT read the new ciphertext.
	if _, err := oldOnly.Decrypt(fresh); err == nil {
		t.Fatal("old key decrypted new ciphertext — rotation boundary broken")
	}
}

// A malformed prev must fail loudly, not silently disable old-row reads.
func TestBadPrevKey(t *testing.T) {
	goodRaw := make([]byte, 32)
	rand.Read(goodRaw)
	goodB64 := base64.StdEncoding.EncodeToString(goodRaw)
	if _, err := NewWithPrev(goodB64, "not-base64!!"); err == nil {
		t.Error("accepted malformed CREDENTIALS_MASTER_KEY_PREV")
	}
	// Empty prev is the steady state, not an error.
	if _, err := NewWithPrev(goodB64, ""); err != nil {
		t.Errorf("empty prev must be valid: %v", err)
	}
}
