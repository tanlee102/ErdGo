import { describe, expect, it, vi } from 'vitest';
import { drawCanvasText } from '@/lib/erd-renderer/canvasText.js';

function textContext(transform, font = '14px sans-serif') {
    return {
        font,
        textAlign: 'right',
        textBaseline: 'middle',
        globalAlpha: 0.35,
        getTransform: () => transform,
        setTransform: vi.fn(),
        fillText: vi.fn(function (text, x, y) {
            this.paintedFont = this.font;
            this.paintedText = { text, x, y };
        }),
    };
}

describe('canvas text rasterization', () => {
    it.each([1, 1.25, 1.5, 2, 3])('paints at the physical font size at DPR %s without changing world geometry', (dpr) => {
        const zoom = 0.65 * dpr;
        const transform = { a: zoom, b: 0, c: 0, d: zoom, e: 10.3 * dpr, f: 15.7 * dpr };
        const ctx = textContext(transform);
        drawCanvasText(ctx, 'customer_id', 42.25, 33.5);
        expect(ctx.paintedFont).toBe(`${14 * zoom}px sans-serif`);
        expect(ctx.paintedText).toEqual({ text: 'customer_id', x: Math.round(42.25 * zoom + transform.e), y: Math.round(33.5 * zoom + transform.f) });
        expect(ctx.setTransform.mock.calls).toEqual([[1, 0, 0, 1, 0, 0], [zoom, 0, 0, zoom, transform.e, transform.f]]);
        expect(ctx.font).toBe('14px sans-serif');
        expect(ctx.textAlign).toBe('right');
        expect(ctx.textBaseline).toBe('middle');
        expect(ctx.globalAlpha).toBe(0.35);
    });

    it('retains weight and font family for headers, badges and monospace notes', () => {
        const ctx = textContext({ a: 0.5, b: 0, c: 0, d: 0.5, e: 0, f: 0 }, '700 12px monospace');
        drawCanvasText(ctx, 'PK', 20, 20);
        expect(ctx.paintedFont).toBe('700 6px monospace');
        expect(ctx.font).toBe('700 12px monospace');
    });

    it.each([
        { a: 1, b: 1, c: 0, d: 1, e: 0, f: 0 },
        { a: 1, b: 0, c: 0, d: 2, e: 0, f: 0 },
        { a: -1, b: 0, c: 0, d: -1, e: 0, f: 0 },
    ])('leaves unsupported transforms on the browser native path', (transform) => {
        const ctx = textContext(transform);
        drawCanvasText(ctx, 'label', 10.5, 22.3);
        expect(ctx.setTransform).not.toHaveBeenCalled();
        expect(ctx.fillText).toHaveBeenCalledWith('label', 10.5, 22.3);
    });

    it('restores the drawing state even if text drawing throws', () => {
        const ctx = textContext({ a: 2, b: 0, c: 0, d: 2, e: 5, f: 7 });
        ctx.fillText.mockImplementation(() => { throw new Error('context lost'); });
        expect(() => drawCanvasText(ctx, 'label', 1, 2)).toThrow('context lost');
        expect(ctx.font).toBe('14px sans-serif');
        expect(ctx.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 5, 7);
    });
});
