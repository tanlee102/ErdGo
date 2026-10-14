// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePrismaCanvasResize } from '@/features/prisma-erd/hooks/usePrismaCanvasResize';
import { createPrismaRenderSchema, usePrismaErdRendering } from '@/features/prisma-erd/hooks/usePrismaErdRendering';
import usePrismaSplitter from '@/features/prisma-erd/hooks/usePrismaSplitter';
import runErdScript from '@/lib/genErdScript';

vi.mock('@/lib/genErdScript', () => ({
    default: vi.fn(() => Promise.resolve({ exportPng: vi.fn() })),
}));

vi.mock('@/components/ConfirmDialog', () => ({
    useConfirm: () => ({ confirm: vi.fn() }),
}));

describe('Prisma ERD UI hooks', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.mocked(runErdScript).mockClear();
        document.body.innerHTML = '';
        delete globalThis.ResizeObserver;
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            writable: true,
            value: 1024,
        });
    });

    it('resizes the Prisma ERD canvas quickly when the diagram panel changes', () => {
        vi.useFakeTimers();
        document.body.innerHTML = '<div id="erd-container"><canvas id="erd-canvas"></canvas></div>';
        const erdContainer = document.getElementById('erd-container');
        const erdCanvas = document.getElementById('erd-canvas');
        erdContainer.getBoundingClientRect = () => ({ width: 320.8, height: 240.4 });
        const dispatchEvent = vi.spyOn(window, 'dispatchEvent');
        let observerCallback;
        const disconnect = vi.fn();

        globalThis.ResizeObserver = class {
            constructor(callback) {
                observerCallback = callback;
            }

            observe = vi.fn();
            disconnect = disconnect;
        };

        renderHook(() => usePrismaCanvasResize(true));

        expect(erdCanvas.width).toBe(320);
        expect(erdCanvas.height).toBe(240);
        expect(erdCanvas.style.width).toBe('320px');
        expect(erdCanvas.style.height).toBe('240px');

        erdContainer.getBoundingClientRect = () => ({ width: 500, height: 300 });
        act(() => {
            observerCallback();
            vi.advanceTimersByTime(16);
        });

        expect(erdCanvas.width).toBe(500);
        expect(erdCanvas.height).toBe(300);
        expect(dispatchEvent).toHaveBeenCalledWith(expect.any(Event));
    });

    it('falls back to window resize events when ResizeObserver is unavailable', () => {
        document.body.innerHTML = '<div id="erd-container"><canvas id="erd-canvas"></canvas></div>';
        const erdContainer = document.getElementById('erd-container');
        const erdCanvas = document.getElementById('erd-canvas');
        erdContainer.getBoundingClientRect = () => ({ width: 400, height: 260 });

        const hook = renderHook(() => usePrismaCanvasResize(true));
        expect(erdCanvas.width).toBe(400);
        expect(erdCanvas.height).toBe(260);

        erdContainer.getBoundingClientRect = () => ({ width: 640, height: 360 });
        act(() => window.dispatchEvent(new Event('resize')));
        expect(erdCanvas.width).toBe(640);
        expect(erdCanvas.height).toBe(360);

        hook.unmount();
    });

    it('caps the Prisma editor width without force-fitting ERD after desktop drag', () => {
        vi.useFakeTimers();
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            writable: true,
            value: 1200,
        });
        document.body.innerHTML = `
            <div class="workspace">
                <div class="prisma-erd-source-panel"></div>
                <div class="prisma-erd-splitter"></div>
                <div class="prisma-erd-diagram-panel"></div>
            </div>
        `;
        document.querySelector('.workspace').getBoundingClientRect = () => ({ width: 1000 });

        const forceFit = vi.fn();
        const resize = vi.fn();
        window.addEventListener('erd-force-fit', forceFit);
        window.addEventListener('resize', resize);
        const splitter = renderHook(() => usePrismaSplitter({ initialSize: 40, maxThreshold: { desktop: 84, mobile: 85 } }));
        splitter.result.current.splitterRef.current = document.querySelector('.prisma-erd-splitter');

        act(() => {
            splitter.result.current.handleSplitterMouseDown({
                target: document.querySelector('.prisma-erd-splitter'),
                clientX: 400,
                preventDefault: vi.fn(),
            });
            document.dispatchEvent(new MouseEvent('mouseup', { clientX: 1000 }));
        });

        expect(splitter.result.current.panelSize).toBe(84);

        act(() => vi.advanceTimersByTime(81));
        expect(forceFit).not.toHaveBeenCalled();
        expect(resize).not.toHaveBeenCalled();
        window.removeEventListener('erd-force-fit', forceFit);
        window.removeEventListener('resize', resize);
    });

    it('cleans up a desktop drag when the splitter unmounts', () => {
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            writable: true,
            value: 1200,
        });
        document.body.innerHTML = `
            <div class="workspace">
                <div class="prisma-erd-source-panel"></div>
                <div class="prisma-erd-splitter"></div>
                <div class="prisma-erd-diagram-panel"></div>
            </div>
        `;
        document.querySelector('.workspace').getBoundingClientRect = () => ({ width: 1000 });

        const splitter = renderHook(() => usePrismaSplitter({ initialSize: 40 }));
        splitter.result.current.splitterRef.current = document.querySelector('.prisma-erd-splitter');

        act(() => {
            splitter.result.current.handleSplitterMouseDown({
                target: document.querySelector('.prisma-erd-splitter'),
                clientX: 400,
                preventDefault: vi.fn(),
            });
        });

        expect(document.body.style.cursor).toBe('col-resize');
        splitter.unmount();
        expect(document.body.style.cursor).toBe('');
        expect(document.body.style.userSelect).toBe('');
    });

    it('switches between full-size editor and ERD views on mobile', () => {
        vi.useFakeTimers();
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            writable: true,
            value: 390,
        });
        const forceFit = vi.fn();
        window.addEventListener('erd-force-fit', forceFit);

        const splitter = renderHook(() => usePrismaSplitter({ initialSize: 40 }));

        expect(splitter.result.current.isMobile).toBe(true);
        expect(splitter.result.current.getPanelStyle(true)).toEqual(
            expect.objectContaining({
                width: '100%',
                height: '100%',
                display: 'flex',
            }),
        );
        expect(splitter.result.current.getPanelStyle(false)).toEqual(
            expect.objectContaining({
                width: '100%',
                height: '100%',
                display: 'none',
            }),
        );

        act(() => {
            splitter.result.current.toggleCollapse();
            vi.advanceTimersByTime(151);
        });

        expect(splitter.result.current.getPanelStyle(true).display).toBe('none');
        expect(splitter.result.current.getPanelStyle(false).display).toBe('flex');
        expect(forceFit).toHaveBeenCalledTimes(1);

        window.removeEventListener('erd-force-fit', forceFit);
    });

    it('auto-colors only the first Prisma ERD render for a new user', async () => {
        const schemaRef = { current: { tables: [{ name: 'User' }, { name: 'Post' }] } };
        const erdContextRef = { current: { tableColors: {}, tablePositions: {} } };

        const hook = renderHook(() =>
            usePrismaErdRendering({
                theme: 'light',
                schemaRef,
                erdContextRef,
                isCanvasReady: true,
                autoColorOnFirstRender: true,
            }),
        );

        await waitFor(() => expect(runErdScript).toHaveBeenCalledTimes(1));
        expect(runErdScript.mock.calls[0][1]).toEqual(expect.objectContaining({
            autoColor: true,
            initialContext: expect.objectContaining({
                tableHeaderTextModes: { User: 'white', Post: 'white' },
            }),
        }));
        expect(erdContextRef.current.tableHeaderTextModes).toEqual({ User: 'white', Post: 'white' });

        act(() => hook.result.current.setFlag((value) => value + 1));

        await waitFor(() => expect(runErdScript).toHaveBeenCalledTimes(2));
        expect(runErdScript.mock.calls[1][1]).toEqual(expect.objectContaining({ autoColor: false }));
    });

    it('keeps first-render auto-color pending until the deferred sample schema has tables', async () => {
        const schemaRef = { current: { tables: [] } };
        const erdContextRef = { current: { tableColors: {}, tablePositions: {} } };

        const hook = renderHook(() =>
            usePrismaErdRendering({
                theme: 'light',
                schemaRef,
                erdContextRef,
                isCanvasReady: true,
                autoColorOnFirstRender: true,
            }),
        );

        await waitFor(() => expect(runErdScript).toHaveBeenCalledTimes(1));
        expect(runErdScript.mock.calls[0][1]).toEqual(expect.objectContaining({ autoColor: false }));
        expect(erdContextRef.current.tableHeaderTextModes).toBeUndefined();

        schemaRef.current = { tables: [{ name: 'Organization' }, { name: 'Project' }] };
        act(() => hook.result.current.setFlag((value) => value + 1));

        await waitFor(() => expect(runErdScript).toHaveBeenCalledTimes(2));
        expect(runErdScript.mock.calls[1][1]).toEqual(expect.objectContaining({
            autoColor: true,
            initialContext: expect.objectContaining({
                tableHeaderTextModes: { Organization: 'white', Project: 'white' },
            }),
        }));

        schemaRef.current = { tables: [{ name: 'Organization' }, { name: 'Project' }, { name: 'Comment' }] };
        act(() => hook.result.current.setFlag((value) => value + 1));

        await waitFor(() => expect(runErdScript).toHaveBeenCalledTimes(3));
        expect(runErdScript.mock.calls[2][1]).toEqual(expect.objectContaining({
            autoColor: false,
            initialContext: expect.objectContaining({
                tableHeaderTextModes: {
                    Organization: 'white',
                    Project: 'white',
                    Comment: 'white',
                },
            }),
        }));
    });

    it('preserves stored Prisma table appearance on the first render', async () => {
        const schemaRef = { current: { tables: [{ name: 'User' }] } };
        const erdContextRef = {
            current: {
                tableColors: { User: '#00796B' },
                tableHeaderTextModes: { User: 'black' },
                tablePositions: {},
            },
        };

        const hook = renderHook(() =>
            usePrismaErdRendering({
                theme: 'light',
                schemaRef,
                erdContextRef,
                isCanvasReady: true,
                autoColorOnFirstRender: false,
            }),
        );

        await waitFor(() => expect(runErdScript).toHaveBeenCalledTimes(1));
        expect(runErdScript.mock.calls[0][1]).toEqual(
            expect.objectContaining({
                autoColor: false,
                initialContext: erdContextRef.current,
            }),
        );

        schemaRef.current = { tables: [{ name: 'User' }, { name: 'Post' }] };
        act(() => hook.result.current.setFlag((value) => value + 1));

        await waitFor(() => expect(runErdScript).toHaveBeenCalledTimes(2));
        expect(erdContextRef.current.tableHeaderTextModes).toEqual({ User: 'black', Post: 'white' });
    });

    it('ignores context callbacks from a renderer superseded by a newer schema render', async () => {
        const schemaRef = { current: { tables: [{ name: 'User' }] } };
        const erdContextRef = { current: { tablePositions: { User: { x: 40, y: 50 } } } };
        const hook = renderHook(() =>
            usePrismaErdRendering({
                theme: 'light',
                schemaRef,
                erdContextRef,
                isCanvasReady: true,
                autoColorOnFirstRender: false,
            }),
        );

        await waitFor(() => expect(runErdScript).toHaveBeenCalledTimes(1));
        const staleContextChange = runErdScript.mock.calls[0][1].onContextChange;

        act(() => hook.result.current.setFlag((value) => value + 1));
        await waitFor(() => expect(runErdScript).toHaveBeenCalledTimes(2));
        const currentContextChange = runErdScript.mock.calls[1][1].onContextChange;

        act(() => staleContextChange({ tablePositions: { User: { x: 900, y: 900 } } }));
        expect(erdContextRef.current.tablePositions.User).toEqual({ x: 40, y: 50 });

        act(() => currentContextChange({ tablePositions: { User: { x: 80, y: 90 } } }));
        expect(erdContextRef.current.tablePositions.User).toEqual({ x: 80, y: 90 });
    });

    it('shows Prisma table header tools by default and lets the gear toggle switch to hover-only', async () => {
        const schemaRef = { current: { tables: [{ name: 'User' }] } };
        const erdContextRef = { current: { tableColors: {}, tablePositions: {} } };

        const hook = renderHook(() =>
            usePrismaErdRendering({
                theme: 'dark',
                schemaRef,
                erdContextRef,
                isCanvasReady: true,
            }),
        );

        await waitFor(() => expect(runErdScript).toHaveBeenCalledTimes(1));
        expect(hook.result.current.headerActionsAlwaysVisible).toBe(true);
        expect(runErdScript.mock.calls[0][1]).toEqual(expect.objectContaining({ headerActionsAlwaysVisible: true }));

        act(() => hook.result.current.setHeaderActionsAlwaysVisible(false));

        await waitFor(() => expect(runErdScript).toHaveBeenCalledTimes(2));
        expect(hook.result.current.headerActionsAlwaysVisible).toBe(false);
        expect(erdContextRef.current.headerActionsAlwaysVisible).toBe(false);
        expect(runErdScript.mock.calls[1][1]).toEqual(expect.objectContaining({ headerActionsAlwaysVisible: false }));

        act(() => {
            runErdScript.mock.calls[1][1].onContextChange({
                tablePositions: { User: { x: 100, y: 120 } },
                selectedNodeName: 'User',
            });
        });

        expect(erdContextRef.current).toEqual(
            expect.objectContaining({
                headerActionsAlwaysVisible: false,
                selectedNodeName: 'User',
                tablePositions: { User: { x: 100, y: 120 } },
            }),
        );
    });

    it('restores Prisma hover-only header tools from saved ERD context', async () => {
        const schemaRef = { current: { tables: [{ name: 'User' }] } };
        const erdContextRef = {
            current: {
                tableColors: {},
                tablePositions: {},
                headerActionsAlwaysVisible: false,
            },
        };

        const hook = renderHook(() =>
            usePrismaErdRendering({
                theme: 'light',
                schemaRef,
                erdContextRef,
                isCanvasReady: true,
                initialHeaderActionsAlwaysVisible: false,
            }),
        );

        await waitFor(() => expect(runErdScript).toHaveBeenCalledTimes(1));
        expect(hook.result.current.headerActionsAlwaysVisible).toBe(false);
        expect(runErdScript.mock.calls[0][1]).toEqual(expect.objectContaining({ headerActionsAlwaysVisible: false }));
    });

    it('removes only the degenerate Prisma implicit self many-to-many edge from the render clone', () => {
        const collapsedPrismaSelfRelation = {
            from: { table: 'User', column: 'id' },
            to: { table: 'User', column: 'id' },
            prisma: { kind: 'implicit-many-to-many', relationName: 'UserFollows' },
        };
        const sqlStyleSelfForeignKey = {
            from: { table: 'Node', column: 'parentId' },
            to: { table: 'Node', column: 'id' },
        };
        const explicitPrismaSelfRelation = {
            from: { table: 'User', column: 'managerId' },
            to: { table: 'User', column: 'id' },
            prisma: { kind: 'explicit' },
        };
        const schema = {
            tables: [],
            relations: [collapsedPrismaSelfRelation, sqlStyleSelfForeignKey, explicitPrismaSelfRelation],
        };

        const renderSchema = createPrismaRenderSchema(schema);

        expect(renderSchema).not.toBe(schema);
        expect(renderSchema.relations).toEqual([sqlStyleSelfForeignKey, explicitPrismaSelfRelation]);
        expect(schema.relations).toEqual([collapsedPrismaSelfRelation, sqlStyleSelfForeignKey, explicitPrismaSelfRelation]);
    });
});
