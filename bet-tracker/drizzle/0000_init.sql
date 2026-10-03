CREATE TABLE `bets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book` text NOT NULL,
	`external_bet_id` text,
	`placed_at` text,
	`placed_live` integer DEFAULT false NOT NULL,
	`stake_cents` integer NOT NULL,
	`bet_type` text NOT NULL,
	`price_american` integer NOT NULL,
	`boost_pct` real,
	`boost_kind` text,
	`boosted_price_american` integer,
	`stated_payout_cents` integer,
	`token_info` text,
	`notes` text,
	`status` text DEFAULT 'open' NOT NULL,
	`settled_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`sport` text NOT NULL,
	`provider` text NOT NULL,
	`provider_event_id` text NOT NULL,
	`league` text,
	`start_time` text NOT NULL,
	`home_name` text NOT NULL,
	`away_name` text NOT NULL,
	`home_abbr` text,
	`away_abbr` text,
	`status` text DEFAULT 'pre' NOT NULL,
	`state_json` text,
	`state_updated_at` text,
	`next_poll_at` text,
	`pregame_odds_json` text,
	`pregame_odds_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_status_idx` ON `events` (`status`);--> statement-breakpoint
CREATE TABLE `legs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bet_id` integer NOT NULL,
	`leg_index` integer NOT NULL,
	`sport` text NOT NULL,
	`event_date` text NOT NULL,
	`event_label` text NOT NULL,
	`participant_a` text NOT NULL,
	`participant_b` text NOT NULL,
	`event_id` text,
	`match_status` text DEFAULT 'unmatched' NOT NULL,
	`match_candidates_json` text,
	`market` text NOT NULL,
	`selection_kind` text NOT NULL,
	`selection_team` text,
	`side` text,
	`line` real,
	`price_american` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`prior_source` text,
	`prior_json` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`bet_id`) REFERENCES `bets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `legs_bet_idx` ON `legs` (`bet_id`);--> statement-breakpoint
CREATE INDEX `legs_event_idx` ON `legs` (`event_id`);--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `prediction_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bet_id` integer NOT NULL,
	`leg_id` integer,
	`sport` text NOT NULL,
	`market` text NOT NULL,
	`taken_at` text NOT NULL,
	`game_status` text NOT NULL,
	`fraction_remaining` real,
	`probability` real NOT NULL,
	`outcome` integer,
	FOREIGN KEY (`bet_id`) REFERENCES `bets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`leg_id`) REFERENCES `legs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `snapshots_bet_idx` ON `prediction_snapshots` (`bet_id`);--> statement-breakpoint
CREATE INDEX `snapshots_leg_idx` ON `prediction_snapshots` (`leg_id`);