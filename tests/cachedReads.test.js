import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { fileURLToPath } from 'url';
import path from 'path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

// Real Upstash and a real database — the point of this suite is the
// cache-ENABLED path, which integration.test.js deliberately switches off so
// its assertions still prove the DB queries are right. Only cacheSet is
// wrapped, and it wraps the REAL implementation: the call still reaches
// Upstash, the spy just makes the TTL argument observable. A fully mocked
// client would leave the wiring covered by nothing but mocks.
vi.mock('../src/redis/client.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, cacheSet: vi.fn(actual.cacheSet) };
});

const { cacheSet, cacheDel, isRedisEnabled } = await import('../src/redis/client.js');
const { getCacheStats, __resetCacheStatsForTests } = await import('../src/redis/cache.js');
const { createApp } = await import('../src/app.js');
const { db, pool } = await import('../src/db/db.js');
const { matches, events, competitions, standings } = await import('../src/db/schema.js');

const migrationsFolder = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'drizzle',
);

// Needs BOTH a test database and Upstash credentials. Without either, the
// cache-enabled path cannot be exercised at all and passing would be vacuous.
const skip = !process.env.TEST_DATABASE_URL || !process.env.UPSTASH_REDIS_REST_URL;

describe.skipIf(skip)('Cached reads — cache enabled', () => {
    let app;

    async function seedMatch(overrides = {}) {
        const [match] = await db
            .insert(matches)
            .values({
                homeTeam: 'Team A',
                awayTeam: 'Team B',
                status: 'scheduled',
                startTime: new Date('2026-01-01T15:00:00Z'),
                homeScore: 0,
                awayScore: 0,
                ...overrides,
            })
            .returning();
        return match;
    }

    async function seedCompetition(overrides = {}) {
        const [competition] = await db
            .insert(competitions)
            .values({
                externalId: `league-${Math.random().toString(36).slice(2, 8)}`,
                name: 'Premier League',
                country: 'England',
                season: 2026,
                ...overrides,
            })
            .returning();
        return competition;
    }

    beforeAll(async () => {
        // Same guard as the integration suite, for the same reason: this suite
        // TRUNCATEs, and a silently-failed redirect once let that hit the real
        // database. Never weaken this.
        const expected = new URL(process.env.TEST_DATABASE_URL).hostname;
        const actual = new URL(process.env.DATABASE_URL).hostname;
        if (expected !== actual) {
            throw new Error(
                `Refusing to run: pool points at ${actual}, not the test DB ${expected}`,
            );
        }

        await migrate(db, { migrationsFolder });
        app = createApp();
    });

    beforeEach(() => {
        __resetCacheStatsForTests();
    });

    afterEach(async () => {
        // Delete every key this test actually wrote. Reading the keys off the
        // spy rather than listing them by hand means the cleanup cannot drift
        // out of step with what the tests cache — a leftover entry would leak
        // one test's rows into the next, exactly the staleness that forced the
        // integration suite to turn the cache off.
        for (const [key] of cacheSet.mock.calls) {
            await cacheDel(key);
        }
        vi.clearAllMocks();

        await pool.query(
            'TRUNCATE TABLE events, standings, competitions, matches RESTART IDENTITY CASCADE',
        );
    });

    afterAll(async () => {
        await pool.end();
    });

    // Gate. Both suites in this repo have a skipIf, and a green summary that
    // silently ran nothing is the failure mode this asserts against.
    it('runs with Redis actually enabled — otherwise this suite proves nothing', () => {
        expect(isRedisEnabled()).toBe(true);
        expect(getCacheStats().enabled).toBe(true);
    });

    // ── GET /matches ─────────────────────────────────────────────────────────

    it('GET /matches: cold miss then warm hit, served from cache the second time', async () => {
        await seedMatch();

        const first = await request(app).get('/matches');
        expect(first.status).toBe(200);
        expect(getCacheStats()).toMatchObject({ hits: 0, misses: 1 });

        const second = await request(app).get('/matches');
        expect(second.status).toBe(200);
        // Mechanism: the hit counter moved, so the second response came from
        // the cache and not from a second identical query.
        expect(getCacheStats()).toMatchObject({ hits: 1, misses: 1 });
        expect(second.body).toEqual(first.body);
    });

    it('GET /matches: a different status filter gets its own entry, never the other\'s rows', async () => {
        await seedMatch({ status: 'live', homeTeam: 'Live FC' });
        await seedMatch({ status: 'finished', homeTeam: 'Finished FC' });

        const live = await request(app).get('/matches?status=live');
        const finished = await request(app).get('/matches?status=finished');

        // Two misses, no hit: the second query reached the database rather than
        // being served the first one's entry.
        expect(getCacheStats()).toMatchObject({ hits: 0, misses: 2 });
        expect(live.body.data).toHaveLength(1);
        expect(finished.body.data).toHaveLength(1);
        expect(live.body.data[0].homeTeam).toBe('Live FC');
        expect(finished.body.data[0].homeTeam).toBe('Finished FC');
    });

    // ── GET /matches/:id ─────────────────────────────────────────────────────

    it('GET /matches/:id: cold miss then warm hit', async () => {
        const match = await seedMatch();

        const first = await request(app).get(`/matches/${match.id}`);
        const second = await request(app).get(`/matches/${match.id}`);

        expect(getCacheStats()).toMatchObject({ hits: 1, misses: 1 });
        expect(second.body).toEqual(first.body);
        expect(second.body.match.id).toBe(match.id);
    });

    it('GET /matches/:id: a different id gets its own entry', async () => {
        const a = await seedMatch({ homeTeam: 'A FC' });
        const b = await seedMatch({ homeTeam: 'B FC' });

        const first = await request(app).get(`/matches/${a.id}`);
        const second = await request(app).get(`/matches/${b.id}`);

        expect(getCacheStats()).toMatchObject({ hits: 0, misses: 2 });
        expect(first.body.match.homeTeam).toBe('A FC');
        expect(second.body.match.homeTeam).toBe('B FC');
    });

    it('GET /matches/:id: a 404 is counted as a skip and never cached', async () => {
        const first = await request(app).get('/matches/99999');
        const second = await request(app).get('/matches/99999');

        expect(first.status).toBe(404);
        expect(second.status).toBe(404);
        // Two misses and two skips — a null result must not occupy an entry
        // that could never register as a hit.
        expect(getCacheStats()).toMatchObject({ hits: 0, misses: 2, skipped: 2 });
    });

    // ── GET /matches/:id/events ──────────────────────────────────────────────

    it('GET /matches/:id/events: cold miss then warm hit', async () => {
        const match = await seedMatch();
        await db.insert(events).values({
            matchId: match.id, minute: 10, type: 'Goal', detail: 'Normal Goal',
            playerName: 'Saka', teamSide: 'home',
        });

        const first = await request(app).get(`/matches/${match.id}/events`);
        const second = await request(app).get(`/matches/${match.id}/events`);

        expect(getCacheStats()).toMatchObject({ hits: 1, misses: 1 });
        expect(second.body).toEqual(first.body);
        expect(second.body.data).toHaveLength(1);
    });

    it('GET /matches/:id/events: a different match gets its own entry', async () => {
        const a = await seedMatch();
        const b = await seedMatch();
        await db.insert(events).values({
            matchId: a.id, minute: 10, type: 'Goal', teamSide: 'home',
        });

        const first = await request(app).get(`/matches/${a.id}/events`);
        const second = await request(app).get(`/matches/${b.id}/events`);

        expect(getCacheStats()).toMatchObject({ hits: 0, misses: 2 });
        expect(first.body.data).toHaveLength(1);
        expect(second.body.data).toEqual([]);
    });

    it('GET /matches/:id/events: an empty list is cached, not re-queried forever', async () => {
        const match = await seedMatch();

        await request(app).get(`/matches/${match.id}/events`);
        const second = await request(app).get(`/matches/${match.id}/events`);

        expect(getCacheStats()).toMatchObject({ hits: 1, misses: 1, skipped: 0 });
        expect(second.body.data).toEqual([]);
    });

    // ── GET /competitions ────────────────────────────────────────────────────

    it('GET /competitions: cold miss then warm hit', async () => {
        await seedCompetition();

        const first = await request(app).get('/competitions');
        const second = await request(app).get('/competitions');

        expect(getCacheStats()).toMatchObject({ hits: 1, misses: 1 });
        expect(second.body).toEqual(first.body);
    });

    it('GET /competitions: a different limit gets its own entry', async () => {
        await seedCompetition();
        await seedCompetition();

        const first = await request(app).get('/competitions?limit=1');
        const second = await request(app).get('/competitions?limit=2');

        expect(getCacheStats()).toMatchObject({ hits: 0, misses: 2 });
        expect(first.body.data).toHaveLength(1);
        expect(second.body.data).toHaveLength(2);
    });

    // ── GET /competitions/:id/standings ──────────────────────────────────────

    it('GET /competitions/:id/standings: cold miss then warm hit', async () => {
        const competition = await seedCompetition();
        await db.insert(standings).values({
            competitionId: competition.id, season: 2026, rank: 1,
            teamExternalId: '42', teamName: 'Arsenal',
        });

        const first = await request(app).get(`/competitions/${competition.id}/standings`);
        const second = await request(app).get(`/competitions/${competition.id}/standings`);

        expect(getCacheStats()).toMatchObject({ hits: 1, misses: 1 });
        expect(second.body).toEqual(first.body);
        expect(second.body.data).toHaveLength(1);
    });

    it('GET /competitions/:id/standings: a different season gets its own entry', async () => {
        const competition = await seedCompetition();
        await db.insert(standings).values({
            competitionId: competition.id, season: 2026, rank: 1,
            teamExternalId: '42', teamName: 'Arsenal',
        });

        const unfiltered = await request(app).get(`/competitions/${competition.id}/standings`);
        const otherSeason = await request(app).get(`/competitions/${competition.id}/standings?season=2025`);

        expect(getCacheStats()).toMatchObject({ hits: 0, misses: 2 });
        expect(unfiltered.body.data).toHaveLength(1);
        expect(otherSeason.body.data).toEqual([]);
    });

    // ── Per-endpoint TTLs ────────────────────────────────────────────────────
    // Asserts the TTL each endpoint actually passes, not merely that something
    // was cached. A TTL copy-pasted from the wrong endpoint still caches
    // perfectly well and would otherwise go unnoticed.

    describe('per-endpoint TTLs', () => {
        it('caches /matches for 60s', async () => {
            await seedMatch();
            await request(app).get('/matches');

            expect(cacheSet).toHaveBeenCalledWith(
                expect.stringMatching(/^matches:list:/), expect.anything(), 60,
            );
        });

        it('caches /matches/:id for 60s', async () => {
            const match = await seedMatch();
            await request(app).get(`/matches/${match.id}`);

            expect(cacheSet).toHaveBeenCalledWith(
                expect.stringMatching(/^matches:byId:/), expect.anything(), 60,
            );
        });

        it('caches /matches/:id/events for 60s', async () => {
            const match = await seedMatch();
            await request(app).get(`/matches/${match.id}/events`);

            expect(cacheSet).toHaveBeenCalledWith(
                expect.stringMatching(/^matches:events:/), expect.anything(), 60,
            );
        });

        it('caches /competitions for 3600s — near-static data', async () => {
            await seedCompetition();
            await request(app).get('/competitions');

            expect(cacheSet).toHaveBeenCalledWith(
                expect.stringMatching(/^competitions:list:/), expect.anything(), 3600,
            );
        });

        it('caches /competitions/:id/standings for 300s', async () => {
            const competition = await seedCompetition();
            await request(app).get(`/competitions/${competition.id}/standings`);

            expect(cacheSet).toHaveBeenCalledWith(
                expect.stringMatching(/^standings:byCompetition:/), expect.anything(), 300,
            );
        });
    });

    // ── Date-coercion response parity ────────────────────────────────────────
    // The contract the cache layer's landmine comment relies on. Redis returns
    // a Date as an ISO string, so a hit and a miss carry DIFFERENT JS types —
    // comparing raw service returns would show that difference and mislead.
    // What actually has to hold is that the HTTP response is identical, because
    // every consumer of these values is a res.json() call. So this asserts at
    // the ROUTE level, on the serialized body.

    describe('Date coercion — hit and miss produce identical HTTP responses', () => {
        it('GET /matches: response is byte-identical on hit and miss', async () => {
            await seedMatch({ startTime: new Date('2026-07-12T19:30:00.000Z') });

            const miss = await request(app).get('/matches');
            expect(getCacheStats()).toMatchObject({ hits: 0, misses: 1 });

            const hit = await request(app).get('/matches');
            expect(getCacheStats()).toMatchObject({ hits: 1, misses: 1 });

            // Raw serialized bodies, not parsed objects — this is the strongest
            // form of the claim and the one the routes actually depend on.
            expect(hit.text).toBe(miss.text);
            expect(miss.body.data[0].startTime).toBe('2026-07-12T19:30:00.000Z');
        });

        it('GET /matches/:id: response is byte-identical on hit and miss', async () => {
            const match = await seedMatch({ startTime: new Date('2026-07-12T19:30:00.000Z') });

            const miss = await request(app).get(`/matches/${match.id}`);
            const hit = await request(app).get(`/matches/${match.id}`);

            expect(getCacheStats()).toMatchObject({ hits: 1, misses: 1 });
            expect(hit.text).toBe(miss.text);
            expect(hit.body.match.startTime).toBe('2026-07-12T19:30:00.000Z');
        });

        it('GET /matches/:id/events: createdAt survives the round trip identically', async () => {
            const match = await seedMatch();
            await db.insert(events).values({
                matchId: match.id, minute: 10, type: 'Goal', teamSide: 'home',
            });

            const miss = await request(app).get(`/matches/${match.id}/events`);
            const hit = await request(app).get(`/matches/${match.id}/events`);

            expect(getCacheStats()).toMatchObject({ hits: 1, misses: 1 });
            expect(hit.text).toBe(miss.text);
        });
    });
});
