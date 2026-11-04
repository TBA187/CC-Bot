-- Defines auction records, subscriptions, pending deliveries, and recovery control tables.
CREATE TABLE IF NOT EXISTS forum_auction_control (
    entry_id VARCHAR(36) NOT NULL PRIMARY KEY,
    revision BIGINT UNSIGNED NOT NULL,
    operation_hash CHAR(64) NULL,
    details LONGTEXT NULL,
    INDEX (revision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS forum_auctions (
    auction_id VARCHAR(20) NOT NULL,
    message_id VARCHAR(32) NOT NULL,
    message_missing TINYINT NULL,
    details LONGTEXT NOT NULL,
    follow_details LONGTEXT NULL,
    PRIMARY KEY (auction_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS forum_auction_subscriptions (
    auction_id VARCHAR(20) NOT NULL,
    user_id VARCHAR(20) NOT NULL,
    followed_at VARCHAR(32) NOT NULL,
    PRIMARY KEY (auction_id, user_id),
    INDEX (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS forum_auction_outbox (
    kind VARCHAR(20) NOT NULL,
    auction_id VARCHAR(20) NOT NULL,
    bid_key CHAR(64) NOT NULL,
    details LONGTEXT NOT NULL,
    recipients LONGTEXT NULL,
    PRIMARY KEY (kind, auction_id, bid_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
