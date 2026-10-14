import { describe, expect, it } from 'vitest';
import { prepareCanvasEditInTabs } from '@/features/editor/lib/canvasSchemaEdits';
import { buildCombinedSql } from '@/features/editor/lib/sqlTabs';
import { sqlToErdSchema } from '@/lib/erdJsonSchema';
let DatabaseSync; try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* optional native runner */ }
function remove(sql, column = 'a', table = 't', cascade = true) {
    const tabs = Array.isArray(sql) ? sql : [{ id: 'sql', sql }];
    const result = prepareCanvasEditInTabs(tabs, { kind: 'remove-column', table, column, cascade });
    return { ...result, sql: result.nextTabs && buildCombinedSql(result.nextTabs).sql };
}
function native(result) { expect(result.ok, result.message).toBe(true); if (DatabaseSync) { const db = new DatabaseSync(':memory:'); try { db.exec(result.sql); return db.prepare('SELECT * FROM t').all().map((row) => ({ ...row })); } finally { db.close(); } } }

describe('migration-aware canvas cascade review', () => {
    it('offers review for later modifications instead of rejecting the history', () => {
        const sql = 'SET search_path=public; CREATE TABLE t(id INTEGER); ALTER TABLE t ADD a TEXT; ALTER TABLE t ALTER COLUMN a TYPE VARCHAR(50);';
        expect(remove(sql, 'a', 't', false)).toMatchObject({ ok: false, canCascade: true });
        const result = remove(sql); expect(result.ok, result.message).toBe(true); expect(result.sql).not.toContain('ALTER TABLE');
        expect(result.impacts.filter((i) => i.kind === 'remove-migration')).toHaveLength(2);
    });
    it('keeps unrelated clauses, literals and comments in multi-action migrations', () => {
        const sql = "SET search_path=public; CREATE TABLE t(id INTEGER); ALTER TABLE t ADD a INTEGER, ADD b TEXT DEFAULT 'a, keep', ADD CONSTRAINT uq UNIQUE(a); ALTER TABLE t ALTER COLUMN a SET DEFAULT 3, ALTER COLUMN b SET DEFAULT 'ok';";
        const result = remove(sql); expect(result.ok, result.message).toBe(true);
        expect(result.sql).toContain("ADD b TEXT DEFAULT 'a, keep'"); expect(result.sql).toContain("ALTER COLUMN b SET DEFAULT 'ok'");
        expect(sqlToErdSchema(result.sql).tables[0].columns.map((c) => c.name)).toEqual(['id', 'b']);
    });
    it('retains an unrelated expression index in a shared MySQL ALTER', () => {
        const result = remove('SET NAMES utf8mb4; CREATE TABLE t(id VARCHAR(255)); ALTER TABLE t ADD a INTEGER, ADD INDEX ix((lower(id)));');
        expect(result.ok, result.message).toBe(true); expect(result.sql).toContain('ADD INDEX ix((lower(id)))'); expect(result.sql).not.toContain('ADD a');
    });
    it('keeps the ADD verb when the first SQL Server field is removed', () => {
        const result = remove('SET ANSI_NULLS ON; CREATE TABLE t(id INT); ALTER TABLE t ADD a INT, b INT;');
        expect(result.ok, result.message).toBe(true); expect(result.sql).toMatch(/ALTER TABLE t ADD\s+b INT/); expect(sqlToErdSchema(result.sql).tables[0].columns.map((c) => c.name)).toEqual(['id', 'b']);
    });
    it('follows SQLite column and table renames and rewrites data at each point in time', () => {
        const sql = "PRAGMA foreign_keys=ON; CREATE TABLE t(id INTEGER,a TEXT); INSERT INTO t VALUES(1,'before'); ALTER TABLE t RENAME COLUMN a TO note; INSERT INTO t VALUES(2,'middle'); ALTER TABLE t RENAME TO current_table; INSERT INTO current_table VALUES(3,'after');";
        const result = remove(sql, 'note', 'current_table'); expect(result.ok, result.message).toBe(true);
        expect(result.sql).not.toContain('RENAME COLUMN'); expect(result.sql).toContain('RENAME TO current_table');
        expect(result.impacts.filter((i) => i.kind === 'rewrite-data')).toHaveLength(3);
        if (DatabaseSync) { const db = new DatabaseSync(':memory:'); try { db.exec(result.sql); expect(db.prepare('SELECT id FROM current_table').all().map((r) => r.id)).toEqual([1, 2, 3]); } finally { db.close(); } }
    });
    it('leaves earlier values untouched when a deleted name belongs to a later incarnation', () => {
        const result = remove("PRAGMA foreign_keys=ON; CREATE TABLE t(id INTEGER,a TEXT); INSERT INTO t VALUES(1,'old'); ALTER TABLE t DROP COLUMN a; ALTER TABLE t ADD a INTEGER; INSERT INTO t VALUES(2,3);");
        expect(result.ok, result.message).toBe(true); expect(result.sql).toContain("VALUES(1,'old')"); expect(result.sql).toContain('DROP COLUMN a');
        expect(native(result)).toEqual([{ id: 1 }, { id: 2 }]);
    });
    it('cascades generated fields, later checks and incoming/outgoing keys across tabs', () => {
        const tabs = [{ id: 'ddl', sql: 'SET search_path=public; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE t(id INTEGER,a INTEGER REFERENCES p(id), keep TEXT);' },
            { id: 'later', sql: 'ALTER TABLE t ADD doubled INTEGER GENERATED ALWAYS AS (a*2) STORED; ALTER TABLE t ADD CONSTRAINT uq UNIQUE(a); CREATE TABLE c(id INTEGER, tid INTEGER REFERENCES t(a)); ALTER TABLE t ADD CONSTRAINT ck CHECK(doubled>0), ADD unrelated INTEGER;' },
            { id: 'off', sql: 'ALTER TABLE t ADD private INTEGER;', isInactive: true }];
        const result = remove(tabs); expect(result.ok, result.message).toBe(true); expect(result.nextTabs[2]).toEqual(tabs[2]);
        expect(result.sql).not.toContain('doubled'); expect(result.sql).not.toContain('REFERENCES t(a)'); expect(result.sql).toContain('ADD unrelated INTEGER');
        expect(sqlToErdSchema(result.sql).relations).toEqual([]); expect(result.impacts.some((i) => i.kind === 'remove-column')).toBe(true);
    });
    it('keeps an added foreign-key column while removing its deleted target reference', () => {
        const sql = 'SET search_path=public; CREATE TABLE t(id INTEGER,a INTEGER UNIQUE); CREATE TABLE child(id INTEGER); ALTER TABLE t ADD note TEXT; ALTER TABLE child ADD tid INTEGER REFERENCES t(a);';
        const result = remove(sql); expect(result.ok, result.message).toBe(true); expect(result.sql).toContain('ADD tid INTEGER'); expect(result.sql).not.toContain('REFERENCES');
        expect(sqlToErdSchema(result.sql).tables.find((t) => t.name === 'child').columns.map((c) => c.name)).toEqual(['id', 'tid']);
    });
    it('removes dependent index drops and constraint rename/drop history', () => {
        const sql = 'SET search_path=public; CREATE TABLE t(id INTEGER,a INTEGER, CONSTRAINT uq UNIQUE(a)); CREATE INDEX ix ON t(a); DROP INDEX ix; ALTER TABLE t RENAME CONSTRAINT uq TO uq_later; ALTER TABLE t DROP CONSTRAINT uq_later;';
        expect(remove(sql, 'a', 't', false)).toMatchObject({ ok: false, canCascade: true });
        const result = remove(sql);
        expect(result.ok, result.message).toBe(true); expect(result.sql).not.toContain('uq'); expect(result.sql).not.toContain('INDEX');
    });
    it('removes a global PostgreSQL index rename and its later drop', () => {
        const result = remove('SET search_path=public; CREATE TABLE t(id INTEGER,a INTEGER); CREATE INDEX ix ON t(a); ALTER INDEX ix RENAME TO ix_current; DROP INDEX ix_current;');
        expect(result.ok, result.message).toBe(true); expect(result.sql).not.toContain('INDEX');
    });
    it('does not confuse index and CHECK constraint names or qualified index namespaces', () => {
        const result = remove('SET search_path=public; CREATE TABLE t(id INTEGER,a INTEGER,b INTEGER,CONSTRAINT ix CHECK(b>0)); CREATE INDEX ix ON t(a); ALTER TABLE t DROP CONSTRAINT ix; DROP INDEX ix;');
        expect(result.ok, result.message).toBe(true); expect(result.sql).toContain('CONSTRAINT ix CHECK(b>0)'); expect(result.sql).toContain('DROP CONSTRAINT ix'); expect(result.sql).not.toContain('INDEX');
        const sql = 'SET search_path=public; CREATE TABLE app.t(id INTEGER,a INTEGER); CREATE INDEX ix ON app.t(a); ALTER INDEX app.ix RENAME TO ix_new; DROP INDEX app.ix_new;';
        const qualified = remove(sql, 'a', sqlToErdSchema(sql).tables[0].name);
        expect(qualified.ok, qualified.message).toBe(true); expect(qualified.sql).not.toContain('INDEX');
    });
    it('cascades SQLite references within an attached database without touching its main namesake', () => {
        const sql = "PRAGMA foreign_keys=ON; ATTACH ':memory:' AS attached; CREATE TABLE main.t(id INTEGER,a INTEGER UNIQUE); CREATE TABLE attached.t(id INTEGER,a INTEGER UNIQUE); CREATE TABLE attached.child(tid INTEGER REFERENCES t(a),keep TEXT);";
        const name = sqlToErdSchema(sql).tables.find(t => t.schemaName === 'attached' && t.fullName === 'attached.t').name;
        const result = remove(sql, 'a', name); expect(result.ok, result.message).toBe(true); expect(result.sql).toContain('CREATE TABLE main.t(id INTEGER,a INTEGER UNIQUE)'); expect(result.sql).not.toContain('REFERENCES');
        if (DatabaseSync) { const db = new DatabaseSync(':memory:'); try { db.exec(result.sql); db.exec("INSERT INTO attached.child VALUES(999,'kept');"); expect(db.prepare('SELECT keep FROM attached.child').get().keep).toBe('kept'); } finally { db.close(); } }
    });
    it('binds index and constraint name reuse to the correct declaration', () => {
        const result = remove('SET search_path=public; CREATE TABLE t(id INTEGER,a INTEGER,b INTEGER,CONSTRAINT uq UNIQUE(a)); ALTER TABLE t DROP CONSTRAINT uq; ALTER TABLE t ADD CONSTRAINT uq UNIQUE(b); ALTER TABLE t DROP CONSTRAINT uq; CREATE INDEX ix ON t(a); DROP INDEX ix; CREATE INDEX ix ON t(b); DROP INDEX ix;');
        expect(result.ok, result.message).toBe(true); expect(result.sql).toContain('ADD CONSTRAINT uq UNIQUE(b)');
        expect((result.sql.match(/DROP CONSTRAINT uq/g) || []).length).toBe(1); expect(result.sql).toContain('CREATE INDEX ix ON t(b)'); expect((result.sql.match(/DROP INDEX ix/g) || []).length).toBe(1);
    });
    it('reports a real STRICT table name and keeps its options outside renderer JSON', () => {
        const sql = 'PRAGMA foreign_keys=ON; CREATE TABLE t(id INTEGER) STRICT; ALTER TABLE t ADD note TEXT;';
        const result = prepareCanvasEditInTabs([{ id: 'sql', sql }], { kind: 'add-column', table: 't', column: 'sd', definition: 'VARCHAR(255)' });
        expect(result.ok).toBe(false); expect(result.message).toContain("table 't'"); expect(result.message).not.toContain('__erdgo_column_draft__');
        const table = sqlToErdSchema(sql).tables[0]; expect(table.options.strict).toBe(true); expect(JSON.parse(JSON.stringify(table)).options).toBeUndefined();
    });
    it('preserves unrelated column/key history and mixed-case quoted field identities', () => {
        const result = remove('SET search_path=public; CREATE TABLE t(id INTEGER,"A" INTEGER,a INTEGER); ALTER TABLE t ALTER COLUMN "A" SET DEFAULT 1; ALTER TABLE t ALTER COLUMN a SET DEFAULT 2;', 'A');
        expect(result.ok, result.message).toBe(true); expect(result.sql).toContain('ALTER COLUMN a SET DEFAULT 2'); expect(result.sql).not.toContain('"A"');
    });
    it('does not rewrite retired table incarnations or inactive SQL', () => {
        const tabs = [{ id: 'old', sql: 'PRAGMA foreign_keys=ON; CREATE TABLE t(a INTEGER); DROP TABLE t;' }, { id: 'live', sql: 'CREATE TABLE t(id INTEGER,a TEXT); ALTER TABLE t RENAME COLUMN a TO note;' }, { id: 'off', sql: 'private', isInactive: true }];
        const result = remove(tabs, 'note'); expect(result.ok, result.message).toBe(true); expect(result.nextTabs[0]).toEqual(tabs[0]); expect(result.nextTabs[2]).toEqual(tabs[2]);
        native(result);
    });
    it('rejects incomplete boundaries without committing any tab', () => {
        expect(remove('PRAGMA foreign_keys=ON; CREATE TABLE t(id INTEGER,a TEXT); CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT NEW.a;')).toMatchObject({ ok: false });
        expect(remove('PRAGMA foreign_keys=ON; CREATE TABLE t(a INTEGER); ALTER TABLE t ADD b INTEGER;')).toMatchObject({ ok: false });
    });
});
