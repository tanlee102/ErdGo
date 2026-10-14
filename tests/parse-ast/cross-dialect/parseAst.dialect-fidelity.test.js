import { describe, expect, it } from 'vitest';
import { parseAST } from '@/lib/parse-ast/parseAst.js';

const errorsOnly = (result) => result.errors.filter((error) => error.severity === 'error');

describe('parseAST dialect fidelity', () => {
    it('keeps quoted type source out of public JSON and does not treat a quoted SERIAL type as auto-increment', () => {
        const result = parseAST('CREATE TYPE "SERIAL" AS ENUM (\'one\'); CREATE TABLE t(id "SERIAL");');
        const column = result.ast.tables[0].columns[0]; expect(column.autoIncrement).toBe(false); expect(column.declaredTypeSql).toBe('"SERIAL"'); expect(JSON.parse(JSON.stringify(column)).declaredTypeSql).toBeUndefined();
    });
    it('replays every field in SQL Server comma-separated ADD syntax', () => {
        const result = parseAST('SET ANSI_NULLS ON; CREATE TABLE t(id INT); ALTER TABLE t ADD a INT, b DECIMAL(10,2), [c.dot] NVARCHAR(20);');
        expect(errorsOnly(result)).toEqual([]); expect(result.ast.alters.map(a => a.column.name)).toEqual(['a', 'b', 'c.dot']);
    });
    it.each(['`', '['])('detects native SQLite with compatible %s quoting and stays neutral for conflicting batch syntax', quote => {
        const close = quote === '[' ? ']' : quote;
        const sql = `PRAGMA foreign_keys = ON; CREATE TABLE ${quote}items${close} (id INTEGER PRIMARY KEY);`;
        expect(parseAST(sql).ast.dialect).toBe('sqlite');
        expect(parseAST(`GO\n${sql}\nGO`).ast.dialect).toBe('auto');
    });

    it('does not treat quoted keywords or an unfinished empty body as native syntax', () => {
        expect(parseAST('CREATE TABLE "strict" ("go" INTEGER, "jsonb" TEXT);').ast.dialect).toBe('auto');
        expect(parseAST('CREATE TABLE unfinished (').ast.dialect).toBe('auto');
    });

    it('detects and preserves SQLite typeless columns, then enforces STRICT declarations', () => {
        const flexible = parseAST(`
            CREATE TABLE flexible (
                id,
                payload TEXT,
                checksum BLOB
            );
        `);

        expect(flexible.ast.dialect).toBe('sqlite');
        expect(errorsOnly(flexible)).toEqual([]);
        expect(flexible.ast.tables[0].columns[0]).toMatchObject({
            name: 'id',
            type: 'UNTYPED',
            declaredTypeMissing: true,
        });

        const strict = parseAST(`CREATE TABLE strict_bad (id, amount NUMERIC) STRICT;`, { dialect: 'sqlite' });
        expect(errorsOnly(strict).map((error) => error.message)).toEqual([
            expect.stringContaining('requires a declared type'),
            expect.stringContaining("does not allow declared type 'NUMERIC'"),
        ]);
    });

    it('supports PostgreSQL empty tables and UNIQUE NULLS NOT DISTINCT', () => {
        const result = parseAST(`
            CREATE TABLE empty_stage ();
            CREATE TABLE accounts (
                id BIGINT PRIMARY KEY,
                tenant_id BIGINT NOT NULL,
                email TEXT,
                CONSTRAINT uq_accounts_email
                    UNIQUE NULLS NOT DISTINCT (tenant_id, email)
            );
        `, { dialect: 'postgres' });

        expect(errorsOnly(result)).toEqual([]);
        expect(result.ast.tables[0].columns).toEqual([]);
        expect(result.ast.tables[1].constraints).toContainEqual(expect.objectContaining({
            name: 'uq_accounts_email',
            kind: 'unique',
            columns: ['tenant_id', 'email'],
            nullsNotDistinct: true,
        }));
    });

    it('preserves MySQL FIRST/AFTER placement through ADD, MODIFY, and CHANGE', () => {
        const result = parseAST(`
            CREATE TABLE inventory (sku VARCHAR(40), legacy INT);
            ALTER TABLE inventory ADD COLUMN tenant_id BIGINT FIRST;
            ALTER TABLE inventory MODIFY COLUMN sku VARCHAR(80) AFTER tenant_id;
            ALTER TABLE inventory CHANGE COLUMN legacy quantity INT AFTER sku;
        `, { dialect: 'mysql' });

        expect(errorsOnly(result)).toEqual([]);
        expect(result.ast.alters.map((alter) => [alter.action, alter.column?.name, alter.column?.placement])).toEqual([
            ['add_column', 'tenant_id', { first: true, after: null }],
            ['modify_column', 'sku', { first: false, after: 'tenant_id' }],
            ['change_column', 'quantity', { first: false, after: 'sku' }],
        ]);
    });

    it('parses SQL Server temporal periods, hidden system columns, and named defaults', () => {
        const result = parseAST(`
            CREATE TABLE [audit].[orders] (
                [id] BIGINT NOT NULL,
                [valid_from] DATETIME2 GENERATED ALWAYS AS ROW START HIDDEN,
                [valid_to] DATETIME2 GENERATED ALWAYS AS ROW END,
                PERIOD FOR SYSTEM_TIME ([valid_from], [valid_to]),
                CONSTRAINT [DF_orders_id] DEFAULT ((0)) FOR [id],
                CONSTRAINT [PK_orders] PRIMARY KEY CLUSTERED ([id])
            ) WITH (SYSTEM_VERSIONING = ON);
        `, { dialect: 'mssql' });

        expect(errorsOnly(result)).toEqual([]);
        const table = result.ast.tables[0];
        expect(table.columns[1].systemGenerated).toEqual({ kind: 'ROW', boundary: 'START', hidden: true });
        expect(table.columns[2].systemGenerated).toEqual({ kind: 'ROW', boundary: 'END', hidden: false });
        expect(table.constraints).toContainEqual(expect.objectContaining({ kind: 'period', columns: ['valid_from', 'valid_to'] }));
        expect(table.constraints).toContainEqual(expect.objectContaining({ kind: 'default', name: 'DF_orders_id', column: 'id', expression: '((0))' }));
    });

    it('preserves expression index entries and DROP lifecycle statements', () => {
        const result = parseAST(`
            CREATE TABLE people (email TEXT);
            CREATE UNIQUE INDEX ux_people_email ON people (lower(email));
            DROP TABLE IF EXISTS people CASCADE;
        `, { dialect: 'postgres' });

        expect(errorsOnly(result)).toEqual([]);
        expect(result.ast.indexes[0]).toMatchObject({ columns: [], expressions: ['lower(email)'], unique: true });
        expect(result.ast.drops[0]).toMatchObject({ kind: 'table', name: 'people' });
        expect(result.errors).toContainEqual(expect.objectContaining({
            severity: 'warning',
            message: expect.stringContaining('Expression index entries are preserved'),
        }));
    });

    it.each(['id + 1', "label || ''", 'pg_catalog.lower(label)', 'CAST(id AS TEXT)', "CASE WHEN id > 0 THEN label ELSE '' END"])(
        'preserves %s as an expression instead of a column key', (expression) => {
            const parsed = parseAST(`CREATE TABLE p(id INTEGER, label TEXT); CREATE UNIQUE INDEX mixed_key ON p(id, ${expression});`, { dialect: 'postgres' });
            expect(parsed.ast.indexes[0].columns).toEqual(['id']);
            expect(parsed.ast.indexes[0].expressions).toHaveLength(1);
            expect(parsed.errors).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('Expression index') }));
        },
    );
});
