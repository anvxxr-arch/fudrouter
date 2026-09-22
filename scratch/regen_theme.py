#!/usr/bin/env python3
"""Regenerate apps/web/src/lib/design/theme.tailwind.css from /DESIGN.md.

The @google/design.md exporter can only emit the *floor* of a fluid heading,
because the spec frontmatter accepts static dimensions only (px/em/rem) — a
`clamp()` is rejected as "not a valid dimension". But `@theme` is CSS, where a
clamp() is perfectly valid. So this wraps the export and re-injects the fluid
expressions documented in DESIGN.md's typography table.

Run from the repo root:  python3 scratch/regen_theme.py
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / "DESIGN.md"
OUT = ROOT / "apps/web/src/lib/design/theme.tailwind.css"

# scale name -> clamp expression, read straight from the spec's fluid table so
# the two can never disagree.
spec = SPEC.read_text()
fluid = dict(
    re.findall(
        r"^\|\s*`([a-z0-9-]+)`\s*\|\s*[^|]+?\s*\|\s*`(clamp\([^`]+\))`\s*\|",
        spec,
        re.M,
    )
)
if not fluid:
    sys.exit("no fluid-heading table found in DESIGN.md")

exported = subprocess.run(
    ["npx", "-y", "@google/design.md", "export", "--format", "css-tailwind", str(SPEC)],
    capture_output=True,
    text=True,
    check=True,
).stdout

# 2-space export -> tabs, to match the rest of the design system.
body = re.sub(r"^  ", "\t", exported, flags=re.M).rstrip()

# Swap each fluid heading's floor for its real clamp().
for name, expr in fluid.items():
    body, n = re.subn(
        rf"^(\t--text-{re.escape(name)}:\s*)[^;]+;",
        rf"\g<1>{expr};",
        body,
        flags=re.M,
    )
    if n != 1:
        sys.exit(f"expected 1 --text-{name} line in the export, patched {n}")

header = """/*
 * Tailwind v4 @theme mirror of /DESIGN.md.
 *
 * Generated — never hand-edit. Regenerate after editing DESIGN.md:
 *   python3 scratch/regen_theme.py
 *
 * That script runs the official exporter and then re-injects the `clamp()`
 * expressions for the fluid headings. The exporter alone cannot: the spec
 * frontmatter accepts static dimensions only (px/em/rem), so DESIGN.md records
 * each fluid heading's *floor* and carries the expression in its typography
 * table. `@theme` is CSS, so the real clamp() goes here.
 *
 * NOTE: not imported anywhere (the app's styles come from tokens.css). It is
 * kept so Tailwind utility users get the same palette and type ladder without
 * re-deriving them from the spec.
 */
"""

OUT.write_text(header + body + "\n")
print(f"wrote {OUT.relative_to(ROOT)}  ({len(fluid)} fluid headings injected)")
for name, expr in fluid.items():
    print(f"  --text-{name}: {expr}")
