import { db } from '../db/db.js';
import { standings } from '../db/schema.js';
import { and, asc, eq, sql } from 'drizzle-orm';
import { withCache } from '../redis/cache.js';
import { STANDINGS_CACHE_TTL_SECONDS } from '../redis/constants.js';

/** A table moves once per matchday at most, so it sits between the other two TTLs. */
export async function listStandingsByCompetition(params) {
    const { competitionId, season } = params;

    return withCache('standings:byCompetition', params, STANDINGS_CACHE_TTL_SECONDS, () => {
        const conditions = [eq(standings.competitionId, competitionId)];

        if (season !== undefined) conditions.push(eq(standings.season, season));

        return db
            .select()
            .from(standings)
            .where(and(...conditions))
            .orderBy(asc(standings.groupName), asc(standings.rank));
    });
}

/**
 * Idempotent on (competitionId, season, teamExternalId) — the unique index a
 * team's row in a given season occupies exactly once.
 */
export async function upsertStandings(rows) {
    if (rows.length === 0) return [];

    return db
        .insert(standings)
        .values(rows)
        .onConflictDoUpdate({
            target: [standings.competitionId, standings.season, standings.teamExternalId],
            set: {
                rank: sql`excluded.rank`,
                teamName: sql`excluded.team_name`,
                teamLogoUrl: sql`excluded.team_logo_url`,
                groupName: sql`excluded.group_name`,
                points: sql`excluded.points`,
                goalsDiff: sql`excluded.goals_diff`,
                played: sql`excluded.played`,
                win: sql`excluded.win`,
                draw: sql`excluded.draw`,
                lose: sql`excluded.lose`,
                goalsFor: sql`excluded.goals_for`,
                goalsAgainst: sql`excluded.goals_against`,
                form: sql`excluded.form`,
                description: sql`excluded.description`,
                updatedAt: sql`now()`,
            },
        })
        .returning();
}
