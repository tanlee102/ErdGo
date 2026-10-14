import { describe, expect, it } from 'vitest';
import { parseAST } from '@/lib/parse-ast/parseAst.js';

describe('parseAST critical DROP lifecycle metadata', () => {
    it('reports end-of-input inside a CREATE TABLE body as an error', () => {
        const result = parseAST('CREATE TABLE users (');

        expect(result.errors).toContainEqual(expect.objectContaining({
            severity: 'error',
            message: expect.stringMatching(/Unclosed parenthesis.*Reached end of input/i),
        }));
    });

    it.each(['mysql', 'mssql'])('captures the target table for %s DROP INDEX ... ON table', (dialect) => {
        const result = parseAST(`DROP INDEX [ix_value] ON [app].[inventory];`, { dialect });

        expect(result.errors).toEqual([]);
        expect(result.ast.drops).toEqual([
            expect.objectContaining({
                kind: 'index',
                name: 'ix_value',
                table: 'app.inventory',
            }),
        ]);
    });

    it('preserves multiple PostgreSQL DROP object names and trailing behavior', () => {
        const result = parseAST(`
            DROP INDEX IF EXISTS app.ix_one, app.ix_two CASCADE;
            DROP TYPE IF EXISTS app.old_one, app.old_two RESTRICT;
        `, { dialect: 'postgres' });

        expect(result.errors).toEqual([]);
        expect(result.ast.drops.map((entry) => [entry.kind, entry.name])).toEqual([
            ['index', 'app.ix_one'],
            ['index', 'app.ix_two'],
            ['type', 'app.old_one'],
            ['type', 'app.old_two'],
        ]);
        expect(result.ast.drops.map((entry) => entry.behavior)).toEqual([
            'CASCADE',
            'CASCADE',
            'RESTRICT',
            'RESTRICT',
        ]);
    });

    it('skips PostgreSQL CONCURRENTLY before resolving a dropped index name', () => {
        const result = parseAST(`
            DROP INDEX CONCURRENTLY IF EXISTS app.ix_audit_code;
        `, { dialect: 'postgres' });

        expect(result.errors).toEqual([]);
        expect(result.ast.drops).toEqual([
            expect.objectContaining({
                kind: 'index',
                name: 'app.ix_audit_code',
            }),
        ]);
    });

    it('preserves quoted PostgreSQL column identity metadata across keys, references, and indexes', () => {
        const result = parseAST(`
            CREATE TABLE parent ("Code" TEXT, code TEXT, UNIQUE ("Code"));
            CREATE TABLE child ("ParentCode" TEXT REFERENCES parent("Code"));
            CREATE INDEX ix_parent_Code ON parent("Code");
        `, { dialect: 'postgres' });

        const parent = result.ast.tables.find((entry) => entry.name === 'parent');
        const child = result.ast.tables.find((entry) => entry.name === 'child');
        const unique = parent.constraints.find((entry) => entry.kind === 'unique');

        expect(parent.columns.map((entry) => [entry.name, entry.nameParts?.[0]?.quoted])).toEqual([
            ['Code', true],
            ['code', false],
        ]);
        expect(unique.columns.identifierParts[0][0]).toMatchObject({ value: 'Code', quoted: true });
        expect(child.columns[0].references.columns.identifierParts[0][0]).toMatchObject({ value: 'Code', quoted: true });
        expect(result.ast.indexes[0].columns.identifierParts[0][0]).toMatchObject({ value: 'Code', quoted: true });
    });

    it('preserves quoted PostgreSQL ALTER column identity metadata', () => {
        const result = parseAST(`
            ALTER TABLE sample ALTER COLUMN "ID" TYPE UUID;
            ALTER TABLE sample DROP COLUMN "Legacy";
        `, { dialect: 'postgres' });

        expect(result.errors).toEqual([]);
        expect(result.ast.alters.map((entry) => ({
            action: entry.action,
            columnQuoted: entry.columnParts?.[0]?.quoted,
            oldQuoted: entry.oldNameParts?.[0]?.quoted,
        }))).toEqual([
            { action: 'alter_column_type', columnQuoted: true, oldQuoted: undefined },
            { action: 'drop_column', columnQuoted: true, oldQuoted: undefined },
        ]);
    });

    it('targets the qualified table after PostgreSQL ALTER TABLE ONLY', () => {
        const result = parseAST(`
            CREATE TABLE public.accounts (id BIGINT);
            CREATE TABLE "app"."orders" (account_id BIGINT);
            ALTER TABLE ONLY public.accounts
                ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);
            ALTER TABLE ONLY "app"."orders"
                ADD CONSTRAINT orders_account_fk
                FOREIGN KEY (account_id) REFERENCES public.accounts(id);
        `, { dialect: 'postgres' });

        expect(result.errors).toEqual([]);
        expect(result.ast.alters).toEqual([
            expect.objectContaining({
                table: 'public.accounts',
                action: 'add_primary',
                name: 'accounts_pkey',
                columns: ['id'],
            }),
            expect.objectContaining({
                table: 'app.orders',
                action: 'add_foreign',
                name: 'orders_account_fk',
                columns: ['account_id'],
                references: expect.objectContaining({
                    table: 'public.accounts',
                    columns: ['id'],
                }),
            }),
        ]);
        expect(result.ast.alters[1].tableParts).toEqual([
            expect.objectContaining({ value: 'app', quoted: true }),
            expect.objectContaining({ value: 'orders', quoted: true }),
        ]);
    });

    it('distinguishes index and constraint renames from table renames', () => {
        const mysql = parseAST(`ALTER TABLE events RENAME INDEX ix_old TO ix_new;`, { dialect: 'mysql' });
        const postgres = parseAST(`ALTER TABLE events RENAME CONSTRAINT "UQ_Old" TO "UQ_New";`, { dialect: 'postgres' });

        expect(mysql.ast.alters).toEqual([
            expect.objectContaining({ table: 'events', action: 'rename_index', oldName: 'ix_old', newName: 'ix_new' }),
        ]);
        expect(postgres.ast.alters).toEqual([
            expect.objectContaining({ table: 'events', action: 'rename_constraint', oldName: 'UQ_Old', newName: 'UQ_New' }),
        ]);
        expect(postgres.ast.alters[0].oldNameParts[0]).toMatchObject({ quoted: true });
        expect(postgres.ast.alters[0].newNameParts[0]).toMatchObject({ quoted: true });
    });

    it('parses PostgreSQL ALTER INDEX and multi-table MySQL RENAME TABLE lifecycle actions', () => {
        const postgres = parseAST(`ALTER INDEX app.ix_old RENAME TO ix_new;`, { dialect: 'postgres' });
        const mysql = parseAST(`RENAME TABLE first_old TO first_new, second_old TO second_new;`, { dialect: 'mysql' });

        expect(postgres.errors).toEqual([]);
        expect(postgres.ast.alters).toEqual([
            expect.objectContaining({
                table: null,
                action: 'rename_index_global',
                oldName: 'app.ix_old',
                newName: 'app.ix_new',
            }),
        ]);
        expect(mysql.errors).toEqual([]);
        expect(mysql.ast.alters).toEqual([
            expect.objectContaining({ table: 'first_old', action: 'rename_table', newName: 'first_new' }),
            expect.objectContaining({ table: 'second_old', action: 'rename_table', newName: 'second_new' }),
        ]);
    });

    it('parses SQL Server sp_rename table, column, and index forms', () => {
        const result = parseAST(`
            EXEC sp_rename N'dbo.Users.Legacy', N'Current', 'COLUMN';
            EXEC sp_rename N'dbo.Users.ix_old', N'ix_current', 'INDEX';
            EXEC sys.sp_rename @objname = N'dbo.Users', @newname = N'Accounts';
        `, { dialect: 'mssql' });

        expect(result.errors).toEqual([]);
        expect(result.ast.alters).toEqual([
            expect.objectContaining({ table: 'dbo.Users', action: 'rename_column', oldName: 'Legacy', newName: 'Current' }),
            expect.objectContaining({ table: 'dbo.Users', action: 'rename_index', oldName: 'ix_old', newName: 'ix_current' }),
            expect.objectContaining({ table: 'dbo.Users', action: 'rename_table', newName: 'dbo.Accounts' }),
        ]);
    });
});
