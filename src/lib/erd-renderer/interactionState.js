/**
 * Pure selection and layering state for interactive ERD relationships.
 * This module must remain independent from canvas drawing and browser events so
 * hover/selection behavior can be tested as plain data transformations.
 */
export function getRelationshipFieldKey(tableName, columnName) {
    return `${String(tableName ?? '')}\u0000${String(columnName ?? '')}`;
}

export function getSelectedRelationshipFieldKeys(connectorPaths, selectedTableName) {
    const keys = new Set();
    if (!selectedTableName || !Array.isArray(connectorPaths)) return keys;

    connectorPaths.forEach((conn) => {
        const rel = conn?.relation;
        if (!rel?.from || !rel?.to) return;
        if (!Array.isArray(conn.points) || conn.points.length < 2) return;
        if (rel.from.table !== selectedTableName && rel.to.table !== selectedTableName) return;

        if (rel.from.table && rel.from.column) {
            keys.add(getRelationshipFieldKey(rel.from.table, rel.from.column));
        }
        if (rel.to.table && rel.to.column) {
            keys.add(getRelationshipFieldKey(rel.to.table, rel.to.column));
        }
    });

    return keys;
}

export function getPriorityLayerState(connectorPaths, priorityTableNames) {
    const priorityTables = new Set();
    if (Array.isArray(priorityTableNames)) {
        priorityTableNames.forEach((tableName) => {
            if (typeof tableName === 'string' && tableName.trim()) {
                priorityTables.add(tableName.trim());
            }
        });
    }

    const visibleTables = new Set(priorityTables);
    const connectorIndexes = new Set();
    if (priorityTables.size === 0 || !Array.isArray(connectorPaths)) {
        return {
            active: priorityTables.size > 0,
            priorityTables,
            visibleTables,
            connectorIndexes,
        };
    }

    connectorPaths.forEach((conn, idx) => {
        const rel = conn?.relation;
        if (!rel?.from || !rel?.to) return;
        if (!Array.isArray(conn.points) || conn.points.length < 2) return;

        const touchesPriority = priorityTables.has(rel.from.table) || priorityTables.has(rel.to.table);
        if (!touchesPriority) return;

        connectorIndexes.add(idx);
        if (rel.from.table) visibleTables.add(rel.from.table);
        if (rel.to.table) visibleTables.add(rel.to.table);
    });

    return {
        active: true,
        priorityTables,
        visibleTables,
        connectorIndexes,
    };
}

export function getLivePriorityTableNames(tables, priorityTableNames) {
    if (!Array.isArray(tables) || !Array.isArray(priorityTableNames)) return [];

    const liveTableNames = new Set();
    tables.forEach((table) => {
        if (typeof table?.name === 'string' && table.name.trim()) {
            liveTableNames.add(table.name.trim());
        }
    });

    const livePriorityTableNames = [];
    const seen = new Set();
    priorityTableNames.forEach((tableName) => {
        if (typeof tableName !== 'string') return;
        const normalizedName = tableName.trim();
        if (!normalizedName || seen.has(normalizedName) || !liveTableNames.has(normalizedName)) return;
        seen.add(normalizedName);
        livePriorityTableNames.push(normalizedName);
    });
    return livePriorityTableNames;
}

export function getColumnHoverTreatment({ isSelectedRelationField, isHoverHighlighted } = {}) {
    return {
        fillHover: Boolean(isHoverHighlighted && !isSelectedRelationField),
        outlineHover: Boolean(isHoverHighlighted && isSelectedRelationField),
    };
}
