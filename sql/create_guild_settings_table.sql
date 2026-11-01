CREATE TABLE IF NOT EXISTS `guild_settings` (
  `guild_id` varchar(32) NOT NULL,
  `guild_name` varchar(100) DEFAULT NULL,
  `xp_enabled` tinyint(1) NOT NULL DEFAULT 0,
  `xp_date_enabled` timestamp NULL DEFAULT NULL,
  `logging_enabled` tinyint(1) NOT NULL DEFAULT 0,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`guild_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `guild_settings`
  (`guild_id`, `guild_name`, `xp_enabled`, `xp_date_enabled`, `logging_enabled`, `updated_at`)
VALUES
  ('1148499020038295582', 'Crow Control', 1, '2026-05-11 04:56:00', 1, '2026-06-05 02:12:20')
ON DUPLICATE KEY UPDATE
  `guild_name` = VALUES(`guild_name`),
  `xp_enabled` = VALUES(`xp_enabled`),
  `xp_date_enabled` = VALUES(`xp_date_enabled`),
  `logging_enabled` = VALUES(`logging_enabled`);
