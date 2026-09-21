package provider

import (
	"fmt"
	"sync"
)

var (
	registryMu sync.RWMutex
	registry   = map[string]Provider{}
)

// Register adds a provider to the registry.
func Register(p Provider) {
	registryMu.Lock()
	defer registryMu.Unlock()
	registry[p.ID()] = p
}

// Get returns a provider by ID.
func Get(id string) (Provider, bool) {
	registryMu.RLock()
	defer registryMu.RUnlock()
	p, ok := registry[id]
	return p, ok
}

// List returns all registered providers.
func List() []Provider {
	registryMu.RLock()
	defer registryMu.RUnlock()
	out := make([]Provider, 0, len(registry))
	for _, p := range registry {
		out = append(out, p)
	}
	return out
}

// ListIDs returns all registered provider IDs.
func ListIDs() []string {
	registryMu.RLock()
	defer registryMu.RUnlock()
	out := make([]string, 0, len(registry))
	for id := range registry {
		out = append(out, id)
	}
	return out
}

// Unregister removes a provider from the registry.
func Unregister(id string) {
	registryMu.Lock()
	defer registryMu.Unlock()
	delete(registry, id)
}

// ResolveProvider returns the provider for a given model or provider name.
// It first checks if the name is a registered provider ID, then tries to
// detect the provider from the model name prefix.
func ResolveProvider(name string) (Provider, error) {
	// Direct provider ID match
	if p, ok := Get(name); ok {
		return p, nil
	}

	// Try to detect from model prefix
	detected := DetectProviderModel(name)
	if detected != "" {
		if p, ok := Get(detected); ok {
			return p, nil
		}
	}

	return nil, fmt.Errorf("unknown provider: %s", name)
}

// DetectProviderModel detects the provider from a model name.
func DetectProviderModel(model string) string {
	// This is a simplified version of the existing DetectProvider logic.
	// In a full implementation, this would be more sophisticated.
	if len(model) == 0 {
		return ""
	}
	// Check for provider/model format
	for i := 0; i < len(model); i++ {
		if model[i] == '/' {
			return model[:i]
		}
	}
	return ""
}
