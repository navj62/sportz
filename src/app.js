import express from 'express';
import pinoHttp from 'pino-http';
import { matchesRouter } from './routes/matches.js';
import { commentaryRouter } from './routes/commentary.js';
import { healthRouter } from './routes/health.js';
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
    app.use('/matches/:id/commentary', commentaryRouter);

    // Error handler must be registered last
    app.use(errorHandler);

    return app;
}
