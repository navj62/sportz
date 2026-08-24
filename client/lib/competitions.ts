import type { Match, Competition } from '@/types';
import { fetchCompetitions } from '@/lib/api';

/**
 * The one competition-resolution path.
 *
 * Competition names are NOT on the match payload — `listMatches` selects the
 * matches table with no join, so a match carries `competitionId` and nothing
 * else. Anything that labels or groups by competition needs this lookup, and
 * it lives here so the list and the detail page share one implementation
 * rather than growing two that can disagree.
 */

export type CompetitionMap = Map<number, Competition>;

export function toCompetitionMap(list: Competition[]): CompetitionMap {
  return new Map(list.map((c) => [c.id, c]));
}

export async function fetchCompetitionMap(): Promise<CompetitionMap> {
  return toCompetitionMap(await fetchCompetitions());
}

export function competitionOf(
  match: Pick<Match, 'competitionId'>,
  map: CompetitionMap,
): Competition | undefined {
  return match.competitionId != null ? map.get(match.competitionId) : undefined;
}

export function competitionNameOf(
  match: Pick<Match, 'competitionId'>,
  map: CompetitionMap,
): string | undefined {
  return competitionOf(match, map)?.name;
}
