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

/**
 * Reconciliation tier 1 — the TIME FLOOR. Marks any row still at 'live' whose
 * scheduled kickoff is older than `cutoffHours` as 'finished'.
 *
 * This deliberately does NOT consult the live feed. It is the one reconciliation
 * signal that stays valid on a failed or empty cycle: a suspended API produces
 * an empty feed, but it does not make a 7-hour-old match still live. Absence
 * from the feed and age are independent concerns, and only the second one is
 * safe to act on unconditionally. (Tier 2, the date-sweep confirm in liveSync,
 * is the one that must be gated on a genuinely successful cycle.)
 *
 * The 6h cutoff is a claim, not a convenience — it is the same claim
 * scripts/backfill-stuck-live-matches.js makes, and for the same reasons:
 * regulation is ~2h with stoppage and half-time, extra time plus penalties
 * reaches ~3h15m, SUSP and INT are in LIVE_STATUSES so a suspended match
 * legitimately stays live for hours, and start_time is SCHEDULED kickoff, not
 * actual, so a delayed start is not reflected in the column. ~4h is the honest
 * floor; 6h carries margin.
 *
 * `now()` is the DATABASE clock, matching the backfill, so a skewed app clock
 * cannot widen or narrow the cutoff.
 *
 * Writes `status` ONLY. home_score and away_score keep whatever was last
 * observed — possibly from the 60th minute — and end_time stays NULL, because
 * this path never learned when the match actually ended. Only the confirm path
 * writes end_time, which is what makes a non-null end_time mean "we observed
 * this finish" rather than "a reconciler touched this row".
 *
 * @param {number} cutoffHours
 * @returns {Promise<Array<{ id: number, externalId: string|null }>>} the rows flipped
 */
export async function markStaleLiveMatchesFinished(cutoffHours) {
    return db
        .update(matches)
        .set({ status: 'finished' })
        .where(
            and(
                eq(matches.status, 'live'),
                lte(matches.startTime, sql`now() - make_interval(hours => ${cutoffHours})`),
            ),
        )
        .returning({ id: matches.id, externalId: matches.externalId });
}

/**
 * Reconciliation tier 2 — applies CONFIRMED outcomes read back from the API.
 *
 * Deliberately NOT upsertMatches. That path is wrong here in two ways: its
 * conflict clause sets `competitionId: excluded.competition_id`, so a row
 * without a freshly resolved competition would have its FK nulled, and it
 * INSERTS on miss, so a fixture we do not track would be conjured into
 * existence by a reconciliation pass. This only ever updates rows that already
 * exist.
 *
 * Every update is additionally guarded on `status = 'live'`. Reconciliation's
 * job is unsticking matches we believe are still in play; a row that already
 * moved on is not ours to rewrite, and the guard makes a late or duplicated
 * sweep a no-op rather than a clobber.
 *
 * `endTime` is written ONLY when the caller supplies one, which it does only
 * for a confirmed 'finished'. It records WHEN WE CONFIRMED the finish, not the
 * final whistle — the upstream payload carries kickoff, not end. The two differ
 * by at most one cooldown. That is the honest reading of the column, and it is
 * still worth having: non-null means "we observed this match finish", which is
 * exactly what the tier 1 floor cannot claim and therefore leaves NULL.
 *
 * One transaction, so a mid-sweep failure leaves no half-applied batch.
 *
 * @param {Array<{ externalId: string, status: string, homeScore: number, awayScore: number, endTime: Date|null }>} rows
 * @returns {Promise<Array<{ id: number, externalId: string|null, status: string }>>}
 */
export async function applyConfirmedFinals(rows) {
    if (rows.length === 0) return [];

    return db.transaction(async (tx) => {
        const updated = [];

        for (const row of rows) {
            const [match] = await tx
                .update(matches)
                .set({
                    status: row.status,
                    homeScore: row.homeScore,
                    awayScore: row.awayScore,
                    ...(row.endTime ? { endTime: row.endTime } : {}),
                })
                .where(and(eq(matches.externalId, row.externalId), eq(matches.status, 'live')))
                .returning({
                    id: matches.id,
                    externalId: matches.externalId,
                    status: matches.status,
                });

            if (match) updated.push(match);
        }

        return updated;
    });
}
