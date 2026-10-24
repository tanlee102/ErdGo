import { describe, expect, it } from 'vitest';
import { isCanvasTableVisible } from '@/lib/erd-renderer/canvasVisibility.js';

const camera = { zoom: 0.5, offsetX: 200, offsetY: 100, width: 800, height: 600 };
const table = { x: 0, y: 0, width: 200, height: 100 };

describe('canvas table paint culling', () => {
    it('keeps partial cards and shadow spill at each viewport edge', () => {
        for (const point of [{ x: -480, y: 0 }, { x: 1280, y: 0 }, { x: 0, y: -280 }, { x: 0, y: 1080 }]) {
            expect(isCanvasTableVisible({ ...table, ...point }, camera)).toBe(true);
        }
    });

    it('skips cards whose complete painted bounds are outside the viewport', () => {
        for (const point of [{ x: -600, y: 0 }, { x: 1400, y: 0 }, { x: 0, y: -400 }, { x: 0, y: 1200 }]) {
            expect(isCanvasTableVisible({ ...table, ...point }, camera)).toBe(false);
        }
    });

    it('uses the target camera for high-resolution and entire-diagram export', () => {
        const farTable = { ...table, x: 10000, y: 10000 };
        expect(isCanvasTableVisible(farTable, camera)).toBe(false);
        expect(isCanvasTableVisible(farTable, { zoom: 4, offsetX: -39000, offsetY: -39000, width: 2000, height: 2000 })).toBe(true);
    });

    it('retains the scaled table border shadow at very high export zoom', () => {
        // The card starts 40 backing pixels beyond the right viewport edge.
        // Its 0.3-world-unit border is 60px wide at this zoom, so the border
        // shadow remains visible inside the image despite the off-screen fill.
        const exportCamera = { zoom: 200, offsetX: 0, offsetY: 0, width: 400, height: 200 };
        expect(isCanvasTableVisible({ x: 7.2, y: 0.5, width: 10, height: 10 }, exportCamera)).toBe(true);
        expect(isCanvasTableVisible({ x: 7.4, y: 0.5, width: 10, height: 10 }, exportCamera)).toBe(false);
    });

    it('keeps column text extending beyond a capped card inside the viewport', () => {
        const viewport = { zoom: 1, offsetX: 0, offsetY: 0, width: 600, height: 400 };
        const outside = { x: -250, y: 100, width: 420, height: 58 };
        expect(isCanvasTableVisible(outside, viewport)).toBe(false);
        expect(isCanvasTableVisible(outside, viewport, 800)).toBe(true);
        expect(isCanvasTableVisible({ ...outside, x: -1800 }, viewport, 800)).toBe(false);
    });

    it('keeps glyph ink extending vertically beyond an off-screen card', () => {
        const viewport = { zoom: 1, offsetX: 0, offsetY: 0, width: 600, height: 400 };
        const outside = { x: 150, y: 469, width: 180, height: 58 };
        expect(isCanvasTableVisible(outside, viewport)).toBe(false);
        expect(isCanvasTableVisible(outside, viewport, 0, 110)).toBe(true);
        expect(isCanvasTableVisible({ ...outside, y: 800 }, viewport, 0, 110)).toBe(false);
    });

    it('fails open for invalid geometry rather than hiding potentially visible content', () => {
        expect(isCanvasTableVisible({ ...table, x: NaN }, camera)).toBe(true);
        expect(isCanvasTableVisible(table, { ...camera, zoom: 0 })).toBe(true);
        expect(isCanvasTableVisible({ ...table, x: 10000 }, camera, NaN)).toBe(true);
        expect(isCanvasTableVisible({ ...table, y: 10000 }, camera, 0, NaN)).toBe(true);
    });
});
