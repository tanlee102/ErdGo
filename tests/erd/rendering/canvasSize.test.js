// @vitest-environment jsdom
/** Only changed physical dimensions may reset a live canvas backing store. */
import { describe, expect, it, vi } from 'vitest';
import { syncCanvasSize } from '@/lib/erd-renderer/canvasSize';

function fixture(width = 320, height = 240) {
    const canvas = document.createElement('canvas');
    const container = { clientWidth: width, clientHeight: height };
    const widthWrite = vi.spyOn(canvas, 'width', 'set');
    const heightWrite = vi.spyOn(canvas, 'height', 'set');
    return { canvas, container, widthWrite, heightWrite };
}

describe('renderer canvas sizing', () => {
    it('keeps a Retina backing store intact when the host did not change', () => {
        const { canvas, container, widthWrite, heightWrite } = fixture();
        expect(syncCanvasSize(canvas, container, 2)).toBe(true);
        expect(canvas.width).toBe(640);
        expect(canvas.height).toBe(480);
        expect(canvas.style.width).toBe('320px');
        expect(canvas.style.height).toBe('240px');
        widthWrite.mockClear(); heightWrite.mockClear();
        expect(syncCanvasSize(canvas, container, 2)).toBe(false);
        expect(widthWrite).not.toHaveBeenCalled();
        expect(heightWrite).not.toHaveBeenCalled();
    });

    it('resets only the width during a horizontal splitter drag', () => {
        const { canvas, container, widthWrite, heightWrite } = fixture();
        syncCanvasSize(canvas, container, 2);
        widthWrite.mockClear(); heightWrite.mockClear();
        container.clientWidth = 500;
        expect(syncCanvasSize(canvas, container, 2)).toBe(true);
        expect(canvas.width).toBe(1000);
        expect(canvas.height).toBe(480);
        expect(widthWrite).toHaveBeenCalledOnce();
        expect(heightWrite).not.toHaveBeenCalled();
    });

    it('handles fractional display density, DPR changes, hidden hosts and restoration', () => {
        const { canvas, container } = fixture(321, 241);
        syncCanvasSize(canvas, container, 1.25);
        expect([canvas.width, canvas.height]).toEqual([401, 301]);
        syncCanvasSize(canvas, container, 2);
        expect([canvas.width, canvas.height]).toEqual([642, 482]);
        container.clientWidth = 0; container.clientHeight = 0;
        syncCanvasSize(canvas, container, 2);
        expect([canvas.width, canvas.height]).toEqual([0, 0]);
        container.clientWidth = 600; container.clientHeight = 400;
        syncCanvasSize(canvas, container, 2);
        expect([canvas.width, canvas.height]).toEqual([1200, 800]);
    });
});
