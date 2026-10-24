import { describe, expect, it } from 'vitest';
import { getTableGroupFrames, getTableGroupHeaderAtPoint, normalizeTableGroups } from '@/lib/erd-renderer/tableGroups.js';

describe('SQL canvas group compatibility', () => {
    it('tolerates missing and malformed data without creating groups', () => {
        for (const value of [undefined, null, false, 'groups', {}, [null, [], {}, { id: 'empty', tableNames: [] }]]) {
            expect(normalizeTableGroups(value)).toEqual([]);
        }
    });

    it('keeps exact SQL identifiers and absent members while sanitizing presentation fields', () => {
        const value = [{ id: ' g1 ', name: ' Sales ', tableNames: ['public.orders', ' "Sales Table" ', 'missing.table', '', ' ', 2, 'public.orders'], color: ' #AABBCC ', ignored: true }];
        const before = JSON.stringify(value);
        expect(normalizeTableGroups(value)).toEqual([{ id: 'g1', name: 'Sales', tableNames: ['public.orders', ' "Sales Table" ', 'missing.table'], color: '#aabbcc' }]);
        expect(JSON.stringify(value)).toBe(before);
    });

    it('assigns each table once and drops duplicate IDs and empty groups deterministically', () => {
        expect(normalizeTableGroups([
            { id: 'one', name: '', tableNames: ['users', 'users'] },
            { id: 'one', name: 'Duplicate', tableNames: ['audit'] },
            { id: 'two', name: 'Second', tableNames: ['users', 'orders'] },
            { id: 'three', name: 'Empty', tableNames: ['users'] },
            { id: 'four', tableNames: ['audit'] },
        ])).toEqual([
            { id: 'one', name: 'Group', tableNames: ['users'] },
            { id: 'two', name: 'Second', tableNames: ['orders'] },
            { id: 'four', name: 'Group', tableNames: ['audit'] },
        ]);
    });

    it('limits names and groups and ignores invalid colors', () => {
        const groups = Array.from({ length: 60 }, (_, index) => ({ id: `g${index}`, name: 'a'.repeat(200), tableNames: [`table${index}`], color: 'red' }));
        const normalized = normalizeTableGroups(groups);
        expect(normalized).toHaveLength(50);
        expect(normalized[0]).toEqual({ id: 'g0', name: 'a'.repeat(160), tableNames: ['table0'] });
        expect(normalizeTableGroups(normalized)).toEqual(normalized);
    });
});

describe('derived SQL table group geometry', () => {
    const groups = [{ id: 'g1', name: 'Sales', tableNames: ['users', 'orders', 'absent'] }];
    const tables = [{ name: 'users', x: 0, y: 0, width: 100, height: 100 }, { name: 'orders', x: 400, y: 200, width: 200, height: 100 }];

    it('encloses live table bounds with shared padding and a separate header', () => {
        const before = JSON.stringify({ groups, tables });
        expect(getTableGroupFrames(groups, tables)).toEqual([{ ...groups[0], x: 225, y: 84, width: 598, height: 380 }]);
        expect(JSON.stringify({ groups, tables })).toBe(before);
    });

    it('tracks table moves and size changes without persisting frame coordinates', () => {
        const [original] = getTableGroupFrames(groups, tables);
        const [moved] = getTableGroupFrames(groups, tables.map(table => ({ ...table, x: table.x + 200, y: table.y - 100 })));
        expect(moved).toEqual({ ...original, x: original.x + 200, y: original.y - 100 });
        const [compact] = getTableGroupFrames([{ id: 'g1', tableNames: ['users'] }], [{ name: 'users', x: 20, y: 100, width: 40, height: 80 }]);
        expect(compact).toMatchObject({ x: 20, y: 84, width: 160, height: 160 });
    });

    it('hides frames with no valid live tables while retaining their saved membership', () => {
        expect(getTableGroupFrames(groups, [])).toEqual([]);
        expect(getTableGroupFrames(groups, [{ ...tables[0], x: NaN }, { ...tables[1], width: 0 }])).toEqual([]);
        expect(groups[0].tableNames).toContain('absent');
        expect(getTableGroupFrames(null, null)).toEqual([]);
    });

    it('captures only headers and gives the last drawn frame priority', () => {
        const frames = getTableGroupFrames(groups, tables);
        const frame = frames[0];
        expect(getTableGroupHeaderAtPoint(frames, -74, -106)).toBe(frame);
        expect(getTableGroupHeaderAtPoint(frames, 524, -74)).toBe(frame);
        expect(getTableGroupHeaderAtPoint(frames, 225, -73)).toBeNull();
        expect(getTableGroupHeaderAtPoint(frames, 525, -100)).toBeNull();
        const later = { ...frame, id: 'later' };
        expect(getTableGroupHeaderAtPoint([...frames, later], 225, -90)).toBe(later);
        expect(getTableGroupHeaderAtPoint(frames, NaN, 0)).toBeNull();
    });
});
