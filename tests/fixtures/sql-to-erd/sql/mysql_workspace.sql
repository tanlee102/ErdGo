CREATE TABLE `workspaces` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `slug` VARCHAR(64) NOT NULL,
    `status` ENUM('trial', 'active', 'locked') NOT NULL DEFAULT 'trial',
    `flags` SET('billing', 'sso', 'audit') DEFAULT 'billing',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_workspace_slug` (`slug`),
    KEY `idx_workspace_status_created` (`status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `memberships` (
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `role` ENUM('owner', 'admin', 'member', 'viewer') NOT NULL DEFAULT 'viewer',
    `permissions` SET('read', 'write', 'delete') NOT NULL DEFAULT 'read',
    PRIMARY KEY (`workspace_id`, `user_id`),
    CONSTRAINT `fk_members_workspace`
        FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE `api_keys` (
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `key` VARCHAR(128) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `name_lc` VARCHAR(100) GENERATED ALWAYS AS (LOWER(`name`)) VIRTUAL,
    PRIMARY KEY (`workspace_id`, `key`),
    CONSTRAINT `fk_keys_workspace`
        FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`)
) ENGINE=InnoDB;

CREATE UNIQUE INDEX `uq_members_role`
    ON `memberships` (`workspace_id`, `role`);

CREATE FULLTEXT INDEX `ft_keys_name`
    ON `api_keys` (`name`);
