'use client';
import { useState, useEffect } from 'react';
import type { Match } from '@/types';
import { fetchMatches } from '@/lib/api';
import { subscribe } from '@/lib/ws';
import MatchCard from '@/components/match-card';
import MatchFilters from '@/components/match-filters';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

function MatchCardSkeleton() {
  return (
    <div className="rounded-xl border border-(--border) bg-(--card) p-5">
      <div className="flex items-center justify-between mb-3">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <div className="flex items-center gap-4">
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-28 mt-2" />
        </div>
        <div className="space-y-1">
          <Skeleton className="h-7 w-8" />
          <Skeleton className="h-7 w-8 mt-2" />
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMatches([]);
    setNextCursor(null);

    fetchMatches({ limit: 20, ...(status && { status }) })
      .then((result) => {
        if (cancelled) return;
        setMatches(result.data);
        setNextCursor(result.nextCursor);
      })
      .catch(console.error)
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [status]);

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type !== 'live_scores' || !msg.data) return;
      const liveMap = new Map(msg.data.map((m) => [m.id, m]));
      setMatches((prev) =>
        prev.map((m) => (liveMap.has(m.id) ? { ...m, ...liveMap.get(m.id)! } : m)),
      );
    });
  }, []);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await fetchMatches({
        limit: 20,
        cursor: nextCursor,
        ...(status && { status }),
      });
      setMatches((prev) => [...prev, ...result.data]);
      setNextCursor(result.nextCursor);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Matches</h1>
        <p className="text-sm text-(--muted-foreground) mt-1">
          Live scores update automatically
        </p>
      </div>

      <MatchFilters
        status={status}
        onStatusChange={setStatus}
      />

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <MatchCardSkeleton key={i} />)}
        </div>
      ) : matches.length === 0 ? (
        <div className="text-center py-20 text-(--muted-foreground)">
          <p className="text-4xl mb-3">🏟</p>
          <p className="font-medium">No matches found</p>
          <p className="text-sm mt-1">Try adjusting your filters</p>
        </div>
      ) : (
        <div className="space-y-3">
          {matches.map((m) => <MatchCard key={m.id} match={m} />)}
        </div>
      )}

      {nextCursor && !loading && (
        <div className="flex justify-center mt-8">
          <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
