import { Router } from "express";
import { matchIdParamSchema } from "../validation/matches.js";
import { listEventsQuerySchema } from "../validation/events.js";
import { listEventsByMatch } from "../services/eventService.js";
import { MAX_LIMIT } from "../constants.js";

export const eventsRouter = Router({ mergeParams: true });

eventsRouter.get("/", async (req, res, next) => {
    const paramParsed = matchIdParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
        return res.status(400).json({ error: "Invalid match id", details: paramParsed.error.issues });
    }

    const queryParsed = listEventsQuerySchema.safeParse(req.query);
    if (!queryParsed.success) {
        return res.status(400).json({ error: "Invalid query", details: queryParsed.error.issues });
    }

    const limit = Math.min(queryParsed.data.limit ?? MAX_LIMIT, MAX_LIMIT);

    try {
        // A match has tens of events, not thousands — ordered by minute, unpaginated.
        const data = await listEventsByMatch({ matchId: paramParsed.data.id, limit });
        return res.json({ data });
    } catch (error) {
        next(error);
    }
});
