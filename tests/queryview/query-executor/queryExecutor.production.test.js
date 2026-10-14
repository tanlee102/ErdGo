import { describe, it, expect } from 'vitest';
import { executeSelectQuery } from '@/features/query-view/lib/queryExecutor.js';

function col(name, type = 'TEXT') {
    return { name, type, pk: false, fk: false, notNull: false, unique: false, defaultVal: null };
}
function mkTables(...defs) { const m = new Map(); for (const d of defs) m.set(d.name, d); return m; }
function run(tables, query) { return executeSelectQuery({ tables, query }); }

const emp = {
    name: 'employees', columns: [col('id','INT'), col('name'), col('dept'), col('salary','NUMERIC'), col('mgr_id','INT'), col('hire_date','DATE')],
    rows: [
        { id: 1, name: 'Alice', dept: 'Eng', salary: 120000, mgr_id: null, hire_date: '2020-01-15' },
        { id: 2, name: 'Bob', dept: 'Eng', salary: 110000, mgr_id: 1, hire_date: '2021-03-10' },
        { id: 3, name: 'Carol', dept: 'Sales', salary: 95000, mgr_id: null, hire_date: '2019-06-01' },
        { id: 4, name: 'Dave', dept: 'Sales', salary: 105000, mgr_id: 3, hire_date: '2022-09-20' },
        { id: 5, name: 'Eve', dept: 'Eng', salary: 130000, mgr_id: null, hire_date: '2018-11-05' },
        { id: 6, name: 'Frank', dept: 'HR', salary: 85000, mgr_id: null, hire_date: '2023-02-14' },
    ],
};

// ═══════════════ PostgreSQL Dialect ═══════════════
describe('PostgreSQL dialect', () => {
    it('reports unsupported PostgreSQL operators with source location', () => {
        const documents = {
            name: 'documents',
            columns: [col('id', 'INT'), col('payload', 'JSONB')],
            rows: [{ id: 1, payload: { region: 'apac' } }],
        };
        const r = run(mkTables(documents), `
            SELECT id
            FROM documents
            WHERE payload @> '{"region":"apac"}'::jsonb
        `);
        expect(r.errors).toHaveLength(1);
        expect(r.errors[0].message).toContain('Unsupported PostgreSQL operator @>');
        expect(r.errors[0].message).toMatch(/line \d+, column \d+/);
        expect(r.errors[0].position).toMatchObject({ line: 3, column: 27 });
        expect(r.rows).toEqual([]);
    });

    it(':: chain: expr::NUMERIC::TEXT', () => {
        const t = { name: 't', columns: [col('v','NUMERIC')], rows: [{ v: 42.7 }] };
        const r = run(mkTables(t), `SELECT v::INTEGER::TEXT AS s FROM t`);
        expect(r.errors).toHaveLength(0);
    });
    it('DISTINCT ON with ORDER BY', () => {
        const r = run(mkTables(emp), `SELECT DISTINCT ON (dept) dept, name, salary FROM employees ORDER BY dept, salary DESC`);
        expect(r.errors).toHaveLength(0);
        const depts = r.rows.map(r => r[0]);
        expect(new Set(depts).size).toBe(depts.length);
    });
    it('ILIKE in CASE WHEN', () => {
        const r = run(mkTables(emp), `
            SELECT name, CASE WHEN name ILIKE 'a%' THEN 'A-team' ELSE 'other' END AS grp FROM employees
        `);
        expect(r.rows.find(r => r[0] === 'Alice')[1]).toBe('A-team');
    });
    it('COALESCE + NULLIF + :: cast pipeline', () => {
        const t = { name: 't', columns: [col('v','TEXT')], rows: [{ v: '5' }, { v: '' }] };
        const r = run(mkTables(t), `SELECT COALESCE(NULLIF(v, ''), '99')::INTEGER AS n FROM t`);
        expect(r.errors).toHaveLength(0);
        // '5' != '' → keeps '5', cast to 5; '' == '' → NULL → fallback '99' → 99
        expect(r.rows[1][0]).toBe(99);
    });
    it('STRPOS + INITCAP + TRANSLATE', () => {
        const t = { name: 't', columns: [col('v','TEXT')], rows: [{ v: 'hello-world' }] };
        const r = run(mkTables(t), `SELECT STRPOS(v, 'world') AS pos, INITCAP(TRANSLATE(v, '-', ' ')) AS titled FROM t`);
        expect(r.rows[0][0]).toBe(7);
        expect(r.rows[0][1]).toBe('Hello World');
    });
    it('DATE_PART + DATE_TRUNC combined', () => {
        const r = run(mkTables(emp), `
            SELECT DATE_PART('year', hire_date) AS yr, DATE_TRUNC('month', hire_date) AS trunc FROM employees WHERE id = 1
        `);
        expect(r.rows[0][0]).toBe(2020);
        expect(r.errors).toHaveLength(0);
    });
    it('ARRAY_AGG in GROUP BY', () => {
        const r = run(mkTables(emp), `SELECT dept, ARRAY_AGG(name) AS names FROM employees GROUP BY dept ORDER BY dept`);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBe(3);
    });
    it('STRING_AGG with separator', () => {
        const r = run(mkTables(emp), `SELECT dept, STRING_AGG(name, ', ') AS names FROM employees GROUP BY dept ORDER BY dept`);
        expect(r.errors).toHaveLength(0);
        expect(r.rows[0][1]).toContain(',');
    });
});

// ═══════════════ MySQL Dialect ═══════════════
describe('MySQL dialect', () => {
    it('IFNULL', () => {
        const t = { name: 't', columns: [col('v','INT')], rows: [{ v: null }, { v: 5 }] };
        const r = run(mkTables(t), `SELECT IFNULL(v, 0) AS r FROM t`);
        expect(r.rows[0][0]).toBe(0);
        expect(r.rows[1][0]).toBe(5);
    });
    it('GROUP_CONCAT', () => {
        const r = run(mkTables(emp), `SELECT dept, GROUP_CONCAT(name) AS names FROM employees GROUP BY dept ORDER BY dept`);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBe(3);
    });
    it('SUBSTR(str, pos, len)', () => {
        const t = { name: 't', columns: [col('v','TEXT')], rows: [{ v: 'MySQL rocks' }] };
        const r = run(mkTables(t), `SELECT SUBSTR(v, 1, 5) AS r FROM t`);
        expect(r.rows[0][0]).toBe('MySQL');
    });
    it('INSTR(str, substr)', () => {
        const t = { name: 't', columns: [col('v','TEXT')], rows: [{ v: 'hello world' }] };
        const r = run(mkTables(t), `SELECT INSTR(v, 'world') AS r FROM t`);
        expect(r.rows[0][0]).toBe(7);
    });
    it('CONCAT(a, b, c)', () => {
        const r = run(mkTables(emp), `SELECT CONCAT(name, ' - ', dept) AS label FROM employees WHERE id = 1`);
        expect(r.rows[0][0]).toBe('Alice - Eng');
    });
    it('CHAR_LENGTH', () => {
        const t = { name: 't', columns: [col('v','TEXT')], rows: [{ v: 'test' }] };
        const r = run(mkTables(t), `SELECT CHAR_LENGTH(v) AS r FROM t`);
        expect(r.rows[0][0]).toBe(4);
    });
    it('DATE_FORMAT', () => {
        const r = run(mkTables(emp), `SELECT DATE_FORMAT(hire_date, '%Y-%m-%d') AS d FROM employees WHERE id = 1`);
        expect(r.errors).toHaveLength(0);
        expect(r.rows[0][0]).toBe('2020-01-15');
    });
    it('LIMIT offset,count syntax', () => {
        const r = run(mkTables(emp), `SELECT name FROM employees ORDER BY name LIMIT 2 OFFSET 1`);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBe(2);
    });
    it('JSON_EXTRACT with ->> shorthand', () => {
        const t = { name: 't', columns: [col('data','JSON')], rows: [{ data: '{"name":"test","age":25}' }] };
        const r = run(mkTables(t), `SELECT data->>'name' AS n, JSON_EXTRACT(data, '$.age') AS a FROM t`);
        expect(r.rows[0][0]).toBe('test');
    });
});

// ═══════════════ MSSQL / SQL Server Dialect ═══════════════
describe('MSSQL dialect', () => {
    it('TOP N', () => {
        const r = run(mkTables(emp), `SELECT TOP 3 name, salary FROM employees ORDER BY salary DESC`);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBe(3);
    });
    it('IIF(cond, true, false)', () => {
        const r = run(mkTables(emp), `SELECT name, IIF(salary > 100000, 'senior', 'junior') AS band FROM employees ORDER BY name`);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.find(r => r[0] === 'Frank')[1]).toBe('junior');
    });
    it('ISNULL (MSSQL)', () => {
        const t = { name: 't', columns: [col('v','INT')], rows: [{ v: null }] };
        const r = run(mkTables(t), `SELECT ISNULL(v, -1) AS r FROM t`);
        expect(r.rows[0][0]).toBe(-1);
    });
    it('CHARINDEX', () => {
        const t = { name: 't', columns: [col('v','TEXT')], rows: [{ v: 'hello world' }] };
        const r = run(mkTables(t), `SELECT CHARINDEX(v, 'world') AS r FROM t`);
        expect(r.errors).toHaveLength(0);
    });
    it('LEN', () => {
        const r = run(mkTables(emp), `SELECT LEN(name) AS n FROM employees WHERE id = 1`);
        expect(r.rows[0][0]).toBe(5);
    });
    it('CONVERT', () => {
        const t = { name: 't', columns: [col('v','INT')], rows: [{ v: 42 }] };
        const r = run(mkTables(t), `SELECT CONVERT(TEXT, v) AS s FROM t`);
        expect(r.rows[0][0]).toBe('42');
    });
    it('TRY_CAST valid input', () => {
        const t = { name: 't', columns: [col('v','TEXT')], rows: [{ v: '123' }] };
        const r = run(mkTables(t), `SELECT TRY_CAST(v AS INTEGER) AS n FROM t`);
        expect(r.errors).toHaveLength(0);
        expect(r.rows[0][0]).toBe(123);
    });
    it('TRY_CAST invalid input returns NULL', () => {
        const t = { name: 't', columns: [col('v','TEXT')], rows: [{ v: 'not-a-number' }] };
        const r = run(mkTables(t), `SELECT TRY_CAST(v AS INTEGER) AS n FROM t`);
        expect(r.errors).toHaveLength(0);
        expect(r.rows[0][0]).toBe(null);
    });
    it('FETCH FIRST N ROWS ONLY', () => {
        const r = run(mkTables(emp), `SELECT name FROM employees ORDER BY name OFFSET 1 ROWS FETCH FIRST 2 ROWS ONLY`);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBe(2);
    });
});

// ═══════════════ SQLite Dialect ═══════════════
describe('SQLite dialect', () => {
    it('TYPEOF', () => {
        const t = { name: 't', columns: [col('v','INT')], rows: [{ v: 42 }] };
        const r = run(mkTables(t), `SELECT TYPEOF(v) AS r FROM t`);
        expect(r.rows[0][0]).toBe('integer');
    });
    it('|| string concatenation', () => {
        const r = run(mkTables(emp), `SELECT name || ' (' || dept || ')' AS label FROM employees WHERE id = 1`);
        expect(r.rows[0][0]).toBe('Alice (Eng)');
    });
    it('COALESCE + || pipeline', () => {
        const t = { name: 't', columns: [col('a','TEXT'), col('b','TEXT')], rows: [{ a: null, b: 'yes' }] };
        const r = run(mkTables(t), `SELECT COALESCE(a, 'N/A') || ' - ' || b AS r FROM t`);
        expect(r.rows[0][0]).toBe('N/A - yes');
    });
    it('STRFTIME for SQLite date', () => {
        const r = run(mkTables(emp), `SELECT STRFTIME('%Y', hire_date) AS yr FROM employees WHERE id = 1`);
        expect(r.rows[0][0]).toBe('2020');
    });
    it('GROUP BY + HAVING + ORDER BY + LIMIT', () => {
        const r = run(mkTables(emp), `
            SELECT dept, COUNT(*) AS cnt, AVG(salary) AS avg_sal
            FROM employees GROUP BY dept HAVING COUNT(*) >= 2 ORDER BY avg_sal DESC LIMIT 2
        `);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBeLessThanOrEqual(2);
    });
    it('REPLACE + LENGTH', () => {
        const t = { name: 't', columns: [col('v','TEXT')], rows: [{ v: 'aabcc' }] };
        const r = run(mkTables(t), `SELECT LENGTH(REPLACE(v, 'a', '')) AS r FROM t`);
        expect(r.rows[0][0]).toBe(3);
    });
});

// ═══════════════ Cross-Dialect Equivalence ═══════════════
describe('Cross-dialect equivalence', () => {
    it('COALESCE = IFNULL = ISNULL = NVL', () => {
        const t = { name: 't', columns: [col('v','INT')], rows: [{ v: null }] };
        const r1 = run(mkTables(t), `SELECT COALESCE(v, 0) AS r FROM t`);
        const r2 = run(mkTables(t), `SELECT IFNULL(v, 0) AS r FROM t`);
        const r3 = run(mkTables(t), `SELECT ISNULL(v, 0) AS r FROM t`);
        const r4 = run(mkTables(t), `SELECT NVL(v, 0) AS r FROM t`);
        expect(r1.rows[0][0]).toBe(0);
        expect(r2.rows[0][0]).toBe(0);
        expect(r3.rows[0][0]).toBe(0);
        expect(r4.rows[0][0]).toBe(0);
    });
    it('LENGTH = LEN = CHAR_LENGTH = CHARACTER_LENGTH', () => {
        const t = { name: 't', columns: [col('v','TEXT')], rows: [{ v: 'hello' }] };
        const r1 = run(mkTables(t), `SELECT LENGTH(v) FROM t`);
        const r2 = run(mkTables(t), `SELECT LEN(v) FROM t`);
        const r3 = run(mkTables(t), `SELECT CHAR_LENGTH(v) FROM t`);
        const r4 = run(mkTables(t), `SELECT CHARACTER_LENGTH(v) FROM t`);
        expect(r1.rows[0][0]).toBe(5);
        expect(r2.rows[0][0]).toBe(5);
        expect(r3.rows[0][0]).toBe(5);
        expect(r4.rows[0][0]).toBe(5);
    });
    it('SUBSTR = SUBSTRING', () => {
        const t = { name: 't', columns: [col('v','TEXT')], rows: [{ v: 'abcdef' }] };
        const r1 = run(mkTables(t), `SELECT SUBSTR(v, 2, 3) FROM t`);
        const r2 = run(mkTables(t), `SELECT SUBSTRING(v, 2, 3) FROM t`);
        expect(r1.rows[0][0]).toBe(r2.rows[0][0]);
    });
    it('POWER = POW', () => {
        const t = { name: 't', columns: [col('v','INT')], rows: [{ v: 3 }] };
        const r1 = run(mkTables(t), `SELECT POWER(v, 3) FROM t`);
        const r2 = run(mkTables(t), `SELECT POW(v, 3) FROM t`);
        expect(r1.rows[0][0]).toBe(27);
        expect(r2.rows[0][0]).toBe(27);
    });
    it('CEIL = CEILING', () => {
        const t = { name: 't', columns: [col('v','NUMERIC')], rows: [{ v: 2.1 }] };
        const r1 = run(mkTables(t), `SELECT CEIL(v) FROM t`);
        const r2 = run(mkTables(t), `SELECT CEILING(v) FROM t`);
        expect(r1.rows[0][0]).toBe(3);
        expect(r2.rows[0][0]).toBe(3);
    });
    it('INSTR = POSITION = STRPOS = CHARINDEX (all find substring)', () => {
        const t = { name: 't', columns: [col('v','TEXT')], rows: [{ v: 'hello world' }] };
        const r1 = run(mkTables(t), `SELECT INSTR(v, 'world') FROM t`);
        const r2 = run(mkTables(t), `SELECT POSITION(v, 'world') FROM t`);
        const r3 = run(mkTables(t), `SELECT STRPOS(v, 'world') FROM t`);
        expect(r1.rows[0][0]).toBe(7);
        expect(r2.rows[0][0]).toBe(7);
        expect(r3.rows[0][0]).toBe(7);
    });
    it('EXTRACT = DATE_PART', () => {
        const r1 = run(mkTables(emp), `SELECT EXTRACT('year', hire_date) FROM employees WHERE id = 1`);
        const r2 = run(mkTables(emp), `SELECT DATE_PART('year', hire_date) FROM employees WHERE id = 1`);
        expect(r1.rows[0][0]).toBe(2020);
        expect(r2.rows[0][0]).toBe(2020);
    });
});

// ═══════════════ Production Edge Cases ═══════════════
describe('Production edge cases', () => {
    it('empty table returns 0 rows', () => {
        const t = { name: 't', columns: [col('id','INT'), col('v','TEXT')], rows: [] };
        const r = run(mkTables(t), `SELECT * FROM t`);
        expect(r.errors).toHaveLength(0);
        expect(r.rows).toHaveLength(0);
    });
    it('COUNT on empty table returns 0', () => {
        const t = { name: 't', columns: [col('id','INT')], rows: [] };
        const r = run(mkTables(t), `SELECT COUNT(*) AS c FROM t`);
        expect(r.rows[0][0]).toBe(0);
    });
    it('SUM/AVG on empty table', () => {
        const t = { name: 't', columns: [col('v','INT')], rows: [] };
        const r = run(mkTables(t), `SELECT SUM(v) AS s, AVG(v) AS a FROM t`);
        expect(r.errors).toHaveLength(0);
        expect(r.rows[0]).toEqual([null, null]);
    });
    it('SUM over all-NULL values returns NULL', () => {
        const t = { name: 't', columns: [col('id','INT'), col('amount','NUMERIC')], rows: [{ id: 1, amount: null }, { id: 2, amount: null }] };
        const r = run(mkTables(t), `SELECT SUM(amount) AS total FROM t`);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBe(1);
        expect(r.rows[0][0]).toBe(null);
    });
    it('NULL in arithmetic produces NULL', () => {
        const t = { name: 't', columns: [col('a','INT'), col('b','INT')], rows: [{ a: 10, b: null }] };
        const r = run(mkTables(t), `SELECT a + b AS sum, a * b AS prod, a - b AS diff FROM t`);
        expect(r.rows[0]).toEqual([null, null, null]);
    });
    it('division by zero returns NULL', () => {
        const t = { name: 't', columns: [col('a','INT'), col('b','INT')], rows: [{ a: 10, b: 0 }] };
        const r = run(mkTables(t), `SELECT a / b AS r FROM t`);
        expect(r.rows[0][0]).toBe(null);
    });
    it('WHERE with all NULLs returns empty', () => {
        const t = { name: 't', columns: [col('v','INT')], rows: [{ v: null }, { v: null }] };
        const r = run(mkTables(t), `SELECT * FROM t WHERE v = 1`);
        expect(r.rows).toHaveLength(0);
    });
    it('ORDER BY NULL values (NULLS LAST default)', () => {
        const t = { name: 't', columns: [col('v','INT')], rows: [{ v: null }, { v: 1 }, { v: 3 }, { v: null }, { v: 2 }] };
        const r = run(mkTables(t), `SELECT v FROM t ORDER BY v ASC`);
        expect(r.errors).toHaveLength(0);
    });
    it('CASE with no matching WHEN returns NULL', () => {
        const t = { name: 't', columns: [col('v','INT')], rows: [{ v: 99 }] };
        const r = run(mkTables(t), `SELECT CASE v WHEN 1 THEN 'a' WHEN 2 THEN 'b' END AS r FROM t`);
        expect(r.rows[0][0]).toBe(null);
    });
    it('deeply nested functions', () => {
        const t = { name: 't', columns: [col('v','TEXT')], rows: [{ v: '  HELLO  ' }] };
        const r = run(mkTables(t), `SELECT LENGTH(TRIM(LOWER(v))) AS r FROM t`);
        expect(r.rows[0][0]).toBe(5);
    });
    it('multiple aliases do not collide', () => {
        const r = run(mkTables(emp), `
            SELECT e1.name AS mgr, e2.name AS emp
            FROM employees e1 JOIN employees e2 ON e2.mgr_id = e1.id
            ORDER BY mgr, emp
        `);
        expect(r.errors).toHaveLength(0);
        expect(r.rows.length).toBe(2);
    });
    it('LEFT JOIN with no matching rows', () => {
        const t1 = { name: 'a', columns: [col('id','INT')], rows: [{ id: 1 }] };
        const t2 = { name: 'b', columns: [col('id','INT'), col('a_id','INT')], rows: [] };
        const r = run(mkTables(t1, t2), `SELECT a.id, b.id AS bid FROM a LEFT JOIN b ON b.a_id = a.id`);
        expect(r.rows[0]).toEqual([1, null]);
    });
    it('CROSS JOIN produces cartesian product', () => {
        const t1 = { name: 'a', columns: [col('x','INT')], rows: [{ x: 1 }, { x: 2 }] };
        const t2 = { name: 'b', columns: [col('y','INT')], rows: [{ y: 10 }, { y: 20 }, { y: 30 }] };
        const r = run(mkTables(t1, t2), `SELECT x, y FROM a CROSS JOIN b ORDER BY x, y`);
        expect(r.rows.length).toBe(6);
    });
});
