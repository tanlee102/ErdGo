// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSqlTabs } from '@/features/editor/hooks/useSqlTabs';
import { buildCombinedSql, serializeSqlTabs } from '@/features/editor/lib/sqlTabs';
import { sqlToErdSchema } from '@/lib/erdJsonSchema';
import { sampleSchemaSQL } from '@/features/editor/lib/sampleSQL';
const initial = [{ id: 'p', title: 'Parent', sql: 'PRAGMA foreign_keys=ON; CREATE TABLE p(id INTEGER PRIMARY KEY, note TEXT);' }, { id: 'c', title: 'Child', sql: 'CREATE TABLE c(pid INTEGER REFERENCES p(id), note TEXT);' }, { id: 'off', title: 'Private', sql: 'private sql bytes', isInactive: true }];
function setup() {
    const sqlInput = buildCombinedSql(initial).sql;
    const savedContext = { sqlTabs: serializeSqlTabs(initial, 'c'), tablePositions: { p: { x: 1, y: 2 } }, tableColors: { p: 'red' } };
    const erdContextRef = { current: savedContext }; const setSqlInput = vi.fn();
    const props = { sqlInput, savedContext, savedSql: sqlInput, loadVersion: 1, setSqlInput, erdContextRef };
    return { ...renderHook((options) => useSqlTabs(options), { initialProps: props }), props, erdContextRef, setSqlInput };
}
describe('canvas SQL tab bridge', () => {
    it('recreates the commerce FK only in its owning tab and restores it exactly with Undo while a private tab is focused', () => {
        const middle = sampleSchemaSQL.indexOf('CREATE TABLE categories'); const end = sampleSchemaSQL.indexOf('CREATE TABLE orders');
        const source = [
            { id: 'users', title: 'Users', sql: sampleSchemaSQL.slice(0, middle) },
            { id: 'products', title: 'Products', sql: sampleSchemaSQL.slice(middle, end).replace('category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL', 'category_id INTEGER') },
            { id: 'orders', title: 'Orders', sql: sampleSchemaSQL.slice(end) },
            { id: 'off', title: 'Private', sql: 'private sql bytes', isInactive: true },
        ];
        const sqlInput = buildCombinedSql(source).sql; const savedContext = { sqlTabs: serializeSqlTabs(source, 'off') }; const setSqlInput = vi.fn();
        const erdContextRef = { current: savedContext };
        const { result } = renderHook(() => useSqlTabs({ sqlInput, savedSql: sqlInput, savedContext, setSqlInput, erdContextRef, loadVersion: 1 }));
        const action = { kind: 'add-relationship', from: { table: 'products', column: 'category_id' }, to: { table: 'categories', column: 'id' } };
        const before = result.current.tabs.map(tab => ({ ...tab })); const preview = result.current.editCanvasSchema(action, { preview: true });
        expect(preview.ok, preview.message).toBe(true); expect(setSqlInput).not.toHaveBeenCalled();
        let edit; act(() => { edit = result.current.editCanvasSchema(action, { expectedRevision: preview.revision }); });
        expect(edit.ok, edit.message).toBe(true); expect(setSqlInput).toHaveBeenCalledTimes(1);
        expect(result.current.activeTabId).toBe('off');
        for (const index of [0, 2, 3]) expect(result.current.tabs[index]).toEqual(before[index]);
        expect(result.current.tabs[1].sql).toContain('ALTER TABLE products DROP COLUMN retired_at');
        expect(sqlToErdSchema(result.current.combinedSql).relations).toHaveLength(5);
        act(() => expect(edit.undo()).toBe(true)); expect(result.current.tabs).toEqual(before); expect(result.current.activeTabId).toBe('off');
    });
    it('previews connector deletion, keeps fields and inactive tabs, commits once, and restores exact SQL with Undo', () => {
        const { result, setSqlInput, erdContextRef } = setup();
        const inactive = result.current.tabs[2];
        const relation = sqlToErdSchema(result.current.combinedSql).relations[0];
        const action = { kind: 'remove-relationship', relation };
        const preview = result.current.editCanvasSchema(action, { preview: true });
        expect(preview.ok, preview.message).toBe(true); expect(setSqlInput).not.toHaveBeenCalled();
        expect(preview.impacts).toEqual([{ kind: 'remove-relationship', label: 'c.pid → p.id' }]);
        let edit; act(() => { edit = result.current.editCanvasSchema(action, { expectedRevision: preview.revision }); });
        expect(edit.ok, edit.message).toBe(true); expect(setSqlInput).toHaveBeenCalledTimes(1);
        expect(result.current.tabs[0].sql).toBe(initial[0].sql); expect(result.current.tabs[2]).toEqual(inactive);
        expect(sqlToErdSchema(result.current.combinedSql).tables[1].columns.map((c) => c.name)).toEqual(['pid', 'note']);
        expect(sqlToErdSchema(result.current.combinedSql).relations).toEqual([]);
        expect(result.current.activeTabId).toBe('c'); expect(erdContextRef.current.tablePositions).toEqual({ p: { x: 1, y: 2 } });
        act(() => expect(edit.undo()).toBe(true)); expect(result.current.tabs.map((t) => t.sql)).toEqual(initial.map((t) => t.sql));
    });
    it('rejects connector deletion if SQL changed while its confirmation was open', () => {
        const { result, setSqlInput } = setup();
        const action = { kind: 'remove-relationship', relation: sqlToErdSchema(result.current.combinedSql).relations[0] };
        const preview = result.current.editCanvasSchema(action, { preview: true });
        act(() => result.current.setActiveTabSql(result.current.activeSql + '\n-- later edit')); setSqlInput.mockClear();
        act(() => expect(result.current.editCanvasSchema(action, { expectedRevision: preview.revision }).ok).toBe(false));
        expect(setSqlInput).not.toHaveBeenCalled(); expect(result.current.tabs[1].sql).toContain('REFERENCES');
    });
    it('previews without a write, then commits affected tabs while retaining focus, inactive SQL and presentation', () => {
        const { result, setSqlInput, erdContextRef } = setup();
        const action = { kind: 'remove-column', table: 'p', column: 'id' };
        const inactive = result.current.tabs[2];
        const preview = result.current.editCanvasSchema(action, { preview: true }); expect(preview.ok, preview.message).toBe(true); expect(setSqlInput).not.toHaveBeenCalled();
        act(() => { expect(result.current.editCanvasSchema(action, { expectedRevision: preview.revision }).ok).toBe(true); });
        expect(result.current.activeTabId).toBe('c'); expect(result.current.tabs[0].sql).not.toContain('PRIMARY KEY'); expect(result.current.tabs[1].sql).not.toContain('REFERENCES'); expect(result.current.tabs[2]).toEqual(inactive);
        expect(erdContextRef.current.tablePositions).toEqual({ p: { x: 1, y: 2 } }); expect(erdContextRef.current.tableColors).toEqual({ p: 'red' });
    });
    it('reveals a newly added column in a compact table without expanding other tables', () => {
        const { result, erdContextRef } = setup(); erdContextRef.current.tableCompactModes = { p: true, c: true };
        act(() => expect(result.current.editCanvasSchema({ kind: 'add-column', table: 'p', column: 'amount', definition: 'REAL' }).ok).toBe(true));
        expect(erdContextRef.current.tableCompactModes).toEqual({ p: false, c: true });
    });
    it('rejects removal review after any SQL or active-membership change', () => {
        const { result, setSqlInput } = setup(); const action = { kind: 'remove-column', table: 'p', column: 'id' };
        const preview = result.current.editCanvasSchema(action, { preview: true });
        act(() => result.current.setActiveTabSql(result.current.activeSql + '\n-- later change')); setSqlInput.mockClear();
        act(() => expect(result.current.editCanvasSchema(action, { expectedRevision: preview.revision }).ok).toBe(false)); expect(setSqlInput).not.toHaveBeenCalled();
    });
    it('guards document loads even when tab SQL is identical', () => {
        const { result, rerender, props } = setup(); const action = { kind: 'remove-column', table: 'p', column: 'id' };
        const preview = result.current.editCanvasSchema(action, { preview: true }); rerender({ ...props, loadVersion: 2 });
        act(() => expect(result.current.editCanvasSchema(action, { expectedRevision: preview.revision }).ok).toBe(false));
    });
    it('undo restores exact SQL and retains cosmetic focus/title changes', () => {
        const { result } = setup(); let edit;
        act(() => { edit = result.current.editCanvasSchema({ kind: 'add-column', table: 'p', column: 'price', definition: 'REAL' }); });
        expect(edit.ok, edit.message).toBe(true);
        act(() => { result.current.renameTab('p', 'Renamed'); result.current.activateTab('p'); });
        act(() => expect(edit.undo()).toBe(true)); expect(result.current.tabs[0].sql).toBe(initial[0].sql); expect(result.current.tabs[0].title).toBe('Renamed'); expect(result.current.activeTabId).toBe('p');
    });
    it('undo cannot overwrite later SQL or a new document', () => {
        const { result, rerender, props } = setup(); let edit;
        act(() => { edit = result.current.editCanvasSchema({ kind: 'add-column', table: 'p', column: 'price', definition: 'REAL' }); });
        act(() => result.current.setActiveTabSql(result.current.activeSql + '\n-- later'));
        act(() => expect(edit.undo()).toBe(false));
        rerender({ ...props, sqlInput: result.current.combinedSql, savedContext: { sqlTabs: serializeSqlTabs(result.current.tabs, 'p') }, loadVersion: 2 });
        act(() => expect(edit.undo()).toBe(false));
    });
    it('validates again at drop and never mutates a mismatched field', () => {
        const { result, setSqlInput } = setup(); const action = { kind: 'add-relationship', from: { table: 'c', column: 'note' }, to: { table: 'p', column: 'id' } };
        act(() => expect(result.current.editCanvasSchema(action).ok).toBe(false)); expect(setSqlInput).not.toHaveBeenCalled();
    });
    it('exposes cascade review, commits all affected tabs once and undoes their exact SQL', () => {
        const { result, setSqlInput } = setup();
        act(() => result.current.setActiveTabSql(result.current.activeSql + " INSERT INTO c(pid,note) VALUES(1,'keep'); CREATE VIEW v AS SELECT note FROM c;"));
        const before = result.current.tabs.map((t) => ({ ...t })); setSqlInput.mockClear();
        const action = { kind: 'remove-column', table: 'c', column: 'note' };
        const blocked = result.current.editCanvasSchema(action, { preview: true }); expect(blocked.canCascade).toBe(true); expect(setSqlInput).not.toHaveBeenCalled();
        const cascade = { ...action, cascade: true }; const preview = result.current.editCanvasSchema(cascade, { preview: true }); expect(preview.ok, preview.message).toBe(true); expect(setSqlInput).not.toHaveBeenCalled();
        let committed; act(() => { committed = result.current.editCanvasSchema(cascade, { expectedRevision: preview.revision }); });
        expect(committed.ok, committed.message).toBe(true); expect(result.current.tabs[1].sql).toContain('INSERT INTO c(pid) VALUES(1)'); expect(result.current.tabs[1].sql).not.toContain('CREATE VIEW'); expect(result.current.tabs[2]).toEqual(before[2]);
        act(() => expect(committed.undo()).toBe(true)); expect(result.current.tabs).toEqual(before);
    });
});
