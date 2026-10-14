-- TypeORM MySQL migration output with UUID strings, metadata noise, generated columns, and FK names.
CREATE TABLE `tenant` (
    `id` varchar(36) NOT NULL,
    `slug` varchar(80) NOT NULL,
    `billingState` enum('trial','active','past_due') NOT NULL DEFAULT 'trial',
    `createdAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (`id`),
    UNIQUE KEY `IDX_tenant_slug` (`slug`)
) ENGINE=InnoDB;

CREATE TABLE `user` (
    `id` varchar(36) NOT NULL,
    `tenantId` varchar(36) NOT NULL,
    `email` varchar(320) NOT NULL,
    `role` enum('owner','admin','member') NOT NULL DEFAULT 'member',
    `emailKey` varchar(320) GENERATED ALWAYS AS (lower(`email`)) VIRTUAL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `IDX_user_tenant_email` (`tenantId`, `email`),
    CONSTRAINT `FK_user_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenant`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE `photo` (
    `id` varchar(36) NOT NULL,
    `userId` varchar(36) NOT NULL,
    `url` varchar(2048) NOT NULL,
    `visibility` enum('private','team','public') NOT NULL DEFAULT 'private',
    `sortOrder` int NOT NULL DEFAULT 0,
    PRIMARY KEY (`id`),
    KEY `IDX_photo_user_sort` (`userId`, `sortOrder`),
    CONSTRAINT `FK_photo_user` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE `typeorm_metadata` (
    `type` varchar(255) NOT NULL,
    `database` varchar(255) DEFAULT NULL,
    `schema` varchar(255) DEFAULT NULL,
    `table` varchar(255) DEFAULT NULL,
    `name` varchar(255) DEFAULT NULL,
    `value` text
) ENGINE=InnoDB;
