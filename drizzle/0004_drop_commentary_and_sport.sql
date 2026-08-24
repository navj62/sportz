ALTER TABLE "commentary" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "commentary" CASCADE;--> statement-breakpoint
DROP INDEX "matches_sport_idx";--> statement-breakpoint
ALTER TABLE "matches" DROP COLUMN "sport";