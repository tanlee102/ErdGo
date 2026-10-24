import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateSampleData, inspectSampleSchema } from '@/features/data-view/lib/sampleData';
import { inferSampleNullability } from '@/features/data-view/lib/sampleDataNullability';
import { createSqlExecutor } from '@/features/data-view/lib/sqlExecutor';
import { sampleDataSQL } from '@/features/editor/lib/sampleSQL';

const MEDIA_SCHEMA = readFileSync(new URL('../../fixtures/sample-data/media-sharing.sql', import.meta.url), 'utf8');
const columns = ['a', 'b', 'c'].map(name => ({ name }));

describe('CHECK-driven sample nullability', () => {
    it('recognizes grouped NULL predicates and AND precedence', () => {
        expect(inferSampleNullability(columns, ['a IS NULL OR b IS NOT NULL AND c IS NULL'])).toEqual([{ a: true }, { b: false, c: true }]);
        expect(inferSampleNullability(columns, ['(a IS NULL OR b IS NULL)', 'a IS NOT NULL'])).toEqual([{ b: true, a: false }]);
    });
    it('handles quoted names and object-prototype identifiers safely', () => {
        const result = inferSampleNullability([{ name: '__proto__' }, { name: 'constructor' }], ['"__proto__" IS NULL AND "constructor" IS NOT NULL']);
        expect(Object.hasOwn(result[0], '__proto__')).toBe(true);
        expect(result[0].__proto__).toBe(true);
        expect(result[0].constructor).toBe(false);
    });
    it('rejects contradictory plans and excludes NULL for required columns', () => {
        expect(inferSampleNullability(columns, ['a IS NULL AND a IS NOT NULL'])).toEqual([]);
        expect(inferSampleNullability([{ name: 'a', notNull: true }, { name: 'b' }], ['a IS NULL OR b IS NULL'])).toEqual([{ b: true }]);
        expect(() => generateSampleData({ sql: 'CREATE TABLE t(id INT PRIMARY KEY, a INT NOT NULL CHECK(a IS NULL));', tables: { t: { enabled: true, count: 1 } } })).toThrow(/NULL CHECK constraints conflict/);
    });
    it('does not infer a partial plan from unsupported or excessive expressions', () => {
        expect(inferSampleNullability(columns, ['a IS NULL OR b > 5'])).toBeUndefined();
        expect(inferSampleNullability(columns, ['missing IS NULL'])).toBeUndefined();
        expect(inferSampleNullability(columns, ['a IS NULL; DROP TABLE t'])).toBeUndefined();
        expect(inferSampleNullability(columns, ['a IS NULL /* unclosed'])).toBeUndefined();
        expect(inferSampleNullability(columns, ['('.repeat(40) + 'a IS NULL' + ')'.repeat(40)])).toBeUndefined();
        expect(inferSampleNullability(columns, [Array(40).fill('a IS NULL').join(' OR ')])).toBeUndefined();
    });
    it('keeps ordinary NULL sampling for tautologies and unconstrained branches', () => {
        expect(inferSampleNullability(columns, ['a IS NULL OR a IS NOT NULL'])).toBeUndefined();
        expect(inferSampleNullability(columns, ['(a IS NULL AND b IS NULL) OR (a IS NULL AND b IS NOT NULL)'])).toEqual([{ a: true }]);
    });
    it.each(['postgres', 'mysql', 'mssql', 'sqlite'])('honors exclusive references in %s at 0%% and 100%% optional NULLs', dialect => {
        const sql = (dialect === 'sqlite' ? 'PRAGMA foreign_keys=ON; ' : '') + 'CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE v(id INT PRIMARY KEY); CREATE TABLE c(id INT PRIMARY KEY, post_id INT REFERENCES p(id), video_id INT REFERENCES v(id), CHECK((post_id IS NOT NULL AND video_id IS NULL) OR (post_id IS NULL AND video_id IS NOT NULL)));';
        const tables = { p: { enabled: true, count: 5 }, v: { enabled: true, count: 5 }, c: { enabled: true, count: 20 } };
        for (const nullPercent of [0, 100]) {
            const result = generateSampleData({ sql, dialect, tables, nullPercent });
            const replay = createSqlExecutor({ dialect }).execute(sql + '\n' + result.sql);
            expect(replay.log.filter(entry => entry.type === 'error')).toEqual([]);
            const rows = replay.tables.get('c').rows;
            expect(rows.filter(row => row.post_id != null && row.video_id == null)).toHaveLength(10);
            expect(rows.filter(row => row.post_id == null && row.video_id != null)).toHaveLength(10);
        }
    });
    it('allows a nullable composite FK component while retaining a CHECK-required component', () => {
        const sql = 'CREATE TABLE p(tenant INT, id INT, PRIMARY KEY(tenant,id)); CREATE TABLE c(id INT PRIMARY KEY, tenant INT CHECK(tenant IS NOT NULL), pid INT CHECK(pid IS NULL), FOREIGN KEY(tenant,pid) REFERENCES p(tenant,id));';
        const result = generateSampleData({ sql, nullPercent: 100, tables: { p: { enabled: false }, c: { enabled: true, count: 10 } } });
        const replay = createSqlExecutor().execute(sql + '\n' + result.sql);
        expect(replay.log.filter(entry => entry.type === 'error')).toEqual([]);
        expect(replay.tables.get('c').rows.every(row => row.tenant != null && row.pid == null)).toBe(true);
    });
    it('tries another CHECK branch when one parent is empty', () => {
        const sql = 'CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE v(id INT PRIMARY KEY); INSERT INTO v VALUES(1); CREATE TABLE c(id INT PRIMARY KEY, post_id INT REFERENCES p(id), video_id INT REFERENCES v(id), CHECK((post_id IS NOT NULL AND video_id IS NULL) OR (post_id IS NULL AND video_id IS NOT NULL)));';
        const result = generateSampleData({ sql, tables: { c: { enabled: true, count: 4 } } });
        const replay = createSqlExecutor().execute(sql + '\n' + result.sql);
        expect(replay.log.filter(entry => entry.type === 'error')).toEqual([]);
        expect(replay.tables.get('c').rows.every(row => row.post_id == null && row.video_id === 1)).toBe(true);
    });
    it('tries a nullable branch for unsupported complex values', () => {
        const sql = 'CREATE TABLE t(id INT PRIMARY KEY, a BYTEA, b INT, CHECK((a IS NOT NULL AND b IS NULL) OR (a IS NULL AND b IS NOT NULL)));';
        const result = generateSampleData({ sql, dialect: 'postgres', tables: { t: { enabled: true, count: 4 } } });
        const replay = createSqlExecutor({ dialect: 'postgres' }).execute(sql + '\n' + result.sql);
        expect(replay.log.filter(entry => entry.type === 'error')).toEqual([]);
        expect(replay.tables.get('t').rows.every(row => row.a == null && row.b != null)).toBe(true);
    });
    it.each([0, 100])('generates the complete media schema at %i%% optional NULLs', nullPercent => {
        const model = inspectSampleSchema(MEDIA_SCHEMA, 'postgres');
        expect(model.errors).toEqual([]);
        const tables = Object.fromEntries(model.tables.map(table => [table.name, { enabled: true, count: 20 }]));
        const options = { sql: MEDIA_SCHEMA, dialect: 'postgres', tables, nullPercent, seed: 'media-sharing' };
        const result = generateSampleData(options);
        expect(generateSampleData(options).sql).toBe(result.sql);
        expect(result.totalRows).toBe(180);
        expect(result.sql).not.toMatch(/INSERT INTO "(?:categories|products|orders|order_items)"/);
        const replay = createSqlExecutor({ dialect: 'postgres' }).execute(MEDIA_SCHEMA + '\n' + result.sql);
        expect(replay.log.filter(entry => entry.type === 'error')).toEqual([]);
        for (const table of replay.tables.values()) expect(table.rows).toHaveLength(20);
        for (const user of replay.tables.get('users').rows) {
            expect(user.id).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
            expect(user.username).toBeTruthy();
            expect(['USER', 'MOD', 'ADMIN']).toContain(user.role);
        }
        const comments = replay.tables.get('comments').rows;
        expect(comments.filter(row => row.post_id != null && row.video_id == null)).toHaveLength(10);
        expect(comments.filter(row => row.post_id == null && row.video_id != null)).toHaveLength(10);
        expect(result.notes.join(' ')).toContain('CHECK constraints');
    });
    it('reports commerce starter rows as incompatible with a replaced media schema', () => {
        const result = createSqlExecutor({ dialect: 'postgres' }).execute(MEDIA_SCHEMA + '\n' + sampleDataSQL);
        expect(result.log.filter(entry => entry.type === 'error').map(entry => entry.message).join(' ')).toMatch(/unknown column\(s\): full_name, flags, last_seen_at/);
        expect(result.log.some(entry => /categories.*table does not exist/.test(entry.message))).toBe(true);
    });
});
