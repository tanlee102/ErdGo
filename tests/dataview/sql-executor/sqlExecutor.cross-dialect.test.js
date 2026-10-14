import { describe, it, expect } from 'vitest';
import { createSqlExecutor } from '@/features/data-view/lib/sqlExecutor.js';

// ════════════════════════════════════════════════════════════════════
// Cross-dialect parity — sqlExecutor (Data View runtime)
// ════════════════════════════════════════════════════════════════════
// Where parseAst.cross-dialect.test.js verifies the *AST* shape, this
// suite verifies that DDL+DML actually executes consistently in the
// in-memory engine across SQLite, PostgreSQL, MySQL, and MSSQL syntax.
// We:
//   • Run the same logical script in 4 dialect skins and verify rows.
//   • Pin down auto-increment behaviour for every flavor.
//   • Verify the new MSSQL bare-AS computed column slot does not
//     misalign positional INSERTs (regression for issue found in
//     2026-Q2 audit).
//   • Verify MySQL inline SET registers like ENUM does.
//   • Verify the new tokenizer features (`#` comments, `N'…'`, `\\'`)
//     flow through the full pipeline.
// ════════════════════════════════════════════════════════════════════

function exec(sql) {
    const e = createSqlExecutor();
    const r = e.execute(sql);
    return {
        ...r,
        table: (name) => {
            for (const [, v] of r.tables) if (v.name.toLowerCase() === name.toLowerCase()) return v;
            return null;
        },
        type: (name) => {
            for (const [, v] of r.types) if (v.name.toLowerCase() === name.toLowerCase()) return v;
            return null;
        },
        errors: () => r.log.filter((l) => l.type === 'error'),
        warnings: () => r.log.filter((l) => l.type === 'warning'),
    };
}

describe('Executor cross-dialect — pattern matching semantics', () => {
    it('distinguishes PostgreSQL LIKE from ILIKE', () => {
        const executor = createSqlExecutor({ dialect: 'postgres' });
        const result = executor.execute(`
            CREATE TABLE names (id INT PRIMARY KEY, value TEXT, matched TEXT);
            INSERT INTO names VALUES (1, 'Ada', 'none'), (2, 'ada', 'none');
            UPDATE names SET matched = 'like' WHERE value LIKE 'a%';
            UPDATE names SET matched = 'ilike' WHERE value ILIKE 'A%';
        `);
        const rows = result.tables.get('names').rows.sort((left, right) => left.id - right.id);
        expect(result.log.filter((entry) => entry.type === 'error')).toEqual([]);
        expect(rows.map((row) => row.matched)).toEqual(['ilike', 'ilike']);

        const likeOnly = createSqlExecutor({ dialect: 'postgres' }).execute(`
            CREATE TABLE names (id INT PRIMARY KEY, value TEXT);
            INSERT INTO names VALUES (1, 'Ada'), (2, 'ada');
            DELETE FROM names WHERE value LIKE 'a%';
        `);
        expect(likeOnly.tables.get('names').rows.map((row) => row.value)).toEqual(['Ada']);
    });
});

// ════════════════════════════════════════════════════════════════════
// Equivalent users+posts schema in 4 dialects → same row shape
// ════════════════════════════════════════════════════════════════════
describe('Executor cross-dialect — equivalent schema produces equivalent rows', () => {
    const DDL = {
        SQLite: `
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE
            );
            CREATE TABLE posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
        `,
        PostgreSQL: `
            CREATE TABLE users (
                id BIGSERIAL PRIMARY KEY,
                email TEXT NOT NULL UNIQUE
            );
            CREATE TABLE posts (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id),
                title TEXT NOT NULL
            );
        `,
        MySQL: `
            CREATE TABLE \`users\` (
                \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
                \`email\` VARCHAR(255) NOT NULL UNIQUE
            ) ENGINE=InnoDB;
            CREATE TABLE \`posts\` (
                \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
                \`user_id\` BIGINT NOT NULL,
                \`title\` VARCHAR(255) NOT NULL,
                FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`)
            ) ENGINE=InnoDB;
        `,
        MSSQL: `
            CREATE TABLE [users] (
                [id] BIGINT IDENTITY(1,1) PRIMARY KEY,
                [email] NVARCHAR(255) NOT NULL UNIQUE
            );
            CREATE TABLE [posts] (
                [id] BIGINT IDENTITY(1,1) PRIMARY KEY,
                [user_id] BIGINT NOT NULL,
                [title] NVARCHAR(255) NOT NULL,
                CONSTRAINT FK_posts_users FOREIGN KEY ([user_id]) REFERENCES [users]([id])
            );
        `,
    };

    // The same DML is fed into every dialect — auto-increment should fill
    // the missing PK slot identically across all four.
    const DML = `
        INSERT INTO users (email) VALUES ('alice@example.com'), ('bob@example.com');
        INSERT INTO posts (user_id, title) VALUES (1, 'first post'), (2, 'second post');
    `;

    for (const [dialect, ddl] of Object.entries(DDL)) {
        it(`${dialect}: 2 users + 2 posts after autoinc INSERT`, () => {
            const r = exec(ddl + DML);
            expect(r.errors()).toEqual([]);
            expect(r.table('users').rows).toHaveLength(2);
            expect(r.table('posts').rows).toHaveLength(2);
        });

        it(`${dialect}: auto-increment generates 1, 2 in order`, () => {
            const r = exec(ddl + DML);
            const ids = r.table('users').rows.map((row) => row.id);
            expect(ids).toEqual([1, 2]);
        });

        it(`${dialect}: PK and UNIQUE constraints prevent duplicates`, () => {
            const r = exec(`${ddl}
                INSERT INTO users (email) VALUES ('alice@example.com');
                INSERT INTO users (email) VALUES ('alice@example.com');
            `);
            // The duplicate statement is rejected atomically in every profile.
            expect(r.errors().some((entry) => /unique|duplicate/i.test(entry.message))).toBe(true);
            expect(r.table('users').rows).toHaveLength(1);
        });
    }
});

describe('Executor cross-dialect — CREATE VIEW production variants', () => {
    it('PostgreSQL: CREATE OR REPLACE VIEW with aliases and CHECK OPTION is queryable', () => {
        const r = exec(`
            CREATE TABLE accounts (id INT PRIMARY KEY, email TEXT, active BOOLEAN);
            INSERT INTO accounts (id, email, active) VALUES
                (1, 'ada@example.test', TRUE),
                (2, 'linus@example.test', FALSE),
                (3, 'grace@example.test', TRUE);

            CREATE OR REPLACE VIEW active_accounts (account_id, email_address) AS
                SELECT id, email FROM accounts WHERE active = TRUE
                WITH LOCAL CHECK OPTION;
        `);

        expect(r.errors()).toEqual([]);
        expect(r.table('active_accounts')).toMatchObject({ isView: true });
        expect(r.table('active_accounts').columns.map((column) => column.name)).toEqual(['account_id', 'email_address']);
        expect(r.table('active_accounts').rows).toEqual([
            { account_id: 1, email_address: 'ada@example.test' },
            { account_id: 3, email_address: 'grace@example.test' },
        ]);
    });

    it('PostgreSQL: CREATE MATERIALIZED VIEW WITH NO DATA preserves columns and empty rows', () => {
        const r = exec(`
            CREATE TABLE events (id INT PRIMARY KEY, kind TEXT);
            INSERT INTO events (id, kind) VALUES (1, 'login'), (2, 'logout');

            CREATE MATERIALIZED VIEW event_summary AS
                SELECT kind, COUNT(*) AS total
                FROM events
                GROUP BY kind
                WITH NO DATA;
        `);

        expect(r.errors()).toEqual([]);
        expect(r.table('event_summary')).toMatchObject({ isView: true, viewNoData: true });
        expect(r.table('event_summary').columns.map((column) => column.name)).toEqual(['kind', 'total']);
        expect(r.table('event_summary').rows).toEqual([]);
    });

    it('MySQL: CREATE OR REPLACE with ALGORITHM, DEFINER, SQL SECURITY, and CHECK OPTION is materialized', () => {
        const r = exec(`
            CREATE TABLE orders (id INT PRIMARY KEY, total NUMERIC, status TEXT);
            INSERT INTO orders (id, total, status) VALUES
                (1, 120, 'paid'),
                (2, 40, 'draft'),
                (3, 250, 'paid');

            CREATE OR REPLACE ALGORITHM = MERGE
                DEFINER = CURRENT_USER
                SQL SECURITY INVOKER
                VIEW paid_orders AS
                SELECT id, total FROM orders WHERE status = 'paid'
                WITH CASCADED CHECK OPTION;
        `);

        expect(r.errors()).toEqual([]);
        expect(r.table('paid_orders').rows).toEqual([
            { id: 1, total: 120 },
            { id: 3, total: 250 },
        ]);
    });

    it('MySQL: backticked DEFINER user@host and SQL SECURITY DEFINER are tolerated', () => {
        const r = exec(`
            CREATE TABLE audit_log (id INT PRIMARY KEY, actor TEXT, visible BOOLEAN);
            INSERT INTO audit_log (id, actor, visible) VALUES
                (1, 'app', TRUE),
                (2, 'internal', FALSE);

            CREATE OR REPLACE
                DEFINER = \`reporting_user\`@\`%\`
                SQL SECURITY DEFINER
                VIEW visible_audit_log AS
                SELECT id, actor FROM audit_log WHERE visible = TRUE;
        `);

        expect(r.errors()).toEqual([]);
        expect(r.table('visible_audit_log').rows).toEqual([{ id: 1, actor: 'app' }]);
    });

    it('SQLite: CREATE TEMP VIEW IF NOT EXISTS refreshes after later inserts', () => {
        const r = exec(`
            CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT, archived BOOLEAN);
            INSERT INTO notes (id, title, archived) VALUES (1, 'draft', FALSE);

            CREATE TEMP VIEW IF NOT EXISTS live_notes AS
                SELECT id, title FROM notes WHERE archived = FALSE;

            INSERT INTO notes (id, title, archived) VALUES (2, 'published', FALSE), (3, 'old', TRUE);
        `);

        expect(r.errors()).toEqual([]);
        expect(r.table('live_notes').rows).toEqual([
            { id: 1, title: 'draft' },
            { id: 2, title: 'published' },
        ]);
    });

    it('SQLite: CREATE VIEW IF NOT EXISTS keeps the original view definition', () => {
        const r = exec(`
            CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT, archived BOOLEAN);
            INSERT INTO notes (id, title, archived) VALUES (1, 'draft', FALSE), (2, 'old', TRUE);

            CREATE VIEW live_notes AS
                SELECT id FROM notes WHERE archived = FALSE;

            CREATE VIEW IF NOT EXISTS live_notes AS
                SELECT title FROM notes;

            INSERT INTO notes (id, title, archived) VALUES (3, 'published', FALSE);
        `);

        expect(r.errors()).toEqual([]);
        expect(r.warnings().some((entry) => entry.message.includes('IF NOT EXISTS skipped'))).toBe(true);
        expect(r.table('live_notes').columns.map((column) => column.name)).toEqual(['id']);
        expect(r.table('live_notes').rows).toEqual([{ id: 1 }, { id: 3 }]);
    });

    it('MSSQL: CREATE OR ALTER VIEW WITH SCHEMABINDING replaces existing view definition', () => {
        const r = exec(`
            CREATE TABLE dbo.Customers (CustomerID INT PRIMARY KEY, Email NVARCHAR(320), Active BIT);
            INSERT INTO dbo.Customers (CustomerID, Email, Active) VALUES
                (1, 'ada@example.test', 1),
                (2, 'linus@example.test', 0);

            CREATE VIEW dbo.ActiveCustomers AS
                SELECT CustomerID FROM dbo.Customers WHERE Active = 1;

            CREATE OR ALTER VIEW dbo.ActiveCustomers
                WITH SCHEMABINDING
            AS
                SELECT CustomerID, Email FROM dbo.Customers WHERE Active = 1;
        `);

        expect(r.errors()).toEqual([]);
        expect(r.table('ActiveCustomers').columns.map((column) => column.name)).toEqual(['CustomerID', 'Email']);
        expect(r.table('ActiveCustomers').rows).toEqual([{ CustomerID: 1, Email: 'ada@example.test' }]);
    });

    it('MSSQL: CREATE OR ALTER VIEW creates the view when it does not exist', () => {
        const r = exec(`
            CREATE TABLE dbo.Orders (OrderID INT PRIMARY KEY, Total NUMERIC, Status NVARCHAR(20));
            INSERT INTO dbo.Orders (OrderID, Total, Status) VALUES
                (1, 120, 'paid'),
                (2, 25, 'draft');

            CREATE OR ALTER VIEW dbo.PaidOrders AS
                SELECT OrderID, Total FROM dbo.Orders WHERE Status = 'paid';
        `);

        expect(r.errors()).toEqual([]);
        expect(r.table('PaidOrders')).toMatchObject({ isView: true });
        expect(r.table('PaidOrders').rows).toEqual([{ OrderID: 1, Total: 120 }]);
    });

    it('refreshes chained views in declaration order after later DML', () => {
        const r = exec(`
            CREATE TABLE payments (id INT PRIMARY KEY, user_id INT, amount NUMERIC, status TEXT);
            INSERT INTO payments (id, user_id, amount, status) VALUES
                (1, 10, 100, 'paid'),
                (2, 10, 40, 'draft'),
                (3, 20, 75, 'paid');

            CREATE VIEW paid_payments AS
                SELECT user_id, amount FROM payments WHERE status = 'paid';

            CREATE VIEW paid_totals AS
                SELECT user_id, SUM(amount) AS total
                FROM paid_payments
                GROUP BY user_id;

            INSERT INTO payments (id, user_id, amount, status) VALUES
                (4, 10, 30, 'paid'),
                (5, 20, 25, 'paid'),
                (6, 30, 999, 'draft');
        `);

        expect(r.errors()).toEqual([]);
        expect(r.table('paid_payments').rows).toEqual([
            { user_id: 10, amount: 100 },
            { user_id: 20, amount: 75 },
            { user_id: 10, amount: 30 },
            { user_id: 20, amount: 25 },
        ]);
        expect(r.table('paid_totals').rows.sort((a, b) => a.user_id - b.user_id)).toEqual([
            { user_id: 10, total: 130 },
            { user_id: 20, total: 100 },
        ]);
    });

    it('logs a clear error when CREATE VIEW column aliases do not match SELECT output', () => {
        const r = exec(`
            CREATE TABLE users (id INT PRIMARY KEY, name TEXT);
            INSERT INTO users (id, name) VALUES (1, 'Ada');

            CREATE VIEW broken_user_view (only_id) AS
                SELECT id, name FROM users;
        `);

        expect(r.errors().map((entry) => entry.message).join('\n')).toContain('declared 1 column alias(es) but SELECT returns 2 column(s)');
        expect(r.table('broken_user_view')).toBeNull();
    });

    it('DROP VIEW and DROP MATERIALIZED VIEW remove materialized view objects without touching tables', () => {
        const r = exec(`
            CREATE TABLE source_rows (id INT PRIMARY KEY);
            INSERT INTO source_rows (id) VALUES (1);
            CREATE VIEW source_view AS SELECT id FROM source_rows;
            CREATE MATERIALIZED VIEW source_mv AS SELECT id FROM source_rows;
            DROP VIEW source_view;
            DROP MATERIALIZED VIEW source_mv;
        `);

        expect(r.errors()).toEqual([]);
        expect(r.table('source_rows')).not.toBeNull();
        expect(r.table('source_view')).toBeNull();
        expect(r.table('source_mv')).toBeNull();
    });
});

// ════════════════════════════════════════════════════════════════════
// Auto-increment lifecycle parity — same counter behavior everywhere
// ════════════════════════════════════════════════════════════════════
describe('Executor cross-dialect — auto-increment lifecycle parity', () => {
    const CASES = [
        ['SQLite AUTOINCREMENT', `CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);`],
        ['PostgreSQL SERIAL', `CREATE TABLE t (id SERIAL PRIMARY KEY, name TEXT);`],
        ['PostgreSQL BIGSERIAL', `CREATE TABLE t (id BIGSERIAL PRIMARY KEY, name TEXT);`],
        ['PostgreSQL GENERATED AS IDENTITY', `CREATE TABLE t (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TEXT);`],
        ['MySQL AUTO_INCREMENT', `CREATE TABLE t (id BIGINT AUTO_INCREMENT PRIMARY KEY, name TEXT);`],
        ['MSSQL IDENTITY(1,1)', `CREATE TABLE t (id BIGINT IDENTITY(1,1) PRIMARY KEY, name TEXT);`],
        ['MSSQL IDENTITY(100, 5)', `CREATE TABLE t (id BIGINT IDENTITY(100, 5) PRIMARY KEY, name TEXT);`],
    ];

    for (const [name, ddl] of CASES) {
        it(`${name}: assigns sequential IDs on INSERT without explicit values`, () => {
            const r = exec(`${ddl}
                INSERT INTO t (name) VALUES ('a'), ('b'), ('c');
            `);
            expect(r.errors()).toEqual([]);
            const ids = r.table('t').rows.map((row) => row.id);
            // Either 1,2,3 (default seed/step 1) OR a sequence honouring
            // the configured seed/step — verify monotonicity and
            // 3-element sequence in either case.
            expect(ids).toHaveLength(3);
            expect(ids[1] - ids[0]).toBeGreaterThan(0);
            expect(ids[2] - ids[1]).toBe(ids[1] - ids[0]);
        });
    }

    it('MSSQL IDENTITY(100, 5) starts at 100, increments by 5', () => {
        const r = exec(`
            CREATE TABLE t (id BIGINT IDENTITY(100, 5) PRIMARY KEY, name TEXT);
            INSERT INTO t (name) VALUES ('a'), ('b'), ('c');
        `);
        expect(r.errors()).toEqual([]);
        const ids = r.table('t').rows.map((row) => row.id);
        expect(ids).toEqual([100, 105, 110]);
    });
});

// ════════════════════════════════════════════════════════════════════
// MSSQL bare-AS computed columns — regression test for the new fix
// ════════════════════════════════════════════════════════════════════
describe('Executor — MSSQL bare-AS computed columns', () => {
    it('preserves the column slot so positional INSERT lines up', () => {
        // BEFORE the fix the COMPUTED column was absorbed into the
        // previous column's type string and the following column became
        // unreachable, causing positional INSERTs to silently mis-align.
        const r = exec(`
            CREATE TABLE t (
                a INT,
                full_name AS (a + 1) PERSISTED,
                b INT
            );
            INSERT INTO t (a, b) VALUES (10, 20);
        `);
        expect(r.errors()).toEqual([]);
        const row = r.table('t').rows[0];
        expect(row.a).toBe(10);
        expect(row.b).toBe(20);
        // Computed column is registered (slot exists) but not evaluated —
        // it's NULL, which is the documented Data View behaviour.
        expect('full_name' in row).toBe(true);
    });

    it('handles parenthesized form `<col> AS (<expr>) PERSISTED`', () => {
        const r = exec(`
            CREATE TABLE t (
                first_name NVARCHAR(50),
                last_name NVARCHAR(50),
                full_name AS (first_name + ' ' + last_name) PERSISTED,
                email NVARCHAR(100)
            );
            INSERT INTO t (first_name, last_name, email) VALUES ('Ada', 'Lovelace', 'ada@example.com');
        `);
        expect(r.errors()).toEqual([]);
        const row = r.table('t').rows[0];
        expect(row.first_name).toBe('Ada');
        expect(row.last_name).toBe('Lovelace');
        expect(row.email).toBe('ada@example.com');
        expect('full_name' in row).toBe(true);
    });

    it('handles bare expression form `<col> AS <expr>` without parens', () => {
        const r = exec(`
            CREATE TABLE t (
                qty_ordered INT,
                qty_shipped INT,
                qty_remaining AS qty_ordered - qty_shipped,
                sku NVARCHAR(50)
            );
            INSERT INTO t (qty_ordered, qty_shipped, sku) VALUES (10, 4, 'SKU-1');
        `);
        expect(r.errors()).toEqual([]);
        const row = r.table('t').rows[0];
        expect(row.qty_ordered).toBe(10);
        expect(row.qty_shipped).toBe(4);
        expect(row.sku).toBe('SKU-1');
    });

    it('handles `PERSISTED NOT NULL` modifier without crashing', () => {
        const r = exec(`
            CREATE TABLE t (
                a INT NOT NULL,
                b INT NOT NULL,
                c AS (a + b) PERSISTED NOT NULL,
                tag NVARCHAR(20)
            );
            INSERT INTO t (a, b, tag) VALUES (1, 2, 'ok');
        `);
        expect(r.errors()).toEqual([]);
        const row = r.table('t').rows[0];
        expect(row.a).toBe(1);
        expect(row.b).toBe(2);
        expect(row.tag).toBe('ok');
    });

    // T-SQL accepts both `PERSISTED NOT NULL` and `NOT NULL PERSISTED`. The
    // earlier code only handled the canonical order — the alternate order
    // would terminate the expression scan prematurely, leak `NOT NULL` into
    // the trailing column slot, and silently misalign positional INSERTs.
    it('handles the alternate `NOT NULL PERSISTED` modifier order', () => {
        const r = exec(`
            CREATE TABLE t (
                a INT NOT NULL,
                b INT NOT NULL,
                c AS (a + b) NOT NULL PERSISTED,
                tag NVARCHAR(20)
            );
            INSERT INTO t (a, b, tag) VALUES (1, 2, 'ok');
        `);
        expect(r.errors()).toEqual([]);
        const row = r.table('t').rows[0];
        expect(row.a).toBe(1);
        expect(row.b).toBe(2);
        // The critical assertion: `tag` is still its own column slot.
        expect(row.tag).toBe('ok');
        // And `c` is still registered (NULL value, not evaluated).
        expect('c' in row).toBe(true);
    });

    it('handles bare-AS computed column with `NOT NULL PERSISTED`', () => {
        // Same alternate ordering, but on the bare-AS form (no parens).
        // This was the original silent-misalignment case in the audit.
        const r = exec(`
            CREATE TABLE t (
                qty_ordered INT NOT NULL,
                qty_shipped INT NOT NULL,
                qty_left AS qty_ordered - qty_shipped NOT NULL PERSISTED,
                sku NVARCHAR(20)
            );
            INSERT INTO t (qty_ordered, qty_shipped, sku) VALUES (10, 4, 'SKU-1');
        `);
        expect(r.errors()).toEqual([]);
        const row = r.table('t').rows[0];
        expect(row.qty_ordered).toBe(10);
        expect(row.qty_shipped).toBe(4);
        expect(row.sku).toBe('SKU-1');
    });
});

// ════════════════════════════════════════════════════════════════════
// MySQL inline SET — regression test for the new fix
// ════════════════════════════════════════════════════════════════════
describe('Executor — MySQL inline SET registration', () => {
    it('registers a SET column as an enum-like type with `_set` suffix', () => {
        const r = exec(`
            CREATE TABLE t (
                id INT PRIMARY KEY,
                perms SET('read','write','admin')
            );
        `);
        expect(r.errors()).toEqual([]);
        const setType = r.types.get('perms_set') || r.type('perms_set');
        expect(setType).toBeTruthy();
        expect(setType.kind).toBe('enum');
        expect(setType.values).toEqual(['read', 'write', 'admin']);
    });

    it('does not break INSERT alignment on a table with a SET column', () => {
        const r = exec(`
            CREATE TABLE t (
                id INT PRIMARY KEY,
                perms SET('read','write','admin'),
                name VARCHAR(50)
            );
            INSERT INTO t (id, perms, name) VALUES (1, 'read,write', 'alice');
        `);
        expect(r.errors()).toEqual([]);
        const row = r.table('t').rows[0];
        expect(row.id).toBe(1);
        expect(row.name).toBe('alice');
    });
});

// ════════════════════════════════════════════════════════════════════
// New tokenizer features end-to-end through the executor
// ════════════════════════════════════════════════════════════════════
describe('Executor — tokenizer features (end-to-end)', () => {
    it('strips MySQL `#` comment line in DDL/DML scripts', () => {
        const r = exec(`
            # mysqldump 8.0 dump file
            CREATE TABLE t (id INT, name VARCHAR(50));
            # comment between statements
            INSERT INTO t VALUES (1, 'alice');
        `);
        expect(r.errors()).toEqual([]);
        expect(r.table('t').rows).toHaveLength(1);
        expect(r.table('t').rows[0]).toMatchObject({ id: 1, name: 'alice' });
    });

    it('parses MSSQL `N\'…\'` Unicode literals in INSERT VALUES', () => {
        const r = exec(`
            CREATE TABLE t (id INT, msg NVARCHAR(50));
            INSERT INTO t VALUES (1, N'你好');
        `);
        expect(r.errors()).toEqual([]);
        expect(r.table('t').rows[0].msg).toBe('你好');
    });

    it('parses MySQL `\\\'` escape inside INSERT VALUES', () => {
        const r = exec(`
            CREATE TABLE t (id INT, note TEXT);
            INSERT INTO t VALUES (1, 'it\\'s working');
        `);
        expect(r.errors()).toEqual([]);
        expect(r.table('t').rows[0].note).toBe("it's working");
    });

    it('handles a 4-dialect mixed dump in one script', () => {
        const r = exec(`
            -- ─── SQLite ───
            CREATE TABLE lite (id INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT);
            INSERT INTO lite (msg) VALUES ('hi');

            -- ─── PostgreSQL ───
            CREATE TABLE pg (id BIGSERIAL PRIMARY KEY, tags TEXT);
            INSERT INTO pg (tags) VALUES ('{a,b,c}');

            # ─── MySQL ───
            CREATE TABLE \`my\` (\`id\` BIGINT AUTO_INCREMENT PRIMARY KEY, \`role\` ENUM('admin','user'));
            INSERT INTO \`my\` (\`role\`) VALUES ('admin');

            -- ─── MSSQL ───
            CREATE TABLE [ms] ([id] BIGINT IDENTITY(1,1) PRIMARY KEY, [greeting] NVARCHAR(50));
            INSERT INTO [ms] ([greeting]) VALUES (N'안녕');
        `);
        expect(r.errors()).toEqual([]);
        expect(r.table('lite').rows[0].id).toBe(1);
        expect(r.table('pg').rows[0].id).toBe(1);
        expect(r.table('my').rows[0].id).toBe(1);
        expect(r.table('ms').rows[0].id).toBe(1);
        expect(r.table('ms').rows[0].greeting).toBe('안녕');
    });
});

// ════════════════════════════════════════════════════════════════════
// CREATE INDEX cross-dialect parity in the executor
// ════════════════════════════════════════════════════════════════════
describe('Executor cross-dialect — CREATE INDEX', () => {
    const CASES = [
        ['SQLite plain', `CREATE INDEX ix_t_name ON t (name);`],
        ['SQLite UNIQUE partial', `CREATE UNIQUE INDEX ix_t_email ON t (email) WHERE email IS NOT NULL;`],
        ['PostgreSQL USING btree', `CREATE INDEX ix_t_name ON t USING btree (name);`],
        ['PostgreSQL CONCURRENTLY UNIQUE', `CREATE UNIQUE INDEX CONCURRENTLY ix_t_email ON t (email);`],
        ['MySQL with USING after column list', `CREATE INDEX ix_t_name ON t (name) USING BTREE;`],
        ['MSSQL CLUSTERED', `CREATE CLUSTERED INDEX ix_t_name ON t (name);`],
        ['MSSQL NONCLUSTERED + INCLUDE', `CREATE NONCLUSTERED INDEX ix_t_name ON t (name) INCLUDE (email);`],
    ];

    for (const [name, sql] of CASES) {
        it(`creates ${name} without errors`, () => {
            const r = exec(`
                CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(50), email VARCHAR(100));
                ${sql}
            `);
            expect(r.errors()).toEqual([]);
            const t = r.table('t');
            expect(t.indexes && t.indexes.length).toBeGreaterThanOrEqual(1);
        });
    }
});

// ════════════════════════════════════════════════════════════════════
// ALTER TABLE parity — same logical action, 4 syntaxes
// ════════════════════════════════════════════════════════════════════
describe('Executor cross-dialect — ALTER TABLE ADD COLUMN', () => {
    const CASES = [
        ['SQLite', `ALTER TABLE t ADD COLUMN email TEXT;`],
        ['PostgreSQL', `ALTER TABLE t ADD COLUMN email TEXT;`],
        ['MySQL', `ALTER TABLE \`t\` ADD COLUMN \`email\` VARCHAR(100);`],
        ['MSSQL', `ALTER TABLE [t] ADD [email] NVARCHAR(100);`],
    ];

    for (const [name, sql] of CASES) {
        it(`${name}: adds the column to existing rows`, () => {
            const r = exec(`
                CREATE TABLE t (id INT PRIMARY KEY, name TEXT);
                INSERT INTO t VALUES (1, 'alice');
                ${sql}
            `);
            expect(r.errors()).toEqual([]);
            const cols = r.table('t').columns.map((c) => c.name);
            expect(cols).toContain('email');
            // Existing row gains the column slot, value defaults to NULL.
            expect(r.table('t').rows[0]).toHaveProperty('email');
        });
    }
});
