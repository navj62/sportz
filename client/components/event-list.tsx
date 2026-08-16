import type { Match, MatchEvent } from '@/types';
import { categorise, eventLabel, formatMinute } from '@/lib/events';
import EventIcon, { CATEGORY_TONE } from '@/components/event-icon';

/**
 * The match timeline.
 *
 * Designed name-optional. A player name is absent on ~15% of rows overall,
 * ~32% of goals and ~59% of missed penalties, so the label alone is always a
 * complete statement of what happened and the name is an enhancement on top —
 * never "Goal — null", never a dangling separator, never an empty gap.
 *
 * Substitutions are the exception in the other direction: 100% named, with
 * `metadata.incomingPlayer` on 1,018 rows, so they show both players.
 */

function Player({ event }: { event: MatchEvent }) {
  const category = categorise(event);

  if (category === 'substitution') {
    const off = event.playerName;
    const on = event.metadata?.incomingPlayer;
    if (!off && !on) return null;
    return (
      <span className="type-label text-fg-secondary">
        {on && <span className="text-fg">{on}</span>}
        {on && off && <span className="text-fg-muted"> for </span>}
        {off && <span>{off}</span>}
      </span>
    );
  }

  if (!event.playerName) return null;
  return <span className="type-label text-fg">{event.playerName}</span>;
}

function EventRow({ event, match }: { event: MatchEvent; match: Match }) {
  const category = categorise(event);
  const minute = formatMinute(event);
  const label = eventLabel(event);
  const teamName = event.teamSide === 'home' ? match.homeTeam : match.awayTeam;

  // A retraction is struck through: the reader must see that this did not
  // stand, not merely read a word saying so.
  const struck = category === 'disallowed';

  return (
    <li className="flex items-baseline gap-3 px-4 py-2.5">
      <span className="numeral w-12 shrink-0 text-right text-[0.8125rem] font-bold text-fg-secondary">
        {minute ?? ''}
      </span>

      <span className={`relative top-0.5 ${CATEGORY_TONE[category]}`}>
        <EventIcon category={category} />
      </span>

      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
        <span
          className={`type-label ${
            category === 'goal' ? 'text-fg' : 'text-fg-secondary'
          } ${struck ? 'line-through decoration-fg-muted' : ''}`}
        >
          {label}
        </span>
        <Player event={event} />
      </span>

      <span className="type-caption shrink-0 truncate text-fg-muted" title={teamName}>
        {teamName}
      </span>
    </li>
  );
}

export default function EventList({
  events,
  match,
}: {
  events: MatchEvent[];
  match: Match;
}) {
  if (events.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="type-body text-fg-secondary">No events recorded</p>
        <p className="type-label mt-1 text-fg-muted">
          Events arrive with the live feed; many fixtures carry none.
        </p>
      </div>
    );
  }

  // Latest first — the reader is checking what just happened. Stoppage time
  // sorts after its own minute; `extra` is not in the backend's index, so the
  // ordering is done here (FOLLOWUPS entry 4).
  const ordered = [...events].sort((a, b) => {
    const am = (a.minute ?? 0) * 100 + Number(a.metadata?.extra ?? 0);
    const bm = (b.minute ?? 0) * 100 + Number(b.metadata?.extra ?? 0);
    return bm - am;
  });

  return (
    <ul className="divide-y divide-stroke">
      {ordered.map((e) => (
        <EventRow key={e.id} event={e} match={match} />
      ))}
    </ul>
  );
}
