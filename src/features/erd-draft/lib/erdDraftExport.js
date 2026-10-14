/** React Flow snapshot adapter for ERD Builder image exports. */
import { toPng } from 'html-to-image';
import { draftNodeSize } from './erdDraftGeometry';

export const ERD_DRAFT_EXPORT_MAX_SIDE = 8192;
export const ERD_DRAFT_EXPORT_PADDING = 48;

function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function mergeBounds(bounds, nextBounds) {
    if (!nextBounds || nextBounds.width < 0 || nextBounds.height < 0) return bounds;
    if (!bounds) return { ...nextBounds };
    const left = Math.min(bounds.x, nextBounds.x);
    const top = Math.min(bounds.y, nextBounds.y);
    const right = Math.max(bounds.x + bounds.width, nextBounds.x + nextBounds.width);
    const bottom = Math.max(bounds.y + bounds.height, nextBounds.y + nextBounds.height);
    return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Includes node geometry plus any routed connector/label DOM that extends beyond it. */
export function getErdDraftExportBounds(nodes = [], extraBounds = []) {
    let bounds = null;
    nodes.forEach((node) => {
        if (node.hidden) return;
        const fallbackSize = draftNodeSize(
            node?.data?.shape,
            node?.data?.sizeScale,
            node?.data?.label,
            node?.data?.textScale,
        );
        const width = finiteNumber(node?.measured?.width ?? node?.width, fallbackSize.width);
        const height = finiteNumber(node?.measured?.height ?? node?.height, fallbackSize.height);
        bounds = mergeBounds(bounds, {
            x: finiteNumber(node?.position?.x),
            y: finiteNumber(node?.position?.y),
            width: Math.max(1, width),
            height: Math.max(1, height),
        });
    });
    extraBounds.forEach((item) => { bounds = mergeBounds(bounds, item); });
    return bounds;
}

/** Preserves the capture aspect ratio while meeting preset minimums and the renderer safety cap. */
export function calculateErdDraftExportSize({ width, height, minWidth, minHeight, scale, maxSize = ERD_DRAFT_EXPORT_MAX_SIDE }) {
    const baseWidth = Math.max(1, Math.ceil(finiteNumber(width, 1)));
    const baseHeight = Math.max(1, Math.ceil(finiteNumber(height, 1)));
    const requestedScale = Math.max(
        finiteNumber(scale, 1),
        finiteNumber(minWidth, 0) / baseWidth,
        finiteNumber(minHeight, 0) / baseHeight,
    );
    const cappedScale = Math.min(requestedScale, maxSize / baseWidth, maxSize / baseHeight);
    const exportScale = Math.max(1 / Math.max(baseWidth, baseHeight), cappedScale);
    return {
        width: Math.max(1, Math.round(baseWidth * exportScale)),
        height: Math.max(1, Math.round(baseHeight * exportScale)),
        scale: exportScale,
    };
}

function getVisibleFlowBounds(canvasElement, screenToFlowPosition) {
    if (typeof screenToFlowPosition !== 'function') return [];
    const selector = '.react-flow__edge-path, .erd-draft-edge-label, .erd-draft-end-label, .erd-draft-attribute-toggle';
    return [...canvasElement.querySelectorAll(selector)].flatMap((element) => {
        const rect = element.getBoundingClientRect();
        if (!Number.isFinite(rect.left) || (!rect.width && !rect.height)) return [];
        const start = screenToFlowPosition({ x: rect.left, y: rect.top });
        const end = screenToFlowPosition({ x: rect.right, y: rect.bottom });
        return [{
            x: Math.min(start.x, end.x),
            y: Math.min(start.y, end.y),
            width: Math.max(1, Math.abs(end.x - start.x)),
            height: Math.max(1, Math.abs(end.y - start.y)),
        }];
    });
}

function shouldIncludeExportNode(node) {
    if (!(node instanceof Element)) return true;
    return !node.matches([
        '.react-flow__handle',
        '.react-flow__resize-control',
        '.erd-draft-edge-hit-path',
        '.erd-draft-endpoint-grip',
        '.erd-draft-waypoint',
    ].join(','));
}

function materializeConnectorStyles(flowViewport) {
    return [...flowViewport.querySelectorAll('.react-flow__edge-path')].map((element) => {
        const styleAttribute = element.getAttribute('style');
        const computedStyle = getComputedStyle(element);
        // html-to-image clones the viewport outside the Builder theme scope. Resolve
        // custom-property SVG strokes now so the cloned paths keep their visible color.
        if (computedStyle.stroke) element.style.stroke = computedStyle.stroke;
        if (computedStyle.strokeWidth) element.style.strokeWidth = computedStyle.strokeWidth;
        if (computedStyle.strokeDasharray) element.style.strokeDasharray = computedStyle.strokeDasharray;
        return { element, styleAttribute };
    });
}

function restoreConnectorStyles(styles) {
    styles.forEach(({ element, styleAttribute }) => {
        if (styleAttribute === null) element.removeAttribute('style');
        else element.setAttribute('style', styleAttribute);
    });
}

/** Produces the PNG snapshot contract consumed by the shared PNG/SVG/PDF downloader. */
export async function exportErdDraftPng({
    canvasElement,
    nodes = [],
    viewport = { x: 0, y: 0, zoom: 1 },
    screenToFlowPosition,
    scope = 'viewport',
    minWidth = 2560,
    minHeight = 1440,
    scale = 3,
    maxSize = ERD_DRAFT_EXPORT_MAX_SIDE,
    toPngImpl = toPng,
}) {
    const flowRoot = canvasElement?.querySelector('.react-flow');
    const flowViewport = flowRoot?.querySelector('.react-flow__viewport');
    if (!flowRoot || !flowViewport) return null;

    const rootRect = flowRoot.getBoundingClientRect();
    let width = Math.max(1, rootRect.width || flowRoot.clientWidth);
    let height = Math.max(1, rootRect.height || flowRoot.clientHeight);
    let transform = `translate(${finiteNumber(viewport.x)}px, ${finiteNumber(viewport.y)}px) scale(${Math.max(0.01, finiteNumber(viewport.zoom, 1))})`;

    if (scope === 'diagram') {
        const diagramBounds = getErdDraftExportBounds(
            nodes,
            getVisibleFlowBounds(canvasElement, screenToFlowPosition),
        );
        if (!diagramBounds) return null;
        width = Math.max(1, Math.ceil(diagramBounds.width + ERD_DRAFT_EXPORT_PADDING * 2));
        height = Math.max(1, Math.ceil(diagramBounds.height + ERD_DRAFT_EXPORT_PADDING * 2));
        transform = `translate(${ERD_DRAFT_EXPORT_PADDING - diagramBounds.x}px, ${ERD_DRAFT_EXPORT_PADDING - diagramBounds.y}px) scale(1)`;
    }

    const output = calculateErdDraftExportSize({ width, height, minWidth, minHeight, scale, maxSize });
    const backgroundColor = getComputedStyle(canvasElement).getPropertyValue('--draft-canvas').trim() || '#ffffff';
    const connectorStyles = materializeConnectorStyles(flowViewport);
    const selectedElements = [...flowViewport.querySelectorAll('.selected, .is-selected')];
    selectedElements.forEach((element) => {
        element.dataset.erdDraftExportSelectedClasses = ['selected', 'is-selected'].filter((name) => element.classList.contains(name)).join(' ');
        element.classList.remove('selected', 'is-selected');
    });

    try {
        const dataUrl = await toPngImpl(flowViewport, {
            width,
            height,
            canvasWidth: output.width,
            canvasHeight: output.height,
            pixelRatio: 1,
            skipAutoScale: true,
            cacheBust: true,
            backgroundColor,
            filter: shouldIncludeExportNode,
            style: {
                width: `${width}px`,
                height: `${height}px`,
                transform,
                transformOrigin: '0 0',
            },
        });
        return { dataUrl, width: output.width, height: output.height, scale: output.scale };
    } finally {
        restoreConnectorStyles(connectorStyles);
        selectedElements.forEach((element) => {
            const classNames = element.dataset.erdDraftExportSelectedClasses?.split(' ').filter(Boolean) || [];
            classNames.forEach((name) => element.classList.add(name));
            delete element.dataset.erdDraftExportSelectedClasses;
        });
    }
}
