// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTableGroupInteraction } from '@/lib/erd-renderer/tableGroupInteraction.js';

describe('table group pointer lifetime', () => {
    let canvas, tables, interaction, active, onCommit, onEdit, onPreview;
    const pointer = (target, type, x, y, extras = {}) => {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
        Object.defineProperties(event, { pointerId: { value: extras.pointerId || 1 }, isPrimary: { value: extras.isPrimary !== false } });
        target.dispatchEvent(event);
    };
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('requestAnimationFrame', callback => setTimeout(callback, 16));
        vi.stubGlobal('cancelAnimationFrame', clearTimeout);
        canvas = document.createElement('canvas');
        document.body.append(canvas);
        tables = [{ name: 'a', x: 100, y: 100, width: 80, height: 80 }, { name: 'b', x: 220, y: 120, width: 80, height: 80 }, { name: 'other', x: 400, y: 100, width: 80, height: 80 }];
        active = true;
        onCommit = vi.fn(); onEdit = vi.fn(); onPreview = vi.fn();
        interaction = createTableGroupInteraction({ canvas, getFrames: () => [{ id: 'g', tableNames: ['a', 'b'], x: 160, y: 90, width: 248, height: 188 }], getTables: () => tables, screenToWorld: (x, y) => ({ x: x / 2, y: y / 2 }), isActive: () => active, onPreview, onCommit, onEdit });
    });
    afterEach(() => { interaction.dispose(); canvas.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

    it('coalesces previews and commits both members once using the world camera', () => {
        pointer(canvas, 'pointerdown', 200, 10);
        pointer(window, 'pointermove', 230, 50);
        pointer(window, 'pointermove', 260, 70);
        expect(tables[0].x).toBe(100);
        vi.advanceTimersByTime(16);
        expect(tables.map(({ x, y }) => [x, y])).toEqual([[130, 130], [250, 150], [400, 100]]);
        expect(onCommit).not.toHaveBeenCalled();
        pointer(window, 'pointerup', 280, 90);
        expect(onCommit).toHaveBeenCalledExactlyOnceWith({ a: { x: 140, y: 140 }, b: { x: 260, y: 160 } });
        expect(onEdit).not.toHaveBeenCalled();
    });

    it.each(['Escape', 'blur', 'pointercancel', 'dispose', 'replacement', 'resize', 'wheel', 'second finger'])('restores every preview and removes listeners after %s', reason => {
        pointer(canvas, 'pointerdown', 200, 10);
        pointer(window, 'pointermove', 280, 90);
        vi.advanceTimersByTime(16);
        if (reason === 'Escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        else if (reason === 'dispose') interaction.dispose();
        else if (reason === 'replacement') { active = false; pointer(window, 'pointerup', 280, 90); }
        else if (reason === 'second finger') pointer(canvas, 'pointerdown', 200, 10, { pointerId: 2, isPrimary: false });
        else if (reason === 'wheel') canvas.dispatchEvent(new WheelEvent('wheel'));
        else window.dispatchEvent(new Event(reason));
        expect(tables.map(({ x, y }) => [x, y])).toEqual([[100, 100], [220, 120], [400, 100]]);
        pointer(window, 'pointermove', 400, 400);
        vi.runAllTimers();
        expect(onCommit).not.toHaveBeenCalled();
        expect(onEdit).not.toHaveBeenCalled();
        expect(canvas.style.cursor).toBe('default');
    });

    it('opens group editing on a click and leaves table/body gestures untouched', () => {
        pointer(canvas, 'pointerdown', 200, 10);
        pointer(window, 'pointerup', 200, 10);
        expect(onEdit).toHaveBeenCalledExactlyOnceWith('g');
        onEdit.mockClear();
        pointer(canvas, 'pointerdown', 200, 200);
        pointer(window, 'pointerup', 200, 200);
        expect(onEdit).not.toHaveBeenCalled();
        expect(onCommit).not.toHaveBeenCalled();
    });

    it('cancels a queued preview before its frame and suppresses compatibility mouse input', () => {
        const legacy = vi.fn();
        canvas.addEventListener('mousedown', legacy);
        pointer(canvas, 'pointerdown', 200, 10);
        canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        pointer(window, 'pointermove', 280, 90);
        interaction.cancel();
        vi.runAllTimers();
        expect(legacy).not.toHaveBeenCalled();
        expect(tables[0]).toMatchObject({ x: 100, y: 100 });
        expect(onCommit).not.toHaveBeenCalled();
    });
});
