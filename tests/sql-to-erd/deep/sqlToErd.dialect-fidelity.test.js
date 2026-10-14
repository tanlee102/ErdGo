import { describe, expect, it } from 'vitest';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

const table = (schema, name) => schema.tables.find((entry) => entry.name === name);
const column = (schema, tableName, columnName) => table(schema, tableName)?.columns.find((entry) => entry.name === columnName);

describe('sqlToErdSchema dialect fidelity', () => {
    it('replays DROP/CREATE lifecycle and MySQL physical column placement', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE inventory (obsolete INT);
            DROP TABLE inventory;
            CREATE TABLE inventory (sku VARCHAR(40), legacy INT);
            ALTER TABLE inventory ADD COLUMN tenant_id BIGINT FIRST;
            ALTER TABLE inventory MODIFY COLUMN sku VARCHAR(80) AFTER tenant_id;
            ALTER TABLE inventory CHANGE COLUMN legacy quantity INT AFTER sku;
        `, { dialect: 'mysql' });

        expect(schema._parseErrors.filter((error) => error.severity === 'error')).toEqual([]);
        expect(schema.tables).toHaveLength(1);
        expect(table(schema, 'inventory').columns.map((entry) => [entry.name, entry.type])).toEqual([
            ['tenant_id', 'BIGINT'],
            ['sku', 'VARCHAR(80)'],
            ['quantity', 'INT'],
        ]);
    });

    it('keeps SQL Server temporal/default semantics visible without inventing columns', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE [audit].[orders] (
                [id] BIGINT NOT NULL,
                [valid_from] DATETIME2 GENERATED ALWAYS AS ROW START HIDDEN,
                [valid_to] DATETIME2 GENERATED ALWAYS AS ROW END,
                PERIOD FOR SYSTEM_TIME ([valid_from], [valid_to]),
                CONSTRAINT [DF_orders_id] DEFAULT ((0)) FOR [id],
                CONSTRAINT [PK_orders] PRIMARY KEY CLUSTERED ([id])
            ) WITH (SYSTEM_VERSIONING = ON);
        `, { dialect: 'mssql' });

        expect(table(schema, 'orders').columns.map((entry) => entry.name)).toEqual(['id', 'valid_from', 'valid_to']);
        expect(column(schema, 'orders', 'id').extras).toContain('DEFAULT ((0))');
        expect(column(schema, 'orders', 'valid_from').extras).toEqual(expect.arrayContaining([
            'GENERATED ALWAYS AS ROW START HIDDEN',
            'PERIOD FOR SYSTEM_TIME START',
        ]));
        expect(column(schema, 'orders', 'valid_to').extras).toEqual(expect.arrayContaining([
            'GENERATED ALWAYS AS ROW END',
            'PERIOD FOR SYSTEM_TIME END',
        ]));
    });

    it('uses PostgreSQL quoted identifier identity and default public schema correctly', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE "Parent" (id BIGINT PRIMARY KEY);
            CREATE TABLE child (
                wrong_parent BIGINT REFERENCES "parent"(id),
                right_parent BIGINT NOT NULL REFERENCES "Parent"(id)
            );
        `, { dialect: 'postgres' });

        expect(schema.relations).toHaveLength(1);
        expect(schema.relations[0]).toMatchObject({
            from: { table: 'child', column: 'right_parent' },
            to: { table: 'Parent', column: 'id' },
            fromCard: '0..n',
            toCard: '1',
        });
        expect(schema._parseErrors).toContainEqual(expect.objectContaining({
            kind: 'relation_dropped_unknown_table',
            message: expect.stringContaining("'parent'"),
        }));
    });

    it('separates child multiplicity from nullable-FK participation', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (id BIGINT PRIMARY KEY);
            CREATE TABLE nullable_many (parent_id BIGINT REFERENCES parent(id));
            CREATE TABLE required_many (parent_id BIGINT NOT NULL REFERENCES parent(id));
            CREATE TABLE nullable_one (parent_id BIGINT UNIQUE REFERENCES parent(id));
            CREATE TABLE required_one (parent_id BIGINT UNIQUE NOT NULL REFERENCES parent(id));
        `, { dialect: 'postgres' });

        const cards = Object.fromEntries(schema.relations.map((relation) => [relation.from.table, [relation.fromCard, relation.toCard]]));
        expect(cards).toEqual({
            nullable_many: ['0..n', '0..1'],
            required_many: ['0..n', '1'],
            nullable_one: ['0..1', '0..1'],
            required_one: ['0..1', '1'],
        });
    });

    it('models SQLite rowid-table primary-key nullability without applying it to STRICT/WITHOUT ROWID tables', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (id INTEGER PRIMARY KEY);
            CREATE TABLE loose_text_pk (id TEXT PRIMARY KEY REFERENCES parent(id));
            CREATE TABLE rowid_alias (id INTEGER PRIMARY KEY REFERENCES parent(id));
            CREATE TABLE strict_text_pk (id TEXT PRIMARY KEY REFERENCES parent(id)) STRICT;
            CREATE TABLE without_rowid_pk (id TEXT PRIMARY KEY REFERENCES parent(id)) WITHOUT ROWID;
        `, { dialect: 'sqlite' });

        const cards = Object.fromEntries(schema.relations.map((relation) => [relation.from.table, relation.toCard]));
        expect(cards).toEqual({
            loose_text_pk: '0..1',
            rowid_alias: '1',
            strict_text_pk: '1',
            without_rowid_pk: '1',
        });
    });

    it('keeps PostgreSQL expression indexes as explicit diagnostics instead of false column badges', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE people (email TEXT);
            CREATE UNIQUE INDEX ux_people_email ON people (lower(email));
        `, { dialect: 'postgres' });

        expect(column(schema, 'people', 'email').constraints).not.toContain('UQ');
        expect(schema._parseErrors).toContainEqual(expect.objectContaining({
            severity: 'warning',
            message: expect.stringContaining('Expression index entries are preserved'),
        }));
    });
});
