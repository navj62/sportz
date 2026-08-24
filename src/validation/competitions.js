import { z } from "zod";

export const listCompetitionsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: z.coerce.number().int().positive().optional(),
});

export const competitionIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const listStandingsQuerySchema = z.object({
  season: z.coerce.number().int().positive().optional(),
});
