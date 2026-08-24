import arcjet, { detectBot, shield, slidingWindow } from '@arcjet/node';
import { logger } from './logger.js';

const arcjetKey = process.env.ARCJET_KEY;
const arcjetMode = process.env.ARCJET_ENV === 'development' ? 'DRY_RUN' : 'LIVE';

export const httpArcjet = arcjetKey ? arcjet({
    key: arcjetKey,
    rules: [
        shield({ mode: arcjetMode }),
        detectBot({ mode: arcjetMode, allow: ['CATEGORY:SEARCH_ENGINE', 'CATEGORY:PREVIEW'] }),
        slidingWindow({ mode: arcjetMode, interval: '10s', max: 50 }),
    ],
}) : null;

export const wsArcjet = arcjetKey ? arcjet({
    key: arcjetKey,
    rules: [
        shield({ mode: arcjetMode }),
        detectBot({ mode: arcjetMode, allow: ['CATEGORY:SEARCH_ENGINE', 'CATEGORY:PREVIEW'] }),
        slidingWindow({ mode: arcjetMode, interval: '2s', max: 5 }),
    ],
}) : null;

export default function securityMiddleware() {
    return async (req, res, next) => {
        if (!httpArcjet) return next();
        try {
            const decision = await httpArcjet.protect(req);
            if (decision.isDenied()) {
                if (decision.reason.isRateLimit()) {
                    return res.status(429).json({ error: 'Too Many Requests' });
                }
                return res.status(403).json({ error: 'Forbidden' });
            }
        } catch (err) {
            logger.error({ err }, 'Arcjet middleware error');
            return res.status(503).json({ error: 'Service Unavailable' });
        }
        next();
    };
}
