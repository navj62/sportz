CREATE TYPE "public"."team_side" AS ENUM('home', 'away');--> statement-breakpoint
CREATE TABLE "competitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"country" text,
	"season" integer,
	"current_round" text,
	"logo_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competitions_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"match_id" integer NOT NULL,
	"minute" integer,
	"type" text NOT NULL,
	"detail" text,
	"player_name" text,
	"team_side" "team_side" NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "standings" (
	"id" serial PRIMARY KEY NOT NULL,
	"competition_id" integer NOT NULL,
	"season" integer NOT NULL,
	"rank" integer NOT NULL,
	"team_external_id" text NOT NULL,
	"team_name" text NOT NULL,
	"team_logo_url" text,
	"group_name" text,
	"points" integer DEFAULT 0 NOT NULL,
	"goals_diff" integer DEFAULT 0 NOT NULL,
	"played" integer DEFAULT 0 NOT NULL,
	"win" integer DEFAULT 0 NOT NULL,
	"draw" integer DEFAULT 0 NOT NULL,
	"lose" integer DEFAULT 0 NOT NULL,
	"goals_for" integer DEFAULT 0 NOT NULL,
	"goals_against" integer DEFAULT 0 NOT NULL,
	"form" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "competition_id" integer;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "home_team_logo_url" text;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "home_team_external_id" text;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "away_team_logo_url" text;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "away_team_external_id" text;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standings" ADD CONSTRAINT "standings_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_match_id_minute_idx" ON "events" USING btree ("match_id","minute");--> statement-breakpoint
CREATE UNIQUE INDEX "standings_competition_season_team_idx" ON "standings" USING btree ("competition_id","season","team_external_id");--> statement-breakpoint
CREATE INDEX "standings_competition_season_rank_idx" ON "standings" USING btree ("competition_id","season","rank");--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "matches_competition_id_idx" ON "matches" USING btree ("competition_id");