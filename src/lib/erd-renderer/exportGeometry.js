/** Padded world bounds for optional full-diagram capture; viewport export keeps its original sizing. */
import { getErdBounds } from '../erdViewport.js';

export function getErdExportBounds(tables, connectors = []) {
    const bounds = getErdBounds(tables);
    if (!bounds) return null;
    // Routed/self-loop edges can extend beyond table cards.
    for (const connector of connectors) {
        for (const point of connector.points || []) {
            if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
            bounds.minX = Math.min(bounds.minX, point.x);
            bounds.minY = Math.min(bounds.minY, point.y);
            bounds.maxX = Math.max(bounds.maxX, point.x);
            bounds.maxY = Math.max(bounds.maxY, point.y);
        }
    }
    // Allow room for cardinality marks, confidence pills and card shadows.
    const padding = 64;
    return { x: bounds.minX - padding, y: bounds.minY - padding, width: bounds.maxX - bounds.minX + padding * 2, height: bounds.maxY - bounds.minY + padding * 2 };
}
