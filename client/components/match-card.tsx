import Link from 'next/link';
import type { Match, MatchStatus } from '@/types';
import { LiveBadge } from '@/components/live-badge';
import { Badge } from '@/components/ui/badge';
import CompetitionLogo from '@/components/competition-logo';

/* Ported from the reference sheet's MatchCard so the product and the specimen
   agree. Depth is the surface step: a live fixture sits one layer forward
   rather than wearing a coloured border. */

function StatusBadge({ status }: { status: MatchStatus }) {
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

function formatKickoff(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function TeamRow({
  name,
  logoUrl,
  score,
  dim,
}: {
  name: string;
  logoUrl: string | null;
  score?: number;
  dim?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <CompetitionLogo src={logoUrl} name={name} size={28} />
      <span
        className={`type-body min-w-0 flex-1 truncate font-medium ${
          dim ? 'text-fg-secondary' : 'text-fg'
        }`}
        title={name}
      >
        {name}
      </span>
      {score != null && (
        <span
          className={`numeral w-6 text-right text-[1.625rem] font-extrabold leading-none ${
            dim ? 'text-fg-secondary' : 'text-fg'
          }`}
        >
          {score}
        </span>
      )}
    </div>
  );
}

export default function MatchCard({
  match,
  competitionName,
  showCompetition = false,
  showStatus = true,
}: {
  match: Match;
  competitionName?: string;
  showCompetition?: boolean;
  /**
   * Off inside the LIVE NOW section: every card there is live by construction,
   * so a red LIVE pill on each one repeats the section header 174 times and
   * spends the whole accent budget on saying nothing. The surface step carries
   * it instead — a live card sits one layer forward.
   */
  showStatus?: boolean;
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

  const live = status === 'live';
  const hasScore = status !== 'scheduled';
  // A finished match reads back as a result, so the losing side recedes. A live
  // one never dims — it is still being decided.
  const dimHome = status === 'finished' && homeScore < awayScore;
  const dimAway = status === 'finished' && awayScore < homeScore;

  return (
    <Link
      href={`/matches/${id}`}
      aria-label={
        hasScore
          ? `${homeTeam} ${homeScore}, ${awayTeam} ${awayScore}, ${status}`
          : `${homeTeam} versus ${awayTeam}, ${formatKickoff(startTime)}`
      }
      className="block rounded-[8px] focus-visible:outline-none"
    >
      <article
        className={`overflow-hidden rounded-[8px] ring-1 ring-stroke transition-colors ${
          live
            ? 'bg-surface-elevated'
            : 'bg-surface-raised hover:bg-surface-elevated'
        }`}
      >
        <header className="flex items-center justify-between gap-3 px-4 pt-3 pb-2.5">
          <span className="type-caption min-w-0 truncate text-fg-secondary">
            {showCompetition ? (competitionName ?? 'Football') : formatKickoff(startTime)}
          </span>
          {showStatus && <StatusBadge status={status} />}
        </header>

        <div className="space-y-3 px-4 pb-4">
          <TeamRow
            name={homeTeam}
            logoUrl={homeTeamLogoUrl}
            score={hasScore ? homeScore : undefined}
            dim={dimHome}
          />
          <TeamRow
            name={awayTeam}
            logoUrl={awayTeamLogoUrl}
            score={hasScore ? awayScore : undefined}
            dim={dimAway}
          />
        </div>
      </article>
    </Link>
  );
}
