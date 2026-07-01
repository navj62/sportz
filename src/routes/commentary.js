import { Router } from "express";
import { matchIdParamSchema } from "../validation/matches.js";
import { listCommentaryQuerySchema } from "../validation/commentary.js";
import { db } from "../db/db.js";
import { commentary } from "../db/schema.js";
import { desc, eq } from "drizzle-orm";

export const commentaryRouter = Router({ mergeParams: true });

const MAX_LIMIT = 100;

commentaryRouter.get("/", async (req, res) => {
    const paramParsed = matchIdParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
        return res.status(400).json({ error: "Invalid match id", details: paramParsed.error.issues });
    }

    const queryParsed = listCommentaryQuerySchema.safeParse(req.query);
    if (!queryParsed.success) {
        return res.status(400).json({ error: "Invalid query", details: queryParsed.error.issues });
    }

    const limit = Math.min(queryParsed.data.limit ?? MAX_LIMIT, MAX_LIMIT);

    try {
        const data = await db
            .select()
            .from(commentary)
            .where(eq(commentary.matchId, paramParsed.data.id))
            .orderBy(desc(commentary.createdAt))
            .limit(limit);
        return res.json({ data });
    } catch (error) {
        console.error("GET /matches/:id/commentary error:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
});
