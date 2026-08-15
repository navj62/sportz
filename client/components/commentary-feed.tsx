'use client';
import { useState, useEffect, useCallback } from 'react';
import type { Commentary } from '@/types';
import { fetchCommentary } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Only the goal takes the accent. Everything else stays on the gray/amber
// ramp — a feed that colors five event types is a feed with no signal.
const EVENT_COLORS: Record<string, string> = {
  goal: 'text-signal',
  yellowcard: 'text-postponed',
  redcard: 'text-signal-dim',
  substitution: 'text-fg-secondary',
  penalty: 'text-fg',
};

function CommentaryEntry({ entry }: { entry: Commentary }) {
  const color = EVENT_COLORS[entry.eventType?.toLowerCase()] ?? 'text-(--muted-foreground)';
  return (
    <div className="flex gap-3 py-3 border-b border-(--border) last:border-0">
      <div className="w-8 shrink-0 text-right">
        {entry.minute != null && (
          <span className="text-xs font-bold tabular-nums text-(--muted-foreground)">
            {entry.minute}&apos;
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className={cn('text-xs font-semibold uppercase tracking-wide', color)}>
            {entry.eventType}
          </span>
          {entry.actor && (
            <span className="text-xs text-(--muted-foreground)">· {entry.actor}</span>
          )}
        </div>
        <p className="text-sm">{entry.message}</p>
      </div>
    </div>
  );
}

export default function CommentaryFeed({ matchId }: { matchId: string | number }) {
  const [entries, setEntries] = useState<Commentary[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (cursor?: number) => {
    const isMore = cursor != null;
    isMore ? setLoadingMore(true) : setLoading(true);
    setError(null);
    try {
      const result = await fetchCommentary(matchId, { limit: 20, cursor });
      if (isMore) {
        setEntries((prev) => [...prev, ...result.data]);
      } else {
        setEntries(result.data);
      }
      setNextCursor(result.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      isMore ? setLoadingMore(false) : setLoading(false);
    }
  }, [matchId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-red-500">Failed to load commentary: {error}</p>;
  }

  if (entries.length === 0) {
    return (
      <p className="text-sm text-(--muted-foreground) text-center py-8">
        No commentary yet
      </p>
    );
  }

  return (
    <div>
      <div>
        {entries.map((e) => <CommentaryEntry key={e.id} entry={e} />)}
      </div>
      {nextCursor && (
        <div className="flex justify-center mt-4">
          <Button variant="outline" size="sm" onClick={() => load(nextCursor)} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load older'}
          </Button>
        </div>
      )}
    </div>
  );
}
