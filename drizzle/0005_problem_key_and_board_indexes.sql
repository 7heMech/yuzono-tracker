DROP INDEX `reports_open_per_source_kind`;--> statement-breakpoint
DROP INDEX `reports_board`;--> statement-breakpoint
ALTER TABLE `reports` ADD `problem` text;--> statement-breakpoint
ALTER TABLE `reports` ADD `fix_announced_at` integer;--> statement-breakpoint
-- Backfill the dedupe key for the 468 imported rows. They carry `stage` and
-- `cause` but no problem key, and that pair determines the problem exactly:
-- the taxonomy on /new was built from these labels in the first place.
--
-- No row can collide here. The index this replaces was unique on
-- (source_id, kind) for open rows, so there was at most one open report per
-- source per kind to begin with, and the new key only adds a column.
UPDATE `reports` SET `problem` = 'moved' WHERE `kind` = 'domain';--> statement-breakpoint
UPDATE `reports` SET `problem` = 'gone' WHERE `kind` = 'dead';--> statement-breakpoint
UPDATE `reports` SET `problem` = CASE
  WHEN `stage` = 'video' THEN 'no-video'
  WHEN `stage` = 'episodes' THEN 'no-episodes'
  WHEN `stage` = 'browse' AND `cause` IN ('cloudflare', 'geo') THEN 'blocked'
  WHEN `stage` = 'browse' THEN 'no-browse'
  ELSE 'other'
END WHERE `kind` = 'bug';--> statement-breakpoint
-- Anything else that hangs off a real source keeps the old one-per-source-kind
-- behaviour rather than escaping dedupe on a NULL.
UPDATE `reports` SET `problem` = 'other' WHERE `problem` IS NULL AND `source_id` IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `reports_open_per_source_problem` ON `reports` (`source_id`,`kind`,`problem`) WHERE status IN ('open', 'confirmed', 'in_progress') AND source_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `reports_tallies` ON `reports` (`status`,`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `reports_board` ON `reports` (`status`,`nsfw`,"votes" desc,`created_at`,`kind`);--> statement-breakpoint
ALTER TABLE `users` ADD `banned` integer DEFAULT false NOT NULL;