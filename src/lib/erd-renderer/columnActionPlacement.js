/** Count actual routed ends, including both ends of self-referencing links. */
export function countColumnConnectorSides(connectors, tableName) {
    const columns = new Map();
    const table = { left: 0, right: 0 };
    for (const connector of connectors || []) {
        if (!Array.isArray(connector?.points) || connector.points.length < 2) continue;
        for (const endpoint of ['from', 'to']) {
            const field = connector.relation?.[endpoint];
            const side = connector[`${endpoint}Side`];
            if (field?.table !== tableName || !field.column || !['left', 'right'].includes(side)) continue;
            if (!columns.has(field.column)) columns.set(field.column, { left: 0, right: 0 });
            columns.get(field.column)[side] += 1;
            table[side] += 1;
        }
    }
    return { columns, table };
}

/** Reserve outside column notes before considering any connector traffic. */
export function getColumnLabelSides(columns, enumMap = {}, compositeMap = {}, hoveredIndex = -1) {
    const blocked = new Map();
    const lines = (column) => (enumMap[column.type]?.length || 0) + (compositeMap[column.type]?.length || 0) + (Array.isArray(column.extras) ? column.extras.length : 0);
    columns.forEach((column) => { if (lines(column)) blocked.set(column.name, { left: false, right: true }); });
    if (Number.isInteger(hoveredIndex) && columns[hoveredIndex]) {
        const count = lines(columns[hoveredIndex]);
        // Native note boxes start at the row top and extend 1–3px below their
        // last line. Protect that adjacent row too, including keyboard actions.
        if (count) for (let i = hoveredIndex; i <= hoveredIndex + count && i < columns.length; i += 1) blocked.set(columns[i].name, { left: false, right: true });
    }
    return blocked;
}

/** Labels are a hard exclusion; connectors are only a placement preference. */
export function chooseColumnActionSide(column = {}, table = {}, previous = 'left', available = { left: true, right: true }, labels = {}) {
    if (labels.left && labels.right) return null;
    if (labels.left || labels.right) return labels.left ? 'right' : 'left';
    if (available.left !== available.right) return available.left ? 'left' : 'right';
    const count = (counts, side) => Number.isFinite(counts?.[side]) && counts[side] > 0 ? counts[side] : 0;
    for (const counts of [column, table]) {
        const left = count(counts, 'left'); const right = count(counts, 'right');
        if (left !== right) return left < right ? 'left' : 'right';
    }
    // Tie stability prevents harmless rerenders from moving a hovered action.
    return previous === 'right' ? 'right' : 'left';
}
