/** Exercises the public SQL → tabs → reconnect → save/reload workflow together. */
import { describe, expect, it } from 'vitest';
import { sqlToErdSchema } from '@/lib/erdJsonSchema';
import { detectEditorSqlDialect } from '@/features/editor/lib/sqlDialectDetection';
import { getRelationshipReconnectTargetsInTabs, reconnectRelationshipInTabs } from '@/features/editor/lib/relationshipReconnect';
import {
    buildCombinedSql, findSqlTabTableLocation, getActiveSqlTabIdFromContext,
    getDirtySqlTabIds, hydrateSqlTabsFromContext, mapDiagnosticsToSqlTabs,
    reconcileSqlTabsFromCombinedSql, serializeSqlTabs,
} from '@/features/editor/lib/sqlTabs';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* older Node runtimes */ }

const DIALECTS = [
    { dialect: 'sqlite', prefix: 'PRAGMA foreign_keys=ON;', quote: (name) => `"${name}"` },
    { dialect: 'postgres', prefix: 'SET search_path=public;', quote: (name) => `"${name}"` },
    { dialect: 'mysql', prefix: 'SET NAMES utf8mb4;', quote: (name) => '`' + name + '`' },
    { dialect: 'mssql', prefix: 'SET ANSI_NULLS ON;', quote: (name) => `[${name}]` },
];
const CASES = DIALECTS.flatMap((profile) => ['inline', 'table'].flatMap((shape) => ['\n', '\r\n'].map((eol) => ({
    ...profile, shape, eol, name: `${profile.dialect}/${shape}/${eol === '\n' ? 'LF' : 'CRLF'}`,
}))));
const errorOnly = (schema) => schema._parseErrors.filter((entry) => entry.severity === 'error');
const relationFrom = (schema, name) => schema.relations.find((relation) => relation.from.table === name);
const tableSemantics = (schema) => schema.tables.map((table) => ({
    name: table.name,
    columns: table.columns.map(({ name, type, pk, constraints, extras }) => ({ name, type, pk, constraints, extras })),
}));

function fixture({ prefix, quote: q, shape, eol }) {
    const make = (id, sql, isInactive = false) => ({ id, title: id, sql: sql.replaceAll('\n', eol), createdAt: 1, isInactive });
    const key = `REFERENCES ${q('p')}(id) ON DELETE CASCADE ON UPDATE CASCADE`;
    return [
        make('parents', `${prefix}\nCREATE TABLE ${q('p')}(id INTEGER PRIMARY KEY);\nCREATE TABLE ${q('q')}(id INTEGER PRIMARY KEY);`),
        make('origin', `-- source 🧭\nCREATE TABLE ${q('c')}(parent_id INTEGER ${shape === 'inline' ? key : ''}, next_id INTEGER, note TEXT DEFAULT ')', CHECK(note <> '(')${shape === 'table' ? `, CONSTRAINT fk_c_parent FOREIGN KEY(parent_id) ${key}` : ''});`),
        make('empty', ''),
        make('private', 'PRAGMA foreign_keys=OFF;\nCREATE TABLE archived(id TEXT PRIMARY KEY);', true),
        make('destination', `CREATE TABLE ${q('d')}(id INTEGER);\nCREATE TABLE ${q('audit')}(parent_id INTEGER REFERENCES ${q('p')}(id));`),
    ];
}

describe('SQL workspace integration', () => {
    it.each(CASES)('$name preserves endpoint eligibility through unrelated migrations in a separate tab', async (profile) => {
        const tabs = fixture(profile); const q = profile.quote;
        const history = `ALTER TABLE ${q('c')} ADD retired INTEGER;\nALTER TABLE ${q('c')} DROP COLUMN retired;\nALTER TABLE ${q('q')} ADD note INTEGER;`.replaceAll('\n', profile.eol);
        tabs.push({ id: 'migrations', title: 'Migrations', sql: history, createdAt: 1 });
        const beforeSql = buildCombinedSql(tabs).sql; const before = sqlToErdSchema(beforeSql);
        const original = relationFrom(before, 'c');
        const targets = await getRelationshipReconnectTargetsInTabs(tabs, original, 'to');
        expect(targets.targets).toContainEqual({ table: 'q', column: 'id', type: 'INTEGER' });
        expect(targets.targets.some(field => field.table === 'archived' || field.column === 'retired' || field.column === 'note')).toBe(false);
        const referenced = reconnectRelationshipInTabs(tabs, original, 'to', { table: 'q', column: 'id' });
        expect(referenced.ok, referenced.message).toBe(true);
        const updated = relationFrom(sqlToErdSchema(buildCombinedSql(referenced.nextTabs).sql), 'c');
        const fields = await getRelationshipReconnectTargetsInTabs(referenced.nextTabs, updated, 'from');
        expect(fields.targets).toContainEqual({ table: 'd', column: 'id', type: 'INTEGER' });
        const moved = reconnectRelationshipInTabs(referenced.nextTabs, updated, 'from', { table: 'd', column: 'id' });
        expect(moved.ok, moved.message).toBe(true);
        expect(moved.nextTabs.find(tab => tab.id === 'migrations')).toEqual(tabs.at(-1));
        expect(moved.nextTabs.find(tab => tab.id === 'private')).toEqual(tabs.find(tab => tab.id === 'private'));
        const afterSql = buildCombinedSql(moved.nextTabs).sql; const after = sqlToErdSchema(afterSql);
        expect(errorOnly(after)).toEqual([]); expect(after.relations).toHaveLength(before.relations.length);
        expect(tableSemantics(after)).toEqual(tableSemantics(before));
        expect(relationFrom(after, 'd')).toMatchObject({ from: { table: 'd', column: 'id' }, to: { table: 'q', column: 'id' }, actions: { onDelete: 'CASCADE', onUpdate: 'CASCADE' } });
        const context = { sqlTabs: serializeSqlTabs(moved.nextTabs, 'private') };
        const reloaded = hydrateSqlTabsFromContext(afterSql, context);
        expect(buildCombinedSql(reloaded).sql).toBe(afterSql);
        expect(getActiveSqlTabIdFromContext(context, reloaded)).toBe('private');
        if (DatabaseSync && profile.dialect === 'sqlite') {
            const database = new DatabaseSync(':memory:');
            try {
                database.exec(afterSql); database.exec('INSERT INTO q(id) VALUES(1); INSERT INTO d(id) VALUES(1); UPDATE q SET id=2 WHERE id=1;');
                expect(database.prepare('SELECT id FROM d').get().id).toBe(2);
                database.exec('DELETE FROM q WHERE id=2;'); expect(database.prepare('SELECT count(*) AS n FROM d').get().n).toBe(0);
            } finally { database.close(); }
        }
    });
    it.each(CASES)('$name keeps schema semantics, owners and private drafts across both connector edits and saved reload', async (profile) => {
        const tabs = fixture(profile);
        const initialSql = buildCombinedSql(tabs).sql;
        const initial = sqlToErdSchema(initialSql);
        expect(errorOnly(initial)).toEqual([]);
        expect(initial.tables.map((table) => table.name)).toEqual(['p', 'q', 'c', 'd', 'audit']);
        expect(initial.relations).toHaveLength(2);
        expect(detectEditorSqlDialect(tabs[1].sql, initialSql).id).toBe(profile.dialect);
        const original = relationFrom(initial, 'c');
        const targets = await getRelationshipReconnectTargetsInTabs(tabs, original, 'to');
        expect(targets.targets).toContainEqual({ table: 'q', column: 'id', type: 'INTEGER' });
        expect(targets.targets.some((field) => field.table === 'archived' || field.table === 'd')).toBe(false);

        const referenced = reconnectRelationshipInTabs(tabs, original, 'to', { table: 'q', column: 'id' });
        expect(referenced.ok, referenced.message).toBe(true);
        expect(referenced.nextTabs[0]).toBe(tabs[0]);
        expect(referenced.nextTabs[3]).toBe(tabs[3]);
        const nextRelation = relationFrom(sqlToErdSchema(buildCombinedSql(referenced.nextTabs).sql), 'c');
        const moved = reconnectRelationshipInTabs(referenced.nextTabs, nextRelation, 'from', { table: 'd', column: 'id' });
        expect(moved.ok, moved.message).toBe(true);
        expect(moved.nextTabs.map((tab) => tab.id)).toEqual(tabs.map((tab) => tab.id));
        expect(moved.nextTabs[0]).toBe(tabs[0]);
        expect(moved.nextTabs[2]).toBe(tabs[2]);
        expect(moved.nextTabs[3]).toBe(tabs[3]);

        const sql = buildCombinedSql(moved.nextTabs).sql;
        const schema = sqlToErdSchema(sql);
        expect(errorOnly(schema)).toEqual([]);
        expect(tableSemantics(schema)).toEqual(tableSemantics(initial));
        expect(schema.relations).toHaveLength(2);
        expect(relationFrom(schema, 'd')).toMatchObject({ from: { table: 'd', column: 'id' }, to: { table: 'q', column: 'id' }, actions: original.actions });
        expect(relationFrom(schema, 'audit').to).toEqual({ table: 'p', column: 'id' });
        expect(sql).toContain("DEFAULT ')'");
        expect(sql).toContain('-- source 🧭');
        expect(sql).not.toContain('archived');
        if (profile.shape === 'table') expect(relationFrom(schema, 'd').fkName).toBe('fk_c_parent');

        const context = JSON.parse(JSON.stringify({ sqlTabs: serializeSqlTabs(moved.nextTabs, 'private') }));
        const restored = hydrateSqlTabsFromContext(sql, context);
        expect(restored).toEqual(moved.nextTabs);
        expect(getActiveSqlTabIdFromContext(context, restored)).toBe('private');
        expect([...getDirtySqlTabIds(restored, moved.nextTabs)]).toEqual([]);
        expect(sqlToErdSchema(buildCombinedSql(restored).sql)).toEqual(schema);
        expect(findSqlTabTableLocation(restored, 'c').tabId).toBe('origin');
        expect(findSqlTabTableLocation(restored, 'd').tabId).toBe('destination');
        expect(findSqlTabTableLocation(restored, 'archived')).toBeNull();

        if (profile.dialect === 'sqlite' && DatabaseSync) {
            const database = new DatabaseSync(':memory:');
            try {
                database.exec(sql);
                expect(database.prepare('PRAGMA foreign_key_list(c)').all()).toEqual([]);
                expect(database.prepare('PRAGMA foreign_key_list(d)').get()).toMatchObject({ table: 'q', from: 'id', to: 'id', on_delete: 'CASCADE', on_update: 'CASCADE' });
                database.exec('INSERT INTO q VALUES(1); INSERT INTO d VALUES(1); UPDATE q SET id=2 WHERE id=1;');
                expect(database.prepare('SELECT id FROM d').get().id).toBe(2);
                expect(() => database.exec('INSERT INTO d VALUES(9)')).toThrow(/FOREIGN KEY/);
                database.exec('DELETE FROM q WHERE id=2;');
                expect(database.prepare('SELECT COUNT(*) AS n FROM d').get().n).toBe(0);
            } finally { database.close(); }
        }
    });

    it.each(['\n', '\r\n', '\r'])('retains all tab identities after independent Unicode edits and maps real diagnostics with %j endings', (eol) => {
        const tabs = fixture({ ...DIALECTS[0], shape: 'table', eol });
        const nextTabs = tabs.map((tab) => tab.id === 'origin' ? { ...tab, sql: tab.sql.replace('note TEXT', '説明 TEXT').replaceAll('note <>', '説明 <>') }
            : tab.id === 'destination' ? { ...tab, sql: tab.sql + eol + 'CREATE TABLE broken(parent_id INTEGER REFERENCES missing(id));' } : tab);
        const expected = buildCombinedSql(nextTabs).sql;
        const reconciled = reconcileSqlTabsFromCombinedSql(tabs, expected);
        expect(reconciled).toEqual(nextTabs);
        const schema = sqlToErdSchema(expected);
        expect(schema.relations).toHaveLength(2);
        const diagnostics = mapDiagnosticsToSqlTabs(schema._parseErrors, reconciled);
        const missing = diagnostics.find((diagnostic) => diagnostic.kind === 'relation_dropped_unknown_table');
        expect(missing).toMatchObject({ tabId: 'destination', line: 3 });
        const context = { sqlTabs: serializeSqlTabs(reconciled, 'origin') };
        expect(hydrateSqlTabsFromContext(expected, context)).toEqual(reconciled);
    });

    it.skipIf(!DatabaseSync)('rejects an expression-index FK that native SQLite cannot enforce, then permits an independent complete key', async () => {
        const sql = 'PRAGMA foreign_keys=ON; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE q(id INTEGER,note TEXT); CREATE UNIQUE INDEX uq ON q(id,lower(note)); CREATE TABLE c(id INTEGER REFERENCES p(id));';
        const tabs = [{ id: 'schema', sql }];
        const relation = sqlToErdSchema(sql).relations[0];
        const target = { table: 'q', column: 'id' };
        expect(reconnectRelationshipInTabs(tabs, relation, 'to', target).ok).toBe(false);
        expect((await getRelationshipReconnectTargetsInTabs(tabs, relation, 'to')).targets).not.toContainEqual({ ...target, type: 'INTEGER' });
        const database = new DatabaseSync(':memory:');
        try {
            database.exec(sql.replace('REFERENCES p', 'REFERENCES q'));
            expect(() => database.exec("INSERT INTO q VALUES(1,'x'); INSERT INTO c VALUES(1);")).toThrow(/foreign key mismatch/i);
        } finally { database.close(); }
        const corrected = [{ ...tabs[0], sql: sql.replace('q(id INTEGER,', 'q(id INTEGER UNIQUE,') }];
        const result = reconnectRelationshipInTabs(corrected, relation, 'to', target);
        expect(result.ok, result.message).toBe(true);
        const valid = new DatabaseSync(':memory:');
        try {
            valid.exec(buildCombinedSql(result.nextTabs).sql);
            valid.exec("INSERT INTO q VALUES(1,'x'); INSERT INTO c VALUES(1);");
            expect(() => valid.exec('INSERT INTO c VALUES(2)')).toThrow(/FOREIGN KEY/);
        } finally { valid.close(); }
    });
});
