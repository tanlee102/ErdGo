/** SQL canvas groups are optional presentation state; table identifiers retain SQL spelling. */
const GROUP_LIMIT = 50;
const FRAME_PADDING = 24;
const HEADER_HEIGHT = 32;

export function normalizeTableGroups(value) {
    if (!Array.isArray(value)) return [];
    const groups = [];
    const ids = new Set();
    const assignedTables = new Set();

    for (const item of value) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        if (!id || ids.has(id) || !Array.isArray(item.tableNames)) continue;
        const tableNames = [];
        const members = new Set();
        for (const tableName of item.tableNames) {
            // Quoted/qualified SQL identifiers can include significant spaces.
            // Validate emptiness without changing the identity used by the schema.
            if (typeof tableName !== 'string' || !tableName.trim() || members.has(tableName) || assignedTables.has(tableName)) continue;
            members.add(tableName);
            tableNames.push(tableName);
        }
        if (!tableNames.length) continue;
        const name = typeof item.name === 'string' ? item.name.trim().slice(0, 160) : '';
        const color = typeof item.color === 'string' && /^#[0-9a-f]{6}$/i.test(item.color.trim()) ? item.color.trim().toLowerCase() : null;
        groups.push({ id, name: name || 'Group', tableNames, ...(color && { color }) });
        ids.add(id);
        tableNames.forEach(tableName => assignedTables.add(tableName));
        if (groups.length === GROUP_LIMIT) break;
    }
    return groups;
}

/** Frames follow live cards; absent members stay saved so parse errors and undo cannot erase groups. */
export function getTableGroupFrames(groups, tables) {
    if (!Array.isArray(groups) || groups.length === 0) return [];
    const liveTables = new Map();
    for (const table of Array.isArray(tables) ? tables : []) {
        if (!table || typeof table.name !== 'string' || ![table.x, table.y, table.width, table.height].every(Number.isFinite) || table.width <= 0 || table.height <= 0) continue;
        liveTables.set(table.name, table);
    }

    return normalizeTableGroups(groups).flatMap(group => {
        let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
        for (const tableName of group.tableNames) {
            const table = liveTables.get(tableName);
            if (!table) continue;
            left = Math.min(left, table.x - table.width / 2);
            right = Math.max(right, table.x + table.width / 2);
            top = Math.min(top, table.y - table.height / 2);
            bottom = Math.max(bottom, table.y + table.height / 2);
        }
        if (![left, top, right, bottom].every(Number.isFinite)) return [];
        top -= FRAME_PADDING + HEADER_HEIGHT;
        bottom += FRAME_PADDING;
        const width = Math.max(160, right - left + FRAME_PADDING * 2);
        const height = bottom - top;
        // Center coordinates match table geometry, including fit/export helpers.
        return [{ ...group, x: (left + right) / 2, y: (top + bottom) / 2, width, height }];
    });
}

/** Only the header captures gestures; the body keeps normal table, connector and pan interactions. */
export function getTableGroupHeaderAtPoint(frames, x, y) {
    if (!Array.isArray(frames) || ![x, y].every(Number.isFinite)) return null;
    for (let index = frames.length - 1; index >= 0; index--) {
        const frame = frames[index];
        if (!frame || ![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite)) continue;
        const left = frame.x - frame.width / 2;
        const top = frame.y - frame.height / 2;
        if (x >= left && x <= left + frame.width && y >= top && y <= top + HEADER_HEIGHT) return frame;
    }
    return null;
}
