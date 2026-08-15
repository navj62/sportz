# Design

<!-- impeccable:design-schema 1 -->

The visual system for the Sportz frontend. `client/app/globals.css` is the
implementation; this file is the reasoning and the rules. Where the two
disagree, the CSS is the truth and this file is stale — fix it.

`client/app/style-reference/` renders every token below on one page. It is a
**token specimen sheet only** — it deliberately does not demonstrate page
structure, navigation, or a sidebar. Keep it until the product surfaces consume
the system; it is the fastest way to see the whole system at once.

## Status of this system

**Locked (Pass 0).** Surfaces, text ramp, accent, status colours, hairlines,
radius, spacing, type scale and motion are settled and should not be
re-derived. Changes to the token values need a stated reason, not a preference.

**Deliberately out of scope.** This frontend supports a backend showcase —
Redis, WebSocket, real-time architecture. The bar is *clean, consistent, and
credibly a real product*, not a design showpiece. Micro-tuning of contrast
ratios, font sizes and colour relationships is explicitly **not** wanted and is
not pending work.

## Platform

Web. Next.js App Router, Tailwind v4, shadcn on `@base-ui/react`. Dark-only —
there is no light theme and none is planned. Dev server runs with `--webpack`;
Turbopack is known-broken on this project's dynamic routes.

## Token architecture

Three layers, in this order, all in `globals.css`:

1. **Authored tokens** (`--bg-*`, `--text-*`, `--accent`, `--status-*`,
   `--stroke*`, `--radius-*`, `--space-*`, `--type-*`). *These are the design
   system.* Author against these and only these.
2. **shadcn compatibility aliases** (`--background`, `--card`, `--muted`,
   `--border`, …) which point at layer 1. They exist so `npx shadcn add` drops
   in a component already speaking this system. **Never hand-edit them.**
3. **`@theme inline`**, which turns both into Tailwind utilities.

**Author against layer 1.** Reaching past it to the aliases —
`bg-(--card)`, `text-(--muted-foreground)`, `border-(--border)` — works, but it
bypasses the system's vocabulary and is how a surface drifts back to looking
like a stock template. Use `bg-surface-raised`, `text-fg-secondary`,
`border-stroke`.

### The `accent` name collision

shadcn's `accent` role means **hover background**, not "brand accent". Pointing
it at racing red would paint every dropdown item red. So:

- `--ui-hover` holds the hover surface, and the alias `--color-accent` points
  there.
- Racing red is exposed as **`signal`** (`text-signal`, `--color-signal`) and
  as `live`.

There is no `bg-signal` in use anywhere, and that is correct — red is a
foreground and small-fill colour here, not a surface.

## Surfaces

Three near-black layers. **Depth comes from the step between layers, never from
an outline.** A card is raised because it is lighter, not because it is
bordered.

| Token | Value | Role |
|---|---|---|
| `--bg-base` | `#0A0D11` | Page ground |
| `--bg-raised` | `#12161C` | Cards, header |
| `--bg-elevated` | `#1A1F27` | Popovers, hover, a card promoted above its peers |

Utilities: `bg-surface`, `bg-surface-raised`, `bg-surface-elevated`.

A live match card takes `bg-surface-elevated` — one step above its neighbours.
That step, not a border and not a colour, is how "this one is happening now"
is carried structurally.

## Text

Never pure white; `#FFF` vibrates against a near-black ground.

| Token | Value | Utility | Role |
|---|---|---|---|
| `--text-primary` | `#F4F6F8` | `text-fg` | Scores, team names, headings |
| `--text-secondary` | `#9BA3AD` | `text-fg-secondary` | Metadata, captions, supporting copy |
| `--text-muted` | `#5A626C` | `text-fg-muted` | De-emphasised, non-essential |

## Accent

`--accent` `#E10600` — racing red. **One accent, under a restraint rule.**

**Permitted on exactly four things:**

1. The LIVE indicator
2. Score-change emphasis (the goal flash)
3. The red-card marker
4. At most one primary action per screen

**Never on:** card borders, section headers, links, generic hover, dividers, or
decoration. Over roughly 5% of the visible screen is overuse. When in doubt,
reach for a grey token.

**The goal marker is deliberately not red.** It was, in the original
derivation, and PRODUCT.md still lists it among the red-permitted places — that
line is superseded by this one. The goal icon takes `--text-primary` (white).
Rationale: red is the *state* channel (this match is live, this player is off),
and a goal is an *event* in a feed. Spending red on both meant the two strongest
signals on screen competed. White at full primary weight is already the loudest
foreground available, and it keeps the red budget on live state.

`--accent-dim` `#A80400` exists for cases needing a recessive red. It reads at
2.32:1 on the raised surface, so it is not usable for anything that must be
read at label size — the red card takes the full accent for exactly this
reason.

## Status colours

Deliberately not red except `live` — that is what keeps red meaningful.

| Token | Value | Utility |
|---|---|---|
| `--status-live` | `#E10600` | `text-live` / `bg-live` |
| `--status-scheduled` | `#9BA3AD` | `text-scheduled` |
| `--status-finished` | `#5A626C` | `text-finished` |
| `--status-postponed` | `#D89614` | `text-postponed` |
| `--status-cancelled` | `#D89614` | `text-cancelled` |

`postponed` and `cancelled` are defined but not yet emitted by the backend
(`scheduled | live | finished` is the vocabulary in code today). Keeping them
defined costs nothing and means the surface does not break if they arrive.

**Status is never carried by colour alone.** Every state ships a text label
next to its colour. `LiveBadge` is the reference implementation: a pulsing dot
*and* the word "Live".

The LIVE pill uses a **solid** red fill rather than a tint, because `#E10600`
text on the raised surface is 3.65:1 while `--text-primary` on `#E10600` is
4.59:1. The pill is small enough that filling it costs almost nothing against
the red budget, and it reads harder from across a room.

## Hairlines

`--stroke` `#232932`, `--stroke-strong` `#333B46`. Derived from the surface
ramp. Used for dividers **inside** a surface — a rule under a section header, a
line between feed entries — not to outline a surface. Outlining is what the
layer step is for.

## Radius

Three values. Nothing else.

- `--radius-card` **8px** — cards, panels (`rounded-xl`)
- `--radius-inner` **6px** — buttons, inputs, anything nested in a card (`rounded-lg`)
- `--radius-pill` **999px** — status pills only (`rounded-4xl`)

The Tailwind radius scale in `@theme inline` is pinned to these real values
rather than a multiplier chain, so shadcn components land on-spec untouched.

## Spacing

`4 / 8 / 12 / 16 / 24 / 32` — Tailwind's `1 / 2 / 3 / 4 / 6 / 8`. Stay on the
scale.

## Type

**Archivo, and only Archivo.** One variable file carries both a weight axis
(100–900) and a width axis (62–125), which gives two voices:

- **wdth 100** — the UI voice. Everything that is words.
- **wdth 75** (condensed) — the display voice. **Numerals and display type
  only.** This is the system's signature; it is what makes a score look like a
  score and not like body text at a larger size.

Set width via `font-stretch`, not `font-variation-settings` — the latter fights
`font-weight`.

Roles are applied as **classes**, so the scale is used rather than eyeballed:

| Utility | Size / weight / width | Role |
|---|---|---|
| `type-score` | 52px / 800 / wdth 75 / -0.03em / tabular | The score. The largest thing on any screen it appears on. |
| `type-display` | 40px / 800 / wdth 75 | Wordmark, display headings |
| `type-h1` | 28px / 700 | Page heading |
| `type-h2` | 20px / 600 | Section heading |
| `type-body` | 15px / 400 | Body copy, team names |
| `type-label` | 13px / 500 | Labels, dense metadata |
| `type-caption` | 11px / 600 / +0.08em / uppercase | Captions, eyebrow text |
| `numeral` | wdth 75 / tabular / -0.03em | Condensed numerals at any size |

`numeral` is the escape hatch for the condensed voice where a full role does
not fit — a minute in a badge, the wordmark in the header.

Do not hand-roll a role out of raw Tailwind (`text-2xl font-bold`,
`text-xs uppercase tracking-wide`). If a size is missing from the scale, that
is a decision to make once here, not per component.

## Motion

**One authored moment: a score changing.** Everything else on the surface holds
still. That restraint is the entire point — the screen is quiet so a goal can
be the only thing that moves.

- `animate-score-flash` — 1400ms. The number swells to 118% and flushes to
  racing red, then settles back to primary. This is the product's peak moment.
  It belongs on the numeral that changed, not on the card.
- `animate-live-pulse` — 1600ms, infinite. The LIVE dot and the connecting
  state only.
- `--ease-out` `cubic-bezier(0.16, 1, 0.3, 1)`, `--dur-fast` 120ms,
  `--dur-base` 200ms for ordinary transitions.

`prefers-reduced-motion: reduce` collapses all animation and transition
duration globally and unconditionally. Do not add a component-level opt-out;
the global rule already covers it.

## Event markers

One 16px grid, one stroke weight, 14px rendered. Goal and cards are authored
SVG because they are objects specific to this sport. The substitution arrow
comes from lucide at the same size and stroke.

**No emoji, ever.** They render differently on every OS, so the brand has no
control over them, and they import a full colour palette into a world that
permits one chromatic value.

| Marker | Treatment |
|---|---|
| Goal | Authored ball glyph — outlined circle, centred pentagon panel. `--text-primary`. |
| Yellow card | Filled rect, `--status-postponed` |
| Red card | Filled rect, `--accent` |
| Substitution | lucide `ArrowRightLeft`, `--text-secondary` |

## Browser surfaces

The parts not drawn by hand still belong to the system: selection uses a 32%
accent mix, `:focus-visible` is a 2px `--text-primary` outline at 2px offset
(stronger and more consistent than the shadcn default it replaces), scrollbars
are thin on `--stroke-strong`, and the caret is `--accent`.

## Known divergence

The product surfaces (`app/page.tsx`, `components/match-card.tsx`,
`components/match-filters.tsx`) were built before this system and do not
consume it — they address the layer-2 aliases directly and hand-roll type
roles. The system currently ships in full only to `app/style-reference/`.
Reconciling them is the next pass, not a defect in the system.

One consequence to be aware of while that is true:
`components/commentary-feed.tsx` still tints its `goal` event label with
`text-signal`, which now disagrees with the white goal marker above. It is a
one-line fix, but changing it in isolation would collide with the `penalty`
label, which is already `text-fg` — so the feed's whole event-colour map should
be settled in one go rather than patched.
