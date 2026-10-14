/** Locks renderer output for representative production-style schemas. */
import { describe, expect, it } from 'vitest';
import { sampleDataSQL, sampleSchemaSQL, sampleSQL } from '@/features/editor/lib/sampleSQL.js';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

function column(schema, tableName, columnName) {
    const table = schema.tables.find((entry) => entry.name === tableName);
    return table?.columns.find((entry) => entry.name === columnName);
}

function relationKey(relation) {
    return `${relation.from.table}.${relation.from.column}->${relation.to.table}.${relation.to.column}`;
}

describe('Production sample SQL golden signature', () => {
    it('keeps the complete AI workspace comfortably below the server limit', () => {
        expect(sampleSQL.length).toBeLessThan(7000);
    });

    it('keeps schema and sample data as separate scripts', () => {
        expect(sampleSchemaSQL).toContain('CREATE TABLE users');
        expect(sampleSchemaSQL).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+INTO?\b/i);
        expect(sampleDataSQL).toContain('INSERT INTO users');
        expect(sampleDataSQL).toContain('UPDATE products');
        expect(sampleDataSQL).toContain('DELETE FROM orders');
        expect(sampleDataSQL).not.toMatch(/\bCREATE\s+(?:TABLE|TYPE|INDEX)\b/i);
        expect(sampleSQL).toBe(sampleSchemaSQL + sampleDataSQL);
    });

    it('locks the compact client-facing showcase shape', () => {
        const schema = sqlToErdSchema(sampleSQL);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.tables.map((table) => table.name)).toEqual([
            'users',
            'categories',
            'products',
            'orders',
            'order_items',
        ]);
        expect(schema.enums.map((entry) => `${entry.name}:${entry.values.join('|')}`)).toEqual([
            'order_status:cart|paid|shipped|cancelled',
            'role_enum:admin|member',
            'flags_set:newsletter|beta',
        ]);

        expect(column(schema, 'users', 'display_name')).toBeUndefined();
        expect(column(schema, 'users', 'full_name')).toBeDefined();
        expect(column(schema, 'users', 'last_seen_at')).toBeDefined();
        expect(column(schema, 'products', 'retired_at')).toBeUndefined();
        expect(column(schema, 'orders', 'coupon_code')).toBeUndefined();
        expect(column(schema, 'orders', 'promotion_code')).toBeDefined();

        expect(column(schema, 'products', 'search_label').extras).toContain(
            "GENERATED ALWAYS AS (CONCAT(sku, ' - ', name)) STORED",
        );
        expect(column(schema, 'order_items', 'line_total').extras).toContain(
            'GENERATED ALWAYS AS (quantity * unit_price) STORED',
        );

        expect(schema.relations.map(relationKey).sort()).toEqual([
            'categories.parent_id->categories.id',
            'order_items.order_id->orders.id',
            'order_items.product_id->products.id',
            'orders.customer_id->users.id',
            'products.category_id->categories.id',
        ]);
    });

    it('keeps representative PK, UQ, PUQ, and IDX badges', () => {
        const schema = sqlToErdSchema(sampleSQL);

        expect(column(schema, 'users', 'email').constraints).toContain('PUQ');
        expect(column(schema, 'users', 'email').constraints).not.toContain('UQ');
        expect(column(schema, 'users', 'role').constraints).toContain('IDX');
        expect(column(schema, 'categories', 'name').constraints).toContain('UQ');
        expect(column(schema, 'products', 'sku').constraints).toContain('UQ');
        expect(column(schema, 'products', 'category_id').compositeIdx).toBe(true);
        expect(column(schema, 'products', 'price').compositeIdx).toBe(true);
        expect(column(schema, 'order_items', 'order_id').constraints).toContain('PK');
        expect(column(schema, 'order_items', 'product_id').constraints).toContain('PK');
    });
});
