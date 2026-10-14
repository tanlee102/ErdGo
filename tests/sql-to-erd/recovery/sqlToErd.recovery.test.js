/** Protects partial recovery when malformed SQL appears beside valid statements. */
import { describe, expect, it } from 'vitest';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

const stripSchema = (name) => {
    const dot = String(name || '').lastIndexOf('.');
    return dot >= 0 ? String(name).slice(dot + 1) : String(name || '');
};
const tableByName = (schema, name) => {
    const exact = schema.tables.find((table) => table.name.toLowerCase() === name.toLowerCase());
    if (exact) return exact;
    const leafMatches = schema.tables.filter((table) => stripSchema(table.name).toLowerCase() === name.toLowerCase());
    return leafMatches.length === 1 ? leafMatches[0] : undefined;
};
const colByName = (table, name) => table?.columns.find((column) => column.name.toLowerCase() === name.toLowerCase());

function assertRenderable(schema) {
    expect(Array.isArray(schema.enums)).toBe(true);
    expect(Array.isArray(schema.composites)).toBe(true);
    expect(Array.isArray(schema.tables)).toBe(true);
    expect(Array.isArray(schema.relations)).toBe(true);
    expect(Array.isArray(schema._parseErrors)).toBe(true);

    schema.tables.forEach((table) => {
        expect(table.name).toBeTruthy();
        expect(Array.isArray(table.columns)).toBe(true);
        table.columns.forEach((column) => {
            expect(column.name).toBeTruthy();
            expect(typeof column.type).toBe('string');
            expect(Array.isArray(column.constraints)).toBe(true);
            expect(Array.isArray(column.extras)).toBe(true);
        });
    });
}

function assertSelfConsistentPosition(sql, position) {
    expect(position).toEqual(
        expect.objectContaining({
            line: expect.any(Number),
            column: expect.any(Number),
            index: expect.any(Number),
        }),
    );

    const lines = sql.split('\n');
    let computedIndex = 0;
    for (let i = 0; i < position.line - 1; i++) {
        computedIndex += lines[i].length + 1;
    }
    computedIndex += position.column - 1;

    expect(computedIndex).toBe(position.index);
    expect(lines[position.line - 1]?.[position.column - 1]).toBeDefined();
}

describe('sqlToErdSchema broken-SQL recovery', () => {
    it('returns a renderable partial ERD and keeps valid relations after an unclosed table', () => {
        const sql = `
            CREATE TABLE valid_before (id INT PRIMARY KEY);
            CREATE TABLE broken_parent (
                id INT PRIMARY KEY,
                name TEXT,
            CREATE TABLE valid_after (
                id INT PRIMARY KEY,
                before_id INT NOT NULL REFERENCES valid_before(id)
            );
        `;

        const schema = sqlToErdSchema(sql);

        assertRenderable(schema);
        expect(tableByName(schema, 'valid_before')).toBeTruthy();
        expect(tableByName(schema, 'valid_after')).toBeTruthy();
        expect(schema.relations).toEqual([
            expect.objectContaining({
                from: { table: 'valid_after', column: 'before_id' },
                to: { table: 'valid_before', column: 'id' },
                fromCard: '0..n',
                toCard: '1',
            }),
        ]);
        expect(schema._parseErrors.some((error) => /Unclosed parenthesis/i.test(error.message))).toBe(true);
        schema._parseErrors.forEach((error) => assertSelfConsistentPosition(sql, error.position));
    });

    it('drops only the invalid FK target and preserves sibling valid relations', () => {
        const sql = `
            CREATE TABLE parents (
                id INT PRIMARY KEY,
                code TEXT UNIQUE
            );
            CREATE TABLE children (
                id INT PRIMARY KEY,
                parent_id INT REFERENCES parents(id),
                bad_parent_id INT REFERENCES parents(missing_code)
            );
        `;

        const schema = sqlToErdSchema(sql);

        assertRenderable(schema);
        expect(schema.relations).toEqual([
            expect.objectContaining({
                from: { table: 'children', column: 'parent_id' },
                to: { table: 'parents', column: 'id' },
            }),
        ]);

        const warning = schema._parseErrors.find((error) => error.kind === 'relation_dropped_unknown_column');
        expect(warning).toBeTruthy();
        expect(warning.severity).toBe('warning');
        expect(warning.message).toMatch(/missing_code/);
        assertSelfConsistentPosition(sql, warning.position);
    });

    it('propagates malformed-index diagnostics while applying the next valid index', () => {
        const sql = `
            CREATE TABLE parents (
                id INT PRIMARY KEY,
                code TEXT,
                name TEXT
            );
            CREATE INDEX idx_broken ON parents;
            CREATE INDEX idx_valid_parent_code ON parents (code);
            CREATE TABLE children (
                id INT PRIMARY KEY,
                parent_id INT NOT NULL REFERENCES parents(id)
            );
        `;

        const schema = sqlToErdSchema(sql);
        const parents = tableByName(schema, 'parents');

        assertRenderable(schema);
        expect(schema._parseErrors.some((error) => /column list in CREATE INDEX/i.test(error.message))).toBe(true);
        expect(colByName(parents, 'code')?.constraints).toContain('IDX');
        expect(schema.relations).toEqual([
            expect.objectContaining({
                from: { table: 'children', column: 'parent_id' },
                to: { table: 'parents', column: 'id' },
            }),
        ]);
        schema._parseErrors.forEach((error) => assertSelfConsistentPosition(sql, error.position));
    });

    it('keeps diagnostic positions aligned with the original SQL when leading whitespace is present', () => {
        const sql = `
  CREATE TABLE child (
    id INT,
    parent_id INT REFERENCES ghost(id)
  );
`;

        const schema = sqlToErdSchema(sql);
        const warning = schema._parseErrors.find((error) => /Relation dropped/i.test(error.message));

        assertRenderable(schema);
        expect(warning).toBeTruthy();
        assertSelfConsistentPosition(sql, warning.position);
        expect(sql[warning.position.index]).toBe('p');
        expect(warning.position.line).toBe(4);
    });

    it('keeps a renderable ERD across mixed dialects after a malformed MySQL table body', () => {
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

        const schema = sqlToErdSchema(sql);

        assertRenderable(schema);
        expect(schema._parseErrors.some((error) => /double comma/i.test(error.message))).toBe(true);
        expect(tableByName(schema, 'sqlite_parent')).toBeTruthy();
        expect(tableByName(schema, 'mysql_bad')).toBeTruthy();
        expect(tableByName(schema, 'Orders')).toBeTruthy();
        expect(tableByName(schema, 'pg_child')).toBeTruthy();
        expect(schema.enums).toEqual([{ name: 'state', values: ['open', 'closed'] }]);
        expect(schema.relations).toEqual([
            expect.objectContaining({
                from: { table: 'dbo.Orders', column: 'ParentID' },
                to: { table: 'public.sqlite_parent', column: 'id' },
            }),
        ]);
        schema._parseErrors.forEach((error) => assertSelfConsistentPosition(sql, error.position));
    });
});
