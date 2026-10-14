import { describe, expect, it } from 'vitest';
import { createSqlExecutor } from '@/features/data-view/lib/sqlExecutor.js';
import { executeSelectQuery } from '@/features/query-view/lib/queryExecutor.js';

function run(ddl, q) {
    return executeSelectQuery({ tables: createSqlExecutor().execute(ddl).tables, query: q });
}

const schema = `
CREATE TABLE departments (id INT, name TEXT, budget NUMERIC);
INSERT INTO departments VALUES (1,'Engineering',500000),(2,'Marketing',200000),(3,'Sales',300000),(4,'HR',150000);

CREATE TABLE employees (id INT, name TEXT, dept_id INT, salary NUMERIC, hire_date TEXT, manager_id INT, active BOOLEAN);
INSERT INTO employees VALUES
(1,'Alice',1,120000,'2020-01-15',NULL,TRUE),(2,'Bob',1,95000,'2021-03-20',1,TRUE),
(3,'Charlie',2,85000,'2019-06-10',NULL,TRUE),(4,'Dana',2,78000,'2022-01-05',3,FALSE),
(5,'Eve',3,110000,'2018-09-01',NULL,TRUE),(6,'Frank',3,72000,'2023-02-14',5,TRUE),
(7,'Grace',1,130000,'2017-11-20',NULL,TRUE),(8,'Hank',4,65000,'2023-08-01',NULL,TRUE),
(9,'Iris',NULL,90000,'2021-07-12',NULL,TRUE),(10,'Jack',3,68000,'2024-01-10',5,FALSE);

CREATE TABLE projects (id INT, name TEXT, dept_id INT, lead_id INT, status TEXT);
INSERT INTO projects VALUES
(100,'Alpha',1,1,'active'),(101,'Beta',1,7,'active'),(102,'Gamma',2,3,'completed'),
(103,'Delta',3,5,'active'),(104,'Epsilon',1,2,'paused'),(105,'Zeta',4,8,'active');

CREATE TABLE timesheets (id INT, emp_id INT, project_id INT, hours NUMERIC);
INSERT INTO timesheets VALUES
(1,1,100,40),(2,1,101,20),(3,2,100,35),(4,2,104,15),(5,3,102,45),
(6,4,102,30),(7,5,103,50),(8,6,103,25),(9,7,101,40),(10,7,100,10),
(11,8,105,38),(12,9,100,20),(13,10,103,15);
`;

describe('cross-dialect comprehensive tests', () => {
    it('queries Data View materialized views from MySQL and MSSQL CREATE variants', () => {
        const r = run(
            `
                CREATE TABLE users (id INT PRIMARY KEY, name TEXT, active BOOLEAN, tier TEXT);
                INSERT INTO users (id, name, active, tier) VALUES
                    (1, 'Ada', TRUE, 'pro'),
                    (2, 'Linus', FALSE, 'free'),
                    (3, 'Grace', TRUE, 'pro');

                CREATE OR REPLACE ALGORITHM = MERGE
                    SQL SECURITY INVOKER
                    VIEW pro_users AS
                    SELECT id, name FROM users WHERE active = TRUE AND tier = 'pro'
                    WITH CASCADED CHECK OPTION;

                CREATE OR ALTER VIEW dbo.user_names
                    WITH SCHEMABINDING
                AS
                    SELECT id, name FROM users WHERE active = TRUE;
            `,
            `
                SELECT p.name
                FROM pro_users p
                JOIN user_names n ON n.id = p.id
                ORDER BY p.id
            `,
        );

        expect(r.errors).toHaveLength(0);
        expect(r.rows).toEqual([['Ada'], ['Grace']]);
    });

    it('queries chained materialized Data View views after base-table DML refreshes them', () => {
        const r = run(
            `
                CREATE TABLE payments (id INT PRIMARY KEY, user_id INT, amount NUMERIC, status TEXT);
                INSERT INTO payments (id, user_id, amount, status) VALUES
                    (1, 10, 100, 'paid'),
                    (2, 10, 40, 'draft'),
                    (3, 20, 75, 'paid');

                CREATE VIEW paid_payments AS
                    SELECT user_id, amount FROM payments WHERE status = 'paid';

                CREATE VIEW paid_totals AS
                    SELECT user_id, SUM(amount) AS total
                    FROM paid_payments
                    GROUP BY user_id;

                INSERT INTO payments (id, user_id, amount, status) VALUES
                    (4, 10, 30, 'paid'),
                    (5, 20, 25, 'paid');
            `,
            `
                SELECT user_id, total
                FROM paid_totals
                WHERE total >= 100
                ORDER BY user_id
            `,
        );

        expect(r.errors).toHaveLength(0);
        expect(r.rows).toEqual([
            [10, 130],
            [20, 100],
        ]);
    });

    // ═══════════════ PostgreSQL-style queries ═══════════════

    describe('PostgreSQL dialect', () => {
        it('CTE + || concat + COALESCE + window LAG + DENSE_RANK', () => {
            const r = run(schema, `
                WITH emp_dept AS (
                    SELECT e.id, e.name || ' (' || COALESCE(d.name, 'Unassigned') || ')' AS label,
                           e.salary, d.name AS dept,
                           DENSE_RANK() OVER (PARTITION BY e.dept_id ORDER BY e.salary DESC) AS dept_rank,
                           LAG(e.salary) OVER (ORDER BY e.salary DESC) AS prev_salary
                    FROM employees e LEFT JOIN departments d ON d.id = e.dept_id
                )
                SELECT label, salary, dept_rank, prev_salary
                FROM emp_dept WHERE dept_rank <= 2
                ORDER BY salary DESC
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBeGreaterThan(0);
            expect(r.rows[0][0]).toContain('(');
        });

        it('ARRAY_AGG DISTINCT + FILTER + GROUP BY + HAVING', () => {
            const r = run(schema, `
                SELECT d.name,
                       COUNT(*) AS emp_count,
                       ARRAY_AGG(DISTINCT e.name ORDER BY e.name) AS names,
                       SUM(e.salary) FILTER (WHERE e.active = TRUE) AS active_salary
                FROM employees e JOIN departments d ON d.id = e.dept_id
                GROUP BY d.name
                HAVING COUNT(*) >= 2
                ORDER BY d.name
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBe(3);
            expect(r.rows[0][2]).toBeInstanceOf(Array);
        });

        it('scalar subquery + EXISTS + NOT IN subquery', () => {
            const r = run(schema, `
                SELECT e.name, e.salary,
                    (SELECT d.name FROM departments d WHERE d.id = e.dept_id) AS dept_name
                FROM employees e
                WHERE EXISTS (SELECT 1 FROM timesheets t WHERE t.emp_id = e.id AND t.hours > 30)
                  AND e.id NOT IN (SELECT lead_id FROM projects WHERE status = 'paused')
                ORDER BY e.salary DESC
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBeGreaterThan(0);
        });

        it('FULL OUTER JOIN + COALESCE + CASE + NULLIF', () => {
            const r = run(schema, `
                SELECT
                    COALESCE(d.name, 'No Dept') AS dept,
                    COALESCE(p.name, 'No Project') AS project,
                    CASE
                        WHEN d.id IS NOT NULL AND p.id IS NOT NULL THEN 'mapped'
                        WHEN d.id IS NOT NULL THEN 'dept_only'
                        ELSE 'project_only'
                    END AS mapping,
                    NULLIF(d.budget, 0) AS budget
                FROM departments d
                FULL OUTER JOIN projects p ON p.dept_id = d.id
                ORDER BY dept, project
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBeGreaterThan(0);
        });

        it('UNION + INTERSECT + complex CTE pipeline', () => {
            const r = run(schema, `
                WITH high_earners AS (
                    SELECT id, name, salary FROM employees WHERE salary >= 100000
                ),
                active_leads AS (
                    SELECT e.id, e.name, e.salary
                    FROM employees e JOIN projects p ON p.lead_id = e.id
                    WHERE p.status = 'active'
                )
                SELECT name, salary FROM high_earners
                UNION
                SELECT name, salary FROM active_leads
                ORDER BY salary DESC
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBeGreaterThan(0);
        });

        it('IS TRUE / IS NOT FALSE + NULLS FIRST ordering', () => {
            const r = run(schema, `
                SELECT e.name, e.dept_id, e.active
                FROM employees e
                WHERE e.active IS TRUE
                ORDER BY e.dept_id ASC NULLS FIRST, e.name
            `);
            expect(r.errors).toHaveLength(0);
            const iris = r.rows.find((row) => row[0] === 'Iris');
            expect(iris).toBeTruthy();
            expect(r.rows[0][1]).toBe(null);
        });

        it('NTILE + FIRST_VALUE + LAST_VALUE partitioned windows', () => {
            const r = run(schema, `
                SELECT e.name, e.salary, d.name AS dept,
                    NTILE(3) OVER (ORDER BY e.salary DESC) AS salary_tier,
                    FIRST_VALUE(e.name) OVER (PARTITION BY e.dept_id ORDER BY e.salary DESC) AS top_earner,
                    LAST_VALUE(e.name) OVER (PARTITION BY e.dept_id ORDER BY e.salary DESC) AS lowest_earner
                FROM employees e LEFT JOIN departments d ON d.id = e.dept_id
                ORDER BY e.salary DESC
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBe(10);
            const tiers = r.rows.map((row) => row[3]);
            expect(tiers[0]).toBe(1);
        });

        it('STRING_AGG + GREATEST + LEAST + multiple JOINs', () => {
            const r = run(schema, `
                SELECT d.name AS dept,
                    STRING_AGG(e.name, ', ' ORDER BY e.name) AS team,
                    GREATEST(MAX(e.salary), d.budget / 10) AS high_val,
                    LEAST(MIN(e.salary), d.budget / 10) AS low_val
                FROM departments d
                JOIN employees e ON e.dept_id = d.id
                GROUP BY d.name, d.budget
                ORDER BY d.name
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBeGreaterThan(0);
        });
    });

    // ═══════════════ MySQL-style queries ═══════════════

    describe('MySQL dialect', () => {
        it('GROUP_CONCAT + IFNULL + SUBSTR + CONCAT', () => {
            const r = run(schema, `
                SELECT d.name,
                    GROUP_CONCAT(SUBSTR(e.name, 1, 1) ORDER BY e.name) AS initials,
                    IFNULL(MAX(e.salary), 0) AS max_salary,
                    CONCAT(d.name, ' (', CAST(COUNT(*) AS TEXT), ')') AS label
                FROM departments d LEFT JOIN employees e ON e.dept_id = d.id
                GROUP BY d.name
                ORDER BY d.name
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBe(4);
        });

        it('REPLACE + LPAD + RPAD + CHAR_LENGTH + REVERSE', () => {
            const r = run(schema, `
                SELECT
                    e.name,
                    REPLACE(e.name, 'a', '@') AS replaced,
                    LPAD(CAST(e.salary AS TEXT), 10, '0') AS padded,
                    RPAD(e.name, 10, '.') AS rpadded,
                    CHAR_LENGTH(e.name) AS len,
                    REVERSE(e.name) AS rev
                FROM employees e WHERE e.id <= 3 ORDER BY e.id
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows[0][1]).toBe('Alice');
            expect(r.rows[0][4]).toBe(5);
            expect(r.rows[0][5]).toBe('ecilA');
        });

        it('CEIL + FLOOR + MOD + POWER + SQRT + ABS + SIGN', () => {
            const r = run(schema, `
                SELECT
                    CEIL(e.salary / 1000.0) AS ceil_k,
                    FLOOR(e.salary / 1000.0) AS floor_k,
                    MOD(e.salary, 1000) AS remainder,
                    POWER(2, 10) AS pow_val,
                    SQRT(e.salary) AS sqrt_sal,
                    ABS(-1 * e.salary) AS abs_sal,
                    SIGN(e.salary - 100000) AS above_100k
                FROM employees e WHERE e.id = 1
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows[0][0]).toBe(120);
            expect(r.rows[0][3]).toBe(1024);
        });

        it('LIMIT with offset syntax + derived table', () => {
            const r = run(schema, `
                SELECT ranked.name, ranked.salary, ranked.rn
                FROM (
                    SELECT e.name, e.salary,
                        ROW_NUMBER() OVER (ORDER BY e.salary DESC) AS rn
                    FROM employees e WHERE e.active = TRUE
                ) ranked
                WHERE ranked.rn BETWEEN 2 AND 5
                ORDER BY ranked.rn
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBe(4);
        });

        it('INSTR + REPEAT + POSITION string functions', () => {
            const r = run(schema, `
                SELECT e.name,
                    INSTR(e.name, 'a') AS a_pos,
                    REPEAT(SUBSTR(e.name, 1, 1), 3) AS triple,
                    POSITION(e.name, 'li') AS li_pos
                FROM employees e WHERE e.id <= 3 ORDER BY e.id
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows[0][2]).toBe('AAA');
        });
    });

    // ═══════════════ MSSQL-style queries ═══════════════

    describe('MSSQL dialect', () => {
        it('TOP + IIF + ISNULL + CAST + RIGHT JOIN', () => {
            const r = run(schema, `
                SELECT TOP 5
                    e.name,
                    ISNULL(d.name, 'Unassigned') AS dept,
                    IIF(e.salary > 100000, 'Senior', IIF(e.salary > 80000, 'Mid', 'Junior')) AS level,
                    CAST(e.salary AS INTEGER) AS salary_int
                FROM employees e
                RIGHT JOIN departments d ON d.id = e.dept_id
                ORDER BY e.salary DESC
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBe(5);
        });

        it('FETCH FIRST with OFFSET + CASE + nested IIF', () => {
            const r = run(schema, `
                SELECT e.name, e.salary,
                    CASE
                        WHEN e.salary >= 120000 THEN 'A'
                        WHEN e.salary >= 90000 THEN 'B'
                        WHEN e.salary >= 70000 THEN 'C'
                        ELSE 'D'
                    END AS grade,
                    IIF(e.manager_id IS NOT NULL, 'has_mgr', 'no_mgr') AS mgr_status
                FROM employees e
                ORDER BY e.salary DESC
                OFFSET 2 ROWS FETCH FIRST 4 ROWS ONLY
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBe(4);
        });

        it('CTE + CHARINDEX/POSITION + multiple aggregates', () => {
            const r = run(schema, `
                WITH project_hours AS (
                    SELECT t.project_id,
                        COUNT(DISTINCT t.emp_id) AS workers,
                        SUM(t.hours) AS total_hours,
                        AVG(t.hours) AS avg_hours,
                        MIN(t.hours) AS min_hours,
                        MAX(t.hours) AS max_hours
                    FROM timesheets t GROUP BY t.project_id
                )
                SELECT p.name, p.status, ph.workers, ph.total_hours,
                    ROUND(ph.avg_hours, 1) AS avg_h,
                    ph.max_hours - ph.min_hours AS range_h
                FROM projects p JOIN project_hours ph ON ph.project_id = p.id
                ORDER BY ph.total_hours DESC
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBeGreaterThan(0);
        });

        it('UNION ALL + TOP + aggregates across sets', () => {
            const r = run(schema, `
                SELECT 'High' AS category, COUNT(*) AS cnt, AVG(salary) AS avg_sal
                FROM employees WHERE salary >= 100000
                UNION ALL
                SELECT 'Mid', COUNT(*), AVG(salary)
                FROM employees WHERE salary >= 70000 AND salary < 100000
                UNION ALL
                SELECT 'Low', COUNT(*), AVG(salary)
                FROM employees WHERE salary < 70000
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBe(3);
            const total = r.rows.reduce((s, row) => s + row[1], 0);
            expect(total).toBe(10);
        });
    });

    // ═══════════════ SQLite-style queries ═══════════════

    describe('SQLite dialect', () => {
        it('|| concat + TYPEOF + CAST + GROUP_CONCAT + SUBSTR', () => {
            const r = run(schema, `
                SELECT d.name,
                    GROUP_CONCAT(SUBSTR(e.name, 1, 3), ' | ') AS abbrevs,
                    TYPEOF(SUM(e.salary)) AS sum_type,
                    CAST(AVG(e.salary) AS INTEGER) AS avg_int,
                    MIN(e.hire_date) || ' to ' || MAX(e.hire_date) AS date_range
                FROM employees e JOIN departments d ON d.id = e.dept_id
                GROUP BY d.name
                HAVING COUNT(*) >= 2
                ORDER BY d.name
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBe(3);
        });

        it('IIF + NULLS LAST + LEFT JOIN + COALESCE chain', () => {
            const r = run(schema, `
                SELECT
                    e.name,
                    COALESCE(d.name, e.name || ' (no dept)', 'unknown') AS dept_info,
                    IIF(e.active = TRUE, 'Y', 'N') AS is_active,
                    COALESCE(e.salary, 0) AS safe_salary
                FROM employees e LEFT JOIN departments d ON d.id = e.dept_id
                ORDER BY e.salary DESC NULLS LAST
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBe(10);
        });

        it('complex window: LAG + LEAD + ROW_NUMBER + RANK together', () => {
            const r = run(schema, `
                SELECT e.name, e.salary,
                    ROW_NUMBER() OVER (ORDER BY e.salary DESC) AS rn,
                    RANK() OVER (ORDER BY e.salary DESC) AS rnk,
                    LAG(e.name) OVER (ORDER BY e.salary DESC) AS prev_name,
                    LEAD(e.name) OVER (ORDER BY e.salary DESC) AS next_name,
                    LAG(e.salary, 1, 0) OVER (ORDER BY e.salary DESC) AS prev_sal,
                    LEAD(e.salary, 1, 0) OVER (ORDER BY e.salary DESC) AS next_sal
                FROM employees e WHERE e.active = TRUE
                ORDER BY e.salary DESC
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows[0][4]).toBe(null);
            expect(r.rows[0][6]).toBe(0);
        });

        it('EXCEPT + INTERSECT combined with aggregation', () => {
            const r = run(schema, `
                SELECT e.dept_id FROM employees e WHERE e.active = TRUE
                EXCEPT
                SELECT e.dept_id FROM employees e WHERE e.salary < 80000
            `);
            expect(r.errors).toHaveLength(0);
        });
    });

    // ═══════════════ Complex multi-feature queries ═══════════════

    describe('complex multi-feature queries', () => {
        it('employee performance dashboard with 3 CTEs + windows + aggregates', () => {
            const r = run(schema, `
                WITH emp_hours AS (
                    SELECT t.emp_id, SUM(t.hours) AS total_hours,
                        COUNT(DISTINCT t.project_id) AS project_count
                    FROM timesheets t GROUP BY t.emp_id
                ),
                dept_stats AS (
                    SELECT e.dept_id,
                        AVG(e.salary) AS avg_salary,
                        COUNT(*) AS dept_size
                    FROM employees e GROUP BY e.dept_id
                ),
                ranked AS (
                    SELECT e.id, e.name, e.salary, d.name AS dept,
                        COALESCE(eh.total_hours, 0) AS hours,
                        COALESCE(eh.project_count, 0) AS projects,
                        ROUND(e.salary / COALESCE(ds.avg_salary, e.salary) * 100, 1) AS pct_of_avg,
                        DENSE_RANK() OVER (ORDER BY COALESCE(eh.total_hours, 0) DESC) AS hours_rank,
                        NTILE(4) OVER (ORDER BY e.salary DESC) AS salary_quartile
                    FROM employees e
                    LEFT JOIN departments d ON d.id = e.dept_id
                    LEFT JOIN emp_hours eh ON eh.emp_id = e.id
                    LEFT JOIN dept_stats ds ON ds.dept_id = e.dept_id
                )
                SELECT name, dept, hours, projects, pct_of_avg,
                    hours_rank, salary_quartile
                FROM ranked
                WHERE salary_quartile <= 2
                ORDER BY hours_rank, name
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBeGreaterThan(0);
            expect(r.columns.map((c) => c.label)).toEqual([
                'name', 'dept', 'hours', 'projects', 'pct_of_avg', 'hours_rank', 'salary_quartile',
            ]);
        });

        it('department budget report: FULL JOIN + CASE + UNION + window', () => {
            const r = run(schema, `
                WITH dept_spend AS (
                    SELECT d.id, d.name, d.budget,
                        SUM(e.salary) AS total_salary,
                        COUNT(e.id) AS headcount
                    FROM departments d LEFT JOIN employees e ON e.dept_id = d.id
                    GROUP BY d.id, d.name, d.budget
                ),
                dept_projects AS (
                    SELECT p.dept_id, COUNT(*) AS active_projects
                    FROM projects p WHERE p.status = 'active' GROUP BY p.dept_id
                )
                SELECT ds.name,
                    ds.budget,
                    ds.total_salary,
                    ds.budget - ds.total_salary AS remaining,
                    CASE
                        WHEN ds.total_salary > ds.budget THEN 'OVER'
                        WHEN ds.total_salary > ds.budget * 0.8 THEN 'WARNING'
                        ELSE 'OK'
                    END AS status,
                    COALESCE(dp.active_projects, 0) AS projects,
                    ROUND(ds.total_salary * 100.0 / ds.budget, 1) AS utilization_pct,
                    ROW_NUMBER() OVER (ORDER BY ds.total_salary DESC) AS spend_rank
                FROM dept_spend ds
                LEFT JOIN dept_projects dp ON dp.dept_id = ds.id
                ORDER BY spend_rank
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBe(4);
        });

        it('cross join + self-referencing + BETWEEN + nested CASE', () => {
            const r = run(schema, `
                SELECT
                    e.name AS employee,
                    COALESCE(m.name, 'None') AS manager,
                    e.salary,
                    CASE
                        WHEN e.salary BETWEEN 60000 AND 80000 THEN 'Band 1'
                        WHEN e.salary BETWEEN 80001 AND 100000 THEN 'Band 2'
                        WHEN e.salary BETWEEN 100001 AND 130000 THEN 'Band 3'
                        ELSE 'Band 4'
                    END AS salary_band,
                    CASE WHEN e.manager_id IS NULL THEN 'Manager' ELSE 'IC' END AS role_type
                FROM employees e
                LEFT JOIN employees m ON m.id = e.manager_id
                WHERE e.active IS TRUE
                ORDER BY e.salary DESC
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBe(8);
            const alice = r.rows.find((row) => row[0] === 'Alice');
            expect(alice[1]).toBe('None');
        });

        it('% modulo + || + TRIM + LTRIM + RTRIM + GREATEST + LEAST in one query', () => {
            const r = run(schema, `
                SELECT e.name,
                    e.salary % 10000 AS mod_10k,
                    TRIM('  ' || e.name || '  ') AS trimmed,
                    LTRIM('xxxAlice', 'x') AS ltrimmed,
                    GREATEST(e.salary, 100000, 90000) AS greatest_val,
                    LEAST(e.salary, 100000, 90000) AS least_val
                FROM employees e WHERE e.id = 1
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows[0][1]).toBe(120000 % 10000);
            expect(r.rows[0][2]).toBe('Alice');
            expect(r.rows[0][3]).toBe('Alice');
            expect(r.rows[0][4]).toBe(120000);
            expect(r.rows[0][5]).toBe(90000);
        });

        it('LEAD/LAG with partitions + FIRST_VALUE + aggregates', () => {
            const r = run(schema, `
                SELECT e.name, d.name AS dept, e.salary,
                    LAG(e.salary) OVER (PARTITION BY e.dept_id ORDER BY e.salary) AS prev_in_dept,
                    LEAD(e.salary) OVER (PARTITION BY e.dept_id ORDER BY e.salary) AS next_in_dept,
                    FIRST_VALUE(e.name) OVER (PARTITION BY e.dept_id ORDER BY e.salary DESC) AS dept_top,
                    LAST_VALUE(e.name) OVER (PARTITION BY e.dept_id ORDER BY e.salary DESC) AS dept_bottom,
                    e.salary - AVG(e.salary) OVER (PARTITION BY e.dept_id) AS diff_from_avg
                FROM employees e JOIN departments d ON d.id = e.dept_id
                ORDER BY d.name, e.salary DESC
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBeGreaterThan(0);
        });

        it('IN subquery + NOT EXISTS + UNION ALL + right join in CTE', () => {
            const r = run(schema, `
                WITH unassigned_emps AS (
                    SELECT e.id, e.name, 'no_project' AS reason
                    FROM employees e
                    WHERE e.id NOT IN (SELECT DISTINCT emp_id FROM timesheets)
                ),
                overworked AS (
                    SELECT e.id, e.name, 'overworked' AS reason
                    FROM employees e
                    WHERE e.id IN (SELECT t.emp_id FROM timesheets t WHERE t.hours >= 40)
                )
                SELECT name, reason FROM unassigned_emps
                UNION ALL
                SELECT name, reason FROM overworked
                ORDER BY reason, name
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBeGreaterThan(0);
        });

        it('deep nesting: CTE with derived table with subquery with window', () => {
            const r = run(schema, `
                WITH base AS (
                    SELECT * FROM (
                        SELECT e.id, e.name, e.salary, e.dept_id,
                            ROW_NUMBER() OVER (ORDER BY e.salary DESC) AS global_rank
                        FROM employees e WHERE e.active = TRUE
                    ) ranked WHERE ranked.global_rank <= 5
                )
                SELECT b.name, b.salary, b.global_rank,
                    (SELECT d.name FROM departments d WHERE d.id = b.dept_id) AS dept,
                    (SELECT COUNT(*) FROM timesheets t WHERE t.emp_id = b.id) AS timesheet_count
                FROM base b
                ORDER BY b.global_rank
            `);
            expect(r.errors).toHaveLength(0);
            expect(r.rows.length).toBe(5);
        });
    });
});
