import express from 'express';
import pinoHttp from 'pino-http';
import { matchesRouter } from './routes/matches.js';
import { commentaryRouter } from './routes/commentary.js';
import { eventsRouter } from './routes/events.js';
import { competitionsRouter } from './routes/competitions.js';
import { standingsRouter } from './routes/standings.js';
import { healthRouter } from './routes/health.js';
import { debugRouter } from './routes/debug.js';
import securityMiddleware from './arcjet.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './logger.js';

export function createApp() {
    const app = express();

    app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

    // /health registered before security middleware — exempt from rate limiting
    app.use('/health', healthRouter);

    app.use(express.json());
    app.use(securityMiddleware());

    app.get('/', (req, res) => {
        res.json({ status: 'ok' });
    });

    app.use('/matches', matchesRouter);
    app.use('/matches/:id/events', eventsRouter);
    // DEPRECATED: remove in frontend phase — superseded by /matches/:id/events
    app.use('/matches/:id/commentary', commentaryRouter);
    app.use('/competitions', competitionsRouter);
    app.use('/competitions/:id/standings', standingsRouter);

    // Read here rather than at module load, like every other env read outside
    // arcjet.js and logger.js.
    //
    // Gated at REGISTRATION: when the flag is off the route does not exist, so
    // the app 404s rather than advertising an endpoint it refuses to serve.
    // Registered HERE, after the security middleware, so it is rate-limited and
    // bot-protected — the deliberate opposite of /health, which is registered
    // before it precisely so liveness probes are never throttled.
    if (process.env.DEBUG_ENDPOINTS_ENABLED === 'true') {
        app.use('/debug', debugRouter);
    }

    // Error handler must be registered last
    app.use(errorHandler);

    return app;
}
