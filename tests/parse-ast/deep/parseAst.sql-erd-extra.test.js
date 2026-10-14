/** Protects parser metadata consumed specifically by SQL-to-ERD conversion. */
import { describe, expect, it } from 'vitest';
import { parseAST } from '@/lib/parse-ast/parseAst.js';

function compactAlters(alters) {
    return alters.map((alter) => ({
        action: alter.action,
        name: alter.name,
        table: alter.table,
        columns: alter.columns,
        references: alter.references,
        expression: alter.expression,
    }));
}

describe('parseAST SQL and ERD extra contracts', () => {
    it('collects ALTER-added primary, unique, check, and composite foreign constraints', () => {
        const parsed = parseAST(`
            CREATE TABLE tenant_accounts (
                tenant_id INT,
                account_code TEXT,
                name TEXT
            );
            CREATE TABLE tenant_contacts (
                tenant_id INT,
                account_code TEXT,
                contact_kind TEXT,
                email TEXT
            );
            ALTER TABLE tenant_accounts
                ADD CONSTRAINT pk_tenant_accounts PRIMARY KEY (tenant_id, account_code);
            ALTER TABLE tenant_contacts
                ADD CONSTRAINT fk_tenant_contacts_account
                FOREIGN KEY (tenant_id, account_code)
                REFERENCES tenant_accounts (tenant_id, account_code);
            ALTER TABLE tenant_contacts
                ADD CONSTRAINT uq_tenant_contacts_kind UNIQUE (tenant_id, contact_kind);
            ALTER TABLE tenant_contacts
                ADD CONSTRAINT chk_tenant_contacts_kind CHECK (contact_kind IN ('billing', 'technical'));
        `);

        expect(parsed.errors).toEqual([]);
        expect(compactAlters(parsed.ast.alters)).toEqual([
            {
                action: 'add_primary',
                name: 'pk_tenant_accounts',
                table: 'tenant_accounts',
                columns: ['tenant_id', 'account_code'],
                references: undefined,
                expression: undefined,
            },
            {
                action: 'add_foreign',
                name: 'fk_tenant_contacts_account',
                table: 'tenant_contacts',
                columns: ['tenant_id', 'account_code'],
                references: { table: 'tenant_accounts', columns: ['tenant_id', 'account_code'] },
                expression: undefined,
            },
            {
                action: 'add_unique',
                name: 'uq_tenant_contacts_kind',
                table: 'tenant_contacts',
                columns: ['tenant_id', 'contact_kind'],
                references: undefined,
                expression: undefined,
            },
            {
                action: 'add_check',
                name: 'chk_tenant_contacts_kind',
                table: 'tenant_contacts',
                columns: undefined,
                references: undefined,
                expression: "contact_kind IN ( 'billing' , 'technical' )",
            },
        ]);
        for (const alter of parsed.ast.alters) {
            expect(alter.position.start.line).toBeGreaterThan(0);
            expect(alter.position.end.line).toBeGreaterThan(0);
        }
    });

    it('parses PostgreSQL CREATE INDEX modifiers while preserving expression entries', () => {
        const parsed = parseAST(`
            CREATE TABLE "User Events" (
                "actor id" UUID NOT NULL,
                "payload" JSONB,
                "deleted at" TIMESTAMPTZ
            );
            CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "idx events actor"
                ON ONLY "User Events" USING btree
                ("actor id" ASC, (lower("payload")) DESC)
                INCLUDE ("deleted at")
                WHERE "deleted at" IS NULL;
        `);

        expect(parsed.errors.filter((error) => error.severity === 'error')).toEqual([]);
        expect(parsed.ast.indexes).toHaveLength(1);
        expect(parsed.ast.indexes[0]).toMatchObject({
            name: 'idx events actor',
            table: 'User Events',
            columns: ['actor id'],
            unique: true,
            kind: 'plain',
        });
        expect(parsed.ast.indexes[0].expressions).toEqual(['(lower("payload")) DESC']);
        expect(parsed.errors).toContainEqual(expect.objectContaining({ severity: 'warning' }));
    });

    it('treats KEY, INDEX, and VALUE as column names when followed by data types', () => {
        const parsed = parseAST(`
            CREATE TABLE metric_events (
                key INT NOT NULL,
                index TEXT,
                value JSON,
                PRIMARY KEY (key)
            );
        `);

        expect(parsed.errors).toEqual([]);
        expect(parsed.ast.tables[0].columns.map((column) => column.name)).toEqual(['key', 'index', 'value']);
        expect(parsed.ast.tables[0].constraints[0]).toMatchObject({
            kind: 'primary',
            columns: ['key'],
        });
    });

    it('recovers from malformed CREATE INDEX syntax and continues parsing later DDL', () => {
        const parsed = parseAST(`
            CREATE INDEX broken_idx recovered(id);
            CREATE TABLE recovered (id INT PRIMARY KEY, email TEXT);
            CREATE INDEX recovered_email_idx ON recovered (email);
        `);

        expect(parsed.errors).toEqual([
            expect.objectContaining({
                severity: 'warning',
                message: "Expected 'ON' in CREATE INDEX statement",
            }),
        ]);
        expect(parsed.ast.tables.map((table) => table.name)).toEqual(['recovered']);
        expect(parsed.ast.indexes).toHaveLength(1);
        expect(parsed.ast.indexes[0]).toMatchObject({
            name: 'recovered_email_idx',
            table: 'recovered',
            columns: ['email'],
        });
    });

    it('skips MSSQL GO batches and non-table CREATE statements without losing nearby tables', () => {
        const parsed = parseAST(`
            CREATE TABLE [dbo].[BeforeBatch] ([id] INT PRIMARY KEY);
            GO
            CREATE VIEW [dbo].[BeforeBatchView] AS SELECT [id] FROM [dbo].[BeforeBatch];
            GO
            CREATE TABLE [dbo].[AfterBatch] (
                [id] INT PRIMARY KEY,
                [before_id] INT REFERENCES [dbo].[BeforeBatch]([id])
            );
            GO
        `);

        expect(parsed.errors).toEqual([]);
        expect(parsed.ast.tables.map((table) => table.name)).toEqual(['dbo.BeforeBatch', 'dbo.AfterBatch']);
        expect(parsed.ast.tables[1].columns[1].references).toEqual({
            table: 'dbo.BeforeBatch',
            columns: ['id'],
        });
    });

    it('preserves composite type fields and enum values across schema-qualified types', () => {
        const parsed = parseAST(`
            CREATE TYPE app.address AS (
                street TEXT,
                city TEXT,
                postal_code TEXT
            );
            CREATE TYPE app.order_state AS ENUM ('draft', 'paid', 'void');
            CREATE TABLE app.orders (
                id BIGSERIAL PRIMARY KEY,
                ship_to app.address,
                state app.order_state NOT NULL DEFAULT 'draft'
            );
        `);

        expect(parsed.errors).toEqual([]);
        expect(parsed.ast.types).toEqual([
            {
                kind: 'composite',
                name: 'app.address',
                fields: [
                    { name: 'street', type: 'TEXT' },
                    { name: 'city', type: 'TEXT' },
                    { name: 'postal_code', type: 'TEXT' },
                ],
            },
            {
                kind: 'enum',
                name: 'app.order_state',
                values: ['draft', 'paid', 'void'],
            },
        ]);
        expect(parsed.ast.tables[0].columns.map((column) => [column.name, column.type])).toEqual([
            ['id', 'BIGSERIAL'],
            ['ship_to', 'app.address'],
            ['state', 'app.order_state'],
        ]);
    });
});
