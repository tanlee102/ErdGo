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

const baseSql = `
    CREATE TABLE users (id INT, name TEXT, active BOOLEAN, tier TEXT, score NUMERIC);
    INSERT INTO users (id, name, active, tier, score) VALUES
        (1, 'Alice', TRUE, 'pro', 90),
        (2, 'Bob', FALSE, 'free', 60),
        (3, 'Charlie', TRUE, 'pro', 90),
        (4, 'Dana', TRUE, 'free', 75),
        (5, 'Eve', FALSE, 'pro', NULL);

    CREATE TABLE orders (id INT, user_id INT, total NUMERIC, status TEXT);
    INSERT INTO orders (id, user_id, total, status) VALUES
        (10, 1, 99.5, 'paid'),
        (11, 1, 25, 'pending'),
        (12, 3, 125, 'paid'),
        (13, 4, 50, 'paid'),
        (14, 2, 30, 'refunded');
`;

describe('queryExecutor – hardening', () => {

    describe('predicate expressions in SELECT', () => {
        it('projects PostgreSQL-style boolean predicates as scalar values', () => {
            const r = runQuery(baseSql, `
                SELECT id,
                       score IS NULL AS missing_score,
                       active IS TRUE AS active_flag,
                       tier = 'pro' AS pro_user,
                       tier IS DISTINCT FROM 'pro' AS not_pro
                FROM users
                ORDER BY id
            `);

            expect(r.errors).toHaveLength(0);
            expect(r.rows).toEqual([
                [1, false, true, true, false],
                [2, false, false, false, true],
                [3, false, true, true, false],
                [4, false, true, false, true],
                [5, true, false, true, false],
            ]);
        });
    });

    // ─── UNION / INTERSECT / EXCEPT ────────────────────────────────────

    describe('UNION / INTERSECT / EXCEPT', () => {
        it('UNION ALL combines all rows', () => {
            const r = runQuery(baseSql, `
                SELECT id, name FROM users WHERE tier = 'pro'
                UNION ALL
                SELECT id, name FROM users WHERE active = TRUE
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBe(6); // 3 pro + 3 active (with overlap)
        });

        it('UNION removes duplicates', () => {
            const r = runQuery(baseSql, `
                SELECT id, name FROM users WHERE tier = 'pro'
                UNION
                SELECT id, name FROM users WHERE active = TRUE
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBe(4); // Alice, Charlie, Dana, Eve(pro)
        });

        it('INTERSECT returns common rows', () => {
            const r = runQuery(baseSql, `
                SELECT id, name FROM users WHERE tier = 'pro'
                INTERSECT
                SELECT id, name FROM users WHERE active = TRUE
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows).toEqual([[1, 'Alice'], [3, 'Charlie']]);
        });

        it('EXCEPT removes right-side rows', () => {
            const r = runQuery(baseSql, `
                SELECT id, name FROM users WHERE active = TRUE
                EXCEPT
                SELECT id, name FROM users WHERE tier = 'pro'
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows).toEqual([[4, 'Dana']]);
        });

        it('chained UNION ALL with 3 queries', () => {
            const r = runQuery(baseSql, `
                SELECT 1 AS v FROM users LIMIT 1
                UNION ALL
                SELECT 2 FROM users LIMIT 1
                UNION ALL
                SELECT 3 FROM users LIMIT 1
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows).toEqual([[1], [2], [3]]);
        });

        it('UNION column count mismatch produces error', () => {
            const r = runQuery(baseSql, `
                SELECT id, name FROM users
                UNION
                SELECT id FROM users
            `);
            expect(r.errors.length).toBeGreaterThan(0);
        });
    });

    // ─── RIGHT JOIN / FULL OUTER JOIN ──────────────────────────────────

    describe('RIGHT JOIN / FULL OUTER JOIN', () => {
        it('RIGHT JOIN returns all right rows with NULLs for unmatched left', () => {
            const r = runQuery(`
                CREATE TABLE a (id INT, val TEXT);
                CREATE TABLE b (id INT, val TEXT);
                INSERT INTO a (id, val) VALUES (1, 'a1'), (2, 'a2');
                INSERT INTO b (id, val) VALUES (2, 'b2'), (3, 'b3');
            `, `
                SELECT a.val, b.val
                FROM a RIGHT JOIN b ON a.id = b.id
                ORDER BY b.id
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows).toEqual([['a2', 'b2'], [null, 'b3']]);
        });

        it('FULL OUTER JOIN returns all rows from both sides', () => {
            const r = runQuery(`
                CREATE TABLE a (id INT, val TEXT);
                CREATE TABLE b (id INT, val TEXT);
                INSERT INTO a (id, val) VALUES (1, 'a1'), (2, 'a2');
                INSERT INTO b (id, val) VALUES (2, 'b2'), (3, 'b3');
            `, `
                SELECT a.id, a.val, b.id, b.val
                FROM a FULL OUTER JOIN b ON a.id = b.id
                ORDER BY COALESCE(a.id, b.id)
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows).toEqual([
                [1, 'a1', null, null],
                [2, 'a2', 2, 'b2'],
                [null, null, 3, 'b3'],
            ]);
        });
    });

    // ─── CAST ──────────────────────────────────────────────────────────

    describe('CAST expression', () => {
        it('CAST to INTEGER truncates decimals', () => {
            const r = runQuery(baseSql, `SELECT CAST(99.7 AS INTEGER) AS v FROM users LIMIT 1`);
            expect(r.errors).toHaveLength(0);
            expect(r.rows[0][0]).toBe(99);
        });

        it('CAST to TEXT converts number to string', () => {
            const r = runQuery(baseSql, `SELECT CAST(42 AS TEXT) AS v FROM users LIMIT 1`);
            expect(r.errors).toHaveLength(0);
            expect(r.rows[0][0]).toBe('42');
        });

        it('CAST NULL returns NULL', () => {
            const r = runQuery(baseSql, `SELECT CAST(NULL AS INTEGER) AS v FROM users LIMIT 1`);
            expect(r.errors).toHaveLength(0);
            expect(r.rows[0][0]).toBe(null);
        });
    });

    // ─── IIF ───────────────────────────────────────────────────────────

    describe('IIF (MSSQL/SQLite)', () => {
        it('IIF returns true branch', () => {
            const r = runQuery(baseSql, `SELECT id, IIF(score > 80, 'high', 'low') AS band FROM users WHERE id = 1`);
            expect(r.errors).toHaveLength(0);
            expect(r.rows).toEqual([[1, 'high']]);
        });

        it('IIF returns false branch', () => {
            const r = runQuery(baseSql, `SELECT id, IIF(score > 80, 'high', 'low') AS band FROM users WHERE id = 2`);
            expect(r.errors).toHaveLength(0);
            expect(r.rows).toEqual([[2, 'low']]);
        });
    });

    // ─── || concatenation and % modulo ─────────────────────────────────

    describe('|| concatenation and % modulo', () => {
        it('|| concatenates strings (PostgreSQL/SQLite)', () => {
            const r = runQuery(baseSql, `SELECT name || ' (' || tier || ')' AS label FROM users WHERE id = 1`);
            expect(r.errors).toHaveLength(0);
            expect(r.rows).toEqual([['Alice (pro)']]);
        });

        it('% returns modulo', () => {
            const r = runQuery(baseSql, `SELECT id, score % 7 AS remainder FROM users WHERE id = 1`);
            expect(r.errors).toHaveLength(0);
            expect(r.rows).toEqual([[1, 90 % 7]]);
        });
    });

    // ─── IS TRUE / IS FALSE ────────────────────────────────────────────

    describe('IS TRUE / IS FALSE / IS NOT TRUE', () => {
        it('IS TRUE filters truthy values', () => {
            const r = runQuery(baseSql, `SELECT id FROM users WHERE active IS TRUE ORDER BY id`);
            expect(r.errors).toHaveLength(0);
            expect(r.rows).toEqual([[1], [3], [4]]);
        });

        it('IS FALSE filters falsy values', () => {
            const r = runQuery(baseSql, `SELECT id FROM users WHERE active IS FALSE ORDER BY id`);
            expect(r.errors).toHaveLength(0);
            expect(r.rows).toEqual([[2], [5]]);
        });

        it('IS NOT TRUE includes false and null', () => {
            const r = runQuery(baseSql, `SELECT id FROM users WHERE active IS NOT TRUE ORDER BY id`);
            expect(r.errors).toHaveLength(0);
            expect(r.rows).toEqual([[2], [5]]);
        });
    });

    // ─── NULLS FIRST / NULLS LAST ──────────────────────────────────────

    describe('NULLS FIRST / NULLS LAST', () => {
        it('NULLS FIRST puts nulls at top', () => {
            const r = runQuery(baseSql, `SELECT id, score FROM users ORDER BY score ASC NULLS FIRST`);
            expect(r.errors).toHaveLength(0);
            expect(r.rows[0]).toEqual([5, null]);
        });

        it('NULLS LAST puts nulls at bottom', () => {
            const r = runQuery(baseSql, `SELECT id, score FROM users ORDER BY score DESC NULLS LAST`);
            expect(r.errors).toHaveLength(0);
            expect(r.rows[r.rows.length - 1]).toEqual([5, null]);
        });
    });

    // ─── IN subquery ───────────────────────────────────────────────────

    describe('IN subquery', () => {
        it('IN (SELECT ...) filters by subquery results', () => {
            const r = runQuery(baseSql, `
                SELECT name FROM users
                WHERE id IN (SELECT user_id FROM orders WHERE status = 'paid')
                ORDER BY name
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows).toEqual([['Alice'], ['Charlie'], ['Dana']]);
        });

        it('NOT IN (SELECT ...) excludes subquery results', () => {
            const r = runQuery(baseSql, `
                SELECT name FROM users
                WHERE id NOT IN (SELECT user_id FROM orders WHERE status = 'paid')
                ORDER BY name
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows).toEqual([['Bob'], ['Eve']]);
        });
    });

    // ─── LAG / LEAD window functions ───────────────────────────────────

    describe('LAG / LEAD window functions', () => {
        it('LAG returns previous row value', () => {
            const r = runQuery(baseSql, `
                SELECT id, score, LAG(score) OVER (ORDER BY id) AS prev_score
                FROM users ORDER BY id
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows[0][2]).toBe(null);   // first row has no previous
            expect(r.rows[1][2]).toBe(90);      // Alice's score
            expect(r.rows[2][2]).toBe(60);      // Bob's score
        });

        it('LEAD returns next row value with default', () => {
            const r = runQuery(baseSql, `
                SELECT id, score, LEAD(score, 1, -1) OVER (ORDER BY id) AS next_score
                FROM users ORDER BY id
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows[4][2]).toBe(-1);  // last row uses default
        });

        it('LAG with offset 2', () => {
            const r = runQuery(baseSql, `
                SELECT id, LAG(id, 2) OVER (ORDER BY id) AS prev2
                FROM users ORDER BY id
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows[0][1]).toBe(null);
            expect(r.rows[1][1]).toBe(null);
            expect(r.rows[2][1]).toBe(1);
        });
    });

    // ─── NTILE window function ─────────────────────────────────────────

    describe('NTILE window function', () => {
        it('NTILE distributes rows into buckets', () => {
            const r = runQuery(baseSql, `
                SELECT id, NTILE(3) OVER (ORDER BY id) AS bucket FROM users ORDER BY id
            `);
            expect(r.errors).toHaveLength(0);
            // 5 rows / 3 buckets = [1,1,2,2,3] distribution
            const buckets = r.rows.map((row) => row[1]);
            expect(buckets).toEqual([1, 1, 2, 2, 3]);
        });
    });

    // ─── FIRST_VALUE / LAST_VALUE ──────────────────────────────────────

    describe('FIRST_VALUE / LAST_VALUE', () => {
        it('FIRST_VALUE returns first row in partition', () => {
            const r = runQuery(baseSql, `
                SELECT id, tier,
                    FIRST_VALUE(name) OVER (PARTITION BY tier ORDER BY id) AS first_name
                FROM users ORDER BY id
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows[0][2]).toBe('Alice');     // pro partition first
            expect(r.rows[1][2]).toBe('Bob');        // free partition first
        });

        it('LAST_VALUE returns the last row in the implicit ordered frame', () => {
            const r = runQuery(baseSql, `
                SELECT id, tier,
                    LAST_VALUE(name) OVER (PARTITION BY tier ORDER BY id) AS last_name
                FROM users ORDER BY id
            `);
            expect(r.errors).toHaveLength(0);
            const proRows = r.rows.filter((row) => row[1] === 'pro');
            expect(proRows.map((row) => row[2])).toEqual(['Alice', 'Charlie', 'Eve']);
        });
    });

    // ─── New scalar functions ──────────────────────────────────────────

    describe('new scalar functions', () => {
        const fnSql = `
            CREATE TABLE vals (id INT, s TEXT, n NUMERIC);
            INSERT INTO vals (id, s, n) VALUES
                (1, '  Hello World  ', 3.7),
                (2, 'abcdef', -5.2),
                (3, NULL, NULL);
        `;

        it('TRIM removes whitespace', () => {
            const r = runQuery(fnSql, `SELECT TRIM(s) FROM vals WHERE id = 1`);
            expect(r.rows[0][0]).toBe('Hello World');
        });

        it('LTRIM / RTRIM', () => {
            const r = runQuery(fnSql, `SELECT LTRIM(s), RTRIM(s) FROM vals WHERE id = 1`);
            expect(r.rows[0][0]).toBe('Hello World  ');
            expect(r.rows[0][1]).toBe('  Hello World');
        });

        it('SUBSTR / SUBSTRING', () => {
            const r = runQuery(fnSql, `SELECT SUBSTR(s, 1, 3), SUBSTRING(s, 4, 3) FROM vals WHERE id = 2`);
            expect(r.rows[0]).toEqual(['abc', 'def']);
        });

        it('REPLACE', () => {
            const r = runQuery(fnSql, `SELECT REPLACE(s, 'abc', 'XYZ') FROM vals WHERE id = 2`);
            expect(r.rows[0][0]).toBe('XYZdef');
        });

        it('REVERSE', () => {
            const r = runQuery(fnSql, `SELECT REVERSE(s) FROM vals WHERE id = 2`);
            expect(r.rows[0][0]).toBe('fedcba');
        });

        it('LPAD / RPAD', () => {
            const r = runQuery(fnSql, `SELECT LPAD(s, 10, '0'), RPAD(s, 10, '.') FROM vals WHERE id = 2`);
            expect(r.rows[0]).toEqual(['0000abcdef', 'abcdef....']);
        });

        it('REPEAT', () => {
            const r = runQuery(fnSql, `SELECT REPEAT('ab', 3) FROM vals WHERE id = 1`);
            expect(r.rows[0][0]).toBe('ababab');
        });

        it('INSTR / POSITION', () => {
            const r = runQuery(fnSql, `SELECT INSTR(s, 'cd'), POSITION(s, 'ef') FROM vals WHERE id = 2`);
            expect(r.rows[0]).toEqual([3, 5]);
        });

        it('CEIL / FLOOR / SIGN', () => {
            const r = runQuery(fnSql, `SELECT CEIL(n), FLOOR(n), SIGN(n) FROM vals WHERE id = 1`);
            expect(r.rows[0]).toEqual([4, 3, 1]);
        });

        it('CEIL / FLOOR with negatives', () => {
            const r = runQuery(fnSql, `SELECT CEIL(n), FLOOR(n), SIGN(n) FROM vals WHERE id = 2`);
            expect(r.rows[0]).toEqual([-5, -6, -1]);
        });

        it('POWER / SQRT / MOD', () => {
            const r = runQuery(fnSql, `SELECT POWER(2, 10), SQRT(144), MOD(17, 5) FROM vals WHERE id = 1`);
            expect(r.rows[0]).toEqual([1024, 12, 2]);
        });

        it('GREATEST / LEAST', () => {
            const r = runQuery(fnSql, `SELECT GREATEST(1, 5, 3), LEAST(10, 2, 7) FROM vals WHERE id = 1`);
            expect(r.rows[0]).toEqual([5, 2]);
        });

        it('CHAR_LENGTH / CHARACTER_LENGTH', () => {
            const r = runQuery(fnSql, `SELECT CHAR_LENGTH(s), CHARACTER_LENGTH(s) FROM vals WHERE id = 2`);
            expect(r.rows[0]).toEqual([6, 6]);
        });

        it('TYPEOF (SQLite)', () => {
            const r = runQuery(fnSql, `SELECT TYPEOF(n), TYPEOF(s), TYPEOF(NULL) FROM vals WHERE id = 1`);
            expect(r.rows[0]).toEqual(['real', 'text', 'null']);
        });

        it('null propagation through new functions', () => {
            const r = runQuery(fnSql, `
                SELECT TRIM(s), CEIL(n), SUBSTR(s, 1, 3), REVERSE(s), GREATEST(n, 1)
                FROM vals WHERE id = 3
            `);
            expect(r.rows[0]).toEqual([null, null, null, null, 1]);
        });
    });

    // ─── Complex cross-dialect queries ─────────────────────────────────

    describe('complex cross-dialect queries', () => {
        it('PostgreSQL-style query with ||, CAST, LAG, and CTE', () => {
            const r = runQuery(baseSql, `
                WITH ranked AS (
                    SELECT
                        u.id,
                        u.name || ' [' || u.tier || ']' AS label,
                        COALESCE(u.score, 0) AS score,
                        LAG(COALESCE(u.score, 0)) OVER (ORDER BY u.id) AS prev_score,
                        ROW_NUMBER() OVER (PARTITION BY u.tier ORDER BY COALESCE(u.score, 0) DESC) AS rank_in_tier
                    FROM users u
                )
                SELECT label, score, prev_score, rank_in_tier
                FROM ranked
                WHERE rank_in_tier <= 2
                ORDER BY label
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBeGreaterThan(0);
            expect(r.rows[0][0]).toContain('['); // label has bracket
        });

        it('MSSQL-style with IIF, TOP, CAST, and RIGHT JOIN', () => {
            const r = runQuery(baseSql, `
                SELECT TOP 3
                    u.name,
                    IIF(o.total > 50, 'big', 'small') AS size,
                    CAST(COALESCE(o.total, 0) AS INTEGER) AS total_int
                FROM orders o
                RIGHT JOIN users u ON u.id = o.user_id
                ORDER BY u.id
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBe(3);
        });

        it('SQLite-style with TYPEOF, ||, SUBSTR, GROUP_CONCAT', () => {
            const r = runQuery(baseSql, `
                SELECT
                    u.tier,
                    GROUP_CONCAT(SUBSTR(u.name, 1, 3) ORDER BY u.name) AS initials,
                    COUNT(*) AS cnt
                FROM users u
                GROUP BY u.tier
                ORDER BY u.tier
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.columns.map((c) => c.label)).toEqual(['tier', 'initials', 'cnt']);
        });

        it('UNION with CTE and aggregates', () => {
            const r = runQuery(baseSql, `
                WITH paid AS (
                    SELECT user_id, SUM(total) AS spend FROM orders WHERE status = 'paid' GROUP BY user_id
                )
                SELECT name, spend FROM users u JOIN paid p ON p.user_id = u.id WHERE spend >= 100
                UNION ALL
                SELECT name, 0 FROM users WHERE id NOT IN (SELECT user_id FROM orders WHERE status = 'paid')
                ORDER BY name
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBeGreaterThan(0);
        });

        it('FULL JOIN with COALESCE and CASE', () => {
            const r = runQuery(`
                CREATE TABLE t1 (k INT, v1 TEXT);
                CREATE TABLE t2 (k INT, v2 TEXT);
                INSERT INTO t1 VALUES (1, 'a'), (2, 'b'), (3, 'c');
                INSERT INTO t2 VALUES (2, 'x'), (3, 'y'), (4, 'z');
            `, `
                SELECT
                    COALESCE(t1.k, t2.k) AS key,
                    CASE
                        WHEN t1.k IS NOT NULL AND t2.k IS NOT NULL THEN 'both'
                        WHEN t1.k IS NOT NULL THEN 'left_only'
                        ELSE 'right_only'
                    END AS source,
                    t1.v1,
                    t2.v2
                FROM t1 FULL OUTER JOIN t2 ON t1.k = t2.k
                ORDER BY key
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows).toEqual([
                [1, 'left_only', 'a', null],
                [2, 'both', 'b', 'x'],
                [3, 'both', 'c', 'y'],
                [4, 'right_only', null, 'z'],
            ]);
        });

        it('window functions with NTILE, FIRST_VALUE, and aggregates', () => {
            const r = runQuery(baseSql, `
                SELECT
                    u.name,
                    COALESCE(u.score, 0) AS score,
                    NTILE(2) OVER (ORDER BY COALESCE(u.score, 0) DESC) AS half,
                    FIRST_VALUE(u.name) OVER (ORDER BY COALESCE(u.score, 0) DESC) AS top_scorer
                FROM users u
                ORDER BY COALESCE(u.score, 0) DESC
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBe(5);
            // Top scorers (90) should be first
            expect(r.rows[0][3]).toBe(r.rows[0][0]); // first_value = first row's name
        });
    });

    // ─── Error handling ────────────────────────────────────────────────

    describe('error handling', () => {
        it('unknown function returns error', () => {
            const r = runQuery(baseSql, `SELECT FOOBAR(id) FROM users`);
            expect(r.errors.length).toBeGreaterThan(0);
        });

        it('CAST missing AS returns error', () => {
            const r = runQuery(baseSql, `SELECT CAST(42 INTEGER) FROM users`);
            expect(r.errors.length).toBeGreaterThan(0);
        });

        it('IIF with wrong arg count returns error', () => {
            const r = runQuery(baseSql, `SELECT IIF(1 > 0, 'yes') FROM users`);
            expect(r.errors.length).toBeGreaterThan(0);
        });

        it('NTILE without arg returns error', () => {
            const r = runQuery(baseSql, `SELECT NTILE() OVER (ORDER BY id) FROM users`);
            expect(r.errors.length).toBeGreaterThan(0);
        });

        it('LAG with too many args returns error', () => {
            const r = runQuery(baseSql, `SELECT LAG(id, 1, 0, 'extra') OVER (ORDER BY id) FROM users`);
            expect(r.errors.length).toBeGreaterThan(0);
        });
    });
});
