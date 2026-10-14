/** Pure selection operations. Clipboard fragments never include external connectors. */
import { draftNodeSize } from './erdDraftGeometry';

const clone = (value) => JSON.parse(JSON.stringify(value));

export function removeDraftSelection(nodes, edges) {
    const removed = new Set(nodes.filter(node => node.selected).map(node => node.id));
    return {
        nodes: nodes.filter(node => !removed.has(node.id)),
        edges: edges.filter(edge => !edge.selected && !removed.has(edge.source) && !removed.has(edge.target)),
    };
}

export function copyDraftSelection(nodes, edges) {
    const selected = nodes.filter(node => node.selected);
    const ids = new Set(selected.map(node => node.id));
    return clone({ nodes: selected, edges: edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) });
}

export function pasteDraftSelection(fragment, offset = 32, makeId = () => crypto.randomUUID()) {
    const ids = new Map(fragment.nodes.map(node => [node.id, makeId()]));
    const translate = (point) => point && Number.isFinite(point.x) && Number.isFinite(point.y)
        ? { ...point, x: point.x + offset, y: point.y + offset } : point ? { ...point } : point;
    return {
        nodes: fragment.nodes.map(node => {
            const copied = clone(node);
            delete copied.measured;
            delete copied.dragging;
            delete copied.width;
            delete copied.height;
            delete copied.draggable;
            return { ...copied, id: ids.get(node.id), selected: true, position: translate(node.position), data: { ...copied.data, positionLocked: false } };
        }),
        edges: fragment.edges.map(edge => ({
            ...clone(edge), id: makeId(), source: ids.get(edge.source), target: ids.get(edge.target), selected: true,
            data: {
                ...clone(edge.data || {}),
                waypoints: (edge.data?.waypoints || []).map(translate),
                sourceLabelPosition: translate(edge.data?.sourceLabelPosition),
                targetLabelPosition: translate(edge.data?.targetLabelPosition),
            },
        })),
    };
}

/** Align/distribute unlocked selected shapes using the same sizes as rendering. */
export function arrangeDraftSelection(nodes, mode) {
    const horizontal = ['left', 'center', 'right', 'horizontal'].includes(mode);
    if (!['left', 'center', 'right', 'top', 'middle', 'bottom', 'horizontal', 'vertical'].includes(mode)) return nodes;
    const axis = horizontal ? 'x' : 'y';
    const sizeKey = horizontal ? 'width' : 'height';
    const items = nodes.filter(node => node.selected && !node.data?.positionLocked).map(node => ({
        node,
        size: draftNodeSize(node.data?.shape, node.data?.sizeScale, node.data?.label, node.data?.textScale)[sizeKey],
    }));
    const distribute = mode === 'horizontal' || mode === 'vertical';
    if (items.length < (distribute ? 3 : 2)) return nodes;
    const start = Math.min(...items.map(({ node }) => node.position[axis]));
    const end = Math.max(...items.map(({ node, size }) => node.position[axis] + size));
    const positions = new Map();
    if (distribute) {
        items.sort((a, b) => a.node.position[axis] - b.node.position[axis]);
        const gap = (end - start - items.reduce((sum, item) => sum + item.size, 0)) / (items.length - 1);
        let cursor = start;
        items.forEach(({ node, size }) => { positions.set(node.id, cursor); cursor += size + gap; });
    } else {
        items.forEach(({ node, size }) => positions.set(node.id,
            ['left', 'top'].includes(mode) ? start : ['right', 'bottom'].includes(mode) ? end - size : (start + end - size) / 2));
    }
    return nodes.map(node => positions.has(node.id) ? { ...node, position: { ...node.position, [axis]: positions.get(node.id) } } : node);
}
