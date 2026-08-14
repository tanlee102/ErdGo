export const sampleSchemaSQL = `
-- ERD Go compact commerce sample
-- Five tables demonstrate relationships, constraints, generated columns,
-- migrations, and index badges without crowding the canvas.

CREATE TYPE order_status AS ENUM ('cart', 'paid', 'shipped', 'cancelled');

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  role ENUM('admin', 'member') NOT NULL DEFAULT 'member',
  flags SET('newsletter', 'beta') DEFAULT 'newsletter',
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (email LIKE '%@%')
) STRICT;

-- Migration replay: add and rename columns after table creation.
ALTER TABLE users ADD COLUMN last_seen_at TEXT DEFAULT 'never';
ALTER TABLE users RENAME COLUMN display_name TO full_name;

-- Self-reference: a category can belong to another category.
CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  sku TEXT NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  price NUMERIC NOT NULL CHECK (price >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  search_label TEXT GENERATED ALWAYS AS (CONCAT(sku, ' - ', name)) STORED
) STRICT;

-- Migration replay also supports adding and dropping a column.
ALTER TABLE products ADD COLUMN retired_at TEXT;
ALTER TABLE products DROP COLUMN retired_at;

CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status order_status NOT NULL DEFAULT 'cart',
  placed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  total NUMERIC NOT NULL DEFAULT 0 CHECK (total >= 0),
  coupon_code TEXT
) STRICT;

ALTER TABLE orders RENAME COLUMN coupon_code TO promotion_code;

-- Junction table: orders and products form a many-to-many relationship.
CREATE TABLE order_items (
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price NUMERIC NOT NULL CHECK (unit_price >= 0),
  line_total NUMERIC GENERATED ALWAYS AS (quantity * unit_price) STORED,
  PRIMARY KEY (order_id, product_id)
) STRICT, WITHOUT ROWID;

-- IDX, UQ, and PUQ badges are visible on the ERD.
CREATE UNIQUE INDEX ux_users_active_email
  ON users (email)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_users_role ON users (role);
CREATE INDEX idx_products_category_price ON products (category_id, price);
CREATE INDEX idx_orders_customer_status ON orders (customer_id, status);
CREATE INDEX idx_orders_open ON orders (placed_at)
  WHERE status IN ('cart', 'paid');
CREATE INDEX idx_order_items_product ON order_items (product_id);

`;

export const sampleDataSQL = `-- Compact rows for Data View.
INSERT INTO users (id, email, full_name, role, flags, last_seen_at) VALUES
  (1, 'alice@example.com', 'Alice', 'admin', 'newsletter,beta', '2026-06-01'),
  (2, 'bob@example.com', 'Bob', 'member', 'newsletter', 'never');

INSERT INTO categories (id, parent_id, name) VALUES
  (1, NULL, 'Hardware'),
  (2, 1, 'Accessories');

INSERT INTO products (id, category_id, sku, name, price, stock) VALUES
  (1, 2, 'MOUSE-01', 'Wireless Mouse', 29.99, 12),
  (2, 2, 'HUB-01', 'USB-C Hub', 49.99, 8);

INSERT INTO orders (id, customer_id, status, total, promotion_code) VALUES
  (1, 1, 'paid', 79.98, 'WELCOME'),
  (2, 2, 'cancelled', 29.99, NULL);

INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
  (1, 1, 1, 29.99),
  (1, 2, 1, 49.99),
  (2, 1, 1, 29.99);

-- UPDATE expressions and filtered DELETE statements.
UPDATE products SET stock = stock - 1 WHERE id = 1;
UPDATE orders SET status = 'shipped' WHERE id = 1;

DELETE FROM order_items WHERE order_id = 2;
DELETE FROM orders WHERE status = 'cancelled';
`;

// Kept for features that operate on the complete sample script.
export const sampleSQL = sampleSchemaSQL + sampleDataSQL;
