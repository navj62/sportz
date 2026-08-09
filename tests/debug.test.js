import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { logger } from '../src/logger.js';

// arcjet.js reads ARCJET_KEY at module load, so it has to be gone before
// app.js is imported — hence the dynamic import below. Without this every
// request in this file would make a real Arcjet call. See ws.test.js for the
// same treatment; running with no Arcjet key is a supported configuration.
const ORIGINAL_ARCJET_KEY = process.env.ARCJET_KEY;
delete process.env.ARCJET_KEY;

// A stand-in Upstash client that can be healthy, broken, or hung. Mocking at
// this level rather than mocking client.js means the REAL cacheGet/cacheSet,
// the real counters and the real bounded ping all run — which is what lets the
// never-hit fault below be reproduced rather than simulated.
const mocks = vi.hoisted(() => ({
    store: new Map(),
    broken: { value: false },
    pingImpl: vi.fn(() => Promise.resolve('PONG')),
}));

vi.mock('@upstash/redis', () => ({
    Redis: class {
        async get(key) {
            if (mocks.broken.value) throw new Error('ECONNREFUSED');
            return mocks.store.has(key) ? mocks.store.get(key) : null;
        }

        async set(key, value) {
            if (mocks.broken.value) throw new Error('ECONNREFUSED');
            mocks.store.set(key, JSON.parse(JSON.stringify(value)));
            return 'OK';
        }

        async del(key) {
            mocks.store.delete(key);
        }

        async eval() {
            return 1;
        }

        ping() {
            return mocks.pingImpl();
        }
    },
}));

const { createApp } = await import('../src/app.js');
const { withCache, __resetCacheStatsForTests } = await import('../src/redis/cache.js');
const { __resetRedisClientForTests, __resetLockStatsForTests } =
    await import('../src/redis/client.js');
const { CACHE_HEALTH_MIN_CACHEABLE_LOOKUPS: MIN_LOOKUPS, REDIS_PING_TIMEOUT_MS } =
    await import('../src/redis/constants.js');

const ORIGINAL_DEBUG_FLAG = process.env.DEBUG_ENDPOINTS_ENABLED;
let warn;

beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://mock.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
    mocks.store.clear();
    mocks.broken.value = false;
    mocks.pingImpl.mockReset().mockResolvedValue('PONG');
    __resetRedisClientForTests();
    __resetCacheStatsForTests();
    __resetLockStatsForTests();
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    warn.mockRestore();
    __resetRedisClientForTests();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    if (ORIGINAL_DEBUG_FLAG === undefined) {
        delete process.env.DEBUG_ENDPOINTS_ENABLED;
    } else {
        process.env.DEBUG_ENDPOINTS_ENABLED = ORIGINAL_DEBUG_FLAG;
    }
    if (ORIGINAL_ARCJET_KEY !== undefined) process.env.ARCJET_KEY = ORIGINAL_ARCJET_KEY;
});

function appWithFlag(value) {
    if (value === undefined) {
        delete process.env.DEBUG_ENDPOINTS_ENABLED;
    } else {
        process.env.DEBUG_ENDPOINTS_ENABLED = value;
    }
    return createApp();
}

describe('GET /debug/stats — registration gate', () => {
    // 404 SPECIFICALLY, not merely "not 200". A 403 would also be non-200 but
    // would mean the route exists and refuses — the opposite of the guarantee.
    // Gating at registration is what makes the endpoint invisible when off.
    it('404s when the flag is unset, because the route is never registered', async () => {
        const res = await request(appWithFlag(undefined)).get('/debug/stats');

        expect(res.status).toBe(404);
    });

    it('404s when the flag is false', async () => {
        const res = await request(appWithFlag('false')).get('/debug/stats');

        expect(res.status).toBe(404);
    });

    // The flag is an exact-string comparison, matching STANDINGS_SYNC_ENABLED.
    // Anything else, however truthy-looking, leaves the endpoint unregistered.
    it.each(['1', 'TRUE', 'yes', 'true '])('404s for the truthy-looking value %j', async (value) => {
        const res = await request(appWithFlag(value)).get('/debug/stats');

        expect(res.status).toBe(404);
    });

    it('serves the endpoint when the flag is exactly "true"', async () => {
        const res = await request(appWithFlag('true')).get('/debug/stats');

        expect(res.status).toBe(200);
    });

    // Proves the flag is read inside createApp rather than at module load:
    // one process, two apps, opposite outcomes.
    it('is decided per createApp call, not once at import', async () => {
        const off = await request(appWithFlag(undefined)).get('/debug/stats');
        const on = await request(appWithFlag('true')).get('/debug/stats');

        expect(off.status).toBe(404);
        expect(on.status).toBe(200);
    });
});

describe('GET /debug/stats — body', () => {
    it('reports uptime, cache, locks and redis', async () => {
        const res = await request(appWithFlag('true')).get('/debug/stats');

        expect(typeof res.body.uptimeSeconds).toBe('number');
        expect(res.body.cache).toMatchObject({
            status: expect.any(String),
            enabled: true,
            hits: expect.any(Number),
            misses: expect.any(Number),
            skipped: expect.any(Number),
            hitRate: expect.any(Number),
        });
        expect(res.body.locks).toMatchObject({
            acquired: expect.any(Number),
            held: expect.any(Number),
            error: expect.any(Number),
            disabled: expect.any(Number),
            errorRate: expect.any(Number),
        });
        expect(typeof res.body.redis).toBe('string');
    });

    it('reports cold on a freshly started process rather than raising a fault', async () => {
        const res = await request(appWithFlag('true')).get('/debug/stats');

        expect(res.body.cache.status).toBe('cold');
    });
});

// The point of the whole observability pass: the fault is readable by hitting
// the endpoint, not by calling an internal function. This reproduces it rather
// than simulating it — a Redis that is configured and reachable enough not to
// error out of the app's view, but from which nothing ever comes back.
describe('GET /debug/stats — the never-hit fault is readable over HTTP', () => {
    it('shows status "never-hit" when a live cache has served nothing back', async () => {
        // Every command rejects; cacheGet catches and reports a miss, so the
        // app sees a cache that works and simply never hits. Exactly the fault
        // that raw hit/miss counters cannot distinguish from a cold cache.
        mocks.broken.value = true;

        for (let i = 0; i < MIN_LOOKUPS; i += 1) {
            await withCache('probe', { unique: i }, 60, vi.fn().mockResolvedValue([{ id: i }]));
        }

        const res = await request(appWithFlag('true')).get('/debug/stats');

        expect(res.status).toBe(200);
        expect(res.body.cache.status).toBe('never-hit');
        expect(res.body.cache).toMatchObject({ enabled: true, hits: 0, hitRate: 0 });
        expect(res.body.cache.misses).toBeGreaterThanOrEqual(MIN_LOOKUPS);
    });

    it('shows ok once the cache is genuinely serving', async () => {
        for (let i = 0; i < MIN_LOOKUPS; i += 1) {
            await withCache('probe', { unique: i }, 60, vi.fn().mockResolvedValue([{ id: i }]));
        }
        await withCache('probe', { unique: 0 }, 60, vi.fn().mockResolvedValue([{ id: 0 }]));

        const res = await request(appWithFlag('true')).get('/debug/stats');

        expect(res.body.cache.status).toBe('ok');
        expect(res.body.cache.hits).toBeGreaterThan(0);
    });
});

describe('GET /debug/stats — the redis field is the bounded ping', () => {
    it('reports ok when the ping answers', async () => {
        const res = await request(appWithFlag('true')).get('/debug/stats');

        expect(res.body.redis).toBe('ok');
    });

    it('reports unreachable when the ping rejects', async () => {
        mocks.pingImpl.mockRejectedValue(new Error('ECONNREFUSED'));

        const res = await request(appWithFlag('true')).get('/debug/stats');

        expect(res.body.redis).toBe('unreachable');
    });

    // The endpoint-level form of the timeout guarantee. A wedged Upstash must
    // make this endpoint slow-but-bounded, never hanging — without the race
    // inside redisPing this request never returns and the test dies on the
    // suite timeout instead of asserting anything.
    it('still answers, bounded, when the ping never settles', async () => {
        mocks.pingImpl.mockReturnValue(new Promise(() => {}));

        const startedAt = Date.now();
        const res = await request(appWithFlag('true')).get('/debug/stats');
        const elapsed = Date.now() - startedAt;

        expect(res.status).toBe(200);
        expect(res.body.redis).toBe('unreachable');
        expect(elapsed).toBeLessThan(REDIS_PING_TIMEOUT_MS * 2);
        // The rest of the payload is still served — one wedged dependency does
        // not cost the whole snapshot.
        expect(res.body.cache).toBeDefined();
        expect(res.body.locks).toBeDefined();
    });
});
