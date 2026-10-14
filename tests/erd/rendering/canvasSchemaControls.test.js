// @vitest-environment jsdom
import { fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvasSchemaControls } from '@/lib/erd-renderer/canvasSchemaControls';
let controls;
afterEach(() => { controls?.dispose(); document.body.replaceChildren(); });
function setup(onEdit = vi.fn(() => ({ ok: true })), extra = {}) {
    const host = document.createElement('div'); const canvas = document.createElement('canvas'); host.append(canvas); document.body.append(host);
    host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 400 }); canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400 });
    const table = { name: 'c', x: 150, y: 100, width: 160, height: 86, columns: [{ name: 'id', type: 'INT', constraints: [] }, { name: 'note', type: 'TEXT', constraints: [] }] };
    const key = { name: 'p', x: 450, y: 100, width: 160, height: 58, columns: [{ name: 'id', type: 'INTEGER', pk: true, constraints: [] }] };
    let selected = table;
    controls = createCanvasSchemaControls({ canvas, getSelectedTable: () => selected, getTables: () => [table, key], getColumns: (t) => t.columns, getCamera: () => ({ zoom: 1, offsetX: 0, offsetY: 0 }), hitField: (x) => x < 250 ? { table: 'c', column: 'id', rowIndex: 0 } : { table: 'p', column: 'id', rowIndex: 0 }, onEdit, dialect: 'sqlite', ...extra }); controls.update();
    return { canvas, root: host.querySelector('[data-erd-schema-controls]'), onEdit, deselect: () => { selected = null; controls.update(); } };
}
function pointer(element, type, x = 0, y = 0) { const event = new Event(type, { bubbles: true, cancelable: true }); Object.assign(event, { pointerId: 1, clientX: x, clientY: y, button: 0 }); element.dispatchEvent(event); }
describe('direct canvas controls', () => {
    it('uses table-specific STRICT defaults even in a mixed SQL workspace', () => {
        const { root } = setup(undefined, { dialect: 'auto', getColumnOptions: () => ({ strict: true }) });
        fireEvent.click(root.querySelector('[data-add-column]'));
        const definition = root.querySelector('[aria-label="Column type and options"]');
        expect(definition.value).toBe('TEXT'); expect(definition.getAttribute('list')).toBe('erd-strict-column-types');
        expect([...root.querySelectorAll('datalist option')].map(o => o.value)).toEqual(['INTEGER', 'INT', 'REAL', 'TEXT', 'BLOB', 'ANY']);
    });
    it('has small row actions and an inline form without a table-editor dialog', () => {
        const { root, onEdit } = setup();
        expect(document.querySelector('[data-erd-table-edit]')).toBeNull(); expect(root.querySelectorAll('[data-row]')).toHaveLength(2);
        expect(root.querySelector('[data-add-column]').textContent).toBe(''); expect(root.querySelector('[data-add-column] svg')).not.toBeNull();
        expect(root.querySelector('[data-add-column]').title).toBe('Add column to c');
        fireEvent.click(root.querySelector('[data-add-column]'));
        const form = root.querySelector('form'); expect(form.getAttribute('aria-label')).toBe('Add column');
        expect(form.querySelector('.erd-schema-inline-context').textContent).toBe('c');
        expect([...form.querySelectorAll('label > span')].map((label) => label.textContent)).toEqual(['Name', 'Type & options']);
        fireEvent.change(form.querySelector('[aria-label="Column name"]'), { target: { value: 'price' } });
        fireEvent.change(form.querySelector('[aria-label="Column type and options"]'), { target: { value: 'REAL' } });
        fireEvent.submit(form); expect(onEdit).toHaveBeenCalledWith({ kind: 'add-column', table: 'c', column: 'price', definition: 'REAL' }, undefined);
    });
    it('closes the compact form with × and returns focus to its add trigger', () => {
        const { root, onEdit } = setup(); const add = root.querySelector('[data-add-column]');
        fireEvent.click(add); fireEvent.click(root.querySelector('[aria-label="Close add column"]'));
        expect(root.querySelector('form')).toBeNull(); expect(document.activeElement).toBe(add); expect(onEdit).not.toHaveBeenCalled();
    });
    it('shows validation feedback without discarding entered fields', async () => {
        const { root } = setup(vi.fn(() => ({ ok: false, message: 'Invalid native type' })));
        fireEvent.click(root.querySelector('[data-add-column]')); const form = root.querySelector('form');
        form.querySelector('input').value = 'price'; fireEvent.submit(form); await Promise.resolve();
        expect(root.querySelector('[role="alert"]').textContent).toBe('Invalid native type'); expect(form.querySelector('input').value).toBe('price');
    });
    it('ignores a late submit response after closing and reopening the form', async () => {
        let finish; const { root } = setup(vi.fn(() => new Promise((resolve) => { finish = resolve; })));
        fireEvent.click(root.querySelector('[data-add-column]')); const original = root.querySelector('form');
        original.querySelector('input').value = 'old'; fireEvent.submit(original);
        fireEvent.click(original.querySelector('[aria-label="Close add column"]'));
        fireEvent.click(root.querySelector('[data-add-column]')); const replacement = root.querySelector('form');
        replacement.querySelector('input').value = 'new'; finish({ ok: false, message: 'Old validation' }); await Promise.resolve();
        expect(root.querySelector('form')).toBe(replacement); expect(replacement.querySelector('input').value).toBe('new');
        expect(replacement.querySelector('[role="alert"]').textContent).toBe('');
    });
    it('offers only keys that pass the exact SQL validator for keyboard connections', async () => {
        const { root } = setup(vi.fn((action) => ({ ok: action.from.column === 'id' })));
        fireEvent.click(root.querySelector('.erd-schema-keyboard-connect')); const select = root.querySelector('select');
        // Choices can yield while validating even a small schema on a busy host.
        await waitFor(() => expect([...select.options].map((o) => o.textContent)).toEqual(['p.id · INTEGER']));
    });
    it('Escape cancels a pointer drag after preview without any commit', () => {
        const { canvas, onEdit } = setup(); pointer(canvas, 'pointerdown', 230, 100); pointer(window, 'pointermove', 450, 115);
        expect(document.querySelector('[data-erd-create-status]').dataset.valid).toBe('true');
        fireEvent.keyDown(document, { key: 'Escape' }); pointer(window, 'pointerup', 450, 115);
        expect(onEdit.mock.calls.every((call) => call[1]?.preview)).toBe(true);
    });
    it('revalidates at drop and commits once, while pointer cancellation commits nothing', async () => {
        const { canvas, onEdit } = setup(); const port = canvas;
        pointer(port, 'pointerdown', 230, 100); pointer(window, 'pointermove', 450, 115); pointer(window, 'pointercancel');
        expect(onEdit.mock.calls.every((call) => call[1]?.preview)).toBe(true); onEdit.mockClear();
        pointer(port, 'pointerdown', 230, 100); pointer(window, 'pointermove', 450, 115); pointer(window, 'pointerup', 450, 115); await Promise.resolve();
        expect(onEdit.mock.calls.filter((call) => !call[1]?.preview)).toHaveLength(1);
    });
    it('creates from the left column edge and uses a × action', () => {
        const { canvas, root, onEdit } = setup();
        pointer(canvas, 'pointerdown', 70, 100); pointer(window, 'pointermove', 450, 115); pointer(window, 'pointerup', 450, 115);
        expect(onEdit.mock.calls.filter((c) => !c[1]?.preview)).toHaveLength(1);
        expect(root.querySelector('.erd-schema-remove').innerHTML).toContain('M18 6');
    });
    it('allows the existing endpoint gesture to proceed instead of starting creation', () => {
        const { canvas, onEdit } = setup(undefined, { hasExistingEndpoint: () => true });
        pointer(canvas, 'pointerdown', 230, 100); pointer(window, 'pointermove', 450, 115); pointer(window, 'pointerup', 450, 115);
        expect(onEdit).not.toHaveBeenCalled();
    });
    it('shows × only on the hovered column of the selected table', () => {
        const { root } = setup(); pointer(window, 'pointermove', 150, 100);
        expect(root.querySelector('[data-row="0"]').dataset.hover).toBe('true'); expect(root.querySelector('[data-row="1"]').dataset.hover).toBe('false');
        pointer(window, 'pointermove', 450, 300); expect(root.querySelector('[data-row="0"]').dataset.hover).toBe('false');
    });
    it('places × opposite the column connectors and keeps hover in either action rail', () => {
        const { root } = setup(undefined, { getConnectorSideCounts: () => ({ columns: new Map([['id', { left: 2, right: 0 }]]), table: { left: 2, right: 0 } }) });
        const row = root.querySelector('[data-row="0"]'); expect(row.dataset.side).toBe('right');
        pointer(window, 'pointermove', 240, 100); expect(row.dataset.hover).toBe('true');
        pointer(window, 'pointermove', 60, 100); expect(row.dataset.hover).toBe('false');
        pointer(row.querySelector('.erd-schema-remove'), 'pointermove', 240, 100); expect(row.dataset.hover).toBe('true');
    });
    it('updates routing pressure without moving a pointer or keyboard action that is in use', () => {
        const pressure = { columns: new Map([['id', { left: 1, right: 0 }]]), table: { left: 1, right: 0 } };
        const { root } = setup(undefined, { getConnectorSideCounts: () => pressure });
        const row = root.querySelector('[data-row="0"]'); const remove = row.querySelector('.erd-schema-remove'); expect(row.dataset.side).toBe('right');
        pointer(remove, 'pointermove', 240, 100); pressure.columns.set('id', { left: 0, right: 1 }); controls.update(); expect(row.dataset.side).toBe('right');
        pointer(window, 'pointermove', 150, 100); controls.update(); expect(row.dataset.side).toBe('left');
        remove.focus(); pressure.columns.set('id', { left: 1, right: 0 }); controls.update(); expect(row.dataset.side).toBe('left');
        remove.blur(); controls.update(); expect(row.dataset.side).toBe('right');
    });
    it('moves a pinned right action away from a newly displayed constraint note', () => {
        const labels = new Map();
        const { root } = setup(undefined, { getConnectorSideCounts: () => ({ columns: new Map([['id', { left: 4, right: 0 }]]), table: { left: 4, right: 0 } }), getColumnLabelSides: () => labels });
        const row = root.querySelector('[data-row="0"]'); const remove = row.querySelector('.erd-schema-remove'); expect(row.dataset.side).toBe('right');
        remove.focus(); labels.set('id', { left: false, right: true }); controls.update(); expect(row.dataset.side).toBe('left');
        expect(document.activeElement).toBe(remove);
    });
    it('keeps the hovered × available below the normal fit-to-canvas zoom', () => {
        const { root } = setup(undefined, { getCamera: () => ({ zoom: .5, offsetX: 0, offsetY: 0 }) });
        pointer(window, 'pointermove', 75, 50);
        const row = root.querySelector('[data-row="0"]'); expect(row.hidden).toBe(false); expect(row.dataset.hover).toBe('true');
        expect(root.style.getPropertyValue('--erd-column-css-height')).toBe('14px'); expect(row.style.top).toBe('15px');
        // Moving into the left action rail must not lose the hovered field.
        pointer(row.querySelector('.erd-schema-remove'), 'pointermove', 22, 50); expect(row.dataset.hover).toBe('true');
        expect(root.querySelector('[data-row="1"]').dataset.hover).toBe('false');
    });
    it('deselection cancels a form and disposal removes all global pointer handlers', () => {
        const { root, onEdit, deselect } = setup(); fireEvent.click(root.querySelector('[data-add-column]')); deselect(); expect(root.hidden).toBe(true); expect(root.querySelector('form')).toBeNull();
        controls.dispose(); pointer(window, 'pointermove', 1, 1); pointer(window, 'pointerup', 1, 1); expect(onEdit).not.toHaveBeenCalled(); expect(document.querySelector('[data-erd-schema-controls]')).toBeNull();
    });
});
