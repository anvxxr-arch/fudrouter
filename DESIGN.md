---
version: alpha
name: Fudrouter
description: A dark-first developer console — precise, calm, and legible under long working sessions.
colors:
  bg: "#0B0D10"
  surface: "#14171C"
  surfaceRaised: "#1B1F26"
  border: "#2A2F37"
  borderStrong: "#3A424E"
  text: "#E6E8EB"
  textMuted: "#9BA3AF"
  primary: "#818CF8"
  primaryHover: "#A5B4FC"
  onPrimary: "#0B0D10"
  success: "#10B981"
  warning: "#F59E0B"
  danger: "#F87171"
  info: "#38BDF8"
typography:
  display-xl:
    fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif"
    fontSize: 3rem
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.03em"
  display:
    fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif"
    fontSize: 2.5rem
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  h1:
    fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif"
    fontSize: 2.25rem
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  h2:
    fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif"
    fontSize: 2rem
    fontWeight: 600
    lineHeight: 1.3
  h3:
    fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif"
    fontSize: 1.75rem
    fontWeight: 600
    lineHeight: 1.3
  h4:
    fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif"
    fontSize: 1.5rem
    fontWeight: 600
    lineHeight: 1.4
  h5:
    fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif"
    fontSize: 1.25rem
    fontWeight: 600
    lineHeight: 1.4
  h6:
    fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif"
    fontSize: 1.125rem
    fontWeight: 600
    lineHeight: 1.4
  lg:
    fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif"
    fontSize: 1.125rem
    fontWeight: 400
    lineHeight: 1.5
  base:
    fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif"
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.55
  sm:
    fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif"
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif"
    fontSize: 0.75rem
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.04em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: 0.8125rem
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "tnum"
rounded:
  sm: 4px
  md: 8px
  lg: 12px
  pill: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.onPrimary}"
    rounded: "{rounded.md}"
    padding: 10px
    height: 40px
  button-primary-hover:
    backgroundColor: "{colors.primaryHover}"
    textColor: "{colors.onPrimary}"
  button-secondary:
    backgroundColor: "{colors.surfaceRaised}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: 10px
    height: 40px
  # Outlined, not filled: a solid red button next to a solid indigo one makes two
  # things compete for "the action to take", and only one of them can win. Danger
  # states itself with its text and border instead. (This entry used to claim a
  # filled `danger` background with `onPrimary` text, which contradicted both this
  # intent and the shipped component.)
  button-danger:
    backgroundColor: "{colors.surfaceRaised}"
    textColor: "{colors.danger}"
    rounded: "{rounded.md}"
    padding: 10px
    height: 40px
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.info}"
    rounded: "{rounded.md}"
    padding: 10px
    height: 40px
  button-sm:
    backgroundColor: "{colors.surfaceRaised}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: 8px
    height: 32px
  button-lg:
    backgroundColor: "{colors.surfaceRaised}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: 24px
    height: 48px
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: 10px
    height: 40px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: 16px
  table-header:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.textMuted}"
    rounded: "{rounded.sm}"
    padding: 8px
  badge-success:
    backgroundColor: "{colors.surfaceRaised}"
    textColor: "{colors.success}"
    rounded: "{rounded.pill}"
    padding: 4px
  badge-warning:
    backgroundColor: "{colors.surfaceRaised}"
    textColor: "{colors.warning}"
    rounded: "{rounded.pill}"
    padding: 4px
  badge-danger:
    backgroundColor: "{colors.surfaceRaised}"
    textColor: "{colors.danger}"
    rounded: "{rounded.pill}"
    padding: 4px
  badge-info:
    backgroundColor: "{colors.surfaceRaised}"
    textColor: "{colors.info}"
    rounded: "{rounded.pill}"
    padding: 4px
  badge-neutral:
    backgroundColor: "{colors.surfaceRaised}"
    textColor: "{colors.textMuted}"
    rounded: "{rounded.pill}"
    padding: 4px
  divider:
    backgroundColor: "{colors.border}"
    height: 1px
  divider-strong:
    backgroundColor: "{colors.borderStrong}"
    height: 1px
---

## Overview

Fudrouter is a **commercial AI router**: one API key, many model providers. Its
console is a *developer tool*, and the interface is built for that: dark-first
to sit beside a terminal, low-chroma surfaces so status colors carry meaning,
and a single indigo accent that marks the one action worth taking on a screen.

The three audiences — **public** visitors, **members** (buyers), and **staff**
(admin) — share one token set. Only density and chrome change between them;
color, type, and spacing never fork.

## Colors

- **Primary (#818CF8):** Indigo. The *only* driver for interactive emphasis —
  primary buttons, active nav, focus rings. It is deliberately distinct from
  success, so "the thing to click" never reads as "the thing that worked".
  Chosen light enough that dark `onPrimary` text clears WCAG AA on it.
- **Success (#10B981):** Emerald. Confirming states only (`success` request
  status, healthy connections, saved confirmations).
- **Warning (#F59E0B):** Amber. Non-blocking cautions and `dev`-status providers.
- **Danger (#F87171):** Red. Destructive actions and failed states only.
- **Info (#38BDF8):** Sky. Links and neutral notices.
- **Surface ramp (`bg` → `surface` → `surfaceRaised`):** Three near-black
  steps create depth without shadows, keeping the dark theme flat and calm.
- **Text (`text` / `textMuted`):** Two steps only — full-contrast for content,
  muted for metadata. Never more than two greys in one view.
- **Border (`border` / `borderStrong`):** Row separators use `border`;
  interactive edges (inputs, hovered rows) use `borderStrong`.

## Typography

**Plus Jakarta Sans** for UI, a system monospace for code, IDs, and all numeric
tables (`fontFeature: tnum` keeps columns from jittering as values change).

The UI face is **self-hosted** as a variable font (`font-weight: 200 800`, two
subset files in `static/fonts/`) rather than loaded from a font CDN — no
third-party request, no extra DNS/TLS on first paint, and it survives the tunnel or
the CDN being unreachable. Declared in `lib/design/fonts.css`; the family is
exposed to the rest of the system as `--fr-font-ui`, and `app.html` preloads the
latin subset so the first paint is not a fallback flash.

The scale splits in two:

- **Static text** — `caption` · `sm` · `base` · `lg`. Fixed at every viewport.
  Body copy that reflows because someone resized a window is hostile to read, so
  these never scale.
- **Fluid headings** — `h6` · `h5` · `h4` · `h3` · `h2` · `h1` · `display` ·
  `display-xl`. They grow with the viewport so a headline keeps its proportion
  from phone to desktop. The two smallest (`h6`, `h5`) stay static — at 18–20px
  fluidity buys nothing.

`caption` is the only all-caps-ish treatment: small, 600 weight, wide tracking —
used for table headers, stat labels, and form labels.

**The frontmatter records each fluid heading's *floor*** — the size at the
smallest viewport. The spec format accepts only static dimensions (`px`/`em`/`rem`),
so a `clamp()` cannot live in the YAML. The full expressions are here, and
`lib/design/tokens.test.ts` asserts them against `tokens.css` — the two cannot
drift apart.

| Token | Floor | Fluid expression | Ceiling |
| --- | --- | --- | --- |
| `display-xl` | 3rem | `clamp(3rem, 2.37rem + 2.8vw, 4.75rem)` | 4.75rem |
| `display` | 2.5rem | `clamp(2.5rem, 2.05rem + 2vw, 3.75rem)` | 3.75rem |
| `h1` | 2.25rem | `clamp(2.25rem, 1.98rem + 1.2vw, 3rem)` | 3rem |
| `h2` | 2rem | `clamp(2rem, 1.82rem + 0.8vw, 2.5rem)` | 2.5rem |
| `h3` | 1.75rem | `clamp(1.75rem, 1.66rem + 0.4vw, 2rem)` | 2rem |
| `h4` | 1.5rem | `clamp(1.5rem, 1.48rem + 0.1vw, 1.5625rem)` | 1.5625rem |

Heading *elements* map onto the **lower half** of the ladder: this is a dense
console, so `h1` renders at the `h4` step and `h2` at `h5` — a 48px headline must
never land on a table of API keys. The `h1`–`h3` and `display` steps are the
content/marketing end: the landing hero uses `display`, and `display-xl` is held
back for a full-bleed hero.

## Layout

A 4px base rhythm (`xs`–`2xl`). Content is capped at 1100px and centered.
Admin and member surfaces use a 12rem sidebar; the public surface is a single
column. Tables are always full-width inside their container.

## Elevation & Depth

Depth comes from the **surface ramp and 1px borders, not shadows** — a shadow
on a near-black canvas reads as a smudge. Only overlays (modals, dropdowns)
may add a subtle shadow plus a `borderStrong` edge.

## Shapes

`sm` (4px) for inline chips and inner elements, `md` (8px) for buttons and
inputs, `lg` (12px) for cards and panels, `pill` for status badges. One radius
per element class — never mixed within a component.

## Components

`button-primary` is the single high-emphasis action per screen. Everything else
is `button-secondary`; destructive actions are `button-danger` and never
primary. `input` and `card` share the surface tokens so forms and panels read
as one family. Badges pair a `surfaceRaised` background with a semantic text
color rather than a filled background — a filled red badge on every row would
shout; an outlined one states a fact. `table-header` uses `textMuted` so column
labels recede behind the data they describe.

### Where a component's styles live

Values live in `tokens.css`. Anything **two or more components share** lives in
`lib/design/components.css` as an `fr-`prefixed class; a Svelte `<style>` block is
scoped to its own file, so a shared rule written there is a copy, not a
reference.

That rule exists because the copies had already drifted: `Button` and
`ButtonLink` each carried their own `.primary` / `.secondary` / `.ghost`, and
`Button` grew a `danger` variant `ButtonLink` never received. `Input`, `Select`
and `Textarea` each re-declared the same control shell, and the label treatment
below was written out four times.

The shared pieces are:

| Class | Shared by |
| --- | --- |
| `.fr-btn` + `.fr-btn--{variant}` + `.fr-btn--{size}` | `Button`, `ButtonLink` |
| `.fr-control` + `.fr-control--{size}` + `.fr-control--multiline` | `Input`, `Select`, `Textarea` |
| `.fr-label` | `Field`, `StatCard`, `table.fr th` |
| `.fr-tone-{tone}` | `Badge`, `Alert`, and any future tone carrier |

**One shell, two elements.** A link that looks like a button and a button are the
*same rule* — `ButtonLink` renders `.fr-btn` exactly as `Button` does. That is
what keeps a CTA and a submit control on one baseline, and it is why `danger` is
now available on both.

**Variants swap custom properties, not declarations.** `.fr-btn` reads
`--_bg` / `--_fg` / `--_bd` / `--_bg-hover` / `--_bd-hover`; each variant sets
only the ones it changes. Every one of those is *defined on the base* with a
default equal to the resting state, because an unset custom property in
`background: var(--_bg-hover)` is invalid at computed-value time and silently
falls back to transparent — a missing hover would flash transparent rather than
fail visibly.

### The enumerated props have one home

`lib/design/variants.ts` declares every variant, size and tone as a `const` array
and derives the type from it. Components import from there instead of declaring
their own union, and `variants.test.ts` asserts that **every member has a
matching CSS rule** — a variant you cannot style otherwise ships silently.

### Sizes

Controls come in three heights, from the `--fr-control-h-*` scale:

| Size | Height | Use |
| --- | --- | --- |
| `sm` | 32px | inside a table row or a dense toolbar |
| `md` | 40px | the default — Fitts's law comfortable target |
| `lg` | 48px | a hero CTA |

### Tone

The tone→colour table is defined once, in `.fr-tone-*`, as `--_tone`. A
component that carries a tone reads `var(--_tone)` and never re-derives the
colour. `Alert` maps `danger` to `role="alert"` (assertive — it interrupts) and
everything else to `role="status"` (polite — it waits for a pause).

### Atoms are composable

Every atom that spreads props destructures `class` out of the rest and merges it.
`{...rest}` placed after a literal `class` **overwrites** it, so `<Button
class="mt-4">` used to drop the entire button shell and render an unstyled
button. A caller's class must extend the design, never replace it.

### The atom library

The design system defines these atoms in `$lib/ui/`:

| Atom | Purpose |
| --- | --- |
| `Alert` | Inline feedback, coloured left border, semantic role (status/alert) |
| `Badge` | Semantic colour + word, never colour alone (colour-blind safe) |
| `Button` | High-emphasis control, variants: primary, secondary, danger, ghost |
| `ButtonLink` | Navigation that looks like a button (same shell, `<a>` element) |
| `Card` | Surface panel, border + surface step |
| `EmptyState` | States what's missing + next action, instead of bare "no data" |
| `Field` | Label + control (+ optional hint), wraps label for click-target |
| `Input` | Text input, shares `.fr-control` shell with Select/Textarea |
| `PageHeader` | Page title + optional lede + optional actions slot |
| `NavProgress` | Route load progress bar, `sr-only` status announcement |
| `Select` | Native select, shares `.fr-control` shell |
| `StatCard` | Single metric, tabular number, accentable for good/bad |
| `Textarea` | Multi-line input, monospace, shares `.fr-control` shell |

Each atom is a thin wrapper over shared `fr-` classes in `components.css`; none
carries a private copy of a shared style.

### Import from the barrel

`import { Button, Card } from '$lib/ui'` — not `'$lib/ui/Button.svelte'`. The file
layout stays an implementation detail, so moving an atom is one edit.

## Surfaces

Three audiences share this token set; only density and chrome differ.

- **Public** — single column, capped at 1100px, marketing rhythm (`2xl` hero
  padding). Header nav is a text row with a 2px active underline.
- **Member** — 12rem sidebar + content. Sidebar items are pills; the active one
  takes `surface` plus a 2px inset `primary` bar (location awareness without
  colour-only signalling).
- **Admin** — a `surface`-filled horizontal tab bar with a 2px inset active bar,
  showing only the tabs the viewer's capabilities unlock (no dead links).

Chrome rule: **cards hold forms and metrics; tables stay open** on the page
background, separated by row rules. Wrapping a table in a card doubles the
border and reads as a different component family.

Label rule: **labels are uppercase** (`label` type), **values are not**. A badge
is a value, so it stays lowercase — `success`, not `SUCCESS`.

## Responsive

One breakpoint, **820px**: below it the member/admin sidebar collapses to a
wrapped horizontal pill row above the content, and the account email is hidden
from the app bar. Nav never becomes a drawer — a console is used with two hands
on a laptop far more than on a phone.

Wide tables scroll **inside a `.table-wrap` box**; the page itself never scrolls
sideways. Two rules make that work, and both are load-bearing:

- The wrapper scrolls, the table stays a `table` — so it keeps its natural column
  widths and the user swipes to reach the rest.
- A grid item defaults to `min-width: auto`, so the content column refuses to
  shrink below its widest child. Without `min-width: 0` on the content column the
  whole document stretches (a 12-column table dragged it ~760px wide on a phone).

## Interaction & accessibility

Rules here are not optional polish — each one fixes a defect that a user could hit,
and most were found by running `axe-core` against the live pages rather than by
inspection.

- **Inline links are underlined.** A link inside running text must be
  distinguishable without relying on colour (WCAG 1.4.1). Nav items, buttons,
  cards and badges are not text blocks and stay clean, so `p a, li a, dd a, dt a,
  td a` carry `text-decoration: underline`.
- **A skip link opens every surface.** It is the first tab stop, rests off-screen
  (`top: -4rem`) and slides into view on focus. It targets `#content`, the region
  *after* the nav, so it actually skips something.
- **Motion is opt-out.** `prefers-reduced-motion: reduce` collapses every
  transition and animation in the document (WCAG 2.3.3). All motion here is
  decorative — a 120ms background fade — so nothing is lost.
- **Every wait is announced.** A route load shows a 2px top progress bar *and*
  writes "Loading page" into an `sr-only` `role="status"` region. A form POST
  disables its submit button and sets `aria-busy`, with the label gaining a `…`.
  Without this a click looks like nothing happened until the server answers.
- **Repeated row controls are named per row.** Thirteen buttons reading "Revoke"
  are unambiguous on screen (the row supplies context) but announce identically in
  a screen reader, so each carries an `aria-label` naming its row — the same rule
  applies to per-row `select` controls.
- **Focus is drawn with `outline`, never `box-shadow`.** Components already spend
  `box-shadow` on decoration (the active-nav inset bar), and `aside a.active`
  (specificity 0,1,2) outranks a bare `:focus-visible` (0,1,0) whichever file loads
  last — so a `box-shadow` ring is silently erased on the active nav link, exactly
  the element a keyboard user is most likely to tab to. Nothing sets `outline`, so
  it cannot be clobbered. `--fr-focus` holds the ring's shorthand (`2px solid
  primary`) and is applied with `outline-offset: 2px`.
- **Everything reflows to 320px.** No page scrolls sideways at any width down to
  320px (WCAG 1.4.10), and nothing clips under the 1.4.12 text-spacing override.
  Two rules carry this, and both are the same `min-width: auto` trap: grid items
  refuse to shrink below their widest child, so `.stack > *` and the member/admin
  content column set `min-width: 0`, and any value column holding an unbreakable
  string uses `minmax(0, 1fr)` plus `overflow-wrap: anywhere`.
- **Standalone pointer targets clear 24x24.** Header links, nav tabs and footer
  links are targets, not links inside running text, so each carries
  `min-height: 24px` (WCAG 2.5.8). Inline links in body copy are exempt and keep
  their natural box.

`.sr-only` is the visually-hidden utility: `clip-path: inset(50%)` with a 1px box,
so the text stays in the accessibility tree.

## API surfaces & tiers

An **API surface** is a path prefix a client points at. It is not a UI surface —
the public/member/admin audiences above are unrelated, and the two must not be
confused in code: the catalog type is `ApiSurface`, never `Surface`.

Two surfaces, each its own prefix rather than a filter on one list:

- **`/v1`** — pay as you go, billed per token.
- **`/coding/v1`** — coding plan, included in a subscription.

A model is assigned to a surface *with a tier*, so the same model can be `free` on
one surface and `premium` on another. Render rules:

- **Group by surface, not by tier.** The surface is what a client points at, so it
  is the thing a reader is looking for; the tier is a property of the row.
- **Print the endpoint in mono beside the section heading** (`<code>` in
  `textMuted`), so the path is copyable without a second lookup.
- **Tier is a `badge` with colour *and* word** — `free` is `success`, `premium` is
  `info`. Never colour alone.
- **A per-token price list shows the PAYG surface only.** A model that is not
  served on `/v1` has no per-token price to quote, so it does not appear there.

`$lib/catalog.ts` owns the surface metadata, the tier assignment and the grouping
helpers, so both `/models` and `/pricing` render from one source. Its tier map is a
**placeholder** until `model` carries real `tier`/`surface` columns (S2/S3); the
public pages say so on screen until it is replaced.

## Tables

Tables use a CSS pattern, not a component — Svelte's HTML parser cannot nest a
`<table>` through a `{@render}` slot:

```html
<!-- Every table in the app -->
<div class="table-wrap">
  <table class="fr">
    <thead>…</thead>
    <tbody>…</tbody>
  </table>
</div>
```

- `.table-wrap` — scrolls horizontally on narrow viewports so the **page** never
  scrolls sideways.
- `.fr` — the table's visual language (borders, hover, shared with `.fr-label`
  for column headers).

Adding zebra stripes, selectable rows, or a sticky header is one edit here, in
`tokens.css` — not fifteen call sites.

## Do's and Don'ts

- **Do** keep exactly one primary button visible per screen.
- **Do** use monospace with tabular numerals for every money and token figure —
  including latency, which takes thousands separators like every other number.
- **Do** show status as color + word, never color alone (color-blind safety).
- **Do** give every table an empty state that names the next action.
- **Do** give every control a 40px target (`--fr-control-h`) — Fitts's law.
- **Do** use atoms — never copy a shared rule into a component's `<style>` block.
- **Do** wrap every table in `<div class="table-wrap">` — the table itself
  scrolls, not the page.
- **Don't** use the primary indigo for success or error meaning.
- **Don't** introduce a third grey, a shadow on flat content, or a second accent.
- **Don't** rely on hover to reveal an action; every action is visible at rest.
- **Don't** reach into the atom file tree by name — import from `$lib/ui`.
