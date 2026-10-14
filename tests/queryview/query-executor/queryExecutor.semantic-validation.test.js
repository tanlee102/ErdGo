/** Ensures unsupported or invalid queries fail with actionable positioned diagnostics. */
import { describe, expect, it } from 'vitest';
import { executeSelectQuery } from '@/features/query-view/lib/queryExecutor.js';

function table(name, columns, rows) {
    return {
        name,
        columns: columns.map((column) => ({ name: column, type: 'TEXT' })),
        rows,
    };
}

const tables = new Map([
    ['metrics', table('metrics', ['id', 'team', 'label', 'score'], [
        { id: 1, team: 'red', label: 'one', score: 10 },
        { id: 2, team: 'red', label: 'two', score: 20 },
        { id: 3, team: 'blue', label: 'three', score: 30 },
    ])],
    ['owners', table('owners', ['id', 'team'], [
        { id: 1, team: 'red' },
        { id: 2, team: 'blue' },
    ])],
]);

function run(query) {
    return executeSelectQuery({ tables, query });
}

function expectSemanticError(query, message) {
    const result = run(query);
    expect(result.rows).toEqual([]);
    expect(result.errors[0]?.message).toContain(message);
}

describe('Query executor semantic validation', () => {
    it('rejects aggregate and window expressions before WHERE evaluation', () => {
        expectSemanticError('SELECT team, COUNT(*) FROM metrics WHERE COUNT(*) > 1 GROUP BY team', 'WHERE cannot contain aggregate');
        expectSemanticError('SELECT team FROM metrics WHERE ROW_NUMBER() OVER (ORDER BY id) = 1', 'WHERE cannot contain window');
    });

    it('rejects aggregate and window expressions in JOIN predicates', () => {
        expectSemanticError(`
            SELECT m.id
            FROM metrics m
            JOIN owners o ON COUNT(*) > 0
        `, 'JOIN ON cannot contain aggregate');
        expectSemanticError(`
            SELECT m.id
            FROM metrics m
            JOIN owners o ON ROW_NUMBER() OVER (ORDER BY m.id) = 1
        `, 'JOIN ON cannot contain window');
    });

    it('rejects aggregate and window expressions in GROUP BY', () => {
        expectSemanticError('SELECT COUNT(*) FROM metrics GROUP BY COUNT(*)', 'GROUP BY cannot contain aggregate');
        expectSemanticError('SELECT COUNT(*) FROM metrics GROUP BY ROW_NUMBER() OVER (ORDER BY id)', 'GROUP BY cannot contain window');
    });

    it('rejects ungrouped projections and HAVING references instead of choosing an arbitrary row', () => {
        expectSemanticError('SELECT team, label, COUNT(*) FROM metrics GROUP BY team', 'must appear in GROUP BY or be used in an aggregate');
        expectSemanticError('SELECT COUNT(*) FROM metrics HAVING team = \'red\'', 'must appear in GROUP BY or be used in an aggregate');
        expectSemanticError('SELECT * FROM metrics GROUP BY team', 'SELECT * is not valid in an aggregate query');
    });

    it('allows deterministic expressions derived only from grouping keys', () => {
        const result = run(`
            SELECT team, UPPER(team) AS normalized_team, COUNT(*) AS total, SUM(score) AS score_total
            FROM metrics
            GROUP BY team
            HAVING UPPER(team) IN ('RED', 'BLUE')
            ORDER BY normalized_team
        `);

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([
            ['blue', 'BLUE', 1, 30],
            ['red', 'RED', 2, 30],
        ]);
    });

    it('requires source aliases to be unique and hides an aliased table name', () => {
        expectSemanticError(`
            SELECT a.id
            FROM metrics a
            JOIN metrics a ON a.id = a.id
        `, 'Duplicate table or alias "a"');
        expectSemanticError('SELECT metrics.id FROM metrics AS m', 'Unknown table or alias "metrics"');
    });

    it('rejects duplicate and malformed CTE declarations', () => {
        expectSemanticError(`
            WITH totals AS (SELECT 1 AS value), totals AS (SELECT 2 AS value)
            SELECT value FROM totals
        `, 'CTE "totals" is declared more than once');
        expectSemanticError(`
            WITH totals(value other) AS (SELECT 1 AS value)
            SELECT value FROM totals
        `, 'Invalid column alias in CTE "totals"');
    });

    it('supports portable recursive CTE UNION semantics and rejects malformed recursion', () => {
        const result = run(`
            WITH RECURSIVE walk(n) AS (
                SELECT 1
                UNION
                SELECT n FROM walk WHERE n = 1
            )
            SELECT n FROM walk
        `);
        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([[1]]);

        expectSemanticError(`
            WITH RECURSIVE broken(n) AS (SELECT 1 INTERSECT SELECT n FROM broken)
            SELECT n FROM broken
        `, 'must contain exactly an anchor query UNION');
    });

    it('fails closed on dangling commas and missing separators', () => {
        expectSemanticError('SELECT team, FROM metrics', 'Empty item in SELECT list');
        expectSemanticError('SELECT COALESCE(team,) FROM metrics', 'Function argument is empty');
        expectSemanticError('SELECT id FROM metrics WHERE id IN (1,)', 'IN list cannot end with a comma');
        expectSemanticError('SELECT id FROM metrics WHERE id IN (1 2)', 'IN values must be separated by commas');
    });

    it('rejects unbalanced parentheses before building an expression tree', () => {
        const closing = run('SELECT COALESCE(score, 0)) FROM metrics');
        expect(closing.rows).toEqual([]);
        expect(closing.errors[0]?.message).toMatch(/closing parenthesis/i);
        expect(closing.errors[0]?.position).toMatchObject({ line: 1 });

        const opening = run('SELECT COALESCE(score, (0) FROM metrics');
        expect(opening.rows).toEqual([]);
        expect(opening.errors[0]?.message).toMatch(/opening parenthesis/i);
        expect(opening.errors[0]?.position).toMatchObject({ line: 1 });
    });

    it('requires deterministic PostgreSQL DISTINCT ON ordering', () => {
        const result = run(`
            SELECT DISTINCT ON (team) team, score
            FROM metrics
            ORDER BY team, score DESC
        `);
        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([
            ['blue', 30],
            ['red', 20],
        ]);

        expectSemanticError('SELECT DISTINCT ON (team) team FROM metrics', 'DISTINCT ON requires ORDER BY');
        expectSemanticError('SELECT DISTINCT ON (team) team FROM metrics ORDER BY score DESC', 'DISTINCT ON expressions must match');
    });

    it.each([
        ['sqlite', [[null], [1], [2]], [[2], [1], [null]]],
        ['mysql', [[null], [1], [2]], [[2], [1], [null]]],
        ['mssql', [[null], [1], [2]], [[2], [1], [null]]],
        ['postgres', [[1], [2], [null]], [[null], [2], [1]]],
    ])('uses %s default NULL ordering while explicit NULLS modifiers still win', (dialect, ascending, descending) => {
        const dialectTables = new Map([[
            'sortable',
            {
                name: 'sortable',
                dialect,
                columns: [{ name: 'value', type: 'INT' }],
                rows: [{ value: 2 }, { value: null }, { value: 1 }],
            },
        ]]);

        expect(executeSelectQuery({ tables: dialectTables, query: 'SELECT value FROM sortable ORDER BY value ASC' }).rows).toEqual(ascending);
        expect(executeSelectQuery({ tables: dialectTables, query: 'SELECT value FROM sortable ORDER BY value DESC' }).rows).toEqual(descending);
        expect(executeSelectQuery({ tables: dialectTables, query: 'SELECT value FROM sortable ORDER BY value DESC NULLS LAST' }).rows).toEqual([[2], [1], [null]]);
    });
});
