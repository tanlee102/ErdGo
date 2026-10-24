/** The renderer alone owns the canvas backing store, in physical pixels. */
export function syncCanvasSize(canvas, container, dpr = window.devicePixelRatio || 1) {
    const width = container.clientWidth;
    const height = container.clientHeight;
    const pixelWidth = Math.floor(width * dpr);
    const pixelHeight = Math.floor(height * dpr);
    let changed = false;

    // Each assignment clears the bitmap and resets drawing state. In
    // particular, a horizontal splitter must never reassign the height.
    if (canvas.width !== pixelWidth) { canvas.width = pixelWidth; changed = true; }
    if (canvas.height !== pixelHeight) { canvas.height = pixelHeight; changed = true; }
    if (canvas.style.width !== `${width}px`) canvas.style.width = `${width}px`;
    if (canvas.style.height !== `${height}px`) canvas.style.height = `${height}px`;
    return changed;
}
