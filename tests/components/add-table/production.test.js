import { describe, expect, it } from 'vitest';
import { generateSql, getAddTableValidationErrors } from '@/components/AddTable';
import { DIALECT_BY_ID } from '@/components/AddTable/dialectConfig';
import { sqlToErdSchema } from '@/lib/erdJsonSchema';
import { getAddTableReferenceTargets, validateAddTableDraft } from '@/components/AddTable/tableModel';
import { formatDefault } from '@/components/AddTable/dialectConfig';

describe('Add Table native SQL regressions', () => {
    it('emits SQL Server computed columns without a declared type', () => {
        const sql = generateSql({ tableName: 'totals', dialect: DIALECT_BY_ID.mssql, columns: [{ name: 'amount', type: 'INT' }, { name: 'total', type: 'INT', generated: 'amount * 2' }] });
        expect(sql).toContain('total AS (amount * 2) PERSISTED');
        expect(sql).not.toContain('total INT AS');
    });
    it('uses table constraints for MySQL foreign keys, which ignores inline references', () => {
        const sql = generateSql({ tableName: 'child', dialect: DIALECT_BY_ID.mysql, columns: [{ name: 'pid', type: 'INT', references: { table: 'parent', column: 'id', onDelete: 'CASCADE' } }] });
        expect(sql).toContain('FOREIGN KEY (pid) REFERENCES parent(id) ON DELETE CASCADE');
        expect(sql).not.toContain('pid INT REFERENCES');
    });
    it('quotes a dotted column as one identifier and omits database qualifiers from SQLite references', () => {
        const sql = generateSql({ tableName: 'child', dialect: DIALECT_BY_ID.sqlite, columns: [{ name: 'parent.id', type: 'INTEGER', references: { table: 'main.parent', column: 'parent.id' } }] });
        expect(sql).toContain('"parent.id" INTEGER REFERENCES parent("parent.id")');
    });
    it.each(['mysql', 'mssql'])('rejects multiple auto-increment columns for %s', id => {
        expect(getAddTableValidationErrors({ dialect: DIALECT_BY_ID[id], columns: [{ name: 'a', type: 'INT', primaryKey: true, autoIncrement: true }, { name: 'b', type: 'INT', primaryKey: true, autoIncrement: true }] }).join(' ')).toMatch(/only one/i);
    });
    it.each(['mssql', 'mysql'])('rejects unsupported referential actions for %s', id => {
        const action = id === 'mssql' ? 'RESTRICT' : 'SET DEFAULT';
        expect(getAddTableValidationErrors({ dialect: DIALECT_BY_ID[id], columns: [{ name: 'pid', type: 'INT', references: { table: 'parent', column: 'id', onDelete: action } }] }).join(' ')).toContain(action);
    });
    it('rejects SET NULL on a required field', () => {
        expect(getAddTableValidationErrors({ dialect: DIALECT_BY_ID.sqlite, columns: [{ name: 'pid', type: 'INTEGER', notNull: true, references: { table: 'parent', column: 'id', onDelete: 'SET NULL' } }] }).join(' ')).toMatch(/nullable/i);
    });
    it.each(['NULL', '(NULL)', '((NULL))'])('requires a non-null default for a required SET DEFAULT field: %s', defaultValue => {
        const column = { name: 'pid', type: 'INTEGER', notNull: true, defaultValue, references: { table: 'parent', column: 'id', onDelete: 'SET DEFAULT' } };
        expect(getAddTableValidationErrors({ dialect: DIALECT_BY_ID.sqlite, columns: [column] }).join(' ')).toContain('non-null default');
        expect(getAddTableValidationErrors({ dialect: DIALECT_BY_ID.sqlite, columns: [{ ...column, notNull: false }] })).toEqual([]);
    });
    it('keeps a composite primary key non-null in PostgreSQL and SQL Server', () => {
        for (const id of ['postgres', 'mssql']) {
            const sql = generateSql({ tableName: 'pair', dialect: DIALECT_BY_ID[id], columns: [{ name: 'a', type: 'INT', primaryKey: true }, { name: 'b', type: 'INT', primaryKey: true }] });
            expect(sql).toContain('a INT NOT NULL');
            expect(sqlToErdSchema(sql, { dialect: id }).tables[0].columns).toHaveLength(2);
        }
    });
});

describe('Add Table insertion validation', () => {
    const draft = (patch = {}) => ({ tableName: 'child', dialect: DIALECT_BY_ID.sqlite, columns: [{ name: 'id', type: 'INTEGER', primaryKey: true }], ...patch });
    it.each(['id::INTEGER IS NOT NULL AND missing > 0', 'id::DOUBLE PRECISION BETWEEN missing AND 10', 'CASE WHEN id::INTEGER IS NULL THEN missing ELSE 0 END'])('checks field dependencies after a PostgreSQL cast: %s', generated => {
        const result = validateAddTableDraft(draft({ dialect: DIALECT_BY_ID.postgres, columns: [{ name: 'id', type: 'INTEGER' }, { name: 'value', type: 'BOOLEAN', generated }] }));
        expect(result.ok).toBe(false); expect(result.errors.join(' ')).toContain('unknown field missing');
    });
    it.each(['child.id + 1', 'other.id + 1', '"other"."id" + 1'])('rejects qualified references in SQLite generated expressions: %s', generated => {
        const result = validateAddTableDraft(draft({ columns: [{ name: 'id', type: 'INTEGER' }, { name: 'value', type: 'INTEGER', generated }] }));
        expect(result.ok).toBe(false); expect(result.errors.join(' ')).toMatch(/unqualified|unknown table/);
        if (DatabaseSync) {
            const database = new DatabaseSync(':memory:');
            try { expect(() => database.exec(generateSql(draft({ columns: [{ name: 'id', type: 'INTEGER' }, { name: 'value', type: 'INTEGER', generated }] })))).toThrow(); }
            finally { database.close(); }
        }
    });
    it.each(['postgres', 'mysql', 'mssql', 'sqlite'])('validates qualified CHECK references against the actual draft table in %s', id => {
        const result = validateAddTableDraft(draft({ dialect: DIALECT_BY_ID[id], columns: [{ name: 'id', type: 'INTEGER', check: 'other.id > 0' }] }));
        expect(result.ok).toBe(false); expect(result.errors.join(' ')).toContain('unknown table other');
    });
    it.each([
        ['id::INTEGER IS NOT NULL AND id > 0', 'INTEGER', 'BOOLEAN'],
        ['id::DOUBLE PRECISION BETWEEN 0 AND 10', 'INTEGER', 'BOOLEAN'],
        ['CASE WHEN id::INTEGER IS NULL THEN 0 ELSE id END', 'INTEGER', 'INTEGER'],
        ['pg_catalog.abs(id)', 'INTEGER', 'INTEGER'],
        ['CAST(id AS pg_catalog.int4) > 0', 'INTEGER', 'BOOLEAN'],
        ['CAST(id AS DOUBLE PRECISION)', 'INTEGER', 'DOUBLE PRECISION'],
        ['id::TIMESTAMP(2) WITHOUT TIME ZONE IS NOT NULL', 'TIMESTAMP', 'BOOLEAN'],
        ["id AT TIME ZONE 'UTC'", 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE'],
        ['id::INTEGER[]', 'INTEGER[]', 'INTEGER[]'],
    ])('retains valid PostgreSQL cast/function grammar and subsequent dependencies: %s', (generated, sourceType, type) => {
        const result = validateAddTableDraft(draft({ dialect: DIALECT_BY_ID.postgres, columns: [{ name: 'id', type: sourceType }, { name: 'value', type, generated }] }));
        expect(result.ok, result.errors.join(' ')).toBe(true);
    });
    it.each(['time', 'zone'])('does not hide a generated self-reference behind the grammar-like field name %s', name => {
        const result = validateAddTableDraft(draft({ columns: [{ name: 'id', type: 'INTEGER' }, { name, type: 'INTEGER', generated: `${name} + 1` }] }));
        expect(result.ok).toBe(false); expect(result.errors.join(' ')).toContain('reference themselves');
    });
    it('allows a quoted dot inside a SQLite field name without treating it as a table qualifier', () => {
        const result = validateAddTableDraft(draft({ columns: [{ name: 'id.dot', type: 'INTEGER' }, { name: 'value', type: 'INTEGER', generated: 'CAST("id.dot" AS INTEGER) + 1' }] }));
        expect(result.ok, result.errors.join(' ')).toBe(true);
        if (DatabaseSync) {
            const database = new DatabaseSync(':memory:');
            try { database.exec(result.sql); database.exec('INSERT INTO child("id.dot") VALUES(4);'); expect(database.prepare('SELECT value FROM child').get().value).toBe(5); }
            finally { database.close(); }
        }
    });
    it('allows a SQLite CHECK to qualify a field by its own table', () => {
        const result = validateAddTableDraft(draft({ columns: [{ name: 'id', type: 'INTEGER', check: 'child.id > 0' }] }));
        expect(result.ok, result.errors.join(' ')).toBe(true);
        if (DatabaseSync) {
            const database = new DatabaseSync(':memory:');
            try { database.exec(result.sql); database.exec('INSERT INTO child VALUES(1);'); expect(() => database.exec('INSERT INTO child VALUES(-1);')).toThrow(/CHECK/); }
            finally { database.close(); }
        }
    });
    it('does not treat comments and spacing inside a valid type as a different storage type', () => {
        const result = validateAddTableDraft(draft({ dialect: DIALECT_BY_ID.mysql, beforeSql: 'SET NAMES utf8mb4; CREATE TABLE parent(id VARCHAR /* key size */ (25) PRIMARY KEY);', columns: [{ name: 'pid', type: 'VARCHAR(25)', references: { table: 'parent', column: 'id' } }] }));
        expect(result.ok, result.errors.join(' ')).toBe(true);
    });
    it('keeps quoted PostgreSQL custom type identities distinct and accepts equivalent lowercase quoting', () => {
        const beforeSql = 'CREATE TYPE "Foo" AS ENUM (\'a\'); CREATE TYPE "foo" AS ENUM (\'a\'); CREATE TABLE p(id "Foo" PRIMARY KEY); CREATE TABLE q(id "foo" PRIMARY KEY);';
        const source = { name: 'pid', type: '"Foo"', references: { table: 'q', column: 'id' } };
        const invalid = validateAddTableDraft(draft({ dialect: DIALECT_BY_ID.postgres, beforeSql, columns: [source] })); expect(invalid.ok).toBe(false);
        const targets = getAddTableReferenceTargets({ schema: sqlToErdSchema(beforeSql), dialect: DIALECT_BY_ID.postgres, column: source }); expect(targets.map(t => t.name)).toEqual(['p']);
        const lower = validateAddTableDraft(draft({ dialect: DIALECT_BY_ID.postgres, beforeSql, columns: [{ ...source, type: 'foo' }] })); expect(lower.ok, lower.errors.join(' ')).toBe(true);
    });
    it.each([
        ['postgres', 'EXTRACT(YEAR FROM created_at)', 'INTEGER'],
        ['mssql', 'DATEPART(year, created_at)', ''],
        ['postgres', 'CAST(EXTRACT(YEAR FROM created_at) AS DOUBLE PRECISION)', 'DOUBLE PRECISION'],
    ])('accepts SQL expression grammar rather than treating date parts and cast types as fields: %s %s', (id, generated, type) => {
        const result = validateAddTableDraft(draft({ dialect: DIALECT_BY_ID[id], columns: [{ name: 'created_at', type: id === 'mssql' ? 'DATETIME2' : 'TIMESTAMP' }, { name: 'year_value', type, generated }] }));
        expect(result.ok, result.errors.join(' ')).toBe(true);
    });
    it('allows SQLite forward foreign keys while requiring server keys at insertion time', () => {
        const input = { afterSql: 'CREATE TABLE parent(id INTEGER PRIMARY KEY);', columns: [{ name: 'pid', type: 'INTEGER', references: { table: 'parent', column: 'id' } }] };
        expect(validateAddTableDraft(draft(input)).ok).toBe(true);
        const server = validateAddTableDraft(draft({ ...input, dialect: DIALECT_BY_ID.postgres })); expect(server.ok).toBe(false); expect(server.errors.join(' ')).toContain('before this table');
    });
    it('rejects a SQLite reference pointing into another attached database', () => {
        const result = validateAddTableDraft(draft({ beforeSql: 'CREATE TABLE main.parent(id INTEGER PRIMARY KEY); CREATE TABLE attached.parent(id INTEGER PRIMARY KEY);', columns: [{ name: 'pid', type: 'INTEGER', references: { table: 'attached.parent', column: 'id' } }] }));
        expect(result.ok).toBe(false); expect(result.errors.join(' ')).toMatch(/same.*database/i);
    });
    it('resolves an attached SQLite table reference within the source database', () => {
        const result = validateAddTableDraft(draft({ tableName: 'attached.child', beforeSql: 'CREATE TABLE main.parent(id TEXT PRIMARY KEY); CREATE TABLE attached.parent(id INTEGER PRIMARY KEY);', columns: [{ name: 'pid', type: 'INTEGER', references: { table: 'attached.parent', column: 'id' } }] }));
        expect(result.ok, result.errors.join(' ')).toBe(true);
        const schema = sqlToErdSchema('PRAGMA foreign_keys=ON; CREATE TABLE main.parent(id TEXT PRIMARY KEY); CREATE TABLE attached.parent(id INTEGER PRIMARY KEY);' + result.sql);
        expect(schema.relations[0].to.table).toBe('attached.parent');
    });
    it.each(['INTEGER, hidden TEXT', 'INTEGER); DROP TABLE parent; --', 'INTEGER PRIMARY KEY', 'VARCHAR(12', 'INTEGER -- comment'])('rejects a field type containing SQL outside the type: %s', type => {
        const result = validateAddTableDraft(draft({ columns: [{ name: 'id', type }] }));
        expect(result.ok).toBe(false); expect(result.errors.join(' ')).toMatch(/data type/i);
    });
    it('accepts punctuation inside quoted literals and dotted column names', () => {
        const result = validateAddTableDraft(draft({ columns: [{ name: 'literal.value', type: 'TEXT', defaultValue: "it's a ); -- literal" }] }));
        expect(result.ok, result.errors.join(' ')).toBe(true);
        expect(sqlToErdSchema(result.sql).tables[0].columns[0].name).toBe('literal.value');
    });
    it('validates key eligibility, exact types and availability at the insertion point', () => {
        const col = { name: 'pid', type: 'INTEGER', references: { table: 'parent', column: 'id' } };
        for (const beforeSql of ['CREATE TABLE parent(id TEXT PRIMARY KEY);', 'CREATE TABLE parent(id INTEGER);', 'CREATE TABLE parent(id INTEGER, other INTEGER, PRIMARY KEY(id,other));', 'CREATE TABLE parent(id INTEGER); CREATE UNIQUE INDEX partial_id ON parent(id) WHERE id > 0;']) expect(validateAddTableDraft(draft({ beforeSql, columns: [col] })).ok).toBe(false);
        expect(validateAddTableDraft(draft({ beforeSql: 'CREATE TABLE parent(id INTEGER PRIMARY KEY);', columns: [col] })).ok).toBe(true);
        expect(validateAddTableDraft(draft({ dialect: DIALECT_BY_ID.postgres, afterSql: 'CREATE TABLE parent(id INTEGER PRIMARY KEY);', columns: [col] })).ok).toBe(false);
    });
    it('rejects native duplicate names, including qualified defaults and migrated names', () => {
        for (const beforeSql of ['CREATE TABLE child(id INTEGER);', 'CREATE TABLE main.child(id INTEGER);', 'CREATE TABLE old_name(id INTEGER); ALTER TABLE old_name RENAME TO child;']) expect(validateAddTableDraft(draft({ beforeSql })).ok).toBe(false);
        const quoted = 'CREATE TABLE "Child" (id INTEGER);';
        expect(validateAddTableDraft(draft({ dialect: DIALECT_BY_ID.postgres, beforeSql: quoted })).ok).toBe(true);
        expect(validateAddTableDraft(draft({ tableName: '"Child"', dialect: DIALECT_BY_ID.postgres, beforeSql: quoted })).ok).toBe(false);
    });
    it('rejects later SQL that removes the newly inserted table', () => {
        expect(validateAddTableDraft(draft({ afterSql: 'DROP TABLE child;' })).ok).toBe(false);
    });
    it('allows self references and detects effective auto-increment storage types', () => {
        const columns = [{ name: 'id', type: '', primaryKey: true, autoIncrement: true }, { name: 'parent_id', type: 'INTEGER', references: { table: 'child', column: 'id' } }];
        expect(validateAddTableDraft(draft({ columns })).ok).toBe(true);
        expect(validateAddTableDraft(draft({ columns: [columns[0]] })).sql).toContain('INTEGER PRIMARY KEY AUTOINCREMENT');
    });
    it('keeps quoted reference-table and column identity intact', () => {
        const result = validateAddTableDraft(draft({ dialect: DIALECT_BY_ID.postgres, beforeSql: 'CREATE TABLE "Parent.Dot"("ID" INTEGER PRIMARY KEY);', columns: [{ name: 'pid', type: 'INTEGER', references: { table: '"Parent.Dot"', column: 'ID', columnQuoted: true } }] }));
        expect(result.ok, result.errors.join(' ')).toBe(true);
        expect(result.sql).toContain('REFERENCES "Parent.Dot"("ID")');
    });
    it('offers only complete matching keys, including an independent unique key on a composite-PK member', () => {
        const schema = sqlToErdSchema('CREATE TABLE p(a INTEGER UNIQUE, b INTEGER, text_id TEXT UNIQUE, PRIMARY KEY(a,b)); CREATE TABLE partial(id INTEGER, active INTEGER); CREATE UNIQUE INDEX partial_key ON partial(id) WHERE active = 1;', { dialect: 'sqlite' });
        expect(schema.tables[0].candidateKeyColumnGroups).toContainEqual(['a']);
        const targets = getAddTableReferenceTargets({ schema, column: { name: 'pid', type: 'INTEGER' }, dialect: DIALECT_BY_ID.sqlite });
        expect(targets.map(t => [t.name, t.columns.map(c => c.name)])).toEqual([['p', ['a']]]);
        expect(Object.keys(schema.tables[0])).not.toContain('candidateKeyColumnGroups');
    });
    it('rejects malformed drafts and SQLite tables containing only generated fields', () => {
        expect(validateAddTableDraft(draft({ columns: [null] })).ok).toBe(false);
        expect(validateAddTableDraft(draft({ columns: [{ name: 'total', type: 'INTEGER', generated: '1 + 2' }] })).errors.join(' ')).toContain('non-generated');
    });
    it('formats native expression defaults and preserves numeric and Unicode literals', () => {
        expect(formatDefault('1e3', DIALECT_BY_ID.postgres)).toBe('1e3');
        expect(formatDefault("N'Unicode'", DIALECT_BY_ID.mssql)).toBe("N'Unicode'");
        expect(formatDefault('FALSE', DIALECT_BY_ID.mssql)).toBe('0');
        expect(formatDefault('UUID()', DIALECT_BY_ID.mysql)).toBe('(UUID())');
        expect(formatDefault('text', DIALECT_BY_ID.mysql, 'TEXT')).toBe("('text')");
        expect(formatDefault("strftime('%Y', 'now')", DIALECT_BY_ID.sqlite)).toBe("(strftime('%Y', 'now'))");
    });
    it.each([
        ['mysql', 'TEXT', true], ['mssql', 'NVARCHAR(MAX)', true], ['postgres', 'JSON', true],
        ['mssql', 'NVARCHAR(4001)', false], ['mysql', 'DECIMAL(66,2)', false], ['mssql', 'DECIMAL(10,11)', false],
        ['postgres', 'VARCHAR(0)', false], ['mssql', 'TIMESTAMP(3)', false],
    ])('rejects non-native key types or invalid parameters for %s %s', (id, type, primaryKey) => {
        expect(validateAddTableDraft(draft({ dialect: DIALECT_BY_ID[id], columns: [{ name: 'id', type, primaryKey }] })).ok).toBe(false);
    });
    it.each([
        ['postgres', 'BIT(8)', true], ['postgres', 'BIT VARYING(8)', true], ['postgres', 'VARBIT(8)', true],
        ['postgres', 'BIT(0)', false], ['postgres', 'BIT VARYING(0)', false], ['postgres', 'VARBIT(-1)', false],
        ['mysql', 'BIT(64)', true], ['mysql', 'BIT(0)', false], ['mysql', 'BIT(65)', false], ['mysql', 'BIT(8,2)', false],
        ['mssql', 'BIT(1)', false],
        ...['postgres', 'mssql'].flatMap(id => [
            [id, 'FLOAT(24)', true], [id, 'FLOAT(53)', true], [id, 'FLOAT(0)', false],
            [id, 'FLOAT(54)', false], [id, 'FLOAT(24,2)', false], [id, 'FLOAT(1.5)', false],
        ]),
    ])('validates native bit length and floating precision: %s %s', (id, type, valid) => {
        const result = validateAddTableDraft(draft({ dialect: DIALECT_BY_ID[id], columns: [{ name: 'value', type }] }));
        expect(result.ok, result.errors.join(' ')).toBe(valid);
    });
    it('validates composite key width and Unicode identifier length without truncation', () => {
        expect(validateAddTableDraft(draft({ dialect: DIALECT_BY_ID.mysql, columns: ['a', 'b', 'c', 'd'].map(name => ({ name, type: 'VARCHAR(255)', primaryKey: true })) })).errors.join(' ')).toContain('3072');
        expect(validateAddTableDraft(draft({ dialect: DIALECT_BY_ID.postgres, tableName: '界'.repeat(22) })).errors.join(' ')).toContain('UTF-8 bytes');
        expect(validateAddTableDraft(draft({ dialect: DIALECT_BY_ID.postgres, tableName: '界'.repeat(21) })).ok).toBe(true);
    });
    it('detects missing fields, incomplete expressions and generated cycles while allowing acyclic SQLite chains', () => {
        for (const generated of ['unknown * 2', 'id >', 'id']) {
            const result = validateAddTableDraft(draft({ columns: [{ name: 'id', type: 'INTEGER', generated }, { name: 'plain', type: 'INTEGER' }] }));
            expect(result.ok).toBe(false);
        }
        const columns = [{ name: 'plain', type: 'INTEGER' }, { name: 'a', type: 'INTEGER', generated: 'plain * 2' }, { name: 'b', type: 'INTEGER', generated: 'a + 1' }];
        expect(validateAddTableDraft(draft({ columns })).ok).toBe(true);
        expect(validateAddTableDraft(draft({ columns, dialect: DIALECT_BY_ID.postgres })).ok).toBe(false);
        columns[1].generated = 'b + 1'; expect(validateAddTableDraft(draft({ columns })).errors.join(' ')).toContain('circular');
    });
    it('preserves independent uniqueness and SQLite composite-PK nullability in ERD relations', () => {
        const sql = 'CREATE TABLE p(a INTEGER UNIQUE,b INTEGER,PRIMARY KEY(a,b)); CREATE TABLE child(pid INTEGER REFERENCES p(a));';
        expect(sqlToErdSchema(sql, { dialect: 'sqlite' }).relations).toHaveLength(1);
        const source = 'CREATE TABLE target(a INTEGER,b INTEGER,PRIMARY KEY(a,b)); CREATE TABLE source(a INTEGER,b INTEGER,PRIMARY KEY(a,b),FOREIGN KEY(a,b) REFERENCES target(a,b));';
        expect(sqlToErdSchema(source, { dialect: 'sqlite' }).relations.every(r => r.toCard === '0..1')).toBe(true);
        expect(sqlToErdSchema(source.replace('source(a INTEGER,b INTEGER', 'source(a INTEGER NOT NULL,b INTEGER NOT NULL'), { dialect: 'sqlite' }).relations.every(r => r.toCard === '1')).toBe(true);
    });
});

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* CI may use a Node release without native SQLite. */ }
describe.skipIf(!DatabaseSync)('Add Table native SQLite execution', () => {
    it('enforces generated SQL, quoted field identity, defaults, checks and foreign-key actions', () => {
        const db = new DatabaseSync(':memory:');
        try {
            db.exec('PRAGMA foreign_keys = ON; CREATE TABLE parent("parent.id" INTEGER PRIMARY KEY); INSERT INTO parent VALUES(7);');
            const result = validateAddTableDraft({ tableName: 'child', dialect: DIALECT_BY_ID.sqlite, beforeSql: 'CREATE TABLE parent("parent.id" INTEGER PRIMARY KEY);', columns: [{ name: 'id', type: '', autoIncrement: true, primaryKey: true }, { name: 'parent.id', type: 'INTEGER', references: { table: 'main.parent', column: 'parent.id', onDelete: 'CASCADE' } }, { name: 'amount', type: 'INTEGER', defaultValue: '2', check: 'amount >= 0' }, { name: 'total', type: 'INTEGER', generated: 'amount * 2' }, { name: 'year', type: 'TEXT', defaultValue: "strftime('%Y', 'now')" }] });
            expect(result.ok, result.errors.join(' ')).toBe(true);
            db.exec(result.sql); db.exec('INSERT INTO child("parent.id") VALUES(7);');
            expect(db.prepare('SELECT amount,total FROM child').get()).toMatchObject({ amount: 2, total: 4 });
            expect(() => db.exec('INSERT INTO child("parent.id") VALUES(999);')).toThrow(/FOREIGN KEY/);
            expect(() => db.exec('INSERT INTO child(amount) VALUES(-1);')).toThrow(/CHECK/);
            db.exec('DELETE FROM parent WHERE "parent.id"=7;'); expect(db.prepare('SELECT count(*) AS n FROM child').get().n).toBe(0);
        } finally { db.close(); }
    });
    it('keeps both columns of a composite primary key required', () => {
        const db = new DatabaseSync(':memory:');
        try {
            db.exec(generateSql({ tableName: 'pair', dialect: DIALECT_BY_ID.sqlite, columns: [{ name: 'a', type: 'INTEGER', primaryKey: true }, { name: 'b', type: 'INTEGER', primaryKey: true }] }));
            expect(() => db.exec('INSERT INTO pair(a,b) VALUES(NULL,1);')).toThrow(/NOT NULL/);
        } finally { db.close(); }
    });
});
