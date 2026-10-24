// @vitest-environment jsdom
/** Splitter input must coalesce without losing the final width or leaking drag handlers. */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import useSplitter from '@/features/editor/hooks/useSplitter';

for (const [name, usePanelSplitter] of [['SQL', useSplitter]]) {
    describe(`${name} splitter drag`, () => {
        afterEach(() => {
            vi.useRealTimers();
            vi.restoreAllMocks();
            document.body.innerHTML = '';
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        });

        function setup() {
            Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
            document.body.innerHTML = '<div class="workspace"><div class="sql-panel prisma-erd-source-panel" style="width:40%"></div><div class="panel-splitter"><button class="splitter-toggle-btn prisma-erd-splitter-toggle"><svg><path /></svg></button></div><div class="erd-panel prisma-erd-diagram-panel"></div></div>';
            document.querySelector('.workspace').getBoundingClientRect = () => ({ width: 1000 });
            const frames = new Map();
            let nextFrame = 0;
            const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++nextFrame, callback); return nextFrame; });
            const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => frames.delete(id));
            const hook = renderHook(() => usePanelSplitter({ initialSize: 40 }));
            const divider = document.querySelector('.panel-splitter');
            const panel = document.querySelector('.sql-panel');
            hook.result.current.splitterRef.current = divider;
            const start = () => act(() => hook.result.current.handleSplitterMouseDown({ target: divider, clientX: 400, preventDefault: vi.fn() }));
            const move = x => act(() => document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, buttons: 1 })));
            const flush = () => act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); });
            return { hook, panel, start, move, flush, requestFrame, cancelFrame, frames };
        }

        it('uses the latest pointer once per frame and retains the width after a round trip', () => {
            const { hook, panel, start, move, flush, requestFrame, cancelFrame } = setup();
            start(); move(450); move(500); move(600);
            expect(requestFrame).toHaveBeenCalledOnce();
            expect(cancelFrame).not.toHaveBeenCalled();
            flush();
            expect(panel.style.width).toBe('60%');
            move(400); flush();
            act(() => document.dispatchEvent(new MouseEvent('mouseup', { clientX: 400 })));
            expect(hook.result.current.panelSize).toBe(40);
            expect(hook.result.current.isDragging).toBe(false);
            expect(panel.style.width).toBe('40%');
            hook.unmount();
        });

        it('finishes a drag on blur and restores existing body styles', () => {
            const { hook, panel, start, move, frames } = setup();
            document.body.style.cursor = 'crosshair';
            document.body.style.userSelect = 'text';
            start(); move(650);
            act(() => window.dispatchEvent(new Event('blur')));
            expect(hook.result.current.panelSize).toBe(65);
            expect(hook.result.current.isDragging).toBe(false);
            expect(panel.style.width).toBe('65%');
            expect(frames.size).toBe(0);
            expect(document.body.style.cursor).toBe('crosshair');
            expect(document.body.style.userSelect).toBe('text');
            move(700);
            expect(panel.style.width).toBe('65%');
            hook.unmount();
        });

        it('cancels pending input and listeners when the route unmounts', () => {
            const { hook, panel, start, move, frames, requestFrame, cancelFrame } = setup();
            start(); move(650);
            hook.unmount();
            expect(cancelFrame).toHaveBeenCalledOnce();
            expect(frames.size).toBe(0);
            move(700);
            expect(requestFrame).toHaveBeenCalledOnce();
            expect(panel.style.width).toBe('40%');
            expect(document.body.style.cursor).toBe('');
            expect(document.body.style.userSelect).toBe('');
        });

        it('finishes pending desktop input when resizing into the mobile layout', () => {
            const { hook, start, move, flush, frames } = setup();
            start(); move(650);
            act(() => {
                Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
                window.dispatchEvent(new Event('resize'));
            });
            expect(hook.result.current.isMobile).toBe(true);
            expect(hook.result.current.isDragging).toBe(false);
            expect(frames.size).toBe(0);
            flush(); move(700);
            expect(hook.result.current.panelSize).toBe(65);
            expect(hook.result.current.getPanelStyle(true).width).toBe('100%');
            expect(document.body.style.cursor).toBe('');
            hook.unmount();
        });

        it('ignores unchanged viewport events and recovers a release outside the window', () => {
            const { hook, panel, start, move, frames } = setup();
            start(); move(650);
            act(() => window.dispatchEvent(new Event('resize')));
            expect(hook.result.current.isDragging).toBe(true);
            expect(frames.size).toBe(1);
            act(() => document.dispatchEvent(new MouseEvent('mousemove', { clientX: 900, buttons: 0 })));
            expect(hook.result.current.isDragging).toBe(false);
            expect(hook.result.current.panelSize).toBe(65);
            expect(panel.style.width).toBe('65%');
            expect(frames.size).toBe(0);
            hook.unmount();
        });

        it('does not start a drag from the nested collapse icon', () => {
            const { hook } = setup();
            const preventDefault = vi.fn();
            act(() => hook.result.current.handleSplitterMouseDown({ target: document.querySelector('path'), clientX: 400, preventDefault }));
            expect(preventDefault).not.toHaveBeenCalled();
            expect(hook.result.current.isDragging).toBe(false);
            hook.unmount();
        });

        it('defers the first mobile fit until the ERD remains visible', () => {
            vi.useFakeTimers();
            const { hook } = setup();
            act(() => {
                Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
                window.dispatchEvent(new Event('resize'));
            });
            const forceFit = vi.fn();
            window.addEventListener('erd-force-fit', forceFit);
            try {
                act(() => hook.result.current.toggleCollapse());
                act(() => hook.result.current.toggleCollapse());
                act(() => vi.advanceTimersByTime(151));
                expect(forceFit).not.toHaveBeenCalled();
                expect(hook.result.current.showEditor).toBe(true);
                act(() => hook.result.current.toggleCollapse());
                act(() => vi.advanceTimersByTime(151));
                expect(forceFit).toHaveBeenCalledOnce();
                act(() => hook.result.current.toggleCollapse());
                act(() => hook.result.current.toggleCollapse());
                act(() => vi.advanceTimersByTime(151));
                expect(forceFit).toHaveBeenCalledOnce();
            } finally {
                hook.unmount();
                window.removeEventListener('erd-force-fit', forceFit);
            }
        });
    });
}
