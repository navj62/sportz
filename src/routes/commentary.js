import { Router } from "express";
import { matchIdParamSchema } from "../validation/matches.js";
import { listCommentaryQuerySchema } from "../validation/commentary.js";
import { listCommentary } from "../services/commentaryService.js";
import { MAX_LIMIT } from "../constants.js";

export const commentaryRouter = Router({ mergeParams: true });

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
        const data = await listCommentary({
            matchId: paramParsed.data.id,
            limit,
            cursor: queryParsed.data.cursor,
        });
        const nextCursor = data.length === limit ? data[data.length - 1].id : null;
        return res.json({ data, nextCursor });
    } catch (error) {
        console.error("GET /matches/:id/commentary error:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
});
