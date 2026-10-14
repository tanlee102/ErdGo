/** Lazy layout must preserve inputs, share concurrent initialization, and recover from initialization failures. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { construct, layout } = vi.hoisted(() => ({ construct: vi.fn(), layout: vi.fn() }));
vi.mock('elkjs/lib/elk.bundled.js', () => ({
    default: function ELK() {
        construct();
        this.layout = layout;
    },
}));

beforeEach(() => {
    vi.resetModules();
    construct.mockReset();
    layout.mockReset().mockImplementation(graph => Promise.resolve({ ...graph, children: [] }));
});

describe('lazy layout engine', () => {
    it('constructs on demand once and forwards both concurrent graph requests unchanged', async () => {
        const { layoutGraph } = await import('@/lib/elkLayout');
        expect(construct).not.toHaveBeenCalled();
        const first = { id: 'sql', layoutOptions: { 'elk.algorithm': 'layered' } };
        const second = { id: 'builder', layoutOptions: { 'elk.algorithm': 'radial' } };
        const results = await Promise.all([layoutGraph(first), layoutGraph(second)]);
        expect(construct).toHaveBeenCalledTimes(1);
        expect(layout).toHaveBeenNthCalledWith(1, first);
        expect(layout).toHaveBeenNthCalledWith(2, second);
        expect(results).toEqual([{ ...first, children: [] }, { ...second, children: [] }]);
    });

    it('allows the existing layout action to retry after engine initialization fails', async () => {
        construct.mockImplementationOnce(() => { throw new Error('Engine unavailable'); });
        const { layoutGraph } = await import('@/lib/elkLayout');
        await expect(layoutGraph({ id: 'first' })).rejects.toThrow('Engine unavailable');
        await expect(layoutGraph({ id: 'retry' })).resolves.toEqual({ id: 'retry', children: [] });
        expect(construct).toHaveBeenCalledTimes(2);
    });
});
