import { describe, it, expect, beforeEach, vi } from 'vitest';

// A faithful stand-in for client.js: an in-memory store behind the same
// never-throw signatures. cacheSet round-trips through JSON exactly as the
// Upstash client does, so a value read back here has been through the same
// coercion a real cache hit would apply — a Date stored is an ISO string read.
const mocks = vi.hoisted(() => {
    const store = new Map();
    let enabled = true;

    return {
        store,
        setEnabled: (value) => { enabled = value; },
        isRedisEnabled: vi.fn(() => enabled),
        cacheGet: vi.fn(async (key) => (store.has(key) ? store.get(key) : null)),
        cacheSet: vi.fn(async (key, value) => {
            store.set(key, JSON.parse(JSON.stringify(value)));
        }),
    };
});

vi.mock('../src/redis/client.js', () => ({
    isRedisEnabled: mocks.isRedisEnabled,
    cacheGet: mocks.cacheGet,
    cacheSet: mocks.cacheSet,
}));

const {
    cacheKey,
    withCache,
    getCacheStats,
    __resetCacheStatsForTests,
} = await import('../src/redis/cache.js');

beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.clear();
    mocks.setEnabled(true);
    __resetCacheStatsForTests();
});

describe('cacheKey', () => {
    it('drops undefined, so an omitted filter and an explicit undefined share a key', () => {
        expect(cacheKey('matches:list', { limit: 10 }))
            .toBe(cacheKey('matches:list', { limit: 10, cursor: undefined }));
    });

    it('sorts fields, so param order does not fork the entry', () => {
        expect(cacheKey('matches:list', { limit: 10, status: 'live' }))
            .toBe(cacheKey('matches:list', { status: 'live', limit: 10 }));
    });

    // Regression guard for the values-only "optimization". Absent and
    // present-but-empty stay distinct only because the field NAME survives
    // serialization; drop the names to shorten keys and these collide.
    it('keeps an empty-string value distinct from an absent one', () => {
        const absent = cacheKey('matches:list', { limit: 10 });
        const empty = cacheKey('matches:list', { limit: 10, status: '' });

        expect(absent).not.toBe(empty);
        expect(empty).toContain('status');
    });

    it('keeps null distinct from absent — over-discriminating is the safe direction', () => {
        expect(cacheKey('matches:list', { cursor: null }))
            .not.toBe(cacheKey('matches:list', {}));
    });

    it('separates namespaces carrying identical params', () => {
        expect(cacheKey('matches:list', { limit: 10 }))
            .not.toBe(cacheKey('competitions:list', { limit: 10 }));
    });
});

// The highest-risk property in the whole caching part. A key missing one
// dimension does not fail loudly — it silently serves one query's rows to
// another. Every dimension of the widest query (/matches) is covered, so
// dropping ANY single field from the key builder fails a named test here.
describe('cacheKey completeness — every /matches dimension changes the key', () => {
    const BASE = {
        limit: 10,
        cursor: 500,
        status: 'live',
        startTimeFrom: '2026-01-01T00:00:00.000Z',
        startTimeTo: '2026-03-01T00:00:00.000Z',
    };

    const DIMENSIONS = [
        ['limit', 25],
        ['cursor', 900],
        ['status', 'finished'],
        ['startTimeFrom', '2026-02-01T00:00:00.000Z'],
        ['startTimeTo', '2026-04-01T00:00:00.000Z'],
    ];

    it.each(DIMENSIONS)('%s changes the key', (field, differentValue) => {
        expect(cacheKey('matches:list', BASE))
            .not.toBe(cacheKey('matches:list', { ...BASE, [field]: differentValue }));
    });

    // Asserts MECHANISM as well as outcome. A test that only compared returned
    // rows could pass with a broken key whenever two queries happen to return
    // the same data; the call count proves the second query actually reached
    // its loader rather than being served the first one's cached entry.
    it.each(DIMENSIONS)(
        'a query differing only in %s is loaded separately, never served the other\'s rows',
        async (field, differentValue) => {
            const first = [{ id: 1, marker: 'first' }];
            const second = [{ id: 2, marker: 'second' }];
            const loader = vi.fn()
                .mockResolvedValueOnce(first)
                .mockResolvedValueOnce(second);

            const a = await withCache('matches:list', BASE, 60, loader);
            const b = await withCache('matches:list', { ...BASE, [field]: differentValue }, 60, loader);

            expect(loader).toHaveBeenCalledTimes(2);
            expect(a).toEqual(first);
            expect(b).toEqual(second);
        },
    );
});

describe('withCache', () => {
    it('runs the loader on a miss and caches the result under the built key', async () => {
        const rows = [{ id: 1 }];
        const loader = vi.fn().mockResolvedValue(rows);

        const result = await withCache('matches:list', { limit: 10 }, 60, loader);

        expect(result).toEqual(rows);
        expect(loader).toHaveBeenCalledTimes(1);
        expect(mocks.cacheSet).toHaveBeenCalledWith(
            cacheKey('matches:list', { limit: 10 }),
            rows,
            60,
        );
    });

    it('serves the second identical call from cache without touching the loader', async () => {
        const rows = [{ id: 1 }];
        const loader = vi.fn().mockResolvedValue(rows);

        await withCache('matches:list', { limit: 10 }, 60, loader);
        const second = await withCache('matches:list', { limit: 10 }, 60, loader);

        expect(loader).toHaveBeenCalledTimes(1);
        expect(second).toEqual(rows);
    });

    it('passes each caller\'s own TTL through to cacheSet', async () => {
        await withCache('competitions:list', { limit: 10 }, 3600, vi.fn().mockResolvedValue([{ id: 1 }]));

        expect(mocks.cacheSet).toHaveBeenCalledWith(expect.any(String), [{ id: 1 }], 3600);
    });

    // An empty list is a real answer — "this match has no events" — and must
    // cache, or every request for it re-queries forever. Note this does NOT
    // guard `=== null` against `!result`: `[]` is truthy, so both forms cache
    // it. The falsy-scalar test below is what distinguishes them.
    it('caches an empty array rather than re-querying an empty result forever', async () => {
        const loader = vi.fn().mockResolvedValue([]);

        await withCache('matches:events', { matchId: 1 }, 60, loader);
        const second = await withCache('matches:events', { matchId: 1 }, 60, loader);

        expect(loader).toHaveBeenCalledTimes(1);
        expect(second).toEqual([]);
        expect(mocks.cacheSet).toHaveBeenCalledTimes(1);
    });

    // Guards the `result === null` skip against being loosened to `!result`.
    // These are the only values where the two forms differ: a falsy scalar is
    // a real answer, and the loose form would refuse to cache it forever while
    // reporting nothing wrong.
    it.each([[0], [''], [false]])('caches a falsy scalar result (%j) — only null is skipped', async (value) => {
        const loader = vi.fn().mockResolvedValue(value);

        const first = await withCache('some:scalar', { k: 1 }, 60, loader);
        const second = await withCache('some:scalar', { k: 1 }, 60, loader);

        expect(first).toEqual(value);
        expect(second).toEqual(value);
        expect(loader).toHaveBeenCalledTimes(1);
        expect(mocks.cacheSet).toHaveBeenCalledTimes(1);
        expect(getCacheStats()).toMatchObject({ hits: 1, misses: 1, skipped: 0 });
    });

    // null is excluded because cacheGet returns `value ?? null` and so cannot
    // tell a stored null from a miss — an entry that could never register as
    // a hit while still costing a write.
    it('never caches a null result', async () => {
        const loader = vi.fn().mockResolvedValue(null);

        const result = await withCache('matches:byId', { id: 999 }, 60, loader);

        expect(result).toBeNull();
        expect(mocks.cacheSet).not.toHaveBeenCalled();
    });

    it('re-runs the loader for a null result rather than serving a phantom hit', async () => {
        const loader = vi.fn().mockResolvedValue(null);

        await withCache('matches:byId', { id: 999 }, 60, loader);
        await withCache('matches:byId', { id: 999 }, 60, loader);

        expect(loader).toHaveBeenCalledTimes(2);
    });

    it('lets a loader error propagate — the cache must not swallow a failed query', async () => {
        const loader = vi.fn().mockRejectedValue(new Error('db down'));

        await expect(withCache('matches:list', { limit: 10 }, 60, loader))
            .rejects.toThrow('db down');
        expect(mocks.cacheSet).not.toHaveBeenCalled();
    });

    it('applies the Upstash JSON coercion on a hit — a Date returns as an ISO string', async () => {
        const startTime = new Date('2026-07-12T19:30:00.000Z');
        const loader = vi.fn().mockResolvedValue([{ id: 1, startTime }]);

        const miss = await withCache('matches:list', { limit: 10 }, 60, loader);
        const hit = await withCache('matches:list', { limit: 10 }, 60, loader);

        expect(miss[0].startTime).toBeInstanceOf(Date);
        expect(hit[0].startTime).toBe('2026-07-12T19:30:00.000Z');
        // Identical once serialized, which is the only contract the routes rely on.
        expect(JSON.stringify(miss)).toBe(JSON.stringify(hit));
    });
});

describe('withCache — Redis disabled', () => {
    beforeEach(() => {
        mocks.setEnabled(false);
    });

    it('runs the loader without consulting the cache at all', async () => {
        const rows = [{ id: 1 }];
        const loader = vi.fn().mockResolvedValue(rows);

        const result = await withCache('matches:list', { limit: 10 }, 60, loader);

        expect(result).toEqual(rows);
        expect(mocks.cacheGet).not.toHaveBeenCalled();
        expect(mocks.cacheSet).not.toHaveBeenCalled();
    });

    // The whole point of the short-circuit. Counting a miss per call with
    // Redis switched off would report hits:0 / misses:N — indistinguishable
    // from the configured-but-never-hitting fault these stats exist to expose.
    it('leaves the counters at zero so disabled cannot be mistaken for broken', async () => {
        await withCache('matches:list', { limit: 10 }, 60, vi.fn().mockResolvedValue([{ id: 1 }]));
        await withCache('matches:list', { limit: 25 }, 60, vi.fn().mockResolvedValue([{ id: 2 }]));

        expect(getCacheStats()).toEqual({ enabled: false, hits: 0, misses: 0, skipped: 0 });
    });
});

describe('getCacheStats', () => {
    it('counts a miss then a hit for the same query', async () => {
        const loader = vi.fn().mockResolvedValue([{ id: 1 }]);

        await withCache('matches:list', { limit: 10 }, 60, loader);
        await withCache('matches:list', { limit: 10 }, 60, loader);

        expect(getCacheStats()).toMatchObject({ hits: 1, misses: 1, skipped: 0 });
    });

    it('counts a skip alongside its miss, since a skip always follows one', async () => {
        await withCache('matches:byId', { id: 999 }, 60, vi.fn().mockResolvedValue(null));

        expect(getCacheStats()).toMatchObject({ hits: 0, misses: 1, skipped: 1 });
    });

    it('reports enabled, which is what separates "Redis off" from "Redis broken"', () => {
        expect(getCacheStats().enabled).toBe(true);

        mocks.setEnabled(false);
        expect(getCacheStats().enabled).toBe(false);
    });

    it('resets through the test seam', async () => {
        await withCache('matches:list', { limit: 10 }, 60, vi.fn().mockResolvedValue([{ id: 1 }]));
        expect(getCacheStats().misses).toBe(1);

        __resetCacheStatsForTests();

        expect(getCacheStats()).toMatchObject({ hits: 0, misses: 0, skipped: 0 });
    });
});
