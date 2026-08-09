import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger } from '../src/logger.js';
import {
    cacheGet,
    cacheSet,
    cacheDel,
    acquireLock,
    releaseLock,
    isRedisEnabled,
    initRedis,
    redisPing,
    getLockStats,
    __resetRedisClientForTests,
    __resetLockStatsForTests,
} from '../src/redis/client.js';

// Hoisted so the vi.mock factory below — which is lifted above the imports —
// can close over these without hitting a temporal dead zone.
const { constructed, calls, pingImpl } = vi.hoisted(() => ({
    constructed: vi.fn(),
    calls: vi.fn(),
    // Overridable per test: the default stands in for an unreachable host,
    // while the timeout case needs a ping that never settles at all.
    pingImpl: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
}));

// A client whose every command rejects, standing in for Upstash being
// unreachable. This is the "Redis is configured but down" case, which is
// distinct from Redis not being configured at all.
vi.mock('@upstash/redis', () => ({
    Redis: class {
        constructor(options) {
            constructed(options);
        }

        get(...args) {
            calls('get', ...args);
            return Promise.reject(new Error('ECONNREFUSED'));
        }

        set(...args) {
            calls('set', ...args);
            return Promise.reject(new Error('ECONNREFUSED'));
        }

        del(...args) {
            calls('del', ...args);
            return Promise.reject(new Error('ECONNREFUSED'));
        }

        // releaseLock releases through a compare-and-delete Lua script. Without
        // this the mock would throw TypeError: eval is not a function, which the
        // helper's try/catch swallows into the same warn a network failure
        // produces — so the unreachable-Redis test below would still pass, while
        // actually exercising a missing method rather than an unreachable host.
        eval(...args) {
            calls('eval', ...args);
            return Promise.reject(new Error('ECONNREFUSED'));
        }

        ping(...args) {
            calls('ping', ...args);
            return pingImpl();
        }
    },
}));

const ORIGINAL_URL = process.env.UPSTASH_REDIS_REST_URL;
const ORIGINAL_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function restoreEnv() {
    if (ORIGINAL_URL === undefined) {
        delete process.env.UPSTASH_REDIS_REST_URL;
    } else {
        process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_URL;
    }

    if (ORIGINAL_TOKEN === undefined) {
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
    } else {
        process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_TOKEN;
    }
}

describe('Redis client — Redis configured but unreachable', () => {
    let warn;

    beforeEach(() => {
        // Set explicitly rather than relying on .env, so these run identically
        // on a machine with no Upstash credentials. The client is mocked, so
        // nothing reaches the network regardless.
        process.env.UPSTASH_REDIS_REST_URL = 'https://mock.upstash.io';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
        __resetRedisClientForTests();
        constructed.mockClear();
        calls.mockClear();
        warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warn.mockRestore();
        __resetRedisClientForTests();
        restoreEnv();
    });

    it('cacheGet returns null and warns', async () => {
        await expect(cacheGet('boom')).resolves.toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatchObject({ key: 'boom' });
        expect(warn.mock.calls[0][0].err).toBeInstanceOf(Error);
    });

    it('cacheSet resolves without throwing, and warns', async () => {
        await expect(cacheSet('boom', { a: 1 }, 30)).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0].err).toBeInstanceOf(Error);
    });

    it('cacheDel resolves without throwing, and warns', async () => {
        await expect(cacheDel('boom')).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
    });

    // Deliberately the opposite of the REDIS_ENABLED=false case below. Redis
    // being configured means another instance may exist and may hold this lock,
    // so an unreachable Redis must not assume leadership.
    //
    // 'error' rather than 'held' is the load-bearing part: no contender has been
    // observed, we just could not ask. Callers guarding quota rather than
    // correctness proceed on 'error' and skip only on 'held'.
    it('acquireLock reports error with no token, and warns', async () => {
        await expect(acquireLock('boom', 30)).resolves.toEqual({
            acquired: false,
            reason: 'error',
            token: null,
        });
        expect(warn).toHaveBeenCalledTimes(1);
    });

    // Passes a token, or the !token guard would return before reaching Redis and
    // this would assert nothing about the unreachable path.
    it('releaseLock resolves without throwing, and warns', async () => {
        await expect(releaseLock('boom', 'some-token')).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(calls.mock.calls[0][0]).toBe('eval');
    });

    // Asserts the !token guard itself, not its consequence. The Lua script would
    // also refuse a null token — it cannot match the stored value — so a test
    // that only checked "the lock survived" passes either way and lets the guard
    // be deleted silently. What the guard uniquely buys is issuing NO command at
    // all: every disabled or failed acquire would otherwise pay a round trip to
    // release a lock it never held, and the behavior would hinge on how Upstash
    // serializes a null ARGV entry.
    it('releaseLock issues no command when the token is null', async () => {
        await expect(releaseLock('boom', null)).resolves.toBeUndefined();

        expect(calls).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
    });

    // The fencing contract at the transport level: the token must reach Redis as
    // an ARGV entry so the comparison happens inside the script, never as a
    // value read back into JS and compared here.
    it('releaseLock sends the prefixed key and the token to the Lua script', async () => {
        await releaseLock('sync', 'tok-123');

        const [command, script, keys, args] = calls.mock.calls[0];
        expect(command).toBe('eval');
        expect(script).toContain("redis.call('del', KEYS[1])");
        expect(keys).toEqual(['sportz:lock:sync']);
        expect(args).toEqual(['tok-123']);
    });

    it('logs the error under the `err` key, matching the logger convention', async () => {
        await cacheGet('boom');

        const [context, message] = warn.mock.calls[0];
        expect(context).toHaveProperty('err');
        expect(typeof message).toBe('string');
    });

    it('applies the cache and lock prefixes to the underlying commands', async () => {
        await cacheGet('scores');
        await acquireLock('sync', 30);

        expect(calls).toHaveBeenNthCalledWith(1, 'get', 'sportz:cache:scores');
        expect(calls.mock.calls[1][0]).toBe('set');
        expect(calls.mock.calls[1][1]).toBe('sportz:lock:sync');
    });

    // The lock value must be a STRING. The Upstash client stores strings
    // verbatim but JSON-encodes anything else, and the release script compares
    // the raw stored bytes against ARGV[1] — so a non-string token would be
    // written encoded, never match on release, and leave every lock to expire.
    it('writes the lock value as a string token', async () => {
        await acquireLock('sync', 30);

        const [, , value, options] = calls.mock.calls[0];
        expect(typeof value).toBe('string');
        expect(value.length).toBeGreaterThan(0);
        expect(options).toEqual({ nx: true, ex: 30 });
    });

    // Two acquisitions must never produce the same token, or a stale release
    // from one holder could delete the other's lock — the exact failure the
    // fencing token exists to prevent.
    it('generates a distinct token per acquisition', async () => {
        await acquireLock('sync', 30);
        await acquireLock('sync', 30);

        expect(calls.mock.calls[0][2]).not.toBe(calls.mock.calls[1][2]);
    });
});

describe('Redis client — not configured', () => {
    let warn;
    let info;

    beforeEach(() => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        __resetRedisClientForTests();
        constructed.mockClear();
        calls.mockClear();
        warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    });

    afterEach(() => {
        warn.mockRestore();
        info.mockRestore();
        __resetRedisClientForTests();
        restoreEnv();
    });

    it('reports disabled', () => {
        expect(isRedisEnabled()).toBe(false);
    });

    it('reports disabled when only one of the two vars is set', () => {
        process.env.UPSTASH_REDIS_REST_URL = 'https://mock.upstash.io';
        expect(isRedisEnabled()).toBe(false);

        delete process.env.UPSTASH_REDIS_REST_URL;
        process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
        expect(isRedisEnabled()).toBe(false);
    });

    it('cacheGet returns null without building a client', async () => {
        await expect(cacheGet('anything')).resolves.toBeNull();
        expect(constructed).not.toHaveBeenCalled();
        expect(calls).not.toHaveBeenCalled();
    });

    // The single-instance leader fallback. Not being configured is a known
    // single-instance deploy, so there is no second contender to coordinate
    // with, and denying the lock would mean the guarded work never runs at all.
    // This is intentionally NOT symmetric with the unreachable-Redis case above,
    // which returns false — do not "fix" this to match it.
    it('acquireLock grants with acquired TRUE — the single-instance leader fallback', async () => {
        await expect(acquireLock('anything', 30)).resolves.toEqual({
            acquired: true,
            reason: 'disabled',
            token: null,
        });
        expect(constructed).not.toHaveBeenCalled();
        expect(calls).not.toHaveBeenCalled();
    });

    // 'disabled' rather than 'acquired' because no lock was taken. The null token
    // is what makes the matching releaseLock a no-op instead of a delete of
    // whatever happens to sit at that key.
    it('reports reason disabled, not acquired, and hands back no token', async () => {
        const lock = await acquireLock('anything', 30);

        expect(lock.reason).toBe('disabled');
        expect(lock.token).toBeNull();
    });

    it('cacheSet, cacheDel and releaseLock no-op without building a client', async () => {
        await expect(cacheSet('anything', { a: 1 }, 30)).resolves.toBeUndefined();
        await expect(cacheDel('anything')).resolves.toBeUndefined();
        // Passes a token so the disabled guard is what stops this, not the
        // !token guard — otherwise this asserts nothing about being disabled.
        await expect(releaseLock('anything', 'tok')).resolves.toBeUndefined();

        expect(constructed).not.toHaveBeenCalled();
        expect(calls).not.toHaveBeenCalled();
    });

    it('never warns on the disabled path — degradation is expected, not an error', async () => {
        await cacheGet('anything');
        await cacheSet('anything', 1, 30);
        await cacheDel('anything');
        await acquireLock('anything', 30);
        await releaseLock('anything', 'tok');

        expect(warn).not.toHaveBeenCalled();
    });

    it('initRedis logs disabled at info and builds no client', () => {
        initRedis();

        expect(info).toHaveBeenCalledTimes(1);
        expect(constructed).not.toHaveBeenCalled();
    });

    it('initRedis logs the host but never the token when enabled', () => {
        process.env.UPSTASH_REDIS_REST_URL = 'https://example-12345.upstash.io';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'super-secret-token';

        initRedis();

        const [context, message] = info.mock.calls[0];
        expect(context).toEqual({ host: 'example-12345.upstash.io' });
        expect(JSON.stringify([context, message])).not.toContain('super-secret-token');
    });
});

describe('redisPing — degradation', () => {
    let warn;

    beforeEach(() => {
        process.env.UPSTASH_REDIS_REST_URL = 'https://mock.upstash.io';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
        __resetRedisClientForTests();
        pingImpl.mockReset();
        warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warn.mockRestore();
        __resetRedisClientForTests();
        restoreEnv();
    });

    it('reports ok when the ping answers', async () => {
        pingImpl.mockResolvedValue('PONG');

        await expect(redisPing()).resolves.toBe('ok');
    });

    it('reports unreachable and warns when the ping rejects', async () => {
        pingImpl.mockRejectedValue(new Error('ECONNREFUSED'));

        await expect(redisPing()).resolves.toBe('unreachable');
        expect(warn).toHaveBeenCalledTimes(1);
    });

    // The reason the timeout exists: the Upstash REST client has no deadline of
    // its own, so a hung instance would otherwise hang /debug/stats forever.
    // A ping that never settles must still resolve, via the race.
    it('reports unreachable when the ping never settles', async () => {
        pingImpl.mockReturnValue(new Promise(() => {}));

        await expect(redisPing(50)).resolves.toBe('unreachable');
    });

    it('never throws, whatever the client does', async () => {
        pingImpl.mockImplementation(() => { throw new Error('synchronous boom'); });

        await expect(redisPing()).resolves.toBe('unreachable');
    });
});

describe('getLockStats — outcome counters', () => {
    beforeEach(() => {
        __resetLockStatsForTests();
    });

    afterEach(() => {
        __resetRedisClientForTests();
        restoreEnv();
        __resetLockStatsForTests();
    });

    it('starts at zero with a zero error rate', () => {
        expect(getLockStats()).toEqual({
            acquired: 0, held: 0, error: 0, disabled: 0, errorRate: 0,
        });
    });

    it('counts an error when Redis is configured but unreachable', async () => {
        process.env.UPSTASH_REDIS_REST_URL = 'https://mock.upstash.io';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
        __resetRedisClientForTests();
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

        await acquireLock('counted', 30);

        expect(getLockStats()).toMatchObject({ error: 1, acquired: 0, held: 0 });
        warn.mockRestore();
    });

    it('counts a disabled outcome when Redis is not configured', async () => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;

        await acquireLock('counted', 30);

        expect(getLockStats()).toMatchObject({ disabled: 1, error: 0 });
    });

    // A rising error rate is the only signal that the lock has stopped
    // coordinating — 'error' means we could not even ask whether a contender
    // exists, and the poll proceeds uncoordinated rather than skipping.
    it('reports the error rate across all outcomes', async () => {
        process.env.UPSTASH_REDIS_REST_URL = 'https://mock.upstash.io';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
        __resetRedisClientForTests();
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

        await acquireLock('counted', 30);
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        await acquireLock('counted', 30);
        await acquireLock('counted', 30);

        // One error out of three attempts.
        expect(getLockStats()).toMatchObject({ error: 1, disabled: 2, errorRate: 0.3333 });
        warn.mockRestore();
    });
});
