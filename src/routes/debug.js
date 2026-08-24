import { Router } from 'express';
import { getCacheStats } from '../redis/cache.js';
import { getLockStats, redisPing } from '../redis/client.js';

// Registered by app.js only when DEBUG_ENDPOINTS_ENABLED is exactly 'true', so
// when it is off this route does not exist at all rather than existing and
// refusing. See the registration for why it sits behind the security
// middleware, unlike /health.
export const debugRouter = Router();

/**
 * Operational snapshot: is the cache actually working, is the poll lock still
 * coordinating, is Redis reachable.
 *
 * No try/catch, deliberately. getCacheStats and getLockStats read counters and
 * cannot throw, and redisPing is contractually never-throwing like every helper
 * in redis/client.js — wrapping them would suggest otherwise.
 *
 * The ping is what makes this endpoint slow-but-bounded rather than instant: it
 * is a real round trip, capped by REDIS_PING_TIMEOUT_MS, so a wedged Upstash
 * costs the caller that timeout once and never hangs.
 */
debugRouter.get('/stats', async (req, res) => {
    const redis = await redisPing();

    res.json({
        // Cumulative counters are uninterpretable without a window — "45 lock
        // errors" means nothing until you know whether that is over a minute
        // or a fortnight.
        uptimeSeconds: Math.round(process.uptime()),
        cache: getCacheStats(),
        locks: getLockStats(),
        redis,
    });
});
