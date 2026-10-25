CREATE TABLE `series` (
	`id` text PRIMARY KEY NOT NULL,
	`sport` text NOT NULL,
	`season` integer NOT NULL,
	`title` text,
	`best_of` integer NOT NULL,
	`home_team_id` text NOT NULL,
	`away_team_id` text NOT NULL,
	`home_name` text NOT NULL,
	`away_name` text NOT NULL,
	`home_abbr` text,
	`away_abbr` text,
	`start_time` text NOT NULL,
	`status` text DEFAULT 'pre' NOT NULL,
	`state_json` text,
	`state_updated_at` text,
	`next_poll_at` text,
	`strength_json` text,
	`strength_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `bets` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `legs` ADD `series_id` text REFERENCES series(id);--> statement-breakpoint
CREATE INDEX `legs_series_idx` ON `legs` (`series_id`);