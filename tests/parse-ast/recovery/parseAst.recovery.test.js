/** Ensures malformed statements produce diagnostics without hiding healthy neighbors. */
import { describe, expect, it } from 'vitest';
import { parseAST } from '@/lib/parse-ast/parseAst.js';

const stripSchema = (name) => {
    if (!name) return name;
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1) : name;
};

function parse(sql) {
    const result = parseAST(sql);
    return {
        ...result,
        table: (name) => result.ast.tables.find((table) => stripSchema(table.name).toLowerCase() === name.toLowerCase()),
        column: (tableName, columnName) => {
            const table = result.ast.tables.find((item) => stripSchema(item.name).toLowerCase() === tableName.toLowerCase());
            return table?.columns.find((column) => column.name.toLowerCase() === columnName.toLowerCase());
        },
        type: (name) => result.ast.types.find((type) => stripSchema(type.name).toLowerCase() === name.toLowerCase()),
        errorsOnly: () => result.errors.filter((error) => error.severity === 'error'),
        warningsOnly: () => result.errors.filter((error) => error.severity === 'warning'),
    };
}

function assertPositionShape(error) {
    expect(error.position).toEqual(
        expect.objectContaining({
            line: expect.any(Number),
            column: expect.any(Number),
            index: expect.any(Number),
        }),
    );
    expect(error.position.line).toBeGreaterThanOrEqual(1);
    expect(error.position.column).toBeGreaterThanOrEqual(1);
    expect(error.position.index).toBeGreaterThanOrEqual(0);
}

describe('parseAST broken-SQL recovery', () => {
    it('recovers to the next CREATE TABLE after an unclosed table body', () => {
        const sql = `
            CREATE TABLE valid_before (id INT PRIMARY KEY);
            CREATE TABLE broken_parent (
                id INT PRIMARY KEY,
                name TEXT,
            CREATE TABLE valid_after (
                id INT PRIMARY KEY,
                before_id INT REFERENCES valid_before(id)
            );
        `;

        const result = parse(sql);

        expect(result.table('valid_before')).toBeTruthy();
        expect(result.table('valid_after')).toBeTruthy();
        expect(result.column('valid_after', 'before_id')?.references?.table).toBe('valid_before');
        expect(result.errors.some((error) => /Unclosed parenthesis/i.test(error.message))).toBe(true);
        result.errors.forEach(assertPositionShape);
    });

    it('keeps later columns and later statements after a double comma in a table body', () => {
        const sql = `
            CREATE TABLE ok_parent (id INT PRIMARY KEY);
            CREATE TABLE typo_child (
                id INT PRIMARY KEY,,
                parent_id INT NOT NULL REFERENCES ok_parent(id),
                payload TEXT
            );
            CREATE TABLE tail_ok (
                id INT PRIMARY KEY,
                child_id INT REFERENCES typo_child(id)
            );
        `;

        const result = parse(sql);

        expect(result.errorsOnly().some((error) => /double comma/i.test(error.message))).toBe(true);
        expect(result.table('typo_child')?.columns.map((column) => column.name)).toEqual(['id', 'parent_id', 'payload']);
        expect(result.column('typo_child', 'parent_id')?.references?.table).toBe('ok_parent');
        expect(result.column('tail_ok', 'child_id')?.references?.table).toBe('typo_child');
        result.errors.forEach(assertPositionShape);
    });

    it('recovers from a malformed CREATE INDEX and still parses following tables', () => {
        const sql = `
            CREATE TABLE parents (
                id INT PRIMARY KEY,
                code TEXT UNIQUE
            );
            CREATE INDEX idx_broken ON parents;
            CREATE TABLE children (
                id INT PRIMARY KEY,
                parent_id INT NOT NULL REFERENCES parents(id)
            );
        `;

        const result = parse(sql);

        expect(result.warningsOnly().some((error) => /column list in CREATE INDEX/i.test(error.message))).toBe(true);
        expect(result.ast.indexes).toEqual([]);
        expect(result.table('children')).toBeTruthy();
        expect(result.column('children', 'parent_id')?.references?.table).toBe('parents');
        result.errors.forEach(assertPositionShape);
    });

    it('skips a malformed ALTER TABLE foreign key and accepts the next valid ALTER', () => {
        const sql = `
            CREATE TABLE parent (id INT PRIMARY KEY, code TEXT UNIQUE);
            CREATE TABLE child (id INT PRIMARY KEY, parent_id INT, code TEXT);
            ALTER TABLE child ADD CONSTRAINT fk_broken
                FOREIGN KEY (parent_id REFERENCES parent(id);
            ALTER TABLE child ADD CONSTRAINT fk_valid
                FOREIGN KEY (parent_id) REFERENCES parent(id);
        `;

        const result = parse(sql);

        expect(result.errorsOnly().some((error) => /missing REFERENCES keyword/i.test(error.message))).toBe(true);
        expect(result.ast.alters).toHaveLength(1);
        expect(result.ast.alters[0]).toEqual(
            expect.objectContaining({
                table: 'child',
                action: 'add_foreign',
                name: 'fk_valid',
                columns: ['parent_id'],
                references: expect.objectContaining({
                    table: 'parent',
                    columns: ['id'],
                }),
            }),
        );
        result.errors.forEach(assertPositionShape);
    });

    it('continues through mixed SQLite, MySQL, MSSQL, and PostgreSQL syntax after a broken MySQL table entry', () => {
        const sql = `
            CREATE TABLE sqlite_parent (
                id INTEGER PRIMARY KEY AUTOINCREMENT
            );
            CREATE TABLE \`mysql_bad\` (
                \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,,
                \`parent_id\` BIGINT
            );
            GO
            CREATE TABLE [dbo].[Orders] (
                [OrderID] BIGINT IDENTITY(1,1) PRIMARY KEY,
                [ParentID] INT REFERENCES sqlite_parent(id)
            );
            CREATE TYPE app.state AS ENUM ('open', 'closed');
            CREATE TABLE app.pg_child (
                id BIGSERIAL PRIMARY KEY,
                state app.state NOT NULL DEFAULT 'open'
            );
        `;

        const result = parse(sql);

        expect(result.errorsOnly().some((error) => /double comma/i.test(error.message))).toBe(true);
        expect(result.table('sqlite_parent')).toBeTruthy();
        expect(result.table('mysql_bad')?.columns.map((column) => column.name)).toEqual(['id', 'parent_id']);
        expect(result.table('Orders')).toBeTruthy();
        expect(result.type('state')?.values).toEqual(['open', 'closed']);
        expect(result.column('pg_child', 'state')?.type).toBe('app.state');
        result.errors.forEach(assertPositionShape);
    });
});
