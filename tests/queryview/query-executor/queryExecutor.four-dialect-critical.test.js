/** Verifies critical SELECT behavior across four supported SQL dialects. */
import { describe, expect, it } from 'vitest';
import { executeSelectQuery } from '@/features/query-view/lib/queryExecutor.js';

function col(name, type = 'TEXT') {
    return { name, type, pk: false, fk: false, notNull: false, unique: false, defaultVal: null };
}

const records = {
    name: 'records',
    columns: [
        col('id', 'INT'),
        col('full name'),
        col('department'),
        col('score', 'NUMERIC'),
        col('created_at'),
        col('nickname'),
        col('metadata', 'JSON'),
    ],
    rows: [
        { id: 1, 'full name': 'Alice', department: 'Eng', score: 12.5, created_at: '2024-01-15T10:20:30Z', nickname: null, metadata: '{"active":true,"level":3}' },
        { id: 2, 'full name': 'Bob', department: 'Eng', score: 7, created_at: '2024-02-20T08:00:00Z', nickname: 'Bobby', metadata: '{"active":false,"level":1}' },
        { id: 3, 'full name': 'Carla', department: 'Sales', score: null, created_at: '2024-03-31T23:30:00Z', nickname: 'CJ', metadata: '{"active":true,"level":2}' },
        { id: 4, 'full name': 'dave', department: 'Sales', score: 10, created_at: '2024-04-01T00:00:00Z', nickname: null, metadata: null },
    ],
};

const tables = new Map([[records.name, records]]);

function run(query) {
    return executeSelectQuery({ tables, query });
}

describe('Query executor four-dialect critical syntax', () => {
    describe('dialect-aware LIKE semantics', () => {
        it.each([
            ['sqlite', [['Ada'], ['ada']]],
            ['mysql', [['Ada'], ['ada']]],
            ['mssql', [['Ada'], ['ada']]],
            ['postgres', [['ada']]],
        ])('uses %s default LIKE case sensitivity', (dialect, expectedRows) => {
            const dialectTables = new Map([['names', {
                name: 'names',
                dialect,
                columns: [col('value')],
                rows: [{ value: 'Ada' }, { value: 'ada' }, { value: 'Bob' }],
            }]]);
            const result = executeSelectQuery({
                tables: dialectTables,
                query: "SELECT value FROM names WHERE value LIKE 'a%'",
            });

            expect(result.errors).toEqual([]);
            expect(result.rows).toEqual(expectedRows);
        });

        it('keeps ILIKE explicitly case-insensitive for PostgreSQL', () => {
            const dialectTables = new Map([['names', {
                name: 'names',
                dialect: 'postgres',
                columns: [col('value')],
                rows: [{ value: 'Ada' }, { value: 'ada' }],
            }]]);
            const result = executeSelectQuery({ tables: dialectTables, query: "SELECT value FROM names WHERE value ILIKE 'a%'" });
            expect(result.errors).toEqual([]);
            expect(result.rows).toEqual([['Ada'], ['ada']]);
        });
    });

    describe('PostgreSQL', () => {
        it('supports double-quoted identifiers, ILIKE, and chained casts', () => {
            const result = run(`
                SELECT "full name", score::INTEGER::TEXT
                FROM records
                WHERE "full name" ILIKE 'a%'
            `);

            expect(result.errors).toEqual([]);
            expect(result.rows).toEqual([['Alice', '12']]);
        });

        it('supports native EXTRACT(part FROM value)', () => {
            const result = run(`
                SELECT
                    EXTRACT(YEAR FROM created_at),
                    EXTRACT(MONTH FROM created_at),
                    EXTRACT(DOW FROM created_at)
                FROM records
                WHERE id = 1
            `);

            expect(result.errors).toEqual([]);
            expect(result.rows).toEqual([[2024, 1, 1]]);

            const utcBoundary = run(`
                SELECT EXTRACT(MONTH FROM created_at), EXTRACT(DAY FROM created_at), EXTRACT(HOUR FROM created_at)
                FROM records
                WHERE id = 3
            `);
            expect(utcBoundary.rows).toEqual([[3, 31, 23]]);
        });

        it('supports native POSITION(substring IN string)', () => {
            const result = run(`
                SELECT POSITION('li' IN "full name")
                FROM records
                WHERE id = 1
            `);

            expect(result.errors).toEqual([]);
            expect(result.rows).toEqual([[2]]);
        });

        it('supports IS DISTINCT FROM with NULL-safe semantics', () => {
            const distinct = run(`
                SELECT id
                FROM records
                WHERE nickname IS DISTINCT FROM 'Bobby'
                ORDER BY id
            `);
            const notDistinct = run(`
                SELECT id
                FROM records
                WHERE nickname IS NOT DISTINCT FROM NULL
                ORDER BY id
            `);

            expect(distinct.errors).toEqual([]);
            expect(distinct.rows).toEqual([[1], [3], [4]]);
            expect(notDistinct.rows).toEqual([[1], [4]]);
        });

        it('supports aggregate FILTER with exact NULL behavior', () => {
            const result = run(`
                SELECT
                    COUNT(*) FILTER (WHERE score >= 10) AS high_count,
                    SUM(score) FILTER (WHERE department = 'Sales') AS sales_total
                FROM records
            `);

            expect(result.errors).toEqual([]);
            expect(result.rows).toEqual([[2, 10]]);
        });

        it('supports bare CURRENT_DATE and CURRENT_TIMESTAMP keywords', () => {
            const result = run(`SELECT CURRENT_DATE AS current_day, CURRENT_TIMESTAMP AS current_time`);

            expect(result.errors).toEqual([]);
            expect(result.rows[0][0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(result.rows[0][1]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        });
    });

    describe('MySQL', () => {
        it('supports backtick identifiers and IF(condition, true, false)', () => {
            const result = run(`
                SELECT \`full name\`, IF(score >= 10, 'high', 'low')
                FROM records
                ORDER BY id
            `);

            expect(result.errors).toEqual([]);
            expect(result.rows).toEqual([
                ['Alice', 'high'],
                ['Bob', 'low'],
                ['Carla', 'low'],
                ['dave', 'high'],
            ]);
        });

        it('supports GROUP_CONCAT DISTINCT ORDER BY SEPARATOR syntax', () => {
            const result = run(`
                SELECT GROUP_CONCAT(
                    DISTINCT department
                    ORDER BY department DESC
                    SEPARATOR '|'
                )
                FROM records
            `);

            expect(result.errors).toEqual([]);
            expect(result.rows).toEqual([['Sales|Eng']]);
        });

        it('supports the NULL-safe equality operator', () => {
            const nulls = run(`SELECT id FROM records WHERE nickname <=> NULL ORDER BY id`);
            const value = run(`SELECT id FROM records WHERE nickname <=> 'Bobby' ORDER BY id`);

            expect(nulls.errors).toEqual([]);
            expect(nulls.rows).toEqual([[1], [4]]);
            expect(value.rows).toEqual([[2]]);
        });

        it('supports LIMIT offset,count syntax', () => {
            const result = run(`
                SELECT id
                FROM records
                ORDER BY id
                LIMIT 1, 2
            `);

            expect(result.errors).toEqual([]);
            expect(result.rows).toEqual([[2], [3]]);
        });

        it('supports JSON_EXTRACT and JSON_UNQUOTE together', () => {
            const result = run(`
                SELECT
                    JSON_EXTRACT(metadata, '$.level'),
                    JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.active'))
                FROM records
                WHERE id = 1
            `);

            expect(result.errors).toEqual([]);
            expect(result.rows).toEqual([[3, 'true']]);
        });

        it('takes the false IF branch for NULL conditions', () => {
            const result = run(`
                SELECT IF(score > 0, 'positive', 'missing')
                FROM records
                WHERE id = 3
            `);

            expect(result.errors).toEqual([]);
            expect(result.rows).toEqual([['missing']]);
        });
    });

    describe('SQL Server', () => {
        it('supports bracket identifiers and Unicode string literals', () => {
            const result = run(`
                SELECT [full name]
                FROM records
                WHERE [full name] = N'Alice'
            `);

            expect(result.errors).toEqual([]);
            expect(result.rows).toEqual([['Alice']]);
        });

        it('supports bare DATEADD and DATEDIFF dateparts', () => {
            const result = run(`
                SELECT
                    DATEADD(DAY, 2, created_at),
                    DATEDIFF(DAY, created_at, '2024-01-20T10:20:30Z')
                FROM records
                WHERE id = 1
            `);

            expect(result.errors).toEqual([]);
            expect(result.rows).toEqual([['2024-01-17T10:20:30.000Z', 5]]);
        });

        it('supports typed CONVERT and TRY_CONVERT calls', () => {
            const result = run(`
                SELECT
                    CONVERT(VARCHAR(10), score),
                    TRY_CONVERT(INT, '42'),
                    TRY_CONVERT(INT, 'not-a-number')
                FROM records
                WHERE id = 1
            `);

            expect(result.errors).toEqual([]);
            expect(result.rows).toEqual([['12.5', 42, null]]);
        });

        it('rejects unsupported CONVERT style arguments instead of ignoring them', () => {
            const result = run(`
                SELECT CONVERT(VARCHAR(10), created_at, 23)
                FROM records
                WHERE id = 1
            `);

            expect(result.errors[0]?.message).toContain('style arguments are not supported');
        });

        it('supports canonical CHARINDEX(search, expression)', () => {
            const result = run(`
                SELECT CHARINDEX('li', [full name]), LEN([full name]), LEN('text   ')
                FROM records
                WHERE id = 1
            `);

            expect(result.errors).toEqual([]);
            expect(result.rows).toEqual([[2, 5, 4]]);
        });

        it('supports TOP with deterministic ordering', () => {
            const result = run(`
                SELECT TOP (2) id, score
                FROM records
                ORDER BY score DESC
            `);

            expect(result.errors).toEqual([]);
            expect(result.rows).toEqual([[1, 12.5], [4, 10]]);
        });

        it('supports OFFSET ROWS FETCH NEXT ROWS ONLY', () => {
            const result = run(`
                SELECT id
                FROM records
                ORDER BY id
                OFFSET 1 ROWS
                FETCH NEXT 2 ROWS ONLY
            `);

            expect(result.errors).toEqual([]);
            expect(result.rows).toEqual([[2], [3]]);
        });
    });

    describe('SQLite', () => {
        it('supports DATE modifiers', () => {
            const result = run(`
                SELECT
                    DATE(created_at, '+1 day'),
                    DATE(created_at, 'start of month', '+1 month', '-1 day')
                FROM records
                WHERE id = 1
            `);

            expect(result.errors).toEqual([]);
            expect(result.rows).toEqual([['2024-01-16', '2024-01-31']]);
        });

        it('supports DATETIME modifiers', () => {
            const result = run(`
                SELECT DATETIME(created_at, '+2 hours', '+30 minutes')
                FROM records
                WHERE id = 1
            `);

            expect(result.errors).toEqual([]);
            expect(result.rows).toEqual([['2024-01-15 12:50:30']]);
        });

        it('supports negative SUBSTR positions', () => {
            const result = run(`
                SELECT SUBSTR("full name", -2), SUBSTR("full name", -4, 2)
                FROM records
                WHERE id = 1
            `);

            expect(result.errors).toEqual([]);
            expect(result.rows).toEqual([['ce', 'li']]);
        });

        it('supports general IS and IS NOT comparisons', () => {
            const isValue = run(`SELECT id FROM records WHERE nickname IS 'Bobby' ORDER BY id`);
            const isNotValue = run(`SELECT id FROM records WHERE nickname IS NOT 'Bobby' ORDER BY id`);

            expect(isValue.errors).toEqual([]);
            expect(isValue.rows).toEqual([[2]]);
            expect(isNotValue.rows).toEqual([[1], [3], [4]]);
        });

        it('supports TYPEOF and IIF on NULL values', () => {
            const result = run(`
                SELECT TYPEOF(score), IIF(score IS NULL, 'missing', 'present')
                FROM records
                WHERE id = 3
            `);

            expect(result.errors).toEqual([]);
            expect(result.rows).toEqual([['null', 'missing']]);
        });

        it('preserves NULL through concatenation', () => {
            const result = run(`
                SELECT nickname || ':' || "full name"
                FROM records
                WHERE id IN (1, 2)
                ORDER BY id
            `);

            expect(result.errors).toEqual([]);
            expect(result.rows).toEqual([[null], ['Bobby:Bob']]);
        });
    });
});
