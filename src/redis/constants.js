// Every key this app writes is namespaced, so the Upstash instance stays
// partitionable if another service ever shares it and a prefix scan never
// crosses into unrelated data. The helpers in client.js apply these — callers
// pass bare keys ('matches:live'), never the full prefixed form.
export const CACHE_PREFIX = 'sportz:cache:';
export const LOCK_PREFIX = 'sportz:lock:';

// Applied by cacheSet when a caller omits a TTL. Every cache entry gets one:
// an entry written without expiry outlives whatever made it correct and there
// is no reaper to clean it up.
export const DEFAULT_CACHE_TTL_SECONDS = 60;

// Per-endpoint read-cache TTLs, sized against how fast the underlying data can
// actually change. liveSync is the sole writer and polls at 900s live /
// 1800s idle, so every value here is well under one write cycle — the cache can
// only ever serve data the poller has already committed.
//
// Match data moves every cycle, so it gets the shortest window. Standings move
// once per matchday at most. Competitions are near-static: name, country and
// logo change essentially never, and `currentRound` advances weekly.
export const MATCHES_CACHE_TTL_SECONDS = 60;
export const STANDINGS_CACHE_TTL_SECONDS = 300;
export const COMPETITIONS_CACHE_TTL_SECONDS = 3_600;

// Bounds the debug endpoint's Redis ping. The Upstash REST client carries no
// deadline of its own, so without this an unresponsive instance would hang
// /debug/stats. Sized against a measured round trip of roughly 800ms: loose
// enough that a healthy-but-slow instance is not called unreachable, tight
// enough that the endpoint stays usable while Redis is wedged.
export const REDIS_PING_TIMEOUT_MS = 2_000;

// Below this many CACHEABLE lookups — hits plus the misses that were actually
// stored — a hit count of zero means the process is young, not that the cache
// is broken. The health status reports 'cold' rather than raising a fault.
export const CACHE_HEALTH_MIN_CACHEABLE_LOOKUPS = 20;
