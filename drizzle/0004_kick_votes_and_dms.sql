CREATE TABLE "kick_votes" (
	"session_id" text NOT NULL,
	"voter_id" text NOT NULL,
	"target_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kick_votes_session_id_voter_id_target_id_pk" PRIMARY KEY("session_id","voter_id","target_id")
);
--> statement-breakpoint
ALTER TABLE "member_profiles" ADD COLUMN "dm_when_full" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kick_votes" ADD CONSTRAINT "kick_votes_session_id_play_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."play_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kick_votes" ADD CONSTRAINT "kick_votes_voter_id_user_id_fk" FOREIGN KEY ("voter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kick_votes" ADD CONSTRAINT "kick_votes_target_id_user_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;