import { db } from '../db/db.js';
import { matches } from '../db/schema.js';
import { fetchLiveScores, mapEventToMatch } from './sportsdb.js';
import { logger } from '../logger.js';

const POLL_INTERVAL_MS = Number(process.env.LIVE_SYNC_INTERVAL_MS ?? 60_000);

let broadcastFn = null;
let intervalId = null;

export function startLiveSync({ broadcast }) {
    if (intervalId) return;
    broadcastFn = broadcast;
    poll();
    intervalId = setInterval(poll, POLL_INTERVAL_MS);
    logger.info({ intervalMs: POLL_INTERVAL_MS }, 'liveSync started');
}

export function stopLiveSync() {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }
}

async function poll() {
    try {
        const events = await fetchLiveScores();
        if (!events.length) return;

        const mapped = events.map(mapEventToMatch);

        await Promise.all(
            mapped.map((match) =>
                db
                    .insert(matches)
                    .values({
                        ...match,
                        // startTime is required NOT NULL; endTime is nullable
                        endTime: match.endTime ?? undefined,
                    })
                    .onConflictDoUpdate({
                        target: matches.externalId,
                        set: {
                            homeScore: match.homeScore,
                            awayScore: match.awayScore,
                            status: match.status,
                        },
                    })
            )
        );

        broadcastFn?.({ type: 'live_scores', data: mapped });
    } catch (err) {
        logger.error({ err }, 'liveSync poll failed');
    }
}
