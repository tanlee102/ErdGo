/** Exercises complex SELECT composition across joins, groups, and subqueries. */
import { describe, expect, it } from 'vitest';
import { executeSelectQuery } from '@/features/query-view/lib/queryExecutor.js';

function col(name, type = 'TEXT') {
    return { name, type, pk: false, fk: false, notNull: false, unique: false, defaultVal: null };
}

function mkTables(...tables) {
    const map = new Map();
    tables.forEach((table) => map.set(table.name, table));
    return map;
}

function run(tables, query) {
    return executeSelectQuery({ tables, query });
}

const employees = {
    name: 'employees',
    columns: [col('id', 'INT'), col('name'), col('dept'), col('salary', 'NUMERIC'), col('metadata', 'JSONB')],
    rows: [
        { id: 1, name: 'Alice', dept: 'Eng', salary: 120000, metadata: '{"level":"senior","region":"apac"}' },
        { id: 2, name: 'Bob', dept: 'Eng', salary: 95000, metadata: '{"level":"mid","region":"emea"}' },
        { id: 3, name: 'Carol', dept: 'Sales', salary: 110000, metadata: '{"level":"senior","region":"apac"}' },
        { id: 4, name: 'Dave', dept: 'Sales', salary: 90000, metadata: '{"level":"junior","region":"na"}' },
        { id: 5, name: 'Eve', dept: 'Ops', salary: 105000, metadata: '{"level":"mid","region":"na"}' },
    ],
};

describe('Query executor - complex SQL behavior', () => {
    it('runs SELECT without FROM, including WHERE, ORDER BY ordinal, and LIMIT', () => {
        const r = run(new Map(), `
            SELECT 'kept' AS label, 2 * 3 AS score
            WHERE (2 + 2) = 4
            ORDER BY 2 DESC
            LIMIT 1
        `);

        expect(r.errors).toEqual([]);
        expect(r.columns.map((column) => column.label)).toEqual(['label', 'score']);
        expect(r.rows).toEqual([['kept', 6]]);

        const filtered = run(new Map(), `SELECT 'hidden' AS label WHERE 1 = 0`);
        expect(filtered.errors).toEqual([]);
        expect(filtered.rows).toEqual([]);
    });

    it('uses SELECT-without-FROM inside CTEs and derived tables', () => {
        const r = run(mkTables(employees), `
            WITH seed AS (
                SELECT 2 AS min_count, 'Eng' AS preferred_dept
            )
            SELECT s.preferred_dept, stats.cnt
            FROM seed s
            JOIN (
                SELECT dept, COUNT(*) AS cnt
                FROM employees
                GROUP BY dept
            ) stats ON stats.dept = s.preferred_dept
            WHERE stats.cnt >= s.min_count
            ORDER BY 2 DESC
        `);

        expect(r.errors).toEqual([]);
        expect(r.rows).toEqual([['Eng', 2]]);
    });

    it('sorts by SELECT-list ordinal after projections are evaluated', () => {
        const r = run(mkTables(employees), `
            SELECT name, salary - 100000 AS delta
            FROM employees
            ORDER BY 2 DESC, 1 ASC
            LIMIT 3
        `);

        expect(r.errors).toEqual([]);
        expect(r.rows).toEqual([
            ['Alice', 20000],
            ['Carol', 10000],
            ['Eve', 5000],
        ]);
    });

    it('combines CTEs, windows, JSON objects, JSON access, and ordinal ordering', () => {
        const r = run(mkTables(employees), `
            WITH ranked AS (
                SELECT dept, name, salary,
                       ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC) AS rn
                FROM employees
            ),
            dept_payloads AS (
                SELECT dept,
                       JSON_OBJECT('count', COUNT(*), 'top_salary', MAX(salary)) AS payload
                FROM employees
                GROUP BY dept
            )
            SELECT r.dept, r.name, r.salary, p.payload->>'count' AS dept_count
            FROM ranked r
            JOIN dept_payloads p ON p.dept = r.dept
            WHERE r.rn = 1
            ORDER BY 3 DESC, 1 ASC
        `);

        expect(r.errors).toEqual([]);
        expect(r.rows).toEqual([
            ['Eng', 'Alice', 120000, '2'],
            ['Sales', 'Carol', 110000, '2'],
            ['Ops', 'Eve', 105000, '1'],
        ]);
    });

    it('runs a production analytics query with JSON filters, filtered aggregates, windows, NULL-safe math, and FETCH', () => {
        const customers = {
            name: 'customers',
            columns: [col('id', 'INT'), col('name'), col('region'), col('metadata', 'JSONB')],
            rows: [
                { id: 1, name: 'Acme', region: 'North', metadata: '{"tier":"gold"}' },
                { id: 2, name: 'Beta', region: 'North', metadata: '{"tier":"silver"}' },
                { id: 3, name: 'Coda', region: 'South', metadata: '{"tier":"gold"}' },
                { id: 4, name: 'Demo', region: 'South', metadata: '{"tier":"test"}' },
                { id: 5, name: 'Echo', region: 'East', metadata: '{"tier":"bronze"}' },
            ],
        };
        const invoices = {
            name: 'invoices',
            columns: [col('id', 'INT'), col('customer_id', 'INT'), col('status'), col('total', 'NUMERIC'), col('issued_on', 'DATE')],
            rows: [
                { id: 101, customer_id: 1, status: 'paid', total: 300, issued_on: '2024-01-10' },
                { id: 102, customer_id: 1, status: 'open', total: 120, issued_on: '2024-02-01' },
                { id: 103, customer_id: 2, status: 'paid', total: 80, issued_on: '2024-01-20' },
                { id: 104, customer_id: 3, status: 'void', total: 999, issued_on: '2024-02-15' },
                { id: 105, customer_id: 3, status: 'open', total: 150, issued_on: '2024-03-05' },
                { id: 106, customer_id: 5, status: 'paid', total: 40, issued_on: '2024-03-08' },
            ],
        };
        const payments = {
            name: 'payments',
            columns: [col('invoice_id', 'INT'), col('amount', 'NUMERIC'), col('received_on', 'DATE')],
            rows: [
                { invoice_id: 101, amount: 300, received_on: '2024-01-12' },
                { invoice_id: 103, amount: 50, received_on: '2024-01-25' },
                { invoice_id: 106, amount: 40, received_on: '2024-03-10' },
            ],
        };

        const r = run(mkTables(customers, invoices, payments), `
            WITH invoice_rollup AS (
                SELECT c.id,
                       c.region,
                       c.name,
                       c.metadata->>'tier' AS tier,
                       COUNT(DISTINCT i.id) FILTER (WHERE i.status <> 'void') AS invoice_count,
                       SUM(i.total) FILTER (WHERE i.status = 'open') AS open_total,
                       SUM(i.total) FILTER (WHERE i.status = 'paid') AS paid_total
                FROM customers c
                LEFT JOIN invoices i ON i.customer_id = c.id
                WHERE c.metadata->>'tier' NOT IN ('test')
                GROUP BY c.id, c.region, c.name, c.metadata->>'tier'
            ),
            payment_rollup AS (
                SELECT i.customer_id,
                       SUM(p.amount) AS cash_collected,
                       MAX(p.received_on) AS last_payment
                FROM invoices i
                JOIN payments p ON p.invoice_id = i.id
                GROUP BY i.customer_id
            ),
            scored AS (
                SELECT r.region,
                       r.name,
                       r.tier,
                       r.invoice_count,
                       COALESCE(r.open_total, 0) AS open_total,
                       COALESCE(r.paid_total, 0) AS paid_total,
                       COALESCE(p.cash_collected, 0) AS cash_collected,
                       CASE
                           WHEN COALESCE(p.cash_collected, 0) >= COALESCE(r.paid_total, 0) THEN 'settled'
                           ELSE 'short'
                       END AS collection_state,
                       p.last_payment
                FROM invoice_rollup r
                LEFT JOIN payment_rollup p ON p.customer_id = r.id
            )
            SELECT region,
                   name,
                   tier,
                   ROUND((cash_collected + open_total) / NULLIF(paid_total + open_total, 0), 2) AS coverage,
                   DENSE_RANK() OVER (PARTITION BY region ORDER BY cash_collected DESC, name ASC) AS regional_cash_rank,
                   COUNT(*) OVER (PARTITION BY region) AS region_size,
                   COALESCE(last_payment, 'none') AS last_payment_label
            FROM scored
            WHERE invoice_count > 0
              AND (collection_state = 'settled' OR open_total >= 100)
            ORDER BY region ASC, regional_cash_rank ASC, name ASC
            FETCH FIRST 4 ROWS ONLY
        `);

        expect(r.errors).toEqual([]);
        expect(r.columns.map((column) => column.label)).toEqual([
            'region',
            'name',
            'tier',
            'coverage',
            'regional_cash_rank',
            'region_size',
            'last_payment_label',
        ]);
        expect(r.rows).toEqual([
            ['East', 'Echo', 'bronze', 1, 1, 1, '2024-03-10'],
            ['North', 'Acme', 'gold', 1, 1, 1, '2024-01-12'],
            ['South', 'Coda', 'gold', 1, 1, 1, 'none'],
        ]);
    });
});
