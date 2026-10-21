ALTER TABLE "offense_reports" DROP CONSTRAINT "offense_reports_session_id_reporter_id_target_id_pk";--> statement-breakpoint
ALTER TABLE "player_ratings" DROP CONSTRAINT "player_ratings_session_id_rater_id_target_id_pk";--> statement-breakpoint
ALTER TABLE "offense_reports" ADD COLUMN "id" integer PRIMARY KEY NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "offense_reports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1);--> statement-breakpoint
ALTER TABLE "player_ratings" ADD COLUMN "id" integer PRIMARY KEY NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "player_ratings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1);--> statement-breakpoint
CREATE INDEX "offense_reports_session_idx" ON "offense_reports" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "player_ratings_session_idx" ON "player_ratings" USING btree ("session_id");