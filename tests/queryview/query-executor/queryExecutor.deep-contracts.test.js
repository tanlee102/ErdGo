/** Protects deep Query View planning, evaluation, and result-shape contracts. */
import { describe, expect, it } from 'vitest';
import { createSqlExecutor } from '@/features/data-view/lib/sqlExecutor.js';
import { executeSelectQuery } from '@/features/query-view/lib/queryExecutor.js';

function tablesFor(sql) {
    return createSqlExecutor().execute(sql).tables;
}

function query(sql, select) {
    return executeSelectQuery({ tables: tablesFor(sql), query: select });
}

const baseSql = `
    CREATE TABLE users (id INT, name TEXT, region TEXT, tier TEXT);
    CREATE TABLE events (id INT, user_id INT, kind TEXT, score INT, created_at TEXT);
    INSERT INTO users (id, name, region, tier) VALUES
        (1, 'Ada', 'north', 'pro'),
        (2, 'Grace', 'north', 'free'),
        (3, 'Linus', 'south', 'pro'),
        (4, 'Mina', 'west', NULL);
    INSERT INTO events (id, user_id, kind, score, created_at) VALUES
        (10, 1, 'login', 3, '2026-01-01'),
        (11, 1, 'export', 9, '2026-01-02'),
        (12, 2, 'login', 1, '2026-01-03'),
        (13, 3, 'export', 7, '2026-01-04');
`;

describe('Query View executor deep contracts', () => {
    it('combines CTE filtering, left joins, grouping, and case expressions', () => {
        const result = query(baseSql, `
            WITH high_events AS (
                SELECT user_id, score FROM events WHERE score >= 7
            )
            SELECT
                u.region,
                COUNT(he.score) AS high_count,
                CASE WHEN COUNT(he.score) > 0 THEN 'active' ELSE 'quiet' END AS state
            FROM users u
            LEFT JOIN high_events he ON he.user_id = u.id
            GROUP BY u.region
            ORDER BY u.region
        `);

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([
            ['north', 1, 'active'],
            ['south', 1, 'active'],
            ['west', 0, 'quiet'],
        ]);
    });

    it('honors NOT IN, NOT BETWEEN, and IS NULL predicates together', () => {
        const result = query(baseSql, `
            SELECT name
            FROM users
            WHERE (tier NOT IN ('free') OR tier IS NULL)
              AND id NOT BETWEEN 2 AND 3
            ORDER BY id
        `);

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([['Ada'], ['Mina']]);
    });

    it('deduplicates UNION while UNION ALL keeps duplicates', () => {
        const distinct = query(baseSql, `
            SELECT region FROM users WHERE region = 'north'
            UNION
            SELECT region FROM users WHERE id IN (1, 2)
            ORDER BY region
        `);
        const allRows = query(baseSql, `
            SELECT region FROM users WHERE region = 'north'
            UNION ALL
            SELECT region FROM users WHERE id IN (1, 2)
        `);

        expect(distinct.rows).toEqual([['north']]);
        expect(allRows.rows).toHaveLength(4);
    });

    it('evaluates recursive CTEs with delta iteration and column aliases', () => {
        const result = query(baseSql, `
            WITH RECURSIVE nums(n) AS (
                SELECT 1
                UNION ALL
                SELECT n + 1 FROM nums WHERE n < 5
            )
            SELECT n FROM nums ORDER BY n
        `);

        expect(result.errors).toEqual([]);
        expect(result.rows).toEqual([[1], [2], [3], [4], [5]]);
    });

    it('keeps set operation column-count errors user-visible', () => {
        const result = query(baseSql, `
            SELECT id, name FROM users
            UNION
            SELECT id FROM events
        `);

        expect(result.errors[0].message).toContain('same number of columns');
    });
});
