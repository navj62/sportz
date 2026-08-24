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

## 7. Widen observability beyond the database — RESOLVED

**Kept here, struck through, because half of it was resolved by a DECISION
rather than by code. Deleting the entry would invite a future session to
re-open it as "we forgot to add Redis to /health."**

The observability half is **built**. `GET /debug/stats` reports cache hit/miss
health, poll-lock outcome counts including the `'held'` versus `'error'` split,
and Redis reachability. It is env-gated behind `DEBUG_ENDPOINTS_ENABLED`.

The `/health` half was **decided against, not deferred**. This entry used to
call for an advisory `redis` field on `/health`. That is now explicitly not
wanted, and the reasoning lives in CLAUDE.md under Deliberate decisions so it
is read before anyone touches the route:

`/health` is a liveness probe. Its question is "can this app serve requests",
which means "can it reach Postgres" — its only real dependency. Redis is
optional by design. An advisory field satisfies the letter of "Redis must never
make /health return 503" while defeating it in practice: a measured Upstash
ping costs roughly 800ms, and a platform probe with its own timeout would mark
the service unhealthy on Redis latency alone. The cleanest guarantee that Redis
cannot fail the health check is that the health check never touches Redis.

Nothing is lost by leaving it out. A Redis outage shows up on `/debug/stats` as
a hit rate collapsing to zero and a climbing lock error rate — a sharper signal
than an up/down boolean, because it says whether the failure is affecting
anything.

---

## 8. Explicit cache invalidation on write

**Trigger: the live poll interval dropping below the cache TTL, a writer other
than `liveSync` appearing, or a product requirement for sub-TTL freshness.**

The read cache added in the caching pass is TTL-only: `liveSync` writes to the
database and nothing tells the cache. That is a decision, not an omission, and
`src/redis/cache.js` documents it at the point where someone would go looking
for the missing invalidation.

It holds because the write cadence is far slower than any TTL here. The poller
runs at 900s live / 1800s idle against TTLs of 60s, 300s and 3600s, so the
worst staleness a reader can see is one TTL against data that changes at most
every 15 minutes. Explicit invalidation would buy an improvement nobody can
observe.

The reason it is not merely unnecessary but actively risky: cache keys encode
the FULL query parameter set, so there is no bounded list of keys to delete
after a write. `/matches` alone varies over five dimensions, and every distinct
filter combination a client has issued is its own entry. An invalidation that
clears four of five variants is a silent stale-read bug — precisely the
key-completeness failure the whole-object keying was designed to make
impossible, reintroduced on the write side where it is much harder to test.

Doing it properly means one of:

- a prefix scan and delete (`sportz:cache:matches:*`) after each write cycle,
  which is coarse but has no enumeration problem; or
- tracking written keys in a Redis set per namespace, and clearing the set on
  write — more precise, more moving parts, and the set itself can drift.

Prefer the prefix scan if this becomes due. Do not hand-enumerate key variants.

Diagnose with `GET /debug/stats` before reaching for this: a staleness
complaint is very hard to read without knowing whether the cache is being
served from at all, and a `never-hit` status means the problem is the opposite
of stale data.

---

## 9. Cap per-socket subscriptions before the frontend starts subscribing — RESOLVED

**The trigger fired and the cap shipped.** The match detail page now sends
`subscribe` / `unsubscribe` frames (`subscribeToMatch` in `client/lib/ws.ts`),
so the handler became reachable in production, and
`MAX_SUBSCRIPTIONS_PER_SOCKET = 20` now guards it in `src/ws/server.js`. At the
cap the frame is refused with an `error` rather than dropped silently, and a
re-subscribe to an id already held is exempt so a client replaying intent after
a reconnect is not punished for asking for what it has. Five tests cover it,
mutation-tested in both directions.

The reasoning below is kept because the sizing argument is the part that will
matter if the pattern ever changes — the cap is generous against ONE
subscription per detail page and none for the list, and a list view that ever
opted in would need roughly one per visible row.

**Trigger (fired): the frontend beginning to send `subscribe` frames.**

Nothing limits how many match ids one socket may subscribe to.
`socket.subscriptions` and the module-level `matchSubscribers` both grow for
every accepted frame, so a client that loops on `{"type":"subscribe"}` with
rising ids grows server memory without bound.

Arcjet does not cover this. It rate-limits the **upgrade** (5 per 2s in
`wsArcjet`), not messages on a socket that is already open, and `maxPayload`
bounds the size of a single frame rather than how many arrive.

It is unexploitable today, which is why it is deferred rather than fixed: no
part of the frontend sends a `subscribe` frame at all — its `subscribe()`
registers a local listener and never touches the wire — so no path reaches the
handler in production.

It is deferred rather than fixed *now* for a second reason: the right cap
depends on a subscription pattern that does not exist yet. The detail view
needs one subscription; a list view that ever opts in would need roughly one
per visible row. Picking a number before that design exists means guessing, and
a cap set too low fails users while looking like a bug.

Add it in the same change that starts sending subscribe frames, before that
change deploys — not after. Same shape as followup 1: a guard deliberately left
off a path that cannot currently be reached, with the trigger that makes it
due written down.

---

## 10. Decide how the network-bound suites run in CI

**Trigger: setting up CI.**

`redis.test.js`, `cachedReads.test.js` and `integration.test.js` all make real
round trips to hosted free-tier services — Neon in ap-southeast-1 and Upstash.
Locally that is handled by `testTimeout: 20000` plus `retry: 2` scoped to the
two Upstash-dependent suites, and by `fileParallelism: false` because two
suites TRUNCATE the same database.

That is a local-development fix and it will not be enough in CI, which is
likely to be slower, further from both services, and subject to the same
free-tier limits from a shared address. Turning the knobs further is the wrong
answer: a suite that only passes because it retries enough is not a suite.

The two real options:

- **Local services.** A Redis container plus a second test database per run.
  This also removes the reason `fileParallelism` is off, so it is the option
  that buys back run time as the suite grows — currently 50-80s serialized.
- **Gate them.** Skip the network suites in CI behind an env flag and run them
  on a schedule or before release, leaving CI to cover the pure-unit suites.
  Cheaper, but it means the cache-enabled path — whose only automated coverage
  is `cachedReads.test.js` — stops being checked per commit.

Prefer local services if the CI setup can afford them; the gating option
quietly weakens exactly the coverage that was hardest to build. Decide at CI
setup, not before.

**This has already been observed, not merely predicted.** During the
observability pass a cold Neon instance turned a 50-80s suite into a **90
minute** run with seven failures, none of them real: a bare `SELECT 1` was
measured at 2689ms against the 0.4-1s seen when warm. It recovered on its own
within a few runs. Note the interaction with `testTimeout: 20000` — raising the
timeout was right, because healthy remote latency was overrunning a 5s budget,
but it also means a genuinely degraded database now takes roughly four times as
long to fail. That is the timeout's real cost, and it is why turning these
knobs further is not the answer in CI.

---

## 11. `GET /matches` has no `competitionId` query param

**Trigger: the match list needing to filter beyond the live sweep.**

`listMatchesQuerySchema` accepts `limit`, `cursor`, `status`, `startTimeFrom`
and `startTimeTo` — no `competitionId`. `listMatches` never destructures one,
so a client that sends it has it stripped by Zod, silently, exactly as the
removed `sport` param was.

The home page therefore filters by competition **client-side**, over the whole
live list it already sweeps (two or three requests at `limit=100`). That is
correct while the surface only ever filters live matches, because the sweep is
complete — but it does not extend to scheduled or finished, which are
paginated, where a client-side filter would only ever see the loaded page.

Add the param — destructure in `listMatches`, add to the schema, and note the
whole-`params` cache key picks it up by existing — if the list ever filters
beyond the live sweep.

*(Carried unrecorded since the home-page pass; recorded here after the fact.)*

---

## 12. The test suite shares the dev Redis, so cache tests can be contaminated

**REASONED, NOT CONFIRMED.** The mechanism below is inferred from the failure
shape and the absent env var; it was not proven, because the running backend
could not be cleanly stopped to test the hypothesis in isolation. Treat it as
the leading explanation, not a diagnosis.

`tests/setup.js` redirects `DATABASE_URL` to `TEST_DATABASE_URL`, and the
integration suites refuse to run if that redirect did not take. **There is no
equivalent for Redis.** `.env` defines `UPSTASH_REDIS_REST_URL` /
`UPSTASH_REDIS_REST_TOKEN` and nothing else, so the suite and a locally running
backend read and write the same Upstash instance and the same cache keys.

Observed during the live-behaviour pass: two failures in
`tests/cachedReads.test.js`, both on `/competitions` —

- `GET /competitions: cold miss then warm hit` — expected `{ hits: 1, misses: 1 }`,
  got `status: 'cold'`
- `caches /competitions for 3600s — near-static data` — the `cacheSet` spy was
  never called with the 3600 TTL

Both are assertions about a **cold** cache. A dev backend that has served
`/competitions` leaves that key warm for its 3600s TTL, at which point the
service under test finds a hit, never calls `cacheSet`, and the counters never
show the expected miss. That fits both failures exactly.

Note what makes this hard to notice: the failures reproduce with unrelated
changes stashed, so they read as pre-existing flakiness — and they overlap with
followup 10's cold-Neon latency story, which is a *different* cause with a
similar signature. They are not the same problem: this one is contamination
from a shared key, not slowness.

The fix is an isolated `TEST_UPSTASH_REST_URL` / `TEST_UPSTASH_REST_TOKEN` pair
redirected in `tests/setup.js` exactly as `TEST_DATABASE_URL` is, ideally with
the same refuse-to-run guard comparing hosts — the database redirect exists
because it once silently no-opped, and this is the same failure mode one
dependency over. A key prefix per run would also work and needs no second
instance, but it leaves the two processes sharing an eviction budget.

Until then: cache tests are only trustworthy with no local backend running.
