import { describe, expect, it } from 'vitest';
import { getErdExportBounds } from '../../../src/lib/erd-renderer/exportGeometry.js';

describe('optional entire-diagram capture bounds', () => {
    it('includes all table corners and external connector bends with padding', () => {
        const tables = [{ x: -500, y: 200, width: 300, height: 400 }, { x: 1000, y: -300, width: 240, height: 200 }];
        const connectors = [{ points: [{ x: -900, y: -600 }, { x: 1300, y: 700 }] }];
        const before = JSON.stringify({ tables, connectors });
        expect(getErdExportBounds(tables, connectors)).toEqual({ x: -964, y: -664, width: 2328, height: 1428 });
        expect(JSON.stringify({ tables, connectors })).toBe(before);
    });
    it('keeps tall and wide diagrams in their natural proportions', () => {
        expect(getErdExportBounds([{ x: 0, y: 0, width: 300, height: 2000 }])).toMatchObject({ width: 428, height: 2128 });
        expect(getErdExportBounds([{ x: 0, y: 0, width: 2000, height: 300 }])).toMatchObject({ width: 2128, height: 428 });
    });
    it('handles empty diagrams and ignores invalid connector points', () => {
        expect(getErdExportBounds([])).toBeNull();
        expect(getErdExportBounds([{ x: 0, y: 0, width: 100, height: 100 }], [{ points: [null, { x: NaN, y: 0 }] }])).toEqual({ x: -114, y: -114, width: 228, height: 228 });
    });
    it('includes optional group headers and leaves legacy bounds unchanged without groups', () => {
        const tables = [{ x: 0, y: 0, width: 100, height: 100 }];
        const groups = [{ x: 0, y: -16, width: 160, height: 180 }];
        expect(getErdExportBounds(tables, [], groups)).toEqual({ x: -144, y: -170, width: 288, height: 308 });
        expect(getErdExportBounds(tables)).toEqual(getErdExportBounds(tables, [], []));
    });
});
