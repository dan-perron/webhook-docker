CREATE TABLE `follows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sport` text NOT NULL,
	`team_name` text NOT NULL,
	`alerts` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `follows_team_idx` ON `follows` (`sport`,`team_name`);--> statement-breakpoint
CREATE TABLE `score_alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	`delivery` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `score_alerts_key_idx` ON `score_alerts` (`event_id`,`key`);--> statement-breakpoint
CREATE INDEX `score_alerts_created_idx` ON `score_alerts` (`created_at`);--> statement-breakpoint
CREATE TABLE `watches` (
	`event_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`follow_id` integer,
	`alerts` integer DEFAULT true NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`last_leader` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`follow_id`) REFERENCES `follows`(`id`) ON UPDATE no action ON DELETE set null
);
