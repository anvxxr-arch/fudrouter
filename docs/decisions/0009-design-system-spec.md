# ADR-0009: a top-level `design-system/` for the authoritative UI spec

- **Status:** APPROVED
- **Date:** 2026-11-10
- **Deciders:** tech lead (fudrouter hackathon hardening)

## Context

The green Tailwind/shadcn migration (branch `migration/green-tailwind`) makes
`design-system/fudrouter/MASTER.md` the single source of truth for visual design:
the endpoint-green token palette, typography, spacing, motion, and component
specs. It is read by `DESIGN.md`, `apps/web/src/index.css`, and the frontend team
during page work — a first-class spec, not documentation of an implementation.

## Decision

`design-system/` becomes an allowlisted top-level directory. `design-system/fudrouter/`
holds the MASTER design spec plus per-page override documents (`design-system/pages/*.md`)
that the MASTER.md logic resolves at build time.

This is registered in `ops/verify/structure.sh` exactly like the other top-level
dirs, so the layout gate keeps its teeth: an un-allowlisted entry still fails.

## Consequences

- The spec lives beside the code it governs and survives a repo checkout, rather
  than living as an orphaned working-tree copy.
- A second design-system implementation must not appear; this is the one place.
