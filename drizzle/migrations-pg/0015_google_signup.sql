ALTER TABLE "users" ADD COLUMN "google_sub" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "google_email" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_google_sub_idx" ON "users" ("google_sub");
