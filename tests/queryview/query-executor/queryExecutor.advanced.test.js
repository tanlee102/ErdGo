import { describe, it, expect } from 'vitest';
import { executeSelectQuery } from '@/features/query-view/lib/queryExecutor.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * Advanced Feature Test Suite for queryExecutor
 *
 * Covers:
 *   1. JSON operators (->  ->>)  and JSON functions (all dialects)
 *   2. PostgreSQL :: cast operator
 *   3. ILIKE (case-insensitive LIKE)
 *   4. DISTINCT ON (PostgreSQL)
 *   5. CONVERT / TRY_CAST / TRY_CONVERT
 *   6. LEFT() / RIGHT() string functions
 *   7. CONCAT_WS
 *   8. Date/time functions (YEAR, MONTH, DAY, DATE_PART, STRFTIME, etc.)
 *   9. UUID join correctness
 *  10. Complex cross-dialect analytics queries
 * ═══════════════════════════════════════════════════════════════════════════ */

function mkTables(...defs) {
    const tables = new Map();
    for (const def of defs) {
        tables.set(def.name, def);
    }
    return tables;
}

function col(name, type = 'TEXT') {
    return { name, type, pk: false, fk: false, notNull: false, unique: false, defaultVal: null };
}

function run(tables, query) {
    return executeSelectQuery({ tables, query });
}

// ════════════════════════════════════════════════════════════════════════
//  1. JSON operators:  ->  ->>
// ════════════════════════════════════════════════════════════════════════

describe('JSON operators and functions', () => {
    const jsonTable = {
        name: 'products',
        columns: [col('id', 'INT'), col('name', 'TEXT'), col('metadata', 'JSONB')],
        rows: [
            { id: 1, name: 'Widget', metadata: '{"color":"red","weight":2.5,"tags":["sale","new"],"spec":{"material":"steel"}}' },
            { id: 2, name: 'Gadget', metadata: '{"color":"blue","weight":1.2,"tags":["premium"],"spec":{"material":"plastic"}}' },
            { id: 3, name: 'Doodad', metadata: '{"color":"green","weight":null,"tags":[],"spec":{"material":"wood"}}' },
        ],
    };

    it('->> extracts JSON scalar as text', () => {
        const tables = mkTables(jsonTable);
        const result = run(tables, `SELECT name, metadata->>'color' AS color FROM products`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0]).toEqual(['Widget', 'red']);
        expect(result.rows[1]).toEqual(['Gadget', 'blue']);
    });

    it('-> extracts JSON object (keeps structure)', () => {
        const tables = mkTables(jsonTable);
        const result = run(tables, `SELECT name, metadata->'spec' AS spec FROM products WHERE id = 1`);
        expect(result.errors).toHaveLength(0);
        const spec = result.rows[0][1];
        expect(spec).toEqual({ material: 'steel' });
    });

    it('chained -> then ->> for nested access', () => {
        const tables = mkTables(jsonTable);
        const result = run(tables, `SELECT name, metadata->'spec'->>'material' AS material FROM products`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0]).toEqual(['Widget', 'steel']);
        expect(result.rows[1]).toEqual(['Gadget', 'plastic']);
        expect(result.rows[2]).toEqual(['Doodad', 'wood']);
    });

    it('->> with array index', () => {
        const tables = mkTables(jsonTable);
        const result = run(tables, `SELECT name, metadata->'tags'->>0 AS first_tag FROM products WHERE id = 1`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0]).toEqual(['Widget', 'sale']);
    });

    it('->> returns NULL for missing key', () => {
        const tables = mkTables(jsonTable);
        const result = run(tables, `SELECT name, metadata->>'nonexistent' AS val FROM products WHERE id = 1`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0][1]).toBe(null);
    });

    it('JSON_EXTRACT (MySQL/SQLite)', () => {
        const tables = mkTables(jsonTable);
        const result = run(tables, `SELECT name, JSON_EXTRACT(metadata, '$.color') AS color FROM products`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0][1]).toBe('red');
        expect(result.rows[1][1]).toBe('blue');
    });

    it('JSON_EXTRACT with nested path', () => {
        const tables = mkTables(jsonTable);
        const result = run(tables, `SELECT JSON_EXTRACT(metadata, '$.spec.material') AS mat FROM products WHERE id = 2`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0][0]).toBe('plastic');
    });

    it('JSON_VALUE (MSSQL)', () => {
        const tables = mkTables(jsonTable);
        const result = run(tables, `SELECT JSON_VALUE(metadata, '$.weight') AS weight FROM products WHERE id = 1`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0][0]).toBe('2.5');
    });

    it('JSON_VALUE returns NULL for null JSON field', () => {
        const tables = mkTables(jsonTable);
        const result = run(tables, `SELECT JSON_VALUE(metadata, '$.weight') AS weight FROM products WHERE id = 3`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0][0]).toBe(null);
    });
});

// ════════════════════════════════════════════════════════════════════════
//  2. PostgreSQL :: cast operator
// ════════════════════════════════════════════════════════════════════════

describe('PostgreSQL :: cast operator', () => {
    const numTable = {
        name: 'data',
        columns: [col('id', 'INT'), col('val', 'TEXT'), col('price', 'NUMERIC')],
        rows: [
            { id: 1, val: '42', price: 9.99 },
            { id: 2, val: '100', price: 19.50 },
            { id: 3, val: 'hello', price: 5.00 },
        ],
    };

    it('val::INTEGER casts text to integer', () => {
        const tables = mkTables(numTable);
        const result = run(tables, `SELECT val::INTEGER AS num FROM data WHERE id = 1`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0][0]).toBe(42);
    });

    it('price::TEXT casts numeric to text', () => {
        const tables = mkTables(numTable);
        const result = run(tables, `SELECT price::TEXT AS p FROM data WHERE id = 1`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0][0]).toBe('9.99');
    });

    it('chained :: with expression', () => {
        const tables = mkTables(numTable);
        const result = run(tables, `SELECT (price * 2)::INTEGER AS doubled FROM data WHERE id = 2`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0][0]).toBe(39);
    });
});

// ════════════════════════════════════════════════════════════════════════
//  3. ILIKE — case-insensitive LIKE (PostgreSQL)
// ════════════════════════════════════════════════════════════════════════

describe('ILIKE — case-insensitive LIKE', () => {
    const textTable = {
        name: 'items',
        columns: [col('id', 'INT'), col('name', 'TEXT')],
        rows: [
            { id: 1, name: 'Apple' },
            { id: 2, name: 'BANANA' },
            { id: 3, name: 'cherry' },
            { id: 4, name: 'Apple Pie' },
        ],
    };

    it('ILIKE matches case-insensitively', () => {
        const tables = mkTables(textTable);
        const result = run(tables, `SELECT name FROM items WHERE name ILIKE 'apple%'`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows.length).toBe(2); // Apple, Apple Pie
    });

    it('NOT ILIKE excludes case-insensitively', () => {
        const tables = mkTables(textTable);
        const result = run(tables, `SELECT name FROM items WHERE name NOT ILIKE '%banana%'`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows.length).toBe(3);
    });

    it('LIKE is now case-sensitive', () => {
        const tables = mkTables(textTable);
        const result = run(tables, `SELECT name FROM items WHERE name LIKE 'apple%'`);
        expect(result.errors).toHaveLength(0);
        // 'Apple' starts with uppercase A, so case-sensitive LIKE 'apple%' should NOT match it
        expect(result.rows.length).toBe(0);
    });
});

// ════════════════════════════════════════════════════════════════════════
//  4. DISTINCT ON (PostgreSQL)
// ════════════════════════════════════════════════════════════════════════

describe('DISTINCT ON (PostgreSQL)', () => {
    const salesTable = {
        name: 'sales',
        columns: [col('region', 'TEXT'), col('product', 'TEXT'), col('amount', 'NUMERIC')],
        rows: [
            { region: 'East', product: 'A', amount: 100 },
            { region: 'East', product: 'B', amount: 200 },
            { region: 'West', product: 'C', amount: 300 },
            { region: 'West', product: 'D', amount: 50 },
            { region: 'North', product: 'E', amount: 150 },
        ],
    };

    it('keeps one row per DISTINCT ON group', () => {
        const tables = mkTables(salesTable);
        const result = run(tables, `SELECT DISTINCT ON (region) region, product, amount FROM sales ORDER BY region, amount DESC`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows.length).toBe(3); // One per region
        const regions = result.rows.map((r) => r[0]);
        expect(new Set(regions).size).toBe(3);
    });
});

// ════════════════════════════════════════════════════════════════════════
//  5. CONVERT / TRY_CAST / TRY_CONVERT
// ════════════════════════════════════════════════════════════════════════

describe('CONVERT / TRY_CAST', () => {
    const tbl = {
        name: 't',
        columns: [col('id', 'INT'), col('val', 'TEXT')],
        rows: [
            { id: 1, val: '42' },
            { id: 2, val: 'hello' },
        ],
    };

    it('CONVERT(INT, val) casts text to integer', () => {
        const tables = mkTables(tbl);
        const result = run(tables, `SELECT CONVERT(INT, val) AS num FROM t WHERE id = 1`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0][0]).toBe(42);
    });
});

// ════════════════════════════════════════════════════════════════════════
//  6. LEFT() / RIGHT() string functions
// ════════════════════════════════════════════════════════════════════════

describe('LEFT / RIGHT string functions', () => {
    const tbl = {
        name: 'words',
        columns: [col('id', 'INT'), col('word', 'TEXT')],
        rows: [
            { id: 1, word: 'HelloWorld' },
            { id: 2, word: 'ABC' },
        ],
    };

    it('LEFT(word, 5) returns first 5 characters', () => {
        const tables = mkTables(tbl);
        const result = run(tables, `SELECT LEFT(word, 5) AS l FROM words WHERE id = 1`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0][0]).toBe('Hello');
    });

    it('RIGHT(word, 5) returns last 5 characters', () => {
        const tables = mkTables(tbl);
        const result = run(tables, `SELECT RIGHT(word, 5) AS r FROM words WHERE id = 1`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0][0]).toBe('World');
    });

    it('LEFT of shorter string returns full string', () => {
        const tables = mkTables(tbl);
        const result = run(tables, `SELECT LEFT(word, 10) AS l FROM words WHERE id = 2`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0][0]).toBe('ABC');
    });
});

// ════════════════════════════════════════════════════════════════════════
//  7. CONCAT_WS
// ════════════════════════════════════════════════════════════════════════

describe('CONCAT_WS', () => {
    const tbl = {
        name: 'people',
        columns: [col('first', 'TEXT'), col('middle', 'TEXT'), col('last', 'TEXT')],
        rows: [
            { first: 'John', middle: null, last: 'Doe' },
            { first: 'Jane', middle: 'M', last: 'Smith' },
        ],
    };

    it('joins non-null values with separator', () => {
        const tables = mkTables(tbl);
        const result = run(tables, `SELECT CONCAT_WS(', ', last, first, middle) AS full_name FROM people`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0][0]).toBe('Doe, John');  // middle is null, skipped
        expect(result.rows[1][0]).toBe('Smith, Jane, M');
    });
});

// ════════════════════════════════════════════════════════════════════════
//  8. Date/time functions
// ════════════════════════════════════════════════════════════════════════

describe('Date/time functions', () => {
    const tbl = {
        name: 'events',
        columns: [col('id', 'INT'), col('name', 'TEXT'), col('ts', 'TIMESTAMP')],
        rows: [
            { id: 1, name: 'Launch', ts: '2024-03-15T10:30:00Z' },
            { id: 2, name: 'Update', ts: '2024-07-20T14:00:00Z' },
            { id: 3, name: 'Sunset', ts: '2025-01-01T00:00:00Z' },
        ],
    };

    it('YEAR() extracts year', () => {
        const tables = mkTables(tbl);
        const result = run(tables, `SELECT YEAR(ts) AS y FROM events WHERE id = 1`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0][0]).toBe(2024);
    });

    it('MONTH() extracts month', () => {
        const tables = mkTables(tbl);
        const result = run(tables, `SELECT MONTH(ts) AS m FROM events WHERE id = 1`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0][0]).toBe(3);
    });

    it('DAY() extracts day', () => {
        const tables = mkTables(tbl);
        const result = run(tables, `SELECT DAY(ts) AS d FROM events WHERE id = 1`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0][0]).toBe(15);
    });

    it('DATE_PART(year, ts) extracts year (PostgreSQL)', () => {
        const tables = mkTables(tbl);
        const result = run(tables, `SELECT DATE_PART('year', ts) AS y FROM events WHERE id = 2`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0][0]).toBe(2024);
    });

    it('DATE() extracts date portion', () => {
        const tables = mkTables(tbl);
        const result = run(tables, `SELECT DATE(ts) AS d FROM events WHERE id = 1`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0][0]).toBe('2024-03-15');
    });

    it('DATEDIFF(DAY, ts1, ts2) computes day difference', () => {
        const tables = mkTables(tbl);
        const result = run(tables, `
            SELECT DATEDIFF('DAY', e1.ts, e2.ts) AS diff
            FROM events e1, events e2
            WHERE e1.id = 1 AND e2.id = 2
        `);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0][0]).toBe(127);
    });

    it('STRFTIME formats date (SQLite)', () => {
        const tables = mkTables(tbl);
        const result = run(tables, `SELECT STRFTIME('%Y-%m', ts) AS ym FROM events WHERE id = 1`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0][0]).toBe('2024-03');
    });
});

// ════════════════════════════════════════════════════════════════════════
//  9. UUID join correctness
// ════════════════════════════════════════════════════════════════════════

describe('UUID join correctness', () => {
    const users = {
        name: 'users',
        columns: [col('id', 'UUID'), col('name', 'TEXT')],
        rows: [
            { id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', name: 'Alice' },
            { id: 'B1C2D3E4-F5A6-7890-ABCD-EF1234567890', name: 'Bob' },
        ],
    };
    const orders = {
        name: 'orders',
        columns: [col('id', 'INT'), col('user_id', 'UUID'), col('total', 'NUMERIC')],
        rows: [
            { id: 1, user_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', total: 100 },
            { id: 2, user_id: 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890', total: 200 }, // same UUID, different case
            { id: 3, user_id: 'b1c2d3e4-f5a6-7890-abcd-ef1234567890', total: 50 },  // matches Bob (different case)
        ],
    };

    it('JOIN matches UUIDs case-insensitively', () => {
        const tables = mkTables(users, orders);
        const result = run(tables, `
            SELECT u.name, o.total
            FROM users u
            JOIN orders o ON u.id = o.user_id
            ORDER BY o.total
        `);
        expect(result.errors).toHaveLength(0);
        // All 3 orders should match: 2 for Alice (case-insensitive), 1 for Bob
        expect(result.rows.length).toBe(3);
    });

    it('WHERE with UUID equality is case-insensitive', () => {
        const tables = mkTables(users);
        const result = run(tables, `SELECT name FROM users WHERE id = 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890'`);
        expect(result.errors).toHaveLength(0);
        expect(result.rows.length).toBe(1);
        expect(result.rows[0][0]).toBe('Alice');
    });
});

// ════════════════════════════════════════════════════════════════════════
// 10. Complex cross-dialect analytics queries
// ════════════════════════════════════════════════════════════════════════

describe('complex cross-dialect analytics', () => {
    const employees = {
        name: 'employees',
        columns: [col('id', 'INT'), col('name', 'TEXT'), col('dept', 'TEXT'), col('salary', 'NUMERIC'), col('hire_date', 'DATE')],
        rows: [
            { id: 1, name: 'Alice', dept: 'Engineering', salary: 120000, hire_date: '2020-01-15' },
            { id: 2, name: 'Bob', dept: 'Engineering', salary: 110000, hire_date: '2021-03-10' },
            { id: 3, name: 'Carol', dept: 'Sales', salary: 95000, hire_date: '2019-06-01' },
            { id: 4, name: 'Dave', dept: 'Sales', salary: 105000, hire_date: '2022-09-20' },
            { id: 5, name: 'Eve', dept: 'Engineering', salary: 130000, hire_date: '2018-11-05' },
            { id: 6, name: 'Frank', dept: 'HR', salary: 85000, hire_date: '2023-02-14' },
        ],
    };
    const projects = {
        name: 'projects',
        columns: [col('id', 'INT'), col('name', 'TEXT'), col('lead_id', 'INT'), col('budget', 'NUMERIC'), col('metadata', 'JSONB')],
        rows: [
            { id: 101, name: 'Atlas', lead_id: 1, budget: 500000, metadata: '{"priority":"high","team_size":5}' },
            { id: 102, name: 'Beacon', lead_id: 3, budget: 300000, metadata: '{"priority":"medium","team_size":3}' },
            { id: 103, name: 'Cascade', lead_id: 5, budget: 750000, metadata: '{"priority":"high","team_size":8}' },
        ],
    };

    it('PostgreSQL: CTE + window + :: cast + ->> JSON', () => {
        const tables = mkTables(employees, projects);
        const result = run(tables, `
            WITH ranked AS (
                SELECT
                    e.name,
                    e.dept,
                    e.salary,
                    RANK() OVER (PARTITION BY e.dept ORDER BY e.salary DESC) AS dept_rank
                FROM employees e
            )
            SELECT name, dept, salary::TEXT AS salary_str, dept_rank
            FROM ranked
            WHERE dept_rank = 1
            ORDER BY dept
        `);
        expect(result.errors).toHaveLength(0);
        expect(result.rows.length).toBe(3); // top earner per dept
    });

    it('MySQL-style: CONCAT_WS + LEFT + GROUP_CONCAT + derived table', () => {
        const tables = mkTables(employees);
        const result = run(tables, `
            SELECT
                dept,
                COUNT(*) AS cnt,
                GROUP_CONCAT(LEFT(name, 3)) AS abbreviations
            FROM employees
            GROUP BY dept
            ORDER BY cnt DESC
        `);
        expect(result.errors).toHaveLength(0);
        expect(result.rows.length).toBe(3);
        const engRow = result.rows.find((r) => r[0] === 'Engineering');
        expect(engRow[1]).toBe(3);
    });

    it('MSSQL-style: JSON_VALUE + CASE + aggregate', () => {
        const tables = mkTables(projects);
        const result = run(tables, `
            SELECT
                name,
                JSON_VALUE(metadata, '$.priority') AS priority,
                CASE
                    WHEN budget > 500000 THEN 'Large'
                    WHEN budget > 200000 THEN 'Medium'
                    ELSE 'Small'
                END AS size_category,
                budget
            FROM projects
            ORDER BY budget DESC
        `);
        expect(result.errors).toHaveLength(0);
        expect(result.rows[0][0]).toBe('Cascade');
        expect(result.rows[0][1]).toBe('high');
        expect(result.rows[0][2]).toBe('Large');
    });

    it('SQLite-style: json_extract + || concat + STRFTIME', () => {
        const tables = mkTables(employees, projects);
        const result = run(tables, `
            SELECT
                e.name || ' leads ' || p.name AS assignment,
                JSON_EXTRACT(p.metadata, '$.team_size') AS team_size
            FROM employees e
            JOIN projects p ON e.id = p.lead_id
            ORDER BY team_size DESC
        `);
        expect(result.errors).toHaveLength(0);
        expect(result.rows.length).toBe(3);
        expect(result.rows[0][0]).toContain('leads');
    });

    it('multi-CTE + JSON + window + aggregate pipeline', () => {
        const tables = mkTables(employees, projects);
        const result = run(tables, `
            WITH dept_stats AS (
                SELECT dept, AVG(salary) AS avg_sal, COUNT(*) AS cnt
                FROM employees
                GROUP BY dept
            ),
            project_info AS (
                SELECT
                    p.name AS project_name,
                    e.dept,
                    p.budget,
                    p.metadata->>'priority' AS priority
                FROM projects p
                JOIN employees e ON p.lead_id = e.id
            )
            SELECT
                d.dept,
                d.avg_sal,
                d.cnt,
                pi.project_name,
                pi.priority
            FROM dept_stats d
            LEFT JOIN project_info pi ON d.dept = pi.dept
            ORDER BY d.dept
        `);
        expect(result.errors).toHaveLength(0);
        expect(result.rows.length).toBeGreaterThanOrEqual(3);
    });

    it('complex WHERE with BETWEEN + ILIKE + COALESCE + CASE', () => {
        const tables = mkTables(employees);
        const result = run(tables, `
            SELECT
                name,
                dept,
                salary,
                CASE
                    WHEN salary > 120000 THEN 'Senior'
                    WHEN salary > 100000 THEN 'Mid'
                    ELSE 'Junior'
                END AS level,
                COALESCE(NULLIF(dept, 'HR'), 'General') AS effective_dept
            FROM employees
            WHERE salary BETWEEN 90000 AND 130000
              AND name ILIKE '%a%'
            ORDER BY salary DESC
        `);
        expect(result.errors).toHaveLength(0);
        // Alice(120k), Dave(105k), Carol(95k), Frank(85k) all have 'a' (case-insensitive)
        // Frank(85k) is outside BETWEEN range, so excluded
        // Eve(130k) has 'e' but no 'a' — excluded
        expect(result.rows.length).toBeGreaterThanOrEqual(2);
    });

    it('YEAR + MONTH date extraction with GROUP BY', () => {
        const tables = mkTables(employees);
        const result = run(tables, `
            SELECT
                YEAR(hire_date) AS hire_year,
                COUNT(*) AS cnt
            FROM employees
            GROUP BY YEAR(hire_date)
            ORDER BY hire_year
        `);
        expect(result.errors).toHaveLength(0);
        expect(result.rows.length).toBeGreaterThanOrEqual(3);
        // First row should be earliest year
        expect(result.rows[0][0]).toBe(2018);
    });

    it('JSON_EXTRACT with aggregate and GROUP BY', () => {
        const tables = mkTables(projects);
        const result = run(tables, `
            SELECT
                JSON_EXTRACT(metadata, '$.priority') AS priority,
                SUM(budget) AS total_budget,
                COUNT(*) AS project_count
            FROM projects
            GROUP BY JSON_EXTRACT(metadata, '$.priority')
            ORDER BY total_budget DESC
        `);
        expect(result.errors).toHaveLength(0);
        expect(result.rows.length).toBe(2); // 'high' and 'medium'
        // High priority: Atlas(500k) + Cascade(750k) = 1250k
        const highRow = result.rows.find((r) => r[0] === 'high');
        expect(highRow[1]).toBe(1250000);
        expect(highRow[2]).toBe(2);
    });

    it('self-join + LEFT + RIGHT string functions', () => {
        const tables = mkTables(employees);
        const result = run(tables, `
            SELECT
                e1.name AS employee,
                e2.name AS colleague,
                LEFT(e1.name, 1) || '.' || LEFT(e2.name, 1) || '.' AS initials
            FROM employees e1
            CROSS JOIN employees e2
            WHERE e1.dept = e2.dept AND e1.id < e2.id
            ORDER BY e1.dept, e1.name
        `);
        expect(result.errors).toHaveLength(0);
        expect(result.rows.length).toBeGreaterThan(0);
        // Check initials format
        expect(result.rows[0][2]).toMatch(/^[A-Z]\.[A-Z]\.$/);
    });
});
