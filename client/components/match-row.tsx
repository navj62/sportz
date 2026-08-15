import Link from 'next/link';
import type { Match } from '@/types';
import CompetitionLogo from '@/components/competition-logo';

/**
 * One match, on one line.
 *
 * Home reads inward from the left, away outward to the right, and the centre
 * slot carries the single fact the visitor came for: the score if it exists,
 * the kickoff time if it does not. Deliberately compact — the vertical
 * two-row card fitted about two matches per screen on a surface whose whole
 * job is a glance across many.
 *
 * No venue here. The list card stays teams and time-or-score; venue belongs
 * on the match detail page.
 */

function formatKickoff(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function Side({
  name,
  logoUrl,
  dim,
  align,
}: {
  name: string;
  logoUrl: string | null;
  dim: boolean;
  align: 'home' | 'away';
}) {
  const crest = <CompetitionLogo src={logoUrl} name={name} size={20} />;
  const label = (
    <span
      className={`type-body min-w-0 truncate ${align === 'home' ? 'text-right' : 'text-left'} ${
        dim ? 'text-fg-muted' : 'text-fg'
      }`}
      title={name}
    >
      {name}
    </span>
  );

  return (
    <div
      className={`flex min-w-0 items-center gap-2.5 ${
        align === 'home' ? 'justify-end' : 'justify-start'
      }`}
    >
      {align === 'home' ? (
        <>
          {label}
          {crest}
        </>
      ) : (
        <>
          {crest}
          {label}
        </>
      )}
    </div>
  );
}

export default function MatchRow({
  match,
  caption,
}: {
  match: Match;
  /** Competition name, for rows outside a competition block. */
  caption?: string;
}) {
  const {
    id,
    homeTeam,
    homeTeamLogoUrl,
    awayTeam,
    awayTeamLogoUrl,
    homeScore,
    awayScore,
    status,
    startTime,
  } = match;

  const hasScore = status !== 'scheduled';
  const settled = status === 'finished';
  // A finished match reads back as a result, so the losing side recedes. A live
  // one never dims — it is still being decided.
  const dimHome = settled && homeScore < awayScore;
  const dimAway = settled && awayScore < homeScore;

  const interrupted = status === 'postponed' || status === 'cancelled';

  return (
    <Link
      href={`/matches/${id}`}
      aria-label={
        hasScore
          ? `${homeTeam} ${homeScore}, ${awayTeam} ${awayScore}, ${status}`
          : `${homeTeam} versus ${awayTeam}, ${formatDay(startTime)} ${formatKickoff(startTime)}`
      }
      className="block px-4 py-2.5 transition-colors hover:bg-surface-elevated focus-visible:outline-none focus-visible:bg-surface-elevated"
    >
      {caption && (
        <span className="type-caption mb-1.5 block truncate text-fg-muted">
          {caption}
        </span>
      )}

      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <Side name={homeTeam} logoUrl={homeTeamLogoUrl} dim={dimHome} align="home" />

        <div className="flex w-16 shrink-0 flex-col items-center justify-center">
          {interrupted ? (
            <span className="type-caption text-postponed">
              {status === 'postponed' ? 'P—P' : 'Off'}
            </span>
          ) : hasScore ? (
            <span className="numeral text-[1.0625rem] font-extrabold leading-none tracking-[-0.02em] text-fg">
              {homeScore}&ndash;{awayScore}
            </span>
          ) : (
            <span className="numeral text-[0.9375rem] font-bold leading-none text-fg-secondary">
              {formatKickoff(startTime)}
            </span>
          )}
          {settled && (
            <span className="type-caption mt-1 leading-none text-fg-muted">FT</span>
          )}
        </div>

        <Side name={awayTeam} logoUrl={awayTeamLogoUrl} dim={dimAway} align="away" />
      </div>
    </Link>
  );
}
