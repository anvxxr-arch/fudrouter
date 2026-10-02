package apikey

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"strings"
)

func secret() string {
	if v := os.Getenv("API_KEY_SECRET"); v != "" {
		return v
	}
	// Fail fast in production — no default secret
	if os.Getenv("FUDROUTER_ENV") == "production" {
		log.Fatal("[apikey] API_KEY_SECRET env var must be set in production")
	}
	return "endpoint-proxy-api-key-secret"
}

func crc(machineID, keyID string) string {
	m := hmac.New(sha256.New, []byte(secret()))
	_, _ = m.Write([]byte(machineID + keyID))
	return hex.EncodeToString(m.Sum(nil))[:8]
}

func randKeyID() string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	out := make([]byte, 6)
	for i := range out {
		out[i] = chars[int(b[i])%len(chars)]
	}
	return string(out)
}

func Generate(machineID string) (key, keyID string) {
	keyID = randKeyID()
	key = fmt.Sprintf("skNP-%s-%s-%s", machineID, keyID, crc(machineID, keyID))
	return key, keyID
}

func Parse(apiKey string) (machineID, keyID string, ok bool) {
	if !strings.HasPrefix(apiKey, "skNP-") {
		return "", "", false
	}
	parts := strings.Split(apiKey, "-")
	if len(parts) == 4 {
		_, mid, kid, c := parts[0], parts[1], parts[2], parts[3]
		if crc(mid, kid) != c {
			return "", "", false
		}
		return mid, kid, true
	}
	if len(parts) == 2 {
		return "", parts[1], true
	}
	return "", "", false
}

func MachineID(dataDir string) string {
	b, err := os.ReadFile(strings.TrimRight(dataDir, "/") + "/machine-id")
	if err != nil {
		return "localhost"
	}
	return strings.TrimSpace(string(b))
}
