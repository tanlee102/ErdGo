import { describe, it, expect } from 'vitest';
import { createSqlExecutor } from '@/features/data-view/lib/sqlExecutor.js';

function exec(sql) {
    const executor = createSqlExecutor();
    const result = executor.execute(sql);
    return {
        tables: result.tables,
        executionLog: result.log,
        table: (name) => {
            for (const [, v] of result.tables) {
                if (v.name.toLowerCase() === name.toLowerCase()) return v;
            }
            return null;
        },
        rowsOf: (name) => {
            for (const [, v] of result.tables) {
                if (v.name.toLowerCase() === name.toLowerCase()) return v.rows;
            }
            return null;
        },
    };
}

// ═══════════════ GENERATED COLUMNS: MORE EDGE CASES ═══════════════
describe('GENERATED columns: extended', () => {
    it('division expression', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, total NUMERIC, qty INT,
                unit_price NUMERIC GENERATED ALWAYS AS (total / qty) STORED);
            INSERT INTO t (id, total, qty) VALUES (1, 300, 6);
        `);
        expect(r.rowsOf('t')[0].unit_price).toBe(50);
    });

    it('modulo expression', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, val INT,
                remainder INT GENERATED ALWAYS AS (val % 3) STORED);
            INSERT INTO t (id, val) VALUES (1, 10);
        `);
        expect(r.rowsOf('t')[0].remainder).toBe(1);
    });

    it('division by zero returns null', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, a INT, b INT,
                ratio NUMERIC GENERATED ALWAYS AS (a / b) STORED);
            INSERT INTO t (id, a, b) VALUES (1, 10, 0);
        `);
        expect(r.rowsOf('t')[0].ratio).toBe(null);
    });

    it('parenthesized sub-expression: (a + b) * c', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, a INT, b INT, c INT,
                result INT GENERATED ALWAYS AS ((a + b) * c) STORED);
            INSERT INTO t (id, a, b, c) VALUES (1, 3, 4, 5);
        `);
        expect(r.rowsOf('t')[0].result).toBe(35);
    });

    it('unary negation: -a * b', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, a INT, b INT,
                neg NUMERIC GENERATED ALWAYS AS (-a * b) STORED);
            INSERT INTO t (id, a, b) VALUES (1, 5, 3);
        `);
        expect(r.rowsOf('t')[0].neg).toBe(-15);
    });

    it('multiple generated columns in same table', () => {
        const r = exec(`
            CREATE TABLE invoice (id INT PRIMARY KEY, subtotal NUMERIC, tax_rate NUMERIC,
                tax NUMERIC GENERATED ALWAYS AS (subtotal * tax_rate) STORED,
                total NUMERIC GENERATED ALWAYS AS (subtotal + subtotal * tax_rate) STORED);
            INSERT INTO invoice (id, subtotal, tax_rate) VALUES (1, 1000, 0.08);
        `);
        const row = r.rowsOf('invoice')[0];
        expect(row.tax).toBe(80);
        expect(row.total).toBe(1080);
    });

    it('UPDATE recalculates generated column', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, price NUMERIC, qty INT,
                total NUMERIC GENERATED ALWAYS AS (price * qty) STORED);
            INSERT INTO t (id, price, qty) VALUES (1, 10, 5);
            UPDATE t SET qty = 20 WHERE id = 1;
        `);
        expect(r.rowsOf('t')[0].total).toBe(200);
    });

    it('GENERATED with COALESCE function', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, a INT, b INT,
                val INT GENERATED ALWAYS AS (COALESCE(a, b, 0)) STORED);
            INSERT INTO t (id, a, b) VALUES (1, NULL, 42);
            INSERT INTO t (id, a, b) VALUES (2, 10, 20);
            INSERT INTO t (id, a, b) VALUES (3, NULL, NULL);
        `);
        const rows = r.rowsOf('t');
        expect(rows[0].val).toBe(42);
        expect(rows[1].val).toBe(10);
        expect(rows[2].val).toBe(0);
    });

    it('GENERATED with ABS function', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, v INT,
                abs_v INT GENERATED ALWAYS AS (ABS(v)) STORED);
            INSERT INTO t (id, v) VALUES (1, -42);
        `);
        expect(r.rowsOf('t')[0].abs_v).toBe(42);
    });

    it('GENERATED with ROUND function', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, v NUMERIC,
                rounded NUMERIC GENERATED ALWAYS AS (ROUND(v, 2)) STORED);
            INSERT INTO t (id, v) VALUES (1, 3.14159);
        `);
        expect(r.rowsOf('t')[0].rounded).toBe(3.14);
    });

    it('GENERATED with PostgreSQL :: casts', () => {
        const r = exec(`
            CREATE TABLE events (
                id INT PRIMARY KEY,
                occurred_at TIMESTAMP,
                raw_score TEXT,
                day_bucket DATE GENERATED ALWAYS AS (occurred_at::date) STORED,
                score_int INT GENERATED ALWAYS AS (raw_score::int) STORED
            );
            INSERT INTO events (id, occurred_at, raw_score) VALUES (1, '2026-05-17T10:15:30Z', '42.9');
        `);
        const row = r.rowsOf('events')[0];
        expect(row.day_bucket).toBe('2026-05-17');
        expect(row.score_int).toBe(42);
    });
});

// ═══════════════ END-TO-END: GOVERNMENT SCENARIO ═══════════════
describe('End-to-end: government tax scenario', () => {
    function govExec() {
        return exec(`
            CREATE TABLE Citizens (
                CitizenID INT PRIMARY KEY,
                NationalID VARCHAR(20) UNIQUE NOT NULL,
                FullName VARCHAR(150) NOT NULL,
                DateOfBirth DATE,
                Status VARCHAR(20) DEFAULT 'Active'
            );
            INSERT INTO Citizens VALUES (1, 'SG123456A', 'John Tan', '1985-03-12', 'Active');
            INSERT INTO Citizens VALUES (2, 'SG654321B', 'Alice Lim', '1990-07-25', 'Active');
            INSERT INTO Citizens VALUES (3, 'SG888999C', 'Michael Lee', '1975-11-02', 'Inactive');

            CREATE TABLE TaxRecords (
                TaxID INT PRIMARY KEY,
                CitizenID INT REFERENCES Citizens(CitizenID),
                Income NUMERIC,
                TaxRate NUMERIC CHECK (TaxRate >= 0),
                TaxAmount NUMERIC GENERATED ALWAYS AS (Income * TaxRate) STORED,
                TaxYear INT NOT NULL
            );
            INSERT INTO TaxRecords (TaxID, CitizenID, Income, TaxRate, TaxYear) VALUES (1, 1, 120000, 0.15, 2024);
            INSERT INTO TaxRecords (TaxID, CitizenID, Income, TaxRate, TaxYear) VALUES (2, 1, 135000, 0.18, 2025);
            INSERT INTO TaxRecords (TaxID, CitizenID, Income, TaxRate, TaxYear) VALUES (3, 2, 90000, 0.12, 2024);
            INSERT INTO TaxRecords (TaxID, CitizenID, Income, TaxRate, TaxYear) VALUES (4, 3, 70000, 0.10, 2025);

            CREATE TABLE Services (
                ServiceID INT PRIMARY KEY,
                Name VARCHAR(150),
                Fee NUMERIC
            );
            INSERT INTO Services VALUES (1, 'Passport Renewal', 120);
            INSERT INTO Services VALUES (2, 'Business License', 450);
            INSERT INTO Services VALUES (3, 'Property Registration', 300);

            CREATE TABLE Applications (
                ApplicationID INT PRIMARY KEY,
                CitizenID INT REFERENCES Citizens(CitizenID),
                ServiceID INT REFERENCES Services(ServiceID),
                Status VARCHAR(20) DEFAULT 'Pending'
            );
            INSERT INTO Applications VALUES (1, 1, 1, 'Approved');
            INSERT INTO Applications VALUES (2, 1, 2, 'Pending');
            INSERT INTO Applications VALUES (3, 2, 3, 'Rejected');

            CREATE TABLE Payments (
                PaymentID INT PRIMARY KEY,
                ApplicationID INT REFERENCES Applications(ApplicationID),
                Amount NUMERIC
            );
            INSERT INTO Payments VALUES (1, 1, 120);
            INSERT INTO Payments VALUES (2, 2, 450);

            UPDATE Citizens SET Status = 'Active' WHERE NationalID = 'SG888999C';
            UPDATE Applications SET Status = 'Approved' WHERE Status = 'Pending';
        `);
    }

    it('TaxAmount is correctly computed for all records', () => {
        const r = govExec();
        const rows = r.rowsOf('TaxRecords');
        expect(rows[0].TaxAmount).toBe(18000);
        expect(rows[1].TaxAmount).toBe(24300);
        expect(rows[2].TaxAmount).toBe(10800);
        expect(rows[3].TaxAmount).toBe(7000);
    });

    it('Citizens are correct after UPDATE', () => {
        const r = govExec();
        const michael = r.rowsOf('Citizens').find(c => c.FullName === 'Michael Lee');
        expect(michael.Status).toBe('Active');
    });

    it('Applications updated correctly', () => {
        const r = govExec();
        const apps = r.rowsOf('Applications');
        expect(apps.filter(a => a.Status === 'Approved').length).toBe(2);
        expect(apps.filter(a => a.Status === 'Rejected').length).toBe(1);
    });

    it('no errors in execution log', () => {
        const r = govExec();
        const errors = r.executionLog.filter(e => e.type === 'error');
        expect(errors).toHaveLength(0);
    });

    it('all tables have correct row counts', () => {
        const r = govExec();
        expect(r.rowsOf('Citizens')).toHaveLength(3);
        expect(r.rowsOf('TaxRecords')).toHaveLength(4);
        expect(r.rowsOf('Services')).toHaveLength(3);
        expect(r.rowsOf('Applications')).toHaveLength(3);
        expect(r.rowsOf('Payments')).toHaveLength(2);
    });
});

// ═══════════════ INSERT WITH SUBQUERIES ═══════════════
describe('INSERT with subquery VALUES', () => {
    it('scalar subquery resolves FK', () => {
        const r = exec(`
            CREATE TABLE categories (id INT PRIMARY KEY, name TEXT);
            INSERT INTO categories VALUES (1, 'Electronics');
            INSERT INTO categories VALUES (2, 'Books');
            CREATE TABLE products (id INT PRIMARY KEY, cat_id INT REFERENCES categories(id), name TEXT);
            INSERT INTO products (id, cat_id, name) VALUES (1, (SELECT id FROM categories WHERE name = 'Books'), 'SQL Guide');
        `);
        expect(r.rowsOf('products')[0].cat_id).toBe(2);
    });

    it('multiple subquery values in single INSERT', () => {
        const r = exec(`
            CREATE TABLE a (id INT PRIMARY KEY, name TEXT);
            CREATE TABLE b (id INT PRIMARY KEY, name TEXT);
            INSERT INTO a VALUES (10, 'alpha');
            INSERT INTO b VALUES (20, 'beta');
            CREATE TABLE c (id INT PRIMARY KEY, a_id INT, b_id INT);
            INSERT INTO c VALUES (1, (SELECT id FROM a WHERE name = 'alpha'), (SELECT id FROM b WHERE name = 'beta'));
        `);
        const row = r.rowsOf('c')[0];
        expect(row.a_id).toBe(10);
        expect(row.b_id).toBe(20);
    });
});

// ═══════════════ COMPLEX DDL + DML SCENARIOS ═══════════════
describe('Complex DDL+DML scenarios', () => {
    it('ALTER TABLE + INSERT + UPDATE + DELETE pipeline', () => {
        const r = exec(`
            CREATE TABLE staff (id INT PRIMARY KEY, name TEXT, role TEXT);
            INSERT INTO staff VALUES (1, 'Alice', 'dev');
            INSERT INTO staff VALUES (2, 'Bob', 'dev');
            INSERT INTO staff VALUES (3, 'Carol', 'mgr');
            ALTER TABLE staff ADD COLUMN salary NUMERIC;
            UPDATE staff SET salary = 100000 WHERE role = 'dev';
            UPDATE staff SET salary = 120000 WHERE role = 'mgr';
            DELETE FROM staff WHERE name = 'Bob';
        `);
        const rows = r.rowsOf('staff');
        expect(rows).toHaveLength(2);
        expect(rows.find(r => r.name === 'Alice').salary).toBe(100000);
        expect(rows.find(r => r.name === 'Carol').salary).toBe(120000);
    });

    it('TRUNCATE resets rows but keeps structure', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, v TEXT);
            INSERT INTO t VALUES (1, 'a');
            INSERT INTO t VALUES (2, 'b');
            TRUNCATE TABLE t;
            INSERT INTO t VALUES (3, 'c');
        `);
        const rows = r.rowsOf('t');
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(3);
    });

    it('multi-row INSERT', () => {
        const r = exec(`
            CREATE TABLE colors (id INT PRIMARY KEY, name TEXT);
            INSERT INTO colors VALUES (1, 'red'), (2, 'green'), (3, 'blue');
        `);
        expect(r.rowsOf('colors')).toHaveLength(3);
    });

    it('SERIAL auto-increment', () => {
        const r = exec(`
            CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT);
            INSERT INTO items (name) VALUES ('first');
            INSERT INTO items (name) VALUES ('second');
            INSERT INTO items (name) VALUES ('third');
        `);
        const rows = r.rowsOf('items');
        expect(rows[0].id).toBe(1);
        expect(rows[1].id).toBe(2);
        expect(rows[2].id).toBe(3);
    });

    it('composite PRIMARY KEY enforces tuple uniqueness', () => {
        const r = exec(`
            CREATE TABLE t (a INT, b INT, v TEXT, PRIMARY KEY (a, b));
            INSERT INTO t VALUES (1, 1, 'x');
            INSERT INTO t VALUES (1, 2, 'y');
            INSERT INTO t VALUES (1, 1, 'duplicate');
        `);
        const errors = r.executionLog.filter(e => e.type === 'error');
        expect(errors.length).toBeGreaterThan(0);
        expect(r.rowsOf('t')).toHaveLength(2);
    });

    it('UNIQUE constraint prevents duplicates', () => {
        const r = exec(`
            CREATE TABLE users (id INT PRIMARY KEY, email TEXT UNIQUE);
            INSERT INTO users VALUES (1, 'a@b.com');
            INSERT INTO users VALUES (2, 'a@b.com');
        `);
        const errors = r.executionLog.filter(e => e.type === 'error');
        expect(errors.length).toBeGreaterThan(0);
        expect(r.rowsOf('users')).toHaveLength(1);
    });

    it('NOT NULL constraint logged on INSERT', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, name TEXT NOT NULL);
            INSERT INTO t VALUES (1, NULL);
        `);
        const errors = r.executionLog.filter(e => e.type === 'error');
        expect(errors.length).toBeGreaterThan(0);
        expect(r.rowsOf('t')).toHaveLength(0);
    });
});
