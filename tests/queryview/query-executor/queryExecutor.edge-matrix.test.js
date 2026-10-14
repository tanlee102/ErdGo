/** Runs a broad matrix of unusual SELECT expressions and data shapes. */
import { describe, expect, it } from 'vitest';
import { createSqlExecutor } from '@/features/data-view/lib/sqlExecutor.js';
import { executeSelectQuery } from '@/features/query-view/lib/queryExecutor.js';

const items = [
    { id: 1, owner_id: 1, category: 'a', label: 'Alpha', qty: 2, price: 10, active: true },
    { id: 2, owner_id: 1, category: 'a', label: 'Beta', qty: 0, price: 15, active: false },
    { id: 3, owner_id: 2, category: 'b', label: 'Gamma', qty: 5, price: 7, active: true },
    { id: 4, owner_id: 2, category: 'b', label: 'Delta', qty: 3, price: 20, active: true },
    { id: 5, owner_id: 3, category: 'c', label: 'Echo', qty: 1, price: 5, active: false },
];

const owners = [
    { id: 1, name: 'Ada', region: 'north' },
    { id: 2, name: 'Ben', region: 'south' },
    { id: 3, name: 'Cy', region: 'north' },
];

const schemaSql = `
    CREATE TABLE owners (id INT PRIMARY KEY, name TEXT, region TEXT);
    CREATE TABLE items (
        id INT PRIMARY KEY,
        owner_id INT,
        category TEXT,
        label TEXT,
        qty INT,
        price NUMERIC,
        active BOOLEAN
    );
    INSERT INTO owners (id, name, region) VALUES
        (1, 'Ada', 'north'),
        (2, 'Ben', 'south'),
        (3, 'Cy', 'north');
    INSERT INTO items (id, owner_id, category, label, qty, price, active) VALUES
        (1, 1, 'a', 'Alpha', 2, 10, TRUE),
        (2, 1, 'a', 'Beta', 0, 15, FALSE),
        (3, 2, 'b', 'Gamma', 5, 7, TRUE),
        (4, 2, 'b', 'Delta', 3, 20, TRUE),
        (5, 3, 'c', 'Echo', 1, 5, FALSE);
`;

function runQuery(query) {
    const executor = createSqlExecutor();
    const tables = executor.execute(schemaSql).tables;
    return executeSelectQuery({ tables, query });
}

function expectRows(query, expectedRows) {
    const result = runQuery(query);
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual(expectedRows);
}

const wherePredicates = [
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
    { sql: "label LIKE 'A%'", matches: (row) => row.label.startsWith('A') },
    { sql: "label LIKE '%a'", matches: (row) => row.label.endsWith('a') },
    { sql: "label NOT LIKE 'B%'", matches: (row) => !row.label.startsWith('B') },
    { sql: "category = 'a' AND active = TRUE", matches: (row) => row.category === 'a' && row.active },
    { sql: "category = 'a' OR price >= 20", matches: (row) => row.category === 'a' || row.price >= 20 },
];

const whereCases = Array.from({ length: 80 }, (_, index) => {
    const predicate = wherePredicates[index % wherePredicates.length];
    return {
        name: `filters items with where predicate ${index}`,
        query: `SELECT id FROM items WHERE ${predicate.sql} ORDER BY id;`,
        expectedRows: items.filter(predicate.matches).map((row) => [row.id]),
    };
});

const expressionTemplates = [
    { select: 'qty + price AS value', value: (row) => row.qty + row.price },
    { select: 'price - qty AS value', value: (row) => row.price - row.qty },
    { select: 'qty * 2 AS value', value: (row) => row.qty * 2 },
    { select: 'price / NULLIF(qty, 0) AS value', value: (row) => (row.qty === 0 ? null : row.price / row.qty) },
    { select: 'ABS(qty - price) AS value', value: (row) => Math.abs(row.qty - row.price) },
    { select: 'ROUND(price / NULLIF(qty, 0), 2) AS value', value: (row) => (row.qty === 0 ? null : Math.round((row.price / row.qty) * 100) / 100) },
    { select: 'UPPER(label) AS value', value: (row) => row.label.toUpperCase() },
    { select: 'LOWER(label) AS value', value: (row) => row.label.toLowerCase() },
    { select: 'LENGTH(label) AS value', value: (row) => row.label.length },
    { select: "COALESCE(label, 'missing') AS value", value: (row) => row.label },
];

const expressionCases = Array.from({ length: 40 }, (_, index) => {
    const template = expressionTemplates[index % expressionTemplates.length];
    const row = items[index % items.length];
    return {
        name: `evaluates scalar expression ${index}`,
        query: `SELECT ${template.select} FROM items WHERE id = ${row.id};`,
        expectedRows: [[template.value(row)]],
    };
});

function groupedByCategory(category) {
    return items.filter((row) => row.category === category);
}

const aggregateTemplates = [
    { select: 'COUNT(id) AS value', value: (rows) => rows.length },
    { select: 'SUM(qty) AS value', value: (rows) => rows.reduce((sum, row) => sum + row.qty, 0) },
    { select: 'SUM(price) AS value', value: (rows) => rows.reduce((sum, row) => sum + row.price, 0) },
    { select: 'MIN(price) AS value', value: (rows) => Math.min(...rows.map((row) => row.price)) },
    { select: 'MAX(price) AS value', value: (rows) => Math.max(...rows.map((row) => row.price)) },
];

const aggregateCases = Array.from({ length: 40 }, (_, index) => {
    const template = aggregateTemplates[index % aggregateTemplates.length];
    const category = ['a', 'b', 'c'][index % 3];
    const rows = groupedByCategory(category);
    return {
        name: `aggregates category slice ${index}`,
        query: `SELECT ${template.select} FROM items WHERE category = '${category}';`,
        expectedRows: [[template.value(rows)]],
    };
});

const joinCases = Array.from({ length: 40 }, (_, index) => {
    const owner = owners[index % owners.length];
    const expectedRows = items
        .filter((item) => item.owner_id === owner.id)
        .map((item) => [owner.name, item.label, item.qty])
        .sort((a, b) => a[1].localeCompare(b[1]));
    return {
        name: `joins owners to items ${index}`,
        query: `
            SELECT o.name, i.label, i.qty
            FROM owners o
            JOIN items i ON i.owner_id = o.id
            WHERE o.id = ${owner.id}
            ORDER BY i.label
        `,
        expectedRows,
    };
});

const cases = [...whereCases, ...expressionCases, ...aggregateCases, ...joinCases];

describe('executeSelectQuery generated edge matrix', () => {
    it.each(cases)('$name', ({ query, expectedRows }) => {
        expectRows(query, expectedRows);
    });
});
