import type { Match } from '@/types';
import { LiveBadge } from '@/components/live-badge';
import { Badge } from '@/components/ui/badge';

function StatusBadge({ status }: { status: Match['status'] }) {
  if (status === 'live') return <LiveBadge />;
  if (status === 'finished') return <Badge variant="finished">Finished</Badge>;
  return <Badge variant="scheduled">Scheduled</Badge>;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function ScoreHeader({ match }: { match: Match }) {
  const { homeTeam, awayTeam, homeScore, awayScore, status, startTime } = match;

  return (
    <div className="rounded-xl border border-(--border) bg-(--card) p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        {/* The competition name needs the competitions lookup; the detail page
            is the next pass, so this slot stays empty rather than showing the
            removed `sport` column. */}
        <span />
        <StatusBadge status={status} />
      </div>

      <div className="flex items-center gap-4">
        <div className="flex-1 space-y-2">
          <p className="text-lg font-bold">{homeTeam}</p>
          <p className="text-lg font-bold">{awayTeam}</p>
        </div>

        {status !== 'scheduled' ? (
          <div className="text-right tabular-nums">
            <p className="text-4xl font-black leading-none">{homeScore}</p>
            <p className="text-4xl font-black leading-none mt-2">{awayScore}</p>
          </div>
        ) : (
          <div className="text-right">
            <p className="text-sm text-(--muted-foreground)">{formatDate(startTime)}</p>
          </div>
        )}
      </div>
    </div>
  );
}
