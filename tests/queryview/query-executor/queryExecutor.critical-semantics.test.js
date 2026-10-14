/** Locks SQL semantics whose approximation would silently produce wrong results. */
import { describe, expect, it } from 'vitest';
import { executeSelectQuery } from '@/features/query-view/lib/queryExecutor.js';

function table(name, columnNames, rows) {
    return {
        name,
        columns: columnNames.map((columnName) => ({ name: columnName, type: 'INT' })),
        rows,
    };
}

const tables = new Map([
    ['left_values', table('left_values', ['value'], [
        { value: 1 },
        { value: 1 },
        { value: 1 },
        { value: 2 },
        { value: null },
    ])],
    ['right_values', table('right_values', ['value'], [
        { value: 1 },
        { value: 1 },
        { value: null },
    ])],
    ['pairs', table('pairs', ['left_value', 'right_value'], [
        { left_value: 1, right_value: 10 },
        { left_value: 2, right_value: 20 },
    ])],
]);

function run(query) {
    return executeSelectQuery({ tables, query });
}

describe('Query executor critical SQL semantics', () => {
    it('preserves duplicate multiplicity for INTERSECT ALL', () => {
        const result = run(`
            SELECT value FROM left_values
            INTERSECT ALL
            SELECT value FROM right_values
        `);

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([[1], [1], [null]]);
    });

    it('subtracts duplicate multiplicity for EXCEPT ALL', () => {
        const result = run(`
            SELECT value FROM left_values
            EXCEPT ALL
            SELECT value FROM right_values
        `);

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([[1], [2]]);
    });

    it('evaluates INTERSECT before UNION and EXCEPT', () => {
        const unionResult = run(`
            SELECT 1 AS value
            UNION
            SELECT 2
            INTERSECT
            SELECT 2
        `);
        const exceptResult = run(`
            SELECT 1 AS value
            EXCEPT
            SELECT 2
            INTERSECT
            SELECT 2
        `);

        expect(unionResult.errors).toEqual([]);
        expect(unionResult.rows).toEqual([[1], [2]]);
        expect(exceptResult.errors).toEqual([]);
        expect(exceptResult.rows).toEqual([[1]]);
    });

    it('applies trailing ORDER BY and LIMIT to the compound result', () => {
        const result = run(`
            SELECT 3 AS value
            UNION ALL
            SELECT 1
            UNION ALL
            SELECT 2
            ORDER BY value
            LIMIT 2
        `);

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([[1], [2]]);
        expect(result.meta.rowCount).toBe(2);
    });

    it('applies OFFSET and FETCH after all set operations', () => {
        const result = run(`
            SELECT 4 AS value
            UNION ALL
            SELECT 1
            UNION ALL
            SELECT 3
            UNION ALL
            SELECT 2
            ORDER BY 1
            OFFSET 1 ROWS
            FETCH NEXT 2 ROWS ONLY
        `);

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([[2], [3]]);
    });

    it('rejects compound ordering by a non-output expression', () => {
        const result = run(`
            SELECT 1 AS value
            UNION ALL
            SELECT 2
            ORDER BY value + 1
        `);

        expect(result.rows).toEqual([]);
        expect(result.errors[0]?.message).toContain('output column or select-list position');
    });

    it('treats NULL from NOT IN lists and subqueries as UNKNOWN', () => {
        const subqueryResult = run(`
            SELECT value
            FROM left_values
            WHERE value NOT IN (SELECT value FROM right_values)
        `);
        const listResult = run(`
            SELECT value
            FROM left_values
            WHERE value NOT IN (1, NULL)
        `);
        const negatedInResult = run(`
            SELECT value
            FROM left_values
            WHERE NOT (value IN (1, NULL))
        `);

        expect(subqueryResult.errors).toEqual([]);
        expect(subqueryResult.rows).toEqual([]);
        expect(listResult.rows).toEqual([]);
        expect(negatedInResult.rows).toEqual([]);
    });

    it('preserves UNKNOWN through NOT, AND, and OR', () => {
        const negatedComparison = run(`
            SELECT value
            FROM left_values
            WHERE NOT (value = NULL)
        `);
        const trueOrUnknown = run(`SELECT 'kept' AS state WHERE TRUE OR (NULL = 1)`);
        const falseAndUnknown = run(`SELECT 'hidden' AS state WHERE FALSE AND (NULL = 1)`);
        const negatedUnknown = run(`SELECT 'hidden' AS state WHERE NOT ((NULL = 1) OR FALSE)`);

        expect(negatedComparison.errors).toEqual([]);
        expect(negatedComparison.rows).toEqual([]);
        expect(trueOrUnknown.rows).toEqual([['kept']]);
        expect(falseAndUnknown.rows).toEqual([]);
        expect(negatedUnknown.rows).toEqual([]);
    });

    it('rejects scalar subqueries that return multiple rows', () => {
        const result = run(`SELECT (SELECT value FROM right_values) AS value`);

        expect(result.rows).toEqual([]);
        expect(result.errors[0]?.message).toContain('Scalar subquery returned 3 rows');
    });

    it('rejects scalar and IN subqueries that return multiple columns', () => {
        const scalarResult = run(`
            SELECT (
                SELECT left_value, right_value
                FROM pairs
                LIMIT 1
            ) AS value
        `);
        const inResult = run(`
            SELECT value
            FROM left_values
            WHERE value IN (SELECT left_value, right_value FROM pairs)
        `);

        expect(scalarResult.errors[0]?.message).toContain('Scalar subquery must return exactly one column');
        expect(inResult.errors[0]?.message).toContain('IN subquery must return exactly one column');
    });

    it('keeps valid zero-row and one-row scalar subqueries working', () => {
        const result = run(`
            SELECT
                (SELECT value FROM right_values WHERE value = 999) AS missing_value,
                (SELECT value FROM right_values WHERE value = 1 LIMIT 1) AS found_value
        `);

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([[null, 1]]);
    });
});
