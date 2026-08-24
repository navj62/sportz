import { cacheGet, cacheSet, isRedisEnabled } from './client.js';
import { CACHE_HEALTH_MIN_CACHEABLE_LOOKUPS } from './constants.js';

/**
 * Read-through cache for the public read endpoints.
 *
 * ── Invalidation: TTL only, deliberately ─────────────────────────────────────
 * There is no write-side invalidation, and its absence is a decision rather
 * than an oversight. liveSync is the sole writer and polls at 900s live /
 * 1800s idle; every TTL here is far shorter than that, so the worst staleness
 * a reader can observe is one TTL against data that changes at most every 15
 * minutes. Explicit invalidation would buy an invisible improvement while
 * reintroducing on the write side exactly the key-completeness risk the
 * whole-object keying below exists to eliminate — a write that invalidates
 * four of five key variants is a silent stale-read bug.
 *
 * Do NOT add invalidation calls to liveSync to "fix" this. It is tracked in
 * FOLLOWUPS.md as a deferred optimization with the trigger that would make it
 * due.
 *
 * ── Landmine: Redis coerces Date to string ───────────────────────────────────
 * Values round-trip through JSON, so a row's `startTime` / `createdAt` /
 * `updatedAt` comes back from a cache HIT as an ISO string, where a cache MISS
 * returns a real Date from pg.
 *
 * This is acceptable today only because every consumer of these values is a
 * `res.json()` call, and Express serializes a Date and its ISO string
 * identically — the HTTP response is byte-for-byte the same on hit and miss.
 *
 * It breaks the moment any consumer calls a Date method on a cached field —
 * `.getTime()`, `.toISOString()`, date arithmetic — because that works on a
 * miss and throws on a hit, intermittently, depending on nothing but cache
 * state. If you need that, either revive the Date fields for that path or
 * bypass the cache for it. Do not assume the type.
 */

/**
 * Counters behind the observability seam. Module-level and process-local: this
 * deploys as a single instance, so there is nothing to aggregate across.
 */
let hits = 0;
let misses = 0;
let skipped = 0;

/**
 * Serializes the FULL parameter set into the key, rather than naming fields
 * one by one.
 *
 * The two failure directions are not symmetric. A key carrying an extra field
 * over-discriminates: more misses, every answer still correct. A key MISSING a
 * field under-discriminates, and one query silently serves another query's
 * rows — a data-correctness bug. Hand-written key templates fail in the
 * dangerous direction the moment someone adds a filter and forgets the key.
 * Keying on the whole params object makes that direction structurally
 * impossible: a new filter joins the key by existing.
 *
 * Entries are serialized as a sorted ARRAY of pairs, not an object. Two
 * reasons: array order is guaranteed, where JS object key order is not (
 * integer-like keys reorder ahead of string ones), and keeping the field NAME
 * in the output means an empty-string value cannot collide with an absent one
 * — `{}` serializes to `[]`, `{ status: '' }` to `[["status",""]]`.
 *
 * That second property is load-bearing, and it comes from the names being
 * present — NOT from the sorting. Do not "shorten" these keys by serializing
 * values only: `['', 10]` and `[10]` are one field apart in different
 * positions, and absent-vs-empty starts colliding again.
 *
 * `undefined` is dropped, which matches the services: they treat an undefined
 * param as "no filter", so `{ limit: 10 }` and `{ limit: 10, cursor: undefined }`
 * are the same query and must share a key. `null` is kept and therefore
 * distinct — no route passes it, and over-discriminating is the safe direction.
 *
 * @param {string} namespace Identifies the query shape, e.g. 'matches:list'.
 * @param {Record<string, unknown>} [params]
 * @returns {string} Bare key; cacheGet/cacheSet apply the cache prefix.
 */
export function cacheKey(namespace, params) {
    const entries = Object.entries(params ?? {})
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return `${namespace}:${JSON.stringify(entries)}`;
}

/**
 * Read-through: return the cached value, else run `loader` and cache what it
 * returns.
 *
 * Never throws on Redis's account — cacheGet and cacheSet swallow their own
 * failures, so a cache miss and a broken Redis are the same thing here, and a
 * caller cannot tell whether the cache is present. Errors from `loader` DO
 * propagate; the routes' next(error) is what should handle a failed query.
 *
 * @template T
 * @param {string} namespace
 * @param {Record<string, unknown>} params Every value that changes the result.
 * @param {number} ttlSeconds
 * @param {() => Promise<T>} loader Runs on a miss.
 * @returns {Promise<T>}
 */
export async function withCache(namespace, params, ttlSeconds, loader) {
    // Short-circuit rather than letting the helpers no-op their way through.
    // Counting a miss per call when Redis is switched off would report
    // hits: 0 / misses: 5000 — indistinguishable from the "configured but
    // never hitting" fault the stats exist to expose. Leaving the counters at
    // zero and reporting `enabled: false` says what is actually happening.
    if (!isRedisEnabled()) {
        return loader();
    }

    const key = cacheKey(namespace, params);

    const cached = await cacheGet(key);
    if (cached !== null) {
        hits += 1;
        return cached;
    }

    misses += 1;
    const result = await loader();

    // Skip ONLY a null result, never merely a falsy one. null is excluded
    // because cacheGet cannot distinguish a stored null from a miss (it
    // returns `value ?? null`), so caching one produces an entry that can
    // never register as a hit while still costing a write.
    //
    // The test is `=== null` rather than `!result` on purpose. Note this is
    // NOT about empty lists: `[]` is truthy, so both forms cache it. It
    // matters for a falsy SCALAR — a loader returning 0, '' or false has
    // returned a real answer, and `!result` would silently refuse to cache it
    // forever. No current caller returns one, but the cheap guard is the
    // correct one, and the loose form fails silently rather than loudly.
    if (result === null) {
        skipped += 1;
        return result;
    }

    await cacheSet(key, result, ttlSeconds);
    return result;
}

/**
 * Observability seam. Read by the debug endpoint in the observability pass;
 * exported now so the counters exist from the moment the cache does.
 *
 * `enabled` is what makes the numbers diagnosable. Because cacheGet reports a
 * failure as a miss, hits and misses alone cannot separate "Redis is off" from
 * "Redis is on and something is broken". With the flag, `enabled: true` beside
 * a hit count stuck at zero is a direct, readable fault rather than something
 * inferred from quota trending the wrong way.
 *
 * `skipped` counts results that were not stored (null loader results). It
 * overlaps `misses` by construction — a skip always follows a miss — and
 * exists so a legitimately low hit rate on a mostly-empty table is not
 * mistaken for a broken cache.
 *
 * @returns {{ enabled: boolean, hits: number, misses: number, skipped: number }}
 */
export function getCacheStats() {
    const enabled = isRedisEnabled();
    const lookups = hits + misses;

    return {
        status: cacheStatus(enabled),
        enabled,
        hits,
        misses,
        skipped,
        hitRate: lookups === 0 ? 0 : Number((hits / lookups).toFixed(4)),
    };
}

/**
 * Classifies the counters, so the one fault that is otherwise invisible reads
 * at a glance instead of having to be computed by whoever is looking.
 *
 * A cache that is configured but never hitting produces numbers identical to a
 * cold one — misses, no hits — which is the whole reason this exists. Two
 * guards stop it crying wolf, and BOTH are load-bearing:
 *
 *  - `skipped` is excluded from the denominator. A skipped result is a null
 *    the cache deliberately refuses to store, so it can never become a hit. A
 *    404-heavy workload legitimately shows `hits: 0`, and counting those as
 *    evidence would raise a fault against a perfectly healthy cache.
 *  - Below CACHE_HEALTH_MIN_CACHEABLE_LOOKUPS the verdict is 'cold', never a
 *    fault. A freshly started process has no hits yet by definition.
 *
 * Delete either guard and a spurious alarm comes back — on 404-heavy traffic,
 * and on every boot, respectively.
 *
 * @param {boolean} enabled
 * @returns {'disabled'|'cold'|'never-hit'|'ok'}
 */
function cacheStatus(enabled) {
    if (!enabled) return 'disabled';

    const cacheableLookups = hits + (misses - skipped);
    if (cacheableLookups < CACHE_HEALTH_MIN_CACHEABLE_LOOKUPS) return 'cold';

    return hits === 0 ? 'never-hit' : 'ok';
}

/**
 * Test seam. Mirrors __resetRedisClientForTests() in client.js.
 * @returns {void}
 */
export function __resetCacheStatsForTests() {
    hits = 0;
    misses = 0;
    skipped = 0;
}
