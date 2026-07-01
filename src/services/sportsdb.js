const API_KEY = process.env.SPORTSDB_API_KEY ?? '1';
const BASE_V1 = `https://www.thesportsdb.com/api/v1/json/${API_KEY}`;
const BASE_V2 = `https://www.thesportsdb.com/api/v2/json/${API_KEY}`;

const LIVE_STATUSES = new Set(['1H', 'HT', '2H', 'ET', 'PT', 'BT', 'P', 'INT', 'LIVE']);
const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN', 'ABD', 'ABAN', 'CANC', 'SUSP', 'WO', 'AWD']);

function mapStatus(strStatus) {
    if (LIVE_STATUSES.has(strStatus)) return 'live';
    if (FINISHED_STATUSES.has(strStatus)) return 'finished';
    return 'scheduled';
}

export function mapEventToMatch(event) {
    const dateStr = event.dateEvent ?? new Date().toISOString().slice(0, 10);
    const timeStr = event.strTime ?? '00:00:00';
    return {
        externalId: String(event.idEvent),
        sport: event.strSport ?? 'Soccer',
        homeTeam: event.strHomeTeam,
        awayTeam: event.strAwayTeam,
        homeScore: Number(event.intHomeScore ?? 0),
        awayScore: Number(event.intAwayScore ?? 0),
        status: mapStatus(event.strProgress ?? event.strStatus ?? 'NS'),
        startTime: new Date(`${dateStr}T${timeStr}Z`),
        endTime: null,
    };
}

export async function fetchLiveScores() {
    const res = await fetch(`${BASE_V2}/livescore.php`);
    if (!res.ok) throw new Error(`TheSportsDB error ${res.status}: ${res.statusText}`);
    const json = await res.json();
    return Array.isArray(json.events) ? json.events : [];
}
