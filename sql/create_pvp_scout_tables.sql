-- Stores scout source messages, catch-up checkpoints and staff review history.
CREATE TABLE IF NOT EXISTS `pvp_scout_messages` (
  `message_id` varchar(32) NOT NULL,
  `channel_id` varchar(32) NOT NULL,
  `server` enum('gold','silver') NOT NULL DEFAULT 'gold',
  `guild_id` varchar(32) DEFAULT NULL,
  `author_id` varchar(32) DEFAULT NULL,
  `author_username` varchar(128) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL,
  `edited_at` datetime(3) DEFAULT NULL,
  `message_content` longtext NOT NULL,
  `source_url` varchar(512) NOT NULL,
  `reply_to_id` varchar(32) DEFAULT NULL,
  `attachments_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`attachments_json`)),
  `ocr_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`ocr_json`)),
  `classification` enum('scout','review','ignored') NOT NULL DEFAULT 'ignored',
  `opponent_ign` varchar(64) DEFAULT NULL,
  `ign_normalized` varchar(64) DEFAULT NULL,
  `ign_confidence` decimal(5,4) NOT NULL DEFAULT 0.0000,
  `ign_source` varchar(32) DEFAULT NULL,
  `rating` smallint unsigned DEFAULT NULL,
  `team_text` longtext DEFAULT NULL,
  `notes` longtext DEFAULT NULL,
  `staff_overrides_json` longtext DEFAULT NULL,
  `root_message_id` varchar(32) DEFAULT NULL,
  `review_status` enum('not_required','pending','confirmed','corrected','not_scout') NOT NULL DEFAULT 'not_required',
  `review_reason` text DEFAULT NULL,
  `reviewed_by_id` varchar(32) DEFAULT NULL,
  `reviewed_at` datetime(3) DEFAULT NULL,
  `team_layout_status` enum('none','recognized','uncertain') NOT NULL DEFAULT 'none',
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `content_hash` char(64) NOT NULL,
  `created_record_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`message_id`),
  KEY `idx_pvp_scout_ign` (`channel_id`,`ign_normalized`,`is_deleted`),
  KEY `idx_pvp_scout_root` (`channel_id`,`root_message_id`,`message_id`),
  KEY `idx_pvp_scout_review` (`channel_id`,`review_status`,`is_deleted`,`message_id`),
  KEY `idx_pvp_scout_author` (`channel_id`,`author_id`,`message_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Only advances after history through this message has been successfully archived.
CREATE TABLE IF NOT EXISTS `pvp_scout_catchup` (
  `channel_id` varchar(32) NOT NULL,
  `last_message_id` varchar(32) NOT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`channel_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Public parsing reactions and correction replies, retained across bot restarts.
CREATE TABLE IF NOT EXISTS `pvp_scout_message_feedback` (
  `message_id` varchar(32) NOT NULL,
  `channel_id` varchar(32) NOT NULL,
  `reaction` varchar(8) NOT NULL,
  `feedback_message_id` varchar(32) DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`message_id`),
  KEY `idx_scout_feedback_channel` (`channel_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Pending multipart feedback, resumed after restarts and removed once delivered.
CREATE TABLE IF NOT EXISTS `pvp_scout_feedback_pending` (
  `channel_id` varchar(32) NOT NULL,
  `root_message_id` varchar(32) NOT NULL,
  `author_id` varchar(32) NOT NULL,
  `latest_message_id` varchar(32) NOT NULL,
  `due_at_ms` bigint unsigned NOT NULL,
  `revision` int unsigned NOT NULL DEFAULT 1,
  `publication_notified` tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`channel_id`,`root_message_id`,`author_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Immutable officer decisions with the parser output before and after review.
CREATE TABLE IF NOT EXISTS `pvp_scout_review_events` (
  `event_id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `message_id` varchar(32) NOT NULL,
  `channel_id` varchar(32) NOT NULL,
  `action` enum('confirmed','corrected','not_scout') NOT NULL,
  `reviewer_id` varchar(32) NOT NULL,
  `before_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`before_json`)),
  `after_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`after_json`)),
  `changes_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`changes_json`)),
  `created_at` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  PRIMARY KEY (`event_id`),
  KEY `idx_scout_review_event_message` (`message_id`,`event_id`),
  KEY `idx_scout_review_event_channel` (`channel_id`,`event_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Idempotent notification for a newly queued review.
CREATE TABLE IF NOT EXISTS `pvp_scout_review_alerts` (
  `message_id` varchar(32) NOT NULL,
  `channel_id` varchar(32) NOT NULL,
  `alert_message_id` varchar(32) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  PRIMARY KEY (`message_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Proposed edits are held aside until an officer accepts them.
CREATE TABLE IF NOT EXISTS `pvp_scout_edit_reviews` (
  `message_id` varchar(32) NOT NULL,
  `channel_id` varchar(32) NOT NULL,
  `before_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`before_json`)),
  `after_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`after_json`)),
  `proposed_hash` char(64) NOT NULL,
  `status` enum('pending','accepted','rejected','expired','cancelled') NOT NULL DEFAULT 'pending',
  `revision` int unsigned NOT NULL DEFAULT 1,
  `alerted_revision` int unsigned NOT NULL DEFAULT 0,
  `requested_by_id` varchar(32) DEFAULT NULL,
  `requested_by_username` varchar(128) DEFAULT NULL,
  `requested_at` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  `reviewed_by_id` varchar(32) DEFAULT NULL,
  `reviewed_at` datetime(3) DEFAULT NULL,
  `alert_message_id` varchar(32) DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`message_id`,`channel_id`),
  KEY `idx_scout_edit_queue` (`channel_id`,`status`,`message_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Admin-maintained friend warnings and shared guild profiles/settings.
CREATE TABLE IF NOT EXISTS `pvp_scout_friendly_list` (
  `entry_id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `guild_id` varchar(32) NOT NULL,
  `ign` varchar(64) NOT NULL,
  `ign_normalized` varchar(64) NOT NULL,
  `discord_id` varchar(32) DEFAULT NULL,
  `username` varchar(128) DEFAULT NULL,
  `server_nickname` varchar(128) DEFAULT NULL,
  `server_nickname_normalized` varchar(64) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`entry_id`),
  UNIQUE KEY `uq_scout_friendly_ign` (`guild_id`,`ign_normalized`),
  KEY `idx_scout_friendly_discord` (`guild_id`,`discord_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `guild_members` (
  `guild_id` varchar(32) NOT NULL,
  `discord_id` varchar(32) NOT NULL,
  `username` varchar(128) NOT NULL,
  `global_name` varchar(128) DEFAULT NULL,
  `server_nickname` varchar(128) DEFAULT NULL,
  `server_nickname_normalized` varchar(64) DEFAULT NULL,
  `status` enum('current','former','other') NOT NULL DEFAULT 'current',
  `selected_server` enum('gold','silver','cross') DEFAULT NULL,
  `first_seen_at` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  `role_added_at` datetime(3) DEFAULT NULL,
  `former_at` datetime(3) DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`guild_id`,`discord_id`),
  KEY `idx_scout_member_status` (`guild_id`,`status`,`username`),
  KEY `idx_scout_member_nickname` (`guild_id`,`server_nickname_normalized`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pvp_scout_member_seed` (
  `guild_id` varchar(32) NOT NULL,
  `seeded_at` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  PRIMARY KEY (`guild_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Author Scout Message correction window.
CREATE TABLE IF NOT EXISTS `pvp_scout_correction_windows` (
  `message_id` varchar(32) NOT NULL,
  `channel_id` varchar(32) NOT NULL,
  `started_at_ms` bigint unsigned DEFAULT NULL,
  `due_at_ms` bigint unsigned DEFAULT NULL,
  `status` enum('waiting','escalated','resolved') NOT NULL DEFAULT 'waiting',
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`message_id`,`channel_id`),
  KEY `idx_scout_correction_due` (`channel_id`,`status`,`due_at_ms`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Member-deleted scout messages awaiting an officer decision (keep, repost or remove).
CREATE TABLE IF NOT EXISTS `pvp_scout_deletions` (
  `message_id` varchar(32) NOT NULL,
  `channel_id` varchar(32) NOT NULL,
  `report_id` varchar(32) NOT NULL,
  `previous_status` enum('not_required','pending','confirmed','corrected','not_scout') NOT NULL,
  `restore_status` enum('not_required','pending','confirmed','corrected','not_scout') NOT NULL,
  `deleted_by_id` varchar(32) DEFAULT NULL,
  `status` enum('pending','kept','reposted','removed') NOT NULL DEFAULT 'pending',
  `alert_channel_id` varchar(32) DEFAULT NULL,
  `alert_message_id` varchar(32) DEFAULT NULL,
  `images_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (`images_json` IS NULL OR json_valid(`images_json`)),
  `repost_message_id` varchar(32) DEFAULT NULL,
  `decided_by_id` varchar(32) DEFAULT NULL,
  `decided_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`message_id`,`channel_id`),
  KEY `idx_scout_deletion_status` (`channel_id`,`status`,`alert_message_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
