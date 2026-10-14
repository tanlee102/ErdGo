/** Verifies intentionally broken fixtures retain healthy schema output and useful diagnostics. */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAST } from '@/lib/parse-ast/parseAst.js';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

const fixtureDir = new URL('../../fixtures/sql-to-erd/broken-sql/', import.meta.url);

const cases = [
    {
        fixture: 'bad_fk_target_column.sql',
        astTables: ['parents', 'children'],
        schemaTables: ['parents', 'children'],
        schemaDiagnostics: [/missing_code/i],
        relations: ['children.parent_id->parents.id'],
    },
    {
        fixture: 'broken_alter_then_valid_alter.sql',
        astTables: ['parent', 'child'],
        schemaTables: ['parent', 'child'],
        parseDiagnostics: [/missing REFERENCES keyword/i],
        relations: ['fk_valid:child.parent_id->parent.id'],
    },
    {
        fixture: 'broken_quoted_identifier.sql',
        astTables: [],
        schemaTables: [],
        parseDiagnostics: [/Unclosed quoted identifier/i],
    },
    {
        fixture: 'broken_type_then_valid_type.sql',
        astTables: ['items'],
        schemaTables: ['items'],
        parseDiagnostics: [/Missing closing/i],
        schemaEnums: ['bad_status', 'good_status'],
    },
    {
        fixture: 'dangling_unique_constraint.sql',
        astTables: ['customers', 'orders', 'invoices'],
        schemaTables: ['customers', 'orders', 'invoices'],
        parseDiagnostics: [/UNIQUE constraint missing column list/i],
        relations: ['fk_orders_customer:orders.customer_id->customers.id', 'invoices.order_id->orders.id'],
    },
    {
        fixture: 'double_comma_recovery.sql',
        astTables: ['ok_parent', 'typo_child', 'tail_ok'],
        schemaTables: ['ok_parent', 'typo_child', 'tail_ok'],
        parseDiagnostics: [/double comma/i],
        relations: ['typo_child.parent_id->ok_parent.id', 'tail_ok.child_id->typo_child.id'],
    },
    {
        fixture: 'malformed_index_then_valid_index.sql',
        astTables: ['parents', 'children'],
        schemaTables: ['parents', 'children'],
        parseDiagnostics: [/column list in CREATE INDEX/i],
        indexedColumns: ['parents.code'],
        relations: ['children.parent_id->parents.id'],
    },
    {
        fixture: 'missing_table_name_then_valid.sql',
        astTables: ['recovered'],
        schemaTables: ['recovered'],
        parseDiagnostics: [/Expected table name after 'CREATE TABLE'/i],
    },
    {
        fixture: 'mixed_dialect_partial_recovery.sql',
        astTables: ['sqlite_parent', 'mysql_bad', 'Orders', 'pg_child'],
        schemaTables: ['public.sqlite_parent', 'public.mysql_bad', 'dbo.Orders', 'app.pg_child'],
        parseDiagnostics: [/double comma/i],
        schemaEnums: ['state'],
        relations: ['dbo.Orders.ParentID->public.sqlite_parent.id'],
    },
    {
        fixture: 'unclosed_create_table.sql',
        astTables: ['valid_before', 'broken_parent', 'valid_after'],
        schemaTables: ['valid_before', 'broken_parent', 'valid_after'],
        parseDiagnostics: [/Unclosed parenthesis/i],
        relations: ['valid_after.before_id->valid_before.id'],
    },
    {
        fixture: 'unclosed_string_default.sql',
        astTables: ['broken_default'],
        schemaTables: ['broken_default'],
        parseDiagnostics: [/Unclosed single-quoted string/i],
    },
];

function readBrokenSql(fixture) {
    return readFileSync(new URL(fixture, fixtureDir), 'utf8');
}

function stripSchema(name) {
    if (!name) return name;
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1) : name;
}

function astTableNames(parsed) {
    return parsed.ast.tables.map((table) => stripSchema(table.name));
}

function relationKeys(schema) {
    return schema.relations.map((relation) => {
        const prefix = relation.fkName ? `${relation.fkName}:` : '';
        return `${prefix}${relation.from.table}.${relation.from.column}->${relation.to.table}.${relation.to.column}`;
    });
}

function assertRenderable(schema) {
    expect(Array.isArray(schema.enums)).toBe(true);
    expect(Array.isArray(schema.composites)).toBe(true);
    expect(Array.isArray(schema.tables)).toBe(true);
    expect(Array.isArray(schema.relations)).toBe(true);
    expect(Array.isArray(schema._parseErrors)).toBe(true);

    for (const table of schema.tables) {
        expect(table.name).toBeTruthy();
        expect(Array.isArray(table.columns)).toBe(true);
        for (const column of table.columns) {
            expect(column.name).toBeTruthy();
            expect(typeof column.type).toBe('string');
            expect(Array.isArray(column.constraints)).toBe(true);
            expect(Array.isArray(column.extras)).toBe(true);
        }
    }
}

function assertDiagnostics(sql, diagnostics) {
    for (const diagnostic of diagnostics) {
        expect(diagnostic.message).toEqual(expect.any(String));
        expect(['error', 'warning']).toContain(diagnostic.severity);
        assertSelfConsistentPosition(sql, diagnostic.position);
    }
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
    expect(position.index).toBeLessThan(sql.length);
    expect(lines[position.line - 1]?.[position.column - 1]).toBeDefined();
}

function assertDiagnosticPatterns(diagnostics, patterns = []) {
    for (const pattern of patterns) {
        expect(diagnostics.some((diagnostic) => pattern.test(diagnostic.message))).toBe(true);
    }
}

function assertContainsAll(actual, expected) {
    for (const item of expected || []) {
        expect(actual).toContain(item);
    }
}

describe('broken SQL fixture corpus', () => {
    it('keeps the test manifest in sync with the fixture directory', () => {
        const discovered = readdirSync(fixtureDir)
            .filter((file) => file.endsWith('.sql'))
            .sort();
        const listed = cases.map((testCase) => testCase.fixture).sort();

        expect(listed).toEqual(discovered);
    });

    it.each(cases)('recovers predictably from $fixture', (testCase) => {
        const sql = readBrokenSql(testCase.fixture);

        const parsed = parseAST(sql);
        const schema = sqlToErdSchema(sql);

        expect(astTableNames(parsed)).toEqual(testCase.astTables);
        expect(schema.tables.map((table) => table.name)).toEqual(testCase.schemaTables);
        assertRenderable(schema);
        assertDiagnostics(sql, parsed.errors);
        assertDiagnostics(sql, schema._parseErrors);
        assertDiagnosticPatterns(parsed.errors, testCase.parseDiagnostics);
        assertDiagnosticPatterns(schema._parseErrors, testCase.schemaDiagnostics || testCase.parseDiagnostics);
        assertContainsAll(relationKeys(schema), testCase.relations);
        assertContainsAll(schema.enums.map((type) => type.name), testCase.schemaEnums);

        for (const indexedColumn of testCase.indexedColumns || []) {
            const [tableName, columnName] = indexedColumn.split('.');
            const table = schema.tables.find((item) => item.name === tableName);
            const column = table?.columns.find((item) => item.name === columnName);
            expect(column?.constraints).toContain('IDX');
        }
    });
});
