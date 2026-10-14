/** Verifies each supported dialect produces usable ERD output for representative syntax. */
import { describe, expect, it } from 'vitest';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

function table(schema, name) {
    return schema.tables.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
}

function column(schema, tableName, columnName) {
    return table(schema, tableName)?.columns.find((entry) => entry.name.toLowerCase() === columnName.toLowerCase());
}

function relation(schema, fromTable, fromColumn) {
    return schema.relations.find(
        (entry) =>
            entry.from.table.toLowerCase() === fromTable.toLowerCase() &&
            entry.from.column.toLowerCase() === fromColumn.toLowerCase(),
    );
}

function assertProductionReadySchema(schema) {
    expect(schema._parseErrors).toEqual([]);
    expect(schema.tables.length).toBeGreaterThan(0);

    const tableColumns = new Map(schema.tables.map((entry) => [entry.name, new Set(entry.columns.map((col) => col.name))]));
    for (const rel of schema.relations) {
        expect(tableColumns.get(rel.from.table)?.has(rel.from.column), `${rel.from.table}.${rel.from.column}`).toBe(true);
        expect(tableColumns.get(rel.to.table)?.has(rel.to.column), `${rel.to.table}.${rel.to.column}`).toBe(true);
        expect(['1', 'n', '0..1', '0..n']).toContain(rel.fromCard);
        expect(['1', '0..1']).toContain(rel.toCard);
    }
}

describe('sqlToErdSchema production readiness across PostgreSQL, MySQL, SQLite, and MSSQL', () => {
    it('accepts CREATE OR REPLACE table and type declarations in the ERD pipeline', () => {
        const schema = sqlToErdSchema(`
            CREATE OR REPLACE TYPE app.account_state AS ENUM ('active', 'archived');

            CREATE OR REPLACE TABLE app.accounts (
                id INT PRIMARY KEY,
                state app.account_state NOT NULL DEFAULT 'active'
            );

            CREATE OR REPLACE TEMP TABLE app.sessions (
                id INT PRIMARY KEY,
                account_id INT NOT NULL REFERENCES app.accounts(id)
            );
        `);

        assertProductionReadySchema(schema);
        expect(schema.enums).toEqual([{ name: 'account_state', values: ['active', 'archived'] }]);
        expect(schema.tables.map((entry) => entry.name).sort()).toEqual(['accounts', 'sessions']);
        expect(column(schema, 'accounts', 'state')).toMatchObject({
            type: 'account_state',
            constraints: ['NN'],
            extras: ["DEFAULT 'active'"],
        });
        expect(relation(schema, 'sessions', 'account_id')).toMatchObject({
            to: { table: 'accounts', column: 'id' },
        });
    });

    it('skips dialect-specific CREATE VIEW wrappers without losing ERD tables', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE accounts (
                id INT PRIMARY KEY,
                active BOOLEAN NOT NULL
            );

            CREATE OR REPLACE VIEW active_accounts AS
                SELECT id FROM accounts WHERE active = TRUE
                WITH LOCAL CHECK OPTION;

            CREATE MATERIALIZED VIEW account_counts AS
                SELECT active, COUNT(*) AS total FROM accounts GROUP BY active
                WITH NO DATA;

            CREATE OR REPLACE ALGORITHM = MERGE
                DEFINER = \`reporting_user\`@\`%\`
                SQL SECURITY INVOKER
                VIEW mysql_active_accounts AS
                SELECT id FROM accounts WHERE active = TRUE
                WITH CASCADED CHECK OPTION;

            CREATE OR ALTER VIEW dbo.ActiveAccounts
                WITH SCHEMABINDING
            AS
                SELECT id FROM accounts WHERE active = 1;

            CREATE TEMP VIEW IF NOT EXISTS sqlite_active_accounts AS
                SELECT id FROM accounts WHERE active = TRUE;

            DROP VIEW IF EXISTS sqlite_active_accounts;
            DROP MATERIALIZED VIEW IF EXISTS account_counts;

            CREATE TABLE sessions (
                id INT PRIMARY KEY,
                account_id INT NOT NULL REFERENCES accounts(id)
            );
        `);

        assertProductionReadySchema(schema);
        expect(schema.tables.map((entry) => entry.name).sort()).toEqual(['accounts', 'sessions']);
        expect(relation(schema, 'sessions', 'account_id')).toMatchObject({
            to: { table: 'accounts', column: 'id' },
        });
    });

    it('supports SQLite STRICT/WITHOUT ROWID, quoted identifiers, FK actions, and table/column renames', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE authors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE,
                "a,b" INTEGER NOT NULL,
                "c.d" INTEGER NOT NULL,
                UNIQUE ("a,b", "c.d")
            ) STRICT;

            CREATE TABLE posts (
                author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE ON UPDATE RESTRICT,
                post_id TEXT NOT NULL,
                "a,b" INTEGER NOT NULL,
                "c.d" INTEGER NOT NULL,
                PRIMARY KEY (author_id, post_id),
                CONSTRAINT fk_posts_author_code
                    FOREIGN KEY ("a,b", "c.d") REFERENCES authors("a,b", "c.d") ON UPDATE CASCADE
            ) STRICT, WITHOUT ROWID;

            ALTER TABLE posts ADD COLUMN summary TEXT;
            ALTER TABLE posts RENAME COLUMN summary TO excerpt;
            ALTER TABLE authors RENAME TO writers;
        `);

        assertProductionReadySchema(schema);
        expect(schema.tables.map((entry) => entry.name).sort()).toEqual(['posts', 'writers']);
        expect(column(schema, 'posts', 'excerpt')).toMatchObject({ name: 'excerpt', type: 'TEXT' });
        expect(column(schema, 'writers', 'a,b').constraints).toContain('UQ');
        expect(relation(schema, 'posts', 'author_id')).toMatchObject({
            to: { table: 'writers', column: 'id' },
            actions: { onDelete: 'CASCADE', onUpdate: 'RESTRICT' },
        });
        expect(relation(schema, 'posts', 'a,b')).toMatchObject({
            fkName: 'fk_posts_author_code',
            to: { table: 'writers', column: 'a,b' },
            actions: { onUpdate: 'CASCADE' },
            composite: true,
            fromColumns: ['a,b', 'c.d'],
            toColumns: ['a,b', 'c.d'],
        });
    });

    it('supports PostgreSQL schemas, CREATE TYPE, implicit composite-PK FK targets, FK actions, and ALTER replay', () => {
        const schema = sqlToErdSchema(`
            CREATE TYPE app.ticket_state AS ENUM ('new', 'done');

            CREATE TABLE app.accounts (
                tenant_id INT NOT NULL,
                account_no TEXT NOT NULL,
                state app.ticket_state NOT NULL DEFAULT 'new',
                PRIMARY KEY (tenant_id, account_no)
            );

            CREATE TABLE app.contacts (
                tenant_id INT NOT NULL,
                account_no TEXT NOT NULL,
                owner_email TEXT,
                FOREIGN KEY (tenant_id, account_no)
                    REFERENCES app.accounts
                    ON DELETE CASCADE
                    DEFERRABLE INITIALLY DEFERRED
            );

            ALTER TABLE app.contacts ALTER COLUMN owner_email TYPE VARCHAR(320);
            ALTER TABLE app.contacts ALTER COLUMN owner_email SET NOT NULL;
            ALTER TABLE app.contacts RENAME COLUMN owner_email TO contact_email;
            ALTER TABLE app.accounts RENAME TO customer_accounts;
        `);

        assertProductionReadySchema(schema);
        expect(schema.enums).toEqual([{ name: 'ticket_state', values: ['new', 'done'] }]);
        expect(column(schema, 'customer_accounts', 'state').type).toBe('ticket_state');
        expect(column(schema, 'contacts', 'contact_email')).toMatchObject({
            type: 'VARCHAR(320)',
            constraints: ['NN'],
        });
        expect(relation(schema, 'contacts', 'tenant_id')).toMatchObject({
            to: { table: 'customer_accounts', column: 'tenant_id' },
            actions: { onDelete: 'CASCADE', deferrable: true, initially: 'DEFERRED' },
            composite: true,
            toColumns: ['tenant_id', 'account_no'],
        });
    });

    it('supports MySQL backticks, inline ENUM, UNIQUE INDEX, FK actions, CHANGE COLUMN, and MODIFY COLUMN', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE \`customers\` (
                \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
                \`email\` VARCHAR(320) NOT NULL,
                UNIQUE INDEX \`ux_customers_email\` (\`email\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

            CREATE TABLE \`orders\` (
                \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
                \`customer_email\` VARCHAR(320),
                \`status\` ENUM('new','paid') NOT NULL DEFAULT 'new',
                CONSTRAINT \`fk_orders_customer\`
                    FOREIGN KEY (\`customer_email\`) REFERENCES \`customers\`(\`email\`) ON DELETE SET NULL
            ) ENGINE=InnoDB;

            ALTER TABLE \`orders\` ADD COLUMN \`old_note\` VARCHAR(50);
            ALTER TABLE \`orders\` CHANGE COLUMN \`old_note\` \`note\` VARCHAR(255) NOT NULL;
            ALTER TABLE \`orders\` MODIFY COLUMN \`status\` ENUM('new','paid') NOT NULL DEFAULT 'paid';
        `);

        assertProductionReadySchema(schema);
        expect(schema.enums).toEqual([{ name: 'status_enum', values: ['new', 'paid'] }]);
        expect(column(schema, 'customers', 'email').constraints).toContain('UQ');
        expect(column(schema, 'orders', 'note')).toMatchObject({
            type: 'VARCHAR(255)',
            constraints: ['NN'],
        });
        expect(column(schema, 'orders', 'status').extras).toEqual(["DEFAULT 'paid'"]);
        expect(relation(schema, 'orders', 'customer_email')).toMatchObject({
            fkName: 'fk_orders_customer',
            to: { table: 'customers', column: 'email' },
            actions: { onDelete: 'SET NULL' },
        });
    });

    it('supports MSSQL brackets, IDENTITY, clustered constraints, ALTER COLUMN, ADD COLUMN, indexes, and FK actions', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE [dbo].[Customers] (
                [CustomerID] INT IDENTITY(1,1) NOT NULL,
                [Email] NVARCHAR(320) NOT NULL,
                CONSTRAINT [PK_Customers] PRIMARY KEY CLUSTERED ([CustomerID]),
                CONSTRAINT [UQ_Customers_Email] UNIQUE NONCLUSTERED ([Email])
            );

            CREATE TABLE [dbo].[Orders] (
                [OrderID] INT IDENTITY(1,1) NOT NULL,
                [CustomerEmail] NVARCHAR(320),
                [LegacyNote] NVARCHAR(50),
                CONSTRAINT [PK_Orders] PRIMARY KEY NONCLUSTERED ([OrderID]),
                CONSTRAINT [FK_Orders_Customers]
                    FOREIGN KEY ([CustomerEmail]) REFERENCES [dbo].[Customers]([Email]) ON DELETE SET NULL
            );

            ALTER TABLE [dbo].[Orders] ALTER COLUMN [LegacyNote] NVARCHAR(255) NOT NULL;
            ALTER TABLE [dbo].[Orders] ADD [CreatedAt] DATETIME2 NOT NULL DEFAULT '2026-01-01';
            CREATE NONCLUSTERED INDEX [IX_Orders_CustomerEmail]
                ON [dbo].[Orders] ([CustomerEmail]);
        `);

        assertProductionReadySchema(schema);
        expect(column(schema, 'Customers', 'CustomerID')).toMatchObject({ pk: true, autoIncrement: true });
        expect(column(schema, 'Orders', 'LegacyNote')).toMatchObject({
            type: 'NVARCHAR(255)',
            constraints: ['NN'],
        });
        expect(column(schema, 'Orders', 'CreatedAt').extras).toContain("DEFAULT '2026-01-01'");
        expect(column(schema, 'Orders', 'CustomerEmail').constraints).toContain('IDX');
        expect(relation(schema, 'Orders', 'CustomerEmail')).toMatchObject({
            fkName: 'FK_Orders_Customers',
            to: { table: 'Customers', column: 'Email' },
            actions: { onDelete: 'SET NULL' },
        });
    });
});
