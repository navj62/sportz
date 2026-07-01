import { z } from "zod";

export const MATCH_STATUS = {
  SCHEDULED: "scheduled",
  LIVE: "live",
  FINISHED: "finished",
};

export const listMatchesQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().max(100).optional(),
    cursor: z.coerce.number().int().positive().optional(),
    status: z.enum(["scheduled", "live", "finished"]).optional(),
    sport: z.string().min(1).max(100).optional(),
    startTimeFrom: z.iso.datetime().optional(),
    startTimeTo: z.iso.datetime().optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.startTimeFrom &&
      data.startTimeTo &&
      Date.parse(data.startTimeTo) < Date.parse(data.startTimeFrom)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "startTimeTo must be after startTimeFrom",
        path: ["startTimeTo"],
      });
    }
  });

export const matchIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

