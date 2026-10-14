/** Exercises deep cross-statement and renderer-facing SQL-to-ERD contracts. */
import { describe, expect, it } from 'vitest';
import { parseAST } from '@/lib/parse-ast/parseAst.js';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

const cases = [
    {
        name: 'PostgreSQL quoted schema with composite natural key relation',
        sql: `
            CREATE TYPE "crm"."lead_state" AS ENUM ('new', 'qualified', 'lost');
            CREATE TABLE "crm"."accounts" (
                "tenant id" UUID NOT NULL,
                "account no" TEXT NOT NULL,
                "state" "crm"."lead_state" NOT NULL DEFAULT 'new',
                PRIMARY KEY ("tenant id", "account no")
            );
            CREATE TABLE "crm"."contacts" (
                "tenant id" UUID NOT NULL,
                "account no" TEXT NOT NULL,
                "email" TEXT NOT NULL,
                CONSTRAINT "fk contacts account"
                    FOREIGN KEY ("tenant id", "account no")
                    REFERENCES "crm"."accounts" ("tenant id", "account no")
            );
            CREATE INDEX "contacts email idx" ON "crm"."contacts" ("email");
        `,
        tables: ['accounts', 'contacts'],
        relations: [
            'fk contacts account:contacts.tenant id->accounts.tenant id',
            'fk contacts account:contacts.account no->accounts.account no',
        ],
    },
    {
        name: 'MySQL dump with inline enum set and generated index column',
        sql: `
            CREATE TABLE \`teams\` (
                \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                \`name\` VARCHAR(120) NOT NULL,
                \`status\` ENUM('trial','active','paused') NOT NULL DEFAULT 'trial',
                \`features\` SET('chat','files','billing') DEFAULT 'chat',
                PRIMARY KEY (\`id\`),
                UNIQUE KEY \`uk_teams_name\` (\`name\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            CREATE TABLE \`team_members\` (
                \`team_id\` BIGINT UNSIGNED NOT NULL,
                \`user_id\` BIGINT UNSIGNED NOT NULL,
                \`email_key\` VARCHAR(320) GENERATED ALWAYS AS (lower(\`user_id\`)) VIRTUAL,
                PRIMARY KEY (\`team_id\`, \`user_id\`),
                CONSTRAINT \`fk_team_members_team\`
                    FOREIGN KEY (\`team_id\`) REFERENCES \`teams\`(\`id\`)
            ) ENGINE=InnoDB;
            CREATE INDEX \`idx_team_members_email_key\` ON \`team_members\` (\`email_key\`);
        `,
        tables: ['teams', 'team_members'],
        relations: ['fk_team_members_team:team_members.team_id->teams.id'],
    },
    {
        name: 'SQL Server computed persisted column and filtered index',
        sql: `
            CREATE TABLE [sales].[Customers] (
                [CustomerID] INT IDENTITY(1,1) NOT NULL,
                [Email] NVARCHAR(320) NOT NULL,
                [EmailKey] AS (LOWER([Email])) PERSISTED,
                CONSTRAINT [PK_Customers] PRIMARY KEY ([CustomerID]),
                CONSTRAINT [UQ_Customers_Email] UNIQUE ([Email])
            );
            CREATE TABLE [sales].[Invoices] (
                [InvoiceID] BIGINT IDENTITY(1,1) NOT NULL,
                [CustomerID] INT NOT NULL,
                [Gross] DECIMAL(18,2) NOT NULL,
                [Discount] DECIMAL(18,2) NOT NULL DEFAULT ((0)),
                [Net] AS ([Gross] - [Discount]) PERSISTED,
                CONSTRAINT [PK_Invoices] PRIMARY KEY ([InvoiceID])
            );
            ALTER TABLE [sales].[Invoices]
                ADD CONSTRAINT [FK_Invoices_Customers]
                FOREIGN KEY ([CustomerID]) REFERENCES [sales].[Customers] ([CustomerID]);
            CREATE NONCLUSTERED INDEX [IX_Invoices_Customer_Net]
                ON [sales].[Invoices] ([CustomerID], [Net])
                WHERE [Net] > 0;
        `,
        tables: ['Customers', 'Invoices'],
        relations: ['FK_Invoices_Customers:Invoices.CustomerID->Customers.CustomerID'],
    },
    {
        name: 'SQLite strict table with composite join table',
        sql: `
            CREATE TABLE IF NOT EXISTS "documents" (
                "id" TEXT NOT NULL PRIMARY KEY,
                "title" TEXT NOT NULL,
                "version_no" INTEGER NOT NULL DEFAULT 1
            ) STRICT;
            CREATE TABLE IF NOT EXISTS "labels" (
                "slug" TEXT NOT NULL PRIMARY KEY,
                "name" TEXT NOT NULL UNIQUE
            ) STRICT;
            CREATE TABLE IF NOT EXISTS "document_labels" (
                "document_id" TEXT NOT NULL,
                "label_slug" TEXT NOT NULL,
                PRIMARY KEY ("document_id", "label_slug"),
                FOREIGN KEY ("document_id") REFERENCES "documents"("id"),
                FOREIGN KEY ("label_slug") REFERENCES "labels"("slug")
            ) WITHOUT ROWID;
        `,
        tables: ['documents', 'labels', 'document_labels'],
        relations: [
            'document_labels.document_id->documents.id',
            'document_labels.label_slug->labels.slug',
        ],
    },
    {
        name: 'PostgreSQL alter adds unique and foreign after table definitions',
        sql: `
            CREATE TABLE public.regions (
                code TEXT NOT NULL,
                name TEXT NOT NULL
            );
            CREATE TABLE public.offices (
                id BIGINT GENERATED BY DEFAULT AS IDENTITY,
                region_code TEXT NOT NULL,
                office_code TEXT NOT NULL
            );
            ALTER TABLE public.regions ADD CONSTRAINT regions_pkey PRIMARY KEY (code);
            ALTER TABLE public.offices ADD CONSTRAINT offices_pkey PRIMARY KEY (id);
            ALTER TABLE public.offices ADD CONSTRAINT offices_region_code_key UNIQUE (region_code, office_code);
            ALTER TABLE public.offices ADD CONSTRAINT offices_region_fk
                FOREIGN KEY (region_code) REFERENCES public.regions(code);
        `,
        tables: ['regions', 'offices'],
        relations: ['offices_region_fk:offices.region_code->regions.code'],
    },
    {
        name: 'Mixed ignored DDL keeps ERD focused on tables and indexes',
        sql: `
            CREATE SCHEMA ignored;
            CREATE VIEW ignored.v AS SELECT 1;
            CREATE TABLE core_users (
                id INT PRIMARY KEY,
                manager_id INT REFERENCES core_users(id),
                email TEXT NOT NULL UNIQUE
            );
            CREATE POLICY ignored_policy ON core_users FOR SELECT USING (true);
            CREATE INDEX idx_core_users_manager ON core_users (manager_id);
        `,
        tables: ['core_users'],
        relations: ['core_users.manager_id->core_users.id'],
    },
];

function relationKeys(schema) {
    return schema.relations.map((relation) => {
        const prefix = relation.fkName ? `${relation.fkName}:` : '';
        return `${prefix}${relation.from.table}.${relation.from.column}->${relation.to.table}.${relation.to.column}`;
    });
}

function assertRelationEndpoints(schema) {
    const tables = new Map(schema.tables.map((table) => [table.name, new Set(table.columns.map((column) => column.name))]));
    for (const relation of schema.relations) {
        expect(tables.get(relation.from.table)?.has(relation.from.column), `${relation.from.table}.${relation.from.column}`).toBe(true);
        expect(tables.get(relation.to.table)?.has(relation.to.column), `${relation.to.table}.${relation.to.column}`).toBe(true);
        expect(['1', '0..1']).toContain(relation.toCard);
    }
}

describe('SQL-to-ERD deep contracts', () => {
    it.each(cases)('keeps $name renderable and relation-complete', ({ sql, tables, relations }) => {
        const parsed = parseAST(sql);
        const schema = sqlToErdSchema(sql);

        expect(parsed.errors).toEqual([]);
        expect(schema._parseErrors).toEqual([]);
        expect(schema.tables.map((table) => table.name)).toEqual(tables);
        expect(relationKeys(schema)).toEqual(relations);
        assertRelationEndpoints(schema);
        expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    });

    it('keeps FK source badges after composite and self-referencing relations', () => {
        const schema = sqlToErdSchema(cases.at(-1).sql);
        const manager = schema.tables[0].columns.find((column) => column.name === 'manager_id');

        expect(manager.fk).toBe(true);
        expect(manager.constraints).toContain('IDX');
    });
});
