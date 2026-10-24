/** Paint-only viewport culling; schema, layout, selection and hit tests stay complete. */
export function isCanvasTableVisible(table, { zoom, offsetX, offsetY, width, height }, horizontalOverflow = 0, verticalOverflow = 0) {
    // Column text can outgrow the established 420px card cap; Unicode glyph ink
    // can extend past its advance or row. Expand paint bounds only, never layout
    // or hit targets. Missing native ink metrics fail open through these bounds.
    const overflow = Number.isFinite(horizontalOverflow) ? Math.max(0, horizontalOverflow) : Infinity;
    const vertical = Number.isFinite(verticalOverflow) ? Math.max(0, verticalOverflow) : Infinity;
    const left = (table.x - table.width / 2 - overflow) * zoom + offsetX;
    const right = (table.x + table.width / 2 + overflow) * zoom + offsetX;
    const top = (table.y - table.height / 2 - vertical) * zoom + offsetY;
    const bottom = (table.y + table.height / 2 + vertical) * zoom + offsetY;
    // Fail open if a transient layout has not supplied valid dimensions yet.
    if (zoom <= 0 || !Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(top) || !Number.isFinite(bottom) || !Number.isFinite(width) || !Number.isFinite(height)) return true;
    // Shadows use backing-store pixels, independent of the world transform.
    // Add half the 0.3-world-unit table border after camera scaling. At high
    // export zoom its outer edge can cast a visible shadow into the image even
    // when the card's fill is more than 32 backing pixels outside the viewport.
    const paintPadding = 32 + 0.15 * zoom;
    return right >= -paintPadding && left <= width + paintPadding && bottom >= -paintPadding && top <= height + paintPadding;
}
