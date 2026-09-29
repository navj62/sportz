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

It holds because the write cadence is far slower than the TTLs that matter. The
poller runs at 1200s live / 1800s idle against TTLs of 60s (matches), 300s
(standings) and 3600s (competitions), so the worst staleness a reader can see
is one TTL against data that changes at most every 20 minutes. Explicit
invalidation would buy an improvement nobody can observe.

One carve-out, corrected here after it was found overstated in the source
comments: **the competitions TTL of 3600s is longer than both intervals**, so
`/competitions` alone can serve up to three poll cycles stale. That was equally
true at the previous 900s interval — it is not drift from the retiming — and it
technically meets this entry's own trigger below. It is nonetheless accepted
rather than due, because the trigger is a proxy for a staleness someone can
observe, and the fields cached there (name, country, logo, and a `currentRound`
that advances weekly) do not move on a poll cadence. The one visible cost is
that a newly appearing competition can take an hour to enter the list. If that
ever becomes a complaint, the fix is to shorten that TTL, not to add
invalidation — the key-completeness argument below is unchanged by it.

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

## 12. The test suite shares the dev Redis, so cache tests can be contaminated — RESOLVED

**CONFIRMED 2026-09-04, and the source is worse than this entry assumed.** The
mechanism below was originally inferred from the failure shape and the absent
env var. It has now been observed directly, with one correction that matters:
the contaminating writer is not only *a locally running backend*. It is the
DEPLOYED stack, which shares this same Upstash instance and cannot be turned
off the way a local `npm run dev` can.

Evidence, captured while both named tests were failing:

- **No local backend was running** (`ps` clean), so the entry's stated
  precondition — "cache tests are only trustworthy with no local backend
  running" — was already satisfied, and the tests failed anyway.
- `KEYS sportz:cache:*` returned three live `competitions:list` entries,
  including the exact key the cold-cache test needs absent:
  `competitions:list:[["limit",100]]`.
- Their TTLs read 3256-3259 of 3600, putting the write minutes earlier, DURING
  the test run rather than left over from before it.
- The other two keys carry `["cursor",126]` and `["cursor",400]`. The test
  database truncates with `RESTART IDENTITY`, so its competition ids start at
  1. Cursors in the hundreds are production ids. The rows are not ours.

The collision is structural, not coincidental: `cacheKey` encodes the query
parameter set and nothing about which DATABASE answered it, so a production
`/competitions?limit=100` and a test one are the same key by construction. The
deployed frontend serving one page is enough to fail the suite for the next
hour, and the competitions TTL of 3600s is the longest in the app, which is why
these two tests are the ones that break.

Note the second-order effect on cleanup. `afterEach` deletes keys read off the
`cacheSet` spy, which is the right design — but a test that fails BECAUSE it
got an unexpected hit never called `cacheSet` for that key, so it has nothing
to delete. The suite cannot clean up the contamination that broke it.

This raises the priority of the fix below from tidiness to correctness of the
signal: `retry: 2` cannot help, because the contaminating value outlives every
retry. Until it is done, treat a `/competitions` failure in this suite as
unproven rather than as a regression, and check `KEYS sportz:cache:*` before
believing it.

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

**RESOLVED 2026-09-13.** Diagnosis above is kept verbatim — the
cacheKey-collision reasoning is what this entry exists to preserve, and
nothing about it was wrong. Only the fix landed.

Two new env vars, `TEST_UPSTASH_REDIS_REST_URL` / `TEST_UPSTASH_REDIS_REST_TOKEN`
(a second, separate Upstash database), redirected in `tests/setup.js` before
any module loads — the same mechanism as the `TEST_DATABASE_URL` redirect, one
dependency over. Documented in `.env.example`. Note the name landed as
`TEST_UPSTASH_REDIS_REST_URL` (mirroring the production var name exactly,
`TEST_` + `UPSTASH_REDIS_REST_URL`), not the `TEST_UPSTASH_REST_URL` this entry
originally proposed — the credentials were provisioned under the more
consistent name before the mismatch was caught, so the code was renamed to
match rather than the other way around.

Both real-Redis suites now gate their `skipIf` on `TEST_UPSTASH_REDIS_REST_URL`,
not `UPSTASH_REDIS_REST_URL`. This is the change that actually closes the hole:
the production var is set for anyone with a working `.env`, so gating on it
meant an unconfigured developer didn't skip — they silently ran the suite
against production. Both suites also gained a `beforeAll` host-hostname guard
mirroring the integration suite's Postgres guard, proving the redirect took
effect (not that the target is "safe" — a deliberately-misconfigured
`TEST_UPSTASH_REDIS_REST_URL` pointed at production would still pass it, the
same limitation the Postgres guard has always had).

Verification performed, differentially rather than by "the suite is green"
(the suite was already 224/224 before this fix — see below):

- **Contamination reproduced and fixed.** Wrote the exact colliding key,
  `sportz:cache:competitions:list:[["limit",100]]`, to the isolated TEST
  instance with a production-shaped value (ids 400/126, matching the cursor
  tell above) and the real 3600s TTL. Both named tests failed, by name, with
  the exact predicted signature — `GET /competitions: cold miss then warm hit`
  got `{hits: 2, misses: 0}` instead of `{hits: 1, misses: 1}`, and
  `caches /competitions for 3600s` saw `cacheSet` called 0 times — and the
  failure survived vitest's own `retry: 2`, confirming retries cannot outlive
  a poisoned value. Deleted the key; the suite returned to 224/224.
- **Guard mutation-tested.** Commented out the redirect assignment (the
  original no-op incident shape), printed the mutated region, `node --check`ed
  it, then ran both real-Redis suites against a fake test-instance URL: both
  refused in `beforeAll` with `Refusing to run: Redis points at
  stunning-urchin-164639.upstash.io, not the test instance
  fake-test-instance.upstash.io` — naming the production host, before any
  Redis command reached it. A control run first (redirect intact, same fake
  URL) showed the guard silent and the suite failing on ordinary connection
  errors instead, so the mutated run's failure is attributable to the guard
  specifically. Reverted; `shasum` confirmed byte-identical.
- **Skip path confirmed visible.** With the TEST vars unset: `191 passed | 33
  skipped (224)` — 12 from `redis.test.js`, 21 from `cachedReads.test.js` —
  plus a `tests/setup.js` warning on stderr naming both suites and the skip
  count. (First attempt used `console.warn` and printed nothing: vitest
  attaches intercepted console output to the running test, and a setupFiles
  line has no test to attach to once every test in the file skips. Switched to
  a raw `process.stderr.write`, which survives.)

Final state: 224/224 against the isolated instance, confirmed clean before and
after the reproduction.

---

## 13. Reconciled matches can carry a final score their events do not explain

**Trigger: moving off the API-Football free tier, or any change that gives the
poller spare daily quota.**

Reconciliation tier 2 (`confirmDepartures` in `src/services/liveSync.js`)
confirms a departed match against `/fixtures?date=` and writes back the real
final score. That endpoint does **not** embed events, unlike
`/fixtures?live=all`, which is the only reason one request can cover every
departure for a date at once.

So a goal scored after the last live poll lands in the corrected **score** but
never reaches the `events` table. A match can read 2-1 with one goal event. The
score is right — that is the whole point of confirming rather than inferring —
but the event list is a snapshot from whenever the fixture was last seen live,
and nothing later reconciles it.

This is the same class of accepted tradeoff as the backfill's stale scores
(`scripts/backfill-stuck-live-matches.js`), and it is strictly an improvement on
what preceded it: before tier 2 the score was wrong *and* the events were
stale. Now only the events are.

Closing it needs one `/fixtures/events?fixture=` request **per departed match** —
`fetchFixtureEvents` already exists and has no caller. That is per-match rather
than per-date, so it does not fit the budget: the free tier allows 100
requests/day and the current plan already spends 97 of them (72 live poll at
20 min + 24 worst-case confirm sweeps + 1 boot `/status`). A day with 30
departures would need 30 more.

Batching by id is **not** available as a cheaper route: `/fixtures?ids=` is
plan-gated on the free tier — verified against the live API, which answers
`{"plan":"Free plans do not have access to the Ids parameter."}` — and
`fetchFixtureById` is `?id=` singular, one request per fixture. A paid tier
unlocks `ids` (20 per request), at which point backfilling events for a sweep's
departures costs one or two requests and this becomes cheap to fix.

Until then the inconsistency is deliberate and bounded: it only affects matches
that ended between two polls, and only their event list.

---

## 14. Verification record: reconciliation against a genuinely suspended API

**Not deferred work. A record of a manual verification, kept because the
evidence otherwise lived only in conversation and in the README's constraints
section — and it is the kind of claim that should be checkable from the repo.**

**Trigger to re-run: any change to either reconciliation tier, or the upstream
account being restored** — a live account is the one condition this run could
not cover, since it verified the degraded path specifically.

The API-Football free-tier account has been suspended three times, most recently
after consolidating to a single account on their support's instruction. That
turned an awkward outage into the exact test the two-tier design was built for:
a feed that returns nothing, where a naive "absent means finished" pass would
have marked all 885 matches finished at once.

Run against the suspended account, with a live match seeded at 9h old and
another at 1h old. Five results, all PASS:

1. Tier 1 flipped the 9h row to `finished` **despite the API call failing**.
2. Tier 1 left the 1h row `live`.
3. No score was invented on the flipped row — it kept its last-observed value.
4. `end_time` stayed NULL on the flipped row.
5. Tier 2 did not run at all on the failed cycle.

**Each result is what the mechanism predicts, which is the point of recording
them together.** `reconcileStaleLiveMatches()` is called before
`syncLiveFixtures()` inside `pollLiveFixtures`, so a throwing fetch cannot stop
it (1); `RECONCILE_STALE_LIVE_CUTOFF_HOURS` is 6 (2);
`markStaleLiveMatchesFinished` issues `.set({ status: 'finished' })` and nothing
else, which is what leaves both the score and `end_time` alone (3, 4); and
`confirmDepartures` is reached only from inside `syncLiveFixtures`, after the
fetch and after the empty-payload early return, so a failed cycle never reaches
it (5).

Result 4 is the one worth keeping in mind. A NULL `end_time` is not missing
data: it is the tier 1 floor correctly declining to claim it observed a finish
it only inferred. Only a tier 2 confirm writes that column. Anything that starts
populating `end_time` from the floor has broken the column's meaning, and this
run is the record of what it meant.

**Provenance: run by hand by the repo owner, not reproduced in CI.** There is no
automated equivalent, because the suspension is not something the suite can
manufacture. The nearest automated coverage is `tests/liveSync.test.js`, which
drives the same branches with a mocked fetch — that proves the wiring, where
this proves the behaviour under a real dead upstream.

---

## 15. Replacing API-Football, and paying for it — BOTH EVALUATED AND DECLINED

**Not deferred work, and not a wish. A decision record, kept because the
decision was to change nothing — and an entry that says "we looked and chose to
stay" is the only thing that stops a future session re-running the same
evaluation from the same headline numbers.**

Two separate questions were asked and both were answered no: *migrate to a
higher-quota provider* (no — see the economics below) and *pay API-Football for
~7,500 requests/day* (no — not justified for a portfolio project, reasoning at
the end of this entry).

**Trigger to re-open the migration question: a provider that embeds events in a
single all-live request.** Not a bigger headline quota — that is the whole reason
this pass ended where it did.

**Trigger to re-open the paid question: the project acquiring real users, or
suspensions making the free tier unusable rather than merely slow.** Both of
those change the cost side of a tradeoff that currently resolves against paying.
Freshness alone is not a trigger — the 20-minute interval is a known, accepted
consequence, not an oversight.

### Why the pass happened

The free-tier account has been suspended three times across two accounts and
two machines, each within about a day of real polling, under compliant usage —
roughly 96 requests/day against a 100/day cap, on a single account, after their
support instructed the consolidation. Entry 14 is the verification record from
the most recent suspension. The 100/day cap also pins knowledge freshness to the
poll interval the quota forces, which is the second motivation: 15-20s polling
was never affordable.

Two candidates were evaluated against current official documentation, plus one
sampling request. Both were rejected.

### The finding that decided it: cycle cost, not daily quota

`/fixtures?live=all` **embeds events**, so one cycle costs **one request**
regardless of how many matches are live. This is already recorded in CLAUDE.md
as an architectural constraint; what this pass established is that it is also
the single most valuable property of the provider, and that neither candidate
has it.

Both candidates serve events **per match**:

- SportScore — timeline only on `/api/widget/match/?sport=&slug=`, one request
  per match
- SportSRC V2 — `?type=incidents&id={match_id}`, one request per match, at every
  price tier

So a cycle costs `1 + N` rather than `1`. The value of `N` is already recorded
in this repo: `fetchFixtureEvents` in `src/services/apiFootball.js` carries the
note that one call per live fixture "would cost ~47 requests a cycle", which is
the observed concurrent-live-fixture count here. That makes a cycle 48 requests:

| Provider | Headline quota | Cost per cycle | Affordable cycles/day |
|---|---|---|---|
| SportScore | ~10,000/day *(disputed, see below)* | 48 | **~208** |
| SportSRC V2 Starter | 10,000/day ($9.99/mo) | 48 | **~208** |
| API-Football paid | 7,500/day | 1 | **7,500** |

The exact figure moves with concurrency — at 40 concurrent matches a 10,000/day
quota buys ~250 cycles, at the repo's observed 47 it buys ~208 — but the order
of magnitude is the finding, and it does not move.

**A headline quota 33% larger buys roughly 36× fewer cycles.** Comparing daily
request allowances was comparing the wrong number: the constraint is requests
per cycle, and embedded events are worth more than any quota either candidate
offers. ~208 cycles/day will not sustain continuous polling through a single
European evening. On the disputed low reading of SportScore's quota (1,000/day)
it lands at ~20 cycles/day — far worse than the 100/day free tier this pass set
out to escape.

The comment in `apiFootball.js` means the 1+N cost was already understood here
as a reason not to call the standalone events endpoint. What this pass adds is
that it is also the correct axis for comparing *providers* — and that on that
axis both candidates lose to the incumbent before any other property is weighed.

### SportScore — four further disqualifications, each independent

1. **No id field. Identity is a URL slug.** The sampled match object carries
   `url: "/football/match/gimnasia-jujuy-vs-san-martin-tucuman/"` and no id of
   any kind. `matches.externalId` is the `onConflictDoUpdate` target in
   `src/services/matchService.js`, so two fixtures between the same teams in one
   season — a league double-header plus a cup tie — would **silently merge into
   one row**. Not an error, not a duplicate: a merge. Silent corruption is worse
   than a loud failure, and the column being `text().unique()` means nothing
   would reject the slug on the way in.
2. **Permission is unverifiable.** The site-wide Terms of Use forbid commercial
   use, forbid "extraction (copying) or utilisation (making available to the
   public) of Database Content", and forbid burdening the server "with automated
   requests". A separate API Terms of Use exists at `/developers/terms/` and
   presumably grants the consent the site terms withhold — it is behind a
   Cloudflare managed challenge and could not be read. Deploying a public app on
   permission that cannot be read is not acceptable.
3. **`limit` caps at 50 and there is no date parameter.** No by-date endpoint,
   no by-ids endpoint, no per-competition fixtures endpoint. The entire global
   view is one call capped at 50 matches with undocumented ordering, so a
   finished match can fall out of the window with no recovery path. That is the
   885-stuck-matches failure mode with the escape hatch removed — and the
   two-tier reconciliation in entry 14 exists precisely because that hatch
   matters.
4. **No elapsed minute, and 15-20s polling is impossible anyway.** The sampled
   payload has `status`, `status_text` and a kickoff `time`, no elapsed field —
   so the one genuine upgrade motivating the pass is absent. Separately, the
   response carries `cache-control: public, max-age=60`, so polling faster than
   60s returns cached data. The faster-polling goal is unreachable on this
   provider at any quota.

Two smaller notes, recorded so they are not rediscovered: SportScore serves no
`X-RateLimit-*` headers at all, so quota consumption is unobservable — worse
than API-Football, which reports remaining quota; and every asset URL points at
`img.thesports.com` while `get_tracker` takes a "numeric match id from the
upstream provider", so SportScore is a reseller of a third-party feed rather
than a primary source.

### SportSRC V2 — disqualified on the free tier outright

**Events are Premium-only.** The free plan card reads `1,000 req/day` /
`Schedules & Scores` / `Stream Embeds` / `No Deep Data`, and `?type=incidents`
sits under the heading "Deep Data (Premium Only)". Free access is two football
endpoints: `?type=matches` and `?type=detail`, the latter covering timeframe,
scores, venue and stream URLs — no events. That takes out `routes/events.js`,
`routes/commentary.js`, `eventService.js` and the `replaceMatchEvents` path in
`liveSync.js`.

Three further findings, which would apply on a paid tier too:

- Their recommended cadence exceeds their own free quota. They advise polling
  every 15-30s; at 30s that is 2,880 requests/day against a 1,000/day cap.
- The free quota has already been cut unilaterally — release v2.4.5 "adjusted"
  it to 1,000/day. The headline number has precedent for moving down.
- **There is no published Terms of Service.** The footer links labelled Terms of
  Service and Privacy Policy carry no `href`; five candidate paths all return
  the byte-identical homepage. The only legal text is a disclaimer describing
  the service as aggregation that accepts no responsibility for "accuracy,
  copyright compliance, legality". Their own release notes describe a scraping
  engine with "proxy rotation", which is the same fragility that caused the
  suspensions here, one layer removed.

### Decision: stay on API-Football, on the free tier

Two decisions, taken together.

**Not migrating.** The cycle economics above are the reason, and they hold at
every quota reading either candidate offers. Beyond that, staying preserves two
things a migration would spend:

- **Zero migration cost.** No files touched. The adapter, the event vocabulary,
  and every trap already handled stay working.
- **Zero re-discovery cost.** The expensive part of the original integration was
  not writing HTTP calls, it was learning what the real responses contain: HTTP
  200 on failure with a polymorphic `errors` field; `type: 'Goal'` containing
  Normal Goal, Penalty, Own Goal *and* Missed Penalty; `Var` + "Goal Disallowed"
  being a retraction; shootout kicks filed as ordinary goals at minute 90 and
  needing the exact `metadata.comments === 'Penalty Shootout'` marker. That
  knowledge is provider-specific and has real value. Migrating discards it and
  buys an unknown set of equivalent traps in exchange.

**Not paying either.** The paid tier — roughly $20/month for about 7,500
requests/day — was costed and declined. It is the technically better option and
carries zero migration cost, so this is purely a value judgement: a recurring
subscription is not justified for a portfolio project with no users. The paid
option is recorded here precisely because it is attractive on the merits; the
reason it was declined is cost, not any defect, and that distinction is what
stops the question being reopened on the wrong grounds.

**What staying on free costs, stated plainly.** This pass was motivated by two
problems, and the decision solves neither:

1. **Freshness stays capped.** The 100/day cap forces
   `LIVE_SYNC_INTERVAL_MS=1200000` — 20 minutes. The 15-20s polling that
   motivated the evaluation is unaffordable on free and remains so. For
   reference if the paid question is ever reopened: on 7,500/day, 20s costs 4,320
   requests/day and 15s costs 5,760, both inside budget, while 10s costs 8,640
   and does not fit — so 15s would be the floor. `LIVE_SYNC_IDLE_INTERVAL_MS` is
   1800000 and would need no attention, staying far above any live value in that
   range.
2. **Suspension risk stays.** All three suspensions happened on free accounts,
   under compliant usage. Nothing in this decision reduces that risk; it accepts
   it. What makes accepting it survivable is that the mitigation is already
   built: the two-tier reconciliation recorded in entry 14 was verified against a
   genuinely suspended account, and is the reason a dead upstream degrades
   instead of marking 885 matches finished at once. **That mitigation is now
   load-bearing rather than defensive** — anything that weakens
   `reconcileStaleLiveMatches` or the tier-1/tier-2 split is removing the only
   thing standing between a suspension and visible data corruption.

Both costs are accepted knowingly. Neither is a defect to be fixed, and neither
is a reason to reopen on its own — see the triggers at the top of this entry.

**What was *not* the reason.** Rejecting the candidates was not inertia, and not
a judgement that they are low quality; both were rejected on measured properties.
Declining the paid tier was not a judgement that the free tier is adequate — it
demonstrably is not, on freshness or on reliability. The mistake worth not
repeating is the one that started the pass: treating the daily request allowance
as the figure of merit when the binding constraint is the cost of a single poll
cycle.

**Provenance and limits of this record.** Phase 1 (documentation verification)
plus one sampling request to SportScore's live endpoint; Phase 2 sampling was
deliberately not run, because the economics finding settles the question without
it. No code was written and nothing under `src/` was changed. Everything
asserted about SportSRC comes from its own current docs, read in full.
Everything asserted about SportScore's response shape comes from a real sampled
payload. **Two SportScore claims remain unverified** and would need a browser to
settle, since Cloudflare blocks non-browser clients from `/developers/`: the
free-tier quota, where the public docs page says ~10,000/day while SportScore's
own MCP server README says ~1,000/day; and the API Terms of Use. Neither changes
the decision — the cycle-cost finding holds at both quota readings.
