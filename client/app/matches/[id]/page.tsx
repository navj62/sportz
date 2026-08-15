'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import type { Match } from '@/types';
import { fetchMatch } from '@/lib/api';
import { subscribe } from '@/lib/ws';
import ScoreHeader from '@/components/score-header';
import CommentaryFeed from '@/components/commentary-feed';
import { Skeleton } from '@/components/ui/skeleton';

function ScoreHeaderSkeleton() {
  return (
    <div className="rounded-xl border border-(--border) bg-(--card) p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <div className="flex items-center gap-4">
        <div className="flex-1 space-y-3">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-5 w-36" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-10 w-12" />
          <Skeleton className="h-10 w-12" />
        </div>
      </div>
    </div>
  );
}

export default function MatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [id, setId] = useState<string | null>(null);
  const [match, setMatch] = useState<Match | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    Promise.resolve(params).then((p) => setId(p.id));
  }, [params]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetchMatch(id)
      .then((data) => {
        if (cancelled) return;
        if (!data) { setMissing(true); return; }
        setMatch(data);
      })
      .catch(console.error)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const numId = Number(id);
    return subscribe((msg) => {
      if (msg.type !== 'live_scores' || !msg.data) return;
      const updated = msg.data.find((m) => m.id === numId);
      if (updated) setMatch((prev) => (prev ? { ...prev, ...updated } : prev));
    });
  }, [id]);

  if (missing) {
    return (
      <div className="container mx-auto px-4 py-20 max-w-4xl text-center">
        <p className="font-medium text-(--muted-foreground)">Match not found</p>
        <Link href="/" className="text-sm text-(--muted-foreground) hover:text-(--foreground) mt-2 inline-block">
          Back to matches
        </Link>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm text-(--muted-foreground) hover:text-(--foreground) mb-6 transition-colors"
      >
        Back to matches
      </Link>

      {loading ? (
        <>
          <ScoreHeaderSkeleton />
          <div className="space-y-4">
            {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
          </div>
        </>
      ) : match ? (
        <>
          <ScoreHeader match={match} />
          <div>
            <h2 className="text-sm font-semibold text-(--muted-foreground) uppercase tracking-wide mb-4">
              Commentary
            </h2>
            <CommentaryFeed matchId={id!} />
          </div>
        </>
      ) : null}
    </div>
  );
}
