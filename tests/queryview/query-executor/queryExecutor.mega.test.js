import { describe, expect, it } from 'vitest';
import { createSqlExecutor } from '@/features/data-view/lib/sqlExecutor.js';
import { executeSelectQuery } from '@/features/query-view/lib/queryExecutor.js';

function run(ddl, q) {
    return executeSelectQuery({ tables: createSqlExecutor().execute(ddl).tables, query: q });
}

const ecommerce = `
CREATE TABLE customers (id INT, name TEXT, email TEXT, country TEXT, vip BOOLEAN, credit NUMERIC);
INSERT INTO customers VALUES
(1,'Alice','alice@co.com','US',TRUE,500),(2,'Bob','bob@co.uk','UK',FALSE,100),
(3,'Charlie','charlie@co.de','DE',TRUE,800),(4,'Dana','dana@co.us','US',FALSE,0),
(5,'Eve','eve@co.jp','JP',TRUE,1200),(6,'Frank',NULL,'US',FALSE,NULL);

CREATE TABLE products (id INT, name TEXT, category TEXT, price NUMERIC, stock INT);
INSERT INTO products VALUES
(1,'Laptop','electronics',999,50),(2,'Phone','electronics',599,200),
(3,'Shirt','clothing',29,500),(4,'Book','books',15,1000),
(5,'Headphones','electronics',149,150),(6,'Pants','clothing',49,300),
(7,'Tablet','electronics',399,80),(8,'Watch','accessories',199,60);

CREATE TABLE orders (id INT, customer_id INT, order_date TEXT, status TEXT, discount NUMERIC);
INSERT INTO orders VALUES
(100,1,'2024-01-15','completed',10),(101,1,'2024-02-20','completed',0),
(102,2,'2024-01-25','completed',5),(103,3,'2024-03-10','completed',15),
(104,3,'2024-03-15','shipped',0),(105,4,'2024-02-01','cancelled',0),
(106,5,'2024-01-05','completed',20),(107,5,'2024-04-01','completed',10),
(108,1,'2024-04-10','pending',0),(109,6,'2024-03-20','completed',0);

CREATE TABLE order_items (id INT, order_id INT, product_id INT, qty INT, unit_price NUMERIC);
INSERT INTO order_items VALUES
(1,100,1,1,999),(2,100,5,2,149),(3,101,3,3,29),(4,101,4,5,15),
(5,102,2,1,599),(6,102,4,2,15),(7,103,1,2,999),(8,103,7,1,399),
(9,104,8,3,199),(10,105,3,1,29),(11,106,1,1,999),(12,106,2,2,599),
(13,107,5,1,149),(14,107,6,2,49),(15,108,7,1,399),(16,109,4,10,15);

CREATE TABLE reviews (id INT, product_id INT, customer_id INT, rating INT, body TEXT);
INSERT INTO reviews VALUES
(1,1,1,5,'Great laptop'),(2,1,3,4,'Good value'),(3,2,2,3,'OK phone'),
(4,3,1,5,'Love it'),(5,5,5,4,'Nice sound'),(6,4,2,2,'Boring'),
(7,2,5,5,'Amazing'),(8,7,3,4,'Solid tablet'),(9,8,5,5,'Beautiful');
`;

describe('queryExecutor mega tests', () => {

    // ── Edge cases & boundary conditions ──

    describe('edge cases', () => {
        it('empty WHERE result preserves column schema', () => {
            const r = run(ecommerce, `SELECT id, name, price FROM products WHERE price > 99999`);
            expect(r.errors).toHaveLength(0);
            expect(r.rows).toHaveLength(0);
            expect(r.columns.map(c => c.label)).toEqual(['id', 'name', 'price']);
        });

        it('NULL handling in arithmetic chains', () => {
            const r = run(ecommerce, `
                SELECT c.name, c.credit, c.credit + 100 AS plus, c.credit * 2 AS doubled,
                    COALESCE(c.credit, 0) + 50 AS safe_plus
                FROM customers c WHERE c.id IN (5, 6) ORDER BY c.id
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows[0]).toEqual(['Eve', 1200, 1300, 2400, 1250]);
            expect(r.rows[1]).toEqual(['Frank', null, null, null, 50]);
        });

        it('NULL in || concatenation returns NULL', () => {
            const r = run(ecommerce, `
                SELECT c.name || ' <' || c.email || '>' AS contact FROM customers c WHERE c.id IN (1, 6) ORDER BY c.id
            `);
            expect(r.rows[0][0]).toBe('Alice <alice@co.com>');
            expect(r.rows[1][0]).toBe(null);
        });

        it('DISTINCT with NULLs', () => {
            const r = run(ecommerce, `SELECT DISTINCT c.country FROM customers c ORDER BY c.country`);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.flat()).toEqual(['DE', 'JP', 'UK', 'US']);
        });

        it('COUNT(*) vs COUNT(column) with NULLs', () => {
            const r = run(ecommerce, `
                SELECT COUNT(*) AS total, COUNT(email) AS with_email, COUNT(credit) AS with_credit
                FROM customers
            `);
            expect(r.rows[0]).toEqual([6, 5, 5]);
        });

        it('multiple aggregates without GROUP BY', () => {
            const r = run(ecommerce, `
                SELECT MIN(price) AS min_p, MAX(price) AS max_p, AVG(price) AS avg_p,
                    SUM(stock) AS total_stock, COUNT(DISTINCT category) AS cats
                FROM products
            `);
            expect(r.rows[0][0]).toBe(15);
            expect(r.rows[0][1]).toBe(999);
            expect(r.rows[0][4]).toBe(4);
        });

        it('BETWEEN with string comparison', () => {
            const r = run(ecommerce, `
                SELECT name FROM products WHERE name BETWEEN 'H' AND 'T' ORDER BY name
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.flat()).toEqual(['Headphones', 'Laptop', 'Pants', 'Phone', 'Shirt']);
        });

        it('NOT BETWEEN + NOT LIKE combined', () => {
            const r = run(ecommerce, `
                SELECT name FROM products
                WHERE price NOT BETWEEN 100 AND 500 AND name NOT LIKE '%o%'
                ORDER BY name
            `);
            expect(r.errors).toHaveLength(0);
        });

        it('nested NOT conditions', () => {
            const r = run(ecommerce, `
                SELECT name FROM customers
                WHERE NOT (country = 'US' AND NOT vip IS TRUE)
                ORDER BY name
            `);
            expect(r.errors).toHaveLength(0);
        });

        it('ORDER BY alias from SELECT', () => {
            const r = run(ecommerce, `
                SELECT name, price * stock AS inventory_value FROM products ORDER BY inventory_value DESC LIMIT 3
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBe(3);
            expect(r.rows[0][1]).toBeGreaterThanOrEqual(r.rows[1][1]);
        });

        it('LIMIT 0 returns no rows', () => {
            const r = run(ecommerce, `SELECT * FROM products LIMIT 0`);
            expect(r.rows).toHaveLength(0);
        });

        it('OFFSET beyond row count returns empty', () => {
            const r = run(ecommerce, `SELECT * FROM products LIMIT 10 OFFSET 1000`);
            expect(r.rows).toHaveLength(0);
        });
    });

    // ── Revenue analytics (long, realistic) ──

    describe('revenue analytics', () => {
        it('revenue by customer with rank + running total pattern', () => {
            const r = run(ecommerce, `
                WITH customer_revenue AS (
                    SELECT c.id, c.name, c.country, c.vip,
                        SUM(oi.qty * oi.unit_price) AS gross,
                        SUM(oi.qty * oi.unit_price * (100 - COALESCE(o.discount, 0)) / 100.0) AS net
                    FROM customers c
                    JOIN orders o ON o.customer_id = c.id AND o.status = 'completed'
                    JOIN order_items oi ON oi.order_id = o.id
                    GROUP BY c.id, c.name, c.country, c.vip
                )
                SELECT cr.name, cr.country,
                    IIF(cr.vip = TRUE, 'VIP', 'Standard') AS tier,
                    cr.gross, ROUND(cr.net, 2) AS net_revenue,
                    RANK() OVER (ORDER BY cr.net DESC) AS revenue_rank,
                    ROUND(cr.net * 100.0 / SUM(cr.net) OVER (), 2) AS pct_of_total,
                    SUM(cr.net) OVER (ORDER BY cr.net DESC) AS running_total
                FROM customer_revenue cr
                ORDER BY revenue_rank
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBeGreaterThan(0);
            expect(r.columns.length).toBe(8);
            expect(r.rows[0][5]).toBe(1);
        });

        it('product performance: reviews + sales + stock analysis', () => {
            const r = run(ecommerce, `
                WITH product_sales AS (
                    SELECT oi.product_id,
                        SUM(oi.qty) AS units_sold,
                        SUM(oi.qty * oi.unit_price) AS revenue
                    FROM order_items oi
                    JOIN orders o ON o.id = oi.order_id AND o.status != 'cancelled'
                    GROUP BY oi.product_id
                ),
                product_reviews AS (
                    SELECT r.product_id,
                        COUNT(*) AS review_count,
                        ROUND(AVG(r.rating), 1) AS avg_rating,
                        MIN(r.rating) AS min_rating,
                        MAX(r.rating) AS max_rating
                    FROM reviews r GROUP BY r.product_id
                )
                SELECT p.name, p.category, p.price, p.stock,
                    COALESCE(ps.units_sold, 0) AS sold,
                    COALESCE(ps.revenue, 0) AS revenue,
                    COALESCE(pr.review_count, 0) AS reviews,
                    COALESCE(pr.avg_rating, 0) AS avg_rating,
                    CASE
                        WHEN p.stock = 0 THEN 'OUT_OF_STOCK'
                        WHEN COALESCE(ps.units_sold, 0) > p.stock * 0.5 THEN 'HOT'
                        WHEN COALESCE(ps.units_sold, 0) > 0 THEN 'NORMAL'
                        ELSE 'COLD'
                    END AS demand,
                    NTILE(3) OVER (ORDER BY COALESCE(ps.revenue, 0) DESC) AS revenue_tier
                FROM products p
                LEFT JOIN product_sales ps ON ps.product_id = p.id
                LEFT JOIN product_reviews pr ON pr.product_id = p.id
                ORDER BY revenue DESC
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBe(8);
        });

        it('category comparison with UNION ALL pivot', () => {
            const r = run(ecommerce, `
                WITH cat_stats AS (
                    SELECT p.category,
                        COUNT(DISTINCT p.id) AS products,
                        SUM(p.stock) AS total_stock,
                        AVG(p.price) AS avg_price,
                        SUM(COALESCE(oi.qty, 0)) AS total_sold
                    FROM products p
                    LEFT JOIN order_items oi ON oi.product_id = p.id
                    GROUP BY p.category
                )
                SELECT 'Revenue Leader' AS metric, category, CAST(total_sold * avg_price AS INTEGER) AS value
                FROM cat_stats WHERE total_sold = (SELECT MAX(total_sold) FROM cat_stats)
                UNION ALL
                SELECT 'Most Products', category, products
                FROM cat_stats WHERE products = (SELECT MAX(products) FROM cat_stats)
                UNION ALL
                SELECT 'Highest Avg Price', category, CAST(avg_price AS INTEGER)
                FROM cat_stats WHERE avg_price = (SELECT MAX(avg_price) FROM cat_stats)
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBe(3);
        });

        it('customer cohort analysis with date ranges + window', () => {
            const r = run(ecommerce, `
                WITH order_data AS (
                    SELECT o.customer_id, o.order_date, o.status,
                        SUM(oi.qty * oi.unit_price) AS order_total,
                        ROW_NUMBER() OVER (PARTITION BY o.customer_id ORDER BY o.order_date) AS order_seq,
                        COUNT(*) OVER (PARTITION BY o.customer_id) AS total_orders,
                        LAG(o.order_date) OVER (PARTITION BY o.customer_id ORDER BY o.order_date) AS prev_date
                    FROM orders o JOIN order_items oi ON oi.order_id = o.id
                    WHERE o.status != 'cancelled'
                    GROUP BY o.id, o.customer_id, o.order_date, o.status
                )
                SELECT c.name, od.order_date, od.order_total,
                    od.order_seq || ' of ' || od.total_orders AS seq_label,
                    COALESCE(od.prev_date, 'first') AS previous_order,
                    CASE
                        WHEN od.order_seq = 1 THEN 'New'
                        WHEN od.total_orders >= 3 THEN 'Loyal'
                        ELSE 'Returning'
                    END AS customer_type
                FROM order_data od JOIN customers c ON c.id = od.customer_id
                ORDER BY c.name, od.order_date
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBeGreaterThan(0);
        });
    });

    // ── Window function edge cases ──

    describe('window function edge cases', () => {
        it('LAG/LEAD across partitions do not bleed', () => {
            const r = run(ecommerce, `
                SELECT p.category, p.name, p.price,
                    LAG(p.name) OVER (PARTITION BY p.category ORDER BY p.price) AS cheaper,
                    LEAD(p.name) OVER (PARTITION BY p.category ORDER BY p.price) AS pricier
                FROM products p ORDER BY p.category, p.price
            `);
            expect(r.errors).toHaveLength(0);
            const electronics = r.rows.filter(row => row[0] === 'electronics');
            expect(electronics[0][3]).toBe(null);
            expect(electronics[electronics.length - 1][4]).toBe(null);
        });

        it('DENSE_RANK with ties', () => {
            const r = run(ecommerce, `
                SELECT r.rating,
                    DENSE_RANK() OVER (ORDER BY r.rating DESC) AS dr,
                    RANK() OVER (ORDER BY r.rating DESC) AS rk,
                    ROW_NUMBER() OVER (ORDER BY r.rating DESC) AS rn
                FROM reviews r ORDER BY r.rating DESC, r.id
            `);
            expect(r.errors).toHaveLength(0);
            const rating5 = r.rows.filter(row => row[0] === 5);
            expect(rating5.every(row => row[1] === 1)).toBe(true);
            expect(rating5.every(row => row[2] === 1)).toBe(true);
            expect(new Set(rating5.map(row => row[3])).size).toBe(rating5.length);
        });

        it('NTILE with fewer rows than buckets', () => {
            const r = run(ecommerce, `
                SELECT name, NTILE(10) OVER (ORDER BY price DESC) AS bucket
                FROM products WHERE category = 'books'
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows[0][1]).toBe(1);
        });

        it('windowed COUNT + SUM + AVG over partition', () => {
            const r = run(ecommerce, `
                SELECT p.name, p.category, p.price,
                    COUNT(*) OVER (PARTITION BY p.category) AS cat_count,
                    SUM(p.price) OVER (PARTITION BY p.category) AS cat_total,
                    ROUND(AVG(p.price) OVER (PARTITION BY p.category), 2) AS cat_avg,
                    p.price - AVG(p.price) OVER (PARTITION BY p.category) AS diff_from_avg
                FROM products p ORDER BY p.category, p.price DESC
            `);
            expect(r.errors).toHaveLength(0);
            const elec = r.rows.filter(row => row[1] === 'electronics');
            expect(elec.every(row => row[3] === 4)).toBe(true);
        });

        it('FIRST_VALUE + LAST_VALUE use the implicit ordered frame', () => {
            const r = run(ecommerce, `
                SELECT p.category, p.name, p.price,
                    FIRST_VALUE(p.name) OVER (PARTITION BY p.category ORDER BY p.price DESC) AS most_expensive,
                    LAST_VALUE(p.name) OVER (PARTITION BY p.category ORDER BY p.price DESC) AS cheapest
                FROM products p ORDER BY p.category, p.price DESC
            `);
            expect(r.errors).toHaveLength(0);
            const clothing = r.rows.filter(row => row[0] === 'clothing');
            expect(clothing.every(row => row[3] === 'Pants')).toBe(true);
            expect(clothing.map(row => row[4])).toEqual(['Pants', 'Shirt']);
        });
    });

    // ── JOIN combinations ──

    describe('join combinations', () => {
        it('LEFT + RIGHT + INNER chained', () => {
            const r = run(ecommerce, `
                SELECT c.name, o.id AS order_id, oi.product_id
                FROM customers c
                LEFT JOIN orders o ON o.customer_id = c.id AND o.status = 'completed'
                INNER JOIN order_items oi ON oi.order_id = o.id
                ORDER BY c.name, o.id
            `);
            expect(r.errors).toHaveLength(0);
        });

        it('self-join: customers in same country', () => {
            const r = run(ecommerce, `
                SELECT c1.name AS person1, c2.name AS person2, c1.country
                FROM customers c1
                JOIN customers c2 ON c1.country = c2.country AND c1.id < c2.id
                ORDER BY c1.country, c1.name
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBeGreaterThan(0);
        });

        it('CROSS JOIN with filter', () => {
            const r = run(ecommerce, `
                SELECT c.name, p.name AS product
                FROM customers c CROSS JOIN products p
                WHERE c.vip = TRUE AND p.price > 500
                ORDER BY c.name, p.name
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBe(6);
        });

        it('FULL JOIN finds orphans on both sides', () => {
            const r = run(`
                CREATE TABLE left_t (k INT, v TEXT);
                CREATE TABLE right_t (k INT, v TEXT);
                INSERT INTO left_t VALUES (1,'L1'),(2,'L2'),(3,'L3');
                INSERT INTO right_t VALUES (2,'R2'),(4,'R4'),(5,'R5');
            `, `
                SELECT
                    COALESCE(l.k, r.k) AS key,
                    l.v AS left_val, r.v AS right_val,
                    IIF(l.k IS NOT NULL AND r.k IS NOT NULL, 'both',
                        IIF(l.k IS NOT NULL, 'left', 'right')) AS side
                FROM left_t l FULL OUTER JOIN right_t r ON l.k = r.k
                ORDER BY key
            `);
            expect(r.rows).toEqual([
                [1, 'L1', null, 'left'],
                [2, 'L2', 'R2', 'both'],
                [3, 'L3', null, 'left'],
                [4, null, 'R4', 'right'],
                [5, null, 'R5', 'right'],
            ]);
        });
    });

    // ── Set operations stress ──

    describe('set operations stress', () => {
        it('UNION removes exact duplicates only', () => {
            const r = run(ecommerce, `
                SELECT name, price FROM products WHERE category = 'electronics'
                UNION
                SELECT name, price FROM products WHERE price > 300
            `);
            expect(r.errors).toHaveLength(0);
            const names = r.rows.map(row => row[0]);
            expect(new Set(names).size).toBe(names.length);
        });

        it('EXCEPT with complex WHERE', () => {
            const r = run(ecommerce, `
                SELECT c.id, c.name FROM customers c WHERE c.country = 'US'
                EXCEPT
                SELECT c.id, c.name FROM customers c
                WHERE c.id IN (SELECT o.customer_id FROM orders o WHERE o.status = 'completed')
            `);
            expect(r.errors).toHaveLength(0);
        });

        it('INTERSECT finds common rows across aggregated CTEs', () => {
            const r = run(ecommerce, `
                WITH high_rated AS (
                    SELECT product_id FROM reviews WHERE rating >= 4 GROUP BY product_id
                ),
                high_revenue AS (
                    SELECT oi.product_id FROM order_items oi
                    GROUP BY oi.product_id HAVING SUM(oi.qty * oi.unit_price) > 500
                )
                SELECT p.name FROM products p WHERE p.id IN (SELECT product_id FROM high_rated)
                INTERSECT
                SELECT p.name FROM products p WHERE p.id IN (SELECT product_id FROM high_revenue)
                ORDER BY name
            `);
            expect(r.errors).toHaveLength(0);
        });
    });

    // ── Error robustness ──

    describe('error robustness', () => {
        it('division by zero returns NULL, not crash', () => {
            const r = run(ecommerce, `SELECT id, price / 0 AS div0 FROM products LIMIT 1`);
            expect(r.errors).toHaveLength(0);
            expect(r.rows[0][1]).toBe(null);
        });

        it('unknown table produces clear error', () => {
            const r = run(ecommerce, `SELECT * FROM nonexistent_table`);
            expect(r.errors.length).toBeGreaterThan(0);
            expect(r.errors[0].message).toContain('nonexistent_table');
        });

        it('unknown column produces clear error', () => {
            const r = run(ecommerce, `SELECT bad_column FROM products`);
            expect(r.errors.length).toBeGreaterThan(0);
        });

        it('ambiguous column across joined tables', () => {
            const r = run(ecommerce, `SELECT name FROM products p JOIN customers c ON c.id = 1 LIMIT 1`);
            expect(r.errors.length).toBeGreaterThan(0);
            expect(r.errors[0].message).toContain('ambiguous');
        });

        it('empty SELECT list', () => {
            const r = run(ecommerce, `SELECT FROM products`);
            expect(r.errors.length).toBeGreaterThan(0);
        });

        it('missing GROUP BY with mixed aggregate/non-aggregate still works', () => {
            const r = run(ecommerce, `SELECT category, COUNT(*) AS cnt FROM products GROUP BY category ORDER BY cnt DESC`);
            expect(r.errors).toHaveLength(0);
            expect(r.rows[0][1]).toBe(4);
        });
    });
});
