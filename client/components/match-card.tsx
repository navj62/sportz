import Link from 'next/link';
import type { Match } from '@/types';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { LiveBadge } from '@/components/live-badge';

function StatusBadge({ status }: { status: Match['status'] }) {
  if (status === 'live') return <LiveBadge />;
  if (status === 'finished') return <Badge variant="finished">Finished</Badge>;
  return <Badge variant="scheduled">Scheduled</Badge>;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function MatchCard({ match }: { match: Match }) {
  const { id, homeTeam, awayTeam, homeScore, awayScore, status, startTime } = match;

  return (
    <Link href={`/matches/${id}`} className="block group">
      <Card className="transition-shadow group-hover:shadow-md">
        <CardContent>
          <div className="flex items-center justify-between mb-3">
            <StatusBadge status={status} />
          </div>

          <div className="flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="font-semibold truncate">{homeTeam}</p>
              <p className="font-semibold truncate mt-1">{awayTeam}</p>
            </div>

            {status !== 'scheduled' && (
              <div className="text-right tabular-nums">
                <p className="text-2xl font-bold leading-none">{homeScore}</p>
                <p className="text-2xl font-bold leading-none mt-1">{awayScore}</p>
              </div>
            )}

            {status === 'scheduled' && (
              <div className="text-right">
                <p className="text-sm text-(--muted-foreground)">{formatTime(startTime)}</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
