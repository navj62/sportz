import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    fetchLiveFixtures,
    fetchStandings,
    mapStatus,
    mapFixtureToMatch,
    mapFixtureToCompetition,
    mapFixtureToEvents,
} from '../src/services/apiFootball.js';

// Shapes below are trimmed from real /fixtures?live=all and /standings payloads.

function envelope(response, { errors = [], headers = {}, status = 200 } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: 'OK',
        headers: new Headers({
            'x-ratelimit-requests-remaining': '95',
            'x-ratelimit-requests-limit': '100',
            'x-ratelimit-remaining': '9',
            ...headers,
        }),
        json: async () => ({
            get: 'fixtures',
            parameters: {},
            errors,
            results: Array.isArray(response) ? response.length : 0,
            paging: { current: 1, total: 1 },
            response,
        }),
    };
}

const FIXTURE = {
    fixture: {
        id: 1498641,
        date: '2026-07-12T19:30:00+00:00',
        status: { long: 'First Half', short: '1H', elapsed: 31 },
    },
    league: {
        id: 129,
        name: 'Primera Nacional',
        country: 'Argentina',
        logo: 'https://media.api-sports.io/football/leagues/129.png',
        season: 2026,
        round: 'Regular Season - 20',
    },
    teams: {
        home: { id: 439, name: 'Godoy Cruz', logo: 'https://home.png', winner: null },
        away: { id: 1067, name: 'Defensores', logo: 'https://away.png', winner: null },
    },
    goals: { home: 1, away: 0 },
    events: [
        {
            time: { elapsed: 4, extra: null },
            team: { id: 1067, name: 'Defensores', logo: 'https://away.png' },
            player: { id: 16385, name: 'A. Lopez' },
            assist: { id: null, name: null },
            type: 'Goal',
            detail: 'Own Goal',
            comments: null,
        },
        {
            time: { elapsed: 63, extra: null },
            team: { id: 439, name: 'Godoy Cruz', logo: 'https://home.png' },
            // player.name is null on ~23% of real events
            player: { id: null, name: null },
            assist: { id: null, name: null },
            type: 'Card',
            detail: 'Yellow Card',
            comments: null,
        },
    ],
};

describe('apiFootball', () => {
    beforeEach(() => {
        process.env.API_FOOTBALL_KEY = 'test-key';
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // ── Envelope error handling ───────────────────────────────────────────────

    it('throws on HTTP 200 carrying an errors OBJECT — the plan-gate shape', async () => {
        // The real free-tier standings failure: HTTP 200, errors is an object.
        // A naive `errors.length > 0` check passes straight through this.
        vi.stubGlobal('fetch', vi.fn(async () => envelope([], {
            errors: { plan: 'Free plans do not have access to this season, try from 2022 to 2024.' },
            headers: {},
        })));

        await expect(fetchStandings(129, 2026)).rejects.toThrow(/Free plans do not have access/);
    });

    it('throws on HTTP 200 carrying a non-empty errors ARRAY', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => envelope([], { errors: ['Invalid api key'] })));

        await expect(fetchLiveFixtures()).rejects.toThrow(/Invalid api key/);
    });

    it('does not throw when errors is an empty array', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => envelope([FIXTURE])));

        const { fixtures, quota } = await fetchLiveFixtures();
        expect(fixtures).toHaveLength(1);
        expect(quota.remainingDay).toBe(95);
        expect(quota.remainingMinute).toBe(9);
    });

    it('reads quota as null when the API omits the headers', async () => {
        // The plan-gate error response really does come back with no quota headers.
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({}),
            json: async () => ({ errors: [], results: 0, paging: {}, response: [] }),
        })));

        const { quota } = await fetchLiveFixtures();
        expect(quota.remainingDay).toBeNull();
        expect(quota.limitDay).toBeNull();
    });

    it('sends the api key as the x-apisports-key header', async () => {
        const spy = vi.fn(async () => envelope([FIXTURE]));
        vi.stubGlobal('fetch', spy);

        await fetchLiveFixtures();

        const [url, init] = spy.mock.calls[0];
        expect(url).toBe('https://v3.football.api-sports.io/fixtures?live=all');
        expect(init.headers['x-apisports-key']).toBe('test-key');
    });

    it('throws when API_FOOTBALL_KEY is missing — and only when called, not on import', async () => {
        delete process.env.API_FOOTBALL_KEY;
        vi.stubGlobal('fetch', vi.fn());

        await expect(fetchLiveFixtures()).rejects.toThrow(/API_FOOTBALL_KEY is not defined/);
    });

    // ── Quota backoff ─────────────────────────────────────────────────────────

    it('backs off exponentially on 429 and gives up after 3 retries', async () => {
        vi.useFakeTimers();
        const spy = vi.fn(async () => ({
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
            headers: new Headers({}),
            json: async () => ({}),
        }));
        vi.stubGlobal('fetch', spy);

        const promise = fetchLiveFixtures();
        const assertion = expect(promise).rejects.toThrow(/rate limited .* after 3 retries/);

        // 1s + 2s + 4s of backoff, then the 4th attempt gives up
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.advanceTimersByTimeAsync(2_000);
        await vi.advanceTimersByTimeAsync(4_000);

        await assertion;
        expect(spy).toHaveBeenCalledTimes(4); // initial + 3 retries
    });

    it('does not retry immediately — the first 429 waits before re-requesting', async () => {
        vi.useFakeTimers();
        const spy = vi.fn(async () => ({
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
            headers: new Headers({}),
            json: async () => ({}),
        }));
        vi.stubGlobal('fetch', spy);

        const promise = fetchLiveFixtures();
        promise.catch(() => {}); // settled later; asserted in the test above

        await vi.advanceTimersByTimeAsync(0);
        expect(spy).toHaveBeenCalledTimes(1); // still waiting — no hot retry loop

        await vi.advanceTimersByTimeAsync(1_000);
        expect(spy).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(10_000);
    });

    it('recovers when a 429 is followed by a success', async () => {
        vi.useFakeTimers();
        const spy = vi.fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 429,
                statusText: 'Too Many Requests',
                headers: new Headers({}),
                json: async () => ({}),
            })
            .mockResolvedValueOnce(envelope([FIXTURE]));
        vi.stubGlobal('fetch', spy);

        const promise = fetchLiveFixtures();
        await vi.advanceTimersByTimeAsync(1_000);

        const { fixtures } = await promise;
        expect(fixtures).toHaveLength(1);
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it('honours Retry-After when the API supplies it', async () => {
        vi.useFakeTimers();
        const spy = vi.fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 429,
                statusText: 'Too Many Requests',
                headers: new Headers({ 'retry-after': '5' }),
                json: async () => ({}),
            })
            .mockResolvedValueOnce(envelope([FIXTURE]));
        vi.stubGlobal('fetch', spy);

        const promise = fetchLiveFixtures();

        await vi.advanceTimersByTimeAsync(1_000);
        expect(spy).toHaveBeenCalledTimes(1); // 1s is not enough — Retry-After said 5s

        await vi.advanceTimersByTimeAsync(4_000);
        await promise;
        expect(spy).toHaveBeenCalledTimes(2);
    });

    // ── Mapping ───────────────────────────────────────────────────────────────

    it('maps API-Football status codes onto match_status', () => {
        expect(mapStatus('NS')).toBe('scheduled');
        expect(mapStatus('1H')).toBe('live');
        expect(mapStatus('HT')).toBe('live');
        expect(mapStatus('FT')).toBe('finished');
        expect(mapStatus('AET')).toBe('finished');
        expect(mapStatus('PEN')).toBe('finished');
        // AWD/WO have a real result despite not being a normal full time.
        expect(mapStatus('AWD')).toBe('finished');
        expect(mapStatus('WO')).toBe('finished');
        expect(mapStatus('PST')).toBe('postponed');
        expect(mapStatus('CANC')).toBe('cancelled');
        // Abandoned doesn't resume, so it's closer to cancelled than postponed.
        expect(mapStatus('ABD')).toBe('cancelled');
        // Unknown codes must not throw
        expect(mapStatus('WHAT')).toBe('scheduled');
    });

    it('maps a fixture onto a match row', () => {
        const match = mapFixtureToMatch(FIXTURE, 7);
        expect(match).toMatchObject({
            externalId: '1498641',
            competitionId: 7,
            homeTeam: 'Godoy Cruz',
            homeTeamExternalId: '439',
            awayTeam: 'Defensores',
            awayTeamExternalId: '1067',
            status: 'live',
            homeScore: 1,
            awayScore: 0,
        });
        expect(match.startTime).toBeInstanceOf(Date);
    });

    it('defaults null goals to 0 — not-yet-started fixtures have null scores', () => {
        const notStarted = { ...FIXTURE, goals: { home: null, away: null } };
        const match = mapFixtureToMatch(notStarted, null);
        expect(match.homeScore).toBe(0);
        expect(match.awayScore).toBe(0);
    });

    it('maps a fixture league onto a competition, keeping round as text', () => {
        expect(mapFixtureToCompetition(FIXTURE)).toEqual({
            externalId: '129',
            name: 'Primera Nacional',
            country: 'Argentina',
            season: 2026,
            currentRound: 'Regular Season - 20',
            logoUrl: 'https://media.api-sports.io/football/leagues/129.png',
        });
    });

    it('derives teamSide by comparing the event team against the fixture home team', () => {
        const events = mapFixtureToEvents(FIXTURE, 42);
        expect(events).toHaveLength(2);

        // Own goal, scored by the AWAY team (id 1067)
        expect(events[0]).toMatchObject({
            matchId: 42,
            minute: 4,
            type: 'Goal',
            detail: 'Own Goal',
            playerName: 'A. Lopez',
            teamSide: 'away',
        });

        // Card against the HOME team (id 439), with no player attached
        expect(events[1]).toMatchObject({
            matchId: 42,
            minute: 63,
            type: 'Card',
            detail: 'Yellow Card',
            playerName: null,
            teamSide: 'home',
        });
    });

    it('leaves metadata null when an event carries no assist, comments or extra time', () => {
        const events = mapFixtureToEvents(FIXTURE, 42);
        expect(events[0].metadata).toBeNull();
    });

    it('populates metadata when an assist is present', () => {
        const withAssist = {
            ...FIXTURE,
            events: [{
                ...FIXTURE.events[0],
                assist: { id: 99, name: 'B. Silva' },
            }],
        };
        const [event] = mapFixtureToEvents(withAssist, 42);
        expect(event.metadata).toEqual({ assist: 'B. Silva', comments: null, extra: null });
    });

    it('returns no events for a fixture with an absent events array', () => {
        const { events, ...noEvents } = FIXTURE;
        expect(mapFixtureToEvents(noEvents, 42)).toEqual([]);
    });

    it('stores the incoming player under incomingPlayer for substitution events, not assist', () => {
        const withSubst = {
            ...FIXTURE,
            events: [{
                ...FIXTURE.events[0],
                type: 'subst',
                detail: 'Substitution 1',
                player: { id: 111, name: 'Outgoing Player' },
                assist: { id: 222, name: 'Incoming Player' },
            }],
        };
        const [event] = mapFixtureToEvents(withSubst, 42);
        expect(event.playerName).toBe('Outgoing Player');
        expect(event.metadata).toEqual({ incomingPlayer: 'Incoming Player', comments: null, extra: null });
        expect(event.metadata).not.toHaveProperty('assist');
    });

    it('flattens standings groups — a cup returns several, a league one', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => envelope([{
            league: {
                standings: [
                    [{ rank: 1, team: { id: 50, name: 'Man City', logo: null }, points: 91, goalsDiff: 62, group: 'Premier League', form: 'WWWWW', description: null, all: { played: 38, win: 28, draw: 7, lose: 3, goals: { for: 96, against: 34 } } }],
                    [{ rank: 1, team: { id: 42, name: 'Arsenal', logo: null }, points: 89, goalsDiff: 62, group: 'Group B', form: 'WWWWL', description: null, all: { played: 38, win: 28, draw: 5, lose: 5, goals: { for: 91, against: 29 } } }],
                ],
            },
        }])));

        const { rows } = await fetchStandings(39, 2023);
        expect(rows).toHaveLength(2);
        expect(rows[0].team.name).toBe('Man City');
        expect(rows[1].team.name).toBe('Arsenal');
    });
});
