export const MAX_LIMIT = 100;

export const API_FOOTBALL_BASE_URL = 'https://v3.football.api-sports.io';
export const API_FOOTBALL_MAX_RETRIES = 3;
export const API_FOOTBALL_RETRY_BASE_MS = 1_000;

// Sized against the API-Football free tier: 100 requests/day. One request per
// live cycle (fixtures, leagues and events all arrive in the /fixtures?live=all
// payload). The idle interval must stay LONGER than the live one, or idling
// would cost more quota than being live.
//
// 20 min => 72/day, leaving room for reconciliation tier 2 (the date-sweep
// confirm below). The full budget:
//
//     72  live poll at 20 min, awake all day
//   + 24  tier 2, worst case: one sweep per hour, every hour
//   +  1  the boot /status request
//   ────
//     97  of 100
//
// The 24 is a CEILING, not an expectation — a sweep only fires when departures
// are actually pending, so quiet hours cost nothing. At the previous 15 min
// (96/day) that budget came to 121 and did not fit, which is why this moved.
export const DEFAULT_LIVE_SYNC_INTERVAL_MS = 1_200_000;
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

// ── Reconciliation tier 2: the date-sweep confirm ────────────────────────────
//
// Tier 1 (the floor above) stops phantom live matches. Tier 2 is what recovers
// the correct FINAL SCORE, which inference structurally cannot: a match that
// leaves the feed carries whatever score was last polled, possibly from the
// 60th minute. Only an explicit upstream marker fixes that.
//
// Confirm is by DATE, not by id. /fixtures?ids= is plan-gated on the free tier
// ("Free plans do not have access to the Ids parameter"), and fetchFixtureById
// is ?id= singular — one request per departure, which does not fit the budget.
// One /fixtures?date= request resolves EVERY departure for that date whatever
// their number, so the cost is per-date rather than per-match.

// Ships ENABLED. Opt-OUT rather than opt-in — unlike STANDINGS_SYNC_ENABLED,
// which is off because the free tier cannot serve it at all — so only the exact
// string 'false' disables it. Anything else, including unset, leaves it on.
export const RECONCILE_CONFIRM_DISABLE_VALUE = 'false';

// N consecutive absences across SUCCESSFUL, NON-EMPTY cycles before a match is
// eligible for confirm.
//
// N is a COST knob, not a safety knob, and that distinction is the whole
// design: absence never writes anything. Only a confirmed upstream status or
// the tier 1 floor changes a row, so no value of N — not even 1 — can flip a
// match on a bad cycle. N therefore only decides how eagerly we spend a
// request. 2 absorbs a single partial payload for at most one extra interval
// (~20 min); 3 would add another 20 min of staleness and buy nothing, since the
// thing it would guard against is already structurally impossible.
export const RECONCILE_ABSENCE_THRESHOLD = 2;

// At most one sweep per hour, however many departures accumulate. Costs nothing
// in coverage — one sweep resolves every pending departure for a date at once —
// so the cooldown only delays the flip, and tier 1 backstops it regardless.
export const RECONCILE_CONFIRM_COOLDOWN_MS = 3_600_000;

// Hard ceiling on requests per sweep. Departures group by the UTC date of their
// kickoff, and a match starting 22:00Z finishes on the following UTC date, so
// two dates is the realistic maximum. This bounds the cost even if the map ends
// up holding something older; whatever is not swept falls to the tier 1 floor,
// which needs no requests at all.
export const RECONCILE_MAX_CONFIRM_DATES = 2;
