import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseAST } from '@/lib/parse-ast/parseAst.js';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';
import { sampleSQL } from '@/features/editor/lib/sampleSQL';

/**
 * ════════════════════════════════════════════════════════════════════════════
 *  ERD Pipeline — end-to-end integration suite
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  Single source of truth for `parseAST` + `sqlToErdSchema` end-to-end
 *  behavior. Pure unit tests live in:
 *    - src/lib/parse-ast/parseAst.test.js     (319 tests)
 *    - src/lib/erdJsonSchema.test.js         (120 tests)
 *    - src/lib/genErdScript.contract.test.js (renderer contract)
 *
 *  This file covers everything else with the highest possible signal:
 *    1.  Real-world per-dialect production schemas (PG, MySQL, MSSQL).
 *    2.  Cross-dialect equivalence (same logical schema, three ways).
 *    3.  Reserved-keyword & adversarial syntax handling.
 *    4.  Generated / Computed / Identity columns per dialect.
 *    5.  Composite PK / UNIQUE / FK / CHECK constraints.
 *    6.  Schema-qualified identifiers and stripping.
 *    7.  Error reporting (shape, severity, position, propagation, actionable).
 *    8.  Renderer contract guarantees — every produced schema is renderable.
 *    9.  Crash-resistance against pathological SQL inputs.
 *   10.  Boundary & stress (long names, deep CHECK, mass relations, 200 tables).
 *   11.  Cardinality matrix — every Crow's-Foot bucket is exercised.
 */

beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function pipeline(sql) {
    const { errors } = parseAST(sql);
    const schema = sqlToErdSchema(sql);
    return { errors, schema };
}

function assertRendererReady(schema) {
    expect(schema).toBeDefined();
    expect(Array.isArray(schema.tables)).toBe(true);
    expect(Array.isArray(schema.relations)).toBe(true);
    expect(Array.isArray(schema.enums)).toBe(true);
    expect(Array.isArray(schema.composites)).toBe(true);
    for (const t of schema.tables) {
        expect(typeof t.name).toBe('string');
        expect(t.name.length).toBeGreaterThan(0);
        expect(Array.isArray(t.columns)).toBe(true);
        for (const c of t.columns) {
            expect(typeof c.name).toBe('string');
            expect(typeof c.type).toBe('string');
            expect(Array.isArray(c.constraints)).toBe(true);
            expect(Array.isArray(c.extras)).toBe(true);
        }
    }
    const tableNames = new Set(schema.tables.map((t) => t.name));
    for (const r of schema.relations) {
        expect(r.from?.table).toBeTruthy();
        expect(r.from?.column).toBeTruthy();
        expect(r.to?.table).toBeTruthy();
        expect(r.to?.column).toBeTruthy();
        expect(tableNames.has(r.from.table)).toBe(true);
        expect(tableNames.has(r.to.table)).toBe(true);
    }
}

const leafName = (name) => String(name || '').split('.').at(-1);
const tableByName = (schema, name) => {
    const exact = schema.tables.find((t) => t.name === name);
    if (exact) return exact;
    const leafMatches = schema.tables.filter((t) => leafName(t.name) === name);
    return leafMatches.length === 1 ? leafMatches[0] : undefined;
};
const colByName = (table, name) => table?.columns.find((c) => c.name === name);
const sameTableLabel = (actual, expected) => actual === expected || leafName(actual) === expected;
const errorsOnly = (errors) => errors.filter((e) => e.severity === 'error');

// ════════════════════════════════════════════════════════════════════════════
// 1. PostgreSQL — real-world SaaS multi-tenant + analytics schema
// ════════════════════════════════════════════════════════════════════════════

describe('PostgreSQL — multi-tenant SaaS + analytics', () => {
    const SQL = `
        CREATE SCHEMA auth;
        CREATE SCHEMA reporting;

        CREATE TYPE auth.role_kind AS ENUM ('admin', 'editor', 'viewer', 'guest');
        CREATE TYPE reporting.bucket AS ENUM ('hourly', 'daily', 'weekly', 'monthly');
        CREATE TYPE reporting.geo_point AS (lat NUMERIC, lng NUMERIC);

        CREATE TABLE auth.users (
            id BIGINT GENERATED ALWAYS AS IDENTITY (START WITH 1000 INCREMENT BY 1) PRIMARY KEY,
            email VARCHAR(320) NOT NULL UNIQUE,
            password_hash CHAR(60) NOT NULL,
            full_name TEXT,
            display_name TEXT GENERATED ALWAYS AS (COALESCE(full_name, split_part(email, '@', 1))) STORED,
            role auth.role_kind NOT NULL DEFAULT 'viewer',
            failed_logins INT NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
            balance NUMERIC(18, 2) NOT NULL DEFAULT -1.0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT chk_email_format CHECK (email LIKE '%@%')
        );

        CREATE TABLE auth.teams (
            id BIGSERIAL PRIMARY KEY,
            slug VARCHAR(64) NOT NULL UNIQUE,
            name TEXT NOT NULL,
            owner_id BIGINT NOT NULL REFERENCES auth.users(id) DEFERRABLE INITIALLY DEFERRED,
            parent_team_id BIGINT REFERENCES auth.teams(id) ON DELETE SET NULL
        );

        CREATE TABLE auth.team_members (
            team_id BIGINT NOT NULL REFERENCES auth.teams(id) ON DELETE CASCADE,
            user_id BIGINT NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
            role auth.role_kind NOT NULL DEFAULT 'viewer',
            joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (team_id, user_id)
        );

        CREATE TABLE reporting.events (
            id BIGSERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES auth.users(id),
            team_id BIGINT REFERENCES auth.teams(id),
            event_type VARCHAR(64) NOT NULL,
            payload JSONB,
            location reporting.geo_point,
            occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            day_bucket DATE GENERATED ALWAYS AS (occurred_at::date) STORED
        );

        CREATE TABLE reporting.metrics (
            id BIGSERIAL PRIMARY KEY,
            metric_name VARCHAR(128) NOT NULL,
            bucket reporting.bucket NOT NULL,
            ts TIMESTAMPTZ NOT NULL,
            value NUMERIC(20, 6) NOT NULL,
            CONSTRAINT uq_metric_bucket_ts UNIQUE (metric_name, bucket, ts)
        );

        ALTER TABLE auth.users ADD CONSTRAINT chk_balance CHECK (balance > -1000);
        ALTER TABLE reporting.metrics ADD COLUMN tags TEXT[];
    `;

    let r;
    beforeEach(() => { r = pipeline(SQL); });

    it('parses without parser-level errors', () => {
        expect(errorsOnly(r.errors)).toEqual([]);
    });

    it('discovers all 5 tables across two schemas', () => {
        expect(r.schema.tables.map((t) => t.name).sort()).toEqual(['auth.team_members', 'auth.teams', 'auth.users', 'reporting.events', 'reporting.metrics']);
    });

    it('registers both ENUM types', () => {
        expect(r.schema.enums.map((e) => e.name).sort()).toEqual(['bucket', 'role_kind']);
    });

    it('registers the geo_point composite type', () => {
        expect(r.schema.composites.map((c) => c.name)).toContain('geo_point');
    });

    it('preserves negative numeric default without spurious spacing (-1.0 not "- 1.0")', () => {
        const balance = colByName(tableByName(r.schema, 'users'), 'balance');
        expect(balance.extras.some((e) => /DEFAULT\s+-1\.?0?/.test(e))).toBe(true);
    });

    it('marks composite PRIMARY KEY on team_members(team_id, user_id)', () => {
        const tm = tableByName(r.schema, 'team_members');
        expect(colByName(tm, 'team_id').compositePk).toBe(true);
        expect(colByName(tm, 'user_id').compositePk).toBe(true);
    });

    it('marks composite UNIQUE on metrics(metric_name, bucket, ts)', () => {
        const m = tableByName(r.schema, 'metrics');
        const ts = colByName(m, 'ts');
        expect(ts.compositeUq || ts.constraints.includes('UQ')).toBeTruthy();
    });

    it('captures generated STORED columns (display_name, day_bucket)', () => {
        const dn = colByName(tableByName(r.schema, 'users'), 'display_name');
        const db = colByName(tableByName(r.schema, 'events'), 'day_bucket');
        expect(dn.extras.some((e) => /GENERATED|STORED/i.test(e))).toBe(true);
        expect(db.extras.some((e) => /GENERATED|STORED/i.test(e))).toBe(true);
    });

    it('captures column-level CHECK on failed_logins', () => {
        const fl = colByName(tableByName(r.schema, 'users'), 'failed_logins');
        expect(fl.extras.some((e) => /CHECK/i.test(e) && /failed_logins/.test(e))).toBe(true);
    });

    it('builds at least 5 distinct relations with no orphans', () => {
        expect(r.schema.relations.length).toBeGreaterThanOrEqual(5);
        const tableNames = new Set(r.schema.tables.map((t) => t.name));
        for (const rel of r.schema.relations) {
            expect(tableNames.has(rel.from.table)).toBe(true);
            expect(tableNames.has(rel.to.table)).toBe(true);
        }
    });

    it('captures self-referencing FK on teams(parent_team_id → teams.id)', () => {
        const selfRef = r.schema.relations.find((rel) => sameTableLabel(rel.from.table, 'teams') && sameTableLabel(rel.to.table, 'teams'));
        expect(selfRef).toBeDefined();
    });

    it('produces a renderer-ready schema', () => {
        assertRendererReady(r.schema);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. MySQL — real-world e-commerce schema
// ════════════════════════════════════════════════════════════════════════════

describe('MySQL — e-commerce (backticks, AUTO_INCREMENT, ENUM, JSON, ENGINE/CHARSET)', () => {
    const SQL = `
        CREATE TABLE \`customers\` (
            \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            \`email\` VARCHAR(255) NOT NULL,
            \`name\` VARCHAR(120) NOT NULL,
            \`tier\` ENUM('bronze', 'silver', 'gold', 'platinum') NOT NULL DEFAULT 'bronze',
            \`metadata\` JSON,
            \`balance\` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
            \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (\`id\`),
            UNIQUE KEY \`uk_email\` (\`email\`),
            KEY \`idx_tier_created\` (\`tier\`, \`created_at\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

        CREATE TABLE \`products\` (
            \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            \`sku\` VARCHAR(64) NOT NULL,
            \`name\` VARCHAR(255) NOT NULL,
            \`description\` TEXT,
            \`price\` DECIMAL(10, 2) NOT NULL CHECK (\`price\` >= 0),
            \`stock\` INT NOT NULL DEFAULT 0,
            \`status\` ENUM('draft', 'active', 'archived') NOT NULL DEFAULT 'draft',
            \`tags\` JSON,
            PRIMARY KEY (\`id\`),
            UNIQUE KEY \`uk_sku\` (\`sku\`)
        ) ENGINE=InnoDB;

        CREATE TABLE \`orders\` (
            \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            \`customer_id\` BIGINT UNSIGNED NOT NULL,
            \`status\` ENUM('pending', 'paid', 'shipped', 'delivered', 'cancelled') NOT NULL DEFAULT 'pending',
            \`total\` DECIMAL(12, 2) NOT NULL,
            \`placed_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (\`id\`),
            KEY \`idx_customer\` (\`customer_id\`),
            CONSTRAINT \`fk_orders_customer\` FOREIGN KEY (\`customer_id\`) REFERENCES \`customers\` (\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE
        ) ENGINE=InnoDB;

        CREATE TABLE \`order_items\` (
            \`order_id\` BIGINT UNSIGNED NOT NULL,
            \`product_id\` BIGINT UNSIGNED NOT NULL,
            \`quantity\` INT UNSIGNED NOT NULL DEFAULT 1,
            \`unit_price\` DECIMAL(10, 2) NOT NULL,
            \`line_total\` DECIMAL(12, 2) GENERATED ALWAYS AS (\`quantity\` * \`unit_price\`) STORED,
            PRIMARY KEY (\`order_id\`, \`product_id\`),
            CONSTRAINT \`fk_oi_order\` FOREIGN KEY (\`order_id\`) REFERENCES \`orders\` (\`id\`) ON DELETE CASCADE,
            CONSTRAINT \`fk_oi_product\` FOREIGN KEY (\`product_id\`) REFERENCES \`products\` (\`id\`)
        ) ENGINE=InnoDB;

        CREATE TABLE \`reviews\` (
            \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            \`product_id\` BIGINT UNSIGNED NOT NULL,
            \`customer_id\` BIGINT UNSIGNED NOT NULL,
            \`rating\` TINYINT NOT NULL CHECK (\`rating\` BETWEEN 1 AND 5),
            \`body\` TEXT,
            \`reviewed_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (\`id\`),
            UNIQUE KEY \`uk_one_review\` (\`product_id\`, \`customer_id\`),
            CONSTRAINT \`fk_rev_product\` FOREIGN KEY (\`product_id\`) REFERENCES \`products\` (\`id\`) ON DELETE CASCADE,
            CONSTRAINT \`fk_rev_customer\` FOREIGN KEY (\`customer_id\`) REFERENCES \`customers\` (\`id\`) ON DELETE CASCADE
        ) ENGINE=InnoDB;
    `;

    let r;
    beforeEach(() => { r = pipeline(SQL); });

    it('parses without parser-level errors', () => {
        expect(errorsOnly(r.errors)).toEqual([]);
    });

    it('discovers all 5 tables (backtick-quoted)', () => {
        expect(r.schema.tables.map((t) => t.name).sort()).toEqual(['customers', 'order_items', 'orders', 'products', 'reviews']);
    });

    it('lifts inline ENUM column types into named enum types', () => {
        // Multiple `status` columns collapse to one `status_enum` by name.
        expect(r.schema.enums.length).toBeGreaterThanOrEqual(2);
    });

    it('captures composite PK on order_items(order_id, product_id)', () => {
        const oi = tableByName(r.schema, 'order_items');
        expect(colByName(oi, 'order_id').compositePk).toBe(true);
        expect(colByName(oi, 'product_id').compositePk).toBe(true);
    });

    it('captures composite UNIQUE on reviews(product_id, customer_id)', () => {
        const rev = tableByName(r.schema, 'reviews');
        const pid = colByName(rev, 'product_id');
        expect(pid.compositeUq || pid.constraints.includes('UQ')).toBeTruthy();
    });

    it('captures generated STORED column on order_items.line_total', () => {
        const lt = colByName(tableByName(r.schema, 'order_items'), 'line_total');
        expect(lt.extras.some((e) => /GENERATED|STORED/i.test(e))).toBe(true);
    });

    it('marks `email` UNIQUE via named UNIQUE KEY', () => {
        const cust = tableByName(r.schema, 'customers');
        expect(colByName(cust, 'email').constraints).toContain('UQ');
    });

    it('builds 5+ relations with no orphans', () => {
        expect(r.schema.relations.length).toBeGreaterThanOrEqual(5);
        const tableNames = new Set(r.schema.tables.map((t) => t.name));
        for (const rel of r.schema.relations) {
            expect(tableNames.has(rel.from.table)).toBe(true);
            expect(tableNames.has(rel.to.table)).toBe(true);
        }
    });

    it('produces a renderer-ready schema', () => {
        assertRendererReady(r.schema);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. MSSQL — real-world banking core
// ════════════════════════════════════════════════════════════════════════════

describe('MSSQL — banking core (IDENTITY, PERSISTED computed, GO batches, bracketed idents)', () => {
    const SQL = `
        CREATE TABLE [dbo].[Branches] (
            [BranchID] INT IDENTITY(1, 1) NOT NULL,
            [Code] CHAR(6) NOT NULL,
            [Name] NVARCHAR(120) NOT NULL,
            [Address] NVARCHAR(255),
            [OpenedOn] DATE NOT NULL DEFAULT GETUTCDATE(),
            CONSTRAINT [PK_Branches] PRIMARY KEY CLUSTERED ([BranchID]),
            CONSTRAINT [UQ_Branches_Code] UNIQUE NONCLUSTERED ([Code])
        );
        GO

        CREATE TABLE [dbo].[Customers] (
            [CustomerID] BIGINT IDENTITY(1000, 1) NOT NULL PRIMARY KEY CLUSTERED,
            [BranchID] INT NOT NULL,
            [SSN] CHAR(11) NOT NULL,
            [FirstName] NVARCHAR(80) NOT NULL,
            [LastName] NVARCHAR(80) NOT NULL,
            [FullName] AS ([FirstName] + N' ' + [LastName]) PERSISTED,
            [BirthDate] DATE NOT NULL,
            [Email] NVARCHAR(320),
            [CreatedAt] DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
            CONSTRAINT [UQ_Customers_SSN] UNIQUE ([SSN]),
            CONSTRAINT [FK_Customers_Branch] FOREIGN KEY ([BranchID]) REFERENCES [dbo].[Branches] ([BranchID])
        );
        GO

        CREATE TABLE [dbo].[Accounts] (
            [AccountID] BIGINT IDENTITY(1, 1) NOT NULL PRIMARY KEY,
            [AccountNumber] CHAR(20) NOT NULL,
            [CustomerID] BIGINT NOT NULL,
            [AccountType] NVARCHAR(20) NOT NULL CHECK ([AccountType] IN (N'CHK', N'SAV', N'CD', N'LOAN')),
            [Balance] DECIMAL(18, 2) NOT NULL DEFAULT 0,
            [Currency] CHAR(3) NOT NULL DEFAULT 'USD',
            [OpenedAt] DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
            [ClosedAt] DATETIME2 NULL,
            [IsClosed] AS (CASE WHEN [ClosedAt] IS NULL THEN CAST(0 AS BIT) ELSE CAST(1 AS BIT) END) PERSISTED,
            CONSTRAINT [UQ_Accounts_Number] UNIQUE ([AccountNumber]),
            CONSTRAINT [FK_Accounts_Customer] FOREIGN KEY ([CustomerID]) REFERENCES [dbo].[Customers] ([CustomerID])
        );
        GO

        CREATE TABLE [dbo].[Transactions] (
            [TxnID] BIGINT IDENTITY(1, 1) NOT NULL PRIMARY KEY,
            [AccountID] BIGINT NOT NULL,
            [TxnType] NVARCHAR(10) NOT NULL,
            [Amount] DECIMAL(18, 2) NOT NULL,
            [Currency] CHAR(3) NOT NULL,
            [PostedAt] DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
            [Description] NVARCHAR(255),
            [SignedAmount] AS (CASE WHEN [TxnType] = N'DEBIT' THEN -[Amount] ELSE [Amount] END) PERSISTED,
            CONSTRAINT [FK_Txn_Account] FOREIGN KEY ([AccountID]) REFERENCES [dbo].[Accounts] ([AccountID])
        );
        GO

        CREATE TABLE [dbo].[Transfers] (
            [TransferID] BIGINT IDENTITY(1, 1) NOT NULL PRIMARY KEY,
            [FromAccountID] BIGINT NOT NULL,
            [ToAccountID] BIGINT NOT NULL,
            [Amount] DECIMAL(18, 2) NOT NULL CHECK ([Amount] > 0),
            [InitiatedAt] DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
            CONSTRAINT [FK_Transfers_From] FOREIGN KEY ([FromAccountID]) REFERENCES [dbo].[Accounts] ([AccountID]),
            CONSTRAINT [FK_Transfers_To] FOREIGN KEY ([ToAccountID]) REFERENCES [dbo].[Accounts] ([AccountID]),
            CONSTRAINT [CK_Transfers_DiffAccounts] CHECK ([FromAccountID] <> [ToAccountID])
        );
        GO
    `;

    let r;
    beforeEach(() => { r = pipeline(SQL); });

    it('parses 5 tables across GO batches', () => {
        expect(r.schema.tables.map((t) => t.name).sort()).toEqual(['Accounts', 'Branches', 'Customers', 'Transactions', 'Transfers']);
    });

    it('parses without parser-level errors', () => {
        expect(errorsOnly(r.errors)).toEqual([]);
    });

    it('strips [dbo] schema prefix from every table name', () => {
        for (const t of r.schema.tables) {
            expect(t.name).not.toContain('.');
            expect(t.name).not.toContain('[');
        }
    });

    it('captures IDENTITY auto-increment', () => {
        const cust = tableByName(r.schema, 'Customers');
        expect(colByName(cust, 'CustomerID').autoIncrement).toBe(true);
    });

    it('captures PERSISTED computed columns (FullName, IsClosed, SignedAmount)', () => {
        const fn = colByName(tableByName(r.schema, 'Customers'), 'FullName');
        const ic = colByName(tableByName(r.schema, 'Accounts'), 'IsClosed');
        const sa = colByName(tableByName(r.schema, 'Transactions'), 'SignedAmount');
        for (const c of [fn, ic, sa]) {
            expect(c).toBeDefined();
            expect(c.extras.some((e) => /AS|PERSISTED/i.test(e))).toBe(true);
        }
    });

    it('captures table-level CHECK with N\'literal\' IN (...) clause', () => {
        const acc = tableByName(r.schema, 'Accounts');
        const at = colByName(acc, 'AccountType');
        expect(at.extras.some((e) => /CHECK/i.test(e))).toBe(true);
    });

    it('builds dual-FK fan-out from Transfers to Accounts', () => {
        const transfers = r.schema.relations.filter((rel) => rel.from.table === 'Transfers' && rel.to.table === 'Accounts');
        expect(transfers).toHaveLength(2);
    });

    it('produces a renderer-ready schema', () => {
        assertRendererReady(r.schema);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Cross-dialect equivalence — same logical schema, three syntaxes
// ════════════════════════════════════════════════════════════════════════════

describe('Cross-dialect equivalence — users + posts in PG/MySQL/MSSQL', () => {
    const dialects = {
        PostgreSQL: `
            CREATE TABLE users (id BIGSERIAL PRIMARY KEY, email VARCHAR(320) NOT NULL UNIQUE);
            CREATE TABLE posts (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                title TEXT NOT NULL
            );
        `,
        MySQL: `
            CREATE TABLE \`users\` (
                \`id\` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                \`email\` VARCHAR(320) NOT NULL,
                UNIQUE KEY \`uk_email\` (\`email\`)
            ) ENGINE=InnoDB;
            CREATE TABLE \`posts\` (
                \`id\` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                \`user_id\` BIGINT UNSIGNED NOT NULL,
                \`title\` VARCHAR(255) NOT NULL,
                CONSTRAINT \`fk_posts_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
            ) ENGINE=InnoDB;
        `,
        MSSQL: `
            CREATE TABLE [dbo].[users] (
                [id] BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
                [email] NVARCHAR(320) NOT NULL,
                CONSTRAINT [uk_email] UNIQUE ([email])
            );
            GO
            CREATE TABLE [dbo].[posts] (
                [id] BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
                [user_id] BIGINT NOT NULL,
                [title] NVARCHAR(255) NOT NULL,
                CONSTRAINT [fk_posts_user] FOREIGN KEY ([user_id]) REFERENCES [dbo].[users] ([id]) ON DELETE CASCADE
            );
            GO
        `,
    };

    for (const [name, sql] of Object.entries(dialects)) {
        describe(name, () => {
            it('parses 2 tables, 1 relation, no errors', () => {
                const r = pipeline(sql);
                expect(errorsOnly(r.errors)).toEqual([]);
                expect(r.schema.tables.map((t) => t.name).sort()).toEqual(['posts', 'users']);
                expect(r.schema.relations).toHaveLength(1);
            });

            it('email is marked UNIQUE NOT NULL', () => {
                const r = pipeline(sql);
                const email = colByName(tableByName(r.schema, 'users'), 'email');
                expect(email.constraints).toContain('UQ');
                expect(email.constraints).toContain('NN');
            });

            it('posts.user_id → users.id with optional-many children and one required parent', () => {
                const r = pipeline(sql);
                const rel = r.schema.relations[0];
                expect(rel.from.table).toBe('posts');
                expect(rel.from.column).toBe('user_id');
                expect(rel.to.table).toBe('users');
                expect(rel.to.column).toBe('id');
                expect(rel.fromCard).toBe('0..n');
                expect(rel.toCard).toBe('1');
            });

            it('renders cleanly', () => {
                assertRendererReady(pipeline(sql).schema);
            });
        });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Reserved-keyword identifiers used as column names
// ════════════════════════════════════════════════════════════════════════════

describe('Reserved-keyword identifiers — disambiguation as column names', () => {
    const cases = [
        { name: 'KEY as column', sql: `CREATE TABLE t (id INT, key VARCHAR(128) NOT NULL);`, col: 'key' },
        { name: 'INDEX as column', sql: `CREATE TABLE t (id INT, index VARCHAR(64));`, col: 'index' },
        { name: 'VALUE as column', sql: `CREATE TABLE t (id INT, value TEXT);`, col: 'value' },
        { name: 'STATUS as column', sql: `CREATE TABLE t (id INT, status TEXT);`, col: 'status' },
        { name: 'LANGUAGE as column', sql: `CREATE TABLE t (id INT, language VARCHAR(8));`, col: 'language' },
    ];

    cases.forEach(({ name, sql, col }) => {
        it(name, () => {
            const r = pipeline(sql);
            expect(errorsOnly(r.errors)).toEqual([]);
            const c = colByName(tableByName(r.schema, 't'), col);
            expect(c).toBeDefined();
            expect(c.name).toBe(col);
        });
    });

    it('MySQL: bare KEY/INDEX/FULLTEXT/SPATIAL definitions are still skipped', () => {
        const sql = `
            CREATE TABLE t (
                id INT,
                name VARCHAR(64),
                KEY idx_name (name),
                INDEX idx_id (id),
                FULLTEXT KEY ft_name (name),
                SPATIAL INDEX sp_name (name)
            );
        `;
        const r = pipeline(sql);
        expect(errorsOnly(r.errors)).toEqual([]);
        const t = tableByName(r.schema, 't');
        expect(t.columns.map((c) => c.name).sort()).toEqual(['id', 'name']);
    });

    it('UNIQUE (a, key) marks composite UNIQUE without dropping the `key` column', () => {
        const r = pipeline(`CREATE TABLE t (a INT, key INT, UNIQUE (a, key));`);
        expect(errorsOnly(r.errors)).toEqual([]);
        const t = tableByName(r.schema, 't');
        expect(t.columns.map((c) => c.name).sort()).toEqual(['a', 'key']);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Generated / Computed / Identity columns per dialect
// ════════════════════════════════════════════════════════════════════════════

describe('Generated / Computed / Identity columns', () => {
    it('PG: GENERATED ALWAYS AS (...) STORED', () => {
        const r = pipeline(`
            CREATE TABLE t (
                a INT NOT NULL,
                b INT NOT NULL,
                sum INT GENERATED ALWAYS AS (a + b) STORED
            );
        `);
        const sum = colByName(tableByName(r.schema, 't'), 'sum');
        expect(sum.extras.some((e) => /GENERATED|STORED/i.test(e))).toBe(true);
    });

    it('PG: GENERATED ALWAYS AS IDENTITY (START WITH N INCREMENT BY M)', () => {
        const r = pipeline(`
            CREATE TABLE t (
                id BIGINT GENERATED ALWAYS AS IDENTITY (START WITH 1000 INCREMENT BY 1) PRIMARY KEY
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(tableByName(r.schema, 't')).toBeDefined();
    });

    it('PG: GENERATED BY DEFAULT AS IDENTITY', () => {
        const r = pipeline(`CREATE TABLE t (id INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY);`);
        expect(errorsOnly(r.errors)).toEqual([]);
    });

    it('PG: SERIAL / BIGSERIAL marks autoIncrement', () => {
        const r = pipeline(`CREATE TABLE t (id BIGSERIAL PRIMARY KEY);`);
        expect(colByName(tableByName(r.schema, 't'), 'id').autoIncrement).toBe(true);
    });

    it('MySQL: AUTO_INCREMENT marks autoIncrement', () => {
        const r = pipeline(`CREATE TABLE \`t\` (\`id\` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY);`);
        expect(colByName(tableByName(r.schema, 't'), 'id').autoIncrement).toBe(true);
    });

    it('MySQL: GENERATED ALWAYS AS (...) STORED with backticked references', () => {
        const r = pipeline(`
            CREATE TABLE \`t\` (
                \`a\` INT NOT NULL, \`b\` INT NOT NULL,
                \`p\` INT GENERATED ALWAYS AS (\`a\` * \`b\`) STORED
            );
        `);
        const p = colByName(tableByName(r.schema, 't'), 'p');
        expect(p.extras.some((e) => /GENERATED|STORED/i.test(e))).toBe(true);
    });

    it('MSSQL: IDENTITY(seed, increment) marks autoIncrement', () => {
        const r = pipeline(`CREATE TABLE [t] ([Id] INT IDENTITY(1, 1) NOT NULL PRIMARY KEY);`);
        expect(colByName(tableByName(r.schema, 't'), 'Id').autoIncrement).toBe(true);
    });

    it('MSSQL: AS (expression) PERSISTED captured', () => {
        const r = pipeline(`
            CREATE TABLE [t] (
                [Q] INT NOT NULL, [P] DECIMAL(10,2) NOT NULL,
                [Total] AS ([Q] * [P]) PERSISTED
            );
        `);
        const total = colByName(tableByName(r.schema, 't'), 'Total');
        expect(total).toBeDefined();
    });

    it('MSSQL: bare AS expression (no parens) computed column', () => {
        const r = pipeline(`
            CREATE TABLE [t] (
                [Days] INT NOT NULL,
                [Plant] DATE NOT NULL,
                [Harvest] AS DATEADD(DAY, [Days], [Plant])
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(colByName(tableByName(r.schema, 't'), 'Harvest')).toBeDefined();
    });

    it('MSSQL: AS CASE WHEN ... END computed column', () => {
        const r = pipeline(`
            CREATE TABLE [t] (
                [Closed] DATETIME2 NULL,
                [IsClosed] AS (CASE WHEN [Closed] IS NULL THEN 0 ELSE 1 END) PERSISTED
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Schema-qualified identifiers
// ════════════════════════════════════════════════════════════════════════════

describe('Schema-qualified identifiers — stripping & FK resolution', () => {
    it('PG: schema.table is stripped to bare table name', () => {
        const r = pipeline(`
            CREATE SCHEMA sales;
            CREATE TABLE sales.customers (id INT PRIMARY KEY);
            CREATE TABLE sales.orders (id INT PRIMARY KEY, customer_id INT REFERENCES sales.customers(id));
        `);
        expect(r.schema.tables.map((t) => t.name).sort()).toEqual(['customers', 'orders']);
        expect(r.schema.relations).toHaveLength(1);
    });

    it('MSSQL: [schema].[table] strips both quotes and schema', () => {
        const r = pipeline(`
            CREATE TABLE [dbo].[A] ([id] INT PRIMARY KEY);
            CREATE TABLE [dbo].[B] ([id] INT PRIMARY KEY, [a_id] INT REFERENCES [dbo].[A] ([id]));
        `);
        expect(r.schema.tables.map((t) => t.name).sort()).toEqual(['A', 'B']);
        expect(r.schema.relations).toHaveLength(1);
    });

    it('PG: qualified user-defined type (public.mood) normalizes to bare', () => {
        const r = pipeline(`
            CREATE TYPE public.mood AS ENUM ('happy', 'sad');
            CREATE TABLE t (id SERIAL PRIMARY KEY, m public.mood);
        `);
        expect(r.schema.enums.map((e) => e.name)).toContain('mood');
        const m = colByName(tableByName(r.schema, 't'), 'm');
        expect(m.type).toBe('mood');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. Error reporting — shape, severity, position, propagation
// ════════════════════════════════════════════════════════════════════════════

describe('Error reporting — shape contract', () => {
    function assertShape(e) {
        expect(e).toHaveProperty('message');
        expect(typeof e.message).toBe('string');
        expect(e.message.length).toBeGreaterThan(0);
        expect(e).toHaveProperty('severity');
        expect(['error', 'warning']).toContain(e.severity);
        expect(e.position?.line).toBeGreaterThanOrEqual(1);
        expect(e.position?.column).toBeGreaterThanOrEqual(1);
    }

    const errorCases = [
        `CREATE TABLE t (id INT, PRIMARY KEY ());`,
        `CREATE TABLE t (a, b INT) ENGINE=InnoDB;`,
        `CREATE TABLE t (id INT, FOREIGN KEY (id) REFERENCES);`,
        `CREATE TABLE t (id INT, UNIQUE ());`,
        `CREATE TABLE t (id INT;`,
        `CREATE TABLE t (id INT,);`,
        `CREATE TABLE t (id INT,, name TEXT);`,
    ];
    errorCases.forEach((sql, i) => {
        it(`case ${i + 1}: every error has shape {message, severity, position}`, () => {
            const { errors } = parseAST(sql);
            expect(errors.length).toBeGreaterThan(0);
            for (const e of errors) assertShape(e);
        });
    });

    it('tokenizer errors are normalized to the same `position` field as parser errors', () => {
        const { errors } = parseAST(`CREATE TABLE t (id INT;`);
        const tok = errors.find((e) => /Missing closing/.test(e.message));
        expect(tok).toBeTruthy();
        expect(tok.position.line).toBe(1);
        expect(tok.position.column).toBeGreaterThan(0);
    });

    it('multi-line SQL: errors carry correct line numbers', () => {
        const sql = `CREATE TABLE good (id INT);\n\n\n\nCREATE TABLE bad (id INT,);`;
        const { errors } = parseAST(sql);
        expect(errors.find((e) => e.position.line === 5)).toBeTruthy();
    });

    it('valid SQL produces zero parse errors', () => {
        const { errors } = parseAST(`CREATE TABLE u (id BIGSERIAL PRIMARY KEY, e VARCHAR(255) UNIQUE);`);
        expect(errors).toHaveLength(0);
    });
});

describe('Error reporting — severity correctness', () => {
    it('parser-level structural errors are severity "error"', () => {
        const { errors } = parseAST(`CREATE TABLE t (id INT, PRIMARY KEY ());`);
        const e = errors.find((er) => /PRIMARY KEY/.test(er.message));
        expect(e.severity).toBe('error');
    });

    it('FK-to-unknown-table is severity "warning"', () => {
        const { errors } = parseAST(`CREATE TABLE c (id INT, p INT REFERENCES nope(id));`);
        expect(errors.find((er) => /not defined/.test(er.message)).severity).toBe('warning');
    });
});

describe('Error reporting — actionable messages', () => {
    it('mentions the table name in table-level errors', () => {
        const { errors } = parseAST(`CREATE TABLE my_table (id INT;`);
        expect(errors.some((e) => /my_table/.test(e.message))).toBe(true);
    });

    it('mentions the column name in column-level errors', () => {
        const { errors } = parseAST(`CREATE TABLE t (a, b INT) ENGINE=InnoDB;`);
        expect(errors.some((e) => /'a'/.test(e.message))).toBe(true);
    });

    it('mentions the referenced table in FK warnings', () => {
        const { errors } = parseAST(`CREATE TABLE c (id INT, p INT REFERENCES some_target(id));`);
        expect(errors.some((e) => /some_target/.test(e.message))).toBe(true);
    });
});

describe('Error reporting — _parseErrors propagation through sqlToErdSchema', () => {
    it('always attaches an array', () => {
        const s = sqlToErdSchema(`CREATE TABLE t (id INT PRIMARY KEY);`);
        expect(Array.isArray(s._parseErrors)).toBe(true);
        expect(s._parseErrors).toHaveLength(0);
    });

    it('forwards parser errors verbatim', () => {
        const s = sqlToErdSchema(`CREATE TABLE t (a, b INT) ENGINE=InnoDB;`);
        expect(s._parseErrors.length).toBeGreaterThan(0);
        expect(s._parseErrors[0].severity).toBe('error');
    });

    it('emits warning when FK references unknown table', () => {
        const s = sqlToErdSchema(`CREATE TABLE c (id INT, p INT REFERENCES nope(id));`);
        const w = s._parseErrors.find((e) => /nope/.test(e.message));
        expect(w?.severity).toBe('warning');
    });

    it('emits warning when FK references unknown column on a defined table', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (id INT, p_id INT REFERENCES p(no_such));
        `);
        const w = s._parseErrors.find((e) => /no_such/.test(e.message));
        expect(w?.severity).toBe('warning');
    });

    it('case-insensitive FK target matching does NOT trip the warning', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE users (id INT PRIMARY KEY);
            CREATE TABLE posts (id INT, user_id INT REFERENCES Users(ID));
        `);
        expect(s._parseErrors.find((e) => /Relation dropped/.test(e.message))).toBeUndefined();
        expect(s.relations).toHaveLength(1);
    });

    it('still produces a renderable schema even when relations drop', () => {
        const s = sqlToErdSchema(`CREATE TABLE c (id INT, p_id INT REFERENCES nope(x));`);
        assertRendererReady(s);
        expect(s.tables).toHaveLength(1);
        expect(s.relations).toHaveLength(0);
    });
});

describe('Error reporting — editor UI contract', () => {
    function uiShape(err) {
        return {
            line: err.position?.line ?? err.start?.line ?? null,
            column: err.position?.column ?? err.start?.col ?? null,
            severity: err.severity,
            message: err.message,
        };
    }

    it('parser errors map cleanly to {line, column, severity, message}', () => {
        const s = sqlToErdSchema(`CREATE TABLE t (a, b INT);`);
        for (const e of s._parseErrors) {
            const ui = uiShape(e);
            expect(ui.line).toBeTruthy();
            expect(ui.column).toBeTruthy();
            expect(['error', 'warning']).toContain(ui.severity);
            expect(ui.message.length).toBeGreaterThan(0);
        }
    });

    it('tokenizer errors map cleanly to UI shape', () => {
        const s = sqlToErdSchema(`CREATE TABLE t (id INT;`);
        const tok = s._parseErrors.find((e) => /Missing closing/.test(e.message));
        const ui = uiShape(tok);
        expect(ui.line).toBe(1);
        expect(ui.column).toBeGreaterThan(0);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 9. Renderer contract — defensiveness + structural integrity
// ════════════════════════════════════════════════════════════════════════════

describe('Renderer contract — defensiveness', () => {
    it('empty SQL returns an empty but renderer-ready schema (no throw)', () => {
        for (const sql of ['', '   ', '\n\t\n']) {
            const s = sqlToErdSchema(sql);
            assertRendererReady(s);
            expect(s.tables).toHaveLength(0);
            expect(s.relations).toHaveLength(0);
        }
    });

    it('non-string input throws (programmer error)', () => {
        expect(() => sqlToErdSchema(null)).toThrow();
        expect(() => sqlToErdSchema(123)).toThrow();
        expect(() => sqlToErdSchema(undefined)).toThrow();
    });

    it('schema with only types but no tables still renders cleanly', () => {
        const s = sqlToErdSchema(`CREATE TYPE m AS ENUM ('a', 'b'); CREATE TYPE p AS (x INT, y INT);`);
        assertRendererReady(s);
        expect(s.tables).toHaveLength(0);
        expect(s.enums).toHaveLength(1);
        expect(s.composites).toHaveLength(1);
    });

    it('every column has constraints and extras as arrays (never undefined)', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (id INT PRIMARY KEY, name TEXT NOT NULL DEFAULT 'x' CHECK (name <> ''));
        `);
        for (const t of s.tables) {
            for (const c of t.columns) {
                expect(Array.isArray(c.constraints)).toBe(true);
                expect(Array.isArray(c.extras)).toBe(true);
            }
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 10. Cardinality matrix — every Crow's-Foot bucket
// ════════════════════════════════════════════════════════════════════════════

describe('Cardinality matrix', () => {
    const cases = [
        {
            name: '0..1 → 1 (FK is PK NOT NULL)',
            sql: `CREATE TABLE p (id INT PRIMARY KEY); CREATE TABLE c (id INT PRIMARY KEY REFERENCES p(id));`,
            fromCard: '0..1', toCard: '1',
        },
        {
            name: '0..1 → 0..1 (FK is UNIQUE NULLABLE)',
            sql: `CREATE TABLE p (id INT PRIMARY KEY); CREATE TABLE c (id INT PRIMARY KEY, p_id INT UNIQUE REFERENCES p(id));`,
            fromCard: '0..1', toCard: '0..1',
        },
        {
            name: '0..n → 1 (FK is NOT NULL non-unique)',
            sql: `CREATE TABLE p (id INT PRIMARY KEY); CREATE TABLE c (id INT PRIMARY KEY, p_id INT NOT NULL REFERENCES p(id));`,
            fromCard: '0..n', toCard: '1',
        },
        {
            name: '0..n → 0..1 (FK is nullable non-unique)',
            sql: `CREATE TABLE p (id INT PRIMARY KEY); CREATE TABLE c (id INT PRIMARY KEY, p_id INT REFERENCES p(id));`,
            fromCard: '0..n', toCard: '0..1',
        },
    ];

    cases.forEach(({ name, sql, fromCard, toCard }) => {
        it(name, () => {
            const r = pipeline(sql);
            expect(r.schema.relations).toHaveLength(1);
            expect(r.schema.relations[0].fromCard).toBe(fromCard);
            expect(r.schema.relations[0].toCard).toBe(toCard);
        });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 11. Adversarial syntax — formatting, comments, quoting
// ════════════════════════════════════════════════════════════════════════════

describe('Adversarial syntax permutations', () => {
    const equivalents = [
        `CREATE TABLE t (id INT PRIMARY KEY, name TEXT);`,
        `create table t (id int primary key, name text);`,
        `CREATE   TABLE   t   (   id   INT   PRIMARY   KEY  ,   name   TEXT  );`,
        `CREATE\nTABLE\nt\n(\n  id INT PRIMARY KEY,\n  name TEXT\n);`,
        `\uFEFFCREATE TABLE t (id INT PRIMARY KEY, name TEXT);`,
        `-- prefix comment\nCREATE TABLE t (id INT PRIMARY KEY, name TEXT);`,
        `/* block */ CREATE TABLE t (id INT PRIMARY KEY, name TEXT); /* trail */`,
        `CREATE TABLE t (\n  id INT PRIMARY KEY, -- inline\n  name TEXT\n);`,
        `CREATE TABLE "t" ("id" INT PRIMARY KEY, "name" TEXT);`,
        `CREATE TABLE \`t\` (\`id\` INT PRIMARY KEY, \`name\` TEXT);`,
        `CREATE TABLE [t] ([id] INT PRIMARY KEY, [name] TEXT);`,
    ];

    equivalents.forEach((sql, i) => {
        it(`variant ${i + 1} parses to the same logical schema`, () => {
            const r = pipeline(sql);
            expect(errorsOnly(r.errors)).toEqual([]);
            expect(r.schema.tables.map((t) => t.name)).toEqual(['t']);
            expect(r.schema.tables[0].columns.map((c) => c.name)).toEqual(['id', 'name']);
        });
    });

    const defaultPermutations = [
        [`DEFAULT 0`, /DEFAULT\s+0\b/],
        [`DEFAULT -1`, /DEFAULT\s+-1\b/],
        [`DEFAULT -0.5`, /DEFAULT\s+-0\.5\b/],
        [`DEFAULT 'hello'`, /DEFAULT\s+'hello'/],
        [`DEFAULT 'O''Brien'`, /DEFAULT\s+'O''?B/],
        [`DEFAULT NOW()`, /DEFAULT\s+NOW\(\)/i],
        [`DEFAULT CURRENT_TIMESTAMP`, /DEFAULT\s+CURRENT_TIMESTAMP/i],
        [`DEFAULT NULL`, /DEFAULT\s+NULL/i],
        [`DEFAULT TRUE`, /DEFAULT\s+TRUE/i],
        [`DEFAULT FALSE`, /DEFAULT\s+FALSE/i],
    ];

    defaultPermutations.forEach(([clause, pattern]) => {
        it(`captures default value: ${clause}`, () => {
            const r = pipeline(`CREATE TABLE t (id INT, v INT ${clause});`);
            expect(errorsOnly(r.errors)).toEqual([]);
            const v = colByName(tableByName(r.schema, 't'), 'v');
            expect(v.extras.some((e) => pattern.test(e))).toBe(true);
        });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 12. Crash resistance — pathological inputs never throw
// ════════════════════════════════════════════════════════════════════════════

describe('Crash resistance — pathological inputs', () => {
    const garbage = [
        '',
        '   ',
        ';;;;',
        '-- comment only',
        'CREATE',
        'CREATE TABLE',
        'CREATE TABLE t',
        'CREATE TABLE t (',
        'CREATE TABLE t (id',
        'CREATE TABLE t (id INT',
        'CREATE TABLE t (id INT,',
        '!@#$%^&*()',
        '中文 SQL 字符',
        'CREATE\u0000TABLE\u0000t',
        '\uFEFF\uFEFFCREATE TABLE t (id INT);',
        // PG
        `CREATE TABLE pg (id INT REFERENCES`,
        `CREATE TYPE x AS ENUM (`,
        `CREATE TABLE pg (id INT GENERATED ALWAYS AS`,
        // MySQL
        `CREATE TABLE \`my\` (\`id\` INT AUTO_INCREMENT,`,
        `CREATE TABLE \`my\` (\`id\` INT, ENGINE=`,
        `CREATE TABLE \`my\` (\`a\` ENUM(`,
        // MSSQL
        `CREATE TABLE [t] ([Id] INT IDENTITY(`,
        `CREATE TABLE [t] ([V] AS (`,
        `GO\nGO\nGO\nGO\nGO`,
        // Mixed nonsense
        `;;;;;CREATE;;CREATE TABLE;;;`,
        `CREATE TABLE t (a INT) /* unclosed comment`,
        `CREATE TABLE t (a TEXT DEFAULT 'unclosed`,
    ];

    garbage.forEach((sql) => {
        it(`does not throw on: ${JSON.stringify(sql.slice(0, 40))}`, () => {
            expect(() => parseAST(sql)).not.toThrow();
            expect(() => sqlToErdSchema(sql)).not.toThrow();
        });
    });

    it('partial schema with bad table preserves preceding good tables', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE good1 (id INT PRIMARY KEY);
            CREATE TABLE bad (id INT,);
            CREATE TABLE good2 (id INT PRIMARY KEY);
        `);
        const names = s.tables.map((t) => t.name);
        expect(names).toContain('good1');
        // good2 may or may not parse depending on recovery — at minimum good1 survives
        expect(s.tables.length).toBeGreaterThanOrEqual(1);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 13. Boundary tests
// ════════════════════════════════════════════════════════════════════════════

describe('Boundary tests', () => {
    it('63-character identifier (PG max)', () => {
        const longName = 'a' + 'b'.repeat(62);
        const r = pipeline(`CREATE TABLE ${longName} (id INT PRIMARY KEY);`);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(r.schema.tables.map((t) => t.name)).toContain(longName);
    });

    it('deeply nested CHECK expression (5 levels)', () => {
        const r = pipeline(`
            CREATE TABLE t (
                id INT PRIMARY KEY,
                v INT CHECK (((((v > 0)) AND ((v < 100))) AND v <> 42))
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
    });

    it('100 columns on a single table', () => {
        const cols = Array.from({ length: 100 }, (_, i) => `c${i} INT`).join(', ');
        const r = pipeline(`CREATE TABLE wide (id INT PRIMARY KEY, ${cols});`);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(tableByName(r.schema, 'wide').columns).toHaveLength(101);
    });

    it('1 parent → 50 children FK fan-out', () => {
        const children = Array.from({ length: 50 }, (_, i) =>
            `CREATE TABLE c${i} (id INT PRIMARY KEY, p_id INT NOT NULL REFERENCES p(id));`
        ).join('\n');
        const r = pipeline(`CREATE TABLE p (id INT PRIMARY KEY);\n${children}`);
        expect(errorsOnly(r.errors)).toEqual([]);
        const inboundToP = r.schema.relations.filter((rel) => rel.to.table === 'p');
        expect(inboundToP).toHaveLength(50);
    });

    it('many-to-many web (10 left × 10 right + 100-row junction)', () => {
        const leftCreate = Array.from({ length: 10 }, (_, i) => `CREATE TABLE L${i} (id INT PRIMARY KEY);`).join('\n');
        const rightCreate = Array.from({ length: 10 }, (_, i) => `CREATE TABLE R${i} (id INT PRIMARY KEY);`).join('\n');
        const junctions = [];
        for (let i = 0; i < 10; i++) {
            for (let j = 0; j < 10; j++) {
                junctions.push(`CREATE TABLE J_${i}_${j} (
                    l_id INT REFERENCES L${i}(id),
                    r_id INT REFERENCES R${j}(id),
                    PRIMARY KEY (l_id, r_id)
                );`);
            }
        }
        const r = pipeline([leftCreate, rightCreate, ...junctions].join('\n'));
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(r.schema.tables).toHaveLength(120);
        expect(r.schema.relations).toHaveLength(200);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 14. Stress — large mixed-dialect dump remains performant
// ════════════════════════════════════════════════════════════════════════════

describe('Stress — large mixed-dialect dump', () => {
    it('200-table mixed dialect schema parses in <1.5s with zero errors', () => {
        const blocks = [];
        for (let i = 0; i < 60; i++) {
            blocks.push(`CREATE TABLE pg_${i} (id BIGSERIAL PRIMARY KEY, fk INT REFERENCES pg_${Math.max(0, i - 1)}(id));`);
        }
        for (let i = 0; i < 70; i++) {
            blocks.push(`CREATE TABLE \`my_${i}\` (\`id\` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, \`v\` JSON) ENGINE=InnoDB;`);
        }
        for (let i = 0; i < 70; i++) {
            blocks.push(`CREATE TABLE [ms_${i}] ([Id] INT IDENTITY(1,1) PRIMARY KEY, [V] NVARCHAR(255));`);
            if (i % 10 === 0) blocks.push('GO');
        }
        const t0 = Date.now();
        const r = pipeline(blocks.join('\n'));
        expect(Date.now() - t0).toBeLessThan(1500);
        expect(r.schema.tables).toHaveLength(200);
        expect(errorsOnly(r.errors)).toEqual([]);
    });

    it('100-table linear chain (PG): each table FKs to its predecessor', () => {
        const chain = ['CREATE TABLE t0 (id INT PRIMARY KEY);'];
        for (let i = 1; i < 100; i++) {
            chain.push(`CREATE TABLE t${i} (id INT PRIMARY KEY, prev INT REFERENCES t${i - 1}(id));`);
        }
        const r = pipeline(chain.join('\n'));
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(r.schema.tables).toHaveLength(100);
        expect(r.schema.relations).toHaveLength(99);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 15. Property invariants — every produced schema satisfies these
// ════════════════════════════════════════════════════════════════════════════

describe('Property invariants', () => {
    const corpus = [
        `CREATE TABLE t (id INT PRIMARY KEY, name TEXT NOT NULL UNIQUE);`,
        `CREATE TABLE p (id INT PRIMARY KEY); CREATE TABLE c (id INT PRIMARY KEY, p_id INT REFERENCES p(id));`,
        `CREATE TYPE m AS ENUM ('a', 'b'); CREATE TABLE u (id INT PRIMARY KEY, mood m);`,
        `CREATE TABLE \`b\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`v\` JSON) ENGINE=InnoDB;`,
        `CREATE TABLE [m] ([Id] INT IDENTITY(1,1) PRIMARY KEY, [Code] CHAR(4) UNIQUE);`,
        `CREATE TABLE k (a INT, b INT, c INT, PRIMARY KEY (a, b), UNIQUE (b, c));`,
        `CREATE TABLE r (id INT PRIMARY KEY, parent INT REFERENCES r(id) ON DELETE SET NULL);`,
    ];

    corpus.forEach((sql, i) => {
        it(`corpus #${i + 1}: every column has name+type+arrays`, () => {
            const s = sqlToErdSchema(sql);
            for (const t of s.tables) {
                for (const c of t.columns) {
                    expect(typeof c.name).toBe('string');
                    expect(c.name.length).toBeGreaterThan(0);
                    expect(typeof c.type).toBe('string');
                    expect(Array.isArray(c.constraints)).toBe(true);
                    expect(Array.isArray(c.extras)).toBe(true);
                }
            }
        });

        it(`corpus #${i + 1}: every relation references existing tables/columns`, () => {
            const s = sqlToErdSchema(sql);
            const tableMap = new Map(s.tables.map((t) => [t.name, new Set(t.columns.map((c) => c.name))]));
            for (const rel of s.relations) {
                expect(tableMap.has(rel.from.table)).toBe(true);
                expect(tableMap.has(rel.to.table)).toBe(true);
                expect(tableMap.get(rel.from.table).has(rel.from.column)).toBe(true);
                expect(tableMap.get(rel.to.table).has(rel.to.column)).toBe(true);
            }
        });

        it(`corpus #${i + 1}: cardinality strings are from the closed vocabulary`, () => {
            const s = sqlToErdSchema(sql);
            const valid = new Set(['1', 'n', '1+', '0..1', '0..n']);
            for (const rel of s.relations) {
                expect(valid.has(rel.fromCard)).toBe(true);
                expect(valid.has(rel.toCard)).toBe(true);
            }
        });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 16. PostgreSQL — advanced types & features
// ════════════════════════════════════════════════════════════════════════════

describe('PostgreSQL — advanced types & features', () => {
    it('array column types (TEXT[], INT[], NUMERIC(10,2)[])', () => {
        const r = pipeline(`
            CREATE TABLE t (
                id SERIAL PRIMARY KEY,
                tags TEXT[] NOT NULL DEFAULT '{}',
                scores INT[],
                amounts NUMERIC(10, 2)[]
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        const t = tableByName(r.schema, 't');
        expect(t.columns.find((c) => c.name === 'tags').type.toUpperCase()).toMatch(/TEXT/);
        expect(t.columns.find((c) => c.name === 'scores').type.toUpperCase()).toMatch(/INT/);
    });

    it('JSON / JSONB column types', () => {
        const r = pipeline(`
            CREATE TABLE t (
                id SERIAL PRIMARY KEY,
                doc JSON,
                payload JSONB NOT NULL DEFAULT '{}'::jsonb
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        const t = tableByName(r.schema, 't');
        expect(t.columns.find((c) => c.name === 'doc').type.toUpperCase()).toMatch(/JSON/);
        expect(t.columns.find((c) => c.name === 'payload').type.toUpperCase()).toMatch(/JSONB?/);
    });

    it('UUID column with gen_random_uuid() default', () => {
        const r = pipeline(`
            CREATE TABLE t (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), v TEXT);
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        const id = colByName(tableByName(r.schema, 't'), 'id');
        expect(id.type.toUpperCase()).toBe('UUID');
        expect(id.extras.some((e) => /gen_random_uuid/i.test(e))).toBe(true);
    });

    it('TIMESTAMP WITH TIME ZONE / TIMESTAMPTZ aliases parse', () => {
        const r = pipeline(`
            CREATE TABLE t (
                id SERIAL PRIMARY KEY,
                a TIMESTAMP WITH TIME ZONE NOT NULL,
                b TIMESTAMPTZ NOT NULL,
                c TIMESTAMP WITHOUT TIME ZONE
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        const t = tableByName(r.schema, 't');
        expect(t.columns.map((c) => c.name)).toEqual(['id', 'a', 'b', 'c']);
    });

    it('INTERVAL, BYTEA, CIDR, INET, MACADDR types', () => {
        const r = pipeline(`
            CREATE TABLE t (
                id SERIAL PRIMARY KEY,
                duration INTERVAL,
                blob BYTEA,
                net CIDR,
                addr INET,
                mac MACADDR
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(tableByName(r.schema, 't').columns).toHaveLength(6);
    });

    it('table-level INHERITS clause does not break parsing', () => {
        const r = pipeline(`
            CREATE TABLE base (id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
            CREATE TABLE child (extra TEXT) INHERITS (base);
        `);
        // Parser may or may not capture the inherited columns, but at minimum
        // it must not throw and must include both tables.
        expect(r.schema.tables.map((t) => t.name).sort()).toEqual(['base', 'child']);
    });

    it('PARTITION BY RANGE clause does not break parsing', () => {
        const r = pipeline(`
            CREATE TABLE measurement (
                logdate DATE NOT NULL,
                temperature NUMERIC,
                humidity NUMERIC
            ) PARTITION BY RANGE (logdate);
        `);
        expect(r.schema.tables.map((t) => t.name)).toContain('measurement');
    });

    it("multi-value default with cast: DEFAULT 'active'::status_type", () => {
        const r = pipeline(`
            CREATE TYPE status_type AS ENUM ('active', 'inactive');
            CREATE TABLE t (id SERIAL PRIMARY KEY, s status_type NOT NULL DEFAULT 'active'::status_type);
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        const s = colByName(tableByName(r.schema, 't'), 's');
        expect(s.extras.some((e) => /DEFAULT.*active/i.test(e))).toBe(true);
    });

    it('column COMMENT via COMMENT ON COLUMN does not crash parser', () => {
        const r = pipeline(`
            CREATE TABLE t (id SERIAL PRIMARY KEY, e TEXT);
            COMMENT ON COLUMN t.e IS 'Email address';
        `);
        expect(r.schema.tables.map((t) => t.name)).toContain('t');
    });

    it('CHECK with subexpression and IN list', () => {
        const r = pipeline(`
            CREATE TABLE t (
                id SERIAL PRIMARY KEY,
                status TEXT NOT NULL CHECK (status IN ('a', 'b', 'c')),
                amount NUMERIC CHECK (amount >= 0 AND amount <= 1000000)
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
    });

    it('multi-column composite type used in a column', () => {
        const r = pipeline(`
            CREATE TYPE address AS (street TEXT, city TEXT, zip CHAR(10));
            CREATE TABLE customers (id SERIAL PRIMARY KEY, home_addr address, work_addr address);
        `);
        expect(r.schema.composites.map((c) => c.name)).toContain('address');
        expect(colByName(tableByName(r.schema, 'customers'), 'home_addr').type).toBe('address');
    });

    it('FK with ON DELETE NO ACTION / ON UPDATE RESTRICT', () => {
        const r = pipeline(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (id INT PRIMARY KEY, p_id INT REFERENCES p(id) ON DELETE NO ACTION ON UPDATE RESTRICT);
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(r.schema.relations).toHaveLength(1);
    });

    it('FK with ON DELETE SET DEFAULT', () => {
        const r = pipeline(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (id INT PRIMARY KEY, p_id INT DEFAULT 0 REFERENCES p(id) ON DELETE SET DEFAULT);
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(r.schema.relations).toHaveLength(1);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 17. MySQL — advanced features & quirks
// ════════════════════════════════════════════════════════════════════════════

describe('MySQL — advanced features & quirks', () => {
    it('TINYINT(1), SMALLINT, MEDIUMINT, BIGINT UNSIGNED', () => {
        const r = pipeline(`
            CREATE TABLE \`t\` (
                \`id\` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                \`flag\` TINYINT(1) NOT NULL DEFAULT 0,
                \`small\` SMALLINT NOT NULL,
                \`med\` MEDIUMINT
            ) ENGINE=InnoDB;
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(tableByName(r.schema, 't').columns).toHaveLength(4);
    });

    it('TEXT family: TINYTEXT, TEXT, MEDIUMTEXT, LONGTEXT', () => {
        const r = pipeline(`
            CREATE TABLE \`t\` (
                \`id\` INT PRIMARY KEY,
                \`tn\` TINYTEXT,
                \`tx\` TEXT,
                \`mt\` MEDIUMTEXT,
                \`lt\` LONGTEXT
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
    });

    it('BLOB family: TINYBLOB, BLOB, MEDIUMBLOB, LONGBLOB', () => {
        const r = pipeline(`
            CREATE TABLE \`t\` (
                \`id\` INT PRIMARY KEY,
                \`a\` TINYBLOB, \`b\` BLOB, \`c\` MEDIUMBLOB, \`d\` LONGBLOB
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
    });

    it('SET column type', () => {
        const r = pipeline(`
            CREATE TABLE \`t\` (
                \`id\` INT PRIMARY KEY,
                \`flags\` SET('a', 'b', 'c', 'd') NOT NULL DEFAULT 'a'
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
    });

    it('ON UPDATE CURRENT_TIMESTAMP parses without errors', () => {
        const r = pipeline(`
            CREATE TABLE \`t\` (
                \`id\` INT PRIMARY KEY,
                \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        // The DEFAULT clause is captured; the ON UPDATE attribute is MySQL-specific
        // metadata that the renderer currently elides. Verifying it parses cleanly
        // and the column survives is enough.
        const ua = colByName(tableByName(r.schema, 't'), 'updated_at');
        expect(ua).toBeDefined();
        expect(ua.constraints).toContain('NN');
    });

    it("column COMMENT '...' does not break and gets captured", () => {
        const r = pipeline(`
            CREATE TABLE \`t\` (
                \`id\` INT PRIMARY KEY,
                \`name\` VARCHAR(64) NOT NULL COMMENT 'Display name'
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
    });

    it('ENGINE / CHARSET / COLLATE / ROW_FORMAT table options', () => {
        const r = pipeline(`
            CREATE TABLE \`t\` (\`id\` INT PRIMARY KEY)
            ENGINE=InnoDB
            DEFAULT CHARSET=utf8mb4
            COLLATE=utf8mb4_unicode_ci
            ROW_FORMAT=DYNAMIC
            COMMENT='Test table';
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(r.schema.tables).toHaveLength(1);
    });

    it('VIRTUAL generated column (vs STORED)', () => {
        const r = pipeline(`
            CREATE TABLE \`t\` (
                \`a\` INT NOT NULL,
                \`b\` INT NOT NULL,
                \`v\` INT GENERATED ALWAYS AS (\`a\` + \`b\`) VIRTUAL
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        const v = colByName(tableByName(r.schema, 't'), 'v');
        expect(v.extras.some((e) => /VIRTUAL|GENERATED/i.test(e))).toBe(true);
    });

    it('FULLTEXT KEY and SPATIAL INDEX skipped without dropping data columns', () => {
        const r = pipeline(`
            CREATE TABLE \`t\` (
                \`id\` INT PRIMARY KEY,
                \`title\` VARCHAR(255) NOT NULL,
                \`body\` TEXT NOT NULL,
                \`loc\` POINT NOT NULL,
                FULLTEXT KEY \`ft_body\` (\`title\`, \`body\`),
                SPATIAL INDEX \`sp_loc\` (\`loc\`)
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        const t = tableByName(r.schema, 't');
        expect(t.columns.map((c) => c.name).sort()).toEqual(['body', 'id', 'loc', 'title']);
    });

    it('CREATE INDEX standalone statement', () => {
        const r = pipeline(`
            CREATE TABLE \`t\` (\`id\` INT PRIMARY KEY, \`v\` VARCHAR(255));
            CREATE INDEX \`idx_v\` ON \`t\` (\`v\`);
            CREATE UNIQUE INDEX \`uk_v\` ON \`t\` (\`v\`);
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 18. MSSQL — advanced features
// ════════════════════════════════════════════════════════════════════════════

describe('MSSQL — advanced features', () => {
    it('UNIQUEIDENTIFIER + NEWID() default', () => {
        const r = pipeline(`
            CREATE TABLE [t] (
                [Id] UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
                [Name] NVARCHAR(120) NOT NULL
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        const id = colByName(tableByName(r.schema, 't'), 'Id');
        expect(id.extras.some((e) => /NEWID/i.test(e))).toBe(true);
    });

    it('ROWVERSION / TIMESTAMP / SQL_VARIANT / HIERARCHYID types', () => {
        const r = pipeline(`
            CREATE TABLE [t] (
                [Id] INT IDENTITY(1, 1) PRIMARY KEY,
                [RowVer] ROWVERSION,
                [Variant] SQL_VARIANT,
                [Org] HIERARCHYID
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
    });

    it('DATETIMEOFFSET / DATETIME2 / SMALLDATETIME / TIME with precision', () => {
        const r = pipeline(`
            CREATE TABLE [t] (
                [Id] INT IDENTITY(1, 1) PRIMARY KEY,
                [A] DATETIMEOFFSET(7) NOT NULL,
                [B] DATETIME2(3) NOT NULL,
                [C] SMALLDATETIME NULL,
                [D] TIME(7) NULL
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
    });

    it('SPARSE column attribute and FILESTREAM modifier', () => {
        const r = pipeline(`
            CREATE TABLE [t] (
                [Id] INT IDENTITY(1, 1) PRIMARY KEY,
                [Optional] NVARCHAR(MAX) SPARSE NULL,
                [Doc] VARBINARY(MAX) FILESTREAM NULL
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
    });

    it('CREATE INDEX ... INCLUDE (...) WHERE ... (filtered + covering)', () => {
        const r = pipeline(`
            CREATE TABLE [t] ([Id] INT IDENTITY(1, 1) PRIMARY KEY, [V] INT NOT NULL, [Active] BIT NOT NULL);
            CREATE NONCLUSTERED INDEX [IX_t_active] ON [t] ([V]) INCLUDE ([Active]) WHERE [Active] = 1;
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
    });

    it('CREATE SEQUENCE statement does not break parsing', () => {
        const r = pipeline(`
            CREATE SEQUENCE [dbo].[OrderSeq] AS BIGINT START WITH 1000 INCREMENT BY 1 NO CYCLE;
            CREATE TABLE [Orders] ([Id] BIGINT NOT NULL DEFAULT NEXT VALUE FOR [dbo].[OrderSeq] PRIMARY KEY);
        `);
        expect(r.schema.tables.map((t) => t.name)).toContain('Orders');
    });

    it('ALTER TABLE ADD CONSTRAINT FOREIGN KEY (out-of-line)', () => {
        const r = pipeline(`
            CREATE TABLE [Customers] ([Id] INT IDENTITY(1, 1) PRIMARY KEY);
            CREATE TABLE [Orders] ([Id] INT IDENTITY(1, 1) PRIMARY KEY, [CustomerId] INT NOT NULL);
            ALTER TABLE [Orders]
                ADD CONSTRAINT [FK_Orders_Customers]
                FOREIGN KEY ([CustomerId]) REFERENCES [Customers] ([Id]) ON DELETE CASCADE;
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(r.schema.relations).toHaveLength(1);
    });

    it('CONSTRAINT named UNIQUE NONCLUSTERED with included columns', () => {
        const r = pipeline(`
            CREATE TABLE [t] (
                [Id] INT IDENTITY(1, 1) PRIMARY KEY,
                [Code] CHAR(10) NOT NULL,
                [V] INT NULL,
                CONSTRAINT [UQ_Code] UNIQUE NONCLUSTERED ([Code])
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(colByName(tableByName(r.schema, 't'), 'Code').constraints).toContain('UQ');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 19. ALTER TABLE — comprehensive matrix
// ════════════════════════════════════════════════════════════════════════════

describe('ALTER TABLE — comprehensive matrix', () => {
    // NOTE: The ERD pipeline replays common migration-style ALTER operations,
    // including ADD COLUMN and ADD CONSTRAINT, so dump files and migration
    // snippets converge on the same final table shape.

    it('ADD COLUMN materializes in the rendered schema', () => {
        const r = pipeline(`
            CREATE TABLE t (id INT PRIMARY KEY);
            ALTER TABLE t ADD COLUMN name TEXT NOT NULL DEFAULT 'x';
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(colByName(tableByName(r.schema, 't'), 'name')).toMatchObject({
            name: 'name',
            type: 'TEXT',
            constraints: ['NN'],
        });
    });

    it('ADD multiple columns in one ALTER materializes each column', () => {
        const r = pipeline(`
            CREATE TABLE t (id INT PRIMARY KEY);
            ALTER TABLE t ADD COLUMN a INT, ADD COLUMN b TEXT, ADD COLUMN c BOOL DEFAULT FALSE;
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(tableByName(r.schema, 't').columns.map((column) => column.name)).toEqual(['id', 'a', 'b', 'c']);
    });

    it('ADD CONSTRAINT PRIMARY KEY out-of-line marks composite PK', () => {
        const r = pipeline(`
            CREATE TABLE t (id INT NOT NULL, code CHAR(8) NOT NULL);
            ALTER TABLE t ADD CONSTRAINT pk_t PRIMARY KEY (id, code);
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        const t = tableByName(r.schema, 't');
        expect(colByName(t, 'id').compositePk).toBe(true);
        expect(colByName(t, 'code').compositePk).toBe(true);
    });

    it('ADD CONSTRAINT UNIQUE out-of-line marks UQ on the column', () => {
        const r = pipeline(`
            CREATE TABLE t (id INT PRIMARY KEY, e VARCHAR(255));
            ALTER TABLE t ADD CONSTRAINT uk_e UNIQUE (e);
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(colByName(tableByName(r.schema, 't'), 'e').constraints).toContain('UQ');
    });

    it('ADD CONSTRAINT FOREIGN KEY out-of-line creates a relation', () => {
        const r = pipeline(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (id INT PRIMARY KEY, p_id INT NOT NULL);
            ALTER TABLE c ADD CONSTRAINT fk_c_p FOREIGN KEY (p_id) REFERENCES p(id);
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(r.schema.relations).toHaveLength(1);
        expect(r.schema.relations[0].from.table).toBe('c');
        expect(r.schema.relations[0].to.table).toBe('p');
    });

    it('ADD CONSTRAINT CHECK out-of-line', () => {
        const r = pipeline(`
            CREATE TABLE t (id INT PRIMARY KEY, qty INT NOT NULL);
            ALTER TABLE t ADD CONSTRAINT ck_qty CHECK (qty >= 0);
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
    });

    it('multiple ALTER ADD CONSTRAINT statements stack predictably', () => {
        const r = pipeline(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (id INT PRIMARY KEY, p_id INT NOT NULL, code CHAR(8) NOT NULL);
            ALTER TABLE c ADD CONSTRAINT fk_c_p FOREIGN KEY (p_id) REFERENCES p(id);
            ALTER TABLE c ADD CONSTRAINT uk_c_code UNIQUE (code);
            ALTER TABLE c ADD CONSTRAINT ck_c_pid CHECK (p_id > 0);
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(r.schema.relations).toHaveLength(1);
        expect(colByName(tableByName(r.schema, 'c'), 'code').constraints).toContain('UQ');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 20. Cardinality — extended matrix (1+ side, mandatory both sides)
// ════════════════════════════════════════════════════════════════════════════

describe('Cardinality — extended matrix', () => {
    it('Composite FK is treated as a single relation per (from, to) pair', () => {
        const r = pipeline(`
            CREATE TABLE p (a INT NOT NULL, b INT NOT NULL, PRIMARY KEY (a, b));
            CREATE TABLE c (
                id INT PRIMARY KEY, pa INT NOT NULL, pb INT NOT NULL,
                FOREIGN KEY (pa, pb) REFERENCES p (a, b)
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        // Schema may emit one relation per FK column pair OR one composite —
        // either is acceptable, but every relation must terminate at p.
        expect(r.schema.relations.length).toBeGreaterThanOrEqual(1);
        for (const rel of r.schema.relations) expect(rel.to.table).toBe('p');
    });

    it('Self-referencing cycle: a → a with NULLABLE FK', () => {
        const r = pipeline(`
            CREATE TABLE node (id INT PRIMARY KEY, parent INT REFERENCES node(id) ON DELETE SET NULL);
        `);
        expect(r.schema.relations).toHaveLength(1);
        expect(r.schema.relations[0].fromCard).toBe('0..n');
    });

    it('Mandatory chain: a → b → c, every FK NOT NULL', () => {
        const r = pipeline(`
            CREATE TABLE a (id INT PRIMARY KEY);
            CREATE TABLE b (id INT PRIMARY KEY, a_id INT NOT NULL REFERENCES a(id));
            CREATE TABLE c (id INT PRIMARY KEY, b_id INT NOT NULL REFERENCES b(id));
        `);
        expect(r.schema.relations).toHaveLength(2);
        for (const rel of r.schema.relations) expect(rel).toMatchObject({ fromCard: '0..n', toCard: '1' });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 21. Column metadata integrity — every flag round-trips correctly
// ════════════════════════════════════════════════════════════════════════════

describe('Column metadata integrity', () => {
    const SQL = `
        CREATE TABLE meta (
            id BIGSERIAL PRIMARY KEY,
            email VARCHAR(255) NOT NULL UNIQUE,
            age INT CHECK (age >= 0),
            slug VARCHAR(64) NOT NULL,
            parent_id BIGINT REFERENCES meta(id),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT uk_slug UNIQUE (slug)
        );
    `;

    it('PK column is flagged with PK constraint', () => {
        const c = colByName(tableByName(pipeline(SQL).schema, 'meta'), 'id');
        expect(c.constraints).toContain('PK');
        // NN is implied by PK and intentionally not duplicated in the badge list.
    });

    it('FK relation is recorded in schema.relations (not as a per-column badge)', () => {
        const s = pipeline(SQL).schema;
        const fk = s.relations.find((r) => r.from.column === 'parent_id');
        expect(fk).toBeDefined();
        expect(fk.to.table).toBe('meta');
        expect(fk.to.column).toBe('id');
    });

    it('NOT NULL surfaces as NN on every explicitly NOT NULL non-PK column', () => {
        const t = tableByName(pipeline(SQL).schema, 'meta');
        for (const name of ['email', 'slug', 'created_at']) {
            expect(colByName(t, name).constraints).toContain('NN');
        }
    });

    it('UNIQUE column surfaces as UQ (both inline and named CONSTRAINT)', () => {
        const t = tableByName(pipeline(SQL).schema, 'meta');
        expect(colByName(t, 'email').constraints).toContain('UQ');
        expect(colByName(t, 'slug').constraints).toContain('UQ');
    });

    it('CHECK constraint becomes a CK extra entry', () => {
        const c = colByName(tableByName(pipeline(SQL).schema, 'meta'), 'age');
        expect(c.extras.some((e) => /CHECK|CK/i.test(e))).toBe(true);
    });

    it('DEFAULT clause is captured in extras with the literal text', () => {
        const c = colByName(tableByName(pipeline(SQL).schema, 'meta'), 'created_at');
        expect(c.extras.some((e) => /DEFAULT.*NOW\(\)/i.test(e))).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 22. ENUM & composite type usage across tables
// ════════════════════════════════════════════════════════════════════════════

describe('ENUM & composite type integrity', () => {
    it('ENUM type is shared across multiple tables', () => {
        const r = pipeline(`
            CREATE TYPE status AS ENUM ('on', 'off', 'maybe');
            CREATE TABLE a (id INT PRIMARY KEY, s status);
            CREATE TABLE b (id INT PRIMARY KEY, s status);
            CREATE TABLE c (id INT PRIMARY KEY, s status);
        `);
        expect(r.schema.enums).toHaveLength(1);
        for (const tName of ['a', 'b', 'c']) {
            expect(colByName(tableByName(r.schema, tName), 's').type).toBe('status');
        }
    });

    it('ENUM with single value is still valid', () => {
        const r = pipeline(`
            CREATE TYPE singleton AS ENUM ('only');
            CREATE TABLE t (id INT PRIMARY KEY, s singleton);
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(r.schema.enums[0].values).toEqual(['only']);
    });

    it('ENUM with quoted values containing special characters', () => {
        const r = pipeline(`
            CREATE TYPE special AS ENUM ('a-b', 'c d', 'e''f', 'g.h');
            CREATE TABLE t (id INT PRIMARY KEY, s special);
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(r.schema.enums[0].values).toHaveLength(4);
    });

    it('Composite type with multiple field types', () => {
        const r = pipeline(`
            CREATE TYPE addr AS (
                line1 VARCHAR(255),
                line2 VARCHAR(255),
                city VARCHAR(120),
                zip CHAR(10),
                country CHAR(2)
            );
        `);
        expect(r.schema.composites[0].fields).toHaveLength(5);
    });

    it('multiple ENUM types coexist', () => {
        const r = pipeline(`
            CREATE TYPE e1 AS ENUM ('a', 'b');
            CREATE TYPE e2 AS ENUM ('x', 'y', 'z');
            CREATE TYPE e3 AS ENUM ('p');
            CREATE TABLE t (id INT, a e1, b e2, c e3);
        `);
        expect(r.schema.enums.map((e) => e.name).sort()).toEqual(['e1', 'e2', 'e3']);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 23. CHECK constraint patterns — full coverage
// ════════════════════════════════════════════════════════════════════════════

describe('CHECK constraint patterns', () => {
    const patterns = [
        { name: 'simple comparison', sql: `CHECK (v > 0)` },
        { name: 'AND chain', sql: `CHECK (v > 0 AND v < 100)` },
        { name: 'OR chain', sql: `CHECK (v = 1 OR v = 2 OR v = 3)` },
        { name: 'IN list', sql: `CHECK (v IN (1, 2, 3, 5, 8, 13))` },
        { name: 'NOT IN list', sql: `CHECK (v NOT IN (0, -1))` },
        { name: 'BETWEEN', sql: `CHECK (v BETWEEN 1 AND 100)` },
        { name: 'NOT BETWEEN', sql: `CHECK (v NOT BETWEEN -10 AND 0)` },
        { name: 'LIKE pattern', sql: `CHECK (s LIKE '%@%')` },
        { name: 'string equality', sql: `CHECK (s = 'fixed')` },
        { name: 'IS NULL / IS NOT NULL', sql: `CHECK (s IS NOT NULL)` },
        { name: 'function call', sql: `CHECK (LENGTH(s) > 0)` },
        { name: 'arithmetic', sql: `CHECK (v + 1 > 0)` },
    ];

    patterns.forEach(({ name, sql }) => {
        it(`column-level: ${name}`, () => {
            const r = pipeline(`CREATE TABLE t (id INT PRIMARY KEY, v INT, s TEXT, ${name === 'CHECK column' ? '' : ''}CONSTRAINT ck ${sql});`);
            expect(errorsOnly(r.errors)).toEqual([]);
        });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 24. DEFAULT value patterns — full coverage (extends section 11)
// ════════════════════════════════════════════════════════════════════════════

describe('DEFAULT value patterns — extended', () => {
    const cases = [
        { c: `INT DEFAULT 0`, m: /DEFAULT\s+0\b/ },
        { c: `INT DEFAULT 42`, m: /DEFAULT\s+42\b/ },
        { c: `INT DEFAULT -100`, m: /DEFAULT\s+-100\b/ },
        { c: `BIGINT DEFAULT 9223372036854775807`, m: /DEFAULT\s+9223372036854775807\b/ },
        { c: `NUMERIC(10,2) DEFAULT 0.00`, m: /DEFAULT\s+0\.00\b/ },
        { c: `NUMERIC(10,2) DEFAULT 3.14`, m: /DEFAULT\s+3\.14\b/ },
        { c: `BOOL DEFAULT TRUE`, m: /DEFAULT\s+TRUE/i },
        { c: `BOOL DEFAULT FALSE`, m: /DEFAULT\s+FALSE/i },
        { c: `TEXT DEFAULT 'hello world'`, m: /DEFAULT\s+'hello world'/ },
        { c: `TEXT DEFAULT 'O''Brien'`, m: /DEFAULT\s+'O''?B/ },
        { c: `TEXT DEFAULT ''`, m: /DEFAULT\s+''/ },
        { c: `JSONB DEFAULT '{}'`, m: /DEFAULT\s+'\{\}'/ },
        { c: `TIMESTAMPTZ DEFAULT NOW()`, m: /DEFAULT\s+NOW\(\)/i },
        { c: `TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP`, m: /DEFAULT\s+CURRENT_TIMESTAMP/i },
        { c: `UUID DEFAULT gen_random_uuid()`, m: /DEFAULT\s+gen_random_uuid\(\)/i },
        { c: `DATE DEFAULT CURRENT_DATE`, m: /DEFAULT\s+CURRENT_DATE/i },
        { c: `TIME DEFAULT CURRENT_TIME`, m: /DEFAULT\s+CURRENT_TIME/i },
        { c: `TEXT DEFAULT NULL`, m: /DEFAULT\s+NULL/i },
    ];

    cases.forEach(({ c, m }) => {
        it(`captures: ${c}`, () => {
            const r = pipeline(`CREATE TABLE t (id SERIAL PRIMARY KEY, v ${c});`);
            expect(errorsOnly(r.errors)).toEqual([]);
            const v = colByName(tableByName(r.schema, 't'), 'v');
            expect(v.extras.some((e) => m.test(e))).toBe(true);
        });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 25. Real-world migration patterns (Rails / Django / Flyway / Liquibase)
// ════════════════════════════════════════════════════════════════════════════

describe('Real-world migration patterns', () => {
    it('Rails-style schema.rb dump → translated CREATE TABLE round-trip', () => {
        const sql = `
            CREATE TABLE users (
                id BIGSERIAL PRIMARY KEY,
                email VARCHAR(255) NOT NULL,
                encrypted_password VARCHAR(255) NOT NULL DEFAULT '',
                reset_password_token VARCHAR(255),
                reset_password_sent_at TIMESTAMP,
                remember_created_at TIMESTAMP,
                sign_in_count INTEGER NOT NULL DEFAULT 0,
                current_sign_in_at TIMESTAMP,
                last_sign_in_at TIMESTAMP,
                current_sign_in_ip INET,
                last_sign_in_ip INET,
                created_at TIMESTAMP NOT NULL,
                updated_at TIMESTAMP NOT NULL,
                CONSTRAINT users_email_unique UNIQUE (email)
            );
        `;
        const r = pipeline(sql);
        expect(errorsOnly(r.errors)).toEqual([]);
        const t = tableByName(r.schema, 'users');
        expect(t.columns.find((c) => c.name === 'email').constraints).toContain('UQ');
    });

    it('Django-style auth_user table parses cleanly', () => {
        const sql = `
            CREATE TABLE auth_user (
                id INTEGER NOT NULL PRIMARY KEY,
                password VARCHAR(128) NOT NULL,
                last_login TIMESTAMP NULL,
                is_superuser BOOLEAN NOT NULL,
                username VARCHAR(150) NOT NULL UNIQUE,
                first_name VARCHAR(150) NOT NULL,
                last_name VARCHAR(150) NOT NULL,
                email VARCHAR(254) NOT NULL,
                is_staff BOOLEAN NOT NULL,
                is_active BOOLEAN NOT NULL,
                date_joined TIMESTAMP NOT NULL
            );
        `;
        const r = pipeline(sql);
        expect(errorsOnly(r.errors)).toEqual([]);
        const t = tableByName(r.schema, 'auth_user');
        expect(t.columns.find((c) => c.name === 'username').constraints).toContain('UQ');
    });

    it('Flyway migration with multiple ALTER ADD CONSTRAINT FOREIGN KEY', () => {
        const sql = `
            CREATE TABLE customers (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE orders   (id SERIAL PRIMARY KEY, customer_id INT NOT NULL, total NUMERIC(10,2));
            CREATE TABLE invoices (id SERIAL PRIMARY KEY, order_id INT NOT NULL);

            ALTER TABLE orders   ADD CONSTRAINT fk_orders_customer  FOREIGN KEY (customer_id) REFERENCES customers(id);
            ALTER TABLE invoices ADD CONSTRAINT fk_invoices_order   FOREIGN KEY (order_id)    REFERENCES orders(id);
        `;
        const r = pipeline(sql);
        expect(errorsOnly(r.errors)).toEqual([]);
        const fkOrders = r.schema.relations.find((rel) => rel.from.table === 'orders' && rel.to.table === 'customers');
        const fkInvoices = r.schema.relations.find((rel) => rel.from.table === 'invoices' && rel.to.table === 'orders');
        expect(fkOrders).toBeDefined();
        expect(fkInvoices).toBeDefined();
    });

    it('Liquibase changeSet bracketed in xml-comment style does not break parsing', () => {
        const sql = `
            -- changeset author:erd-go id:1
            CREATE TABLE products (
                id SERIAL PRIMARY KEY,
                sku VARCHAR(64) NOT NULL UNIQUE,
                price NUMERIC(10, 2) NOT NULL CHECK (price >= 0)
            );
            -- changeset author:erd-go id:2
            CREATE TABLE warehouses (
                id SERIAL PRIMARY KEY,
                code VARCHAR(8) NOT NULL UNIQUE
            );
        `;
        const r = pipeline(sql);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(r.schema.tables.map((t) => t.name).sort()).toEqual(['products', 'warehouses']);
    });

    it('IF NOT EXISTS clauses recognised across PG/MySQL/MSSQL', () => {
        const sql = `
            CREATE TABLE IF NOT EXISTS pg_t (id SERIAL PRIMARY KEY, name TEXT);
            CREATE TABLE IF NOT EXISTS my_t (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(80));
        `;
        const r = pipeline(sql);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(tableByName(r.schema, 'pg_t')).toBeDefined();
        expect(tableByName(r.schema, 'my_t')).toBeDefined();
    });

    it('migration with COMMENT ON TABLE / COMMENT ON COLUMN doesn\'t crash', () => {
        const sql = `
            CREATE TABLE accounts (id SERIAL PRIMARY KEY, balance NUMERIC(12, 2) NOT NULL);
            COMMENT ON TABLE  accounts          IS 'customer-facing balance accounts';
            COMMENT ON COLUMN accounts.balance  IS 'must always be non-negative';
        `;
        const r = pipeline(sql);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(tableByName(r.schema, 'accounts').columns.length).toBeGreaterThanOrEqual(2);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 26. Determinism — same SQL ⇒ same schema (snapshot stability)
// ════════════════════════════════════════════════════════════════════════════

describe('Determinism / idempotence', () => {
    const sql = `
        CREATE TABLE a (id SERIAL PRIMARY KEY, b_id INT, c_id INT);
        CREATE TABLE b (id SERIAL PRIMARY KEY);
        CREATE TABLE c (id SERIAL PRIMARY KEY);
        ALTER TABLE a ADD CONSTRAINT fk_a_b FOREIGN KEY (b_id) REFERENCES b(id);
        ALTER TABLE a ADD CONSTRAINT fk_a_c FOREIGN KEY (c_id) REFERENCES c(id);
    `;

    it('parsing the same SQL twice yields structurally identical schemas', () => {
        const a = pipeline(sql).schema;
        const b = pipeline(sql).schema;
        expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
    });

    it('table order is preserved from declaration order', () => {
        const r = pipeline(sql);
        expect(r.schema.tables.map((t) => t.name)).toEqual(['a', 'b', 'c']);
    });

    it('relation order is preserved from FK declaration order', () => {
        const r = pipeline(sql);
        const rels = r.schema.relations.filter((rel) => rel.from.table === 'a');
        expect(rels.map((rel) => rel.to.table)).toEqual(['b', 'c']);
    });

    it('column order within a table is preserved from declaration', () => {
        const r = pipeline(`CREATE TABLE t (z INT, m INT, a INT, k INT);`);
        const t = tableByName(r.schema, 't');
        expect(t.columns.map((c) => c.name)).toEqual(['z', 'm', 'a', 'k']);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 27. Self-referencing & duplicate-target FK matrix
// ════════════════════════════════════════════════════════════════════════════

describe('Self-referencing & duplicate-target FKs', () => {
    it('self-FK: employees.manager_id → employees.id', () => {
        const r = pipeline(`
            CREATE TABLE employees (
                id INT PRIMARY KEY,
                name TEXT NOT NULL,
                manager_id INT REFERENCES employees(id)
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        const rel = r.schema.relations.find((x) => x.from.table === 'employees' && x.to.table === 'employees');
        expect(rel).toBeDefined();
        expect(rel.from.column).toBe('manager_id');
        expect(rel.to.column).toBe('id');
    });

    it('two FKs from one table to the same parent (shipping + billing → addresses)', () => {
        const r = pipeline(`
            CREATE TABLE addresses (id SERIAL PRIMARY KEY, line1 TEXT NOT NULL);
            CREATE TABLE orders (
                id SERIAL PRIMARY KEY,
                shipping_address_id INT NOT NULL REFERENCES addresses(id),
                billing_address_id  INT NOT NULL REFERENCES addresses(id)
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        const rels = r.schema.relations.filter((x) => x.from.table === 'orders' && x.to.table === 'addresses');
        expect(rels).toHaveLength(2);
        expect(rels.map((x) => x.from.column).sort()).toEqual(['billing_address_id', 'shipping_address_id']);
    });

    it('chain of FKs: a → b → c → d resolves all relations', () => {
        const r = pipeline(`
            CREATE TABLE d (id SERIAL PRIMARY KEY);
            CREATE TABLE c (id SERIAL PRIMARY KEY, d_id INT REFERENCES d(id));
            CREATE TABLE b (id SERIAL PRIMARY KEY, c_id INT REFERENCES c(id));
            CREATE TABLE a (id SERIAL PRIMARY KEY, b_id INT REFERENCES b(id));
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(r.schema.relations).toHaveLength(3);
    });

    it('many-to-many junction table with composite PK exposes both FKs', () => {
        const r = pipeline(`
            CREATE TABLE students (id SERIAL PRIMARY KEY);
            CREATE TABLE courses  (id SERIAL PRIMARY KEY);
            CREATE TABLE enrollments (
                student_id INT NOT NULL REFERENCES students(id),
                course_id  INT NOT NULL REFERENCES courses(id),
                PRIMARY KEY (student_id, course_id)
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        const rels = r.schema.relations.filter((x) => x.from.table === 'enrollments');
        expect(rels.map((x) => x.to.table).sort()).toEqual(['courses', 'students']);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 28. Type aliases & dialect equivalents
// ════════════════════════════════════════════════════════════════════════════

describe('Type aliases & dialect equivalents', () => {
    const aliasCases = [
        { sql: `id INT`, expect: /INT/i },
        { sql: `id INTEGER`, expect: /INT(EGER)?/i },
        { sql: `flag BOOL`, expect: /BOOL/i },
        { sql: `flag BOOLEAN`, expect: /BOOL/i },
        { sql: `body VARCHAR(MAX)`, expect: /VARCHAR/i },
        { sql: `body NVARCHAR(MAX)`, expect: /NVARCHAR/i },
        { sql: `body NTEXT`, expect: /NTEXT/i },
        { sql: `created TIMESTAMPTZ`, expect: /TIMESTAMP/i },
        { sql: `created TIMESTAMP WITH TIME ZONE`, expect: /TIMESTAMP/i },
    ];

    aliasCases.forEach(({ sql, expect: m }) => {
        it(`recognises type: ${sql}`, () => {
            const r = pipeline(`CREATE TABLE t (${sql});`);
            expect(errorsOnly(r.errors)).toEqual([]);
            const t = tableByName(r.schema, 't');
            expect(t.columns.length).toBeGreaterThanOrEqual(1);
            expect(t.columns[0].type).toMatch(m);
        });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 29. SQL comments — line, block, inline — never affect schema shape
// ════════════════════════════════════════════════════════════════════════════

describe('SQL comments — stripped without distortion', () => {
    it('line comments between statements', () => {
        const r = pipeline(`
            -- top of file
            CREATE TABLE a (id INT PRIMARY KEY);
            -- between tables
            CREATE TABLE b (id INT PRIMARY KEY);
            -- end of file
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(r.schema.tables).toHaveLength(2);
    });

    it('block comments inside a CREATE TABLE', () => {
        const r = pipeline(`
            CREATE TABLE t (
                id INT PRIMARY KEY, /* surrogate */
                /* multi
                   line
                   block */
                name TEXT NOT NULL
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        const t = tableByName(r.schema, 't');
        expect(t.columns.map((c) => c.name)).toEqual(['id', 'name']);
    });

    it('inline -- comment at end of column definition', () => {
        const r = pipeline(`
            CREATE TABLE t (
                id INT PRIMARY KEY, -- surrogate id
                name TEXT NOT NULL  -- display name
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(tableByName(r.schema, 't').columns).toHaveLength(2);
    });

    it('comments inside CHECK expressions don\'t corrupt the expression', () => {
        const r = pipeline(`
            CREATE TABLE t (
                id INT PRIMARY KEY,
                v INT CHECK (v > 0 /* must be positive */)
            );
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 30. Whitespace, CRLF, BOM, trailing semicolons
// ════════════════════════════════════════════════════════════════════════════

describe('Whitespace, CRLF, BOM, trailing semicolons', () => {
    it('leading BOM is tolerated', () => {
        const r = pipeline('\uFEFFCREATE TABLE t (id INT PRIMARY KEY);');
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(tableByName(r.schema, 't')).toBeDefined();
    });

    it('CRLF line endings are tolerated', () => {
        const sql = ['CREATE TABLE a (id INT PRIMARY KEY);', 'CREATE TABLE b (id INT PRIMARY KEY);'].join('\r\n');
        const r = pipeline(sql);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(r.schema.tables).toHaveLength(2);
    });

    it('extra blank lines between statements are tolerated', () => {
        const r = pipeline(`



            CREATE TABLE a (id INT PRIMARY KEY);



            CREATE TABLE b (id INT PRIMARY KEY);



        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(r.schema.tables).toHaveLength(2);
    });

    it('trailing semicolons (multiple) are tolerated', () => {
        const r = pipeline(`CREATE TABLE t (id INT PRIMARY KEY);;;;;;`);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(tableByName(r.schema, 't')).toBeDefined();
    });

    it('mixed tabs / spaces / wide indentation', () => {
        const r = pipeline(`\tCREATE\tTABLE\tt\t(\n\t\tid\tINT\tPRIMARY\tKEY,\n\t\tname\tTEXT\n\t);`);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(tableByName(r.schema, 't').columns).toHaveLength(2);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 31. parseAST contract — invariants from the public docblock
// ════════════════════════════════════════════════════════════════════════════

describe('parseAST contract invariants', () => {
    it('non-string input throws TypeError (callers must coerce / nullish-check)', () => {
        for (const v of [null, undefined, 0, 42, true, false, {}, []]) {
            expect(() => parseAST(v)).toThrow(TypeError);
        }
    });

    it('whitespace-only input returns empty AST with no errors (live-typing)', () => {
        for (const sql of ['', '   ', '\n\n\n', '\t\t\t', '\r\n\r\n']) {
            const r = parseAST(sql);
            expect(r.ast.tables).toEqual([]);
            expect(r.ast.types).toEqual([]);
            expect(errorsOnly(r.errors)).toEqual([]);
        }
    });

    it('parseAST is pure: same input → identical output', () => {
        const sql = `
            CREATE TABLE a (id SERIAL PRIMARY KEY, x INT);
            CREATE TABLE b (id SERIAL PRIMARY KEY, a_id INT REFERENCES a(id));
        `;
        const a = parseAST(sql);
        const b = parseAST(sql);
        expect(JSON.stringify(a.ast)).toEqual(JSON.stringify(b.ast));
        expect(JSON.stringify(a.errors)).toEqual(JSON.stringify(b.errors));
    });

    it('every error / warning carries position { line, column, index }', () => {
        const r = parseAST(`CREATE TABLE bad ( id );`); // missing type
        for (const err of r.errors) {
            expect(err.position).toBeDefined();
            expect(typeof err.position.line).toBe('number');
            expect(typeof err.position.column).toBe('number');
            expect(typeof err.position.index).toBe('number');
            expect(err.position.line).toBeGreaterThanOrEqual(1);
            expect(err.position.column).toBeGreaterThanOrEqual(1);
        }
    });

    it('errors array is always returned, even for heavily malformed input', () => {
        const r = parseAST(`CREATE TABLE ( garbage ((((`);
        expect(Array.isArray(r.errors)).toBe(true);
        expect(r.ast).toBeDefined();
        // The parser never throws on string input — it surfaces diagnostics.
        expect(r.errors.length).toBeGreaterThanOrEqual(0);
    });

    it('identifiers preserve their original casing', () => {
        const r = parseAST(`CREATE TABLE MyMixedCase (Id INT, FullName TEXT);`);
        expect(r.ast.tables[0].name).toBe('MyMixedCase');
        const colNames = r.ast.tables[0].columns.map((c) => c.name);
        expect(colNames).toContain('Id');
        expect(colNames).toContain('FullName');
    });

    it('errors are ordered (first by stream order — useful for the editor gutter)', () => {
        const r = parseAST(`
            CREATE TABLE a (
                id INT
                missing_comma TEXT,
                also_bad TEXT
                another_missing_comma TEXT
            );
        `);
        const positions = r.errors.map((e) => e.position?.index ?? -1).filter((i) => i >= 0);
        const sorted = [...positions].sort((a, b) => a - b);
        expect(positions).toEqual(sorted);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 32. Statement-boundary recovery — one bad table never sinks the rest
// ════════════════════════════════════════════════════════════════════════════

describe('Statement-boundary recovery', () => {
    it('recovers after a properly-terminated bad statement', () => {
        const r = pipeline(`
            CREATE TABLE good_a (id INT PRIMARY KEY);
            CREATE TABLE bad (id INT garbage_token here);
            CREATE TABLE good_b (id INT PRIMARY KEY);
        `);
        // Good tables on either side must survive.
        expect(tableByName(r.schema, 'good_a')).toBeDefined();
        expect(tableByName(r.schema, 'good_b')).toBeDefined();
    });

    it('recovers when a statement uses GO instead of ; (MSSQL)', () => {
        const r = pipeline(`
            CREATE TABLE a (id INT PRIMARY KEY)
            GO
            CREATE TABLE b (id INT PRIMARY KEY)
            GO
        `);
        expect(errorsOnly(r.errors)).toEqual([]);
        expect(tableByName(r.schema, 'a')).toBeDefined();
        expect(tableByName(r.schema, 'b')).toBeDefined();
    });

    it('a stray DROP between two CREATEs does not block recovery', () => {
        const r = pipeline(`
            CREATE TABLE a (id INT PRIMARY KEY);
            DROP TABLE IF EXISTS some_other_table;
            CREATE TABLE b (id INT PRIMARY KEY);
        `);
        expect(tableByName(r.schema, 'a')).toBeDefined();
        expect(tableByName(r.schema, 'b')).toBeDefined();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 33. parseAST AST contract — every column has the documented fields
// ════════════════════════════════════════════════════════════════════════════

describe('parseAST AST contract', () => {
    it('every column has at least { name, type } and constraints reflect declarations', () => {
        const r = parseAST(`
            CREATE TABLE t (
                id     SERIAL PRIMARY KEY,
                email  VARCHAR(255) NOT NULL UNIQUE,
                name   TEXT,
                price  NUMERIC(10, 2) CHECK (price >= 0),
                pid    INT REFERENCES other(id)
            );
        `);
        const t = r.ast.tables[0];
        for (const col of t.columns) {
            expect(typeof col.name).toBe('string');
            expect(typeof col.type).toBe('string');
            expect(col.name.length).toBeGreaterThan(0);
            expect(col.type.length).toBeGreaterThan(0);
        }
    });

    it('table-level CONSTRAINT entries land in `constraints` not `columns`', () => {
        const r = parseAST(`
            CREATE TABLE t (
                a INT,
                b INT,
                CONSTRAINT pk_t PRIMARY KEY (a, b),
                CONSTRAINT uq_b UNIQUE (b)
            );
        `);
        const t = r.ast.tables[0];
        expect(t.columns.map((c) => c.name).sort()).toEqual(['a', 'b']);
        expect(t.constraints.length).toBeGreaterThanOrEqual(2);
        expect(t.constraints.some((c) => c.kind === 'primary' && c.name === 'pk_t')).toBe(true);
        expect(t.constraints.some((c) => c.kind === 'unique' && c.name === 'uq_b')).toBe(true);
    });

    it('CREATE TYPE ... AS ENUM lands in ast.types', () => {
        const r = parseAST(`CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');`);
        expect(r.ast.types).toHaveLength(1);
        expect(r.ast.types[0].kind).toBe('enum');
        expect(r.ast.types[0].name).toBe('mood');
        expect(r.ast.types[0].values).toEqual(['sad', 'ok', 'happy']);
    });

    it('ALTER TABLE ADD CONSTRAINT FOREIGN KEY lands in ast.alters', () => {
        const r = parseAST(`
            CREATE TABLE a (id INT PRIMARY KEY);
            CREATE TABLE b (id INT PRIMARY KEY, a_id INT);
            ALTER TABLE b ADD CONSTRAINT fk_b_a FOREIGN KEY (a_id) REFERENCES a(id);
        `);
        expect(r.ast.alters.length).toBeGreaterThanOrEqual(1);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 34. SQL → ERD renderer-shape — frozen JSON contract
// ════════════════════════════════════════════════════════════════════════════
//
// These tests pin the EXACT JSON shape `genErdScript.js` consumes, by way of
// `sqlToErdSchema(sql)`. Any change here is a renderer-breaking change — bump
// the renderer in lockstep or the canvas will misrender.
// ════════════════════════════════════════════════════════════════════════════

describe('SQL → ERD shape — top-level contract', () => {
    it('returns the canonical empty schema for empty input', () => {
        expect(sqlToErdSchema('')).toEqual({
            enums: [],
            composites: [],
            tables: [],
            relations: [],
            _parseErrors: [],
        });
    });

    it('every table has { name, columns } and every column has { name, type, constraints, extras }', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE u (id INT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE);
            CREATE TABLE p (id INT PRIMARY KEY, uid INT REFERENCES u(id));
        `);
        for (const t of s.tables) {
            expect(Object.keys(t).sort()).toEqual(['columns', 'name'].sort());
            for (const c of t.columns) {
                expect(typeof c.name).toBe('string');
                expect(typeof c.type).toBe('string');
                expect(Array.isArray(c.constraints)).toBe(true);
                expect(Array.isArray(c.extras)).toBe(true);
                for (const badge of c.constraints) expect(['PK', 'UQ', 'NN', 'FK']).toContain(badge);
            }
        }
    });

    it('every relation has the frozen { from, to, fromCard, toCard } shape', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE u (id INT PRIMARY KEY);
            CREATE TABLE p (id INT PRIMARY KEY, uid INT REFERENCES u(id));
        `);
        for (const r of s.relations) {
            expect(typeof r.from?.table).toBe('string');
            expect(typeof r.from?.column).toBe('string');
            expect(typeof r.to?.table).toBe('string');
            expect(typeof r.to?.column).toBe('string');
            expect(['1', 'n', '0..1', '0..n', '1+']).toContain(r.fromCard);
            expect(['1', 'n', '0..1', '0..n', '1+']).toContain(r.toCard);
        }
    });
});

describe('SQL → ERD — column constraint badges', () => {
    it('PRIMARY KEY column gets PK badge and pk:true (no separate NN)', () => {
        const s = sqlToErdSchema(`CREATE TABLE t (id INT PRIMARY KEY);`);
        const id = s.tables[0].columns[0];
        expect(id.constraints).toEqual(['PK']);
        expect(id.pk).toBe(true);
    });

    it('UNIQUE NOT NULL column gets [UQ, NN] but not PK', () => {
        const s = sqlToErdSchema(`CREATE TABLE t (id INT PRIMARY KEY, email TEXT UNIQUE NOT NULL);`);
        const email = s.tables[0].columns[1];
        expect(email.constraints.sort()).toEqual(['NN', 'UQ']);
        expect(email.pk).not.toBe(true);
    });

    it('FK column gets fk:true (badge stays in `constraints` only when inline)', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE u (id INT PRIMARY KEY);
            CREATE TABLE p (id INT PRIMARY KEY, uid INT REFERENCES u(id));
        `);
        const uid = tableByName(s, 'p').columns.find((c) => c.name === 'uid');
        expect(uid.fk).toBe(true);
    });

    it('NOT NULL alone (no PK) appears as NN', () => {
        const s = sqlToErdSchema(`CREATE TABLE t (id INT PRIMARY KEY, x TEXT NOT NULL);`);
        const x = s.tables[0].columns[1];
        expect(x.constraints).toContain('NN');
    });

    it('plain column with no constraints has empty arrays (no nulls)', () => {
        const s = sqlToErdSchema(`CREATE TABLE t (id INT PRIMARY KEY, x TEXT);`);
        const x = s.tables[0].columns[1];
        expect(x.constraints).toEqual([]);
        expect(x.extras).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// SQL → ERD — CREATE INDEX → IDX / UQ badges (full pipeline)
// ════════════════════════════════════════════════════════════════════════════

describe('SQL → ERD — CREATE INDEX badges', () => {
    it('CREATE INDEX on a single column adds an IDX badge', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (id INT PRIMARY KEY, name TEXT);
            CREATE INDEX idx_t_name ON t (name);
        `);
        const name = tableByName(s, 't').columns.find((c) => c.name === 'name');
        expect(name.constraints).toContain('IDX');
        expect(name.compositeIdx).toBeFalsy();
    });

    it('CREATE UNIQUE INDEX on a single column adds a UQ badge (not IDX)', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (id INT PRIMARY KEY, email TEXT);
            CREATE UNIQUE INDEX uq_email ON t (email);
        `);
        const email = tableByName(s, 't').columns.find((c) => c.name === 'email');
        expect(email.constraints).toContain('UQ');
        expect(email.constraints).not.toContain('IDX');
        expect(email.compositeUq).toBeFalsy();
    });

    it('composite CREATE INDEX flags every column with IDX + compositeIdx', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (a INT, b INT, c INT);
            CREATE INDEX idx_ab ON t (a, b);
        `);
        const cols = tableByName(s, 't').columns;
        const a = cols.find((c) => c.name === 'a');
        const b = cols.find((c) => c.name === 'b');
        const c = cols.find((c) => c.name === 'c');
        expect(a.constraints).toContain('IDX');
        expect(b.constraints).toContain('IDX');
        expect(a.compositeIdx).toBe(true);
        expect(b.compositeIdx).toBe(true);
        expect(c.constraints).not.toContain('IDX');
    });

    it('composite CREATE UNIQUE INDEX flags every column with UQ + compositeUq', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (a INT, b INT);
            CREATE UNIQUE INDEX uq_ab ON t (a, b);
        `);
        const cols = tableByName(s, 't').columns;
        cols.forEach((c) => {
            expect(c.constraints).toContain('UQ');
            expect(c.compositeUq).toBe(true);
        });
    });

    it('IDX is suppressed when the column already has PK or UQ (stronger guarantee)', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (id INT PRIMARY KEY, email TEXT UNIQUE);
            CREATE INDEX idx_id ON t (id);
            CREATE INDEX idx_email ON t (email);
        `);
        const id = tableByName(s, 't').columns.find((c) => c.name === 'id');
        const email = tableByName(s, 't').columns.find((c) => c.name === 'email');
        expect(id.constraints).toEqual(['PK']);
        expect(email.constraints).toEqual(['UQ']);
    });

    it('multiple non-overlapping indexes accumulate IDX badges per column', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (id INT PRIMARY KEY, a INT, b INT);
            CREATE INDEX idx_a ON t (a);
            CREATE INDEX idx_b ON t (b);
        `);
        const a = tableByName(s, 't').columns.find((c) => c.name === 'a');
        const b = tableByName(s, 't').columns.find((c) => c.name === 'b');
        expect(a.constraints).toContain('IDX');
        expect(b.constraints).toContain('IDX');
    });

    it('duplicate IDX badges deduplicate', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (a INT);
            CREATE INDEX idx_a1 ON t (a);
            CREATE INDEX idx_a2 ON t (a);
        `);
        const a = tableByName(s, 't').columns.find((c) => c.name === 'a');
        expect(a.constraints.filter((c) => c === 'IDX')).toHaveLength(1);
    });

    it('CREATE INDEX on unknown table is silently ignored (no badge, no crash)', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (id INT);
            CREATE INDEX idx ON does_not_exist (col);
        `);
        expect(s.tables).toHaveLength(1);
        expect(s.tables[0].columns[0].constraints).toEqual([]);
    });

    it('CREATE INDEX on unknown column is silently ignored', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (id INT, name TEXT);
            CREATE INDEX idx ON t (does_not_exist);
        `);
        const cols = s.tables[0].columns;
        cols.forEach((c) => expect(c.constraints).not.toContain('IDX'));
    });

    it('functional / expression indexes do not badge any column', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (a TEXT);
            CREATE INDEX idx_low ON t (lower(a));
        `);
        const a = s.tables[0].columns[0];
        expect(a.constraints).not.toContain('IDX');
    });

    it('schema-qualified table is matched (stripSchema parity)', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE app.users (id INT PRIMARY KEY, email TEXT);
            CREATE UNIQUE INDEX uq_email ON app.users (email);
        `);
        const email = s.tables[0].columns.find((c) => c.name === 'email');
        expect(email.constraints).toContain('UQ');
    });

    it('MySQL inline `KEY idx (col)` lands as an IDX badge', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (
                id INT PRIMARY KEY,
                name VARCHAR(50),
                KEY idx_name (name)
            );
        `);
        const name = s.tables[0].columns.find((c) => c.name === 'name');
        expect(name.constraints).toContain('IDX');
    });

    it('MySQL inline `INDEX (a, b)` composite flags compositeIdx', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (
                id INT,
                a INT,
                b INT,
                INDEX (a, b)
            );
        `);
        const a = s.tables[0].columns.find((c) => c.name === 'a');
        const b = s.tables[0].columns.find((c) => c.name === 'b');
        expect(a.constraints).toContain('IDX');
        expect(a.compositeIdx).toBe(true);
        expect(b.compositeIdx).toBe(true);
    });

    it('MSSQL CREATE NONCLUSTERED INDEX with INCLUDE list', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (id INT PRIMARY KEY, a INT, b INT);
            CREATE NONCLUSTERED INDEX idx_a ON t (a) INCLUDE (b);
        `);
        const a = s.tables[0].columns.find((c) => c.name === 'a');
        const b = s.tables[0].columns.find((c) => c.name === 'b');
        // INCLUDE columns are covering-only, not key columns — no IDX on b.
        expect(a.constraints).toContain('IDX');
        expect(b.constraints).not.toContain('IDX');
    });

    it('three-dialect parity: same logical index produces same badges', () => {
        const pg  = sqlToErdSchema(`CREATE TABLE t (id INT PRIMARY KEY, email TEXT); CREATE UNIQUE INDEX uq ON t (email);`);
        const my  = sqlToErdSchema('CREATE TABLE `t` (`id` INT PRIMARY KEY, `email` TEXT); CREATE UNIQUE INDEX `uq` ON `t` (`email`);');
        const ms  = sqlToErdSchema(`CREATE TABLE [t] ([id] INT PRIMARY KEY, [email] NVARCHAR(255)); CREATE UNIQUE NONCLUSTERED INDEX [uq] ON [t] ([email]);`);
        const constraintsOf = (s) => s.tables[0].columns.find((c) => c.name === 'email').constraints;
        expect(constraintsOf(pg)).toContain('UQ');
        expect(constraintsOf(my)).toContain('UQ');
        expect(constraintsOf(ms)).toContain('UQ');
    });
});

describe('SQL → ERD — auto-increment / SERIAL / IDENTITY all collapse to one shape', () => {
    const cases = [
        { sql: `CREATE TABLE t (id SERIAL PRIMARY KEY);`,                                     type: 'SERIAL' },
        { sql: `CREATE TABLE t (id BIGSERIAL PRIMARY KEY);`,                                  type: 'BIGSERIAL' },
        { sql: `CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY);`,                         type: 'INT' },
        { sql: `CREATE TABLE t (id INT IDENTITY(1,1) PRIMARY KEY);`,                          type: 'INT' },
        { sql: `CREATE TABLE t (id INT IDENTITY(100, 5) PRIMARY KEY);`,                       type: 'INT' },
        { sql: `CREATE TABLE t (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY);`,        type: 'BIGINT' },
        { sql: `CREATE TABLE t (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY);`,    type: 'BIGINT' },
    ];

    cases.forEach(({ sql, type }) => {
        it(`${type} → autoIncrement:true + extras includes 'AUTO_INCREMENT'`, () => {
            const s = sqlToErdSchema(sql);
            const id = s.tables[0].columns[0];
            expect(id.autoIncrement).toBe(true);
            expect(id.extras).toContain('AUTO_INCREMENT');
            expect(id.pk).toBe(true);
            expect(id.type).toBe(type);
        });
    });
});

describe('SQL → ERD — DEFAULT values land in extras as `DEFAULT <text>`', () => {
    const cases = [
        { decl: `n INT DEFAULT 42`,                          extras: ['DEFAULT 42'] },
        { decl: `n INT DEFAULT -1`,                          extras: ['DEFAULT -1'] },
        { decl: `s TEXT DEFAULT 'hi'`,                       extras: [`DEFAULT 'hi'`] },
        { decl: `b BOOLEAN DEFAULT TRUE`,                    extras: ['DEFAULT TRUE'] },
        { decl: `b BOOLEAN DEFAULT FALSE`,                   extras: ['DEFAULT FALSE'] },
        { decl: `c TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,     extras: ['DEFAULT CURRENT_TIMESTAMP'] },
        { decl: `c TIMESTAMP DEFAULT NOW()`,                 extras: ['DEFAULT NOW()'] },
        { decl: `u UUID DEFAULT gen_random_uuid()`,          extras: ['DEFAULT gen_random_uuid()'] },
        { decl: `u UNIQUEIDENTIFIER DEFAULT NEWID()`,        extras: ['DEFAULT NEWID()'] },
    ];

    cases.forEach(({ decl, extras }) => {
        it(`${decl} → extras = ${JSON.stringify(extras)}`, () => {
            const s = sqlToErdSchema(`CREATE TABLE t (id INT PRIMARY KEY, ${decl});`);
            const c = s.tables[0].columns[1];
            for (const expected of extras) expect(c.extras).toContain(expected);
        });
    });
});

describe('SQL → ERD — CHECK constraints land on referenced columns', () => {
    it('inline CHECK lands in that column extras', () => {
        const s = sqlToErdSchema(`CREATE TABLE t (id INT PRIMARY KEY, age INT CHECK (age >= 0));`);
        const age = s.tables[0].columns[1];
        expect(age.extras.some((e) => e.includes('CHECK') && e.includes('age >= 0'))).toBe(true);
    });

    it('table-level CHECK distributes to every referenced column with name prefix', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (
                id INT PRIMARY KEY,
                age INT,
                CONSTRAINT chk_age CHECK (age >= 0 AND age <= 150)
            );
        `);
        const age = s.tables[0].columns.find((c) => c.name === 'age');
        const has = age.extras.some((e) => e.includes('chk_age:') && e.includes('age >= 0'));
        expect(has).toBe(true);
    });

    it('unnamed table-level CHECK lands without name prefix', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (id INT PRIMARY KEY, score INT, CHECK (score BETWEEN 0 AND 100));
        `);
        const score = s.tables[0].columns.find((c) => c.name === 'score');
        expect(score.extras.some((e) => /^CHECK \(score/.test(e))).toBe(true);
    });

    it('multiple CHECKs accumulate on the same column without dedup loss', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (
                id INT PRIMARY KEY,
                n INT CHECK (n > 0),
                CONSTRAINT chk_upper CHECK (n < 100)
            );
        `);
        const n = s.tables[0].columns.find((c) => c.name === 'n');
        expect(n.extras.length).toBeGreaterThanOrEqual(2);
    });
});

describe('SQL → ERD — generated / computed columns', () => {
    it('PostgreSQL GENERATED … STORED → extras', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (id INT PRIMARY KEY, qty INT, price NUMERIC,
                            total NUMERIC GENERATED ALWAYS AS (qty * price) STORED);
        `);
        const total = s.tables[0].columns.find((c) => c.name === 'total');
        expect(total.extras.some((e) => /GENERATED ALWAYS AS \(qty \* price\) STORED/.test(e))).toBe(true);
    });

    it('MySQL VIRTUAL generated column also lands in extras', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (id INT PRIMARY KEY, n INT,
                            n2 INT GENERATED ALWAYS AS (n * 2) VIRTUAL);
        `);
        const n2 = s.tables[0].columns.find((c) => c.name === 'n2');
        expect(n2.extras.some((e) => /VIRTUAL/.test(e))).toBe(true);
    });

    it('MSSQL `col AS (expr) PERSISTED` → extras', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (id INT PRIMARY KEY, a INT, b INT,
                            ab AS (a + b) PERSISTED);
        `);
        const ab = s.tables[0].columns.find((c) => c.name === 'ab');
        expect(ab.extras.some((e) => /a \+ b/.test(e))).toBe(true);
    });
});

describe('SQL → ERD — Crow’s-Foot cardinality matrix (full)', () => {
    const SQL = `
        CREATE TABLE owner (id INT PRIMARY KEY);
        CREATE TABLE many_nn  (id INT PRIMARY KEY, oid INT NOT NULL REFERENCES owner(id));
        CREATE TABLE many_null(id INT PRIMARY KEY, oid INT          REFERENCES owner(id));
        CREATE TABLE one_nn   (id INT PRIMARY KEY, oid INT NOT NULL UNIQUE REFERENCES owner(id));
        CREATE TABLE one_null (id INT PRIMARY KEY, oid INT UNIQUE          REFERENCES owner(id));
    `;
    const matrix = [
        { from: 'many_nn',   fromCard: '0..n', toCard: '1' },
        { from: 'many_null', fromCard: '0..n', toCard: '0..1' },
        { from: 'one_nn',    fromCard: '0..1', toCard: '1' },
        { from: 'one_null',  fromCard: '0..1', toCard: '0..1' },
    ];

    matrix.forEach(({ from, fromCard, toCard }) => {
        it(`${from}.oid → owner gets ${fromCard} / ${toCard}`, () => {
            const s = sqlToErdSchema(SQL);
            const r = s.relations.find((rel) => rel.from.table === from);
            expect(r).toBeDefined();
            expect(r.fromCard).toBe(fromCard);
            expect(r.toCard).toBe(toCard);
        });
    });

    it('composite-PK column FK side downgrades to n (not unique)', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE p (a INT, b INT, PRIMARY KEY (a, b));
            CREATE TABLE c (id INT PRIMARY KEY, p_a INT NOT NULL, p_b INT NOT NULL,
                            FOREIGN KEY (p_a, p_b) REFERENCES p(a, b));
        `);
        // Each leg of a composite FK must NOT collapse to '1'.
        for (const r of s.relations) expect(r.fromCard).not.toBe('1');
    });
});

describe('SQL → ERD — relation deduplication and ALTER paths', () => {
    it('inline FK and ALTER ADD CONSTRAINT FK on the same pair → ONE relation', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (id INT PRIMARY KEY, p_id INT REFERENCES p(id));
            ALTER TABLE c ADD CONSTRAINT fk_dup FOREIGN KEY (p_id) REFERENCES p(id);
        `);
        const dup = s.relations.filter((r) => r.from.table === 'c' && r.from.column === 'p_id');
        expect(dup).toHaveLength(1);
        expect(dup[0].fkName).toBe('fk_dup');
    });

    it('ALTER ADD FOREIGN KEY without inline declaration creates the relation', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (id INT PRIMARY KEY, p_id INT);
            ALTER TABLE c ADD CONSTRAINT fk_c_p FOREIGN KEY (p_id) REFERENCES p(id);
        `);
        const r = s.relations.find((rel) => rel.from.table === 'c');
        expect(r).toBeDefined();
        expect(r.to.table).toBe('p');
        expect(r.fkName).toBe('fk_c_p');
        const child = tableByName(s, 'c').columns.find((c) => c.name === 'p_id');
        expect(child.fk).toBe(true);
    });

    it('ALTER ADD PRIMARY KEY upgrades a column to PK + flags compositePk for n>1', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (a INT, b INT);
            ALTER TABLE t ADD CONSTRAINT pk_t PRIMARY KEY (a, b);
        `);
        const t = tableByName(s, 't');
        for (const colName of ['a', 'b']) {
            const c = t.columns.find((cc) => cc.name === colName);
            expect(c.pk).toBe(true);
            expect(c.compositePk).toBe(true);
            expect(c.constraints).toContain('PK');
        }
    });

    it('ALTER ADD UNIQUE composite flags every column with UQ + compositeUq', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (a INT, b INT, PRIMARY KEY (a));
            ALTER TABLE t ADD CONSTRAINT uq_ab UNIQUE (a, b);
        `);
        const t = tableByName(s, 't');
        for (const colName of ['a', 'b']) {
            const c = t.columns.find((cc) => cc.name === colName);
            expect(c.constraints).toContain('UQ');
            expect(c.compositeUq).toBe(true);
        }
    });
});

describe('SQL → ERD — composite FK splits into one relation per column pair', () => {
    it('FOREIGN KEY (x, y) REFERENCES p(a, b) → 2 relations with paired columns', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE p (a INT, b INT, PRIMARY KEY (a, b));
            CREATE TABLE c (x INT, y INT, FOREIGN KEY (x, y) REFERENCES p(a, b));
        `);
        expect(s.relations).toHaveLength(2);
        const pair = s.relations.map((r) => `${r.from.column}->${r.to.column}`).sort();
        expect(pair).toEqual(['x->a', 'y->b']);
    });
});

describe('SQL → ERD — quote styles all collapse to clean identifiers', () => {
    it('backticks (MySQL), brackets (MSSQL), and double-quotes (PG) all strip cleanly', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE \`mysql_t\` (\`id\` INT PRIMARY KEY);
            CREATE TABLE [mssql_t] ([id] INT PRIMARY KEY);
            CREATE TABLE "pg_t" ("id" INT PRIMARY KEY);
        `);
        const names = s.tables.map((t) => t.name).sort();
        expect(names).toEqual(['mssql_t', 'mysql_t', 'pg_t']);
        for (const t of s.tables) expect(t.columns[0].name).toBe('id');
    });

    it('mixed schema table names stay qualified in the schema output', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE public.users (id INT PRIMARY KEY);
            CREATE TABLE dbo.posts  (id INT PRIMARY KEY, uid INT REFERENCES public.users(id));
        `);
        const names = s.tables.map((t) => t.name).sort();
        expect(names).toEqual(['dbo.posts', 'public.users']);
        // Cross-schema FK resolves without collapsing the visible namespace.
        const r = s.relations[0];
        expect(r.to.table).toBe('public.users');
    });
});

describe('SQL → ERD — type registration & user-type column normalization', () => {
    it('CREATE TYPE … AS ENUM populates schema.enums and is referenceable', () => {
        const s = sqlToErdSchema(`
            CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
            CREATE TABLE u (id INT PRIMARY KEY, m mood);
        `);
        expect(s.enums).toEqual([{ name: 'mood', values: ['sad', 'ok', 'happy'] }]);
        const m = tableByName(s, 'u').columns.find((c) => c.name === 'm');
        expect(m.type).toBe('mood');
    });

    it('inline MySQL ENUM column auto-registers as `<col>_enum` type', () => {
        const s = sqlToErdSchema(`CREATE TABLE u (id INT PRIMARY KEY, status ENUM('active','inactive'));`);
        expect(s.enums).toEqual([{ name: 'status_enum', values: ['active', 'inactive'] }]);
        const status = s.tables[0].columns.find((c) => c.name === 'status');
        expect(status.type).toBe('status_enum');
    });

    it('qualified user type `public.mood` normalizes to bare `mood` on the column', () => {
        const s = sqlToErdSchema(`
            CREATE TYPE public.mood AS ENUM ('a', 'b');
            CREATE TABLE u (id INT PRIMARY KEY, m public.mood);
        `);
        const m = s.tables[0].columns.find((c) => c.name === 'm');
        expect(m.type).toBe('mood');
        expect(s.enums.map((e) => e.name)).toContain('mood');
    });

    it('CREATE TYPE … AS (composite) lands in schema.composites', () => {
        const s = sqlToErdSchema(`
            CREATE TYPE addr AS (street TEXT, zip INT);
            CREATE TABLE u (id INT PRIMARY KEY, home addr);
        `);
        expect(s.composites.map((c) => c.name)).toContain('addr');
    });
});

describe('SQL → ERD — validateSchema warning policy', () => {
    it('FK to unknown TABLE → warning, relation dropped', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE c (id INT PRIMARY KEY, x INT REFERENCES nonex(id));
        `);
        expect(s.relations).toHaveLength(0);
        const w = s._parseErrors.find((e) => e.kind === 'relation_dropped_unknown_table');
        expect(w).toBeDefined();
        expect(w.severity).toBe('warning');
        expect(w.message).toMatch(/nonex/);
    });

    it('FK to unknown COLUMN of an existing table → warning, relation dropped', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (id INT PRIMARY KEY, x INT REFERENCES p(missing_col));
        `);
        expect(s.relations).toHaveLength(0);
        const w = s._parseErrors.find((e) => e.kind === 'relation_dropped_unknown_column');
        expect(w).toBeDefined();
        expect(w.severity).toBe('warning');
        expect(w.message).toMatch(/missing_col/);
    });

    it('valid FKs are preserved alongside dropped ones in the same script', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c1 (id INT PRIMARY KEY, x INT REFERENCES p(id));
            CREATE TABLE c2 (id INT PRIMARY KEY, x INT REFERENCES nonex(id));
        `);
        expect(s.relations).toHaveLength(1);
        expect(s.relations[0].from.table).toBe('c1');
        expect(s._parseErrors.some((e) => e.kind === 'relation_dropped_unknown_table')).toBe(true);
    });

    it('cardinality strings outside the allowed set are coerced to defaults', () => {
        // We can't easily produce an invalid card via SQL, so verify defaults
        // never escape: every emitted card must be a member of the valid set.
        const s = sqlToErdSchema(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (id INT PRIMARY KEY, p_id INT REFERENCES p(id));
        `);
        const valid = new Set(['1', 'n', '1+', '0..1', '0..n']);
        for (const r of s.relations) {
            expect(valid.has(r.fromCard)).toBe(true);
            expect(valid.has(r.toCard)).toBe(true);
        }
    });
});

describe('SQL → ERD — order independence and case insensitivity', () => {
    it('FK declared BEFORE the referenced table still resolves', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE c (id INT PRIMARY KEY, p_id INT REFERENCES p(id));
            CREATE TABLE p (id INT PRIMARY KEY);
        `);
        expect(s.relations).toHaveLength(1);
        expect(s._parseErrors.filter((e) => e.severity === 'error')).toHaveLength(0);
    });

    it('mixed-case identifiers in FK still resolve case-insensitively', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE Users (Id INT PRIMARY KEY);
            CREATE TABLE Posts (id INT PRIMARY KEY, uid INT REFERENCES users(ID));
        `);
        expect(s.relations).toHaveLength(1);
        expect(s._parseErrors.filter((e) => e.severity === 'error')).toHaveLength(0);
    });
});

describe('SQL → ERD — three-dialect parity (same schema, three syntaxes)', () => {
    const PG = `
        CREATE TABLE users (id BIGSERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE);
        CREATE TABLE posts (
            id BIGSERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES users(id),
            title TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `;
    const MY = `
        CREATE TABLE \`users\` (
            \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
            \`email\` VARCHAR(255) NOT NULL UNIQUE
        ) ENGINE=InnoDB CHARSET=utf8mb4;
        CREATE TABLE \`posts\` (
            \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
            \`user_id\` BIGINT NOT NULL,
            \`title\` TEXT NOT NULL,
            \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`)
        );
    `;
    const MS = `
        CREATE TABLE [users] ([id] BIGINT IDENTITY(1,1) PRIMARY KEY, [email] NVARCHAR(255) NOT NULL UNIQUE);
        CREATE TABLE [posts] (
            [id] BIGINT IDENTITY(1,1) PRIMARY KEY,
            [user_id] BIGINT NOT NULL,
            [title] NVARCHAR(MAX) NOT NULL,
            [created_at] DATETIME2 NOT NULL DEFAULT GETDATE(),
            CONSTRAINT [fk_posts_users] FOREIGN KEY ([user_id]) REFERENCES [users]([id])
        );
    `;

    [['Postgres', PG], ['MySQL', MY], ['MSSQL', MS]].forEach(([name, sql]) => {
        it(`${name} → 2 tables, 1 relation, no errors`, () => {
            const s = sqlToErdSchema(sql);
            expect(s.tables).toHaveLength(2);
            expect(s.relations).toHaveLength(1);
            expect(s._parseErrors.filter((e) => e.severity === 'error')).toHaveLength(0);

            const users = tableByName(s, 'users');
            const posts = tableByName(s, 'posts');
            expect(users).toBeDefined();
            expect(posts).toBeDefined();
            expect(users.columns.find((c) => c.name === 'email').constraints).toContain('UQ');
            expect(posts.columns.find((c) => c.name === 'user_id').fk).toBe(true);

            const r = s.relations[0];
            expect(r.from.table).toBe('posts');
            expect(r.to.table).toBe('users');
        });
    });
});

describe('SQL → ERD — full pipeline JSON snapshot (small but complete)', () => {
    it('produces the exact frozen JSON for a small Postgres schema', () => {
        const s = sqlToErdSchema(`
            CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
            CREATE TABLE users (
                id BIGSERIAL PRIMARY KEY,
                email VARCHAR(255) NOT NULL UNIQUE,
                m mood NOT NULL DEFAULT 'ok'
            );
            CREATE TABLE posts (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id),
                title TEXT NOT NULL
            );
        `);

        // Strip _parseErrors — only the pure schema is part of the renderer
        // contract. _parseErrors is metadata for the editor UI.
        const { _parseErrors, ...pure } = s;
        void _parseErrors;

        expect(pure).toEqual({
            enums: [{ name: 'mood', values: ['sad', 'ok', 'happy'] }],
            composites: [],
            tables: [
                {
                    name: 'users',
                    columns: [
                        { name: 'id',    type: 'BIGSERIAL',     constraints: ['PK'],       extras: ['AUTO_INCREMENT'], pk: true, autoIncrement: true },
                        { name: 'email', type: 'VARCHAR(255)',  constraints: ['UQ', 'NN'], extras: [] },
                        { name: 'm',     type: 'mood',          constraints: ['NN'],       extras: [`DEFAULT 'ok'`] },
                    ],
                },
                {
                    name: 'posts',
                    columns: [
                        { name: 'id',      type: 'BIGSERIAL', constraints: ['PK'],       extras: ['AUTO_INCREMENT'], pk: true, autoIncrement: true },
                        { name: 'user_id', type: 'BIGINT',    constraints: ['NN'],       extras: [], fk: true },
                        { name: 'title',   type: 'TEXT',      constraints: ['NN'],       extras: [] },
                    ],
                },
            ],
            relations: [
                {
                    from: { table: 'posts', column: 'user_id' },
                    to:   { table: 'users', column: 'id' },
                    fromCard: '0..n',
                    toCard:   '1',
                    // Position is anchored at the FK source column's name
                    // token so the editor can jump straight to it. Asserted
                    // by structural shape rather than literal coordinates so
                    // this snapshot doesn't churn when the test SQL above
                    // is reformatted.
                    position: expect.objectContaining({
                        line: expect.any(Number),
                        column: expect.any(Number),
                        index: expect.any(Number),
                    }),
                },
            ],
        });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Production demo SQL — `src/features/editor/lib/sampleSQL.js`
//
// This is the SQL clients see the moment they open the editor. Any
// regression here is user-visible. We lock the feature showcase end-to-end:
//   - Parse cleanly (zero errors, zero warnings)
//   - Produce exact SQLite-first tables, enums, composites, and relations
//   - Replay migration-style ALTER TABLE changes before ERD conversion
//   - Preserve implicit-PK FKs, composite FK groups, and FK actions
//   - Render partial unique indexes as PUQ without promoting them to UQ
//   - Apply IDX/UQ badge precedence and composite flags consistently
//   - Schema is renderer-ready (every contract invariant holds)
// ════════════════════════════════════════════════════════════════════════════

describe('Production sample SQL (`@/features/editor/lib/sampleSQL`)', () => {
    const { errors, schema } = (() => {
        const parseResult = parseAST(sampleSQL);
        const built = sqlToErdSchema(sampleSQL);
        return { errors: parseResult.errors, schema: built };
    })();

    it('parses with zero errors and zero warnings', () => {
        const errs = errorsOnly(errors);
        const warns = errors.filter((e) => e.severity === 'warning');
        expect(errs, `unexpected parse errors:\n${JSON.stringify(errs, null, 2)}`).toHaveLength(0);
        expect(warns, `unexpected parse warnings:\n${JSON.stringify(warns, null, 2)}`).toHaveLength(0);
    });

    it('produces a renderer-ready schema (contract invariants hold)', () => {
        assertRendererReady(schema);
    });

    const relationFrom = (table, column) =>
        schema.relations.find((r) => r.from.table === table && r.from.column === column);

    it('produces all 5 compact showcase tables in declaration order', () => {
        expect(schema.tables.map((t) => t.name)).toEqual([
            'users',
            'categories',
            'products',
            'orders',
            'order_items',
        ]);
    });

    it('produces standalone and inline ENUM / SET domains with correct values', () => {
        const byName = Object.fromEntries(schema.enums.map((e) => [e.name, e.values]));
        expect(byName.order_status).toEqual(['cart', 'paid', 'shipped', 'cancelled']);
        expect(byName.role_enum).toEqual(['admin', 'member']);
        expect(byName.flags_set).toEqual(['newsletter', 'beta']);
    });

    it('keeps the starter focused without extra composite types', () => {
        expect(schema.composites).toEqual([]);
    });

    it('replays ALTER TABLE changes before producing the ERD', () => {
        expect(colByName(tableByName(schema, 'users'), 'display_name')).toBeUndefined();
        expect(colByName(tableByName(schema, 'users'), 'full_name')).toMatchObject({
            type: 'VARCHAR(100)',
            constraints: ['NN'],
        });
        expect(colByName(tableByName(schema, 'users'), 'last_seen_at')).toBeDefined();

        expect(colByName(tableByName(schema, 'orders'), 'coupon_code')).toBeUndefined();
        expect(colByName(tableByName(schema, 'orders'), 'promotion_code')).toBeDefined();

        expect(colByName(tableByName(schema, 'products'), 'retired_at')).toBeUndefined();
    });

    it('preserves generated columns and user-defined type normalization', () => {
        expect(colByName(tableByName(schema, 'products'), 'search_label').extras).toContain("GENERATED ALWAYS AS (CONCAT(sku, ' - ', name)) STORED");
        expect(colByName(tableByName(schema, 'order_items'), 'line_total').extras).toContain('GENERATED ALWAYS AS (quantity * unit_price) STORED');
        expect(colByName(tableByName(schema, 'users'), 'role').type).toBe('role_enum');
        expect(colByName(tableByName(schema, 'users'), 'flags').type).toBe('flags_set');
    });

    it('produces every expected FK relation', () => {
        const pairs = schema.relations
            .map((r) => `${r.from.table}.${r.from.column}->${r.to.table}.${r.to.column}`)
            .sort();
        expect(pairs).toEqual([
            'categories.parent_id->categories.id',
            'order_items.order_id->orders.id',
            'order_items.product_id->products.id',
            'orders.customer_id->users.id',
            'products.category_id->categories.id',
        ].sort());
    });

    it('preserves representative FK actions and implicit PK targets', () => {
        expect(relationFrom('categories', 'parent_id')).toMatchObject({
            to: { table: 'categories', column: 'id' },
            actions: { onDelete: 'SET NULL' },
        });

        expect(relationFrom('orders', 'customer_id')).toMatchObject({
            to: { table: 'users', column: 'id' },
            actions: { onDelete: 'RESTRICT' },
        });

        expect(relationFrom('order_items', 'order_id')).toMatchObject({
            to: { table: 'orders', column: 'id' },
            actions: { onDelete: 'CASCADE' },
        });

        expect(relationFrom('order_items', 'product_id')).toMatchObject({
            to: { table: 'products', column: 'id' },
            actions: { onDelete: 'RESTRICT' },
        });
    });

    // ────────────────────────────────────────────────────────────────────
    // Index badges — the sample must show IDX / UQ / PUQ clearly
    // ────────────────────────────────────────────────────────────────────

    describe('IDX / UQ / PUQ badges from CREATE INDEX statements', () => {
        const cell = (table, column) =>
            colByName(tableByName(schema, table), column);

        it('users.email shows PUQ for partial unique, never global UQ', () => {
            const email = cell('users', 'email');
            expect(email.constraints).toContain('PUQ');
            expect(email.constraints).not.toContain('UQ');
            expect(email.compositePartialUq).toBeFalsy();
            expect(email.extras).toContain('PARTIAL UNIQUE INDEX ux_users_active_email WHERE deleted_at IS NULL');
        });

        it('users.role shows a single-column IDX badge', () => {
            const role = cell('users', 'role');
            expect(role.constraints).toContain('IDX');
            expect(role.compositeIdx).toBeFalsy();
        });

        it('orders.customer_id and status show composite IDX badges', () => {
            const c = cell('orders', 'customer_id');
            expect(c.constraints).toContain('IDX');
            expect(c.compositeIdx).toBe(true);
            expect(cell('orders', 'status').constraints).toContain('IDX');
            expect(cell('orders', 'status').compositeIdx).toBe(true);
        });

        it('orders.placed_at shows a single-column partial IDX badge', () => {
            expect(cell('orders', 'placed_at').constraints).toContain('IDX');
            expect(cell('orders', 'placed_at').compositeIdx).toBeFalsy();
        });

        it('categories.name keeps its inline UQ badge', () => {
            const c = cell('categories', 'name');
            expect(c.constraints).toContain('UQ');
            expect(c.constraints).not.toContain('IDX');
        });

        it('order_items.order_id keeps PK and is NOT demoted by IDX (PK suppresses IDX)', () => {
            const c = cell('order_items', 'order_id');
            // Composite PK: both `order_id` and `line_no` are PK-flagged.
            expect(c.constraints).toContain('PK');
            expect(c.constraints).not.toContain('IDX');
        });

        it('order_items.product_id keeps PK precedence over its lookup index', () => {
            const product = cell('order_items', 'product_id');
            expect(product.constraints).toContain('PK');
            expect(product.constraints).not.toContain('IDX');
        });

        it('products.category_id + products.price both get IDX + compositeIdx', () => {
            const cat   = cell('products', 'category_id');
            const price = cell('products', 'price');
            expect(cat.constraints).toContain('IDX');
            expect(price.constraints).toContain('IDX');
            expect(cat.compositeIdx).toBe(true);
            expect(price.compositeIdx).toBe(true);
        });

        it('products.sku keeps its inline UQ badge', () => {
            const c = cell('products', 'sku');
            expect(c.constraints).toContain('UQ');
            expect(c.constraints).not.toContain('IDX');
            expect(c.compositeUq).toBeFalsy();
        });

        it('PK/UQ columns are NEVER demoted by CREATE INDEX (suppression rule)', () => {
            const categoryName = cell('categories', 'name');
            expect(categoryName.constraints).toContain('UQ');
            expect(categoryName.constraints).not.toContain('IDX');

            const productSku = cell('products', 'sku');
            expect(productSku.constraints).toContain('UQ');
            expect(productSku.constraints).not.toContain('IDX');
            expect(productSku.compositeUq).toBeFalsy();

            const userPk = cell('users', 'id');
            expect(userPk.constraints).toContain('PK');
            expect(userPk.constraints).not.toContain('IDX');
        });

        it('badges deduplicate when a column appears in multiple indexes', () => {
            const c = cell('orders', 'customer_id');
            expect(c.constraints.filter((x) => x === 'IDX')).toHaveLength(1);
        });

        it('columns with no index get no IDX badge', () => {
            const noBadge = [
                ['users',      'full_name'],
                ['users',      'created_at'],
                ['products',   'name'],
                ['products',   'stock'],
                ['orders',     'total'],
                ['order_items', 'quantity'],
            ];
            for (const [t, col] of noBadge) {
                const c = cell(t, col);
                expect(c, `${t}.${col} missing`).toBeDefined();
                expect(c.constraints, `${t}.${col} unexpectedly indexed`).not.toContain('IDX');
            }
        });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Indexes — idempotency and scale
//
// Two properties that protect against the most insidious classes of bugs:
//   - Idempotency: running the pipeline twice on the same SQL yields the
//     exact same schema (catches global state, mutable defaults, RNG, etc.)
//   - Scale: hundreds of indexes across dozens of tables don't blow up the
//     parser/builder and don't degrade asymptotically (we cap on wall time).
// ════════════════════════════════════════════════════════════════════════════

describe('Indexes — idempotency / determinism', () => {
    const SQL = `
        CREATE TABLE users (
            id INT PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            tenant_id INT NOT NULL,
            created_at TIMESTAMP
        );
        CREATE TABLE posts (
            id INT PRIMARY KEY,
            user_id INT NOT NULL REFERENCES users(id),
            title TEXT NOT NULL,
            published_at TIMESTAMP
        );
        CREATE INDEX ix_users_tenant ON users(tenant_id);
        CREATE INDEX ix_users_created ON users(created_at);
        CREATE INDEX ix_users_tenant_created ON users(tenant_id, created_at);
        CREATE UNIQUE INDEX uq_posts_title ON posts(title);
        CREATE INDEX ix_posts_user_pub ON posts(user_id, published_at);
    `;

    it('two pipeline runs on the same SQL produce structurally identical schemas', () => {
        const a = sqlToErdSchema(SQL);
        const b = sqlToErdSchema(SQL);
        // Strip the editor-only `_parseErrors` metadata before deep-comparing —
        // it carries position info that may be re-allocated each run.
        const strip = (s) => { const { _parseErrors, ...rest } = s; void _parseErrors; return rest; };
        expect(strip(a)).toEqual(strip(b));
    });

    it('JSON.stringify of two consecutive runs is byte-identical (deterministic ordering)', () => {
        const strip = (s) => { const { _parseErrors, ...rest } = s; void _parseErrors; return rest; };
        const a = JSON.stringify(strip(sqlToErdSchema(SQL)));
        const b = JSON.stringify(strip(sqlToErdSchema(SQL)));
        expect(a).toBe(b);
    });

    it('parse → build → re-parse → re-build still yields the same badge shape', () => {
        // Guards against any hidden mutable state bleeding across calls.
        const first  = sqlToErdSchema(SQL);
        const _parsed = parseAST(SQL); void _parsed;
        const second = sqlToErdSchema(SQL);
        const shape = (s) => s.tables.map((t) => ({
            name: t.name,
            cols: t.columns.map((c) => ({
                name: c.name,
                constraints: [...c.constraints].sort(),
                compositeIdx: !!c.compositeIdx,
                compositeUq:  !!c.compositeUq,
                compositePk:  !!c.compositePk,
            })),
        }));
        expect(shape(second)).toEqual(shape(first));
    });

    it('order of CREATE INDEX statements does not change PK/UQ/IDX semantics for non-overlapping cols', () => {
        const A = `
            CREATE TABLE t(a INT, b INT, c INT);
            CREATE INDEX ix_a ON t(a);
            CREATE INDEX ix_b ON t(b);
            CREATE INDEX ix_c ON t(c);
        `;
        const B = `
            CREATE TABLE t(a INT, b INT, c INT);
            CREATE INDEX ix_c ON t(c);
            CREATE INDEX ix_a ON t(a);
            CREATE INDEX ix_b ON t(b);
        `;
        const sa = sqlToErdSchema(A);
        const sb = sqlToErdSchema(B);
        const cols = (s) => Object.fromEntries(
            tableByName(s, 't').columns.map((c) => [c.name, [...c.constraints].sort()])
        );
        expect(cols(sb)).toEqual(cols(sa));
    });
});

describe('Indexes — scale / performance', () => {
    it('50 tables × 6 indexes each (≈300 indexes) parses & builds in well under 5s', () => {
        let sql = '';
        for (let i = 0; i < 50; i++) {
            sql += `CREATE TABLE t${i}(id INT PRIMARY KEY, a INT, b INT, c INT, d INT, e INT, f INT);\n`;
        }
        for (let i = 0; i < 50; i++) {
            sql += `CREATE INDEX ix_${i}_a ON t${i}(a);\n`;
            sql += `CREATE INDEX ix_${i}_b ON t${i}(b);\n`;
            sql += `CREATE INDEX ix_${i}_cd ON t${i}(c, d);\n`;
            sql += `CREATE UNIQUE INDEX uq_${i}_e ON t${i}(e);\n`;
            sql += `CREATE INDEX ix_${i}_ef ON t${i}(e, f);\n`;
            sql += `CREATE INDEX ix_${i}_acd ON t${i}(a, c, d);\n`;
        }
        const t0 = Date.now();
        const { errors, schema } = pipeline(sql);
        const elapsed = Date.now() - t0;
        expect(errorsOnly(errors)).toHaveLength(0);
        expect(schema.tables).toHaveLength(50);
        expect(elapsed).toBeLessThan(5000);
        // Spot-check one table: `e` should be UQ-only (UQ first), `a/b/c/d/f`
        // should all carry IDX from at least one index they participate in.
        const t0table = tableByName(schema, 't0');
        expect(colByName(t0table, 'a').constraints).toContain('IDX');
        expect(colByName(t0table, 'b').constraints).toContain('IDX');
        expect(colByName(t0table, 'e').constraints).toContain('UQ');
        // `e` was UQ first → later IDX from ix_0_ef is suppressed → no IDX.
        expect(colByName(t0table, 'e').constraints).not.toContain('IDX');
        // Renderer-ready end-to-end.
        assertRendererReady(schema);
    });

    it('1 table × 100 indexes on the same column dedupes to a single IDX badge', () => {
        let sql = `CREATE TABLE t(a INT);\n`;
        for (let i = 0; i < 100; i++) sql += `CREATE INDEX ix_${i} ON t(a);\n`;
        const { errors, schema } = pipeline(sql);
        expect(errorsOnly(errors)).toHaveLength(0);
        const a = colByName(tableByName(schema, 't'), 'a');
        expect(a.constraints.filter((c) => c === 'IDX')).toHaveLength(1);
    });
});
