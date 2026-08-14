/**
 * Pure ERD layout analysis and geometry.
 *
 * No DOM, canvas, ELK instance, or persisted context belongs here. The module
 * selects strategies and produces coordinates/edges; genErdScript owns the
 * asynchronous layout engine and applies the resulting positions.
 */
export const LAYOUT_MODES = Object.freeze({
    BEST: 'best',
    LEFT_TO_RIGHT: 'left-to-right',
    RIGHT_TO_LEFT: 'right-to-left',
    SNOWFLAKE: 'snowflake',
});

export const SMART_LAYOUT_STRATEGIES = Object.freeze({
    GRID: 'grid',
    LAYERED: 'layered',
    RADIAL: 'radial',
});

const LAYOUT_MODE_ORDER = [LAYOUT_MODES.BEST, LAYOUT_MODES.LEFT_TO_RIGHT, LAYOUT_MODES.RIGHT_TO_LEFT, LAYOUT_MODES.SNOWFLAKE];
export const LAYOUT_MODE_OPTIONS = [
    {
        mode: LAYOUT_MODES.BEST,
        title: 'Best (Auto)',
        note: 'Chooses hierarchy, snowflake, or grid from the table relationships.',
    },
    {
        mode: LAYOUT_MODES.LEFT_TO_RIGHT,
        title: 'Left to Right (LR)',
        note: 'Classic directional flow; good for most transactional schemas.',
    },
    {
        mode: LAYOUT_MODES.RIGHT_TO_LEFT,
        title: 'Right to Left (RL)',
        note: 'Mirrored directional flow; useful when reading from right side.',
    },
    {
        mode: LAYOUT_MODES.SNOWFLAKE,
        title: 'Snowflake (SF)',
        note: 'Most-connected table in center; ideal for warehouse-style models.',
    },
];

export function normalizeLayoutMode(layoutMode) {
    return LAYOUT_MODE_ORDER.includes(layoutMode) ? layoutMode : LAYOUT_MODES.BEST;
}

export function getLayoutModeLabel(layoutMode) {
    switch (layoutMode) {
        case LAYOUT_MODES.BEST:
            return 'BE';
        case LAYOUT_MODES.RIGHT_TO_LEFT:
            return 'RL';
        case LAYOUT_MODES.SNOWFLAKE:
            return 'SF';
        case LAYOUT_MODES.LEFT_TO_RIGHT:
        default:
            return 'LR';
    }
}

/**
 * Place a toolbar popover inside the visible ERD panel. The right toolbar is
 * intentionally scrollable, so its popovers use fixed positioning to avoid
 * being clipped by the toolbar's overflow container.
 */
export function getToolbarPopupPosition({ triggerRect, popupRect, bounds, gap = 8, margin = 8 }) {
    const popupWidth = Math.max(0, Number(popupRect?.width) || 0);
    const popupHeight = Math.max(0, Number(popupRect?.height) || 0);
    const minLeft = (Number(bounds?.left) || 0) + margin;
    const minTop = (Number(bounds?.top) || 0) + margin;
    const boundsRight = Number.isFinite(Number(bounds?.right)) ? Number(bounds.right) : minLeft + popupWidth;
    const boundsBottom = Number.isFinite(Number(bounds?.bottom)) ? Number(bounds.bottom) : minTop + popupHeight;
    const maxLeft = Math.max(minLeft, boundsRight - margin - popupWidth);
    const maxTop = Math.max(minTop, boundsBottom - margin - popupHeight);
    const triggerLeft = Number(triggerRect?.left) || minLeft;
    const triggerRight = Number(triggerRect?.right) || triggerLeft;
    const triggerTop = Number(triggerRect?.top) || minTop;
    const triggerBottom = Number(triggerRect?.bottom) || triggerTop;
    const triggerCenterX = (triggerLeft + triggerRight) / 2;
    const triggerCenterY = (triggerTop + triggerBottom) / 2;

    let placement = 'left';
    let left = triggerLeft - gap - popupWidth;
    let top = triggerCenterY - popupHeight / 2;

    if (left < minLeft) {
        const rightPlacement = triggerRight + gap;
        if (rightPlacement + popupWidth <= boundsRight - margin) {
            placement = 'right';
            left = rightPlacement;
        } else {
            placement = 'stacked';
            left = triggerCenterX - popupWidth / 2;
            const below = triggerBottom + gap;
            const above = triggerTop - gap - popupHeight;
            top = below + popupHeight <= boundsBottom - margin ? below : above >= minTop ? above : triggerCenterY - popupHeight / 2;
        }
    }

    left = Math.max(minLeft, Math.min(left, maxLeft));
    top = Math.max(minTop, Math.min(top, maxTop));
    const arrowTop = Math.max(16, Math.min(triggerCenterY - top, Math.max(16, popupHeight - 16)));

    return { left, top, arrowTop, placement };
}

export function getLayoutModeTitle(layoutMode) {
    const option = LAYOUT_MODE_OPTIONS.find((item) => item.mode === normalizeLayoutMode(layoutMode));
    if (option) return option.title;
    return 'Left to Right (LR)';
}

function compareTableNames(a, b) {
    return String(a || '').localeCompare(String(b || ''), undefined, {
        numeric: true,
        sensitivity: 'base',
    });
}

function buildRelationKey(source, target) {
    return `${String(source ?? '')}\u0000${String(target ?? '')}`;
}

function mapSetSizeByTable(map, tableNames) {
    const result = {};
    tableNames.forEach((name) => {
        result[name] = map.get(name)?.size || 0;
    });
    return result;
}

function hasDirectedCycle(tableNames, outboundByTable) {
    const visitState = new Map();

    const visit = (tableName) => {
        const state = visitState.get(tableName) || 0;
        if (state === 1) return true;
        if (state === 2) return false;

        visitState.set(tableName, 1);
        const nextTables = outboundByTable.get(tableName) || new Set();
        for (const nextTable of nextTables) {
            if (visit(nextTable)) return true;
        }
        visitState.set(tableName, 2);
        return false;
    };

    return tableNames.some((tableName) => visit(tableName));
}

export function analyzeErdLayoutGraph(tables = [], relations = []) {
    const tableNames = [];
    const tableNameSet = new Set();

    (Array.isArray(tables) ? tables : []).forEach((table) => {
        const name = typeof table?.name === 'string' ? table.name.trim() : '';
        if (!name || tableNameSet.has(name)) return;
        tableNameSet.add(name);
        tableNames.push(name);
    });

    const adjacencyByTable = new Map(tableNames.map((name) => [name, new Set()]));
    const outboundByTable = new Map(tableNames.map((name) => [name, new Set()]));
    const inboundByTable = new Map(tableNames.map((name) => [name, new Set()]));
    const directedPairs = new Set();

    let validRelationCount = 0;
    let selfReferenceCount = 0;
    let duplicateRelationCount = 0;

    (Array.isArray(relations) ? relations : []).forEach((rel) => {
        const fromTable = rel?.from?.table;
        const toTable = rel?.to?.table;
        if (!tableNameSet.has(fromTable) || !tableNameSet.has(toTable)) return;

        validRelationCount += 1;
        if (fromTable === toTable) {
            selfReferenceCount += 1;
            return;
        }

        // Layout semantics are parent -> dependent: referenced table first,
        // FK-owning table after. Drawing still uses the original relation.
        const source = toTable;
        const target = fromTable;
        const directedKey = buildRelationKey(source, target);
        if (directedPairs.has(directedKey)) duplicateRelationCount += 1;
        directedPairs.add(directedKey);

        adjacencyByTable.get(source).add(target);
        adjacencyByTable.get(target).add(source);
        outboundByTable.get(source).add(target);
        inboundByTable.get(target).add(source);
    });

    const degreeByTable = {};
    let connectedTableCount = 0;
    let maxDegree = 0;
    let hubName = null;
    let degreeTotal = 0;

    tableNames.forEach((name) => {
        const degree = adjacencyByTable.get(name)?.size || 0;
        degreeByTable[name] = degree;
        if (degree > 0) {
            connectedTableCount += 1;
            degreeTotal += degree;
        }
        if (degree > maxDegree || (degree === maxDegree && hubName && compareTableNames(name, hubName) < 0)) {
            maxDegree = degree;
            hubName = name;
        } else if (!hubName) {
            hubName = name;
        }
    });

    const visited = new Set();
    const componentSizes = [];
    tableNames.forEach((name) => {
        if (visited.has(name)) return;
        const queue = [name];
        visited.add(name);
        let size = 0;

        while (queue.length > 0) {
            const current = queue.shift();
            size += 1;
            const neighbors = adjacencyByTable.get(current) || new Set();
            neighbors.forEach((neighbor) => {
                if (visited.has(neighbor)) return;
                visited.add(neighbor);
                queue.push(neighbor);
            });
        }

        componentSizes.push(size);
    });

    const uniqueRelationCount = directedPairs.size;
    const averageDegree = connectedTableCount > 0 ? degreeTotal / connectedTableCount : 0;
    const hubRatio = connectedTableCount > 1 ? maxDegree / (connectedTableCount - 1) : 0;
    const relationDensity = connectedTableCount > 1 ? uniqueRelationCount / (connectedTableCount * (connectedTableCount - 1)) : 0;
    const childCountByTable = mapSetSizeByTable(outboundByTable, tableNames);
    const parentCountByTable = mapSetSizeByTable(inboundByTable, tableNames);
    const rootCount = tableNames.filter((name) => parentCountByTable[name] === 0 && childCountByTable[name] > 0).length;
    const leafCount = tableNames.filter((name) => parentCountByTable[name] > 0 && childCountByTable[name] === 0).length;

    const isHubLike = connectedTableCount >= 5 && maxDegree >= Math.max(4, Math.ceil((connectedTableCount - 1) * 0.45)) && hubRatio >= 0.45;
    const isDense = connectedTableCount >= 6 && relationDensity >= 0.22 && maxDegree >= Math.max(4, Math.ceil((connectedTableCount - 1) * 0.35));

    return {
        tableCount: tableNames.length,
        connectedTableCount,
        validRelationCount,
        uniqueRelationCount,
        selfReferenceCount,
        duplicateRelationCount,
        componentCount: componentSizes.length,
        nonTrivialComponentCount: componentSizes.filter((size) => size > 1).length,
        largestComponentSize: componentSizes.length ? Math.max(...componentSizes) : 0,
        maxDegree,
        hubName,
        hubRatio,
        averageDegree,
        relationDensity,
        hasDirectedCycle: hasDirectedCycle(tableNames, outboundByTable),
        rootCount,
        leafCount,
        degreeByTable,
        childCountByTable,
        parentCountByTable,
        isHubLike,
        isDense,
    };
}

export function chooseBestLayoutStrategy(profile) {
    if (!profile || profile.tableCount <= 0) return SMART_LAYOUT_STRATEGIES.GRID;
    if (profile.connectedTableCount <= 1 || profile.uniqueRelationCount <= 0) return SMART_LAYOUT_STRATEGIES.GRID;
    if (profile.isHubLike || profile.isDense) return SMART_LAYOUT_STRATEGIES.RADIAL;
    return SMART_LAYOUT_STRATEGIES.LAYERED;
}

export function orderTablesForSmartLayout(tables, profile) {
    if (!Array.isArray(tables) || !profile) return Array.isArray(tables) ? tables : [];

    const degreeByTable = profile.degreeByTable || {};
    const childCountByTable = profile.childCountByTable || {};
    const parentCountByTable = profile.parentCountByTable || {};
    const hubName = profile.hubName;

    return [...tables].sort((a, b) => {
        const aName = a?.name;
        const bName = b?.name;
        if (aName === hubName && bName !== hubName) return -1;
        if (bName === hubName && aName !== hubName) return 1;

        const aRootScore = parentCountByTable[aName] === 0 && childCountByTable[aName] > 0 ? 1 : 0;
        const bRootScore = parentCountByTable[bName] === 0 && childCountByTable[bName] > 0 ? 1 : 0;
        if (aRootScore !== bRootScore) return bRootScore - aRootScore;

        const degreeDiff = (degreeByTable[bName] || 0) - (degreeByTable[aName] || 0);
        if (degreeDiff !== 0) return degreeDiff;

        const childDiff = (childCountByTable[bName] || 0) - (childCountByTable[aName] || 0);
        if (childDiff !== 0) return childDiff;

        const parentDiff = (parentCountByTable[aName] || 0) - (parentCountByTable[bName] || 0);
        if (parentDiff !== 0) return parentDiff;

        return compareTableNames(aName, bName);
    });
}

export function buildLayoutEdges(relations, nodeIds, { semanticDirection = false, dedupe = false, skipSelf = false } = {}) {
    const seen = new Set();
    const edges = [];

    (Array.isArray(relations) ? relations : []).forEach((rel) => {
        if (!rel || !rel.from || !rel.to || !rel.from.table || !rel.to.table) return;
        if (!nodeIds.has(rel.from.table) || !nodeIds.has(rel.to.table)) return;

        const source = semanticDirection ? rel.to.table : rel.from.table;
        const target = semanticDirection ? rel.from.table : rel.to.table;
        if (skipSelf && source === target) return;

        const key = buildRelationKey(source, target);
        if (dedupe && seen.has(key)) return;
        seen.add(key);
        edges.push({
            id: `e${edges.length}`,
            source,
            target,
        });
    });

    return edges;
}

export function buildGridLayoutPositions(tables = []) {
    const safeTables = (Array.isArray(tables) ? tables : [])
        .filter((table) => typeof table?.name === 'string' && table.name.trim())
        .sort((a, b) => compareTableNames(a.name, b.name));

    if (safeTables.length === 0) return {};

    const count = safeTables.length;
    const columns = Math.max(1, Math.ceil(Math.sqrt(count * 1.35)));
    const rows = Math.ceil(count / columns);
    const columnWidths = Array.from({ length: columns }, () => 0);
    const rowHeights = Array.from({ length: rows }, () => 0);

    safeTables.forEach((table, index) => {
        const col = index % columns;
        const row = Math.floor(index / columns);
        columnWidths[col] = Math.max(columnWidths[col], Number(table.width) || 180);
        rowHeights[row] = Math.max(rowHeights[row], Number(table.height) || 120);
    });

    const columnGap = 90;
    const rowGap = 90;
    const totalWidth = columnWidths.reduce((sum, width) => sum + width, 0) + Math.max(0, columns - 1) * columnGap;
    const totalHeight = rowHeights.reduce((sum, height) => sum + height, 0) + Math.max(0, rows - 1) * rowGap;
    const columnCenters = [];
    const rowCenters = [];

    let xCursor = -totalWidth / 2;
    columnWidths.forEach((width) => {
        columnCenters.push(xCursor + width / 2);
        xCursor += width + columnGap;
    });

    let yCursor = -totalHeight / 2;
    rowHeights.forEach((height) => {
        rowCenters.push(yCursor + height / 2);
        yCursor += height + rowGap;
    });

    const positions = {};
    safeTables.forEach((table, index) => {
        positions[table.name] = {
            x: columnCenters[index % columns],
            y: rowCenters[Math.floor(index / columns)],
        };
    });
    return positions;
}

export function calculateSelfReferenceConnectorLoop({ table, fromY, toY, connectorOffset, selfIndex = 0, sameColumn = false }) {
    const safeIndex = Number.isFinite(selfIndex) ? Math.max(0, selfIndex) : 0;
    const fromLeft = table.x - table.width / 2;
    const fromRight = table.x + table.width / 2;
    const loopInset = connectorOffset + 28 + safeIndex * 10;

    if (!sameColumn) {
        return {
            points: [
                { x: fromRight, y: fromY },
                { x: fromRight + loopInset, y: fromY },
                { x: fromRight + loopInset, y: toY },
                { x: fromRight, y: toY },
            ],
            radius: 8,
        };
    }

    const loopGap = connectorOffset + 24 + safeIndex * 16;
    const nodeTop = table.y - table.height / 2;
    const nodeBottom = table.y + table.height / 2;
    const routeAbove = (fromY + toY) / 2 < table.y;
    const loopY = routeAbove ? nodeTop - loopGap : nodeBottom + loopGap;

    return {
        points: [
            { x: fromRight, y: fromY },
            { x: fromRight + loopInset, y: fromY },
            { x: fromRight + loopInset, y: loopY },
            { x: fromLeft - loopInset, y: loopY },
            { x: fromLeft - loopInset, y: toY },
            { x: fromLeft, y: toY },
        ],
        radius: 8,
    };
}
