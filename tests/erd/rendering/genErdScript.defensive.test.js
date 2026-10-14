import { describe, it, expect } from 'vitest';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

/**
 * genErdScript — defensive-input contract.
 *
 * The renderer can't be unit-tested directly (canvas + DOM + ELK), but
 * we CAN pin the upstream contract: every schema that flows from
 * `sqlToErdSchema` into `runErdScript` MUST satisfy a strict invariant
 * set so the renderer's defensive guards never need to actually fire.
 *
 * If any of these invariants ever break, the renderer either throws,
 * silently mis-draws, or freezes the canvas. Catching it here means we
 * never ship a regression that takes the ERD pane offline.
 *
 * The renderer-side guards we shipped in this changeset:
 *   • computeTableLayoutWithELK — handles tbl.columns missing/non-array.
 *   • buildConnectorPaths      — pre-filters relations missing from/to.
 *   • renderTableNavList       — pre-filters relations + tables missing name.
 *   • runErdScript bootstrap   — bails out gracefully when #erd-canvas
 *                                 has no parentNode (component unmount race).
 *   • document mousedown       — single listener replaced per render
 *                                 (was: leaked on every keystroke).
 */

function build(sql) {
    return sqlToErdSchema(sql);
}

describe('Renderer input invariants — schemas the renderer always sees', () => {
    it('every table.name is a non-empty string', () => {
        const s = build(`
            CREATE TABLE users (id INT);
            CREATE TABLE posts (id INT);
        `);
        expect(s.tables.length).toBeGreaterThan(0);
        for (const t of s.tables) {
            expect(typeof t.name).toBe('string');
            expect(t.name.length).toBeGreaterThan(0);
        }
    });

    it('every table.columns is an array (possibly empty, never undefined)', () => {
        const s = build(`CREATE TABLE empty_t (id INT);`);
        for (const t of s.tables) {
            expect(Array.isArray(t.columns)).toBe(true);
        }
    });

    it('every relation has well-formed from/to with table strings', () => {
        const s = build(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (pid INT REFERENCES p(id));
        `);
        for (const rel of s.relations) {
            expect(rel.from).toBeTruthy();
            expect(rel.to).toBeTruthy();
            expect(typeof rel.from.table).toBe('string');
            expect(typeof rel.from.column).toBe('string');
            expect(typeof rel.to.table).toBe('string');
            expect(typeof rel.to.column).toBe('string');
            expect(rel.from.table.length).toBeGreaterThan(0);
            expect(rel.to.table.length).toBeGreaterThan(0);
        }
    });

    it('relations point only at tables that exist in schema.tables', () => {
        const s = build(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (pid INT REFERENCES p(id));
            CREATE TABLE c2 (pid INT REFERENCES does_not_exist(id));
        `);
        const tableNames = new Set(s.tables.map((t) => t.name));
        for (const rel of s.relations) {
            expect(tableNames.has(rel.from.table)).toBe(true);
            expect(tableNames.has(rel.to.table)).toBe(true);
        }
        // The dangling FK should have been dropped by validateSchema.
        const w = (s._parseErrors || []).filter((e) => /does_not_exist/i.test(e.message));
        expect(w.length).toBeGreaterThan(0);
    });

    it('relations point only at columns that exist on the target table', () => {
        const s = build(`
            CREATE TABLE p (uuid TEXT PRIMARY KEY);
            CREATE TABLE c (pid INT REFERENCES p(id));
        `);
        // 'p' has no 'id' column — relation must be dropped, not silently kept.
        for (const rel of s.relations) {
            const target = s.tables.find((t) => t.name === rel.to.table);
            expect(target).toBeTruthy();
            const col = target.columns.find((c) => c.name === rel.to.column);
            expect(col).toBeTruthy();
        }
    });

    it('cardinality enum is always one of the known values', () => {
        const s = build(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (pid INT REFERENCES p(id));
        `);
        const valid = new Set(['1', 'n', '1+', '0..1', '0..n']);
        for (const rel of s.relations) {
            expect(valid.has(rel.fromCard)).toBe(true);
            expect(valid.has(rel.toCard)).toBe(true);
        }
    });

    it('empty input produces a renderer-ready empty schema (no crash)', () => {
        const s = build('');
        expect(Array.isArray(s.tables)).toBe(true);
        expect(s.tables).toHaveLength(0);
        expect(Array.isArray(s.relations)).toBe(true);
        expect(s.relations).toHaveLength(0);
        expect(Array.isArray(s.enums)).toBe(true);
        expect(Array.isArray(s.composites)).toBe(true);
    });

    it('isolated tables (no relations) still produce a valid schema', () => {
        const s = build(`
            CREATE TABLE a (id INT PRIMARY KEY);
            CREATE TABLE b (id INT PRIMARY KEY);
            CREATE TABLE c (id INT PRIMARY KEY);
        `);
        expect(s.tables).toHaveLength(3);
        expect(s.relations).toHaveLength(0);
    });

    it('self-referencing FK is a valid relation (renderer handles self-loops)', () => {
        const s = build(`
            CREATE TABLE node (
                id INT PRIMARY KEY,
                parent_id INT REFERENCES node(id)
            );
        `);
        const rel = s.relations.find(
            (r) => r.from.table === 'node' && r.from.column === 'parent_id',
        );
        expect(rel).toBeTruthy();
        expect(rel.to.table).toBe('node');
        expect(rel.to.column).toBe('id');
    });

    it('cycle in FKs is preserved (does not crash schema construction)', () => {
        const s = build(`
            CREATE TABLE a (id INT PRIMARY KEY, b_id INT REFERENCES b(id));
            CREATE TABLE b (id INT PRIMARY KEY, a_id INT REFERENCES a(id));
        `);
        expect(s.tables).toHaveLength(2);
        const aToB = s.relations.find((r) => r.from.table === 'a');
        const bToA = s.relations.find((r) => r.from.table === 'b');
        expect(aToB).toBeTruthy();
        expect(bToA).toBeTruthy();
    });

    it('large schema (50 tables, ~100 relations) builds without falling over', () => {
        const tables = Array.from({ length: 50 }, (_, i) => `CREATE TABLE t${i} (id INT PRIMARY KEY);`).join('\n');
        const relations = Array.from({ length: 49 }, (_, i) => `CREATE TABLE r${i} (id INT PRIMARY KEY, f INT REFERENCES t${i}(id));`).join('\n');
        const s = build(tables + '\n' + relations);
        expect(s.tables.length).toBeGreaterThanOrEqual(50);
        // Every relation points at an existing table.
        const names = new Set(s.tables.map((t) => t.name));
        for (const rel of s.relations) {
            expect(names.has(rel.from.table)).toBe(true);
            expect(names.has(rel.to.table)).toBe(true);
        }
    });

    it('every constraint badge in col.constraints is a string from the known set', () => {
        const s = build(`
            CREATE TABLE t (
                id INT PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                name TEXT,
                indexed_col INT
            );
            CREATE INDEX idx ON t (indexed_col);
        `);
        const allowed = new Set(['PK', 'UQ', 'NN', 'IDX']);
        for (const t of s.tables) {
            for (const col of t.columns) {
                for (const badge of col.constraints) {
                    expect(allowed.has(badge)).toBe(true);
                }
            }
        }
    });

    it('every extras entry is a string (renderer measures via ctx.measureText)', () => {
        const s = build(`
            CREATE TABLE t (
                id INT PRIMARY KEY AUTO_INCREMENT,
                created TIMESTAMP DEFAULT NOW(),
                CONSTRAINT chk CHECK (id > 0)
            );
        `);
        for (const t of s.tables) {
            for (const col of t.columns) {
                for (const x of col.extras) {
                    expect(typeof x).toBe('string');
                }
            }
        }
    });
});
