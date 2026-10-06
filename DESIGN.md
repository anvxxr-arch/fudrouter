---
version: alpha
name: Fudrouter
description: A dark-first developer console — precise, calm, and legible under long working sessions. Inspired by Apple Human Interface Design.
# Tier 1 — primitives. Raw values, named for what they ARE, never for where
# they go. A rebrand edits one value here and nothing downstream has to know.
# Nothing in a component may consume this tier: `--color-orange` in a button
# means "this is orange", not "this is the action colour".
colors:
  orange: "#FF6C11"
  orangeHover: "#FF8A3D"
  amber: "#FFAA2B"
  cream: "#FFE2AE"
  bg: "#090B0F"
  surface: "#151922"
  surfaceRaised: "#1E2430"
  border: "#2A3040"
  borderStrong: "#3D4660"
  text: "#F5F6F8"
  textMuted: "#8B94A3"
  success: "#10B981"
  danger: "#F87171"
  info: "#38BDF8"
  focus: "2px solid {colors.orange}"
  # Tier 2 — semantic. What a colour is FOR, and the only tier a component
  # reads. Thin on purpose: a semantic token earns its place only when it
  # names a decision a theme could make differently. `--success` qualifies (a
  # status badge must go green without a stylesheet knowing what green is);
  # a token that merely renames a primitive does not, and there are none.
semantic:
  primary: "{colors.orange}"
  primaryHover: "{colors.orangeHover}"
  onPrimary: "{colors.bg}"
  warning: "{colors.amber}"
typography:
  display:
    fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif"
    fontSize: 3.5rem
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  h1:
    fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif"
    fontSize: 2.75rem
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  h2:
    fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif"
    fontSize: 2.25rem
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
  lg:
    fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif"
    fontSize: 1.125rem
    fontWeight: 400
    lineHeight: 1.47
    letterSpacing: "-0.00374em"
  base:
    fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif"
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.47
    letterSpacing: "-0.00374em"
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
    fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
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
  card: 20px
  lg: 24px
  xl: 32px
  2xl: 48px
  # The section-break step. Past this a page wants two sections, not more
  # space — it exists so the one gap that should read as a pause has a name
  # rather than a literal in whichever stylesheet needed it.
  3xl: 80px
motion:
  # Two durations only. Anything answering a click must land inside the ~100ms
  # where a delay stops reading as lag; entrances are the one place a longer
  # curve buys legibility, because that is where the movement needs explaining.
  durFast: 120ms
  durMed: 320ms
  # One curve, ease-out. An ease-in on a UI transition makes the interface feel
  # like it is chasing the user instead of settling where they put it.
  ease: "cubic-bezier(0.16, 1, 0.3, 1)"
components:
  button-primary:
    backgroundColor: "{semantic.primary}"
    textColor: "{semantic.onPrimary}"
    rounded: "{rounded.md}"
    padding: 8px
    height: 44px
  button-primary-hover:
    backgroundColor: "{semantic.primaryHover}"
    textColor: "{semantic.onPrimary}"
  button-secondary:
    backgroundColor: "{colors.surfaceRaised}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: 8px
    height: 44px
  button-danger:
    backgroundColor: "{colors.surfaceRaised}"
    textColor: "{colors.danger}"
    rounded: "{rounded.md}"
    padding: 8px
    height: 44px
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.info}"
    rounded: "{rounded.md}"
    padding: 8px
    height: 44px
  button-sm:
    backgroundColor: "{colors.surfaceRaised}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: 6px
    height: 32px
  button-lg:
    backgroundColor: "{colors.surfaceRaised}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: 12px
    height: 48px
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: 8px
    height: 44px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: 20px
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
    textColor: "{semantic.warning}"
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

Fudrouter is a **commercial AI router**: one API key, many model providers. Its console is a *developer tool*, and the interface is built that way — dark-first to sit beside a terminal, low-chroma surfaces so status colors carry meaning, and a single orange accent that marks the one action worth taking on a screen.

Inspired by **Apple Human Interface Design**. Key principles:

- **Information Architecture first.** Every page answers: what does the user need *right now*? Text is reduced to essential facts. Visuals (icons, badges, patterns) carry meaning faster than prose.
- **Fast recognition through symbols.** Users scan, not read. A green badge = healthy, a muted number = metric, an orange button = action. Every element signals its role before a word is read.
- **Controlled density.** Tight tracking on headlines (optical sizing), generous breathing room between sections. Compression within, expansion between.
- **Binary rhythm.** Sections alternate between void and graphite backgrounds — each color change signals a new scene.
- **Nothing hidden behind hover.** Every action is visible at rest.

The three audiences — **public** visitors, **members** (buyers), and **staff** (admin) — share one token set. Only density and chrome change between them; color, type, and spacing never fork.

## Information Architecture

### User flows

**Public (acquisition):** Landing → Pricing → Models → Signup → Dashboard
**Member (usage):** Dashboard → Keys → Usage → Account
**Admin (operations):** Overview → Providers → Models → Users → Connections → Requests

### Information per page

| Page | User needs | Primary visual | Secondary |
|------|-----------|---------------|-----------|
| `/` (landing) | What is this? Is it credible? | Hero + metric strip | Feature grid + CTA |
| `/pricing` | How much? | Price comparison | Tier badges |
| `/models` | What's available? | Model cards by surface | Endpoint paths |
| `/login` | Access my account | Clean split layout | Discord OAuth |
| `/signup` | Create account | Clean split layout | Discord OAuth |
| `/dashboard` | What's my usage? | Chart + stat cards | Recent activity |
| `/keys` | Manage API keys | Key list + create form | Prefixes |
| `/usage` | Audit my calls | Log table + filters | Cost/latency |
| `/account` | Update profile | Form | Preferences |
| `/status` | Is it working? | Live probe + indicator | Model count |
| `/docs` | How do I use this? | Structured reference | Code samples |
| `/admin` | System overview | Metric grid | Top consumers |
| `/admin/*` | Manage resources | Tables + forms | Status badges |

### Rules

- **One primary action per screen.** The eye lands here first.
- **Every table has an empty state** that names the next action.
- **Status = color + word**, never color alone.
- **No security-relevant info on public pages.** No provider names, no base URLs, no credential hints.
- **Labels are uppercase, values are not.** A badge is a value — lowercase.
- **Less text, more scannable patterns.** Icons, badges, stat cards, and charts replace paragraphs.

## Colors

- **Primary (#FF6C11):** FUD Orange. The *only* driver for interactive emphasis — primary buttons, active nav, focus rings. It is deliberately distinct from success, so "the thing to click" never reads as "the thing that worked".
- **Success (#10B981):** Emerald. Confirming states only.
- **Warning (#FFAA2B):** Amber. Non-blocking cautions and `dev`-status providers.
- **Danger (#F87171):** Red. Destructive actions and failed states only.
- **Info (#38BDF8):** Sky. Links and neutral notices.

**FUD Orange** (`#FF6C11`) anchors the brand. A gradient from orange to amber appears in exactly two places — the hero glow and the visual divider; interactive elements stay flat.

- **Surface ramp:** Three near-black steps create depth without shadows.
- **Text:** Two steps only — full-contrast for content, muted for metadata.
- **Border:** Row separators use `border`; interactive edges use `borderStrong`.

## Typography

**Plus Jakarta Sans** for UI (self-hosted variable font), **JetBrains Mono** for code/data with `fontFeature: tnum` for tabular numerals.

The scale splits in two:

- **Static text** — `caption` · `sm` · `base` · `lg`. Fixed at every viewport.
- **Fluid headings** — `h5` · `h4` · `h3` · `h2` · `h1` · `display`. Grow with viewport. (`h6` and `display-xl` were removed — each was byte-identical to `lg` and `display` respectively, so the second name was a way to spell the same step twice.)

**Optical sizing (Apple HIG):** Display sizes (≥20px) use tighter tracking and lighter stroke; body sizes (<20px) use tighter, sturdier tracking. The `display` headline runs at `line-height: 1.07` with `letter-spacing: -0.028em` — compressed, billboard-like impact. Body copy at `1.47` line-height with `-0.00374em` tracking — comfortable without slack.

| Token | Floor | Fluid expression | Ceiling |
| --- | --- | --- | --- |
| `display` | 3.5rem | `clamp(3.5rem, 3.05rem + 2vw, 4.75rem)` | 4.75rem |
| `h1` | 2.75rem | `clamp(2.75rem, 2.48rem + 1.2vw, 3.5rem)` | 3.5rem |
| `h2` | 2.25rem | `clamp(2.25rem, 2.07rem + 0.8vw, 2.75rem)` | 2.75rem |
| `h3` | 1.75rem | `clamp(1.75rem, 1.66rem + 0.4vw, 2rem)` | 2rem |
| `h4` | 1.5rem | `clamp(1.5rem, 1.48rem + 0.1vw, 1.5625rem)` | 1.5625rem |

Heading *elements* map onto the **lower half** of the ladder: this is a dense console, so `h1` renders at the `h4` step and `h2` at `h5` — a 48px headline must never land on a table of API keys.

## Layout

A 4px base rhythm (`xs`–`2xl`). Content is capped at 1100px and centered. Admin and member surfaces use a 12rem sidebar; the public surface is a single column.

`card` is the one step that is not a gap: it is the inner padding of a card, so card padding is tunable without moving a rhythm step. Every card atom (`Card`, `StatCard`, `Metric`, and the model/price cards) reads `--fr-space-card` — none of them hardcodes a padding.

### Section rhythm (Apple HIG)

Sections alternate between void (`#090B0F`) and graphite (`#151922`) backgrounds. Each color change signals a new "scene" — a cinematic pause between content moments. Whitespace between sections is `var(--fr-space-2xl)` minimum. Where two scenes share one background, the boundary is a `VisualDivider` — a hairline that fades out at both ends; a solid border there would read as a table rule.

Within a section, content is tightly set (negative tracking, tight line-heights) while the space surrounding it is vast. This creates tension between density and openness.

## Elevation & Depth

Depth comes from the **surface ramp and 1px borders, not shadows** — a shadow on a near-black canvas reads as a smudge. Only overlays (modals, dropdowns) may add a subtle shadow plus a `borderStrong` edge.

## Shapes

`sm` (4px) for inline chips, `md` (8px) for buttons and inputs, `lg` (12px) for cards and panels, `pill` for status badges. One radius per element class — never mixed within a component.

## Components

`button-primary` is the single high-emphasis action per screen. Everything else is `button-secondary`; destructive actions are `button-danger` and never primary.

### Shared primitives

Shared pieces live in `lib/design/components.css`:

| Class | Shared by |
| --- | --- |
| `.fr-btn` + `.fr-btn--{variant}` + `.fr-btn--{size}` | `Button`, `ButtonLink` |
| `.fr-control` + `.fr-control--{size}` + `.fr-control--multiline` | `Input`, `Select`, `Textarea` |
| `.fr-label` | `Field`, `StatCard`, `table.fr th` |
| `.fr-tone-{tone}` | `Badge`, `Alert`, and any future tone carrier |
| `.fr-dl` | `Facts`, and the `Guide` that composes it |

**A Guide's fact rows are separated by spacing, never a rule.** A full-width hairline there is byte-identical to `table.fr td`'s separator, so a Guide stacked above a table read as one continuous table — the two blocks had no way to say they were different things. Tables are the only thing in the system that draws row rules. Give a table a heading when it follows a Guide.

### Atom library

The design system defines these atoms in `$lib/ui/`:

| Atom | Purpose |
| --- | --- |
| `Alert` | Inline feedback, coloured left border, semantic role (status/alert) |
| `Badge` | Semantic colour + word, never colour alone (colour-blind safe) |
| `Button` | High-emphasis control |
| `ButtonLink` | Navigation that looks like a button (same shell, `<a>` element) |
| `Card` | Surface panel, border + surface step |
| `EmptyState` | States what's missing + next action |
| `Field` | Label + control (+ optional hint) |
| `Input` | Text input, shares `.fr-control` shell |
| `PageHeader` | Page title + optional lede + optional actions slot |
| `NavProgress` | Route load progress bar, `sr-only` status |
| `Select` | Native select, shares `.fr-control` shell |
| `StatCard` | Single metric, tabular number, accentable for good/bad |
| `Textarea` | Multi-line input, monospace, shares `.fr-control` shell |
| `Section` | Heading + lede + slot. The page-section rhythm |
| `Facts` | Term/detail list. Label is caption; value is not |
| `CodeBlock` | Labeled `pre`. Geometry stays on the `pre` rule |
| `Metric` | Large scannable number with label, used in metric strips |
| `VisualDivider` | Decorative scene edge (gradient hairline) |
| `UsageChart` | Activity bars on a canvas — rules in §Charts |
| `TableWrap` | Scroll container for a wide table: focusable region — rules in §Tables |
| `Guide` | Page explanation, composed from `Section` + `Facts`; copy lives in `$lib/guides` |
| `DiscordButton` | OAuth sign-in button |

### Import from the barrel

`import { Button, Card } from '$lib/ui'` — not per-file deep imports.

## Cards

A grid of cards whose content varies in length needs two rules, or the grid reads as ragged even when every card is exactly the same size:

- **The badge is top-aligned** (`align-items: flex-start`). Centring it against the title makes it drift down a line whenever a long slug wraps one line further, so the badges stop forming a row.
- **The trailing block is pinned to the card's bottom** (`margin-top: auto` on a flex column). Cards in a grid row stretch to one height, so a title that wraps one line more otherwise pushes every row after it down — the price rows stop lining up across the row.

A card may also render a **uniform set of rows**: if a row is optional in the data, render it with a dash rather than omitting it, or half the cards are one row shorter and nothing after the title aligns. `Pricing` does this with `Context`.

**Never print the same string twice.** Where a row's display name and its identifier are equal — as `model.name` and `model.slug` are on 238 of 243 models — render one line, not two.

## Charts

One chart, `UsageChart`, exported from `$lib/ui`. It draws with Chart.js on the client only — the server emits the heading and the empty state, so a cold load never shows a blank canvas.

- **Tokens are the palette.** Colours and the tick font are read from the CSS custom properties at mount; a chart carries no hex of its own.
- **No chartjunk.** No legend (the heading names the series), no vertical gridlines, no frame around the plot. One horizontal rule per tick, in `--fr-border`.
- **One series per chart.** A second axis is a second chart.
- **Detail lives in the tooltip** — the bars carry the count; tokens and cost are one hover away. Nothing *action-like* hides behind hover.
- **Motion is opt-out** — `prefers-reduced-motion` disables the reveal, like every other transition.
- **The wrapper owns the height.** The chart chunk is lazy and must not shift the page when it lands; the canvas is decorative, with the numbers in an `sr-only` summary.

## Surfaces

- **Public** — single column, capped at 1100px, marketing rhythm (`2xl` hero padding). Header nav is a text row with a 2px active underline.
- **Member** — 12rem sidebar + content. Sidebar items are pills; the active one takes `surface` plus a 2px inset `primary` bar.
- **Admin** — a `surface`-filled horizontal tab bar with a 2px inset active bar, showing only the tabs the viewer's capabilities unlock.

Chrome rule: **cards hold forms and metrics; tables stay open** on the page background, separated by row rules.

## Responsive

One breakpoint, **820px**: below it the member/admin sidebar collapses to a wrapped horizontal pill row above the content. Wide tables scroll **inside a `.table-wrap` box**; the page itself never scrolls sideways.

## Interaction & accessibility

- **Inline links are underlined** (WCAG 1.4.1) — `p a, li a, dd a, dt a, td a, .lede a`.
- **Skip link** opens every surface. First tab stop, off-screen until focused.
- **Motion is opt-out** — `prefers-reduced-motion: reduce` collapses every transition.
- **Motion is what the `motion` scale names, and nothing else** — an animation may
  not introduce a duration, easing or keyframe of its own; it composes `motion.*`.
  Motion that lives in a stylesheet without a spec entry is motion nobody can
  review, and `tokens.test.ts` cannot hold an undocumented value in place.
- **Transform and opacity only.** Both are compositor properties, so neither
  triggers layout. Animating width, height, top or margin does, and on a page
  this size that is the difference between a reveal and a stutter.
- **Entrances are the only animation that is not optional to write.** A control
  that changes state on hover or press transitions it — that is `durFast`, and
  the rest-state must already look correct without it.
- **An entrance must be able to fail closed.** Any `animation` with a `backwards`
  fill needs a `reduce` branch that restores the resting state explicitly, so a
  skipped animation can never leave content at `opacity: 0`.
- **Every wait is announced** — progress bar + `sr-only` status region; form POST disables button + `aria-busy`.
- **Repeated row controls named per row** via `aria-label`.
- **Focus with `outline`, never `box-shadow`** — `--fr-focus` holds the ring shorthand.
- **Everything reflows to 320px** — no page scrolls sideways.
- **Standalone targets clear 24x24** (WCAG 2.5.8).
- **Text spacing** (WCAG 1.4.12) — content must not clip under the override.

## API surfaces & tiers

Two surfaces, each its own prefix:

- **`/v1`** — pay as you go, billed per token.
- **`/coding/v1`** — coding plan, included in a subscription.

Render rules:
- **Group by surface, not by tier.** The surface is what a client points at.
- **Print the endpoint in mono beside the section heading** — copyable.
- **Tier is a `badge` with colour *and* word** — `free` is `success`, `premium` is `info`.
- **A per-token price list shows the PAYG surface only.**

## Tables

A table is a `TableWrap` around a plain `table.fr`:

```tsx
<TableWrap label="Recent requests">
  <table class="fr">
    <thead>…</thead>
    <tbody>…</tbody>
  </table>
</TableWrap>
```

`TableWrap` exists for one reason: `.table-wrap` scrolls horizontally, so it must be keyboard focusable — otherwise a keyboard user cannot reach the columns that scrolled off (axe: `scrollable-region-focusable`, serious). It sets `tabindex="0"` and `role="region"` and names the region from the `label` you pass. The wrapper scrolls; the table keeps its natural width.

A `{@render}` slot **can** carry a `<table>` — the earlier claim here that it cannot was wrong, and it is why this shipped as raw markup with the a11y gap for so long. the wrapper's `tabindex` a11y warning is a false positive (the linter cannot see that the element scrolls); it is suppressed in the component with a comment.

## Do's and Don'ts

- **Do** keep exactly one primary button visible per screen.
- **Do** use monospace with tabular numerals for every money and token figure.
- **Do** show status as color + word, never color alone.
- **Do** give every table an empty state that names the next action.
- **Do** give every control a 44px target.
- **Do** use atoms — never copy a shared rule into a component's `<style>` block.
- **Do** wrap every table in `<div class="table-wrap">`.
- **Don't** use the primary orange for success or error meaning.
- **Don't** introduce a third grey, a shadow on flat content, or a second accent.
- **Don't** rely on hover to reveal an action; every action is visible at rest.
- **Don't** expose provider names, upstream URLs, or credential hints on public pages.
- **Don't** center-align body text — only headlines center.
- **Don't** use wide letter-spacing — the typeface is designed to run tight.