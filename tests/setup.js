// Load .env HERE, before the redirects below. Vitest does not read .env itself,
// so without this TEST_DATABASE_URL is undefined at setup time, the redirect
// silently no-ops, and the pool binds to whatever DATABASE_URL is already in the
// environment — the real one. The suite then runs, and TRUNCATEs, against the
// production database. dotenv does not overwrite vars that are already set, so
// loading it here and reassigning below is safe.
import 'dotenv/config';

// Redirect DATABASE_URL to the test database before any modules are loaded.
// vitest runs setupFiles in the worker process before test file imports are
// evaluated, so db/db.js will pick up the updated env var when it first runs.
if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

// Redirect the Upstash vars to the ISOLATED test instance — same mechanism as
// the database redirect above, one dependency over, for the same class of
// reason.
//
// Without it the suite and the DEPLOYED backend share one instance, and
// `cacheKey` encodes the query parameters and NOTHING about which database
// answered them. A production `/competitions?limit=100` and a test one are
// therefore the same key by construction, and whichever writes first wins for
// the full 3600s TTL. That is a collision, not a race: no retry outruns it, and
// a test that fails by getting an unexpected hit never called cacheSet, so it
// has no key to clean up. See FOLLOWUPS 12.
//
// A plain reassignment suffices because src/redis/client.js reads these lazily
// — on every isRedisEnabled() call, and inside getClient() — never at module
// load. That lazy read is precisely what makes the instance controllable from
// here.
//
// Both are required: redirecting the URL while leaving the production TOKEN in
// place would build a client from two different instances' credentials.
if (process.env.TEST_UPSTASH_REDIS_REST_URL && process.env.TEST_UPSTASH_REDIS_REST_TOKEN) {
    process.env.UPSTASH_REDIS_REST_URL = process.env.TEST_UPSTASH_REDIS_REST_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = process.env.TEST_UPSTASH_REDIS_REST_TOKEN;
} else if (process.env.UPSTASH_REDIS_REST_URL) {
    // The vacuous-green case. The two real-Redis suites gate on the TEST pair,
    // so they SKIP here rather than quietly exercising the production instance
    // — but an unannounced skip reads exactly like a pass in the summary line.
    //
    // process.stderr.write, NOT console.warn, and not pino (silenced below).
    // Vitest intercepts console in the worker and attaches each line to the
    // running test; a setupFiles line has no test to attach to, so when every
    // test in the file then skips the warning is dropped entirely. Verified
    // both ways: console.warn here printed nothing under `vitest run`, a raw
    // stderr write printed. A warning about a silent skip must not itself be
    // silently skipped.
    process.stderr.write(
        '[tests/setup] TEST_UPSTASH_REDIS_REST_URL/TEST_UPSTASH_REDIS_REST_TOKEN unset — '
        + 'redis.test.js and cachedReads.test.js will SKIP (33 tests). '
        + 'UPSTASH_REDIS_REST_URL is set but the suites deliberately do not use '
        + 'it. See FOLLOWUPS 12 and .env.example.\n',
    );
}

// Silence pino output during tests unless the caller explicitly sets LOG_LEVEL.
process.env.LOG_LEVEL ??= 'silent';
