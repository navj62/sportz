import { z } from "zod";

// API-Football's event.type vocabulary, as observed on /fixtures?live=all.
// The meaning lives in `detail` ("Own Goal", "Yellow Card", "Substitution 3"),
// which is why the column is text: extending this list needs no migration.
export const EVENT_TYPES = ["Goal", "Card", "subst", "Var"];

export const eventTypeSchema = z.enum(EVENT_TYPES);

export const listEventsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
});
