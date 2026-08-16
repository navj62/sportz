import type { Match, MatchEvent, Competition } from '@/types';
import { LiveBadge } from '@/components/live-badge';
import { Badge } from '@/components/ui/badge';
import CompetitionLogo from '@/components/competition-logo';
import { categorise, formatMinute, isOwnGoal } from '@/lib/events';

/**
 * The single-match header.
 *
 * The solid LiveBadge is correct here — one match owns the screen, which is
 * the density that pill was designed for. The compact dot exists for the list,
 * where hundreds of live rows share a viewport.
 *
 * No venue and no referee: neither exists on the matches table or in the
 * payload, and inventing football facts is out.
 */

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function StatusMark({ status }: { status: Match['status'] }) {
  switch (status) {
    case 'live':
      return <LiveBadge />;
    case 'finished':
      return <Badge variant="finished">Full time</Badge>;
    case 'postponed':
      return <Badge variant="postponed">Postponed</Badge>;
    case 'cancelled':
      return <Badge variant="cancelled">Cancelled</Badge>;
    default:
      return <Badge variant="scheduled">Scheduled</Badge>;
  }
}

function Side({
  name,
  logoUrl,
  dim,
}: {
  name: string;
  logoUrl: string | null;
  dim: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-3 text-center">
      <CompetitionLogo src={logoUrl} name={name} size={56} />
      <span
        className={`type-h2 w-full break-words ${dim ? 'text-fg-secondary' : 'text-fg'}`}
      >
        {name}
      </span>
    </div>
  );
}

/**
 * The scorer line under the score.
 *
 * Only events that actually changed the score appear — a missed penalty and a
 * Var-disallowed goal are excluded by `categorise`, not by a name check.
 * Unnamed scorers (32% of goals) contribute their minute alone rather than
 * being dropped, so the line still accounts for every goal on the scoreboard.
 *
 * An own goal counts for the side that did NOT score it, so it is listed under
 * the beneficiary with an "(og)" marker — the standard scoreboard convention.
 */
function Scorers({ events, side }: { events: MatchEvent[]; side: 'home' | 'away' }) {
  const goals = events.filter((e) => {
    if (categorise(e) !== 'goal') return false;
    const creditedTo = isOwnGoal(e)
      ? e.teamSide === 'home'
        ? 'away'
        : 'home'
      : e.teamSide;
    return creditedTo === side;
  });

  if (goals.length === 0) return null;

  const byPlayer = new Map<string, string[]>();
  for (const g of goals) {
    const minute = formatMinute(g) ?? '';
    const key = (g.playerName ?? '') + (isOwnGoal(g) ? ' (og)' : '');
    const list = byPlayer.get(key);
    if (list) list.push(minute);
    else byPlayer.set(key, [minute]);
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {[...byPlayer.entries()].map(([name, minutes]) => (
        <li key={name} className="type-label text-fg-secondary">
          {name && <span className="text-fg">{name}</span>}
          {name && ' '}
          <span className="numeral text-[0.8125rem] font-bold">
            {minutes.filter(Boolean).join(', ')}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function MatchHeader({
  match,
  competition,
  events,
}: {
  match: Match;
  competition?: Competition;
  events: MatchEvent[];
}) {
  const {
    homeTeam,
    homeTeamLogoUrl,
    awayTeam,
    awayTeamLogoUrl,
    homeScore,
    awayScore,
    status,
    startTime,
  } = match;

  const hasScore = status !== 'scheduled' && status !== 'cancelled';
  const settled = status === 'finished';
  const dimHome = settled && homeScore < awayScore;
  const dimAway = settled && awayScore < homeScore;

  return (
    <section className="overflow-hidden rounded-[8px] bg-surface-raised ring-1 ring-stroke">
      <header className="flex items-center gap-2.5 border-b border-stroke bg-surface-elevated px-4 py-2.5">
        {competition && (
          <CompetitionLogo src={competition.logoUrl} name={competition.name} size={18} />
        )}
        <h1 className="type-caption min-w-0 shrink truncate text-fg">
          {competition?.name ?? 'Football'}
        </h1>
        {competition?.country && (
          <span className="type-caption min-w-0 shrink truncate text-fg-muted">
            {competition.country}
          </span>
        )}
        <span className="flex-1" />
        <StatusMark status={status} />
      </header>

      <div className="flex items-start gap-4 px-4 py-8 sm:gap-8">
        <Side name={homeTeam} logoUrl={homeTeamLogoUrl} dim={dimHome} />

        <div className="flex shrink-0 flex-col items-center gap-2 pt-4">
          {hasScore ? (
            <span className="type-score text-fg">
              {homeScore}&ndash;{awayScore}
            </span>
          ) : (
            <span className="numeral text-[2rem] font-extrabold leading-none text-fg-secondary">
              {formatTime(startTime)}
            </span>
          )}
        </div>

        <Side name={awayTeam} logoUrl={awayTeamLogoUrl} dim={dimAway} />
      </div>

      {events.length > 0 && (
        <div className="flex items-start gap-4 border-t border-stroke px-4 py-3 sm:gap-8">
          <div className="flex-1 text-right">
            <div className="inline-flex flex-col items-end">
              <Scorers events={events} side="home" />
            </div>
          </div>
          <div className="w-16 shrink-0" aria-hidden="true" />
          <div className="flex-1 text-left">
            <div className="inline-flex flex-col items-start">
              <Scorers events={events} side="away" />
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-stroke px-4 py-2.5">
        <span className="type-label text-fg-secondary">{formatDate(startTime)}</span>
        <span className="text-fg-muted">·</span>
        <span className="numeral text-[0.8125rem] font-bold text-fg-secondary">
          {formatTime(startTime)}
        </span>
        {competition?.currentRound && (
          <>
            <span className="text-fg-muted">·</span>
            <span className="type-label text-fg-muted">{competition.currentRound}</span>
          </>
        )}
      </div>
    </section>
  );
}
