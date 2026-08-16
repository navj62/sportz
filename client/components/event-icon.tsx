import { ArrowRightLeft } from 'lucide-react';
import type { EventCategory } from '@/lib/events';

/* One 16px grid, one stroke weight, 14px rendered — the reference sheet's
   marker system. Goal and cards are authored SVG because they are objects
   specific to this sport; the substitution arrow comes from lucide at the same
   size and stroke. No emoji, ever.

   The goal glyph is white per DESIGN.md: red is the STATE channel (live), a
   goal is an EVENT, and spending red on both made the two strongest signals
   compete. Red is kept for the red card, which is a red object. */

function Ball({ struck = false }: { struck?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="shrink-0">
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 5L10.85 7.07L9.76 10.43H6.24L5.15 7.07Z" fill="currentColor" />
      {struck && (
        <line
          x1="2.5" y1="13.5" x2="13.5" y2="2.5"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
        />
      )}
    </svg>
  );
}

function Card({ tone }: { tone: 'yellow' | 'red' }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="shrink-0">
      <rect
        x="4.25" y="2.25" width="7.5" height="11.5" rx="1.5"
        fill="currentColor"
        /* --accent-dim reads at 2.32:1 on the card surface, not legible at
           14px, so a red card takes the full accent. */
        style={{ color: tone === 'yellow' ? 'var(--status-postponed)' : 'var(--accent)' }}
      />
    </svg>
  );
}

/** Tone is deliberately NOT red for goals — see the note above. */
export const CATEGORY_TONE: Record<EventCategory, string> = {
  goal: 'text-fg',
  missed: 'text-fg-muted',
  disallowed: 'text-fg-muted',
  yellow: 'text-postponed',
  red: 'text-signal',
  substitution: 'text-fg-secondary',
  other: 'text-fg-secondary',
};

export default function EventIcon({ category }: { category: EventCategory }) {
  switch (category) {
    case 'goal':
      return <Ball />;
    // A miss and a retraction share the struck ball: both are "this is not on
    // the scoreboard". They are told apart by their labels, which are always
    // present, rather than by icon alone.
    case 'missed':
    case 'disallowed':
      return <Ball struck />;
    case 'yellow':
      return <Card tone="yellow" />;
    case 'red':
      return <Card tone="red" />;
    case 'substitution':
      return <ArrowRightLeft size={14} strokeWidth={1.75} className="shrink-0" />;
    default:
      return <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-fg-muted" />;
  }
}
