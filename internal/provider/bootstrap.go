package provider

import (
	"github.com/anvxxr-arch/fudrouter/internal/catalog"
)

// Bootstrap registers all known providers from the catalog into the registry.
func Bootstrap(c *catalog.Catalog) {
	for _, p := range c.ProvidersClient() {
		id, _ := p["id"].(string)
		name, _ := p["name"].(string)
		if id == "" {
			continue
		}
		authTypes := []AuthType{}
		if at, ok := p["authTypes"].([]any); ok {
			for _, a := range at {
				if s, ok := a.(string); ok {
					authTypes = append(authTypes, AuthType(s))
				}
			}
		}
		provider := NewConnectionProvider(id, name, authTypes)
		Register(provider)
	}
}
