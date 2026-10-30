// injection.go — resolving the prompt injections that apply to one request.
//
// Three scopes, one row each at most, stacked in a fixed order:
//
//	account-wide  (api_key_id IS NULL AND model_slug IS NULL)
//	per API key   (api_key_id = this key)
//	per model     (model_slug matches what the client asked for, or what it
//	              resolved to)
//
// The router applies them in that order (internal/proxy/injection.go), which is
// also the order this query returns. A request therefore carries at most three
// injections and never the same one twice.
//
// Model matching is deliberately BOTH names: `requested` is the raw string the
// client sent (`premium`, `opus`, `glm-5.3-flash-unrestricted`), `canonical` is
// the slug the resolution produced. An injection authored for a real model must
// fire when that model is reached through a combo or an alias — otherwise the
// persona would vanish exactly when the customer's fallback kicked in, which is
// the one moment it matters most.
package store

import (
	"context"
	"strings"
)

// PromptInjection is one stored injection, shaped for the data plane.
type PromptInjection struct {
	ID       string `json:"id"`
	APIKeyID string `json:"apiKeyId,omitempty"`
	ModelSlug string `json:"modelSlug,omitempty"`
	// Mode is system_prepend | system_append | chat_script.
	Mode    string `json:"mode"`
	Content string `json:"content"`
}

// PromptInjectionsFor returns the injections that apply to one request, ordered
// account-wide → key → model.
//
// `canonical` may be empty (a name that resolved to a virtual set); the query
// then matches on `requested` alone.
func (s *Store) PromptInjectionsFor(ctx context.Context, accountID, keyID, requested, canonical string) ([]PromptInjection, error) {
	if accountID == "" {
		return nil, nil
	}
	// Blank targets must never match a NULL target column, so the empty string
	// is filtered out of the match list rather than compared.
	names := make([]string, 0, 2)
	for _, n := range []string{requested, canonical} {
		if n = strings.ToLower(strings.TrimSpace(n)); n != "" {
			names = append(names, n)
		}
	}
	if len(names) == 0 {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx, `
		select id, coalesce(api_key_id, ''), coalesce(model_slug, ''), mode, content
		from prompt_injection
		where enabled and account_id = $1
		  and (api_key_id is null or api_key_id = $2)
		  and (model_slug is null or lower(model_slug) = any($3))
		-- false sorts before true: account-wide (false,false) → key (true,false)
		-- → model (true,true). updated_at breaks a tie deterministically.
		order by (api_key_id is not null), (model_slug is not null), updated_at asc`,
		accountID, keyID, names)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PromptInjection
	for rows.Next() {
		var in PromptInjection
		if err := rows.Scan(&in.ID, &in.APIKeyID, &in.ModelSlug, &in.Mode, &in.Content); err != nil {
			return nil, err
		}
		out = append(out, in)
	}
	return out, rows.Err()
}
