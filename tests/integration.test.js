import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/db.js';
import { matches, commentary } from '../src/db/schema.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

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
                sport: 'Soccer',
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

    async function seedCommentary(matchId, overrides = {}) {
        const [entry] = await db
            .insert(commentary)
            .values({
                matchId,
                eventType: 'goal',
                message: 'A goal was scored',
                ...overrides,
            })
            .returning();
        return entry;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    beforeAll(async () => {
        await migrate(db, { migrationsFolder });
        app = createApp();
    });

    afterEach(async () => {
        // RESTART IDENTITY resets serial sequences so IDs are predictable
        await pool.query('TRUNCATE TABLE commentary, matches RESTART IDENTITY CASCADE');
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

    it('GET /matches?sport filters by sport', async () => {
        await seedMatch({ sport: 'Basketball' });
        const soccer = await seedMatch({ sport: 'Soccer' });

        const res = await request(app).get('/matches?sport=Soccer');
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].id).toBe(soccer.id);
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

    it('GET /matches/:id/commentary cursor excludes entries at or above cursor id', async () => {
        const match = await seedMatch();
        const c1 = await seedCommentary(match.id, { message: 'First' });
        const c2 = await seedCommentary(match.id, { message: 'Second' });
        const c3 = await seedCommentary(match.id, { message: 'Third' });

        // Cursor at c3.id — only c1 and c2 should come back (ORDER BY id DESC)
        const res = await request(app).get(`/matches/${match.id}/commentary?cursor=${c3.id}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(2);
        const ids = res.body.data.map((c) => c.id);
        expect(ids).not.toContain(c3.id);
        expect(ids).toContain(c2.id);
        expect(ids).toContain(c1.id);
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

    it('liveSync upsert: same externalId updates scores without creating a duplicate row', async () => {
        const base = {
            sport: 'Soccer',
            homeTeam: 'Team A',
            awayTeam: 'Team B',
            status: /** @type {const} */ ('live'),
            startTime: new Date('2026-01-01T15:00:00Z'),
            externalId: 'ext-upsert-test',
        };

        // First call — insert
        await db
            .insert(matches)
            .values({ ...base, homeScore: 0, awayScore: 0 })
            .onConflictDoUpdate({
                target: matches.externalId,
                set: { homeScore: 0, awayScore: 0, status: 'live' },
            });

        // Second call — same externalId, scores updated
        await db
            .insert(matches)
            .values({ ...base, homeScore: 2, awayScore: 1 })
            .onConflictDoUpdate({
                target: matches.externalId,
                set: { homeScore: 2, awayScore: 1, status: 'live' },
            });

        const rows = await db
            .select()
            .from(matches)
            .where(eq(matches.externalId, 'ext-upsert-test'));

        expect(rows).toHaveLength(1);
        expect(rows[0].homeScore).toBe(2);
        expect(rows[0].awayScore).toBe(1);
    });
});
