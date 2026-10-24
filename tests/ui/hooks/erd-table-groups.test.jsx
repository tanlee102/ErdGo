// @vitest-environment jsdom
/** Table-group edits belong to the current painted SQL canvas and never rerun layout. */
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RootLayoutContext } from '@/contexts/RootLayoutContext';
import { ConfirmProvider } from '@/components/ConfirmDialog';
import { useErdRendering } from '@/features/editor/hooks/useErdRendering';
import runErdScript from '@/lib/genErdScript';

vi.mock('@/lib/genErdScript', () => ({ default: vi.fn() }));

const group = { id: 'accounts', name: 'Accounts', tableNames: ['users', 'temporarily_absent'], color: '#3b82f6' };

function setup(context = {}, tableNames = ['users', 'orders']) {
    const erdContextRef = { current: context };
    const layout = { sqlInput: 'CREATE TABLE users (id INT); CREATE TABLE orders (id INT);', setSqlInput: vi.fn(), schemaRef: { current: { tables: tableNames.map((name) => ({ name, columns: [] })), relations: [] } } };
    const wrapper = ({ children }) => <RootLayoutContext.Provider value={layout}><ConfirmProvider>{children}</ConfirmProvider></RootLayoutContext.Provider>;
    const hook = renderHook((props) => useErdRendering({ theme: 'light', isLoading: false, contextLoadVersion: 1, erdContextRef, ...props }), { wrapper, initialProps: {} });
    return { ...hook, erdContextRef, layout };
}

async function finishRender(result) {
    await act(async () => { await Promise.resolve(); });
    act(() => runErdScript.mock.calls.at(-1)[1].onFirstPaint());
    await waitFor(() => expect(result.current.tableGroups.disabled).toBe(false));
}

describe('SQL canvas table-group bridge', () => {
    beforeEach(() => {
        runErdScript.mockReset().mockImplementation((_schema, options) => Promise.resolve({
            setTableGroups: vi.fn((tableGroups) => { options.onContextChange({ ...options.initialContext, tableGroups }); return true; }),
        }));
    });

    it('leaves legacy context untouched and exposes no groups until deliberately created', async () => {
        const { result, erdContextRef, layout } = setup({ tablePositions: { users: { x: 20, y: 40 } } });
        expect(result.current.tableGroups.groups).toEqual([]);
        expect(result.current.tableGroups.tables).toEqual([{ name: 'users' }, { name: 'orders' }]);
        const before = JSON.stringify(erdContextRef.current);
        expect(result.current.tableGroups.update([group])).toBe(false);
        await finishRender(result);
        expect(JSON.stringify(erdContextRef.current)).toBe(before);
        const renders = runErdScript.mock.calls.length;
        act(() => expect(result.current.tableGroups.update([group])).toBe(true));
        expect(result.current.tableGroups.groups).toEqual([group]);
        expect(erdContextRef.current.tablePositions).toEqual({ users: { x: 20, y: 40 } });
        expect(runErdScript.mock.calls.length).toBe(renders);
        expect(layout.setSqlInput).not.toHaveBeenCalled();
    });

    it('hydrates unavailable members, selection and header edit requests without rewriting saved groups', async () => {
        const { result, erdContextRef } = setup({ tableGroups: [group], selectedNodeName: 'users' });
        await finishRender(result);
        expect(result.current.tableGroups).toMatchObject({ groups: [group], selectedTableName: 'users', documentKey: 1 });
        const options = runErdScript.mock.calls.at(-1)[1];
        expect(options.tableGroupsEnabled).toBe(true);
        act(() => options.onTableGroupEdit('accounts'));
        expect(result.current.tableGroups.editRequest).toEqual({ id: 'accounts', version: 1 });
        expect(erdContextRef.current.tableGroups).toEqual([group]);
    });

    it('retains exact quoted table identifiers in the membership chooser', async () => {
        const spaced = { id: 'spaced', name: 'Quoted names', tableNames: [' spaced '] };
        const { result } = setup({ tableGroups: [spaced], selectedNodeName: ' spaced ' }, [' spaced ', 'users']);
        await finishRender(result);
        expect(result.current.tableGroups).toMatchObject({ groups: [spaced], tables: [{ name: ' spaced ' }, { name: 'users' }], selectedTableName: ' spaced ' });
    });

    it('revokes old group callbacks across layouts, replacement documents, AI preview and unmount', async () => {
        const { result, rerender, unmount, erdContextRef } = setup({ tableGroups: [group] });
        await finishRender(result);
        const oldOptions = runErdScript.mock.calls.at(-1)[1];
        const oldUpdate = result.current.tableGroups.update;
        act(() => result.current.setFlag((flag) => flag + 1));
        expect(result.current.tableGroups.update([])).toBe(false);
        act(() => oldOptions.onTableGroupEdit('accounts'));
        expect(result.current.tableGroups.editRequest).toBeNull();
        await finishRender(result);
        rerender({ contextLoadVersion: 2, isLoading: true });
        expect(oldUpdate([])).toBe(false);
        expect(result.current.tableGroups.update([])).toBe(false);
        rerender({ contextLoadVersion: 2, isLoading: false, isAiPreview: true });
        expect(runErdScript.mock.calls.at(-1)[1].onTableGroupEdit).toBeNull();
        expect(result.current.tableGroups.update([])).toBe(false);
        rerender({ contextLoadVersion: 2, isLoading: false, isAiPreview: false });
        await finishRender(result);
        expect(oldUpdate([])).toBe(false);
        const currentUpdate = result.current.tableGroups.update;
        unmount();
        expect(currentUpdate([])).toBe(false);
        expect(erdContextRef.current.tableGroups).toEqual([group]);
    });
});
