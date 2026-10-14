import { describe, expect, it } from 'vitest';
import { arrangeDraftSelection, copyDraftSelection, pasteDraftSelection, removeDraftSelection } from '@/features/erd-draft/lib/erdDraftSelection';
import { draftNodeSize } from '@/features/erd-draft/lib/erdDraftGeometry';

const node = (id, x = 0, y = 0, selected = true, data = {}) => ({ id, position: { x, y }, selected, data: { shape: 'entity', label: id, ...data } });
const edge = (id, source, target, selected = false, data = {}) => ({ id, source, target, selected, data });

describe('Builder selection operations', () => {
    it('deletes all selected nodes, selected connectors, and incident connectors only', () => {
        const nodes = [node('a'), node('b'), node('c', 0, 0, false), node('d', 0, 0, false)];
        const edges = [edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('cd', 'c', 'd'), edge('dc', 'd', 'c', true)];
        const result = removeDraftSelection(nodes, edges);
        expect(result.nodes.map(item => item.id)).toEqual(['c', 'd']);
        expect(result.edges.map(item => item.id)).toEqual(['cd']);
        expect(nodes).toHaveLength(4);
    });

    it('copies internal connectors, remaps every identity and preserves semantics without sharing references', () => {
        const nodes = [node('a', -200, 20, true, { positionLocked: true }), node('b', 30, 40), node('c', 0, 0, false)];
        const edges = [edge('ab', 'a', 'b', false, { isaRole: 'supertype', waypoints: [{ t: .5, offset: 40 }], sourceLabelPosition: { x: 4, y: 8 } }), edge('bc', 'b', 'c', true)];
        const fragment = copyDraftSelection(nodes, edges);
        let id = 0;
        const result = pasteDraftSelection(fragment, 32, () => `copy-${++id}`);
        expect(result.nodes.map(item => item.id)).toEqual(['copy-1', 'copy-2']);
        expect(result.nodes[0]).toMatchObject({ selected: true, position: { x: -168, y: 52 }, data: { positionLocked: false } });
        expect(result.edges).toHaveLength(1);
        expect(result.edges[0]).toMatchObject({ id: 'copy-3', source: 'copy-1', target: 'copy-2', data: { isaRole: 'supertype', waypoints: [{ t: .5, offset: 40 }], sourceLabelPosition: { x: 36, y: 40 } } });
        result.nodes[0].data.label = 'Changed';
        result.edges[0].data.waypoints[0].offset = 999;
        expect(fragment.edges[0].data.waypoints[0].offset).toBe(40);
        expect(fragment.nodes[0].data.label).toBe('a');
        expect(nodes[0].data.positionLocked).toBe(true);
    });

    it.each(['left', 'center', 'right', 'top', 'middle', 'bottom'])('aligns %s with content sizes and excludes locked/unselected shapes', mode => {
        const nodes = [node('a', 50, 80), node('b', 300, 200, true, { sizeScale: 1.8 }), node('locked', -100, -100, true, { positionLocked: true }), node('other', 1000, 1000, false)];
        const result = arrangeDraftSelection(nodes, mode);
        const axis = ['left', 'center', 'right'].includes(mode) ? 'x' : 'y';
        const sizeKey = axis === 'x' ? 'width' : 'height';
        const factor = ['left', 'top'].includes(mode) ? 0 : ['right', 'bottom'].includes(mode) ? 1 : .5;
        const anchor = item => item.position[axis] + draftNodeSize(item.data.shape, item.data.sizeScale, item.data.label)[sizeKey] * factor;
        expect(anchor(result[0])).toBeCloseTo(anchor(result[1]));
        expect(result[2]).toBe(nodes[2]);
        expect(result[3]).toBe(nodes[3]);
    });

    it.each(['horizontal', 'vertical'])('distributes equal %s gaps and leaves fewer than three shapes unchanged', mode => {
        const nodes = [node('a'), node('b', 100, 100), node('c', 600, 600)];
        const result = arrangeDraftSelection(nodes, mode);
        const axis = mode === 'horizontal' ? 'x' : 'y';
        expect(result[1].position[axis]).toBe(300);
        expect(arrangeDraftSelection(nodes.slice(0, 2), mode)).toEqual(nodes.slice(0, 2));
        expect(arrangeDraftSelection(nodes, 'unknown')).toBe(nodes);
    });
});
