import type { MatchEvent } from '@/types';

/**
 * Event semantics.
 *
 * Branch on `detail`, never on `type`. `type: 'Goal'` covers a goal that
 * stands, a penalty, an OWN goal AND a missed penalty — keying on it renders a
 * missed penalty as a goal, which tells the reader the opposite of what
 * happened. `detail` is null on exactly 1 of 2,558 rows measured, so it is
 * effectively total; `type` is the fallback for that one row only.
 *
 * The vocabulary is API-Football's raw output, written straight through by
 * mapFixtureToEvents. Measured distribution:
 *
 *   Goal  / Normal Goal                777    Card  / Yellow Card      600
 *   subst / Substitution 1..11       1,028    Card  / Red Card          52
 *   Goal  / Penalty                     46    Goal  / Missed Penalty    22
 *   Goal  / Own Goal                    21    Var   / Goal Disallowed…  11
 *
 * Two categories are correctness-critical, not stylistic:
 *   - `missed`     — filed under type 'Goal' but is NOT a goal.
 *   - `disallowed` — a Var retraction: a goal TAKEN AWAY.
 * Both must read as not-a-goal.
 */

export type EventCategory =
  | 'goal'
  | 'missed'
  | 'disallowed'
  | 'yellow'
  | 'red'
  | 'substitution'
  | 'other';

export function categorise(event: MatchEvent): EventCategory {
  const detail = event.detail?.trim().toLowerCase();

  if (detail) {
    // Order matters: 'missed penalty' must be tested before 'penalty'.
    if (detail === 'missed penalty') return 'missed';
    if (detail.startsWith('goal disallowed')) return 'disallowed';
    if (detail === 'normal goal' || detail === 'penalty' || detail === 'own goal') {
      return 'goal';
    }
    if (detail.startsWith('substitution')) return 'substitution';
    if (detail === 'red card' || detail.startsWith('second yellow')) return 'red';
    if (detail === 'yellow card') return 'yellow';
  }

  // detail null or unrecognised — fall back on type, conservatively. An
  // unknown 'Goal' is deliberately NOT categorised as a goal: a new upstream
  // detail could be another Missed-Penalty-shaped value, and the cost of
  // showing an unknown event plainly is far lower than the cost of announcing
  // a goal that did not happen.
  if (event.type === 'Card') return 'yellow';
  if (event.type === 'subst') return 'substitution';
  return 'other';
}

/** True only for events that changed the score. */
export function isGoal(event: MatchEvent): boolean {
  return categorise(event) === 'goal';
}

export function isOwnGoal(event: MatchEvent): boolean {
  return event.detail?.trim().toLowerCase() === 'own goal';
}

/**
 * The minute, with stoppage time when present: "45+2'", else "45'".
 * `metadata.extra` carries it on 116 of 2,558 rows, always alongside 45 or 90.
 */
export function formatMinute(event: MatchEvent): string | null {
  if (event.minute == null) return null;
  const extra = event.metadata?.extra;
  const extraNum = extra == null ? null : Number(extra);
  return extraNum && Number.isFinite(extraNum) && extraNum > 0
    ? `${event.minute}+${extraNum}'`
    : `${event.minute}'`;
}

/**
 * The label an event carries when it has no player name — which is the common
 * case, not the exception (32% of goals, 59% of missed penalties). Every
 * category has to read cleanly with the name absent, so the label alone is
 * always a complete sentence about what happened.
 */
export const CATEGORY_LABEL: Record<EventCategory, string> = {
  goal: 'Goal',
  missed: 'Missed penalty',
  disallowed: 'Goal disallowed',
  yellow: 'Yellow card',
  red: 'Red card',
  substitution: 'Substitution',
  other: 'Event',
};

/**
 * The precise label where `detail` adds something the category does not:
 * "Penalty" and "Own goal" are both goals, and the Var reasons differ.
 */
export function eventLabel(event: MatchEvent): string {
  const category = categorise(event);
  const detail = event.detail?.trim();

  if (category === 'goal' && detail) {
    const d = detail.toLowerCase();
    if (d === 'penalty') return 'Goal · penalty';
    if (d === 'own goal') return 'Own goal';
    return 'Goal';
  }

  if (category === 'disallowed' && detail) {
    // "Goal Disallowed - offside" → "Goal disallowed · offside"
    const reason = detail.split('-').slice(1).join('-').trim();
    return reason ? `Goal disallowed · ${reason.toLowerCase()}` : 'Goal disallowed';
  }

  if (category === 'other') {
    if (detail) return detail;
    // The one null-detail row in 2,558 is a `Var`. Naming it as a VAR check is
    // both more useful than "Event" and safely non-committal: a Var row with
    // no detail does not say whether anything was overturned, so it must not
    // borrow the disallowed treatment either.
    if (event.type === 'Var') return 'VAR check';
  }

  return CATEGORY_LABEL[category];
}
