-- Carry any existing maintainer over as a manual admin grant before the
-- column goes: a boolean cannot express two tiers, but losing someone's
-- rights during a migration is worse than over-granting one person.
UPDATE `users` SET `manual_level` = 'admin' WHERE `is_maintainer` = 1;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `is_maintainer`;