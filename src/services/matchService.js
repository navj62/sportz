import { db } from '../db/db.js';
import { matches } from '../db/schema.js';
import { and, desc, eq, gte, lt, lte, sql } from 'drizzle-orm';
import { withCache } from '../redis/cache.js';
import { MATCHES_CACHE_TTL_SECONDS } from '../redis/constants.js';

/**
 * The WHOLE `params` object goes to the cache, not a re-listed subset of it.
 * Re-listing the fields here would reintroduce precisely the key-completeness
 * risk the whole-object keying exists to remove: a filter added to the
 * destructure below but forgotten in the key makes one query serve another
 * query's rows, silently. Passing `params` straight through means a new filter
 * joins the key by existing. If you add a filter, add it to the destructure —
 * the key takes care of itself.
 */
export async function listMatches(params) {
    const { limit, cursor, status, startTimeFrom, startTimeTo } = params;

    return withCache('matches:list', params, MATCHES_CACHE_TTL_SECONDS, () => {
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
    });
}

/**
 * A miss on a nonexistent id returns null, which withCache deliberately does
 * not store — so a 404 re-queries every time rather than occupying an entry
 * that could never register as a hit.
 */
export async function getMatchById(id) {
    return withCache('matches:byId', { id }, MATCHES_CACHE_TTL_SECONDS, async () => {
        const [match] = await db
            .select()
            .from(matches)
            .where(eq(matches.id, id));
        return match ?? null;
    });
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
