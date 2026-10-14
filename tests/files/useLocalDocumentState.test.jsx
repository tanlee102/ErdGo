// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useLocalDocumentState } from '@/features/files/hooks/useLocalDocumentState';

describe('local document save baselines', () => {
    it('keeps changes made during save dirty and prevents duplicate writes', () => {
        const { result, rerender } = renderHook(props => useLocalDocumentState(props), { initialProps: { currentSnapshot: 'initial' } });
        act(() => result.current.finishLocalLoad('initial'));
        expect(result.current.hasUnsavedChanges).toBe(false);
        act(() => { expect(result.current.beginLocalSave()).toBe(true); expect(result.current.beginLocalSave()).toBe(false); });
        rerender({ currentSnapshot: 'changed-during-save' });
        act(() => result.current.finishLocalSave('initial'));
        expect(result.current.isLocalSaving).toBe(false);
        expect(result.current.hasUnsavedChanges).toBe(true);
        act(() => result.current.finishLocalSave('changed-during-save'));
        expect(result.current.hasUnsavedChanges).toBe(false);
    });

    it('allows retry after a storage failure and clears the previous document baseline', () => {
        const { result } = renderHook(() => useLocalDocumentState({ currentSnapshot: 'document' }));
        act(() => { result.current.beginLocalSave(); result.current.failLocalSave(); });
        expect(result.current.hasUnsavedChanges).toBe(true);
        act(() => expect(result.current.beginLocalSave()).toBe(true));
        act(() => result.current.finishLocalSave('document'));
        expect(result.current.hasUnsavedChanges).toBe(false);
        act(() => result.current.beginLocalLoad());
        expect(result.current.hasUnsavedChanges).toBe(true);
    });
});
