// Singleton WebSocket manager — connects lazily, auto-reconnects, notifies all listeners.
// Safe to import in both server and client modules; connection only opens in the browser.

import type { WsMessage } from '@/types';

export type WsConnectionStatus = 'connected' | 'connecting' | 'disconnected';
export type WsListener = (msg: WsMessage) => void;
export type StatusListener = (status: WsConnectionStatus) => void;

let socket: WebSocket | null = null;
let listeners = new Set<WsListener>();
let statusListeners = new Set<StatusListener>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let explicitlyClosed = false;
let currentStatus: WsConnectionStatus = 'disconnected';

/**
 * Match ids this client WANTS narrowed, kept as intent rather than fired and
 * forgotten.
 *
 * Two reasons it has to be tracked here rather than by the component:
 *
 * 1. One socket serves every page. An empty server-side set means ALL matches
 *    (see subscribedMatches in src/ws/server.js), which the list page depends
 *    on. So a subscription that outlives the page that wanted it does not fail
 *    loudly — it silently narrows the LIST to one match and freezes every other
 *    score. Owning the set here means a leaked frame cannot outlive its owner.
 *
 * 2. A reconnected socket starts empty server-side. Without replaying intent on
 *    connect, a detail page would quietly fall back to the firehose after a
 *    drop — still functional, but no longer exercising the per-match filtering
 *    it asked for.
 */
const desiredMatchIds = new Set<number>();

const WS_URL =
  typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8000/ws')
    : null;

function setStatus(status: WsConnectionStatus) {
  currentStatus = status;
  for (const fn of statusListeners) fn(status);
}

function connect() {
  if (typeof window === 'undefined' || !WS_URL) return;
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;

  explicitlyClosed = false;
  setStatus('connecting');
  socket = new WebSocket(WS_URL);

  socket.onopen = () => {
    setStatus('connected');
    // Reconcile: the server side of a fresh socket has no subscriptions.
    for (const matchId of desiredMatchIds) {
      sendFrame({ type: 'subscribe', matchId });
    }
  };

  socket.onmessage = (event: MessageEvent) => {
    let msg: WsMessage;
    try { msg = JSON.parse(event.data as string) as WsMessage; } catch { return; }
    for (const fn of listeners) fn(msg);
  };

  socket.onclose = () => {
    socket = null;
    setStatus('disconnected');
    if (!explicitlyClosed && listeners.size > 0) {
      reconnectTimer = setTimeout(connect, 3000);
    }
  };

  socket.onerror = () => socket?.close();
}

function sendFrame(frame: { type: string; matchId: number }) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(frame));
  return true;
}

function maybeDisconnect() {
  if (listeners.size === 0 && statusListeners.size === 0 && socket) {
    explicitlyClosed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket.close();
    socket = null;
  }
}

/** Subscribe to all incoming WS messages. Returns an unsubscribe function. */
export function subscribe(fn: WsListener): () => void {
  if (listeners.size === 0 && statusListeners.size === 0) connect();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    maybeDisconnect();
  };
}

/** Subscribe to connection status changes. Returns an unsubscribe function. */
export function subscribeStatus(fn: StatusListener): () => void {
  if (listeners.size === 0 && statusListeners.size === 0) connect();
  statusListeners.add(fn);
  fn(currentStatus);
  return () => {
    statusListeners.delete(fn);
    maybeDisconnect();
  };
}

/**
 * Narrow this socket to one match, activating the server's per-match filtering.
 *
 * Returns a cleanup that removes the intent and sends `unsubscribe`. Note the
 * frame MUST carry the matchId: handleMessage in src/ws/server.js gates on
 * `Number.isInteger(message.matchId)`, so a bare { type: 'unsubscribe' } is
 * silently ignored and the subscription is retained.
 */
export function subscribeToMatch(matchId: number): () => void {
  if (listeners.size === 0 && statusListeners.size === 0) connect();
  desiredMatchIds.add(matchId);
  sendFrame({ type: 'subscribe', matchId });

  return () => {
    desiredMatchIds.delete(matchId);
    sendFrame({ type: 'unsubscribe', matchId });
  };
}

/** Test/debug seam — what this client currently believes it is narrowed to. */
export function __desiredMatchIdsForTests(): number[] {
  return [...desiredMatchIds];
}
