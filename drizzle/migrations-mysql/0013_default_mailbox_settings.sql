ALTER TABLE `app_settings` ADD `default_mailbox_enabled` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `default_mailbox_local_part` varchar(255) DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `default_mailbox_forward_to` longtext;
