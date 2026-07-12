import { logger } from '../logger.js';
import {
    API_FOOTBALL_BASE_URL,
    API_FOOTBALL_MAX_RETRIES,
    API_FOOTBALL_RETRY_BASE_MS,
} from '../constants.js';

/**
 * @typedef {Object} ApiQuota
 * @property {number|null} remainingDay   x-ratelimit-requests-remaining
 * @property {number|null} limitDay       x-ratelimit-requests-limit
 * @property {number|null} remainingMinute x-ratelimit-remaining
 */

/**
 * API-Football wraps every payload in this envelope and returns HTTP 200 even
 * on failure. `errors` is polymorphic: [] on success, but an object keyed by
 * error kind on failure — e.g. { plan: "Free plans do not have access..." }.
 * @typedef {Object} ApiEnvelope
 * @property {string} get
 * @property {Record<string, string>} parameters
 * @property {string[]|Record<string, string>} errors
 * @property {number} results
 * @property {{ current: number, total: number }} paging
 * @property {unknown[]|Record<string, unknown>} response
 */

/**
 * @typedef {Object} ApiTeam
 * @property {number} id
 * @property {string} name
 * @property {string|null} logo
 * @property {boolean|null} winner
 */

/**
 * @typedef {Object} ApiLeague
 * @property {number} id
 * @property {string} name
 * @property {string|null} country
 * @property {string|null} logo
 * @property {number} season
 * @property {string|null} round Free text: "Regular Season - 20", "Round of 32".
 */

/**
 * @typedef {Object} ApiEvent
 * @property {{ elapsed: number|null, extra: number|null }} time
 * @property {{ id: number, name: string, logo: string|null }} team
 * @property {{ id: number|null, name: string|null }} player
 * @property {{ id: number|null, name: string|null }} assist
 * @property {string} type   "Goal" | "Card" | "subst" | "Var"
 * @property {string|null} detail "Own Goal" | "Yellow Card" | "Substitution 3"
 * @property {string|null} comments
 */

/**
 * @typedef {Object} ApiFixture
 * @property {{ id: number, date: string, status: { short: string, long: string, elapsed: number|null } }} fixture
 * @property {ApiLeague} league
 * @property {{ home: ApiTeam, away: ApiTeam }} teams
 * @property {{ home: number|null, away: number|null }} goals
 * @property {ApiEvent[]} [events] Embedded by /fixtures?live=all.
 */

/**
 * @typedef {Object} ApiStandingRow
 * @property {number} rank
 * @property {{ id: number, name: string, logo: string|null }} team
 * @property {number} points
 * @property {number} goalsDiff
 * @property {string|null} group
 * @property {string|null} form
 * @property {string|null} description
 * @property {{ played: number, win: number, draw: number, lose: number, goals: { for: number, against: number } }} all
 */

const SCHEDULED_STATUSES = new Set(['TBD', 'NS']);
const LIVE_STATUSES = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE']);
// PST/CANC/ABD are not truly "finished", but match_status has no cell for them.
// Coercing them here preserves the behaviour the previous provider had.
const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN', 'PST', 'CANC', 'ABD', 'AWD', 'WO']);

/**
 * Read lazily rather than at module load, so importing this module is side-effect
 * free and unit tests never need the key in the environment.
 * @returns {string}
 */
function getApiKey() {
    const key = process.env.API_FOOTBALL_KEY;
    if (!key) {
        throw new Error('API_FOOTBALL_KEY is not defined');
    }
    return key;
}

/**
 * `errors` is [] on success and an object on failure, so a plain `.length`
 * check silently passes on the failure shape.
 * @param {string[]|Record<string, string>} errors
 * @returns {string[]}
 */
function collectErrors(errors) {
    if (Array.isArray(errors)) return errors.map(String);
    if (errors && typeof errors === 'object') {
        return Object.entries(errors).map(([kind, message]) => `${kind}: ${message}`);
    }
    return [];
}

/** @param {Headers} headers @returns {ApiQuota} */
function readQuota(headers) {
    const num = (name) => {
        const raw = headers.get(name);
        return raw === null || raw === '' ? null : Number(raw);
    };
    return {
        remainingDay: num('x-ratelimit-requests-remaining'),
        limitDay: num('x-ratelimit-requests-limit'),
        remainingMinute: num('x-ratelimit-remaining'),
    };
}

/** @param {number} ms */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Single request against the API, with envelope validation and 429 backoff.
 * @param {string} path e.g. '/fixtures?live=all'
 * @returns {Promise<{ envelope: ApiEnvelope, quota: ApiQuota }>}
 */
async function request(path) {
    const key = getApiKey();
    const url = `${API_FOOTBALL_BASE_URL}${path}`;

    for (let attempt = 0; ; attempt++) {
        const res = await fetch(url, { headers: { 'x-apisports-key': key } });

        if (res.status === 429) {
            if (attempt >= API_FOOTBALL_MAX_RETRIES) {
                throw new Error(`API-Football rate limited ${path} after ${attempt} retries`);
            }
            // Honour Retry-After when the API sends one, else exponential backoff.
            const retryAfter = Number(res.headers.get('retry-after'));
            const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : API_FOOTBALL_RETRY_BASE_MS * 2 ** attempt;

            logger.warn({ path, attempt: attempt + 1, delayMs }, 'API-Football rate limited, backing off');
            await sleep(delayMs);
            continue;
        }

        if (!res.ok) {
            throw new Error(`API-Football error ${res.status}: ${res.statusText}`);
        }

        /** @type {ApiEnvelope} */
        const envelope = await res.json();
        const quota = readQuota(res.headers);
        const errors = collectErrors(envelope.errors);

        if (errors.length > 0) {
            throw new Error(`API-Football error on ${path}: ${errors.join('; ')}`);
        }

        return { envelope, quota };
    }
}

/** @returns {Promise<{ status: Record<string, unknown>, quota: ApiQuota }>} */
export async function fetchStatus() {
    const { envelope, quota } = await request('/status');
    return { status: /** @type {Record<string, unknown>} */ (envelope.response), quota };
}

/**
 * Live fixtures. The response embeds each fixture's events, so one request
 * covers fixtures, leagues and events — no per-fixture follow-up needed.
 * @returns {Promise<{ fixtures: ApiFixture[], quota: ApiQuota }>}
 */
export async function fetchLiveFixtures() {
    const { envelope, quota } = await request('/fixtures?live=all');
    return { fixtures: /** @type {ApiFixture[]} */ (envelope.response), quota };
}

/** @param {string} date YYYY-MM-DD @returns {Promise<{ fixtures: ApiFixture[], quota: ApiQuota }>} */
export async function fetchFixturesByDate(date) {
    const { envelope, quota } = await request(`/fixtures?date=${encodeURIComponent(date)}`);
    return { fixtures: /** @type {ApiFixture[]} */ (envelope.response), quota };
}

/** @param {number} id @returns {Promise<{ fixtures: ApiFixture[], quota: ApiQuota }>} */
export async function fetchFixtureById(id) {
    const { envelope, quota } = await request(`/fixtures?id=${id}`);
    return { fixtures: /** @type {ApiFixture[]} */ (envelope.response), quota };
}

/**
 * Standalone events endpoint. liveSync does not use it — /fixtures?live=all
 * already embeds events, and one call per live fixture would cost ~47 requests
 * a cycle. Kept for fetching events of a fixture that is not currently live.
 * @param {number} fixtureId
 * @returns {Promise<{ events: ApiEvent[], quota: ApiQuota }>}
 */
export async function fetchFixtureEvents(fixtureId) {
    const { envelope, quota } = await request(`/fixtures/events?fixture=${fixtureId}`);
    return { events: /** @type {ApiEvent[]} */ (envelope.response), quota };
}

/**
 * @param {number} leagueId
 * @param {number} season
 * @returns {Promise<{ rows: ApiStandingRow[], quota: ApiQuota }>}
 */
export async function fetchStandings(leagueId, season) {
    const { envelope, quota } = await request(`/standings?league=${leagueId}&season=${season}`);
    const response = /** @type {Array<{ league: { standings: ApiStandingRow[][] } }>} */ (envelope.response);
    // response[0].league.standings is an array of groups; a league has one, a cup several.
    const groups = response[0]?.league?.standings ?? [];
    return { rows: groups.flat(), quota };
}

/** @param {string} short @returns {'scheduled'|'live'|'finished'} */
export function mapStatus(short) {
    if (LIVE_STATUSES.has(short)) return 'live';
    if (FINISHED_STATUSES.has(short)) return 'finished';
    if (SCHEDULED_STATUSES.has(short)) return 'scheduled';
    return 'scheduled';
}

/** @param {ApiFixture} fixture */
export function mapFixtureToCompetition(fixture) {
    return {
        externalId: String(fixture.league.id),
        name: fixture.league.name,
        country: fixture.league.country ?? null,
        season: fixture.league.season ?? null,
        currentRound: fixture.league.round ?? null,
        logoUrl: fixture.league.logo ?? null,
    };
}

/**
 * @param {ApiFixture} fixture
 * @param {number|null} competitionId FK, resolved by the caller from competitions.
 */
export function mapFixtureToMatch(fixture, competitionId = null) {
    return {
        externalId: String(fixture.fixture.id),
        competitionId,
        homeTeam: fixture.teams.home.name,
        homeTeamLogoUrl: fixture.teams.home.logo ?? null,
        homeTeamExternalId: String(fixture.teams.home.id),
        awayTeam: fixture.teams.away.name,
        awayTeamLogoUrl: fixture.teams.away.logo ?? null,
        awayTeamExternalId: String(fixture.teams.away.id),
        status: mapStatus(fixture.fixture.status.short),
        startTime: new Date(fixture.fixture.date),
        homeScore: fixture.goals.home ?? 0,
        awayScore: fixture.goals.away ?? 0,
    };
}

/**
 * Events carry a team id, not a side, so the side is derived by comparing
 * against the fixture's home team.
 * @param {ApiFixture} fixture
 * @param {number} matchId
 */
export function mapFixtureToEvents(fixture, matchId) {
    const homeTeamId = fixture.teams.home.id;

    return (fixture.events ?? []).map((event) => {
        const metadata = {
            assist: event.assist?.name ?? null,
            comments: event.comments ?? null,
            extra: event.time?.extra ?? null,
        };
        const hasMetadata = Object.values(metadata).some((value) => value !== null);

        return {
            matchId,
            minute: event.time?.elapsed ?? null,
            type: event.type,
            detail: event.detail ?? null,
            // player.name is null on roughly a quarter of events upstream.
            playerName: event.player?.name ?? null,
            teamSide: /** @type {'home'|'away'} */ (event.team.id === homeTeamId ? 'home' : 'away'),
            metadata: hasMetadata ? metadata : null,
        };
    });
}

/**
 * @param {ApiStandingRow} row
 * @param {number} competitionId
 * @param {number} season
 */
export function mapStandingRow(row, competitionId, season) {
    return {
        competitionId,
        season,
        rank: row.rank,
        teamExternalId: String(row.team.id),
        teamName: row.team.name,
        teamLogoUrl: row.team.logo ?? null,
        groupName: row.group ?? null,
        points: row.points ?? 0,
        goalsDiff: row.goalsDiff ?? 0,
        played: row.all?.played ?? 0,
        win: row.all?.win ?? 0,
        draw: row.all?.draw ?? 0,
        lose: row.all?.lose ?? 0,
        goalsFor: row.all?.goals?.for ?? 0,
        goalsAgainst: row.all?.goals?.against ?? 0,
        form: row.form ?? null,
        description: row.description ?? null,
    };
}
