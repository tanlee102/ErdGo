import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import {
    ERD_DRAFT_LAYOUT_MODES,
    ERD_DRAFT_LAYOUT_OPTIONS,
    chooseSmartErdDraftLayout,
    draftLayoutEdges,
    getErdDraftLayoutPlan,
    normalizeErdDraftLayoutMode,
    createChenDraftLayoutGraph,
    applyChenDraftLayout,
    getDraftRepeatedParticipationIds,
    separateDraftParticipationPaths,
} from '@/features/erd-draft/lib/erdDraftLayout';
import { draftNodeSize } from '@/features/erd-draft/lib/erdDraftGeometry';

const nodes = Array.from({ length: 7 }, (_, index) => ({ id: `node-${index}` }));
const chainEdges = nodes.slice(1).map((node, index) => ({ source: nodes[index].id, target: node.id }));

describe('ERD Builder layout strategies', () => {
    it('separates coincident recursive roles, including reversed and zero-offset paths, without changing their meaning', () => {
        const nodes = [
            { id: 'person', data: { shape: 'entity' } },
            { id: 'supervises', data: { shape: 'relationship' } },
        ];
        const edges = [
            { id: 'a', source: 'person', target: 'supervises', sourceHandle: 'right', targetHandle: 'left', data: { sourceRole: 'supervisor', cardinalityMode: 'minmax', sourceMin: '0', sourceMax: '1', lineCount: 'single', waypoints: [] } },
            { id: 'b', source: 'supervises', target: 'person', sourceHandle: 'left', targetHandle: 'right', data: { targetRole: 'subordinate', cardinalityMode: 'minmax', targetMin: '1', targetMax: 'N', lineCount: 'double', waypoints: [{ t: 0.25, offset: 0 }] } },
            { id: 'annotation', source: 'person', target: 'supervises', data: { connectionKind: 'annotation' } },
        ];
        const before = JSON.stringify(edges);
        expect([...getDraftRepeatedParticipationIds(nodes, edges)]).toEqual(['a', 'b']);
        const arranged = separateDraftParticipationPaths(nodes, edges);
        expect(arranged[0]).toBe(edges[0]);
        expect(arranged[1].data.waypoints).toEqual([{ t: 0.5, offset: -48 }]);
        expect(arranged[1].data).toMatchObject({ targetRole: 'subordinate', targetMin: '1', targetMax: 'N', lineCount: 'double' });
        expect(arranged[2]).toBe(edges[2]);
        expect(JSON.stringify(edges)).toBe(before);
        expect(separateDraftParticipationPaths(nodes, arranged)).toEqual(arranged);
        expect(separateDraftParticipationPaths([{ ...nodes[0], data: { ...nodes[0].data, positionLocked: true } }, nodes[1]], edges)).toEqual(edges);
    });

    it('recognizes reversed curves as the same physical path and can separate many repeated roles', () => {
        const nodes = [{ id: 'person', data: { shape: 'entity' } }, { id: 'relation', data: { shape: 'relationship' } }];
        const edges = Array.from({ length: 20 }, (_, i) => ({
            id: `edge-${i}`, source: i % 2 ? 'relation' : 'person', target: i % 2 ? 'person' : 'relation',
            sourceHandle: i % 2 ? 'left' : 'right', targetHandle: i % 2 ? 'right' : 'left',
            data: { waypoints: [{ t: 0.5, offset: i % 2 ? -48 : 48 }] },
        }));
        const separated = separateDraftParticipationPaths(nodes, edges);
        const canonicalOffsets = separated.map(item => item.data.waypoints[0].offset * (item.source === 'person' ? 1 : -1));
        expect(new Set(canonicalOffsets).size).toBe(20);
        expect(canonicalOffsets.every(Number.isFinite)).toBe(true);
    });

    it('preserves locks and model data through collision-heavy deterministic arrangements', () => {
        const nodes = [];
        const edges = [];
        for (let i = 0; i < 12; i++) {
            nodes.push({ id: `owner-${i}`, position: { x: i * 150, y: i * 100 }, data: { shape: i % 3 ? 'entity' : 'relationship', label: `Owner ${i}`, positionLocked: i % 4 === 0 } });
            for (let j = 0; j < 5; j++) {
                const id = `attr-${i}-${j}`;
                nodes.push({ id, position: { x: i * 400 + j * 150, y: 900 }, data: { shape: j === 0 ? 'compositeAttribute' : 'attribute', label: j % 2 ? 'AccountAuthorizationResponsibilityIdentifier' : id, textScale: 1.8, positionLocked: j === 2 && i % 2 === 0 } });
                edges.push({ id: `edge-${id}`, source: j > 2 ? `attr-${i}-0` : `owner-${i}`, target: id });
            }
        }
        const before = JSON.stringify({ nodes, edges });
        const graph = createChenDraftLayoutGraph(nodes, edges);
        const arranged = applyChenDraftLayout(nodes, graph, { children: graph.children.map(root => ({ ...root, x: 0, y: 0 })) });
        const rects = arranged.map(item => ({ ...item.position, ...graph.sizes.get(item.id), locked: item.data.positionLocked }));
        for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
            if (rects[i].locked && rects[j].locked) continue;
            const a = rects[i], b = rects[j];
            expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `${arranged[i].id} overlaps ${arranged[j].id}`).toBe(true);
        }
        expect(arranged.filter(item => item.data.positionLocked).map(item => item.position)).toEqual(nodes.filter(item => item.data.positionLocked).map(item => item.position));
        expect(arranged.map(item => item.data)).toEqual(nodes.map(item => item.data));
        expect(JSON.stringify({ nodes, edges })).toBe(before);
    });
    it('prepares deeply nested composite attributes without exhausting the JavaScript call stack', () => {
        const nested = [
            { id: 'owner', position: { x: 0, y: 0 }, data: { shape: 'entity', label: 'Owner' } },
            ...Array.from({ length: 2500 }, (_, i) => ({ id: `nested-${i}`, position: { x: 0, y: 0 }, data: { shape: 'compositeAttribute', label: `Nested ${i}` } })),
        ];
        const links = nested.slice(1).map((node, index) => ({ id: `edge-${index}`, source: nested[index].id, target: node.id }));
        const graph = createChenDraftLayoutGraph(nested, links);
        expect(graph.children).toHaveLength(1);
        expect(graph.groups.get('owner').size).toBe(nested.length);
        expect(Number.isFinite(graph.children[0].height)).toBe(true);
    });
    it('normalizes unknown modes and exposes the complete dropdown order', () => {
        expect(normalizeErdDraftLayoutMode('unknown')).toBe(ERD_DRAFT_LAYOUT_MODES.SMART);
        expect(ERD_DRAFT_LAYOUT_OPTIONS.map((option) => option.mode)).toEqual([
            'smart', 'chen', 'horizontal', 'vertical', 'radial', 'organic', 'compact', 'grid',
        ]);
    });

    it('chooses grid, horizontal, radial, and organic from graph structure', () => {
        expect(chooseSmartErdDraftLayout(nodes, [])).toBe(ERD_DRAFT_LAYOUT_MODES.GRID);
        expect(chooseSmartErdDraftLayout(nodes, chainEdges)).toBe(ERD_DRAFT_LAYOUT_MODES.HORIZONTAL);

        const starEdges = nodes.slice(1).map((node) => ({ source: nodes[0].id, target: node.id }));
        expect(chooseSmartErdDraftLayout(nodes, starEdges)).toBe(ERD_DRAFT_LAYOUT_MODES.RADIAL);

        const denseEdges = [];
        nodes.forEach((source, sourceIndex) => nodes.slice(sourceIndex + 1).forEach((target) => {
            denseEdges.push({ source: source.id, target: target.id });
        }));
        expect(chooseSmartErdDraftLayout(nodes, denseEdges)).toBe(ERD_DRAFT_LAYOUT_MODES.ORGANIC);
    });

    it('arranges explicit hierarchy roles independently of stored connector direction', async () => {
        const hierarchy = ['parent', 'isa', 'child', 'category', 'result'].map(id => ({ id, data: { shape: ['isa', 'category'].includes(id) ? id : 'entity' }, width: 100, height: 60 }));
        const links = [
            { id: 'a', source: 'isa', target: 'parent', data: { isaRole: 'supertype' } },
            { id: 'b', source: 'child', target: 'isa', data: { isaRole: 'subtype' } },
            { id: 'c', source: 'category', target: 'child', data: { categoryRole: 'member' } },
            { id: 'd', source: 'result', target: 'category', data: { categoryRole: 'result' } },
            { id: 'note', source: 'result', target: 'parent', data: { connectionKind: 'annotation' } },
        ];
        const original = JSON.stringify(links);
        const layoutEdges = draftLayoutEdges(hierarchy, links);
        expect(layoutEdges.map(edge => [...edge.sources, ...edge.targets])).toEqual([
            ['parent', 'isa'], ['isa', 'child'], ['child', 'category'], ['category', 'result'],
        ]);
        const plan = getErdDraftLayoutPlan('smart', hierarchy, links);
        expect(plan.resolvedMode).toBe('vertical');
        const result = await new ELK().layout({ id: 'roles', children: hierarchy, edges: layoutEdges, layoutOptions: plan.layoutOptions });
        const positions = new Map(result.children.map(node => [node.id, node.y]));
        for (const edge of layoutEdges) expect(positions.get(edge.sources[0])).toBeLessThan(positions.get(edge.targets[0]));
        expect(JSON.stringify(links)).toBe(original);
        expect(chooseSmartErdDraftLayout(hierarchy, [links[4]])).toBe('grid');
    });

    it('provides executable ELK options for every explicit layout', async () => {
        const elk = new ELK();
        const graphNodes = nodes.map((node) => ({ ...node, width: 150, height: 90 }));
        const graphEdges = chainEdges.map((edge, index) => ({ id: `edge-${index}`, sources: [edge.source], targets: [edge.target] }));

        for (const mode of ERD_DRAFT_LAYOUT_OPTIONS.map((option) => option.mode).filter((mode) => mode !== 'smart')) {
            const plan = getErdDraftLayoutPlan(mode, nodes, chainEdges);
            const result = await elk.layout({ id: `layout-${mode}`, layoutOptions: plan.layoutOptions, children: graphNodes, edges: graphEdges });
            expect(result.children).toHaveLength(nodes.length);
            expect(result.children.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
        }
    });

    it('reserves attribute-tree space, keeps labels apart, and preserves semantic data', async () => {
        const graphNodes = [
            { id: 'entity', position: { x: 0, y: 0 }, data: { shape: 'entity', label: 'Customer' } },
            { id: 'relation', position: { x: 200, y: 0 }, data: { shape: 'relationship', label: 'places' } },
            { id: 'other', position: { x: 400, y: 0 }, data: { shape: 'entity', label: 'Order' } },
            ...Array.from({ length: 18 }, (_, i) => ({ id: `attr-${i}`, position: { x: 0, y: 0 }, data: { shape: i === 0 ? 'compositeAttribute' : 'attribute', label: i % 3 ? `Attribute ${i}` : 'CustomerAccountAuthorizationResponsibilityIdentifier', textScale: 1.8 } })),
        ];
        const links = [{ id: 'r1', source: 'entity', target: 'relation' }, { id: 'r2', source: 'relation', target: 'other' },
            ...graphNodes.slice(3).map((node, i) => ({ id: `a${i}`, source: i > 12 ? 'attr-0' : 'entity', target: node.id }))];
        const before = JSON.stringify({ nodes: graphNodes, links });
        const graph = createChenDraftLayoutGraph(graphNodes, links);
        expect(graph.children.map(node => node.id)).toEqual(['entity', 'relation', 'other']);
        expect(chooseSmartErdDraftLayout(graphNodes, links)).toBe('chen');
        const result = await new ELK().layout({ id: 'chen', children: graph.children, edges: graph.edges, layoutOptions: getErdDraftLayoutPlan('chen', graphNodes, links).layoutOptions });
        const arranged = applyChenDraftLayout(graphNodes, graph, result);
        const rects = arranged.map(node => ({ ...node.position, ...draftNodeSize(node.data.shape, node.data.sizeScale, node.data.label, node.data.textScale) }));
        expect(new Set(rects.slice(0, 3).map(rect => Math.round(rect.y + rect.height / 2))).size).toBe(1);
        for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i], b = rects[j];
            expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `${arranged[i].id} overlaps ${arranged[j].id}`).toBe(true);
        }
        expect(JSON.stringify({ nodes: graphNodes, links })).toBe(before);
        expect(arranged.map(node => node.data)).toEqual(graphNodes.map(node => node.data));
    });

    it('anchors locked owners and attributes and avoids collisions with locked shapes', () => {
        const graphNodes = [
            { id: 'owner', position: { x: 500, y: 400 }, data: { shape: 'entity', label: 'Locked owner', positionLocked: true } },
            { id: 'a', position: { x: 0, y: 0 }, data: { shape: 'attribute', label: 'name' } },
            { id: 'b', position: { x: 500, y: 200 }, data: { shape: 'attribute', label: 'Locked key', positionLocked: true } },
        ];
        const graph = createChenDraftLayoutGraph(graphNodes, [{ source: 'owner', target: 'a' }, { source: 'owner', target: 'b' }]);
        const result = applyChenDraftLayout(graphNodes, graph, { children: [{ id: 'owner', x: 0, y: 0 }] });
        expect(result[0].position).toEqual(graphNodes[0].position);
        expect(result[2].position).toEqual(graphNodes[2].position);
        expect(result[1].position.x).toBeGreaterThan(300);
        expect(result[1].position).not.toEqual(result[2].position);
    });
});
