import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/db.js';
import { matches, events, competitions } from '../src/db/schema.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { upsertMatches } from '../src/services/matchService.js';
import { replaceMatchEvents } from '../src/services/eventService.js';
import { upsertCompetitions } from '../src/services/competitionService.js';
import { upsertStandings } from '../src/services/standingsService.js';

const migrationsFolder = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'drizzle',
);

// All tests require a real test DB. Skip the suite when TEST_DATABASE_URL is absent
// so CI without a DB setup doesn't fail loudly.
const skip = !process.env.TEST_DATABASE_URL;

describe.skipIf(skip)('Sportz API — Integration', () => {
    let app;

    // ── Helpers ──────────────────────────────────────────────────────────────

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

    async function seedEvent(matchId, overrides = {}) {
        const [event] = await db
            .insert(events)
            .values({
                matchId,
                minute: 10,
                type: 'Goal',
                detail: 'Normal Goal',
                playerName: 'Saka',
                teamSide: 'home',
                ...overrides,
            })
            .returning();
        return event;
    }

    async function seedCompetition(overrides = {}) {
        const [competition] = await db
            .insert(competitions)
            .values({
                externalId: 'league-1',
                name: 'Premier League',
                country: 'England',
                season: 2026,
                currentRound: 'Regular Season - 20',
                ...overrides,
            })
            .returning();
        return competition;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    beforeAll(async () => {
        // This suite TRUNCATEs. Refuse to run if the pool is not actually pointed
        // at the test database — a silently-failed redirect in setup.js once let
        // it truncate the real one.
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

    afterEach(async () => {
        // RESTART IDENTITY resets serial sequences so IDs are predictable
        await pool.query(
            'TRUNCATE TABLE events, standings, competitions, matches RESTART IDENTITY CASCADE',
        );
    });

    afterAll(async () => {
        await pool.end();
    });

    // ── Tests ─────────────────────────────────────────────────────────────────

    it('GET /health returns 200 with db:ok when pool is healthy', async () => {
        const res = await request(app).get('/health');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'ok', db: 'ok' });
    });

    it('GET /matches returns empty page with null nextCursor on empty DB', async () => {
        const res = await request(app).get('/matches');
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
        expect(res.body.nextCursor).toBeNull();
    });

    it('GET /matches returns matches in id DESC order', async () => {
        const m1 = await seedMatch({ homeTeam: 'First' });
        const m2 = await seedMatch({ homeTeam: 'Second' });

        const res = await request(app).get('/matches');
        expect(res.status).toBe(200);
        expect(res.body.data[0].id).toBe(m2.id);
        expect(res.body.data[1].id).toBe(m1.id);
    });

    it('GET /matches sets nextCursor to last row id when page is full', async () => {
        await seedMatch({ homeTeam: 'First' });
        const m2 = await seedMatch({ homeTeam: 'Second' });
        const m3 = await seedMatch({ homeTeam: 'Third' });

        // Request 2 of 3 — page is full so nextCursor should be set
        const res = await request(app).get('/matches?limit=2');
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(2);
        expect(res.body.data[0].id).toBe(m3.id);
        expect(res.body.data[1].id).toBe(m2.id);
        expect(res.body.nextCursor).toBe(m2.id);
    });

    it('GET /matches?cursor applies WHERE id < cursor in SQL — not post-query filter', async () => {
        const m1 = await seedMatch({ homeTeam: 'First' });
        const m2 = await seedMatch({ homeTeam: 'Second' });
        const m3 = await seedMatch({ homeTeam: 'Third' });

        // Cursor at m3.id — only m1 and m2 should come back
        const res = await request(app).get(`/matches?cursor=${m3.id}`);
        expect(res.status).toBe(200);
        const ids = res.body.data.map((m) => m.id);
        expect(ids).not.toContain(m3.id);
        expect(ids).toContain(m2.id);
        expect(ids).toContain(m1.id);
        // 2 rows returned < default limit 100 → last page
        expect(res.body.nextCursor).toBeNull();
    });

    it('GET /matches?status filters by status, cursor composes with filter in SQL', async () => {
        const live = await seedMatch({ status: 'live' });
        await seedMatch({ status: 'scheduled' });
        await seedMatch({ status: 'finished' });

        const res = await request(app).get('/matches?status=live');
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].id).toBe(live.id);
        expect(res.body.data[0].status).toBe('live');
    });

    it('GET /matches returns 400 with custom message when startTimeTo < startTimeFrom', async () => {
        const res = await request(app).get(
            '/matches?startTimeFrom=2026-06-01T00:00:00Z&startTimeTo=2026-05-01T00:00:00Z',
        );
        expect(res.status).toBe(400);
        expect(res.body.details[0].message).toBe('startTimeTo must be after startTimeFrom');
    });

    it('GET /matches/:id returns the correct match', async () => {
        const match = await seedMatch({ homeTeam: 'Unique Team' });
        const res = await request(app).get(`/matches/${match.id}`);
        expect(res.status).toBe(200);
        expect(res.body.match.id).toBe(match.id);
        expect(res.body.match.homeTeam).toBe('Unique Team');
    });

    it('GET /matches/:id returns 404 for an id that does not exist', async () => {
        const res = await request(app).get('/matches/999999');
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Match not found' });
    });

    it('error handler returns { error: "Internal server error" } — never leaks raw error details', async () => {
        // Isolated test app with a single route that throws a revealing error
        const testApp = express();
        testApp.get('/boom', (req, res, next) => {
            next(new Error('secret db internals: password=hunter2 table=matches'));
        });
        testApp.use(errorHandler);

        const res = await request(testApp).get('/boom');
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Internal server error' });
        // The raw error message must not appear anywhere in the response body
        expect(JSON.stringify(res.body)).not.toContain('hunter2');
        expect(JSON.stringify(res.body)).not.toContain('secret');
    });

    // ── Events ────────────────────────────────────────────────────────────────

    it('GET /matches/:id/events returns structured events ordered by minute', async () => {
        const match = await seedMatch();
        await seedEvent(match.id, { minute: 63, type: 'Card', detail: 'Yellow Card' });
        await seedEvent(match.id, { minute: 4, type: 'Goal', detail: 'Own Goal' });
        await seedEvent(match.id, { minute: 31, type: 'subst', detail: 'Substitution 1' });

        const res = await request(app).get(`/matches/${match.id}/events`);
        expect(res.status).toBe(200);
        expect(res.body.data.map((e) => e.minute)).toEqual([4, 31, 63]);
        expect(res.body.data[0]).toMatchObject({
            type: 'Goal',
            detail: 'Own Goal',
            teamSide: 'home',
        });
    });

    it('GET /matches/:id/events returns an empty list for a match with no events', async () => {
        const match = await seedMatch();
        const res = await request(app).get(`/matches/${match.id}/events`);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
    });

    // ── Deprecated commentary alias ───────────────────────────────────────────

    it('GET /matches/:id/commentary synthesizes a message with minute and player name', async () => {
        const match = await seedMatch({ homeTeam: 'Arsenal', awayTeam: 'Chelsea' });
        await seedEvent(match.id, {
            minute: 63,
            type: 'Goal',
            detail: 'Normal Goal',
            playerName: 'Saka',
            teamSide: 'home',
        });

        const res = await request(app).get(`/matches/${match.id}/commentary`);
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].message).toBe("Goal! Saka (Arsenal) 63'");
    });

    it('GET /matches/:id/commentary omits the player when upstream sent none', async () => {
        const match = await seedMatch({ homeTeam: 'Arsenal', awayTeam: 'Chelsea' });
        await seedEvent(match.id, {
            minute: 70,
            type: 'Card',
            detail: 'Yellow Card',
            playerName: null,
            teamSide: 'away',
        });

        const res = await request(app).get(`/matches/${match.id}/commentary`);
        expect(res.status).toBe(200);
        // Must not render "null" — ~23% of upstream events carry no player
        expect(res.body.data[0].message).toBe("Yellow Card (Chelsea) 70'");
        expect(res.body.data[0].message).not.toContain('null');
    });

    it('GET /matches/:id/commentary cursor excludes entries at or above cursor id', async () => {
        const match = await seedMatch();
        const c1 = await seedEvent(match.id, { minute: 1 });
        const c2 = await seedEvent(match.id, { minute: 2 });
        const c3 = await seedEvent(match.id, { minute: 3 });

        // Cursor at c3.id — only c1 and c2 should come back (ORDER BY id DESC)
        const res = await request(app).get(`/matches/${match.id}/commentary?cursor=${c3.id}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(2);
        const ids = res.body.data.map((c) => c.id);
        expect(ids).not.toContain(c3.id);
        expect(ids).toContain(c2.id);
        expect(ids).toContain(c1.id);
    });

    // ── liveSync writes ───────────────────────────────────────────────────────

    it('upsertMatches: same externalId updates scores without creating a duplicate row', async () => {
        const base = {
            homeTeam: 'Team A',
            awayTeam: 'Team B',
            status: /** @type {const} */ ('live'),
            startTime: new Date('2026-01-01T15:00:00Z'),
            externalId: 'ext-upsert-test',
        };

        await upsertMatches([{ ...base, homeScore: 0, awayScore: 0 }]);
        await upsertMatches([{ ...base, homeScore: 2, awayScore: 1 }]);

        const rows = await db
            .select()
            .from(matches)
            .where(eq(matches.externalId, 'ext-upsert-test'));

        expect(rows).toHaveLength(1);
        expect(rows[0].homeScore).toBe(2);
        expect(rows[0].awayScore).toBe(1);
    });

    it('upsertCompetitions: re-running the same payload does not duplicate rows', async () => {
        const row = {
            externalId: '129',
            name: 'Primera Nacional',
            country: 'Argentina',
            season: 2026,
            currentRound: 'Regular Season - 20',
            logoUrl: null,
        };

        await upsertCompetitions([row]);
        await upsertCompetitions([{ ...row, currentRound: 'Regular Season - 21' }]);

        const rows = await db.select().from(competitions);
        expect(rows).toHaveLength(1);
        expect(rows[0].currentRound).toBe('Regular Season - 21');
    });

    it('replaceMatchEvents is idempotent — running twice leaves one set of rows', async () => {
        const match = await seedMatch();
        const payload = [
            { matchId: match.id, minute: 4, type: 'Goal', detail: 'Own Goal', playerName: 'A. Lopez', teamSide: 'away', metadata: null },
            { matchId: match.id, minute: 63, type: 'Card', detail: 'Yellow Card', playerName: null, teamSide: 'home', metadata: null },
        ];

        await replaceMatchEvents(match.id, payload);
        await replaceMatchEvents(match.id, payload);

        const rows = await db.select().from(events).where(eq(events.matchId, match.id));
        expect(rows).toHaveLength(2);
    });

    it('replaceMatchEvents removes an event the upstream snapshot no longer contains', async () => {
        const match = await seedMatch();

        await replaceMatchEvents(match.id, [
            { matchId: match.id, minute: 4, type: 'Goal', detail: 'Normal Goal', playerName: 'Saka', teamSide: 'home', metadata: null },
            { matchId: match.id, minute: 30, type: 'Goal', detail: 'Normal Goal', playerName: 'Odegaard', teamSide: 'home', metadata: null },
        ]);

        // VAR disallows the 30' goal — upstream drops it from the array entirely
        await replaceMatchEvents(match.id, [
            { matchId: match.id, minute: 4, type: 'Goal', detail: 'Normal Goal', playerName: 'Saka', teamSide: 'home', metadata: null },
        ]);

        const rows = await db.select().from(events).where(eq(events.matchId, match.id));
        expect(rows).toHaveLength(1);
        expect(rows[0].minute).toBe(4);
    });

    it('replaceMatchEvents with an empty array clears the match events', async () => {
        const match = await seedMatch();
        await seedEvent(match.id);

        await replaceMatchEvents(match.id, []);

        const rows = await db.select().from(events).where(eq(events.matchId, match.id));
        expect(rows).toHaveLength(0);
    });

    // ── Competitions and standings ────────────────────────────────────────────

    it('GET /competitions lists competitions in id DESC order', async () => {
        const c1 = await seedCompetition({ externalId: '39', name: 'Premier League' });
        const c2 = await seedCompetition({ externalId: '129', name: 'Primera Nacional' });

        const res = await request(app).get('/competitions');
        expect(res.status).toBe(200);
        expect(res.body.data[0].id).toBe(c2.id);
        expect(res.body.data[1].id).toBe(c1.id);
        expect(res.body.nextCursor).toBeNull();
    });

    it('GET /competitions/:id/standings returns rows ordered by rank', async () => {
        const competition = await seedCompetition();

        await upsertStandings([
            { competitionId: competition.id, season: 2026, rank: 2, teamExternalId: '42', teamName: 'Arsenal', points: 89, goalsDiff: 62, played: 38, win: 28, draw: 5, lose: 5, goalsFor: 91, goalsAgainst: 29 },
            { competitionId: competition.id, season: 2026, rank: 1, teamExternalId: '50', teamName: 'Man City', points: 91, goalsDiff: 62, played: 38, win: 28, draw: 7, lose: 3, goalsFor: 96, goalsAgainst: 34 },
        ]);

        const res = await request(app).get(`/competitions/${competition.id}/standings`);
        expect(res.status).toBe(200);
        expect(res.body.data.map((r) => r.rank)).toEqual([1, 2]);
        expect(res.body.data[0].teamName).toBe('Man City');
    });

    it('upsertStandings is idempotent on (competition, season, team)', async () => {
        const competition = await seedCompetition();
        const row = {
            competitionId: competition.id,
            season: 2026,
            rank: 1,
            teamExternalId: '50',
            teamName: 'Man City',
            points: 91,
            goalsDiff: 62,
            played: 38,
            win: 28,
            draw: 7,
            lose: 3,
            goalsFor: 96,
            goalsAgainst: 34,
        };

        await upsertStandings([row]);
        await upsertStandings([{ ...row, rank: 2, points: 88 }]);

        const res = await request(app).get(`/competitions/${competition.id}/standings`);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].rank).toBe(2);
        expect(res.body.data[0].points).toBe(88);
    });

    it('GET /competitions/:id/standings returns an empty list when nothing has been synced', async () => {
        const competition = await seedCompetition();
        const res = await request(app).get(`/competitions/${competition.id}/standings`);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
    });
});
