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

type Crypt struct{ aead cipher.AEAD }

// New reads CREDENTIALS_MASTER_KEY (base64 of 32 bytes) from the environment.
func New(envValue string) (*Crypt, error) {
	if envValue == "" {
		return nil, errors.New("CREDENTIALS_MASTER_KEY is not set")
	}
	key, err := base64.StdEncoding.DecodeString(envValue)
	if err != nil {
		return nil, fmt.Errorf("CREDENTIALS_MASTER_KEY not valid base64: %w", err)
	}
	if len(key) != 32 {
		return nil, errors.New("CREDENTIALS_MASTER_KEY must be base64 of 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Crypt{aead: aead}, nil
}

func FromEnv() (*Crypt, error) { return New(os.Getenv("CREDENTIALS_MASTER_KEY")) }

func (c *Crypt) Encrypt(plaintext string) (string, error) {
	iv := make([]byte, 12)
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	sealed := c.aead.Seal(nil, iv, []byte(plaintext), nil) // ct||tag
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
	pt, err := c.aead.Open(nil, iv, sealed, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt failed (wrong master key or tampered): %w", err)
	}
	return string(pt), nil
}
