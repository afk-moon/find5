CREATE TABLE "auto_posts" (
	"group_id" text NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auto_posts_group_id_key_pk" PRIMARY KEY("group_id","key")
);
--> statement-breakpoint
ALTER TABLE "auto_posts" ADD CONSTRAINT "auto_posts_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;