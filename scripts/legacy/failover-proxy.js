#!/usr/bin/env node
/**
 * Optional zero-delay multi-connection RACE proxy for fudrouter.
 *
 * Lives inside /home/dwizzy/fudrouter-app/scripts only.
 *
 * Default path (recommended):
 *   MITM → fudrouter :20128
 *   fudrouter native fill-first / round-robin already fails over accounts
 *   with no artificial sleep on 429/401/5xx.
 *
 * This race proxy is OPTIONAL. Enable only when you want parallel key race
 * (burns quota on losers). Default setup leaves MITM on :20128.
 *
 * Modes:
 *   - passthrough (default): proxy everything to fudrouter :20128
 *   - race: race multiple providerConnections keys for /v1/chat/completions
 *
 * Run:
 *   node scripts/failover-proxy.js
 *   FAILOVER_MODE=race node scripts/failover-proxy.js
 *   pm2 start scripts/failover-proxy.js --name fudrouter-failover
 */

const http = require("http");
const https = require("https");
const path = require("path");
const os = require("os");

const PORT = parseInt(process.env.FAILOVER_PORT || "20126", 10);
const MODE = (process.env.FAILOVER_MODE || "passthrough").toLowerCase(); // passthrough | race
const BACKEND = process.env.FAILOVER_BACKEND || "http://127.0.0.1:20128";
const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), ".fudrouter");
const DB_PATH = process.env.FAILOVER_DB_PATH || path.join(DATA_DIR, "db", "data.sqlite");
const CONNECTION_TIMEOUT_MS = parseInt(process.env.FAILOVER_TIMEOUT || "15000", 10);
const RACE_TIMEOUT_MS = parseInt(process.env.FAILOVER_RACE_TIMEOUT || "30000", 10);
const DISABLE_COOLDOWN_MS = parseInt(process.env.FAILOVER_COOLDOWN || "60000", 10);
const MAX_RACE = parseInt(process.env.FAILOVER_MAX_RACE || "4", 10);

const rateLimitTracker = new Map();
let db = null;

function getDB() {
  if (db) return db;
  try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
  } catch (err) {
    try {
      const Database = require("better-sqlite3");
      db = new Database(DB_PATH);
    } catch (err2) {
      console.error("[Failover] DB open failed:", err.message, err2.message);
      process.exit(1);
    }
  }
  return db;
}

function parseConnectionData(connection) {
  let data = {};
  try {
    if (typeof connection.data === "string") data = JSON.parse(connection.data || "{}");
    else if (connection.data) data = connection.data;
  } catch {}
  return data || {};
}

function getActiveConnections(provider) {
  const database = getDB();
  try {
    const rows = database
      .prepare(
        `SELECT id, provider, name, priority, isActive, data, base_url, api_key
         FROM providerConnections
         WHERE provider = ? AND isActive = 1
         ORDER BY priority ASC`
      )
      .all(provider);

    const now = Date.now();
    return rows
      .filter((row) => {
        const tracker = rateLimitTracker.get(row.id);
        if (tracker?.disabledUntil && tracker.disabledUntil > now) return false;
        if (tracker?.disabledUntil && tracker.disabledUntil <= now) {
          tracker.disabledUntil = null;
          tracker.status = "active";
        }
        return true;
      })
      .slice(0, Math.max(1, MAX_RACE));
  } catch (err) {
    console.error("[Failover] getActiveConnections failed:", err.message);
    return [];
  }
}

function markConnectionFailed(connectionId, statusCode, retryAfter) {
  let tracker = rateLimitTracker.get(connectionId);
  if (!tracker) {
    tracker = { status: "active", failures: 0, disabledUntil: null };
    rateLimitTracker.set(connectionId, tracker);
  }
  tracker.failures = (tracker.failures || 0) + 1;
  tracker.lastFailure = Date.now();
  tracker.lastStatusCode = statusCode;

  if (statusCode === 429) {
    const disableMs = retryAfter ? retryAfter * 1000 : DISABLE_COOLDOWN_MS;
    tracker.disabledUntil = Date.now() + disableMs;
    tracker.status = "rate_limited";
    console.log(`[Failover] ${connectionId} 429 → cooldown ${disableMs}ms`);
  } else if (statusCode === 401 || statusCode === 403) {
    tracker.disabledUntil = Date.now() + 24 * 60 * 60 * 1000;
    tracker.status = "auth_error";
    console.log(`[Failover] ${connectionId} ${statusCode} → disabled 24h`);
  } else if (statusCode >= 500 || statusCode === 408) {
    tracker.disabledUntil = Date.now() + 5000;
    tracker.status = "server_error";
    console.log(`[Failover] ${connectionId} ${statusCode} → cooldown 5s`);
  }
}

function markConnectionHealthy(connectionId) {
  const tracker = rateLimitTracker.get(connectionId);
  if (tracker) {
    tracker.failures = 0;
    tracker.status = "active";
    tracker.disabledUntil = null;
  }
}

function detectProviderFromModel(model) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  if (m.includes("/")) return m.split("/")[0];
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")) return "openai";
  if (m.startsWith("gemini")) return "google";
  if (m.startsWith("deepseek")) return "deepseek";
  if (m.startsWith("qwen") || m.startsWith("qwq")) return "qwen";
  if (m.startsWith("mistral")) return "mistral";
  if (m.startsWith("grok")) return "xai";
  if (m.startsWith("kimi")) return "moonshot";
  if (m.startsWith("glm")) return "zhipu";
  return null;
}

function attemptConnection(connection, body, headers, abortController) {
  return new Promise((resolve, reject) => {
    const data = parseConnectionData(connection);
    const baseUrl =
      connection.base_url ||
      data.baseUrl ||
      data.base_url ||
      data.endpoint ||
      null;
    const apiKey =
      connection.api_key ||
      data.apiKey ||
      data.api_key ||
      data.accessToken ||
      data.token ||
      "";

    if (!baseUrl) {
      reject(Object.assign(new Error("Missing baseUrl on connection"), { statusCode: 503 }));
      return;
    }
    if (!apiKey) {
      reject(Object.assign(new Error("Missing apiKey on connection"), { statusCode: 401 }));
      return;
    }

    let url;
    try {
      url = new URL(baseUrl);
      if (!/\/v1\/chat\/completions\/?$/.test(url.pathname)) {
        url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/chat/completions`;
      }
    } catch {
      reject(Object.assign(new Error(`Invalid base URL: ${baseUrl}`), { statusCode: 400 }));
      return;
    }

    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": headers["user-agent"] || "fudrouter-failover/1.1",
        Accept: "application/json, text/event-stream",
      },
      timeout: CONNECTION_TIMEOUT_MS,
      rejectUnauthorized: false,
    };

    const req = lib.request(options, (res) => {
      const statusCode = res.statusCode;
      const contentType = res.headers["content-type"] || "";
      if (statusCode >= 200 && statusCode < 300) {
        resolve({
          statusCode,
          headers: res.headers,
          connectionId: connection.id,
          isStream: contentType.includes("text/event-stream"),
          res,
        });
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const err = new Error(
          `HTTP ${statusCode}: ${Buffer.concat(chunks).toString().slice(0, 200)}`
        );
        err.statusCode = statusCode;
        err.retryAfter = res.headers["retry-after"]
          ? parseInt(res.headers["retry-after"], 10)
          : null;
        reject(err);
      });
    });

    const onAbort = () => {
      req.destroy();
      reject(Object.assign(new Error("Aborted"), { statusCode: 499 }));
    };
    abortController.signal.addEventListener("abort", onAbort, { once: true });

    req.on("timeout", () => {
      req.destroy();
      reject(Object.assign(new Error("Timeout"), { statusCode: 408 }));
    });
    req.on("error", (err) => {
      err.statusCode = err.statusCode || 503;
      reject(err);
    });

    req.write(JSON.stringify(body));
    req.end();
  });
}

function raceConnections(connections, body, headers) {
  return new Promise((resolve, reject) => {
    if (!connections.length) {
      reject(new Error("No active connections available"));
      return;
    }

    const abortControllers = connections.map(() => new AbortController());
    let settled = false;
    let pending = connections.length;

    const raceTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      abortControllers.forEach((ac) => ac.abort());
      reject(new Error(`Race timeout after ${RACE_TIMEOUT_MS}ms`));
    }, RACE_TIMEOUT_MS);

    connections.forEach((conn, index) => {
      attemptConnection(conn, body, headers, abortControllers[index])
        .then((result) => {
          if (settled) {
            try {
              result.res.resume();
              result.res.destroy();
            } catch {}
            return;
          }
          settled = true;
          clearTimeout(raceTimer);
          abortControllers.forEach((ac, i) => {
            if (i !== index) ac.abort();
          });
          markConnectionHealthy(conn.id);
          resolve({ ...result, connectionId: conn.id });
        })
        .catch((err) => {
          pending -= 1;
          if (!settled) {
            markConnectionFailed(conn.id, err.statusCode, err.retryAfter);
            if (pending <= 0) {
              settled = true;
              clearTimeout(raceTimer);
              reject(err);
            }
          }
        });
    });
  });
}

function proxyToBackend(req, res) {
  const target = new URL(BACKEND);
  const options = {
    hostname: target.hostname,
    port: target.port || 80,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: target.host },
  };
  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Backend unavailable", message: err.message }));
    }
  });
  req.pipe(proxyReq);
}

async function handleRaceChat(req, res) {
  const start = Date.now();
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const provider =
      req.headers["x-fudrouter-provider"] ||
      body.provider ||
      detectProviderFromModel(body.model);

    if (!provider) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Cannot determine provider from request" }));
      return;
    }

    const connections = getActiveConnections(provider);
    if (!connections.length) {
      // Fall back to native fudrouter instead of hard-failing empty race pool
      console.log(`[Failover] No race pool for ${provider} → passthrough ${BACKEND}`);
      const target = new URL(BACKEND);
      const options = {
        hostname: target.hostname,
        port: target.port || 80,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(JSON.stringify(body)),
          Authorization: req.headers.authorization || "",
          "User-Agent": req.headers["user-agent"] || "fudrouter-failover/1.1",
        },
      };
      const proxyReq = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, {
          ...proxyRes.headers,
          "X-Failover-Mode": "passthrough-fallback",
        });
        proxyRes.pipe(res);
      });
      proxyReq.on("error", (err) => {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });
      proxyReq.write(JSON.stringify(body));
      proxyReq.end();
      return;
    }

    console.log(`[Failover] Racing ${connections.length} connections for ${provider}`);
    const result = await raceConnections(connections, body, {
      "user-agent": req.headers["user-agent"] || "fudrouter-failover/1.1",
    });
    const elapsed = Date.now() - start;
    console.log(
      `[Failover] Won: ${result.connectionId} (${elapsed}ms${result.isStream ? " SSE" : ""})`
    );

    res.writeHead(result.statusCode, {
      ...result.headers,
      "X-Failover-Connection": result.connectionId,
      "X-Failover-Time": `${elapsed}ms`,
      "X-Failover-Raced": String(connections.length),
      "X-Failover-Mode": "race",
    });

    if (result.isStream) {
      result.res.pipe(res);
      result.res.on("error", () => res.end());
    } else {
      const out = [];
      result.res.on("data", (c) => out.push(c));
      result.res.on("end", () => res.end(Buffer.concat(out)));
      result.res.on("error", () => res.end());
    }
  } catch (err) {
    const elapsed = Date.now() - start;
    console.error(`[Failover] Failed (${elapsed}ms): ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "All connections failed",
          message: err.message,
          fudrouter_failover: true,
        })
      );
    }
  }
}

function handleHealth(_req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      status: "ok",
      mode: MODE,
      backend: BACKEND,
      uptime: process.uptime(),
      timestamp: Date.now(),
    })
  );
}

function handleStatus(_req, res) {
  try {
    const database = getDB();
    const connections = database
      .prepare(
        `SELECT id, provider, name, priority, isActive, base_url
         FROM providerConnections
         ORDER BY provider, priority`
      )
      .all();
    const enriched = connections.map((c) => {
      const tracker = rateLimitTracker.get(c.id);
      return {
        ...c,
        failoverStatus: tracker?.status || "active",
        failures: tracker?.failures || 0,
        disabledMs: tracker?.disabledUntil
          ? Math.max(0, tracker.disabledUntil - Date.now())
          : 0,
      };
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ mode: MODE, backend: BACKEND, connections: enriched }, null, 2));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/_failover_health" && req.method === "GET") return handleHealth(req, res);
  if (req.url === "/_failover_status" && req.method === "GET") return handleStatus(req, res);

  if (MODE === "race" && req.url === "/v1/chat/completions" && req.method === "POST") {
    return handleRaceChat(req, res);
  }

  // Default: transparent passthrough to native fudrouter
  return proxyToBackend(req, res);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));

setInterval(() => {
  const now = Date.now();
  for (const [id, tracker] of rateLimitTracker.entries()) {
    if (tracker.disabledUntil && tracker.disabledUntil <= now) {
      tracker.disabledUntil = null;
      tracker.status = "active";
      console.log(`[Failover] ${id} re-enabled`);
    }
  }
}, 5000).unref?.();

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[Failover] listening :${PORT}`);
  console.log(`[Failover] mode=${MODE} backend=${BACKEND}`);
  console.log(`[Failover] db=${DB_PATH}`);
});
