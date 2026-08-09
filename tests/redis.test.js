import { describe, it, expect, afterAll } from 'vitest';
import {
    cacheGet,
    cacheSet,
    cacheDel,
    acquireLock,
    releaseLock,
    isRedisEnabled,
    getLockStats,
    __resetLockStatsForTests,
} from '../src/redis/client.js';

// These hit the real Upstash instance. Skip the suite when it is not configured,
// mirroring how integration.test.js gates on TEST_DATABASE_URL.
const skip = !process.env.UPSTASH_REDIS_REST_URL;

// Namespaced per run so a re-run never reads a key a previous run left behind,
// and two runs in parallel cannot fight over the same lock.
const RUN = `test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
const key = (name) => `${RUN}:${name}`;

// Retried because the only failure mode seen here is a transient Upstash
// blip: the helper catches it, returns its safe value, and the assertion of a
// real round-tripped value fails while the app's graceful-degradation contract
// is behaving exactly as designed. The app is weaker than the test on purpose,
// so a single blip is not a defect. Scoped to this suite — never the
// integration suite, where an intermittent failure can be real DB logic.
describe.skipIf(skip)('Redis client — real Upstash', { retry: 2 }, () => {
    // Locks are deliberately absent here. Releasing one now requires the token
    // the acquiring test holds, which is the point of fencing — a tokenless
    // sweep is exactly the cross-holder delete the script refuses. The tests
    // that need a key freed release it themselves; the rest are per-run
    // namespaced with short TTLs and reap on their own.
    afterAll(async () => {
        await Promise.all([
            cacheDel(key('string')),
            cacheDel(key('object')),
            cacheDel(key('ttl')),
            cacheDel(key('del')),
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

    it('acquireLock grants once and reports held while held', async () => {
        const first = await acquireLock(key('lock'), 30);
        expect(first).toMatchObject({ acquired: true, reason: 'acquired' });
        expect(typeof first.token).toBe('string');

        // 'held' is the only reason that proves a real contender, and the only
        // one callers are entitled to skip their work on.
        expect(await acquireLock(key('lock'), 30)).toEqual({
            acquired: false,
            reason: 'held',
            token: null,
        });
    });

    it('releaseLock lets a later acquireLock succeed', async () => {
        const lock = await acquireLock(key('release'), 30);
        expect(lock.acquired).toBe(true);
        expect((await acquireLock(key('release'), 30)).reason).toBe('held');

        await releaseLock(key('release'), lock.token);

        expect((await acquireLock(key('release'), 30)).acquired).toBe(true);
    });

    // The fencing guarantee, and the whole reason release is a compare-and-delete
    // rather than a DEL. Simulates our lock expiring mid-work and a second holder
    // taking the key: our late release must not evict them. A bare DEL here would
    // delete a live lock and admit a third caller alongside the second.
    it('releaseLock with a stale token does not delete another holder\'s lock', async () => {
        const name = key('fencing');

        // 1s TTL, then let it lapse — the real sequence, not a forged token.
        const stale = await acquireLock(name, 1);
        expect(stale.acquired).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 1_500));

        const current = await acquireLock(name, 30);
        expect(current.acquired).toBe(true);
        expect(current.token).not.toBe(stale.token);

        await releaseLock(name, stale.token);

        // Still held by `current` — the stale release was a no-op.
        expect((await acquireLock(name, 30)).reason).toBe('held');

        await releaseLock(name, current.token);
        expect((await acquireLock(name, 30)).acquired).toBe(true);
        await releaseLock(name, (await acquireLock(name, 30)).token);
    });

    // The disabled and error paths both hand back a null token. Release must
    // treat that as "we hold nothing" rather than falling through to a delete.
    it('releaseLock with a null token leaves the lock untouched', async () => {
        const name = key('null-token');

        const lock = await acquireLock(name, 30);
        expect(lock.acquired).toBe(true);

        await releaseLock(name, null);

        expect((await acquireLock(name, 30)).reason).toBe('held');
        await releaseLock(name, lock.token);
    });

    // Cache and lock helpers apply different prefixes, so the same bare key in
    // both namespaces must not collide.
    it('keeps the cache and lock namespaces separate', async () => {
        const shared = key('shared-name');

        await cacheSet(shared, 'cached', 30);
        const lock = await acquireLock(shared, 30);
        expect(lock.acquired).toBe(true);
        expect(await cacheGet(shared)).toBe('cached');

        await cacheDel(shared);
        await releaseLock(shared, lock.token);
    });

    // 'acquired' and 'held' can only be produced by a Redis that actually
    // answers, so they are counted here rather than against the unreachable
    // mock in redisFallback.test.js, which can only ever yield 'error'.
    it('counts acquired and held lock outcomes', async () => {
        __resetLockStatsForTests();

        const first = await acquireLock(key('counted'), 30);
        const second = await acquireLock(key('counted'), 30);

        expect(getLockStats()).toMatchObject({
            acquired: 1, held: 1, error: 0, disabled: 0, errorRate: 0,
        });
        expect(second.acquired).toBe(false);

        await releaseLock(key('counted'), first.token);
    });
});
