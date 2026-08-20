CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`report_id` integer NOT NULL,
	`kind` text NOT NULL,
	`detail` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`read_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`discord_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notifications_unread` ON `notifications` (`user_id`,`read_at`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`source_id` text,
	`proposed_name` text,
	`proposed_url` text,
	`lang` text NOT NULL,
	`nsfw` integer DEFAULT false NOT NULL,
	`stage` text,
	`cause` text,
	`title` text NOT NULL,
	`body` text,
	`status` text DEFAULT 'open' NOT NULL,
	`reporter_id` text NOT NULL,
	`ext_version` text,
	`github_issue` integer,
	`duplicate_of` integer,
	`votes` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`status_changed_at` integer,
	FOREIGN KEY (`reporter_id`) REFERENCES `users`(`discord_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reports_open_per_source_kind` ON `reports` (`source_id`,`kind`) WHERE status IN ('open', 'confirmed', 'in_progress') AND source_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `reports_open_per_proposed_url` ON `reports` (`proposed_url`) WHERE status IN ('open', 'confirmed', 'in_progress') AND proposed_url IS NOT NULL;--> statement-breakpoint
CREATE INDEX `reports_board` ON `reports` (`kind`,`status`,`votes`);--> statement-breakpoint
CREATE INDEX `reports_by_source` ON `reports` (`source_id`);--> statement-breakpoint
CREATE INDEX `reports_by_reporter` ON `reports` (`reporter_id`);--> statement-breakpoint
CREATE INDEX `reports_by_age` ON `reports` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `reports_by_issue` ON `reports` (`github_issue`);--> statement-breakpoint
CREATE TABLE `users` (
	`discord_id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`avatar_hash` text,
	`account_created_at` integer NOT NULL,
	`guild_joined_at` integer,
	`is_maintainer` integer DEFAULT false NOT NULL,
	`first_seen` integer DEFAULT (unixepoch()) NOT NULL,
	`last_login` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `votes` (
	`report_id` integer NOT NULL,
	`discord_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`report_id`, `discord_id`),
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`discord_id`) REFERENCES `users`(`discord_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `votes_by_user` ON `votes` (`discord_id`);