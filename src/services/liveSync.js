import {
    fetchLiveFixtures,
    fetchStandings,
    fetchStatus,
    mapFixtureToCompetition,
    mapFixtureToEvents,
    mapFixtureToMatch,
    mapStandingRow,
} from './apiFootball.js';
import { upsertMatches } from './matchService.js';
import { replaceMatchEvents } from './eventService.js';
import { listCompetitions, upsertCompetitions } from './competitionService.js';
import { upsertStandings } from './standingsService.js';
import { logger } from '../logger.js';
import {
    DEFAULT_LIVE_SYNC_IDLE_INTERVAL_MS,
    DEFAULT_LIVE_SYNC_INTERVAL_MS,
    DEFAULT_STANDINGS_SYNC_INTERVAL_MS,
    MAX_LIMIT,
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
    if (liveTimer || standingsTimer) return;

    const config = readConfig();
    broadcastFn = broadcast;
    stopped = false;

    // One request at boot, so the logs state unambiguously which quota regime
    // this process is running under.
    logApiStatus();

    runLiveCycle(config);

    if (config.standingsEnabled) {
        runStandingsCycle(config);
    } else {
        logger.info('Standings sync disabled (set STANDINGS_SYNC_ENABLED=true to enable)');
    }

    logger.info(
        { liveIntervalMs: config.liveIntervalMs, idleIntervalMs: config.idleIntervalMs },
        'liveSync started',
    );
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

/** @returns {Promise<number>} live fixtures seen this cycle */
async function pollLiveFixtures() {
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
