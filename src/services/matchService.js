import { db } from '../db/db.js';
import { matches } from '../db/schema.js';
import { and, desc, eq, gte, lt, lte } from 'drizzle-orm';

export async function listMatches({ limit, cursor, status, sport, startTimeFrom, startTimeTo }) {
    const conditions = [];

    if (cursor !== undefined)        conditions.push(lt(matches.id, cursor));
    if (status !== undefined)        conditions.push(eq(matches.status, status));
    if (sport !== undefined)         conditions.push(eq(matches.sport, sport));
    if (startTimeFrom !== undefined) conditions.push(gte(matches.startTime, new Date(startTimeFrom)));
    if (startTimeTo !== undefined)   conditions.push(lte(matches.startTime, new Date(startTimeTo)));

    return db
        .select()
        .from(matches)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(matches.id))
        .limit(limit);
}

export async function getMatchById(id) {
    const [match] = await db
        .select()
        .from(matches)
        .where(eq(matches.id, id));
    return match ?? null;
}
