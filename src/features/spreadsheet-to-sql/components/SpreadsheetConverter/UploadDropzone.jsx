/** Keyboard-accessible file picker and drag/drop target for supported spreadsheet formats. */
import { useRef, useState } from 'react';

const ACCEPTED_FILE_TYPES = '.csv,.tsv,.txt,.xlsx,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export default function UploadDropzone({ isCompact = false, isParsing, onFileSelect, progress = { label: '', percent: 0 } }) {
    const fileInputRef = useRef(null);
    const [isDragging, setIsDragging] = useState(false);

    const handleInputChange = (event) => {
        onFileSelect(event.target.files?.[0]);
        event.target.value = '';
    };

    const handleDrop = (event) => {
        event.preventDefault();
        setIsDragging(false);
        onFileSelect(event.dataTransfer.files?.[0]);
    };

    return (
        <div
            className={`spreadsheet-upload${isCompact ? ' is-compact' : ''}${isDragging ? ' is-dragging' : ''}`}
            onDragEnter={(event) => {
                event.preventDefault();
                setIsDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
        >
            <input ref={fileInputRef} type="file" accept={ACCEPTED_FILE_TYPES} onChange={handleInputChange} />
            <div className="spreadsheet-upload-icon" aria-hidden="true">
                SQL
            </div>
            <div className="spreadsheet-upload-copy">
                <h2>{isParsing ? 'Reading file...' : isCompact ? 'Replace file' : 'Drop a file here'}</h2>
                <p>{isCompact ? 'Drop another CSV, TSV, TXT, or XLSX.' : 'CSV, TSV, TXT, or XLSX. Parsing runs in your browser.'}</p>
                {isParsing && (
                    <div className="spreadsheet-upload-progress-group">
                        <small>{progress.label || 'Reading file'}</small>
                        <div className="spreadsheet-upload-progress" role="progressbar" aria-label={progress.label || 'Reading file'} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.max(4, Math.min(progress.percent || 12, 100))}>
                            <span style={{ width: `${Math.max(4, Math.min(progress.percent || 12, 100))}%` }} />
                        </div>
                    </div>
                )}
            </div>
            <button type="button" className="spreadsheet-primary-btn" onClick={() => fileInputRef.current?.click()} disabled={isParsing}>
                Choose file
            </button>
        </div>
    );
}
