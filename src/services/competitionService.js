import { db } from '../db/db.js';
import { competitions } from '../db/schema.js';
import { and, desc, lt, sql } from 'drizzle-orm';
import { withCache } from '../redis/cache.js';
import { COMPETITIONS_CACHE_TTL_SECONDS } from '../redis/constants.js';

/**
 * The longest TTL of the five: a competition's name, country and logo change
 * essentially never, and `currentRound` advances about once a week.
 *
 * Note this has an internal caller as well as the route — pollStandings reads
 * it to decide which competitions to fetch standings for, so it reads through
 * the same cache. Harmless: standings sync runs hourly and is off by default,
 * so the worst case is a newly-added competition waiting up to one TTL for its
 * first standings fetch.
 */
export async function listCompetitions(params) {
    const { limit, cursor } = params;

    return withCache('competitions:list', params, COMPETITIONS_CACHE_TTL_SECONDS, () => {
        const conditions = [];

        if (cursor !== undefined) conditions.push(lt(competitions.id, cursor));

        return db
            .select()
            .from(competitions)
            .where(conditions.length > 0 ? and(...conditions) : undefined)
            .orderBy(desc(competitions.id))
            .limit(limit);
    });
}

/**
 * Idempotent on externalId. Competitions arrive as a byproduct of the live
 * fixtures payload — each fixture carries its own league object — so this runs
 * every cycle with mostly unchanged rows.
 */
export async function upsertCompetitions(rows) {
    if (rows.length === 0) return [];

    return db
        .insert(competitions)
        .values(rows)
        .onConflictDoUpdate({
            target: competitions.externalId,
            set: {
                name: sql`excluded.name`,
                country: sql`excluded.country`,
                season: sql`excluded.season`,
                currentRound: sql`excluded.current_round`,
                logoUrl: sql`excluded.logo_url`,
                updatedAt: sql`now()`,
            },
        })
        .returning();
}
