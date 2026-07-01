import 'dotenv/config';
import http from 'http';
import { createApp } from './app.js';
import { attachWebSocketServer } from './ws/server.js';
import { startLiveSync, stopLiveSync } from './services/liveSync.js';
import { logger } from './logger.js';
import { pool } from './db/db.js';

const PORT = process.env.PORT ?? 8000;
const HOST = process.env.HOST;

const app = createApp();
const server = http.createServer(app);

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
