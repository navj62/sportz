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

  socket.onopen = () => setStatus('connected');

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
