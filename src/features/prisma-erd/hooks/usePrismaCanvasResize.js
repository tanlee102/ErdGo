/** Observes the Prisma canvas host and forwards stable pixel dimensions to the renderer. */
import { useEffect, useRef } from 'react';

export function usePrismaCanvasResize(isCanvasReady) {
    const resizeTimeoutRef = useRef(null);

    useEffect(() => {
        const erdContainer = document.getElementById('erd-container');
        const erdCanvas = document.getElementById('erd-canvas');
        if (!erdContainer || !erdCanvas) return;

        const resizeCanvas = (notifyRenderer = true) => {
            const containerRect = erdContainer.getBoundingClientRect();
            const newWidth = Math.max(1, Math.floor(containerRect.width));
            const newHeight = Math.max(1, Math.floor(containerRect.height));

            erdCanvas.width = newWidth;
            erdCanvas.height = newHeight;
            erdCanvas.style.width = `${newWidth}px`;
            erdCanvas.style.height = `${newHeight}px`;

            if (notifyRenderer) window.dispatchEvent(new Event('resize'));
        };

        const scheduleResize = () => {
            if (resizeTimeoutRef.current) {
                clearTimeout(resizeTimeoutRef.current);
            }
            resizeTimeoutRef.current = setTimeout(() => {
                resizeTimeoutRef.current = null;
                resizeCanvas();
            }, 16);
        };

        if (typeof ResizeObserver === 'undefined') {
            const handleWindowResize = () => resizeCanvas(false);
            window.addEventListener('resize', handleWindowResize);
            resizeCanvas();

            return () => {
                window.removeEventListener('resize', handleWindowResize);
            };
        }

        const resizeObserver = new ResizeObserver(scheduleResize);
        resizeObserver.observe(erdContainer);
        resizeCanvas();

        return () => {
            resizeObserver.disconnect();
            if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
        };
    }, [isCanvasReady]);
}
