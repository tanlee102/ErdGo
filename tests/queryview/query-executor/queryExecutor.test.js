/** Defines the primary public contract for in-browser read-only query execution. */
import { describe, expect, it } from 'vitest';
import { createSqlExecutor } from '@/features/data-view/lib/sqlExecutor.js';
import { executeSelectQuery } from '@/features/query-view/lib/queryExecutor.js';

function buildTables(sql) {
    const executor = createSqlExecutor();
    return executor.execute(sql).tables;
}

function runQuery(schemaSql, query) {
    return executeSelectQuery({ tables: buildTables(schemaSql), query });
}

describe('queryExecutor', () => {
    const shopSql = `
        CREATE TABLE users (
            id INT PRIMARY KEY,
            name TEXT,
            active BOOLEAN,
            tier TEXT
        );

        CREATE TABLE orders (
            id INT PRIMARY KEY,
            user_id INT,
            total NUMERIC,
            status TEXT
        );

        INSERT INTO users (id, name, active, tier) VALUES
            (1, 'Alice', TRUE, 'pro'),
            (2, 'Bob', FALSE, 'free'),
            (3, 'Charlie', TRUE, 'pro');

        INSERT INTO orders (id, user_id, total, status) VALUES
            (10, 1, 99.5, 'paid'),
            (11, 1, 25, 'pending'),
            (12, 3, 125, 'paid');
    `;

    it('selects explicit columns with where, order, and limit', () => {
        const result = runQuery(
            shopSql,
            `
                SELECT id, name
                FROM users
                WHERE active = TRUE
                ORDER BY id DESC
                LIMIT 1
            `,
        );

        expect(result.errors).toHaveLength(0);
        expect(result.columns.map((c) => c.label)).toEqual(['id', 'name']);
        expect(result.rows).toEqual([[3, 'Charlie']]);
    });

    it('supports aliases and arithmetic expressions', () => {
        const result = runQuery(shopSql, `SELECT id AS order_id, total * 2 doubled FROM orders WHERE id = 10;`);

        expect(result.errors).toHaveLength(0);
        expect(result.columns.map((c) => c.label)).toEqual(['order_id', 'doubled']);
        expect(result.rows).toEqual([[10, 199]]);
    });

    it('supports inner joins with qualified columns', () => {
        const result = runQuery(
            shopSql,
            `
                SELECT u.name, o.total
                FROM users u
                JOIN orders o ON o.user_id = u.id
                WHERE o.status = 'paid'
                ORDER BY o.total DESC
            `,
        );

        expect(result.errors).toHaveLength(0);
        expect(result.rows).toEqual([
            ['Charlie', 125],
            ['Alice', 99.5],
        ]);
    });

    it('queries views created with CREATE OR REPLACE in the Data View script', () => {
        const result = runQuery(
            `
                CREATE OR REPLACE TABLE users (id INT PRIMARY KEY, name TEXT, active BOOLEAN);
                INSERT INTO users (id, name, active) VALUES
                    (1, 'Ada', TRUE),
                    (2, 'Linus', FALSE),
                    (3, 'Grace', TRUE);

                CREATE OR REPLACE VIEW active_users AS
                    SELECT id, name FROM users WHERE active = TRUE;
            `,
            `
                SELECT name
                FROM active_users
                ORDER BY id
            `,
        );

        expect(result.errors).toHaveLength(0);
        expect(result.columns.map((column) => column.label)).toEqual(['name']);
        expect(result.rows).toEqual([['Ada'], ['Grace']]);
    });

    it('supports left joins and returns nulls for missing right rows', () => {
        const result = runQuery(
            `
                CREATE TABLE users (id INT, name TEXT);
                CREATE TABLE orders (id INT, user_id INT);
                INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob');
                INSERT INTO orders (id, user_id) VALUES (10, 1);
            `,
            `
                SELECT u.name, o.id AS order_id
                FROM users u
                LEFT JOIN orders o ON o.user_id = u.id
                ORDER BY u.id
            `,
        );

        expect(result.errors).toHaveLength(0);
        expect(result.rows).toEqual([
            ['Alice', 10],
            ['Bob', null],
        ]);
    });

    it('supports aggregate functions with group by and having', () => {
        const result = runQuery(
            shopSql,
            `
                SELECT u.name, COUNT(o.id) AS order_count, SUM(o.total) AS spend
                FROM users u
                LEFT JOIN orders o ON o.user_id = u.id
                GROUP BY u.name
                HAVING COUNT(o.id) > 0
                ORDER BY spend DESC
            `,
        );

        expect(result.errors).toHaveLength(0);
        expect(result.columns.map((c) => c.label)).toEqual(['name', 'order_count', 'spend']);
        expect(result.rows).toEqual([
            ['Charlie', 1, 125],
            ['Alice', 2, 124.5],
        ]);
    });

    it('supports SQL null helpers, scalar functions, and CASE expressions', () => {
        const result = runQuery(
            `
                CREATE TABLE sample_values (
                    id INT,
                    raw_name TEXT,
                    nickname TEXT,
                    amount NUMERIC,
                    divisor NUMERIC
                );

                INSERT INTO sample_values (id, raw_name, nickname, amount, divisor) VALUES
                    (1, 'Alice', NULL, 25.55, 5),
                    (2, NULL, 'Bee', 10, 0),
                    (3, NULL, NULL, -7.25, NULL);
            `,
            `
                SELECT
                    id,
                    COALESCE(nickname, raw_name, 'anonymous') AS display_name,
                    CASE COALESCE(nickname, raw_name, 'anonymous')
                        WHEN 'Alice' THEN 'known'
                        WHEN 'Bee' THEN 'alias'
                        ELSE 'fallback'
                    END AS display_kind,
                    CASE
                        WHEN NULLIF(divisor, 0) IS NULL THEN 'blocked'
                        WHEN amount / NULLIF(divisor, 0) >= 5 THEN 'high'
                        ELSE 'low'
                    END AS ratio_band,
                    ROUND(amount / NULLIF(divisor, 0), 2) AS safe_ratio,
                    UPPER(COALESCE(nickname, raw_name, 'anonymous')) AS display_upper,
                    LOWER(COALESCE(nickname, raw_name, 'anonymous')) AS display_lower,
                    LENGTH(COALESCE(nickname, raw_name, 'anonymous')) AS display_length,
                    ABS(amount) AS magnitude
                FROM sample_values
                ORDER BY id
            `,
        );

        expect(result.errors).toHaveLength(0);
        expect(result.columns.map((c) => c.label)).toEqual(['id', 'display_name', 'display_kind', 'ratio_band', 'safe_ratio', 'display_upper', 'display_lower', 'display_length', 'magnitude']);
        expect(result.rows).toEqual([
            [1, 'Alice', 'known', 'high', 5.11, 'ALICE', 'alice', 5, 25.55],
            [2, 'Bee', 'alias', 'blocked', null, 'BEE', 'bee', 3, 10],
            [3, 'anonymous', 'fallback', 'blocked', null, 'ANONYMOUS', 'anonymous', 9, 7.25],
        ]);
    });

    it('returns schema columns for empty select star results', () => {
        const result = runQuery(`CREATE TABLE users (id INT, name TEXT);`, `SELECT * FROM users;`);

        expect(result.errors).toHaveLength(0);
        expect(result.columns.map((c) => c.label)).toEqual(['id', 'name']);
        expect(result.rows).toEqual([]);
    });

    it('reports ambiguous unqualified columns', () => {
        const result = runQuery(
            `
                CREATE TABLE a (id INT);
                CREATE TABLE b (id INT);
                INSERT INTO a (id) VALUES (1);
                INSERT INTO b (id) VALUES (1);
            `,
            `SELECT id FROM a JOIN b ON a.id = b.id;`,
        );

        expect(result.errors[0].message).toContain('ambiguous');
    });

    it('supports complex chained CTE customer metrics queries', () => {
        const result = runQuery(
            `
                CREATE TABLE customers (
                    id INT,
                    name TEXT,
                    region TEXT,
                    status TEXT
                );

                CREATE TABLE orders (
                    id INT,
                    customer_id INT,
                    total NUMERIC,
                    status TEXT
                );

                INSERT INTO customers (id, name, region, status) VALUES
                    (1, 'Alice', 'North', 'active'),
                    (2, 'Bob', 'North', 'active'),
                    (3, 'Carla', 'South', 'active'),
                    (4, 'Dan', 'South', 'inactive'),
                    (5, 'Eve', 'West', 'active');

                INSERT INTO orders (id, customer_id, total, status) VALUES
                    (100, 1, 120, 'paid'),
                    (101, 1, 80, 'paid'),
                    (102, 1, 25, 'refunded'),
                    (103, 2, 55, 'paid'),
                    (104, 3, 300, 'paid'),
                    (105, 3, 150, 'paid'),
                    (106, 3, 75, 'pending'),
                    (107, 5, 40, 'paid');
            `,
            `
                WITH customer_metrics AS (
                    SELECT
                        c.id AS customer_id,
                        c.name AS customer_name,
                        c.region,
                        COUNT(o.id) AS order_count,
                        SUM(o.total) AS gross_revenue,
                        AVG(o.total) AS avg_order_value,
                        MAX(o.total) AS largest_order
                    FROM customers c
                    LEFT JOIN orders o ON o.customer_id = c.id AND o.status = 'paid'
                    WHERE c.status = 'active'
                    GROUP BY c.id, c.name, c.region
                    HAVING SUM(o.total) >= 100
                ),
                regional_metrics AS (
                    SELECT
                        region,
                        COUNT(customer_id) AS active_customers,
                        SUM(gross_revenue) AS regional_revenue,
                        AVG(avg_order_value) AS regional_avg_order_value
                    FROM customer_metrics
                    GROUP BY region
                )
                SELECT
                    cm.customer_name,
                    cm.region,
                    cm.order_count,
                    cm.gross_revenue,
                    cm.avg_order_value,
                    cm.gross_revenue / cm.order_count AS revenue_per_order,
                    rm.regional_revenue,
                    rm.active_customers
                FROM customer_metrics cm
                JOIN regional_metrics rm ON rm.region = cm.region
                WHERE cm.order_count BETWEEN 2 AND 4
                ORDER BY cm.gross_revenue DESC, cm.customer_name ASC
            `,
        );

        expect(result.errors).toHaveLength(0);
        expect(result.columns.map((c) => c.label)).toEqual(['customer_name', 'region', 'order_count', 'gross_revenue', 'avg_order_value', 'revenue_per_order', 'regional_revenue', 'active_customers']);
        expect(result.rows).toEqual([
            ['Carla', 'South', 2, 450, 225, 225, 450, 1],
            ['Alice', 'North', 2, 200, 100, 100, 200, 1],
        ]);
    });

    it('supports CTE column alias lists', () => {
        const result = runQuery(
            shopSql,
            `
                WITH totals(customer_id, spend) AS (
                    SELECT user_id, SUM(total)
                    FROM orders
                    GROUP BY user_id
                )
                SELECT customer_id, spend
                FROM totals
                WHERE spend >= 100
                ORDER BY spend DESC
            `,
        );

        expect(result.errors).toHaveLength(0);
        expect(result.columns.map((c) => c.label)).toEqual(['customer_id', 'spend']);
        expect(result.rows).toEqual([
            [3, 125],
            [1, 124.5],
        ]);
    });

    it('supports DENSE_RANK windows with partitions, ties, and CTE filters', () => {
        const result = runQuery(
            `
                CREATE TABLE sales (
                    id INT,
                    region TEXT,
                    rep TEXT,
                    account TEXT,
                    amount NUMERIC,
                    status TEXT
                );

                INSERT INTO sales (id, region, rep, account, amount, status) VALUES
                    (1, 'North', 'Alice', 'Acme', 500, 'won'),
                    (2, 'North', 'Alice', 'Beta', 500, 'won'),
                    (3, 'North', 'Nora', 'Core', 350, 'won'),
                    (4, 'North', 'Nora', 'Drift', 100, 'won'),
                    (5, 'South', 'Sam', 'Delta', 700, 'won'),
                    (6, 'South', 'Sue', 'Echo', 450, 'won'),
                    (7, 'South', 'Sue', 'Foxtrot', 450, 'won'),
                    (8, 'South', 'Syd', 'Giga', NULL, 'won'),
                    (9, 'South', 'Sam', 'Hold', 800, 'lost');
            `,
            `
                WITH won_sales AS (
                    SELECT
                        region,
                        rep,
                        account,
                        COALESCE(amount, 0) AS amount
                    FROM sales
                    WHERE status = 'won'
                ),
                ranked AS (
                    SELECT
                        region,
                        rep,
                        account,
                        amount,
                        DENSE_RANK() OVER (PARTITION BY region ORDER BY amount DESC) AS dense_rank_in_region,
                        RANK() OVER (PARTITION BY region ORDER BY amount DESC) AS rank_in_region,
                        ROW_NUMBER() OVER (PARTITION BY region ORDER BY amount DESC, account ASC) AS row_number_in_region
                    FROM won_sales
                )
                SELECT
                    region,
                    account,
                    amount,
                    dense_rank_in_region,
                    rank_in_region,
                    row_number_in_region
                FROM ranked
                WHERE dense_rank_in_region <= 2
                ORDER BY region ASC, dense_rank_in_region ASC, account ASC
            `,
        );

        expect(result.errors).toHaveLength(0);
        expect(result.columns.map((c) => c.label)).toEqual(['region', 'account', 'amount', 'dense_rank_in_region', 'rank_in_region', 'row_number_in_region']);
        expect(result.rows).toEqual([
            ['North', 'Acme', 500, 1, 1, 1],
            ['North', 'Beta', 500, 1, 1, 2],
            ['North', 'Core', 350, 2, 3, 3],
            ['South', 'Delta', 700, 1, 1, 1],
            ['South', 'Echo', 450, 2, 2, 2],
            ['South', 'Foxtrot', 450, 2, 2, 3],
        ]);
    });

    it('supports DENSE_RANK over grouped aggregate results', () => {
        const result = runQuery(
            `
                CREATE TABLE rep_sales (
                    id INT,
                    region TEXT,
                    rep TEXT,
                    amount NUMERIC,
                    status TEXT
                );

                INSERT INTO rep_sales (id, region, rep, amount, status) VALUES
                    (1, 'North', 'Alice', 300, 'won'),
                    (2, 'North', 'Alice', 200, 'won'),
                    (3, 'North', 'Bob', 500, 'won'),
                    (4, 'North', 'Cara', 200, 'won'),
                    (5, 'North', 'Cara', 50, 'lost'),
                    (6, 'South', 'Dan', 400, 'won'),
                    (7, 'South', 'Eva', 250, 'won'),
                    (8, 'South', 'Eva', 50, 'won'),
                    (9, 'South', 'Finn', 300, 'won');
            `,
            `
                SELECT
                    region,
                    rep,
                    SUM(CASE WHEN status = 'won' THEN COALESCE(amount, 0) ELSE 0 END) AS won_revenue,
                    DENSE_RANK() OVER (
                        PARTITION BY region
                        ORDER BY SUM(CASE WHEN status = 'won' THEN COALESCE(amount, 0) ELSE 0 END) DESC
                    ) AS revenue_rank
                FROM rep_sales
                GROUP BY region, rep
                HAVING SUM(CASE WHEN status = 'won' THEN COALESCE(amount, 0) ELSE 0 END) >= 200
                ORDER BY region ASC, revenue_rank ASC, rep ASC
            `,
        );

        expect(result.errors).toHaveLength(0);
        expect(result.columns.map((c) => c.label)).toEqual(['region', 'rep', 'won_revenue', 'revenue_rank']);
        expect(result.rows).toEqual([
            ['North', 'Alice', 500, 1],
            ['North', 'Bob', 500, 1],
            ['North', 'Cara', 200, 2],
            ['South', 'Dan', 400, 1],
            ['South', 'Eva', 300, 2],
            ['South', 'Finn', 300, 2],
        ]);
    });

    it('supports ARRAY_AGG DISTINCT with aggregate ORDER BY in admin order queries', () => {
        const result = runQuery(
            `
                CREATE TABLE orders (
                    id INT,
                    customer_id INT,
                    status TEXT,
                    total NUMERIC,
                    created_at TEXT
                );

                CREATE TABLE customers (
                    id INT,
                    full_name TEXT,
                    email TEXT
                );

                CREATE TABLE order_items (
                    id INT,
                    order_id INT,
                    product_id INT,
                    quantity INT,
                    unit_price NUMERIC
                );

                CREATE TABLE products (
                    id INT,
                    name TEXT
                );

                CREATE TABLE payments (
                    id INT,
                    order_id INT,
                    method TEXT,
                    amount NUMERIC,
                    paid_at TEXT
                );

                CREATE TABLE shipments (
                    id INT,
                    order_id INT,
                    carrier TEXT,
                    tracking_number TEXT,
                    status TEXT,
                    shipped_at TEXT
                );

                INSERT INTO orders (id, customer_id, status, total, created_at) VALUES
                    (100, 1, 'paid', 45, '2024-02-01T10:00:00'),
                    (101, 2, 'pending', 0, '2024-02-02T11:00:00');

                INSERT INTO customers (id, full_name, email) VALUES
                    (1, 'Alice Nguyen', 'alice@example.com'),
                    (2, 'Bob Tran', 'bob@example.com');

                INSERT INTO products (id, name) VALUES
                    (10, 'Widget'),
                    (20, 'Gizmo');

                INSERT INTO order_items (id, order_id, product_id, quantity, unit_price) VALUES
                    (1, 100, 10, 2, 10),
                    (2, 100, 20, 1, 15),
                    (3, 100, 10, 1, 10);

                INSERT INTO payments (id, order_id, method, amount, paid_at) VALUES
                    (500, 100, 'card', 45, '2024-02-01T10:05:00');

                INSERT INTO shipments (id, order_id, carrier, tracking_number, status, shipped_at) VALUES
                    (900, 100, 'UPS', 'TRACK100', 'shipped', '2024-02-01T18:00:00');
            `,
            `
                SELECT
                    o.id AS order_id,
                    o.status,
                    o.total,
                    o.created_at,

                    c.id AS customer_id,
                    c.full_name,
                    c.email,

                    COALESCE(SUM(oi.quantity), 0) AS total_items,
                    COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS computed_order_total,

                    ARRAY_AGG(DISTINCT p.name ORDER BY p.name) AS products,

                    pay.method AS payment_method,
                    pay.amount AS payment_amount,
                    pay.paid_at AS paid_at,

                    s.carrier AS shipment_carrier,
                    s.tracking_number,
                    s.status AS shipment_status,
                    s.shipped_at

                FROM orders o

                JOIN customers c
                    ON c.id = o.customer_id

                LEFT JOIN order_items oi
                    ON oi.order_id = o.id

                LEFT JOIN products p
                    ON p.id = oi.product_id

                LEFT JOIN payments pay
                    ON pay.order_id = o.id

                LEFT JOIN shipments s
                    ON s.order_id = o.id

                GROUP BY
                    o.id,
                    o.status,
                    o.total,
                    o.created_at,
                    c.id,
                    c.full_name,
                    c.email,
                    pay.method,
                    pay.amount,
                    pay.paid_at,
                    s.carrier,
                    s.tracking_number,
                    s.status,
                    s.shipped_at

                ORDER BY
                    o.created_at DESC
            `,
        );

        expect(result.errors).toHaveLength(0);
        expect(result.columns.map((c) => c.label)).toEqual([
            'order_id',
            'status',
            'total',
            'created_at',
            'customer_id',
            'full_name',
            'email',
            'total_items',
            'computed_order_total',
            'products',
            'payment_method',
            'payment_amount',
            'paid_at',
            'shipment_carrier',
            'tracking_number',
            'shipment_status',
            'shipped_at',
        ]);
        expect(result.rows).toEqual([
            [101, 'pending', 0, '2024-02-02T11:00:00', 2, 'Bob Tran', 'bob@example.com', 0, 0, [], null, null, null, null, null, null, null],
            [100, 'paid', 45, '2024-02-01T10:00:00', 1, 'Alice Nguyen', 'alice@example.com', 4, 45, ['Gizmo', 'Widget'], 'card', 45, '2024-02-01T10:05:00', 'UPS', 'TRACK100', 'shipped', '2024-02-01T18:00:00'],
        ]);
    });

    it('supports scalar subqueries, derived tables, and PostgreSQL JSON report helpers', () => {
        const result = runQuery(
            `
                CREATE TABLE customers (
                    id INT,
                    full_name TEXT,
                    email TEXT
                );

                CREATE TABLE orders (
                    id INT,
                    customer_id INT,
                    status TEXT,
                    total NUMERIC,
                    created_at TEXT
                );

                CREATE TABLE order_items (
                    id INT,
                    order_id INT,
                    product_id INT,
                    quantity INT,
                    unit_price NUMERIC
                );

                CREATE TABLE products (
                    id INT,
                    name TEXT
                );

                CREATE TABLE payments (
                    id INT,
                    order_id INT,
                    method TEXT,
                    amount NUMERIC,
                    paid_at TEXT
                );

                CREATE TABLE shipments (
                    id INT,
                    order_id INT,
                    carrier TEXT,
                    tracking_number TEXT,
                    status TEXT,
                    shipped_at TEXT
                );

                INSERT INTO customers (id, full_name, email) VALUES
                    (1, 'Alice Nguyen', 'alice@example.com'),
                    (2, 'Bob Tran', 'bob@example.com'),
                    (3, 'Carla Pham', 'carla@example.com');

                INSERT INTO orders (id, customer_id, status, total, created_at) VALUES
                    (100, 1, 'paid', 70, '2024-02-01T10:00:00'),
                    (101, 1, 'paid', 50, '2024-03-01T10:00:00'),
                    (102, 2, 'paid', 30, '2024-01-15T09:00:00'),
                    (103, 3, 'paid', 60, '2024-01-20T09:00:00');

                INSERT INTO products (id, name) VALUES
                    (10, 'Widget'),
                    (20, 'Gizmo');

                INSERT INTO order_items (id, order_id, product_id, quantity, unit_price) VALUES
                    (1, 100, 10, 2, 20),
                    (2, 100, 20, 1, 30),
                    (3, 101, 10, 1, 50),
                    (4, 102, 20, 1, 30),
                    (5, 103, 10, 3, 20);

                INSERT INTO payments (id, order_id, method, amount, paid_at) VALUES
                    (500, 100, 'card', 70, '2024-02-01T10:05:00'),
                    (501, 101, 'cash', 50, '2024-03-01T10:05:00'),
                    (502, 102, 'card', 30, '2024-01-15T09:05:00');

                INSERT INTO shipments (id, order_id, carrier, tracking_number, status, shipped_at) VALUES
                    (900, 100, 'UPS', 'TRACK100', 'delivered', '2024-02-02T18:00:00'),
                    (901, 101, 'DHL', 'TRACK101', 'processing', NULL),
                    (902, 102, 'UPS', 'TRACK102', 'delivered', '2024-01-16T18:00:00');
            `,
            `
                SELECT
                    c.id AS customer_id,
                    c.full_name,
                    c.email,

                    COUNT(DISTINCT o.id) AS total_orders,

                    COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS total_spent,

                    MAX(o.created_at) AS last_order_date,

                    DENSE_RANK() OVER (
                        ORDER BY COALESCE(SUM(oi.quantity * oi.unit_price), 0) DESC
                    ) AS spending_rank,

                    CASE
                        WHEN COALESCE(SUM(oi.quantity * oi.unit_price), 0) >= 100 THEN 'VIP'
                        WHEN COALESCE(SUM(oi.quantity * oi.unit_price), 0) >= 50 THEN 'PREMIUM'
                        WHEN COALESCE(SUM(oi.quantity * oi.unit_price), 0) > 0 THEN 'STANDARD'
                        ELSE 'BASIC'
                    END AS segment,

                    (
                        SELECT json_build_object(
                            'order_id', o2.id,
                            'status', o2.status,
                            'total', o2.total,
                            'payment_method', pay.method,
                            'shipment_status', s.status
                        )
                        FROM orders o2
                        LEFT JOIN payments pay
                            ON pay.order_id = o2.id
                        LEFT JOIN shipments s
                            ON s.order_id = o2.id
                        WHERE o2.customer_id = c.id
                        ORDER BY o2.created_at DESC
                        LIMIT 1
                    ) AS latest_order,

                    ARRAY_AGG(DISTINCT p.name ORDER BY p.name) AS products_bought

                FROM customers c

                LEFT JOIN orders o
                    ON o.customer_id = c.id

                LEFT JOIN order_items oi
                    ON oi.order_id = o.id

                LEFT JOIN products p
                    ON p.id = oi.product_id

                GROUP BY
                    c.id,
                    c.full_name,
                    c.email

                HAVING
                    COUNT(o.id) > 0
                    AND COALESCE(SUM(oi.quantity * oi.unit_price), 0) > (
                        SELECT AVG(customer_total)
                        FROM (
                            SELECT
                                SUM(oi2.quantity * oi2.unit_price) AS customer_total
                            FROM customers c2
                            JOIN orders o2 ON o2.customer_id = c2.id
                            JOIN order_items oi2 ON oi2.order_id = o2.id
                            GROUP BY c2.id
                        ) t
                    )

                ORDER BY
                    total_spent DESC
            `,
        );

        expect(result.errors).toHaveLength(0);
        expect(result.columns.map((c) => c.label)).toEqual(['customer_id', 'full_name', 'email', 'total_orders', 'total_spent', 'last_order_date', 'spending_rank', 'segment', 'latest_order', 'products_bought']);
        expect(result.rows).toEqual([
            [
                1,
                'Alice Nguyen',
                'alice@example.com',
                2,
                120,
                '2024-03-01T10:00:00',
                1,
                'VIP',
                {
                    order_id: 101,
                    status: 'paid',
                    total: 50,
                    payment_method: 'cash',
                    shipment_status: 'processing',
                },
                ['Gizmo', 'Widget'],
            ],
        ]);
    });

    it('supports aggregate FILTER, EXISTS predicates, and windowed aggregates in CTE reports', () => {
        const result = runQuery(
            `
                CREATE TABLE customers (
                    id INT,
                    full_name TEXT,
                    email TEXT
                );

                CREATE TABLE orders (
                    id INT,
                    customer_id INT,
                    status TEXT,
                    total NUMERIC,
                    created_at TEXT
                );

                CREATE TABLE order_items (
                    id INT,
                    order_id INT,
                    product_id INT,
                    quantity INT,
                    unit_price NUMERIC
                );

                CREATE TABLE products (
                    id INT,
                    name TEXT
                );

                CREATE TABLE payments (
                    id INT,
                    order_id INT,
                    method TEXT
                );

                CREATE TABLE shipments (
                    id INT,
                    order_id INT,
                    status TEXT
                );

                INSERT INTO customers (id, full_name, email) VALUES
                    (1, 'Alice Nguyen', 'alice@example.com'),
                    (2, 'Bob Tran', 'bob@example.com'),
                    (3, 'Carla Pham', 'carla@example.com');

                INSERT INTO orders (id, customer_id, status, total, created_at) VALUES
                    (100, 1, 'paid', 70, '2024-02-01T10:00:00'),
                    (101, 1, 'paid', 50, '2024-03-01T10:00:00'),
                    (102, 2, 'paid', 30, '2024-01-15T09:00:00'),
                    (103, 3, 'paid', 60, '2024-01-20T09:00:00');

                INSERT INTO products (id, name) VALUES
                    (10, 'Widget'),
                    (20, 'Gizmo');

                INSERT INTO order_items (id, order_id, product_id, quantity, unit_price) VALUES
                    (1, 100, 10, 2, 20),
                    (2, 100, 20, 1, 30),
                    (3, 101, 10, 1, 50),
                    (4, 102, 20, 1, 30),
                    (5, 103, 10, 3, 20);

                INSERT INTO payments (id, order_id, method) VALUES
                    (500, 100, 'card'),
                    (501, 101, 'cash'),
                    (502, 102, 'card');

                INSERT INTO shipments (id, order_id, status) VALUES
                    (900, 100, 'delivered'),
                    (901, 101, 'processing'),
                    (902, 102, 'delivered');
            `,
            `
                WITH customer_metrics AS (
                    SELECT
                        c.id AS customer_id,
                        c.full_name,
                        c.email,

                        COUNT(DISTINCT o.id) AS total_orders,

                        COALESCE(SUM(
                            oi.quantity * oi.unit_price
                        ), 0) AS total_spent,

                        MAX(o.created_at) AS last_order_date,

                        ARRAY_AGG(
                            DISTINCT p.name
                            ORDER BY p.name
                        ) FILTER (
                            WHERE p.name IS NOT NULL
                        ) AS purchased_products

                    FROM customers c

                    LEFT JOIN orders o
                        ON o.customer_id = c.id

                    LEFT JOIN order_items oi
                        ON oi.order_id = o.id

                    LEFT JOIN products p
                        ON p.id = oi.product_id

                    GROUP BY
                        c.id,
                        c.full_name,
                        c.email
                ),

                ranked_customers AS (
                    SELECT
                        cm.*,

                        DENSE_RANK() OVER (
                            ORDER BY cm.total_spent DESC
                        ) AS spending_rank,

                        AVG(cm.total_spent) OVER () AS avg_customer_spending

                    FROM customer_metrics cm
                )

                SELECT
                    rc.customer_id,
                    rc.full_name,
                    rc.email,
                    rc.total_orders,
                    rc.total_spent,
                    rc.last_order_date,
                    rc.purchased_products,
                    rc.spending_rank,

                    CASE
                        WHEN rc.total_spent >= 1000 THEN 'VIP'
                        WHEN rc.total_spent >= 200 THEN 'PREMIUM'
                        WHEN rc.total_spent >= 50 THEN 'STANDARD'
                        ELSE 'BASIC'
                    END AS customer_segment,

                    (
                        SELECT json_build_object(
                            'order_id', o.id,
                            'status', o.status,
                            'total', o.total,
                            'latest_payment_method', pay.method,
                            'shipment_status', s.status
                        )

                        FROM orders o

                        LEFT JOIN payments pay
                            ON pay.order_id = o.id

                        LEFT JOIN shipments s
                            ON s.order_id = o.id

                        WHERE o.customer_id = rc.customer_id

                        ORDER BY o.created_at DESC

                        LIMIT 1
                    ) AS latest_order_summary

                FROM ranked_customers rc

                WHERE EXISTS (
                    SELECT 1
                    FROM orders o
                    WHERE o.customer_id = rc.customer_id
                )

                AND rc.total_spent > (
                    SELECT AVG(order_total)
                    FROM (
                        SELECT
                            SUM(total) AS order_total
                        FROM orders
                        GROUP BY customer_id
                    ) avg_table
                )

                ORDER BY
                    rc.total_spent DESC,
                    rc.full_name
            `,
        );

        expect(result.errors).toHaveLength(0);
        expect(result.columns.map((c) => c.label)).toEqual(['customer_id', 'full_name', 'email', 'total_orders', 'total_spent', 'last_order_date', 'purchased_products', 'spending_rank', 'customer_segment', 'latest_order_summary']);
        expect(result.rows).toEqual([
            [
                1,
                'Alice Nguyen',
                'alice@example.com',
                2,
                120,
                '2024-03-01T10:00:00',
                ['Gizmo', 'Widget'],
                1,
                'STANDARD',
                {
                    order_id: 101,
                    status: 'paid',
                    total: 50,
                    latest_payment_method: 'cash',
                    shipment_status: 'processing',
                },
            ],
        ]);
    });

    it('supports common SQLite, MySQL, PostgreSQL, and MSSQL helper syntax', () => {
        const result = runQuery(
            `
                CREATE TABLE events (
                    id INT,
                    category TEXT,
                    label TEXT,
                    score NUMERIC
                );

                INSERT INTO events (id, category, label, score) VALUES
                    (1, 'A', 'beta', NULL),
                    (2, 'A', 'alpha', 4),
                    (3, 'A', 'alpha', 4),
                    (4, 'B', 'delta', 10);
            `,
            `
                SELECT TOP (2)
                    category,
                    STRING_AGG(label, '|') AS labels_for_mssql_postgres,
                    GROUP_CONCAT(DISTINCT label ORDER BY label) AS labels_for_sqlite_mysql,
                    JSON_OBJECT('category', category, 'score', ISNULL(MAX(score), 0)) AS payload,
                    NVL(MIN(score), 0) AS min_score
                FROM events
                GROUP BY category
                ORDER BY category ASC
            `,
        );

        expect(result.errors).toHaveLength(0);
        expect(result.columns.map((c) => c.label)).toEqual(['category', 'labels_for_mssql_postgres', 'labels_for_sqlite_mysql', 'payload', 'min_score']);
        expect(result.rows).toEqual([
            ['A', 'beta|alpha|alpha', 'alpha,beta', { category: 'A', score: 4 }, 4],
            ['B', 'delta', 'delta', { category: 'B', score: 10 }, 10],
        ]);
    });

    it('supports complex reporting SQL with COALESCE, CASE, NULLIF, and COUNT DISTINCT', () => {
        const result = runQuery(
            `
                CREATE TABLE sales_reps (
                    id INT,
                    name TEXT,
                    region TEXT
                );

                CREATE TABLE customers (
                    id INT,
                    name TEXT,
                    region TEXT,
                    status TEXT,
                    sales_rep_id INT
                );

                CREATE TABLE orders (
                    id INT,
                    customer_id INT,
                    total NUMERIC,
                    discount NUMERIC,
                    status TEXT
                );

                INSERT INTO sales_reps (id, name, region) VALUES
                    (1, 'Rita', 'North'),
                    (2, 'Sam', 'South');

                INSERT INTO customers (id, name, region, status, sales_rep_id) VALUES
                    (1, 'Alice', NULL, 'vip', 1),
                    (2, 'Bob', 'North', 'standard', NULL),
                    (3, 'Carla', 'South', NULL, 2),
                    (4, 'Dana', 'West', 'standard', NULL),
                    (5, NULL, NULL, NULL, NULL);

                INSERT INTO orders (id, customer_id, total, discount, status) VALUES
                    (100, 1, 120, 20, 'paid'),
                    (101, 1, 80, NULL, 'paid'),
                    (102, 1, 50, 0, 'pending'),
                    (103, 2, 60, 10, 'paid'),
                    (104, 3, 300, 30, 'paid'),
                    (105, 3, 0, 0, 'paid'),
                    (106, 4, NULL, NULL, 'paid'),
                    (107, 5, 10, NULL, 'refunded');
            `,
            `
                WITH customer_metrics AS (
                    SELECT
                        c.id AS customer_id,
                        COALESCE(c.region, sr.region, 'Unassigned') AS region,
                        COALESCE(c.name, 'Unknown') AS customer_name,
                        CASE
                            WHEN c.status IS NULL THEN 'unknown'
                            WHEN c.status = 'vip' THEN 'vip'
                            ELSE 'standard'
                        END AS customer_tier,
                        COUNT(DISTINCT o.id) AS order_count,
                        COALESCE(SUM(
                            CASE
                                WHEN o.status = 'paid' THEN COALESCE(o.total, 0) - COALESCE(o.discount, 0)
                                ELSE 0
                            END
                        ), 0) AS net_paid_revenue,
                        COALESCE(AVG(
                            CASE
                                WHEN o.status = 'paid' THEN NULLIF(o.total, 0)
                                ELSE NULL
                            END
                        ), 0) AS avg_paid_order_value
                    FROM customers c
                    LEFT JOIN sales_reps sr ON sr.id = c.sales_rep_id
                    LEFT JOIN orders o ON o.customer_id = c.id
                    GROUP BY c.id, c.name, c.region, sr.region, c.status
                ),
                regional_rollup AS (
                    SELECT
                        region,
                        COUNT(DISTINCT customer_id) AS customer_count,
                        SUM(net_paid_revenue) AS region_revenue
                    FROM customer_metrics
                    GROUP BY region
                    HAVING COALESCE(SUM(net_paid_revenue), 0) >= 100
                )
                SELECT
                    cm.region,
                    cm.customer_name,
                    cm.customer_tier,
                    cm.order_count,
                    cm.net_paid_revenue,
                    cm.avg_paid_order_value,
                    CASE
                        WHEN cm.net_paid_revenue / NULLIF(rr.region_revenue, 0) >= 0.5 THEN 'major'
                        ELSE 'supporting'
                    END AS revenue_weight,
                    rr.customer_count,
                    rr.region_revenue
                FROM customer_metrics cm
                JOIN regional_rollup rr ON rr.region = cm.region
                WHERE COALESCE(cm.net_paid_revenue, 0) > 0
                ORDER BY rr.region_revenue DESC, cm.net_paid_revenue DESC, cm.customer_name ASC
            `,
        );

        expect(result.errors).toHaveLength(0);
        expect(result.columns.map((c) => c.label)).toEqual(['region', 'customer_name', 'customer_tier', 'order_count', 'net_paid_revenue', 'avg_paid_order_value', 'revenue_weight', 'customer_count', 'region_revenue']);
        expect(result.rows).toEqual([
            ['South', 'Carla', 'unknown', 2, 270, 300, 'major', 1, 270],
            ['North', 'Alice', 'vip', 3, 180, 100, 'major', 2, 230],
            ['North', 'Bob', 'standard', 1, 50, 60, 'supporting', 2, 230],
        ]);
    });
});

describe('queryExecutor — lexical safety and SQL Server temp tables', () => {
    it('supports nested PostgreSQL / SQL Server block comments before a query', () => {
        const result = executeSelectQuery({ tables: new Map(), query: `/* outer /* inner */ outer */ SELECT 1 AS value;` });

        expect(result.errors).toHaveLength(0);
        expect(result.rows).toEqual([[1]]);
    });

    it('rejects unterminated string literals instead of returning a partial value', () => {
        const result = executeSelectQuery({ tables: new Map(), query: `SELECT 'unterminated` });

        expect(result.rows).toEqual([]);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toMatch(/syntax error: unclosed single-quoted string/i);
    });

    it('rejects a second statement instead of silently running only the first', () => {
        const result = executeSelectQuery({ tables: new Map(), query: `SELECT 1; SELECT 2;` });

        expect(result.rows).toEqual([]);
        expect(result.errors[0].message).toMatch(/exactly one select statement/i);
    });

    it('queries SQL Server local temp tables', () => {
        const result = runQuery(
            `CREATE TABLE #temp (id INT, label TEXT); CREATE INDEX ix_temp_id ON #temp (id); INSERT INTO #temp VALUES (1, 'ready');`,
            `SELECT label FROM #temp;`,
        );

        expect(result.errors).toHaveLength(0);
        expect(result.rows).toEqual([['ready']]);
    });
});
