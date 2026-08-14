const DEFAULT_FIT_PADDING = 200;
const DEFAULT_MAX_FIT_ZOOM = 2;
const DEFAULT_MAX_ZOOM = 5;
const MIN_ZOOM_FLOOR = 0.0001;
const FIT_ZOOM_RATIO = 0.98;
const MIN_ZOOM_FIT_RATIO = 0.2;
const MAX_ZOOM_FIT_RATIO = 2.5;

export function getErdBounds(tables) {
    const validTables = (tables || []).filter((t) => (
        t &&
        typeof t.x === 'number' &&
        typeof t.y === 'number' &&
        typeof t.width === 'number' &&
        typeof t.height === 'number' &&
        Number.isFinite(t.x) &&
        Number.isFinite(t.y) &&
        Number.isFinite(t.width) &&
        Number.isFinite(t.height)
    ));

    if (validTables.length === 0) return null;

    const minX = Math.min(...validTables.map((t) => t.x - t.width / 2));
    const minY = Math.min(...validTables.map((t) => t.y - t.height / 2));
    const maxX = Math.max(...validTables.map((t) => t.x + t.width / 2));
    const maxY = Math.max(...validTables.map((t) => t.y + t.height / 2));
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);

    return {
        minX,
        minY,
        maxX,
        maxY,
        width,
        height,
        centerX: minX + width / 2,
        centerY: minY + height / 2,
    };
}

export function calculateErdViewportFit({
    tables,
    viewportWidth,
    viewportHeight,
    fitPadding = DEFAULT_FIT_PADDING,
    maxFitZoom = DEFAULT_MAX_FIT_ZOOM,
} = {}) {
    if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight) || viewportWidth <= 0 || viewportHeight <= 0) {
        return null;
    }

    const bounds = getErdBounds(tables);
    if (!bounds) return null;

    const safePadding = Number.isFinite(fitPadding) && fitPadding >= 0 ? fitPadding : DEFAULT_FIT_PADDING;
    const safeMaxFitZoom = Number.isFinite(maxFitZoom) && maxFitZoom > 0 ? maxFitZoom : DEFAULT_MAX_FIT_ZOOM;
    const fitZoom = Math.min(
        viewportWidth / (bounds.width + safePadding),
        viewportHeight / (bounds.height + safePadding),
    );
    const limitedFitZoom = Math.min(fitZoom, safeMaxFitZoom);
    const zoom = limitedFitZoom * FIT_ZOOM_RATIO;
    const maxZoom = Math.max(DEFAULT_MAX_ZOOM, limitedFitZoom * MAX_ZOOM_FIT_RATIO);
    const minZoom = Math.min(maxZoom, Math.max(MIN_ZOOM_FLOOR, limitedFitZoom * MIN_ZOOM_FIT_RATIO));

    return {
        bounds,
        fitZoom,
        limitedFitZoom,
        zoom,
        minZoom,
        maxZoom,
        offsetX: viewportWidth / 2 - bounds.centerX * zoom,
        offsetY: viewportHeight / 2 - bounds.centerY * zoom,
    };
}

export function calculateErdZoomLimits(options = {}) {
    const fit = calculateErdViewportFit(options);
    if (!fit) {
        return {
            minZoom: MIN_ZOOM_FLOOR,
            maxZoom: DEFAULT_MAX_ZOOM,
        };
    }

    return {
        minZoom: fit.minZoom,
        maxZoom: fit.maxZoom,
    };
}

export function clampErdZoom(zoom, { minZoom = MIN_ZOOM_FLOOR, maxZoom = DEFAULT_MAX_ZOOM } = {}) {
    if (!Number.isFinite(zoom) || zoom <= 0) return null;

    const safeMaxZoom = Number.isFinite(maxZoom) && maxZoom > 0 ? maxZoom : DEFAULT_MAX_ZOOM;
    const safeMinZoom = Number.isFinite(minZoom) && minZoom > 0 ? Math.min(minZoom, safeMaxZoom) : MIN_ZOOM_FLOOR;

    return Math.min(safeMaxZoom, Math.max(safeMinZoom, zoom));
}

export function getAnchoredZoomUpdate({ anchorX, anchorY, worldX, worldY, zoom }) {
    if (![anchorX, anchorY, worldX, worldY, zoom].every(Number.isFinite) || zoom <= 0) {
        return null;
    }

    return {
        zoom,
        offsetX: anchorX - worldX * zoom,
        offsetY: anchorY - worldY * zoom,
    };
}

/**
 * Calculate a stable pinch transform from the gesture's initial state.
 *
 * The scale is always derived from the initial finger distance, rather than
 * from the previous frame, so touch-event rounding cannot accumulate drift.
 * The initial world point is then placed below the current finger midpoint;
 * this combines pinch-to-zoom and two-finger panning in one exact transform.
 */
export function calculateErdPinchUpdate({
    startDistance,
    currentDistance,
    startZoom,
    anchorX,
    anchorY,
    worldX,
    worldY,
    minZoom,
    maxZoom,
} = {}) {
    if (
        ![startDistance, currentDistance, startZoom, anchorX, anchorY, worldX, worldY].every(Number.isFinite) ||
        startDistance <= 0 ||
        currentDistance <= 0 ||
        startZoom <= 0
    ) {
        return null;
    }

    const zoom = clampErdZoom(startZoom * (currentDistance / startDistance), { minZoom, maxZoom });
    if (zoom === null) return null;

    return getAnchoredZoomUpdate({ anchorX, anchorY, worldX, worldY, zoom });
}
