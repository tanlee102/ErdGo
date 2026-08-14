const CONNECTOR_SIDES = new Set(['left', 'right']);

export function normalizeConnectorSide(side) {
    if (typeof side !== 'string') return null;
    const normalized = side.trim().toLowerCase();
    return CONNECTOR_SIDES.has(normalized) ? normalized : null;
}

export function normalizeConnectorEndpointSides(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

    return Object.fromEntries(
        Object.entries(value)
            .map(([relationKey, endpoints]) => {
                if (typeof relationKey !== 'string' || !relationKey.trim() || !endpoints || typeof endpoints !== 'object' || Array.isArray(endpoints)) return null;
                const from = normalizeConnectorSide(endpoints.from);
                const to = normalizeConnectorSide(endpoints.to);
                if (!from && !to) return null;
                return [relationKey, { ...(from && { from }), ...(to && { to }) }];
            })
            .filter(Boolean),
    );
}

export function getConnectorRelationKey(relation) {
    if (!relation?.from?.table || !relation?.from?.column || !relation?.to?.table || !relation?.to?.column) return '';
    const constraintName = [relation.fkName, relation.constraintName, relation.foreignKeyName, relation.name].find((value) => typeof value === 'string' && value.trim());
    const endpointKey = `${relation.from.table}.${relation.from.column}->${relation.to.table}.${relation.to.column}`;
    return constraintName ? `${endpointKey}|${constraintName.trim()}` : endpointKey;
}

export function getAutomaticConnectorSides(fromTable, toTable, { sameColumn = false, overlapPadding = 0 } = {}) {
    if (!fromTable || !toTable) return { from: 'right', to: 'left' };
    if (fromTable === toTable || fromTable.name === toTable.name) {
        return sameColumn ? { from: 'right', to: 'left' } : { from: 'right', to: 'right' };
    }

    const fromLeft = fromTable.x - fromTable.width / 2;
    const fromRight = fromTable.x + fromTable.width / 2;
    const toLeft = toTable.x - toTable.width / 2;
    const toRight = toTable.x + toTable.width / 2;
    const overlapsHorizontally = !(fromRight + overlapPadding < toLeft || fromLeft - overlapPadding > toRight);

    if (overlapsHorizontally) {
        return fromTable.x <= toTable.x ? { from: 'right', to: 'right' } : { from: 'left', to: 'left' };
    }
    return fromTable.x < toTable.x ? { from: 'right', to: 'left' } : { from: 'left', to: 'right' };
}

export function chooseConnectorSideFromPointer(pointerX, tableCenterX, currentSide, hysteresis = 12) {
    const safePointerX = Number(pointerX);
    const safeCenterX = Number(tableCenterX);
    const safeHysteresis = Number.isFinite(hysteresis) ? Math.max(0, hysteresis) : 12;
    const normalizedCurrent = normalizeConnectorSide(currentSide);
    if (!Number.isFinite(safePointerX) || !Number.isFinite(safeCenterX)) return normalizedCurrent || 'right';
    if (safePointerX < safeCenterX - safeHysteresis) return 'left';
    if (safePointerX > safeCenterX + safeHysteresis) return 'right';
    return normalizedCurrent || (safePointerX < safeCenterX ? 'left' : 'right');
}

function sideDirection(side) {
    return side === 'left' ? -1 : 1;
}

function endpointX(table, side) {
    return table.x + sideDirection(side) * table.width / 2;
}

function simplifyOrthogonalPoints(points) {
    const finite = points.filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y));
    const unique = finite.filter((point, index) => index === 0 || point.x !== finite[index - 1].x || point.y !== finite[index - 1].y);
    if (unique.length <= 2) return unique;

    const result = [unique[0]];
    for (let index = 1; index < unique.length - 1; index += 1) {
        const previous = result[result.length - 1];
        const current = unique[index];
        const next = unique[index + 1];
        const isHorizontal = previous.y === current.y && current.y === next.y;
        const isVertical = previous.x === current.x && current.x === next.x;
        if (!isHorizontal && !isVertical) result.push(current);
    }
    result.push(unique.at(-1));
    return result;
}

function chooseVerticalDetour(fromTable, toTable, fromY, toY, distance) {
    const top = Math.min(fromTable.y - fromTable.height / 2, toTable.y - toTable.height / 2) - distance;
    const bottom = Math.max(fromTable.y + fromTable.height / 2, toTable.y + toTable.height / 2) + distance;
    const topCost = Math.abs(fromY - top) + Math.abs(toY - top);
    const bottomCost = Math.abs(fromY - bottom) + Math.abs(toY - bottom);
    if (topCost === bottomCost) {
        const rowMidpoint = (fromY + toY) / 2;
        const tableMidpoint = (fromTable.y + toTable.y) / 2;
        return rowMidpoint <= tableMidpoint ? top : bottom;
    }
    return topCost < bottomCost ? top : bottom;
}

function getVerticalDetourCandidates(fromTable, toTable, fromY, toY, distance) {
    const top = Math.min(fromTable.y - fromTable.height / 2, toTable.y - toTable.height / 2) - distance;
    const bottom = Math.max(fromTable.y + fromTable.height / 2, toTable.y + toTable.height / 2) + distance;
    const candidates = [
        { value: top, cost: Math.abs(fromY - top) + Math.abs(toY - top) },
        { value: bottom, cost: Math.abs(fromY - bottom) + Math.abs(toY - bottom) },
    ];
    return candidates.sort((left, right) => {
        if (left.cost !== right.cost) return left.cost - right.cost;
        const rowMidpoint = (fromY + toY) / 2;
        const tableMidpoint = (fromTable.y + toTable.y) / 2;
        const preferred = rowMidpoint <= tableMidpoint ? top : bottom;
        return left.value === preferred ? -1 : 1;
    });
}

function segmentCrossesRectangleInterior(start, end, table) {
    const epsilon = 0.000001;
    const left = table.x - table.width / 2;
    const right = table.x + table.width / 2;
    const top = table.y - table.height / 2;
    const bottom = table.y + table.height / 2;

    if (Math.abs(start.y - end.y) <= epsilon) {
        const minX = Math.min(start.x, end.x);
        const maxX = Math.max(start.x, end.x);
        return start.y > top + epsilon && start.y < bottom - epsilon && Math.max(minX, left) < Math.min(maxX, right) - epsilon;
    }
    if (Math.abs(start.x - end.x) <= epsilon) {
        const minY = Math.min(start.y, end.y);
        const maxY = Math.max(start.y, end.y);
        return start.x > left + epsilon && start.x < right - epsilon && Math.max(minY, top) < Math.min(maxY, bottom) - epsilon;
    }
    return true;
}

function countEndpointTableCollisions(points, fromTable, toTable) {
    let collisions = 0;
    for (let index = 1; index < points.length; index += 1) {
        if (segmentCrossesRectangleInterior(points[index - 1], points[index], fromTable)) collisions += 1;
        if (toTable !== fromTable && toTable.name !== fromTable.name && segmentCrossesRectangleInterior(points[index - 1], points[index], toTable)) collisions += 1;
    }
    return collisions;
}

function getAlternatingLaneOffset(lane, spacing) {
    if (lane <= 0) return 0;
    const magnitude = Math.ceil(lane / 2) * spacing;
    return lane % 2 === 1 ? magnitude : -magnitude;
}

function getPolylineLength(points) {
    let length = 0;
    for (let index = 1; index < points.length; index += 1) {
        length += Math.abs(points[index].x - points[index - 1].x) + Math.abs(points[index].y - points[index - 1].y);
    }
    return length;
}

function getOutwardRailCandidates(point, side, localRailX, globalLeft, globalRight) {
    const candidates = side === 'left' ? [localRailX, globalLeft] : [localRailX, globalRight];
    return candidates.filter((value, index) => Number.isFinite(value) && candidates.indexOf(value) === index && (side === 'left' ? value < point.x : value > point.x));
}

/**
 * Builds an orthogonal connector for any independent left/right endpoint pair.
 * The first and last segments always travel outward from their table edge.
 * When those outward half-planes intersect, the route uses the shortest safe
 * vertical channel. Otherwise it detours above or below both table rectangles.
 */
export function calculateEditableConnectorRoute({
    fromTable,
    toTable,
    fromY,
    toY,
    fromSide,
    toSide,
    connectorOffset = 24,
    headClearance = connectorOffset,
    parallelIndex = 0,
    radius = 5,
}) {
    if (!fromTable || !toTable || ![fromY, toY, fromTable.x, fromTable.y, fromTable.width, fromTable.height, toTable.x, toTable.y, toTable.width, toTable.height].every(Number.isFinite)) {
        return { points: [], radius: 0 };
    }

    const safeFromSide = normalizeConnectorSide(fromSide) || 'right';
    const safeToSide = normalizeConnectorSide(toSide) || 'left';
    const fromDirection = sideDirection(safeFromSide);
    const toDirection = sideDirection(safeToSide);
    const lane = Number.isFinite(parallelIndex) ? Math.max(0, Math.floor(parallelIndex)) : 0;
    const baseOffset = Number.isFinite(connectorOffset) ? Math.max(8, connectorOffset) : 24;
    const safeHeadClearance = Number.isFinite(headClearance) ? Math.max(8, headClearance) : baseOffset;
    const laneSpacing = Math.max(5, baseOffset * 0.28);
    const fromPoint = { x: endpointX(fromTable, safeFromSide), y: fromY };
    const toPoint = { x: endpointX(toTable, safeToSide), y: toY };
    const sameTable = fromTable === toTable || fromTable.name === toTable.name;
    // Reserve a straight head segment at both table edges before any bend.
    // Besides looking intentional, this keeps crow's-foot/cardinality glyphs
    // clear of rounded corners even when users force endpoints into a tight gap.
    const fromStub = { x: fromPoint.x + fromDirection * safeHeadClearance, y: fromY };
    const toStub = { x: toPoint.x + toDirection * safeHeadClearance, y: toY };

    if (sameTable) {
        if (safeFromSide === safeToSide && fromY !== toY) {
            const channelDistance = safeHeadClearance + lane * laneSpacing;
            const channelX = fromPoint.x + fromDirection * channelDistance;
            return {
                points: simplifyOrthogonalPoints([fromPoint, { x: channelX, y: fromY }, { x: channelX, y: toY }, toPoint]),
                radius: Math.max(radius, 8),
            };
        }

        const channelY = chooseVerticalDetour(fromTable, toTable, fromY, toY, baseOffset + lane * laneSpacing);
        if (safeFromSide === safeToSide && fromY === toY) {
            const channelX = fromPoint.x + fromDirection * (safeHeadClearance + lane * laneSpacing);
            const secondLaneX = channelX + fromDirection * Math.max(8, baseOffset * 0.55);
            return {
                points: simplifyOrthogonalPoints([
                    fromPoint,
                    { x: channelX, y: fromY },
                    { x: channelX, y: channelY },
                    { x: secondLaneX, y: channelY },
                    { x: secondLaneX, y: toY },
                    toPoint,
                ]),
                radius: Math.max(radius, 8),
            };
        }
        return {
            points: simplifyOrthogonalPoints([fromPoint, fromStub, { x: fromStub.x, y: channelY }, { x: toStub.x, y: channelY }, toStub, toPoint]),
            radius: Math.max(radius, 8),
        };
    }

    // When facing tables are closer than two complete head clearances, there
    // is no single X coordinate that can satisfy both heads. Keep the route in
    // the inter-table gap with a compact S bridge instead of detouring above
    // or below both cards. This preserves cardinality space without the large
    // visually surprising loop that a global detour would create.
    const horizontalDirection = Math.sign(toPoint.x - fromPoint.x);
    const horizontalGap = Math.abs(toPoint.x - fromPoint.x);
    const facesAcrossGap = horizontalDirection !== 0 && fromDirection === horizontalDirection && toDirection === -horizontalDirection;
    const headsFitIndividually = horizontalGap >= safeHeadClearance;
    const headsOverlap = horizontalGap < safeHeadClearance * 2;
    if (facesAcrossGap && headsFitIndividually && headsOverlap) {
        const bridgeY = (fromY + toY) / 2 + getAlternatingLaneOffset(lane, laneSpacing);
        const compactPoints = simplifyOrthogonalPoints([
            fromPoint,
            fromStub,
            { x: fromStub.x, y: bridgeY },
            { x: toStub.x, y: bridgeY },
            toStub,
            toPoint,
        ]);
        if (countEndpointTableCollisions(compactPoints, fromTable, toTable) === 0) {
            return { points: compactPoints, radius };
        }
    }

    const fromLower = fromDirection > 0 ? fromStub.x : -Infinity;
    const fromUpper = fromDirection < 0 ? fromStub.x : Infinity;
    const toLower = toDirection > 0 ? toStub.x : -Infinity;
    const toUpper = toDirection < 0 ? toStub.x : Infinity;
    const channelLower = Math.max(fromLower, toLower);
    const channelUpper = Math.min(fromUpper, toUpper);

    if (channelLower <= channelUpper) {
        let channelX;
        if (fromDirection > 0 && toDirection > 0) channelX = channelLower + lane * laneSpacing;
        else if (fromDirection < 0 && toDirection < 0) channelX = channelUpper - lane * laneSpacing;
        else {
            const midpoint = (channelLower + channelUpper) / 2;
            channelX = Math.max(channelLower, Math.min(channelUpper, midpoint + getAlternatingLaneOffset(lane, laneSpacing)));
        }

        const directPoints = simplifyOrthogonalPoints([fromPoint, fromStub, { x: channelX, y: fromY }, { x: channelX, y: toY }, toStub, toPoint]);
        if (countEndpointTableCollisions(directPoints, fromTable, toTable) === 0) {
            return { points: directPoints, radius };
        }
    }

    const detourDistance = Math.max(baseOffset + lane * laneSpacing, safeHeadClearance);
    const globalLeft = Math.min(fromTable.x - fromTable.width / 2, toTable.x - toTable.width / 2) - detourDistance;
    const globalRight = Math.max(fromTable.x + fromTable.width / 2, toTable.x + toTable.width / 2) + detourDistance;
    const fromRails = getOutwardRailCandidates(fromPoint, safeFromSide, fromStub.x, globalLeft, globalRight);
    const toRails = getOutwardRailCandidates(toPoint, safeToSide, toStub.x, globalLeft, globalRight);
    const detourCandidates = [];

    for (const { value: channelY, cost: verticalCost } of getVerticalDetourCandidates(fromTable, toTable, fromY, toY, detourDistance)) {
        for (const fromRailX of fromRails) {
            for (const toRailX of toRails) {
                const points = simplifyOrthogonalPoints([
                    fromPoint,
                    { x: fromRailX, y: fromY },
                    { x: fromRailX, y: channelY },
                    { x: toRailX, y: channelY },
                    { x: toRailX, y: toY },
                    toPoint,
                ]);
                detourCandidates.push({
                    points,
                    verticalCost,
                    length: getPolylineLength(points),
                    collisions: countEndpointTableCollisions(points, fromTable, toTable),
                });
            }
        }
    }

    const bestDetour = detourCandidates.sort(
        (left, right) => left.collisions - right.collisions || left.length - right.length || left.verticalCost - right.verticalCost,
    )[0];
    return { points: bestDetour.points, radius };
}
