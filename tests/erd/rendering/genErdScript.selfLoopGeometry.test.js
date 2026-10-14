import { describe, expect, it } from 'vitest';
import {
    LAYOUT_MODES,
    analyzeErdLayoutGraph,
    buildGridLayoutPositions,
    calculateSelfReferenceConnectorLoop,
    chooseBestLayoutStrategy,
    composeCanvasAlpha,
    getCenteredCanvasTextBaseline,
    getCanvasColorCss,
    getColorSwatchGroups,
    getColumnHoverTreatment,
    getCompositeConstraintPillColors,
    getConstraintPillTextMode,
    getConstraintPillLayout,
    getInferredRelationVisual,
    getLayoutModeLabel,
    getLivePriorityTableNames,
    measureConstraintPillText,
    getPrimaryCanvasColor,
    getPriorityLayerState,
    getRelationshipFieldKey,
    getSelectedRelationshipFieldKeys,
    getTableConnectorColor,
    getTableHeaderFillStyle,
    getTableHeaderTextColorForMode,
    getToolbarPopupPosition,
    getTableConstraintPillAppearance,
    getTableRelationshipFieldFillColor,
    getTableRowHoverOutlineColor,
    getTableSelectionAccentColor,
    parseGradientColor,
    resolveTableHeaderColor,
    truncateCanvasTextToWidth,
    wrapCanvasTextToWidth,
} from '@/lib/genErdScript.js';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';
import { getColorContrastRatio } from '@/lib/smartTableColors.js';

const TABLE = {
    name: 'node',
    x: 240,
    y: 180,
    width: 160,
    height: 180,
};

const CANVAS_PAINT_RE = /^(#[0-9a-fA-F]{6}|rgba\(\d+, \d+, \d+, (?:0|1|0?\.\d+)\))$/;

describe('ERD self-reference connector geometry', () => {
    it('routes a self-column reference through a real loop instead of a collapsed same-side U-turn', () => {
        const fromY = TABLE.y + 24;
        const toY = fromY;
        const fromLeft = TABLE.x - TABLE.width / 2;
        const fromRight = TABLE.x + TABLE.width / 2;
        const conn = calculateSelfReferenceConnectorLoop({
            table: TABLE,
            fromY,
            toY,
            connectorOffset: 24,
            selfIndex: 0,
            sameColumn: true,
        });

        expect(conn.radius).toBe(8);
        expect(conn.points).toHaveLength(6);
        expect(conn.points[0]).toEqual({ x: fromRight, y: fromY });
        expect(conn.points[5]).toEqual({ x: fromLeft, y: toY });

        // The outgoing and incoming legs must live on opposite table sides,
        // otherwise a self-reference to the same row paints over itself.
        expect(conn.points[1].x).toBeGreaterThan(fromRight);
        expect(conn.points[4].x).toBeLessThan(fromLeft);
        expect(conn.points[2].y).toBeGreaterThan(TABLE.y + TABLE.height / 2);
        expect(conn.points[3].y).toBe(conn.points[2].y);
    });

    it('keeps same-table different-field references on the same side for a compact row-to-row loop', () => {
        const fromY = TABLE.y - 24;
        const toY = TABLE.y + 52;
        const fromRight = TABLE.x + TABLE.width / 2;
        const conn = calculateSelfReferenceConnectorLoop({
            table: TABLE,
            fromY,
            toY,
            connectorOffset: 24,
            selfIndex: 0,
            sameColumn: false,
        });

        expect(conn.radius).toBe(8);
        expect(conn.points).toHaveLength(4);
        expect(conn.points[0]).toEqual({ x: fromRight, y: fromY });
        expect(conn.points[3]).toEqual({ x: fromRight, y: toY });
        expect(conn.points[1].x).toBeGreaterThan(fromRight);
        expect(conn.points[2].x).toBe(conn.points[1].x);
        expect(conn.points.every((point) => point.x >= fromRight)).toBe(true);
    });

    it('routes upper-half self references above the table', () => {
        const fromY = TABLE.y - 48;
        const toY = TABLE.y - 20;
        const conn = calculateSelfReferenceConnectorLoop({
            table: TABLE,
            fromY,
            toY,
            connectorOffset: 24,
            selfIndex: 0,
            sameColumn: true,
        });

        expect(conn.points[2].y).toBeLessThan(TABLE.y - TABLE.height / 2);
        expect(conn.points[3].y).toBe(conn.points[2].y);
    });

    it('pushes parallel self-reference loops farther out so they stay visually distinct', () => {
        const first = calculateSelfReferenceConnectorLoop({
            table: TABLE,
            fromY: TABLE.y + 24,
            toY: TABLE.y + 52,
            connectorOffset: 24,
            selfIndex: 0,
            sameColumn: true,
        });
        const second = calculateSelfReferenceConnectorLoop({
            table: TABLE,
            fromY: TABLE.y + 24,
            toY: TABLE.y + 52,
            connectorOffset: 24,
            selfIndex: 1,
            sameColumn: true,
        });

        expect(second.points[1].x).toBeGreaterThan(first.points[1].x);
        expect(second.points[4].x).toBeLessThan(first.points[4].x);
        expect(second.points[2].y).toBeGreaterThan(first.points[2].y);
    });

    it('pushes parallel same-side different-field loops farther right without switching sides', () => {
        const fromRight = TABLE.x + TABLE.width / 2;
        const first = calculateSelfReferenceConnectorLoop({
            table: TABLE,
            fromY: TABLE.y - 24,
            toY: TABLE.y + 52,
            connectorOffset: 24,
            selfIndex: 0,
            sameColumn: false,
        });
        const second = calculateSelfReferenceConnectorLoop({
            table: TABLE,
            fromY: TABLE.y - 24,
            toY: TABLE.y + 52,
            connectorOffset: 24,
            selfIndex: 1,
            sameColumn: false,
        });

        expect(second.points).toHaveLength(4);
        expect(second.points[1].x).toBeGreaterThan(first.points[1].x);
        expect(second.points[2].x).toBe(second.points[1].x);
        expect(second.points.every((point) => point.x >= fromRight)).toBe(true);
    });

    it('normalizes invalid self-loop indexes to the first loop', () => {
        const first = calculateSelfReferenceConnectorLoop({
            table: TABLE,
            fromY: TABLE.y + 24,
            toY: TABLE.y + 24,
            connectorOffset: 24,
            selfIndex: 0,
            sameColumn: true,
        });
        const negative = calculateSelfReferenceConnectorLoop({
            table: TABLE,
            fromY: TABLE.y + 24,
            toY: TABLE.y + 24,
            connectorOffset: 24,
            selfIndex: -3,
            sameColumn: true,
        });
        const nonFinite = calculateSelfReferenceConnectorLoop({
            table: TABLE,
            fromY: TABLE.y + 24,
            toY: TABLE.y + 24,
            connectorOffset: 24,
            selfIndex: Number.NaN,
            sameColumn: true,
        });

        expect(negative).toEqual(first);
        expect(nonFinite).toEqual(first);
    });

    it('keeps SQL fixtures with both same-field and different-field self references renderer-visible', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE employees (
                id INT PRIMARY KEY,
                manager_id INT,
                mentor_id INT,
                mirror_id INT UNIQUE,

                CONSTRAINT fk_employee_manager
                    FOREIGN KEY (manager_id) REFERENCES employees(id),

                CONSTRAINT fk_employee_mentor
                    FOREIGN KEY (mentor_id) REFERENCES employees(id),

                CONSTRAINT fk_employee_self_same_field
                    FOREIGN KEY (mirror_id) REFERENCES employees(mirror_id)
            );
        `);

        const relationKey = (rel) => `${rel.from.column}->${rel.to.column}`;
        const keys = schema.relations.map(relationKey);

        expect(keys).toContain('manager_id->id');
        expect(keys).toContain('mentor_id->id');
        expect(keys).toContain('mirror_id->mirror_id');
        expect(schema.relations).toHaveLength(3);
        expect(schema._parseErrors.filter((error) => error.kind === 'relation_dropped_non_unique_target')).toHaveLength(0);
    });

    it('tracks the exact relationship endpoint fields for the selected table', () => {
        const connectorPaths = [
            {
                points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
                relation: {
                    from: { table: 'orders', column: 'customer_id' },
                    to: { table: 'customers', column: 'id' },
                },
            },
            {
                points: [{ x: 0, y: 10 }, { x: 10, y: 10 }],
                relation: {
                    from: { table: 'line_items', column: 'order_id' },
                    to: { table: 'orders', column: 'id' },
                },
            },
            {
                points: [{ x: 0, y: 20 }, { x: 10, y: 20 }],
                relation: {
                    from: { table: 'invoices', column: 'customer_id' },
                    to: { table: 'customers', column: 'id' },
                },
            },
            {
                points: [],
                relation: {
                    from: { table: 'orders', column: 'draft_customer_id' },
                    to: { table: 'customers', column: 'id' },
                },
            },
        ];

        const keys = getSelectedRelationshipFieldKeys(connectorPaths, 'orders');

        expect(keys.has(getRelationshipFieldKey('orders', 'customer_id'))).toBe(true);
        expect(keys.has(getRelationshipFieldKey('customers', 'id'))).toBe(true);
        expect(keys.has(getRelationshipFieldKey('line_items', 'order_id'))).toBe(true);
        expect(keys.has(getRelationshipFieldKey('orders', 'id'))).toBe(true);
        expect(keys.has(getRelationshipFieldKey('invoices', 'customer_id'))).toBe(false);
        expect(keys.has(getRelationshipFieldKey('orders', 'draft_customer_id'))).toBe(false);
    });

    it('builds the priority layer from selected tables and direct relationship neighbors', () => {
        const connectorPaths = [
            {
                points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
                relation: {
                    from: { table: 'orders', column: 'customer_id' },
                    to: { table: 'customers', column: 'id' },
                },
            },
            {
                points: [{ x: 0, y: 10 }, { x: 10, y: 10 }],
                relation: {
                    from: { table: 'line_items', column: 'order_id' },
                    to: { table: 'orders', column: 'id' },
                },
            },
            {
                points: [{ x: 0, y: 20 }, { x: 10, y: 20 }],
                relation: {
                    from: { table: 'audit_logs', column: 'actor_id' },
                    to: { table: 'users', column: 'id' },
                },
            },
            {
                points: [],
                relation: {
                    from: { table: 'orders', column: 'draft_customer_id' },
                    to: { table: 'customers', column: 'id' },
                },
            },
        ];

        const state = getPriorityLayerState(connectorPaths, ['orders', 'orders']);

        expect(state.active).toBe(true);
        expect([...state.priorityTables]).toEqual(['orders']);
        expect([...state.visibleTables].sort()).toEqual(['customers', 'line_items', 'orders']);
        expect([...state.connectorIndexes]).toEqual([0, 1]);
    });

    it('filters saved priority tables to live schema tables', () => {
        const livePriorityTableNames = getLivePriorityTableNames(
            [{ name: 'orders' }, { name: 'customers' }],
            ['orders', 'missing_table', 'customers', 'orders'],
        );

        expect(livePriorityTableNames).toEqual(['orders', 'customers']);
    });

    it('uses an outline hover for rows already highlighted as relationship fields', () => {
        expect(
            getColumnHoverTreatment({
                isSelectedRelationField: true,
                isHoverHighlighted: true,
            }),
        ).toEqual({
            fillHover: false,
            outlineHover: true,
        });

        expect(
            getColumnHoverTreatment({
                isSelectedRelationField: false,
                isHoverHighlighted: true,
            }),
        ).toEqual({
            fillHover: true,
            outlineHover: false,
        });
    });

    it('wraps connector tooltip text without dropping content behind ellipses', () => {
        const ctx = {
            measureText: (value) => ({ width: String(value).length }),
        };

        const actionText = 'Actions: ON DELETE SET DEFAULT, ON UPDATE CASCADE, MATCH FULL';
        const actionLines = wrapCanvasTextToWidth(ctx, actionText, 24);
        expect(actionLines.join(' ')).toBe(actionText);
        expect(actionLines.every((line) => line.length <= 24)).toBe(true);
        expect(actionLines.some((line) => line.includes('...'))).toBe(false);

        const longIdentifier = 'fk_orders_customer_identifier_without_spaces';
        const identifierLines = wrapCanvasTextToWidth(ctx, longIdentifier, 12);
        expect(identifierLines.join('')).toBe(longIdentifier);
        expect(identifierLines.every((line) => line.length <= 12)).toBe(true);
        expect(identifierLines.some((line) => line.includes('...'))).toBe(false);
    });

    it('truncates header text to the measured lane without overflowing icons', () => {
        const ctx = {
            measureText: (value) => ({ width: String(value).length }),
        };

        expect(truncateCanvasTextToWidth(ctx, 'short_name', 20)).toBe('short_name');
        expect(truncateCanvasTextToWidth(ctx, 'very_long_table_name', 12)).toBe('very_long...');
        expect(truncateCanvasTextToWidth(ctx, 'name', 2)).toBe('');
    });
});

describe('ERD Best layout graph analysis', () => {
    const table = (name, width = 180, height = 120) => ({ name, width, height, columns: [] });
    const fk = (from, to) => ({
        from: { table: from, column: `${to}_id` },
        to: { table: to, column: 'id' },
    });

    it('uses a deterministic packed grid when there are no relationship edges', () => {
        const tables = [table('t10', 240, 120), table('t2', 180, 140), table('t1', 220, 100)];
        const profile = analyzeErdLayoutGraph(tables, []);
        const positions = buildGridLayoutPositions(tables);

        expect(chooseBestLayoutStrategy(profile)).toBe('grid');
        expect(Object.keys(positions).sort()).toEqual(['t1', 't10', 't2']);
        expect(positions.t1.x).toBeLessThan(positions.t2.x);
        expect(positions.t2.x).toBeLessThan(positions.t10.x);
        expect(new Set(Object.values(positions).map((point) => `${point.x}:${point.y}`)).size).toBe(3);
    });

    it('detects hub-like schemas and chooses radial layout', () => {
        const tables = ['users', 'profiles', 'posts', 'comments', 'sessions', 'tokens'].map((name) => table(name));
        const relations = ['profiles', 'posts', 'comments', 'sessions', 'tokens'].map((child) => fk(child, 'users'));
        const profile = analyzeErdLayoutGraph(tables, relations);

        expect(profile.hubName).toBe('users');
        expect(profile.maxDegree).toBe(5);
        expect(profile.isHubLike).toBe(true);
        expect(chooseBestLayoutStrategy(profile)).toBe('radial');
    });

    it('keeps normal dependency chains in semantic layered layout', () => {
        const tables = ['organizations', 'users', 'orders', 'order_items'].map((name) => table(name));
        const relations = [fk('users', 'organizations'), fk('orders', 'users'), fk('order_items', 'orders')];
        const profile = analyzeErdLayoutGraph(tables, relations);

        expect(profile.rootCount).toBe(1);
        expect(profile.leafCount).toBe(1);
        expect(profile.hasDirectedCycle).toBe(false);
        expect(chooseBestLayoutStrategy(profile)).toBe('layered');
    });
});

describe('ERD color picker swatches and gradients', () => {
    it('composes a header scrim with the table priority opacity', () => {
        expect(composeCanvasAlpha(0.16, 0.349)).toBeCloseTo(0.05584, 6);
        expect(composeCanvasAlpha(1, 0.349)).toBeCloseTo(0.349, 6);
    });

    it('maps persisted header text modes without treating malformed values as overrides', () => {
        expect(getTableHeaderTextColorForMode('white')).toBe('#FFFFFF');
        expect(getTableHeaderTextColorForMode(' BLACK ')).toBe('#000000');
        expect(getTableHeaderTextColorForMode('auto')).toBeNull();
        expect(getTableHeaderTextColorForMode('blue')).toBeNull();
        expect(getTableHeaderTextColorForMode(null)).toBeNull();
    });

    it('keeps composite constraint pills readable in both themes', () => {
        expect(getCompositeConstraintPillColors(false).background).toBe('#64748B');
        expect(getCompositeConstraintPillColors(true).background).toBe('#4F5E70');

        [false, true].forEach((darkMode) => {
            const colors = getCompositeConstraintPillColors(darkMode);

            expect(colors.text).toBe('#FFFFFF');
            expect(getColorContrastRatio(colors.text, colors.background)).toBeGreaterThanOrEqual(4.5);
        });
    });

    it('applies Auto, White, and Black safely while keeping neutral composite badges adaptively white', () => {
        const forcedWhite = getTableConstraintPillAppearance('#FBC02D', 'white', '#FFFFFF');
        const forcedBlack = getTableConstraintPillAppearance('#312E81', 'black', '#FFFFFF');

        expect(forcedWhite).toMatchObject({ background: '#FBC02D', textColor: '#FFFFFF', overlayColor: '#000000' });
        expect(forcedWhite.overlayAlpha).toBeGreaterThan(0);
        expect(forcedWhite.minimumContrast).toBeGreaterThanOrEqual(4.75);
        expect(forcedBlack).toMatchObject({ background: '#312E81', textColor: '#000000', overlayColor: '#FFFFFF' });
        expect(forcedBlack.overlayAlpha).toBeGreaterThan(0);
        expect(forcedBlack.minimumContrast).toBeGreaterThanOrEqual(4.75);

        [false, true].forEach((darkMode) => {
            const compositeBackground = getCompositeConstraintPillColors(darkMode).background;
            ['auto', 'white', 'black'].forEach((mode) => {
                const resolvedMode = getConstraintPillTextMode(true, mode);
                const appearance = getTableConstraintPillAppearance(compositeBackground, resolvedMode, darkMode ? '#323232' : '#FFFFFF');
                expect(resolvedMode).toBe('white');
                expect(appearance.background).toBe(compositeBackground);
                expect(appearance.textColor).toBe('#FFFFFF');
                expect(appearance.minimumContrast).toBeGreaterThanOrEqual(4.75);
            });
        });

        const futureLightNeutral = getTableConstraintPillAppearance('#D1D5DB', getConstraintPillTextMode(true, 'black'), '#FFFFFF');
        expect(futureLightNeutral).toMatchObject({ textColor: '#FFFFFF', overlayColor: '#000000' });
        expect(futureLightNeutral.overlayAlpha).toBeGreaterThan(0);
        expect(futureLightNeutral.minimumContrast).toBeGreaterThanOrEqual(4.75);
        expect(getConstraintPillTextMode(false, 'black')).toBe('black');

        expect(getTableConstraintPillAppearance('gradient:#2563EB:#06B6D4', 'auto').background).toBe('#2563EB');
        expect(getTableConstraintPillAppearance('not-a-color', 'white', '#323232')).toMatchObject({ background: '#323232', textColor: '#FFFFFF' });
        expect(composeCanvasAlpha(0.16, forcedWhite.overlayAlpha)).toBeCloseTo(0.16 * forcedWhite.overlayAlpha, 8);
    });

    it('uses roomier badge padding and measured font bounds for cross-platform centering', () => {
        let baselineAtMeasure = null;
        const context = {
            font: '',
            textAlign: 'left',
            textBaseline: 'middle',
            measureText() {
                baselineAtMeasure = this.textBaseline;
                return { width: 10, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 3 };
            },
        };

        expect(measureConstraintPillText(context, 'PK')).toMatchObject({ width: 10 });
        expect(baselineAtMeasure).toBe('alphabetic');
        expect(context).toMatchObject({ font: '700 12px sans-serif', textAlign: 'center', textBaseline: 'alphabetic' });
        expect(getConstraintPillLayout(10)).toEqual({ width: 16, height: 16, paddingX: 3 });
        expect(getCenteredCanvasTextBaseline(20, { actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 3 })).toBe(23);
        expect(getCenteredCanvasTextBaseline(20, { actualBoundingBoxAscent: 9.4, actualBoundingBoxDescent: 0.2 })).toBe(24.5);
        expect(getCenteredCanvasTextBaseline(20, {}, 12)).toBe(23);
    });

    it('keeps solid and gradient swatches aligned to six-column grids', () => {
        const swatches = getColorSwatchGroups();
        const allValues = [...swatches.solid, ...swatches.gradient].map((swatch) => swatch.value);

        expect(swatches.solid).toHaveLength(24);
        expect(swatches.gradient).toHaveLength(12);
        expect(swatches.solid.length % 6).toBe(0);
        expect(swatches.gradient.length % 6).toBe(0);
        expect(new Set(allValues).size).toBe(allValues.length);
        expect(swatches.solid.every((swatch) => swatch.type === 'solid' && /^#[0-9a-fA-F]{6}$/.test(swatch.value))).toBe(true);
        expect(swatches.gradient.every((swatch) => swatch.type === 'gradient' && parseGradientColor(swatch.value)?.colors.length === swatch.colors.length)).toBe(true);
    });

    it('formats gradient swatches for CSS and falls back to the first stop for simple canvas fills', () => {
        const value = 'gradient:#2563EB:#06B6D4';

        expect(parseGradientColor(value)).toEqual({ colors: ['#2563EB', '#06B6D4'] });
        expect(getCanvasColorCss(value)).toBe('linear-gradient(135deg, #2563EB, #06B6D4)');
        expect(getPrimaryCanvasColor(value)).toBe('#2563EB');
        expect(getCanvasColorCss('#388E3C')).toBe('#388E3C');
        expect(getPrimaryCanvasColor('#388E3C')).toBe('#388E3C');
        expect(parseGradientColor('gradient:#2563EB')).toBeNull();
        expect(parseGradientColor('gradient:#2563EB:not-a-color')).toBeNull();
    });

    it('falls back safely when a persisted canvas color is malformed', () => {
        const fallback = '#334155';

        expect(resolveTableHeaderColor('rgba(255,255,255,garbage)', fallback)).toBe(fallback);
        expect(resolveTableHeaderColor('rgb(255,255,255) trailing-text', fallback)).toBe(fallback);
        expect(resolveTableHeaderColor('rgba(255,255,255,0.5)', fallback)).toBe('rgba(255,255,255,0.5)');
        expect(resolveTableHeaderColor('gradient:#2563EB:#06B6D4', fallback)).toBe('gradient:#2563EB:#06B6D4');
    });

    it('builds a real canvas gradient for table headers', () => {
        const stops = [];
        let gradientArgs = null;
        const canvasGradient = {
            addColorStop: (offset, color) => stops.push({ offset, color }),
        };
        const ctx = {
            createLinearGradient: (...args) => {
                gradientArgs = args;
                return canvasGradient;
            },
        };
        const fill = getTableHeaderFillStyle(
            ctx,
            { x: 100, y: 80, width: 200, height: 120 },
            'gradient:#2563EB:#06B6D4',
            32,
        );

        expect(fill).toBe(canvasGradient);
        expect(gradientArgs).toEqual([0, 20, 200, 52]);
        expect(stops).toEqual([
            { offset: 0, color: '#2563EB' },
            { offset: 1, color: '#06B6D4' },
        ]);
    });

    it('keeps black and very dark table interaction colors neutral in dark theme', () => {
        const darkTableColors = ['#000000', '#111827', 'gradient:#0F172A:#475569'];

        darkTableColors.forEach((color) => {
            expect(getTableConnectorColor(color, true)).toBe('#a6a6a6');
            expect(getTableRelationshipFieldFillColor(color, true)).toBe('rgba(255, 255, 255, 0.1)');
            expect(getTableSelectionAccentColor(color, true)).toBe('rgba(255, 255, 255, 0.64)');
            expect(getTableRowHoverOutlineColor(color, true)).toBe('rgba(255, 255, 255, 0.58)');
        });
    });

    it('returns valid interaction paints for every table swatch in both themes', () => {
        const swatches = getColorSwatchGroups();
        const tableColors = [
            '#000000',
            '#ffffff',
            ...swatches.solid.map((swatch) => swatch.value),
            ...swatches.gradient.map((swatch) => swatch.value),
        ];

        tableColors.forEach((color) => {
            [false, true].forEach((darkMode) => {
                expect(getTableConnectorColor(color, darkMode)).toMatch(CANVAS_PAINT_RE);
                expect(getColorContrastRatio(getTableConnectorColor(color, darkMode), darkMode ? '#3c3c3c' : '#ffffff')).toBeGreaterThanOrEqual(4.5);
                expect(getTableRelationshipFieldFillColor(color, darkMode)).toMatch(CANVAS_PAINT_RE);
                expect(getTableSelectionAccentColor(color, darkMode)).toMatch(CANVAS_PAINT_RE);
                expect(getTableRowHoverOutlineColor(color, darkMode)).toMatch(CANVAS_PAINT_RE);
            });
        });
    });
});

describe('ERD inferred relationship visuals', () => {
    it('keeps pending and accepted inference distinct from real foreign keys', () => {
        expect(getInferredRelationVisual({ inferred: false }, false)).toBeNull();
        expect(getInferredRelationVisual({ inferred: true, inferenceStatus: 'pending' }, false)).toEqual({
            status: 'pending',
            stroke: '#b36205',
            dash: [5, 5],
            badgeFill: '#b45309',
        });
        expect(getInferredRelationVisual({ inferred: true, inferenceStatus: 'accepted' }, true)).toEqual({
            status: 'accepted',
            stroke: '#34d399',
            dash: [8, 5],
            badgeFill: '#065f46',
        });
    });
});

describe('ERD layout mode labels', () => {
    it('uses BE for the Best layout button label', () => {
        expect(getLayoutModeLabel(LAYOUT_MODES.BEST)).toBe('BE');
        expect(getLayoutModeLabel(LAYOUT_MODES.LEFT_TO_RIGHT)).toBe('LR');
    });
});

describe('ERD toolbar popup positioning', () => {
    it('prefers the right of a table icon when both sides have room', () => {
        expect(getToolbarPopupPosition({
            triggerRect: { left: 500, right: 524, top: 300, bottom: 324 },
            popupRect: { width: 190, height: 294 },
            bounds: { left: 0, right: 1200, top: 0, bottom: 800 },
            preferredPlacement: 'right',
        })).toEqual({ left: 532, top: 165, arrowTop: 147, placement: 'right' });
    });

    it('flips a table popup left without covering the icon or its arrow clearance', () => {
        const position = getToolbarPopupPosition({
            triggerRect: { left: 1100, right: 1124, top: 300, bottom: 324 },
            popupRect: { width: 190, height: 294 },
            bounds: { left: 0, right: 1200, top: 0, bottom: 800 },
            preferredPlacement: 'right',
        });

        expect(position).toEqual({ left: 902, top: 165, arrowTop: 147, placement: 'left' });
        expect(position.left + 190 + 8).toBeLessThanOrEqual(1100);
    });

    it('stacks a table popup when neither side fits while keeping it inside the panel', () => {
        expect(getToolbarPopupPosition({
            triggerRect: { left: 110, right: 134, top: 80, bottom: 104 },
            popupRect: { width: 190, height: 170 },
            bounds: { left: 0, right: 240, top: 0, bottom: 300 },
            preferredPlacement: 'right',
        })).toEqual({ left: 27, top: 112, arrowTop: 16, placement: 'stacked' });
    });

    it('places a popup to the left of the right toolbar and aligns its arrow to the trigger', () => {
        expect(
            getToolbarPopupPosition({
                triggerRect: { left: 1140, right: 1178, top: 300, bottom: 338 },
                popupRect: { width: 270, height: 240 },
                bounds: { left: 0, right: 1200, top: 0, bottom: 800 },
            }),
        ).toEqual({ left: 862, top: 199, arrowTop: 120, placement: 'left' });
    });

    it('clamps tall popups inside the panel while preserving an accurate arrow position', () => {
        expect(
            getToolbarPopupPosition({
                triggerRect: { left: 1140, right: 1178, top: 20, bottom: 58 },
                popupRect: { width: 270, height: 280 },
                bounds: { left: 0, right: 1200, top: 0, bottom: 800 },
            }),
        ).toEqual({ left: 862, top: 8, arrowTop: 31, placement: 'left' });
    });

    it('uses a clamped stacked placement when neither side has enough room', () => {
        expect(
            getToolbarPopupPosition({
                triggerRect: { left: 194, right: 232, top: 80, bottom: 118 },
                popupRect: { width: 224, height: 170 },
                bounds: { left: 0, right: 240, top: 0, bottom: 300 },
            }),
        ).toEqual({ left: 8, top: 14, arrowTop: 85, placement: 'stacked' });
    });
});
