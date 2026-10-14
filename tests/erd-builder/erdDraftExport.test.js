// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
    calculateErdDraftExportSize,
    exportErdDraftPng,
    getErdDraftExportBounds,
} from '@/features/erd-draft/lib/erdDraftExport';

describe('ERD Builder export', () => {
    it('excludes collapsed attributes from whole-diagram geometry', () => {
        const owner = { position: { x: 0, y: 0 }, data: { shape: 'entity', label: 'Customer' } };
        expect(getErdDraftExportBounds([owner, { hidden: true, position: { x: -9000, y: 9000 }, data: { shape: 'attribute' } }])).toEqual(getErdDraftExportBounds([owner]));
    });
    it('includes cardinality labels dragged beyond nodes in whole-diagram bounds', async () => {
        const canvasElement = document.createElement('section');
        canvasElement.innerHTML = '<div class="react-flow"><div class="react-flow__viewport"><button class="erd-draft-end-label">(1, N)</button></div></div>';
        canvasElement.querySelector('.react-flow').getBoundingClientRect = () => ({ width: 800, height: 600 });
        canvasElement.querySelector('.erd-draft-end-label').getBoundingClientRect = () => ({ left: -1500, top: -1000, right: -1400, bottom: -970, width: 100, height: 30 });
        const toPngImpl = vi.fn(async () => 'data:image/png;base64,label');
        await exportErdDraftPng({ canvasElement, nodes: [{ position: { x: 0, y: 0 }, data: { shape: 'entity' } }], screenToFlowPosition: point => point, scope: 'diagram', toPngImpl });
        const options = toPngImpl.mock.calls[0][1];
        expect(options.style.transform).toBe('translate(1548px, 1048px) scale(1)');
        expect(options.width).toBeGreaterThan(1500);
        expect(options.height).toBeGreaterThan(1000);
    });
    it('uses content-aware node geometry and includes connector overflow', () => {
        const bounds = getErdDraftExportBounds([
            { position: { x: 100, y: 50 }, data: { shape: 'entity', label: 'Patient' } },
            { position: { x: 420, y: 300 }, measured: { width: 200, height: 120 }, data: { shape: 'note' } },
        ], [{ x: 20, y: 10, width: 700, height: 450 }]);

        expect(bounds).toEqual({ x: 20, y: 10, width: 700, height: 450 });
    });

    it('meets preset minimums without changing aspect ratio and caps oversized diagrams', () => {
        expect(calculateErdDraftExportSize({ width: 800, height: 600, minWidth: 2560, minHeight: 1440, scale: 3 }))
            .toEqual({ width: 2560, height: 1920, scale: 3.2 });
        expect(calculateErdDraftExportSize({ width: 12000, height: 6000, minWidth: 3840, minHeight: 2160, scale: 4 }))
            .toEqual({ width: 8192, height: 4096, scale: 8192 / 12000 });
    });

    it('captures the entire diagram without mutating the live viewport or selection', async () => {
        const canvasElement = document.createElement('section');
        canvasElement.style.setProperty('--draft-canvas', '#ffffff');
        canvasElement.innerHTML = `
            <div class="react-flow">
                <div class="react-flow__viewport">
                    <div class="react-flow__node selected is-selected"></div>
                    <svg><path class="react-flow__edge-path" style="stroke: var(--draft-edge); stroke-width: 2;"></path></svg>
                    <button class="erd-draft-waypoint"></button>
                </div>
            </div>`;
        document.body.appendChild(canvasElement);
        const flowRoot = canvasElement.querySelector('.react-flow');
        const edge = canvasElement.querySelector('.react-flow__edge-path');
        flowRoot.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 });
        edge.getBoundingClientRect = () => ({ x: 10, y: 30, left: 10, top: 30, right: 410, bottom: 230, width: 400, height: 200 });
        const nativeGetComputedStyle = window.getComputedStyle;
        const computedStyle = vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
            if (element === edge) return { stroke: 'rgb(126, 133, 141)', strokeWidth: '2px', strokeDasharray: 'none' };
            return nativeGetComputedStyle(element);
        });
        const toPngImpl = vi.fn(async (_target, options) => {
            expect(canvasElement.querySelector('.react-flow__node')).not.toHaveClass('selected');
            expect(edge.style.stroke).toBe('rgb(126, 133, 141)');
            expect(options.filter(canvasElement.querySelector('.erd-draft-waypoint'))).toBe(false);
            return 'data:image/png;base64,builder';
        });

        const result = await exportErdDraftPng({
            canvasElement,
            nodes: [{ position: { x: 100, y: 50 }, data: { shape: 'entity', label: 'Patient' } }],
            viewport: { x: 55, y: 66, zoom: 1.5 },
            screenToFlowPosition: ({ x, y }) => ({ x, y }),
            scope: 'diagram',
            minWidth: 992,
            minHeight: 592,
            scale: 2,
            toPngImpl,
        });

        expect(result).toEqual({ dataUrl: 'data:image/png;base64,builder', width: 992, height: 592, scale: 2 });
        expect(toPngImpl).toHaveBeenCalledWith(canvasElement.querySelector('.react-flow__viewport'), expect.objectContaining({
            width: 496,
            height: 296,
            canvasWidth: 992,
            canvasHeight: 592,
            pixelRatio: 1,
            skipAutoScale: true,
            backgroundColor: '#ffffff',
            style: expect.objectContaining({ transform: 'translate(38px, 18px) scale(1)' }),
        }));
        expect(canvasElement.querySelector('.react-flow__node')).toHaveClass('selected', 'is-selected');
        expect(edge.style.stroke).toBe('var(--draft-edge)');
        computedStyle.mockRestore();
        canvasElement.remove();
    });

    it('uses the live camera only for current-view capture', async () => {
        const canvasElement = document.createElement('section');
        canvasElement.innerHTML = '<div class="react-flow"><div class="react-flow__viewport"></div></div>';
        canvasElement.querySelector('.react-flow').getBoundingClientRect = () => ({ width: 1000, height: 500 });
        const toPngImpl = vi.fn(async () => 'data:image/png;base64,current');

        await exportErdDraftPng({
            canvasElement,
            viewport: { x: -120, y: 80, zoom: 1.25 },
            minWidth: 2000,
            minHeight: 1000,
            scale: 2,
            toPngImpl,
        });

        expect(toPngImpl.mock.calls[0][1].style.transform).toBe('translate(-120px, 80px) scale(1.25)');
        canvasElement.remove();
    });
});
