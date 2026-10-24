/** Header-only pointer gestures preview member positions, then persist once on release. */
import { getTableGroupHeaderAtPoint } from './tableGroups.js';

export function createTableGroupInteraction({ canvas, getFrames, getTables, screenToWorld, isActive, onPreview, onCommit, onEdit, onStart }) {
    let drag = null;
    let frameId = null;
    let pendingPoint = null;

    function headerAt(clientX, clientY) {
        const point = screenToWorld(clientX, clientY);
        // Existing table cards always win over a frame overlapping another group.
        if (getTables().some(table => point.x >= table.x - table.width / 2 && point.x <= table.x + table.width / 2 && point.y >= table.y - table.height / 2 && point.y <= table.y + table.height / 2)) return null;
        return getTableGroupHeaderAtPoint(getFrames(), point.x, point.y);
    }

    function applyPreview() {
        frameId = null;
        if (!drag || !pendingPoint || !isActive()) return;
        const point = screenToWorld(pendingPoint.clientX, pendingPoint.clientY);
        const dx = point.x - drag.start.x;
        const dy = point.y - drag.start.y;
        if (!drag.moved && Math.hypot(pendingPoint.clientX - drag.clientX, pendingPoint.clientY - drag.clientY) < 3) return;
        drag.moved = true;
        for (const member of drag.members) {
            member.table.x = member.x + dx;
            member.table.y = member.y + dy;
        }
        onPreview();
    }

    function removeDragListeners() {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', release, true);
        window.removeEventListener('pointercancel', cancel, true);
        window.removeEventListener('pointerdown', additionalPointer, true);
        window.removeEventListener('keydown', keydown, true);
        window.removeEventListener('blur', cancel);
        window.removeEventListener('resize', cancel);
        if (frameId !== null) cancelAnimationFrame(frameId);
        frameId = null;
    }

    function finish(cancelled) {
        if (!drag) return;
        const current = drag;
        if (frameId !== null) cancelAnimationFrame(frameId);
        frameId = null;
        if (!cancelled && isActive()) applyPreview();
        removeDragListeners();
        drag = null;
        pendingPoint = null;
        canvas.style.cursor = 'default';
        if (cancelled || !isActive()) {
            for (const member of current.members) Object.assign(member.table, { x: member.x, y: member.y });
            onPreview();
        } else if (current.moved) {
            onCommit(Object.fromEntries(current.members.map(({ table }) => [table.name, { x: table.x, y: table.y }])));
        } else {
            onEdit?.(current.id);
        }
    }

    function move(event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (!isActive()) { finish(true); return; }
        event.preventDefault();
        event.stopImmediatePropagation();
        pendingPoint = { clientX: event.clientX, clientY: event.clientY };
        if (frameId === null) frameId = requestAnimationFrame(applyPreview);
    }

    function release(event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        pendingPoint = { clientX: event.clientX, clientY: event.clientY };
        finish(false);
    }

    function cancel() { finish(true); }
    function additionalPointer(event) {
        if (drag && event.pointerId !== drag.pointerId) cancel();
    }
    function keydown(event) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel();
    }

    function start(event) {
        if (event.button !== 0 || !event.isPrimary || !isActive() || drag) return;
        const group = headerAt(event.clientX, event.clientY);
        if (!group) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const names = new Set(group.tableNames);
        drag = {
            id: group.id, pointerId: event.pointerId,
            clientX: event.clientX, clientY: event.clientY,
            start: screenToWorld(event.clientX, event.clientY), moved: false,
            members: getTables().filter(table => names.has(table.name)).map(table => ({ table, x: table.x, y: table.y })),
        };
        onStart?.();
        canvas.style.cursor = 'grabbing';
        window.addEventListener('pointermove', move, { capture: true, passive: false });
        window.addEventListener('pointerup', release, true);
        window.addEventListener('pointercancel', cancel, true);
        window.addEventListener('pointerdown', additionalPointer, true);
        window.addEventListener('keydown', keydown, true);
        window.addEventListener('blur', cancel);
        window.addEventListener('resize', cancel);
    }

    // Suppress compatibility mouse/touch events only during a group gesture.
    function compatibility(event) {
        if (!drag) return;
        if (event.touches?.length >= 2) { cancel(); return; }
        event.preventDefault();
        event.stopImmediatePropagation();
    }
    canvas.addEventListener('pointerdown', start, true);
    canvas.addEventListener('mousedown', compatibility, true);
    canvas.addEventListener('mousemove', compatibility, true);
    canvas.addEventListener('touchstart', compatibility, { capture: true, passive: false });
    canvas.addEventListener('touchmove', compatibility, { capture: true, passive: false });
    canvas.addEventListener('wheel', cancel, true);
    return {
        cancel,
        dispose() {
            cancel();
            canvas.removeEventListener('pointerdown', start, true);
            canvas.removeEventListener('mousedown', compatibility, true);
            canvas.removeEventListener('mousemove', compatibility, true);
            canvas.removeEventListener('touchstart', compatibility, true);
            canvas.removeEventListener('touchmove', compatibility, true);
            canvas.removeEventListener('wheel', cancel, true);
        },
    };
}
