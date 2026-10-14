import { describe, expect, it } from 'vitest';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

const DIALECTS = ['sqlite', 'postgres', 'mysql', 'mssql'];
const ALTER_RENAME_DIALECTS = ['sqlite', 'postgres', 'mysql'];

function table(schema, name) {
    return schema.tables.find((entry) => entry.name === name);
}

function column(schema, tableName, columnName) {
    return table(schema, tableName)?.columns.find((entry) => entry.name === columnName);
}

function dropIndexSql(dialect, indexName, tableName) {
    return dialect === 'mysql' || dialect === 'mssql'
        ? `DROP INDEX ${indexName} ON ${tableName};`
        : `DROP INDEX ${indexName};`;
}

describe('SQL-to-ERD critical DDL lifecycle replay', () => {
    it('replays canonical pg_dump ALTER TABLE ONLY keys and relationships', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE public.accounts (
                id BIGINT NOT NULL,
                email TEXT NOT NULL
            );
            CREATE TABLE public.orders (
                id BIGINT NOT NULL,
                account_id BIGINT NOT NULL
            );

            ALTER TABLE ONLY public.accounts
                ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);
            ALTER TABLE ONLY public.accounts
                ADD CONSTRAINT accounts_email_key UNIQUE (email);
            ALTER TABLE ONLY public.orders
                ADD CONSTRAINT orders_pkey PRIMARY KEY (id);
            ALTER TABLE ONLY public.orders
                ADD CONSTRAINT orders_account_fk
                FOREIGN KEY (account_id) REFERENCES public.accounts(id);
        `, { dialect: 'postgres' });

        expect(schema._parseErrors).toEqual([]);
        expect(column(schema, 'accounts', 'id')).toMatchObject({ pk: true });
        expect(column(schema, 'accounts', 'email').constraints).toContain('UQ');
        expect(column(schema, 'orders', 'id')).toMatchObject({ pk: true });
        expect(column(schema, 'orders', 'account_id')).toMatchObject({
            fk: true,
            constraints: ['NN'],
        });
        expect(schema.relations).toEqual([
            expect.objectContaining({
                from: { table: 'orders', column: 'account_id' },
                to: { table: 'accounts', column: 'id' },
                fkName: 'orders_account_fk',
                fromCard: '0..n',
                toCard: '1',
            }),
        ]);
    });

    it.each(DIALECTS)('%s does not leak pre-drop ALTER or CREATE INDEX state into a recreated table', (dialect) => {
        const schema = sqlToErdSchema(`
            CREATE TABLE inventory (
                id INT PRIMARY KEY,
                shared_value INT
            );
            ALTER TABLE inventory ADD COLUMN leaked_column TEXT;
            CREATE INDEX ix_inventory_shared ON inventory(shared_value);

            DROP TABLE inventory;

            CREATE TABLE inventory (
                id INT PRIMARY KEY,
                shared_value INT
            );
        `, { dialect });

        expect(schema._parseErrors.filter((entry) => entry.severity === 'error')).toEqual([]);
        expect(table(schema, 'inventory').columns.map((entry) => entry.name)).toEqual(['id', 'shared_value']);
        expect(column(schema, 'inventory', 'shared_value').constraints).not.toContain('IDX');
    });

    it.each(DIALECTS)('%s applies only operations that occur after the surviving CREATE TABLE', (dialect) => {
        const schema = sqlToErdSchema(`
            ALTER TABLE inventory ADD COLUMN impossible_early TEXT;
            CREATE TABLE inventory (id INT PRIMARY KEY, value INT);
            ALTER TABLE inventory ADD COLUMN valid_late TEXT;
            CREATE INDEX ix_inventory_value ON inventory(value);
        `, { dialect });

        expect(table(schema, 'inventory').columns.map((entry) => entry.name)).toEqual(['id', 'value', 'valid_late']);
        expect(column(schema, 'inventory', 'value').constraints).toContain('IDX');
    });

    it.each(DIALECTS)('%s removes a dropped top-level index from final ERD badges', (dialect) => {
        const schema = sqlToErdSchema(`
            CREATE TABLE inventory (id INT PRIMARY KEY, value INT);
            CREATE INDEX ix_inventory_value ON inventory(value);
            ${dropIndexSql(dialect, 'ix_inventory_value', 'inventory')}
        `, { dialect });

        expect(column(schema, 'inventory', 'value').constraints).not.toContain('IDX');
    });

    it('removes a PostgreSQL index dropped with CONCURRENTLY from final ERD badges', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE app.audit_log (id BIGINT PRIMARY KEY, code TEXT);
            CREATE INDEX app.ix_audit_code ON app.audit_log(code);
            DROP INDEX CONCURRENTLY IF EXISTS app.ix_audit_code;
        `, { dialect: 'postgres' });

        expect(schema._parseErrors).toEqual([]);
        expect(column(schema, 'audit_log', 'code').constraints).not.toContain('IDX');
    });

    it('keeps only the index incarnation created after the latest matching DROP INDEX', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE inventory (id INT PRIMARY KEY, value INT);
            CREATE INDEX ix_inventory_value ON inventory(value);
            DROP INDEX ix_inventory_value;
            CREATE UNIQUE INDEX ix_inventory_value ON inventory(value);
        `, { dialect: 'postgres' });

        expect(column(schema, 'inventory', 'value').constraints).toContain('UQ');
        expect(column(schema, 'inventory', 'value').constraints).not.toContain('IDX');
    });

    it('removes dropped PostgreSQL types and keeps only a later recreated incarnation', () => {
        const schema = sqlToErdSchema(`
            CREATE TYPE app.mood AS ENUM ('obsolete');
            DROP TYPE app.mood;
            CREATE TYPE app.mood AS ENUM ('active', 'archived');
            CREATE TYPE app.removed AS ENUM ('gone');
            DROP TYPE app.removed CASCADE;
            CREATE TABLE app.items (
                id BIGINT PRIMARY KEY,
                state app.mood NOT NULL
            );
        `, { dialect: 'postgres' });

        expect(schema.enums).toEqual([{ name: 'mood', values: ['active', 'archived'] }]);
        expect(column(schema, 'items', 'state')).toMatchObject({ type: 'mood', constraints: ['NN'] });
    });

    it('matches an unqualified PostgreSQL DROP against an explicit public-schema CREATE', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE public.inventory (id BIGINT PRIMARY KEY);
            DROP TABLE inventory;
        `, { dialect: 'postgres' });

        expect(schema.tables).toEqual([]);
    });

    it('keeps MySQL table-scoped indexes with the same name isolated', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE first_table (id INT PRIMARY KEY, value INT);
            CREATE TABLE second_table (id INT PRIMARY KEY, value INT);
            CREATE INDEX ix_value ON first_table(value);
            CREATE INDEX ix_value ON second_table(value);
            DROP INDEX ix_value ON first_table;
        `, { dialect: 'mysql' });

        expect(column(schema, 'first_table', 'value').constraints).not.toContain('IDX');
        expect(column(schema, 'second_table', 'value').constraints).toContain('IDX');
    });

    it('keeps PostgreSQL schema-scoped indexes with the same leaf name isolated', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE app_a.items (id BIGINT PRIMARY KEY, value INT);
            CREATE TABLE app_b.items (id BIGINT PRIMARY KEY, value INT);
            CREATE INDEX ix_value ON app_a.items(value);
            CREATE INDEX ix_value ON app_b.items(value);
            DROP INDEX app_a.ix_value;
        `, { dialect: 'postgres' });

        expect(column(schema, 'app_a.items', 'value').constraints).not.toContain('IDX');
        expect(column(schema, 'app_b.items', 'value').constraints).toContain('IDX');
    });

    it('renames and drops an index through PostgreSQL implicit table-schema identity', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE app.events (id BIGINT PRIMARY KEY, occurred_at TIMESTAMPTZ);
            CREATE INDEX ix_events_old ON app.events(occurred_at);
            ALTER INDEX app.ix_events_old RENAME TO ix_events_current;
            DROP INDEX app.ix_events_current;
        `, { dialect: 'postgres' });

        expect(column(schema, 'events', 'occurred_at').constraints).not.toContain('IDX');
    });

    it('does not remove unrelated unnamed inline indexes when a named index is dropped', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE inventory (
                id INT PRIMARY KEY,
                retained_value INT,
                dropped_value INT,
                INDEX (retained_value),
                INDEX ix_dropped (dropped_value)
            );
            DROP INDEX ix_dropped ON inventory;
        `, { dialect: 'mysql' });

        expect(column(schema, 'inventory', 'retained_value').constraints).toContain('IDX');
        expect(column(schema, 'inventory', 'dropped_value').constraints).not.toContain('IDX');
    });

    it('removes a dropped unique-index guarantee before validating foreign-key targets', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (id BIGINT PRIMARY KEY, external_id TEXT NOT NULL);
            CREATE UNIQUE INDEX ux_parent_external_id ON parent(external_id);
            DROP INDEX ux_parent_external_id;
            CREATE TABLE child (
                id BIGINT PRIMARY KEY,
                parent_external_id TEXT REFERENCES parent(external_id)
            );
        `, { dialect: 'postgres' });

        expect(schema.relations).toEqual([]);
        expect(column(schema, 'child', 'parent_external_id').fk).toBeUndefined();
        expect(schema._parseErrors).toContainEqual(expect.objectContaining({
            kind: 'relation_dropped_non_unique_target',
        }));
    });

    it('does not leak a pre-drop foreign key into a recreated child table', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (id BIGINT PRIMARY KEY);
            CREATE TABLE child (id BIGINT PRIMARY KEY, parent_id BIGINT);
            ALTER TABLE child ADD CONSTRAINT fk_old FOREIGN KEY (parent_id) REFERENCES parent(id);
            DROP TABLE child;
            CREATE TABLE child (id BIGINT PRIMARY KEY, parent_id BIGINT);
        `, { dialect: 'postgres' });

        expect(schema.relations).toEqual([]);
        expect(column(schema, 'child', 'parent_id').fk).toBeUndefined();
    });

    it('drops only the matching schema-qualified PostgreSQL type', () => {
        const schema = sqlToErdSchema(`
            CREATE TYPE app_a.state AS ENUM ('a');
            CREATE TYPE app_b.state AS ENUM ('b');
            DROP TYPE app_a.state;
            CREATE TABLE app_b.items (id BIGINT PRIMARY KEY, state app_b.state);
        `, { dialect: 'postgres' });

        expect(schema.enums).toEqual([{ name: 'state', values: ['b'] }]);
        expect(column(schema, 'items', 'state').type).toBe('state');
    });

    it('removes a MySQL inline UNIQUE INDEX by name and invalidates dependent FKs', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (
                id BIGINT PRIMARY KEY,
                external_id VARCHAR(64),
                UNIQUE INDEX ux_parent_external_id (external_id)
            );
            DROP INDEX ux_parent_external_id ON parent;
            CREATE TABLE child (
                id BIGINT PRIMARY KEY,
                parent_external_id VARCHAR(64) REFERENCES parent(external_id)
            );
        `, { dialect: 'mysql' });

        expect(column(schema, 'parent', 'external_id').constraints).not.toContain('UQ');
        expect(schema.relations).toEqual([]);
        expect(schema._parseErrors).toContainEqual(expect.objectContaining({
            kind: 'relation_dropped_non_unique_target',
        }));
    });

    it('replays MySQL ALTER ADD/DROP UNIQUE INDEX as final constraint state', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (id BIGINT PRIMARY KEY, external_id VARCHAR(64));
            ALTER TABLE parent ADD UNIQUE INDEX ux_parent_external_id (external_id);
            ALTER TABLE parent DROP INDEX ux_parent_external_id;
        `, { dialect: 'mysql' });

        expect(column(schema, 'parent', 'external_id').constraints).not.toContain('UQ');
    });

    it('replays MySQL ALTER ADD/DROP non-unique INDEX without leaving an IDX badge', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE events (id BIGINT PRIMARY KEY, occurred_at DATETIME);
            ALTER TABLE events ADD INDEX ix_events_occurred_at (occurred_at);
            ALTER TABLE events DROP INDEX ix_events_occurred_at;
        `, { dialect: 'mysql' });

        expect(column(schema, 'events', 'occurred_at').constraints).not.toContain('IDX');
    });

    it('does not let an earlier DROP INDEX remove an index added later', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE events (id BIGINT PRIMARY KEY, occurred_at TIMESTAMP);
            DROP INDEX IF EXISTS ix_events_occurred_at;
            CREATE INDEX ix_events_occurred_at ON events(occurred_at);
        `, { dialect: 'postgres' });

        expect(column(schema, 'events', 'occurred_at').constraints).toContain('IDX');
    });

    it.each(ALTER_RENAME_DIALECTS)('%s resolves DROP TABLE against the current name after ALTER TABLE RENAME', (dialect) => {
        const schema = sqlToErdSchema(`
            CREATE TABLE inventory (id INT PRIMARY KEY);
            ALTER TABLE inventory RENAME TO archived_inventory;
            DROP TABLE archived_inventory;
        `, { dialect });

        expect(schema.tables).toEqual([]);
    });

    it.each(ALTER_RENAME_DIALECTS)('%s keeps a post-drop recreation isolated from the renamed incarnation', (dialect) => {
        const schema = sqlToErdSchema(`
            CREATE TABLE inventory (id INT PRIMARY KEY, obsolete_value TEXT);
            ALTER TABLE inventory RENAME TO archived_inventory;
            CREATE INDEX ix_archived_obsolete ON archived_inventory(obsolete_value);
            DROP TABLE archived_inventory;
            CREATE TABLE archived_inventory (id INT PRIMARY KEY, current_value TEXT);
        `, { dialect });

        expect(schema.tables.map((entry) => entry.name)).toEqual(['archived_inventory']);
        expect(table(schema, 'archived_inventory').columns.map((entry) => entry.name)).toEqual(['id', 'current_value']);
        expect(column(schema, 'archived_inventory', 'current_value').constraints).not.toContain('IDX');
    });

    it('preserves a PostgreSQL namespace while resolving rename then qualified drop', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE app.inventory (id BIGINT PRIMARY KEY);
            ALTER TABLE app.inventory RENAME TO archived_inventory;
            DROP TABLE app.archived_inventory;
        `, { dialect: 'postgres' });

        expect(schema.tables).toEqual([]);
    });

    it.each(ALTER_RENAME_DIALECTS)('%s keeps both live incarnations when a renamed name is reused', (dialect) => {
        const schema = sqlToErdSchema(`
            CREATE TABLE inventory (id INT PRIMARY KEY, archived_value TEXT);
            ALTER TABLE inventory RENAME TO archived_inventory;
            CREATE TABLE inventory (id INT PRIMARY KEY, current_value TEXT);
        `, { dialect });

        expect(schema.tables.map((entry) => entry.name).sort()).toEqual(['archived_inventory', 'inventory']);
        expect(table(schema, 'archived_inventory').columns.map((entry) => entry.name)).toEqual(['id', 'archived_value']);
        expect(table(schema, 'inventory').columns.map((entry) => entry.name)).toEqual(['id', 'current_value']);
    });

    it.each(ALTER_RENAME_DIALECTS)('%s applies later operations to the correct reused-name incarnation', (dialect) => {
        const schema = sqlToErdSchema(`
            CREATE TABLE inventory (id INT PRIMARY KEY, archived_value INT);
            ALTER TABLE inventory ADD COLUMN archived_note TEXT;
            ALTER TABLE inventory RENAME TO archived_inventory;
            CREATE INDEX ix_archived_value ON archived_inventory(archived_value);

            CREATE TABLE inventory (id INT PRIMARY KEY, current_value INT);
            ALTER TABLE inventory ADD COLUMN current_note TEXT;
            CREATE INDEX ix_current_value ON inventory(current_value);
        `, { dialect });

        expect(table(schema, 'archived_inventory').columns.map((entry) => entry.name)).toEqual(['id', 'archived_value', 'archived_note']);
        expect(column(schema, 'archived_inventory', 'archived_value').constraints).toContain('IDX');
        expect(table(schema, 'inventory').columns.map((entry) => entry.name)).toEqual(['id', 'current_value', 'current_note']);
        expect(column(schema, 'inventory', 'current_value').constraints).toContain('IDX');
    });

    it.each(ALTER_RENAME_DIALECTS)('%s drops only the reused current name and retains the renamed table', (dialect) => {
        const schema = sqlToErdSchema(`
            CREATE TABLE inventory (id INT PRIMARY KEY, archived_value TEXT);
            ALTER TABLE inventory RENAME TO archived_inventory;
            CREATE TABLE inventory (id INT PRIMARY KEY, current_value TEXT);
            DROP TABLE inventory;
        `, { dialect });

        expect(schema.tables.map((entry) => entry.name)).toEqual(['archived_inventory']);
        expect(table(schema, 'archived_inventory').columns.map((entry) => entry.name)).toEqual(['id', 'archived_value']);
    });

    it('removes incoming PostgreSQL FKs when DROP TABLE CASCADE removes their constraint', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (id BIGINT PRIMARY KEY);
            CREATE TABLE child (id BIGINT PRIMARY KEY, parent_id BIGINT REFERENCES parent(id));
            DROP TABLE parent CASCADE;
            CREATE TABLE parent (id BIGINT PRIMARY KEY);
        `, { dialect: 'postgres' });

        expect(schema.relations).toEqual([]);
        expect(column(schema, 'child', 'parent_id').fk).toBeUndefined();
    });

    it('retains SQLite FK declarations when a referenced table is dropped and recreated', () => {
        const schema = sqlToErdSchema(`
            PRAGMA foreign_keys = OFF;
            CREATE TABLE parent (id INTEGER PRIMARY KEY);
            CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
            DROP TABLE parent;
            CREATE TABLE parent (id INTEGER PRIMARY KEY);
        `, { dialect: 'sqlite' });

        expect(schema.relations).toHaveLength(1);
        expect(schema.relations[0]).toMatchObject({
            from: { table: 'child', column: 'parent_id' },
            to: { table: 'parent', column: 'id' },
        });
    });

    it('resolves a SQLite forward FK through a later target-table rename', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
            CREATE TABLE parent (id INTEGER PRIMARY KEY);
            ALTER TABLE parent RENAME TO account;
        `, { dialect: 'sqlite' });

        expect(schema.relations).toHaveLength(1);
        expect(schema.relations[0]).toMatchObject({
            from: { table: 'child', column: 'parent_id' },
            to: { table: 'account', column: 'id' },
        });
    });

    it('replays MySQL RENAME INDEX then DROP INDEX without renaming the table', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE events (id BIGINT PRIMARY KEY, occurred_at DATETIME);
            CREATE INDEX ix_events_old ON events(occurred_at);
            ALTER TABLE events RENAME INDEX ix_events_old TO ix_events_current;
            ALTER TABLE events DROP INDEX ix_events_current;
        `, { dialect: 'mysql' });

        expect(schema.tables.map((entry) => entry.name)).toEqual(['events']);
        expect(column(schema, 'events', 'occurred_at').constraints).not.toContain('IDX');
    });

    it('replays MySQL unique-index rename/drop before validating FK targets', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (id BIGINT PRIMARY KEY, external_id VARCHAR(64));
            CREATE UNIQUE INDEX ux_parent_old ON parent(external_id);
            ALTER TABLE parent RENAME INDEX ux_parent_old TO ux_parent_current;
            ALTER TABLE parent DROP INDEX ux_parent_current;
            CREATE TABLE child (parent_external_id VARCHAR(64) REFERENCES parent(external_id));
        `, { dialect: 'mysql' });

        expect(column(schema, 'parent', 'external_id').constraints).not.toContain('UQ');
        expect(schema.relations).toEqual([]);
        expect(column(schema, 'child', 'parent_external_id').fk).toBeUndefined();
        expect(schema._parseErrors).toContainEqual(expect.objectContaining({ kind: 'relation_dropped_non_unique_target' }));
    });

    it('replays PostgreSQL RENAME CONSTRAINT before a later DROP CONSTRAINT', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (
                id BIGINT PRIMARY KEY,
                external_id TEXT,
                CONSTRAINT "UQ_Old" UNIQUE (external_id)
            );
            ALTER TABLE parent RENAME CONSTRAINT "UQ_Old" TO "UQ_Current";
            ALTER TABLE parent DROP CONSTRAINT "UQ_Current";
            CREATE TABLE child (parent_external_id TEXT REFERENCES parent(external_id));
        `, { dialect: 'postgres' });

        expect(column(schema, 'parent', 'external_id').constraints).not.toContain('UQ');
        expect(schema.relations).toEqual([]);
    });

    it('replays PostgreSQL ALTER INDEX RENAME before DROP INDEX', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE events (id BIGINT PRIMARY KEY, occurred_at TIMESTAMPTZ);
            CREATE INDEX ix_events_old ON events(occurred_at);
            ALTER INDEX ix_events_old RENAME TO ix_events_current;
            DROP INDEX ix_events_current;
        `, { dialect: 'postgres' });

        expect(column(schema, 'events', 'occurred_at').constraints).not.toContain('IDX');
    });

    it('does not let a PostgreSQL DROP of an obsolete index name remove its renamed incarnation', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE events (id BIGINT PRIMARY KEY, occurred_at TIMESTAMPTZ);
            CREATE INDEX ix_events_old ON events(occurred_at);
            ALTER INDEX ix_events_old RENAME TO ix_events_current;
            DROP INDEX ix_events_old;
        `, { dialect: 'postgres' });

        expect(column(schema, 'events', 'occurred_at').constraints).toContain('IDX');
    });

    it('does not let a MySQL DROP of an obsolete index name remove its renamed incarnation', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE events (id BIGINT PRIMARY KEY, occurred_at DATETIME);
            CREATE INDEX ix_events_old ON events(occurred_at);
            ALTER TABLE events RENAME INDEX ix_events_old TO ix_events_current;
            ALTER TABLE events DROP INDEX ix_events_old;
        `, { dialect: 'mysql' });

        expect(column(schema, 'events', 'occurred_at').constraints).toContain('IDX');
    });

    it('does not let a SQL Server DROP of an obsolete index name remove its renamed incarnation', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE [dbo].[events] ([id] BIGINT PRIMARY KEY, [occurred_at] DATETIME2);
            CREATE INDEX [ix_events_old] ON [dbo].[events]([occurred_at]);
            EXEC sp_rename N'dbo.events.ix_events_old', N'ix_events_current', 'INDEX';
            DROP INDEX [ix_events_old] ON [dbo].[events];
        `, { dialect: 'mssql' });

        expect(column(schema, 'events', 'occurred_at').constraints).toContain('IDX');
    });

    it('retains a unique guarantee when only one of two equivalent named indexes is dropped', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (id BIGINT PRIMARY KEY, external_id TEXT NOT NULL);
            CREATE UNIQUE INDEX ux_parent_external_a ON parent(external_id);
            CREATE UNIQUE INDEX ux_parent_external_b ON parent(external_id);
            DROP INDEX ux_parent_external_a;
            CREATE TABLE child (parent_external_id TEXT REFERENCES parent(external_id));
        `, { dialect: 'postgres' });

        expect(column(schema, 'parent', 'external_id').constraints).toContain('UQ');
        expect(schema.relations).toHaveLength(1);
    });

    it('retains partial-unique metadata when only one equivalent named index is dropped', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE users (id BIGINT PRIMARY KEY, email TEXT, deleted_at TIMESTAMPTZ);
            CREATE UNIQUE INDEX ux_users_email_a ON users(email) WHERE deleted_at IS NULL;
            CREATE UNIQUE INDEX ux_users_email_b ON users(email) WHERE deleted_at IS NULL;
            DROP INDEX ux_users_email_a;
        `, { dialect: 'postgres' });

        expect(column(schema, 'users', 'email').constraints).toContain('PUQ');
        expect(column(schema, 'users', 'email').extras).toContain('PARTIAL UNIQUE INDEX ux_users_email_b WHERE deleted_at IS NULL');
        expect(column(schema, 'users', 'email').extras).not.toContain('PARTIAL UNIQUE INDEX ux_users_email_a WHERE deleted_at IS NULL');
    });

    it('replays multi-table MySQL RENAME TABLE with later DDL bound to each new identity', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE first_old (id BIGINT PRIMARY KEY, first_value INT);
            CREATE TABLE second_old (id BIGINT PRIMARY KEY, second_value INT);
            RENAME TABLE first_old TO first_current, second_old TO second_current;
            ALTER TABLE first_current ADD COLUMN note TEXT;
            DROP TABLE second_current;
        `, { dialect: 'mysql' });

        expect(schema.tables.map((entry) => entry.name)).toEqual(['first_current']);
        expect(table(schema, 'first_current').columns.map((entry) => entry.name)).toEqual(['id', 'first_value', 'note']);
    });

    it('replays SQL Server sp_rename for columns, indexes, and tables', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE [dbo].[Users] (
                [Id] BIGINT PRIMARY KEY,
                [Legacy] NVARCHAR(120)
            );
            CREATE INDEX [ix_old] ON [dbo].[Users]([Legacy]);
            EXEC sp_rename N'dbo.Users.Legacy', N'Current', 'COLUMN';
            EXEC sp_rename N'dbo.Users.ix_old', N'ix_current', 'INDEX';
            EXEC sys.sp_rename @objname = N'dbo.Users', @newname = N'Accounts';
            DROP INDEX [ix_current] ON [dbo].[Accounts];
        `, { dialect: 'mssql' });

        expect(schema.tables.map((entry) => entry.name)).toEqual(['Accounts']);
        expect(table(schema, 'Accounts').columns.map((entry) => entry.name)).toEqual(['Id', 'Current']);
        expect(column(schema, 'Accounts', 'Current').constraints).not.toContain('IDX');
    });
});
