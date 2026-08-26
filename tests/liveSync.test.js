import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Every collaborator is mocked with a factory, so the real modules are never
// evaluated. That matters beyond isolation: matchService and friends import
// db/db.js, which opens a pg pool at module load. Mocking them keeps Postgres
// out of the import graph entirely, so these stay unit tests that run with no
// database and no Upstash credentials.
const {
    acquireLock,
    releaseLock,
    fetchLiveFixtures,
    fetchStatus,
    upsertCompetitions,
    upsertMatches,
    replaceMatchEvents,
    markStaleLiveMatchesFinished,
} = vi.hoisted(() => ({
    acquireLock: vi.fn(),
    releaseLock: vi.fn(),
    fetchLiveFixtures: vi.fn(),
    fetchStatus: vi.fn(),
    upsertCompetitions: vi.fn(),
    upsertMatches: vi.fn(),
    replaceMatchEvents: vi.fn(),
    markStaleLiveMatchesFinished: vi.fn(),
}));

vi.mock('../src/redis/client.js', () => ({ acquireLock, releaseLock }));

vi.mock('../src/services/apiFootball.js', () => ({
    fetchLiveFixtures,
    fetchStatus,
    fetchStandings: vi.fn(),
    mapFixtureToCompetition: (fixture) => ({ externalId: String(fixture.league.id), name: 'L' }),
    mapFixtureToEvents: () => [],
    mapFixtureToMatch: (fixture) => ({ externalId: String(fixture.fixture.id) }),
    mapStandingRow: vi.fn(),
}));

vi.mock('../src/services/matchService.js', () => ({ upsertMatches, markStaleLiveMatchesFinished }));
vi.mock('../src/services/eventService.js', () => ({ replaceMatchEvents }));
vi.mock('../src/services/competitionService.js', () => ({
    upsertCompetitions,
    listCompetitions: vi.fn().mockResolvedValue([]),
}));
vi.mock('../src/services/standingsService.js', () => ({ upsertStandings: vi.fn() }));

const { __pollOnceForTests, startLiveSync, stopLiveSync } = await import('../src/services/liveSync.js');

/** One live fixture, enough to drive the poll past its empty-payload early return. */
const FIXTURE = { fixture: { id: 111 }, league: { id: 39 } };

function lockGranted(token = 'tok-1') {
    return { acquired: true, reason: 'acquired', token };
}

beforeEach(() => {
    vi.clearAllMocks();

    fetchLiveFixtures.mockResolvedValue({ fixtures: [FIXTURE], quota: { remainingDay: 10 } });
    fetchStatus.mockResolvedValue({ status: {}, quota: { remainingDay: 10 } });
    upsertCompetitions.mockResolvedValue([{ externalId: '39', id: 1 }]);
    upsertMatches.mockResolvedValue([{ externalId: '111', id: 7 }]);
    replaceMatchEvents.mockResolvedValue(undefined);
    markStaleLiveMatchesFinished.mockResolvedValue([]);
    acquireLock.mockResolvedValue(lockGranted());
    releaseLock.mockResolvedValue(undefined);
});

afterEach(() => {
    stopLiveSync();
});

describe('liveSync poll lock', () => {
    it('polls and releases with the acquired token when the lock is granted', async () => {
        acquireLock.mockResolvedValue(lockGranted('tok-abc'));

        const count = await __pollOnceForTests();

        expect(fetchLiveFixtures).toHaveBeenCalledTimes(1);
        expect(count).toBe(1);
        expect(releaseLock).toHaveBeenCalledWith('live-sync:poll', 'tok-abc');
    });

    it('acquires with the configured key and TTL', async () => {
        await __pollOnceForTests();

        expect(acquireLock).toHaveBeenCalledWith('live-sync:poll', 60);
    });

    // The quota-saving case the lock exists for.
    it('skips the poll when another instance genuinely holds the lock', async () => {
        acquireLock.mockResolvedValue({ acquired: false, reason: 'held', token: null });

        const count = await __pollOnceForTests();

        // Asserting the mechanism, not just the count: a poll that ran and found
        // nothing would also return 0, so the count alone cannot tell a skip from
        // an empty cycle. No request issued is what a skip actually means.
        expect(fetchLiveFixtures).not.toHaveBeenCalled();
        expect(upsertMatches).not.toHaveBeenCalled();
        expect(count).toBe(0);
    });

    // Graceful degradation. 'error' means we could not ask Redis whether anyone
    // holds the lock — not that someone does. On a single instance nobody does,
    // so refusing to poll would trade a duplicated request for a missed cycle.
    it('polls anyway when Redis errors, rather than skipping', async () => {
        acquireLock.mockResolvedValue({ acquired: false, reason: 'error', token: null });

        const count = await __pollOnceForTests();

        expect(fetchLiveFixtures).toHaveBeenCalledTimes(1);
        expect(count).toBe(1);
    });

    it('releases with a null token when Redis errored, so nothing is wrongly deleted', async () => {
        acquireLock.mockResolvedValue({ acquired: false, reason: 'error', token: null });

        await __pollOnceForTests();

        expect(releaseLock).toHaveBeenCalledWith('live-sync:poll', null);
    });

    // REDIS_ENABLED=false. acquireLock grants with a null token and issues no
    // Redis command; the poller must not notice any difference.
    it('polls normally when Redis is disabled', async () => {
        acquireLock.mockResolvedValue({ acquired: true, reason: 'disabled', token: null });

        const count = await __pollOnceForTests();

        expect(fetchLiveFixtures).toHaveBeenCalledTimes(1);
        expect(count).toBe(1);
        expect(releaseLock).toHaveBeenCalledWith('live-sync:poll', null);
    });

    // Without the finally, a throwing poll would hold the lock until its TTL and
    // block every other instance for a full minute.
    it('releases the lock when the poll body throws', async () => {
        fetchLiveFixtures.mockRejectedValue(new Error('api down'));

        await expect(__pollOnceForTests()).rejects.toThrow('api down');

        expect(releaseLock).toHaveBeenCalledWith('live-sync:poll', 'tok-1');
    });
});

// The permanent-outage guard. runLiveCycle owns the reschedule, so if a lock
// skip ever short-circuited it, a single skipped cycle would stop the poller
// forever — silent, and far worse than the double-polling the lock prevents.
describe('liveSync rescheduling after a lock skip', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        process.env.LIVE_SYNC_INTERVAL_MS = '900000';
        process.env.LIVE_SYNC_IDLE_INTERVAL_MS = '1800000';
    });

    afterEach(() => {
        stopLiveSync();
        vi.useRealTimers();
        delete process.env.LIVE_SYNC_INTERVAL_MS;
        delete process.env.LIVE_SYNC_IDLE_INTERVAL_MS;
    });

    it('reschedules at the idle interval after a skipped cycle, and polls again', async () => {
        acquireLock.mockResolvedValue({ acquired: false, reason: 'held', token: null });
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

        startLiveSync({ broadcast: vi.fn() });
        // Drain the awaited logApiStatus() that gates the first cycle.
        await vi.waitFor(() => expect(acquireLock).toHaveBeenCalled());

        // A skip returns 0, so the cycle must back off to the idle interval
        // rather than the live one.
        const delays = setTimeoutSpy.mock.calls.map(([, delay]) => delay);
        expect(delays).toContain(1_800_000);
        expect(delays).not.toContain(900_000);

        // The poller is still alive: let the lock free up and the next cycle
        // must actually poll. This is what proves a skip did not end the loop.
        acquireLock.mockResolvedValue(lockGranted());
        await vi.advanceTimersByTimeAsync(1_800_000);

        expect(fetchLiveFixtures).toHaveBeenCalledTimes(1);
    });

    // The counterpart to the skip case: proves the idle interval above is a
    // consequence of the skip specifically, not the only delay this code can
    // ever pick.
    it('reschedules at the live interval when a granted poll finds live fixtures', async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

        startLiveSync({ broadcast: vi.fn() });
        await vi.waitFor(() => expect(fetchLiveFixtures).toHaveBeenCalled());

        await vi.waitFor(() => {
            const delays = setTimeoutSpy.mock.calls.map(([, delay]) => delay);
            expect(delays).toContain(900_000);
            expect(delays).not.toContain(1_800_000);
        });
    });
});

/**
 * Tier 1 of reconciliation. These assert the MECHANISM, not just the outcome —
 * "the row ended up finished" could be produced by the ordinary upsert path
 * observing an FT status, which would hide a deleted floor entirely.
 */
describe('liveSync stale-live reconciliation (time floor)', () => {
    it('runs the floor with the 6h cutoff on a normal cycle', async () => {
        await __pollOnceForTests();

        expect(markStaleLiveMatchesFinished).toHaveBeenCalledTimes(1);
        expect(markStaleLiveMatchesFinished).toHaveBeenCalledWith(6);
    });

    it('still runs the floor when the feed comes back EMPTY', async () => {
        // The catastrophic case. An empty feed is indistinguishable from a
        // broken one, so nothing may infer "finished" from absence — but the
        // floor never consults the feed, so it must still run.
        fetchLiveFixtures.mockResolvedValue({ fixtures: [], quota: { remainingDay: 10 } });

        const count = await __pollOnceForTests();

        expect(count).toBe(0);
        expect(upsertMatches).not.toHaveBeenCalled();
        expect(markStaleLiveMatchesFinished).toHaveBeenCalledTimes(1);
    });

    it('still runs the floor when the feed FAILS', async () => {
        fetchLiveFixtures.mockRejectedValue(new Error('API-Football error 500'));

        await expect(__pollOnceForTests()).rejects.toThrow('API-Football error 500');

        // Ordered before the fetch precisely so a broken feed cannot suppress it.
        expect(markStaleLiveMatchesFinished).toHaveBeenCalledTimes(1);
    });

    it('does NOT run the floor when another instance holds the poll lock', async () => {
        acquireLock.mockResolvedValue({ acquired: false, reason: 'held', token: null });

        await __pollOnceForTests();

        expect(markStaleLiveMatchesFinished).not.toHaveBeenCalled();
    });

    it('a failing floor does not break the poll', async () => {
        // Graceful degradation: reconciliation is a step inside the poll, not a
        // precondition for it.
        markStaleLiveMatchesFinished.mockRejectedValue(new Error('db down'));

        const count = await __pollOnceForTests();

        expect(count).toBe(1);
        expect(fetchLiveFixtures).toHaveBeenCalledTimes(1);
        expect(releaseLock).toHaveBeenCalledTimes(1);
    });
});
