/** Safe attribute ownership, temporary canvas views, and connected Chen creation. */
import { shapeCatalog } from '../data/draftTemplate';
import { draftNodeSize, findOpenNodePosition } from './erdDraftGeometry';
import { isDraftAttributeShape, isDraftEntityShape, isDraftRelationshipShape, isDraftSemanticConnection, normalizeDraftNodeSemantics } from './erdDraftSemantics';

const nodeSize = node => draftNodeSize(node.data?.shape, node.data?.sizeScale, node.data?.label, node.data?.textScale);

/** Only singly rooted, acyclic attribute trees can be folded or arranged as a group. */
export function getDraftAttributeTrees(nodes, edges) {
    const byId = new Map(nodes.map(node => [node.id, node]));
    const adjacency = new Map(nodes.map(node => [node.id, new Set()]));
    for (const edge of edges) {
        if (edge.data?.connectionKind === 'annotation' || !byId.has(edge.source) || !byId.has(edge.target)) continue;
        adjacency.get(edge.source).add(edge.target);
        adjacency.get(edge.target).add(edge.source);
    }
    const ownerByAttribute = new Map();
    const parentByAttribute = new Map();
    const attributesByOwner = new Map();
    const visited = new Set();
    for (const node of nodes) {
        if (!isDraftAttributeShape(node.data?.shape) || visited.has(node.id)) continue;
        const component = [];
        const queue = [node.id];
        const roots = [];
        let innerLinks = 0;
        let valid = true;
        while (queue.length) {
            const id = queue.pop();
            if (visited.has(id)) continue;
            visited.add(id);
            component.push(id);
            for (const other of adjacency.get(id)) {
                const neighbor = byId.get(other);
                if (isDraftAttributeShape(neighbor.data?.shape)) {
                    innerLinks += 1;
                    if (!isDraftSemanticConnection(byId.get(id).data.shape, neighbor.data.shape)) valid = false;
                    if (!visited.has(other)) queue.push(other);
                } else {
                    roots.push({ owner: other, attribute: id });
                    if (!isDraftEntityShape(neighbor.data?.shape) && !isDraftRelationshipShape(neighbor.data?.shape)) valid = false;
                }
            }
        }
        if (!valid || roots.length !== 1 || innerLinks / 2 !== component.length - 1) continue;
        const { owner, attribute } = roots[0];
        const pending = [[attribute, owner]];
        while (pending.length) {
            const [id, parent] = pending.pop();
            if (ownerByAttribute.has(id)) continue;
            ownerByAttribute.set(id, owner);
            parentByAttribute.set(id, parent);
            for (const other of adjacency.get(id)) {
                if (other !== parent && isDraftAttributeShape(byId.get(other)?.data?.shape)) pending.push([other, id]);
            }
        }
        attributesByOwner.set(owner, [...(attributesByOwner.get(owner) || []), ...component]);
    }
    return { ownerByAttribute, parentByAttribute, attributesByOwner };
}

/** Presentation is derived separately from the authoritative saved graph. */
export function getDraftCanvasView(nodes, edges, trees, { showAttributes = true, collapsedOwners = new Set(), focusId = null } = {}) {
    const hiddenNodes = new Set();
    for (const [attribute, owner] of trees.ownerByAttribute) {
        if (!showAttributes || collapsedOwners.has(owner)) hiddenNodes.add(attribute);
    }
    const activeNodes = new Set();
    const ids = new Set(nodes.map(node => node.id));
    const shapes = new Map(nodes.map(node => [node.id, node.data?.shape]));
    const rootId = trees.ownerByAttribute.get(focusId) || focusId;
    const focused = ids.has(rootId);
    if (focused) {
        activeNodes.add(rootId);
        // Two semantic hops include a relationship and its participants; annotations
        // and attribute branches never lead into unrelated entity neighborhoods.
        let frontier = new Set([rootId]);
        for (let hop = 0; hop < 2; hop++) {
            const next = new Set();
            for (const edge of edges) {
                if (edge.data?.connectionKind === 'annotation') continue;
                for (const [from, to] of [[edge.source, edge.target], [edge.target, edge.source]]) {
                    if (frontier.has(from) && ids.has(to) && !isDraftAttributeShape(shapes.get(to))) next.add(to);
                }
            }
            for (const id of next) activeNodes.add(id);
            frontier = next;
        }
        for (const [attribute, owner] of trees.ownerByAttribute) if (activeNodes.has(owner)) activeNodes.add(attribute);
    }
    const hiddenEdges = new Set(edges.filter(edge => hiddenNodes.has(edge.source) || hiddenNodes.has(edge.target)).map(edge => edge.id));
    const dimmedEdges = new Set(focused ? edges.filter(edge => !activeNodes.has(edge.source) || !activeNodes.has(edge.target)).map(edge => edge.id) : []);
    return { hiddenNodes, hiddenEdges, activeNodes, focused, dimmedEdges };
}

/** Reveal requested attribute groups while preserving every unrelated collapse. */
export function revealDraftAttributeGroups(trees, { showAttributes, collapsedOwners }, nodeIds) {
    const reveal = new Set(nodeIds.map(id => trees.ownerByAttribute.get(id) || id).filter(id => trees.attributesByOwner.has(id)));
    if (!reveal.size) return { showAttributes, collapsedOwners };
    const next = new Set(showAttributes ? collapsedOwners : trees.attributesByOwner.keys());
    for (const owner of reveal) next.delete(owner);
    return { showAttributes: true, collapsedOwners: next };
}

/** Valid attribute types for contextual creation; weak entities expose partial keys. */
export function connectedDraftAttributeShapes(shape) {
    if (!isDraftEntityShape(shape) && !isDraftRelationshipShape(shape) && shape !== 'compositeAttribute') return [];
    return shapeCatalog.filter(item => isDraftAttributeShape(item.type)
        && (item.type !== 'partialKeyAttribute' || shape === 'weakEntity')
        && (item.type !== 'keyAttribute' || isDraftEntityShape(shape)));
}

/** Creates a whole fragment without guessing cardinality, participation, or roles. */
export function createConnectedDraftFragment(nodes, { ownerId, shape = 'attribute', label, targetId, entityLabel, relationshipLabel }, makeId = () => crypto.randomUUID()) {
    const owner = nodes.find(node => node.id === ownerId);
    if (!owner) return null;
    const addedNodes = [];
    const addedEdges = [];
    const occupied = nodes.map(node => ({ ...node.position, ...nodeSize(node) }));
    const add = (type, name, preferred) => {
        const catalog = shapeCatalog.find(item => item.type === type);
        const node = {
            id: makeId(), type: 'erdDraftNode',
            data: normalizeDraftNodeSemantics(type, { shape: type, label: name.trim(), color: catalog.color, description: '', sizeScale: 1, textScale: 1 }),
        };
        const size = nodeSize(node);
        node.position = findOpenNodePosition(preferred, size, occupied);
        occupied.push({ ...node.position, ...size });
        addedNodes.push(node);
        return node;
    };
    const connect = (source, target) => addedEdges.push({ id: makeId(), type: 'erdDraftEdge', source: source.id, target: target.id, data: { connectionKind: 'semantic' } });
    const ownerSize = nodeSize(owner);
    if (shape !== 'relationship') {
        if (!label?.trim() || !connectedDraftAttributeShapes(owner.data.shape).some(item => item.type === shape)) return null;
        const attr = add(shape, label, { x: owner.position.x, y: owner.position.y - 140 });
        connect(owner, attr);
        return { nodes: addedNodes, edges: addedEdges, selectedId: owner.id };
    }
    if (!isDraftEntityShape(owner.data.shape) || !relationshipLabel?.trim()) return null;
    let target = nodes.find(node => node.id === targetId);
    if (targetId && (!target || !isDraftEntityShape(target.data.shape))) return null;
    if (!target) {
        if (!entityLabel?.trim()) return null;
        target = add('entity', entityLabel, { x: owner.position.x + ownerSize.width + 350, y: owner.position.y });
    }
    const targetSize = nodeSize(target);
    const relationSize = draftNodeSize('relationship', 1, relationshipLabel.trim(), 1);
    const center = {
        x: (owner.position.x + ownerSize.width / 2 + target.position.x + targetSize.width / 2) / 2 - relationSize.width / 2,
        y: (owner.position.y + ownerSize.height / 2 + target.position.y + targetSize.height / 2) / 2 - relationSize.height / 2,
    };
    const relationship = add('relationship', relationshipLabel, center);
    connect(owner, relationship);
    connect(relationship, target);
    if (owner.id === target.id) {
        // Distinct handles keep the two roles of a recursive relationship visible.
        addedEdges[0].sourceHandle = 'top';
        addedEdges[0].targetHandle = 'left';
        addedEdges[1].sourceHandle = 'right';
        addedEdges[1].targetHandle = 'bottom';
    }
    return { nodes: addedNodes, edges: addedEdges, selectedId: relationship.id };
}
