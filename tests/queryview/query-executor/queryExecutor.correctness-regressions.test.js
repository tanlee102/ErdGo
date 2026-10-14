/** Regression coverage for SQL semantics shared by Query View dialects. */
import { describe, expect, it } from 'vitest';
import { executeSelectQuery } from '@/features/query-view/lib/queryExecutor.js';

function table(name, dialect, columns, rows) {
    return {
        name,
        dialect,
        columns: columns.map(([columnName, type]) => ({ name: columnName, type })),
        rows,
    };
}

describe('Query View correctness regressions', () => {
    it('preserves NULL through unary signs and accepts unary plus', () => {
        const result = executeSelectQuery({
            tables: new Map(),
            query: 'SELECT -NULL AS negative_null, +NULL AS positive_null, +7 AS positive_value, ROUND(-1.5, 0) AS rounded_value',
        });

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([[null, null, 7, -2]]);
    });

    it('rounds decimal half-ties deterministically despite binary floating-point representation', () => {
        const result = executeSelectQuery({
            tables: new Map(),
            query: `
                SELECT
                    ROUND(1.005, 2) AS positive_fraction,
                    ROUND(-1.005, 2) AS negative_fraction,
                    ROUND(149.5, -1) AS positive_tens,
                    ROUND(-149.5, -1) AS negative_tens
            `,
        });

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([[1.01, -1.01, 150, -150]]);
    });

    it('supports SQL-standard IS UNKNOWN and IS NOT UNKNOWN predicates', () => {
        const result = executeSelectQuery({
            tables: new Map(),
            query: `
                SELECT
                    NULL IS UNKNOWN AS null_is_unknown,
                    1 IS NOT UNKNOWN AS one_is_known,
                    NULL IS NOT UNKNOWN AS null_is_known
            `,
        });

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([[true, true, false]]);
    });

    it('returns native JSON scalar types for SQLite ->> and text for PostgreSQL ->>', () => {
        const row = { payload: '{"count":7,"enabled":true,"none":null,"object":{"x":1}}' };
        const query = `SELECT payload->>'count', payload->>'enabled', payload->>'none', payload->>'object' FROM records`;
        const sqlite = executeSelectQuery({
            tables: new Map([['records', table('records', 'sqlite', [['payload', 'JSON']], [row])]]),
            query,
        });
        const postgres = executeSelectQuery({
            tables: new Map([['records', table('records', 'postgres', [['payload', 'JSONB']], [row])]]),
            query,
        });

        expect(sqlite.errors).toEqual([]);
        expect(sqlite.rows).toEqual([[7, 1, null, '{"x":1}']]);
        expect(postgres.errors).toEqual([]);
        expect(postgres.rows).toEqual([['7', 'true', null, '{"x":1}']]);
    });

    it('keeps SQLite JSON scalar types through arithmetic, grouping, and ordering', () => {
        const records = table(
            'records',
            'sqlite',
            [['payload', 'JSON']],
            [
                { payload: '{"count":7,"enabled":true}' },
                { payload: '{"count":5,"enabled":true}' },
                { payload: '{"count":3,"enabled":false}' },
            ],
        );
        const result = executeSelectQuery({
            tables: new Map([['records', records]]),
            query: `
                SELECT
                    payload->>'enabled' AS enabled,
                    SUM(payload->>'count' + 1) AS adjusted_total
                FROM records
                GROUP BY payload->>'enabled'
                ORDER BY enabled
            `,
        });

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([
            [0, 4],
            [1, 14],
        ]);
    });

    it('keeps PostgreSQL text equality case-sensitive without breaking UUID equality', () => {
        const records = table(
            'records',
            'postgres',
            [
                ['id', 'UUID'],
                ['label', 'TEXT'],
            ],
            [
                { id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', label: 'Ada' },
                { id: 'b1c2d3e4-f5a6-7890-abcd-ef1234567890', label: 'ada' },
            ],
        );

        const textResult = executeSelectQuery({
            tables: new Map([['records', records]]),
            query: "SELECT label FROM records WHERE label = 'ada'",
        });
        const uuidResult = executeSelectQuery({
            tables: new Map([['records', records]]),
            query: "SELECT label FROM records WHERE id = 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890'",
        });

        expect(textResult.errors).toEqual([]);
        expect(textResult.rows).toEqual([['ada']]);
        expect(uuidResult.errors).toEqual([]);
        expect(uuidResult.rows).toEqual([['Ada']]);
    });

    it('compares numeric-looking PostgreSQL text lexically in filters, ordering, and extrema', () => {
        const labels = table(
            'labels',
            'postgres',
            [['value', 'TEXT']],
            [
                { value: '2' },
                { value: '10' },
                { value: '02' },
            ],
        );
        const tables = new Map([['labels', labels]]);
        const filtered = executeSelectQuery({
            tables,
            query: `SELECT value FROM labels WHERE value > '10' ORDER BY value`,
        });
        const extrema = executeSelectQuery({
            tables,
            query: `
                SELECT
                    MIN(value) AS minimum,
                    MAX(value) AS maximum,
                    LEAST('2', '10') AS least_value,
                    GREATEST('2', '10') AS greatest_value
                FROM labels
            `,
        });

        expect(filtered.errors).toEqual([]);
        expect(filtered.rows).toEqual([['2']]);
        expect(extrema.errors).toEqual([]);
        expect(extrema.rows).toEqual([['02', '2', '10', '2']]);
    });

    it('propagates UNKNOWN through nested boolean logic instead of treating it as false too early', () => {
        const result = executeSelectQuery({
            tables: new Map(),
            query: `
                SELECT CASE
                    WHEN NOT (NULL IS UNKNOWN) OR NULL = 1 THEN 'incorrect'
                    WHEN (NULL = 1) IS UNKNOWN THEN 'unknown-preserved'
                    ELSE 'incorrect'
                END AS outcome
            `,
        });

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([['unknown-preserved']]);
    });
});
