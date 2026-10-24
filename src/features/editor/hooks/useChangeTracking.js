import { useEffect, useRef, useCallback } from 'react';
import { deepEqual } from '@/utils/objectUtils';

const DEBOUNCE_MS = 30;

/**
 * useChangeTracking — emits `setHasUnsavedChanges(true|false)` whenever the
 * editor state diverges from / re-converges with the persisted snapshot.
 *
 * Behavioral contract:
 *
 *   • New files always have unsaved changes.
 *   • Without `originalData`, an existing file is considered clean.
 *   • Compares: `sqlInput`, trimmed `fileName`, and a JSON-deep-equal of
 *     `erdContextRef.current` against the snapshot.
 *   • SQL / file-name typing is debounced to coalesce rapid keystrokes.
 *   • Context-only changes (driven by `erdContextVersion` ticks from the ERD
 *     canvas — table drag, color toggle, zoom, …) bypass the debounce.
 *   • Repeated results are suppressed within the same saved baseline. A new
 *     baseline must republish its result because hydration/save can reset the
 *     parent's flag while the early canvas already has new context changes.
 */
export function useChangeTracking({ sqlInput, fileName, originalData, isNewFile, erdContextRef, erdContextVersion, setHasUnsavedChanges }) {
    const debounceRef = useRef(null);
    const lastResultRef = useRef({ baseline: originalData, hasChanges: false });

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
            if (hasChanges !== lastResultRef.current.hasChanges || originalData !== lastResultRef.current.baseline) {
                lastResultRef.current = { baseline: originalData, hasChanges };
                setHasUnsavedChanges(hasChanges);
            }
        },
        [originalData, setHasUnsavedChanges],
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
