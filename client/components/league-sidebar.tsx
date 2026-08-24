'use client';

import { useState } from 'react';
import type { Competition } from '@/types';
import CompetitionLogo from '@/components/competition-logo';
import { cn } from '@/lib/utils';

/**
 * The competition rail.
 *
 * Deliberately derived from the data rather than a curated "top leagues" list.
 * This backend serves the global live firehose, so at most hours the
 * recognisable European leagues have nothing playing while Tasmania NPL and
 * the Chatham Cup do. A hardcoded list would be dead nav most of the time, and
 * naming a league that is not playing is inventing a football fact.
 *
 * So: "Competitions" is whatever is live right now, ranked by how much of it
 * is live. "All leagues" is everything else the backend knows about, grouped
 * by country.
 */

export interface LeagueCount {
  competition: Competition;
  live: number;
}

function RailRow({
  competition,
  count,
  selected,
  onSelect,
}: {
  competition: Competition;
  count?: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex w-full items-center gap-3 rounded-[6px] px-2 py-2 text-left transition-colors',
        selected ? 'bg-surface-elevated text-fg' : 'text-fg-secondary hover:bg-surface-elevated',
      )}
    >
      <CompetitionLogo src={competition.logoUrl} name={competition.name} size={20} />
      <span className="type-label min-w-0 flex-1 truncate">{competition.name}</span>
      {count != null && count > 0 && (
        <span className="numeral shrink-0 text-[0.75rem] font-bold text-fg-muted">
          {count}
        </span>
      )}
    </button>
  );
}

function RailHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="type-caption mb-2 px-2 text-fg-muted">{children}</h2>;
}

/**
 * How many live competitions the rail shows before collapsing the tail. Around
 * 90 are live at once, which would run the rail several screens past the match
 * list; the ones below the cut are single-match competitions whose matches are
 * in "Elsewhere" anyway.
 */
const LIVE_RAIL_CAP = 14;

/**
 * All-leagues rows shown before the tail collapses. Capped by COUNT, never by
 * height with an inner scroller: an `overflow-y-auto` panel here created a
 * second scroll context that captured the wheel and made the rail's lower half
 * hard to reach. One scroll on this screen, and it is the page's.
 */
const ALL_LEAGUES_CAP = 24;

export default function LeagueSidebar({
  live,
  others,
  selectedId,
  onSelect,
}: {
  live: LeagueCount[];
  others: Competition[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [allExpanded, setAllExpanded] = useState(false);

  // A selected competition must stay visible even when it sits below the cut,
  // or the rail loses its own selected state.
  const selectedBelowCut =
    selectedId != null && live.findIndex((l) => l.competition.id === selectedId) >= LIVE_RAIL_CAP;
  const visibleLive =
    expanded || selectedBelowCut ? live : live.slice(0, LIVE_RAIL_CAP);
  const hiddenCount = live.length - visibleLive.length;

  const sortedOthers = [...others].sort((a, b) => {
    const country = (a.country ?? 'International').localeCompare(b.country ?? 'International');
    return country !== 0 ? country : a.name.localeCompare(b.name);
  });
  const visibleOthers = allExpanded ? sortedOthers : sortedOthers.slice(0, ALL_LEAGUES_CAP);
  const hiddenOthers = sortedOthers.length - visibleOthers.length;

  const byCountry = new Map<string, Competition[]>();
  for (const c of visibleOthers) {
    const key = c.country ?? 'International';
    const list = byCountry.get(key);
    if (list) list.push(c);
    else byCountry.set(key, [c]);
  }
  const countries = [...byCountry.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <nav aria-label="Competitions" className="flex flex-col gap-6">
      <div className="rounded-[8px] bg-surface-raised p-3 ring-1 ring-stroke">
        <RailHeading>Live competitions</RailHeading>

        {live.length === 0 ? (
          <p className="type-label px-2 py-1 text-fg-muted">Nothing live</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {selectedId != null && (
              <button
                type="button"
                onClick={() => onSelect(null)}
                className="type-label mb-1 rounded-[6px] px-2 py-2 text-left text-fg-secondary transition-colors hover:bg-surface-elevated"
              >
                ← All competitions
              </button>
            )}
            {visibleLive.map(({ competition, live: count }) => (
              <RailRow
                key={competition.id}
                competition={competition}
                count={count}
                selected={selectedId === competition.id}
                onSelect={() =>
                  onSelect(selectedId === competition.id ? null : competition.id)
                }
              />
            ))}
            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="type-label mt-1 rounded-[6px] px-2 py-2 text-left text-fg-muted transition-colors hover:bg-surface-elevated hover:text-fg-secondary"
              >
                Show {hiddenCount} more
              </button>
            )}
            {expanded && (
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="type-label mt-1 rounded-[6px] px-2 py-2 text-left text-fg-muted transition-colors hover:bg-surface-elevated hover:text-fg-secondary"
              >
                Show fewer
              </button>
            )}
          </div>
        )}
      </div>

      {countries.length > 0 && (
        <div className="rounded-[8px] bg-surface-raised p-3 ring-1 ring-stroke">
          <RailHeading>All leagues</RailHeading>
          <div className="flex flex-col gap-4">
            {countries.map(([country, comps]) => (
              <div key={country}>
                <h3 className="type-label mb-1 px-2 font-semibold text-fg-secondary">
                  {country}
                </h3>
                <div className="flex flex-col gap-0.5">
                  {comps.map((c) => (
                    <RailRow
                      key={c.id}
                      competition={c}
                      selected={selectedId === c.id}
                      onSelect={() => onSelect(selectedId === c.id ? null : c.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
            {(hiddenOthers > 0 || allExpanded) && (
              <button
                type="button"
                onClick={() => setAllExpanded((v) => !v)}
                className="type-label rounded-[6px] px-2 py-2 text-left text-fg-muted transition-colors hover:bg-surface-elevated hover:text-fg-secondary"
              >
                {allExpanded ? 'Show fewer' : `Show ${hiddenOthers} more`}
              </button>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
