/** Multi-file SQL import workflow: selection, preflight diagnostics, dialect hints, and commit. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ImportSqlIcon from '@/icons/ImportSqlIcon';
import {
    SQL_IMPORT_ACCEPT,
    analyzeSqlImportCandidates,
    formatSqlImportBytes,
    readSqlImportCandidates,
} from '@/features/editor/lib/sqlImport';

import './index.css';

function hasFiles(event) {
    return Array.from(event?.dataTransfer?.types || []).includes('Files');
}

function getDialectConfidenceLabel(dialect) {
    if (dialect?.id === 'generic') return 'dialect-neutral';
    if (dialect?.confidence === 'low') return 'possible match';
    return `${dialect?.confidence || 'medium'} confidence`;
}

export default function SqlImportDialog({ isOpen, onClose, onImport, fileRequest }) {
    const [candidates, setCandidates] = useState([]);
    const [isReading, setIsReading] = useState(false);
    const [isDropActive, setIsDropActive] = useState(false);
    const inputRef = useRef(null);
    const dialogRef = useRef(null);
    const onCloseRef = useRef(onClose);
    const isReadingRef = useRef(isReading);
    const selectionSequenceRef = useRef(0);
    const handledRequestRef = useRef(null);
    const report = useMemo(() => analyzeSqlImportCandidates(candidates), [candidates]);

    useEffect(() => {
        onCloseRef.current = onClose;
        isReadingRef.current = isReading;
    }, [isReading, onClose]);

    const addFiles = useCallback(async (fileList) => {
        const files = Array.from(fileList || []);
        if (files.length === 0) return;
        setIsReading(true);
        try {
            const nextCandidates = await readSqlImportCandidates(files);
            setCandidates((current) => [
                ...current,
                ...nextCandidates.map((candidate) => ({
                    ...candidate,
                    selectionId: `sql-import-${Date.now()}-${selectionSequenceRef.current++}`,
                })),
            ]);
        } finally {
            setIsReading(false);
        }
    }, []);

    useEffect(() => {
        if (!isOpen) return undefined;
        const previouslyFocused = document.activeElement;
        const focusTimer = window.setTimeout(() => dialogRef.current?.focus(), 0);
        const handleKeyDown = (event) => {
            if (event.key === 'Escape' && !isReadingRef.current) {
                event.preventDefault();
                onCloseRef.current?.();
                return;
            }
            if (event.key !== 'Tab') return;

            const focusable = Array.from(
                dialogRef.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), summary, [tabindex]:not([tabindex="-1"])') || [],
            ).filter((element) => element.getClientRects().length > 0);
            if (focusable.length === 0) {
                event.preventDefault();
                dialogRef.current?.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.clearTimeout(focusTimer);
            window.removeEventListener('keydown', handleKeyDown);
            previouslyFocused?.focus?.();
        };
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen || !fileRequest?.id || handledRequestRef.current === fileRequest.id) return;
        handledRequestRef.current = fileRequest.id;
        if (fileRequest.files?.length) addFiles(fileRequest.files);
    }, [addFiles, fileRequest, isOpen]);

    useEffect(() => {
        if (isOpen) return;
        setCandidates([]);
        setIsDropActive(false);
        if (inputRef.current) inputRef.current.value = '';
    }, [isOpen]);

    if (!isOpen) return null;

    const handleDrop = (event) => {
        event.preventDefault();
        event.stopPropagation();
        setIsDropActive(false);
        if (hasFiles(event)) addFiles(event.dataTransfer.files);
    };

    const handleImport = () => {
        if (isReading || report.readyFiles.length === 0) return;
        onImport?.(report.readyFiles, report);
    };

    const removeCandidate = (selectionId) => {
        setCandidates((current) => current.filter((candidate) => candidate.selectionId !== selectionId));
    };

    return (
        <div className="sql-import-overlay" onMouseDown={(event) => event.target === event.currentTarget && !isReading && onClose?.()}>
            <section ref={dialogRef} className="sql-import-dialog" role="dialog" aria-modal="true" aria-labelledby="sql-import-title" tabIndex={-1}>
                <header className="sql-import-header">
                    <div className="sql-import-header-main">
                        <span className="sql-import-header-icon" aria-hidden="true"><ImportSqlIcon width="22px" height="22px" /></span>
                        <div>
                            <h2 id="sql-import-title">Import SQL files</h2>
                            <p>Each readable file opens in its own tab. Files stay in your browser.</p>
                        </div>
                    </div>
                    <button type="button" className="sql-import-close" onClick={onClose} disabled={isReading} aria-label="Close SQL import">
                        ×
                    </button>
                </header>

                <div className="sql-import-body">
                    <div
                        className={`sql-import-dropzone ${isDropActive ? 'is-dragging' : ''}`}
                        onDragEnter={(event) => {
                            if (!hasFiles(event)) return;
                            event.preventDefault();
                            setIsDropActive(true);
                        }}
                        onDragOver={(event) => {
                            if (!hasFiles(event)) return;
                            event.preventDefault();
                            event.dataTransfer.dropEffect = 'copy';
                        }}
                        onDragLeave={(event) => {
                            if (!event.currentTarget.contains(event.relatedTarget)) setIsDropActive(false);
                        }}
                        onDrop={handleDrop}
                    >
                        <div className="sql-import-drop-icon"><ImportSqlIcon width="24px" height="24px" /></div>
                        <div className="sql-import-drop-copy">
                            <strong>{isDropActive ? 'Drop files here' : candidates.length ? 'Add more SQL files' : 'Drop SQL files or database dumps here'}</strong>
                            <span>Plain-text SQL up to 30 MB per file · UTF-8, Windows-1252, and UTF-16</span>
                        </div>
                        <button type="button" className="sql-import-browse" onClick={() => inputRef.current?.click()} disabled={isReading}>
                            {isReading ? 'Reading…' : 'Browse files'}
                        </button>
                        <input
                            ref={inputRef}
                            className="sql-import-file-input"
                            type="file"
                            accept={SQL_IMPORT_ACCEPT}
                            multiple
                            onChange={(event) => {
                                addFiles(event.target.files);
                                event.target.value = '';
                            }}
                        />
                    </div>

                    {candidates.length > 0 && (
                        <>
                            <div className="sql-import-summary" role="status" aria-live="polite">
                                <div><strong>{report.readyFiles.length}</strong><span>ready</span></div>
                                <div><strong>{report.tableCount}</strong><span>tables found</span></div>
                                <div className={report.errorCount ? 'has-errors' : ''}><strong>{report.errorCount}</strong><span>errors</span></div>
                                <div className={report.warningCount ? 'has-warnings' : ''}><strong>{report.warningCount}</strong><span>warnings</span></div>
                            </div>

                            {report.hasMixedDialects && (
                                <div className="sql-import-note">
                                    Multiple SQL dialects were detected. ERD Go can parse the combined workspace, but review dialect-specific diagnostics before saving.
                                </div>
                            )}

                            <div className="sql-import-files" aria-label="Selected SQL files">
                                {report.files.map((file) => {
                                    const errors = file.diagnostics.filter((diagnostic) => diagnostic.severity !== 'warning').length;
                                    const warnings = file.diagnostics.length - errors;
                                    return (
                                        <article className={`sql-import-file ${file.blockedReason ? 'is-blocked' : ''}`} key={file.selectionId || file.sourceKey}>
                                            <div className="sql-import-file-main">
                                                <span className={`sql-import-file-state ${file.blockedReason ? 'blocked' : file.diagnostics.length ? 'issues' : 'ready'}`} aria-hidden="true">
                                                    {file.blockedReason ? '×' : file.diagnostics.length ? '!' : '✓'}
                                                </span>
                                                <div className="sql-import-file-copy">
                                                    <div className="sql-import-file-name-row">
                                                        <strong title={file.name}>{file.name}</strong>
                                                        <span>{formatSqlImportBytes(file.size)}</span>
                                                    </div>
                                                    {file.blockedReason ? (
                                                        <p className="sql-import-blocked-reason">{file.blockedReason}</p>
                                                    ) : (
                                                        <div className="sql-import-file-meta">
                                                            <span className={`sql-import-dialect dialect-${file.dialect.id}`}>{file.dialect.label}</span>
                                                            <span>{getDialectConfidenceLabel(file.dialect)}</span>
                                                            <span>{file.tableCount} table{file.tableCount === 1 ? '' : 's'}</span>
                                                            {file.encoding && <span>{file.encoding.toUpperCase()}</span>}
                                                            {errors > 0 && <span className="sql-import-error-count">{errors} error{errors === 1 ? '' : 's'}</span>}
                                                            {warnings > 0 && <span className="sql-import-warning-count">{warnings} warning{warnings === 1 ? '' : 's'}</span>}
                                                        </div>
                                                    )}
                                                </div>
                                                <button type="button" className="sql-import-remove" onClick={() => removeCandidate(file.selectionId)} aria-label={`Remove ${file.name}`} title="Remove file">×</button>
                                            </div>

                                            {!file.blockedReason && file.diagnostics.length > 0 && (
                                                <details className="sql-import-diagnostics">
                                                    <summary>Review parsing issues</summary>
                                                    <ul>
                                                        {file.diagnostics.slice(0, 5).map((diagnostic) => (
                                                            <li className={diagnostic.severity} key={diagnostic.id}>
                                                                <span>{diagnostic.severity === 'warning' ? 'Warning' : 'Error'}</span>
                                                                <p>{diagnostic.line ? `Line ${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ''} — ` : ''}{diagnostic.message}</p>
                                                            </li>
                                                        ))}
                                                    </ul>
                                                    {file.diagnostics.length > 5 && <p className="sql-import-more-issues">{file.diagnostics.length - 5} more issue{file.diagnostics.length - 5 === 1 ? '' : 's'} will appear in the editor diagnostics.</p>}
                                                </details>
                                            )}
                                        </article>
                                    );
                                })}
                            </div>
                        </>
                    )}
                </div>

                <footer className="sql-import-footer">
                    <p>
                        {report.blockedFiles.length > 0
                            ? `${report.blockedFiles.length} blocked file${report.blockedFiles.length === 1 ? '' : 's'} will be skipped.`
                            : report.readyFiles.length > 0
                              ? 'Parsing issues do not prevent import; you can fix them in Monaco afterward.'
                              : 'Select one or more plain-text SQL files.'}
                    </p>
                    <div>
                        <button type="button" className="sql-import-secondary" onClick={onClose} disabled={isReading}>Cancel</button>
                        <button type="button" className="sql-import-primary" onClick={handleImport} disabled={isReading || report.readyFiles.length === 0}>
                            Import {report.readyFiles.length || ''} file{report.readyFiles.length === 1 ? '' : 's'}
                        </button>
                    </div>
                </footer>
            </section>
        </div>
    );
}
