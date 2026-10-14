import { describe, it, expect } from 'vitest';
import { executeSelectQuery } from '@/features/query-view/lib/queryExecutor.js';

function col(name, type = 'TEXT') {
    return { name, type, pk: false, fk: false, notNull: false, unique: false, defaultVal: null };
}
function mkTables(...defs) {
    const m = new Map();
    for (const d of defs) m.set(d.name, d);
    return m;
}
function run(tables, query) { return executeSelectQuery({ tables, query }); }

const employees = {
    name: 'employees',
    columns: [col('id','INT'), col('name','TEXT'), col('dept','TEXT'), col('salary','NUMERIC'), col('hire_date','DATE'), col('metadata','JSONB')],
    rows: [
        { id: 1, name: 'Alice', dept: 'Eng', salary: 120000, hire_date: '2020-01-15', metadata: '{"level":"senior","skills":["go","rust"],"rating":4.8}' },
        { id: 2, name: 'Bob', dept: 'Eng', salary: 110000, hire_date: '2021-03-10', metadata: '{"level":"mid","skills":["java"],"rating":4.2}' },
        { id: 3, name: 'Carol', dept: 'Sales', salary: 95000, hire_date: '2019-06-01', metadata: '{"level":"senior","skills":["crm"],"rating":4.5}' },
        { id: 4, name: 'Dave', dept: 'Sales', salary: 105000, hire_date: '2022-09-20', metadata: '{"level":"junior","skills":["excel"],"rating":3.9}' },
        { id: 5, name: 'Eve', dept: 'Eng', salary: 130000, hire_date: '2018-11-05', metadata: '{"level":"principal","skills":["go","rust","c++"],"rating":4.9}' },
        { id: 6, name: 'Frank', dept: 'HR', salary: 85000, hire_date: '2023-02-14', metadata: '{"level":"junior","skills":["admin"],"rating":3.5}' },
        { id: 7, name: 'Grace', dept: 'HR', salary: 92000, hire_date: '2020-07-01', metadata: '{"level":"mid","skills":["recruiting"],"rating":4.0}' },
        { id: 8, name: 'Hank', dept: 'Eng', salary: 115000, hire_date: '2022-01-20', metadata: '{"level":"mid","skills":["python","sql"],"rating":4.3}' },
    ],
};

const projects = {
    name: 'projects',
    columns: [col('id','INT'), col('name','TEXT'), col('lead_id','INT'), col('budget','NUMERIC'), col('config','JSONB')],
    rows: [
        { id: 101, name: 'Atlas', lead_id: 1, budget: 500000, config: '{"priority":"high","phases":3,"tags":["core","v2"]}' },
        { id: 102, name: 'Beacon', lead_id: 3, budget: 300000, config: '{"priority":"medium","phases":2,"tags":["sales"]}' },
        { id: 103, name: 'Cascade', lead_id: 5, budget: 750000, config: '{"priority":"high","phases":5,"tags":["infra","core"]}' },
        { id: 104, name: 'Delta', lead_id: 8, budget: 200000, config: '{"priority":"low","phases":1,"tags":["internal"]}' },
    ],
};

// ═══════════════ JSON OPERATORS ═══════════════
describe('JSON: advanced operators', () => {
    it('->> with WHERE filter', () => {
        const r = run(mkTables(employees), `SELECT name FROM employees WHERE metadata->>'level' = 'senior'`);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.map(r=>r[0]).sort()).toEqual(['Alice','Carol']);
    });
    it('-> array then ->> index', () => {
        const r = run(mkTables(employees), `SELECT name, metadata->'skills'->>0 AS s FROM employees WHERE id = 5`);
        expect(r.rows[0]).toEqual(['Eve','go']);
    });
    it('->> numeric field comparison', () => {
        const r = run(mkTables(employees), `SELECT name FROM employees WHERE metadata->>'rating' > '4.5' ORDER BY name`);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBeGreaterThanOrEqual(2);
    });
    it('JSON_EXTRACT with array path', () => {
        const r = run(mkTables(employees), `SELECT JSON_EXTRACT(metadata, '$.skills') AS s FROM employees WHERE id = 1`);
        expect(r.errors).toHaveLength(0);
        expect(r.rows[0][0]).toContain('go');
    });
    it('JSON_VALUE nested path', () => {
        const r = run(mkTables(projects), `SELECT JSON_VALUE(config, '$.priority') AS p FROM projects WHERE id = 101`);
        expect(r.rows[0][0]).toBe('high');
    });
    it('chained JSON in JOIN condition', () => {
        const r = run(mkTables(employees, projects), `
            SELECT e.name, p.name AS proj, p.config->>'priority' AS pri
            FROM employees e JOIN projects p ON e.id = p.lead_id
            WHERE p.config->>'priority' = 'high' ORDER BY e.name
        `);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBe(2);
    });
    it('JSON ->> with CASE', () => {
        const r = run(mkTables(employees), `
            SELECT name, CASE WHEN metadata->>'level' = 'senior' THEN 'S'
                              WHEN metadata->>'level' = 'principal' THEN 'P' ELSE 'O' END AS tier
            FROM employees ORDER BY name
        `);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.find(r=>r[0]==='Eve')[1]).toBe('P');
        expect(r.rows.find(r=>r[0]==='Alice')[1]).toBe('S');
    });
    it('JSON ->> in GROUP BY', () => {
        const r = run(mkTables(employees), `
            SELECT metadata->>'level' AS lvl, COUNT(*) AS cnt
            FROM employees GROUP BY metadata->>'level' ORDER BY cnt DESC
        `);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBeGreaterThanOrEqual(3);
    });
});

// ═══════════════ :: CAST ═══════════════
describe(':: cast: edge cases', () => {
    it('string::INTEGER', () => {
        const t = { name: 't', columns: [col('v','TEXT')], rows: [{ v: '99' }] };
        const r = run(mkTables(t), `SELECT v::INTEGER AS n FROM t`);
        expect(r.rows[0][0]).toBe(99);
    });
    it('number::TEXT', () => {
        const t = { name: 't', columns: [col('v','NUMERIC')], rows: [{ v: 3.14 }] };
        const r = run(mkTables(t), `SELECT v::TEXT AS s FROM t`);
        expect(r.rows[0][0]).toBe('3.14');
    });
    it('NULL::INTEGER stays null', () => {
        const t = { name: 't', columns: [col('v','TEXT')], rows: [{ v: null }] };
        const r = run(mkTables(t), `SELECT v::INTEGER AS n FROM t`);
        expect(r.rows[0][0]).toBe(null);
    });
    it('column::BOOLEAN', () => {
        const t = { name: 't', columns: [col('v','TEXT')], rows: [{ v: 'true' }, { v: 'false' }] };
        const r = run(mkTables(t), `SELECT v::BOOLEAN AS b FROM t`);
        expect(r.rows[0][0]).toBe(true);
        expect(r.rows[1][0]).toBe(false);
    });
    it('function()::TEXT', () => {
        const r = run(mkTables(employees), `SELECT ROUND(salary / 1000.0, 1)::TEXT AS k FROM employees WHERE id = 1`);
        expect(r.rows[0][0]).toBe('120');
    });
});

// ═══════════════ ILIKE ═══════════════
describe('ILIKE: comprehensive', () => {
    it('ILIKE with _ wildcard', () => {
        const r = run(mkTables(employees), `SELECT name FROM employees WHERE name ILIKE '_ob'`);
        expect(r.rows[0][0]).toBe('Bob');
    });
    it('ILIKE %pattern% mixed case', () => {
        const r = run(mkTables(employees), `SELECT name FROM employees WHERE name ILIKE '%ANK%'`);
        expect(r.rows[0][0]).toBe('Frank');
    });
    it('NOT ILIKE filters correctly', () => {
        const r = run(mkTables(employees), `SELECT COUNT(*) AS c FROM employees WHERE name NOT ILIKE '%a%'`);
        expect(r.rows[0][0]).toBeLessThan(8);
    });
});

// ═══════════════ DATE FUNCTIONS ═══════════════
describe('Date functions: comprehensive', () => {
    it('YEAR + MONTH + DAY combined', () => {
        const r = run(mkTables(employees), `
            SELECT YEAR(hire_date) AS y, MONTH(hire_date) AS m, DAY(hire_date) AS d
            FROM employees WHERE id = 1
        `);
        expect(r.rows[0]).toEqual([2020, 1, 15]);
    });
    it('DATE_PART with QUARTER', () => {
        const r = run(mkTables(employees), `SELECT DATE_PART('quarter', hire_date) AS q FROM employees WHERE id = 3`);
        expect(r.rows[0][0]).toBe(2); // June = Q2
    });
    it('DATEDIFF years', () => {
        const t = { name: 't', columns: [col('d1','DATE'), col('d2','DATE')], rows: [{ d1: '2020-01-01', d2: '2025-06-15' }] };
        const r = run(mkTables(t), `SELECT DATEDIFF('year', d1, d2) AS diff FROM t`);
        expect(r.rows[0][0]).toBe(5);
    });
    it('STRFTIME format', () => {
        const r = run(mkTables(employees), `SELECT STRFTIME('%Y-%m-%d', hire_date) AS d FROM employees WHERE id = 1`);
        expect(r.rows[0][0]).toBe('2020-01-15');
    });
    it('DATE() truncates to date', () => {
        const t = { name: 't', columns: [col('ts','TIMESTAMP')], rows: [{ ts: '2024-06-15T14:30:00Z' }] };
        const r = run(mkTables(t), `SELECT DATE(ts) AS d FROM t`);
        expect(r.rows[0][0]).toBe('2024-06-15');
    });
    it('YEAR in GROUP BY', () => {
        const r = run(mkTables(employees), `
            SELECT YEAR(hire_date) AS y, COUNT(*) AS c FROM employees
            GROUP BY YEAR(hire_date) ORDER BY y
        `);
        expect(r.errors).toHaveLength(0);
        expect(r.rows[0][0]).toBe(2018);
    });
});

// ═══════════════ STRING FUNCTIONS ═══════════════
describe('String functions: LEFT, RIGHT, CONCAT_WS', () => {
    it('LEFT on NULL returns NULL', () => {
        const t = { name: 't', columns: [col('v','TEXT')], rows: [{ v: null }] };
        const r = run(mkTables(t), `SELECT LEFT(v, 3) AS l FROM t`);
        expect(r.rows[0][0]).toBe(null);
    });
    it('RIGHT(0) returns empty', () => {
        const t = { name: 't', columns: [col('v','TEXT')], rows: [{ v: 'hello' }] };
        const r = run(mkTables(t), `SELECT RIGHT(v, 0) AS r FROM t`);
        expect(r.rows[0][0]).toBe('');
    });
    it('CONCAT_WS skips nulls', () => {
        const t = { name: 't', columns: [col('a','TEXT'), col('b','TEXT'), col('c','TEXT')], rows: [{ a: 'x', b: null, c: 'z' }] };
        const r = run(mkTables(t), `SELECT CONCAT_WS('-', a, b, c) AS s FROM t`);
        expect(r.rows[0][0]).toBe('x-z');
    });
});

// ═══════════════ WINDOW + JSON ═══════════════
describe('Window functions + JSON combined', () => {
    it('ROW_NUMBER with JSON partition', () => {
        const r = run(mkTables(employees), `
            SELECT name, metadata->>'level' AS lvl,
                   ROW_NUMBER() OVER (PARTITION BY metadata->>'level' ORDER BY salary DESC) AS rn
            FROM employees
        `);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBe(8);
    });
    it('RANK + :: cast in same query', () => {
        const r = run(mkTables(employees), `
            SELECT name, salary::TEXT AS sal_str,
                   RANK() OVER (ORDER BY salary DESC) AS rnk
            FROM employees
        `);
        expect(r.errors).toHaveLength(0);
        // Eve has highest salary (130000), so find her rank
        const eveRow = r.rows.find(row => row[0] === 'Eve');
        expect(eveRow[2]).toBe(1);
        expect(eveRow[1]).toBe('130000');
    });
});

// ═══════════════ COMPLEX ANALYTICS ═══════════════
describe('Complex analytics queries', () => {
    it('multi-CTE with JSON + window + aggregation', () => {
        const r = run(mkTables(employees, projects), `
            WITH dept_summary AS (
                SELECT dept, COUNT(*) AS cnt, AVG(salary) AS avg_sal,
                       MIN(salary) AS min_sal, MAX(salary) AS max_sal
                FROM employees GROUP BY dept
            ),
            project_leads AS (
                SELECT e.name, e.dept, p.name AS proj, p.budget,
                       p.config->>'priority' AS priority
                FROM employees e JOIN projects p ON e.id = p.lead_id
            )
            SELECT d.dept, d.cnt, d.avg_sal, pl.proj, pl.priority
            FROM dept_summary d
            LEFT JOIN project_leads pl ON d.dept = pl.dept
            ORDER BY d.dept, pl.proj
        `);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBeGreaterThanOrEqual(3);
    });

    it('correlated subquery with JSON access', () => {
        const r = run(mkTables(employees), `
            SELECT name, salary,
                (SELECT COUNT(*) FROM employees e2
                 WHERE e2.dept = 'Eng' AND e2.salary > 120000) AS higher_paid_eng
            FROM employees
            WHERE metadata->>'level' = 'senior'
            ORDER BY salary DESC
        `);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBe(2);
    });

    it('UNION ALL with :: cast and JSON', () => {
        const r = run(mkTables(employees, projects), `
            SELECT 'employee' AS type, name, salary::TEXT AS value FROM employees WHERE dept = 'HR'
            UNION ALL
            SELECT 'project' AS type, name, budget::TEXT AS value FROM projects WHERE config->>'priority' = 'low'
        `);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBe(3); // 2 HR + 1 low-priority project
    });

    it('EXCEPT with JSON filter', () => {
        const r = run(mkTables(employees), `
            SELECT name FROM employees WHERE dept = 'Eng'
            EXCEPT
            SELECT name FROM employees WHERE metadata->>'level' = 'mid'
        `);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBe(2); // Alice(senior) and Eve(principal)
    });

    it('self-join salary comparison with LEFT + ILIKE', () => {
        const r = run(mkTables(employees), `
            SELECT e1.name AS emp, e2.name AS higher,
                   LEFT(e1.name, 1) || '-' || LEFT(e2.name, 1) AS pair
            FROM employees e1
            JOIN employees e2 ON e1.dept = e2.dept AND e2.salary > e1.salary
            WHERE e1.name ILIKE '%o%'
            ORDER BY e1.name
        `);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBeGreaterThan(0);
    });

    it('aggregate + CASE + COALESCE + JSON', () => {
        const r = run(mkTables(employees), `
            SELECT dept,
                COUNT(*) AS total,
                SUM(CASE WHEN metadata->>'level' IN ('senior','principal') THEN 1 ELSE 0 END) AS senior_count,
                COALESCE(AVG(salary), 0) AS avg_sal,
                MAX(metadata->>'rating') AS top_rating
            FROM employees
            GROUP BY dept
            HAVING COUNT(*) >= 2
            ORDER BY avg_sal DESC
        `);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBe(3); // Eng(4), Sales(2), HR(2)
    });

    it('DENSE_RANK + BETWEEN + date functions', () => {
        const r = run(mkTables(employees), `
            SELECT name, salary, YEAR(hire_date) AS yr,
                   DENSE_RANK() OVER (ORDER BY salary DESC) AS drnk
            FROM employees
            WHERE YEAR(hire_date) BETWEEN 2019 AND 2022
            ORDER BY drnk
        `);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBeGreaterThanOrEqual(4);
    });

    it('IN subquery + JSON filter', () => {
        const r = run(mkTables(employees, projects), `
            SELECT name, dept FROM employees
            WHERE id IN (SELECT lead_id FROM projects WHERE config->>'priority' = 'high')
            ORDER BY name
        `);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBe(2);
    });

    it('EXISTS + correlated + aggregation', () => {
        const r = run(mkTables(employees, projects), `
            SELECT dept, AVG(salary) AS avg_sal
            FROM employees e
            WHERE EXISTS (
                SELECT 1 FROM projects p
                WHERE p.lead_id = e.id AND p.budget > 400000
            )
            GROUP BY dept
        `);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBeGreaterThanOrEqual(1);
    });

    it('NOT EXISTS filter', () => {
        const r = run(mkTables(employees, projects), `
            SELECT name FROM employees e
            WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.lead_id = e.id)
            ORDER BY name
        `);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBe(4);
    });

    it('LAG and LEAD window functions', () => {
        const r = run(mkTables(employees), `
            SELECT name, salary,
                   LAG(salary) OVER (ORDER BY salary) AS prev_sal,
                   LEAD(salary) OVER (ORDER BY salary) AS next_sal
            FROM employees WHERE dept = 'Eng' ORDER BY salary
        `);
        expect(r.errors).toHaveLength(0);
        expect(r.rows[0][2]).toBe(null); // first row LAG = null
        expect(r.rows[r.rows.length-1][3]).toBe(null); // last row LEAD = null
    });

    it('NULLIF + COALESCE pipeline', () => {
        const t = { name: 't', columns: [col('v','TEXT')], rows: [{ v: '' }, { v: 'hello' }, { v: null }] };
        const r = run(mkTables(t), `SELECT COALESCE(NULLIF(v, ''), 'default') AS result FROM t`);
        expect(r.rows[0][0]).toBe('default');
        expect(r.rows[1][0]).toBe('hello');
        expect(r.rows[2][0]).toBe('default');
    });
});

// ═══════════════ FULL STRING FUNCTION COVERAGE ═══════════════
describe('String functions: full coverage', () => {
    const t = { name: 't', columns: [col('v','TEXT')], rows: [{ v: '  Hello World  ' }] };

    it('TRIM', () => {
        const r = run(mkTables(t), `SELECT TRIM(v) AS r FROM t`);
        expect(r.rows[0][0]).toBe('Hello World');
    });
    it('LTRIM', () => {
        const r = run(mkTables(t), `SELECT LTRIM(v) AS r FROM t`);
        expect(r.rows[0][0]).toBe('Hello World  ');
    });
    it('RTRIM', () => {
        const r = run(mkTables(t), `SELECT RTRIM(v) AS r FROM t`);
        expect(r.rows[0][0]).toBe('  Hello World');
    });
    it('SUBSTRING(v, 3, 5)', () => {
        const r = run(mkTables(t), `SELECT SUBSTRING(v, 3, 5) AS r FROM t`);
        expect(r.rows[0][0]).toBe('Hello');
    });
    it('SUBSTR(v, 3)', () => {
        const s = { name: 's', columns: [col('v','TEXT')], rows: [{ v: 'abcdef' }] };
        const r = run(mkTables(s), `SELECT SUBSTR(v, 3) AS r FROM s`);
        expect(r.rows[0][0]).toBe('cdef');
    });
    it('REPLACE', () => {
        const s = { name: 's', columns: [col('v','TEXT')], rows: [{ v: 'foo-bar-baz' }] };
        const r = run(mkTables(s), `SELECT REPLACE(v, '-', '_') AS r FROM s`);
        expect(r.rows[0][0]).toBe('foo_bar_baz');
    });
    it('REVERSE', () => {
        const s = { name: 's', columns: [col('v','TEXT')], rows: [{ v: 'abc' }] };
        const r = run(mkTables(s), `SELECT REVERSE(v) AS r FROM s`);
        expect(r.rows[0][0]).toBe('cba');
    });
    it('REPEAT', () => {
        const s = { name: 's', columns: [col('v','TEXT')], rows: [{ v: 'ha' }] };
        const r = run(mkTables(s), `SELECT REPEAT(v, 3) AS r FROM s`);
        expect(r.rows[0][0]).toBe('hahaha');
    });
    it('LPAD', () => {
        const s = { name: 's', columns: [col('v','TEXT')], rows: [{ v: '42' }] };
        const r = run(mkTables(s), `SELECT LPAD(v, 5, '0') AS r FROM s`);
        expect(r.rows[0][0]).toBe('00042');
    });
    it('RPAD', () => {
        const s = { name: 's', columns: [col('v','TEXT')], rows: [{ v: 'hi' }] };
        const r = run(mkTables(s), `SELECT RPAD(v, 5, '.') AS r FROM s`);
        expect(r.rows[0][0]).toBe('hi...');
    });
    it('POSITION / STRPOS', () => {
        const s = { name: 's', columns: [col('v','TEXT')], rows: [{ v: 'hello world' }] };
        const r = run(mkTables(s), `SELECT STRPOS(v, 'world') AS r FROM s`);
        expect(r.rows[0][0]).toBe(7);
    });
    it('LEN (MSSQL alias)', () => {
        const s = { name: 's', columns: [col('v','TEXT')], rows: [{ v: 'test' }] };
        const r = run(mkTables(s), `SELECT LEN(v) AS r FROM s`);
        expect(r.rows[0][0]).toBe(4);
    });
    it('INITCAP', () => {
        const s = { name: 's', columns: [col('v','TEXT')], rows: [{ v: 'hello world foo' }] };
        const r = run(mkTables(s), `SELECT INITCAP(v) AS r FROM s`);
        expect(r.rows[0][0]).toBe('Hello World Foo');
    });
    it('TRANSLATE', () => {
        const s = { name: 's', columns: [col('v','TEXT')], rows: [{ v: 'abc123' }] };
        const r = run(mkTables(s), `SELECT TRANSLATE(v, 'abc', 'xyz') AS r FROM s`);
        expect(r.rows[0][0]).toBe('xyz123');
    });
    it('CONCAT', () => {
        const s = { name: 's', columns: [col('a','TEXT'), col('b','TEXT')], rows: [{ a: 'Hello', b: 'World' }] };
        const r = run(mkTables(s), `SELECT CONCAT(a, ' ', b) AS r FROM s`);
        expect(r.rows[0][0]).toBe('Hello World');
    });
    it('UPPER + LOWER', () => {
        const s = { name: 's', columns: [col('v','TEXT')], rows: [{ v: 'Hello' }] };
        const r = run(mkTables(s), `SELECT UPPER(v) AS u, LOWER(v) AS l FROM s`);
        expect(r.rows[0]).toEqual(['HELLO', 'hello']);
    });
});

// ═══════════════ MATH FUNCTION COVERAGE ═══════════════
describe('Math functions: full coverage', () => {
    it('ABS', () => {
        const t = { name: 't', columns: [col('v','INT')], rows: [{ v: -42 }] };
        const r = run(mkTables(t), `SELECT ABS(v) AS r FROM t`);
        expect(r.rows[0][0]).toBe(42);
    });
    it('CEIL / FLOOR', () => {
        const t = { name: 't', columns: [col('v','NUMERIC')], rows: [{ v: 3.7 }] };
        const r = run(mkTables(t), `SELECT CEIL(v) AS c, FLOOR(v) AS f FROM t`);
        expect(r.rows[0]).toEqual([4, 3]);
    });
    it('ROUND with precision', () => {
        const t = { name: 't', columns: [col('v','NUMERIC')], rows: [{ v: 3.14159 }] };
        const r = run(mkTables(t), `SELECT ROUND(v, 2) AS r FROM t`);
        expect(r.rows[0][0]).toBe(3.14);
    });
    it('POWER / SQRT', () => {
        const t = { name: 't', columns: [col('v','INT')], rows: [{ v: 9 }] };
        const r = run(mkTables(t), `SELECT POWER(v, 2) AS p, SQRT(v) AS s FROM t`);
        expect(r.rows[0]).toEqual([81, 3]);
    });
    it('MOD', () => {
        const t = { name: 't', columns: [col('v','INT')], rows: [{ v: 17 }] };
        const r = run(mkTables(t), `SELECT MOD(v, 5) AS r FROM t`);
        expect(r.rows[0][0]).toBe(2);
    });
    it('SIGN', () => {
        const t = { name: 't', columns: [col('a','INT'), col('b','INT'), col('c','INT')], rows: [{ a: -5, b: 0, c: 10 }] };
        const r = run(mkTables(t), `SELECT SIGN(a) AS sa, SIGN(b) AS sb, SIGN(c) AS sc FROM t`);
        expect(r.rows[0]).toEqual([-1, 0, 1]);
    });
    it('GREATEST / LEAST', () => {
        const t = { name: 't', columns: [col('a','INT'), col('b','INT'), col('c','INT')], rows: [{ a: 3, b: 7, c: 1 }] };
        const r = run(mkTables(t), `SELECT GREATEST(a, b, c) AS g, LEAST(a, b, c) AS l FROM t`);
        expect(r.rows[0]).toEqual([7, 1]);
    });
});

// ═══════════════ CAST() vs :: EQUIVALENCE ═══════════════
describe('CAST() function equivalence', () => {
    it('CAST(val AS INTEGER) = val::INTEGER', () => {
        const t = { name: 't', columns: [col('v','TEXT')], rows: [{ v: '42' }] };
        const r = run(mkTables(t), `SELECT CAST(v AS INTEGER) AS a, v::INTEGER AS b FROM t`);
        expect(r.rows[0][0]).toBe(r.rows[0][1]);
        expect(r.rows[0][0]).toBe(42);
    });
    it('CAST(num AS TEXT) = num::TEXT', () => {
        const t = { name: 't', columns: [col('v','NUMERIC')], rows: [{ v: 99.5 }] };
        const r = run(mkTables(t), `SELECT CAST(v AS TEXT) AS a, v::TEXT AS b FROM t`);
        expect(r.rows[0][0]).toBe(r.rows[0][1]);
    });
    it('CAST in WHERE clause', () => {
        const r = run(mkTables(employees), `SELECT name FROM employees WHERE CAST(salary AS TEXT) LIKE '12%' ORDER BY name`);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBeGreaterThanOrEqual(1);
    });
});

// ═══════════════ MORE DATE FUNCTIONS ═══════════════
describe('Date functions: DATEADD, DATE_TRUNC, EXTRACT', () => {
    const t = { name: 't', columns: [col('ts','TIMESTAMP')], rows: [{ ts: '2024-06-15T14:30:45Z' }] };

    it('DATEADD DAY', () => {
        const r = run(mkTables(t), `SELECT DATEADD('day', 10, ts) AS r FROM t`);
        expect(r.errors).toHaveLength(0);
        expect(r.rows[0][0]).toContain('2024-06-25');
    });
    it('DATEADD MONTH', () => {
        const r = run(mkTables(t), `SELECT DATEADD('month', 3, ts) AS r FROM t`);
        expect(r.rows[0][0]).toContain('2024-09');
    });
    it('DATE_TRUNC year', () => {
        const r = run(mkTables(t), `SELECT DATE_TRUNC('year', ts) AS r FROM t`);
        expect(r.errors).toHaveLength(0);
        const d = new Date(r.rows[0][0]);
        // Should be Jan 1 of same year (allow for timezone offset)
        expect(d.getMonth()).toBe(0);    // January
        expect(d.getDate()).toBeLessThanOrEqual(1);
    });
    it('DATE_TRUNC month', () => {
        const r = run(mkTables(t), `SELECT DATE_TRUNC('month', ts) AS r FROM t`);
        const val = r.rows[0][0];
        expect(val).toContain('2024');
        expect(new Date(val).getDate()).toBe(1);
    });
    it('EXTRACT(dow)', () => {
        const r = run(mkTables(t), `SELECT EXTRACT('dow', ts) AS r FROM t`);
        expect(r.errors).toHaveLength(0);
        expect(typeof r.rows[0][0]).toBe('number');
    });
    it('EXTRACT(epoch)', () => {
        const r = run(mkTables(t), `SELECT EXTRACT('epoch', ts) AS r FROM t`);
        expect(r.rows[0][0]).toBeGreaterThan(0);
    });
    it('DATEDIFF months', () => {
        const s = { name: 's', columns: [col('d1','DATE'), col('d2','DATE')], rows: [{ d1: '2024-01-15', d2: '2024-06-20' }] };
        const r = run(mkTables(s), `SELECT DATEDIFF('month', d1, d2) AS r FROM s`);
        expect(r.rows[0][0]).toBe(5);
    });
    it('HOUR + MINUTE + SECOND', () => {
        const r = run(mkTables(t), `SELECT HOUR(ts) AS h, MINUTE(ts) AS m, SECOND(ts) AS s FROM t`);
        // Time may be offset by local timezone, just verify they are numbers
        expect(r.errors).toHaveLength(0);
        expect(typeof r.rows[0][0]).toBe('number');
        expect(r.rows[0][1]).toBe(30);
        expect(r.rows[0][2]).toBe(45);
    });
});

// ═══════════════ IIF (MSSQL) ═══════════════
describe('IIF function (MSSQL)', () => {
    it('basic IIF', () => {
        const r = run(mkTables(employees), `SELECT name, IIF(salary > 100000, 'high', 'low') AS band FROM employees WHERE id = 1`);
        expect(r.rows[0]).toEqual(['Alice', 'high']);
    });
    it('IIF with NULL', () => {
        const t = { name: 't', columns: [col('v','INT')], rows: [{ v: null }] };
        const r = run(mkTables(t), `SELECT IIF(v > 0, 'pos', 'other') AS r FROM t`);
        expect(r.rows[0][0]).toBe('other');
    });
});

// ═══════════════ TYPEOF (SQLite) ═══════════════
describe('TYPEOF function', () => {
    it('integer', () => {
        const t = { name: 't', columns: [col('v','INT')], rows: [{ v: 42 }] };
        const r = run(mkTables(t), `SELECT TYPEOF(v) AS r FROM t`);
        expect(r.rows[0][0]).toBe('integer');
    });
    it('text', () => {
        const t = { name: 't', columns: [col('v','TEXT')], rows: [{ v: 'abc' }] };
        const r = run(mkTables(t), `SELECT TYPEOF(v) AS r FROM t`);
        expect(r.rows[0][0]).toBe('text');
    });
    it('null', () => {
        const t = { name: 't', columns: [col('v','TEXT')], rows: [{ v: null }] };
        const r = run(mkTables(t), `SELECT TYPEOF(v) AS r FROM t`);
        expect(r.rows[0][0]).toBe('null');
    });
    it('real', () => {
        const t = { name: 't', columns: [col('v','NUMERIC')], rows: [{ v: 3.14 }] };
        const r = run(mkTables(t), `SELECT TYPEOF(v) AS r FROM t`);
        expect(r.rows[0][0]).toBe('real');
    });
});

// ═══════════════ NTILE WINDOW FUNCTION ═══════════════
describe('NTILE window function', () => {
    it('NTILE(4) divides into quartiles', () => {
        const r = run(mkTables(employees), `
            SELECT name, salary, NTILE(4) OVER (ORDER BY salary) AS quartile
            FROM employees
        `);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBe(8);
        const quartiles = r.rows.map(r => r[2]);
        expect(Math.min(...quartiles)).toBe(1);
        expect(Math.max(...quartiles)).toBe(4);
    });
});
