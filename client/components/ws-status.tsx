'use client';
import { useState, useEffect } from 'react';
import { subscribeStatus, type WsConnectionStatus } from '@/lib/ws';

const STATUS_CONFIG: Record<WsConnectionStatus, { label: string; className: string; dotClass: string }> = {
  // The socket being up is infrastructure, not a match being live — so this
  // indicator never takes the accent. Red is reserved for match state.
  connected: {
    label: 'Connected',
    className: 'text-fg-secondary',
    dotClass: 'bg-fg-secondary',
  },
  connecting: {
    label: 'Connecting',
    className: 'text-postponed',
    dotClass: 'bg-postponed animate-live-pulse',
  },
  disconnected: {
    label: 'Offline',
    className: 'text-fg-muted',
    dotClass: 'bg-fg-muted',
  },
};

export default function WsStatus() {
  const [status, setStatus] = useState<WsConnectionStatus>('disconnected');

  useEffect(() => {
    return subscribeStatus(setStatus);
  }, []);

  const { label, className, dotClass } = STATUS_CONFIG[status];

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
      {label}
    </span>
  );
}
