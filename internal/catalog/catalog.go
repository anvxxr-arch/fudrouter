package catalog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type Catalog struct {
	mu        sync.RWMutex
	path      string
	providers map[string]any
	models    []map[string]any
	loadedAt  time.Time
}

func Open(dataDir string) *Catalog {
	c := &Catalog{path: filepath.Join(dataDir, "model-catalog.json")}
	_ = c.Reload()
	return c
}

func (c *Catalog) Reload() error {
	b, err := os.ReadFile(c.path)
	if err != nil {
		c.mu.Lock()
		c.providers = map[string]any{}
		c.models = nil
		c.mu.Unlock()
		return err
	}
	var root map[string]any
	if err := json.Unmarshal(b, &root); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.providers = map[string]any{}
	if p, ok := root["providers"].(map[string]any); ok {
		c.providers = p
	}
	c.models = nil
	switch m := root["models"].(type) {
	case []any:
		for _, item := range m {
			if mm, ok := item.(map[string]any); ok {
				c.models = append(c.models, mm)
			}
		}
	case map[string]any:
		for id, item := range m {
			if mm, ok := item.(map[string]any); ok {
				mm = clone(mm)
				if _, ok := mm["id"]; !ok {
					mm["id"] = id
				}
				c.models = append(c.models, mm)
			}
		}
	}
	c.loadedAt = time.Now()
	return nil
}

func clone(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func (c *Catalog) ProvidersClient() []map[string]any {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]map[string]any, 0, len(c.providers))
	for id, raw := range c.providers {
		item := map[string]any{"id": id}
		if m, ok := raw.(map[string]any); ok {
			for k, v := range m {
				// strip secrets if any
				if strings.Contains(strings.ToLower(k), "key") || strings.Contains(strings.ToLower(k), "secret") {
					continue
				}
				item[k] = v
			}
			if _, ok := item["name"]; !ok {
				item["name"] = id
			}
		} else {
			item["name"] = id
		}
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(str(out[i]["name"])) < strings.ToLower(str(out[j]["name"]))
	})
	return out
}

func (c *Catalog) Provider(id string) (map[string]any, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	raw, ok := c.providers[id]
	if !ok {
		return nil, false
	}
	m, _ := raw.(map[string]any)
	out := map[string]any{"id": id}
	for k, v := range m {
		out[k] = v
	}
	return out, true
}

func (c *Catalog) Models(provider string) []map[string]any {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]map[string]any, 0)
	for _, m := range c.models {
		if provider != "" {
			p := str(m["provider"])
			if p == "" {
				p = str(m["owned_by"])
			}
			if !strings.EqualFold(p, provider) && !strings.HasPrefix(str(m["id"]), provider+"/") {
				continue
			}
		}
		out = append(out, m)
	}
	return out
}

func (c *Catalog) OpenAIModels() []map[string]any {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]map[string]any, 0, len(c.models))
	for _, m := range c.models {
		id := str(m["id"])
		if id == "" {
			continue
		}
		out = append(out, map[string]any{
			"id":       id,
			"object":   "model",
			"created":  int64(0),
			"owned_by": first(str(m["provider"]), str(m["owned_by"]), "fudrouter"),
		})
	}
	if len(out) == 0 {
		// minimal defaults
		for _, id := range []string{"openai/gpt-4o", "anthropic/claude-sonnet-4", "google/gemini-2.0-flash"} {
			out = append(out, map[string]any{"id": id, "object": "model", "owned_by": strings.Split(id, "/")[0]})
		}
	}
	return out
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func first(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
