import { describe, expect, it } from 'vitest';
import {
    createErdDraftHistory,
    recordErdDraftHistory,
    redoErdDraftHistory,
    undoErdDraftHistory,
} from '@/features/erd-draft/lib/erdDraftHistory';

function graph(label) {
    return {
        nodes: [{ id: label, position: { x: 0, y: 0 }, data: { label } }],
        edges: [],
    };
}

describe('ERD Builder history', () => {
    it('undoes and redoes graph changes in order', () => {
        let history = createErdDraftHistory(graph('first'));
        history = recordErdDraftHistory(history, graph('second'));
        history = recordErdDraftHistory(history, graph('third'));

        const firstUndo = undoErdDraftHistory(history);
        expect(firstUndo.changed).toBe(true);
        expect(firstUndo.snapshot.nodes[0].id).toBe('second');

        const secondUndo = undoErdDraftHistory(firstUndo.history);
        expect(secondUndo.snapshot.nodes[0].id).toBe('first');

        const redo = redoErdDraftHistory(secondUndo.history);
        expect(redo.changed).toBe(true);
        expect(redo.snapshot.nodes[0].id).toBe('second');
    });

    it('drops the redo branch after a new edit', () => {
        let history = createErdDraftHistory(graph('first'));
        history = recordErdDraftHistory(history, graph('second'));
        history = undoErdDraftHistory(history).history;
        history = recordErdDraftHistory(history, graph('replacement'));

        expect(history.future).toEqual([]);
        expect(redoErdDraftHistory(history).changed).toBe(false);
    });

    it('does not record duplicate snapshots and keeps a bounded past', () => {
        let history = createErdDraftHistory(graph('first'));
        history = recordErdDraftHistory(history, graph('first'), 2);
        history = recordErdDraftHistory(history, graph('second'), 2);
        history = recordErdDraftHistory(history, graph('third'), 2);
        history = recordErdDraftHistory(history, graph('fourth'), 2);

        expect(history.past.map((snapshot) => snapshot.nodes[0].id)).toEqual(['second', 'third']);
    });

    it('returns detached snapshots so replay cannot mutate stored history', () => {
        let history = createErdDraftHistory(graph('first'));
        history = recordErdDraftHistory(history, graph('second'));
        const undo = undoErdDraftHistory(history);

        undo.snapshot.nodes[0].data.label = 'mutated';

        expect(undo.history.present.nodes[0].data.label).toBe('first');
    });
});
