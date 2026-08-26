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

// Caps how many match ids one WebSocket may narrow itself to. Nothing bounded
// this before, so a client looping `{"type":"subscribe"}` with rising ids grew
// both socket.subscriptions and the module-level matchSubscribers without
// limit. Arcjet does not cover it: wsArcjet rate-limits the UPGRADE, not
// messages on an already-open socket, and maxPayload bounds one frame's size
// rather than how many arrive.
//
// 20 is generous against the only pattern that exists: the detail page narrows
// to exactly ONE match, and the list deliberately holds no subscriptions at all
// (an empty set means every match). A cap set near the real usage would fail
// users while looking like a bug, so this leaves an order of magnitude of room.
export const MAX_SUBSCRIPTIONS_PER_SOCKET = 20;

// Reconciliation tier 1, the time floor. A match still marked 'live' whose
// SCHEDULED kickoff is older than this cannot actually be live. Same value and
// same reasoning as scripts/backfill-stuck-live-matches.js: regulation ~2h,
// extra time plus penalties ~3h15m, SUSP/INT legitimately hold a match live for
// hours, and start_time is scheduled rather than actual kickoff. ~4h is the
// honest floor; 6h carries margin.
//
// Costs ZERO API requests, which is why it runs on every cycle including empty
// and failed ones — it never consults the feed.
export const RECONCILE_STALE_LIVE_CUTOFF_HOURS = 6;
