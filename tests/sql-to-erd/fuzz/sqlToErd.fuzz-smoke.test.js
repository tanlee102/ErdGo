/** Seeded fuzz smoke suite proving varied SQL inputs do not crash conversion. */
import { describe, expect, it } from 'vitest';
import { parseAST } from '@/lib/parse-ast/parseAst.js';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

const dialects = [
    {
        id: 'sqlite',
        name: 'SQLite',
        q: (name) => `"${name}"`,
        idColumn: 'INTEGER PRIMARY KEY AUTOINCREMENT',
        integer: 'INTEGER',
        text: 'TEXT',
        numeric: 'REAL',
        tableTail: ' STRICT',
    },
    {
        id: 'postgres',
        name: 'PostgreSQL',
        q: (name) => `"${name}"`,
        idColumn: 'BIGSERIAL PRIMARY KEY',
        integer: 'BIGINT',
        text: 'TEXT',
        numeric: 'NUMERIC(12, 2)',
        tableTail: '',
    },
    {
        id: 'mysql',
        name: 'MySQL',
        q: (name) => `\`${name}\``,
        idColumn: 'BIGINT AUTO_INCREMENT PRIMARY KEY',
        integer: 'BIGINT',
        text: 'VARCHAR(180)',
        numeric: 'DECIMAL(12, 2)',
        tableTail: ' ENGINE=InnoDB',
    },
    {
        id: 'mssql',
        name: 'MSSQL',
        q: (name) => `[${name}]`,
        idColumn: 'BIGINT IDENTITY(1,1) PRIMARY KEY',
        integer: 'BIGINT',
        text: 'NVARCHAR(180)',
        numeric: 'DECIMAL(12, 2)',
        tableTail: '',
    },
];

const variants = [
    {
        id: 'valid',
        name: 'valid baseline',
        build: (dialect, suffix) => buildInlineFkSchema(dialect, suffix),
        clean: true,
        indexed: true,
    },
    {
        id: 'double_comma',
        name: 'double comma in child table',
        build: (dialect, suffix) => buildInlineFkSchema(dialect, suffix, { childDoubleComma: true }),
        diagnostics: [/double comma/i],
        indexed: true,
    },
    {
        id: 'trailing_parent_comma',
        name: 'trailing comma in parent table',
        build: (dialect, suffix) => buildInlineFkSchema(dialect, suffix, { parentTrailingComma: true }),
        diagnostics: [/trailing comma/i],
        indexed: true,
    },
    {
        id: 'bad_index',
        name: 'malformed index before valid index',
        build: (dialect, suffix) => buildInlineFkSchema(dialect, suffix, { malformedIndex: true }),
        diagnostics: [/column list in CREATE INDEX/i],
        indexed: true,
    },
    {
        id: 'bad_fk_target',
        name: 'invalid FK target column beside valid FK',
        build: (dialect, suffix) => buildInlineFkSchema(dialect, suffix, { badFkTarget: true }),
        diagnostics: [/missing_id/i],
        indexed: true,
    },
    {
        id: 'dangling_unique',
        name: 'dangling table-level UNIQUE',
        build: (dialect, suffix) => buildInlineFkSchema(dialect, suffix, { danglingUnique: true }),
        diagnostics: [/UNIQUE constraint missing column list/i],
        indexed: true,
    },
    {
        id: 'broken_alter',
        name: 'broken ALTER followed by valid ALTER',
        build: (dialect, suffix) => buildAlterFkSchema(dialect, suffix),
        diagnostics: [/missing REFERENCES keyword/i],
        relationFkName: (suffix) => `fk_valid_${suffix}`,
        indexedColumn: (suffix) => `child_${suffix}.parent_id`,
        indexed: true,
    },
    {
        id: 'unclosed_middle',
        name: 'unclosed middle table before valid tail table',
        build: (dialect, suffix) => buildUnclosedMiddleSchema(dialect, suffix),
        diagnostics: [/Unclosed parenthesis/i],
        relationFrom: (suffix) => `tail_${suffix}.parent_id`,
        expectedTables: (suffix) => [`parent_${suffix}`, `broken_${suffix}`, `tail_${suffix}`],
    },
];

const seeds = Array.from({ length: 5 }, (_, index) => index + 1);

const fuzzCases = dialects.flatMap((dialect) =>
    seeds.flatMap((seed) =>
        variants.map((variant) => {
            const suffix = `${dialect.id}_${seed}_${variant.id}`;
            const sql = variant.build(dialect, suffix);
            const parent = `parent_${suffix}`;
            const child = `child_${suffix}`;
            const expectedTables = variant.expectedTables ? variant.expectedTables(suffix) : [parent, child];
            const relationFrom = variant.relationFrom ? variant.relationFrom(suffix) : `${child}.parent_id`;
            const relationFkName = variant.relationFkName ? variant.relationFkName(suffix) : null;
            const relation = `${relationFkName ? `${relationFkName}:` : ''}${relationFrom}->${parent}.id`;
            const indexedColumn = variant.indexedColumn ? variant.indexedColumn(suffix) : `${child}.amount`;

            return {
                name: `${dialect.name} seed ${seed} - ${variant.name}`,
                sql,
                clean: variant.clean,
                diagnostics: variant.diagnostics || [],
                expectedTables,
                relation,
                indexedColumn: variant.indexed ? indexedColumn : null,
            };
        }),
    ),
);

function buildInlineFkSchema(dialect, suffix, options = {}) {
    const parent = `parent_${suffix}`;
    const child = `child_${suffix}`;
    const parentId = dialect.q('id');
    const childIdDefinition = `${dialect.q('id')} ${dialect.idColumn}${options.childDoubleComma ? ',' : ''}`;
    const badFkLine = options.badFkTarget
        ? `    ${dialect.q('bad_parent_id')} ${dialect.integer} REFERENCES ${dialect.q(parent)}(${dialect.q('missing_id')}),\n`
        : '';
    const danglingUnique = options.danglingUnique ? `,\n    CONSTRAINT uq_broken_${suffix} UNIQUE` : '';
    const malformedIndex = options.malformedIndex ? `\nCREATE INDEX idx_broken_${suffix} ON ${dialect.q(child)};\n` : '\n';

    return `
CREATE TABLE ${dialect.q(parent)} (
    ${parentId} ${dialect.idColumn},
    ${dialect.q('code')} ${dialect.text} NOT NULL UNIQUE,
    ${dialect.q('status')} ${dialect.text} DEFAULT 'active' CHECK (${dialect.q('status')} IN ('active', 'disabled'))${options.parentTrailingComma ? ',' : ''}
)${dialect.tableTail};

CREATE TABLE ${dialect.q(child)} (
    ${childIdDefinition},
    ${dialect.q('parent_id')} ${dialect.integer} NOT NULL REFERENCES ${dialect.q(parent)}(${parentId}),
${badFkLine}    ${dialect.q('line_no')} INT NOT NULL,
    ${dialect.q('amount')} ${dialect.numeric} DEFAULT 0 CHECK (${dialect.q('amount')} >= 0),
    CONSTRAINT uq_child_${suffix} UNIQUE (${dialect.q('parent_id')}, ${dialect.q('line_no')})${danglingUnique}
)${dialect.tableTail};
${malformedIndex}
CREATE INDEX idx_child_${suffix}_amount ON ${dialect.q(child)} (${dialect.q('amount')});
`;
}

function buildAlterFkSchema(dialect, suffix) {
    const parent = `parent_${suffix}`;
    const child = `child_${suffix}`;

    return `
CREATE TABLE ${dialect.q(parent)} (
    ${dialect.q('id')} ${dialect.idColumn},
    ${dialect.q('code')} ${dialect.text} NOT NULL UNIQUE
)${dialect.tableTail};

CREATE TABLE ${dialect.q(child)} (
    ${dialect.q('id')} ${dialect.idColumn},
    ${dialect.q('parent_id')} ${dialect.integer} NOT NULL,
    ${dialect.q('line_no')} INT NOT NULL
)${dialect.tableTail};

ALTER TABLE ${dialect.q(child)} ADD CONSTRAINT fk_broken_${suffix}
    FOREIGN KEY (${dialect.q('parent_id')} REFERENCES ${dialect.q(parent)}(${dialect.q('id')});

ALTER TABLE ${dialect.q(child)} ADD CONSTRAINT fk_valid_${suffix}
    FOREIGN KEY (${dialect.q('parent_id')}) REFERENCES ${dialect.q(parent)}(${dialect.q('id')});

CREATE INDEX idx_child_${suffix}_parent ON ${dialect.q(child)} (${dialect.q('parent_id')}, ${dialect.q('line_no')});
`;
}

function buildUnclosedMiddleSchema(dialect, suffix) {
    const parent = `parent_${suffix}`;
    const broken = `broken_${suffix}`;
    const tail = `tail_${suffix}`;

    return `
CREATE TABLE ${dialect.q(parent)} (
    ${dialect.q('id')} ${dialect.idColumn}
)${dialect.tableTail};

CREATE TABLE ${dialect.q(broken)} (
    ${dialect.q('id')} ${dialect.idColumn},
    ${dialect.q('label')} ${dialect.text},
CREATE TABLE ${dialect.q(tail)} (
    ${dialect.q('id')} ${dialect.idColumn},
    ${dialect.q('parent_id')} ${dialect.integer} REFERENCES ${dialect.q(parent)}(${dialect.q('id')})
)${dialect.tableTail};
`;
}

function assertParseShape(parsed) {
    expect(parsed).toEqual(
        expect.objectContaining({
            ast: expect.objectContaining({
                types: expect.any(Array),
                tables: expect.any(Array),
                alters: expect.any(Array),
                indexes: expect.any(Array),
            }),
            errors: expect.any(Array),
        }),
    );
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

function relationKeys(schema) {
    return schema.relations.map((relation) => {
        const prefix = relation.fkName ? `${relation.fkName}:` : '';
        return `${prefix}${relation.from.table}.${relation.from.column}->${relation.to.table}.${relation.to.column}`;
    });
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
    expect(position.index).toBeGreaterThanOrEqual(0);
    expect(position.index).toBeLessThanOrEqual(sql.length);
    if (position.index < sql.length) {
        expect(lines[position.line - 1]?.[position.column - 1]).toBeDefined();
    }
}

function assertDiagnosticPatterns(diagnostics, patterns) {
    for (const pattern of patterns) {
        expect(diagnostics.some((diagnostic) => pattern.test(diagnostic.message))).toBe(true);
    }
}

describe('SQL parser and ERD fuzz smoke', () => {
    it.each(fuzzCases)('$name', (testCase) => {
        const parsed = parseAST(testCase.sql);
        const schema = sqlToErdSchema(testCase.sql);

        assertParseShape(parsed);
        assertRenderable(schema);
        assertDiagnostics(testCase.sql, parsed.errors);
        assertDiagnostics(testCase.sql, schema._parseErrors);

        if (testCase.clean) {
            expect(parsed.errors).toEqual([]);
            expect(schema._parseErrors).toEqual([]);
        } else {
            const allDiagnostics = [...parsed.errors, ...schema._parseErrors];
            assertDiagnosticPatterns(allDiagnostics, testCase.diagnostics);
        }

        for (const tableName of testCase.expectedTables) {
            expect(schema.tables.map((table) => table.name)).toContain(tableName);
        }

        expect(relationKeys(schema)).toContain(testCase.relation);

        if (testCase.indexedColumn) {
            const [tableName, columnName] = testCase.indexedColumn.split('.');
            const table = schema.tables.find((item) => item.name === tableName);
            const column = table?.columns.find((item) => item.name === columnName);
            expect(column?.constraints).toContain('IDX');
        }
    });
});
