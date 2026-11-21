ALTER TABLE `app_settings` ADD `drive_default_quota_bytes` integer DEFAULT 5368709120 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `drive_quota_bytes` integer;--> statement-breakpoint
UPDATE `app_settings` SET `drive_default_quota_bytes` = `drive_storage_limit_bytes` WHERE `drive_storage_limit_bytes` IS NOT NULL AND `drive_storage_limit_bytes` > 0;
