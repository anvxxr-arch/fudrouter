#!/usr/bin/env python3
"""Rewrite per-file `$lib/ui/X.svelte` imports into a single barrel import.

    import Badge from '$lib/ui/Badge.svelte';
    import Button from '$lib/ui/Button.svelte';
    ->
    import { Badge, Button } from '$lib/ui';

Idempotent: a file that already imports from the barrel is left alone.
"""
import re
import sys
from pathlib import Path

ROOT = Path("/home/dwizzy/fudrouter/apps/web/src")
IMPORT = re.compile(r"^\s*import\s+([A-Za-z][A-Za-z0-9]*)\s+from\s+'\$lib/ui/([A-Za-z0-9]+)\.svelte';\s*$")

changed = []
for path in sorted(ROOT.rglob("*")):
    if path.suffix not in (".svelte", ".ts") or not path.is_file():
        continue
    lines = path.read_text().split("\n")
    hits = [(i, m) for i, line in enumerate(lines) if (m := IMPORT.match(line))]
    if not hits:
        continue

    names = [m.group(1) for _, m in hits]
    # Guard: the named import must match the file it came from, or the barrel
    # would silently bind the wrong component.
    for (_, m), name in zip(hits, names):
        assert m.group(2) == name, f"{path}: import {name} from {m.group(2)}.svelte"

    first = hits[0][0]
    for i, _ in reversed(hits):
        del lines[i]
    joined = ", ".join(sorted(names))
    one = f"import {{ {joined} }} from '$lib/ui';"
    if len(one) > 100:
        body = "".join(f"\t{n},\n" for n in sorted(names))
        one = f"import {{\n{body}}} from '$lib/ui';"
    lines.insert(first, one)
    path.write_text("\n".join(lines))
    changed.append(f"{path.relative_to(ROOT)} ({len(names)})")

print(f"{len(changed)} file(s) rewritten:")
for c in changed:
    print(f"  {c}")
if not changed:
    sys.exit(0)
