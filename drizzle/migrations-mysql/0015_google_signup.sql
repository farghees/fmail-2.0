ALTER TABLE `users` ADD `google_sub` varchar(255);--> statement-breakpoint
ALTER TABLE `users` ADD `google_email` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_sub_idx` ON `users` (`google_sub`);
