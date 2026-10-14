// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSqlTabs } from '@/features/editor/hooks/useSqlTabs';
import { buildCombinedSql, serializeSqlTabs } from '@/features/editor/lib/sqlTabs';
import { sqlToErdSchema } from '@/lib/erdJsonSchema';

function setup() {
    const tabs = [{ id: 'first', title: 'First', sql: 'CREATE TABLE first(id INTEGER PRIMARY KEY);' }, { id: 'draft', title: 'Draft', sql: 'CREATE TABLE draft(id INTEGER PRIMARY KEY);', isInactive: true }, { id: 'last', title: 'Last', sql: 'CREATE TABLE last(id INTEGER PRIMARY KEY);' }];
    const savedContext = { sqlTabs: serializeSqlTabs(tabs, 'draft') }; const setSqlInput = vi.fn();
    const props = { sqlInput: buildCombinedSql(tabs).sql, savedSql: buildCombinedSql(tabs).sql, savedContext, loadVersion: 1, setSqlInput, erdContextRef: { current: savedContext } };
    return { ...renderHook(p => useSqlTabs(p), { initialProps: props }), props, setSqlInput };
}
describe('Add Table SQL-tab context and mutation guards', () => {
    it('includes the focused inactive draft without activating it or exposing other inactive drafts', () => {
        const { result, setSqlInput } = setup(); const context = result.current.getAddTableContext();
        expect(context.beforeSql).toContain('CREATE TABLE first'); expect(context.beforeSql).toContain('CREATE TABLE draft'); expect(context.beforeSql).not.toContain('CREATE TABLE last');
        expect(context.afterSql).toContain('CREATE TABLE last'); expect(setSqlInput).not.toHaveBeenCalled();
        act(() => result.current.activateTab('last'));
        expect(result.current.getAddTableContext().beforeSql).not.toContain('CREATE TABLE draft');
        expect(result.current.tabs.find(t => t.id === 'draft').isInactive).toBe(true);
    });
    it('rejects stale snapshots after edits, tab focus, membership changes and document reloads', () => {
        const { result, rerender, props, setSqlInput } = setup(); const context = result.current.getAddTableContext();
        act(() => result.current.setActiveTabSql(result.current.activeSql + '\n-- changed')); setSqlInput.mockClear();
        act(() => expect(result.current.appendSqlToActiveTab('CREATE TABLE added(id INTEGER);', { expectedRevision: context.revision })).toBe(false));
        expect(setSqlInput).not.toHaveBeenCalled();
        const next = result.current.getAddTableContext(); act(() => result.current.activateTab('last'));
        act(() => expect(result.current.appendSqlToActiveTab('CREATE TABLE added(id INTEGER);', { expectedRevision: next.revision })).toBe(false));
        const focused = result.current.getAddTableContext(); act(() => result.current.toggleTabInactive('first'));
        act(() => expect(result.current.appendSqlToActiveTab('CREATE TABLE added(id INTEGER);', { expectedRevision: focused.revision })).toBe(false));
        const beforeLoad = result.current.getAddTableContext(); rerender({ ...props, loadVersion: 2 });
        act(() => expect(result.current.appendSqlToActiveTab('CREATE TABLE added(id INTEGER);', { expectedRevision: beforeLoad.revision })).toBe(false));
    });
    it('appends to an inactive draft atomically and retains its compilation state', () => {
        const { result, setSqlInput, props } = setup(); const revision = result.current.getAddTableContext().revision;
        act(() => expect(result.current.appendSqlToActiveTab('CREATE TABLE added(id INTEGER);', { expectedRevision: revision })).toBe(true));
        expect(result.current.tabs.find(t => t.id === 'draft')).toMatchObject({ isInactive: true, sql: expect.stringContaining('CREATE TABLE added') });
        expect(result.current.combinedSql).not.toContain('CREATE TABLE added'); expect(setSqlInput).toHaveBeenLastCalledWith(props.sqlInput);
    });
    it('never lets a previous document’s connector Undo change an identical new document', () => {
        const sql = 'CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE q(id INTEGER PRIMARY KEY); CREATE TABLE c(pid INTEGER REFERENCES p(id));';
        const props = { sqlInput: sql, loadVersion: 1, setSqlInput: vi.fn(), erdContextRef: { current: {} } };
        const { result, rerender } = renderHook(p => useSqlTabs(p), { initialProps: props }); let edit;
        act(() => { edit = result.current.reconnectRelationship(sqlToErdSchema(sql).relations[0], 'to', { table: 'q', column: 'id' }); });
        expect(edit.ok).toBe(true); const nextSql = result.current.combinedSql;
        const savedContext = { sqlTabs: serializeSqlTabs(result.current.tabs, result.current.activeTabId) };
        rerender({ ...props, sqlInput: nextSql, savedSql: nextSql, savedContext, loadVersion: 2 }); props.setSqlInput.mockClear();
        act(() => expect(edit.undo()).toBe(false)); expect(result.current.combinedSql).toBe(nextSql); expect(props.setSqlInput).not.toHaveBeenCalled();
    });
});
