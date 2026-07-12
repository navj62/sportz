import { db } from '../db/db.js';
import { matches } from '../db/schema.js';
import { and, desc, eq, gte, lt, lte, sql } from 'drizzle-orm';

export async function listMatches({ limit, cursor, status, startTimeFrom, startTimeTo }) {
    const conditions = [];

    if (cursor !== undefined)        conditions.push(lt(matches.id, cursor));
    if (status !== undefined)        conditions.push(eq(matches.status, status));
    if (startTimeFrom !== undefined) conditions.push(gte(matches.startTime, new Date(startTimeFrom)));
    if (startTimeTo !== undefined)   conditions.push(lte(matches.startTime, new Date(startTimeTo)));

    return db
        .select()
        .from(matches)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(matches.id))
        .limit(limit);
}

export async function getMatchById(id) {
    const [match] = await db
        .select()
        .from(matches)
        .where(eq(matches.id, id));
    return match ?? null;
}

/**
 * Idempotent on externalId — re-running with the same payload updates in place
 * instead of inserting duplicates. Returns the rows so the caller can map an
 * upstream fixture id back to the local match id.
 */
export async function upsertMatches(rows) {
    if (rows.length === 0) return [];

    return db
        .insert(matches)
        .values(rows)
        .onConflictDoUpdate({
            target: matches.externalId,
            set: {
                competitionId: sql`excluded.competition_id`,
                homeTeamLogoUrl: sql`excluded.home_team_logo_url`,
                homeTeamExternalId: sql`excluded.home_team_external_id`,
                awayTeamLogoUrl: sql`excluded.away_team_logo_url`,
                awayTeamExternalId: sql`excluded.away_team_external_id`,
                status: sql`excluded.status`,
                homeScore: sql`excluded.home_score`,
                awayScore: sql`excluded.away_score`,
            },
        })
        .returning();
}
