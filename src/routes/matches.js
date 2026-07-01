import { Router } from "express";
import { listMatchesQuerySchema, matchIdParamSchema } from "../validation/matches.js";
import { listMatches, getMatchById } from "../services/matchService.js";

export const matchesRouter = Router();

const MAX_LIMIT = 100;

matchesRouter.get("/", async (req, res) => {
    const parsed = listMatchesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        return res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
    }
    const limit = parsed.data.limit ?? MAX_LIMIT;
    try {
        const data = await listMatches({ limit });
        res.json({ data });
    } catch (error) {
        console.error("GET /matches error:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
});

matchesRouter.get("/:id", async (req, res) => {
    const parsed = matchIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
        return res.status(400).json({ error: "Invalid match id", details: parsed.error.issues });
    }
    try {
        const match = await getMatchById(parsed.data.id);
        if (!match) {
            return res.status(404).json({ error: "Match not found" });
        }
        return res.json({ match });
    } catch (error) {
        console.error(`GET /matches/${parsed.data.id} error:`, error);
        return res.status(500).json({ error: "Internal server error" });
    }
});

export default matchesRouter;
