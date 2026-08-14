import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RootLayoutContext } from '@/contexts/RootLayoutContext';
import { useNotifications } from '@/components/Notifications';
import { FILE_NAME_MAX_LENGTH, FILE_NAME_MIN_LENGTH, SQL_MAX_LENGTH, SQL_MIN_LENGTH } from '@/utils/constants';
import { cloneIfPopulatedObject, deepEqual } from '@/utils/objectUtils';
import { saveLocalDocument } from '@/features/files/lib/localFileStore';

export function useSaveLogic({ index, isNewFile, setIsNewFile, fileName, originalData, setOriginalData, setHasUnsavedChanges, erdContextRef, setErdContextVersion }) {
    const { sqlInput } = useContext(RootLayoutContext);
    const { notifyError, notifySuccess, notifyWarning } = useNotifications();
    const [isSaving, setIsSaving] = useState(false);
    const isSavingRef = useRef(false);
    const sqlInputRef = useRef(sqlInput);
    const fileNameRef = useRef(fileName);
    const navigate = useNavigate();

    useEffect(() => { sqlInputRef.current = sqlInput; }, [sqlInput]);
    useEffect(() => { fileNameRef.current = fileName; }, [fileName]);

    const hasChangedDuringSave = useCallback(
        (savedSql, savedName, savedContext) => sqlInputRef.current !== savedSql || (fileNameRef.current || '').trim() !== savedName || !deepEqual(erdContextRef.current, savedContext),
        [erdContextRef],
    );

    const saveOrUpdate = useCallback(async (options = {}) => {
        if (isSavingRef.current) return;
        const sqlToSave = options.sqlOverride ?? sqlInputRef.current;
        const nameToSave = (fileNameRef.current || '').trim();
        if (!sqlToSave || sqlToSave.length < SQL_MIN_LENGTH) {
            notifyWarning(`SQL must be at least ${SQL_MIN_LENGTH} characters`, { title: 'Cannot save yet' });
            return;
        }
        if (sqlToSave.length > SQL_MAX_LENGTH) {
            notifyWarning(`SQL is too long, max ${SQL_MAX_LENGTH.toLocaleString()} characters`, { title: 'Cannot save yet' });
            return;
        }
        if (nameToSave.length < FILE_NAME_MIN_LENGTH) {
            notifyWarning('File name is required', { title: 'Cannot save yet' });
            return;
        }
        if (nameToSave.length > FILE_NAME_MAX_LENGTH) {
            notifyWarning(`File name too long, max ${FILE_NAME_MAX_LENGTH} characters`, { title: 'Cannot save yet' });
            return;
        }
        const contextToSave = cloneIfPopulatedObject(erdContextRef.current);
        if (!contextToSave) {
            notifyError('Failed to prepare context data', { title: 'Save failed' });
            return;
        }
        const sqlChanged = sqlToSave !== originalData.sql;
        const nameChanged = nameToSave !== originalData.fileName;
        const contextChanged = !deepEqual(contextToSave, originalData.context);
        if (!isNewFile && !sqlChanged && !nameChanged && !contextChanged) {
            setHasUnsavedChanges(hasChangedDuringSave(sqlToSave, nameToSave, contextToSave));
            return;
        }

        isSavingRef.current = true;
        setIsSaving(true);
        try {
            const saved = saveLocalDocument({ id: isNewFile ? null : index, name: nameToSave, sql: sqlToSave, context: contextToSave });
            setOriginalData({ id: saved.id, uuid: saved.id, created_at: saved.createdAt, updated_at: saved.updatedAt, sql: saved.sql, fileName: saved.name, context: saved.context });
            setIsNewFile(false);
            setHasUnsavedChanges(hasChangedDuringSave(saved.sql, saved.name, saved.context));
            setErdContextVersion((version) => version + 1);
            notifySuccess('Diagram saved in this browser.', { title: 'Saved locally' });
            if (isNewFile) navigate(`/e/${saved.id}`, { replace: true });
        } catch (error) {
            notifyError(error.message || 'An unexpected error occurred', { title: 'Save failed' });
        } finally {
            isSavingRef.current = false;
            setIsSaving(false);
        }
    }, [erdContextRef, hasChangedDuringSave, index, isNewFile, navigate, notifyError, notifySuccess, notifyWarning, originalData, setErdContextVersion, setHasUnsavedChanges, setIsNewFile, setOriginalData]);

    return { saveOrUpdate, isSaving };
}
