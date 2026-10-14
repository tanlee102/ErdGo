/** Pure, bounded undo/redo history for persisted ERD Builder graph snapshots. */

export const ERD_DRAFT_HISTORY_LIMIT = 100;

function cloneSnapshot(snapshot) {
    return JSON.parse(JSON.stringify({
        nodes: Array.isArray(snapshot?.nodes) ? snapshot.nodes : [],
        edges: Array.isArray(snapshot?.edges) ? snapshot.edges : [],
    }));
}

export function createErdDraftHistory(snapshot) {
    return {
        past: [],
        present: cloneSnapshot(snapshot),
        future: [],
    };
}

export function areErdDraftSnapshotsEqual(first, second) {
    return JSON.stringify(first) === JSON.stringify(second);
}

export function recordErdDraftHistory(history, snapshot, limit = ERD_DRAFT_HISTORY_LIMIT) {
    const nextSnapshot = cloneSnapshot(snapshot);
    if (areErdDraftSnapshotsEqual(history.present, nextSnapshot)) return history;
    return {
        past: [...history.past, history.present].slice(-Math.max(1, limit)),
        present: nextSnapshot,
        future: [],
    };
}

export function undoErdDraftHistory(history) {
    if (!history.past.length) return { history, snapshot: history.present, changed: false };
    const snapshot = history.past[history.past.length - 1];
    return {
        history: {
            past: history.past.slice(0, -1),
            present: snapshot,
            future: [...history.future, history.present],
        },
        snapshot: cloneSnapshot(snapshot),
        changed: true,
    };
}

export function redoErdDraftHistory(history) {
    if (!history.future.length) return { history, snapshot: history.present, changed: false };
    const snapshot = history.future[history.future.length - 1];
    return {
        history: {
            past: [...history.past, history.present],
            present: snapshot,
            future: history.future.slice(0, -1),
        },
        snapshot: cloneSnapshot(snapshot),
        changed: true,
    };
}
