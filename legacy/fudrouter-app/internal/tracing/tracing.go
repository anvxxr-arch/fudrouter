package tracing

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Span represents a single operation span.
type Span struct {
	TraceID   string            `json:"traceId"`
	SpanID    string            `json:"spanId"`
	ParentID  string            `json:"parentId,omitempty"`
	Name      string            `json:"name"`
	StartTime time.Time         `json:"startTime"`
	EndTime   time.Time         `json:"endTime"`
	Duration  int64             `json:"durationMs"`
	Tags      map[string]string `json:"tags,omitempty"`
	Events    []SpanEvent       `json:"events,omitempty"`
}

// SpanEvent represents an event within a span.
type SpanEvent struct {
	Name      string            `json:"name"`
	Timestamp time.Time         `json:"timestamp"`
	Tags      map[string]string `json:"tags,omitempty"`
}

// Tracer creates and manages spans.
type Tracer struct {
	mu     sync.Mutex
	spans  []*Span
	maxLen int
}

// New creates a new Tracer.
func New() *Tracer {
	return &Tracer{
		spans:  make([]*Span, 0, 1000),
		maxLen: 10000,
	}
}

// StartSpan starts a new span.
func (t *Tracer) StartSpan(ctx context.Context, name string, tags map[string]string) *Span {
	span := &Span{
		TraceID:   traceID(ctx),
		SpanID:    spanID(),
		ParentID:  parentID(ctx),
		Name:      name,
		StartTime: time.Now(),
		Tags:      tags,
		Events:    make([]SpanEvent, 0),
	}
	return span
}

// FinishSpan finishes a span and records it.
func (t *Tracer) FinishSpan(span *Span) {
	span.EndTime = time.Now()
	span.Duration = span.EndTime.Sub(span.StartTime).Milliseconds()

	t.mu.Lock()
	defer t.mu.Unlock()
	t.spans = append(t.spans, span)
	if len(t.spans) > t.maxLen {
		t.spans = t.spans[len(t.spans)-t.maxLen:]
	}
}

// AddEvent adds an event to a span.
func (s *Span) AddEvent(name string, tags map[string]string) {
	s.Events = append(s.Events, SpanEvent{
		Name:      name,
		Timestamp: time.Now(),
		Tags:      tags,
	})
}

// GetSpans returns all recorded spans.
func (t *Tracer) GetSpans() []*Span {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]*Span, len(t.spans))
	copy(out, t.spans)
	return out
}

// GetSpansByTraceID returns all spans for a given trace ID.
func (t *Tracer) GetSpansByTraceID(traceID string) []*Span {
	t.mu.Lock()
	defer t.mu.Unlock()
	var out []*Span
	for _, s := range t.spans {
		if s.TraceID == traceID {
			out = append(out, s)
		}
	}
	return out
}

// Clear removes all recorded spans.
func (t *Tracer) Clear() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.spans = make([]*Span, 0, 1000)
}

// Context keys
type contextKey string

const (
	traceIDKey contextKey = "trace_id"
	spanIDKey  contextKey = "span_id"
)

// WithTraceID returns a context with a trace ID.
func WithTraceID(ctx context.Context, traceID string) context.Context {
	return context.WithValue(ctx, traceIDKey, traceID)
}

// WithSpanID returns a context with a span ID.
func WithSpanID(ctx context.Context, spanID string) context.Context {
	return context.WithValue(ctx, spanIDKey, spanID)
}

// traceID extracts the trace ID from context.
func traceID(ctx context.Context) string {
	if v, ok := ctx.Value(traceIDKey).(string); ok {
		return v
	}
	return newID()
}

// parentID extracts the parent span ID from context.
func parentID(ctx context.Context) string {
	if v, ok := ctx.Value(spanIDKey).(string); ok {
		return v
	}
	return ""
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func spanID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Handler returns an HTTP handler for trace spans.
func (t *Tracer) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		spans := t.GetSpans()
		json.NewEncoder(w).Encode(map[string]any{
			"spans": spans,
			"count": len(spans),
		})
	})
}

var _ = fmt.Sprintf // keep import
