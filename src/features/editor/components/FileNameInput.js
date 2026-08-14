import SaveIcon from '@/icons/SaveIcon';

export default function FileNameInput({ fileName, setFileName, hasUnsavedChanges, isSaving, saveOrUpdate, isNewFile, isOwner, disabled = false }) {
    // Only show save button if it's a new file or user is the owner
    const canSave = isNewFile || isOwner;

    return (
        <div className="file-input-container">
            <input type="text" value={fileName} onChange={(e) => setFileName(e.target.value)} placeholder="Enter file name..." title="File name" disabled={!canSave || disabled} autoComplete="off" />
            {canSave && (
                <button className={`file-save-btn ${!hasUnsavedChanges || isSaving || disabled ? 'disabled' : ''}`} onClick={() => saveOrUpdate()} disabled={!hasUnsavedChanges || isSaving || disabled} title={isNewFile ? 'Save SQL and ERD' : 'Update SQL and ERD'}>
                    {isSaving ? <span className="save-spinner"></span> : <SaveIcon width="16px" height="16px" />}
                </button>
            )}
        </div>
    );
}
