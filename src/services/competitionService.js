import { db } from '../db/db.js';
import { competitions } from '../db/schema.js';
import { and, desc, lt, sql } from 'drizzle-orm';

export async function listCompetitions({ limit, cursor }) {
    const conditions = [];

    if (cursor !== undefined) conditions.push(lt(competitions.id, cursor));

    return db
        .select()
        .from(competitions)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(competitions.id))
        .limit(limit);
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
