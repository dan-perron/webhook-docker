-- One-time: placement values for games that haven't started were computed by
-- the pre-fit models (e.g. MLB run lines ~3 points low). Clear them so the
-- tracker recomputes them with the fitted, market-anchored models.
UPDATE `legs` SET `p_win_placement` = NULL, `p_push_placement` = NULL
WHERE `status` = 'open' AND `event_id` IN (SELECT `id` FROM `events` WHERE `status` = 'pre');
--> statement-breakpoint
UPDATE `bets` SET `joint_placement_json` = NULL
WHERE `status` = 'open' AND `id` IN (
  SELECT `bet_id` FROM `legs` WHERE `event_id` IN (SELECT `id` FROM `events` WHERE `status` = 'pre')
);
