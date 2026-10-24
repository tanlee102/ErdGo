// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RootLayoutContext } from '@/contexts/RootLayoutContext';
import { useSaveLogic } from '@/features/editor/hooks/useSaveLogic';
import { getLocalDocument, LOCAL_DOCUMENTS_KEY, saveLocalDocument } from '@/features/files/lib/localFileStore';

const notifications = vi.hoisted(() => ({ notifyError: vi.fn(), notifySuccess: vi.fn(), notifyWarning: vi.fn() }));
vi.mock('@/components/Notifications', () => ({ useNotifications: () => notifications }));
const SQL = 'CREATE TABLE saved(id INTEGER PRIMARY KEY);';

function setup(overrides = {}) {
    const props = { index: 'saved', documentKey: 'saved', isLoading: false, isNewFile: false, fileName: 'Changed name', originalData: { uuid: 'saved', sql: SQL, fileName: 'Saved name', context: { zoom: 1 } }, erdContextRef: { current: { zoom: 1 } }, setIsNewFile: vi.fn(), setOriginalData: vi.fn(), setHasUnsavedChanges: vi.fn(), setErdContextVersion: vi.fn(), ...overrides };
    const wrapper = ({ children }) => <MemoryRouter><RootLayoutContext.Provider value={{ sqlInput: SQL }}>{children}</RootLayoutContext.Provider></MemoryRouter>;
    return { props, ...renderHook(value => useSaveLogic(value), { initialProps: props, wrapper }) };
}

describe('local SQL save lifetimes', () => {
    beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

    it.each([{ isLoading: true }, { originalData: { uuid: 'previous-file' } }])('rejects saves before the target document is ready', async overrides => {
        const { result, props } = setup(overrides);
        await act(() => result.current.saveOrUpdate());
        expect(localStorage.getItem(LOCAL_DOCUMENTS_KEY)).toBeNull();
        expect(props.setOriginalData).not.toHaveBeenCalled();
        expect(notifications.notifyWarning).toHaveBeenCalled();
    });

    it('revokes old callbacks after loading and after a new document entry', async () => {
        const { result, props, rerender } = setup();
        const oldSave = result.current.saveOrUpdate;
        rerender({ ...props, isLoading: true });
        rerender(props);
        await act(() => oldSave());
        expect(localStorage.getItem(LOCAL_DOCUMENTS_KEY)).toBeNull();
        const readySave = result.current.saveOrUpdate;
        rerender({ ...props, index: 'new', documentKey: 'new-entry', isNewFile: true });
        await act(() => readySave());
        expect(localStorage.getItem(LOCAL_DOCUMENTS_KEY)).toBeNull();
    });

    it('saves a ready document atomically and preserves existing renderer context', async () => {
        saveLocalDocument({ id: 'saved', name: 'Saved name', sql: SQL, context: { zoom: 1 } });
        const { result } = setup();
        await act(() => result.current.saveOrUpdate());
        expect(getLocalDocument('saved')).toMatchObject({ name: 'Changed name', sql: SQL, context: { zoom: 1 } });
        expect(notifications.notifyError).not.toHaveBeenCalled();
    });
});
