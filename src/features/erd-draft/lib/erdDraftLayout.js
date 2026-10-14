/** Graph-aware layout choices for the free-form ERD Builder. */
import { getDraftIsaConnection, getDraftCategoryConnection, isDraftEntityShape, isDraftRelationshipShape } from './erdDraftSemantics';
import { getDraftAttributeTrees } from './erdDraftModelTools';
import { draftNodeSize, findOpenNodePosition } from './erdDraftGeometry';

/** Orient only the layout graph; persisted endpoints/handles and roles remain unchanged. */
export function draftLayoutEdges(nodes, edges) {
    const byId = new Map(nodes.map(node => [node.id, node]));
    return edges.filter(edge => edge.data?.connectionKind !== 'annotation').map(edge => {
        const source = byId.get(edge.source);
        const target = byId.get(edge.target);
        const isa = getDraftIsaConnection(source, target);
        const category = getDraftCategoryConnection(source, target);
        let from = edge.source;
        let to = edge.target;
        if (isa && ['supertype', 'subtype'].includes(edge.data?.isaRole)) {
            from = edge.data.isaRole === 'supertype' ? isa.entity.id : isa.isa.id;
            to = edge.data.isaRole === 'supertype' ? isa.isa.id : isa.entity.id;
        } else if (category && ['member', 'result'].includes(edge.data?.categoryRole)) {
            from = edge.data.categoryRole === 'member' ? category.entity.id : category.category.id;
            to = edge.data.categoryRole === 'member' ? category.category.id : category.entity.id;
        }
        return { id: edge.id, sources: [from], targets: [to] };
    });
}

export const ERD_DRAFT_LAYOUT_MODES = Object.freeze({
    SMART: 'smart',
    CHEN: 'chen',
    HORIZONTAL: 'horizontal',
    VERTICAL: 'vertical',
    RADIAL: 'radial',
    ORGANIC: 'organic',
    COMPACT: 'compact',
    GRID: 'grid',
});

export const ERD_DRAFT_LAYOUT_OPTIONS = Object.freeze([
    {
        mode: ERD_DRAFT_LAYOUT_MODES.SMART,
        badge: 'AUTO',
        title: 'Smart arrangement',
        note: 'Chooses the best layout from the shape connections.',
    },
    {
        mode: ERD_DRAFT_LAYOUT_MODES.CHEN,
        badge: 'ER',
        title: 'Chen arrangement',
        note: 'Keeps attributes around their entities and relationships.',
    },
    {
        mode: ERD_DRAFT_LAYOUT_MODES.HORIZONTAL,
        badge: 'LR',
        title: 'Left to right',
        note: 'Clear horizontal flow for relationship chains.',
    },
    {
        mode: ERD_DRAFT_LAYOUT_MODES.VERTICAL,
        badge: 'TD',
        title: 'Top to bottom',
        note: 'Vertical hierarchy for subtype and dependency trees.',
    },
    {
        mode: ERD_DRAFT_LAYOUT_MODES.RADIAL,
        badge: 'RAD',
        title: 'Radial',
        note: 'Places highly connected shapes around a central hub.',
    },
    {
        mode: ERD_DRAFT_LAYOUT_MODES.ORGANIC,
        badge: 'ORG',
        title: 'Organic',
        note: 'Balances dense or cyclic models with natural spacing.',
    },
    {
        mode: ERD_DRAFT_LAYOUT_MODES.COMPACT,
        badge: 'CMP',
        title: 'Compact tree',
        note: 'Uses less space for tree-like diagrams.',
    },
    {
        mode: ERD_DRAFT_LAYOUT_MODES.GRID,
        badge: 'GRID',
        title: 'Grid',
        note: 'Orders disconnected shapes into tidy rows.',
    },
]);

const VALID_LAYOUT_MODES = new Set(ERD_DRAFT_LAYOUT_OPTIONS.map((option) => option.mode));

export function normalizeErdDraftLayoutMode(mode) {
    return VALID_LAYOUT_MODES.has(mode) ? mode : ERD_DRAFT_LAYOUT_MODES.SMART;
}

export function analyzeErdDraftLayoutGraph(nodes = [], edges = []) {
    const nodeIds = new Set((Array.isArray(nodes) ? nodes : []).map((node) => String(node?.id || '')).filter(Boolean));
    const adjacency = new Map([...nodeIds].map((id) => [id, new Set()]));
    let relationCount = 0;

    (Array.isArray(edges) ? edges : []).forEach((edge) => {
        const source = String(edge?.source || '');
        const target = String(edge?.target || '');
        if (!nodeIds.has(source) || !nodeIds.has(target) || source === target) return;
        if (!adjacency.get(source).has(target)) relationCount += 1;
        adjacency.get(source).add(target);
        adjacency.get(target).add(source);
    });

    const connectedNodeIds = [...nodeIds].filter((id) => adjacency.get(id).size > 0);
    const connectedCount = connectedNodeIds.length;
    const maxDegree = connectedNodeIds.reduce((maximum, id) => Math.max(maximum, adjacency.get(id).size), 0);
    const possibleRelations = connectedCount > 1 ? (connectedCount * (connectedCount - 1)) / 2 : 0;
    const density = possibleRelations > 0 ? relationCount / possibleRelations : 0;
    const hubRatio = connectedCount > 1 ? maxDegree / (connectedCount - 1) : 0;

    return {
        nodeCount: nodeIds.size,
        connectedCount,
        relationCount,
        maxDegree,
        density,
        hubRatio,
    };
}

export function chooseSmartErdDraftLayout(nodes = [], edges = []) {
    const modelEdges = edges.filter(edge => edge.data?.connectionKind !== 'annotation');
    const profile = analyzeErdDraftLayoutGraph(nodes, modelEdges);
    const byId = new Map(nodes.map(node => [node.id, node]));
    const hasHierarchy = modelEdges.some(edge => {
        const source = byId.get(edge.source);
        const target = byId.get(edge.target);
        return (getDraftIsaConnection(source, target) && ['supertype', 'subtype'].includes(edge.data?.isaRole))
            || (getDraftCategoryConnection(source, target) && ['member', 'result'].includes(edge.data?.categoryRole));
    });
    if (hasHierarchy) return ERD_DRAFT_LAYOUT_MODES.VERTICAL;
    if (getDraftAttributeTrees(nodes, modelEdges).ownerByAttribute.size) return ERD_DRAFT_LAYOUT_MODES.CHEN;
    if (profile.connectedCount <= 1 || profile.relationCount === 0) return ERD_DRAFT_LAYOUT_MODES.GRID;
    if (profile.connectedCount >= 6 && profile.density >= 0.42) return ERD_DRAFT_LAYOUT_MODES.ORGANIC;
    if (profile.connectedCount >= 5 && profile.maxDegree >= 4 && profile.hubRatio >= 0.45) return ERD_DRAFT_LAYOUT_MODES.RADIAL;
    return ERD_DRAFT_LAYOUT_MODES.HORIZONTAL;
}

export function getErdDraftLayoutPlan(mode, nodes = [], edges = []) {
    const requestedMode = normalizeErdDraftLayoutMode(mode);
    const resolvedMode = requestedMode === ERD_DRAFT_LAYOUT_MODES.SMART
        ? chooseSmartErdDraftLayout(nodes, edges)
        : requestedMode;

    const sharedLayeredOptions = {
        'elk.algorithm': 'layered',
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.spacing.nodeNode': '75',
        'elk.layered.spacing.nodeNodeBetweenLayers': '115',
        'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    };

    const layoutOptionsByMode = {
        [ERD_DRAFT_LAYOUT_MODES.CHEN]: {
            ...sharedLayeredOptions,
            'elk.direction': chooseSmartErdDraftLayout(nodes, edges) === ERD_DRAFT_LAYOUT_MODES.VERTICAL ? 'DOWN' : 'RIGHT',
        },
        [ERD_DRAFT_LAYOUT_MODES.HORIZONTAL]: {
            ...sharedLayeredOptions,
            'elk.direction': 'RIGHT',
        },
        [ERD_DRAFT_LAYOUT_MODES.VERTICAL]: {
            ...sharedLayeredOptions,
            'elk.direction': 'DOWN',
        },
        [ERD_DRAFT_LAYOUT_MODES.RADIAL]: {
            'elk.algorithm': 'radial',
            'elk.spacing.nodeNode': '75',
        },
        [ERD_DRAFT_LAYOUT_MODES.ORGANIC]: {
            'elk.algorithm': 'stress',
            'elk.spacing.nodeNode': '70',
            'elk.stress.desiredEdgeLength': '190',
        },
        [ERD_DRAFT_LAYOUT_MODES.COMPACT]: {
            'elk.algorithm': 'mrtree',
            'elk.direction': 'RIGHT',
            'elk.spacing.nodeNode': '45',
            'elk.spacing.edgeNode': '30',
            'elk.mrtree.weighting': 'CONSTRAINT',
        },
        [ERD_DRAFT_LAYOUT_MODES.GRID]: {
            'elk.algorithm': 'box',
            'elk.spacing.nodeNode': '70',
        },
    };

    return {
        requestedMode,
        resolvedMode,
        layoutOptions: layoutOptionsByMode[resolvedMode],
        option: ERD_DRAFT_LAYOUT_OPTIONS.find((option) => option.mode === requestedMode),
    };
}

/** Lay out the backbone with envelopes that reserve room for each attribute tree. */
export function createChenDraftLayoutGraph(nodes, edges) {
    const trees = getDraftAttributeTrees(nodes, edges);
    const byId = new Map(nodes.map(node => [node.id, node]));
    const sizes = new Map(nodes.map(node => [node.id, draftNodeSize(node.data?.shape, node.data?.sizeScale, node.data?.label, node.data?.textScale)]));
    const childrenByParent = new Map();
    for (const [id, parent] of trees.parentByAttribute) childrenByParent.set(parent, [...(childrenByParent.get(parent) || []), id]);
    const subtreeWidths = new Map();
    // Ownership traversal records parents before children. A reverse pass computes
    // subtree widths without recursion, including deeply nested imported models.
    for (const id of [...trees.parentByAttribute.keys()].reverse()) {
        const children = childrenByParent.get(id) || [];
        const width = Math.max(sizes.get(id).width, children.reduce((sum, child) => sum + subtreeWidths.get(child), 0) + Math.max(0, children.length - 1) * 36);
        subtreeWidths.set(id, width);
    }
    const widthOf = id => subtreeWidths.get(id);
    const groups = new Map();
    const children = nodes.filter(node => !trees.ownerByAttribute.has(node.id)).map(root => {
        const positions = new Map([[root.id, { x: 0, y: 0 }]]);
        const rootSize = sizes.get(root.id);
        const direct = childrenByParent.get(root.id) || [];
        const rows = [
            { ids: direct.filter((_id, index) => index % 2 === 1), parentX: 0, parentY: 0, parentHeight: rootSize.height, direction: 1 },
            { ids: direct.filter((_id, index) => index % 2 === 0), parentX: 0, parentY: 0, parentHeight: rootSize.height, direction: -1 },
        ];
        while (rows.length) {
            const { ids, parentX, parentY, parentHeight, direction } = rows.pop();
            const width = ids.reduce((sum, id) => sum + widthOf(id), 0) + Math.max(0, ids.length - 1) * 36;
            let left = parentX - width / 2;
            for (const id of ids) {
                const size = sizes.get(id);
                const x = left + widthOf(id) / 2;
                const y = parentY + direction * (parentHeight / 2 + 68 + size.height / 2);
                positions.set(id, { x, y });
                const childIds = childrenByParent.get(id) || [];
                if (childIds.length) rows.push({ ids: childIds, parentX: x, parentY: y, parentHeight: size.height, direction });
                left += widthOf(id) + 36;
            }
        }
        let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
        for (const [id, center] of positions) {
            const size = sizes.get(id);
            left = Math.min(left, center.x - size.width / 2);
            top = Math.min(top, center.y - size.height / 2);
            right = Math.max(right, center.x + size.width / 2);
            bottom = Math.max(bottom, center.y + size.height / 2);
        }
        // ELK aligns envelope centers. Symmetric padding keeps the real owner
        // centered too, even when every attribute occupies only one side.
        const halfWidth = Math.max(-left, right);
        const halfHeight = Math.max(-top, bottom);
        left = -halfWidth;
        right = halfWidth;
        top = -halfHeight;
        bottom = halfHeight;
        const offsets = new Map([...positions].map(([id, center]) => [id, { x: center.x - sizes.get(id).width / 2 - left, y: center.y - sizes.get(id).height / 2 - top }]));
        groups.set(root.id, offsets);
        return { id: root.id, width: right - left, height: bottom - top };
    });
    const backboneIds = new Set(children.map(node => node.id));
    return {
        children,
        edges: draftLayoutEdges(nodes, edges).filter(edge => backboneIds.has(edge.sources[0]) && backboneIds.has(edge.targets[0])),
        groups,
        sizes,
        byId,
    };
}

/** Anchor locked owners, preserve all locked positions, and avoid their occupied space. */
export function applyChenDraftLayout(nodes, graph, result) {
    const positions = new Map();
    const occupied = nodes.filter(node => node.data?.positionLocked).map(node => ({ ...node.position, ...graph.sizes.get(node.id) }));
    for (const root of result.children || []) {
        const offsets = graph.groups.get(root.id);
        const owner = graph.byId.get(root.id);
        if (!offsets || !owner) continue;
        const ownerOffset = offsets.get(root.id);
        let origin = owner.data?.positionLocked
            ? { x: owner.position.x - ownerOffset.x, y: owner.position.y - ownerOffset.y }
            : { x: root.x || 0, y: root.y || 0 };
        for (const [id, offset] of offsets) {
            const node = graph.byId.get(id);
            const preferred = { x: origin.x + offset.x, y: origin.y + offset.y };
            const position = node.data?.positionLocked ? node.position : findOpenNodePosition(preferred, graph.sizes.get(id), occupied);
            positions.set(id, position);
            if (!node.data?.positionLocked) occupied.push({ ...position, ...graph.sizes.get(id) });
            if (id === root.id) origin = { x: position.x - ownerOffset.x, y: position.y - ownerOffset.y };
        }
    }
    return nodes.map(node => ({ ...node, position: positions.get(node.id) || node.position }));
}

function repeatedParticipationGroups(nodes, edges) {
    const byId = new Map(nodes.map(node => [node.id, node]));
    const groups = new Map();
    for (const edge of edges) {
        if (edge.data?.connectionKind === 'annotation') continue;
        const source = byId.get(edge.source), target = byId.get(edge.target);
        const entity = isDraftEntityShape(source?.data?.shape) ? source : isDraftEntityShape(target?.data?.shape) ? target : null;
        const relationship = isDraftRelationshipShape(source?.data?.shape) ? source : isDraftRelationshipShape(target?.data?.shape) ? target : null;
        if (!entity || !relationship) continue;
        const key = JSON.stringify([entity.id, relationship.id]);
        if (!groups.has(key)) groups.set(key, { entity, relationship, edges: [] });
        groups.get(key).edges.push(edge);
    }
    return [...groups.values()].filter(group => group.edges.length > 1);
}

/** Repeated participations retain their handles and manual bends during arrangement. */
export function getDraftRepeatedParticipationIds(nodes, edges) {
    return new Set(repeatedParticipationGroups(nodes, edges).flatMap(group => group.edges.map(edge => edge.id)));
}

/** Repair coincident role paths without inferring or changing their semantic roles. */
export function separateDraftParticipationPaths(nodes, edges) {
    const replacements = new Map();
    for (const group of repeatedParticipationGroups(nodes, edges)) {
        if (group.entity.data?.positionLocked || group.relationship.data?.positionLocked) continue;
        const seen = new Set();
        for (const edge of group.edges) {
            const forward = edge.source === group.entity.id;
            const handles = forward ? [edge.sourceHandle, edge.targetHandle] : [edge.targetHandle, edge.sourceHandle];
            const stored = edge.data?.waypoints?.[0];
            let control = stored && Number.isFinite(stored.t)
                ? { t: forward ? stored.t : 1 - stored.t, offset: forward ? stored.offset : -stored.offset }
                : stored || null;
            if (control && control.offset === 0 && control.t >= 0 && control.t <= 1) control = null;
            const signature = () => JSON.stringify([handles, control]);
            if (seen.has(signature())) {
                let offset = 48;
                do { control = { t: 0.5, offset }; offset += 48; } while (seen.has(signature()));
                replacements.set(edge.id, { ...edge, data: { ...edge.data, waypoints: [{ t: 0.5, offset: forward ? control.offset : -control.offset }] } });
            }
            seen.add(signature());
        }
    }
    return edges.map(edge => replacements.get(edge.id) || edge);
}
