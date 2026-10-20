// compare-frame.test.mjs — the client-side compare frame parser.
//
// Why this file exists: the compare relay (apps/web/server/playground.mjs:599-602)
// wraps every upstream SSE line verbatim as {"model":…,"chunk":"data: {…}"}, so
// the delta sits one level down inside frame.chunk. The client used to read
// `choices` off the wrapper itself, which is always undefined — every compare
// column stayed empty while the stream ran fine. This is the only code-level
// coverage of that parser: the integration test (tests/integration/
// playground-compare.test.mjs) covers the server relay only, never the client's
// unwrap. A regression here is invisible to every other gate in the repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareChunk } from './compare-frame.ts';

test('a wrapped data line yields the attributed delta', () => {
  assert.deepEqual(
    compareChunk('{"model":"gpt-x","chunk":"data: {\\"choices\\":[{\\"delta\\":{\\"content\\":\\"hello\\"}}]}"}'),
    { model: 'gpt-x', delta: 'hello' }
  );
});

test('the [DONE] terminator carries no text', () => {
  assert.equal(compareChunk('{"model":"gpt-x","chunk":"data: [DONE]"}'), null);
});

test('a delta with no content field yields null', () => {
  assert.equal(compareChunk('{"model":"gpt-x","chunk":"data: {\\"choices\\":[{\\"delta\\":{}}]}"}'), null);
});

test('a non-JSON chunk body yields null', () => {
  assert.equal(compareChunk('{"model":"gpt-x","chunk":"not-json"}'), null);
});

test('a metrics frame (no model, no chunk) yields null', () => {
  assert.equal(compareChunk('{"requestId":"r","latencyMs":1}'), null);
});

test('a null payload and a non-JSON payload yield null without throwing', () => {
  assert.equal(compareChunk('null'), null);
  assert.equal(compareChunk('not json'), null);
});

test('a frame whose delta lives at the TOP level yields null', () => {
  // The old bug shape: reading choices off the wrapper instead of unwrapping
  // frame.chunk. It must stay dead — the relay never produces this, and a
  // parser that accepted it would silently mis-attribute text.
  assert.equal(
    compareChunk('{"model":"gpt-x","choices":[{"delta":{"content":"hello"}}]}'),
    null
  );
});
