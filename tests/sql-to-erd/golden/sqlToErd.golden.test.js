/** Compares normalized SQL-to-ERD output with reviewed golden artifacts. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

const fixtures = [
    ['SQLite mobile sync', 'sqlite_mobile_sync'],
    ['PostgreSQL inventory', 'postgres_inventory'],
    ['MySQL workspace', 'mysql_workspace'],
    ['MSSQL banking', 'mssql_banking'],
    ['Semantic hardening', 'semantic_hardening'],
];

function fixtureUrl(kind, name) {
    return new URL(`../../fixtures/sql-to-erd/${kind}/${name}.${kind === 'sql' ? 'sql' : 'golden.json'}`, import.meta.url);
}

function readFixture(kind, name) {
    return readFileSync(fixtureUrl(kind, name), 'utf8');
}

function normalizeColumn(column) {
    const normalized = {
        name: column.name,
        type: column.type,
        constraints: column.constraints || [],
        extras: column.extras || [],
    };

    for (const key of ['pk', 'fk', 'compositePk', 'compositeUq', 'compositeIdx', 'autoIncrement']) {
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
                ...(relation.actions ? { actions: relation.actions } : {}),
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

describe('sqlToErdSchema golden fixtures', () => {
    it.each(fixtures)('matches the renderer-facing ERD golden for %s', (_label, fixtureName) => {
        const sql = readFixture('sql', fixtureName);
        const expected = JSON.parse(readFixture('erd', fixtureName));

        const actual = normalizeSchema(sqlToErdSchema(sql));

        expect(actual).toStrictEqual(expected);
    });

    it('keeps every golden fixture free of parser or validator errors', () => {
        for (const [_label, fixtureName] of fixtures) {
            const sql = readFixture('sql', fixtureName);
            const schema = sqlToErdSchema(sql);

            expect(schema._parseErrors.filter((error) => error.severity === 'error'), fixtureName).toEqual([]);
        }
    });
});
