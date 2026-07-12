import { Router } from "express";
import { listCompetitionsQuerySchema } from "../validation/competitions.js";
import { listCompetitions } from "../services/competitionService.js";
import { MAX_LIMIT } from "../constants.js";

export const competitionsRouter = Router();

competitionsRouter.get("/", async (req, res, next) => {
    const parsed = listCompetitionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        return res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
    }

    const limit = Math.min(parsed.data.limit ?? MAX_LIMIT, MAX_LIMIT);

    try {
        const data = await listCompetitions({ limit, cursor: parsed.data.cursor });
        const nextCursor = data.length === limit ? data[data.length - 1].id : null;
        return res.json({ data, nextCursor });
    } catch (error) {
        next(error);
    }
});
