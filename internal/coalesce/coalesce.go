package coalesce

import (
	"sync"
)

// Coalescer deduplicates identical concurrent requests.
type Coalescer struct {
	mu    sync.Mutex
	calls map[string]*call
}

type call struct {
	done chan struct{}
	resp []byte
	err  error
}

// New creates a new Coalescer.
func New() *Coalescer {
	return &Coalescer{
		calls: make(map[string]*call),
	}
}

// Do executes a function with request coalescing.
// If the same key is already being processed, it waits for the result.
func (c *Coalescer) Do(key string, fn func() ([]byte, error)) ([]byte, error) {
	c.mu.Lock()
	if cl, ok := c.calls[key]; ok {
		c.mu.Unlock()
		<-cl.done
		return cl.resp, cl.err
	}

	cl := &call{done: make(chan struct{})}
	c.calls[key] = cl
	c.mu.Unlock()

	cl.resp, cl.err = fn()

	c.mu.Lock()
	delete(c.calls, key)
	c.mu.Unlock()
	close(cl.done)

	return cl.resp, cl.err
}

// Size returns the number of in-flight coalesced requests.
func (c *Coalescer) Size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.calls)
}

// Keys returns the keys of in-flight coalesced requests.
func (c *Coalescer) Keys() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, 0, len(c.calls))
	for k := range c.calls {
		out = append(out, k)
	}
	return out
}
