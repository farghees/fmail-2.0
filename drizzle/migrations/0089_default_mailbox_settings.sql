ALTER TABLE `app_settings` ADD `default_mailbox_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `default_mailbox_local_part` text DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `default_mailbox_forward_to` text;
