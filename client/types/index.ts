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

export interface Commentary {
  id: number;
  matchId: number;
  minute: number | null;
  sequence: number;
  period: string | null;
  eventType: string;
  actor: string | null;
  team: string | null;
  message: string;
  metadata: Record<string, unknown> | null;
  tags: string[] | null;
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
