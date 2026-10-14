-- MySQL dump shape with executable comments, locks, inserts, table options, and inline keys.
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
DROP TABLE IF EXISTS `order_lines_dump`;
DROP TABLE IF EXISTS `orders_dump`;
DROP TABLE IF EXISTS `customers_dump`;
LOCK TABLES `customers_dump` WRITE;

CREATE TABLE IF NOT EXISTS `customers_dump` (
    `id` bigint unsigned NOT NULL AUTO_INCREMENT,
    `email` varchar(320) NOT NULL,
    `state` enum('lead','active','blocked') NOT NULL DEFAULT 'lead',
    `flags` set('vip','tax_exempt','newsletter') DEFAULT 'newsletter',
    `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_customers_dump_email` (`email`),
    KEY `idx_customers_dump_state_created` (`state`, `created_at`)
) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `orders_dump` (
    `id` bigint unsigned NOT NULL AUTO_INCREMENT,
    `customer_id` bigint unsigned NOT NULL,
    `external_ref` varchar(64) NOT NULL,
    `status` enum('draft','paid','shipped','refunded') NOT NULL DEFAULT 'draft',
    `total_cents` int NOT NULL DEFAULT 0,
    `placed_at` datetime DEFAULT NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_orders_dump_external` (`external_ref`),
    KEY `idx_orders_dump_customer_status` (`customer_id`, `status`),
    CONSTRAINT `fk_orders_dump_customer`
        FOREIGN KEY (`customer_id`) REFERENCES `customers_dump` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `order_lines_dump` (
    `order_id` bigint unsigned NOT NULL,
    `line_no` int NOT NULL,
    `sku` varchar(80) NOT NULL,
    `qty` int NOT NULL DEFAULT 1,
    `unit_cents` int NOT NULL,
    `line_cents` int GENERATED ALWAYS AS (`qty` * `unit_cents`) STORED,
    PRIMARY KEY (`order_id`, `line_no`),
    KEY `idx_order_lines_dump_sku_qty` (`sku`, `qty`),
    CONSTRAINT `fk_lines_dump_order`
        FOREIGN KEY (`order_id`) REFERENCES `orders_dump` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

INSERT INTO `customers_dump` (`id`, `email`, `state`) VALUES (1, 'demo@example.test', 'active');
UNLOCK TABLES;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
