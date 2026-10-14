/** Verifies SQL window-frame boundaries and peer-row semantics. */
import { describe, expect, it } from 'vitest';
import { executeSelectQuery } from '@/features/query-view/lib/queryExecutor.js';

function col(name, type = 'TEXT') {
    return { name, type, pk: false, fk: false, notNull: false, unique: false, defaultVal: null };
}

const transactions = {
    name: 'transactions',
    columns: [
        col('id', 'INT'),
        col('team'),
        col('seq', 'INT'),
        col('amount', 'NUMERIC'),
        col('approved', 'BOOLEAN'),
    ],
    rows: [
        { id: 1, team: 'A', seq: 1, amount: 10, approved: true },
        { id: 2, team: 'A', seq: 2, amount: 20, approved: false },
        { id: 3, team: 'A', seq: 2, amount: 5, approved: true },
        { id: 4, team: 'A', seq: 3, amount: 7, approved: true },
        { id: 5, team: 'B', seq: 1, amount: 4, approved: true },
        { id: 6, team: 'B', seq: 2, amount: 6, approved: true },
    ],
};

const tables = new Map([[transactions.name, transactions]]);

function run(query) {
    return executeSelectQuery({ tables, query });
}

describe('Query executor window frames', () => {
    it('uses peer-aware cumulative semantics for ordered aggregate windows', () => {
        const result = run(`
            SELECT id,
                SUM(amount) OVER (PARTITION BY team ORDER BY seq) AS peer_total,
                SUM(amount) OVER (
                    PARTITION BY team
                    ORDER BY seq
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS row_total
            FROM transactions
            ORDER BY team, seq, id
        `);

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([
            [1, 10, 10],
            [2, 35, 30],
            [3, 35, 35],
            [4, 42, 42],
            [5, 4, 4],
            [6, 10, 10],
        ]);
    });

    it('uses the implicit peer-aware ordered frame for FIRST_VALUE and LAST_VALUE', () => {
        const result = run(`
            SELECT id,
                FIRST_VALUE(amount) OVER (PARTITION BY team ORDER BY seq) AS frame_first,
                LAST_VALUE(amount) OVER (PARTITION BY team ORDER BY seq) AS frame_last
            FROM transactions
            WHERE team = 'A'
            ORDER BY id
        `);

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([
            [1, 10, 10],
            [2, 10, 5],
            [3, 10, 5],
            [4, 10, 7],
        ]);
    });

    it('assigns larger NTILE buckets before smaller buckets', () => {
        const result = run(`
            SELECT id, NTILE(4) OVER (ORDER BY id) AS bucket
            FROM transactions
            ORDER BY id
        `);

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([
            [1, 1],
            [2, 1],
            [3, 2],
            [4, 2],
            [5, 3],
            [6, 4],
        ]);
    });

    it('evaluates sliding and forward-looking ROWS frames', () => {
        const result = run(`
            SELECT id,
                ROUND(AVG(amount) OVER (
                    PARTITION BY team
                    ORDER BY seq, id
                    ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING
                ), 2) AS moving_average,
                SUM(amount) OVER (
                    PARTITION BY team
                    ORDER BY seq, id
                    ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING
                ) AS remaining_total
            FROM transactions
            ORDER BY team, seq, id
        `);

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([
            [1, 15, 42],
            [2, 11.67, 32],
            [3, 10.67, 12],
            [4, 6, 7],
            [5, 5, 10],
            [6, 5, 6],
        ]);
    });

    it('returns aggregate identities for frames that extend past the partition', () => {
        const result = run(`
            SELECT id,
                SUM(amount) OVER (
                    PARTITION BY team
                    ORDER BY seq, id
                    ROWS BETWEEN 2 FOLLOWING AND 3 FOLLOWING
                ) AS future_sum,
                COUNT(*) OVER (
                    PARTITION BY team
                    ORDER BY seq, id
                    ROWS BETWEEN 2 FOLLOWING AND 3 FOLLOWING
                ) AS future_count
            FROM transactions
            WHERE team = 'A'
            ORDER BY id
        `);

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([
            [1, 12, 2],
            [2, 7, 1],
            [3, null, 0],
            [4, null, 0],
        ]);
    });

    it('combines FILTER with a cumulative frame', () => {
        const result = run(`
            SELECT id,
                SUM(amount) FILTER (WHERE approved = TRUE) OVER (
                    PARTITION BY team
                    ORDER BY seq, id
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS approved_total
            FROM transactions
            WHERE team = 'A'
            ORDER BY id
        `);

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([
            [1, 10],
            [2, 10],
            [3, 15],
            [4, 22],
        ]);
    });

    it('keeps aggregate ordering separate from window ordering', () => {
        const result = run(`
            SELECT id,
                ARRAY_AGG(amount ORDER BY amount DESC) OVER (
                    PARTITION BY team
                    ORDER BY seq, id
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS amounts_desc
            FROM transactions
            WHERE team = 'A'
            ORDER BY id
        `);

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([
            [1, [10]],
            [2, [20, 10]],
            [3, [20, 10, 5]],
            [4, [20, 10, 7, 5]],
        ]);
    });

    it('applies explicit frames to FIRST_VALUE and LAST_VALUE', () => {
        const result = run(`
            SELECT id,
                FIRST_VALUE(amount) OVER (
                    PARTITION BY team
                    ORDER BY seq, id
                    ROWS BETWEEN 1 PRECEDING AND CURRENT ROW
                ) AS frame_first,
                LAST_VALUE(amount) OVER (
                    PARTITION BY team
                    ORDER BY seq, id
                    ROWS BETWEEN CURRENT ROW AND 1 FOLLOWING
                ) AS frame_last
            FROM transactions
            WHERE team = 'A'
            ORDER BY id
        `);

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([
            [1, 10, 20],
            [2, 10, 5],
            [3, 20, 7],
            [4, 5, 7],
        ]);
    });

    it('composes grouped CTEs with multiple framed windows', () => {
        const result = run(`
            WITH daily AS (
                SELECT team, seq, SUM(amount) AS daily_amount
                FROM transactions
                GROUP BY team, seq
            )
            SELECT team, seq, daily_amount,
                SUM(daily_amount) OVER (
                    PARTITION BY team
                    ORDER BY seq
                    ROWS UNBOUNDED PRECEDING
                ) AS running_amount,
                AVG(daily_amount) OVER (
                    PARTITION BY team
                    ORDER BY seq
                    ROWS BETWEEN 1 PRECEDING AND CURRENT ROW
                ) AS recent_average
            FROM daily
            ORDER BY team, seq
        `);

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([
            ['A', 1, 10, 10, 10],
            ['A', 2, 25, 35, 17.5],
            ['A', 3, 7, 42, 16],
            ['B', 1, 4, 4, 4],
            ['B', 2, 6, 10, 5],
        ]);
    });

    it('lets ORDER BY choose the surviving DISTINCT ON row', () => {
        const result = run(`
            SELECT DISTINCT ON (team) team, id, amount
            FROM transactions
            ORDER BY team, amount DESC, id
        `);

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([
            ['A', 2, 20],
            ['B', 6, 6],
        ]);
    });

    it('reports invalid DISTINCT ON expressions instead of falling back silently', () => {
        const result = run(`
            SELECT DISTINCT ON (missing_column) team, id
            FROM transactions
            ORDER BY team, id
        `);

        expect(result.rows).toEqual([]);
        expect(result.errors[0]?.message).toContain('Unknown column "missing_column"');
    });

    it('reports unsupported or invalid frames clearly', () => {
        const rangeResult = run(`
            SELECT SUM(amount) OVER (ORDER BY id RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
            FROM transactions
        `);
        expect(rangeResult.errors[0]?.message).toContain('RANGE');
        expect(rangeResult.errors[0]?.message).toContain('Use ROWS');

        const reversedResult = run(`
            SELECT SUM(amount) OVER (ORDER BY id ROWS BETWEEN CURRENT ROW AND 1 PRECEDING)
            FROM transactions
        `);
        expect(reversedResult.errors[0]?.message).toContain('start must not be after');
    });
});
