import { describe, expect, it } from 'vitest';
import { chooseColumnActionSide, countColumnConnectorSides, getColumnLabelSides } from '@/lib/erd-renderer/columnActionPlacement';

describe('column action placement', () => {
    it.each([
        [{ left: 1, right: 0 }, {}, 'left', 'right'],
        [{ left: 0, right: 4 }, {}, 'right', 'left'],
        [{ left: 2, right: 1 }, {}, 'left', 'right'],
        [{ left: 1, right: 3 }, {}, 'right', 'left'],
        [{ left: 0, right: 1 }, { left: 9, right: 1 }, 'right', 'left'],
        [{ left: 1, right: 1 }, { left: 3, right: 1 }, 'left', 'right'],
        [{}, { left: 0, right: 3 }, 'right', 'left'],
        [{}, {}, 'right', 'right'],
        [{}, {}, 'left', 'left'],
        [{ left: NaN, right: -1 }, {}, 'invalid', 'left'],
    ])('chooses %s with whole-table traffic %s and previous side %s → %s', (column, table, previous, expected) => {
        expect(chooseColumnActionSide(column, table, previous)).toBe(expected);
    });
    it('keeps an action within the viewport when the free side is clipped', () => {
        expect(chooseColumnActionSide({ left: 0, right: 3 }, {}, 'left', { left: false, right: true })).toBe('right');
        expect(chooseColumnActionSide({ left: 3, right: 0 }, {}, 'right', { left: true, right: false })).toBe('left');
        expect(chooseColumnActionSide({}, {}, 'right', { left: false, right: false })).toBe('right');
    });
    it('never chooses an outside-label side, even when its opposite has more connectors or is clipped', () => {
        expect(chooseColumnActionSide({ left: 5, right: 0 }, { left: 8, right: 0 }, 'right', { left: true, right: true }, { right: true })).toBe('left');
        expect(chooseColumnActionSide({ left: 5, right: 0 }, {}, 'right', { left: false, right: true }, { right: true })).toBe('left');
        expect(chooseColumnActionSide({}, {}, 'left', undefined, { left: true })).toBe('right');
        expect(chooseColumnActionSide({}, {}, 'right', undefined, { left: true, right: true })).toBeNull();
    });
    it('reserves enum, composite and extras notes, including the full hovered multirow box', () => {
        const columns = [{ name: 'status', type: 'status', extras: ['DEFAULT active'] }, { name: 'plain', type: 'TEXT' }, { name: 'address', type: 'address' }, { name: 'next', type: 'INT' }, { name: 'final', type: 'INT' }];
        const enums = { status: ['active', 'inactive'] }; const composites = { address: [{ name: 'zip', type: 'TEXT' }] };
        expect([...getColumnLabelSides(columns, enums, composites).keys()]).toEqual(['status', 'address']);
        expect([...getColumnLabelSides(columns, enums, composites, 0).keys()].sort()).toEqual(['address', 'next', 'plain', 'status']);
        expect([...getColumnLabelSides(columns, enums, composites, 1).keys()]).toEqual(['status', 'address']);
    });
    it('counts outgoing/incoming ends, shared heads, self-references and inferred routed links once each', () => {
        const path = (from, to, fromSide, toSide) => ({ relation: { from, to }, fromSide, toSide, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] });
        const c = (column) => ({ table: 'c', column }); const p = { table: 'p', column: 'id' };
        const connectors = [path(c('pid'), p, 'left', 'right'), path(c('pid'), p, 'left', 'right'), path(p, c('id'), 'left', 'right'), path(c('pid'), c('id'), 'right', 'left'), { ...path(c('extra'), p, 'right', 'left'), relation: { from: c('extra'), to: p, inferred: true } }];
        const counts = countColumnConnectorSides([...connectors, { ...connectors[0], points: [] }, { relation: null }], 'c');
        expect(counts.table).toEqual({ left: 3, right: 3 });
        expect([...counts.columns]).toEqual([['pid', { left: 2, right: 1 }], ['id', { left: 1, right: 1 }], ['extra', { left: 0, right: 1 }]]);
        connectors[0].fromSide = 'right';
        expect(countColumnConnectorSides(connectors, 'c').columns.get('pid')).toEqual({ left: 1, right: 2 });
    });
});
