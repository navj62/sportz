import { Router } from "express";
import { matchIdParamSchema } from "../validation/matches.js";
import { listCommentaryQuerySchema } from "../validation/commentary.js";
import { listCommentaryFromEvents } from "../services/eventService.js";
import { MAX_LIMIT } from "../constants.js";

// DEPRECATED: remove in frontend phase.
// The commentary table is gone; this reads the events table and synthesizes the
// `message` string the existing frontend feed still expects. GET
// /matches/:id/events is the canonical endpoint. Pagination stays id-DESC +
// cursor so the feed's paging behaviour is unchanged.
export const commentaryRouter = Router({ mergeParams: true });

commentaryRouter.get("/", async (req, res, next) => {
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
        const data = await listCommentaryFromEvents({
            matchId: paramParsed.data.id,
            limit,
            cursor: queryParsed.data.cursor,
        });
        const nextCursor = data.length === limit ? data[data.length - 1].id : null;
        return res.json({ data, nextCursor });
    } catch (error) {
        next(error);
    }
});
