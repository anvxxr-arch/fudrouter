package proxy

import (
	"net/http"

	"github.com/anvxxr-arch/fudrouter/apps/router/internal/routing"
)

// Error normalization (PRD §88, schema spec §8).
//
// The client-facing body is the [OI] error envelope with the platform's
// normalized code inside it:
//
//	{"error": {"message": "…", "type": "…", "code": "RATE_LIMITED"}}
//
// `code` is exactly the PRD §88 taxonomy (the cross-plane contract the
// playground and the metrics panels read); `type` is the [OI]-shaped error
// class every existing client already parses; `message` is human text. Raw
// upstream error text goes in request_log.error / attempt metadata, NEVER as
// the client-facing code (spec §8).

// apiError is one normalized failure: the taxonomy code plus the HTTP status
// and [OI] type it surfaces as.
type apiError struct {
	Code    string
	Status  int
	Type    string
	Message string
}

// errTable maps every taxonomy code onto its wire shape. One table, so the
// code→status mapping cannot drift between handlers.
var errTable = map[string]apiError{
	routing.ErrCodeAuthError:           {routing.ErrCodeAuthError, http.StatusUnauthorized, "invalid_request_error", "authentication error"},
	routing.ErrCodeAuthorization:       {routing.ErrCodeAuthorization, http.StatusForbidden, "invalid_request_error", "authorization error"},
	routing.ErrCodeRateLimited:         {routing.ErrCodeRateLimited, http.StatusTooManyRequests, "rate_limit_error", "rate limit exceeded"},
	routing.ErrCodeInsufficientCredits: {routing.ErrCodeInsufficientCredits, http.StatusPaymentRequired, "billing_error", "insufficient credits"},
	routing.ErrCodeInvalidRequest:      {routing.ErrCodeInvalidRequest, http.StatusBadRequest, "invalid_request_error", "invalid request"},
	routing.ErrCodeModelNotFound:       {routing.ErrCodeModelNotFound, http.StatusNotFound, "invalid_request_error", "model not found"},
	routing.ErrCodeContextTooLong:      {routing.ErrCodeContextTooLong, http.StatusRequestEntityTooLarge, "invalid_request_error", "context length exceeded"},
	routing.ErrCodeUnsupportedParam:    {routing.ErrCodeUnsupportedParam, http.StatusBadRequest, "invalid_request_error", "unsupported parameter"},
	routing.ErrCodeContentRejected:     {routing.ErrCodeContentRejected, http.StatusForbidden, "invalid_request_error", "content rejected"},
	routing.ErrCodeProviderTimeout:     {routing.ErrCodeProviderTimeout, http.StatusGatewayTimeout, "api_error", "provider timed out"},
	routing.ErrCodeProviderUnavailable: {routing.ErrCodeProviderUnavailable, http.StatusBadGateway, "api_error", "provider unavailable"},
	routing.ErrCodeCircuitOpen:         {routing.ErrCodeCircuitOpen, http.StatusServiceUnavailable, "api_error", "provider circuit is open"},
	routing.ErrCodeUpstreamError:       {routing.ErrCodeUpstreamError, http.StatusBadGateway, "api_error", "upstream error"},
	routing.ErrCodeInternalError:       {routing.ErrCodeInternalError, http.StatusInternalServerError, "api_error", "internal error"},
}

// normalize builds the wire shape for a taxonomy code with an optional message
// override.
func normalize(code, message string) apiError {
	e, ok := errTable[code]
	if !ok {
		e = errTable[routing.ErrCodeInternalError]
	}
	if message != "" {
		e.Message = message
	}
	return e
}

// statusCodeFor is the HTTP status a taxonomy code surfaces as.
func statusCodeFor(code string) int {
	return normalize(code, "").Status
}
