/** Ensures documented SQL examples remain accepted by the production converter. */
import { describe, expect, it } from 'vitest';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';
import {
    docsProductionSyntaxExamples,
    erdSemanticResolutionExample,
    mssqlAlterReplayExample,
    mysqlAlterReplayExample,
    partialUniqueIndexExample,
    sqliteAlterReplayExample,
} from '@/content/docs/sqlSyntaxExamples.js';

function table(schema, name) {
    return schema.tables.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
}

function column(schema, tableName, columnName) {
    return table(schema, tableName)?.columns.find((entry) => entry.name.toLowerCase() === columnName.toLowerCase());
}

function relation(schema, fromTable, fromColumn) {
    return schema.relations.find(
        (entry) =>
            entry.from.table.toLowerCase() === fromTable.toLowerCase() &&
            entry.from.column.toLowerCase() === fromColumn.toLowerCase(),
    );
}

function assertNoDanglingRelations(schema) {
    const tableColumns = new Map(schema.tables.map((entry) => [entry.name.toLowerCase(), new Set(entry.columns.map((col) => col.name.toLowerCase()))]));
    schema.relations.forEach((entry) => {
        expect(tableColumns.get(entry.from.table.toLowerCase())?.has(entry.from.column.toLowerCase()), `${entry.from.table}.${entry.from.column}`).toBe(true);
        expect(tableColumns.get(entry.to.table.toLowerCase())?.has(entry.to.column.toLowerCase()), `${entry.to.table}.${entry.to.column}`).toBe(true);
    });
}

describe('documented SQL-to-ERD syntax examples', () => {
    it.each(docsProductionSyntaxExamples.map((sql, index) => [`docs example ${index + 1}`, sql]))('%s parses without ERD errors or dangling relations', (_name, sql) => {
        const schema = sqlToErdSchema(sql);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.tables.length).toBeGreaterThan(0);
        assertNoDanglingRelations(schema);
    });

    it('documents semantic FK resolution, schema-aware types, FK actions, ALTER replay, and unique-index validation', () => {
        const schema = sqlToErdSchema(erdSemanticResolutionExample);

        expect(schema.enums).toEqual([{ name: 'ticket_status', values: ['new', 'open', 'closed'] }]);
        expect(column(schema, 'accounts', 'status')).toMatchObject({ type: 'ticket_status', constraints: ['NN'] });
        expect(column(schema, 'contacts', 'contact_email')).toMatchObject({
            type: 'VARCHAR(320)',
            constraints: ['NN', 'UQ'],
        });
        expect(column(schema, 'contacts', 'audit_state')).toBeUndefined();
        expect(relation(schema, 'contacts', 'tenant_id')).toMatchObject({
            fkName: 'fk_contacts_account',
            to: { table: 'accounts', column: 'tenant_id' },
            fromColumns: ['tenant_id', 'account_no'],
            toColumns: ['tenant_id', 'account_no'],
            composite: true,
            actions: { onDelete: 'CASCADE', deferrable: true, initially: 'DEFERRED' },
        });
    });

    it('documents MySQL UNIQUE INDEX, CHANGE COLUMN, MODIFY COLUMN, inline ENUM, and FK actions', () => {
        const schema = sqlToErdSchema(mysqlAlterReplayExample);

        expect(column(schema, 'customers', 'email').constraints).toContain('UQ');
        expect(column(schema, 'orders', 'note')).toMatchObject({ type: 'VARCHAR(255)', constraints: ['NN'] });
        expect(column(schema, 'orders', 'status')).toMatchObject({
            type: 'status_enum',
            extras: ["DEFAULT 'paid'"],
        });
        expect(relation(schema, 'orders', 'customer_email')).toMatchObject({
            to: { table: 'customers', column: 'email' },
            actions: { onDelete: 'SET NULL' },
        });
    });

    it('documents SQL Server ALTER COLUMN and ADD column replay', () => {
        const schema = sqlToErdSchema(mssqlAlterReplayExample);

        expect(column(schema, 'Customers', 'CustomerID')).toMatchObject({ pk: true, autoIncrement: true });
        expect(column(schema, 'Orders', 'LegacyNote')).toMatchObject({ type: 'NVARCHAR(255)', constraints: ['NN'] });
        expect(column(schema, 'Orders', 'CreatedAt')).toMatchObject({
            type: 'DATETIME2',
            constraints: ['NN'],
            extras: ["DEFAULT '2026-01-01'"],
        });
        expect(relation(schema, 'Orders', 'CustomerEmail')).toMatchObject({
            to: { table: 'Customers', column: 'Email' },
            actions: { onDelete: 'SET NULL' },
        });
    });

    it('documents SQLite STRICT/WITHOUT ROWID, FK actions, and rename replay', () => {
        const schema = sqlToErdSchema(sqliteAlterReplayExample);

        expect(schema.tables.map((entry) => entry.name).sort()).toEqual(['posts', 'writers']);
        expect(column(schema, 'posts', 'excerpt')).toMatchObject({ type: 'TEXT' });
        expect(relation(schema, 'posts', 'author_id')).toMatchObject({
            to: { table: 'writers', column: 'id' },
            actions: { onDelete: 'CASCADE', onUpdate: 'RESTRICT' },
        });
    });

    it('documents partial unique index semantics separately from global FK validation', () => {
        const schema = sqlToErdSchema(partialUniqueIndexExample);

        expect(schema._parseErrors).toEqual([]);
        expect(column(schema, 'users', 'email')).toMatchObject({
            constraints: ['NN', 'PUQ'],
            extras: ['PARTIAL UNIQUE INDEX ux_users_active_email WHERE deleted_at IS NULL'],
        });
        expect(relation(schema, 'login_events', 'user_id')).toMatchObject({
            to: { table: 'users', column: 'id' },
            actions: { onDelete: 'CASCADE' },
        });
    });
});
