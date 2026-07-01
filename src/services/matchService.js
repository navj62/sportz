import { db } from '../db/db.js';
import { matches } from '../db/schema.js';
import { desc, eq } from 'drizzle-orm';

export async function listMatches({ limit }) {
    return db
        .select()
        .from(matches)
        .orderBy(desc(matches.createdAt))
        .limit(limit);
}

export async function getMatchById(id) {
    const [match] = await db
        .select()
        .from(matches)
        .where(eq(matches.id, id));
    return match ?? null;
}
