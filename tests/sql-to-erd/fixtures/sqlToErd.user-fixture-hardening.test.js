/** Applies defensive invariants to schemas derived from real user fixtures. */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAST } from '@/lib/parse-ast/parseAst.js';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

const fixtureDir = new URL('../../fixtures/sql-to-erd/user-sql/', import.meta.url);

const fixtureFiles = readdirSync(fixtureDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

const fixtureSql = new Map(
    fixtureFiles.map((fixture) => [fixture, readFileSync(new URL(fixture, fixtureDir), 'utf8')]),
);

const hardeningTransforms = [
    {
        name: 'raw export',
        apply: (sql) => sql,
    },
    {
        name: 'leading and trailing whitespace',
        apply: (sql) => `\n\n\t  ${sql}\n\n  \t\n`,
    },
    {
        name: 'utf8 bom prefix',
        apply: (sql) => `\uFEFF${sql}`,
    },
    {
        name: 'crlf line endings',
        apply: (sql) => sql.replace(/\n/g, '\r\n'),
    },
    {
        name: 'indented clipboard block',
        apply: (sql) => sql.split('\n').map((line) => (line ? `    ${line}` : line)).join('\n'),
    },
    {
        name: 'tab indented clipboard block',
        apply: (sql) => sql.split('\n').map((line) => (line ? `\t${line}` : line)).join('\n'),
    },
    {
        name: 'client banner comments',
        apply: (sql) => `-- exported from a database client\n/* user fixture hardening */\n${sql}`,
    },
    {
        name: 'client footer comments',
        apply: (sql) => `${sql}\n-- export finished\n/* checksum omitted by client */\n`,
    },
    {
        name: 'statement separator comments',
        apply: (sql) => sql.replace(/;\n/g, ';\n-- statement boundary copied by client\n'),
    },
    {
        name: 'extra blank lines after statements',
        apply: (sql) => sql.replace(/;\n/g, ';\n\n\n'),
    },
    {
        name: 'extra semicolons around script',
        apply: (sql) => `;;;\n${sql}\n;;;`,
    },
    {
        name: 'sql server go wrapper',
        apply: (sql) => `GO\n${sql}\nGO\n`,
    },
    {
        name: 'sql server settings wrapper',
        apply: (sql) => `SET ANSI_NULLS ON;\nSET QUOTED_IDENTIFIER ON;\nGO\n${sql}\nGO\nSET NOCOUNT OFF;\n`,
    },
    {
        name: 'postgres client settings wrapper',
        apply: (sql) => `SET client_encoding = 'UTF8';\nSET standard_conforming_strings = on;\nSET check_function_bodies = false;\n${sql}`,
    },
    {
        name: 'postgres search path wrapper',
        apply: (sql) => `SET search_path = public, app, auth, storage, dbo, dw;\n${sql}\nRESET search_path;\n`,
    },
    {
        name: 'sqlite pragma wrapper',
        apply: (sql) => `PRAGMA foreign_keys=OFF;\nPRAGMA journal_mode=WAL;\n${sql}\nPRAGMA foreign_keys=ON;\n`,
    },
    {
        name: 'sqlite transaction wrapper',
        apply: (sql) => `BEGIN TRANSACTION;\n${sql}\nCOMMIT;\n`,
    },
    {
        name: 'generic transaction wrapper',
        apply: (sql) => `BEGIN;\n${sql}\nCOMMIT;\n`,
    },
    {
        name: 'mysql dump setting wrapper',
        apply: (sql) => `/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;\nSET FOREIGN_KEY_CHECKS=0;\n${sql}\nSET FOREIGN_KEY_CHECKS=1;\n`,
    },
    {
        name: 'mysql lock wrapper',
        apply: (sql) => `LOCK TABLES ignored_fixture_lock WRITE;\n${sql}\nUNLOCK TABLES;\n`,
    },
    {
        name: 'database use wrapper',
        apply: (sql) => `USE ignored_fixture_database;\n${sql}\n`,
    },
    {
        name: 'ignored schema and extension prelude',
        apply: (sql) => `CREATE SCHEMA IF NOT EXISTS ignored_fixture_schema;\nCREATE EXTENSION IF NOT EXISTS pgcrypto;\n${sql}`,
    },
    {
        name: 'ignored sequence prelude',
        apply: (sql) => `CREATE SEQUENCE ignored_fixture_sequence START WITH 1 INCREMENT BY 1;\n${sql}`,
    },
    {
        name: 'ignored domain prelude',
        apply: (sql) => `CREATE DOMAIN ignored_fixture_domain AS TEXT;\n${sql}`,
    },
    {
        name: 'ignored view suffix',
        apply: (sql) => `${sql}\nCREATE VIEW ignored_fixture_view AS SELECT 1;\nDROP VIEW ignored_fixture_view;\n`,
    },
    {
        name: 'ignored materialized view suffix',
        apply: (sql) => `${sql}\nCREATE MATERIALIZED VIEW ignored_fixture_mv AS SELECT 1;\nDROP MATERIALIZED VIEW ignored_fixture_mv;\n`,
    },
    {
        name: 'ignored create or replace view suffix',
        apply: (sql) => `${sql}\nCREATE OR REPLACE VIEW ignored_fixture_replace_view AS SELECT 1;\n`,
    },
    {
        name: 'ignored trigger suffix',
        apply: (sql) => `${sql}\nCREATE TRIGGER ignored_fixture_trigger AFTER INSERT ON ignored_fixture_table EXECUTE FUNCTION ignored_fixture_fn();\n`,
    },
    {
        name: 'ignored policy suffix',
        apply: (sql) => `${sql}\nCREATE POLICY ignored_fixture_policy ON ignored_fixture_table FOR SELECT USING (true);\n`,
    },
    {
        name: 'ignored rule suffix',
        apply: (sql) => `${sql}\nCREATE RULE ignored_fixture_rule AS ON SELECT TO ignored_fixture_table DO INSTEAD NOTHING;\n`,
    },
    {
        name: 'grant revoke comment suffix',
        apply: (sql) => `${sql}\nGRANT SELECT ON TABLE ignored_fixture_table TO public;\nREVOKE ALL ON TABLE ignored_fixture_table FROM public;\nCOMMENT ON TABLE ignored_fixture_table IS 'ignored';\n`,
    },
    {
        name: 'maintenance statements suffix',
        apply: (sql) => `${sql}\nANALYZE;\nVACUUM;\nEXPLAIN SELECT 1;\n`,
    },
    {
        name: 'select and explain prelude',
        apply: (sql) => `SELECT 1;\nEXPLAIN SELECT 1;\n${sql}`,
    },
    {
        name: 'drop noise around script',
        apply: (sql) => `DROP TABLE IF EXISTS ignored_fixture_old;\nDROP TYPE IF EXISTS ignored_fixture_type;\n${sql}\nDROP SCHEMA IF EXISTS ignored_fixture_schema CASCADE;\n`,
    },
    {
        name: 'windows clipboard with bom and go',
        apply: (sql) => `\uFEFF-- copied from Windows SQL client\nGO\n${sql}\nGO\n`.replace(/\n/g, '\r\n'),
    },
    {
        name: 'migration tool comments and transaction',
        apply: (sql) => `-- migrate:up\nBEGIN;\n${sql}\nCOMMIT;\n-- migrate:down omitted\n`,
    },
    {
        name: 'orm migration timestamp comments',
        apply: (sql) => `/* migration 20260523120000 */\n${sql}\n/* end migration 20260523120000 */\n`,
    },
    {
        name: 'trimmed final newline',
        apply: (sql) => sql.trim(),
    },
];

const hardeningCases = fixtureFiles.flatMap((fixture) =>
    hardeningTransforms.map((transform) => ({
        name: `${fixture} - ${transform.name}`,
        fixture,
        transform,
    })),
);

function stripSchema(name) {
    if (!name) return name;
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1) : name;
}

function relationKey(relation) {
    const prefix = relation.fkName ? `${relation.fkName}:` : '';
    return `${prefix}${relation.from.table}.${relation.from.column}->${relation.to.table}.${relation.to.column}`;
}

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
    };
}

function tableNames(parsed) {
    return parsed.ast.tables.map((table) => stripSchema(table.name));
}

function typeNames(parsed) {
    return parsed.ast.types.map((type) => stripSchema(type.name));
}

function indexNames(parsed) {
    return parsed.ast.indexes.map((index) => index.name).filter(Boolean).sort();
}

function foreignKeyCount(parsed) {
    const tableFkCount = parsed.ast.tables.reduce((count, table) => {
        return count + (table.constraints || []).filter((constraint) => constraint.kind === 'foreign').length;
    }, 0);
    const alterFkCount = parsed.ast.alters.filter((alter) => alter.action === 'add_foreign').length;
    return tableFkCount + alterFkCount;
}

function astContract(parsed) {
    return {
        tables: tableNames(parsed),
        types: typeNames(parsed),
        indexes: indexNames(parsed),
        foreignKeyCount: foreignKeyCount(parsed),
    };
}

function tableColumnMap(schema) {
    return new Map(schema.tables.map((table) => [table.name, new Set(table.columns.map((column) => column.name))]));
}

function assertRelationEndpointsResolvable(schema, label) {
    const tables = tableColumnMap(schema);

    for (const relation of schema.relations) {
        expect(tables.has(relation.from.table), `${label}:${relation.from.table}.${relation.from.column}`).toBe(true);
        expect(tables.get(relation.from.table)?.has(relation.from.column), `${label}:${relation.from.table}.${relation.from.column}`).toBe(true);
        expect(tables.has(relation.to.table), `${label}:${relation.to.table}.${relation.to.column}`).toBe(true);
        expect(tables.get(relation.to.table)?.has(relation.to.column), `${label}:${relation.to.table}.${relation.to.column}`).toBe(true);
        expect(['1', 'n', '0..1', '0..n']).toContain(relation.fromCard);
        expect(['1', '0..1']).toContain(relation.toCard);
    }
}

const baselines = new Map(
    fixtureFiles.map((fixture) => {
        const sql = fixtureSql.get(fixture);
        const parsed = parseAST(sql);
        const schema = sqlToErdSchema(sql);

        expect(parsed.errors, `${fixture}: baseline parse diagnostics`).toEqual([]);
        expect(schema._parseErrors, `${fixture}: baseline ERD diagnostics`).toEqual([]);

        return [fixture, {
            dialect: parsed.ast.dialect,
            ast: astContract(parsed),
            schema: normalizeSchema(schema),
        }];
    }),
);

describe('user SQL fixture hardening matrix', () => {
    it('keeps the production user fixture corpus at the expected size', () => {
        expect(fixtureFiles).toHaveLength(16);
    });

    it('generates around six hundred high-value fixture variants', () => {
        expect(hardeningTransforms).toHaveLength(38);
        expect(hardeningCases).toHaveLength(608);
    });

    it.each(hardeningCases)('keeps parseAST and SQL-to-ERD stable for $name', ({ fixture, transform }) => {
        const sql = fixtureSql.get(fixture);
        const transformedSql = transform.apply(sql);
        const baseline = baselines.get(fixture);
        // A wrapper can add conflicting native markers (e.g. GO around a
        // SQLite PRAGMA dump). Pin the raw export's detected dialect here so
        // these transformations test parser recovery/shape stability under the
        // same native semantics. Separate dialect tests protect auto/mixed mode.
        const options = { dialect: baseline.dialect };
        const parsed = parseAST(transformedSql, options);
        const schema = sqlToErdSchema(transformedSql, options);

        expect(parsed.errors).toEqual([]);
        expect(schema._parseErrors).toEqual([]);
        expect(astContract(parsed)).toEqual(baseline.ast);
        expect(normalizeSchema(schema)).toEqual(baseline.schema);
        expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
        assertRelationEndpointsResolvable(schema, `${fixture}:${transform.name}`);
    });
});
