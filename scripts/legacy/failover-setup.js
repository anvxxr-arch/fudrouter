#!/usr/bin/env node
/**
 * fudrouter multi-connection failover setup
 * All files stay under /home/dwizzy/fudrouter-app
 *
 * What this does:
 * 1. Ensures DB columns for optional race proxy
 * 2. Enables NATIVE zero-delay failover settings:
 *      fallbackStrategy=fill-first
 *      stickyRoundRobinLimit=1
 * 3. Keeps MITM on native fudrouter :20128 (recommended)
 * 4. Installs optional race proxy on :20126 in passthrough mode
 *
 * Usage:
 *   node scripts/failover-setup.js
 *   node scripts/failover-setup.js --race   # optional parallel race mode
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), ".fudrouter");
const DB_PATH = path.join(DATA_DIR, "db", "data.sqlite");
const WANT_RACE = process.argv.includes("--race");

function log(msg) {
  console.log(`[Setup] ${msg}`);
}

function openDb() {
  try {
    const { DatabaseSync } = require("node:sqlite");
    return new DatabaseSync(DB_PATH);
  } catch {
    const Database = require("better-sqlite3");
    return new Database(DB_PATH);
  }
}

function migrateDatabase() {
  log(`DB: ${DB_PATH}`);
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`DB not found: ${DB_PATH}`);
  }

  const db = openDb();
  const columns = db.prepare("PRAGMA table_info(providerConnections)").all();
  const colNames = columns.map((c) => c.name);

  if (!colNames.includes("base_url")) {
    log("Adding base_url column...");
    db.exec("ALTER TABLE providerConnections ADD COLUMN base_url TEXT");
  }
  if (!colNames.includes("api_key")) {
    log("Adding api_key column...");
    db.exec("ALTER TABLE providerConnections ADD COLUMN api_key TEXT");
  }

  // Flatten known fields from JSON data blob when present
  const rows = db.prepare("SELECT id, data FROM providerConnections").all();
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data || "{}");
      const baseUrl = data.baseUrl || data.base_url || data.endpoint || null;
      const apiKey = data.apiKey || data.api_key || data.accessToken || data.token || null;
      if (baseUrl || apiKey) {
        db.prepare(
          "UPDATE providerConnections SET base_url = COALESCE(?, base_url), api_key = COALESCE(?, api_key) WHERE id = ?"
        ).run(baseUrl, apiKey, row.id);
      }
    } catch {}
  }

  const defaults = {
    openai: "https://api.openai.com",
    anthropic: "https://api.anthropic.com",
    google: "https://generativelanguage.googleapis.com/v1beta",
    deepseek: "https://api.deepseek.com",
    xai: "https://api.x.ai",
    qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    moonshot: "https://api.moonshot.cn",
    zhipu: "https://open.bigmodel.cn/api/paas/v4",
    ollama: "http://127.0.0.1:11434/v1",
    mistral: "https://api.mistral.ai",
  };
  for (const [provider, url] of Object.entries(defaults)) {
    db.prepare(
      "UPDATE providerConnections SET base_url = ? WHERE provider = ? AND (base_url IS NULL OR base_url = '')"
    ).run(url, provider);
  }

  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_pc_failover ON providerConnections(provider, isActive, priority)"
  );

  // Native zero-delay multi-account failover
  const settingsRow = db.prepare("SELECT data FROM settings WHERE id = 1").get();
  const settings = settingsRow ? JSON.parse(settingsRow.data || "{}") : {};
  settings.fallbackStrategy = "fill-first";
  settings.stickyRoundRobinLimit = 1;
  settings.comboStrategy = "fill-first";
  settings.comboStickyRoundRobinLimit = 1;

  const ps = settings.providerStrategies || {};
  for (const provider of [
    "openai",
    "anthropic",
    "google",
    "deepseek",
    "xai",
    "openrouter",
    "oc",
    "claude",
    "codex",
    "grok-cli",
  ]) {
    ps[provider] = {
      fallbackStrategy: ps[provider]?.fallbackStrategy || "fill-first",
      stickyRoundRobinLimit: ps[provider]?.stickyRoundRobinLimit || 1,
      ...(ps[provider] || {}),
    };
    // force sticky=1 for snappy rotate after error
    ps[provider].stickyRoundRobinLimit = 1;
  }
  // keep grok-cli round-robin if user already chose it
  if (!ps["grok-cli"]?.fallbackStrategy) ps["grok-cli"].fallbackStrategy = "round-robin";
  settings.providerStrategies = ps;

  db.prepare("UPDATE settings SET data = ? WHERE id = 1").run(JSON.stringify(settings));
  log("Native settings: fallbackStrategy=fill-first, stickyRoundRobinLimit=1");

  const count = db.prepare("SELECT COUNT(*) AS c FROM providerConnections").get().c;
  const active = db
    .prepare("SELECT COUNT(*) AS c FROM providerConnections WHERE isActive = 1")
    .get().c;
  log(`Connections total=${count} active=${active}`);
}

function writeEnv(mode) {
  const envPath = path.join(__dirname, ".env-failover");
  const content = [
    `# fudrouter failover env (inside fudrouter-app/scripts)`,
    `FAILOVER_PORT=20126`,
    `FAILOVER_MODE=${mode}`,
    `FAILOVER_BACKEND=http://127.0.0.1:20128`,
    `DATA_DIR=${DATA_DIR}`,
    `FAILOVER_DB_PATH=${DB_PATH}`,
    `# Keep MITM on native fudrouter unless you intentionally enable race interception`,
    `MITM_ROUTER_BASE=http://127.0.0.1:20128`,
    "",
  ].join("\n");
  fs.writeFileSync(envPath, content);
  log(`Wrote ${envPath}`);
}

function installPm2(mode) {
  const script = path.join(__dirname, "failover-proxy.js");
  const env = {
    ...process.env,
    FAILOVER_PORT: "20126",
    FAILOVER_MODE: mode,
    FAILOVER_BACKEND: "http://127.0.0.1:20128",
    DATA_DIR,
    FAILOVER_DB_PATH: DB_PATH,
  };

  try {
    const list = JSON.parse(execSync("pm2 jlist", { encoding: "utf8" }));
    if (list.find((p) => p.name === "fudrouter-failover")) {
      log("Deleting existing fudrouter-failover...");
      execSync("pm2 delete fudrouter-failover", { stdio: "ignore" });
    }
  } catch {}

  execSync(`pm2 start ${JSON.stringify(script)} --name fudrouter-failover --update-env`, {
    stdio: "inherit",
    env,
    cwd: ROOT,
  });
  execSync("pm2 save", { stdio: "ignore" });
  log("PM2 fudrouter-failover installed");
}

function wireNprouterNative() {
  // Ensure MITM hits native fudrouter (not empty race proxy)
  try {
    // Remove previous bad redirect if present
    execSync("pm2 set fudrouter:env:MITM_ROUTER_BASE http://127.0.0.1:20128", {
      stdio: "ignore",
    });
  } catch {}

  // Restart fudrouter so settings reload and MITM base is correct
  try {
    execSync("pm2 restart fudrouter --update-env", { stdio: "inherit" });
    log("Restarted fudrouter on native path :20128");
  } catch (err) {
    log(`WARN restart fudrouter failed: ${err.message}`);
  }
}

function verify(mode) {
  log("Verifying...");
  try {
    const health = execSync("curl -s http://127.0.0.1:20126/_failover_health", {
      encoding: "utf8",
    });
    log(`failover health: ${health}`);
  } catch {
    log("WARN: failover health check failed");
  }
  try {
    const status = execSync("curl -s http://127.0.0.1:20126/_failover_status", {
      encoding: "utf8",
    });
    log(`failover status: ${status.slice(0, 300)}`);
  } catch {
    log("WARN: failover status failed");
  }
  try {
    const code = execSync(
      "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:20128/api/health",
      { encoding: "utf8" }
    );
    log(`fudrouter health HTTP ${code}`);
  } catch {
    log("WARN: fudrouter health failed");
  }
  log(`mode=${mode}`);
}

function main() {
  console.log("=== fudrouter multi-connection failover setup ===\n");
  const mode = WANT_RACE ? "race" : "passthrough";
  migrateDatabase();
  writeEnv(mode);
  installPm2(mode);
  wireNprouterNative();
  // small wait for listen
  try {
    execSync("sleep 1");
  } catch {}
  verify(mode);

  console.log("\n=== Done ===");
  console.log("Native behavior (always on):");
  console.log("  fill-first → key A 429/401/5xx → instant next key B (no sleep)");
  console.log("  stickyRoundRobinLimit=1");
  console.log("\nAdd multiple connections per provider in dashboard:");
  console.log("  priority 0 = primary, 1 = backup, 2 = tertiary...");
  console.log("\nOptional race mode (parallel, burns loser quota):");
  console.log("  node scripts/failover-setup.js --race");
  console.log("\nStatus:");
  console.log("  curl http://127.0.0.1:20126/_failover_status");
  console.log("  curl http://127.0.0.1:20126/_failover_health");
}

main();
