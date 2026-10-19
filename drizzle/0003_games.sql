CREATE TABLE "games" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"name" text NOT NULL,
	"party_size" integer DEFAULT 5 NOT NULL,
	"match_minutes" integer DEFAULT 40 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "games_group_name" UNIQUE("group_id","name")
);
--> statement-breakpoint
CREATE TABLE "member_games" (
	"user_id" text NOT NULL,
	"game_id" text NOT NULL,
	CONSTRAINT "member_games_user_id_game_id_pk" PRIMARY KEY("user_id","game_id")
);
--> statement-breakpoint
ALTER TABLE "play_sessions" ADD COLUMN "game_id" text;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_games" ADD CONSTRAINT "member_games_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_games" ADD CONSTRAINT "member_games_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_sessions" ADD CONSTRAINT "play_sessions_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Data: every existing group gets the starter games. Valorant keeps the group's old party size and match
-- length, everyone already in a group plays it (it was the only game), and existing sessions were Valorant.
-- They are added a second apart so they list in this order (like new groups, see src/lib/games.ts).
INSERT INTO "games" ("id", "group_id", "name", "party_size", "match_minutes", "created_at")
SELECT 'valorant-' || "id", "id", 'Valorant', "party_size", "match_length_minutes", now() + interval '0 seconds' FROM "groups";--> statement-breakpoint
INSERT INTO "games" ("id", "group_id", "name", "party_size", "match_minutes", "created_at")
SELECT 'lol-' || "id", "id", 'League of Legends', 5, 35, now() + interval '1 seconds' FROM "groups";--> statement-breakpoint
INSERT INTO "games" ("id", "group_id", "name", "party_size", "match_minutes", "created_at")
SELECT 'tft-' || "id", "id", 'TFT', 2, 40, now() + interval '2 seconds' FROM "groups";--> statement-breakpoint
INSERT INTO "games" ("id", "group_id", "name", "party_size", "match_minutes", "created_at")
SELECT 'aion2-' || "id", "id", 'Aion 2', 4, 30, now() + interval '3 seconds' FROM "groups";--> statement-breakpoint
INSERT INTO "member_games" ("user_id", "game_id")
SELECT "user_id", 'valorant-' || "group_id" FROM "memberships";--> statement-breakpoint
UPDATE "play_sessions" SET "game_id" = 'valorant-' || "group_id";
