/** Verifies free-form ERD connector geometry independently of React Flow rendering. */
import { describe, expect, it } from 'vitest';
import {
    closestConnectorPosition,
    connectorControlFromPoint,
    draftLabelWidthRatio,
    draftNodeSize,
    findOpenNodePosition,
    pointOnConnector,
    resolveConnectorControl,
    resolveConnectorLabel,
} from '@/features/erd-draft/lib/erdDraftGeometry.js';

function expectPoint(actual, expected, precision = 5) {
    expect(actual.x).toBeCloseTo(expected.x, precision);
    expect(actual.y).toBeCloseTo(expected.y, precision);
}

describe('ERD Builder connector geometry', () => {
    it('places beyond occupied space when the nearby insertion search is exhausted', () => {
        const occupied = [{ x: -2000, y: -2000, width: 10000, height: 10000 }];
        const position = findOpenNodePosition({ x: 0, y: 0 }, { width: 180, height: 92 }, occupied);
        expect(position.x).toBeGreaterThanOrEqual(8024);
    });
    it('grows nodes deterministically to contain long and multiline labels', () => {
        const shortEntity = draftNodeSize('entity', 1, 'Customer');
        const longEntity = draftNodeSize('entity', 1, 'Customer account holder with a deliberately long business label');
        const multilineNote = draftNodeSize('note', 1, 'First\nSecond\nThird\nFourth\nFifth\nSixth');
        const scaledCategory = draftNodeSize('category', 1.5, 'A long union category name');

        expect(longEntity.height).toBeGreaterThan(shortEntity.height);
        expect(multilineNote.height).toBeGreaterThan(draftNodeSize('note', 1, 'Short note').height);
        expect(scaledCategory.width).toBeGreaterThan(draftNodeSize('category', 1, 'Category').width);
        expect(scaledCategory.height).toBeGreaterThan(draftNodeSize('category', 1, 'Category').height);
    });

    it('fits dense labels with independent width and height growth', () => {
        const shapes = [
            'entity', 'weakEntity', 'relationship', 'identifyingRelationship',
            'attribute', 'keyAttribute', 'partialKeyAttribute', 'multivaluedAttribute',
            'derivedAttribute', 'compositeAttribute', 'isa', 'category', 'aggregation', 'note',
        ];
        const denseLabel = 'A deliberately detailed multiline business concept that must remain readable\nwith every word contained inside its Chen notation shape and no clipped rows';

        shapes.forEach((shape) => {
            const base = draftNodeSize(shape, 1, 'Short');
            const dense = draftNodeSize(shape, 1, denseLabel);
            const largeText = draftNodeSize(shape, 1, denseLabel, 1.8);

            expect(dense.width, `${shape} width`).toBeGreaterThanOrEqual(base.width);
            expect(dense.height, `${shape} height`).toBeGreaterThan(base.height);
            expect(largeText.width, `${shape} large-text width`).toBeGreaterThanOrEqual(dense.width);
            expect(largeText.height, `${shape} large-text height`).toBeGreaterThanOrEqual(dense.height);
            if (shape === 'category') {
                expect(dense.width - dense.height).toBe(46);
            }
        });
    });

    it('uses existing inner space before making a small multiline label larger', () => {
        const category = draftNodeSize('category', 1, 'my text\nsecond line');
        const isa = draftNodeSize('isa', 1, 'my text\nsecond line');
        const relationship = draftNodeSize('relationship', 1, 'first\nsecond\nthird');

        expect(category).toEqual(draftNodeSize('category', 1, 'Category'));
        expect(isa).toEqual(draftNodeSize('isa', 1, 'ISA'));
        expect(relationship.width).toBe(148);
        expect(relationship.height).toBeGreaterThan(116);
        expect(relationship.height).toBeLessThan(160);
    });

    it('widens every Chen shape instead of splitting a complete long word', () => {
        const shapes = [
            'entity', 'weakEntity', 'relationship', 'identifyingRelationship',
            'attribute', 'keyAttribute', 'partialKeyAttribute', 'multivaluedAttribute',
            'derivedAttribute', 'compositeAttribute', 'isa', 'category', 'aggregation', 'note',
        ];
        const completeWord = 'CustomerAccountAuthorizationResponsibilityIdentifier';

        shapes.forEach((shape) => {
            const base = draftNodeSize(shape, 1, 'Short');
            const completeWordSize = draftNodeSize(shape, 1, completeWord);

            expect(completeWordSize.width, `${shape} complete-word width`).toBeGreaterThan(base.width);
            expect(Number.isFinite(completeWordSize.height), `${shape} complete-word height`).toBe(true);
            if (shape !== 'category') {
                expect(completeWordSize.height, `${shape} complete-word height`).toBe(base.height);
            }
        });
    });

    it('uses more of a constrained shape only when a complete word needs it', () => {
        const shortRelationshipRatio = draftLabelWidthRatio('relationship', 'Owns');
        const longRelationshipRatio = draftLabelWidthRatio('relationship', 'CustomerAccountAuthorizationResponsibilityIdentifier');
        const shortAttributeRatio = draftLabelWidthRatio('attribute', 'Email');
        const longAttributeRatio = draftLabelWidthRatio('attribute', 'CustomerAccountAuthorizationResponsibilityIdentifier');

        expect(shortRelationshipRatio).toBe(0.58);
        expect(longRelationshipRatio).toBe(0.76);
        expect(shortAttributeRatio).toBe(0.76);
        expect(longAttributeRatio).toBe(0.86);
    });

    it('cascades keyboard-added shapes around occupied canvas space', () => {
        const origin = { x: 100, y: 100 };
        const size = { width: 180, height: 92 };
        const occupied = [{ ...origin, ...size }];

        expect(findOpenNodePosition(origin, size, [])).toEqual(origin);
        expect(findOpenNodePosition(origin, size, occupied)).toEqual({ x: 310, y: 100 });
        expect(findOpenNodePosition(origin, size, [
            ...occupied,
            { x: 310, y: 100, ...size },
        ])).toEqual({ x: -110, y: 100 });
    });

    it('keeps labels attached by progress and perpendicular offset', () => {
        const relative = { t: 0.2, offset: 15 };
        const horizontal = resolveConnectorLabel(relative, 0.08, { x: 0, y: 0 }, { x: 100, y: 0 }, null);
        const translated = resolveConnectorLabel(relative, 0.08, { x: 50, y: 40 }, { x: 150, y: 40 }, null);
        const rotated = resolveConnectorLabel(relative, 0.08, { x: 0, y: 0 }, { x: 0, y: 100 }, null);

        expectPoint(horizontal.point, { x: 20, y: 15 });
        expectPoint(translated.point, { x: 70, y: 55 });
        expectPoint(rotated.point, { x: -15, y: 20 });
    });

    it('round-trips a freely dragged label on a quadratic connector', () => {
        const start = { x: 10, y: 20 };
        const end = { x: 210, y: 80 };
        const control = { x: 90, y: 190 };
        const original = resolveConnectorLabel({ t: 0.73, offset: -24 }, 0.92, start, end, control);
        const projected = closestConnectorPosition(original.point, start, end, control);
        const restored = resolveConnectorLabel(projected, 0.92, start, end, control);

        expect(projected.t).toBeCloseTo(0.73, 2);
        expect(projected.offset).toBeCloseTo(-24, 1);
        expectPoint(restored.point, original.point, 1);
    });

    it('migrates legacy absolute label coordinates to connector-relative coordinates', () => {
        const migrated = resolveConnectorLabel({ x: 30, y: 12 }, 0.08, { x: 0, y: 0 }, { x: 100, y: 0 }, null);

        expect(migrated.relative).toEqual({ t: 0.3, offset: 12 });
        expectPoint(migrated.point, { x: 30, y: 12 });
    });

    it('keeps a curved connector control point relative when endpoints move', () => {
        const relative = connectorControlFromPoint({ x: 50, y: 40 }, { x: 0, y: 0 }, { x: 100, y: 0 });
        const translated = resolveConnectorControl(relative, { x: 25, y: 30 }, { x: 125, y: 30 });
        const rotated = resolveConnectorControl(relative, { x: 0, y: 0 }, { x: 0, y: 100 });

        expect(relative).toEqual({ t: 0.5, offset: 40 });
        expectPoint(translated.point, { x: 75, y: 70 });
        expectPoint(rotated.point, { x: -40, y: 50 });
    });

    it('places the center label on the rendered Bézier curve, not at its control point', () => {
        const midpoint = pointOnConnector({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 }, 0.5);

        expectPoint(midpoint, { x: 50, y: 50 });
    });

    it('returns finite positions for overlapping endpoints', () => {
        const point = { x: 20, y: 30 };
        const relative = closestConnectorPosition(point, point, point, null);
        const resolved = resolveConnectorLabel(relative, 0.5, point, point, null);

        expect(relative.t).toBe(0.5);
        expect(Number.isFinite(relative.offset)).toBe(true);
        expect(Number.isFinite(resolved.point.x)).toBe(true);
        expect(Number.isFinite(resolved.point.y)).toBe(true);
    });
});
