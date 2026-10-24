import { describe, it, expect, vi } from 'vitest';
import ContextManager from '@/lib/ContextManager.js';

/**
 * ContextManager — validation + persistence-round-trip tests.
 *
 * Pins the input-validation contract that the renderer relies on:
 *   • zoom is always > 0 and finite (otherwise getTouchPos /
 *     screenToWorld divides by zero and the canvas freezes).
 *   • offsetX / offsetY are always finite numbers (NaN propagates
 *     through every coordinate transform downstream).
 *   • batchUpdate enforces the same rules as the per-field setters,
 *     so a corrupted persisted payload from a previous session can't
 *     poison the in-memory context after re-hydration.
 */

function make() {
    return new ContextManager();
}

describe('ContextManager — zoom validation', () => {
    it('setZoom rejects 0 and negative values', () => {
        const cm = make();
        const original = cm.zoom;
        expect(cm.setZoom(0)).toBe(false);
        expect(cm.setZoom(-1)).toBe(false);
        expect(cm.zoom).toBe(original);
    });

    it('setZoom rejects NaN, Infinity, non-numbers', () => {
        const cm = make();
        const original = cm.zoom;
        expect(cm.setZoom(NaN)).toBe(false);
        expect(cm.setZoom(Infinity)).toBe(false);
        expect(cm.setZoom(-Infinity)).toBe(false);
        expect(cm.setZoom('1.5')).toBe(false);
        expect(cm.setZoom(null)).toBe(false);
        expect(cm.zoom).toBe(original);
    });

    it('setZoom accepts positive finite numbers', () => {
        const cm = make();
        expect(cm.setZoom(2.5)).toBe(true);
        expect(cm.zoom).toBe(2.5);
    });
});

describe('ContextManager — batchUpdate validation', () => {
    it('rejects non-object updates', () => {
        const cm = make();
        expect(cm.batchUpdate(null)).toBe(false);
        expect(cm.batchUpdate('hi')).toBe(false);
    });

    it('drops zoom = 0 from a batch (renderer would divide by zero)', () => {
        const cm = make();
        const original = cm.zoom;
        cm.batchUpdate({ zoom: 0, offsetX: 100, offsetY: 100 });
        expect(cm.zoom).toBe(original); // zoom unchanged
        expect(cm.offsetX).toBe(100); // other valid keys still applied
        expect(cm.offsetY).toBe(100);
    });

    it('drops NaN offset from a batch', () => {
        const cm = make();
        cm.setOffset(50, 50);
        cm.batchUpdate({ offsetX: NaN, offsetY: 200 });
        expect(cm.offsetX).toBe(50); // NaN dropped, prior value retained
        expect(cm.offsetY).toBe(200); // valid value applied
    });

    it('drops Infinity zoom from a batch', () => {
        const cm = make();
        const original = cm.zoom;
        cm.batchUpdate({ zoom: Infinity });
        expect(cm.zoom).toBe(original);
    });

    it('drops a string-typed zoom from a batch', () => {
        const cm = make();
        const original = cm.zoom;
        cm.batchUpdate({ zoom: '1.5' });
        expect(cm.zoom).toBe(original);
    });

    it('accepts a fully-valid batch update', () => {
        const cm = make();
        const result = cm.batchUpdate({
            zoom: 1.25,
            offsetX: 100,
            offsetY: -50,
        });
        expect(result).toBe(true);
        expect(cm.zoom).toBe(1.25);
        expect(cm.offsetX).toBe(100);
        expect(cm.offsetY).toBe(-50);
    });

    it('persists table positions / colors / compactModes from a batch', () => {
        const cm = make();
        cm.batchUpdate({
            tablePositions: { users: { x: 10, y: 20 } },
            tableColors: { users: '#ff00ff' },
            tableHeaderTextModes: { users: 'white' },
            tableCompactModes: { users: true },
            priorityTableNames: ['users', 'orders', 'users'],
        });
        expect(cm.tablePositions.users).toEqual({ x: 10, y: 20 });
        expect(cm.tableColors.users).toBe('#ff00ff');
        expect(cm.tableHeaderTextModes.users).toBe('white');
        expect(cm.tableCompactModes.users).toBe(true);
        expect(cm.priorityTableNames).toEqual(['users', 'orders']);
    });

    it('toggles priority table names and removes stale table priority state', () => {
        const cm = make();
        expect(cm.togglePriorityTableName('users')).toBe(true);
        expect(cm.togglePriorityTableName('orders')).toBe(true);
        expect(cm.priorityTableNames).toEqual(['users', 'orders']);
        expect(cm.isPriorityTableName('users')).toBe(true);

        expect(cm.togglePriorityTableName('users')).toBe(true);
        expect(cm.priorityTableNames).toEqual(['orders']);

        expect(cm.clearPriorityTableNames()).toBe(true);
        expect(cm.priorityTableNames).toEqual([]);

        expect(cm.togglePriorityTableName('orders')).toBe(true);
        cm.removeTableData('orders');
        expect(cm.priorityTableNames).toEqual([]);
    });

    it('ignores unknown keys silently (forward-compat with future fields)', () => {
        const cm = make();
        const result = cm.batchUpdate({
            zoom: 1.5,
            unknownField: 'whatever',
        });
        expect(result).toBe(true);
        expect(cm.zoom).toBe(1.5);
        expect(cm.context.unknownField).toBeUndefined();
    });
});

describe('ContextManager — table header text modes', () => {
    it('defaults missing modes to Auto and normalizes valid persisted values', () => {
        const cm = new ContextManager({
            tableHeaderTextModes: { users: ' WHITE ', orders: 'black', ignored: 'blue' },
        });

        expect(cm.tableHeaderTextModes).toEqual({ users: 'white', orders: 'black' });
        expect(cm.getTableHeaderTextMode('users')).toBe('white');
        expect(cm.getTableHeaderTextMode('missing')).toBe('auto');
        expect(new ContextManager({ tableHeaderTextModes: 'corrupt' }).tableHeaderTextModes).toEqual({});
    });

    it('sets White or Black, rejects invalid modes, and treats Auto as a sparse reset', () => {
        const cm = make();

        expect(cm.setTableHeaderTextMode('users', 'WHITE')).toBe(true);
        expect(cm.getTableHeaderTextMode('users')).toBe('white');
        expect(cm.setTableHeaderTextMode('users', 'blue')).toBe(false);
        expect(cm.getTableHeaderTextMode('users')).toBe('white');
        expect(cm.setTableHeaderTextMode('users', 'auto')).toBe(true);
        expect(cm.getTableHeaderTextMode('users')).toBe('auto');
        expect(cm.tableHeaderTextModes).toEqual({});
    });

    it('validates batch hydration and removes table-specific or global overrides', () => {
        const cm = make();

        cm.batchUpdate({ tableHeaderTextModes: { users: 'white', orders: 'BLACK', ignored: '#ffffff' } });
        expect(cm.tableHeaderTextModes).toEqual({ users: 'white', orders: 'black' });
        cm.removeTableData('users');
        expect(cm.tableHeaderTextModes).toEqual({ orders: 'black' });
        expect(cm.clearAllTableHeaderTextModes()).toBe(true);
        expect(cm.tableHeaderTextModes).toEqual({});
    });
});

describe('ContextManager — optional SQL table groups', () => {
    const group = { id: 'sales', name: 'Sales', tableNames: ['public.orders', 'temporarily_missing'], color: '#aabbcc' };

    it('keeps the additive field absent for legacy, empty and malformed contexts without notifying', () => {
        const notify = vi.fn();
        const schedule = vi.spyOn(ContextManager.prototype, '_scheduleNotifyChange');
        try {
            for (const context of [undefined, {}, { tableGroups: [] }, { tableGroups: 'corrupt' }]) {
                const manager = new ContextManager(context, notify);
                expect(manager.tableGroups).toEqual([]);
                expect(manager.getFullContext()).not.toHaveProperty('tableGroups');
            }
            expect(notify).not.toHaveBeenCalled();
            expect(schedule).not.toHaveBeenCalled();
        } finally {
            schedule.mockRestore();
        }
    });

    it('round trips normalized groups and unrelated renderer context without schema-based pruning', () => {
        const context = { tableGroups: [group], tablePositions: { existing: { x: 50, y: 70 } }, futureState: { retained: true } };
        const manager = new ContextManager(context);
        expect(manager.tableGroups).toEqual([group]);
        expect(manager.tableGroups).not.toBe(context.tableGroups);
        expect(manager.tableGroups[0].tableNames).not.toBe(group.tableNames);
        expect(new ContextManager(JSON.parse(JSON.stringify(manager.getFullContext()))).getFullContext()).toEqual(manager.getFullContext());
        expect(manager.getFullContext()).toMatchObject({ tablePositions: context.tablePositions, futureState: context.futureState });
    });

    it('notifies only changed groups and removes the optional field when the final group is removed', () => {
        const manager = make();
        const schedule = vi.spyOn(manager, '_scheduleNotifyChange').mockImplementation(() => {});
        expect(manager.setTableGroups([group])).toBe(true);
        expect(schedule).toHaveBeenCalledTimes(1);
        expect(manager.setTableGroups([{ ...group, color: '#AABBCC' }])).toBe(true);
        expect(schedule).toHaveBeenCalledTimes(1);
        expect(manager.setTableGroups(null)).toBe(false);
        expect(manager.tableGroups).toEqual([group]);
        expect(manager.setTableGroups([])).toBe(true);
        expect(schedule).toHaveBeenCalledTimes(2);
        expect(manager.getFullContext()).not.toHaveProperty('tableGroups');
        expect(manager.setTableGroups([])).toBe(true);
        expect(schedule).toHaveBeenCalledTimes(2);
    });

    it('uses the same sparse normalization for batch updates', () => {
        const manager = make();
        manager.batchUpdate({ tableGroups: [group, { id: 'duplicate', tableNames: ['public.orders'] }] });
        expect(manager.tableGroups).toEqual([group]);
        manager.batchUpdate({ tableGroups: 'invalid' });
        expect(manager.tableGroups).toEqual([group]);
        manager.batchUpdate({ tableGroups: [] });
        expect(manager.getFullContext()).not.toHaveProperty('tableGroups');
    });
});

describe('ContextManager — connector endpoint sides', () => {
    const relationKey = 'orders.customer_id->customers.id|fk_orders_customer';

    it('hydrates only valid sparse left/right endpoint overrides', () => {
        const cm = new ContextManager({
            connectorEndpointSides: {
                [relationKey]: { from: ' LEFT ', to: 'right' },
                corrupt: { from: 'top', to: 'bottom' },
            },
        });

        expect(cm.connectorEndpointSides).toEqual({ [relationKey]: { from: 'left', to: 'right' } });
    });

    it('sets each endpoint independently and supports returning either side to Auto', () => {
        const cm = make();

        expect(cm.setConnectorEndpointSide(relationKey, 'from', 'left')).toBe(true);
        expect(cm.setConnectorEndpointSide(relationKey, 'to', 'right')).toBe(true);
        expect(cm.getConnectorEndpointSides(relationKey)).toEqual({ from: 'left', to: 'right' });
        expect(cm.clearConnectorEndpointSide(relationKey, 'from')).toBe(true);
        expect(cm.getConnectorEndpointSides(relationKey)).toEqual({ to: 'right' });
        expect(cm.clearConnectorEndpointSide(relationKey, 'to')).toBe(true);
        expect(cm.connectorEndpointSides).toEqual({});
    });

    it('rejects invalid endpoints and side values without mutating persisted state', () => {
        const cm = make();

        expect(cm.setConnectorEndpointSide(relationKey, 'middle', 'left')).toBe(false);
        expect(cm.setConnectorEndpointSide(relationKey, 'from', 'top')).toBe(false);
        expect(cm.clearConnectorEndpointSide('', 'from')).toBe(false);
        expect(cm.connectorEndpointSides).toEqual({});
    });
});

describe('ContextManager — offset validation', () => {
    it('setOffset rejects NaN', () => {
        const cm = make();
        const ox = cm.offsetX;
        const oy = cm.offsetY;
        expect(cm.setOffset(NaN, 10)).toBe(false);
        expect(cm.setOffset(10, NaN)).toBe(false);
        expect(cm.offsetX).toBe(ox);
        expect(cm.offsetY).toBe(oy);
    });

    it('setOffset accepts negative finite values', () => {
        const cm = make();
        expect(cm.setOffset(-100, -200)).toBe(true);
        expect(cm.offsetX).toBe(-100);
        expect(cm.offsetY).toBe(-200);
    });

    it('rejects nonfinite offsets in paired and individual setters', () => {
        const cm = make();
        cm.setOffset(20, 30);
        expect(cm.setOffset(Infinity, 10)).toBe(false);
        expect(cm.setOffset(10, -Infinity)).toBe(false);
        expect(cm.setOffsetX(Infinity)).toBe(false);
        expect(cm.setOffsetY(-Infinity)).toBe(false);
        expect([cm.offsetX, cm.offsetY]).toEqual([20, 30]);
    });
});

describe('ContextManager — saved dictionary compatibility', () => {
    it.each(['broken', 12, [], null])('recovers malformed dictionary containers (%j) before canvas edits', invalid => {
        const cm = new ContextManager({ tablePositions: invalid, tableColors: invalid, tableCompactModes: invalid });
        expect(cm.setTablePosition('users', 10, 20)).toBe(true);
        expect(cm.setTableColor('users', '#123456')).toBe(true);
        expect(cm.setTableCompactMode('users', true)).toBe(true);
        const saved = JSON.parse(JSON.stringify(cm.getFullContext()));
        expect(saved).toMatchObject({ tablePositions: { users: { x: 10, y: 20 } }, tableColors: { users: '#123456' }, tableCompactModes: { users: true } });
    });

    it('round trips SQL identifiers that match object prototype keys through edits, batches and resets', () => {
        const cm = make();
        for (const name of ['__proto__', 'constructor', 'toString']) {
            expect(cm.getTablePosition(name)).toBeUndefined();
            expect(cm.getTableColor(name)).toBeUndefined();
            expect(cm.getTableHeaderTextMode(name)).toBe('auto');
            expect(cm.getTableCompactMode(name)).toBe(false);
            cm.setTablePosition(name, 10, 20);
            cm.setTableColor(name, '#123456');
            cm.setTableHeaderTextMode(name, 'white');
            cm.setTableCompactMode(name, true);
        }
        const saved = JSON.parse(JSON.stringify(cm.getFullContext()));
        const loaded = new ContextManager(saved);
        expect(loaded.getFullContext()).toEqual(saved);
        expect(loaded.getTablePosition('__proto__')).toEqual({ x: 10, y: 20 });
        expect(loaded.getTableColor('__proto__')).toBe('#123456');
        loaded.resetPositions();
        loaded.clearAllTableHeaderTextModes();
        loaded.batchUpdate(JSON.parse('{"tablePositions":{"__proto__":{"x":30,"y":40}},"tableHeaderTextModes":{"__proto__":"black"}}'));
        expect(JSON.parse(JSON.stringify(loaded.getFullContext()))).toMatchObject(JSON.parse('{"tablePositions":{"__proto__":{"x":30,"y":40}},"tableHeaderTextModes":{"__proto__":"black"}}'));
    });

    it('ignores invalid saved geometry and batch entries without poisoning valid canvas state', () => {
        const cm = new ContextManager({ zoom: Infinity, offsetX: NaN, offsetY: 'broken', tablePositions: { users: { x: 10, y: 20 }, invalid: { x: Infinity, y: 30 } }, tableColors: { users: '#123456', invalid: {} }, tableCompactModes: { users: true, invalid: 'false' } });
        expect(cm.hasExplicitZoomPan).toBe(false);
        expect([cm.zoom, cm.offsetX, cm.offsetY]).toEqual([1, 0, 0]);
        cm.batchUpdate({ tablePositions: { invalid: null, users: { x: Infinity, y: 30 } }, tableColors: { users: {} }, tableCompactModes: { users: 'false' } });
        expect(cm.tablePositions).toEqual({ users: { x: 10, y: 20 } });
        expect(cm.tableColors).toEqual({ users: '#123456' });
        expect(cm.tableCompactModes).toEqual({ users: true });
        expect(cm.setTablePosition('users', Infinity, 30)).toBe(false);
        expect(() => cm.bulkSetTablePositions({ invalid: null, users: { x: 20, y: 30 } })).not.toThrow();
        expect(cm.getTablePosition('users')).toEqual({ x: 20, y: 30 });
    });
});
