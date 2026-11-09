---
version: alpha
name: Fudrouter
description: A dark-first developer console — precise, calm, and legible under long working sessions. Minimalism & Swiss Style, code dark + endpoint green. The single source of truth is design-system/fudrouter/MASTER.md.
# Tier 1 — primitives. Raw values, named for what they ARE, never for where
# they go. A rebrand edits one value here and nothing downstream has to know.
# Nothing in a component may consume this tier: `--color-accent` in a button
# means "this is the action colour", not "this is green".
colors:
  primary: "#0F172A"
  onPrimary: "#FFFFFF"
  secondary: "#1E293B"
  onSecondary: "#FFFFFF"
  accent: "#22C55E"
  onAccent: "#0F172A"
  bg: "#020617"
  surface: "#0E1223"
  surfaceRaised: "#1E293B"
  border: "#334155"
  borderStrong: "#475569"
  text: "#F8FAFC"
  textMuted: "#94A3B8"
  success: "#22C55E"
  danger: "#EF4444"
  onDanger: "#000000"
  info: "#38BDF8"
  warning: "#F59E0B"
  ring: "#FFFFFF"
  focus: "2px solid {colors.ring}"
  # Tier 2 — semantic. What a colour is FOR, and the only tier a component
  # reads. Thin on purpose: a semantic token earns its place only when it
  # names a decision a theme could make differently. (Note: `accent` here is
  # the CTA green; `secondary`/`surfaceRaised` are the quiet hover surfaces —
  # `accent` is NOT a hover colour.)
semantic:
  primary: "{colors.accent}"
  primaryForeground: "{colors.onAccent}"
  onPrimary: "{colors.onAccent}"
  warning: "{colors.warning}"
  destructive: "{colors.danger}"
  destructiveForeground: "{colors.onDanger}"
  ring: "{colors.ring}"
typography:
  displayXl:
    fontFamily: "'IBM Plex Sans', system-ui, sans-serif"
    fontSize: "clamp(3rem, 2.4167rem + 2.9167vw, 4.75rem)"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  display:
    fontFamily: "'IBM Plex Sans', system-ui, sans-serif"
    fontSize: "clamp(2.5rem, 2.0833rem + 2.0833vw, 3.75rem)"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  h1:
    fontFamily: "'IBM Plex Sans', system-ui, sans-serif"
    fontSize: "clamp(2.25rem, 2rem + 1.25vw, 3rem)"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.015em"
  h2:
    fontFamily: "'IBM Plex Sans', system-ui, sans-serif"
    fontSize: "clamp(2rem, 1.8333rem + 0.8333vw, 2.5rem)"
    fontWeight: 600
    lineHeight: 1.2
  h3:
    fontFamily: "'IBM Plex Sans', system-ui, sans-serif"
    fontSize: "clamp(1.75rem, 1.6667rem + 0.4167vw, 2rem)"
    fontWeight: 600
    lineHeight: 1.3
  h4:
    fontFamily: "'IBM Plex Sans', system-ui, sans-serif"
    fontSize: "clamp(1.5rem, 1.4792rem + 0.1042vw, 1.5625rem)"
    fontWeight: 600
    lineHeight: 1.35
  h5:
    fontFamily: "'IBM Plex Sans', system-ui, sans-serif"
    fontSize: 1.25rem
    fontWeight: 600
    lineHeight: 1.4
  h6:
    fontFamily: "'IBM Plex Sans', system-ui, sans-serif"
    fontSize: 1.125rem
    fontWeight: 600
    lineHeight: 1.4
  lg:
    fontFamily: "'IBM Plex Sans', system-ui, sans-serif"
    fontSize: 1.125rem
    fontWeight: 400
    lineHeight: 1.47
    letterSpacing: "-0.00374em"
  base:
    fontFamily: "'IBM Plex Sans', system-ui, sans-serif"
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.47
    letterSpacing: "-0.00374em"
  sm:
    fontFamily: "'IBM Plex Sans', system-ui, sans-serif"
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: "'IBM Plex Sans', system-ui, sans-serif"
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

Fudrouter is a **commercial AI router**: one API key, many model providers. Its console is a *developer tool*, and the interface is built that way — dark-first to sit beside a terminal, low-chroma slate surfaces so status colors carry meaning, and a single green accent that marks the one action worth taking on a screen.

Inspired by **Minimalism & Swiss Style** (see `design-system/fudrouter/MASTER.md`). Key principles:

- **Information Architecture first.** Every page answers: what does the user need *right now*? Text is reduced to essential facts. Visuals (icons, badges, patterns) carry meaning faster than prose.
- **Fast recognition through symbols.** Users scan, not read. A green badge = healthy, a muted number = metric, a green button = action. Every element signals its role before a word is read.
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

- **Primary/CTA (#22C55E):** Endpoint green. The *only* driver for interactive emphasis — primary buttons, active nav, focus/ring. It is deliberately distinct from success (they share the hue but success is never an action), so "the thing to click" never reads as "the thing that worked".
- **Success (#22C55E):** Green. Confirming states only.
- **Warning (#F59E0B):** Amber. Non-blocking cautions and `dev`-status providers.
- **Danger (#EF4444):** Red. Destructive actions and failed states only.
- **Info (#38BDF8):** Sky. Links and neutral notices.

**Endpoint green** (`#22C55E`) anchors the brand against the slate ramp; interactive elements stay flat.

- **Surface ramp:** `#020617` background, `#0E1223` card, `#1E293B` hover/secondary — three slate steps create depth without shadows.
- **Text:** Two steps only — full-contrast for content, muted for metadata.
- **Border:** Row separators use `border`; interactive edges use `borderStrong`.

## Typography

**IBM Plex Sans** for headings and body (self-hosted), **JetBrains Mono** for code/data + labels with `fontFeature: tnum` for tabular numerals. Display and headline glyphs run the humanist sans so large text reads crisp rather than as a monospace field (`tracking` tightens as size grows); the mono cut carries the technical texture — eyebrows, code, figures — where fixed-width spacing means precision. MASTER.md names JetBrains Mono the "heading" family for the developer mood; the two-face rule pushes the actual display cut to the sans face for legibility.

The scale splits in two:

- **Static text** — `caption` · `sm` · `base` · `lg`. Fixed at every viewport.
- **Fluid headings** — `h6` · `h5` · `h4` · `h3` · `h2` · `h1` · `display` · `display-xl`. Each is a `clamp()` that reaches its floor at 320px and its ceiling at 1280px (the widest point where the 1100px shell still breathes).

**Optical sizing:** Display sizes (≥20px) use tighter tracking and heavier stroke (IBM Plex Sans 600–700); body sizes (<20px) use looser tracking; labels and code use JetBrains Mono.

| Token | Floor | Fluid expression | Ceiling |
| --- | --- | --- | --- |
| `display-xl` | 3rem | `clamp(3rem, 2.4167rem + 2.9167vw, 4.75rem)` | 4.75rem |
| `display` | 2.5rem | `clamp(2.5rem, 2.0833rem + 2.0833vw, 3.75rem)` | 3.75rem |
| `h1` | 2.25rem | `clamp(2.25rem, 2rem + 1.25vw, 3rem)` | 3rem |
| `h2` | 2rem | `clamp(2rem, 1.8333rem + 0.8333vw, 2.5rem)` | 2.5rem |
| `h3` | 1.75rem | `clamp(1.75rem, 1.6667rem + 0.4167vw, 2rem)` | 2rem |
| `h4` | 1.5rem | `clamp(1.5rem, 1.4792rem + 0.1042vw, 1.5625rem)` | 1.5625rem |
| `h5` | 1.25rem | — | 1.25rem |
| `h6` | 1.125rem | — | 1.125rem |

Heading *elements* carry the token with the same name (`h1` → `--text-h1`, `h2` →
`--text-h2`, …), so a heading always renders the step its level names. The console
only compresses its chrome (console pages render their `h1` at the `--text-h3` step for
density); public pages keep the full ladder. The authoritative values live in the
`:root` block of `apps/web/src/index.css` (Tailwind `@theme` + `:root` tokens,
consumed by shadcn/ui).

## Layout

A 4px base rhythm (`xs`–`2xl`). Content is capped at 1100px and centered. Admin and member surfaces use a 14rem sidebar (within `ConsoleLayout`, a `grid` with a `14rem` column); the public surface is a single column.

`card` is the one step that is not a gap: it is the inner padding of a card, so card padding is tunable without moving a rhythm step. Every card atom (`Card`, `StatCard`) uses the same `p-5` (or equivalent) padding — none of them hardcodes a distinct one.

### Section rhythm

Sections alternate between void (`#020617`) and card (`#0E1223`) backgrounds. Each color change signals a new "scene" — a cinematic pause between content moments. Where two scenes share one background, the boundary is a `VisualDivider` — a hairline that fades out at both ends; a solid border there would read as a table rule.

Within a section, content is tightly set (negative tracking, tight line-heights) while the space surrounding it is vast. This creates tension between density and openness.

## Elevation & Depth

Depth comes from the **surface ramp and 1px borders, not shadows** — a shadow on a near-black canvas reads as a smudge. Only overlays (modals, dropdowns) may add a subtle shadow plus a `borderStrong` edge.

## Shapes

`sm` (4px) for inline chips, `md` (8px) for buttons and inputs, `lg` (12px) for cards and panels, `pill` for status badges. One radius per element class — never mixed within a component.

## Components

`button-primary` is the single high-emphasis action per screen. Everything else is `button-secondary`; destructive actions are `button-danger` and never primary.

### Shared primitives

The theming and shared primitives live in **`apps/web/src/index.css`** (Tailwind
v4 `@theme` + `:root` tokens) and the shadcn/ui atoms in
**`apps/web/src/components/ui/`** (generate/add via `components.json`, style
`new-york`, base color `neutral`):

| Primitive | Shared by |
| --- | --- |
| `Button` (shadcn `button.tsx`, `buttonVariants`) | every action; `variant` ∈ `default`/`outline`/`secondary`/`ghost`/`destructive`/`link`, `size` ∈ `xs`…`lg`/`icon` |
| `Input` / native `<select>` | forms (shadcn `input.tsx`; selects are native + Tailwind) |
| `Badge` (shadcn `badge.tsx`, `badgeVariants`) | status tone carrier; `variant` includes `ok`/`warn`/`info` + `destructive` |
| `Table`/`TableHeader`/`TableBody`/`TableRow`/`TableHead`/`TableCell` | every table; the root `Table` owns the horizontal `overflow-x-auto` scroll container |
| lucide-react icons | `Menu`, `X`, `Check`, `Copy`, chevrons, tabs — no hand-drawn marker SVGs |

Layout is Tailwind utilities (`.grid`, `.flex`, `.gap-*`, `text-*`,
`bg-[var(--…)]`) plus the theme tokens `--primary`/`--accent`/`--card`/
`--muted`/`--border`/`--chart-1…3`; there are no bespoke `.btn`/`.card`/`.fr`/
`.stack`/`.row` semantic classes. Journey/prose blocks that render server-
generated HTML use one scoped `<style>` (docs, changelog, legal) because that
markup carries no Tailwind hooks.

**A Guide's fact rows are separated by spacing, never a rule.** A full-width hairline there is byte-identical to a table row separator, so a Guide stacked above a table read as one continuous table — the two blocks had no way to say they were different things. Tables are the only thing in the system that draws row rules. Give a table a heading when it follows a Guide.

### Atom library

The React primitives are the shadcn/ui atoms in **`apps/web/src/components/ui/`**:

| Atom | Purpose |
| --- | --- |
| `Button` | High-emphasis control; `variant`/`size` encode the emphasis/size ladder |
| `Card` (`CardHeader`/`CardTitle`/`CardDescription`/`CardContent`) | surface panel |
| `Input` / `Label` / `Textarea` | form controls |
| `Badge` | semantic colour + word, never colour alone (colour-blind safe) |
| `Table` (+ sub-parts) | data table; root owns the `overflow-x-auto` scroll region |
| `Sheet` | mobile bottom sheet (public header, console sidebar) |
| `Dialog`/`DropdownMenu`/`Select`/`Tooltip`/`Separator` | available primitives |

`Select` is a shadcn Radix primitive; pages that only need a simple picker use a
native `<select>` with the Tailwind field classes. `CodeBlock` (labeled `pre` +
clipboard) has no shadcn equivalent and is bespoke but Tailwind-styled.

### Importing atoms

Import from the atom file (`../components/ui/button`) — there is no barrel module
to re-export them.

## Cards

A grid of cards whose content varies in length needs two rules, or the grid reads as ragged even when every card is exactly the same size:

- **The badge is top-aligned** (`align-items: flex-start`). Centring it against the title makes it drift down a line whenever a long slug wraps one line further, so the badges stop forming a row.
- **The trailing block is pinned to the card's bottom** (`margin-top: auto` on a flex column). Cards in a grid row stretch to one height, so a title that wraps one line more otherwise pushes every row after it down — the price rows stop lining up across the row.

A card may also render a **uniform set of rows**: if a row is optional in the data, render it with a dash rather than omitting it, or half the cards are one row shorter and nothing after the title aligns. `Pricing` does this with `Context`.

**Never print the same string twice.** Where a row's display name and its identifier are equal — as `model.name` and `model.slug` are on 238 of 243 models — render one line, not two.

## Charts

No chart library is vendored. Usage figures render as stat cards and tables (mono,
tabular figures). Any future chart must read its palette from the CSS custom
properties at mount and honour `prefers-reduced-motion`, following the motion rules
in §Interaction.

## Surfaces

- **Public** — single column, capped at 1100px (`max-w-[1100px]` in `PublicLayout`), marketing rhythm. Header nav is a text row with a 2px active underline.
- **Member** — 14rem sidebar + content (within `ConsoleLayout`). Sidebar items are links; the active one takes the accent surface and a leading rail.
- **Admin** — shares the same `ConsoleLayout` sidebar, which switches to the admin section list when the path is under `/admin`; it is not a separate horizontal bar. Items are filtered by the viewer's capabilities.

Chrome rule: **cards hold forms and metrics; tables stay open** on the page background, separated by row rules.

## Responsive

Below **720px** the member/admin sidebar is replaced by a 44px section bar whose Menu button opens the shared bottom sheet (shadcn `Sheet`); public pages switch to the same sheet navigation. Wide tables scroll **inside the shadcn `Table` root's `overflow-x-auto` region**; the page itself never scrolls sideways.

## Interaction & accessibility

- **Inline links are underlined** (WCAG 1.4.1) — prose links (`p a`, `li a`, `dd a`, `dt a`, `td a`).
- **Skip link** opens every surface. First tab stop, off-screen until focused.
- **Motion is opt-out** — `prefers-reduced-motion: reduce` collapses every transition.
- **Motion is what the `motion` scale names, and nothing else** — an animation may
  not introduce a duration, easing or keyframe of its own; it composes `motion.*`.
  Motion that lives in a stylesheet without a spec entry is motion nobody can
  review.
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
- **Focus with a visible ring**, never a lost outline — the theme's `--ring` token (`--ring/50` utilities) holds the focus ring shorthand.
- **Everything reflows to 320px** — no page scrolls sideways.
- **Standalone targets clear 24x24** (WCAG 2.5.8).
- **Text spacing** (WCAG 1.4.12) — content must not clip under the override.

## API surface

One surface, one prefix: **`/v1`** — pay per token, no subscription, no plan tier.
This matches the product record (`apps/web/PRODUCT.md`): four endpoints — two native
(`POST /v1/chat/completions`, `GET /v1/models`), two forwarded pass-through
(`POST /v1/responses`, `POST /v1/embeddings`). A per-token price list shows the
whole surface; there is no separate coding plan, so no tier badge and no `/coding/*`
prefix appear anywhere.

## Tables

A table is the shadcn `Table`/`TableHeader`/`TableBody`/`TableRow`/`TableHead`/
`TableCell` composition:

```tsx
<Table aria-label="Recent requests">
  <TableHeader>
    <TableRow>
      <TableHead>Time</TableHead>
      <TableHead className="text-right font-mono tabular-nums">Cost</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    <TableRow>…</TableRow>
  </TableBody>
</Table>
```

The `Table` root renders its own `relative w-full overflow-x-auto` container, so a
table wider than its column scrolls horizontally without scrolling the page.

## Do's and Don'ts

- **Do** keep exactly one primary button visible per screen.
- **Do** use monospace with tabular numerals for every money and token figure.
- **Do** show status as color + word, never color alone.
- **Do** give every table an empty state that names the next action.
- **Do** give every control a 44px target.
- **Do** use atoms — never copy a shared rule into a component's `<style>` block (scoped prose/styles for server-rendered HTML are the one exception).
- **Do** wrap wide tables in the shadcn `Table` (its root scrolls).
- **Don't** use the primary green for success or error meaning.
- **Don't** introduce a second accent, a shadow on flat content, or an off-palette grey.
- **Don't** rely on hover to reveal an action; every action is visible at rest.
- **Don't** expose provider names, upstream URLs, or credential hints on public pages.
- **Don't** center-align body text — only headlines center.
- **Don't** use wide letter-spacing — the typeface is designed to run tight.