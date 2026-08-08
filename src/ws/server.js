import WebSocket, { WebSocketServer } from "ws";
import { wsArcjet } from "../arcjet.js";
import { logger } from "../logger.js";

const matchSubscribers = new Map();

function subscribe(matchId, socket) {
    if (!matchSubscribers.has(matchId)) {
        matchSubscribers.set(matchId, new Set());
    }
    matchSubscribers.get(matchId).add(socket);
}

function unsubscribe(matchId, socket) {
    const subscribers = matchSubscribers.get(matchId);
    if (!subscribers) return;
    subscribers.delete(socket);
    if (subscribers.size === 0) {
        matchSubscribers.delete(matchId);
    }
}

function cleanupSubscriptions(socket) {
    for (const matchId of socket.subscriptions ?? []) {
        unsubscribe(matchId, socket);
    }
}


function handleMessage(socket, data) {
    let message;
    try {
        message = JSON.parse(data.toString());
    } catch {
        sendJson(socket, { type: 'error', error: 'Invalid JSON' });
        return;
    }
    if (message?.type === 'subscribe' && Number.isInteger(message.matchId)) {
        subscribe(message.matchId, socket);
        socket.subscriptions.add(message.matchId);
        sendJson(socket, { type: 'subscribed', matchId: message.matchId });
    }
    if (message?.type === 'unsubscribe' && Number.isInteger(message.matchId)) {
        unsubscribe(message.matchId, socket);
        socket.subscriptions.delete(message.matchId);
        sendJson(socket, { type: 'unsubscribed', matchId: message.matchId });
    }
}

function sendJson(socket, payload) {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
}

/**
 * Narrows a broadcast's match array to what this socket actually asked for.
 *
 * ── AN EMPTY SUBSCRIPTION SET MEANS *ALL* MATCHES, NOT NONE ──────────────────
 * This reads backwards at first glance, and "correcting" it to empty-means-none
 * would be a silent, total outage of live updates. Do not.
 *
 * Nothing in the frontend sends a `subscribe` frame — its exported subscribe()
 * registers a local listener and never touches the wire, so in production
 * EVERY socket has an empty set. Under empty-means-none the server would
 * deliver nothing to anyone: no error, no closed socket, no failed request,
 * just scores that quietly stop moving. There is no signal that would catch it.
 *
 * It is also the right semantic independently of that. The match list renders
 * ~20 paginated matches and would have to subscribe to every visible id and
 * re-subscribe on each filter change or page load; it genuinely wants the whole
 * feed. Per-match filtering is for the detail view, which follows one match.
 * So: no subscriptions means "everything", and a subscription is an opt-in
 * narrowing.
 *
 * Returns the SAME array reference when nothing is narrowed, which lets the
 * caller reuse one serialization for every unsubscribed socket.
 *
 * @param {import('ws').WebSocket} socket
 * @param {Array<{ id: number }>} data
 * @returns {Array<{ id: number }>|null} matches to send, or null to send nothing
 */
function subscribedMatches(socket, data) {
    if (!socket.subscriptions || socket.subscriptions.size === 0) {
        return data;
    }

    const filtered = data.filter((match) => socket.subscriptions.has(match.id));

    // An empty result carries no information, so skip the frame entirely rather
    // than sending `data: []`.
    return filtered.length > 0 ? filtered : null;
}

function broadcast(wss, payload) {
    // Serialized at most once and reused by every socket receiving the whole
    // payload. Today that is every socket, so this costs exactly what the
    // unfiltered broadcast did — a subscription is what pays for its own
    // filtering, and adding this feature adds no overhead until one exists.
    let fullMessage;
    const sendFull = (client) => {
        fullMessage ??= JSON.stringify(payload);
        client.send(fullMessage);
    };

    for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;

        // Only match arrays are narrowable; anything else goes out whole.
        if (!Array.isArray(payload.data)) {
            sendFull(client);
            continue;
        }

        const data = subscribedMatches(client, payload.data);
        if (data === null) continue;

        if (data === payload.data) {
            sendFull(client);
        } else {
            client.send(JSON.stringify({ ...payload, data }));
        }
    }
}

export function attachWebSocketServer(server) {
    const wss = new WebSocketServer({
        noServer: true,
        maxPayload: 1024 * 1024,
    });

    server.on('upgrade', async (req, socket, head) => {
        const { pathname } = new URL(req.url, `http://${req.headers.host}`);
        if (pathname !== '/ws') {
            socket.destroy();
            return;
        }

        if (wsArcjet) {
            try {
                const decision = await wsArcjet.protect(req);
                if (decision.isDenied()) {
                    const isRateLimit = decision.reason.isRateLimit();
                    const status = isRateLimit ? 429 : 403;
                    const message = isRateLimit ? 'Too Many Requests' : 'Forbidden';
                    socket.write(`HTTP/1.1 ${status} ${message}\r\n\r\n`);
                    socket.destroy();
                    return;
                }
            } catch (err) {
                logger.error({ err }, 'Arcjet WebSocket protection error');
                socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
                socket.destroy();
                return;
            }
        }

        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });

    wss.on('connection', (socket) => {
        socket.isAlive = true;
        socket.on('pong', () => { socket.isAlive = true; });
        socket.subscriptions = new Set();
        sendJson(socket, { type: 'welcome' });

        socket.on('message', (data) => handleMessage(socket, data));

        socket.on('close', () => cleanupSubscriptions(socket));

        socket.on('error', (err) => {
            logger.error({ err }, 'WebSocket error');
            socket.terminate();
        });
    });

    const interval = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) return ws.terminate();
            ws.isAlive = false;
            ws.ping();
        });
    }, 30000);

    wss.on('close', () => clearInterval(interval));

    function broadcastLiveScores(payload) {
        broadcast(wss, payload);
    }

    /**
     * Closes the server and stops the heartbeat.
     *
     * Deliberately NOT wired into index.js: production shutdown is
     * process.exit(0) from server.close's callback, which is a documented
     * decision, and routing it through here would change it for no gain.
     *
     * It exists because the ping interval above is cleared only by wss's
     * 'close' event, and with `noServer: true` closing the HTTP server does not
     * emit it. A test creating a server per case would otherwise leak a 30s
     * timer every time and hold the runner open.
     */
    function close() {
        for (const client of wss.clients) {
            client.terminate();
        }
        return new Promise((resolve) => wss.close(() => resolve()));
    }

    return { broadcastLiveScores, close };
}

/**
 * Test seams. Mirror __resetRedisClientForTests() in redis/client.js.
 *
 * matchSubscribers is module-level rather than per-server, so a suite that
 * builds a server per test case would otherwise carry one case's subscriptions
 * into the next.
 * @returns {void}
 */
export function __resetSubscribersForTests() {
    matchSubscribers.clear();
}

/** @param {number} matchId @returns {number} sockets currently subscribed */
export function __subscriberCountForTests(matchId) {
    return matchSubscribers.get(matchId)?.size ?? 0;
}
