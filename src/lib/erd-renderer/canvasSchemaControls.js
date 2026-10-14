/** Accessible canvas controls; SQL validation/commits belong to the editor bridge. */
import { normalizedSqlColumnType } from '../sqlColumnTypes.js';
import { chooseColumnActionSide } from './columnActionPlacement.js';

const svgNS = 'http://www.w3.org/2000/svg';
const icons = { remove: '<path d="M18 6 6 18M6 6l12 12"/>', add: '<path d="M12 5v14M5 12h14"/>' };
const icon = (kind) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[kind]}</svg>`;

/** Controls use CSS coordinates; the runtime supplies its DPR-adjusted camera. */
export function createCanvasSchemaControls({ canvas, getSelectedTable, getTables, getColumns, getCamera, hitField, onEdit, dialect, getColumnOptions, hasExistingEndpoint, getConnectorSideCounts, getColumnLabelSides, onSelectTable, appearance = {} }) {
    const host = canvas.parentElement;
    const root = document.createElement('div');
    root.className = 'erd-schema-controls'; root.dataset.erdSchemaControls = 'true'; root.hidden = true;
    for (const [key, value] of Object.entries(appearance)) root.style.setProperty(`--erd-schema-${key}`, value);
    const overlay = document.createElementNS(svgNS, 'svg');
    overlay.classList.add('erd-schema-drag-preview'); overlay.setAttribute('aria-hidden', 'true'); overlay.hidden = true;
    const line = document.createElementNS(svgNS, 'path'); line.classList.add('erd-schema-drag-line');
    const targetRect = document.createElementNS(svgNS, 'rect'); targetRect.classList.add('erd-schema-drop-target');
    overlay.append(line, targetRect);
    const status = document.createElement('div');
    status.className = 'erd-schema-drag-status'; status.dataset.erdCreateStatus = 'true'; status.setAttribute('role', 'status'); status.hidden = true;
    host.append(overlay, root, status);
    let signature; let table; let drag; let form; let disposed = false; let lastPointer;
    const abort = new AbortController();
    const listen = (element, event, handler, options = {}) => element.addEventListener(event, handler, { ...options, signal: abort.signal });
    const edit = (action, options) => onEdit?.(action, options) || { ok: false, message: 'Finish the AI review before editing the schema.' };
    const button = (label, content, className = '') => {
        const element = document.createElement('button'); element.type = 'button'; element.className = className;
        element.setAttribute('aria-label', label); element.title = label; element.innerHTML = content; return element;
    };
    const closeForm = () => { form?.remove(); form = null; };
    const closeDrag = () => { drag = null; overlay.hidden = true; overlay.style.display = 'none'; status.hidden = true; canvas.classList.remove('erd-schema-edge-dragging'); };
    const actionFor = (to) => ({ kind: 'add-relationship', from: drag.from, to: to && { table: to.table, column: to.column } });
    const localPoint = (x, y) => {
        const camera = getCamera(); const rect = canvas.getBoundingClientRect(); const parent = host.getBoundingClientRect();
        return { x: x * camera.zoom + camera.offsetX + rect.left - parent.left, y: y * camera.zoom + camera.offsetY + rect.top - parent.top };
    };
    function updateDrag(event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        drag.moved ||= Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y) > 4;
        if (!drag.moved) return;
        const parent = host.getBoundingClientRect();
        const start = localPoint(drag.table.x + (drag.side === 'left' ? -1 : 1) * drag.table.width / 2, drag.table.y - drag.table.height / 2 + 30 + (drag.row + .5) * 28);
        const end = { x: event.clientX - parent.left, y: event.clientY - parent.top };
        const bend = (drag.side === 'left' ? -1 : 1) * Math.max(35, Math.abs(end.x - start.x) / 2);
        line.setAttribute('d', `M${start.x},${start.y} C${start.x + bend},${start.y} ${end.x - bend},${end.y} ${end.x},${end.y}`);
        const target = hitField(event.clientX, event.clientY);
        const key = JSON.stringify(target && [target.table, target.column]);
        if (key !== drag.key) {
            drag.key = key; drag.target = target;
            drag.previews ||= new Map();
            if (target && !drag.previews.has(key)) {
                if (drag.previews.size >= 48) drag.previews.clear();
                const result = edit(actionFor(target), { preview: true });
                // Keep verdicts only; candidate SQL is released after validation.
                drag.previews.set(key, { ok: result.ok, message: result.message });
            }
            drag.result = target ? drag.previews.get(key) : { ok: false, message: 'Drop onto a matching primary or unique key. Escape cancels.' };
        }
        const valid = drag.result?.ok === true;
        overlay.dataset.valid = String(valid); status.dataset.valid = String(valid);
        status.textContent = valid ? `${drag.from.table}.${drag.from.column} → ${target.table}.${target.column} · Release to connect` : drag.result?.message;
        targetRect.style.display = target ? '' : 'none';
        if (target) {
            const node = getTables().find((t) => t.name === target.table);
            const point = localPoint(node.x - node.width / 2, node.y - node.height / 2 + 30 + target.rowIndex * 28);
            const camera = getCamera();
            for (const [name, value] of Object.entries({ x: point.x, y: point.y, width: node.width * camera.zoom, height: 28 * camera.zoom, rx: 3 })) targetRect.setAttribute(name, value);
        }
        overlay.hidden = false; overlay.style.display = 'block'; status.hidden = false;
    }
    async function finishDrag(event, cancelled = false) {
        if (!drag || (!cancelled && event.pointerId !== drag.pointerId)) return;
        if (!cancelled) updateDrag(event);
        const previous = drag;
        const action = previous.target && actionFor(previous.target);
        closeDrag();
        if (!previous.moved || cancelled) return;
        // Revalidate live SQL at release; the preview never mutates a tab.
        const result = action ? await edit(action) : { ok: false, message: 'Drop onto a matching primary or unique key.' };
        if (disposed) return;
        if (!result.ok) { status.textContent = result.message; status.dataset.valid = 'false'; status.hidden = false; }
    }
    function showForm(column) {
        closeDrag(); closeForm();
        const owner = table.name;
        form = document.createElement('form'); form.className = 'erd-schema-inline-form'; form.setAttribute('aria-label', column ? 'Add connection' : 'Add column');
        const header = document.createElement('div'); header.className = 'erd-schema-inline-header';
        const title = document.createElement('div'); title.className = 'erd-schema-inline-title';
        const heading = document.createElement('strong'); heading.textContent = column ? `Connect ${column.name}` : 'Add column';
        heading.title = heading.textContent;
        const context = document.createElement('span'); context.className = 'erd-schema-inline-context'; context.textContent = owner; context.title = owner;
        title.append(heading, context);
        const close = button(column ? 'Close connection form' : 'Close add column', icon('remove'), 'erd-schema-inline-close');
        header.append(title, close);
        const fields = document.createElement('div'); fields.className = 'erd-schema-inline-fields';
        const error = document.createElement('p'); error.className = 'erd-schema-inline-error'; error.setAttribute('role', 'alert');
        const submit = button(column ? 'Connect' : 'Add column', column ? 'Connect' : 'Add', 'erd-schema-inline-submit'); submit.type = 'submit';
        let action;
        const input = (label, placeholder, caption) => {
            const field = document.createElement('label'); field.className = 'erd-schema-inline-field';
            const text = document.createElement('span'); text.textContent = caption;
            const element = document.createElement('input'); element.required = true; element.setAttribute('aria-label', label); element.placeholder = placeholder; element.autocomplete = 'off'; element.spellcheck = false;
            field.append(text, element); fields.append(field); return element;
        };
        let focus; let populateKeys;
        if (column) {
            const select = document.createElement('select'); select.setAttribute('aria-label', 'Referenced key'); fields.append(select); focus = select;
            const placeholder = document.createElement('option'); placeholder.textContent = 'Checking compatible keys…'; select.append(placeholder);
            select.disabled = true; submit.disabled = true;
            populateKeys = async () => {
                const currentForm = form; const openingFocus = document.activeElement;
                const choices = document.createDocumentFragment(); let revision; let deadline = performance.now() + 8;
                for (const node of getTables()) for (const candidate of node.columns) {
                    if ((!candidate.pk && !candidate.constraints.includes('UQ')) || normalizedSqlColumnType(candidate, dialect) !== normalizedSqlColumnType(column, dialect)) continue;
                    if (performance.now() >= deadline) { await new Promise((resolve) => setTimeout(resolve, 0)); deadline = performance.now() + 8; }
                    if (disposed || form !== currentForm) return;
                    const to = { table: node.name, column: candidate.name };
                    const nextAction = { kind: 'add-relationship', from: { table: owner, column: column.name }, to };
                    const result = edit(nextAction, { preview: true });
                    if (revision && result.revision !== revision) { error.textContent = 'SQL changed. Reopen this field to refresh its keys.'; update(); return; }
                    revision ||= result.revision;
                    if (!result.ok) continue;
                    const option = document.createElement('option'); option.value = JSON.stringify(to); option.textContent = `${node.name}.${candidate.name} · ${candidate.type}`; choices.append(option);
                }
                if (disposed || form !== currentForm) return;
                select.replaceChildren(choices); select.disabled = !select.options.length; submit.disabled = select.disabled;
                if (select.disabled) error.textContent = 'No compatible single-column keys available.';
                else if (document.activeElement === openingFocus) select.focus({ preventScroll: true });
                update();
            };
            action = () => ({ kind: 'add-relationship', from: { table: owner, column: column.name }, to: JSON.parse(select.value) });
        } else {
            const name = input('Column name', 'e.g. customer_id', 'Name'); name.maxLength = 128;
            const options = getColumnOptions?.(table) || {};
            const defaultDefinition = options.strict || dialect === 'sqlite' ? 'TEXT' : 'VARCHAR(255)';
            const definition = input('Column type and options', defaultDefinition, 'Type & options'); definition.maxLength = 1000;
            definition.value = defaultDefinition; focus = name;
            if (options.strict) {
                const types = document.createElement('datalist'); types.id = 'erd-strict-column-types';
                for (const value of ['INTEGER', 'INT', 'REAL', 'TEXT', 'BLOB', 'ANY']) { const option = document.createElement('option'); option.value = value; types.append(option); }
                definition.setAttribute('list', types.id); definition.title = 'SQLite STRICT types: INTEGER, INT, REAL, TEXT, BLOB, ANY'; fields.append(types);
            }
            action = () => ({ kind: 'add-column', table: owner, column: name.value, definition: definition.value });
        }
        const footer = document.createElement('div'); footer.className = 'erd-schema-inline-actions'; footer.append(submit);
        const body = document.createElement('div'); body.className = 'erd-schema-inline-body'; body.append(fields, footer);
        form.dataset.mode = column ? 'connection' : 'column';
        form.append(header, body, error); root.append(form);
        const dismiss = () => { closeForm(); root.querySelector('[data-add-column]')?.focus(); };
        close.addEventListener('click', dismiss);
        form.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); } });
        form.addEventListener('submit', async (event) => {
            event.preventDefault(); submit.disabled = true; const submittedForm = form;
            const result = await edit(action());
            if (disposed || form !== submittedForm) return;
            submit.disabled = false;
            if (result.ok) closeForm(); else { error.textContent = result.message; update(); }
        });
        // Forms stay fully visible on narrow canvases and at viewport edges.
        update(); focus.focus({ preventScroll: true });
        void populateKeys?.();
    }
    function update() {
        if (disposed) return;
        table = getSelectedTable();
        const rect = canvas.getBoundingClientRect(); const camera = getCamera();
        root.hidden = !table || !onEdit || !rect.width || !rect.height;
        if (root.hidden) { closeForm(); closeDrag(); return; }
        const columns = getColumns(table);
        const nextSignature = JSON.stringify([table.name, columns.map((c) => [c.name, c.type])]);
        if (signature !== nextSignature) {
            closeForm(); closeDrag(); root.replaceChildren(); signature = nextSignature;
            columns.forEach((column, row) => {
                const actions = document.createElement('div'); actions.className = 'erd-schema-row-actions'; actions.dataset.row = row;
                // A focus-only action gives keyboard users the same validated
                // connection choices. Pointer creation starts on the canvas edge.
                const connect = button(`Connect ${table.name}.${column.name}`, '↗', 'erd-schema-keyboard-connect'); connect.dataset.column = column.name;
                const remove = button(`Remove column ${table.name}.${column.name}`, icon('remove'), 'erd-schema-remove');
                const sourceTable = table;
                connect.addEventListener('click', () => showForm(column));
                remove.addEventListener('click', async () => { remove.disabled = true; await edit({ kind: 'remove-column', table: sourceTable.name, column: column.name }); if (!disposed) remove.disabled = false; });
                actions.append(connect, remove); root.append(actions);
            });
            const add = button(`Add column to ${table.name}`, icon('add'), 'erd-schema-add'); add.dataset.addColumn = 'true'; add.addEventListener('click', () => showForm()); root.append(add);
        }
        const corner = localPoint(table.x + table.width / 2, table.y - table.height / 2);
        root.style.setProperty('--erd-table-css-width', `${table.width * camera.zoom}px`);
        root.style.setProperty('--erd-column-css-height', `${28 * camera.zoom}px`);
        root.style.setProperty('--erd-column-action-width', `${Math.max(14, Math.min(24, 22 * camera.zoom))}px`);
        root.style.left = `${corner.x}px`; root.style.top = `${corner.y}px`;
        const pressure = getConnectorSideCounts?.(table.name);
        const labels = getColumnLabelSides?.(table);
        const actionWidth = Math.max(14, Math.min(24, 22 * camera.zoom));
        const parent = host.getBoundingClientRect();
        const available = {
            left: corner.x - table.width * camera.zoom - actionWidth >= rect.left - parent.left,
            right: corner.x + actionWidth <= rect.right - parent.left,
        };
        root.querySelectorAll('[data-row]').forEach((row) => {
            row.style.top = `${(30 + Number(row.dataset.row) * 28) * camera.zoom}px`;
            const current = row.dataset.side || 'left';
            const active = row.contains(document.activeElement) || row.contains(lastPointer?.target instanceof Node ? lastPointer.target : null);
            const column = columns[Number(row.dataset.row)].name;
            const blocked = labels?.get(column);
            // Keep the target still while it is being clicked or keyboard-used.
            // A label exclusion always wins, even over a pinned action.
            const side = !active || !available[current] || blocked?.[current]
                ? chooseColumnActionSide(pressure?.columns.get(column), pressure?.table, current, available, blocked)
                : current;
            row.dataset.side = side || current;
            // Each tab shares its column's exact height at every zoom level.
            row.hidden = !side;
        });
        const add = root.querySelector('[data-add-column]');
        add.style.top = `${table.height * camera.zoom + 3}px`; add.style.right = '0';
        if (lastPointer) updateHover(lastPointer);
        if (form) {
            const parent = host.getBoundingClientRect(); const width = Math.max(0, Math.min(304, rect.width - 16));
            form.style.width = `${width}px`;
            form.style.maxHeight = `${Math.max(0, rect.height - 16)}px`;
            form.style.left = `${Math.max(rect.left - parent.left + 8, Math.min(corner.x - width, rect.right - parent.left - width - 8)) - corner.x}px`;
            form.style.top = `${Math.max(rect.top - parent.top + 8, Math.min(corner.y + table.height * camera.zoom + 30, rect.bottom - parent.top - form.offsetHeight - 8)) - corner.y}px`;
        }
    }
    function edgeAt(event) {
        if (!onEdit || hasExistingEndpoint?.(event.clientX, event.clientY)) return null;
        const field = hitField(event.clientX, event.clientY);
        const node = field && getTables().find((t) => t.name === field.table);
        if (!node) return null;
        const parent = host.getBoundingClientRect(); const x = event.clientX - parent.left;
        const left = localPoint(node.x - node.width / 2, node.y).x;
        const right = localPoint(node.x + node.width / 2, node.y).x;
        const side = Math.abs(x - left) <= 7 ? 'left' : Math.abs(x - right) <= 7 ? 'right' : null;
        return side ? { field, node, side } : null;
    }
    function updateHover(event) {
        if (!table || root.hidden) return;
        const parent = host.getBoundingClientRect(); const corner = localPoint(table.x - table.width / 2, table.y - table.height / 2);
        const camera = getCamera(); const x = event.clientX - parent.left; const y = event.clientY - parent.top;
        const actionRow = event.target?.closest?.('.erd-schema-row-actions');
        const candidate = Math.floor((y - corner.y - 30 * camera.zoom) / (28 * camera.zoom));
        const action = root.querySelector(`[data-row="${candidate}"]`);
        const width = Math.max(14, Math.min(24, 22 * camera.zoom));
        const right = corner.x + table.width * camera.zoom;
        const inside = x >= corner.x && x <= right;
        const rail = action?.dataset.side === 'right' ? x > right && x <= right + width : x < corner.x && x >= corner.x - width;
        const row = actionRow && root.contains(actionRow) ? Number(actionRow.dataset.row) : inside || (action && rail) ? candidate : -1;
        root.querySelectorAll('[data-row]').forEach((element) => { element.dataset.hover = String(Number(element.dataset.row) === row); });
    }
    listen(canvas, 'pointerdown', (event) => {
        lastPointer = { clientX: event.clientX, clientY: event.clientY };
        if (event.button !== 0 || drag || event.isPrimary === false) return;
        const hit = edgeAt(event);
        if (!hit) return;
        closeForm(); closeDrag();
        onSelectTable?.(hit.node); update();
        drag = { from: { table: hit.field.table, column: hit.field.column }, table: hit.node, row: hit.field.rowIndex, side: hit.side,
            pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, moved: false };
        canvas.classList.add('erd-schema-edge-dragging');
        canvas.focus({ preventScroll: true });
        event.preventDefault(); event.stopImmediatePropagation();
    }, { capture: true });
    // Pointer events own new connections; avoid starting the legacy touch pan
    // from the same contact. A second contact cancels creation for pinch zoom.
    listen(canvas, 'touchstart', (event) => {
        if (!drag) return;
        if (event.touches.length > 1) { closeDrag(); return; }
        event.preventDefault(); event.stopImmediatePropagation();
    }, { capture: true, passive: false });
    for (const event of ['mousedown', 'touchstart', 'dblclick']) listen(root, event, (e) => e.stopPropagation());
    listen(window, 'pointermove', (event) => {
        lastPointer = { clientX: event.clientX, clientY: event.clientY, target: event.target };
        updateHover(event);
        if (drag) updateDrag(event);
        else canvas.classList.toggle('erd-schema-edge-hover', event.target === canvas && Boolean(edgeAt(event)));
    });
    listen(canvas, 'pointerleave', () => canvas.classList.remove('erd-schema-edge-hover'));
    listen(window, 'pointerup', (event) => { void finishDrag(event); });
    listen(window, 'pointercancel', (event) => { if (drag?.pointerId === event.pointerId) void finishDrag(event, true); });
    listen(window, 'blur', closeDrag);
    listen(document, 'keydown', (event) => { if (event.key === 'Escape' && drag) { event.preventDefault(); void finishDrag(event, true); } });
    listen(document, 'pointerdown', (event) => { if (!root.contains(event.target)) { closeForm(); if (!drag) status.hidden = true; } });
    canvas.classList.remove('erd-schema-edge-hover', 'erd-schema-edge-dragging');
    return { update, dispose() { disposed = true; abort.abort(); root.remove(); overlay.remove(); status.remove(); drag = null; canvas.classList.remove('erd-schema-edge-hover', 'erd-schema-edge-dragging'); } };
}
