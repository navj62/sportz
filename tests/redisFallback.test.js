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
    __resetRedisClientForTests,
} from '../src/redis/client.js';

// Hoisted so the vi.mock factory below — which is lifted above the imports —
// can close over these without hitting a temporal dead zone.
const { constructed, calls } = vi.hoisted(() => ({
    constructed: vi.fn(),
    calls: vi.fn(),
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
    // so an unreachable Redis must deny rather than assume leadership.
    it('acquireLock returns false and warns', async () => {
        await expect(acquireLock('boom', 30)).resolves.toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('releaseLock resolves without throwing, and warns', async () => {
        await expect(releaseLock('boom')).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
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
    it('acquireLock returns TRUE — the single-instance leader fallback', async () => {
        await expect(acquireLock('anything', 30)).resolves.toBe(true);
        expect(constructed).not.toHaveBeenCalled();
        expect(calls).not.toHaveBeenCalled();
    });

    it('cacheSet, cacheDel and releaseLock no-op without building a client', async () => {
        await expect(cacheSet('anything', { a: 1 }, 30)).resolves.toBeUndefined();
        await expect(cacheDel('anything')).resolves.toBeUndefined();
        await expect(releaseLock('anything')).resolves.toBeUndefined();

        expect(constructed).not.toHaveBeenCalled();
        expect(calls).not.toHaveBeenCalled();
    });

    it('never warns on the disabled path — degradation is expected, not an error', async () => {
        await cacheGet('anything');
        await cacheSet('anything', 1, 30);
        await cacheDel('anything');
        await acquireLock('anything', 30);
        await releaseLock('anything');

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
