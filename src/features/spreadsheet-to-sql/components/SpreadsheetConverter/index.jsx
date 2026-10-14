/**
 * Spreadsheet-to-SQL workbench coordinator.
 * File parsing lives in its hook, deterministic SQL modeling lives in spreadsheetImport,
 * and this component stages settings before committing them to the generated output.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import GeneratedSqlPanel from './GeneratedSqlPanel';
import ImportSettingsPanel from './ImportSettingsPanel';
import TablePreview from './TablePreview';
import UploadDropzone from './UploadDropzone';
import { formatFileSize, getSheetStats, useSpreadsheetConverter } from './useSpreadsheetConverter';
import { createSqlModel, suggestTableName } from '@/features/spreadsheet-to-sql/lib/spreadsheetImport';

import './index.css';

function CloseIcon() {
    return (
        <svg className="spreadsheet-close-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
        </svg>
    );
}

function sortObjectKeys(value = {}) {
    return Object.keys(value)
        .sort()
        .reduce((sorted, key) => {
            sorted[key] = value[key];
            return sorted;
        }, {});
}

function areOverridesEqual(left = {}, right = {}) {
    return JSON.stringify(sortObjectKeys(left)) === JSON.stringify(sortObjectKeys(right));
}

export default function SpreadsheetConverter() {
    const converter = useSpreadsheetConverter();
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [settingsDraft, setSettingsDraft] = useState(null);
    const settingsButtonRef = useRef(null);
    const settingsDialogRef = useRef(null);
    const closeSettingsButtonRef = useRef(null);
    const hasWorkbook = Boolean(converter.workbook && converter.model);
    const notificationCount = converter.model ? (converter.model.issueSummary?.total || converter.model.issues?.length || 0) + (converter.model.warnings?.length || 0) : 0;
    const draftSheet = converter.workbook?.sheets?.[settingsDraft?.selectedSheetIndex ?? converter.selectedSheetIndex] || null;
    const draftSheetStats = useMemo(() => getSheetStats(draftSheet), [draftSheet]);
    const draftModel = useMemo(() => {
        if (!settingsDraft || !draftSheet) return converter.model;
        return createSqlModel({
            rows: draftSheet.rows,
            tableName: settingsDraft.tableName,
            hasHeader: settingsDraft.hasHeader,
            dialect: settingsDraft.dialect,
            columnTypeOverrides: settingsDraft.columnTypeOverrides,
        });
    }, [converter.model, draftSheet, settingsDraft]);
    const settingsHaveChanges = Boolean(
        settingsDraft &&
            (settingsDraft.selectedSheetIndex !== converter.selectedSheetIndex ||
                settingsDraft.tableName !== converter.tableName ||
                settingsDraft.dialect !== converter.dialect ||
                settingsDraft.hasHeader !== converter.hasHeader ||
                !areOverridesEqual(settingsDraft.columnTypeOverrides, converter.columnTypeOverrides)),
    );

    const createSettingsDraft = useCallback(() => ({
        selectedSheetIndex: converter.selectedSheetIndex,
        tableName: converter.tableName,
        dialect: converter.dialect,
        hasHeader: converter.hasHeader,
        columnTypeOverrides: { ...converter.columnTypeOverrides },
    }), [converter.columnTypeOverrides, converter.dialect, converter.hasHeader, converter.selectedSheetIndex, converter.tableName]);

    const closeSettingsDialog = useCallback(() => {
        setIsSettingsOpen(false);
        setSettingsDraft(null);
    }, []);

    const openSettingsDialog = useCallback(() => {
        setSettingsDraft(createSettingsDraft());
        setIsSettingsOpen(true);
    }, [createSettingsDraft]);

    const updateSettingsDraft = useCallback((updater) => {
        setSettingsDraft((currentDraft) => {
            if (!currentDraft) return currentDraft;
            return updater(currentDraft);
        });
    }, []);

    const changeDraftSheet = useCallback((nextIndex) => {
        updateSettingsDraft((currentDraft) => {
            const nextSheet = converter.workbook?.sheets?.[nextIndex];
            return {
                ...currentDraft,
                selectedSheetIndex: nextIndex,
                tableName: converter.file && nextSheet ? suggestTableName(converter.file.name, nextSheet.name) : currentDraft.tableName,
                columnTypeOverrides: {},
            };
        });
    }, [converter.file, converter.workbook, updateSettingsDraft]);

    const changeDraftHeader = useCallback((nextHasHeader) => {
        updateSettingsDraft((currentDraft) => ({
            ...currentDraft,
            hasHeader: nextHasHeader,
            columnTypeOverrides: {},
        }));
    }, [updateSettingsDraft]);

    const changeDraftColumnType = useCallback((columnName, nextType) => {
        updateSettingsDraft((currentDraft) => {
            const nextOverrides = { ...currentDraft.columnTypeOverrides };
            if (nextType) {
                nextOverrides[columnName] = nextType;
            } else {
                delete nextOverrides[columnName];
            }
            return { ...currentDraft, columnTypeOverrides: nextOverrides };
        });
    }, [updateSettingsDraft]);

    const saveSettingsDialog = useCallback(() => {
        if (!settingsDraft) return;
        converter.applyImportSettings(settingsDraft);
        closeSettingsDialog();
    }, [closeSettingsDialog, converter, settingsDraft]);

    useEffect(() => {
        if (!isSettingsOpen) return undefined;

        const originalBodyOverflow = document.body.style.overflow;
        const originalDocumentOverflow = document.documentElement.style.overflow;
        const settingsButton = settingsButtonRef.current;
        document.body.style.overflow = 'hidden';
        document.documentElement.style.overflow = 'hidden';
        closeSettingsButtonRef.current?.focus();

        const handleKeyDown = (event) => {
            if (event.key === 'Escape') {
                closeSettingsDialog();
                return;
            }

            if (event.key !== 'Tab') {
                return;
            }

            const dialog = settingsDialogRef.current;
            if (!dialog) return;

            const focusableElements = Array.from(
                dialog.querySelectorAll(
                    'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
                ),
            );
            if (focusableElements.length === 0) return;

            const firstElement = focusableElements[0];
            const lastElement = focusableElements[focusableElements.length - 1];

            if (event.shiftKey && document.activeElement === firstElement) {
                event.preventDefault();
                lastElement.focus();
                return;
            }

            if (!event.shiftKey && document.activeElement === lastElement) {
                event.preventDefault();
                firstElement.focus();
            }
        };

        window.addEventListener('keydown', handleKeyDown);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            document.body.style.overflow = originalBodyOverflow;
            document.documentElement.style.overflow = originalDocumentOverflow;
            settingsButton?.focus();
        };
    }, [closeSettingsDialog, isSettingsOpen]);

    return (
        <main className="spreadsheet-main" role="main" aria-label="Spreadsheet to SQL converter">
            <section className={`spreadsheet-hero${hasWorkbook ? ' is-compact' : ''}`}>
                <div className="spreadsheet-hero-copy">
                    <span className="spreadsheet-eyebrow">{hasWorkbook ? 'Current file' : 'Spreadsheet to SQL'}</span>
                    <h1>{hasWorkbook ? converter.file?.name : 'Upload Excel or CSV and turn rows into SQL.'}</h1>
                    {hasWorkbook ? (
                        <div className="spreadsheet-file-list" aria-label="Loaded file summary">
                            <div>
                                <span>Worksheet</span>
                                <strong>{converter.activeSheet?.name}</strong>
                            </div>
                            <div>
                                <span>Raw rows</span>
                                <strong>{converter.sheetStats.rows}</strong>
                            </div>
                            <div>
                                <span>Columns</span>
                                <strong>{converter.model.columns.length}</strong>
                            </div>
                        </div>
                    ) : (
                        <p>Convert a worksheet into a SQL table, preview the inferred columns, inspect the rows, then copy or download the generated statement.</p>
                    )}
                </div>

                <UploadDropzone isCompact={hasWorkbook} isParsing={converter.isParsing} onFileSelect={converter.processFile} progress={converter.parseProgress} />
            </section>

            {converter.error && <div className="spreadsheet-alert">{converter.error}</div>}

            {converter.workbook && converter.model && (
                <>
                    <section className="spreadsheet-workbench">
                        <div className="spreadsheet-workbench-toolbar">
                            <div className="spreadsheet-workbench-status">
                                <span className="spreadsheet-panel-label">Import setup</span>
                                <strong>
                                    {converter.model.rows.length} data rows / {converter.model.columns.length} columns
                                </strong>
                            </div>
                            <button ref={settingsButtonRef} type="button" className={`spreadsheet-settings-button${notificationCount ? ' has-notifications' : ''}`} aria-haspopup="dialog" aria-expanded={isSettingsOpen} onClick={openSettingsDialog}>
                                <span>Import settings</span>
                                {notificationCount > 0 ? <span className="spreadsheet-settings-badge">{notificationCount}</span> : <span className="spreadsheet-settings-ok">OK</span>}
                            </button>
                        </div>

                        <TablePreview activeSheet={converter.activeSheet} model={converter.model} previewHiddenCount={converter.previewHiddenCount} previewRows={converter.previewRows} />
                    </section>

                    {isSettingsOpen && settingsDraft && draftModel && draftSheet && (
                        <div className="spreadsheet-settings-overlay">
                            <div ref={settingsDialogRef} className="spreadsheet-settings-dialog" role="dialog" aria-modal="true" aria-label="Import settings" onMouseDown={(event) => event.stopPropagation()}>
                                <div className="spreadsheet-settings-dialog-header">
                                    <div>
                                        <span className="spreadsheet-panel-label">Import settings</span>
                                        <strong>{converter.file?.name}</strong>
                                        <small>
                                            {formatFileSize(converter.file?.size)} / {converter.workbook.kind.toUpperCase()}
                                        </small>
                                    </div>
                                    <button ref={closeSettingsButtonRef} type="button" className="spreadsheet-settings-close-btn" aria-label="Close import settings" title="Close import settings" onClick={closeSettingsDialog}>
                                        <CloseIcon />
                                    </button>
                                </div>
                                <ImportSettingsPanel
                                    dialect={settingsDraft.dialect}
                                    file={converter.file}
                                    hasHeader={settingsDraft.hasHeader}
                                    model={draftModel}
                                    onColumnTypeChange={changeDraftColumnType}
                                    onDialectChange={(nextDialect) => updateSettingsDraft((currentDraft) => ({ ...currentDraft, dialect: nextDialect }))}
                                    onHeaderToggle={changeDraftHeader}
                                    onSheetChange={changeDraftSheet}
                                    onTableNameChange={(nextTableName) => updateSettingsDraft((currentDraft) => ({ ...currentDraft, tableName: nextTableName }))}
                                    selectedSheetIndex={settingsDraft.selectedSheetIndex}
                                    showSource={false}
                                    sheetStats={draftSheetStats}
                                    tableName={settingsDraft.tableName}
                                    workbook={converter.workbook}
                                />
                                <div className="spreadsheet-settings-dialog-footer">
                                    <button type="button" className="spreadsheet-secondary-btn" onClick={closeSettingsDialog}>
                                        Cancel
                                    </button>
                                    <button type="button" className="spreadsheet-primary-btn" disabled={!settingsHaveChanges} onClick={saveSettingsDialog}>
                                        Save
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    <GeneratedSqlPanel copyStatus={converter.copyStatus} model={converter.model} onCopySql={converter.copySql} onDownloadIssues={converter.downloadIssues} onDownloadSql={converter.downloadSql} />
                </>
            )}
        </main>
    );
}
