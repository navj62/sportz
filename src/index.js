import 'dotenv/config';
import express from 'express';
import http from 'http';
import pinoHttp from 'pino-http';
import { matchesRouter } from './routes/matches.js';
import { commentaryRouter } from './routes/commentary.js';
import { healthRouter } from './routes/health.js';
import { attachWebSocketServer } from './ws/server.js';
import securityMiddleware from './arcjet.js';
import { startLiveSync, stopLiveSync } from './services/liveSync.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './logger.js';
import { pool } from './db/db.js';

const PORT = process.env.PORT ?? 8000;
const HOST = process.env.HOST;

const app = express();
const server = http.createServer(app);

app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

// Health check registered before security middleware — exempt from rate limiting
app.use('/health', healthRouter);

app.use(express.json());
app.use(securityMiddleware());

app.get('/', (req, res) => {
    res.json({ status: 'ok' });
});

app.use('/matches', matchesRouter);
app.use('/matches/:id/commentary', commentaryRouter);

// Centralized error handler — must be registered after all routes
app.use(errorHandler);

const { broadcastLiveScores } = attachWebSocketServer(server);

startLiveSync({ broadcast: broadcastLiveScores });

server.listen(PORT, HOST, () => {
    const baseUrl = HOST === '0.0.0.0'
        ? `http://localhost:${PORT}`
        : `http://${HOST ?? 'localhost'}:${PORT}`;

    logger.info({ url: baseUrl }, 'HTTP server listening');
    logger.info({ url: baseUrl.replace('http', 'ws') + '/ws' }, 'WebSocket server listening');
});

function shutdown(signal) {
    logger.info({ signal }, 'Shutdown signal received, draining connections');
    stopLiveSync();
    server.close(async () => {
        await pool.end();
        logger.info('Graceful shutdown complete');
        process.exit(0);
    });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
