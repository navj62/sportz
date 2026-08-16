/* Shapes mirror the backend responses exactly. Verified against a running
   backend on 2026-08-15, not inferred from the Drizzle schema — the two had
   already drifted twice (`sport` was removed in the football rebuild, and the
   team logo / competition columns were added without the types following). */

// The DB enum carries five values. Note that GET /matches?status= only accepts
// the first three — `postponed` and `cancelled` can be RETURNED but cannot be
// FILTERED on. Display must handle five; the filter may only offer three.
export type MatchStatus =
  | 'scheduled'
  | 'live'
  | 'finished'
  | 'postponed'
  | 'cancelled';

export interface Match {
  id: number;
  externalId: string | null;
  competitionId: number | null;
  homeTeam: string;
  homeTeamLogoUrl: string | null;
  homeTeamExternalId: string | null;
  awayTeam: string;
  awayTeamLogoUrl: string | null;
  awayTeamExternalId: string | null;
  status: MatchStatus;
  startTime: string;
  endTime: string | null;
  homeScore: number;
  awayScore: number;
  createdAt: string;
}

export interface Competition {
  id: number;
  externalId: string;
  name: string;
  country: string | null;
  season: number | null;
  // API-Football's league.round is free text — "Regular Season - 20",
  // "Quarter-finals" — so this is never a number.
  currentRound: string | null;
  logoUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * An event row exactly as GET /matches/:id/events returns it.
 *
 * `type` is API-Football's raw vocabulary, written straight through by
 * mapFixtureToEvents — the allowlist is EVENT_TYPES in
 * src/validation/events.js: "Goal" | "Card" | "subst" | "Var". It is NOT
 * normalised, and it is NOT the field to branch on: `type: 'Goal'` covers a
 * scored goal, a penalty, an OWN goal and a MISSED penalty. The meaning lives
 * in `detail` — see lib/events.ts.
 */
export interface MatchEvent {
  id: number;
  matchId: number;
  // Never null across 2,558 rows measured.
  minute: number | null;
  type: string;
  // Null on exactly 1 of 2,558 rows, which is why it is the branch field.
  detail: string | null;
  // Null on ~15% of rows overall, ~32% of goals, ~59% of missed penalties.
  playerName: string | null;
  teamSide: 'home' | 'away';
  // { extra, assist, incomingPlayer, comments } — all optional, and the whole
  // object is null on ~39% of rows. `extra` carries stoppage time (116 rows),
  // `incomingPlayer` the player coming on for a substitution (1,018 rows).
  metadata: {
    extra?: string | number | null;
    assist?: string | null;
    incomingPlayer?: string | null;
    comments?: string | null;
  } | null;
  createdAt: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  nextCursor: number | null;
}

export interface WsMessage {
  type: 'welcome' | 'live_scores' | 'subscribed' | 'unsubscribed' | 'error';
  data?: Match[];
  matchId?: number;
  error?: string;
}
