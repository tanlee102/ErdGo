/** Verifies ERD bounds, fitting, zooming, and viewport normalization. */
import { describe, it, expect } from 'vitest';
import {
    calculateErdPinchUpdate,
    calculateErdViewportFit,
    calculateErdZoomLimits,
    clampErdZoom,
    getAnchoredZoomUpdate,
} from '@/lib/erdViewport.js';

const largeDiagramTables = [
    { name: 'left_edge', x: 0, y: 0, width: 200, height: 120 },
    { name: 'right_edge', x: 12000, y: 6000, width: 240, height: 180 },
];

describe('erdViewport zoom bounds', () => {
    it('derives a low minZoom for large diagrams before Fit is clicked', () => {
        const limits = calculateErdZoomLimits({
            tables: largeDiagramTables,
            viewportWidth: 1440,
            viewportHeight: 900,
            maxFitZoom: 2,
        });

        expect(limits.minZoom).toBeLessThan(0.5);
        expect(limits.minZoom).toBeCloseTo(0.023188, 5);
    });

    it('uses the same schema-aware minZoom for Fit and normal zoom clamping', () => {
        const fit = calculateErdViewportFit({
            tables: largeDiagramTables,
            viewportWidth: 1440,
            viewportHeight: 900,
            maxFitZoom: 2,
        });
        const clamped = clampErdZoom(0.01, {
            minZoom: fit.minZoom,
            maxZoom: fit.maxZoom,
        });

        expect(fit.zoom).toBeGreaterThan(fit.minZoom);
        expect(clamped).toBe(fit.minZoom);
    });

    it('keeps maxZoom above fit zoom when maxFitZoom is raised', () => {
        const fit = calculateErdViewportFit({
            tables: [{ name: 'tiny', x: 0, y: 0, width: 100, height: 80 }],
            viewportWidth: 4000,
            viewportHeight: 3000,
            maxFitZoom: 10,
        });

        expect(fit.zoom).toBeCloseTo(9.8);
        expect(fit.maxZoom).toBeGreaterThan(fit.zoom);
    });

    it('preserves the anchored world point while changing zoom', () => {
        const update = getAnchoredZoomUpdate({
            anchorX: 800,
            anchorY: 400,
            worldX: 120,
            worldY: -20,
            zoom: 2.5,
        });

        expect(update).toEqual({
            zoom: 2.5,
            offsetX: 500,
            offsetY: 450,
        });
    });

    it('uses the initial pinch distance and preserves the world point below the moving midpoint', () => {
        const update = calculateErdPinchUpdate({
            startDistance: 100,
            currentDistance: 200,
            startZoom: 1.5,
            anchorX: 700,
            anchorY: 420,
            worldX: 200,
            worldY: 100,
            minZoom: 0.2,
            maxZoom: 5,
        });

        expect(update).toEqual({
            zoom: 3,
            offsetX: 100,
            offsetY: 120,
        });
        expect((update.offsetX + 200 * update.zoom)).toBe(700);
        expect((update.offsetY + 100 * update.zoom)).toBe(420);
    });

    it('clamps pinch zoom while retaining two-finger midpoint panning', () => {
        const update = calculateErdPinchUpdate({
            startDistance: 120,
            currentDistance: 1200,
            startZoom: 1,
            anchorX: 360,
            anchorY: 640,
            worldX: 50,
            worldY: 80,
            minZoom: 0.25,
            maxZoom: 2,
        });

        expect(update).toEqual({
            zoom: 2,
            offsetX: 260,
            offsetY: 480,
        });
    });

    it('rejects degenerate pinch geometry', () => {
        expect(calculateErdPinchUpdate({
            startDistance: 0,
            currentDistance: 100,
            startZoom: 1,
            anchorX: 0,
            anchorY: 0,
            worldX: 0,
            worldY: 0,
        })).toBeNull();
        expect(calculateErdPinchUpdate({
            startDistance: 100,
            currentDistance: Number.NaN,
            startZoom: 1,
            anchorX: 0,
            anchorY: 0,
            worldX: 0,
            worldY: 0,
        })).toBeNull();
    });

    it('preserves the pinch focal point across varied distances, positions, and zoom clamps', () => {
        let seed = 0x51f15e;
        const random = () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed / 0x100000000;
        };

        for (let index = 0; index < 500; index += 1) {
            const minZoom = 0.05 + random() * 0.45;
            const maxZoom = minZoom + 0.5 + random() * 7;
            const startZoom = minZoom + random() * (maxZoom - minZoom);
            const startDistance = 8 + random() * 800;
            const currentDistance = 4 + random() * 1600;
            const anchorX = -2000 + random() * 8000;
            const anchorY = -2000 + random() * 8000;
            const worldX = -5000 + random() * 10000;
            const worldY = -5000 + random() * 10000;
            const expectedZoom = Math.min(maxZoom, Math.max(
                minZoom,
                startZoom * (currentDistance / startDistance),
            ));

            const update = calculateErdPinchUpdate({
                startDistance,
                currentDistance,
                startZoom,
                anchorX,
                anchorY,
                worldX,
                worldY,
                minZoom,
                maxZoom,
            });

            expect(update.zoom).toBeCloseTo(expectedZoom, 12);
            expect(update.offsetX + worldX * update.zoom).toBeCloseTo(anchorX, 9);
            expect(update.offsetY + worldY * update.zoom).toBeCloseTo(anchorY, 9);
        }
    });

    it('returns null for empty diagrams or collapsed viewports', () => {
        expect(calculateErdViewportFit({ tables: [], viewportWidth: 1000, viewportHeight: 800 })).toBeNull();
        expect(calculateErdViewportFit({ tables: largeDiagramTables, viewportWidth: 0, viewportHeight: 800 })).toBeNull();
    });
});
