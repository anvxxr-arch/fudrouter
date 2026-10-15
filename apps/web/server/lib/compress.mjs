// On-the-fly response compression (node:zlib, no dependency).
//
// Added because the console shipped its entire frontend uncompressed: measured
// `Content-Length: 339054` on the main bundle with AND without
// `Accept-Encoding: gzip, br`, so every visitor paid ~3.2x the wire bytes.
// Caddy owns the other response headers (index.mjs) and nothing in the chain
// compressed, so the origin does it here.
//
// Two things are load-bearing.
//
// 1. The skip list. The playground relay calls
//    `res.writeHead(200, { 'content-type': 'text/event-stream' })` and streams
//    with `res.write` (playground.mjs:400-425); compressing that buffers the
//    stream and destroys TTFT, the one metric the SSE path exists to produce.
//    So the decision is taken exactly once -- at the first writeHead/write/end
//    -- and never for an event stream, a partial response, or a body the caller
//    already encoded.
//
// 2. Backpressure, both directions. `express.static` serves files with
//    `fileStream.pipe(res)`, and `pipe` writes through `res.write` and pauses
//    the source when it returns false, waiting for a `'drain'` event on `res`.
//    A first cut returned the encoder's own backpressure value without ever
//    emitting `'drain'` on `res`, so the source paused and never resumed: every
//    asset larger than the encoder's highWaterMark hung until the client timed
//    out. Input backpressure is therefore propagated back (`stream` drain ->
//    `res.emit('drain')`) and output backpressure is handled by pausing the
//    encoder when the socket is full and resuming it on the socket's drain.
//
// `Vary: Accept-Encoding` is set even when nothing is compressed: without it a
// shared cache in front (cloudflared, Caddy) can hand a compressed body to a
// client that never asked for one.
import zlib from 'node:zlib';

// Below this, the framing cost of a compressed body exceeds the saving.
const DEFAULT_THRESHOLD = 1024;
const COMPRESSIBLE =
  /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json|ld\+json|rss\+xml)|image\/svg\+xml|font\/)/;
const NEVER = /^(?:text\/event-stream|application\/(?:x-ndjson|octet-stream|zip)|multipart\/)/;

// Quality 6 on a 339KB bundle (index-BDBBJqrH.js): q4 107375, q6 100363,
// q9 99322, q11 92173, against gzip -6 106454. q4 losing to gzip here is a
// property of *large* inputs -- on small bodies q4 usually beats gzip -- so
// this is not a claim that gzip is better in general, only that q6 is the right
// default for the mix this server sends. q9/q11 buy 1-13% more for 3-75x the
// CPU, which is the wrong trade for a per-request encoder.
const BROTLI = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } };

export function compress({ threshold = DEFAULT_THRESHOLD } = {}) {
  return function compressMiddleware(req, res, next) {
    const accept = String(req.headers['accept-encoding'] ?? '');
    const encoding = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;

    if (!res.hasHeader('Vary')) res.setHeader('Vary', 'Accept-Encoding');
    if (!encoding || (req.method !== 'GET' && req.method !== 'HEAD')) return next();

    const rawWrite = res.write;
    const rawWriteHead = res.writeHead;
    const rawEnd = res.end;
    let stream = null;
    let decided = false;
    let finished = false;

    // Decide once, from the headers actually being sent. Returns true when the
    // body should go through `stream`.
    const decide = () => {
      decided = true;
      const type = String(res.getHeader('content-type') ?? '');
      const declared = Number(res.getHeader('content-length') ?? 0);
      const status = res.statusCode;
      if (
        NEVER.test(type) ||
        !COMPRESSIBLE.test(type) ||
        res.hasHeader('content-encoding') ||
        /no-transform/i.test(String(res.getHeader('cache-control') ?? '')) ||
        status === 204 ||
        status === 206 ||
        status === 304 ||
        status < 200 ||
        (declared > 0 && declared < threshold)
      ) {
        return false;
      }
      res.removeHeader('Content-Length');
      res.setHeader('content-encoding', encoding);
      stream = encoding === 'br' ? zlib.createBrotliCompress(BROTLI) : zlib.createGzip({ level: 6 });
      // Encoder -> socket. If the socket is full, stop reading from the encoder
      // until it drains; otherwise a slow client would buffer the whole body.
      stream.on('data', (chunk) => {
        if (rawWrite.call(res, chunk) === false) stream.pause();
      });
      // Encoder drained its input buffer -> the pipe source may resume writing.
      stream.on('drain', () => res.emit('drain'));
      res.on('drain', () => stream.resume());
      stream.on('end', () => {
        if (!finished) {
          finished = true;
          rawEnd.call(res);
        }
      });
      // An encoder error cannot be reported as a clean end: the status line and
      // part of the body are already on the wire, so `end()` would hand the
      // client a truncated gzip/brotli stream that decodes to garbage while the
      // response still looks successful. Destroying the response is the only
      // honest signal (the client sees a broken connection, not corrupt bytes).
      stream.on('error', (err) => {
        if (!finished) {
          finished = true;
          res.destroy(err);
        }
      });
      return true;
    };

    // The playground calls writeHead directly, so the decision cannot wait for
    // the first write -- by then the status line is on the wire and setHeader
    // would throw ERR_HTTP_HEADERS_SENT.
    res.writeHead = function (status, reason, headers) {
      if (typeof reason === 'object' && reason !== null) {
        headers = reason;
        reason = undefined;
      }
      if (headers) {
        for (const [k, v] of Object.entries(headers)) if (!res.hasHeader(k)) res.setHeader(k, v);
      }
      if (typeof status === 'number') res.statusCode = status;
      if (!decided && decide() && headers) {
        delete headers['content-length'];
        delete headers['Content-Length'];
        headers['content-encoding'] = encoding;
      }
      return reason === undefined
        ? rawWriteHead.call(res, res.statusCode, headers)
        : rawWriteHead.call(res, res.statusCode, reason, headers);
    };

    res.write = function (chunk, enc, cb) {
      if (!decided && !decide()) return rawWrite.call(res, chunk, enc, cb);
      return stream ? stream.write(chunk, enc, cb) : rawWrite.call(res, chunk, enc, cb);
    };

    res.end = function (chunk, enc, cb) {
      if (typeof chunk === 'function') {
        cb = chunk;
        chunk = undefined;
        enc = undefined;
      }
      if (!decided && !decide()) return rawEnd.call(res, chunk, enc, cb);
      if (!stream) return rawEnd.call(res, chunk, enc, cb);
      if (chunk !== undefined && chunk !== null) stream.write(chunk, enc);
      stream.end(cb);
      return res;
    };

    next();
  };
}
