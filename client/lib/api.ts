import type {
  Match,
  Competition,
  Commentary,
  PaginatedResponse,
} from '@/types';

// Browser fetches go through the /backend proxy (Next.js rewrites → port 8000).
// Server-side fetches use the direct URL via API_URL env var.
const BASE =
  typeof window !== 'undefined'
    ? '/backend'
    : (process.env.API_URL ?? 'http://localhost:8000');

// The backend caps `limit` at 100 (MAX_LIMIT), so a full sweep is
// ceil(rows / 100) requests. PAGE_CAP bounds a runaway loop if the cursor ever
// stops advancing; at 100 rows a page that is 2000 matches, far past any
// plausible number of simultaneous live fixtures.
const MAX_PAGE = 100;
const PAGE_CAP = 20;

export interface MatchFilters {
  limit?: number;
  cursor?: number;
  // Only 'scheduled' | 'live' | 'finished' are accepted here. The backend's
  // Zod schema rejects 'postponed' and 'cancelled' even though a match can
  // carry those statuses in a response.
  status?: string;
  startTimeFrom?: string;
  startTimeTo?: string;
}

export async function fetchMatches(
  filters: MatchFilters = {},
): Promise<PaginatedResponse<Match>> {
  const { limit = 20, cursor, status, startTimeFrom, startTimeTo } = filters;
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', String(cursor));
  if (status) params.set('status', status);
  if (startTimeFrom) params.set('startTimeFrom', startTimeFrom);
  if (startTimeTo) params.set('startTimeTo', startTimeTo);

  const res = await fetch(`${BASE}/matches?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch matches: ${res.status}`);
  return res.json() as Promise<PaginatedResponse<Match>>;
}

/**
 * Walks the keyset cursor to completion.
 *
 * The live list is swept whole rather than paginated because the page groups
 * by competition: a partial page would show "Serie A · 3" when nine are live,
 * which is worse than slower. Live fixtures worldwide run to a few hundred, so
 * this is two or three requests.
 */
async function fetchAll(filters: MatchFilters): Promise<Match[]> {
  const out: Match[] = [];
  let cursor: number | undefined;

  for (let page = 0; page < PAGE_CAP; page++) {
    const result = await fetchMatches({ ...filters, limit: MAX_PAGE, cursor });
    out.push(...result.data);
    if (result.nextCursor == null) break;
    cursor = result.nextCursor;
  }

  return out;
}

export function fetchLiveMatches(): Promise<Match[]> {
  return fetchAll({ status: 'live' });
}

export async function fetchMatch(id: string | number): Promise<Match | null> {
  const res = await fetch(`${BASE}/matches/${id}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch match: ${res.status}`);
  const body = (await res.json()) as { match: Match };
  return body.match;
}

/**
 * Competition names are NOT on the match payload — `listMatches` selects the
 * matches table with no join, so a match carries `competitionId` and nothing
 * else. Everything that groups or labels by competition needs this map.
 */
export async function fetchCompetitions(): Promise<Competition[]> {
  const out: Competition[] = [];
  let cursor: number | undefined;

  for (let page = 0; page < PAGE_CAP; page++) {
    const params = new URLSearchParams({ limit: String(MAX_PAGE) });
    if (cursor) params.set('cursor', String(cursor));

    const res = await fetch(`${BASE}/competitions?${params}`);
    if (!res.ok) throw new Error(`Failed to fetch competitions: ${res.status}`);
    const result = (await res.json()) as PaginatedResponse<Competition>;

    out.push(...result.data);
    if (result.nextCursor == null) break;
    cursor = result.nextCursor;
  }

  return out;
}

export interface CommentaryFilters {
  limit?: number;
  cursor?: number;
}

export async function fetchCommentary(
  matchId: string | number,
  filters: CommentaryFilters = {},
): Promise<PaginatedResponse<Commentary>> {
  const { limit = 20, cursor } = filters;
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', String(cursor));

  const res = await fetch(`${BASE}/matches/${matchId}/commentary?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch commentary: ${res.status}`);
  return res.json() as Promise<PaginatedResponse<Commentary>>;
}
