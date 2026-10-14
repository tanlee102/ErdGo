/** Detects accidental fixture or expected-output drift. */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAST } from '@/lib/parse-ast/parseAst.js';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

const fixtureGroups = [
    { label: 'golden', dir: new URL('../../fixtures/sql-to-erd/sql/', import.meta.url) },
    { label: 'complex', dir: new URL('../../fixtures/sql-to-erd/complex-sql/', import.meta.url) },
];

const fixtures = fixtureGroups.flatMap((group) =>
    readdirSync(group.dir)
        .filter((file) => file.endsWith('.sql'))
        .sort()
        .map((file) => ({
            id: `${group.label}/${file}`,
            sql: readFileSync(new URL(file, group.dir), 'utf8'),
        })),
);

const perturbations = [
    {
        name: 'leading comments',
        apply: (sql) => `-- copied from migration bundle\n/* fixture stability guard */\n${sql}`,
    },
    {
        name: 'CRLF line endings',
        apply: (sql) => sql.replace(/\n/g, '\r\n'),
    },
    {
        name: 'UTF-8 BOM prefix',
        apply: (sql) => `\uFEFF${sql}`,
    },
    {
        name: 'padded editor buffer',
        apply: (sql) => `\n\n\t${sql}\n\n`,
    },
    {
        name: 'ignored DDL suffix',
        apply: (sql) => `${sql}\n\nCREATE VIEW ignored_fixture_view AS SELECT 1;\nDROP TABLE ignored_fixture_old;\nCREATE SCHEMA ignored_fixture_schema;\n`,
    },
    {
        name: 'comments CRLF ignored DDL together',
        apply: (sql) => `\uFEFF-- Windows paste buffer\n${sql}\nCREATE VIEW ignored_fixture_view AS SELECT 1;\n`.replace(/\n/g, '\r\n'),
    },
];

const stabilityCases = fixtures.flatMap((fixture) =>
    perturbations.map((perturbation) => ({
        name: `${fixture.id} - ${perturbation.name}`,
        fixture,
        perturbation,
    })),
);

function normalizeColumn(column) {
    const normalized = {
        name: column.name,
        type: column.type,
        constraints: column.constraints || [],
        extras: column.extras || [],
    };

    for (const key of ['pk', 'fk', 'compositePk', 'compositeUq', 'compositePartialUq', 'compositeIdx', 'autoIncrement']) {
        if (column[key]) normalized[key] = true;
    }

    return normalized;
}

function normalizeSchema(schema) {
    return {
        enums: schema.enums.map(({ name, values }) => ({ name, values })),
        composites: schema.composites.map(({ name, fields }) => ({ name, fields })),
        tables: schema.tables.map((table) => ({
            name: table.name,
            columns: table.columns.map(normalizeColumn),
        })),
        relations: schema.relations
            .map((relation) => ({
                from: relation.from,
                to: relation.to,
                fromCard: relation.fromCard,
                toCard: relation.toCard,
                ...(relation.fkName ? { fkName: relation.fkName } : {}),
            }))
            .sort((a, b) => relationKey(a).localeCompare(relationKey(b))),
        diagnostics: (schema._parseErrors || []).map((error) => ({
            kind: error.kind || null,
            severity: error.severity,
            message: error.message,
        })),
    };
}

function relationKey(relation) {
    return `${relation.from.table}.${relation.from.column}->${relation.to.table}.${relation.to.column}:${relation.fkName || ''}`;
}

function tableMap(schema) {
    return new Map(schema.tables.map((table) => [table.name, new Set(table.columns.map((column) => column.name))]));
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

describe('SQL fixture stability corpus', () => {
    it('discovers the expected valid fixture corpus', () => {
        expect(fixtures.map((fixture) => fixture.id).sort()).toEqual([
            'complex/mssql_healthcare_claims.sql',
            'complex/mssql_inventory_lots.sql',
            'complex/mysql_collaboration_acl.sql',
            'complex/mysql_marketplace_orders.sql',
            'complex/postgres_finance_books.sql',
            'complex/postgres_saas_audit.sql',
            'complex/sqlite_content_graph.sql',
            'complex/sqlite_offline_forms.sql',
            'golden/mssql_banking.sql',
            'golden/mysql_workspace.sql',
            'golden/partial_unique_semantics.sql',
            'golden/postgres_inventory.sql',
            'golden/semantic_hardening.sql',
            'golden/sqlite_mobile_sync.sql',
        ]);
    });

    it.each(fixtures)('has no parser or ERD error diagnostics for $id', ({ sql }) => {
        const parsed = parseAST(sql);
        const schema = sqlToErdSchema(sql);

        expect(parsed.errors.filter((error) => error.severity === 'error')).toEqual([]);
        expect(schema._parseErrors.filter((error) => error.severity === 'error')).toEqual([]);
        assertRenderable(schema);
    });

    it.each(stabilityCases)('keeps schema stable under $name', ({ fixture, perturbation }) => {
        const baseline = normalizeSchema(sqlToErdSchema(fixture.sql));
        const perturbed = normalizeSchema(sqlToErdSchema(perturbation.apply(fixture.sql)));

        expect(perturbed).toEqual(baseline);
        expect(perturbed.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    });

    it.each(fixtures)('keeps all relation endpoints resolvable for $id', ({ sql }) => {
        const schema = sqlToErdSchema(sql);
        const tables = tableMap(schema);

        for (const relation of schema.relations) {
            expect(tables.has(relation.from.table), `${relation.from.table}.${relation.from.column}`).toBe(true);
            expect(tables.get(relation.from.table)?.has(relation.from.column), `${relation.from.table}.${relation.from.column}`).toBe(true);
            expect(tables.has(relation.to.table), `${relation.to.table}.${relation.to.column}`).toBe(true);
            expect(tables.get(relation.to.table)?.has(relation.to.column), `${relation.to.table}.${relation.to.column}`).toBe(true);
            expect(['1', 'n', '0..1', '0..n']).toContain(relation.fromCard);
            expect(['1', '0..1']).toContain(relation.toCard);
        }
    });

    it.each(fixtures)('is deterministic and JSON-safe for $id', ({ sql }) => {
        const first = normalizeSchema(sqlToErdSchema(sql));
        const second = normalizeSchema(sqlToErdSchema(sql));

        expect(second).toEqual(first);
        expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    });
});
