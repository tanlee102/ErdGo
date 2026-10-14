/** Runs a broad parser matrix of rare but valid SQL forms. */
import { describe, expect, it } from 'vitest';
import { parseAST } from '@/lib/parse-ast/parseAst.js';

function parse(sql) {
    return parseAST(sql);
}

function stripSchema(name) {
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1) : name;
}

function table(parsed, name) {
    return parsed.ast.tables.find((entry) => stripSchema(entry.name).toLowerCase() === name.toLowerCase());
}

function column(parsed, tableName, columnName) {
    return table(parsed, tableName)?.columns.find((entry) => entry.name.toLowerCase() === columnName.toLowerCase());
}

function q(identifier, style) {
    if (style === 'double') return `"${identifier}"`;
    if (style === 'backtick') return `\`${identifier}\``;
    if (style === 'bracket') return `[${identifier}]`;
    return identifier;
}

const typeSpecs = [
    ['INT', 'INT'],
    ['INTEGER', 'INTEGER'],
    ['BIGINT', 'BIGINT'],
    ['SMALLINT', 'SMALLINT'],
    ['TINYINT', 'TINYINT'],
    ['MEDIUMINT', 'MEDIUMINT'],
    ['SERIAL', 'SERIAL'],
    ['BIGSERIAL', 'BIGSERIAL'],
    ['SMALLSERIAL', 'SMALLSERIAL'],
    ['UUID', 'UUID'],
    ['TEXT', 'TEXT'],
    ['LONGTEXT', 'LONGTEXT'],
    ['MEDIUMTEXT', 'MEDIUMTEXT'],
    ['CLOB', 'CLOB'],
    ['NCLOB', 'NCLOB'],
    ['VARCHAR(255)', 'VARCHAR(255)'],
    ['VARCHAR(MAX)', 'VARCHAR(MAX)'],
    ['CHAR(8)', 'CHAR(8)'],
    ['NCHAR(8)', 'NCHAR(8)'],
    ['NVARCHAR(120)', 'NVARCHAR(120)'],
    ['NVARCHAR(MAX)', 'NVARCHAR(MAX)'],
    ['BOOLEAN', 'BOOLEAN'],
    ['BOOL', 'BOOL'],
    ['DATE', 'DATE'],
    ['TIME', 'TIME'],
    ['TIMESTAMP', 'TIMESTAMP'],
    ['TIMESTAMPTZ', 'TIMESTAMPTZ'],
    ['DATETIME', 'DATETIME'],
    ['INTERVAL', 'INTERVAL'],
    ['NUMERIC(10,2)', 'NUMERIC(10, 2)'],
    ['DECIMAL(12,4)', 'DECIMAL(12, 4)'],
    ['DOUBLE PRECISION', 'DOUBLE PRECISION'],
    ['FLOAT', 'FLOAT'],
    ['REAL', 'REAL'],
    ['MONEY', 'MONEY'],
    ['JSON', 'JSON'],
    ['JSONB', 'JSONB'],
    ['XML', 'XML'],
    ['BYTEA', 'BYTEA'],
    ['BLOB', 'BLOB'],
    ['VARBINARY(16)', 'VARBINARY(16)'],
    ['BINARY(16)', 'BINARY(16)'],
    ['UNIQUEIDENTIFIER', 'UNIQUEIDENTIFIER'],
    ['IMAGE', 'IMAGE'],
    ['INET', 'INET'],
    ['CIDR', 'CIDR'],
    ['MACADDR', 'MACADDR'],
    ['TSVECTOR', 'TSVECTOR'],
    ['GEOGRAPHY', 'GEOGRAPHY'],
    ['GEOMETRY', 'GEOMETRY'],
];

const typeCases = typeSpecs.map(([sqlType, expectedType], index) => ({
    name: `type ${sqlType}`,
    sql: `CREATE TABLE type_case_${index} (id INT PRIMARY KEY, payload ${sqlType});`,
    assert(parsed) {
        expect(parsed.errors).toEqual([]);
        expect(column(parsed, `type_case_${index}`, 'payload').type).toBe(expectedType);
    },
}));

const identifierStyles = ['plain', 'double', 'backtick', 'bracket', 'plain'];
const constraintTemplates = [
    {
        label: 'primary key',
        body: ({ tableName, colName, style }) => `CREATE TABLE ${q(tableName, style)} (${q(colName, style)} INT PRIMARY KEY);`,
        assert: (parsed, tableName, colName) => expect(column(parsed, tableName, colName).primary).toBe(true),
    },
    {
        label: 'unique not-null default',
        body: ({ tableName, colName, style }) => `CREATE TABLE ${q(tableName, style)} (${q(colName, style)} TEXT UNIQUE NOT NULL DEFAULT 'edge');`,
        assert: (parsed, tableName, colName) => {
            const col = column(parsed, tableName, colName);
            expect(col.unique).toBe(true);
            expect(col.notNull).toBe(true);
            expect(col.default).toBe("'edge'");
        },
    },
    {
        label: 'numeric check',
        body: ({ tableName, colName, style }) => `CREATE TABLE ${q(tableName, style)} (${q(colName, style)} INT CHECK (${q(colName, style)} >= 0));`,
        assert: (parsed, tableName, colName) => expect(column(parsed, tableName, colName).check).toContain('>= 0'),
    },
    {
        label: 'inline reference',
        body: ({ tableName, colName, style }) => `
            CREATE TABLE ${q(`parent_${tableName}`, style)} (${q('id', style)} INT PRIMARY KEY);
            CREATE TABLE ${q(tableName, style)} (${q(colName, style)} INT REFERENCES ${q(`parent_${tableName}`, style)}(${q('id', style)}));
        `,
        assert: (parsed, tableName, colName) => expect(column(parsed, tableName, colName).references.table).toBe(`parent_${tableName}`),
    },
    {
        label: 'default current timestamp',
        body: ({ tableName, colName, style }) => `CREATE TABLE ${q(tableName, style)} (${q(colName, style)} TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
        assert: (parsed, tableName, colName) => expect(column(parsed, tableName, colName).default).toBe('CURRENT_TIMESTAMP'),
    },
    {
        label: 'escaped string default',
        body: ({ tableName, colName, style }) => `CREATE TABLE ${q(tableName, style)} (${q(colName, style)} TEXT DEFAULT 'it''s ok');`,
        assert: (parsed, tableName, colName) => expect(column(parsed, tableName, colName).default).toBe("'it''s ok'"),
    },
    {
        label: 'postgres generated column',
        body: ({ tableName, colName, style }) => `
            CREATE TABLE ${q(tableName, style)} (
                raw_value TEXT,
                ${q(colName, style)} TEXT GENERATED ALWAYS AS (lower(raw_value)) STORED
            );
        `,
        assert: (parsed, tableName, colName) => {
            expect(column(parsed, tableName, colName).generated).toBe('GENERATED ALWAYS AS (lower(raw_value)) STORED');
        },
    },
    {
        label: 'mssql computed persisted',
        body: ({ tableName, colName, style }) => `
            CREATE TABLE ${q(tableName, style)} (
                price DECIMAL(10,2),
                qty INT,
                ${q(colName, style)} AS (price * qty) PERSISTED
            );
        `,
        assert: (parsed, tableName, colName) => {
            expect(column(parsed, tableName, colName)).toMatchObject({
                type: 'COMPUTED',
                generated: 'AS (price * qty) PERSISTED',
            });
        },
    },
    {
        label: 'boolean default false',
        body: ({ tableName, colName, style }) => `CREATE TABLE ${q(tableName, style)} (${q(colName, style)} BOOLEAN NOT NULL DEFAULT FALSE);`,
        assert: (parsed, tableName, colName) => {
            const col = column(parsed, tableName, colName);
            expect(col.notNull).toBe(true);
            expect(col.default).toBe('FALSE');
        },
    },
    {
        label: 'table-level composite primary key',
        body: ({ tableName, colName, style }) => `
            CREATE TABLE ${q(tableName, style)} (
                tenant_id INT,
                ${q(colName, style)} INT,
                PRIMARY KEY (tenant_id, ${q(colName, style)})
            );
        `,
        assert: (parsed, tableName) => {
            const constraints = table(parsed, tableName).constraints;
            expect(constraints[0]).toMatchObject({ kind: 'primary', columns: ['tenant_id', 'edge_col'] });
        },
    },
];

const constraintCases = constraintTemplates.flatMap((template, templateIndex) =>
    identifierStyles.map((style, styleIndex) => {
        const tableName = `constraint_${templateIndex}_${styleIndex}`;
        const colName = 'edge_col';
        return {
            name: `${template.label} with ${style} identifiers`,
            sql: template.body({ tableName, colName, style }),
            assert(parsed) {
                expect(parsed.errors).toEqual([]);
                template.assert(parsed, tableName, colName);
            },
        };
    }),
);

const indexTemplates = [
    ({ tableName, indexName }) => `CREATE INDEX ${indexName} ON ${tableName} (code);`,
    ({ tableName, indexName }) => `CREATE UNIQUE INDEX ${indexName} ON ${tableName} (code);`,
    ({ tableName, indexName }) => `CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName} (code);`,
    ({ tableName, indexName }) => `CREATE INDEX ${indexName} ON ${tableName} (code, created_at);`,
    ({ tableName, indexName }) => `CREATE INDEX ${indexName} ON ${tableName} USING btree (code);`,
    ({ tableName, indexName }) => `CREATE INDEX ${indexName} ON ${tableName} (code) WHERE code IS NOT NULL;`,
    ({ tableName, indexName }) => `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${indexName} ON ONLY ${tableName} USING btree (code ASC);`,
    ({ tableName, indexName }) => `CREATE NONCLUSTERED INDEX ${indexName} ON ${tableName} (code);`,
    ({ tableName, indexName }) => `CREATE CLUSTERED INDEX ${indexName} ON ${tableName} (code);`,
    ({ tableName, indexName }) => `CREATE INDEX ${indexName} ON ${tableName} ((lower(code)), created_at);`,
];

const indexCases = indexTemplates.flatMap((template, templateIndex) =>
    Array.from({ length: 5 }, (_, variantIndex) => {
        const tableName = `index_case_${templateIndex}_${variantIndex}`;
        const indexName = `idx_${templateIndex}_${variantIndex}`;
        return {
            name: `index syntax ${templateIndex + 1}.${variantIndex + 1}`,
            sql: `
                CREATE TABLE ${tableName} (id INT PRIMARY KEY, code TEXT, created_at TIMESTAMP);
                ${template({ tableName, indexName })}
            `,
            assert(parsed) {
                expect(parsed.errors.filter((error) => error.severity === 'error')).toEqual([]);
                expect(parsed.ast.indexes[0]).toMatchObject({
                    name: indexName,
                    table: tableName,
                });
                expect(parsed.ast.indexes[0].columns.length + parsed.ast.indexes[0].expressions.length).toBeGreaterThan(0);
            },
        };
    }),
);

const toleranceTemplates = [
    ({ tableName }) => `-- leading comment\nCREATE TABLE ${tableName} (id INT PRIMARY KEY);`,
    ({ tableName }) => `/* block comment */\nCREATE TABLE ${tableName} (id INT PRIMARY KEY);`,
    ({ tableName }) => `CREATE VIEW ignored_${tableName} AS SELECT 1;\nCREATE TABLE ${tableName} (id INT PRIMARY KEY);`,
    ({ tableName }) => `DROP TABLE ignored_${tableName};\nCREATE TABLE ${tableName} (id INT PRIMARY KEY);`,
    ({ tableName }) => `CREATE SCHEMA ignored_${tableName};\nCREATE TABLE ${tableName} (id INT PRIMARY KEY);`,
    ({ tableName }) => `CREATE TABLE before_${tableName} (id INT PRIMARY KEY);\nGO\nCREATE TABLE ${tableName} (id INT PRIMARY KEY);`,
    ({ tableName }) => `\n\n\tCREATE TABLE ${tableName} (id INT PRIMARY KEY);\n\n`,
    ({ tableName }) => `CREATE TABLE public.${tableName} (id INT PRIMARY KEY);`,
    ({ tableName }) => `CREATE TABLE "${tableName}" ("select" INT, "from" TEXT);`,
    ({ tableName }) => `CREATE TABLE ${tableName} (id INT PRIMARY KEY);;;;`,
];

const toleranceCases = toleranceTemplates.flatMap((template, templateIndex) =>
    Array.from({ length: 5 }, (_, variantIndex) => {
        const tableName = `tolerated_${templateIndex}_${variantIndex}`;
        return {
            name: `tolerates surrounding SQL ${templateIndex + 1}.${variantIndex + 1}`,
            sql: template({ tableName }),
            assert(parsed) {
                expect(parsed.errors).toEqual([]);
                expect(table(parsed, tableName)).toBeTruthy();
            },
        };
    }),
);

const cases = [...typeCases, ...constraintCases, ...indexCases, ...toleranceCases];

describe('parseAST generated edge matrix', () => {
    it.each(cases)('$name', ({ sql, assert }) => {
        assert(parse(sql));
    });
});
