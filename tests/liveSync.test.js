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
    applyConfirmedFinals,
    fetchFixturesByDate,
} = vi.hoisted(() => ({
    acquireLock: vi.fn(),
    releaseLock: vi.fn(),
    fetchLiveFixtures: vi.fn(),
    fetchStatus: vi.fn(),
    upsertCompetitions: vi.fn(),
    upsertMatches: vi.fn(),
    replaceMatchEvents: vi.fn(),
    markStaleLiveMatchesFinished: vi.fn(),
    applyConfirmedFinals: vi.fn(),
    fetchFixturesByDate: vi.fn(),
}));

vi.mock('../src/redis/client.js', () => ({ acquireLock, releaseLock }));

vi.mock('../src/services/apiFootball.js', () => ({
    fetchLiveFixtures,
    fetchFixturesByDate,
    fetchStatus,
    mapStatus: (short) => (short === 'FT' ? 'finished' : short === 'CANC' ? 'cancelled' : 'live'),
    fetchStandings: vi.fn(),
    mapFixtureToCompetition: (fixture) => ({ externalId: String(fixture.league.id), name: 'L' }),
    mapFixtureToEvents: () => [],
    mapFixtureToMatch: (fixture) => ({ externalId: String(fixture.fixture.id) }),
    mapStandingRow: vi.fn(),
}));

vi.mock('../src/services/matchService.js', () => ({ upsertMatches, markStaleLiveMatchesFinished, applyConfirmedFinals }));
vi.mock('../src/services/eventService.js', () => ({ replaceMatchEvents }));
vi.mock('../src/services/competitionService.js', () => ({
    upsertCompetitions,
    listCompetitions: vi.fn().mockResolvedValue([]),
}));
vi.mock('../src/services/standingsService.js', () => ({ upsertStandings: vi.fn() }));

const { __pollOnceForTests, __resetReconcileStateForTests, startLiveSync, stopLiveSync } = await import('../src/services/liveSync.js');

/** One live fixture, enough to drive the poll past its empty-payload early return. */
const FIXTURE = { fixture: { id: 111, date: '2026-08-26T09:00:00+00:00' }, league: { id: 39 } };

/** A second live fixture, so a cycle can drop one and keep the other. */
const FIXTURE_2 = { fixture: { id: 222, date: '2026-08-26T09:00:00+00:00' }, league: { id: 39 } };

/** How the date sweep reports a departed fixture. */
function finishedFixture(id, home, away) {
    return {
        fixture: { id, date: '2026-08-26T09:00:00+00:00', status: { short: 'FT' } },
        goals: { home, away },
    };
}

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
    applyConfirmedFinals.mockResolvedValue([]);
    fetchFixturesByDate.mockResolvedValue({ fixtures: [], quota: { remainingDay: 10 } });
    __resetReconcileStateForTests();
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

/**
 * Tier 2 of reconciliation. The properties under test are the ones whose
 * failure mode is silent and catastrophic: an absence counted against a cycle
 * that did not genuinely succeed, or a departure acted on before the threshold.
 * Both assert on MECHANISM — whether a request was made and with what — rather
 * than on a final row state, which the ordinary upsert path could also produce.
 */
describe('liveSync departure confirmation (date sweep)', () => {
    const live = (...fixtures) =>
        fetchLiveFixtures.mockResolvedValue({ fixtures, quota: { remainingDay: 10 } });

    it('does NOT confirm after a single absence', async () => {
        live(FIXTURE, FIXTURE_2);
        await __pollOnceForTests();

        live(FIXTURE); // 222 absent once — below the threshold of 2
        await __pollOnceForTests();

        expect(fetchFixturesByDate).not.toHaveBeenCalled();
        expect(applyConfirmedFinals).not.toHaveBeenCalled();
    });

    it('confirms once the absence threshold is reached', async () => {
        live(FIXTURE, FIXTURE_2);
        await __pollOnceForTests();
        live(FIXTURE);
        await __pollOnceForTests();
        await __pollOnceForTests(); // 222 absent twice

        expect(fetchFixturesByDate).toHaveBeenCalledTimes(1);
        expect(fetchFixturesByDate).toHaveBeenCalledWith('2026-08-26');
    });

    it('resets the counter when a match reappears', async () => {
        live(FIXTURE, FIXTURE_2);
        await __pollOnceForTests();
        live(FIXTURE);
        await __pollOnceForTests();          // 222 absent once
        live(FIXTURE, FIXTURE_2);
        await __pollOnceForTests();          // 222 back — consecutive run broken
        live(FIXTURE);
        await __pollOnceForTests();          // absent once again, not twice

        expect(fetchFixturesByDate).not.toHaveBeenCalled();
    });

    it('resets the counter to ZERO on reappearance, rather than decrementing it', async () => {
        // Distinguishes reset from decrement, which a single absent-then-back
        // cycle cannot: both leave the counter at 0 there. Only a match that
        // accumulated SEVERAL absences before returning tells them apart —
        // decrementing would leave it at or above the threshold and keep it in
        // the departure list forever, re-confirming a match that is plainly
        // live every time the cooldown lapses.
        //
        // Confirm is disabled while the absences accumulate so the sweep
        // neither resolves the entry nor starts the cooldown, which would mask
        // the difference.
        process.env.RECONCILE_CONFIRM_ENABLED = 'false';
        try {
            live(FIXTURE, FIXTURE_2);
            await __pollOnceForTests();
            live(FIXTURE);
            await __pollOnceForTests();      // 222 absent once
            await __pollOnceForTests();      // 222 absent twice — at the threshold
            live(FIXTURE, FIXTURE_2);
            await __pollOnceForTests();      // 222 back: reset -> 0, decrement -> 1
        } finally {
            delete process.env.RECONCILE_CONFIRM_ENABLED;
        }

        live(FIXTURE);
        await __pollOnceForTests();          // reset -> 1 (below), decrement -> 2 (at)

        expect(fetchFixturesByDate).not.toHaveBeenCalled();
    });

    it('does NOT count an absence against an EMPTY cycle', async () => {
        // The catastrophic case, and the reason tier 2 sits after the
        // empty-payload early return. An empty feed is indistinguishable from a
        // broken one; if it counted, a single outage would age every live match
        // to the threshold at once and mark the whole table finished.
        live(FIXTURE, FIXTURE_2);
        await __pollOnceForTests();

        live(); // empty
        await __pollOnceForTests();
        await __pollOnceForTests();
        await __pollOnceForTests();

        expect(fetchFixturesByDate).not.toHaveBeenCalled();
        expect(applyConfirmedFinals).not.toHaveBeenCalled();
    });

    it('does NOT count an absence against a FAILED cycle', async () => {
        live(FIXTURE, FIXTURE_2);
        await __pollOnceForTests();

        fetchLiveFixtures.mockRejectedValue(new Error('API-Football error 500'));
        await expect(__pollOnceForTests()).rejects.toThrow();
        await expect(__pollOnceForTests()).rejects.toThrow();

        expect(fetchFixturesByDate).not.toHaveBeenCalled();
    });

    it('makes ONE request for several departures sharing a date', async () => {
        // The whole reason confirm is by date rather than by id: cost is per
        // date, not per match.
        const third = { fixture: { id: 333, date: '2026-08-26T09:00:00+00:00' }, league: { id: 39 } };
        live(FIXTURE, FIXTURE_2, third);
        await __pollOnceForTests();
        live(FIXTURE);
        await __pollOnceForTests();
        await __pollOnceForTests(); // 222 AND 333 both departed

        expect(fetchFixturesByDate).toHaveBeenCalledTimes(1);
    });

    it('writes the CONFIRMED final score, not the last-polled one', async () => {
        fetchFixturesByDate.mockResolvedValue({
            fixtures: [finishedFixture(222, 3, 1)],
            quota: { remainingDay: 10 },
        });

        live(FIXTURE, FIXTURE_2);
        await __pollOnceForTests();
        live(FIXTURE);
        await __pollOnceForTests();
        await __pollOnceForTests();

        expect(applyConfirmedFinals).toHaveBeenCalledTimes(1);
        const [rows] = applyConfirmedFinals.mock.calls[0];
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            externalId: '222',
            status: 'finished',
            homeScore: 3,
            awayScore: 1,
        });
        // A confirmed finish is the only path that may claim an end time.
        expect(rows[0].endTime).toBeInstanceOf(Date);
    });

    it('writes no end_time for a non-finish outcome', async () => {
        fetchFixturesByDate.mockResolvedValue({
            fixtures: [{ fixture: { id: 222, status: { short: 'CANC' } }, goals: { home: 0, away: 0 } }],
            quota: { remainingDay: 10 },
        });

        live(FIXTURE, FIXTURE_2);
        await __pollOnceForTests();
        live(FIXTURE);
        await __pollOnceForTests();
        await __pollOnceForTests();

        const [rows] = applyConfirmedFinals.mock.calls[0];
        expect(rows[0]).toMatchObject({ externalId: '222', status: 'cancelled' });
        expect(rows[0].endTime).toBeNull();
    });

    it('writes nothing when the confirm says the match is STILL LIVE', async () => {
        // A transient feed dropout, not a departure. Absence proposed it; the
        // explicit marker overrules it.
        fetchFixturesByDate.mockResolvedValue({
            fixtures: [{ fixture: { id: 222, status: { short: '2H' } }, goals: { home: 1, away: 0 } }],
            quota: { remainingDay: 10 },
        });

        live(FIXTURE, FIXTURE_2);
        await __pollOnceForTests();
        live(FIXTURE);
        await __pollOnceForTests();
        await __pollOnceForTests();

        expect(fetchFixturesByDate).toHaveBeenCalledTimes(1);
        expect(applyConfirmedFinals).not.toHaveBeenCalled();
    });

    it('honours the cooldown — a second sweep in the same hour costs no request', async () => {
        live(FIXTURE, FIXTURE_2);
        await __pollOnceForTests();
        live(FIXTURE);
        await __pollOnceForTests();
        await __pollOnceForTests(); // sweep 1
        await __pollOnceForTests(); // would be sweep 2, inside the cooldown

        expect(fetchFixturesByDate).toHaveBeenCalledTimes(1);
    });

    it('spends NO request when there are no departures', async () => {
        live(FIXTURE, FIXTURE_2);
        await __pollOnceForTests();
        await __pollOnceForTests();
        await __pollOnceForTests();

        expect(fetchFixturesByDate).not.toHaveBeenCalled();
    });

    it('is disabled by exactly the string "false"', async () => {
        process.env.RECONCILE_CONFIRM_ENABLED = 'false';
        try {
            live(FIXTURE, FIXTURE_2);
            await __pollOnceForTests();
            live(FIXTURE);
            await __pollOnceForTests();
            await __pollOnceForTests();

            expect(fetchFixturesByDate).not.toHaveBeenCalled();
        } finally {
            delete process.env.RECONCILE_CONFIRM_ENABLED;
        }
    });

    it('stays enabled when the flag is unset or any other value', async () => {
        process.env.RECONCILE_CONFIRM_ENABLED = 'yes';
        try {
            live(FIXTURE, FIXTURE_2);
            await __pollOnceForTests();
            live(FIXTURE);
            await __pollOnceForTests();
            await __pollOnceForTests();

            expect(fetchFixturesByDate).toHaveBeenCalledTimes(1);
        } finally {
            delete process.env.RECONCILE_CONFIRM_ENABLED;
        }
    });

    it('a failing confirm does not break the poll', async () => {
        fetchFixturesByDate.mockRejectedValue(new Error('API-Football error 500'));

        live(FIXTURE, FIXTURE_2);
        await __pollOnceForTests();
        live(FIXTURE);
        await __pollOnceForTests();
        const count = await __pollOnceForTests();

        expect(count).toBe(1);
        expect(releaseLock).toHaveBeenCalledTimes(3);
    });
});
