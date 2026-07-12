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
