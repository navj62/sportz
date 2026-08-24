import { Redis } from '@upstash/redis';
import { logger } from '../logger.js';
import {
    CACHE_PREFIX,
    LOCK_PREFIX,
    DEFAULT_CACHE_TTL_SECONDS,
    REDIS_PING_TIMEOUT_MS,
} from './constants.js';

/**
 * Lock outcome counters, read by /debug/stats.
 *
 * Counted here rather than in liveSync because this is where the four reasons
 * are produced. Counting at a caller's branch would re-derive the information
 * at a distance, and liveSync never inspects 'acquired' or 'disabled' at all —
 * it would have to grow branches purely to count.
 *
 * Aggregated across lock KEYS, not per key. With a single key
 * (LIVE_SYNC_LOCK_KEY) that is exact; a second lock would silently conflate
 * the two. Keying is deferred until a second key exists — see FOLLOWUPS.
 */
let lockOutcomes = { acquired: 0, held: 0, error: 0, disabled: 0 };

/**
 * Memoized so we build one client per process rather than one per call. Reset
 * between tests via __resetRedisClientForTests().
 * @type {Redis|null}
 */
let client = null;

/**
 * Read lazily rather than at module load, mirroring getApiKey() in
 * apiFootball.js: importing this module must stay side-effect free so unit
 * tests never need Upstash credentials in the environment.
 *
 * Recomputed on every call rather than memoized. It is two property reads, and
 * caching the result would make the disabled path untestable in-process.
 * @returns {boolean}
 */
export function isRedisEnabled() {
    return Boolean(
        process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
    );
}

/**
 * Only ever called behind an isRedisEnabled() guard, so the env vars are known
 * present by the time we read them here.
 * @returns {Redis}
 */
function getClient() {
    client ??= new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    return client;
}

/**
 * Emits the single startup line describing Redis availability. Called from
 * index.js rather than run at module load, which would reintroduce the import
 * side effect the lazy env read exists to avoid.
 * @returns {void}
 */
export function initRedis() {
    if (!isRedisEnabled()) {
        logger.info('Redis disabled (UPSTASH_REDIS_REST_URL/TOKEN unset), cache and lock helpers are no-ops');
        return;
    }

    // Host only. The token is a credential and must never reach the logs, and
    // the full URL is not worth logging when the host identifies the instance.
    let host;
    try {
        host = new URL(process.env.UPSTASH_REDIS_REST_URL).host;
    } catch {
        host = 'unparseable';
    }

    logger.info({ host }, 'Redis enabled');
}

/**
 * @param {string} key Bare key; the cache prefix is applied here.
 * @returns {Promise<unknown|null>} The cached value, or null on miss or failure.
 */
export async function cacheGet(key) {
    if (!isRedisEnabled()) {
        return null;
    }

    try {
        // The Upstash REST client deserializes JSON on read, so an object
        // stored by cacheSet comes back already parsed. A JSON.parse here would
        // throw on it rather than help.
        const value = await getClient().get(CACHE_PREFIX + key);
        return value ?? null;
    } catch (err) {
        logger.warn({ err, key }, 'Redis cacheGet failed, treating as a miss');
        return null;
    }
}

/**
 * @param {string} key Bare key; the cache prefix is applied here.
 * @param {unknown} value Serialized by the Upstash client.
 * @param {number} [ttlSeconds]
 * @returns {Promise<void>}
 */
export async function cacheSet(key, value, ttlSeconds = DEFAULT_CACHE_TTL_SECONDS) {
    if (!isRedisEnabled()) {
        return;
    }

    try {
        await getClient().set(CACHE_PREFIX + key, value, { ex: ttlSeconds });
    } catch (err) {
        logger.warn({ err, key }, 'Redis cacheSet failed, value not cached');
    }
}

/**
 * @param {string} key Bare key; the cache prefix is applied here.
 * @returns {Promise<void>}
 */
export async function cacheDel(key) {
    if (!isRedisEnabled()) {
        return;
    }

    try {
        await getClient().del(CACHE_PREFIX + key);
    } catch (err) {
        logger.warn({ err, key }, 'Redis cacheDel failed, stale value may persist until TTL');
    }
}

/**
 * Compare-and-delete. Releasing with a bare DEL is wrong under contention: if
 * our lock has already expired and another holder acquired the same key, a DEL
 * deletes THEIR lock and admits a third caller while they are still working.
 * Checking the value first from JS does not fix it either — the check and the
 * delete would be two round trips with a window in between.
 *
 * Upstash's REST API runs this atomically, verified against a live instance:
 * a non-matching token returns 0 and leaves the key, a matching one returns 1
 * and deletes it. Note Lua compares the RAW stored bytes, which is why the
 * token must be a string — the Upstash client stores strings verbatim but
 * JSON-encodes objects, and an encoded value would never match ARGV[1].
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

/**
 * @typedef {object} LockResult
 * @property {boolean} acquired Whether the caller may proceed with the guarded work.
 * @property {'acquired'|'disabled'|'held'|'error'} reason Why. Callers that must
 *   distinguish "someone else is working" from "we could not coordinate" branch
 *   on this rather than on `acquired` — only 'held' proves a real contender.
 * @property {string|null} token Pass to releaseLock. Null whenever we hold no
 *   real lock, which makes releasing a no-op instead of a wrongful delete.
 */

/**
 * @param {string} key Bare key; the lock prefix is applied here.
 * @param {number} ttlSeconds Expiry, so a holder that crashes mid-work cannot
 *   wedge the lock permanently.
 * @returns {Promise<LockResult>}
 */
export async function acquireLock(key, ttlSeconds) {
    // Grant the lock when Redis is not configured. This deploys as a single
    // instance, so there is no second contender to coordinate with, and denying
    // the lock would mean the guarded work never runs at all.
    //
    // Reported as 'disabled' rather than 'acquired' because no lock exists to
    // release; claiming otherwise would hand callers a token that owns nothing.
    if (!isRedisEnabled()) {
        lockOutcomes.disabled += 1;
        return { acquired: true, reason: 'disabled', token: null };
    }

    // Unique per acquisition, so releaseLock can prove the lock it is deleting
    // is still the one this call created.
    const token = crypto.randomUUID();

    try {
        const result = await getClient().set(LOCK_PREFIX + key, token, {
            nx: true,
            ex: ttlSeconds,
        });

        // SET NX returns 'OK' when it wrote, null when the key already existed.
        if (result === 'OK') {
            lockOutcomes.acquired += 1;
            return { acquired: true, reason: 'acquired', token };
        }

        lockOutcomes.held += 1;
        return { acquired: false, reason: 'held', token: null };
    } catch (err) {
        lockOutcomes.error += 1;
        // Distinct from 'held': nobody has been shown to hold this lock, we
        // simply could not ask. Callers guarding quota rather than correctness
        // may choose to proceed anyway — see pollLiveFixtures.
        logger.warn({ err, key }, 'Redis acquireLock failed, lock state unknown');
        return { acquired: false, reason: 'error', token: null };
    }
}

/**
 * @param {string} key Bare key; the lock prefix is applied here.
 * @param {string|null} token The token from the acquireLock that took this lock.
 * @returns {Promise<void>}
 */
export async function releaseLock(key, token) {
    // No token means we never took a real lock — the disabled and error paths
    // both return null. Returning silently is correct, not a fault worth
    // warning about: there is nothing of ours to release.
    if (!isRedisEnabled() || !token) {
        return;
    }

    try {
        await getClient().eval(RELEASE_LOCK_SCRIPT, [LOCK_PREFIX + key], [token]);
    } catch (err) {
        logger.warn({ err, key }, 'Redis releaseLock failed, lock will clear on TTL');
    }
}

/**
 * @returns {{ acquired: number, held: number, error: number, disabled: number,
 *   errorRate: number }} Cumulative since process start.
 */
export function getLockStats() {
    const { acquired, held, error, disabled } = lockOutcomes;
    const total = acquired + held + error + disabled;

    return {
        acquired,
        held,
        error,
        disabled,
        // A rising error rate is the only signal that the lock has stopped
        // coordinating anything — 'error' means we could not even ask whether
        // a contender exists, and the poll proceeds uncoordinated.
        errorRate: total === 0 ? 0 : Number((error / total).toFixed(4)),
    };
}

/**
 * Availability probe for the debug endpoint. Never throws, like every helper
 * in this module.
 *
 * Bounded by a timeout because the Upstash REST client has no deadline of its
 * own, so an unresponsive instance would otherwise hang /debug/stats. A
 * timeout reports 'unreachable' rather than a fourth state: to a caller, a
 * ping that never lands and one that fails are the same fact.
 *
 * Deliberately NOT used by /health. Redis is optional, /health is a liveness
 * probe for the app's real dependency, and hanging an external call of roughly
 * 800ms off that path would let a slow Redis trip a platform's own health
 * timeout — failing the check by latency while faithfully reporting Redis as
 * merely advisory. The cleanest guarantee that Redis can never fail /health is
 * that /health never touches Redis.
 *
 * @param {number} [timeoutMs]
 * @returns {Promise<'ok'|'unreachable'|'disabled'>}
 */
export async function redisPing(timeoutMs = REDIS_PING_TIMEOUT_MS) {
    if (!isRedisEnabled()) {
        return 'disabled';
    }

    let timer;
    try {
        const expiry = new Promise((_resolve, reject) => {
            timer = setTimeout(
                () => reject(new Error(`Redis ping timed out after ${timeoutMs}ms`)),
                timeoutMs,
            );
        });

        await Promise.race([getClient().ping(), expiry]);
        return 'ok';
    } catch (err) {
        logger.warn({ err }, 'Redis ping failed, reporting unreachable');
        return 'unreachable';
    } finally {
        // Without this the pending timer keeps the event loop alive for up to
        // timeoutMs after a successful ping.
        clearTimeout(timer);
    }
}

/**
 * Test seam. Drops the memoized client so a suite can change the Upstash env
 * vars and have the next call build a client against the new values.
 * @returns {void}
 */
export function __resetRedisClientForTests() {
    client = null;
}

/** Test seam. Mirrors __resetCacheStatsForTests() in cache.js. @returns {void} */
export function __resetLockStatsForTests() {
    lockOutcomes = { acquired: 0, held: 0, error: 0, disabled: 0 };
}
