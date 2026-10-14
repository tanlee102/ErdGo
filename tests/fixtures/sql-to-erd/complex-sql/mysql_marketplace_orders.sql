CREATE TABLE `shops` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `slug` VARCHAR(80) NOT NULL,
    `status` ENUM('draft', 'open', 'closed') NOT NULL DEFAULT 'draft',
    `features` SET('pickup', 'delivery', 'international') DEFAULT 'pickup',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_shops_slug` (`slug`),
    KEY `idx_shops_status_created` (`status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `products` (
    `shop_id` BIGINT UNSIGNED NOT NULL,
    `sku` VARCHAR(64) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `search_blob` TEXT,
    `price` DECIMAL(12, 2) NOT NULL,
    `tax_rate` DECIMAL(5, 4) NOT NULL DEFAULT 0.0000,
    `gross_price` DECIMAL(12, 2)
        GENERATED ALWAYS AS (`price` + (`price` * `tax_rate`)) STORED,
    `active` TINYINT NOT NULL DEFAULT 1,
    PRIMARY KEY (`shop_id`, `sku`),
    CONSTRAINT `fk_products_shop`
        FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE CASCADE,
    FULLTEXT KEY `ft_products_search` (`search_blob`),
    KEY `idx_products_active_price` (`active`, `price`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `orders` (
    `shop_id` BIGINT UNSIGNED NOT NULL,
    `order_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `buyer_email` VARCHAR(320) NOT NULL,
    `state` ENUM('cart', 'paid', 'fulfilled', 'cancelled') NOT NULL DEFAULT 'cart',
    PRIMARY KEY (`shop_id`, `order_id`),
    CONSTRAINT `fk_orders_shop`
        FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `order_items` (
    `shop_id` BIGINT UNSIGNED NOT NULL,
    `order_id` BIGINT UNSIGNED NOT NULL,
    `line_no` INT NOT NULL,
    `sku` VARCHAR(64) NOT NULL,
    `qty` INT NOT NULL,
    `unit_price` DECIMAL(12, 2) NOT NULL,
    `line_total` DECIMAL(12, 2)
        GENERATED ALWAYS AS (`qty` * `unit_price`) VIRTUAL,
    PRIMARY KEY (`shop_id`, `order_id`, `line_no`),
    CONSTRAINT `fk_items_order`
        FOREIGN KEY (`shop_id`, `order_id`) REFERENCES `orders` (`shop_id`, `order_id`),
    CONSTRAINT `fk_items_product`
        FOREIGN KEY (`shop_id`, `sku`) REFERENCES `products` (`shop_id`, `sku`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX `idx_items_sku_qty`
    ON `order_items` (`sku`, `qty`);
