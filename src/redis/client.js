import { Redis } from '@upstash/redis';
import { logger } from '../logger.js';
import { CACHE_PREFIX, LOCK_PREFIX, DEFAULT_CACHE_TTL_SECONDS } from './constants.js';

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
        return result === 'OK'
            ? { acquired: true, reason: 'acquired', token }
            : { acquired: false, reason: 'held', token: null };
    } catch (err) {
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
 * Test seam. Drops the memoized client so a suite can change the Upstash env
 * vars and have the next call build a client against the new values.
 * @returns {void}
 */
export function __resetRedisClientForTests() {
    client = null;
}
