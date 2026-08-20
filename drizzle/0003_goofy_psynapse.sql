CREATE TABLE `audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`action` text NOT NULL,
	`target` text,
	`detail` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_recent` ON `audit` (`created_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
ALTER TABLE `reports` ADD `announced_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `discord_level` text;--> statement-breakpoint
ALTER TABLE `users` ADD `manual_level` text;