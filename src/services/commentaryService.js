import { db } from '../db/db.js';
import { commentary } from '../db/schema.js';
import { and, desc, eq, lt } from 'drizzle-orm';

export async function listCommentary({ matchId, limit, cursor }) {
    const conditions = [eq(commentary.matchId, matchId)];

    if (cursor !== undefined) conditions.push(lt(commentary.id, cursor));

    return db
        .select()
        .from(commentary)
        .where(and(...conditions))
        .orderBy(desc(commentary.id))
        .limit(limit);
}
