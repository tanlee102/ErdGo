/** Field hit testing shared by mouse and touch connector reconnection. */
export function findConnectorDropField(tables, x, y, { getColumns, headerHeight = 30, rowHeight = 28, edgeMargin = 0 } = {}) {
    for (let i = tables.length - 1; i >= 0; i -= 1) {
        const table = tables[i];
        if (x < table.x - table.width / 2 - edgeMargin || x > table.x + table.width / 2 + edgeMargin) continue;
        if (y < table.y - table.height / 2 || y > table.y + table.height / 2) continue;
        const rowIndex = Math.floor((y - (table.y - table.height / 2) - headerHeight) / rowHeight);
        const column = (getColumns?.(table) || table.columns)[rowIndex];
        // A foreground header/body occludes the table behind it, even when
        // that foreground area is not itself a field drop target.
        return column ? { table: table.name, column: column.name, rowIndex } : null;
    }
    return null;
}
