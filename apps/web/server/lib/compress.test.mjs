// Unit tests for the response compressor. Why this file exists: the first cut of
// lib/compress.mjs hung on every asset larger than the encoder's highWaterMark,
// because `express.static` (fileStream.pipe(res)) pauses on `res.write() === false`
// and waits for a `'drain'` event that the zlib stream — not `res` — was emitting.
// That regression is invisible to a header-only assertion, so the size case below
// streams a body well past the highWaterMark through a real Node http server.
//
// These tests pin the three decisions that are load-bearing: event streams are
// never encoded, bodies under the threshold are never encoded, and a large body
// is encoded to fewer bytes and still round-trips byte-for-byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import express from 'express';
import { compress } from './compress.mjs';

function listen(app) {
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Streams `buf` as multiple 64 KB chunks. A single-chunk source never makes
// `res.write()` return false, so it cannot exercise the pause/resume path that
// the hang lived in — the bug shipped precisely because this looked fine.
function chunked(buf, size = 64 * 1024) {
  let i = 0;
  return new Readable({
    read() {
      if (i >= buf.length) return this.push(null);
      const end = Math.min(i + size, buf.length);
      this.push(buf.subarray(i, end));
      i = end;
    },
  });
}

test('a large multi-chunk streamed body is compressed and round-trips byte-for-byte', async () => {
  // Incompressible random data so the encoder's output stays large and crosses
  // its highWaterMark, which is what makes the source see backpressure. Verified
  // to fail (hang) when the drain propagation in compress.mjs is removed.
  const payload = randomBytes(400 * 1024);
  const app = express();
  app.use(compress());
  app.get('/big.js', (req, res) => {
    res.type('application/javascript');
    chunked(payload).pipe(res);
  });
  const srv = await listen(app);
  try {
    const plain = await get(srv.address().port, '/big.js', { 'accept-encoding': 'identity' });
    const br = await get(srv.address().port, '/big.js', { 'accept-encoding': 'br' });
    assert.equal(plain.body.length, payload.length, 'identity body is intact');
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(br.headers.vary, 'Accept-Encoding');
    assert.deepEqual(zlib.brotliDecompressSync(br.body), payload, 'brotli body decodes to the original');
  } finally {
    srv.close();
  }
});

test('an event stream is never compressed', async () => {
  const app = express();
  app.use(compress());
  app.get('/sse', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('data: one\n\n');
    res.end('data: two\n\n');
  });
  const srv = await listen(app);
  try {
    const r = await get(srv.address().port, '/sse', { 'accept-encoding': 'gzip, br' });
    assert.equal(r.headers['content-encoding'], undefined, 'SSE must not be encoded');
    assert.equal(r.headers.vary, 'Accept-Encoding');
    assert.equal(r.body.toString(), 'data: one\n\ndata: two\n\n');
  } finally {
    srv.close();
  }
});

test('a body under the threshold is left alone but still varies', async () => {
  const app = express();
  app.use(compress());
  app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nAllow: /\n'));
  const srv = await listen(app);
  try {
    const r = await get(srv.address().port, '/robots.txt', { 'accept-encoding': 'gzip, br' });
    assert.equal(r.headers['content-encoding'], undefined);
    assert.equal(r.headers.vary, 'Accept-Encoding');
    assert.match(r.body.toString(), /User-agent/);
  } finally {
    srv.close();
  }
});

test('a client that cannot compress is not sent a compressed body', async () => {
  const app = express();
  app.use(compress());
  app.get('/x.json', (req, res) => res.json({ ok: true }));
  const srv = await listen(app);
  try {
    const r = await get(srv.address().port, '/x.json', { 'accept-encoding': 'identity' });
    assert.equal(r.headers['content-encoding'], undefined);
    assert.deepEqual(JSON.parse(r.body.toString()), { ok: true });
  } finally {
    srv.close();
  }
});
