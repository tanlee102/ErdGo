/** Verifies conservative relationship inference and candidate scoring. */
import { describe, expect, it } from 'vitest';
import { buildInferredRelationId, inferRelationships } from '@/lib/relationshipInference.js';

function column(name, type, options = {}) {
    const constraints = [];
    if (options.pk) constraints.push('PK');
    if (options.unique) constraints.push('UQ');
    if (options.notNull) constraints.push('NN');
    return {
        name,
        type,
        constraints,
        ...(options.pk ? { pk: true } : {}),
        ...(options.compositePk ? { compositePk: true } : {}),
        ...(options.compositeUq ? { compositeUq: true } : {}),
    };
}

function schema(tables, relations = []) {
    return { enums: [], composites: [], tables, relations };
}

describe('relationship inference', () => {
    it.each([
        ['user_id', 'users'],
        ['userId', 'users'],
        ['user_id', 'user'],
        ['userAccountId', 'user_accounts'],
    ])('strongly infers %s from the %s table name', (sourceName, targetTableName) => {
        const result = inferRelationships(
            schema([
                { name: targetTableName, columns: [column('id', 'BIGINT', { pk: true })] },
                { name: 'posts', columns: [column('id', 'BIGINT', { pk: true }), column(sourceName, 'BIGINT', { notNull: true })] },
            ]),
        );

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            id: `inferred:posts.${sourceName}->${targetTableName}.id`,
            from: { table: 'posts', column: sourceName },
            to: { table: targetTableName, column: 'id' },
            fromCard: '0..n',
            toCard: '1',
            inferred: true,
            confidence: 97,
            confidenceLevel: 'high',
        });
        expect(result[0].reasons).toEqual([
            `Column name matches ${targetTableName}.id`,
            'Target column is a non-composite primary key',
            'Column types match exactly (BIGINT)',
        ]);
    });

    it('requires compatible source and target types', () => {
        const result = inferRelationships(
            schema([
                { name: 'users', columns: [column('id', 'BIGINT', { pk: true })] },
                { name: 'posts', columns: [column('user_id', 'TEXT')] },
            ]),
        );

        expect(result).toEqual([]);
    });

    it('does not suggest a source column already used by an explicit FK', () => {
        const tables = [
            { name: 'users', columns: [column('id', 'BIGINT', { pk: true })] },
            { name: 'posts', columns: [column('user_id', 'BIGINT')] },
        ];
        const relations = [
            {
                from: { table: 'posts', column: 'user_id' },
                to: { table: 'users', column: 'id' },
                fromCard: '0..n',
                toCard: '1',
            },
        ];

        expect(inferRelationships(schema(tables, relations))).toEqual([]);
    });

    it('drops a tied target instead of guessing across schemas', () => {
        const result = inferRelationships(
            schema([
                { name: 'auth.users', columns: [column('id', 'BIGINT', { pk: true })] },
                { name: 'crm.users', columns: [column('id', 'BIGINT', { pk: true })] },
                { name: 'orders', columns: [column('user_id', 'BIGINT')] },
            ]),
        );

        expect(result).toEqual([]);
    });

    it('can target a non-composite unique column', () => {
        const result = inferRelationships(
            schema([
                { name: 'countries', columns: [column('id', 'BIGINT', { pk: true }), column('code', 'VARCHAR(2)', { unique: true })] },
                { name: 'addresses', columns: [column('country_code', 'VARCHAR(2)', { notNull: true })] },
            ]),
        );

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            from: { table: 'addresses', column: 'country_code' },
            to: { table: 'countries', column: 'code' },
            confidence: 94,
            confidenceLevel: 'high',
        });
    });

    it('uses optional-many cardinality for a nullable, non-unique source', () => {
        const result = inferRelationships(
            schema([
                { name: 'users', columns: [column('id', 'INTEGER', { pk: true })] },
                { name: 'posts', columns: [column('user_id', 'INT')] },
            ]),
        );

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ fromCard: '0..n', toCard: '0..1', confidence: 92, confidenceLevel: 'high' });
        expect(result[0].reasons).toContain('Column types are compatible (INT and INTEGER)');
    });

    it('builds schema-qualified stable IDs and returns deterministic ordering', () => {
        const firstSchema = schema([
            { name: 'sales.orders', columns: [column('customer_id', 'BIGINT'), column('account_id', 'BIGINT')] },
            { name: 'sales.customers', columns: [column('id', 'BIGINT', { pk: true })] },
            { name: 'sales.accounts', columns: [column('id', 'BIGINT', { pk: true })] },
        ]);
        const reorderedSchema = schema([...firstSchema.tables].reverse());

        const first = inferRelationships(firstSchema);
        const reordered = inferRelationships(reorderedSchema);

        expect(first).toEqual(reordered);
        expect(first.map((relation) => relation.id)).toEqual([
            'inferred:sales.orders.account_id->sales.accounts.id',
            'inferred:sales.orders.customer_id->sales.customers.id',
        ]);
        expect(
            buildInferredRelationId(
                { table: 'sales.orders', column: 'customer_id' },
                { table: 'sales.customers', column: 'id' },
            ),
        ).toBe('inferred:sales.orders.customer_id->sales.customers.id');
    });

    it('does not infer from a generic id or to a composite key', () => {
        const result = inferRelationships(
            schema([
                {
                    name: 'tenants',
                    columns: [
                        column('region_id', 'BIGINT', { pk: true, compositePk: true }),
                        column('tenant_id', 'BIGINT', { pk: true, compositePk: true }),
                    ],
                },
                { name: 'events', columns: [column('id', 'BIGINT'), column('tenant_id', 'BIGINT')] },
            ]),
        );

        expect(result).toEqual([]);
    });

    it('requires a table-name signal for self references', () => {
        const result = inferRelationships(
            schema([
                {
                    name: 'employees',
                    columns: [column('id', 'BIGINT', { pk: true }), column('manager_id', 'BIGINT'), column('employee_id', 'BIGINT')],
                },
            ]),
        );

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            from: { table: 'employees', column: 'employee_id' },
            to: { table: 'employees', column: 'id' },
        });
    });
});
