CREATE TABLE `workspaces_acl` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `slug` VARCHAR(90) NOT NULL,
    `plan` ENUM('free', 'team', 'enterprise') NOT NULL DEFAULT 'free',
    `flags` SET('sso', 'audit', 'scim') DEFAULT 'audit',
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_acl_workspace_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `projects_acl` (
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `project_key` VARCHAR(40) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `name_key` VARCHAR(160) GENERATED ALWAYS AS (LOWER(`name`)) STORED,
    `visibility` ENUM('private', 'internal', 'public') NOT NULL DEFAULT 'private',
    PRIMARY KEY (`workspace_id`, `project_key`),
    CONSTRAINT `fk_projects_acl_workspace`
        FOREIGN KEY (`workspace_id`) REFERENCES `workspaces_acl` (`id`) ON DELETE CASCADE,
    KEY `idx_projects_acl_visibility` (`visibility`, `name_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `project_members_acl` (
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `project_key` VARCHAR(40) NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `role` ENUM('owner', 'maintainer', 'viewer') NOT NULL DEFAULT 'viewer',
    `permissions` SET('read', 'write', 'admin') NOT NULL DEFAULT 'read',
    PRIMARY KEY (`workspace_id`, `project_key`, `user_id`),
    CONSTRAINT `fk_members_acl_project`
        FOREIGN KEY (`workspace_id`, `project_key`)
        REFERENCES `projects_acl` (`workspace_id`, `project_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `api_tokens_acl` (
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `token_id` VARCHAR(64) NOT NULL,
    `project_key` VARCHAR(40),
    `label` VARCHAR(120) NOT NULL,
    `label_key` VARCHAR(120) GENERATED ALWAYS AS (LOWER(`label`)) VIRTUAL,
    PRIMARY KEY (`workspace_id`, `token_id`),
    CONSTRAINT `fk_tokens_acl_workspace`
        FOREIGN KEY (`workspace_id`) REFERENCES `workspaces_acl` (`id`),
    CONSTRAINT `fk_tokens_acl_project`
        FOREIGN KEY (`workspace_id`, `project_key`)
        REFERENCES `projects_acl` (`workspace_id`, `project_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX `idx_tokens_acl_label`
    ON `api_tokens_acl` (`label_key`);
