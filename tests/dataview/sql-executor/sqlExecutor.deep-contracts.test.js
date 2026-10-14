/** Protects deep Data View state, constraint, and transaction contracts. */
import { describe, expect, it } from 'vitest';
import { createSqlExecutor } from '@/features/data-view/lib/sqlExecutor.js';

function exec(sql) {
    const result = createSqlExecutor().execute(sql);
    const table = (name) => {
        for (const [, value] of result.tables) {
            if (value.name.toLowerCase() === name.toLowerCase()) return value;
        }
        return null;
    };
    return { ...result, table, errors: result.log.filter((entry) => entry.type === 'error'), warnings: result.log.filter((entry) => entry.type === 'warning') };
}

describe('Data View SQL executor deep contracts', () => {
    it('defers inserts until their table exists and applies defaults', () => {
        const result = exec(`
            INSERT INTO users (id, name, active) VALUES (1, 'Ada', DEFAULT);
            CREATE TABLE users (
                id INT PRIMARY KEY,
                name TEXT NOT NULL,
                active BOOLEAN NOT NULL DEFAULT TRUE
            );
        `);

        expect(result.errors).toEqual([]);
        expect(result.table('users').rows).toEqual([{ id: 1, name: 'Ada', active: true }]);
    });

    it('bumps auto-increment counters after explicit ids', () => {
        const result = exec(`
            CREATE TABLE items (id INT AUTO_INCREMENT PRIMARY KEY, name TEXT);
            INSERT INTO items (id, name) VALUES (10, 'manual');
            INSERT INTO items (name) VALUES ('auto');
        `);

        expect(result.table('items').rows.map((row) => row.id)).toEqual([10, 11]);
    });

    it('evaluates generated columns after update statements', () => {
        const result = exec(`
            CREATE TABLE lines (
                id INT PRIMARY KEY,
                qty INT NOT NULL,
                unit_price INT NOT NULL,
                total INT GENERATED ALWAYS AS (qty * unit_price) STORED
            );
            INSERT INTO lines (id, qty, unit_price) VALUES (1, 2, 50);
            UPDATE lines SET qty = 3 WHERE id = 1;
        `);

        expect(result.table('lines').rows[0].total).toBe(150);
    });

    it('preserves existing rows when create table is rerun for same name', () => {
        const result = exec(`
            CREATE TABLE cache (id INT PRIMARY KEY, name TEXT);
            INSERT INTO cache (id, name) VALUES (1, 'kept');
            CREATE TABLE cache (id INT PRIMARY KEY, name TEXT, extra TEXT);
        `);

        expect(result.table('cache').rows).toEqual([{ id: 1, name: 'kept' }]);
        expect(result.warnings.some((entry) => entry.message.includes('already exists'))).toBe(true);
    });

    it('supports CREATE OR REPLACE TABLE and refreshes CREATE OR REPLACE VIEW rows', () => {
        const result = exec(`
            CREATE TABLE users (id INT PRIMARY KEY, name TEXT, active BOOLEAN);
            INSERT INTO users (id, name, active) VALUES (1, 'old row', TRUE);

            CREATE OR REPLACE TABLE users (id INT PRIMARY KEY, name TEXT, active BOOLEAN);
            INSERT INTO users (id, name, active) VALUES (2, 'Ada', TRUE), (3, 'Linus', FALSE);

            CREATE OR REPLACE VIEW active_users AS
                SELECT id, name FROM users WHERE active = TRUE ORDER BY id;

            INSERT INTO users (id, name, active) VALUES (4, 'Grace', TRUE);
        `);

        expect(result.errors).toEqual([]);
        expect(result.table('users').rows.map((row) => row.id)).toEqual([2, 3, 4]);
        expect(result.table('active_users')).toMatchObject({ isView: true });
        expect(result.table('active_users').rows).toEqual([
            { id: 2, name: 'Ada' },
            { id: 4, name: 'Grace' },
        ]);
    });

    it('supports INSERT INTO target SELECT query results', () => {
        const result = exec(`
            CREATE TABLE source (id INT, name TEXT);
            CREATE TABLE target (id INT, name TEXT);
            INSERT INTO source (id, name) VALUES (1, 'one'), (2, 'two');
            INSERT INTO target (id, name) SELECT id, name FROM source WHERE id > 1;
        `);

        expect(result.table('target').rows).toEqual([{ id: 2, name: 'two' }]);
    });

    it('rejects invalid constrained rows without mutating the table', () => {
        const result = exec(`
            CREATE TABLE users (id INT PRIMARY KEY, email TEXT UNIQUE NOT NULL);
            INSERT INTO users (id, email) VALUES (1, 'a@example.test');
            INSERT INTO users (id, email) VALUES (1, 'a@example.test');
        `);

        expect(result.errors.map((entry) => entry.message).join('\n')).toContain('duplicate');
        expect(result.table('users').rows).toHaveLength(1);
    });
});
