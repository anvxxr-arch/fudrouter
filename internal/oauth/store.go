package oauth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

func b64url(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

func RandomB64URL(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return b64url(b), nil
}

func PKCEVerifier(bytes int) (string, error) {
	if bytes <= 0 {
		bytes = 32
	}
	return RandomB64URL(bytes)
}

func PKCEChallengeS256(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return b64url(sum[:])
}

func RandomState() (string, error) {
	return RandomB64URL(16)
}

func RandomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// Pending holds in-flight OAuth handshakes (process memory).
type Pending struct {
	ID           string    `json:"id"`
	Provider     string    `json:"provider"`
	Status       string    `json:"status"` // pending|done|error
	CreatedAt    time.Time `json:"createdAt"`
	ExpiresAt    time.Time `json:"expiresAt"`
	AuthURL      string    `json:"authUrl,omitempty"`
	RedirectURI  string    `json:"redirectUri,omitempty"`
	CodeVerifier string    `json:"-"`
	State        string    `json:"-"`
	Nonce        string    `json:"-"`
	MachineID    string    `json:"machineId,omitempty"`
	// xiaomi
	PrivateKeyPKCS8 []byte `json:"-"`
	PublicKeyB64    string `json:"publicKey,omitempty"`
	// result
	Error  string         `json:"error,omitempty"`
	Result map[string]any `json:"result,omitempty"`
}

type Store struct {
	mu   sync.Mutex
	byID map[string]*Pending
}

func NewStore() *Store {
	return &Store{byID: map[string]*Pending{}}
}

func (s *Store) Put(p *Pending) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.byID[p.ID] = p
	// purge expired
	now := time.Now()
	for id, v := range s.byID {
		if now.After(v.ExpiresAt) {
			delete(s.byID, id)
		}
	}
}

func (s *Store) Get(id string) (*Pending, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.byID[id]
	if !ok {
		return nil, false
	}
	if time.Now().After(p.ExpiresAt) {
		delete(s.byID, id)
		return nil, false
	}
	return p, true
}

// GetByState finds a pending session by its OAuth state value.
func (s *Store) GetByState(state string) (*Pending, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.byID {
		if p.State == state {
			if time.Now().After(p.ExpiresAt) {
				delete(s.byID, p.ID)
				return nil, false
			}
			return p, true
		}
	}
	return nil, false
}

func (s *Store) Update(id string, fn func(*Pending)) (*Pending, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.byID[id]
	if !ok {
		return nil, fmt.Errorf("oauth session not found")
	}
	fn(p)
	return p, nil
}

func NewPending(provider string, ttl time.Duration) (*Pending, error) {
	id, err := RandomHex(16)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	return &Pending{
		ID:        id,
		Provider:  provider,
		Status:    "pending",
		CreatedAt: now,
		ExpiresAt: now.Add(ttl),
	}, nil
}
