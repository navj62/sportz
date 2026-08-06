export const MAX_LIMIT = 100;

export const API_FOOTBALL_BASE_URL = 'https://v3.football.api-sports.io';
export const API_FOOTBALL_MAX_RETRIES = 3;
export const API_FOOTBALL_RETRY_BASE_MS = 1_000;

// Sized against the API-Football free tier: 100 requests/day. One request per
// live cycle (fixtures, leagues and events all arrive in the /fixtures?live=all
// payload) means 15 min => ~96 requests/day. The idle interval must stay LONGER
// than the live one, or idling would cost more quota than being live.
export const DEFAULT_LIVE_SYNC_INTERVAL_MS = 900_000;
export const DEFAULT_LIVE_SYNC_IDLE_INTERVAL_MS = 1_800_000;
export const DEFAULT_STANDINGS_SYNC_INTERVAL_MS = 3_600_000;

// Guards the live poll so that on a multi-instance deploy only one process
// spends a cycle's quota. Not env-overridable: it is a property of how long a
// poll takes, not a deployment knob.
export const LIVE_SYNC_LOCK_KEY = 'live-sync:poll';

// Long enough to outlast a poll — one /fixtures?live=all request with up to
// API_FOOTBALL_MAX_RETRIES backed-off retries, plus the upserts — and far
// shorter than the 900s live interval, so a holder that dies mid-poll can never
// wedge the lock into the next cycle.
//
// Getting this wrong degrades gently in both directions: too short means two
// instances briefly poll together (wasted quota, and the upserts are idempotent
// anyway), too long means one skipped cycle. Neither corrupts data.
export const LIVE_SYNC_LOCK_TTL_SECONDS = 60;
