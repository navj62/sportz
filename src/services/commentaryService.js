import { db } from '../db/db.js';
import { commentary } from '../db/schema.js';
import { desc, eq } from 'drizzle-orm';

export async function listCommentary({ matchId, limit }) {
    return db
        .select()
        .from(commentary)
        .where(eq(commentary.matchId, matchId))
        .orderBy(desc(commentary.createdAt))
        .limit(limit);
}
