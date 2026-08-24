import type { Match, Competition } from '@/types';
import CompetitionLogo from '@/components/competition-logo';
import MatchRow from '@/components/match-row';

/**
 * One competition, one card: a header band and its matches as rows.
 *
 * The block IS the group boundary. Previously every match was its own ringed
 * card under a shared rule, so one competition's matches were no more bound to
 * each other than to the next competition's. Header band, ring and the gap
 * between blocks now do that work, which is what makes a group read as a
 * group.
 */

export default function CompetitionBlock({
  competition,
  matches,
  title,
  live = false,
  showCaptions = false,
  competitionNameOf,
}: {
  competition?: Competition | null;
  matches: Match[];
  /** Overrides the competition name — used by "Elsewhere" and finished lists. */
  title?: string;
  live?: boolean;
  /** Rows carry their own competition name, for blocks that mix competitions. */
  showCaptions?: boolean;
  competitionNameOf?: (match: Match) => string | undefined;
}) {
  const heading = title ?? competition?.name ?? 'Unknown competition';
  const country = title ? undefined : competition?.country;

  return (
    <section className="overflow-hidden rounded-[8px] bg-surface-raised ring-1 ring-stroke">
      <header className="flex items-center gap-2.5 border-b border-stroke bg-surface-elevated px-4 py-2.5">
        {live && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-live animate-live-pulse" />
        )}
        {!title && (
          <CompetitionLogo src={competition?.logoUrl ?? null} name={heading} size={18} />
        )}
        <h2 className="type-caption min-w-0 shrink truncate text-fg">{heading}</h2>
        {country && (
          <span className="type-caption min-w-0 shrink truncate text-fg-muted">
            {country}
          </span>
        )}
        <span className="flex-1" />
        <span className="numeral shrink-0 text-[0.8125rem] font-bold text-fg-secondary">
          {matches.length}
        </span>
      </header>

      <div className="divide-y divide-stroke">
        {matches.map((m) => (
          <MatchRow
            key={m.id}
            match={m}
            caption={showCaptions ? competitionNameOf?.(m) : undefined}
          />
        ))}
      </div>
    </section>
  );
}
