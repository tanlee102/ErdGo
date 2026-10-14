/** Regression coverage for Data View value materialization semantics. */
import { describe, expect, it } from 'vitest';
import { createSqlExecutor } from '@/features/data-view/lib/sqlExecutor.js';

function execute(sql, dialect = 'sqlite') {
    return createSqlExecutor({ dialect }).execute(sql);
}

describe('Data View correctness regressions', () => {
    it('unescapes SQL quotes when applying a declared string default', () => {
        const result = execute(`
            CREATE TABLE authors (
                id INTEGER PRIMARY KEY,
                publisher TEXT DEFAULT 'O''Reilly'
            );
            INSERT INTO authors (id) VALUES (1);
            INSERT INTO authors (id, publisher) VALUES (2, DEFAULT);
        `);

        expect(result.log.filter((entry) => entry.type === 'error')).toEqual([]);
        expect(result.tables.get('authors').rows).toEqual([
            { id: 1, publisher: "O'Reilly" },
            { id: 2, publisher: "O'Reilly" },
        ]);
    });

    it('materializes CURRENT_DATE and CURRENT_TIME using their SQL value shapes', () => {
        const result = execute(`
            CREATE TABLE temporal_values (
                id INTEGER PRIMARY KEY,
                created_date TEXT DEFAULT CURRENT_DATE,
                created_time TEXT DEFAULT CURRENT_TIME
            );
            INSERT INTO temporal_values (id) VALUES (1);
            INSERT INTO temporal_values (id, created_date, created_time)
            VALUES (2, CURRENT_DATE, CURRENT_TIME);
            INSERT INTO temporal_values (id, created_date, created_time)
            VALUES (3, 'outdated', 'outdated');
            UPDATE temporal_values
            SET created_date = CURRENT_DATE, created_time = CURRENT_TIME
            WHERE id = 3;
        `);

        expect(result.log.filter((entry) => entry.type === 'error')).toEqual([]);
        result.tables.get('temporal_values').rows.forEach((row) => {
            expect(row.created_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(row.created_time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
        });
    });

    it('rounds negative generated values halfway away from zero', () => {
        const result = execute(`
            CREATE TABLE measurements (
                id INTEGER PRIMARY KEY,
                raw_value REAL,
                rounded_value REAL GENERATED ALWAYS AS (ROUND(raw_value, 0)) STORED
            );
            INSERT INTO measurements (id, raw_value) VALUES (1, -1.5), (2, 1.5);
        `);

        expect(result.log.filter((entry) => entry.type === 'error')).toEqual([]);
        expect(result.tables.get('measurements').rows.map((row) => row.rounded_value)).toEqual([-2, 2]);
    });

    it('rounds generated decimal half-ties reliably and keeps a rejected update atomic', () => {
        const result = execute(`
            CREATE TABLE invoices (
                id INTEGER PRIMARY KEY,
                amount NUMERIC,
                rounded_amount NUMERIC GENERATED ALWAYS AS (ROUND(amount, 2)) STORED,
                CHECK (rounded_amount <= 10)
            );
            INSERT INTO invoices (id, amount) VALUES (1, 1.005), (2, -1.005);
            UPDATE invoices SET amount = 10.005;
        `, 'postgres');

        expect(result.log.filter((entry) => entry.type === 'error')).toHaveLength(1);
        expect(result.log.find((entry) => entry.type === 'error')?.message).toMatch(/check/i);
        expect(result.tables.get('invoices').rows).toEqual([
            { id: 1, amount: 1.005, rounded_amount: 1.01 },
            { id: 2, amount: -1.005, rounded_amount: -1.01 },
        ]);
    });

    it('uses lexical and case-sensitive PostgreSQL text comparisons during mutations', () => {
        const result = execute(`
            CREATE TABLE labels (
                value TEXT PRIMARY KEY,
                selected INTEGER DEFAULT 0,
                exact_case INTEGER DEFAULT 0
            );
            INSERT INTO labels (value) VALUES ('2'), ('10'), ('02'), ('Ada'), ('ada');
            UPDATE labels SET selected = 1 WHERE value > '10';
            UPDATE labels SET exact_case = 1 WHERE value = 'ada';
        `, 'postgres');

        expect(result.log.filter((entry) => entry.type === 'error')).toEqual([]);
        expect(result.tables.get('labels').rows).toEqual([
            { value: '2', selected: 1, exact_case: 0 },
            { value: '10', selected: 0, exact_case: 0 },
            { value: '02', selected: 0, exact_case: 0 },
            { value: 'Ada', selected: 1, exact_case: 0 },
            { value: 'ada', selected: 1, exact_case: 1 },
        ]);
    });

    it('rejects unknown UPDATE target and right-hand-side columns atomically with positioned errors', () => {
        const unknownTarget = execute(`
            CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT, visits INTEGER);
            INSERT INTO accounts VALUES (1, 'Ada', 2);
            UPDATE accounts SET missing = 10, visits = visits + 1 WHERE id = 1;
        `, 'postgres');
        const targetError = unknownTarget.log.find((entry) => entry.type === 'error' && /missing/.test(entry.message));

        expect(targetError?.position).toMatchObject({ line: 4 });
        expect(unknownTarget.tables.get('accounts').rows).toEqual([{ id: 1, name: 'Ada', visits: 2 }]);

        const unknownReference = execute(`
            CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT, visits INTEGER);
            INSERT INTO accounts VALUES (1, 'Ada', 2);
            UPDATE accounts SET name = 'changed', visits = missing + 1 WHERE id = 1;
        `, 'postgres');
        const referenceError = unknownReference.log.find((entry) => entry.type === 'error' && /column reference "missing"/.test(entry.message));

        expect(referenceError?.position).toMatchObject({ line: 4 });
        expect(unknownReference.tables.get('accounts').rows).toEqual([{ id: 1, name: 'Ada', visits: 2 }]);
    });

    it('rejects unknown WHERE columns instead of matching missing values as NULL', () => {
        const updateResult = execute(`
            CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT);
            INSERT INTO accounts VALUES (1, 'Ada'), (2, 'Lin');
            UPDATE accounts SET name = 'changed' WHERE ghost IS NULL;
        `, 'sqlite');
        const updateError = updateResult.log.find((entry) => entry.type === 'error' && /WHERE column "ghost"/.test(entry.message));

        expect(updateError?.position).toMatchObject({ line: 4 });
        expect(updateResult.tables.get('accounts').rows).toEqual([
            { id: 1, name: 'Ada' },
            { id: 2, name: 'Lin' },
        ]);

        const rightHandReference = execute(`
            CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT);
            INSERT INTO accounts VALUES (1, 'Ada'), (2, 'Lin');
            UPDATE accounts SET name = 'changed' WHERE id = ghost;
        `, 'sqlite');

        expect(rightHandReference.log.some((entry) => entry.type === 'error' && /WHERE column "ghost"/.test(entry.message))).toBe(true);
        expect(rightHandReference.tables.get('accounts').rows).toEqual([
            { id: 1, name: 'Ada' },
            { id: 2, name: 'Lin' },
        ]);

        const inListReference = execute(`
            CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT);
            INSERT INTO accounts VALUES (1, 'Ada'), (2, 'Lin');
            UPDATE accounts SET name = 'changed' WHERE id IN (ghost);
        `, 'sqlite');

        expect(inListReference.log.some((entry) => entry.type === 'error' && /WHERE column "ghost"/.test(entry.message))).toBe(true);
        expect(inListReference.tables.get('accounts').rows).toEqual([
            { id: 1, name: 'Ada' },
            { id: 2, name: 'Lin' },
        ]);

        const deleteResult = execute(`
            CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT);
            INSERT INTO accounts VALUES (1, 'Ada'), (2, 'Lin');
            DELETE FROM accounts WHERE ghost IS NULL;
        `, 'sqlite');

        expect(deleteResult.log.some((entry) => entry.type === 'error' && /WHERE column "ghost"/.test(entry.message))).toBe(true);
        expect(deleteResult.tables.get('accounts').rows).toEqual([
            { id: 1, name: 'Ada' },
            { id: 2, name: 'Lin' },
        ]);
    });

    it('preserves temporal default shapes through ALTER backfill and transaction rollback', () => {
        const result = execute(`
            CREATE TABLE audit_events (id INTEGER PRIMARY KEY);
            INSERT INTO audit_events (id) VALUES (1), (2);
            ALTER TABLE audit_events ADD COLUMN event_date TEXT DEFAULT CURRENT_DATE;
            ALTER TABLE audit_events ADD COLUMN event_time TEXT DEFAULT CURRENT_TIME;
            BEGIN;
            UPDATE audit_events SET event_date = 'invalid', event_time = 'invalid';
            ROLLBACK;
        `, 'postgres');

        expect(result.log.filter((entry) => entry.type === 'error')).toEqual([]);
        result.tables.get('audit_events').rows.forEach((row) => {
            expect(row.event_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(row.event_time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
        });
    });
});
