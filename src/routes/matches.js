import Router from "express";
import { createMatchSchema, listMatchesQuerySchema, matchIdParamSchema } from "../validation/matches.js";
import { db } from "../db/db.js";
import { matches } from "../db/schema.js";
import { desc, eq } from "drizzle-orm";
export const matchesRouter = Router();

const MAX_LIMIT = 100;

function getMatchStatus(startTime, endTime) {
    const now = Date.now();
    if (now < Date.parse(startTime)) return "scheduled";
    if (now <= Date.parse(endTime)) return "live";
    return "finished";
}

matchesRouter.get("/", async (req, res) => {
    const parsed = listMatchesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        return res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
    }
    const limit = parsed.data.limit ?? MAX_LIMIT;
    try {
        const data=await db
        .select()
        .from(matches)
        .orderBy(desc(matches.createdAt))
        .limit(limit)
      res.json({data})
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

matchesRouter.get("/:id", async (req, res) => {
    const parsed = matchIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
        return res.status(400).json({ error: "Invalid match id", details: parsed.error.issues });
    }
    try {
        const [match] = await db.select().from(matches).where(eq(matches.id, parsed.data.id));
        if (!match) {
            return res.status(404).json({ error: "Match not found" });
        }
        return res.json({ match });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});


matchesRouter.post("/", async (req, res) => {
    const parsed = createMatchSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
    }
    const { startTime, endTime, homeScore, awayScore } = parsed.data;
    try {
        const [event] = await db.insert(matches).values({
            ...parsed.data,
            startTime: new Date(startTime),
            endTime: new Date(endTime),
            homeScore: homeScore ?? 0,
            awayScore: awayScore ?? 0,
            status: getMatchStatus(startTime, endTime),
        }).returning();
        res.status(201).json({ event });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

export default matchesRouter;