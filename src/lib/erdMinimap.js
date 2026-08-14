/** Pure transforms between ERD world coordinates, viewport coordinates, and minimap pixels. */
import { getErdBounds } from './erdViewport.js';

function isFiniteRect(rect) {
    return rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width >= 0 && rect.height >= 0;
}

export function getErdViewportWorldRect({ zoom, offsetX, offsetY, viewportWidth, viewportHeight } = {}) {
    if (
        ![zoom, offsetX, offsetY, viewportWidth, viewportHeight].every(Number.isFinite) ||
        zoom <= 0 ||
        viewportWidth < 0 ||
        viewportHeight < 0
    ) {
        return null;
    }

    return {
        x: -offsetX / zoom,
        y: -offsetY / zoom,
        width: viewportWidth / zoom,
        height: viewportHeight / zoom,
    };
}

export function calculateErdMinimapModel({ tables, viewport, width, height, padding = 12 } = {}) {
    if (![width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;

    const bounds = getErdBounds(tables);
    if (!bounds) return null;

    const safePadding = Number.isFinite(padding) && padding >= 0
        ? Math.min(padding, Math.max(0, Math.min(width, height) / 2 - 1))
        : 12;
    const innerWidth = Math.max(1, width - safePadding * 2);
    const innerHeight = Math.max(1, height - safePadding * 2);
    const scale = Math.min(innerWidth / bounds.width, innerHeight / bounds.height);
    if (!Number.isFinite(scale) || scale <= 0) return null;

    const offsetX = (width - bounds.width * scale) / 2 - bounds.minX * scale;
    const offsetY = (height - bounds.height * scale) / 2 - bounds.minY * scale;
    const projectRect = (rect) => ({
        x: rect.x * scale + offsetX,
        y: rect.y * scale + offsetY,
        width: rect.width * scale,
        height: rect.height * scale,
    });

    return {
        width,
        height,
        padding: safePadding,
        scale,
        offsetX,
        offsetY,
        worldBounds: bounds,
        viewport: isFiniteRect(viewport) ? projectRect(viewport) : null,
        tableRects: (tables || []).filter((table) => (
            table &&
            typeof table.name === 'string' &&
            [table.x, table.y, table.width, table.height].every(Number.isFinite)
        )).map((table) => ({
            name: table.name,
            ...projectRect({
                x: table.x - table.width / 2,
                y: table.y - table.height / 2,
                width: table.width,
                height: table.height,
            }),
        })),
    };
}

export function erdMinimapPointToWorld(model, x, y) {
    if (!model || ![model.scale, model.offsetX, model.offsetY, x, y].every(Number.isFinite) || model.scale <= 0) {
        return null;
    }

    return {
        x: (x - model.offsetX) / model.scale,
        y: (y - model.offsetY) / model.scale,
    };
}

export function getErdMinimapPanUpdate({
    model,
    mapX,
    mapY,
    zoom,
    viewportWidth,
    viewportHeight,
    grabOffsetX,
    grabOffsetY,
} = {}) {
    if (![zoom, viewportWidth, viewportHeight].every(Number.isFinite) || zoom <= 0 || viewportWidth < 0 || viewportHeight < 0) {
        return null;
    }

    const worldPoint = erdMinimapPointToWorld(model, mapX, mapY);
    if (!worldPoint) return null;

    const viewportWorldWidth = viewportWidth / zoom;
    const viewportWorldHeight = viewportHeight / zoom;
    const safeGrabOffsetX = Number.isFinite(grabOffsetX) ? grabOffsetX : viewportWorldWidth / 2;
    const safeGrabOffsetY = Number.isFinite(grabOffsetY) ? grabOffsetY : viewportWorldHeight / 2;

    return {
        offsetX: -(worldPoint.x - safeGrabOffsetX) * zoom,
        offsetY: -(worldPoint.y - safeGrabOffsetY) * zoom,
    };
}
