import { describe, expect, it } from 'vitest';
import { prepareCanvasEditInTabs } from '@/features/editor/lib/canvasSchemaEdits';
import { buildCombinedSql } from '@/features/editor/lib/sqlTabs';
import { sqlToErdSchema } from '@/lib/erdJsonSchema';
import { sampleSchemaSQL } from '@/features/editor/lib/sampleSQL';
let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* native SQLite optional on older Node */ }
const tabs = (sql) => [{ id: 'schema', title: 'Schema', sql }];
const connection = { kind: 'add-relationship', from: { table: 'c', column: 'parent_id' }, to: { table: 'p', column: 'id' } };
function apply(sql, action) {
    const result = prepareCanvasEditInTabs(Array.isArray(sql) ? sql : tabs(sql), action);
    return { ...result, sql: result.nextTabs && buildCombinedSql(result.nextTabs).sql };
}
const ddl = 'CREATE TABLE p(id INT PRIMARY KEY, note TEXT); CREATE TABLE c(parent_id INT, other INT);';
describe('direct canvas schema edits', () => {
    it('recreates the commerce sample category connection without an unrelated migration blocking it', () => {
        const schema = sqlToErdSchema(sampleSchemaSQL);
        const relation = schema.relations.find(r => r.from.table === 'products' && r.from.column === 'category_id');
        expect(relation.to).toEqual({ table: 'categories', column: 'id' });
        expect(apply(sampleSchemaSQL, { kind: 'add-relationship', from: relation.from, to: relation.to }).message).toContain('already');
        const removed = apply(sampleSchemaSQL, { kind: 'remove-relationship', relation });
        expect(removed.ok, removed.message).toBe(true);
        const result = apply(removed.nextTabs, { kind: 'add-relationship', from: relation.from, to: relation.to });
        expect(result.ok, result.message).toBe(true);
        expect(result.sql).toContain('ADD COLUMN retired_at TEXT');
        expect(result.sql).toContain('DROP COLUMN retired_at');
        expect(result.sql).not.toContain('ALTER TABLE products ADD FOREIGN KEY');
        expect(sqlToErdSchema(result.sql).relations).toHaveLength(5);
        expect(sqlToErdSchema(result.sql)._parseErrors).toEqual([]);
    });
    it.each(['', 'PRAGMA foreign_keys=ON;'])('adds a connection when migrations change only other columns (%s)', prefix => {
        const sql = prefix + ddl + ' ALTER TABLE c ADD retired TEXT; ALTER TABLE c DROP COLUMN retired;';
        const result = apply(sql, connection);
        expect(result.ok, result.message).toBe(true);
        expect(result.sql).toContain('ALTER TABLE c ADD retired TEXT');
        expect(result.sql).toContain('ALTER TABLE c DROP COLUMN retired');
        if (DatabaseSync) {
            const database = new DatabaseSync(':memory:');
            try { database.exec('PRAGMA foreign_keys=ON; ' + result.sql); database.exec('INSERT INTO p(id) VALUES(1); INSERT INTO c(parent_id) VALUES(1);'); expect(() => database.exec('INSERT INTO c(parent_id) VALUES(2);')).toThrow(/FOREIGN KEY/i); }
            finally { database.close(); }
        }
    });
    it.each([
        'ALTER TABLE c RENAME COLUMN parent_id TO temporary; ALTER TABLE c RENAME COLUMN temporary TO parent_id;',
        'ALTER TABLE c DROP COLUMN parent_id; ALTER TABLE c ADD parent_id INT;',
    ])('does not mistake a replaced or renamed endpoint for an unchanged field: %s', history => {
        const result = apply(ddl + history, connection);
        expect(result.ok).toBe(false); expect(result.message).toContain('connection fields change');
    });
    it.each(['', 'PRAGMA foreign_keys=ON;', 'SET search_path=public;', 'SET NAMES utf8mb4;', 'SET ANSI_NULLS ON;'])('uses the surviving CREATE rather than a dropped table\'s endpoint history: %s', prefix => {
        const sql = prefix + ddl + ' ALTER TABLE c DROP COLUMN parent_id; ALTER TABLE c ADD parent_id INT; DROP TABLE c; CREATE TABLE c(parent_id INT, other INT);';
        const result = apply(sql, connection);
        expect(result.ok, result.message).toBe(true);
        expect(result.sql.indexOf('FOREIGN KEY')).toBeGreaterThan(result.sql.indexOf('DROP TABLE c'));
        expect(result.sql).toContain('ALTER TABLE c DROP COLUMN parent_id; ALTER TABLE c ADD parent_id INT;');
        expect(sqlToErdSchema(result.sql).relations).toMatchObject([{ from: connection.from, to: connection.to }]);
        if (DatabaseSync && prefix.startsWith('PRAGMA')) {
            const database = new DatabaseSync(':memory:');
            try { database.exec(result.sql); expect(() => database.exec('INSERT INTO c(parent_id) VALUES(99);')).toThrow(/FOREIGN KEY/i); }
            finally { database.close(); }
        }
    });
    it.each([
        ['SET search_path=public;', 'ALTER TABLE c ALTER COLUMN other TYPE BIGINT;'],
        ['SET NAMES utf8mb4;', 'ALTER TABLE c MODIFY COLUMN other BIGINT;'],
        ['SET NAMES utf8mb4;', 'ALTER TABLE c CHANGE COLUMN other renamed BIGINT;'],
        ['SET ANSI_NULLS ON;', "EXEC sp_rename 'c.other', 'renamed', 'COLUMN';"],
    ])('keeps the connection at CREATE time when only another field changes: %s %s', (prefix, history) => {
        const result = apply(prefix + ddl + history, connection);
        expect(result.ok, result.message).toBe(true);
        expect(result.sql).toContain(history); expect(result.sql).not.toContain('ADD FOREIGN KEY');
    });
    it.each([
        ['SET search_path=public;', 'ALTER TABLE c ALTER COLUMN parent_id TYPE BIGINT;'],
        ['SET NAMES utf8mb4;', 'ALTER TABLE c MODIFY COLUMN parent_id BIGINT;'],
        ['SET ANSI_NULLS ON;', 'ALTER TABLE c ALTER COLUMN parent_id BIGINT;'],
    ])('uses a later native constraint when the actual endpoint changes type: %s', (prefix, history) => {
        const result = apply(prefix + ' CREATE TABLE p(id BIGINT PRIMARY KEY); CREATE TABLE c(parent_id INT);' + history, connection);
        expect(result.ok, result.message).toBe(true);
        expect(result.sql.indexOf('ADD FOREIGN KEY')).toBeGreaterThan(result.sql.indexOf(history));
    });
    it.each(['PRAGMA foreign_keys=ON;', 'SET search_path=public;', 'SET NAMES utf8mb4;', 'SET ANSI_NULLS ON;', ''])('adds native FK SQL with %s', (prefix) => {
        const result = apply(prefix + ddl, connection);
        expect(result.ok, result.message).toBe(true);
        expect(sqlToErdSchema(result.sql).relations).toMatchObject([{ from: connection.from, to: connection.to }]);
        expect(result.sql).toContain('other INT');
    });
    it.each(['PRAGMA foreign_keys=ON;', 'SET search_path=public;', 'SET NAMES utf8mb4;', 'SET ANSI_NULLS ON;'])('supports a forward target without forward-invalid CREATE SQL with %s', (prefix) => {
        const result = apply(prefix + 'CREATE TABLE c(parent_id INT); CREATE TABLE p(id INT PRIMARY KEY);', connection);
        expect(result.ok, result.message).toBe(true);
        if (prefix.startsWith('PRAGMA')) expect(result.sql).not.toContain('ALTER TABLE');
        else expect(result.sql.indexOf('ALTER TABLE')).toBeGreaterThan(result.sql.indexOf('CREATE TABLE p'));
    });
    it('writes a later FK into the last active tab without touching the focused/inactive tab', () => {
        const source = [{ id: 'c', sql: 'SET search_path=public; CREATE TABLE c(parent_id INT);' }, { id: 'p', sql: 'CREATE TABLE p(id INT PRIMARY KEY); -- EOF' }, { id: 'off', sql: 'SELECT sensitive;', isInactive: true }];
        const result = apply(source, connection);
        expect(result.ok, result.message).toBe(true);
        expect(result.nextTabs[0]).toEqual(source[0]); expect(result.nextTabs[2]).toEqual(source[2]);
        expect(result.nextTabs[1].sql).toContain('-- EOF\nALTER TABLE');
    });
    it.each([
        ['type mismatch', ddl.replace('parent_id INT', 'parent_id UUID'), 'Types must match'],
        ['no complete key', ddl.replace('PRIMARY KEY', ''), 'primary key'],
        ['compound key subset', ddl.replace('id INT PRIMARY KEY, note TEXT', 'id INT, note INT, PRIMARY KEY(id,note)'), 'complete'],
        ['partial index', ddl.replace('PRIMARY KEY', '') + ' CREATE UNIQUE INDEX u ON p(id) WHERE id>0;', 'primary key'],
        ['expression index', ddl.replace('PRIMARY KEY', '') + ' CREATE UNIQUE INDEX u ON p(id, (lower(note)));', 'primary key'],
        ['duplicate', ddl.replace('parent_id INT', 'parent_id INT REFERENCES p(id)'), 'already'],
        ['unknown forward dialect', 'CREATE TABLE c(parent_id INT); CREATE TABLE p(id INT PRIMARY KEY);', 'before'],
    ])('rejects %s', (_label, sql, reason) => {
        const result = apply(sql, connection); expect(result.ok).toBe(false); expect(result.message).toContain(reason);
    });
    it('supports a later native key and preserves existing FKs', () => {
        const sql = 'SET search_path=public; CREATE TABLE p(id INT); CREATE TABLE c(parent_id INT, other INT); ALTER TABLE p ADD UNIQUE(id); CREATE TABLE d(id INT REFERENCES p(id));';
        const result = apply(sql, connection); expect(result.ok, result.message).toBe(true);
        expect(result.sql).toContain('ALTER TABLE "c" ADD FOREIGN KEY'); expect(sqlToErdSchema(result.sql).relations).toHaveLength(2);
    });
    it('adds a column before table constraints and preserves options/comments/inactive SQL', () => {
        const sql = 'PRAGMA foreign_keys=ON; CREATE TABLE t(id INTEGER, /* keep */ title TEXT, PRIMARY KEY(id)) STRICT, WITHOUT ROWID; -- tail';
        const result = apply([{ id: 'a', sql }, { id: 'b', sql: 'CREATE TABLE secret(x);', isInactive: true }], { kind: 'add-column', table: 't', column: 'price', definition: 'REAL NOT NULL DEFAULT 0' });
        expect(result.ok, result.message).toBe(true); expect(result.sql).toContain('/* keep */ title TEXT');
        expect(result.sql.indexOf('"price" REAL')).toBeLessThan(result.sql.indexOf('PRIMARY KEY(id)'));
        expect(result.sql).toContain('STRICT, WITHOUT ROWID; -- tail'); expect(result.nextTabs[1].sql).toBe('CREATE TABLE secret(x);');
    });
    it.each(['NUMERIC', 'TEXT, injected INT', 'TEXT); DROP TABLE t; CREATE TABLE t(x TEXT', 'TEXT, UNIQUE(id)'])('rejects invalid/injected STRICT column definition %s', (definition) => {
        const result = apply('CREATE TABLE t(id INTEGER PRIMARY KEY) STRICT;', { kind: 'add-column', table: 't', column: 'x', definition }); expect(result.ok).toBe(false);
    });
    it('rejects duplicate identifiers with native case folding', () => {
        expect(apply('PRAGMA foreign_keys=ON; CREATE TABLE t(id INT);', { kind: 'add-column', table: 't', column: 'ID', definition: 'TEXT' }).ok).toBe(false);
    });
    it('removes connected keys/complete FK groups across tabs and preserves unrelated column constraints', () => {
        const source = [{ id: 'p', sql: 'PRAGMA foreign_keys=ON; CREATE TABLE p(id INTEGER PRIMARY KEY, title TEXT);' }, { id: 'c', sql: 'CREATE TABLE c(pid INTEGER CONSTRAINT fk REFERENCES p(id) ON DELETE CASCADE NOT NULL DEFAULT 1 CHECK(pid>0), keep TEXT);' }];
        const result = apply(source, { kind: 'remove-column', table: 'p', column: 'id' });
        expect(result.ok, result.message).toBe(true); expect(result.sql).not.toContain('REFERENCES');
        expect(result.sql).toContain('NOT NULL DEFAULT 1 CHECK(pid>0)'); expect(result.sql).toContain('title TEXT');
        expect(result.impacts.some((i) => i.kind === 'remove-relationship')).toBe(true);
        expect(result.impacts.some((i) => i.kind === 'remove-key')).toBe(true);
    });
    it('removes complete compound keys, indexes and incoming compound FKs rather than inventing subsets', () => {
        const sql = 'PRAGMA foreign_keys=ON; CREATE TABLE p(a INTEGER,b INTEGER,c TEXT, PRIMARY KEY(a,b)); CREATE TABLE child(x INTEGER,y INTEGER, FOREIGN KEY(x,y) REFERENCES p(a,b)); CREATE INDEX idx ON p(a,c);';
        const result = apply(sql, { kind: 'remove-column', table: 'p', column: 'a' });
        expect(result.ok, result.message).toBe(true); expect(result.sql).not.toContain('PRIMARY KEY'); expect(result.sql).not.toContain('FOREIGN KEY'); expect(result.sql).not.toContain('CREATE INDEX');
        expect(result.impacts.filter((i) => i.kind === 'remove-relationship')).toHaveLength(1);
    });
    it('removes outgoing inline and table FK constraints when deleting their source field', () => {
        for (const sql of [ddl.replace('parent_id INT', 'parent_id INT REFERENCES p(id)'), ddl.replace('other INT)', 'other INT, FOREIGN KEY(parent_id) REFERENCES p(id))')]) {
            const result = apply(sql, { kind: 'remove-column', table: 'c', column: 'parent_id' });
            expect(result.ok, result.message).toBe(true); expect(result.sql).not.toContain('REFERENCES'); expect(result.impacts).toHaveLength(1);
        }
    });
    it('removes ALTER constraints in their owning tab', () => {
        const sql = 'SET search_path=public; CREATE TABLE p(id INT PRIMARY KEY, other TEXT); CREATE TABLE c(id INT); ALTER TABLE c ADD CONSTRAINT fk FOREIGN KEY(id) REFERENCES p(id);';
        const result = apply(sql, { kind: 'remove-column', table: 'p', column: 'id' });
        expect(result.ok, result.message).toBe(true); expect(result.sql).not.toContain('ALTER TABLE c');
    });
    it.each([
        'CREATE TABLE t(a INT, b INT CHECK(a>0));',
        'CREATE TABLE t(a INT, b INT GENERATED ALWAYS AS (a+1) STORED);',
        'CREATE TABLE t(a INT,b INT); INSERT INTO t VALUES(1,2);',
        'CREATE TABLE t(a INT,b INT); CREATE VIEW v AS SELECT a FROM t;',
        'CREATE TABLE t(a INT,b INT); CREATE INDEX idx ON t(a) WHERE b>0;',
    ])('blocks unsafe remaining expression/data dependencies: %s', (sql) => {
        const result = apply(sql, { kind: 'remove-column', table: 't', column: 'a' }); expect(result.ok, result.message).toBe(false);
    });
    it.each(['VIRTUAL', ''])('rejects MySQL virtual generated referenced keys (%s)', (storage) => {
        const sql = `SET NAMES utf8mb4; CREATE TABLE p(base INT, id INT GENERATED ALWAYS AS (base+1) ${storage}, UNIQUE(id)); CREATE TABLE c(parent_id INT);`;
        const result = apply(sql, connection); expect(result.ok).toBe(false); expect(result.message).toContain('virtual');
    });
    it('accepts stored generated MySQL keys using native default FK actions', () => {
        const sql = 'SET NAMES utf8mb4; CREATE TABLE p(base INT, id INT GENERATED ALWAYS AS (base+1) STORED, UNIQUE(id)); CREATE TABLE c(parent_id INT);';
        const result = apply(sql, connection); expect(result.ok, result.message).toBe(true);
    });
    it('rejects a new inline SET NULL relationship on a required field', () => {
        const result = apply('PRAGMA foreign_keys=ON; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(keep TEXT);', { kind: 'add-column', table: 'c', column: 'pid', definition: 'INTEGER NOT NULL REFERENCES p(id) ON DELETE SET NULL' });
        expect(result.ok).toBe(false); expect(result.message).toContain('nullable');
    });
    it.each([
        'CREATE TABLE t(id INTEGER PRIMARY KEY, note TEXT); ALTER TABLE t DROP CONSTRAINT t_pkey;',
        'CREATE TABLE t(id INTEGER, note TEXT, CONSTRAINT pk PRIMARY KEY(id)); ALTER TABLE t RENAME CONSTRAINT pk TO pk_next;',
        'CREATE TABLE t(id INTEGER, note TEXT); CREATE INDEX ix ON t(id); DROP INDEX ix;',
    ])('blocks removing a key field whose DDL history would become invalid: %s', (body) => {
        const result = apply('SET search_path=public; ' + body, { kind: 'remove-column', table: 't', column: 'id' });
        expect(result.ok).toBe(false); expect(result.message).toContain('history');
        const unrelated = apply('SET search_path=public; ' + body, { kind: 'remove-column', table: 't', column: 'note' }); expect(unrelated.ok, unrelated.message).toBe(true);
    });
    it('does not recreate a foreign key against an implicitly dropped PostgreSQL key', () => {
        const sql = 'SET search_path=public; CREATE TABLE p(id INTEGER PRIMARY KEY, note TEXT); ALTER TABLE p DROP CONSTRAINT p_pkey; CREATE TABLE c(parent_id INTEGER);';
        const result = apply(sql, connection); expect(result.ok).toBe(false); expect(result.message).toContain('constraint history');
    });
    it('places a new FK after an explicit key replacement instead of blocking its DROP', () => {
        const sql = 'SET search_path=public; CREATE TABLE p(id INTEGER, CONSTRAINT pk PRIMARY KEY(id)); CREATE TABLE c(parent_id INTEGER); ALTER TABLE p DROP CONSTRAINT pk; ALTER TABLE p ADD CONSTRAINT next_pk PRIMARY KEY(id);';
        const result = apply(sql, connection); expect(result.ok, result.message).toBe(true); expect(result.sql.indexOf('ALTER TABLE "c"')).toBeGreaterThan(result.sql.indexOf('next_pk'));
    });
    it('preserves quoted dots while finding key replacement histories', () => {
        const sql = 'SET search_path=public; CREATE TABLE "p.dot"(id INTEGER, CONSTRAINT pk PRIMARY KEY(id)); CREATE TABLE c(parent_id INTEGER); ALTER TABLE "p.dot" DROP CONSTRAINT pk; ALTER TABLE "p.dot" ADD CONSTRAINT next_pk PRIMARY KEY(id);';
        const name = sqlToErdSchema(sql).tables[0].name;
        const result = apply(sql, { ...connection, to: { table: name, column: 'id' } }); expect(result.ok, result.message).toBe(true); expect(result.sql.indexOf('ALTER TABLE "c"')).toBeGreaterThan(result.sql.indexOf('next_pk'));
    });
    it('keeps portable SQL identifiers unquoted instead of guessing a dialect', () => {
        const result = apply(ddl, connection); expect(result.ok, result.message).toBe(true); expect(result.sql).toContain('FOREIGN KEY (parent_id) REFERENCES p (id)'); expect(sqlToErdSchema(result.sql).dialect).toBe('auto');
        const added = apply(ddl, { kind: 'add-column', table: 'c', column: 'amount', definition: 'INTEGER' }); expect(added.ok, added.message).toBe(true); expect(added.sql).toContain('amount INTEGER');
        expect(apply(ddl, { kind: 'add-column', table: 'c', column: 'reserved field', definition: 'TEXT' }).ok).toBe(false);
    });
    it('can add the first field to a native PostgreSQL empty table', () => {
        const result = apply('CREATE TABLE t();', { kind: 'add-column', table: 't', column: 'id', definition: 'INTEGER' });
        expect(result.ok, result.message).toBe(true); expect(result.sql).toContain('"id" INTEGER');
    });
    it.each(['PRAGMA foreign_keys=ON;', 'SET search_path=public;', 'SET NAMES utf8mb4;', 'SET ANSI_NULLS ON;', ''])('adds after column migration history with %s', (prefix) => {
        const sql = prefix + ' CREATE TABLE t(id INTEGER); ALTER TABLE t ADD note TEXT;';
        const result = apply(sql, { kind: 'add-column', table: 't', column: 'amount', definition: 'INTEGER DEFAULT 0' });
        expect(result.ok, result.message).toBe(true); expect(result.sql.startsWith(sql)).toBe(true);
        expect(sqlToErdSchema(result.sql).tables[0].columns.map((c) => c.name)).toEqual(['id', 'note', 'amount']);
        const duplicate = apply(result.sql, { kind: 'add-column', table: 't', column: 'note', definition: 'TEXT' });
        expect(duplicate.ok).toBe(false); expect(duplicate.message).toContain('unique');
    });
    it('uses the current table name after SQLite renames and retains STRICT validation', () => {
        const sql = 'PRAGMA foreign_keys=ON; CREATE TABLE t(id INTEGER, note TEXT) STRICT; ALTER TABLE t RENAME COLUMN note TO info; ALTER TABLE t RENAME TO current_table;';
        const action = { kind: 'add-column', table: 'current_table', column: 'amount', definition: 'REAL' };
        const result = apply(sql, action); expect(result.ok, result.message).toBe(true);
        expect(result.sql.startsWith(sql)).toBe(true); expect(result.sql).toContain('ALTER TABLE "current_table" ADD COLUMN "amount" REAL;');
        expect(apply(sql, { ...action, definition: 'NUMERIC' }).ok).toBe(false);
        if (DatabaseSync) { const db = new DatabaseSync(':memory:'); try { db.exec(result.sql); expect(db.prepare('PRAGMA table_info(current_table)').all().map((c) => c.name)).toEqual(['id', 'info', 'amount']); } finally { db.close(); } }
    });
    it('adds after drop/recreate without rewriting the retired incarnation or inactive SQL', () => {
        const source = [{ id: 'old', sql: 'PRAGMA foreign_keys=ON; CREATE TABLE t(retired TEXT); DROP TABLE t;' }, { id: 'live', sql: 'CREATE TABLE t(id INTEGER); -- EOF' }, { id: 'off', sql: 'private', isInactive: true }];
        const result = apply(source, { kind: 'add-column', table: 't', column: 'note', definition: 'TEXT' });
        expect(result.ok, result.message).toBe(true); expect(result.nextTabs[0]).toEqual(source[0]); expect(result.nextTabs[2]).toEqual(source[2]);
        expect(result.nextTabs[1].sql).toContain('-- EOF\nALTER TABLE'); expect(sqlToErdSchema(result.sql).tables[0].columns.map((c) => c.name)).toEqual(['id', 'note']);
    });
    it.each(['TEXT PRIMARY KEY', 'TEXT UNIQUE', 'TEXT NOT NULL', 'TEXT DEFAULT CURRENT_TIMESTAMP', 'TEXT DEFAULT (lower(\'a\'))', 'INTEGER GENERATED ALWAYS AS (id+1) STORED'])('rejects native SQLite ADD restrictions: %s', (definition) => {
        const result = apply('PRAGMA foreign_keys=ON; CREATE TABLE t(id INTEGER); ALTER TABLE t ADD note TEXT;', { kind: 'add-column', table: 't', column: 'amount', definition });
        expect(result.ok).toBe(false); expect(result.message).not.toContain('complete history');
    });
    it('rejects injected definitions in historical additions', () => {
        const sql = 'SET search_path=public; CREATE TABLE t(id INTEGER); ALTER TABLE t ADD note TEXT;';
        for (const definition of ['TEXT, injected INTEGER', 'TEXT); DROP TABLE t; CREATE TABLE injected(id INTEGER', 'TEXT, UNIQUE(id)']) {
            expect(apply(sql, { kind: 'add-column', table: 't', column: 'amount', definition }).ok).toBe(false);
        }
    });
    it('can remove its new standalone addition without rewriting migration history', () => {
        const sql = 'PRAGMA foreign_keys=ON; CREATE TABLE t(id INTEGER); ALTER TABLE t ADD note TEXT; ALTER TABLE t RENAME TO current_table;';
        const added = apply(sql, { kind: 'add-column', table: 'current_table', column: 'amount', definition: 'REAL DEFAULT 0' }); expect(added.ok, added.message).toBe(true);
        const removed = apply(added.sql, { kind: 'remove-column', table: 'current_table', column: 'amount' }); expect(removed.ok, removed.message).toBe(true);
        expect(removed.sql.trim()).toBe(sql); expect(sqlToErdSchema(removed.sql).tables[0].columns.map((c) => c.name)).toEqual(['id', 'note']);
    });
    it('keeps dependent later migrations and indexes when a removal is unsafe', () => {
        const sql = 'SET search_path=public; CREATE TABLE t(id INTEGER); ALTER TABLE t ADD note TEXT;';
        for (const suffix of [' CREATE INDEX ix ON t(note);', ' ALTER TABLE t ADD generated TEXT GENERATED ALWAYS AS (lower(note)) STORED;', ' CREATE VIEW v AS SELECT note FROM t;']) {
            expect(apply(sql + suffix, { kind: 'remove-column', table: 't', column: 'note' }).ok).toBe(false);
        }
    });
    it('never removes an unrelated expression index sharing the same ALTER statement', () => {
        const sql = 'SET NAMES utf8mb4; CREATE TABLE t(id TEXT); ALTER TABLE t ADD note TEXT, ADD INDEX ix((lower(id)));';
        const result = apply(sql, { kind: 'remove-column', table: 't', column: 'note' });
        expect(result).toMatchObject({ ok: false, canCascade: true });
        const reviewed = apply(sql, { kind: 'remove-column', table: 't', column: 'note', cascade: true });
        expect(reviewed.ok, reviewed.message).toBe(true); expect(reviewed.sql).toContain('ADD INDEX ix((lower(id)))');
    });
    it('preserves quoted punctuation in the current renamed table name', () => {
        const sql = 'SET search_path=public; CREATE TABLE t(id INTEGER); ALTER TABLE t RENAME TO "current.dot";';
        const name = sqlToErdSchema(sql).tables[0].name;
        const result = apply(sql, { kind: 'add-column', table: name, column: 'note', definition: 'TEXT' });
        expect(result.ok, result.message).toBe(true); expect(result.sql).toContain('ALTER TABLE "current.dot" ADD COLUMN "note" TEXT;');
    });
    it.skipIf(!DatabaseSync)('adds after positional inserts without invalidating old data statements', () => {
        const sql = 'PRAGMA foreign_keys=ON; CREATE TABLE t(id INTEGER); INSERT INTO t VALUES(1); ALTER TABLE t ADD note TEXT;';
        const result = apply(sql, { kind: 'add-column', table: 't', column: 'amount', definition: 'REAL NOT NULL DEFAULT 0' }); expect(result.ok, result.message).toBe(true);
        const db = new DatabaseSync(':memory:'); try { db.exec(result.sql); expect({ ...db.prepare('SELECT * FROM t').get() }).toEqual({ id: 1, note: null, amount: 0 }); } finally { db.close(); }
    });
    it('validates native defaults and referenced keys for historical SQLite additions', () => {
        const sql = 'PRAGMA foreign_keys=ON; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE t(id INTEGER); ALTER TABLE t ADD note TEXT;';
        const action = { kind: 'add-column', table: 't', column: 'pid', definition: 'INTEGER REFERENCES p(id)' };
        const result = apply(sql, action); expect(result.ok, result.message).toBe(true); expect(sqlToErdSchema(result.sql).relations).toHaveLength(1);
        expect(apply(sql, { ...action, definition: 'INTEGER DEFAULT 1 REFERENCES p(id)' }).ok).toBe(false);
        expect(apply(sql, { ...action, definition: 'TEXT REFERENCES p(id)' }).ok).toBe(false);
        if (DatabaseSync) { const db = new DatabaseSync(':memory:'); try { db.exec(result.sql); expect(() => db.exec('INSERT INTO t(pid) VALUES(999)')).toThrow(); } finally { db.close(); } }
    });
    it('keeps unrelated expression indexes and foreign keys when removing a different field', () => {
        const sql = 'PRAGMA foreign_keys=ON; CREATE TABLE q(id INTEGER PRIMARY KEY); CREATE TABLE p(gone INTEGER, keep INTEGER, note TEXT, FOREIGN KEY(keep) REFERENCES q(id)); CREATE INDEX exp ON p((lower(note)));';
        const result = apply(sql, { kind: 'remove-column', table: 'p', column: 'gone' });
        expect(result.ok, result.message).toBe(true); expect(result.sql).toContain('FOREIGN KEY(keep)'); expect(result.sql).toContain('CREATE INDEX exp');
    });
    it('never removes the last field', () => expect(apply('CREATE TABLE t(a INT);', { kind: 'remove-column', table: 't', column: 'a' }).ok).toBe(false));
    it('quotes punctuation names safely without treating defaults as column delimiters', () => {
        const sql = 'PRAGMA foreign_keys=ON; CREATE TABLE "p.dot"("id)" INTEGER PRIMARY KEY); CREATE TABLE c("pid," INTEGER, keep TEXT DEFAULT \',)\');';
        const result = apply(sql, { kind: 'add-relationship', from: { table: 'c', column: 'pid,' }, to: { table: sqlToErdSchema(sql).tables[0].name, column: 'id)' } });
        expect(result.ok, result.message).toBe(true); expect(result.sql).toContain('REFERENCES "p.dot" ("id)")'); expect(result.sql).toContain("DEFAULT ',)'");
    });
    it.skipIf(!DatabaseSync)('executes add/connect/remove SQL in native SQLite with enforced foreign keys', () => {
        const db = new DatabaseSync(':memory:');
        try {
            const initial = 'PRAGMA foreign_keys=ON; CREATE TABLE p(id INTEGER PRIMARY KEY, note TEXT); CREATE TABLE c(parent_id INTEGER, keep TEXT) STRICT;';
            const added = apply(initial, { kind: 'add-column', table: 'c', column: 'amount', definition: 'REAL NOT NULL DEFAULT 0' }); expect(added.ok, added.message).toBe(true);
            const connected = apply(added.sql, connection); expect(connected.ok, connected.message).toBe(true); db.exec(connected.sql);
            db.exec('INSERT INTO p(id) VALUES(1); INSERT INTO c(parent_id) VALUES(1);'); expect(() => db.exec('INSERT INTO c(parent_id) VALUES(999)')).toThrow();
            const removed = apply(connected.sql, { kind: 'remove-column', table: 'p', column: 'id' }); expect(removed.ok, removed.message).toBe(true);
            db.exec('DROP TABLE c; DROP TABLE p;'); db.exec(removed.sql); expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        } finally { db.close(); }
    });
});
