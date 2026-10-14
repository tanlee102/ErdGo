import { describe, expect, it } from 'vitest';
import {
    calculateEditableConnectorRoute,
    chooseConnectorSideFromPointer,
    getAutomaticConnectorSides,
    getConnectorRelationKey,
    normalizeConnectorEndpointSides,
} from '@/lib/genErdScript.js';

const LEFT_TABLE = { name: 'orders', x: 100, y: 180, width: 160, height: 180 };
const RIGHT_TABLE = { name: 'customers', x: 500, y: 180, width: 180, height: 220 };

function route(overrides = {}) {
    return calculateEditableConnectorRoute({
        fromTable: LEFT_TABLE,
        toTable: RIGHT_TABLE,
        fromY: 170,
        toY: 210,
        fromSide: 'right',
        toSide: 'left',
        connectorOffset: 24,
        headClearance: 38,
        ...overrides,
    });
}

function tableBounds(table) {
    return {
        left: table.x - table.width / 2,
        right: table.x + table.width / 2,
        top: table.y - table.height / 2,
        bottom: table.y + table.height / 2,
    };
}

function segmentCrossesTableInterior(start, end, table) {
    const bounds = tableBounds(table);
    const epsilon = 0.000001;
    if (Math.abs(start.y - end.y) <= epsilon) {
        return (
            start.y > bounds.top + epsilon &&
            start.y < bounds.bottom - epsilon &&
            Math.max(Math.min(start.x, end.x), bounds.left) < Math.min(Math.max(start.x, end.x), bounds.right) - epsilon
        );
    }
    if (Math.abs(start.x - end.x) <= epsilon) {
        return (
            start.x > bounds.left + epsilon &&
            start.x < bounds.right - epsilon &&
            Math.max(Math.min(start.y, end.y), bounds.top) < Math.min(Math.max(start.y, end.y), bounds.bottom) - epsilon
        );
    }
    return true;
}

function expectValidRoute(points, fromTable, toTable, fromSide, toSide, { checkCollisions = true, minimumHeadLength = 0 } = {}) {
    expect(points.length).toBeGreaterThanOrEqual(2);
    expect(points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
    expect(Math.sign(points[1].x - points[0].x)).toBe(fromSide === 'left' ? -1 : 1);
    expect(Math.sign(points.at(-2).x - points.at(-1).x)).toBe(toSide === 'left' ? -1 : 1);
    expect(Math.abs(points[1].x - points[0].x)).toBeGreaterThanOrEqual(minimumHeadLength);
    expect(Math.abs(points.at(-2).x - points.at(-1).x)).toBeGreaterThanOrEqual(minimumHeadLength);

    for (let index = 1; index < points.length; index += 1) {
        const start = points[index - 1];
        const end = points[index];
        expect(start.x === end.x || start.y === end.y).toBe(true);
        expect(start.x === end.x && start.y === end.y).toBe(false);
        if (checkCollisions) {
            expect(segmentCrossesTableInterior(start, end, fromTable)).toBe(false);
            expect(segmentCrossesTableInterior(start, end, toTable)).toBe(false);
        }
    }
}

describe('editable ERD connector routing', () => {
    it('creates a stable relation key and includes a constraint name when available', () => {
        expect(
            getConnectorRelationKey({
                from: { table: 'orders', column: 'customer_id' },
                to: { table: 'customers', column: 'id' },
                constraintName: 'fk_orders_customer',
            }),
        ).toBe('orders.customer_id->customers.id|fk_orders_customer');
    });

    it('normalizes sparse persisted endpoint overrides and rejects corrupt values', () => {
        expect(
            normalizeConnectorEndpointSides({
                relationA: { from: ' LEFT ', to: 'right' },
                relationB: { from: 'top', to: 'bottom' },
                relationC: null,
            }),
        ).toEqual({ relationA: { from: 'left', to: 'right' } });
    });

    it('automatically chooses the facing table edges when tables are separated', () => {
        expect(getAutomaticConnectorSides(LEFT_TABLE, RIGHT_TABLE, { overlapPadding: 40 })).toEqual({ from: 'right', to: 'left' });
        expect(getAutomaticConnectorSides(RIGHT_TABLE, LEFT_TABLE, { overlapPadding: 40 })).toEqual({ from: 'left', to: 'right' });
    });

    it('keeps both endpoints on a common outside edge when tables overlap horizontally', () => {
        const lowerTable = { ...RIGHT_TABLE, x: 150, y: 520 };
        expect(getAutomaticConnectorSides(LEFT_TABLE, lowerTable, { overlapPadding: 40 })).toEqual({ from: 'right', to: 'right' });
    });

    it('uses hysteresis while dragging so the side does not flicker around the table center', () => {
        expect(chooseConnectorSideFromPointer(87, 100, 'right', 12)).toBe('left');
        expect(chooseConnectorSideFromPointer(113, 100, 'left', 12)).toBe('right');
        expect(chooseConnectorSideFromPointer(101, 100, 'left', 12)).toBe('left');
        expect(chooseConnectorSideFromPointer(99, 100, 'right', 12)).toBe('right');
    });

    it('routes facing endpoints through a vertical channel between tables', () => {
        const result = route();
        const fromRight = LEFT_TABLE.x + LEFT_TABLE.width / 2;
        const toLeft = RIGHT_TABLE.x - RIGHT_TABLE.width / 2;

        expect(result.points[0]).toEqual({ x: fromRight, y: 170 });
        expect(result.points.at(-1)).toEqual({ x: toLeft, y: 210 });
        expect(result.points.slice(1, -1).every((point) => point.x >= fromRight && point.x <= toLeft)).toBe(true);
    });

    it.each([
        ['left', 'left'],
        ['left', 'right'],
        ['right', 'left'],
        ['right', 'right'],
    ])('keeps the first and last segments outward for %s-to-%s routing', (fromSide, toSide) => {
        const result = route({ fromSide, toSide });
        const fromDirection = fromSide === 'left' ? -1 : 1;
        const toDirection = toSide === 'left' ? -1 : 1;

        expect(Math.sign(result.points[1].x - result.points[0].x)).toBe(fromDirection);
        expect(Math.sign(result.points.at(-2).x - result.points.at(-1).x)).toBe(toDirection);
        expect(Math.abs(result.points[1].x - result.points[0].x)).toBeGreaterThanOrEqual(38);
        expect(Math.abs(result.points.at(-2).x - result.points.at(-1).x)).toBeGreaterThanOrEqual(38);
    });

    it('routes same-side endpoints outside both right table edges', () => {
        const result = route({ fromSide: 'right', toSide: 'right' });
        const outsideRight = Math.max(LEFT_TABLE.x + LEFT_TABLE.width / 2, RIGHT_TABLE.x + RIGHT_TABLE.width / 2);

        expect(result.points[0].x).toBe(LEFT_TABLE.x + LEFT_TABLE.width / 2);
        expect(result.points.at(-1).x).toBe(RIGHT_TABLE.x + RIGHT_TABLE.width / 2);
        expect(Math.max(...result.points.slice(1, -1).map((point) => point.x))).toBeGreaterThan(outsideRight);
    });

    it('detours above or below both tables when requested endpoints face away', () => {
        const result = route({ fromSide: 'left', toSide: 'right' });
        const top = Math.min(LEFT_TABLE.y - LEFT_TABLE.height / 2, RIGHT_TABLE.y - RIGHT_TABLE.height / 2);
        const bottom = Math.max(LEFT_TABLE.y + LEFT_TABLE.height / 2, RIGHT_TABLE.y + RIGHT_TABLE.height / 2);
        const horizontalDetour = result.points.filter((point) => point.x !== result.points[0].x && point.x !== result.points.at(-1).x);

        expect(result.points[0].x).toBe(LEFT_TABLE.x - LEFT_TABLE.width / 2);
        expect(result.points.at(-1).x).toBe(RIGHT_TABLE.x + RIGHT_TABLE.width / 2);
        expect(horizontalDetour.some((point) => point.y < top || point.y > bottom)).toBe(true);
    });

    it('uses a compact in-gap bridge when facing cardinality heads overlap', () => {
        const fromTable = { name: 'payments', x: 0, y: 220, width: 200, height: 300 };
        const toTable = { name: 'orders', x: 246, y: 260, width: 160, height: 280 };
        const fromY = 225;
        const toY = 250;
        const result = route({
            fromTable,
            toTable,
            fromY,
            toY,
            fromSide: 'right',
            toSide: 'left',
            parallelIndex: 0,
        });

        expectValidRoute(result.points, fromTable, toTable, 'right', 'left', { minimumHeadLength: 38 });
        expect(Math.min(...result.points.map((point) => point.y))).toBeGreaterThanOrEqual(Math.min(fromY, toY));
        expect(Math.max(...result.points.map((point) => point.y))).toBeLessThanOrEqual(Math.max(fromY, toY));
        expect(Math.min(...result.points.map((point) => point.x))).toBeGreaterThanOrEqual(fromTable.x + fromTable.width / 2);
        expect(Math.max(...result.points.map((point) => point.x))).toBeLessThanOrEqual(toTable.x - toTable.width / 2);
    });

    it('moves a detour onto safe outer rails when a local vertical rail would cross the opposite table', () => {
        const fromTable = { name: 'from', x: -523.265, y: 992.041, width: 495.848, height: 454.646 };
        const toTable = { name: 'to', x: -764.231, y: -944.019, width: 490.921, height: 469.745 };
        const result = route({
            fromTable,
            toTable,
            fromY: 768.251,
            toY: -712.76,
            fromSide: 'left',
            toSide: 'right',
            parallelIndex: 30,
        });

        expectValidRoute(result.points, fromTable, toTable, 'left', 'right');
    });

    it('preserves both straight head clearances when forced sides leave a sub-pixel gap', () => {
        const fromTable = { name: 'from', x: -838.8287, y: -411.0188, width: 425.1883, height: 428.9114 };
        const toTable = { name: 'to', x: -594.2431, y: -735.8304, width: 62.5576, height: 491.0191 };
        const result = route({
            fromTable,
            toTable,
            fromY: -580.655,
            toY: -679.5043,
            fromSide: 'right',
            toSide: 'left',
            parallelIndex: 18,
        });

        // A collision-free route is mathematically impossible for these
        // manually forced sides, but cardinality head clearance still wins.
        expectValidRoute(result.points, fromTable, toTable, 'right', 'left', {
            checkCollisions: false,
            minimumHeadLength: 38,
        });
    });

    it('preserves the routing invariants across seeded randomized layouts', () => {
        let seed = 0x5eed1234;
        const random = () => {
            seed = (1664525 * seed + 1013904223) >>> 0;
            return seed / 0x100000000;
        };
        const between = (minimum, maximum) => minimum + random() * (maximum - minimum);
        const overlapsWithRoutingClearance = (leftTable, rightTable) => {
            const left = tableBounds(leftTable);
            const right = tableBounds(rightTable);
            const clearance = 64;
            return left.left - clearance < right.right + clearance && left.right + clearance > right.left - clearance && left.top - clearance < right.bottom + clearance && left.bottom + clearance > right.top - clearance;
        };

        for (let layout = 0; layout < 500; layout += 1) {
            const fromTable = {
                name: `from-${layout}`,
                x: between(-1200, 1200),
                y: between(-1200, 1200),
                width: between(60, 520),
                height: between(70, 500),
            };
            let toTable;
            do {
                toTable = {
                    name: `to-${layout}`,
                    x: between(-1200, 1200),
                    y: between(-1200, 1200),
                    width: between(60, 520),
                    height: between(70, 500),
                };
            } while (overlapsWithRoutingClearance(fromTable, toTable));

            const fromY = between(fromTable.y - fromTable.height / 2 + 0.01, fromTable.y + fromTable.height / 2 - 0.01);
            const toY = between(toTable.y - toTable.height / 2 + 0.01, toTable.y + toTable.height / 2 - 0.01);
            for (const fromSide of ['left', 'right']) {
                for (const toSide of ['left', 'right']) {
                    const result = route({
                        fromTable,
                        toTable,
                        fromY,
                        toY,
                        fromSide,
                        toSide,
                        connectorOffset: between(8, 60),
                        parallelIndex: Math.floor(between(0, 31)),
                    });
                    expectValidRoute(result.points, fromTable, toTable, fromSide, toSide, { minimumHeadLength: 8 });
                }
            }
        }
    });

    it('keeps forced self-reference sides outside the table rectangle', () => {
        const result = route({
            fromTable: LEFT_TABLE,
            toTable: LEFT_TABLE,
            fromY: 150,
            toY: 220,
            fromSide: 'left',
            toSide: 'right',
        });
        const left = LEFT_TABLE.x - LEFT_TABLE.width / 2;
        const right = LEFT_TABLE.x + LEFT_TABLE.width / 2;
        const top = LEFT_TABLE.y - LEFT_TABLE.height / 2;
        const bottom = LEFT_TABLE.y + LEFT_TABLE.height / 2;

        expect(result.points[0].x).toBe(left);
        expect(result.points.at(-1).x).toBe(right);
        expect(result.points.some((point) => point.y < top || point.y > bottom)).toBe(true);
    });
});
