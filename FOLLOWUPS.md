# Followups

Deferred work from the backend rebuild. Each entry says what was deferred, why
deferring was the right call, and the trigger that makes it due — a followup
without a trigger is a wish, not a plan.

Nothing here is a known defect. These are decisions taken deliberately with the
conditions that would reverse them written down.

---

## 1. Lock `pollStandings` before enabling standings sync

**Trigger: setting `STANDINGS_SYNC_ENABLED=true`.**

`pollLiveFixtures` is guarded by a distributed lock; `pollStandings` is not.
Standings sync is gated off by default, so locking it now would guard a code
path that never runs.

It matters more than the live poller when it does run: standings spend one
request **per competition** per cycle, so an unguarded multi-instance deploy
double-burns proportionally to the competition count, against a 100 req/day free
tier. Give it the same `acquireLock`/`releaseLock` treatment as
`pollLiveFixtures` — including the `finally` and the skip-only-on-`'held'`
semantics — in the same change that flips the flag, not after.

See the FOLLOWUP comment on `runStandingsCycle` in `src/services/liveSync.js`.

---

## 2. Remove the deprecated `/matches/:id/commentary` alias

**Trigger: the frontend no longer calling it.**

`src/routes/commentary.js` reads the events table and synthesizes the `message`
string the existing frontend feed expects. The commentary table itself is gone.
`GET /matches/:id/events` is the canonical endpoint.

The alias exists only so the frontend keeps working across the rebuild. Once the
frontend reads `/events`, delete the route, its registration in `src/app.js`,
`src/validation/commentary.js`, and `listCommentaryFromEvents` in
`src/services/eventService.js`. The alias is covered by tests, so removal should
be test-driven from the other direction — delete the tests with it.

Marked `DEPRECATED: remove in frontend phase` at both the route and its `app.js`
registration.

---

## 3. Drop the unused default export in `src/routes/matches.js`

**Trigger: any edit to that file — it is a two-line cleanup.**

`matchesRouter` is exported twice: as a named export (line 6) and again as
`export default matchesRouter` (line 39). `src/app.js` imports the named one,
and every other router module exports named-only. The default export is dead and
inconsistent with its siblings.

Left alone so far because touching it is pure churn on its own; fold it into the
next real change to the matches route.

---

## 4. Stoppage time is stored but never used

**Trigger: an endpoint or UI needing correct within-minute event ordering.**

`mapFixtureToEvents` sets `minute` from `event.time.elapsed` only.
`event.time.extra` is preserved, but as `metadata.extra` — not in `minute`, and
not in any index.

The consequence is ordering, not data loss: the events index is
`(match_id, minute)`, so a 90+3 event and a 90th-minute event share `minute: 90`
and sort ambiguously against each other. Fine for a feed that renders in
arrival order; wrong for anything claiming chronological accuracy within
stoppage time.

Fixing it properly means deciding whether `minute` becomes a sortable composite
or `extra` joins the index — a schema migration either way, which is why it was
not done inline.

---

## 5. Revisit the `ABD` → `cancelled` status mapping

**Trigger: upstream evidence that abandoned matches resume, or a product
decision to distinguish them.**

`src/services/apiFootball.js` maps `ABD` (Abandoned) to `cancelled` rather than
`postponed`, on the reasoning that an abandoned match does not resume, making
`cancelled` the closer semantic match. `PST` alone maps to `postponed`.

This is a judgment call about upstream semantics, not a fact — recorded here so
that if abandoned matches turn out to be replayed in practice, the decision is
findable rather than archaeology. `postponed` and `cancelled` are both real enum
values in the schema, so changing the mapping needs no migration.

---

## 6. `npm audit` — 13 advisories, 4 needing a breaking upgrade

**Trigger: before any production deploy; re-check on dependency bumps.**

As of the Redis/WebSocket pass: **1 high, 11 moderate, 1 low.**

Nine resolve with a non-breaking `npm audit fix` — `postcss` (high),
`body-parser` (low), and the `arcjet` / `@arcjet/*` / `typeid-js` / `uuid`
moderate chain.

Four do not: `esbuild`, `@esbuild-kit/core-utils`, `@esbuild-kit/esm-loader` and
`drizzle-kit` itself, all fixable only by downgrading to `drizzle-kit@0.18.1` —
a major, and *backwards* from the current 0.31.x. These are dev-only
(`drizzle-kit` is a devDependency; the esbuild advisory concerns its dev server)
and do not ship in the runtime image, which is why the downgrade was refused
rather than taken.

Do not run `npm audit fix --force` — it is what performs that downgrade.

---

## 7. Widen observability beyond the database

**Trigger: the observability pass.**

`GET /health` checks Postgres with `SELECT 1` and reports `{ status, db }`. It
says nothing about Redis, and Redis is now load-bearing for poll coordination.

Deliberately not widened yet, because a health check that fails on Redis being
down would contradict the whole graceful-degradation design — the app is built
to run correctly with Redis unreachable, so Redis must never be able to make
`/health` return 503. Any widening has to report Redis as an **advisory** field
(`redis: 'ok' | 'unreachable' | 'disabled'`) that leaves the top-level status
governed by the database alone.

Also unexposed: cache hit/miss rates, and how often the poll lock is skipped
(`'held'`) versus proceeding uncoordinated (`'error'`). That last pair is the
one worth having — a rising `'error'` rate is the only signal that the lock has
silently stopped coordinating anything.
