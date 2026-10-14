-- WordPress-style dump: lots of indexes, no declared FKs, and plugin-owned tables.
CREATE TABLE `wp_users` (
    `ID` bigint unsigned NOT NULL AUTO_INCREMENT,
    `user_login` varchar(60) NOT NULL DEFAULT '',
    `user_pass` varchar(255) NOT NULL DEFAULT '',
    `user_nicename` varchar(50) NOT NULL DEFAULT '',
    `user_email` varchar(100) NOT NULL DEFAULT '',
    `user_status` int NOT NULL DEFAULT 0,
    `display_name` varchar(250) NOT NULL DEFAULT '',
    PRIMARY KEY (`ID`),
    KEY `user_login_key` (`user_login`),
    KEY `user_email` (`user_email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `wp_posts` (
    `ID` bigint unsigned NOT NULL AUTO_INCREMENT,
    `post_author` bigint unsigned NOT NULL DEFAULT 0,
    `post_date` datetime NOT NULL DEFAULT '0000-00-00 00:00:00',
    `post_content` longtext NOT NULL,
    `post_title` text NOT NULL,
    `post_status` varchar(20) NOT NULL DEFAULT 'publish',
    `post_name` varchar(200) NOT NULL DEFAULT '',
    `post_parent` bigint unsigned NOT NULL DEFAULT 0,
    `post_type` varchar(20) NOT NULL DEFAULT 'post',
    PRIMARY KEY (`ID`),
    KEY `post_name` (`post_name`),
    KEY `type_status_date` (`post_type`, `post_status`, `post_date`, `ID`),
    KEY `post_author` (`post_author`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `wp_postmeta` (
    `meta_id` bigint unsigned NOT NULL AUTO_INCREMENT,
    `post_id` bigint unsigned NOT NULL DEFAULT 0,
    `meta_key` varchar(255) DEFAULT NULL,
    `meta_value` longtext,
    PRIMARY KEY (`meta_id`),
    KEY `post_id` (`post_id`),
    KEY `meta_key` (`meta_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `wp_acme_events` (
    `id` bigint unsigned NOT NULL AUTO_INCREMENT,
    `user_id` bigint unsigned NOT NULL,
    `post_id` bigint unsigned NOT NULL,
    `event_type` enum('view','share','purchase') NOT NULL DEFAULT 'view',
    `event_payload` json DEFAULT NULL,
    `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `acme_user_post_event` (`user_id`, `post_id`, `event_type`),
    KEY `acme_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
