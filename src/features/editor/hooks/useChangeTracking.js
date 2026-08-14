import { useEffect, useRef, useCallback } from 'react';
import { deepEqual } from '@/utils/objectUtils';

const DEBOUNCE_MS = 30;

/**
 * useChangeTracking — emits `setHasUnsavedChanges(true|false)` whenever the
 * editor state diverges from / re-converges with the persisted snapshot.
 *
 * Behavioral contract (frozen — refactor-only changes):
 *
 *   • New files always have unsaved changes.
 *   • Without `originalData`, an existing file is considered clean.
 *   • Compares: `sqlInput`, trimmed `fileName`, and a JSON-deep-equal of
 *     `erdContextRef.current` against the snapshot.
 *   • SQL / file-name typing is debounced to coalesce rapid keystrokes.
 *   • Context-only changes (driven by `erdContextVersion` ticks from the ERD
 *     canvas — table drag, color toggle, zoom, …) bypass the debounce.
 *   • The setter is only called when the boolean truly changes, eliminating
 *     redundant React re-renders.
 *
 * @version 2.1.0 — refactor-only: shared deepEqual, single comparison
 *                  pipeline, no behavioral changes.
 */
export function useChangeTracking({ sqlInput, fileName, originalData, isNewFile, erdContextRef, erdContextVersion, setHasUnsavedChanges }) {
    const debounceRef = useRef(null);
    const lastResultRef = useRef(false);

    const checkForChanges = useCallback(() => {
        if (isNewFile) return true;
        if (!originalData) return false;

        if (sqlInput !== originalData.sql) return true;

        const currentName = (fileName || '').trim();
        const originalName = (originalData.fileName || '').trim();
        if (currentName !== originalName) return true;

        if (!deepEqual(erdContextRef.current, originalData.context)) return true;
        return false;
    }, [sqlInput, fileName, originalData, isNewFile, erdContextRef]);

    const updateState = useCallback(
        (hasChanges) => {
            if (hasChanges !== lastResultRef.current) {
                lastResultRef.current = hasChanges;
                setHasUnsavedChanges(hasChanges);
            }
        },
        [setHasUnsavedChanges],
    );

    // Debounced check: SQL / file-name updates fire many times per second.
    useEffect(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => updateState(checkForChanges()), DEBOUNCE_MS);
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, [sqlInput, fileName, originalData, isNewFile, checkForChanges, updateState]);

    // Immediate check: ERD canvas mutations are coarse-grained — no need to
    // wait, and waiting would defer the dirty-state badge that the toolbar
    // shows the user.
    useEffect(() => {
        updateState(checkForChanges());
    }, [erdContextVersion, checkForChanges, updateState]);
}
