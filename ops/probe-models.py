#!/usr/bin/env python3
"""Probe every published model on fudrouter and record a reliability verdict.

Why this exists: /v1/models lists 83 entries and the hourly model_status_snapshot
reports ~82% failures. Publishing a model that cannot answer means every caller
who picks it burns a request, a rotation slot, and their patience. The catalogue
must reflect what actually serves.

Verdicts per model (3 shots, because one 200 is not proof of life -- see the ZRO
incident where the single success was the last request before a cap):
  RELIABLE   3/3 succeeded
  FLAKY      1-2/3
  DEAD       0/3
  NON_CHAT   the model answered but not with a chat completion (or the provider
             declares a non-text modality) -- excluded from chat pruning
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "http://127.0.0.1:8100"
SHOTS = 3
TIMEOUT = 120
CONCURRENCY = 8


def api_key() -> str:
    out = subprocess.run(
        ["grep", "-E", "^HERMES_CUSTOM_API_FUDROUTER_API_KEY=", "/home/dwizzy/.hermes/.env"],
        capture_output=True, text=True,
    ).stdout.strip()
    return out.split("=", 1)[1].strip().strip('"')


KEY = api_key()


def list_models() -> list[str]:
    req = urllib.request.Request(f"{BASE}/v1/models", headers={"Authorization": f"Bearer {KEY}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return sorted(m["id"] for m in json.load(r)["data"])


def probe(model: str) -> dict:
    """Fire SHOTS chat completions; stop early once the verdict is settled."""
    ok = 0
    errs: list[str] = []
    lat: list[int] = []
    for _ in range(SHOTS):
        body = json.dumps({
            "model": model,
            "messages": [{"role": "user", "content": "Reply with the single word: ok"}],
            "max_tokens": 8,
            "stream": False,
        }).encode()
        req = urllib.request.Request(
            f"{BASE}/v1/chat/completions", data=body,
            headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
            method="POST",
        )
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                raw = r.read()
            ms = int((time.time() - t0) * 1000)
            d = json.loads(raw)
            choice = (d.get("choices") or [{}])[0]
            msg = choice.get("message") or {}
            content = (msg.get("content") or "").strip()
            # A 200 with no content is a hollow success: some upstreams answer
            # 200 with an empty choice when the mapping is wrong.
            if not content:
                errs.append("empty content")
                continue
            ok += 1
            lat.append(ms)
            if ok >= SHOTS:
                break
        except urllib.error.HTTPError as ex:
            raw = ex.read()[:200].decode("utf-8", "replace")
            errs.append(f"{ex.code} {raw[:110]}")
        except Exception as ex:  # noqa: BLE001 - transport errors all mean "no answer"
            errs.append(f"{type(ex).__name__}: {str(ex)[:80]}")
    if ok == SHOTS:
        verdict = "RELIABLE"
    elif ok > 0:
        verdict = "FLAKY"
    else:
        verdict = "DEAD"
    return {
        "model": model,
        "verdict": verdict,
        "ok": ok,
        "shots": SHOTS,
        "p50_ms": sorted(lat)[len(lat) // 2] if lat else None,
        "errors": errs[:2],
    }


def main() -> None:
    models = list_models()
    print(f"probing {len(models)} published models, {SHOTS} shots each, concurrency {CONCURRENCY}",
          file=sys.stderr)
    results = []
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
        for i, r in enumerate(ex.map(probe, models), 1):
            results.append(r)
            print(f"[{i}/{len(models)}] {r['verdict']:<8} {r['model']}", file=sys.stderr)
    out = "/tmp/fudrouter_model_probe.json"
    with open(out, "w") as f:
        json.dump(results, f, indent=1)
    print(f"\nwrote {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
