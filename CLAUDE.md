# Sportz — backend

Express 5 + Postgres (Drizzle) service that polls API-Football for live
football fixtures, persists them, and pushes score updates over WebSocket.
Read-only public HTTP API. `client/` is a separate Next.js frontend with its
own CLAUDE.md — this file covers the backend only.

## Architecture

`routes → validation (zod) → services → drizzle/pg`

- **Services own DB access.** There is no repository layer; each `*Service.js`
  calls `db` directly. Don't add one.
- **`liveSync.js` is the sole writer.** It is the only caller of
  `upsertMatches` / `upsertCompetitions` / `upsertStandings` /
  `replaceMatchEvents`. If data needs to change, it changes there.
- **Every HTTP route is a GET.** No write endpoints, and no auth — both
  intentional (see Deliberate decisions).
- **Public reads go through a TTL-only cache**, applied in the services via
  `withCache`. `liveSync` writes invalidate nothing, so staleness is bounded by
  the TTL — always far shorter than the poll interval. The deprecated
  commentary alias is deliberately uncached.
- **One `/fixtures?live=all` request yields fixtures, leagues AND events.**
  Competitions and events fall out of that single payload; neither is fetched
  on its own. Adding a per-fixture request multiplies quota cost by the number
  of live matches.
- WebSocket lives at `/ws`. `broadcastLiveScores` filters each socket's
  matches by its subscription set — but an **empty** set means **all**
  matches, not none; only a non-empty set narrows to those match ids. Nothing
  in the frontend ever sends a `subscribe` frame, so every production socket
  has an empty set — the list page's live updates depend on empty-means-all.
  Do not "fix" this to empty-means-none. See `subscribedMatches` in
  `src/ws/server.js`.

## Hard invariants

Violating these breaks the app or its guarantees.

**Env is read lazily, inside functions — never at module load.**
`getApiKey()`, `isRedisEnabled()`, `readConfig()`, and `db.js`'s `init()` all
defer the read. This keeps every module side-effect free to import, which is
what lets unit tests run with no credentials in the environment. The only
importable modules that read env at load are `arcjet.js` and `logger.js`.
(`index.js` does too, but it is the entrypoint and is never imported.)

**`db.js` is the model for this rule, not an exception to it.**
It defers *both* pool construction and the `DATABASE_URL` read to first
property access through a Proxy, and it deliberately does **not** import
`dotenv/config`. Reading env eagerly there is what once bound the pool to the
production `DATABASE_URL` and let the test suite truncate the production
database. Do not "simplify" the Proxy away, and do not add `dotenv/config` to
it.

**`dotenv/config` is loaded only by process owners:** `src/index.js`,
`drizzle.config.js`, `tests/setup.js`. Loading it from a deeper module lets
`.env` silently repopulate a var the caller just overrode.

**The test suite must run against the test DB.** `tests/setup.js` redirects
`DATABASE_URL` to `TEST_DATABASE_URL`, and the integration suite's `beforeAll`
compares the two hostnames and throws rather than run. That guard exists
because the redirect once silently no-opped. Never weaken it.

**Suites that TRUNCATE share one test database, so test files run
serialized.** `fileParallelism` is off in `vitest.config.js` for exactly this
reason: two truncating suites running in parallel wipe each other's rows
mid-test, and the failures read as assertion bugs rather than interference —
each file passes alone and fails alongside the other. A new truncating suite
either inherits that serialization or needs its own database.

**Redis helpers never throw.** Graceful degradation is contractual: every
helper in `src/redis/client.js` catches, warns, and returns a safe value. A
caller must never need a try/catch around one.

- `cacheGet` must not `JSON.parse` — the Upstash REST client already
  deserializes on read, so a parse would throw on every object.
- `releaseLock` is compare-and-delete via Lua, not `DEL`. A bare `DEL` deletes
  another holder's lock once ours has expired. The token must be a **string**;
  Lua compares raw stored bytes, and the client JSON-encodes non-strings.

**Upserts are idempotent; events are snapshot-replace.** Matches, competitions
and standings upsert on their natural keys and can re-run on unchanged data.
Events are delete-then-insert for the match inside one transaction — upstream
events carry no stable id, and a composite key would both duplicate rows (NULLs
compare distinct in Postgres) and strand VAR-retracted events forever.

**API-Football returns HTTP 200 on failure.** The envelope's `errors` field is
polymorphic: `[]` on success, an *object* keyed by error kind on failure. A
`.length` check silently passes the failure shape. Always go through
`collectErrors()`.

**The idle poll interval must stay longer than the live one.** Otherwise idling
costs more daily quota than being live, which inverts the whole sizing model.

## Deliberate decisions — do not "fix" these

- **No auth.** The API is read-only and public by design.
- **Standings sync is off** unless `STANDINGS_SYNC_ENABLED` is exactly the
  string `'true'`. The free tier cannot read current-season standings, and it
  costs one request *per competition per cycle*.
- **`pollStandings` is not lock-guarded**, unlike `pollLiveFixtures` — a lock
  would guard a path that never runs. Before enabling standings sync, give it
  the same `acquireLock`/`releaseLock` treatment first — see `FOLLOWUPS.md`.
- **Single-instance deploy**, so no Redis Pub/Sub; WebSocket broadcast is
  in-process.
- **`acquireLock` returns `acquired: true` when Redis is disabled**, with
  `reason: 'disabled'` and a null token. Granting is correct — there is no
  second contender, and denying would mean the guarded work never runs. The
  reason is not `'acquired'` because there is no lock to hand back.
- **`pollLiveFixtures` skips only on `reason === 'held'`.** `'error'` proceeds:
  an unreachable Redis proves nothing about contenders, and a duplicated
  request is cheaper than a missed cycle (the writes are idempotent).
- **Shutdown does not await an in-flight poll.** The lock TTL is the *expected*
  reaper on a normal shutdown, not just a SIGKILL backstop. Awaiting the poll
  would delay every SIGTERM for no correctness gain — fencing plus TTL cover it.
- **`/health` is registered before the security middleware**, so it is exempt
  from rate limiting.
- **`/matches/:id/commentary` is deprecated but live.** The commentary table is
  gone; the route reads `events` and synthesizes the `message` string the
  frontend still expects. `/matches/:id/events` is canonical; removal is
  tracked in `FOLLOWUPS.md`.
- **`events.type` is `text`, not an enum**, so a new upstream event type needs
  no migration.

## Conventions

- **ESM with mandatory `.js` extensions** on relative imports.
- **Named exports** are the norm. Only `arcjet.js` and `matchesRouter` have a
  `export default`, and the latter also exports by name — follow the named form.
- **`*Service.js` suffix for domain services only.** Integrations
  (`apiFootball.js`) and orchestrators (`liveSync.js`) do not take it.
- **pino is object-first, message-second:** `logger.info({ key }, 'message')`.
  Reversed, the object is swallowed.
- **Never log credentials.** `initRedis` logs the Upstash *host* only, never the
  URL or token.
- **Migrations:** edit `src/db/schema.js`, then `npm run db:generate`, then
  `npm run db:migrate`. Never hand-write files into `drizzle/`.
- **Test seams are explicitly named** with a `__…ForTests` suffix
  (`__resetRedisClientForTests`, `__pollOnceForTests`) so they are obviously not
  production API.
- **Style: match the file you are editing.** `src/db/` and `src/validation/` are
  2-space; everything else is 4-space. Quote style varies per file. There is no
  linter or formatter at the repo root, so nothing will correct you.

## Workflow rules

These come from things that have actually gone wrong here.

- **Verify claims against the code, including claims in this file.** A previous
  CLAUDE.md drifted from the implementation and actively misled work. If you
  cannot point at the file and line that makes a statement true, treat it as
  unverified.
- **Run the full suite and report actual pass/skip/fail counts.** Both the
  integration and real-Redis suites `skipIf` on a missing env var, so a green
  summary can mean nothing ran. A vacuous pass is a silent failure.
- **Mutation-test safety-critical code.** Break the guard deliberately, confirm
  the *right* test fails *by name*, then revert and confirm byte-identical.
  Assert on mechanism, not just outcome — a second code path can produce the
  same outcome and hide a deleted guard. Before trusting a "survived" result,
  print the mutated region to prove the change actually landed — an unapplied
  mutation (wrong indentation, a pattern that didn't match) and a genuinely
  surviving mutation both read as "all tests still pass," and are otherwise
  indistinguishable. The same shape applies to configuration — an unsupported
  or misspelled option no-ops silently — so demonstrate the mechanism engaging
  before crediting a fix to it.
- **Any script that mutates a database must print which database it targets
  before doing so.**
- **Recon first on non-trivial changes.** Surface contradictions before writing
  code rather than resolving them silently.

## Known gaps

- **`cacheDel` has no production caller.** Invalidation is TTL-only by design
  (see the cache layer and `FOLLOWUPS.md`), so nothing in `src/` deletes a cache
  entry. It is implemented and tested; don't assume it is dead code.

## Where things live

- Deferred work and follow-ups: `FOLLOWUPS.md`
- Every env var, with defaults and how to obtain each: `.env.example`
- Migrations and their journal: `drizzle/`
