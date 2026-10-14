import { describe, expect, it, vi } from 'vitest';
import { deleteRelationshipInTabs, getRelationshipReconnectTargetsInTabs, reconnectRelationshipInTabs } from '@/features/editor/lib/relationshipReconnect';
import * as schemaModule from '@/lib/erdJsonSchema';
import { buildCombinedSql } from '@/features/editor/lib/sqlTabs';
import { sqlToErdSchema } from '@/lib/erdJsonSchema';
import { sampleSchemaSQL } from '@/features/editor/lib/sampleSQL';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* older Node runtimes */ }

function reconnect(sql, endpoint, target, extraTabs = []) {
    const tabs = [{ id: 'schema', title: 'Schema', sql }, ...extraTabs];
    const schema = sqlToErdSchema(buildCombinedSql(tabs).sql);
    const result = reconnectRelationshipInTabs(tabs, schema.relations[0], endpoint, target);
    return { ...result, sql: result.nextTabs && buildCombinedSql(result.nextTabs).sql };
}

describe('connector SQL deletion', () => {
    function remove(sql, index = 0, extraTabs = []) {
        const tabs = [{ id: 'schema', sql }, ...extraTabs];
        const schema = sqlToErdSchema(buildCombinedSql(tabs).sql);
        const result = deleteRelationshipInTabs(tabs, schema.relations[index]);
        return { ...result, sql: result.nextTabs && buildCombinedSql(result.nextTabs).sql };
    }
    it.each([
        ['sqlite', 'PRAGMA foreign_keys=ON;', 'INTEGER', '"'],
        ['mysql', 'SET NAMES utf8mb4;', 'INT UNSIGNED', '`'],
        ['postgres', 'SET search_path=public;', 'BIGINT', '"'],
        ['mssql', 'SET ANSI_NULLS ON;', 'BIGINT', '['],
    ])('deletes only an inline FK in %s, retaining native types, checks, defaults and comments', (_dialect, prefix, type, left) => {
        const q = (name) => left + name + (left === '[' ? ']' : left);
        const sql = `${prefix} CREATE TABLE p(id ${type} PRIMARY KEY); CREATE TABLE c(pid ${type} CONSTRAINT ${q('fk')} REFERENCES p(id) /* fk note */ ON DELETE CASCADE ON UPDATE NO ACTION NOT DEFERRABLE /* keep */ NOT NULL DEFAULT 1 CHECK(pid>0), note VARCHAR(20) DEFAULT 'REFERENCES p(id)');`;
        const result = remove(sql);
        expect(result.ok, result.message).toBe(true);
        expect(result.sql).toBe(sql.replace(`CONSTRAINT ${q('fk')} REFERENCES p(id) /* fk note */ ON DELETE CASCADE ON UPDATE NO ACTION NOT DEFERRABLE`, ''));
        expect(sqlToErdSchema(result.sql).tables[1].columns).toHaveLength(2);
        expect(sqlToErdSchema(result.sql).relations).toEqual([]);
    });
    it.each(['first', 'middle', 'last'])('removes a %s table constraint without breaking commas or other connections', (placement) => {
        const fk = 'CONSTRAINT fk FOREIGN KEY(pid) REFERENCES p(id) ON DELETE CASCADE';
        const columns = ['pid INTEGER', 'qid INTEGER REFERENCES q(id)', 'note TEXT'];
        columns.splice(placement === 'first' ? 0 : placement === 'middle' ? 1 : 3, 0, fk);
        const sql = `PRAGMA foreign_keys=ON; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE q(id INTEGER PRIMARY KEY); CREATE TABLE c(${columns.join(',\n')});`;
        const index = sqlToErdSchema(sql).relations.findIndex((r) => r.fkName === 'fk');
        const result = remove(sql, index);
        expect(result.ok, result.message).toBe(true);
        expect(sqlToErdSchema(result.sql).relations).toMatchObject([{ to: { table: 'q' } }]);
        if (DatabaseSync) { const db = new DatabaseSync(':memory:'); try { db.exec(result.sql); expect(db.prepare('PRAGMA foreign_key_list(c)').all()).toHaveLength(1); } finally { db.close(); } }
    });
    it.each(['create', 'alter'])('deletes a complete composite %s constraint from either connector leg', (shape) => {
        const fk = 'CONSTRAINT fk FOREIGN KEY(a,b) REFERENCES p(a,b) ON DELETE CASCADE';
        const sql = `SET search_path=public; CREATE TABLE p(a INT,b INT,PRIMARY KEY(a,b)); CREATE TABLE c(a INT,b INT${shape === 'create' ? ', ' + fk : ''}); ${shape === 'alter' ? `ALTER TABLE c ADD ${fk};` : ''}`;
        for (const index of [0, 1]) {
            const result = remove(sql, index);
            expect(result.ok, result.message).toBe(true);
            expect(result.impacts).toEqual([{ kind: 'remove-relationship', label: 'c(a, b) → p(a, b)' }]);
            expect(sqlToErdSchema(result.sql).relations).toHaveLength(0);
            expect(sqlToErdSchema(result.sql).tables[1].columns.map((c) => c.name)).toEqual(['a', 'b']);
        }
    });
    it.each(['SET search_path=public;', 'SET NAMES utf8mb4;', 'SET ANSI_NULLS ON;'])('deletes a standalone ALTER FK with native directive %s', (prefix) => {
        const sql = `${prefix} CREATE TABLE p(id BIGINT PRIMARY KEY); CREATE TABLE c(pid BIGINT); ALTER TABLE c ADD CONSTRAINT fk FOREIGN KEY(pid) REFERENCES p(id); -- keep\nINSERT INTO c VALUES(9);`;
        const result = remove(sql);
        expect(result.ok, result.message).toBe(true);
        expect(result.sql).toBe(sql.replace('ALTER TABLE c ADD CONSTRAINT fk FOREIGN KEY(pid) REFERENCES p(id);', ''));
    });
    it('keeps column/table rename migrations and data after removing the original FK', () => {
        const sql = 'PRAGMA foreign_keys=ON; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(pid INTEGER REFERENCES p(id), note TEXT); ALTER TABLE c RENAME COLUMN pid TO parent_id; ALTER TABLE c RENAME TO renamed; INSERT INTO renamed VALUES(99,\'keep\');';
        const result = remove(sql);
        expect(result.ok, result.message).toBe(true);
        expect(result.sql).toBe(sql.replace('REFERENCES p(id)', ''));
        if (DatabaseSync) { const db = new DatabaseSync(':memory:'); try { db.exec(result.sql); expect(db.prepare('SELECT * FROM renamed').all()).toMatchObject([{ parent_id: 99, note: 'keep' }]); } finally { db.close(); } }
    });
    it('edits only the owning active tab and preserves inactive SQL byte for byte', () => {
        const tabs = [{ id: 'p', sql: 'CREATE TABLE p(id INT PRIMARY KEY);' }, { id: 'off', sql: 'private REFERENCES p(id) bytes', isInactive: true }, { id: 'c', sql: 'CREATE TABLE c(pid INT REFERENCES p(id), note TEXT);' }];
        const relation = sqlToErdSchema(buildCombinedSql(tabs).sql).relations[0];
        const result = deleteRelationshipInTabs(tabs, relation);
        expect(result.ok, result.message).toBe(true);
        expect(result.nextTabs[0]).toBe(tabs[0]); expect(result.nextTabs[1]).toBe(tabs[1]);
        expect(result.nextTabs[2].sql).toBe(tabs[2].sql.replace('REFERENCES p(id)', ''));
        expect(tabs[2].sql).toContain('REFERENCES');
    });
    it('rejects stale/inferred selection without writing SQL', () => {
        const sql = 'CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE c(pid INT REFERENCES p(id));';
        const relation = sqlToErdSchema(sql).relations[0];
        for (const requested of [{ ...relation, inferred: true }, { ...relation, fkName: 'wrong' }, { ...relation, position: { index: 0 } }]) expect(deleteRelationshipInTabs([{ id: 'x', sql }], requested)).toMatchObject({ ok: false });
        expect(deleteRelationshipInTabs([{ id: 'x', sql: '\n' + sql }], relation).ok).toBe(false);
    });
    it.each([
        'ALTER TABLE c RENAME CONSTRAINT fk TO renamed;',
        'ALTER TABLE c RENAME TO moved; ALTER TABLE moved RENAME CONSTRAINT fk TO renamed;',
        'ALTER TABLE c RENAME TO first_move; ALTER TABLE first_move RENAME TO second_move; ALTER TABLE second_move RENAME CONSTRAINT fk TO renamed;',
    ])('rejects dangling named constraint history: %s', (migration) => {
        const sql = `SET search_path=public; CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE c(pid INT, CONSTRAINT fk FOREIGN KEY(pid) REFERENCES p(id)); ${migration}`;
        const result = remove(sql);
        expect(result.ok).toBe(false); expect(result.message).toContain('history');
    });
    it('retains an explicit namespace while tracking renamed constraint owners', () => {
        const sql = 'SET search_path=public; CREATE TABLE custom.p(id INT PRIMARY KEY); CREATE TABLE custom.c(pid INT, CONSTRAINT fk FOREIGN KEY(pid) REFERENCES custom.p(id)); ALTER TABLE custom.c RENAME TO moved; ALTER TABLE custom.moved RENAME CONSTRAINT fk TO renamed;';
        const result = remove(sql); expect(result.ok).toBe(false); expect(result.message).toContain('history');
    });
    it('keeps unrelated named constraint history', () => {
        const sql = 'SET search_path=public; CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE c(pid INT, CONSTRAINT fk FOREIGN KEY(pid) REFERENCES p(id), CONSTRAINT uq UNIQUE(pid)); ALTER TABLE c RENAME CONSTRAINT uq TO renamed;';
        expect(remove(sql).ok).toBe(true);
    });
    it.each(['COMMENT ON CONSTRAINT fk ON c IS \'keep\';', 'ALTER TABLE c VALIDATE CONSTRAINT fk;'])('rejects a dependent native constraint command: %s', (statement) => {
        const sql = `SET search_path=public; CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE c(pid INT, CONSTRAINT fk FOREIGN KEY(pid) REFERENCES p(id)); ${statement}`;
        const result = remove(sql); expect(result.ok).toBe(false); expect(result.message).toContain('statement');
    });
    it('rejects a shared ALTER instead of losing its other operation', () => {
        const sql = 'SET search_path=public; CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE c(pid INT); ALTER TABLE c ADD CONSTRAINT fk FOREIGN KEY(pid) REFERENCES p(id), ADD COLUMN note TEXT;';
        const result = remove(sql); expect(result.ok).toBe(false); expect(result.message).toContain('shares an ALTER');
    });
});

describe('relationship SQL reconnection', () => {
    it.each(['PRAGMA foreign_keys=ON;', 'SET search_path=public;', 'SET NAMES utf8mb4;', 'SET ANSI_NULLS ON;'])('moves a named FK into the surviving table definition after recreation: %s', prefix => {
        const sql = prefix + ' CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE d(x INTEGER, CONSTRAINT fk UNIQUE(x)); DROP TABLE d; CREATE TABLE c(pid INTEGER, CONSTRAINT fk FOREIGN KEY(pid) REFERENCES p(id) ON DELETE CASCADE); CREATE TABLE d(x INTEGER);';
        const result = reconnect(sql, 'from', { table: 'd', column: 'x' });
        expect(result.ok, result.message).toBe(true);
        expect(result.sql.slice(0, result.sql.indexOf('DROP TABLE d'))).toBe(sql.slice(0, sql.indexOf('DROP TABLE d')));
        expect(result.sql.lastIndexOf('FOREIGN KEY')).toBeGreaterThan(result.sql.indexOf('DROP TABLE d'));
        expect(sqlToErdSchema(result.sql).relations[0]).toMatchObject({ from: { table: 'd', column: 'x' }, to: { table: 'p', column: 'id' }, fkName: 'fk', actions: { onDelete: 'CASCADE' } });
        if (DatabaseSync && prefix.startsWith('PRAGMA')) {
            const database = new DatabaseSync(':memory:');
            try { database.exec(result.sql); database.exec('INSERT INTO p VALUES(1); INSERT INTO d VALUES(1); DELETE FROM p WHERE id=1;'); expect(database.prepare('SELECT count(*) AS n FROM d').get().n).toBe(0); }
            finally { database.close(); }
        }
    });
    it.each([
        ['postgres', 'SET search_path=public;', 'ADD COLUMN note TEXT'],
        ['postgres', 'SET search_path=public;', 'ADD UNIQUE(keep)'],
        ['postgres', 'SET search_path=public;', 'ALTER COLUMN keep SET DEFAULT 7'],
        ['postgres', 'SET search_path=public;', 'ADD CHECK(keep > 0)'],
        ['mysql', 'SET NAMES utf8mb4;', 'ADD COLUMN note TEXT'],
        ['mysql', 'SET NAMES utf8mb4;', 'ADD UNIQUE(keep)'],
    ])('does not move unrelated %s shared ALTER operations with a connector: %s', async (_dialect, prefix, operation) => {
        const sql = `${prefix} CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE q(id INTEGER PRIMARY KEY); CREATE TABLE c(pid INTEGER, next_id INTEGER, keep INTEGER); CREATE TABLE d(pid INTEGER, keep INTEGER); ALTER TABLE c ADD CONSTRAINT fk FOREIGN KEY(pid) REFERENCES p(id), ${operation};`;
        const tabs = [{ id: 'x', sql }]; const relation = sqlToErdSchema(sql).relations[0];
        const result = reconnectRelationshipInTabs(tabs, relation, 'from', { table: 'd', column: 'pid' });
        expect(result.ok).toBe(false); expect(result.nextTabs).toBeUndefined(); expect(tabs[0].sql).toBe(sql);
        const choices = await getRelationshipReconnectTargetsInTabs(tabs, relation, 'from');
        expect(choices.targets.some(field => field.table === 'd')).toBe(false);
        const local = reconnectRelationshipInTabs(tabs, relation, 'from', { table: 'c', column: 'next_id' });
        expect(local.ok, local.message).toBe(true); expect(local.nextTabs[0].sql).toContain(operation);
        const target = reconnectRelationshipInTabs(tabs, relation, 'to', { table: 'q', column: 'id' });
        expect(target.ok, target.message).toBe(true); expect(target.nextTabs[0].sql).toContain(operation);
    });
    it.each(['SET search_path=public;', 'SET NAMES utf8mb4;', 'SET ANSI_NULLS ON;'])('requires the new source table to exist when an ALTER FK executes: %s', prefix => {
        const sql = `${prefix} CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(pid INTEGER); ALTER TABLE c ADD CONSTRAINT fk FOREIGN KEY(pid) REFERENCES p(id); CREATE TABLE d(pid INTEGER);`;
        const result = reconnect(sql, 'from', { table: 'd', column: 'pid' });
        expect(result.ok).toBe(false); expect(result.message).toContain('when the constraint runs');
    });
    it.each([
        ['sqlite', 'PRAGMA foreign_keys=ON;', 'INTEGER', '"', '"'],
        ['mysql', '', 'INT UNSIGNED', '`', '`'],
        ['mssql', '', 'INT', '[', ']'],
        ['postgres', '', 'SERIAL', '"', '"'],
    ])('changes an inline referenced key in %s without losing comments or actions', (_dialect, prefix, type, left, right) => {
        const q = (name) => left + name + right;
        const sql = `${prefix} CREATE TABLE ${q('old parent')}(id ${type} PRIMARY KEY); CREATE TABLE ${q('new parent')}(id ${type} PRIMARY KEY); CREATE TABLE child(id ${type} REFERENCES ${q('old parent')}(id) /* keep */ ON DELETE CASCADE ON UPDATE RESTRICT);`;
        const schema = sqlToErdSchema(sql);
        const target = { table: schema.tables[1].name, column: 'id' };
        const result = reconnect(sql, 'to', target);
        expect(result.ok, result.message).toBe(true);
        expect(result.sql).toContain('/* keep */ ON DELETE CASCADE ON UPDATE RESTRICT');
        const next = sqlToErdSchema(result.sql);
        expect(next.relations[0].to).toEqual(target);
        expect(next.relations[0].actions).toEqual(schema.relations[0].actions);
        expect(result.sql).toContain(`REFERENCES ${q('new parent')}`);
    });

    it('preserves named table constraints and changes only the reference clause', () => {
        const sql = 'CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE q(id INTEGER UNIQUE); CREATE TABLE c(id INT, CONSTRAINT fk FOREIGN KEY(id) REFERENCES p(id) ON DELETE CASCADE);';
        const result = reconnect(sql, 'to', { table: 'q', column: 'id' });
        expect(result.sql).toBe(sql.replace('REFERENCES p(id)', 'REFERENCES "q"("id")'));
        expect(sqlToErdSchema(result.sql).relations[0].fkName).toBe('fk');
    });

    it('changes implicit primary-key references to an explicit field', () => {
        const sql = 'CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE q(id INT UNIQUE); CREATE TABLE c(id INT REFERENCES p);';
        const result = reconnect(sql, 'to', { table: 'q', column: 'id' });
        expect(result.ok, result.message).toBe(true);
        expect(result.sql).toContain('REFERENCES "q"("id")');
    });

    it('moves an inline foreign key to another field while retaining column constraints', () => {
        const sql = 'CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE c(a INT REFERENCES p(id) ON DELETE CASCADE NOT NULL DEFAULT 1 CHECK(a>0), b INTEGER);';
        const result = reconnect(sql, 'from', { table: 'c', column: 'b' });
        expect(result.ok, result.message).toBe(true);
        expect(result.sql).toContain('NOT NULL DEFAULT 1 CHECK(a>0)');
        expect(result.sql).toContain('FOREIGN KEY ("b") REFERENCES p(id) ON DELETE CASCADE');
        expect(sqlToErdSchema(result.sql).relations[0].from.column).toBe('b');
    });

    it('moves the complete NO ACTION clause without leaving ACTION behind on the old field', () => {
        const sql = 'CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE c(a INT REFERENCES p(id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT DEFERRABLE NOT NULL DEFAULT 1, b INT);';
        const result = reconnect(sql, 'from', { table: 'c', column: 'b' });
        expect(result.ok, result.message).toBe(true);
        expect(result.sql).toContain('a INT  NOT NULL DEFAULT 1');
        expect(result.sql).toContain('FOREIGN KEY ("b") REFERENCES p(id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT DEFERRABLE');
    });

    it('preserves an inline constraint name when moving the foreign-key field', () => {
        const sql = 'CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE c(a INT CONSTRAINT fk REFERENCES p(id) ON DELETE CASCADE NOT NULL, b INT);';
        const result = reconnect(sql, 'from', { table: 'c', column: 'b' });
        expect(result.ok, result.message).toBe(true);
        expect(result.sql).toContain('CONSTRAINT fk FOREIGN KEY ("b") REFERENCES p(id) ON DELETE CASCADE');
        expect(sqlToErdSchema(result.sql).relations[0].fkName).toBe('fk');
    });

    it('rejects moving a named FK into a table that already uses its constraint name', () => {
        const sql = 'CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE c(a INT, CONSTRAINT fk FOREIGN KEY(a) REFERENCES p(id)); CREATE TABLE d(id INT, CONSTRAINT fk UNIQUE(id));';
        const result = reconnect(sql, 'from', { table: 'd', column: 'id' });
        expect(result.ok).toBe(false);
        expect(result.message).toContain('constraint with this name');
    });

    it.each([
        ['FK', 'fk', false], ['"FK"', 'FK', true], ['"fk"', 'FK', false],
    ])('uses PostgreSQL quote-aware constraint identity for %s and %s', (sourceName, destinationName, accepted) => {
        const sql = `SET search_path=public; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(a INTEGER, CONSTRAINT ${sourceName} FOREIGN KEY(a) REFERENCES p(id)); CREATE TABLE d(id INTEGER, CONSTRAINT ${destinationName} UNIQUE(id));`;
        const result = reconnect(sql, 'from', { table: 'd', column: 'id' });
        expect(result.ok, result.message).toBe(accepted);
        if (!accepted) expect(result.message).toContain('constraint with this name');
    });

    it.each([
        ['CREATE TABLE q(id INT PRIMARY KEY); ALTER TABLE q RENAME TO renamed;', 'renamed', 'id'],
        ['CREATE TABLE q(old_id INT PRIMARY KEY); ALTER TABLE q RENAME COLUMN old_id TO id;', 'q', 'id'],
    ])('rejects migration-dependent targets instead of emitting a forward-invalid reference', (declaration, table, column) => {
        const sql = `CREATE TABLE p(id INT PRIMARY KEY); ${declaration} CREATE TABLE c(id INT REFERENCES p(id));`;
        const result = reconnect(sql, 'to', { table, column });
        expect(result.ok).toBe(false);
        expect(result.message).toContain('migrations');
    });
    it.each([
        ['PRAGMA foreign_keys=ON;', 'ALTER TABLE q RENAME COLUMN note TO label;'],
        ['SET search_path=public;', 'ALTER TABLE q RENAME COLUMN note TO label;'],
        ['SET NAMES utf8mb4;', 'ALTER TABLE q CHANGE COLUMN note label TEXT;'],
        ['SET ANSI_NULLS ON;', "EXEC sp_rename 'q.note', 'label', 'COLUMN';"],
        ['', 'ALTER TABLE q RENAME COLUMN note TO label;'],
    ])('reconnects unchanged endpoints through unrelated native table migrations: %s', (prefix, rename) => {
        const sql = prefix + ' CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE q(id INTEGER PRIMARY KEY); CREATE TABLE c(pid INTEGER REFERENCES p(id) ON DELETE CASCADE, other INTEGER); ALTER TABLE c ADD retired TEXT; ALTER TABLE c DROP COLUMN retired; ALTER TABLE q ADD note TEXT; ' + rename;
        const result = reconnect(sql, 'to', { table: 'q', column: 'id' });
        expect(result.ok, result.message).toBe(true);
        expect(result.sql).toContain('DROP COLUMN retired'); expect(result.sql).toContain(rename);
        expect(sqlToErdSchema(result.sql).relations[0].actions).toEqual({ onDelete: 'CASCADE' });
        if (DatabaseSync && prefix.startsWith('PRAGMA')) {
            const database = new DatabaseSync(':memory:');
            try { database.exec(result.sql); database.exec('INSERT INTO q VALUES(1,\'keep\'); INSERT INTO c VALUES(1,0); DELETE FROM q WHERE id=1;'); expect(database.prepare('SELECT count(*) AS n FROM c').get().n).toBe(0); }
            finally { database.close(); }
        }
    });
    it('updates a commerce sample category connector while keeping unrelated migrations and SET NULL intact', () => {
        const relation = sqlToErdSchema(sampleSchemaSQL).relations.find(r => r.from.table === 'products' && r.from.column === 'category_id');
        const result = reconnectRelationshipInTabs([{ id: 'schema', sql: sampleSchemaSQL }], relation, 'to', { table: 'users', column: 'id' });
        expect(result.ok, result.message).toBe(true);
        const sql = buildCombinedSql(result.nextTabs).sql;
        expect(sql).toContain('REFERENCES "users"("id") ON DELETE SET NULL');
        expect(sql).toContain('ALTER TABLE products DROP COLUMN retired_at');
    });
    it('does not confuse a field migration in a different namespace with the selected endpoint', () => {
        const sql = 'SET search_path=public; CREATE TABLE a.p(id INTEGER PRIMARY KEY); CREATE TABLE a.q(id INTEGER PRIMARY KEY); CREATE TABLE a.c(pid INTEGER REFERENCES a.p(id)); CREATE TABLE b.c(pid INTEGER); ALTER TABLE b.c RENAME COLUMN pid TO other;';
        const result = reconnect(sql, 'to', { table: 'a.q', column: 'id' });
        expect(result.ok, result.message).toBe(true);
        expect(result.sql).toContain('REFERENCES "a"."q"("id")');
        expect(result.sql).toContain('ALTER TABLE b.c RENAME COLUMN pid TO other;');
    });
    it('keeps PostgreSQL quoted case identities distinct when inspecting endpoint history', () => {
        const sql = 'SET search_path=public; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE q(id INTEGER PRIMARY KEY); CREATE TABLE c(pid INTEGER REFERENCES p(id)); CREATE TABLE "C"(pid INTEGER); ALTER TABLE "C" RENAME COLUMN pid TO other;';
        const result = reconnect(sql, 'to', { table: 'q', column: 'id' });
        expect(result.ok, result.message).toBe(true);
        expect(result.sql).toContain('REFERENCES "q"("id")');
        expect(result.sql).toContain('ALTER TABLE "C" RENAME COLUMN pid TO other;');
    });

    it.each(['SET search_path=public;', 'SET NAMES utf8mb4;', 'SET ANSI_NULLS ON;', ''])(
        'rejects new forward table/key dependencies with directive %s', (prefix) => {
            const sql = `${prefix} CREATE TABLE d(id INTEGER); CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(id INTEGER REFERENCES p(id)); CREATE TABLE q(id INTEGER PRIMARY KEY);`;
            for (const [endpoint, target] of [['to', { table: 'q', column: 'id' }], ['from', { table: 'd', column: 'id' }]]) {
                const result = reconnect(sql, endpoint, target);
                expect(result.ok).toBe(false);
                expect(result.message).toContain('when the constraint runs');
            }
            const keyAfter = sql.replace('CREATE TABLE q(id INTEGER PRIMARY KEY);', '').replace('CREATE TABLE c', 'CREATE TABLE q(id INTEGER); CREATE TABLE c') + ' CREATE UNIQUE INDEX uq ON q(id);';
            expect(reconnect(keyAfter, 'to', { table: 'q', column: 'id' }).ok).toBe(false);
            // An earlier complete key still qualifies despite unrelated or
            // redundant key operations later in the script.
            const keyBefore = keyAfter.replace('q(id INTEGER)', 'q(id INTEGER UNIQUE)');
            expect(reconnect(keyBefore, 'to', { table: 'q', column: 'id' }).ok).toBe(true);
        },
    );

    it('permits SQLite forward target creation and an ALTER FK that runs after its target exists', () => {
        const sql = 'PRAGMA foreign_keys=ON; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(id INTEGER REFERENCES p(id)); CREATE TABLE q(id INTEGER PRIMARY KEY);';
        expect(reconnect(sql, 'to', { table: 'q', column: 'id' }).ok).toBe(true);
        const alter = 'SET search_path=public; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(id INTEGER); CREATE TABLE q(id INTEGER PRIMARY KEY); ALTER TABLE c ADD CONSTRAINT fk FOREIGN KEY(id) REFERENCES p(id);';
        expect(reconnect(alter, 'to', { table: 'q', column: 'id' }).ok).toBe(true);
    });

    it.each(['inline', 'table', 'first', 'alter'])('moves a %s foreign key to a different table', (shape) => {
        const key = 'CONSTRAINT fk FOREIGN KEY(a) REFERENCES p(id) ON DELETE CASCADE';
        const source = shape === 'inline' ? 'a INT REFERENCES p(id) ON DELETE CASCADE, b INT'
            : shape === 'table' ? `a INT, b INT, ${key}` : shape === 'first' ? `${key}, a INT, b INT` : 'a INT, b INT';
        const sql = `CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE c(${source}); CREATE TABLE d(x INT); ${shape === 'alter' ? `ALTER TABLE c ADD ${key};` : ''}`;
        const result = reconnect(sql, 'from', { table: 'd', column: 'x' });
        expect(result.ok, result.message).toBe(true);
        const schema = sqlToErdSchema(result.sql);
        expect(schema.relations).toHaveLength(1);
        expect(schema.relations[0].from).toEqual({ table: 'd', column: 'x' });
        expect(schema.tables.find((t) => t.name === 'c').columns).toHaveLength(2);
        expect(schema.relations[0].actions).toEqual({ onDelete: 'CASCADE' });
        if (shape !== 'inline') expect(schema.relations[0].fkName).toBe('fk');
    });

    it('edits the FK tab, protecting unrelated and inactive tabs', () => {
        const tabs = [
            { id: 'tables', title: 'Tables', sql: 'CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE q(id INT PRIMARY KEY); CREATE TABLE c(id INT);' },
            { id: 'constraints', title: 'Keys', sql: '/* owner */ ALTER TABLE c ADD CONSTRAINT fk FOREIGN KEY(id) REFERENCES p(id);' },
            { id: 'inactive', title: 'Archive', sql: 'CREATE TABLE stale(id INT REFERENCES p(id));', isInactive: true },
        ];
        const relation = sqlToErdSchema(buildCombinedSql(tabs).sql).relations[0];
        const result = reconnectRelationshipInTabs(tabs, relation, 'to', { table: 'q', column: 'id' });
        expect(result.ok, result.message).toBe(true);
        expect(result.nextTabs[0]).toBe(tabs[0]);
        expect(result.nextTabs[2]).toBe(tabs[2]);
        expect(result.nextTabs[1].sql).toContain('/* owner */ ALTER TABLE c ADD CONSTRAINT fk FOREIGN KEY(id) REFERENCES "q"("id");');
    });

    it('atomically moves a CREATE constraint between two owning tabs', () => {
        const sql = 'CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE c(id INT REFERENCES p(id));';
        const extra = { id: 'dest', title: 'Destination', sql: 'CREATE TABLE d(id INT);' };
        const result = reconnect(sql, 'from', { table: 'd', column: 'id' }, [extra]);
        expect(result.ok, result.message).toBe(true);
        expect(result.nextTabs[0].sql).not.toContain('REFERENCES');
        expect(result.nextTabs[1].sql).toContain('REFERENCES p(id)');
    });

    it.each([
        ['INT', 'BIGINT'], ['INT UNSIGNED', 'INT'], ['VARCHAR(20)', 'VARCHAR(30)'],
        ['DECIMAL(10,2)', 'NUMERIC(10,3)'], ['UUID', 'TEXT'], ['TEXT', 'INTEGER'],
    ])('rejects mismatched %s and %s without changing SQL', (sourceType, targetType) => {
        const sql = `CREATE TABLE p(id ${sourceType} PRIMARY KEY); CREATE TABLE q(id ${targetType} PRIMARY KEY); CREATE TABLE c(id ${sourceType} REFERENCES p(id));`;
        const result = reconnect(sql, 'to', { table: 'q', column: 'id' });
        expect(result.ok).toBe(false);
        expect(result.message).toContain('Types must match');
        expect(result.nextTabs).toBeUndefined();
    });

    it.each([
        'CREATE TABLE q(id INT);',
        'CREATE TABLE q(id INT, other INT, PRIMARY KEY(id,other));',
        'CREATE TABLE q(id INT); CREATE UNIQUE INDEX uq ON q(id) WHERE id>0;',
        'CREATE TABLE q(id INT,note TEXT); CREATE UNIQUE INDEX uq ON q(id,lower(note));',
    ])('rejects a field without a complete unique key: %s', (targetSql) => {
        const sql = `CREATE TABLE p(id INT PRIMARY KEY); ${targetSql} CREATE TABLE c(id INT REFERENCES p(id));`;
        const result = reconnect(sql, 'to', { table: 'q', column: 'id' });
        expect(result.ok).toBe(false);
        expect(result.message).toContain('primary key');
    });

    it('accepts an unfiltered single-column unique index', () => {
        const result = reconnect('CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE q(id INT); CREATE UNIQUE INDEX uq ON q(id); CREATE TABLE c(id INT REFERENCES p(id));', 'to', { table: 'q', column: 'id' });
        expect(result.ok, result.message).toBe(true);
    });

    it('rejects one-column edits of a composite FK', () => {
        const sql = 'CREATE TABLE p(a INT, b INT, PRIMARY KEY(a,b)); CREATE TABLE c(a INT,b INT, FOREIGN KEY(a,b) REFERENCES p(a,b));';
        const result = reconnect(sql, 'to', { table: 'p', column: 'b' });
        expect(result.ok).toBe(false);
        expect(result.message).toContain('multiple columns');
    });

    it('rejects a duplicate relationship and an incompatible SET NULL source', () => {
        const sql = 'CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE q(id INT PRIMARY KEY); CREATE TABLE c(a INT REFERENCES p(id) ON DELETE SET NULL, b INT NOT NULL REFERENCES q(id));';
        expect(reconnect(sql, 'from', { table: 'c', column: 'b' }).message).toContain('nullable');
        const duplicates = 'CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE q(id INT PRIMARY KEY); CREATE TABLE c(a INT REFERENCES p(id), FOREIGN KEY(a) REFERENCES q(id));';
        expect(reconnect(duplicates, 'to', { table: 'q', column: 'id' }).message).toContain('already');
    });

    it('treats the current field as a no-op', () => {
        expect(reconnect('CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE c(id INT REFERENCES p(id));', 'to', { table: 'p', column: 'id' })).toMatchObject({ ok: true, unchanged: true });
    });

    it('ignores canvas-only row metadata on drop targets', () => {
        const sql = 'CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE q(id INT PRIMARY KEY); CREATE TABLE c(id INT REFERENCES p(id));';
        expect(reconnect(sql, 'to', { table: 'q', column: 'id', rowIndex: 0 }).ok).toBe(true);
    });

    it('preserves quoted periods and escaped names', () => {
        const sql = 'CREATE TABLE "app"."old"(id SERIAL PRIMARY KEY); CREATE TABLE "app"."a.b"("i.d" INTEGER PRIMARY KEY); CREATE TABLE c(id INT REFERENCES "app"."old"(id));';
        const result = reconnect(sql, 'to', { table: 'app.a.b', column: 'i.d' });
        expect(result.ok, result.message).toBe(true);
        expect(result.sql).toContain('REFERENCES "app"."a.b"("i.d")');
    });

    it.each(['(', ')', ',', '.'])('keeps quoted punctuation %s separate from SQL syntax on both endpoint edits', (name) => {
        const sql = `PRAGMA foreign_keys=ON; CREATE TABLE p("${name}" INTEGER PRIMARY KEY); CREATE TABLE q("${name}" INTEGER PRIMARY KEY); CREATE TABLE c("${name}" INTEGER REFERENCES p("${name}"), next_id INTEGER); CREATE TABLE d("${name}" INTEGER);`;
        const original = sqlToErdSchema(sql);
        expect(original.relations).toHaveLength(1);
        for (const [endpoint, target] of [['to', { table: 'q', column: name }], ['from', { table: 'd', column: name }]]) {
            const result = reconnect(sql, endpoint, target);
            expect(result.ok, result.message).toBe(true);
            expect(sqlToErdSchema(result.sql).relations[0][endpoint]).toEqual(target);
            if (DatabaseSync) {
                const database = new DatabaseSync(':memory:');
                try { database.exec(result.sql); } finally { database.close(); }
            }
        }
    });

    it.each(['(', ')', ',', '.'])('ignores punctuation literal %s before a table-level FK', (literal) => {
        const sql = `PRAGMA foreign_keys=ON; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE q(id INTEGER PRIMARY KEY); CREATE TABLE c(note TEXT DEFAULT '${literal}', id INTEGER, CONSTRAINT fk FOREIGN KEY(id) REFERENCES p(id)); CREATE TABLE d(note TEXT DEFAULT '${literal}', id INTEGER);`;
        expect(sqlToErdSchema(sql).relations).toHaveLength(1);
        for (const [endpoint, target] of [['to', { table: 'q', column: 'id' }], ['from', { table: 'd', column: 'id' }]]) {
            const result = reconnect(sql, endpoint, target);
            expect(result.ok, result.message).toBe(true);
            expect(result.sql.match(/DEFAULT '[(),.]'/g)).toHaveLength(2);
            if (DatabaseSync) {
                const database = new DatabaseSync(':memory:');
                try { database.exec(result.sql); } finally { database.close(); }
            }
        }
    });

    it.each(['', '[]', '[][]'])('rejects ambiguous case-distinct user-defined types with %s dimensions', (dimensions) => {
        const sql = `CREATE TYPE "Foo" AS ENUM ('a'); CREATE TYPE "foo" AS ENUM ('a'); CREATE TABLE p(id "Foo"${dimensions} PRIMARY KEY); CREATE TABLE q(id "foo"${dimensions} PRIMARY KEY); CREATE TABLE c(id "Foo"${dimensions} REFERENCES p(id));`;
        const schema = sqlToErdSchema(sql);
        const result = reconnect(sql, 'to', { table: schema.tables[1].name, column: 'id' });
        expect(result.ok).toBe(false);
        expect(result.message).toContain('ambiguous');
    });

    it('rejects moving SET DEFAULT onto a required field without a default', () => {
        const sql = 'CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE c(a INT DEFAULT 1 REFERENCES p(id) ON DELETE SET DEFAULT, b INT NOT NULL);';
        expect(reconnect(sql, 'from', { table: 'c', column: 'b' }).message).toContain('default value');
    });
    it.each(['NULL', '(NULL)', '((NULL))', '(/* empty default */ NULL)'])('filters required fields with a null default from SET DEFAULT reconnection: %s', async defaultSql => {
        const sql = `PRAGMA foreign_keys=ON; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(a INTEGER DEFAULT 1 REFERENCES p(id) ON DELETE SET DEFAULT, b INTEGER NOT NULL DEFAULT ${defaultSql}, nullable INTEGER DEFAULT ${defaultSql});`;
        const invalid = reconnect(sql, 'from', { table: 'c', column: 'b' });
        expect(invalid.ok).toBe(false); expect(invalid.message).toContain('default value');
        expect(reconnect(sql, 'from', { table: 'c', column: 'nullable' }).ok).toBe(true);
        const choices = await getRelationshipReconnectTargetsInTabs([{ id: 'schema', sql }], sqlToErdSchema(sql).relations[0], 'from');
        expect(choices.targets.map(target => target.column)).not.toContain('b');
        expect(choices.targets.map(target => target.column)).toContain('nullable');
        if (DatabaseSync) {
            const database = new DatabaseSync(':memory:');
            try {
                database.exec(`PRAGMA foreign_keys=ON; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(id INTEGER NOT NULL DEFAULT ${defaultSql} REFERENCES p(id) ON DELETE SET DEFAULT); INSERT INTO p VALUES(1); INSERT INTO c VALUES(1);`);
                expect(() => database.exec('DELETE FROM p WHERE id=1;')).toThrow(/NOT NULL/i);
            } finally { database.close(); }
        }
    });
    it('preserves a quoted NULL string as a non-null SET DEFAULT value', () => {
        const sql = "CREATE TABLE p(id TEXT PRIMARY KEY); CREATE TABLE c(a TEXT REFERENCES p(id) ON DELETE SET DEFAULT, b TEXT NOT NULL DEFAULT 'NULL');";
        expect(reconnect(sql, 'from', { table: 'c', column: 'b' }).ok).toBe(true);
    });

    it('does not guess after the original relationship has changed', () => {
        const sql = 'CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE q(id INT PRIMARY KEY); CREATE TABLE c(id INT REFERENCES p(id));';
        const relation = sqlToErdSchema(sql).relations[0];
        const result = reconnectRelationshipInTabs([{ id: 'one', sql: sql.replace('REFERENCES p', 'REFERENCES q') }], relation, 'to', { table: 'q', column: 'id' });
        expect(result.ok).toBe(false);
        expect(result.message).toContain('changed');
    });

    it.skipIf(!DatabaseSync)('executes both endpoint edits in native SQLite and enforces the new key', () => {
        const sql = 'PRAGMA foreign_keys=ON; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE q(id INTEGER PRIMARY KEY); CREATE TABLE c(id INTEGER REFERENCES p(id) ON DELETE CASCADE); CREATE TABLE d(id INTEGER);';
        const target = reconnect(sql, 'to', { table: 'q', column: 'id' });
        const source = reconnect(sql, 'from', { table: 'd', column: 'id' });
        for (const [result, owner, parent] of [[target, 'c', 'q'], [source, 'd', 'p']]) {
            expect(result.ok, result.message).toBe(true);
            const database = new DatabaseSync(':memory:');
            try {
                database.exec(result.sql);
                expect(database.prepare(`PRAGMA foreign_key_list(${owner})`).get().table).toBe(parent);
                database.exec(`INSERT INTO ${parent} VALUES(2); INSERT INTO ${owner} VALUES(2);`);
                expect(() => database.exec(`INSERT INTO ${owner} VALUES(3);`)).toThrow(/FOREIGN KEY/);
                database.exec(`DELETE FROM ${parent} WHERE id=2;`);
                expect(database.prepare(`SELECT COUNT(*) AS n FROM ${owner}`).get().n).toBe(0);
            } finally { database.close(); }
        }
    });
});

describe('eligible connector popup fields', () => {
    async function choices(sql, endpoint) {
        const tabs = [{ id: 'schema', sql }];
        const relation = sqlToErdSchema(sql).relations[0];
        const result = await getRelationshipReconnectTargetsInTabs(tabs, relation, endpoint);
        // Every visible alternative must be accepted by the actual edit path.
        for (const target of result.targets) expect(reconnectRelationshipInTabs(tabs, relation, endpoint, target).ok).toBe(true);
        return result;
    }

    it('filters both lists using types, complete keys, nullability and duplicate links', async () => {
        const sql = 'CREATE TABLE p(id UUID PRIMARY KEY); CREATE TABLE q(id UUID PRIMARY KEY); CREATE TABLE c(parent_id UUID REFERENCES p(id) ON DELETE SET NULL, compatible UUID, required UUID NOT NULL, subtotal NUMERIC(18, 2)); CREATE TABLE bad(id NUMERIC(18, 2) PRIMARY KEY); CREATE TABLE duplicate(id UUID REFERENCES p(id));';
        expect((await choices(sql, 'from')).targets).toEqual([{ table: 'c', column: 'compatible', type: 'UUID' }]);
        expect((await choices(sql, 'to')).targets).toEqual([{ table: 'q', column: 'id', type: 'UUID' }]);
    });

    it('accepts complete unique keys even alongside composite keys, excluding partial indexes and individual composite members', async () => {
        const sql = 'CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE partial(id INT); CREATE UNIQUE INDEX puq ON partial(id) WHERE id>0; CREATE TABLE composite(a INT,b INT,PRIMARY KEY(a,b)); CREATE TABLE global_key(id INT); CREATE UNIQUE INDEX uq ON global_key(id); CREATE TABLE mixed(a INT,b INT,UNIQUE(a,b),UNIQUE(a)); CREATE TABLE c(id INT REFERENCES p(id));';
        expect((await choices(sql, 'to')).targets.map((t) => `${t.table}.${t.column}`)).toEqual(['global_key.id', 'mixed.a']);
    });

    it.each([
        ['VARCHAR(30)', 'VARCHAR(31)'],
        ['NUMERIC(18,2)', 'NUMERIC(18,3)'],
        ['BIGINT', 'INT'],
        ['INT UNSIGNED', 'INT'],
        ['UUID[]', 'UUID'],
    ])('excludes incompatible %s and %s in either list', async (left, right) => {
        const sql = `CREATE TABLE p(id ${left} PRIMARY KEY); CREATE TABLE c(id ${left} REFERENCES p(id)); CREATE TABLE q(id ${right} PRIMARY KEY);`;
        expect((await choices(sql, 'to')).targets).toEqual([]);
        expect((await choices(sql, 'from')).targets.some((t) => t.table === 'q')).toBe(false);
    });

    it.each([
        ['CREATE TABLE d(id INT,CONSTRAINT fk UNIQUE(id));', 'CONSTRAINT fk FOREIGN KEY(a) REFERENCES p(id)'],
        ['CREATE TABLE d(old_id INT); ALTER TABLE d RENAME COLUMN old_id TO id;', 'FOREIGN KEY(a) REFERENCES p(id)'],
        ['CREATE TABLE d(id INT NOT NULL);', 'FOREIGN KEY(a) REFERENCES p(id) ON DELETE SET DEFAULT'],
    ])('excludes source fields whose constraint cannot be safely moved: %s', async (destination, key) => {
        const sql = `CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE c(a INT DEFAULT 1,${key}); ${destination}`;
        expect((await choices(sql, 'from')).targets.some((t) => t.table === 'd')).toBe(false);
    });

    it('explains empty alternatives and composite constraints', async () => {
        const sql = 'CREATE TABLE p(id UUID PRIMARY KEY); CREATE TABLE c(id UUID REFERENCES p(id));';
        expect(await choices(sql, 'to')).toMatchObject({ ok: true, targets: [], message: 'No compatible referenced keys available.' });
        const composite = 'CREATE TABLE p(a INT,b INT,PRIMARY KEY(a,b)); CREATE TABLE c(a INT,b INT,FOREIGN KEY(a,b) REFERENCES p(a,b));';
        expect(await choices(composite, 'from')).toMatchObject({ ok: false, targets: [], message: expect.stringContaining('multiple columns') });
    });

    it('skips incompatible/non-key fields before reparsing and caches only the current SQL choices', async () => {
        const sql = 'CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE q(id INT PRIMARY KEY,ordinary INT); CREATE TABLE c(id INT REFERENCES p(id));' + Array.from({ length: 150 }, (_, i) => `CREATE TABLE unrelated${i}(id TEXT PRIMARY KEY,body TEXT);`).join('');
        const tabs = [{ id: 'schema', sql }];
        const relation = sqlToErdSchema(sql).relations[0];
        const spy = vi.spyOn(schemaModule, 'sqlToErdSchema');
        try {
            const first = await getRelationshipReconnectTargetsInTabs(tabs, relation, 'to');
            expect(first.targets).toEqual([{ table: 'q', column: 'id', type: 'INT' }]);
            expect(spy).toHaveBeenCalledTimes(2); // baseline plus the one plausible edit
            first.targets[0].column = 'mutated';
            expect((await getRelationshipReconnectTargetsInTabs(tabs, relation, 'to')).targets[0].column).toBe('id');
            expect(spy).toHaveBeenCalledTimes(2);
            const changed = [{ id: 'schema', sql: sql.replace('q(id INT', 'q(id TEXT') }];
            expect((await getRelationshipReconnectTargetsInTabs(changed, relation, 'to')).targets).toEqual([]);
            expect(spy).toHaveBeenCalledTimes(3);
        } finally { spy.mockRestore(); }
    });

    it('yields to user input while fully validating a large set of matching fields', async () => {
        const sql = 'CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE c(id INT REFERENCES p(id));' + Array.from({ length: 60 }, (_, i) => `CREATE TABLE candidate${i}(id INT);`).join('');
        const relation = sqlToErdSchema(sql).relations[0];
        let inputProcessed = false;
        const timer = setTimeout(() => { inputProcessed = true; }, 0);
        try {
            const result = await getRelationshipReconnectTargetsInTabs([{ id: 'schema', sql }], relation, 'from');
            expect(result.targets).toHaveLength(61);
            expect(inputProcessed).toBe(true);
        } finally { clearTimeout(timer); }
    });
});
