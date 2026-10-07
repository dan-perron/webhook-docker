CREATE TABLE `event_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`source` text NOT NULL,
	`fetched_at` text NOT NULL,
	`lines_json` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `event_lines_event_idx` ON `event_lines` (`event_id`,`fetched_at`);--> statement-breakpoint
ALTER TABLE `legs` ADD `placement_json` text;--> statement-breakpoint
-- Backfill: the lines each event already holds become its first history rows.
INSERT INTO `event_lines` (`event_id`, `source`, `fetched_at`, `lines_json`)
SELECT `id`, 'espn', COALESCE(`provider_lines_at`, `created_at`), `provider_lines_json`
FROM `events` WHERE `provider_lines_json` IS NOT NULL;
--> statement-breakpoint
INSERT INTO `event_lines` (`event_id`, `source`, `fetched_at`, `lines_json`)
SELECT `id`, 'snapshot', COALESCE(`pregame_odds_at`, `created_at`), `pregame_odds_json`
FROM `events` WHERE `pregame_odds_json` IS NOT NULL;
