// Package crypt decrypts provider credentials: AES-256-GCM,
// wire format base64(iv[12] || ciphertext || tag[16]) — identical to the TS control plane.
package crypt

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
)

// Crypt holds the ACTIVE master key plus the PREVIOUS one during a rotation
// window. Encrypt always uses active; Decrypt tries active first, then prev —
// so a rotation (decrypt-old → encrypt-new) can run without downtime, and
// outside a rotation prev is nil and behaviour is exactly New's.
type Crypt struct {
	active cipher.AEAD
	prev   cipher.AEAD
}

// New builds a Crypt with no previous key (prev is nil).
func New(envValue string) (*Crypt, error) {
	return NewWithPrev(envValue, "")
}

// NewWithPrev builds a Crypt from the active master key plus the optional
// previous one (CREDENTIALS_MASTER_KEY_PREV). An empty prev is not an error
// — it is the steady state outside a rotation. A malformed prev IS an error:
// silently ignoring it would make old rows undecryptable with no signal.
func NewWithPrev(activeEnv, prevEnv string) (*Crypt, error) {
	active, err := openKey(activeEnv, "CREDENTIALS_MASTER_KEY")
	if err != nil {
		return nil, err
	}
	c := &Crypt{active: active}
	if prevEnv != "" {
		prev, err := openKey(prevEnv, "CREDENTIALS_MASTER_KEY_PREV")
		if err != nil {
			return nil, err
		}
		c.prev = prev
	}
	return c, nil
}

func openKey(envValue, name string) (cipher.AEAD, error) {
	if envValue == "" {
		return nil, errors.New(name + " is not set")
	}
	key, err := base64.StdEncoding.DecodeString(envValue)
	if err != nil {
		return nil, fmt.Errorf("%s not valid base64: %w", name, err)
	}
	if len(key) != 32 {
		return nil, errors.New(name + " must be base64 of 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func FromEnv() (*Crypt, error) {
	return NewWithPrev(os.Getenv("CREDENTIALS_MASTER_KEY"), os.Getenv("CREDENTIALS_MASTER_KEY_PREV"))
}

func (c *Crypt) Encrypt(plaintext string) (string, error) {
	iv := make([]byte, 12)
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	sealed := c.active.Seal(nil, iv, []byte(plaintext), nil) // ct||tag
	return base64.StdEncoding.EncodeToString(append(iv, sealed...)), nil
}

func (c *Crypt) Decrypt(wire string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(wire)
	if err != nil {
		return "", err
	}
	if len(raw) < 12+16 {
		return "", errors.New("ciphertext too short")
	}
	iv, sealed := raw[:12], raw[12:]
	pt, actErr := c.active.Open(nil, iv, sealed, nil)
	if actErr == nil {
		return string(pt), nil
	}
	if c.prev != nil {
		if pt, err := c.prev.Open(nil, iv, sealed, nil); err == nil {
			return string(pt), nil
		}
	}
	return "", fmt.Errorf("decrypt failed (wrong master key or tampered): %w", actErr)
}
