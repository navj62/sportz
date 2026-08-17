'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Match, MatchEvent, Competition } from '@/types';
import { fetchMatch, fetchMatchEvents } from '@/lib/api';
import { fetchCompetitionMap, competitionOf } from '@/lib/competitions';
import { subscribe, subscribeToMatch } from '@/lib/ws';
import MatchHeader from '@/components/match-header';
import EventList from '@/components/event-list';
import SectionHeader from '@/components/section-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

/* No tabs. Lineups, stats and head-to-head are not in this build's data, and
   three tabs that each say "not available" would make absence the dominant
   feature of a page that is already thin — most fixtures carry one or two
   events. One honest view reads more finished than four, three of which are
   apologies. */

function HeaderSkeleton() {
  return (
    <div className="overflow-hidden rounded-[8px] bg-surface-raised ring-1 ring-stroke">
      <div className="flex items-center gap-2.5 border-b border-stroke bg-surface-elevated px-4 py-2.5">
        <Skeleton className="h-4 w-4 rounded-full" />
        <Skeleton className="h-3 w-40" />
      </div>
      <div className="flex items-start gap-8 px-4 py-8">
        {[0, 1].map((i) => (
          <div key={i} className="flex flex-1 flex-col items-center gap-3">
            <Skeleton className="h-14 w-14 rounded-full" />
            <Skeleton className="h-5 w-32" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function MatchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [id, setId] = useState<string | null>(null);
  const [match, setMatch] = useState<Match | null>(null);
  const [events, setEvents] = useState<MatchEvent[]>([]);
  const [competition, setCompetition] = useState<Competition | undefined>();
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.resolve(params).then((p) => setId(p.id));
  }, [params]);

  const load = useCallback(async (matchId: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMatch(matchId);
      if (!data) {
        setMissing(true);
        return;
      }
      setMatch(data);

      // Events and the competition lookup are independent of each other and
      // neither is worth failing the page over — the score is the product, and
      // it has already arrived by this point.
      const [eventResult, mapResult] = await Promise.allSettled([
        fetchMatchEvents(matchId),
        fetchCompetitionMap(),
      ]);
      if (eventResult.status === 'fulfilled') setEvents(eventResult.value);
      if (mapResult.status === 'fulfilled') {
        setCompetition(competitionOf(data, mapResult.value));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (id) load(id);
  }, [id, load]);

  /**
   * Narrows the socket to this one match, which is what activates the server's
   * per-match filtering — until now every socket carried an empty subscription
   * set, and `subscribedMatches` was serving the whole firehose to everyone.
   *
   * The id has to come from the loaded match rather than the route param: the
   * server gates on `Number.isInteger(matchId)`, and the param is a string.
   */
  // Depends on the numeric id, not the match object: a score update replaces
  // `match`, and re-running these on every update would tear the subscription
  // down and rebuild it on every goal.
  const numericId = match?.id ?? null;

  useEffect(() => {
    if (numericId == null) return;
    return subscribeToMatch(numericId);
  }, [numericId]);

  useEffect(() => {
    if (numericId == null) return;
    return subscribe((msg) => {
      if (msg.type !== 'live_scores' || !msg.data) return;
      const update = msg.data.find((m) => m.id === numericId);
      if (update) setMatch((prev) => (prev ? { ...prev, ...update } : prev));
    });
  }, [numericId]);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8">
      <Link
        href="/"
        className="type-label mb-6 inline-flex items-center gap-1 text-fg-secondary transition-colors hover:text-fg"
      >
        ← All matches
      </Link>

      {missing ? (
        <div className="rounded-[8px] bg-surface-raised px-6 py-16 text-center ring-1 ring-stroke">
          <p className="type-h2 text-fg">Match not found</p>
          <p className="type-body mt-2 text-fg-secondary">
            It may have been removed, or the link may be wrong.
          </p>
        </div>
      ) : error ? (
        <div className="rounded-[8px] bg-surface-raised px-6 py-16 text-center ring-1 ring-stroke">
          <p className="type-h2 text-fg">Can&rsquo;t reach the scores right now</p>
          <p className="type-body mx-auto mt-2 max-w-sm text-fg-secondary">
            The scores service didn&rsquo;t respond.
          </p>
          <Button className="mt-6" onClick={() => id && load(id)}>
            Try again
          </Button>
        </div>
      ) : loading ? (
        <HeaderSkeleton />
      ) : match ? (
        <>
          <MatchHeader match={match} competition={competition} events={events} />

          <div className="mt-10">
            <SectionHeader title="Match events" meta={events.length || undefined} />
            <div className="overflow-hidden rounded-[8px] bg-surface-raised ring-1 ring-stroke">
              <EventList events={events} match={match} />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
