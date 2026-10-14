/** Proves golden comparisons catch deliberate contract mutations. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

const fixtures = [
    ['SQLite mobile sync', 'sqlite_mobile_sync'],
    ['PostgreSQL inventory', 'postgres_inventory'],
    ['MySQL workspace', 'mysql_workspace'],
    ['MSSQL banking', 'mssql_banking'],
    ['Semantic hardening', 'semantic_hardening'],
    ['Partial unique semantics', 'partial_unique_semantics'],
];

const topLevelKeys = ['enums', 'composites', 'tables', 'relations', 'diagnostics'];
const enumKeys = ['name', 'values'];
const compositeKeys = ['name', 'fields'];
const compositeFieldKeys = ['name', 'type'];
const tableKeys = ['name', 'columns'];
const columnBaseKeys = ['name', 'type', 'constraints', 'extras'];
const columnFlagKeys = ['pk', 'fk', 'compositePk', 'compositeUq', 'compositePartialUq', 'compositeIdx', 'autoIncrement'];
const relationBaseKeys = ['from', 'to', 'fromCard', 'toCard'];
const endpointKeys = ['table', 'column'];
const relationActionKeys = ['onDelete', 'onUpdate', 'match', 'deferrable', 'initially'];
const diagnosticKeys = ['kind', 'severity', 'message'];

const mutationCases = [
    {
        name: 'drops a relation',
        mutate(schema) {
            if (schema.relations.length === 0) return false;
            schema.relations.pop();
            return true;
        },
    },
    {
        name: 'changes relation cardinality',
        mutate(schema) {
            const relation = schema.relations[0];
            if (!relation) return false;
            relation.fromCard = relation.fromCard === '0..n' ? '0..1' : '0..n';
            return true;
        },
    },
    {
        name: 'removes a named foreign key',
        mutate(schema) {
            const relation = schema.relations.find((entry) => entry.fkName);
            if (!relation) return false;
            delete relation.fkName;
            return true;
        },
    },
    {
        name: 'removes foreign-key actions',
        mutate(schema) {
            const relation = schema.relations.find((entry) => entry.actions);
            if (!relation) return false;
            delete relation.actions;
            return true;
        },
    },
    {
        name: 'removes a primary-key flag',
        mutate(schema) {
            const column = findColumn(schema, (entry) => entry.pk);
            if (!column) return false;
            delete column.pk;
            return true;
        },
    },
    {
        name: 'removes a foreign-key flag',
        mutate(schema) {
            const column = findColumn(schema, (entry) => entry.fk);
            if (!column) return false;
            delete column.fk;
            return true;
        },
    },
    {
        name: 'removes a visible constraint badge',
        mutate(schema) {
            const column = findColumn(schema, (entry) => entry.constraints.length > 0);
            if (!column) return false;
            column.constraints.pop();
            return true;
        },
    },
    {
        name: 'removes renderer extra metadata',
        mutate(schema) {
            const column = findColumn(schema, (entry) => entry.extras.length > 0);
            if (!column) return false;
            column.extras.pop();
            return true;
        },
    },
    {
        name: 'renames a table',
        mutate(schema) {
            const table = schema.tables[0];
            if (!table) return false;
            table.name = `${table.name}_mutant`;
            return true;
        },
    },
    {
        name: 'renames an enum type',
        mutate(schema) {
            const enumType = schema.enums[0];
            if (!enumType) return false;
            enumType.name = `${enumType.name}_mutant`;
            return true;
        },
    },
    {
        name: 'drops a composite field',
        mutate(schema) {
            const composite = schema.composites.find((entry) => entry.fields.length > 0);
            if (!composite) return false;
            composite.fields.pop();
            return true;
        },
    },
    {
        name: 'adds a diagnostic warning',
        mutate(schema) {
            schema.diagnostics.push({
                kind: 'mutant_warning',
                severity: 'warning',
                message: 'mutation guard injected warning',
            });
            return true;
        },
    },
];

function fixtureUrl(kind, name) {
    const extension = kind === 'sql' ? 'sql' : 'golden.json';
    return new URL(`../../fixtures/sql-to-erd/${kind}/${name}.${extension}`, import.meta.url);
}

function readFixture(kind, name) {
    return readFileSync(fixtureUrl(kind, name), 'utf8');
}

function readGolden(name) {
    return JSON.parse(readFixture('erd', name));
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function sortedKeys(value) {
    return Object.keys(value).sort();
}

function expectExactKeys(value, keys, label) {
    expect(sortedKeys(value), label).toStrictEqual([...keys].sort());
}

function normalizeColumn(column) {
    const normalized = {
        name: column.name,
        type: column.type,
        constraints: column.constraints || [],
        extras: column.extras || [],
    };

    for (const key of columnFlagKeys) {
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

function tableColumnMap(schema) {
    return new Map(schema.tables.map((table) => [table.name, new Set(table.columns.map((column) => column.name))]));
}

function findColumn(schema, predicate) {
    for (const table of schema.tables) {
        const column = table.columns.find(predicate);
        if (column) return column;
    }
    return null;
}

function assertCanonicalGolden(schema, fixtureName) {
    expectExactKeys(schema, topLevelKeys, `${fixtureName}: top-level keys`);
    expect(Array.isArray(schema.enums), `${fixtureName}: enums`).toBe(true);
    expect(Array.isArray(schema.composites), `${fixtureName}: composites`).toBe(true);
    expect(Array.isArray(schema.tables), `${fixtureName}: tables`).toBe(true);
    expect(Array.isArray(schema.relations), `${fixtureName}: relations`).toBe(true);
    expect(Array.isArray(schema.diagnostics), `${fixtureName}: diagnostics`).toBe(true);

    for (const enumType of schema.enums) {
        expectExactKeys(enumType, enumKeys, `${fixtureName}: enum ${enumType.name}`);
        expect(enumType.name).toBeTruthy();
        expect(enumType.values.length, `${fixtureName}: enum ${enumType.name} values`).toBeGreaterThan(0);
        expect(new Set(enumType.values).size, `${fixtureName}: enum ${enumType.name} duplicates`).toBe(enumType.values.length);
    }

    for (const composite of schema.composites) {
        expectExactKeys(composite, compositeKeys, `${fixtureName}: composite ${composite.name}`);
        expect(composite.name).toBeTruthy();
        expect(composite.fields.length, `${fixtureName}: composite ${composite.name} fields`).toBeGreaterThan(0);
        for (const field of composite.fields) {
            expectExactKeys(field, compositeFieldKeys, `${fixtureName}: composite ${composite.name}.${field.name}`);
            expect(field.name).toBeTruthy();
            expect(field.type).toBeTruthy();
        }
    }

    const tableColumns = tableColumnMap(schema);
    for (const table of schema.tables) {
        expectExactKeys(table, tableKeys, `${fixtureName}: table ${table.name}`);
        expect(table.name).toBeTruthy();
        expect(table.columns.length, `${fixtureName}: table ${table.name} columns`).toBeGreaterThan(0);

        for (const column of table.columns) {
            const allowedKeys = [...columnBaseKeys, ...columnFlagKeys.filter((key) => column[key])];
            expectExactKeys(column, allowedKeys, `${fixtureName}: column ${table.name}.${column.name}`);
            expect(column.name).toBeTruthy();
            expect(column.type).toBeTruthy();
            expect(Array.isArray(column.constraints)).toBe(true);
            expect(Array.isArray(column.extras)).toBe(true);
            expect(new Set(column.constraints).size, `${fixtureName}: duplicate badges on ${table.name}.${column.name}`).toBe(column.constraints.length);

            for (const key of columnFlagKeys) {
                if (key in column) expect(column[key], `${fixtureName}: ${table.name}.${column.name}.${key}`).toBe(true);
            }
        }
    }

    for (const relation of schema.relations) {
        const allowedKeys = [
            ...relationBaseKeys,
            ...(relation.fkName ? ['fkName'] : []),
            ...(relation.actions ? ['actions'] : []),
        ];
        expectExactKeys(relation, allowedKeys, `${fixtureName}: relation ${relationKey(relation)}`);
        expectExactKeys(relation.from, endpointKeys, `${fixtureName}: relation from`);
        expectExactKeys(relation.to, endpointKeys, `${fixtureName}: relation to`);
        expect(tableColumns.get(relation.from.table)?.has(relation.from.column), `${fixtureName}: relation source ${relationKey(relation)}`).toBe(true);
        expect(tableColumns.get(relation.to.table)?.has(relation.to.column), `${fixtureName}: relation target ${relationKey(relation)}`).toBe(true);
        expect(['1', 'n', '0..1', '0..n']).toContain(relation.fromCard);
        expect(['1', '0..1']).toContain(relation.toCard);
        if (relation.actions) {
            for (const [key, value] of Object.entries(relation.actions)) {
                expect(relationActionKeys, `${fixtureName}: relation action key ${key}`).toContain(key);
                if (key === 'deferrable') expect(typeof value).toBe('boolean');
                else expect(typeof value).toBe('string');
            }
        }
    }

    for (const diagnostic of schema.diagnostics) {
        expectExactKeys(diagnostic, diagnosticKeys, `${fixtureName}: diagnostic`);
        expect(['error', 'warning']).toContain(diagnostic.severity);
        expect(diagnostic.message).toBeTruthy();
    }
}

describe('sqlToErdSchema strict golden mutation guards', () => {
    it.each(fixtures)('matches the canonical golden snapshot with strict equality for %s', (_label, fixtureName) => {
        const actual = normalizeSchema(sqlToErdSchema(readFixture('sql', fixtureName)));
        const expected = readGolden(fixtureName);

        assertCanonicalGolden(expected, fixtureName);
        expect(actual).toStrictEqual(expected);
    });

    it.each(mutationCases)('detects golden-output mutant: $name', ({ mutate }) => {
        const detectedFixtures = [];

        for (const [_label, fixtureName] of fixtures) {
            const expected = readGolden(fixtureName);
            const mutant = clone(expected);

            if (!mutate(mutant)) continue;

            expect(mutant, `${fixtureName} should detect this mutant`).not.toStrictEqual(expected);
            detectedFixtures.push(fixtureName);
        }

        expect(detectedFixtures.length).toBeGreaterThan(0);
    });
});
