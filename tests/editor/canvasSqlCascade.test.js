import { describe, expect, it } from 'vitest';
import { prepareCanvasEditInTabs } from '@/features/editor/lib/canvasSchemaEdits';
import { buildCombinedSql } from '@/features/editor/lib/sqlTabs';
import { sqlToErdSchema } from '@/lib/erdJsonSchema';
let DatabaseSync; try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* optional native runner */ }
const remove = { kind: 'remove-column', table: 't', column: 'a', cascade: true };
function edit(sql, action = remove) {
    const result = prepareCanvasEditInTabs(Array.isArray(sql) ? sql : [{ id: 'schema', sql }], action);
    return { ...result, sql: result.nextTabs && buildCombinedSql(result.nextTabs).sql };
}
const prefix = 'PRAGMA foreign_keys=ON; CREATE TABLE t(a INTEGER, b TEXT, c REAL);';
describe('reviewed canvas SQL cascades', () => {
    it('offers a cascade instead of committing dependent SQL implicitly', () => {
        const result = edit(prefix + ' INSERT INTO t VALUES(1,\'keep\',2);', { ...remove, cascade: false });
        expect(result).toMatchObject({ ok: false, canCascade: true }); expect(result.nextTabs).toBeUndefined();
    });
    it.each([
        ["INSERT INTO t VALUES(1,'one; )',2.5),(2,'two,(',3.5);", "INSERT INTO t VALUES('one; )', 2.5),('two,(', 3.5);"],
        ["INSERT INTO t(c,a,b) VALUES(2.5,1,'one'),(3.5,2,'two');", "INSERT INTO t(c, b) VALUES(2.5, 'one'),(3.5, 'two');"],
    ])('keeps other INSERT fields and all rows: %s', (data, expected) => {
        const result = edit(prefix + data); expect(result.ok, result.message).toBe(true); expect(result.sql).toContain(expected);
        expect(result.impacts).toContainEqual(expect.objectContaining({ kind: 'rewrite-data', label: 'INSERT · 2 rows kept' }));
        if (DatabaseSync) { const db = new DatabaseSync(':memory:'); try { db.exec(result.sql); expect(db.prepare('SELECT b,c FROM t ORDER BY c').all()).toHaveLength(2); } finally { db.close(); } }
    });
    it('preserves unrelated data and views, including identically named fields on other tables', () => {
        const sql = prefix + "CREATE TABLE other(a INTEGER); INSERT INTO other(a) VALUES(9); INSERT INTO t(b,c) VALUES('keep',1); CREATE VIEW remaining AS SELECT b FROM t; CREATE VIEW count_rows AS SELECT count(*) AS n FROM t; CREATE VIEW other_a AS SELECT a FROM other;";
        const result = edit(sql, { ...remove, cascade: false }); expect(result.ok, result.message).toBe(true);
        expect(result.sql).toContain('INSERT INTO other(a) VALUES(9)'); expect(result.sql).toContain("INSERT INTO t(b,c) VALUES('keep',1)"); expect(result.sql).toContain('CREATE VIEW remaining'); expect(result.sql).toContain('CREATE VIEW count_rows'); expect(result.sql).toContain('CREATE VIEW other_a');
    });
    it('preserves comments attached to remaining fields and values without swallowing delimiters', () => {
        const sql = prefix + "INSERT INTO t(a, /* keep field */ b, c) VALUES(1, /* keep value */ 'ok' -- keep trailing\n, 2);";
        const result = edit(sql); expect(result.ok, result.message).toBe(true); expect(result.sql).toContain('/* keep field */ b'); expect(result.sql).toContain('/* keep value */'); expect(result.sql).toContain('-- keep trailing\n');
        if (DatabaseSync) { const db = new DatabaseSync(':memory:'); try { db.exec(result.sql); expect(db.prepare('SELECT b FROM t').get().b).toBe('ok'); } finally { db.close(); } }
    });
    it('removes dependent views transitively, complete trigger bodies and corresponding DROP statements', () => {
        const sql = prefix + "CREATE TABLE audit(id INTEGER,note TEXT); CREATE VIEW v AS SELECT a FROM t; CREATE VIEW wrapped AS SELECT * FROM v; CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO audit VALUES(NEW.a, NEW.b); UPDATE audit SET note='a; END;'; END; DROP VIEW wrapped;";
        const result = edit(sql); expect(result.ok, result.message).toBe(true);
        expect(result.sql).not.toContain('CREATE VIEW'); expect(result.sql).not.toContain('CREATE TRIGGER'); expect(result.sql).not.toContain('UPDATE audit'); expect(result.sql).not.toContain('DROP VIEW'); expect(result.sql).toContain('CREATE TABLE audit');
        expect(result.impacts.filter((i) => i.kind === 'remove-view')).toHaveLength(2); expect(result.impacts.some((i) => i.kind === 'remove-trigger')).toBe(true);
        if (DatabaseSync) { const db = new DatabaseSync(':memory:'); try { db.exec(result.sql); expect(db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('view','trigger')").all()).toEqual([]); } finally { db.close(); } }
    });
    it('recognizes SQL Server inserted aliases and removes the complete trigger batch', () => {
        const sql = 'SET ANSI_NULLS ON; CREATE TABLE t(a INTEGER,b TEXT); CREATE TABLE audit(a INTEGER); GO\nCREATE TRIGGER tr ON t AFTER INSERT AS BEGIN INSERT INTO audit SELECT i.a FROM inserted i; UPDATE audit SET a=1; END; GO\nSELECT 1;';
        const result = edit(sql); expect(result.ok, result.message).toBe(true); expect(result.sql).not.toContain('CREATE TRIGGER'); expect(result.sql).not.toContain('UPDATE audit'); expect(result.sql).toContain('SELECT 1;'); expect(result.impacts.some((i) => i.kind === 'remove-trigger')).toBe(true);
    });
    it('binds NEW to its own trigger table and preserves an unrelated qualified field', () => {
        const sql = prefix + 'CREATE TABLE other(a INTEGER); CREATE TABLE audit(a INTEGER,b TEXT); CREATE TRIGGER remaining AFTER INSERT ON other BEGIN INSERT INTO audit SELECT NEW.a,t.b FROM t; END;';
        const result = edit(sql, { ...remove, cascade: false }); expect(result.ok, result.message).toBe(true); expect(result.sql).toContain('CREATE TRIGGER remaining');
        if (DatabaseSync) { const db = new DatabaseSync(':memory:'); try { db.exec(result.sql); } finally { db.close(); } }
    });
    it('removes generated dependency chains, checks, expression indexes and their incoming FKs', () => {
        const sql = 'PRAGMA foreign_keys=ON; CREATE TABLE t(a INTEGER PRIMARY KEY, g INTEGER GENERATED ALWAYS AS (a+1) VIRTUAL UNIQUE, h INTEGER GENERATED ALWAYS AS(g*2) VIRTUAL, keep TEXT CHECK(a>0), CHECK(a<100)); CREATE TABLE child(id INTEGER REFERENCES t(g), keep TEXT); CREATE INDEX exp ON t((lower(keep))) WHERE a>0;';
        const result = edit(sql); expect(result.ok, result.message).toBe(true); expect(sqlToErdSchema(result.sql).tables[0].columns.map((c) => c.name)).toEqual(['keep']);
        expect(result.sql).not.toContain('CHECK'); expect(result.sql).not.toContain('CREATE INDEX'); expect(result.sql).not.toContain('REFERENCES'); expect(result.impacts.filter((i) => i.kind === 'remove-column')).toHaveLength(2);
        if (DatabaseSync) { const db = new DatabaseSync(':memory:'); try { db.exec(result.sql); } finally { db.close(); } }
    });
    it('lists entire dependent UPDATE/DELETE statements but retains unrelated updates', () => {
        const result = edit(prefix + "UPDATE t SET b='keep'; UPDATE t SET b='changed' WHERE a=1; DELETE FROM t WHERE a=2;");
        expect(result.ok, result.message).toBe(true); expect(result.sql).toContain("UPDATE t SET b='keep'"); expect(result.sql).not.toContain("b='changed'"); expect(result.sql).not.toContain('DELETE FROM'); expect(result.impacts.filter((i) => i.kind === 'remove-statement')).toHaveLength(2);
    });
    it('preserves qualified unrelated fields in joins and quoted PostgreSQL case distinctions', () => {
        const sql = 'SET search_path=public; CREATE TABLE t("A" INTEGER, a INTEGER, b TEXT); CREATE TABLE other("A" INTEGER); INSERT INTO t("A",a,b) VALUES(1,2,\'keep\'); CREATE VIEW remaining AS SELECT o."A",t.b FROM t JOIN other o ON true;';
        const result = edit(sql, { ...remove, column: 'A' }); expect(result.ok, result.message).toBe(true);
        expect(result.sql).toContain("INSERT INTO t(a, b) VALUES(2, 'keep')"); expect(result.sql).toContain('CREATE VIEW remaining'); expect(sqlToErdSchema(result.sql).tables.find((t) => t.name === 't').columns.map((c) => c.name)).toEqual(['a', 'b']);
    });
    it('changes the active owner tabs atomically and leaves inactive SQL byte-for-byte', () => {
        const tabs = [{ id: 'ddl', sql: prefix }, { id: 'data', sql: "-- keep\nINSERT INTO t VALUES(1,'ok',2); CREATE VIEW v AS SELECT a FROM t;" }, { id: 'off', sql: 'CREATE VIEW private AS SELECT a FROM t;', isInactive: true }];
        const result = edit(tabs); expect(result.ok, result.message).toBe(true); expect(result.nextTabs[2]).toEqual(tabs[2]); expect(result.nextTabs[1].sql).toContain('-- keep'); expect(result.nextTabs[1].sql).not.toContain('CREATE VIEW'); expect(result.nextTabs[1].sql).toContain("VALUES('ok', 2)");
    });
    it.each([
        ['SET NAMES utf8mb4;', "INSERT t(a,b) VALUE(1,'keep');", "INSERT t(b) VALUE('keep');"],
        ['SET ANSI_NULLS ON;', "INSERT t(a,b) VALUES(1,'keep');", "INSERT t(b) VALUES('keep');"],
        ['PRAGMA foreign_keys=ON;', "REPLACE INTO t(a,b) VALUES(1,'keep');", "REPLACE INTO t(b) VALUES('keep');"],
    ])('rewrites native insert variants with %s', (dialect, data, expected) => {
        const result = edit(dialect + 'CREATE TABLE t(a INTEGER,b TEXT);' + data); expect(result.ok, result.message).toBe(true); expect(result.sql).toContain(expected);
    });
    it('keeps DEFAULT VALUES rows and removes only deleted PostgreSQL column comments', () => {
        const sql = 'SET search_path=public; CREATE TABLE t(a INTEGER,b TEXT); INSERT INTO t DEFAULT VALUES; COMMENT ON COLUMN t.a IS \'removed\'; COMMENT ON COLUMN t.b IS \'kept\';';
        const result = edit(sql); expect(result.ok, result.message).toBe(true); expect(result.sql).toContain('DEFAULT VALUES'); expect(result.sql).not.toContain("IS 'removed'"); expect(result.sql).toContain("IS 'kept'");
    });
    it('removes a dependent ALTER CHECK while retaining checks on remaining fields', () => {
        const sql = 'SET search_path=public; CREATE TABLE t(a INTEGER,b TEXT); ALTER TABLE t ADD CONSTRAINT keep_b CHECK(length(b)>0); ALTER TABLE t ADD CONSTRAINT gone_a CHECK(a>0);';
        const result = edit(sql); expect(result.ok, result.message).toBe(true); expect(result.sql).toContain('keep_b'); expect(result.sql).not.toContain('gone_a'); expect(result.impacts.some((i) => i.kind === 'remove-check')).toBe(true);
    });
    it('keeps recreated views and their later consumers when their new definition is independent', () => {
        const result = edit(prefix + 'CREATE VIEW v AS SELECT a FROM t; DROP VIEW v; CREATE VIEW v AS SELECT b FROM t; CREATE VIEW wrapped AS SELECT * FROM v; SELECT * FROM wrapped;');
        expect(result.ok, result.message).toBe(true); expect(result.sql).not.toContain('DROP VIEW'); expect(result.sql).toContain('CREATE VIEW v AS SELECT b'); expect(result.sql).toContain('CREATE VIEW wrapped'); expect(result.sql).toContain('SELECT * FROM wrapped');
        if (DatabaseSync) { const db = new DatabaseSync(':memory:'); try { db.exec(result.sql); } finally { db.close(); } }
    });
    it('lists a complete dependent MERGE for confirmation', () => {
        const result = edit(prefix + "MERGE INTO t USING other ON t.a=other.a WHEN MATCHED THEN UPDATE SET b='x';");
        expect(result.ok, result.message).toBe(true); expect(result.sql).not.toContain('MERGE'); expect(result.impacts).toContainEqual(expect.objectContaining({ kind: 'remove-statement', label: expect.stringContaining('MERGE') }));
    });
    it('can cascade data after a latest ADD while leaving earlier positional inserts intact', () => {
        const sql = "PRAGMA foreign_keys=ON; CREATE TABLE t(id INTEGER, b TEXT); INSERT INTO t VALUES(1,'before'); ALTER TABLE t ADD a INTEGER; INSERT INTO t VALUES(2,'after',3);";
        const result = edit(sql); expect(result.ok, result.message).toBe(true); expect(result.sql).toContain("VALUES(1,'before')"); expect(result.sql).toContain("VALUES(2, 'after')"); expect(result.sql).not.toContain('ALTER TABLE');
        if (DatabaseSync) { const db = new DatabaseSync(':memory:'); try { db.exec(result.sql); expect(db.prepare('SELECT * FROM t').all()).toHaveLength(2); } finally { db.close(); } }
    });
    it.each([
        prefix + ' CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET b=NEW.a;',
        'PRAGMA foreign_keys=ON; CREATE TABLE t(a INTEGER, g INTEGER GENERATED ALWAYS AS(a+1) VIRTUAL);',
        'SET search_path=public; CREATE TABLE t(a INTEGER,b TEXT); COPY t FROM stdin;',
    ])('rejects an unsupported or incomplete cascade without candidate SQL: %s', (sql) => {
        const result = edit(sql); expect(result.ok).toBe(false); expect(result.nextTabs).toBeUndefined();
    });
});
