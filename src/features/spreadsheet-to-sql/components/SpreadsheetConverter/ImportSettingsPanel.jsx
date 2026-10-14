/** Editable import settings for dialect, table/header choices, and per-column SQL types. */
import { formatFileSize, getSheetStats } from './useSpreadsheetConverter';
import { SPREADSHEET_SQL_DIALECTS, SPREADSHEET_SQL_TYPES } from '@/features/spreadsheet-to-sql/lib/spreadsheetImport';

function ResetAutoIcon() {
    return (
        <svg className="spreadsheet-reset-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
        </svg>
    );
}

export default function ImportSettingsPanel({
    dialect,
    file,
    hasHeader,
    model,
    onColumnTypeChange = () => {},
    onDialectChange,
    onHeaderToggle,
    onSheetChange,
    onTableNameChange,
    selectedSheetIndex,
    showSource = true,
    sheetStats,
    tableName,
    workbook,
}) {
    const overriddenColumns = model.columns.filter((column) => column.isTypeOverridden);
    const hasTypeOverrides = overriddenColumns.length > 0;
    const resetColumnType = (columnName) => onColumnTypeChange(columnName, '');
    const resetAllColumnTypes = () => {
        overriddenColumns.forEach((column) => resetColumnType(column.name));
    };

    return (
        <aside className="spreadsheet-controls" aria-label="Import settings and inferred columns">
            {showSource && (
                <div className="spreadsheet-file-card">
                    <span className="spreadsheet-panel-label">Source</span>
                    <strong>{file?.name}</strong>
                    <span>
                        {formatFileSize(file?.size)} / {workbook.kind.toUpperCase()}
                    </span>
                </div>
            )}

            <label className="spreadsheet-field">
                <span>Worksheet</span>
                <select value={selectedSheetIndex} onChange={(event) => onSheetChange(Number(event.target.value))}>
                    {workbook.sheets.map((sheet, index) => {
                        const stats = getSheetStats(sheet);
                        return (
                            <option key={`${sheet.name}-${index}`} value={index}>
                                {sheet.name} ({stats.rows} rows)
                            </option>
                        );
                    })}
                </select>
            </label>

            <label className="spreadsheet-field">
                <span>SQL table name</span>
                <input value={tableName} onChange={(event) => onTableNameChange(event.target.value)} placeholder="uploaded_table" />
                {model.tableName !== tableName && <small>Will be saved as {model.tableName}</small>}
            </label>

            <label className="spreadsheet-field">
                <span>Database dialect</span>
                <select aria-label="Database dialect" value={dialect} onChange={(event) => onDialectChange(event.target.value)}>
                    {SPREADSHEET_SQL_DIALECTS.map((sqlDialect) => (
                        <option key={sqlDialect.id} value={sqlDialect.id}>
                            {sqlDialect.label}
                        </option>
                    ))}
                </select>
                <small className="spreadsheet-help-text">{model.dialect.description}</small>
            </label>

            <label className="spreadsheet-checkbox">
                <input type="checkbox" checked={hasHeader} onChange={(event) => onHeaderToggle(event.target.checked)} />
                <span>First row contains column names</span>
            </label>

            <div className="spreadsheet-stats" aria-label="Table stats">
                <div>
                    <strong>{model.columns.length}</strong>
                    <span>Columns</span>
                </div>
                <div>
                    <strong>{model.rows.length}</strong>
                    <span>Data rows</span>
                </div>
                <div>
                    <strong>{sheetStats.rows}</strong>
                    <span>Raw rows</span>
                </div>
            </div>

            {model.warnings.length > 0 && (
                <div className="spreadsheet-warnings">
                    {model.warnings.map((warning) => (
                        <p key={warning}>{warning}</p>
                    ))}
                </div>
            )}

            {model.issues?.length > 0 && (
                <div className="spreadsheet-issues">
                    <span className="spreadsheet-panel-label">Conversion issues</span>
                    {model.issues.slice(0, 5).map((issue) => (
                        <p key={issue.id}>{issue.message}</p>
                    ))}
                    {model.issues.length > 5 && <p>{model.issues.length - 5} more values need review.</p>}
                </div>
            )}

            <div className="spreadsheet-column-list">
                <div className="spreadsheet-column-list-header">
                    <div className="spreadsheet-column-list-title">
                        <span className="spreadsheet-panel-label">Columns</span>
                        <small>{model.columns.length} detected</small>
                    </div>
                    <button type="button" className="spreadsheet-column-reset-all" aria-label="Reset all columns to auto detect" title="Reset all columns to auto detect" disabled={!hasTypeOverrides} onClick={resetAllColumnTypes}>
                        <ResetAutoIcon />
                    </button>
                </div>
                <div className="spreadsheet-column-table" role="list" aria-label="Column type settings">
                    {model.columns.map((column) => (
                        <div className={`spreadsheet-column-row${column.isTypeOverridden ? ' is-overridden' : ''}`} key={column.name} role="listitem">
                            <div className="spreadsheet-column-name">
                                <div className="spreadsheet-column-name-main">
                                    <strong>{column.name}</strong>
                                    {column.isTypeOverridden && <span>Manual</span>}
                                </div>
                                <span>{column.originalName}</span>
                            </div>
                            <label className="spreadsheet-column-type-row">
                                <select
                                    aria-label={`SQL type for ${column.name}`}
                                    className="spreadsheet-column-type-select"
                                    value={column.isTypeOverridden ? column.selectedType : ''}
                                    onChange={(event) => onColumnTypeChange(column.name, event.target.value)}
                                >
                                    <option value="">Auto detect</option>
                                    {SPREADSHEET_SQL_TYPES.map((sqlType) => (
                                        <option key={sqlType.id} value={sqlType.id}>
                                            {sqlType.label}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            {column.isTypeOverridden && (
                                <button
                                    type="button"
                                    className="spreadsheet-column-reset-btn"
                                    aria-label={`Reset ${column.name} to auto detect`}
                                    title={`Reset ${column.name} to auto detect`}
                                    onClick={() => resetColumnType(column.name)}
                                >
                                    <ResetAutoIcon />
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            </div>
        </aside>
    );
}
