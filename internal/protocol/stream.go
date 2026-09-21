package protocol

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"
)

// StreamingProxy proxies SSE streams from upstream to downstream without buffering.
type StreamingProxy struct {
	client *http.Client
}

// NewStreamingProxy creates a new StreamingProxy.
func NewStreamingProxy() *StreamingProxy {
	return &StreamingProxy{
		client: &http.Client{
			Timeout: 0, // No timeout for streaming
			Transport: &http.Transport{
				Proxy: http.ProxyFromEnvironment,
				DialContext: (&net.Dialer{
					Timeout:   5 * time.Second,
					KeepAlive: 30 * time.Second,
				}).DialContext,
				MaxIdleConns:        100,
				IdleConnTimeout:     90 * time.Second,
				TLSHandshakeTimeout: 5 * time.Second,
				ForceAttemptHTTP2:   true,
			},
		},
	}
}

// ProxyStream proxies an SSE stream from the upstream URL to the downstream writer.
func (p *StreamingProxy) ProxyStream(ctx context.Context, upstreamURL string, body []byte, headers http.Header, w http.ResponseWriter) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, upstreamURL, bytes.NewReader(body))
	if err != nil {
		return err
	}

	// Copy headers
	for k, v := range headers {
		if k == "Host" || k == "Content-Length" {
			continue
		}
		req.Header[k] = v
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")

	resp, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	// Copy response headers
	for k, v := range resp.Header {
		if k == "Content-Length" || k == "Transfer-Encoding" {
			continue
		}
		w.Header()[k] = v
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(resp.StatusCode)

	// Pipe the stream
	flusher, ok := w.(http.Flusher)
	if !ok {
		return fmt.Errorf("response writer does not support flushing")
	}

	buf := make([]byte, 32*1024)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return werr
			}
			flusher.Flush()
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// ProxyStreamWithTransform proxies an SSE stream and transforms chunks to OpenAI format.
func (p *StreamingProxy) ProxyStreamWithTransform(ctx context.Context, upstreamURL string, body []byte, headers http.Header, w http.ResponseWriter, providerID, model, id string, created int64) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, upstreamURL, bytes.NewReader(body))
	if err != nil {
		return err
	}

	for k, v := range headers {
		if k == "Host" || k == "Content-Length" {
			continue
		}
		req.Header[k] = v
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")

	resp, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(resp.StatusCode)

	flusher, ok := w.(http.Flusher)
	if !ok {
		return fmt.Errorf("response writer does not support flushing")
	}

	// Use the normalizer to transform chunks
	chunks, errs := NormalizeSSE(resp.Body, providerID, model, id, created)

	for chunk := range chunks {
		data, err := json.Marshal(chunk)
		if err != nil {
			continue
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
			return err
		}
		flusher.Flush()
	}

	if err := <-errs; err != nil {
		return err
	}

	// Send [DONE]
	_, err = fmt.Fprint(w, "data: [DONE]\n\n")
	flusher.Flush()
	return err
}
