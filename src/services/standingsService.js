import { db } from '../db/db.js';
import { standings } from '../db/schema.js';
import { and, asc, eq, sql } from 'drizzle-orm';

export async function listStandingsByCompetition({ competitionId, season }) {
    const conditions = [eq(standings.competitionId, competitionId)];

    if (season !== undefined) conditions.push(eq(standings.season, season));

    return db
        .select()
        .from(standings)
        .where(and(...conditions))
        .orderBy(asc(standings.groupName), asc(standings.rank));
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
