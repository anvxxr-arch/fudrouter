package cache

import (
	"testing"
	"time"
)

func TestCache_SetAndGet(t *testing.T) {
	c := New(10)
	c.Set("key1", "value1", time.Minute)

	v, ok := c.Get("key1")
	if !ok {
		t.Fatal("expected to find key1")
	}
	if v != "value1" {
		t.Errorf("expected 'value1', got '%v'", v)
	}
}

func TestCache_Get_NotFound(t *testing.T) {
	c := New(10)
	_, ok := c.Get("nonexistent")
	if ok {
		t.Error("expected not to find nonexistent key")
	}
}

func TestCache_Get_Expired(t *testing.T) {
	c := New(10)
	c.Set("key1", "value1", time.Millisecond)
	time.Sleep(2 * time.Millisecond)

	_, ok := c.Get("key1")
	if ok {
		t.Error("expected key to be expired")
	}
}

func TestCache_Delete(t *testing.T) {
	c := New(10)
	c.Set("key1", "value1", time.Minute)
	c.Delete("key1")

	_, ok := c.Get("key1")
	if ok {
		t.Error("expected key to be deleted")
	}
}

func TestCache_Clear(t *testing.T) {
	c := New(10)
	c.Set("key1", "value1", time.Minute)
	c.Set("key2", "value2", time.Minute)
	c.Clear()

	if c.Size() != 0 {
		t.Errorf("expected size 0, got %d", c.Size())
	}
}

func TestCache_MaxSize(t *testing.T) {
	c := New(3)
	c.Set("key1", "value1", time.Minute)
	c.Set("key2", "value2", time.Minute)
	c.Set("key3", "value3", time.Minute)
	c.Set("key4", "value4", time.Minute) // Should evict oldest

	if c.Size() > 3 {
		t.Errorf("expected max size 3, got %d", c.Size())
	}
}

func TestCache_Keys(t *testing.T) {
	c := New(10)
	c.Set("key1", "value1", time.Minute)
	c.Set("key2", "value2", time.Minute)

	keys := c.Keys()
	if len(keys) != 2 {
		t.Errorf("expected 2 keys, got %d", len(keys))
	}
}
