package oauth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	XiaomiPlatformURL = "https://platform.xiaomimimo.com"
	XiaomiDefaultBase = "https://api.xiaomimimo.com/v1"
	XiaomiKN          = "mimocode"
)

func StartXiaomi(store *Store, redirectURI string) (*Pending, error) {
	p, err := NewPending("xiaomi-mimo", 10*time.Minute)
	if err != nil {
		return nil, err
	}
	if redirectURI == "" {
		redirectURI = "http://127.0.0.1:8011/api/oauth/xiaomi-mimo/callback?sessionId=" + p.ID
	} else if !strings.Contains(redirectURI, "sessionId=") {
		sep := "?"
		if strings.Contains(redirectURI, "?") {
			sep = "&"
		}
		redirectURI = redirectURI + sep + "sessionId=" + p.ID
	}
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	pkcs8, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, err
	}
	pubSPKI, err := x509.MarshalPKIXPublicKey(priv.PublicKey())
	if err != nil {
		return nil, err
	}
	pubB64 := base64.StdEncoding.EncodeToString(pubSPKI)
	keyName := xiaomiKeyName()
	q := url.Values{}
	q.Set("pk", pubB64)
	q.Set("redirect_uri", redirectURI)
	q.Set("kn", XiaomiKN)
	q.Set("key_name", keyName)
	p.PrivateKeyPKCS8 = pkcs8
	p.PublicKeyB64 = pubB64
	p.RedirectURI = redirectURI
	p.AuthURL = XiaomiPlatformURL + "/authorize?" + q.Encode()
	store.Put(p)
	return p, nil
}

func xiaomiKeyName() string {
	host, _ := os.Hostname()
	sum := sha256.Sum256([]byte("linux-" + host))
	return fmt.Sprintf("Fudrouter-xmd-%x", sum[:4])
}

// DecryptXiaomiCallback decrypts the `u` query param.
func DecryptXiaomiCallback(privateKeyPKCS8 []byte, encryptedB64 string) (map[string]any, error) {
	raw, err := base64.StdEncoding.DecodeString(encryptedB64)
	if err != nil {
		// try raw url encoding
		raw, err = base64.RawStdEncoding.DecodeString(encryptedB64)
		if err != nil {
			return nil, err
		}
	}
	if len(raw) < 12+32+16+1 {
		return nil, fmt.Errorf("encrypted payload too short: %d", len(raw))
	}
	nonce := raw[0:12]
	ephRaw := raw[12:44]
	ctAndTag := raw[44:]
	tag := ctAndTag[len(ctAndTag)-16:]
	ciphertext := ctAndTag[:len(ctAndTag)-16]

	privAny, err := x509.ParsePKCS8PrivateKey(privateKeyPKCS8)
	if err != nil {
		return nil, err
	}
	priv, ok := privAny.(*ecdh.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("not x25519 private key")
	}
	eph, err := ecdh.X25519().NewPublicKey(ephRaw)
	if err != nil {
		return nil, err
	}
	shared, err := priv.ECDH(eph)
	if err != nil {
		return nil, err
	}
	derived := sha256.Sum256(shared)
	block, err := aes.NewCipher(derived[:])
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, nonce, append(ciphertext, tag...), nil)
	if err != nil {
		// GCM Open expects ciphertext||tag already as single slice
		ct := make([]byte, len(ciphertext)+len(tag))
		copy(ct, ciphertext)
		copy(ct[len(ciphertext):], tag)
		plain, err = gcm.Open(nil, nonce, ct, nil)
		if err != nil {
			return nil, err
		}
	}
	var parsed map[string]any
	if err := json.Unmarshal(plain, &parsed); err != nil {
		return nil, err
	}
	uid, _ := parsed["uid"].(string)
	sk, _ := parsed["sk"].(string)
	baseURL, _ := parsed["url"].(string)
	if baseURL == "" {
		baseURL = XiaomiDefaultBase
	}
	return map[string]any{
		"uid":         uid,
		"accessToken": sk,
		"sk":          sk,
		"baseUrl":     baseURL,
		"provider":    "xiaomi-mimo",
		"authType":    "oauth",
	}, nil
}

func CompleteXiaomi(store *Store, sessionID, encryptedU string) (*Pending, error) {
	p, ok := store.Get(sessionID)
	if !ok || p.Provider != "xiaomi-mimo" {
		return nil, fmt.Errorf("xiaomi session not found")
	}
	res, err := DecryptXiaomiCallback(p.PrivateKeyPKCS8, encryptedU)
	if err != nil {
		_, _ = store.Update(sessionID, func(pp *Pending) {
			pp.Status = "error"
			pp.Error = err.Error()
		})
		return nil, err
	}
	return store.Update(sessionID, func(pp *Pending) {
		pp.Status = "done"
		pp.Result = res
	})
}
