-- Android Room export: metadata tables, IF NOT EXISTS, composite PKs, and FK cascades.
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS `room_master_table` (
    `id` INTEGER PRIMARY KEY,
    `identity_hash` TEXT
);

CREATE TABLE IF NOT EXISTS `channels` (
    `channel_id` TEXT NOT NULL,
    `workspace_id` TEXT NOT NULL,
    `name` TEXT NOT NULL,
    `is_archived` INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (`channel_id`)
);

CREATE TABLE IF NOT EXISTS `messages` (
    `message_id` TEXT NOT NULL,
    `channel_id` TEXT NOT NULL,
    `sender_id` TEXT NOT NULL,
    `body` TEXT NOT NULL,
    `sent_at` INTEGER NOT NULL,
    PRIMARY KEY (`message_id`),
    FOREIGN KEY (`channel_id`) REFERENCES `channels`(`channel_id`) ON UPDATE NO ACTION ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS `message_reactions` (
    `message_id` TEXT NOT NULL,
    `user_id` TEXT NOT NULL,
    `emoji` TEXT NOT NULL,
    `created_at` INTEGER NOT NULL,
    PRIMARY KEY (`message_id`, `user_id`, `emoji`),
    FOREIGN KEY (`message_id`) REFERENCES `messages`(`message_id`) ON UPDATE NO ACTION ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS `index_channels_workspace_id_name` ON `channels` (`workspace_id`, `name`);
CREATE INDEX IF NOT EXISTS `index_messages_channel_sent` ON `messages` (`channel_id`, `sent_at`);
CREATE INDEX IF NOT EXISTS `index_reactions_user_emoji` ON `message_reactions` (`user_id`, `emoji`);
PRAGMA user_version=14;
