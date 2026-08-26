import {
    fetchFixturesByDate,
    fetchLiveFixtures,
    fetchStandings,
    fetchStatus,
    mapStatus,
    mapFixtureToCompetition,
    mapFixtureToEvents,
    mapFixtureToMatch,
    mapStandingRow,
} from './apiFootball.js';
import { applyConfirmedFinals, markStaleLiveMatchesFinished, upsertMatches } from './matchService.js';
import { replaceMatchEvents } from './eventService.js';
import { listCompetitions, upsertCompetitions } from './competitionService.js';
import { upsertStandings } from './standingsService.js';
import { logger } from '../logger.js';
import { acquireLock, releaseLock } from '../redis/client.js';
import {
    DEFAULT_LIVE_SYNC_IDLE_INTERVAL_MS,
    DEFAULT_LIVE_SYNC_INTERVAL_MS,
    DEFAULT_STANDINGS_SYNC_INTERVAL_MS,
    LIVE_SYNC_LOCK_KEY,
    LIVE_SYNC_LOCK_TTL_SECONDS,
    MAX_LIMIT,
    RECONCILE_ABSENCE_THRESHOLD,
    RECONCILE_CONFIRM_COOLDOWN_MS,
    RECONCILE_CONFIRM_DISABLE_VALUE,
    RECONCILE_MAX_CONFIRM_DATES,
    RECONCILE_STALE_LIVE_CUTOFF_HOURS,
} from '../constants.js';

let broadcastFn = null;
let liveTimer = null;
let standingsTimer = null;
let stopped = true;

/**
 * Reconciliation tier 2 state: every fixture this process has seen live, and
 * how many consecutive SUCCESSFUL, NON-EMPTY cycles it has been missing from
 * since.
 *
 * In memory, and no migration, because absence is NON-WRITING. The counter
 * never decides that a match finished — it only decides when it is worth
 * spending a request to ask. So losing it to a restart (Render's free tier
 * hibernates, and the instance hostname says so) delays a confirm by one
 * cooldown and can never cause a wrong write. A rebuilt-from-empty map simply
 * has no departures yet, which is the fail-safe direction. Persisting it would
 * be paying migration cost for a value whose loss is harmless.
 *
 * @type {Map<string, { absences: number, startTime: string|null }>}
 */
const liveSeen = new Map();

/** Epoch ms of the last confirm sweep, enforcing RECONCILE_CONFIRM_COOLDOWN_MS. */
let lastConfirmAtMs = 0;

/** Read here rather than at module load, so importing this file is side-effect free. */
function readConfig() {
    return {
        liveIntervalMs: Number(process.env.LIVE_SYNC_INTERVAL_MS ?? DEFAULT_LIVE_SYNC_INTERVAL_MS),
        idleIntervalMs: Number(process.env.LIVE_SYNC_IDLE_INTERVAL_MS ?? DEFAULT_LIVE_SYNC_IDLE_INTERVAL_MS),
        standingsIntervalMs: Number(process.env.STANDINGS_SYNC_INTERVAL_MS ?? DEFAULT_STANDINGS_SYNC_INTERVAL_MS),
        standingsEnabled: process.env.STANDINGS_SYNC_ENABLED === 'true',
    };
}

export function startLiveSync({ broadcast }) {
    // Guards on the flag, not the timers: between boot and the first scheduled
    // cycle both timers are still null, so a timer check would let a second
    // start slip through and run two pollers.
    if (!stopped) return;

    const config = readConfig();
    broadcastFn = broadcast;
    stopped = false;

    logger.info(
        { liveIntervalMs: config.liveIntervalMs, idleIntervalMs: config.idleIntervalMs },
        'liveSync started',
    );

    if (!config.standingsEnabled) {
        logger.info('Standings sync disabled (set STANDINGS_SYNC_ENABLED=true to enable)');
    }

    // One request at boot, so the logs state unambiguously which quota regime this
    // process is running under. Awaited before the first cycle so the plan and
    // quota are always the first thing in the log, rather than racing the cycle
    // that follows — at the cost of delaying the first poll by one request.
    logApiStatus().then(() => {
        if (stopped) return;

        runLiveCycle(config);

        if (config.standingsEnabled) {
            runStandingsCycle(config);
        }
    });
}

/**
 * Test seam. Runs exactly one lock-guarded live poll, with no timers and no
 * rescheduling, so the lock branches can be driven directly.
 *
 * Additive on purpose: pollLiveFixtures is module-private and startLiveSync
 * only reaches it through a timer behind an awaited status request, which a
 * unit test should not have to fake. Mirrors __resetRedisClientForTests().
 * @returns {Promise<number>}
 */
export function __pollOnceForTests() {
    return pollLiveFixtures();
}

/**
 * Test seam. Clears tier 2's absence map and cooldown so one test's departures
 * cannot leak into the next. Named per the __…ForTests convention so it is
 * obviously not production API.
 */
export function __resetReconcileStateForTests() {
    liveSeen.clear();
    lastConfirmAtMs = 0;
}

export function stopLiveSync() {
    stopped = true;

    if (liveTimer) {
        clearTimeout(liveTimer);
        liveTimer = null;
    }
    if (standingsTimer) {
        clearTimeout(standingsTimer);
        standingsTimer = null;
    }
}

async function logApiStatus() {
    try {
        const { status, quota } = await fetchStatus();
        logger.info(
            {
                plan: status.subscription?.plan,
                requestsToday: status.requests?.current,
                limitDay: status.requests?.limit_day,
                quotaRemaining: quota.remainingDay,
            },
            'API-Football account status',
        );
    } catch (err) {
        logger.error({ err }, 'Failed to read API-Football status');
    }
}

/**
 * Polls live fixtures, then reschedules itself. A recursive setTimeout rather
 * than setInterval because the delay is not fixed: idling uses a longer
 * interval than being live, so an idle poller costs less quota than a busy one.
 */
async function runLiveCycle(config) {
    let liveCount = 0;

    try {
        liveCount = await pollLiveFixtures();
    } catch (err) {
        logger.error({ err }, 'liveSync poll failed');
    }

    if (stopped) return;

    const delayMs = liveCount > 0 ? config.liveIntervalMs : config.idleIntervalMs;
    liveTimer = setTimeout(() => runLiveCycle(config), delayMs);
}

/**
 * Lock guard around syncLiveFixtures. Deliberately wraps the WORK and not
 * runLiveCycle: the reschedule lives in runLiveCycle, and if a lock skip ever
 * short-circuited that, one skipped cycle would stop the poller permanently.
 * Returning 0 instead makes runLiveCycle pick idleIntervalMs, which is the
 * right back-off — another instance is polling, so we have no live count of our
 * own and should check back at the cheaper interval.
 *
 * On shutdown the release is best-effort by design. index.js calls stopLiveSync
 * and then process.exit(0) from server.close's callback without awaiting an
 * in-flight poll, so a SIGTERM that drains faster than a poll kills the process
 * before this finally runs. The lock's TTL is therefore the EXPECTED reaper on
 * a normal shutdown, not just a backstop for SIGKILL. That is fine and needs no
 * fix: an orphaned lock clears within LIVE_SYNC_LOCK_TTL_SECONDS, and fencing
 * means the next process cannot evict whoever took the key in between.
 *
 * Do NOT "fix" this by awaiting the poll in shutdown — that delays every
 * SIGTERM by up to a full poll for no correctness gain, since fencing plus TTL
 * already cover it.
 *
 * @returns {Promise<number>} live fixtures seen this cycle, 0 if skipped
 */
async function pollLiveFixtures() {
    const lock = await acquireLock(LIVE_SYNC_LOCK_KEY, LIVE_SYNC_LOCK_TTL_SECONDS);

    // Skip ONLY on 'held'. That is the one reason proving another instance is
    // already spending this cycle's quota.
    if (lock.reason === 'held') {
        logger.info({ endpoint: '/fixtures?live=all' }, 'liveSync cycle skipped — another instance holds the poll lock');
        return 0;
    }

    // 'error' is not 'held'. Redis being unreachable tells us nothing about
    // whether a contender exists, and this deploys as a single instance where
    // there is none — so proceed. The cost of being wrong on a multi-instance
    // deploy is a duplicated request, not corruption: the upserts are idempotent
    // and replaceMatchEvents is snapshot-based. The cost of skipping instead
    // would be a missed cycle every time Redis blips.
    if (lock.reason === 'error') {
        logger.warn({ endpoint: '/fixtures?live=all' }, 'liveSync poll lock unavailable, polling without coordination');
    }

    try {
        // Tier 1 runs BEFORE the fetch, and unconditionally. It is time-based,
        // not feed-based, so it stays correct when the fetch below throws or
        // comes back empty — the two cases where reading absence as "finished"
        // would be catastrophic. Placing it here also puts it inside the lock,
        // so on a multi-instance deploy only one process runs the UPDATE.
        await reconcileStaleLiveMatches();

        return await syncLiveFixtures();
    } finally {
        // Null token on the 'disabled' and 'error' paths, where releaseLock is a
        // no-op — we never took a lock to give back.
        await releaseLock(LIVE_SYNC_LOCK_KEY, lock.token);
    }
}

/**
 * Reconciliation tier 1 — the time floor. Costs no API requests, so it runs on
 * every cycle rather than being gated on the cycle succeeding.
 *
 * Swallows its own failure by design: reconciliation is a step inside the poll,
 * not a precondition for it. A reconciliation that cannot run must never cost us
 * the live scores, which are the actual product.
 */
async function reconcileStaleLiveMatches() {
    try {
        const flipped = await markStaleLiveMatchesFinished(RECONCILE_STALE_LIVE_CUTOFF_HOURS);

        if (flipped.length > 0) {
            logger.info(
                {
                    matches: flipped.length,
                    cutoffHours: RECONCILE_STALE_LIVE_CUTOFF_HOURS,
                    externalIds: flipped.map((row) => row.externalId),
                },
                'reconciled stale live matches to finished (time floor)',
            );
        }
    } catch (err) {
        logger.error({ err }, 'stale-live reconciliation failed');
    }
}

/**
 * Ships enabled: only the exact string 'false' turns tier 2 off. Read lazily
 * inside the function, never at module load, so importing this file stays
 * side-effect free.
 */
function isConfirmEnabled() {
    return process.env.RECONCILE_CONFIRM_ENABLED !== RECONCILE_CONFIRM_DISABLE_VALUE;
}

/**
 * Updates the absence map against one cycle's fixtures and returns the matches
 * that have now been missing for RECONCILE_ABSENCE_THRESHOLD cycles.
 *
 * MUST only ever be called with the fixtures of a cycle that genuinely
 * succeeded AND returned a non-empty payload. An empty feed is indistinguishable
 * from a broken one, so counting an absence against it would let a single API
 * outage age every live match to the threshold at once. Its caller sits after
 * syncLiveFixtures' empty-payload early return for exactly that reason.
 *
 * @param {Array<{ fixture: { id: number, date?: string } }>} fixtures
 * @returns {Array<{ externalId: string, startTime: string|null }>}
 */
function trackAbsences(fixtures) {
    const seen = new Set();

    for (const fixture of fixtures) {
        const externalId = String(fixture.fixture.id);
        seen.add(externalId);
        // Present again resets the counter outright rather than decrementing:
        // the threshold counts CONSECUTIVE absences, and a match that reappears
        // was never a departure.
        liveSeen.set(externalId, { absences: 0, startTime: fixture.fixture.date ?? null });
    }

    const departures = [];
    for (const [externalId, entry] of liveSeen) {
        if (seen.has(externalId)) continue;

        entry.absences += 1;
        if (entry.absences >= RECONCILE_ABSENCE_THRESHOLD) {
            departures.push({ externalId, startTime: entry.startTime });
        }
    }

    return departures;
}

/** @param {string|null} iso @returns {string|null} YYYY-MM-DD in UTC, or null if unusable */
function utcDateOf(iso) {
    if (!iso) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
}

/**
 * Reconciliation tier 2 — confirm departures against the API and write their
 * real final scores.
 *
 * This is the half that inference cannot do. A match that left the feed carries
 * whatever score was last polled, possibly from the 60th minute; only reading
 * the outcome back fixes it. Absence gets us as far as "worth asking about" and
 * no further — the write is driven entirely by the status the API reports.
 *
 * KNOWN TRADEOFF, accepted and tracked in FOLLOWUPS: /fixtures?date= does NOT
 * embed events, unlike /fixtures?live=all. So a goal scored after the last live
 * poll lands in the corrected SCORE but is missing from the event list — a match
 * can read 2-1 with one goal event. Same class as the backfill's stale-score
 * caveat. Closing it needs one /fixtures/events request per match, which does
 * not fit the free tier's budget.
 *
 * Swallows its own failure: reconciliation is a step inside the poll, not a
 * precondition for it.
 */
async function confirmDepartures(departures) {
    if (departures.length === 0) return;
    if (!isConfirmEnabled()) return;

    const now = Date.now();
    if (now - lastConfirmAtMs < RECONCILE_CONFIRM_COOLDOWN_MS) return;
    // Stamped BEFORE the requests, not after. On failure this still holds the
    // cooldown, so a persistently failing sweep costs one request an hour rather
    // than one every cycle.
    lastConfirmAtMs = now;

    // Group by the UTC date of kickoff: one request serves every departure that
    // shares a date, however many there are. A match starting 22:00Z finishes on
    // the next UTC date, so two dates is the realistic maximum.
    const byDate = new Map();
    for (const departure of departures) {
        const date = utcDateOf(departure.startTime);
        if (date === null) continue;
        if (!byDate.has(date)) byDate.set(date, new Set());
        byDate.get(date).add(departure.externalId);
    }

    // Newest dates first if we are ever over the cap; anything dropped is left
    // to the tier 1 floor, which costs nothing.
    const dates = [...byDate.keys()].sort().slice(-RECONCILE_MAX_CONFIRM_DATES);

    const finals = [];
    let requests = 0;
    let stillLive = 0;

    for (const date of dates) {
        const { fixtures } = await fetchFixturesByDate(date);
        requests += 1;

        const wanted = byDate.get(date);
        for (const fixture of fixtures) {
            const externalId = String(fixture.fixture.id);
            if (!wanted.has(externalId)) continue;

            const status = mapStatus(fixture.fixture.status.short);

            if (status === 'live') {
                // A false departure — the feed dropped it transiently but the
                // match is still going. Reset rather than write anything.
                const entry = liveSeen.get(externalId);
                if (entry) entry.absences = 0;
                stillLive += 1;
                continue;
            }

            finals.push({
                externalId,
                status,
                homeScore: fixture.goals?.home ?? 0,
                awayScore: fixture.goals?.away ?? 0,
                // Only a finish is an observed finish. A cancelled or postponed
                // match never ended, so it gets no end_time.
                endTime: status === 'finished' ? new Date() : null,
            });
            liveSeen.delete(externalId);
        }
    }

    const updated = finals.length > 0 ? await applyConfirmedFinals(finals) : [];

    logger.info(
        {
            endpoint: '/fixtures?date=',
            departures: departures.length,
            dates,
            requests,
            confirmed: finals.length,
            updated: updated.length,
            stillLive,
        },
        'reconciled departed matches against confirmed status (date sweep)',
    );
}

/** @returns {Promise<number>} live fixtures seen this cycle */
async function syncLiveFixtures() {
    const startedAt = Date.now();
    const { fixtures, quota } = await fetchLiveFixtures();

    if (fixtures.length === 0) {
        logger.info(
            {
                endpoint: '/fixtures?live=all',
                fixtures: 0,
                quotaRemaining: quota.remainingDay,
                durationMs: Date.now() - startedAt,
            },
            'liveSync cycle complete — no live fixtures',
        );
        return 0;
    }

    // Every fixture carries its own league object, so competitions fall out of
    // this payload. They are never fetched on their own.
    const byExternalId = new Map();
    for (const fixture of fixtures) {
        const competition = mapFixtureToCompetition(fixture);
        byExternalId.set(competition.externalId, competition);
    }
    const competitionRows = await upsertCompetitions([...byExternalId.values()]);
    const competitionIdByExternalId = new Map(competitionRows.map((row) => [row.externalId, row.id]));

    const matchRows = await upsertMatches(
        fixtures.map((fixture) =>
            mapFixtureToMatch(fixture, competitionIdByExternalId.get(String(fixture.league.id)) ?? null),
        ),
    );
    const matchIdByExternalId = new Map(matchRows.map((row) => [row.externalId, row.id]));

    let eventCount = 0;
    for (const fixture of fixtures) {
        const matchId = matchIdByExternalId.get(String(fixture.fixture.id));
        if (matchId === undefined) continue;

        const eventRows = mapFixtureToEvents(fixture, matchId);
        await replaceMatchEvents(matchId, eventRows);
        eventCount += eventRows.length;
    }

    broadcastFn?.({ type: 'live_scores', data: matchRows });

    // Tier 2 runs HERE and nowhere else. Everything above it — the non-empty
    // early return, the successful fetch, the completed upserts — is what makes
    // this cycle's fixture list trustworthy enough to count an absence against.
    // Move this above that early return and one empty payload from a broken API
    // starts ageing every live match toward the threshold at once.
    try {
        await confirmDepartures(trackAbsences(fixtures));
    } catch (err) {
        logger.error({ err }, 'departure confirmation failed');
    }

    logger.info(
        {
            endpoint: '/fixtures?live=all',
            fixtures: fixtures.length,
            competitions: competitionRows.length,
            events: eventCount,
            quotaRemaining: quota.remainingDay,
            durationMs: Date.now() - startedAt,
        },
        'liveSync cycle complete',
    );

    return fixtures.length;
}

/**
 * Standings run on their own, much slower schedule. This is the only place the
 * competitions table drives requests rather than being populated by them.
 *
 * FOLLOWUP — deliberately NOT lock-guarded, unlike pollLiveFixtures. Standings
 * sync is gated off by default (STANDINGS_SYNC_ENABLED), so a lock here would
 * guard a path that never runs. If you are turning that flag on, give
 * pollStandings the same acquireLock/releaseLock treatment first: it spends one
 * request PER COMPETITION, so on a multi-instance deploy it double-burns far
 * more quota than the live poller ever could. See FOLLOWUPS.md.
 */
async function runStandingsCycle(config) {
    try {
        await pollStandings();
    } catch (err) {
        logger.error({ err }, 'standings sync failed');
    }

    if (stopped) return;

    standingsTimer = setTimeout(() => runStandingsCycle(config), config.standingsIntervalMs);
}

async function pollStandings() {
    const competitions = await listCompetitions({ limit: MAX_LIMIT });

    for (const competition of competitions) {
        if (competition.season === null) continue;

        const startedAt = Date.now();
        try {
            const { rows, quota } = await fetchStandings(Number(competition.externalId), competition.season);
            const upserted = await upsertStandings(
                rows.map((row) => mapStandingRow(row, competition.id, competition.season)),
            );

            logger.info(
                {
                    endpoint: '/standings',
                    competition: competition.name,
                    rows: upserted.length,
                    quotaRemaining: quota.remainingDay,
                    durationMs: Date.now() - startedAt,
                },
                'standings sync complete',
            );
        } catch (err) {
            // A single competition failing (a plan gate, say) must not kill the rest.
            logger.warn({ err, competition: competition.name }, 'standings sync failed for competition');
        }
    }
}
