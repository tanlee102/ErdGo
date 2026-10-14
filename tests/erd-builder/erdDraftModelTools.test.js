import { describe, expect, it } from 'vitest';
import { connectedDraftAttributeShapes, createConnectedDraftFragment, getDraftAttributeTrees, getDraftCanvasView, revealDraftAttributeGroups } from '@/features/erd-draft/lib/erdDraftModelTools';

const node = (id, shape = 'entity') => ({ id, position: { x: 0, y: 0 }, data: { shape, label: id } });
const edge = (id, source, target, data = {}) => ({ id, source, target, data });

describe('Builder connected creation and temporary detail views', () => {
    it('reveals only requested owners, including composite descendants and newly pasted groups', () => {
        const nodes = [node('one'), node('two'), node('name', 'attribute'), node('address', 'compositeAttribute'), node('street', 'attribute'), node('orphan', 'attribute')];
        const edges = [edge('1', 'one', 'name'), edge('2', 'two', 'address'), edge('3', 'address', 'street')];
        const trees = getDraftAttributeTrees(nodes, edges);
        const collapsedOwners = new Set(['one', 'two']);
        const next = revealDraftAttributeGroups(trees, { showAttributes: false, collapsedOwners }, ['street']);
        expect(next.showAttributes).toBe(true);
        expect([...next.collapsedOwners]).toEqual(['one']);
        expect([...collapsedOwners]).toEqual(['one', 'two']);
        expect(getDraftCanvasView(nodes, edges, trees, next).hiddenNodes).toEqual(new Set(['name']));
        const unchanged = revealDraftAttributeGroups(trees, { showAttributes: false, collapsedOwners }, ['orphan', 'deleted']);
        expect(unchanged).toEqual({ showAttributes: false, collapsedOwners });
    });

    it('preserves ownership and visibility across deterministic graph permutations and annotation noise', () => {
        let seed = 718;
        const random = limit => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
        for (let sample = 0; sample < 80; sample++) {
            const nodes = [node('one'), node('two'), node('note', 'note')];
            const edges = [];
            const expectedOwners = new Map();
            for (const owner of ['one', 'two']) {
                const parentCandidates = [owner];
                for (let i = 0, count = random(12) + 1; i < count; i++) {
                    const id = `${owner}-${i}`;
                    nodes.push(node(id, 'compositeAttribute'));
                    edges.push(edge(`semantic-${id}`, parentCandidates[random(parentCandidates.length)], id));
                    if (random(2)) edges.push(edge(`duplicate-${id}`, id, edges.at(-1).source));
                    edges.push(edge(`annotation-${id}`, 'note', id, { connectionKind: 'annotation' }));
                    expectedOwners.set(id, owner);
                    parentCandidates.push(id);
                }
            }
            const original = JSON.stringify({ nodes, edges });
            const reversed = edges.slice().reverse().map(item => ({ ...item, source: item.target, target: item.source }));
            const trees = getDraftAttributeTrees(nodes.slice().reverse(), reversed);
            expect([...trees.ownerByAttribute].sort()).toEqual([...expectedOwners].sort());
            const view = getDraftCanvasView(nodes, reversed, trees, { collapsedOwners: new Set(['one']), focusId: 'one' });
            for (const [id, owner] of expectedOwners) {
                expect(view.hiddenNodes.has(id)).toBe(owner === 'one');
                expect(view.activeNodes.has(id)).toBe(owner === 'one');
            }
            for (const item of edges) expect(view.hiddenEdges.has(item.id)).toBe(view.hiddenNodes.has(item.source) || view.hiddenNodes.has(item.target));
            expect(JSON.stringify({ nodes, edges })).toBe(original);
        }
    });
    it('folds valid composite trees, with reversed and duplicate connectors, without mutating the model', () => {
        const nodes = [node('owner'), node('address', 'compositeAttribute'), node('street', 'attribute'), node('name', 'attribute')];
        const edges = [edge('1', 'address', 'owner'), edge('2', 'address', 'street'), edge('3', 'owner', 'name'), edge('4', 'name', 'owner')];
        const before = JSON.stringify({ nodes, edges });
        const trees = getDraftAttributeTrees(nodes, edges);
        expect([...trees.ownerByAttribute.values()]).toEqual(['owner', 'owner', 'owner']);
        expect(trees.parentByAttribute.get('street')).toBe('address');
        const view = getDraftCanvasView(nodes, edges, trees, { collapsedOwners: new Set(['owner']) });
        expect(view.hiddenNodes.size).toBe(3);
        expect(view.hiddenEdges.size).toBe(4);
        expect(JSON.stringify({ nodes, edges })).toBe(before);
    });

    it('keeps shared, cyclic, orphaned, unsupported and annotation-only attributes visible', () => {
        const nodes = [node('one'), node('two'), node('shared', 'attribute'), node('a', 'compositeAttribute'), node('b', 'compositeAttribute'), node('c', 'compositeAttribute'), node('orphan', 'attribute'), node('note', 'note'), node('invalid', 'attribute'), node('annotation', 'attribute')];
        const edges = [edge('1', 'one', 'shared'), edge('2', 'two', 'shared'), edge('3', 'one', 'a'), edge('4', 'a', 'b'), edge('5', 'b', 'c'), edge('6', 'c', 'a'), edge('7', 'note', 'invalid'), edge('8', 'one', 'annotation', { connectionKind: 'annotation' })];
        const trees = getDraftAttributeTrees(nodes, edges);
        expect(trees.ownerByAttribute.size).toBe(0);
        expect(getDraftCanvasView(nodes, edges, trees, { showAttributes: false }).hiddenNodes.size).toBe(0);
    });

    it('focuses a relationship neighborhood, includes owned attributes, and excludes annotation paths', () => {
        const nodes = [node('customer'), node('places', 'relationship'), node('order'), node('includes', 'relationship'), node('product'), node('id', 'keyAttribute'), node('shared', 'attribute')];
        const edges = [edge('1', 'customer', 'places'), edge('2', 'places', 'order'), edge('3', 'order', 'includes'), edge('4', 'includes', 'product'), edge('5', 'customer', 'id'), edge('6', 'customer', 'product', { connectionKind: 'annotation' }), edge('7', 'customer', 'shared'), edge('8', 'shared', 'product')];
        const trees = getDraftAttributeTrees(nodes, edges);
        const view = getDraftCanvasView(nodes, edges, trees, { focusId: 'id' });
        expect([...view.activeNodes].sort()).toEqual(['customer', 'id', 'order', 'places']);
        expect(view.dimmedEdges.has('4')).toBe(true);
        expect(getDraftCanvasView(nodes, edges, trees, { focusId: 'deleted' }).focused).toBe(false);
    });

    it('creates labelled, connected attributes and relationships without guessing model constraints', () => {
        const nodes = [node('owner')];
        let id = 0;
        const makeId = () => `new-${++id}`;
        const attr = createConnectedDraftFragment(nodes, { ownerId: 'owner', shape: 'keyAttribute', label: '  customer_id  ' }, makeId);
        expect(attr.nodes[0].data).toMatchObject({ shape: 'keyAttribute', label: 'customer_id' });
        expect(attr.edges[0]).toMatchObject({ source: 'owner', target: attr.nodes[0].id });
        expect(attr.selectedId).toBe('owner');
        const relation = createConnectedDraftFragment(nodes, { ownerId: 'owner', shape: 'relationship', relationshipLabel: 'places', entityLabel: 'Order' }, makeId);
        expect(relation.nodes.map(item => item.data.shape)).toEqual(['entity', 'relationship']);
        expect(relation.edges).toHaveLength(2);
        expect(relation.edges.every(item => item.data.cardinalityMode === undefined && item.data.isaRole === undefined)).toBe(true);
        expect(new Set([...attr.nodes, ...attr.edges, ...relation.nodes, ...relation.edges].map(item => item.id)).size).toBe(6);
        expect(nodes).toEqual([node('owner')]);
    });

    it('supports recursive role connectors and rejects stale targets and unsupported attribute owners', () => {
        const nodes = [node('owner'), node('note', 'note')];
        const relation = createConnectedDraftFragment(nodes, { ownerId: 'owner', targetId: 'owner', shape: 'relationship', relationshipLabel: 'supervises' });
        expect(relation.nodes).toHaveLength(1);
        expect(relation.edges[0].sourceHandle).not.toBe(relation.edges[1].targetHandle);
        expect(createConnectedDraftFragment(nodes, { ownerId: 'owner', targetId: 'deleted', shape: 'relationship', relationshipLabel: 'has' })).toBeNull();
        expect(createConnectedDraftFragment(nodes, { ownerId: 'note', label: 'name' })).toBeNull();
        expect(createConnectedDraftFragment(nodes, { ownerId: 'owner', label: ' ' })).toBeNull();
        expect(connectedDraftAttributeShapes('entity').some(item => item.type === 'partialKeyAttribute')).toBe(false);
        expect(connectedDraftAttributeShapes('weakEntity').some(item => item.type === 'partialKeyAttribute')).toBe(true);
    });
});
