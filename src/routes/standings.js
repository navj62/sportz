import { Router } from "express";
import {
    competitionIdParamSchema,
    listStandingsQuerySchema,
} from "../validation/competitions.js";
import { listStandingsByCompetition } from "../services/standingsService.js";

export const standingsRouter = Router({ mergeParams: true });

standingsRouter.get("/", async (req, res, next) => {
    const paramParsed = competitionIdParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
        return res.status(400).json({ error: "Invalid competition id", details: paramParsed.error.issues });
    }

    const queryParsed = listStandingsQuerySchema.safeParse(req.query);
    if (!queryParsed.success) {
        return res.status(400).json({ error: "Invalid query", details: queryParsed.error.issues });
    }

    try {
        // A table is at most a few dozen rows — ordered by group then rank, unpaginated.
        const data = await listStandingsByCompetition({
            competitionId: paramParsed.data.id,
            season: queryParsed.data.season,
        });
        return res.json({ data });
    } catch (error) {
        next(error);
    }
});
