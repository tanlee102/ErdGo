import { useState } from 'react';

const DIAGNOSTIC_CATEGORY_LABELS = {
    relation_dropped_non_unique_target: 'Non-unique FK target',
    relation_dropped_unknown_table: 'Unknown table',
    relation_dropped_unknown_column: 'Unknown column',
    relation_dropped_column_count_mismatch: 'Dropped relation',
    relation_dropped_missing_target_columns: 'Dropped relation',
    relation_dropped_composite_group_partial: 'Dropped relation',
};

function getDiagnosticCategory(error) {
    if (error?.kind && DIAGNOSTIC_CATEGORY_LABELS[error.kind]) {
        return DIAGNOSTIC_CATEGORY_LABELS[error.kind];
    }
    if (/relation dropped/i.test(error?.message || '')) return 'Dropped relation';
    return error?.severity === 'warning' ? 'Warnings' : 'Parse errors';
}

function groupDiagnostics(parseErrors) {
    const groups = [];
    const byCategory = new Map();

    parseErrors.forEach((error) => {
        const category = getDiagnosticCategory(error);
        if (!byCategory.has(category)) {
            const group = { category, items: [] };
            byCategory.set(category, group);
            groups.push(group);
        }
        byCategory.get(category).items.push(error);
    });

    return groups;
}

function getDiagnosticLine(error) {
    return error?.line ?? error?.position?.line;
}

function getDiagnosticColumn(error) {
    return error?.column ?? error?.position?.column;
}

function getLocationLabel(error) {
    const line = getDiagnosticLine(error);
    if (!line) return null;

    const column = getDiagnosticColumn(error);
    const lineLabel = `Line ${line}${column ? `:${column}` : ''}`;
    return error?.tabTitle ? `${error.tabTitle} ${lineLabel.toLowerCase()}` : lineLabel;
}

export default function ParseErrorsDisplay({ parseErrors, setParseErrors, onDiagnosticJump, onDismissDiagnostic, canDismiss = true }) {
    const [isCollapsed, setIsCollapsed] = useState(false);

    if (!parseErrors || parseErrors.length === 0) return null;

    const errorCount = parseErrors.filter((error) => error.severity !== 'warning').length;
    const warningCount = parseErrors.length - errorCount;
    const groups = groupDiagnostics(parseErrors);

    // Click on an error to jump to that line in the Monaco editor
    const handleErrorClick = (error) => {
        if (onDiagnosticJump?.(error)) return;

        const line = getDiagnosticLine(error);
        const editors = typeof window !== 'undefined' ? window.monaco?.editor?.getEditors?.() : null;
        if (!line || !editors?.length) return;

        const editor = editors[0];
        const column = getDiagnosticColumn(error) || 1;

        editor.revealLineInCenter(line);
        editor.setPosition({ lineNumber: line, column: column });
        editor.focus();
    };

    const handleErrorKeyDown = (event, error) => {
        if (!getDiagnosticLine(error)) return;

        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleErrorClick(error);
        }
    };

    // Close error by ID - remove from full list, automatically surfaces the next error
    const handleCloseError = (e, errorToRemove) => {
        e.stopPropagation();
        if (onDismissDiagnostic) {
            onDismissDiagnostic(errorToRemove);
            return;
        }

        const newErrors = parseErrors.filter((err) => {
            if (errorToRemove.id != null) return err.id !== errorToRemove.id;
            return err !== errorToRemove;
        });
        setParseErrors(newErrors);
    };

    return (
        <section className={`parse-errors-container ${isCollapsed ? 'is-collapsed' : ''}`} aria-label="SQL diagnostics">
            <button type="button" className="parse-errors-header" onClick={() => setIsCollapsed((value) => !value)} aria-expanded={!isCollapsed} aria-controls="sql-diagnostics-list" title={isCollapsed ? 'Open SQL diagnostics' : 'Collapse SQL diagnostics'}>
                <span className="parse-errors-header-main">
                    <span className="parse-errors-toggle-icon" aria-hidden="true">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            {isCollapsed ? <polyline points="6 9 12 15 18 9" /> : <polyline points="18 15 12 9 6 15" />}
                        </svg>
                    </span>
                    <span className="parse-errors-title-group">
                        <span className="parse-errors-title">SQL diagnostics</span>
                        <span className="parse-errors-subtitle">
                            {parseErrors.length} diagnostic{parseErrors.length === 1 ? '' : 's'}
                        </span>
                    </span>
                </span>
                <span className="parse-errors-summary" aria-label={`${errorCount} errors and ${warningCount} warnings`}>
                    {errorCount > 0 && <span className="diagnostic-count error-count">{errorCount} error{errorCount === 1 ? '' : 's'}</span>}
                    {warningCount > 0 && <span className="diagnostic-count warning-count">{warningCount} warning{warningCount === 1 ? '' : 's'}</span>}
                </span>
            </button>

            {!isCollapsed && (
                <div id="sql-diagnostics-list" className="parse-errors-body">
                    {groups.map((group) => (
                        <div className="parse-error-group" key={group.category}>
                            <div className="parse-error-group-title">
                                <span>{group.category}</span>
                                <span className="parse-error-group-count">{group.items.length}</span>
                            </div>
                            {group.items.map((error, index) => {
                                const locationLabel = getLocationLabel(error);
                                const isJumpable = Boolean(getDiagnosticLine(error));

                                return (
                                    <div key={error.id ?? `${group.category}-${index}-${error.message}`} className={`parse-error-item ${error.severity === 'warning' ? 'warning-item' : 'error-item'}`}>
                                        <div
                                            className="error-content"
                                            onClick={() => handleErrorClick(error)}
                                            onKeyDown={(event) => handleErrorKeyDown(event, error)}
                                            role={isJumpable ? 'button' : undefined}
                                            tabIndex={isJumpable ? 0 : undefined}
                                            style={{ cursor: isJumpable ? 'pointer' : 'default' }}
                                            title={isJumpable ? `Click to go to ${locationLabel.toLowerCase()}` : ''}
                                            aria-label={isJumpable ? `${locationLabel}: ${error.message}` : undefined}
                                        >
                                            <div className="diagnostic-meta">
                                                <span className={`diagnostic-severity-pill ${error.severity === 'warning' ? 'warning-pill' : 'error-pill'}`}>{error.severity === 'warning' ? 'Warning' : 'Error'}</span>
                                                <span className="diagnostic-kind-pill">{group.category}</span>
                                                {locationLabel ? <span className="diagnostic-location">{locationLabel}</span> : null}
                                            </div>
                                            <span className="error-message diagnostic-message">{error.message}</span>
                                        </div>

                                        {canDismiss && (
                                            <button type="button" className={`diagnostic-dismiss-btn ${error.severity === 'warning' ? 'warning-dismiss-btn' : 'error-dismiss-btn'}`} onClick={(e) => handleCloseError(e, error)} title="Dismiss" aria-label="Dismiss diagnostic">
                                                ×
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
}
