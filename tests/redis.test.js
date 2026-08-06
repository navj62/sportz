import { describe, it, expect, afterAll } from 'vitest';
import {
    cacheGet,
    cacheSet,
    cacheDel,
    acquireLock,
    releaseLock,
    isRedisEnabled,
} from '../src/redis/client.js';

// These hit the real Upstash instance. Skip the suite when it is not configured,
// mirroring how integration.test.js gates on TEST_DATABASE_URL.
const skip = !process.env.UPSTASH_REDIS_REST_URL;

// Namespaced per run so a re-run never reads a key a previous run left behind,
// and two runs in parallel cannot fight over the same lock.
const RUN = `test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
const key = (name) => `${RUN}:${name}`;

describe.skipIf(skip)('Redis client — real Upstash', () => {
    afterAll(async () => {
        await Promise.all([
            cacheDel(key('string')),
            cacheDel(key('object')),
            cacheDel(key('ttl')),
            cacheDel(key('del')),
            releaseLock(key('lock')),
            releaseLock(key('release')),
        ]);
    });

    it('reports enabled when credentials are present', () => {
        expect(isRedisEnabled()).toBe(true);
    });

    it('cacheSet then cacheGet returns the value', async () => {
        await cacheSet(key('string'), 'hello', 30);
        expect(await cacheGet(key('string'))).toBe('hello');
    });

    // Regression guard for the no-JSON.parse decision in cacheGet. The Upstash
    // REST client serializes on write and deserializes on read, so a value must
    // come back as a live object — not a JSON string needing a second parse. If
    // that behavior ever changes, or someone adds a JSON.parse to cacheGet, this
    // fails rather than silently corrupting every cached payload.
    it('round-trips a nested object as an object, not a JSON string', async () => {
        const value = {
            matchId: 42,
            score: { home: 2, away: 1 },
            tags: ['live', 'featured'],
            finished: false,
        };

        await cacheSet(key('object'), value, 30);
        const got = await cacheGet(key('object'));

        expect(typeof got).toBe('object');
        expect(got).toEqual(value);
        expect(got.score.home).toBe(2);
        expect(got.tags).toEqual(['live', 'featured']);
    });

    it('cacheGet returns null past the TTL', async () => {
        await cacheSet(key('ttl'), 'expires', 1);
        expect(await cacheGet(key('ttl'))).toBe('expires');

        await new Promise((resolve) => setTimeout(resolve, 1_500));

        expect(await cacheGet(key('ttl'))).toBeNull();
    });

    it('cacheGet returns null for a key that was never set', async () => {
        expect(await cacheGet(key('never-written'))).toBeNull();
    });

    it('cacheDel removes the value', async () => {
        await cacheSet(key('del'), 'doomed', 30);
        expect(await cacheGet(key('del'))).toBe('doomed');

        await cacheDel(key('del'));

        expect(await cacheGet(key('del'))).toBeNull();
    });

    it('acquireLock grants once and denies while held', async () => {
        expect(await acquireLock(key('lock'), 30)).toBe(true);
        expect(await acquireLock(key('lock'), 30)).toBe(false);
    });

    it('releaseLock lets a later acquireLock succeed', async () => {
        expect(await acquireLock(key('release'), 30)).toBe(true);
        expect(await acquireLock(key('release'), 30)).toBe(false);

        await releaseLock(key('release'));

        expect(await acquireLock(key('release'), 30)).toBe(true);
    });

    // Cache and lock helpers apply different prefixes, so the same bare key in
    // both namespaces must not collide.
    it('keeps the cache and lock namespaces separate', async () => {
        const shared = key('shared-name');

        await cacheSet(shared, 'cached', 30);
        expect(await acquireLock(shared, 30)).toBe(true);
        expect(await cacheGet(shared)).toBe('cached');

        await cacheDel(shared);
        await releaseLock(shared);
    });
});
