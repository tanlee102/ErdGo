// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSqlTabs } from '@/features/editor/hooks/useSqlTabs';
import { buildCombinedSql, serializeSqlTabs } from '@/features/editor/lib/sqlTabs';

function setup() {
    const tabs = [{ id: 'schema', title: 'Schema', sql: 'CREATE TABLE t(id INT PRIMARY KEY);' }, { id: 'private', title: 'Draft', sql: 'SELECT secret FROM future;', isInactive: true }];
    const props = { sqlInput: buildCombinedSql(tabs).sql, savedContext: { sqlTabs: serializeSqlTabs(tabs, 'private') }, loadVersion: 1, setSqlInput: vi.fn(), erdContextRef: { current: {} } };
    return { ...renderHook(value => useSqlTabs(value), { initialProps: props }), props };
}

describe('sample data tab insertion', () => {
    it('appends active data after the schema and preserves inactive SQL and tab identities', () => {
        const { result } = setup(); const context = result.current.getSampleDataContext();
        expect(context.sql).not.toContain('secret');
        act(() => expect(result.current.insertSampleDataTab('INSERT INTO t VALUES(1);', context.revision)).toEqual({ ok: true }));
        expect(result.current.tabs.map(tab => tab.title)).toEqual(['Schema', 'Draft', 'Sample Data']);
        expect(result.current.tabs[1]).toMatchObject({ id: 'private', isInactive: true, sql: 'SELECT secret FROM future;' });
        expect(result.current.activeTab.title).toBe('Sample Data');
        expect(result.current.combinedSql).toMatch(/CREATE TABLE[\s\S]*INSERT INTO/);
        expect(result.current.insertSampleDataTab('INSERT INTO t VALUES(1);', context.revision).ok).toBe(false);
    });
    it('rejects changed SQL, changed activation, and document reloads', () => {
        const { result, rerender, props } = setup(); const original = result.current.getSampleDataContext();
        act(() => result.current.toggleTabInactive('schema'));
        expect(result.current.insertSampleDataTab('INSERT INTO t VALUES(1);', original.revision).ok).toBe(false);
        const beforeLoad = result.current.getSampleDataContext(); const oldCallback = result.current.insertSampleDataTab;
        rerender({ ...props, loadVersion: 2 });
        expect(oldCallback('INSERT INTO t VALUES(1);', beforeLoad.revision).ok).toBe(false);
        const beforeEdit = result.current.getSampleDataContext();
        act(() => result.current.setActiveTabSql('-- changed draft'));
        expect(result.current.insertSampleDataTab('INSERT INTO t VALUES(1);', beforeEdit.revision).ok).toBe(false);
    });
    it('allows focus and title changes and chooses unique data-tab titles', () => {
        const { result } = setup(); const context = result.current.getSampleDataContext();
        act(() => { result.current.activateTab('schema'); result.current.renameTab('schema', 'Renamed schema'); });
        act(() => expect(result.current.insertSampleDataTab('INSERT INTO t VALUES(1);', context.revision).ok).toBe(true));
        const next = result.current.getSampleDataContext();
        act(() => expect(result.current.insertSampleDataTab('INSERT INTO t VALUES(2);', next.revision).ok).toBe(true));
        expect(result.current.tabs.at(-1).title).toBe('Sample Data 2');
    });
});
