import 'dotenv/config';
import express from 'express';
import http from 'http';
import { matchesRouter } from './routes/matches.js';
import { commentaryRouter } from './routes/commentary.js';
import { attachWebSocketServer } from './ws/server.js';
import securityMiddleware from './arcjet.js';
import { startLiveSync } from './services/liveSync.js';

const PORT = process.env.PORT ?? 8000;
const HOST = process.env.HOST;

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(securityMiddleware());

app.get('/', (req, res) => {
    res.send('Hello from Express server!');
});

app.use('/matches', matchesRouter);
app.use('/matches/:id/commentary', commentaryRouter);

const { broadcastLiveScores } = attachWebSocketServer(server);

startLiveSync({ broadcast: broadcastLiveScores });

server.listen(PORT, HOST, () => {
    const baseUrl = HOST === '0.0.0.0'
        ? `http://localhost:${PORT}`
        : `http://${HOST ?? 'localhost'}:${PORT}`;

    console.log(`Server is running on ${baseUrl}`);
    console.log(`WebSocket Server is running on ${baseUrl.replace('http', 'ws')}/ws`);
});
