/** Keeps editor canvas dimensions synchronized with the resizable panel container. */
import { useEffect, useRef } from 'react';

export function useCanvasResize(isEditorReady) {
    const resizeTimeoutRef = useRef(null);

    useEffect(() => {
        const erdContainer = document.getElementById('erd-container');
        const erdCanvas = document.getElementById('erd-canvas');
        if (!erdContainer || !erdCanvas) return;

        const resizeCanvas = () => {
            const containerRect = erdContainer.getBoundingClientRect();
            const newWidth = Math.floor(containerRect.width);
            const newHeight = Math.floor(containerRect.height);

            erdCanvas.width = newWidth;
            erdCanvas.height = newHeight;
            erdCanvas.style.width = newWidth + 'px';
            erdCanvas.style.height = newHeight + 'px';

            window.dispatchEvent(new Event('resize'));
        };

        const resizeObserver = new ResizeObserver(() => {
            if (resizeTimeoutRef.current) {
                clearTimeout(resizeTimeoutRef.current);
            }
            resizeTimeoutRef.current = setTimeout(() => {
                resizeCanvas();
            }, 1000);
        });

        resizeObserver.observe(erdContainer);
        resizeCanvas();

        return () => {
            resizeObserver.disconnect();
            if (resizeTimeoutRef.current) {
                clearTimeout(resizeTimeoutRef.current);
            }
        };
    }, [isEditorReady]);
}
