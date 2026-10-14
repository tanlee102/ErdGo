/** Runs a broad matrix of unusual Data View expressions and mutations. */
import { describe, expect, it } from 'vitest';
import { createSqlExecutor } from '@/features/data-view/lib/sqlExecutor.js';

function exec(sql) {
    const result = createSqlExecutor().execute(sql);
    return {
        ...result,
        table(name) {
            for (const table of result.tables.values()) {
                if (table.name.toLowerCase() === name.toLowerCase()) return table;
            }
            return null;
        },
        warnings() {
            return result.log.filter((entry) => entry.type === 'warning');
        },
        errors() {
            return result.log.filter((entry) => entry.type === 'error');
        },
    };
}

const insertDefaultCases = Array.from({ length: 70 }, (_, index) => {
    const bool = index % 2 === 0 ? 'TRUE' : 'FALSE';
    const expectedFlag = index % 2 === 0;
    return {
        name: `applies omitted-column defaults ${index}`,
        sql: `
            CREATE TABLE edge_insert_${index} (
                id INT PRIMARY KEY,
                label TEXT NOT NULL DEFAULT 'label_${index}',
                qty INT DEFAULT ${index},
                flag BOOLEAN DEFAULT ${bool}
            );
            INSERT INTO edge_insert_${index} (id) VALUES (${index + 1});
        `,
        assert(result) {
            const row = result.table(`edge_insert_${index}`).rows[0];
            expect(row).toMatchObject({
                id: index + 1,
                label: `label_${index}`,
                qty: index,
                flag: expectedFlag,
            });
            expect(result.errors()).toEqual([]);
        },
    };
});

const updatePredicates = [
    { sql: 'qty = 2', matches: (row) => row.qty === 2 },
    { sql: 'qty != 2', matches: (row) => row.qty !== 2 },
    { sql: 'qty <> 2', matches: (row) => row.qty !== 2 },
    { sql: 'qty < 3', matches: (row) => row.qty < 3 },
    { sql: 'qty <= 3', matches: (row) => row.qty <= 3 },
    { sql: 'qty > 3', matches: (row) => row.qty > 3 },
    { sql: 'qty >= 3', matches: (row) => row.qty >= 3 },
    { sql: 'qty IN (1, 3, 5)', matches: (row) => [1, 3, 5].includes(row.qty) },
    { sql: 'qty NOT IN (1, 3, 5)', matches: (row) => ![1, 3, 5].includes(row.qty) },
    { sql: 'qty BETWEEN 2 AND 4', matches: (row) => row.qty >= 2 && row.qty <= 4 },
    { sql: 'qty NOT BETWEEN 2 AND 4', matches: (row) => row.qty < 2 || row.qty > 4 },
    { sql: "label LIKE 'row_%'", matches: () => true },
    { sql: "label NOT LIKE 'row_1'", matches: (row) => row.label !== 'row_1' },
];

const baseRows = Array.from({ length: 6 }, (_, index) => ({
    id: index + 1,
    qty: index,
    label: `row_${index}`,
}));

function seedRows() {
    return baseRows.map((row) => `(${row.id}, ${row.qty}, '${row.label}', 'keep')`).join(', ');
}

const updateCases = Array.from({ length: 65 }, (_, index) => {
    const predicate = updatePredicates[index % updatePredicates.length];
    const tableName = `edge_update_${index}`;
    return {
        name: `updates rows with predicate ${index}`,
        sql: `
            CREATE TABLE ${tableName} (id INT PRIMARY KEY, qty INT, label TEXT, mark TEXT);
            INSERT INTO ${tableName} (id, qty, label, mark) VALUES ${seedRows()};
            UPDATE ${tableName} SET mark = 'hit_${index}' WHERE ${predicate.sql};
        `,
        assert(result) {
            const rows = result.table(tableName).rows;
            const expectedHits = baseRows.filter(predicate.matches).map((row) => row.id).sort((a, b) => a - b);
            const actualHits = rows.filter((row) => row.mark === `hit_${index}`).map((row) => row.id).sort((a, b) => a - b);
            expect(actualHits).toEqual(expectedHits);
            expect(result.errors()).toEqual([]);
        },
    };
});

const deleteCases = Array.from({ length: 65 }, (_, index) => {
    const predicate = updatePredicates[(index * 3) % updatePredicates.length];
    const tableName = `edge_delete_${index}`;
    return {
        name: `deletes rows with predicate ${index}`,
        sql: `
            CREATE TABLE ${tableName} (id INT PRIMARY KEY, qty INT, label TEXT, mark TEXT);
            INSERT INTO ${tableName} (id, qty, label, mark) VALUES ${seedRows()};
            DELETE FROM ${tableName} WHERE ${predicate.sql};
        `,
        assert(result) {
            const expectedRemaining = baseRows.filter((row) => !predicate.matches(row)).map((row) => row.id).sort((a, b) => a - b);
            const actualRemaining = result.table(tableName).rows.map((row) => row.id).sort((a, b) => a - b);
            expect(actualRemaining).toEqual(expectedRemaining);
            expect(result.errors()).toEqual([]);
        },
    };
});

const cases = [...insertDefaultCases, ...updateCases, ...deleteCases];

describe('createSqlExecutor generated edge matrix', () => {
    it.each(cases)('$name', ({ sql, assert }) => {
        assert(exec(sql));
    });
});
