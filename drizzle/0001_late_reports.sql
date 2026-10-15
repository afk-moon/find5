CREATE TABLE "late_reports" (
	"session_id" text NOT NULL,
	"reporter_id" text NOT NULL,
	"late_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "late_reports_session_id_reporter_id_late_user_id_pk" PRIMARY KEY("session_id","reporter_id","late_user_id")
);
--> statement-breakpoint
ALTER TABLE "late_reports" ADD CONSTRAINT "late_reports_session_id_play_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."play_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "late_reports" ADD CONSTRAINT "late_reports_reporter_id_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "late_reports" ADD CONSTRAINT "late_reports_late_user_id_user_id_fk" FOREIGN KEY ("late_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;