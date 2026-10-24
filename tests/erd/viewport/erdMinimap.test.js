/** Verifies world/minimap coordinate transforms and pan updates. */
import { describe, expect, it } from 'vitest';
import {
    calculateErdMinimapModel,
    erdMinimapPointToWorld,
    getErdMinimapPanUpdate,
    getErdViewportWorldRect,
} from '@/lib/erdMinimap.js';

const tables = [
    { name: 'users', x: 100, y: 100, width: 200, height: 120 },
    { name: 'orders', x: 700, y: 400, width: 240, height: 180 },
];

describe('ERD minimap geometry', () => {
    it('projects optional group frames without treating them as tables', () => {
        const group = { id: 'sales', color: '#299a92', x: 410, y: 249, width: 868, height: 530 };
        const model = calculateErdMinimapModel({ tables, groups: [group], width: 300, height: 180 });
        expect(model.tableRects).toHaveLength(2);
        expect(model.groupRects).toEqual([{ id: 'sales', color: '#299a92', x: -24 * model.scale + model.offsetX, y: -16 * model.scale + model.offsetY, width: 868 * model.scale, height: 530 * model.scale }]);
        expect(model.worldBounds).toMatchObject({ minX: -24, minY: -16, maxX: 844, maxY: 514 });
        expect(calculateErdMinimapModel({ tables, width: 300, height: 180 })).toEqual(calculateErdMinimapModel({ tables, groups: [], width: 300, height: 180 }));
    });
    it('projects diagram bounds into a centered, padded minimap', () => {
        const viewport = getErdViewportWorldRect({
            zoom: 2,
            offsetX: -100,
            offsetY: -200,
            viewportWidth: 1000,
            viewportHeight: 600,
        });
        const model = calculateErdMinimapModel({ tables, viewport, width: 300, height: 180, padding: 12 });

        expect(viewport).toEqual({ x: 50, y: 100, width: 500, height: 300 });
        expect(model.tableRects).toHaveLength(2);
        expect(model.scale).toBeGreaterThan(0);
        expect(model.worldBounds).toEqual(expect.objectContaining({ minX: 0, minY: 40, maxX: 820, maxY: 490 }));
        expect(model.viewport).toEqual(expect.objectContaining({ width: 500 * model.scale, height: 300 * model.scale }));
    });

    it('round-trips projected points without coordinate drift', () => {
        const model = calculateErdMinimapModel({ tables, width: 260, height: 150, padding: 10 });
        const worldPoint = { x: 430, y: 275 };
        const mapPoint = {
            x: worldPoint.x * model.scale + model.offsetX,
            y: worldPoint.y * model.scale + model.offsetY,
        };

        const roundTrip = erdMinimapPointToWorld(model, mapPoint.x, mapPoint.y);
        expect(roundTrip.x).toBeCloseTo(worldPoint.x, 12);
        expect(roundTrip.y).toBeCloseTo(worldPoint.y, 12);
    });

    it('centers the main viewport on a minimap click', () => {
        const model = calculateErdMinimapModel({ tables, width: 300, height: 180, padding: 12 });
        const targetWorld = { x: 700, y: 400 };
        const update = getErdMinimapPanUpdate({
            model,
            mapX: targetWorld.x * model.scale + model.offsetX,
            mapY: targetWorld.y * model.scale + model.offsetY,
            zoom: 2,
            viewportWidth: 800,
            viewportHeight: 500,
        });

        expect(update.offsetX).toBeCloseTo(-1000, 12);
        expect(update.offsetY).toBeCloseTo(-550, 12);
        expect(-update.offsetX / 2 + 800 / 2 / 2).toBeCloseTo(targetWorld.x, 12);
        expect(-update.offsetY / 2 + 500 / 2 / 2).toBeCloseTo(targetWorld.y, 12);
    });

    it('preserves the grabbed point while dragging the viewport rectangle', () => {
        const model = calculateErdMinimapModel({ tables, width: 300, height: 180, padding: 12 });
        const pointerWorld = { x: 600, y: 350 };
        const update = getErdMinimapPanUpdate({
            model,
            mapX: pointerWorld.x * model.scale + model.offsetX,
            mapY: pointerWorld.y * model.scale + model.offsetY,
            zoom: 1.5,
            viewportWidth: 900,
            viewportHeight: 600,
            grabOffsetX: 125,
            grabOffsetY: 80,
        });

        expect(-update.offsetX / 1.5).toBeCloseTo(pointerWorld.x - 125, 12);
        expect(-update.offsetY / 1.5).toBeCloseTo(pointerWorld.y - 80, 12);
    });

    it('rejects invalid or empty geometry', () => {
        expect(calculateErdMinimapModel({ tables: [], width: 300, height: 180 })).toBeNull();
        expect(calculateErdMinimapModel({ tables, width: 0, height: 180 })).toBeNull();
        expect(getErdViewportWorldRect({ zoom: 0, offsetX: 0, offsetY: 0, viewportWidth: 100, viewportHeight: 100 })).toBeNull();
        expect(getErdMinimapPanUpdate({ model: null, mapX: 0, mapY: 0, zoom: 1, viewportWidth: 100, viewportHeight: 100 })).toBeNull();
    });
});
