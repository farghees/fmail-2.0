ALTER TABLE `users` ADD `google_sub` text;
CREATE UNIQUE INDEX `users_google_sub_idx` ON `users` (`google_sub`);
ALTER TABLE `users` ADD `google_email` text;
