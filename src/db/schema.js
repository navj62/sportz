import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const matchStatusEnum = pgEnum("match_status", [
  "scheduled",
  "live",
  "finished",
]);

export const teamSideEnum = pgEnum("team_side", ["home", "away"]);

export const competitions = pgTable("competitions", {
  id: serial("id").primaryKey(),
  externalId: text("external_id").notNull().unique(),
  name: text("name").notNull(),
  country: text("country"),
  season: integer("season"),
  // API-Football returns league.round as free text — "Regular Season - 20",
  // "Round of 32", "Club Friendlies" — so this cannot be an integer matchday.
  currentRound: text("current_round"),
  logoUrl: text("logo_url"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const matches = pgTable("matches", {
  id: serial("id").primaryKey(),
  externalId: text("external_id").unique(),
  competitionId: integer("competition_id").references(() => competitions.id, {
    onDelete: "set null",
  }),
  homeTeam: text("home_team").notNull(),
  homeTeamLogoUrl: text("home_team_logo_url"),
  homeTeamExternalId: text("home_team_external_id"),
  awayTeam: text("away_team").notNull(),
  awayTeamLogoUrl: text("away_team_logo_url"),
  awayTeamExternalId: text("away_team_external_id"),
  status: matchStatusEnum("status").notNull().default("scheduled"),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }),
  homeScore: integer("home_score").notNull().default(0),
  awayScore: integer("away_score").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
}, (table) => [
  index("matches_created_at_idx").on(table.createdAt),
  index("matches_status_idx").on(table.status),
  index("matches_start_time_idx").on(table.startTime),
  index("matches_competition_id_idx").on(table.competitionId),
]);

export const events = pgTable("events", {
  id: serial("id").primaryKey(),
  matchId: integer("match_id")
    .notNull()
    .references(() => matches.id, { onDelete: "cascade" }),
  minute: integer("minute"),
  // API-Football event.type: "Goal" | "Card" | "subst" | "Var". Text rather
  // than an enum so a new upstream type does not require a migration.
  type: text("type").notNull(),
  // API-Football event.detail: "Own Goal", "Yellow Card", "Substitution 3".
  detail: text("detail"),
  playerName: text("player_name"),
  teamSide: teamSideEnum("team_side").notNull(),
  // Loose extras only: { assist, comments, extra }.
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
}, (table) => [
  index("events_match_id_minute_idx").on(table.matchId, table.minute),
]);

export const standings = pgTable("standings", {
  id: serial("id").primaryKey(),
  competitionId: integer("competition_id")
    .notNull()
    .references(() => competitions.id, { onDelete: "cascade" }),
  season: integer("season").notNull(),
  rank: integer("rank").notNull(),
  teamExternalId: text("team_external_id").notNull(),
  teamName: text("team_name").notNull(),
  teamLogoUrl: text("team_logo_url"),
  // "group" is a reserved word in SQL, so the column is named group_name.
  groupName: text("group_name"),
  points: integer("points").notNull().default(0),
  goalsDiff: integer("goals_diff").notNull().default(0),
  played: integer("played").notNull().default(0),
  win: integer("win").notNull().default(0),
  draw: integer("draw").notNull().default(0),
  lose: integer("lose").notNull().default(0),
  goalsFor: integer("goals_for").notNull().default(0),
  goalsAgainst: integer("goals_against").notNull().default(0),
  form: text("form"),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
}, (table) => [
  uniqueIndex("standings_competition_season_team_idx").on(
    table.competitionId,
    table.season,
    table.teamExternalId,
  ),
  index("standings_competition_season_rank_idx").on(
    table.competitionId,
    table.season,
    table.rank,
  ),
]);
