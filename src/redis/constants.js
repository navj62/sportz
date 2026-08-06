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
