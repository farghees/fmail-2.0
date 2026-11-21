ALTER TABLE "app_settings" ADD COLUMN "default_mailbox_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "default_mailbox_local_part" text DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "default_mailbox_forward_to" text;
