import { db } from '../db/db.js';
import { events, matches } from '../db/schema.js';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { withCache } from '../redis/cache.js';
import { MATCHES_CACHE_TTL_SECONDS } from '../redis/constants.js';

/** Shares the match TTL: events change on the same poll cycle the scores do. */
export async function listEventsByMatch(params) {
    const { matchId, limit } = params;

    return withCache('matches:events', params, MATCHES_CACHE_TTL_SECONDS, () =>
        db
            .select()
            .from(events)
            .where(eq(events.matchId, matchId))
            .orderBy(asc(events.minute), asc(events.id))
            .limit(limit));
}

/**
 * Renders an event as the free-text line the old commentary feed served, e.g.
 * "Goal! Saka (Arsenal) 63'". playerName is null on roughly a quarter of
 * upstream events, so every part is appended only when present.
 */
function synthesizeMessage({ type, detail, playerName, minute }, teamName) {
    const label = type === 'Goal' && detail && detail !== 'Normal Goal'
        ? `Goal (${detail})!`
        : type === 'Goal'
            ? 'Goal!'
            : detail ?? type;

    const parts = [label];
    if (playerName) parts.push(playerName);
    if (teamName) parts.push(`(${teamName})`);
    if (minute !== null && minute !== undefined) parts.push(`${minute}'`);

    return parts.join(' ');
}

/**
 * DEPRECATED: backs the /matches/:id/commentary alias. Reads the events table
 * and synthesizes the `message` string the frontend feed still expects. Keeps
 * the old id-DESC + cursor pagination so the feed's paging is unchanged.
 */
export async function listCommentaryFromEvents({ matchId, limit, cursor }) {
    const conditions = [eq(events.matchId, matchId)];

    if (cursor !== undefined) conditions.push(lt(events.id, cursor));

    const rows = await db
        .select({
            id: events.id,
            matchId: events.matchId,
            minute: events.minute,
            type: events.type,
            detail: events.detail,
            playerName: events.playerName,
            teamSide: events.teamSide,
            metadata: events.metadata,
            createdAt: events.createdAt,
            homeTeam: matches.homeTeam,
            awayTeam: matches.awayTeam,
        })
        .from(events)
        .innerJoin(matches, eq(events.matchId, matches.id))
        .where(and(...conditions))
        .orderBy(desc(events.id))
        .limit(limit);

    return rows.map(({ homeTeam, awayTeam, ...event }) => ({
        ...event,
        message: synthesizeMessage(event, event.teamSide === 'home' ? homeTeam : awayTeam),
    }));
}

/**
 * Mirrors the upstream snapshot: the caller passes the full event array for a
 * match, not a diff. Upstream events carry no stable id, so there is nothing
 * to upsert against — and a composite natural key would both duplicate rows
 * (NULLs compare distinct in Postgres) and strand VAR-retracted events forever.
 * Delete-then-insert in one transaction is idempotent by construction, and
 * atomic so a crash mid-sync never leaves a match with partial events.
 */
export async function replaceMatchEvents(matchId, rows) {
    return db.transaction(async (tx) => {
        await tx.delete(events).where(eq(events.matchId, matchId));
        if (rows.length === 0) return [];
        return tx.insert(events).values(rows).returning();
    });
}
