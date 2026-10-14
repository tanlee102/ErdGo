/** Runs a broad matrix of edge-case schemas through SQL-to-ERD conversion. */
import { describe, expect, it } from 'vitest';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

function table(schema, name) {
    return schema.tables.find((entry) => entry.name === name);
}

function column(schema, tableName, columnName) {
    return table(schema, tableName)?.columns.find((entry) => entry.name === columnName);
}

const sourceModes = [
    { name: 'nullable many', declaration: 'parent_id INT', fromCard: '0..n', toCard: '0..1' },
    { name: 'not-null many', declaration: 'parent_id INT NOT NULL', fromCard: '0..n', toCard: '1' },
    { name: 'nullable unique', declaration: 'parent_id INT UNIQUE', fromCard: '0..1', toCard: '0..1' },
    { name: 'not-null unique', declaration: 'parent_id INT UNIQUE NOT NULL', fromCard: '0..1', toCard: '1' },
    { name: 'primary key', declaration: 'parent_id INT PRIMARY KEY', fromCard: '0..1', toCard: '1' },
];

const relationStyles = [
    {
        name: 'inline foreign key',
        childColumn: (mode, parentName) => `${mode.declaration} REFERENCES ${parentName}(id)`,
        childConstraint: () => '',
        alter: () => '',
        fkName: null,
    },
    {
        name: 'named table foreign key',
        childColumn: (mode) => mode.declaration,
        childConstraint: (fkName, parentName) => `, CONSTRAINT ${fkName} FOREIGN KEY (parent_id) REFERENCES ${parentName}(id)`,
        alter: () => '',
        fkName: (id) => `fk_edge_${id}`,
    },
    {
        name: 'unnamed table foreign key',
        childColumn: (mode) => mode.declaration,
        childConstraint: (_fkName, parentName) => `, FOREIGN KEY (parent_id) REFERENCES ${parentName}(id)`,
        alter: () => '',
        fkName: null,
    },
    {
        name: 'alter foreign key',
        childColumn: (mode) => mode.declaration,
        childConstraint: () => '',
        alter: (fkName, parentName, childName) => `ALTER TABLE ${childName} ADD CONSTRAINT ${fkName} FOREIGN KEY (parent_id) REFERENCES ${parentName}(id);`,
        fkName: (id) => `fk_edge_${id}`,
    },
];

const variants = [
    {
        name: 'default and check extras',
        prelude: () => '',
        parentExtra: () => `, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled'))`,
        childExtra: () => `, note TEXT DEFAULT 'new', amount NUMERIC CHECK (amount >= 0)`,
        trailer: ({ childName }) => `CREATE INDEX idx_${childName}_note ON ${childName} (note);`,
        assert(schema, childName) {
            expect(column(schema, childName, 'note').constraints).toContain('IDX');
            expect(column(schema, childName, 'amount').extras.join(' ')).toContain('CHECK');
        },
    },
    {
        name: 'enum type normalization',
        prelude: ({ id }) => `CREATE TYPE edge_state_${id} AS ENUM ('new', 'done');`,
        parentExtra: ({ id }) => `, state edge_state_${id} NOT NULL DEFAULT 'new'`,
        childExtra: ({ id }) => `, state edge_state_${id} DEFAULT 'done'`,
        trailer: () => '',
        assert(schema, childName, id) {
            expect(schema.enums).toContainEqual({ name: `edge_state_${id}`, values: ['new', 'done'] });
            expect(column(schema, childName, 'state').type).toBe(`edge_state_${id}`);
        },
    },
    {
        name: 'composite type normalization',
        prelude: ({ id }) => `CREATE TYPE edge_money_${id} AS (amount NUMERIC(10,2), currency TEXT);`,
        parentExtra: ({ id }) => `, budget edge_money_${id}`,
        childExtra: ({ id }) => `, cost edge_money_${id}`,
        trailer: () => '',
        assert(schema, childName, id) {
            expect(schema.composites[0].name).toBe(`edge_money_${id}`);
            expect(column(schema, childName, 'cost').type).toBe(`edge_money_${id}`);
        },
    },
    {
        name: 'generated stored column',
        prelude: () => '',
        parentExtra: () => `, code TEXT NOT NULL UNIQUE`,
        childExtra: () => `, label TEXT, label_key TEXT GENERATED ALWAYS AS (lower(label)) STORED`,
        trailer: () => '',
        assert(schema, childName) {
            expect(column(schema, childName, 'label_key').extras.join(' ')).toContain('GENERATED ALWAYS AS');
        },
    },
    {
        name: 'named table check',
        prelude: () => '',
        parentExtra: () => `, code TEXT`,
        childExtra: ({ id }) => `, score INT, CONSTRAINT chk_edge_score_${id} CHECK (score >= 0)`,
        trailer: () => '',
        assert(schema, childName, id) {
            expect(column(schema, childName, 'score').extras).toContain(`chk_edge_score_${id}: CHECK (score >= 0)`);
        },
    },
    {
        name: 'composite unique source flag',
        prelude: () => '',
        parentExtra: () => `, code TEXT`,
        childExtra: () => `, label TEXT, UNIQUE (parent_id, label)`,
        trailer: () => '',
        expectedCard(mode) {
            if (mode.name === 'nullable unique') return '0..n';
            if (mode.name === 'not-null unique') return '0..n';
            return mode.fromCard;
        },
        assert(schema, childName) {
            expect(column(schema, childName, 'parent_id').compositeUq).toBe(true);
        },
    },
    {
        name: 'composite index flag',
        prelude: () => '',
        parentExtra: () => `, code TEXT`,
        childExtra: () => `, label TEXT`,
        trailer: ({ childName }) => `CREATE INDEX idx_${childName}_parent_label ON ${childName} (parent_id, label);`,
        assert(schema, childName) {
            const parentId = column(schema, childName, 'parent_id');
            if (parentId.pk || parentId.constraints.includes('UQ')) {
                expect(parentId.compositeIdx).toBeFalsy();
            } else {
                expect(parentId.compositeIdx).toBe(true);
            }
        },
    },
    {
        name: 'single-column unique index badge',
        prelude: () => '',
        parentExtra: () => `, code TEXT`,
        childExtra: () => `, slug TEXT`,
        trailer: ({ childName }) => `CREATE UNIQUE INDEX uq_${childName}_slug ON ${childName} (slug);`,
        assert(schema, childName) {
            expect(column(schema, childName, 'slug').constraints).toContain('UQ');
        },
    },
    {
        name: 'schema-qualified names',
        prelude: () => '',
        qualify: (name, id) => `tenant_${id}.${name}`,
        parentExtra: () => `, code TEXT`,
        childExtra: () => `, label TEXT NOT NULL`,
        trailer: () => '',
        assert(schema, childName) {
            expect(table(schema, childName)).toBeTruthy();
        },
    },
    {
        name: 'comments and ignored ddl',
        prelude: () => `-- migration comment\nCREATE VIEW ignored_edge_view AS SELECT 1;`,
        parentExtra: () => `, code TEXT`,
        childExtra: () => `, label TEXT NOT NULL DEFAULT 'edge'`,
        trailer: () => `CREATE SCHEMA ignored_edge_schema;`,
        assert(schema, childName) {
            expect(column(schema, childName, 'label').constraints).toContain('NN');
        },
    },
];

const cases = variants.flatMap((variant, variantIndex) =>
    relationStyles.flatMap((style, styleIndex) =>
        sourceModes.map((mode, modeIndex) => {
            const id = `${variantIndex}_${styleIndex}_${modeIndex}`;
            const parentBase = `edge_parent_${id}`;
            const childBase = `edge_child_${id}`;
            const parentName = variant.qualify ? variant.qualify(parentBase, id) : parentBase;
            const childName = variant.qualify ? variant.qualify(childBase, id) : childBase;
            const expectedParent = parentBase;
            const expectedChild = childBase;
            const fkName = style.fkName ? style.fkName(id) : null;
            const childColumn = style.childColumn(mode, parentName);
            const childConstraint = style.childConstraint(fkName, parentName);
            return {
                name: `${variant.name} - ${style.name} - ${mode.name}`,
                expectedChild,
                expectedParent,
                expectedCard: variant.expectedCard ? variant.expectedCard(mode) : mode.fromCard,
                expectedToCard: mode.toCard,
                fkName,
                sql: `
                    ${variant.prelude({ id })}
                    CREATE TABLE ${parentName} (
                        id INT PRIMARY KEY
                        ${variant.parentExtra({ id })}
                    );
                    CREATE TABLE ${childName} (
                        local_id INT,
                        ${childColumn}
                        ${variant.childExtra({ id })}
                        ${childConstraint}
                    );
                    ${style.alter(fkName, parentName, childName)}
                    ${variant.trailer({ id, parentName, childName })}
                `,
                assert: variant.assert,
                id,
            };
        }),
    ),
);

describe('sqlToErdSchema generated edge matrix', () => {
    it.each(cases)('$name', ({ sql, expectedChild, expectedParent, expectedCard, expectedToCard, fkName, assert, id }) => {
        const schema = sqlToErdSchema(sql);
        const relation = schema.relations.find((entry) => entry.from.table === expectedChild && entry.from.column === 'parent_id');

        expect(schema._parseErrors).toEqual([]);
        expect(table(schema, expectedParent)).toBeTruthy();
        expect(table(schema, expectedChild)).toBeTruthy();
        expect(relation).toMatchObject({
            from: { table: expectedChild, column: 'parent_id' },
            to: { table: expectedParent, column: 'id' },
            fromCard: expectedCard,
            toCard: expectedToCard,
        });
        if (fkName) expect(relation.fkName).toBe(fkName);
        else expect(relation.fkName).toBeUndefined();
        expect(column(schema, expectedChild, 'parent_id').fk).toBe(true);
        assert(schema, expectedChild, id);
    });
});
