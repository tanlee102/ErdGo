import { useCallback, useRef, useState } from 'react';

export function createLocalDocumentSnapshot(name, payload) {
    return JSON.stringify({ name: String(name || '').trim(), payload });
}

/** Shared dirty baseline and exclusive-save guard for local Prisma and Builder documents. */
export function useLocalDocumentState({ currentSnapshot }) {
    const [isLocalSaving, setIsLocalSaving] = useState(false);
    const [savedSnapshot, setSavedSnapshot] = useState(null);
    const saveInFlightRef = useRef(false);
    const resetLocalState = useCallback(() => setSavedSnapshot(null), []);
    const beginLocalLoad = resetLocalState;
    const finishLocalLoad = useCallback((snapshot) => setSavedSnapshot(snapshot), []);
    const failLocalLoad = resetLocalState;
    const beginLocalSave = useCallback(() => {
        if (saveInFlightRef.current) return false;
        saveInFlightRef.current = true;
        setIsLocalSaving(true);
        return true;
    }, []);
    const finishLocalSave = useCallback((snapshot) => {
        setSavedSnapshot(snapshot);
        saveInFlightRef.current = false;
        setIsLocalSaving(false);
    }, []);
    const failLocalSave = useCallback(() => {
        saveInFlightRef.current = false;
        setIsLocalSaving(false);
    }, []);
    return {
        isLocalSaving,
        hasUnsavedChanges: savedSnapshot === null || currentSnapshot !== savedSnapshot,
        resetLocalState, beginLocalLoad, finishLocalLoad, failLocalLoad,
        beginLocalSave, finishLocalSave, failLocalSave,
    };
}
