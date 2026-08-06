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
 * @param {string} key Bare key; the lock prefix is applied here.
 * @param {number} ttlSeconds Expiry, so a holder that crashes mid-work cannot
 *   wedge the lock permanently.
 * @returns {Promise<boolean>} True if the caller now holds the lock.
 */
export async function acquireLock(key, ttlSeconds) {
    // Grant the lock when Redis is not configured. This deploys as a single
    // instance, so there is no second contender to coordinate with, and denying
    // the lock would mean the guarded work never runs at all.
    //
    // Deliberately the opposite of the error path below, which denies. Env vars
    // being absent is a known single-instance deployment; Redis being present
    // but unreachable means other instances may exist and may be holding this
    // lock right now, so the safe answer there is to not act.
    if (!isRedisEnabled()) {
        return true;
    }

    try {
        const result = await getClient().set(LOCK_PREFIX + key, Date.now(), {
            nx: true,
            ex: ttlSeconds,
        });
        // SET NX returns 'OK' when it wrote, null when the key already existed.
        return result === 'OK';
    } catch (err) {
        logger.warn({ err, key }, 'Redis acquireLock failed, treating lock as unavailable');
        return false;
    }
}

/**
 * @param {string} key Bare key; the lock prefix is applied here.
 * @returns {Promise<void>}
 */
export async function releaseLock(key) {
    if (!isRedisEnabled()) {
        return;
    }

    try {
        // Unconditional DEL, which is wrong under contention: if our lock has
        // already expired and another holder acquired the same key, this
        // deletes THEIR lock, admitting a third caller while they are still
        // working. Tolerable only because nothing acquires locks until Part 3
        // and this runs as a single instance. Part 3 fixes it by writing a
        // random token as the lock value and releasing through a
        // compare-and-delete Lua script that deletes only if the value still
        // matches ours.
        await getClient().del(LOCK_PREFIX + key);
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
