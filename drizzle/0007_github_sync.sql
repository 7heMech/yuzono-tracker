CREATE TABLE `github_issues` (
	`number` integer PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`state_reason` text,
	`updated_at` integer,
	`labels` text,
	`reactions` integer DEFAULT 0 NOT NULL,
	`report_id` integer,
	`seen_at` integer DEFAULT (unixepoch()) NOT NULL,
	`dismissed_at` integer,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `github_issues_unmatched` ON `github_issues` (`report_id`,`dismissed_at`);--> statement-breakpoint
DROP INDEX `reports_by_issue`;--> statement-breakpoint
ALTER TABLE `reports` ADD `promoted_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `reports_by_issue` ON `reports` (`github_issue`) WHERE github_issue IS NOT NULL;