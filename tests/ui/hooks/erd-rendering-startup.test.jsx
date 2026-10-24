// @vitest-environment jsdom
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RootLayoutContext } from '@/contexts/RootLayoutContext';
import { ConfirmProvider } from '@/components/ConfirmDialog';
import { useErdRendering } from '@/features/editor/hooks/useErdRendering';
import runErdScript from '@/lib/genErdScript';

vi.mock('@/lib/genErdScript', () => ({ default: vi.fn() }));

function setup({ isLoading = false, context = {} } = {}) {
    const erdContextRef = { current: context };
    const value = { sqlInput: 'CREATE TABLE users (id INT);', setSqlInput: vi.fn(), schemaRef: { current: { tables: [{ name: 'users', columns: [] }], relations: [] } } };
    const wrapper = ({ children }) => <RootLayoutContext.Provider value={value}><ConfirmProvider>{children}</ConfirmProvider></RootLayoutContext.Provider>;
    const hook = renderHook(props => useErdRendering({ erdContextRef, contextLoadVersion: 1, ...props }), { wrapper, initialProps: { theme: 'light', isLoading } });
    return { ...hook, erdContextRef };
}

describe('ERD startup lifecycle', () => {
    beforeEach(() => { runErdScript.mockReset().mockResolvedValue({}); });

    it('starts with hydrated preferences before Monaco and stays busy until the first canvas paint', async () => {
        const { result, rerender } = setup({ isLoading: true, context: { fullConnect: true, showTableOwnerLabels: true, headerActionsAlwaysVisible: false } });
        expect(runErdScript).not.toHaveBeenCalled();
        expect(result.current.isRendering).toBe(true);
        expect(window.monaco).toBeUndefined();
        rerender({ theme: 'light', isLoading: false });
        await waitFor(() => expect(runErdScript).toHaveBeenCalled());
        for (const [, options] of runErdScript.mock.calls) expect(options).toMatchObject({ fullConnect: true, showTableOwnerLabels: true, headerActionsAlwaysVisible: false });
        // Resolving the renderer API is earlier than painting its first frame.
        expect(result.current.isRendering).toBe(true);
        act(() => runErdScript.mock.calls.at(-1)[1].onFirstPaint());
        expect(result.current.isRendering).toBe(false);
        expect(result.current.renderError).toBe(false);
    });

    it('ignores obsolete paints, context updates and API promises after a newer render or unmount', async () => {
        const pending = [];
        runErdScript.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
        const { result, rerender, unmount, erdContextRef } = setup();
        const previous = runErdScript.mock.calls.at(-1)[1];
        rerender({ theme: 'dark', isLoading: false });
        const current = runErdScript.mock.calls.at(-1)[1];
        expect(current).not.toBe(previous);
        expect(previous.isCurrentRender()).toBe(false);
        expect(current.isCurrentRender()).toBe(true);
        const exportPng = vi.fn(() => 'current image');
        await act(async () => { pending.at(-1)({ exportPng }); });
        await act(async () => { pending[0]({ exportPng: vi.fn(() => 'obsolete image') }); });
        act(() => {
            previous.onFirstPaint();
            previous.onContextChange({ tablePositions: { obsolete: { x: 1, y: 2 } } });
        });
        expect(result.current.isRendering).toBe(true);
        expect(erdContextRef.current).toEqual({});
        expect(result.current.exportPng()).toBe('current image');
        act(() => current.onFirstPaint());
        expect(result.current.isRendering).toBe(false);
        unmount();
        expect(current.isCurrentRender()).toBe(false);
        current.onContextChange({ tablePositions: { obsolete: { x: 1, y: 2 } } });
        expect(erdContextRef.current).toEqual({});
    });

    it('retains starter coloring through a superseded layout without carrying it to another document', async () => {
        const pending = [];
        runErdScript.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
        const { result, rerender } = setup({ isLoading: true });
        act(() => result.current.triggerAutoColor());
        rerender({ theme: 'light', isLoading: false, contextLoadVersion: 1 });
        expect(runErdScript.mock.calls.at(-1)[1].autoColor).toBe(true);
        rerender({ theme: 'dark', isLoading: false, contextLoadVersion: 1 });
        expect(runErdScript.mock.calls.at(-1)[1].autoColor).toBe(true);
        await act(async () => pending.at(-1)({}));
        act(() => result.current.setFlag(value => value + 1));
        expect(runErdScript.mock.calls.at(-1)[1].autoColor).toBe(false);
        act(() => result.current.triggerAutoColor());
        rerender({ theme: 'dark', isLoading: false, contextLoadVersion: 2 });
        expect(runErdScript.mock.calls.at(-1)[1].autoColor).toBe(false);
    });

    it('clears a failed render on retry and waits for the replacement paint', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const { result } = setup();
            await act(async () => runErdScript.mock.calls.at(-1)[1].onFirstPaint());
            runErdScript.mockRejectedValueOnce(new Error('layout unavailable'));
            await act(async () => result.current.setFlag(value => value + 1));
            expect(result.current.renderError).toBe(true);
            expect(result.current.isRendering).toBe(false);
            await act(async () => result.current.setFlag(value => value + 1));
            expect(result.current.renderError).toBe(false);
            expect(result.current.isRendering).toBe(true);
            act(() => runErdScript.mock.calls.at(-1)[1].onFirstPaint());
            expect(result.current.isRendering).toBe(false);
        } finally { log.mockRestore(); }
    });
});
