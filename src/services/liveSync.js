import {
    fetchLiveFixtures,
    fetchStandings,
    fetchStatus,
    mapFixtureToCompetition,
    mapFixtureToEvents,
    mapFixtureToMatch,
    mapStandingRow,
} from './apiFootball.js';
import { markStaleLiveMatchesFinished, upsertMatches } from './matchService.js';
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
    RECONCILE_STALE_LIVE_CUTOFF_HOURS,
} from '../constants.js';

let broadcastFn = null;
let liveTimer = null;
let standingsTimer = null;
let stopped = true;

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
