import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, formatMs } from "../lib/api";
import type { RunMetrics } from "../lib/api";
import { compareChunk, type CompareFrame } from "../lib/compare-frame";
import { ConsoleLayout } from "../components/ConsoleLayout";
import { Button } from "../components/ui/button";
import "./playground.css";

// Rebuilt playground: the server already streams the full run (SSE data
// frames plus one trailing `event: metrics` frame) and this page finally
// reads all of it. The old free-text slug input is gone — the model list
// comes from the pricing catalog so only routable slugs can be picked.
// Compare mode fans the same prompt out to 2–3 models through
// /api/playground/compare and renders the columns side by side.

type PricingModel = { slug: string; name: string; context: number | null };
type PricingGroup = { developer: string; models: PricingModel[] };

// fmtMicro is dashboard.tsx's formatter, copied here because that module is
// owned by another worker this session and exports nothing to reuse.
function fmtMicro(v: string | null | undefined) {
  if (v === null || v === undefined) return "—";
  try {
    const micro = BigInt(v);
    const sign = micro < 0n ? "-" : "";
    const abs = micro < 0n ? -micro : micro;
    return `${sign}$${(Number(abs) / 1_000_000).toFixed(2)}`;
  } catch {
    return String(v);
  }
}

// SSE arrives in arbitrary TCP chunks, so a `data:` line (or the metrics
// frame) can be split mid-frame. Buffer the raw text, dispatch only complete
// lines, and keep the trailing partial line for the next chunk.
function createFrameSink(onData: (payload: string) => void, onMetrics: (payload: string) => void) {
  let buffer = "";
  let event = "";
  let data: string[] = [];
  const dispatch = () => {
    if (data.length > 0) {
      const payload = data.join("\n");
      if (event === "metrics") onMetrics(payload);
      else onData(payload);
    }
    event = "";
    data = [];
  };
  const line = (raw: string) => {
    if (raw === "") { dispatch(); return; }
    if (raw.startsWith(":")) return;
    if (raw.startsWith("event:")) { event = raw.slice(6).trim(); return; }
    if (raw.startsWith("data:")) data.push(raw.slice(5).replace(/^ /, ""));
  };
  return {
    feed(text: string) {
      buffer += text;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) line(part);
    },
    end() {
      if (buffer !== "") line(buffer);
      buffer = "";
      dispatch();
    },
  };
}

type DeltaFrame = { choices?: { delta?: { content?: unknown } }[] };

// One compare column: the streamed text plus the metrics frame attributed to
// its model. `error` carries a failed run's message so the column shows why
// it is empty instead of silently blank.
type CompareRun = {
  model: string;
  output: string;
  metrics: RunMetrics | null;
  error: string | null;
  done: boolean;
};

export function PlaygroundPage2() {
  const { projectId } = useParams();
  const pid = projectId ?? "";
  const [groups, setGroups] = useState<PricingGroup[] | null>(null);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [system, setSystem] = useState("");
  const [prompt, setPrompt] = useState("");
  const [temperature, setTemperature] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [jsonMode, setJsonMode] = useState(false);
  const [output, setOutput] = useState("");
  const [metrics, setMetrics] = useState<RunMetrics | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [compare, setCompare] = useState(false);
  const [compareModels, setCompareModels] = useState<string[]>([]);
  const [runs, setRuns] = useState<CompareRun[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let live = true;
    api.pricing().then((d) => {
      if (!live) return;
      if (!d) {
        setPricingError("The model list could not be loaded — reload to try again.");
        return;
      }
      setGroups(d.groups);
      const first = d.groups.flatMap((g) => g.models)[0];
      if (first) setModel((cur) => cur || first.slug);
    });
    return () => { live = false; };
  }, []);

  // Compare defaults to the current model plus the first other one, so the
  // toggle-on state is always a valid 2-model run without extra clicks.
  useEffect(() => {
    if (!compare || groups === null) return;
    setCompareModels((cur) => {
      if (cur.length >= 2) return cur;
      const all = groups.flatMap((g) => g.models.map((m) => m.slug));
      const first = cur[0] ?? model;
      const other = all.find((s) => s !== first) ?? all[1] ?? "";
      return other ? [first, other] : [first];
    });
  }, [compare, groups, model]);

  // Rough input-size hint only: chars/4 over both prompts. The real cost is
  // unknown until the run finishes, so no dollar figure is shown here.
  const estimate = useMemo(() => Math.ceil((system.length + prompt.length) / 4), [system, prompt]);
  const canRun = !busy && !pricingError && groups !== null && model !== "" && prompt.trim() !== "";
  const canRunCompare = !busy && !pricingError && groups !== null && compareModels.filter(Boolean).length >= 2 && prompt.trim() !== "";

  function setCompareAt(index: number, slug: string) {
    setCompareModels((cur) => {
      const next = [...cur];
      next[index] = slug;
      return next;
    });
  }

  async function run() {
    if (compare ? !canRunCompare : !canRun) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    setOutput("");
    setMetrics(null);
    setRuns(null);
    const models = compare ? compareModels.filter(Boolean) : null;
    if (compare) {
      setRuns(models!.map((m) => ({ model: m, output: "", metrics: null, error: null, done: false })));
    }
    let text = "";
    const sink = createFrameSink(
      (payload) => {
        if (payload === "[DONE]") return;
        try {
          const frame = JSON.parse(payload) as DeltaFrame;
          const delta = frame.choices?.[0]?.delta?.content;
          if (typeof delta === "string") {
            text += delta;
            setOutput(text);
          }
        } catch { /* a non-JSON data line carries no text */ }
      },
      (payload) => {
        try {
          setMetrics(JSON.parse(payload) as RunMetrics);
        } catch { /* a malformed metrics frame leaves the header blank */ }
      },
    );
    // Compare sink: every frame carries its model, so one reader fans frames
    // out to the matching column.
    const compareSink = createFrameSink(
      (payload) => {
        const hit = compareChunk(payload);
        if (!hit) return;
        setRuns((cur) => cur?.map((r) => (r.model === hit.model ? { ...r, output: r.output + hit.delta } : r)) ?? cur);
      },
      (payload) => {
        try {
          const frame = JSON.parse(payload) as CompareFrame;
          const model = frame.model ?? "";
          const { model: _m, chunk: _c, ...metrics } = frame as CompareFrame & Partial<RunMetrics>;
          setRuns((cur) =>
            cur?.map((r) =>
              r.model === model
                ? {
                    ...r,
                    metrics: metrics as RunMetrics,
                    error: frame.error?.message ?? null,
                    done: true,
                  }
                : r
            ) ?? cur
          );
        } catch { /* a malformed metrics frame leaves the column blank */ }
      },
    );
    try {
      const body: Record<string, unknown> = {
        projectId: pid,
        messages: [{ role: "user", content: prompt }],
      };
      if (compare) body.models = models;
      else body.model = model;
      if (system.trim() !== "") body.system = system;
      if (temperature !== "") body.temperature = Number(temperature);
      if (maxTokens !== "") body.maxTokens = Number(maxTokens);
      if (jsonMode) body.jsonMode = true;
      const res = await fetch(compare ? "/api/playground/compare" : "/api/playground/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const failed = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
        setError(failed?.error?.message ?? `The run failed to start (${res.status}).`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const activeSink = compare ? compareSink : sink;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        activeSink.feed(decoder.decode(value, { stream: true }));
      }
      activeSink.end();
      if (compare) setRuns((cur) => cur?.map((r) => ({ ...r, done: true })) ?? cur);
    } catch (e) {
      // Abort is user intent, not a failure — the server reclaims the run key.
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message.slice(0, 500) : "The stream failed.");
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function clear() {
    setPrompt("");
    setOutput("");
    setMetrics(null);
    setRuns(null);
    setError(null);
  }

  async function copy() {
    if (!output) return;
    try {
      // navigator.clipboard is undefined over plain HTTP on the LAN, so fall
      // back to a transient textarea like CodeBlock does.
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(output);
      } else {
        const ta = document.createElement("textarea");
        ta.value = output;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  // Fastest/cheapest come from the metrics frames only — a run without its
  // metrics frame (still streaming, or failed) is never a winner.
  const fastest = useMemo(() => {
    const done = (runs ?? []).filter((r) => r.metrics?.latencyMs != null);
    if (done.length < 2) return null;
    return done.reduce((a, b) => ((b.metrics?.latencyMs ?? Infinity) < (a.metrics?.latencyMs ?? Infinity) ? b : a)).model;
  }, [runs]);
  const cheapest = useMemo(() => {
    const done = (runs ?? []).filter((r) => r.metrics?.costMicro != null);
    if (done.length < 2) return null;
    return done.reduce((a, b) => (BigInt(b.metrics!.costMicro!) < BigInt(a.metrics!.costMicro!) ? b : a)).model;
  }, [runs]);

  // A finished run where every column errored is a failure, not a success:
  // the old badge read "complete" + green for a run where nothing streamed.
  const allDone = runs?.length ? runs.every((r) => r.done) : false;
  const allFailed = allDone && (runs ?? []).every((r) => r.error);

  return (<ConsoleLayout>
    <nav className="row" style={{ flexWrap: "wrap" }} aria-label="Project">
      <Link to={"/dashboard/projects/" + pid}><Button variant="ghost" size="sm">Overview</Button></Link>
      <Link to={"/dashboard/projects/" + pid + "/keys"}><Button variant="ghost" size="sm">Keys</Button></Link>
      <Link to={"/dashboard/projects/" + pid + "/limits"}><Button variant="ghost" size="sm">Limits</Button></Link>
      <Link to={"/dashboard/projects/" + pid + "/routing"}><Button variant="ghost" size="sm">Routing</Button></Link>
      <Link to={"/dashboard/projects/" + pid + "/requests"}><Button variant="ghost" size="sm">Requests</Button></Link>
      <Link to={"/dashboard/projects/" + pid + "/playground"}><Button variant="ghost" size="sm">Playground</Button></Link>
      <Link to={"/dashboard/projects/" + pid + "/settings"}><Button variant="ghost" size="sm">Settings</Button></Link>
    </nav>
    <div className="stack">
      <div>
        <h1>Playground</h1>
        <p className="lede muted">Run a streamed completion against the live router.</p>
      </div>
      <div className="pg-panels">
        <section className="card pg-panel" aria-label="Request">
          <label className="pg-inline">
            <input
              type="checkbox"
              checked={compare}
              onChange={(e) => setCompare(e.target.checked)}
              disabled={busy}
            />
            Compare models
          </label>
          {compare ? (
            <div className="pg-picks">
              {compareModels.map((slug, i) => (
                <label className="pg-field" key={i}>
                  <span>Model {i + 1}</span>
                  <select
                    className="select"
                    value={slug}
                    onChange={(e) => setCompareAt(i, e.target.value)}
                    disabled={busy || groups === null}
                    aria-label={`Compare model ${i + 1}`}
                  >
                    {groups === null ? <option value="">Loading models…</option> : null}
                    {(groups ?? []).map((g) => (
                      <optgroup key={g.developer} label={g.developer}>
                        {g.models.map((m) => (
                          <option key={m.slug} value={m.slug}>
                            {m.name !== m.slug ? `${m.name} (${m.slug})` : m.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
              ))}
              {compareModels.length < 3 ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy || groups === null}
                  onClick={() => setCompareModels((cur) => [...cur, ""])}
                >
                  Add model
                </Button>
              ) : null}
            </div>
          ) : (
            <label className="pg-field">
              <span>Model</span>
              <select
                className="select"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={busy || groups === null}
                aria-label="Model"
              >
                {groups === null ? <option value="">Loading models…</option> : null}
                {(groups ?? []).map((g) => (
                  <optgroup key={g.developer} label={g.developer}>
                    {g.models.map((m) => (
                      <option key={m.slug} value={m.slug}>
                        {m.name !== m.slug ? `${m.name} (${m.slug})` : m.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          )}
          {pricingError ? <p className="error" role="alert">{pricingError}</p> : null}
          <details className="pg-details">
            <summary>System prompt</summary>
            <textarea
              className="pg-textarea pg-textarea--system"
              value={system}
              onChange={(e) => setSystem(e.target.value)}
              placeholder="Optional instructions for the model…"
              aria-label="System prompt"
            />
          </details>
          <label className="pg-field">
            <span>Prompt</span>
            <textarea
              className="pg-textarea"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ask anything…"
              aria-label="Prompt"
            />
          </label>
          <details className="pg-details">
            <summary>Advanced</summary>
            <div className="pg-details-body">
              <label className="pg-field">
                <span>Temperature (0–2)</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={temperature}
                  onChange={(e) => setTemperature(e.target.value)}
                  placeholder="Model default"
                  aria-label="Temperature"
                />
              </label>
              <label className="pg-field">
                <span>Max tokens</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  step={1}
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(e.target.value)}
                  placeholder="Model default"
                  aria-label="Max tokens"
                />
              </label>
              <label className="pg-inline">
                <input
                  type="checkbox"
                  checked={jsonMode}
                  onChange={(e) => setJsonMode(e.target.checked)}
                />
                JSON mode
              </label>
            </div>
          </details>
          <p className="pg-estimate">~{estimate.toLocaleString("en-US")} tokens (estimate)</p>
          <div className="pg-actions">
            <Button type="button" onClick={() => void run()} disabled={compare ? !canRunCompare : !canRun}>{busy ? "Running…" : "Run"}</Button>
            {busy ? <Button type="button" variant="secondary" onClick={stop}>Stop</Button> : null}
            <Button type="button" variant="secondary" onClick={clear} disabled={busy}>Clear</Button>
          </div>
          {error ? <p className="error" role="alert">{error}</p> : null}
        </section>
        {compare ? (
          <section className="card pg-panel" aria-label="Comparison" aria-live="polite">
            <div className="pg-response-head">
              <h2 className="card-title">Comparison</h2>
              <span className={`badge ${busy ? "badge-info" : allDone && !allFailed ? "badge-ok" : ""}`}>
                {busy ? "streaming" : allFailed ? "failed" : allDone ? "complete" : runs?.length ? "streaming" : "idle"}
              </span>
            </div>
            <div className="pg-compare-grid" style={{ "--pg-cols": compareModels.length } as React.CSSProperties}>
              {(runs ?? compareModels.map((m) => ({ model: m, output: "", metrics: null, error: null, done: false }))).map((r) => (
                <div className={`pg-compare-col${r.model === fastest ? " pg-fast" : ""}${r.model === cheapest ? " pg-cheap" : ""}`} key={r.model}>
                  <div className="pg-response-head">
                    <h3 className="card-title">{r.model}</h3>
                    {r.model === fastest ? <span className="badge badge-ok">fastest</span> : null}
                    {r.model === cheapest ? <span className="badge badge-info">cheapest</span> : null}
                  </div>
                  {r.error ? <p className="error" role="alert">{r.error}</p> : null}
                  {r.output ? <pre className="pg-output pg-output--col">{r.output}</pre> : (
                    <p className="pg-empty">{r.done ? "No output." : busy ? "Generating…" : "Idle."}</p>
                  )}
                </div>
              ))}
            </div>
            {runs?.some((r) => r.metrics) ? (
              <div className="table-wrap">
                <table className="fr">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Latency</th>
                      <th>Tokens in / out</th>
                      <th>Cost</th>
                      <th>Finish</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr key={r.model}>
                        <td>{r.model}</td>
                        <td className="num">{formatMs(r.metrics?.latencyMs ?? null)}</td>
                        <td className="num">{r.metrics ? `${r.metrics.tokensIn ?? "—"} / ${r.metrics.tokensOut ?? "—"}` : "—"}</td>
                        <td className="num">{fmtMicro(r.metrics?.costMicro)}</td>
                        <td>{r.metrics?.status ?? r.error ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        ) : (
        <section className="card pg-panel" aria-label="Response" aria-live="polite">
          <div className="pg-response-head">
            <h2 className="card-title">Response</h2>
            <span className={`badge ${busy ? "badge-info" : metrics ? "badge-ok" : ""}`}>
              {busy ? "streaming" : metrics ? "complete" : "idle"}
            </span>
          </div>
          <dl className="pg-metrics">
            <div><dt>Model</dt><dd className="num">{metrics?.actualModel ?? (busy ? model : "—")}</dd></div>
            <div><dt>Provider</dt><dd>{metrics?.provider ?? "—"}</dd></div>
            <div><dt>Tokens in / out</dt><dd className="num">{metrics ? `${metrics.tokensIn ?? "—"} / ${metrics.tokensOut ?? "—"}` : "—"}</dd></div>
            <div><dt>TTFT</dt><dd className="num">{formatMs(metrics?.ttftMs ?? null)}</dd></div>
            <div><dt>Latency</dt><dd className="num">{formatMs(metrics?.latencyMs ?? null)}</dd></div>
            <div><dt>Cost</dt><dd className="num">{fmtMicro(metrics?.costMicro)}</dd></div>
            <div><dt>Attempts</dt><dd className="num">{metrics?.attempts ?? "—"}</dd></div>
            <div><dt>Fallback</dt><dd>{metrics?.fallback == null ? "—" : metrics.fallback ? "yes" : "no"}</dd></div>
          </dl>
          {busy ? <p className="pg-generating" role="status">Generating…</p> : null}
          {output ? (
            <>
              <pre className="pg-output">{output}</pre>
              <div className="pg-actions">
                <Button type="button" variant="secondary" size="sm" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</Button>
              </div>
            </>
          ) : !busy && !metrics ? (
            <p className="pg-empty">A run uses the workspace key and appears in the request log.</p>
          ) : null}
        </section>
        )}
      </div>
    </div>
  </ConsoleLayout>);
}
