import { describe, expect, it } from 'vitest';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

function table(schema, name) {
    return schema.tables.find((entry) => entry.name === name);
}

function column(schema, tableName, columnName) {
    return table(schema, tableName)?.columns.find((entry) => entry.name === columnName);
}

describe('SQL-to-ERD critical column identifier identity', () => {
    it('keeps distinct PostgreSQL quoted and unquoted FK targets separate', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (
                "ID" BIGINT UNIQUE,
                id BIGINT UNIQUE
            );
            CREATE TABLE child (
                upper_fk BIGINT REFERENCES parent("ID"),
                lower_fk BIGINT REFERENCES parent(id)
            );
        `, { dialect: 'postgres' });

        expect(schema.relations.map((relation) => [relation.from.column, relation.to.column])).toEqual([
            ['upper_fk', 'ID'],
            ['lower_fk', 'id'],
        ]);
    });

    it('uses the exact PostgreSQL quoted FK source when deriving cardinality', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (id BIGINT PRIMARY KEY);
            CREATE TABLE child (
                "parent_id" BIGINT,
                "Parent_ID" BIGINT NOT NULL REFERENCES parent(id)
            );
        `, { dialect: 'postgres' });

        expect(schema.relations).toHaveLength(1);
        expect(schema.relations[0]).toMatchObject({
            from: { table: 'child', column: 'Parent_ID' },
            to: { table: 'parent', column: 'id' },
            toCard: '1',
        });
    });

    it('rejects a PostgreSQL quoted FK target whose exact case does not exist', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (id BIGINT PRIMARY KEY);
            CREATE TABLE child (parent_id BIGINT REFERENCES parent("ID"));
        `, { dialect: 'postgres' });

        expect(schema.relations).toEqual([]);
        expect(schema._parseErrors).toContainEqual(expect.objectContaining({
            kind: 'relation_dropped_unknown_column',
        }));
    });

    it('applies PostgreSQL quoted UNIQUE constraints only to the exact column', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (
                "Code" TEXT,
                code TEXT,
                CONSTRAINT uq_parent_Code UNIQUE ("Code")
            );
            CREATE TABLE child (
                exact_code TEXT REFERENCES parent("Code"),
                folded_code TEXT REFERENCES parent(code)
            );
        `, { dialect: 'postgres' });

        expect(column(schema, 'parent', 'Code').constraints).toContain('UQ');
        expect(column(schema, 'parent', 'code').constraints).not.toContain('UQ');
        expect(schema.relations.map((relation) => relation.from.column)).toEqual(['exact_code']);
        expect(schema._parseErrors).toContainEqual(expect.objectContaining({
            kind: 'relation_dropped_non_unique_target',
        }));
    });

    it('badges only the exact PostgreSQL quoted index column', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE contacts ("Email" TEXT, email TEXT);
            CREATE INDEX ix_contacts_Email ON contacts("Email");
        `, { dialect: 'postgres' });

        expect(column(schema, 'contacts', 'Email').constraints).toContain('IDX');
        expect(column(schema, 'contacts', 'email').constraints).not.toContain('IDX');
    });

    it('preserves exact quoted column identity through ALTER-added keys and FKs', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent ("Code" TEXT, code TEXT);
            ALTER TABLE parent ADD CONSTRAINT uq_parent_Code UNIQUE ("Code");
            CREATE TABLE child ("ParentCode" TEXT, parentcode TEXT);
            ALTER TABLE child ADD CONSTRAINT fk_exact
                FOREIGN KEY ("ParentCode") REFERENCES parent("Code");
        `, { dialect: 'postgres' });

        expect(column(schema, 'parent', 'Code').constraints).toContain('UQ');
        expect(column(schema, 'parent', 'code').constraints).not.toContain('UQ');
        expect(schema.relations).toHaveLength(1);
        expect(schema.relations[0]).toMatchObject({
            from: { table: 'child', column: 'ParentCode' },
            to: { table: 'parent', column: 'Code' },
            fkName: 'fk_exact',
        });
    });

    it.each(['sqlite', 'mysql', 'mssql'])('%s retains case-insensitive column resolution', (dialect) => {
        const schema = sqlToErdSchema(`
            CREATE TABLE Parent (ID BIGINT PRIMARY KEY);
            CREATE TABLE Child (Parent_ID BIGINT REFERENCES parent(id));
        `, { dialect });

        expect(schema.relations).toHaveLength(1);
        expect(schema.relations[0]).toMatchObject({
            from: { table: 'Child', column: 'Parent_ID' },
            to: { table: 'Parent', column: 'ID' },
        });
    });

    it('applies PostgreSQL ALTER COLUMN and DROP COLUMN to exact quoted identities', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE sample (
                "ID" TEXT UNIQUE,
                id INTEGER UNIQUE
            );
            ALTER TABLE sample ALTER COLUMN "ID" TYPE UUID;
            ALTER TABLE sample ALTER COLUMN id TYPE BIGINT;
            ALTER TABLE sample DROP COLUMN id;
        `, { dialect: 'postgres' });

        expect(table(schema, 'sample').columns).toEqual([
            expect.objectContaining({ name: 'ID', type: 'UUID', constraints: ['UQ'] }),
        ]);
    });

    it('folds an unquoted PostgreSQL ALTER identifier without touching a quoted case variant', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE sample ("ID" TEXT, id INTEGER);
            ALTER TABLE sample ALTER COLUMN ID TYPE BIGINT;
        `, { dialect: 'postgres' });

        expect(column(schema, 'sample', 'ID').type).toBe('TEXT');
        expect(column(schema, 'sample', 'id').type).toBe('BIGINT');
    });

    it('renames only the exact quoted PostgreSQL column and preserves incoming FK targeting', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent ("Code" TEXT UNIQUE, code TEXT UNIQUE);
            CREATE TABLE child (parent_code TEXT REFERENCES parent("Code"));
            ALTER TABLE parent RENAME COLUMN "Code" TO "ExternalCode";
        `, { dialect: 'postgres' });

        expect(table(schema, 'parent').columns.map((entry) => entry.name)).toEqual(['ExternalCode', 'code']);
        expect(schema.relations).toHaveLength(1);
        expect(schema.relations[0].to).toEqual({ table: 'parent', column: 'ExternalCode' });
    });

    it('replays PostgreSQL SET/DROP DEFAULT and SET DATA TYPE on exact columns', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE sample (
                "Value" TEXT DEFAULT 'old',
                value INTEGER DEFAULT 1
            );
            ALTER TABLE sample ALTER COLUMN "Value" SET DEFAULT 'new';
            ALTER TABLE sample ALTER COLUMN "Value" SET DATA TYPE VARCHAR(32);
            ALTER TABLE sample ALTER COLUMN value DROP DEFAULT;
        `, { dialect: 'postgres' });

        expect(column(schema, 'sample', 'Value')).toMatchObject({
            type: 'VARCHAR(32)',
            extras: ["DEFAULT 'new'"],
        });
        expect(column(schema, 'sample', 'value')).toMatchObject({
            type: 'INTEGER',
            extras: [],
        });
    });

    it('accepts PostgreSQL ALTER TABLE ADD COLUMN IF NOT EXISTS', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE sample (id BIGINT PRIMARY KEY);
            ALTER TABLE sample ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT 'n/a';
        `, { dialect: 'postgres' });

        expect(column(schema, 'sample', 'note')).toMatchObject({
            type: 'TEXT',
            constraints: ['NN'],
            extras: ["DEFAULT 'n/a'"],
        });
    });

    it('folds unquoted PostgreSQL constraint names across rename and drop', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (
                code TEXT,
                CONSTRAINT UQ_Code UNIQUE (code)
            );
            ALTER TABLE parent RENAME CONSTRAINT uq_code TO UQ_Current;
            ALTER TABLE parent DROP CONSTRAINT uq_current;
        `, { dialect: 'postgres' });

        expect(column(schema, 'parent', 'code').constraints).not.toContain('UQ');
    });

    it('keeps quoted and unquoted PostgreSQL constraint names distinct', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (
                upper_code TEXT,
                lower_code TEXT,
                CONSTRAINT "UQ_Code" UNIQUE (upper_code),
                CONSTRAINT uq_code UNIQUE (lower_code)
            );
            ALTER TABLE parent RENAME CONSTRAINT "UQ_Code" TO "UQ_Current";
            ALTER TABLE parent DROP CONSTRAINT uq_code;
            ALTER TABLE parent DROP CONSTRAINT uq_current;
        `, { dialect: 'postgres' });

        expect(column(schema, 'parent', 'upper_code').constraints).toContain('UQ');
        expect(column(schema, 'parent', 'lower_code').constraints).not.toContain('UQ');
    });

    it('resolves an unqualified PostgreSQL user-defined type through the default schema when leaf names collide', () => {
        const schema = sqlToErdSchema(`
            CREATE TYPE public.state AS ENUM ('public');
            CREATE TYPE app.state AS ENUM ('app');
            CREATE TABLE public.items (
                id BIGINT PRIMARY KEY,
                state state NOT NULL
            );
        `, { dialect: 'postgres' });

        expect(schema.enums.map((entry) => entry.name)).toEqual(['public.state', 'app.state']);
        expect(column(schema, 'items', 'state')).toMatchObject({
            type: 'public.state',
            constraints: ['NN'],
        });
    });

    it('honors a caller-provided PostgreSQL default schema for unqualified type resolution', () => {
        const schema = sqlToErdSchema(`
            CREATE TYPE tenant_a.state AS ENUM ('tenant');
            CREATE TYPE public.state AS ENUM ('public');
            CREATE TABLE tenant_a.items (id BIGINT PRIMARY KEY, state state);
        `, { dialect: 'postgres', defaultSchema: 'tenant_a' });

        expect(column(schema, 'items', 'state').type).toBe('tenant_a.state');
    });
});
