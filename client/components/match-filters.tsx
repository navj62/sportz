'use client';
import { cn } from '@/lib/utils';

const STATUSES = [
  { value: '', label: 'All' },
  { value: 'live', label: 'Live' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'finished', label: 'Finished' },
];

interface MatchFiltersProps {
  status: string;
  onStatusChange: (status: string) => void;
}

export default function MatchFilters({ status, onStatusChange }: MatchFiltersProps) {
  return (
    <div className="flex flex-col sm:flex-row gap-3 mb-6">
      <div className="flex gap-1 p-1 rounded-lg bg-(--muted) w-fit">
        {STATUSES.map((s) => (
          <button
            key={s.value}
            onClick={() => onStatusChange(s.value)}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
              status === s.value
                ? 'bg-(--card) text-(--foreground) shadow-sm'
                : 'text-(--muted-foreground) hover:text-(--foreground)',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
