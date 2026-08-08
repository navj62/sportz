import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import http from 'http';
import WebSocket from 'ws';

// arcjet.js reads ARCJET_KEY at MODULE LOAD — one of the two documented
// exceptions to this codebase's lazy-env rule — so the var has to be gone
// BEFORE ws/server.js is imported, which is why the import below is dynamic.
//
// The result is wsArcjet === null, which is not a test-only fiction:
// .env.example documents running without an Arcjet key as a supported setup
// ("when unset, Arcjet is skipped entirely"). It also keeps every upgrade in
// this file off the network.
const ORIGINAL_ARCJET_KEY = process.env.ARCJET_KEY;
delete process.env.ARCJET_KEY;

const {
    attachWebSocketServer,
    __resetSubscribersForTests,
    __subscriberCountForTests,
} = await import('../src/ws/server.js');

// Real ws sockets against a real HTTP server on an ephemeral port — no mocked
// sockets. The subscription map and the broadcast are only meaningful in terms
// of what a client actually receives over the wire.
let server;
let port;
let broadcastLiveScores;
let closeWss;
const openSockets = [];

const PAYLOAD = {
    type: 'live_scores',
    data: [
        { id: 42, homeTeam: 'Arsenal', homeScore: 1 },
        { id: 7, homeTeam: 'Chelsea', homeScore: 0 },
        { id: 99, homeTeam: 'Spurs', homeScore: 2 },
    ],
};

/** Polls rather than racing a single event, so an already-delivered frame is never missed. */
async function waitFor(predicate, timeoutMs = 1_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
}

/**
 * Opens a client and starts collecting frames BEFORE the socket opens — the
 * welcome frame is sent immediately on connection, and an EventEmitter does not
 * buffer, so a listener attached after `open` can miss it.
 */
async function openClient() {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages = [];

    socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
    socket.on('error', () => {}); // terminate() in close() surfaces here; not a failure

    openSockets.push(socket);

    await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    await waitFor(() => messages.length >= 1);

    return { socket, messages };
}

function send(socket, payload) {
    socket.send(JSON.stringify(payload));
}

/**
 * Selects broadcast frames by type rather than by array index — a subscribe
 * acknowledgement lands between the welcome and the broadcast, so indices shift
 * depending on what a test sent.
 */
function liveFrames(messages) {
    return messages.filter((message) => message.type === 'live_scores');
}

const idsOf = (frame) => frame.data.map((match) => match.id);

beforeEach(async () => {
    __resetSubscribersForTests();

    server = http.createServer();
    ({ broadcastLiveScores, close: closeWss } = attachWebSocketServer(server));

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
});

afterEach(async () => {
    for (const socket of openSockets.splice(0)) {
        socket.terminate();
    }
    await closeWss();
    await new Promise((resolve) => server.close(resolve));
});

afterAll(() => {
    if (ORIGINAL_ARCJET_KEY !== undefined) process.env.ARCJET_KEY = ORIGINAL_ARCJET_KEY;
});

describe('WebSocket server — connection', () => {
    it('sends a welcome frame on connect', async () => {
        const { messages } = await openClient();

        expect(messages[0]).toEqual({ type: 'welcome' });
    });

    it('refuses an upgrade on a path other than /ws', async () => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/not-ws`);
        openSockets.push(socket);

        const outcome = await new Promise((resolve) => {
            socket.once('open', () => resolve('open'));
            socket.once('error', () => resolve('error'));
            socket.once('close', () => resolve('close'));
        });

        expect(outcome).not.toBe('open');
    });
});

// The behaviour the whole frontend depends on today, recorded BEFORE any
// filtering exists. Every socket is subscription-less in normal use, so this is
// the path that must survive per-match filtering unchanged.
describe('WebSocket server — broadcast reaches every socket', () => {
    it('delivers the payload to all connected sockets', async () => {
        const a = await openClient();
        const b = await openClient();
        const c = await openClient();

        broadcastLiveScores(PAYLOAD);

        expect(await waitFor(() => [a, b, c].every((client) => client.messages.length >= 2))).toBe(true);
        for (const client of [a, b, c]) {
            expect(client.messages[1]).toEqual(PAYLOAD);
        }
    });

    it('delivers every match to a socket that never subscribed', async () => {
        const { messages } = await openClient();

        broadcastLiveScores(PAYLOAD);

        await waitFor(() => messages.length >= 2);
        expect(messages[1].data.map((match) => match.id)).toEqual([42, 7, 99]);
    });

    it('preserves the message shape', async () => {
        const { messages } = await openClient();

        broadcastLiveScores(PAYLOAD);

        await waitFor(() => messages.length >= 2);
        expect(messages[1].type).toBe('live_scores');
        expect(Array.isArray(messages[1].data)).toBe(true);
    });
});

describe('WebSocket server — subscription bookkeeping', () => {
    it('acknowledges a subscribe and records the socket against the match', async () => {
        const { socket, messages } = await openClient();

        send(socket, { type: 'subscribe', matchId: 42 });

        await waitFor(() => messages.length >= 2);
        expect(messages[1]).toEqual({ type: 'subscribed', matchId: 42 });
        expect(__subscriberCountForTests(42)).toBe(1);
    });

    it('acknowledges an unsubscribe and drops the socket from the match', async () => {
        const { socket, messages } = await openClient();

        send(socket, { type: 'subscribe', matchId: 42 });
        await waitFor(() => messages.length >= 2);

        send(socket, { type: 'unsubscribe', matchId: 42 });
        await waitFor(() => messages.length >= 3);

        expect(messages[2]).toEqual({ type: 'unsubscribed', matchId: 42 });
        expect(__subscriberCountForTests(42)).toBe(0);
    });

    it('tracks two sockets subscribed to the same match', async () => {
        const a = await openClient();
        const b = await openClient();

        send(a.socket, { type: 'subscribe', matchId: 42 });
        send(b.socket, { type: 'subscribe', matchId: 42 });

        expect(await waitFor(() => __subscriberCountForTests(42) === 2)).toBe(true);
    });

    it('keeps subscriptions to different matches apart', async () => {
        const { socket } = await openClient();

        send(socket, { type: 'subscribe', matchId: 42 });
        send(socket, { type: 'subscribe', matchId: 7 });

        expect(await waitFor(() => __subscriberCountForTests(42) === 1)).toBe(true);
        expect(__subscriberCountForTests(7)).toBe(1);
        expect(__subscriberCountForTests(99)).toBe(0);
    });

    it('releases a socket\'s subscriptions when it closes', async () => {
        const { socket } = await openClient();

        send(socket, { type: 'subscribe', matchId: 42 });
        expect(await waitFor(() => __subscriberCountForTests(42) === 1)).toBe(true);

        socket.close();

        expect(await waitFor(() => __subscriberCountForTests(42) === 0)).toBe(true);
    });
});

describe('WebSocket server — malformed input', () => {
    it('replies with an error on invalid JSON rather than closing', async () => {
        const { socket, messages } = await openClient();

        socket.send('not json at all');

        await waitFor(() => messages.length >= 2);
        expect(messages[1]).toEqual({ type: 'error', error: 'Invalid JSON' });
        expect(socket.readyState).toBe(WebSocket.OPEN);
    });

    it('ignores a subscribe carrying a non-integer matchId', async () => {
        const { socket, messages } = await openClient();

        send(socket, { type: 'subscribe', matchId: 'forty-two' });
        send(socket, { type: 'subscribe', matchId: 42 });

        // Only the valid one is acknowledged and recorded.
        await waitFor(() => messages.length >= 2);
        expect(messages[1]).toEqual({ type: 'subscribed', matchId: 42 });
        expect(__subscriberCountForTests(42)).toBe(1);
    });

    it('ignores an unknown message type', async () => {
        const { socket, messages } = await openClient();

        send(socket, { type: 'something-else', matchId: 42 });

        expect(await waitFor(() => messages.length >= 2, 200)).toBe(false);
        expect(__subscriberCountForTests(42)).toBe(0);
    });
});

// The filtering path does not execute in normal use — nothing in the frontend
// sends a subscribe frame — so these tests are the only thing exercising it.
describe('WebSocket server — per-match filtering', () => {
    it('delivers only the subscribed match to a subscribed socket', async () => {
        const { socket, messages } = await openClient();

        send(socket, { type: 'subscribe', matchId: 42 });
        await waitFor(() => __subscriberCountForTests(42) === 1);

        broadcastLiveScores(PAYLOAD);

        expect(await waitFor(() => liveFrames(messages).length >= 1)).toBe(true);
        // Exactly the subscribed match — not merely "a frame arrived".
        expect(liveFrames(messages)[0].data).toHaveLength(1);
        expect(idsOf(liveFrames(messages)[0])).toEqual([42]);
    });

    // Proves the narrowing is PER SOCKET rather than applied to the broadcast
    // as a whole: one payload, two sockets, two different results.
    it('filters per socket — subscribed and unsubscribed differ in the same broadcast', async () => {
        const narrowed = await openClient();
        const everything = await openClient();

        send(narrowed.socket, { type: 'subscribe', matchId: 42 });
        await waitFor(() => __subscriberCountForTests(42) === 1);

        broadcastLiveScores(PAYLOAD);

        expect(await waitFor(() =>
            liveFrames(narrowed.messages).length >= 1 && liveFrames(everything.messages).length >= 1,
        )).toBe(true);

        expect(idsOf(liveFrames(narrowed.messages)[0])).toEqual([42]);
        expect(idsOf(liveFrames(everything.messages)[0])).toEqual([42, 7, 99]);
    });

    it('gives two differently-subscribed sockets their own matches', async () => {
        const a = await openClient();
        const b = await openClient();

        send(a.socket, { type: 'subscribe', matchId: 42 });
        send(b.socket, { type: 'subscribe', matchId: 99 });
        await waitFor(() =>
            __subscriberCountForTests(42) === 1 && __subscriberCountForTests(99) === 1,
        );

        broadcastLiveScores(PAYLOAD);

        expect(await waitFor(() =>
            liveFrames(a.messages).length >= 1 && liveFrames(b.messages).length >= 1,
        )).toBe(true);

        expect(idsOf(liveFrames(a.messages)[0])).toEqual([42]);
        expect(idsOf(liveFrames(b.messages)[0])).toEqual([99]);
    });

    it('delivers every subscribed match, in payload order', async () => {
        const { socket, messages } = await openClient();

        send(socket, { type: 'subscribe', matchId: 99 });
        send(socket, { type: 'subscribe', matchId: 42 });
        await waitFor(() =>
            __subscriberCountForTests(42) === 1 && __subscriberCountForTests(99) === 1,
        );

        broadcastLiveScores(PAYLOAD);

        expect(await waitFor(() => liveFrames(messages).length >= 1)).toBe(true);
        // Payload order (42, 7, 99), not subscription order (99, 42).
        expect(idsOf(liveFrames(messages)[0])).toEqual([42, 99]);
    });

    it('sends no frame at all when the cycle holds none of the subscribed matches', async () => {
        const { socket, messages } = await openClient();

        send(socket, { type: 'subscribe', matchId: 1234 });
        await waitFor(() => __subscriberCountForTests(1234) === 1);

        broadcastLiveScores(PAYLOAD);

        // An empty data array carries no information, so nothing is sent.
        expect(await waitFor(() => liveFrames(messages).length >= 1, 250)).toBe(false);
    });

    it('keeps the live_scores shape on a filtered frame', async () => {
        const { socket, messages } = await openClient();

        send(socket, { type: 'subscribe', matchId: 42 });
        await waitFor(() => __subscriberCountForTests(42) === 1);

        broadcastLiveScores(PAYLOAD);

        await waitFor(() => liveFrames(messages).length >= 1);
        const [frame] = liveFrames(messages);
        expect(frame.type).toBe('live_scores');
        expect(Array.isArray(frame.data)).toBe(true);
        expect(frame.data[0]).toEqual({ id: 42, homeTeam: 'Arsenal', homeScore: 1 });
    });
});

// The backward-compatibility guarantee, stated as its own case rather than
// left implicit in the baseline suite. Every production socket is empty-set,
// so empty-means-ALL is what the live frontend depends on; empty-means-none
// would freeze it silently.
describe('WebSocket server — an empty subscription set means ALL matches', () => {
    it('a socket that never subscribed receives the whole payload', async () => {
        const { messages } = await openClient();

        broadcastLiveScores(PAYLOAD);

        expect(await waitFor(() => liveFrames(messages).length >= 1)).toBe(true);
        expect(idsOf(liveFrames(messages)[0])).toEqual([42, 7, 99]);
    });

    it('unsubscribing back to an empty set restores the whole payload', async () => {
        const { socket, messages } = await openClient();

        send(socket, { type: 'subscribe', matchId: 42 });
        await waitFor(() => __subscriberCountForTests(42) === 1);
        send(socket, { type: 'unsubscribe', matchId: 42 });
        await waitFor(() => __subscriberCountForTests(42) === 0);

        broadcastLiveScores(PAYLOAD);

        expect(await waitFor(() => liveFrames(messages).length >= 1)).toBe(true);
        expect(idsOf(liveFrames(messages)[0])).toEqual([42, 7, 99]);
    });
});
