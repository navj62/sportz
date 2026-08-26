'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import type { Match, Competition } from '@/types';
import { fetchMatches, fetchLiveMatches, fetchCompetitions } from '@/lib/api';
import {
  toCompetitionMap,
  competitionNameOf,
  type CompetitionMap,
} from '@/lib/competitions';
import { subscribe } from '@/lib/ws';
import CompetitionBlock from '@/components/competition-block';
import SectionHeader from '@/components/section-header';
import LeagueSidebar, { type LeagueCount } from '@/components/league-sidebar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Competitions with at least this many live matches get their own group.
 *
 * The backend serves the global live firehose — around 174 live matches across
 * 91 competitions, 51 of them with exactly one — so grouping every competition
 * would put more than half the page under a header of its own. Below the
 * threshold, matches fall into "Elsewhere" and carry their competition name on
 * the card instead, so nothing is lost.
 */
const GROUP_THRESHOLD = 2;

interface Groups {
  // The bucket's own competitionId is kept alongside the resolved competition:
  // a match can reference a competition the lookup does not have, and keying a
  // group off the resolved object collapsed every such group onto one key.
  grouped: { competitionId: number; competition: Competition | null; matches: Match[] }[];
  singles: Match[];
}

function groupByCompetition(
  matches: Match[],
  competitions: CompetitionMap,
): Groups {
  const buckets = new Map<number, Match[]>();
  const singles: Match[] = [];

  for (const m of matches) {
    if (m.competitionId == null) {
      singles.push(m);
      continue;
    }
    const bucket = buckets.get(m.competitionId);
    if (bucket) bucket.push(m);
    else buckets.set(m.competitionId, [m]);
  }

  const grouped: Groups['grouped'] = [];

  for (const [id, group] of buckets) {
    if (group.length >= GROUP_THRESHOLD) {
      grouped.push({
        competitionId: id,
        competition: competitions.get(id) ?? null,
        matches: group,
      });
    } else {
      singles.push(...group);
    }
  }

  // Biggest first — the competition with the most football happening leads.
  grouped.sort((a, b) =>
    b.matches.length !== a.matches.length
      ? b.matches.length - a.matches.length
      : (a.competition?.name ?? '').localeCompare(b.competition?.name ?? ''),
  );
  singles.sort((a, b) => a.startTime.localeCompare(b.startTime));

  return { grouped, singles };
}

function BlockSkeleton() {
  return (
    <div className="overflow-hidden rounded-[8px] bg-surface-raised ring-1 ring-stroke">
      <div className="flex items-center gap-2.5 border-b border-stroke bg-surface-elevated px-4 py-2.5">
        <Skeleton className="h-4 w-4 rounded-full" />
        <Skeleton className="h-3 w-32" />
      </div>
      <div className="divide-y divide-stroke">
        {[0, 1, 2].map((i) => (
          <div key={i} className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 py-3">
            <div className="flex items-center justify-end gap-2.5">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-5 w-5 rounded-full" />
            </div>
            <Skeleton className="h-4 w-10" />
            <div className="flex items-center gap-2.5">
              <Skeleton className="h-5 w-5 rounded-full" />
              <Skeleton className="h-4 w-28" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function HomePage() {
  const [liveMatches, setLiveMatches] = useState<Match[]>([]);
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [recent, setRecent] = useState<Match[]>([]);
  const [recentCursor, setRecentCursor] = useState<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [live, comps, finished] = await Promise.all([
        fetchLiveMatches(),
        fetchCompetitions(),
        fetchMatches({ status: 'finished', limit: 20 }),
      ]);
      setLiveMatches(live);
      setCompetitions(comps);
      setRecent(finished.data);
      setRecentCursor(finished.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * The firehose broadcast, merged by id and then PARTITIONED on status.
   *
   * The merge used to be a bare `prev.map`, which is a pure in-place rewrite:
   * cardinality never changed, so membership of the live list was frozen at
   * whatever the initial fetch returned. That is two separate drifts. A match
   * whose payload flipped away from `live` kept its slot and simply wore a
   * Finished badge inside the Live section; and a match that kicked off after
   * load never appeared at all until a refresh. Nothing downstream caught
   * either — `visibleLive`, `groupByCompetition` and `liveCounts` all key off
   * `competitionId` and never read `status`.
   *
   * Membership is `status === 'live'`, not `!== 'finished'`: the enum carries
   * five values, and `postponed` / `cancelled` have to leave too.
   *
   * A match ABSENT from the frame is kept. The payload is one poll's fixtures,
   * so absence says nothing about the match — only an explicit non-live status
   * removes one.
   *
   * Joining is safe against the list's own size because `prev` is not a page:
   * `fetchLiveMatches` sweeps the cursor to completion, so it and the frame
   * describe the same population — every live match. The joiner is a complete
   * row (`upsertMatches(...).returning()`), so it renders with no extra fetch.
   *
   * The updater is pure — no mutation of `updates` — because React invokes it
   * twice under StrictMode, and a drained map on the second pass would silently
   * lose every joiner.
   */
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type !== 'live_scores' || !msg.data) return;
      const incoming = msg.data;
      const updates = new Map(incoming.map((m) => [m.id, m]));

      setLiveMatches((prev) => {
        const present = new Set(prev.map((m) => m.id));
        const next: Match[] = [];

        for (const m of prev) {
          const update = updates.get(m.id);
          const merged = update ? { ...m, ...update } : m;
          if (merged.status === 'live') next.push(merged);
        }

        for (const m of incoming) {
          if (!present.has(m.id) && m.status === 'live') next.push(m);
        }

        return next;
      });
    });
  }, []);

  const competitionMap = useMemo<CompetitionMap>(
    () => toCompetitionMap(competitions),
    [competitions],
  );

  const liveCounts = useMemo<LeagueCount[]>(() => {
    const counts = new Map<number, number>();
    for (const m of liveMatches) {
      if (m.competitionId == null) continue;
      counts.set(m.competitionId, (counts.get(m.competitionId) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([id, live]) => ({ competition: competitionMap.get(id), live }))
      .filter((x): x is LeagueCount => x.competition != null)
      .sort((a, b) =>
        b.live !== a.live
          ? b.live - a.live
          : a.competition.name.localeCompare(b.competition.name),
      );
  }, [liveMatches, competitionMap]);

  const otherCompetitions = useMemo(() => {
    const liveIds = new Set(liveCounts.map((l) => l.competition.id));
    return competitions.filter((c) => !liveIds.has(c.id));
  }, [competitions, liveCounts]);

  const visibleLive = useMemo(
    () =>
      selectedId == null
        ? liveMatches
        : liveMatches.filter((m) => m.competitionId === selectedId),
    [liveMatches, selectedId],
  );

  const { grouped, singles } = useMemo(
    () => groupByCompetition(visibleLive, competitionMap),
    [visibleLive, competitionMap],
  );

  const selectedName =
    selectedId != null ? competitionMap.get(selectedId)?.name : undefined;

  async function loadMoreRecent() {
    if (!recentCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await fetchMatches({
        status: 'finished',
        limit: 20,
        cursor: recentCursor,
      });
      setRecent((prev) => [...prev, ...result.data]);
      setRecentCursor(result.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-280 px-4 py-8">
      <div className="flex flex-col gap-8 lg:flex-row lg:items-start">
        {/* Matches first on a phone. Stacked in source order the rail would put
            fourteen league rows above the first score, and the scores are the
            product. The rail returns to the left at lg.

            Deliberately NOT sticky. Pinning the rail while its content is
            taller than the viewport makes everything below the fold inside it
            unreachable — page scroll moves the centre column, and the pinned
            rail never advances. The rail scrolls with the page instead, so
            there is exactly one scroll context on this screen. */}
        <aside className="order-2 w-full shrink-0 lg:order-1 lg:w-64">
          {loading ? (
            <div className="rounded-[8px] bg-surface-raised p-3 ring-1 ring-stroke">
              <div className="flex flex-col gap-2">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            </div>
          ) : (
            <LeagueSidebar
              live={liveCounts}
              others={otherCompetitions}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
        </aside>

        {/* Not <main> — layout.tsx already provides the main landmark, and
            nesting a second one is invalid and gives the page two landmarks. */}
        <div className="order-1 min-w-0 flex-1 lg:order-2">
          {error ? (
            <div className="rounded-[8px] bg-surface-raised px-6 py-16 text-center ring-1 ring-stroke">
              <p className="type-h2 text-fg">Can&rsquo;t reach the scores right now</p>
              <p className="type-body mx-auto mt-2 max-w-sm text-fg-secondary">
                The scores service didn&rsquo;t respond. Nothing is wrong with what
                you selected.
              </p>
              <Button className="mt-6" onClick={load}>
                Try again
              </Button>
            </div>
          ) : loading ? (
            <>
              <SectionHeader title="Live now" live level={1} />
              <div className="flex flex-col gap-4">
                {[0, 1, 2].map((i) => (
                  <BlockSkeleton key={i} />
                ))}
              </div>
            </>
          ) : (
            <>
              <SectionHeader
                title={selectedName ? `Live · ${selectedName}` : 'Live now'}
                meta={visibleLive.length}
                live
                level={1}
              />

              {visibleLive.length === 0 ? (
                <div className="rounded-[8px] bg-surface-raised px-6 py-12 text-center ring-1 ring-stroke">
                  <p className="type-body text-fg">
                    {selectedName
                      ? `Nothing live in ${selectedName} right now`
                      : 'No matches are live right now'}
                  </p>
                  {selectedName && (
                    <Button
                      variant="outline"
                      className="mt-4"
                      onClick={() => setSelectedId(null)}
                    >
                      Show all competitions
                    </Button>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  {grouped.map(({ competitionId, competition, matches }) => (
                    <CompetitionBlock
                      key={competitionId}
                      competition={competition}
                      matches={matches}
                      live
                    />
                  ))}

                  {singles.length > 0 && (
                    <CompetitionBlock
                      title="Elsewhere"
                      matches={singles}
                      live
                      showCaptions
                      competitionNameOf={(m) => competitionNameOf(m, competitionMap)}
                    />
                  )}
                </div>
              )}

              {recent.length > 0 && selectedId == null && (
                <section className="mt-12">
                  <SectionHeader title="Recently finished" meta={recent.length} />
                  <CompetitionBlock
                    title="Full time"
                    matches={recent}
                    showCaptions
                    competitionNameOf={(m) => competitionNameOf(m, competitionMap)}
                  />
                  {recentCursor && (
                    <div className="mt-6 flex justify-center">
                      <Button
                        variant="outline"
                        onClick={loadMoreRecent}
                        disabled={loadingMore}
                      >
                        {loadingMore ? 'Loading…' : 'Load more'}
                      </Button>
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
