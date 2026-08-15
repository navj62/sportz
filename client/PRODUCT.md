# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Football supporters checking scores while a match is in progress — on a phone
between other things, or on a desktop tab left open in the background. The job
is a glance: *what is the score right now, and did anything just happen.* They
are not researching; they are checking. A returning visitor arrives already
knowing which matches they care about.

## Product Purpose

Sportz shows live football scores as they change. The backend polls
API-Football for live fixtures, persists them, and pushes score updates to
connected clients over WebSocket. Success is that a goal appears on screen
without the visitor doing anything, and that the current state of every live
match is readable in one glance.

## Positioning

Updates are pushed, not polled by the browser: the page reflects a score change
as it arrives rather than on a refresh interval. The read surface is entirely
public and entirely read-only — there is no account, no personalization stored
server-side, and nothing to configure before the product is useful.

## Operating Context

- One `/fixtures?live=all` upstream request yields fixtures, competitions *and*
  match events together; the product's information architecture follows what
  that single payload can support.
- WebSocket at `/ws`. Every production socket currently subscribes to all
  matches, so the list surface receives every live update.
- Reads are served from a TTL-only cache; staleness is bounded by the TTL,
  always shorter than the upstream poll interval.

## Capabilities and Constraints

- **Confirmed:** live/finished/scheduled match state, scores, competitions,
  match events (goals, cards, substitutions), a deprecated commentary view
  synthesized from events.
- **Status vocabulary in code today** is `scheduled | live | finished`. The
  design system additionally defines `postponed` and `cancelled`; whether the
  backend will emit them is an open product decision.
- **Read-only, no auth**, by design. There are no write endpoints and no
  primary "action" in the transactional sense.
- **Team crests / logos are not yet available.** Until they are, team identity
  is carried by initials in a monogram. Do not fabricate club badges.
- Frontend is Next.js (App Router) + Tailwind v4 + shadcn on `@base-ui/react`.
  Dev server runs with `--webpack`; Turbopack is known-broken on this project's
  dynamic routes.

## Brand Commitments

The visual system is **pinned by the user** and is not open for re-derivation:

- **Racing red `#E10600`** as the single accent, under a strict restraint rule
  — LIVE state, score-change emphasis, goal markers, and at most one primary
  action. Never on borders, headers, links, generic hover, or decoration.
- **Archivo** as the sole typeface, its condensed width carrying scores and
  display numerals.
- A **near-black, three-layer** dark surface world (`#0A0D11` / `#12161C` /
  `#1A1F27`); depth comes from the steps between layers, not from borders.
- FotMob's restraint and layered calm is the **feel** reference only. Its
  layout, palette, and components are explicitly not to be copied.

## Evidence on Hand

- A working backend with real API-Football data and a live WebSocket feed.
- No club crests, no photography, no press or usage claims. Sample fixtures on
  the reference surface are **synthetic** and labeled as such.

## Product Principles

1. **The score is the product.** Everything else on screen is context for it.
2. **Calm by default, loud on change.** The surface stays quiet so that a goal
   can be the only thing that moves.
3. **A glance, not a session.** State must be readable without interpretation —
   no legend, no drill-down required to answer "what's the score."
4. **Red means live.** The accent is a status signal, never styling. Spending it
   on decoration destroys the only channel that carries urgency.
5. **Never invent football facts.** Fixtures, scores, crests and competitions
   come from upstream or are visibly marked as sample data.

## Accessibility & Inclusion

Status must never be encoded by color alone — every state carries a text label
alongside its color. Motion used for score changes must respect
`prefers-reduced-motion`. Target contrast is WCAG AA against the near-black
ground.
