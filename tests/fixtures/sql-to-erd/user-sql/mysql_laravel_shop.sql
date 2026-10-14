-- Laravel-style MySQL migration output with framework tables and pivot relations.
CREATE TABLE `migrations` (
    `id` int unsigned NOT NULL AUTO_INCREMENT,
    `migration` varchar(255) NOT NULL,
    `batch` int NOT NULL,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `users` (
    `id` bigint unsigned NOT NULL AUTO_INCREMENT,
    `name` varchar(255) NOT NULL,
    `email` varchar(255) NOT NULL,
    `email_verified_at` timestamp NULL DEFAULT NULL,
    `role` enum('customer','seller','admin') NOT NULL DEFAULT 'customer',
    `password` varchar(255) NOT NULL,
    `remember_token` varchar(100) DEFAULT NULL,
    `created_at` timestamp NULL DEFAULT NULL,
    `updated_at` timestamp NULL DEFAULT NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `users_email_unique` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `products` (
    `id` bigint unsigned NOT NULL AUTO_INCREMENT,
    `seller_id` bigint unsigned NOT NULL,
    `sku` varchar(80) NOT NULL,
    `title` varchar(255) NOT NULL,
    `status` enum('draft','active','archived') NOT NULL DEFAULT 'draft',
    `price_cents` int NOT NULL DEFAULT 0,
    `created_at` timestamp NULL DEFAULT NULL,
    `updated_at` timestamp NULL DEFAULT NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `products_seller_sku_unique` (`seller_id`, `sku`),
    KEY `products_status_created_index` (`status`, `created_at`),
    CONSTRAINT `products_seller_id_foreign`
        FOREIGN KEY (`seller_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `carts` (
    `id` bigint unsigned NOT NULL AUTO_INCREMENT,
    `user_id` bigint unsigned NOT NULL,
    `state` enum('open','converted','abandoned') NOT NULL DEFAULT 'open',
    `created_at` timestamp NULL DEFAULT NULL,
    PRIMARY KEY (`id`),
    KEY `carts_user_state_index` (`user_id`, `state`),
    CONSTRAINT `carts_user_id_foreign`
        FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `cart_items` (
    `cart_id` bigint unsigned NOT NULL,
    `product_id` bigint unsigned NOT NULL,
    `quantity` int NOT NULL DEFAULT 1,
    `unit_cents` int NOT NULL,
    PRIMARY KEY (`cart_id`, `product_id`),
    KEY `cart_items_product_id_foreign` (`product_id`),
    CONSTRAINT `cart_items_cart_id_foreign`
        FOREIGN KEY (`cart_id`) REFERENCES `carts` (`id`) ON DELETE CASCADE,
    CONSTRAINT `cart_items_product_id_foreign`
        FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
