import React, { useContext, useState, useMemo, useEffect, useCallback, useRef, useDeferredValue, useImperativeHandle } from 'react';
import { RootLayoutContext } from '@/contexts/RootLayoutContext';
import { useConfirm } from '@/components/ConfirmDialog';
import { ColumnOptionsDropdown } from './ColumnOptionsDropdown';
import { DIALECTS, DIALECT_BY_ID, DEFAULT_DIALECT_ID, flatTypes } from './dialectConfig';
import { generateSql, validateAddTableDraft } from './tableModel';
export { generateColumnLine, generateSql, getAddTableValidationErrors } from './tableModel';
import { detectEditorSqlDialect } from '@/features/editor/lib/sqlDialectDetection';
import { sqlToErdSchema } from '@/lib/erdJsonSchema';
import { identifierKey, identifierPartsFrom, identifierPartsFromText, identifierPartsEquivalent } from '@/lib/sqlIdentifierIdentity';
import { getSqlDialectProfile } from '@/lib/sqlDialectProfiles';

import './index.css';

import ConfigureIcon from '@/icons/ConfigureIcon';
import RemoveIcon from '@/icons/RemoveIcon';

// ============================================================================
// Add Table — multi-dialect (SQLite / PostgreSQL / MySQL / MSSQL) modal
// ----------------------------------------------------------------------------
// Behavior contract:
//   - Native syntax in the focused tab selects the target database on opening;
//     neutral tabs inherit the workspace. Manual choices last for this opening
//     and remain the stored fallback for SQL whose dialect cannot be detected.
//   - The selected dialect drives identifier quoting, type catalog,
//     auto-increment syntax, generated-column syntax, FK action support,
//     and `IF NOT EXISTS` legality.
//   - Composite PK: when ≥ 2 columns are flagged primaryKey, they collapse
//     into a table-level `PRIMARY KEY (a, b, …)` constraint instead of
//     inline `PRIMARY KEY` on each column (which most dialects forbid).
//   - Generated/computed columns suppress DEFAULT / CHECK / FK clauses
//     as the form's conservative generation policy; native engines differ.
//   - Auto-increment normalizes the column type to a dialect-legal integer
//     (PG: SERIAL/BIGSERIAL; MySQL: keeps INT family + AUTO_INCREMENT;
//     MSSQL: keeps INT family + IDENTITY(1,1); SQLite: forces `INTEGER`
//     and emits `AUTOINCREMENT` *after* `PRIMARY KEY`).
//   - Identifier quoting is "smart": only quotes when the identifier needs
//     it (non-bare or reserved word), so generated SQL stays readable.
//
// All emitted SQL round-trips through `parseAst` cleanly — verified by the
// end-to-end ERD pipeline tests + dialectConfig.test.js.
// ============================================================================

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const DIALECT_LS_KEY = 'addTable.dialect';
const DIALECT_LS_VERSION_KEY = 'addTable.dialect.version';
const DIALECT_STORAGE_VERSION = '2';
const DIALECT_STORAGE_ALIASES = {
    postgresql: 'postgres',
};

const DEFAULT_COLUMN = {
    name: '',
    type: '',
    notNull: false,
    primaryKey: false,
    unique: false,
    autoIncrement: false,
    defaultValue: '',
    check: '',
    generated: '',
    references: { table: '', column: '', onDelete: '', onUpdate: '' },
};

let nextColumnId = 1;
const createColumn = () => ({ ...DEFAULT_COLUMN, references: { ...DEFAULT_COLUMN.references }, _id: nextColumnId++ });

function loadDialect() {
    try {
        const stored = typeof window !== 'undefined' && window.localStorage?.getItem(DIALECT_LS_KEY);
        const storedVersion = typeof window !== 'undefined' && window.localStorage?.getItem(DIALECT_LS_VERSION_KEY);
        const aliased = DIALECT_STORAGE_ALIASES[stored] || stored;
        if (storedVersion !== DIALECT_STORAGE_VERSION && aliased === 'postgres') return DEFAULT_DIALECT_ID;
        if (aliased && DIALECT_BY_ID[aliased]) return aliased;
    } catch {
        // ignore — SSR / no-localStorage paths fall back to default
    }
    return DEFAULT_DIALECT_ID;
}

// ────────────────────────────────────────────────────────────────────────────
// SQL generation — the only place that knows how to translate the form
// state into a CREATE TABLE statement for the selected dialect.
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────────

export const AddTable = ({ closeRequestRef = null }) => {
    const { schemaRef, sqlInput, setSqlInput, displayModalAddTable, setDisplayModalAddTable, runSqlTabOperation } = useContext(RootLayoutContext);
    const { confirm } = useConfirm();

    const [preferredDialectId, setPreferredDialectId] = useState(loadDialect);
    const [manualDialectId, setManualDialectId] = useState(null);
    const [dialectDetection, setDialectDetection] = useState(() => detectEditorSqlDialect(sqlInput));
    const [ifNotExists, setIfNotExists] = useState(false);
    const [tableName, setTableName] = useState('');
    const [columns, setColumns] = useState(() => [createColumn()]);
    const [tableNameError, setTableNameError] = useState('');
    const [activeColumnIdx, setActiveColumnIdx] = useState(null);
    const [dropdownAnchorEl, setDropdownAnchorEl] = useState(null);
    const [schemaSnapshot, setSchemaSnapshot] = useState(null);
    const [sqlContext, setSqlContext] = useState(null);
    const [submitError, setSubmitError] = useState('');
    const tableNameRef = useRef(null);
    const cancelPendingRef = useRef(false);
    const submitPendingRef = useRef(false);

    const detectedDialectId = DIALECT_BY_ID[dialectDetection.id] ? dialectDetection.id : null;
    const dialectId = manualDialectId || detectedDialectId || preferredDialectId;
    const dialect = DIALECT_BY_ID[dialectId] || DIALECT_BY_ID[DEFAULT_DIALECT_ID];

    useEffect(() => {
        if (displayModalAddTable === false) {
            setManualDialectId(null);
            setActiveColumnIdx(null);
            setDropdownAnchorEl(null);
            return;
        }
        const detected = runSqlTabOperation?.('getSqlDialectDetection');
        submitPendingRef.current = false;
        setDialectDetection(detected?.id ? detected : detectEditorSqlDialect(sqlInput));
        const context = runSqlTabOperation?.('getAddTableContext');
        setSqlContext(typeof context?.beforeSql === 'string' ? context : null);
    }, [displayModalAddTable, runSqlTabOperation, sqlInput]);

    useEffect(() => { setSubmitError(''); }, [tableName, columns, dialectId, ifNotExists]);

    useEffect(() => {
        setSchemaSnapshot(schemaRef.current || null);
    }, [schemaRef, sqlInput, displayModalAddTable]);

    const referenceBase = useMemo(() => {
        const before = sqlContext?.beforeSql ?? sqlInput;
        const after = dialectId === 'sqlite' ? sqlContext?.afterSql || '' : '';
        return sqlContext || before?.trim() || after ? sqlToErdSchema(`${before || ''}\n\n${after}`, { dialect: dialectId }) : schemaSnapshot;
    }, [sqlContext, sqlInput, dialectId, schemaSnapshot]);

    const referenceSchema = useMemo(() => {
        if (!dropdownAnchorEl) return referenceBase;
        const sql = sqlContext?.beforeSql ?? sqlInput;
        const complete = tableName.trim() && columns.every(col => col.name.trim() && (col.type.trim() || col.autoIncrement || col.generated?.trim() && (dialect.computedTypeInferred || dialectId === 'sqlite')));
        const self = complete ? generateSql({ tableName, columns: columns.map(col => ({ ...col, references: {} })), dialect }) : '';
        const later = dialectId === 'sqlite' ? sqlContext?.afterSql || '' : '';
        return sql?.trim() || self || later ? sqlToErdSchema(`${sql || ''}\n\n${self}\n\n${later}`, { dialect: dialectId }) : schemaSnapshot;
    }, [sqlContext, sqlInput, dialectId, schemaSnapshot, tableName, columns, dialect, dropdownAnchorEl, referenceBase]);

    // Only manual preferences are remembered. Detection from another document
    // must not overwrite the user's fallback for empty/portable/mixed SQL.
    useEffect(() => {
        try {
            window.localStorage?.setItem(DIALECT_LS_KEY, preferredDialectId);
            window.localStorage?.setItem(DIALECT_LS_VERSION_KEY, DIALECT_STORAGE_VERSION);
        } catch { /* noop */ }
    }, [preferredDialectId]);

    // ── Type suggestions: dialect catalog ∪ user-defined enums ───────────
    const enumTypes = useMemo(() => {
        return referenceBase?.enums?.map((e) => e.name) || [];
    }, [referenceBase]);

    const typeSuggestions = useMemo(() => {
        const dialectTypes = flatTypes(dialect).map((t) => t.value);
        return [...dialectTypes, ...enumTypes];
    }, [dialect, enumTypes]);

    // ── Column-name duplicate detection ──────────────────────────────────
    const dupNames = useMemo(() => {
        const seen = new Map();
        const dups = new Set();
        for (const c of columns) {
            const n = identifierKey(identifierPartsFromText(dialect.quoteColumn(c.name || '')), dialectId);
            if (!n) continue;
            if (seen.has(n)) dups.add(n);
            else seen.set(n, true);
        }
        return dups;
    }, [columns, dialect, dialectId]);

    // ── Stable column mutators ───────────────────────────────────────────
    const updateColumn = useCallback((idx, patch) => {
        setColumns((prev) =>
            prev.map((col, i) => {
                if (i !== idx) return col;
                const next = { ...col, ...patch };

                // Auto-increment ↔ PK coupling: turning AI on forces PK on
                // (it's almost always what the user wants, and matches what
                // SERIAL/IDENTITY/AUTO_INCREMENT implies in practice).
                if (patch.autoIncrement === true && !next.primaryKey) {
                    next.primaryKey = true;
                }
                if (patch.autoIncrement === true) {
                    next.defaultValue = '';
                }
                if (patch.primaryKey === false && next.autoIncrement) {
                    next.autoIncrement = false;
                    next.primaryKey = false;
                    next.unique = false;
                }

                // Generated columns can't have DEFAULT/CHECK/FK or be PK/UQ —
                // clear them out to avoid emitting illegal SQL.
                if (patch.generated && patch.generated.trim()) {
                    next.defaultValue = '';
                    next.check = '';
                    next.references = { table: '', column: '', onDelete: '', onUpdate: '' };
                    next.autoIncrement = false;
                }

                return next;
            }),
        );
    }, []);

    const addColumn = useCallback(() => setColumns((prev) => [...prev, createColumn()]), []);

    const removeColumn = useCallback((idx) => {
        setColumns((prev) => prev.filter((_, i) => i !== idx));
        setActiveColumnIdx((prev) => {
            if (prev === idx) {
                setDropdownAnchorEl(null);
                return null;
            }
            if (prev !== null && prev > idx) return prev - 1;
            return prev;
        });
    }, []);

    const moveColumn = useCallback((idx, dir) => {
        setActiveColumnIdx(null);
        setDropdownAnchorEl(null);
        setColumns((prev) => {
            const next = [...prev];
            const target = idx + dir;
            if (target < 0 || target >= next.length) return prev;
            [next[idx], next[target]] = [next[target], next[idx]];
            return next;
        });
    }, []);

    // ── Live SQL preview ─────────────────────────────────────────────────
    const generatedSql = useMemo(
        () => generateSql({ tableName, columns, dialect, ifNotExists }),
        [tableName, columns, dialect, ifNotExists],
    );

    const validationDraft = useMemo(
        () => ({ tableName, columns, dialect, ifNotExists, beforeSql: sqlContext?.beforeSql ?? sqlInput, afterSql: sqlContext?.afterSql || '' }),
        [tableName, columns, dialect, ifNotExists, sqlContext, sqlInput],
    );
    const deferredDraft = useDeferredValue(validationDraft);
    const validation = useMemo(() => validateAddTableDraft(deferredDraft), [deferredDraft]);
    const validationErrors = validation.errors;

    const isValid = useMemo(() => {
        if (!tableName.trim() || tableNameError || !validation.ok || deferredDraft !== validationDraft) return false;
        if (columns.length === 0) return false;
        if (dupNames.size > 0) return false;
        if (validationErrors.length > 0) return false;
        return columns.every((col) => {
            if (!col.name.trim()) return false;
            // Generated columns may have an empty type only if expr provided.
            if (!col.type.trim() && !col.autoIncrement && !(col.generated?.trim() && (dialect.computedTypeInferred || dialect.id === 'sqlite'))) return false;
            return true;
        });
    }, [tableName, tableNameError, columns, dupNames, validation, validationErrors, dialect, deferredDraft, validationDraft]);

    // ── Form lifecycle ───────────────────────────────────────────────────
    const resetForm = useCallback(() => {
        setTableName('');
        setColumns([createColumn()]);
        setActiveColumnIdx(null);
        setDropdownAnchorEl(null);
        setTableNameError('');
        setIfNotExists(false);
        setSubmitError('');
    }, []);

    const handleCancel = useCallback(async () => {
        if (cancelPendingRef.current) return;
        if (dropdownAnchorEl) {
            setActiveColumnIdx(null); setDropdownAnchorEl(null);
            dropdownAnchorEl.focus(); return;
        }
        const isModified =
            tableName.trim() !== '' ||
            ifNotExists ||
            columns.length > 1 ||
            columns.some(col => Object.keys(DEFAULT_COLUMN).some(key => JSON.stringify(col[key]) !== JSON.stringify(DEFAULT_COLUMN[key])));
        if (isModified) {
            cancelPendingRef.current = true;
            let confirmed;
            try { confirmed = await confirm({
                title: 'Discard changes?',
                message: 'Are you sure you want to discard your changes?',
                confirmText: 'Discard',
                tone: 'danger',
            }); } finally { cancelPendingRef.current = false; }
            if (!confirmed) return;
        }
        resetForm();
        setDisplayModalAddTable(false);
    }, [tableName, columns, ifNotExists, resetForm, setDisplayModalAddTable, confirm, dropdownAnchorEl]);

    useImperativeHandle(closeRequestRef, () => handleCancel, [handleCancel]);

    const handleSubmit = useCallback(
        (e) => {
            e.preventDefault();
            if (!isValid || submitPendingRef.current) return;
            const current = runSqlTabOperation?.('getAddTableContext');
            const context = typeof current?.beforeSql === 'string' ? current : { beforeSql: sqlInput, afterSql: '' };
            const checked = validateAddTableDraft({ tableName, columns, dialect, ifNotExists, ...context });
            if (!checked.ok) { setSubmitError(checked.errors.join(' ') || 'Complete the table fields.'); setSqlContext(context); return; }
            // In the tab editor, new table SQL belongs in the focused tab. The
            // fallback keeps this modal usable in any older single-SQL surface.
            const appendedToActiveTab = context.revision
                ? runSqlTabOperation?.('appendSqlToActiveTab', checked.sql, { expectedRevision: context.revision })
                : runSqlTabOperation?.('appendSqlToActiveTab', checked.sql);
            if (appendedToActiveTab !== true && appendedToActiveTab !== undefined) { setSubmitError('SQL changed. Check the current table fields and try again.'); return; }
            submitPendingRef.current = true;
            if (appendedToActiveTab === undefined) {
                setSqlInput((prev) => (prev ? `${prev}\n\n${checked.sql}` : checked.sql));
            }
            // New tables are the deliberate exception to the general Auto
            // contrast default: start with adaptive white header/badge text.
            // Choosing Auto later clears this sparse per-table override.
            runSqlTabOperation?.('applyNewTableDefaults', checked.tableName);
            resetForm();
            setDisplayModalAddTable(false);
        },
        [isValid, runSqlTabOperation, setSqlInput, setDisplayModalAddTable, resetForm, tableName, columns, dialect, ifNotExists, sqlInput],
    );

    // ── Dropdown plumbing ────────────────────────────────────────────────
    const closeDropdown = useCallback(() => {
        setActiveColumnIdx(null);
        setDropdownAnchorEl(null);
    }, []);

    const handleConfigureClick = useCallback(
        (e, idx) => {
            e.preventDefault();
            const buttonEl = e.currentTarget;
            if (activeColumnIdx === idx) closeDropdown();
            else {
                setActiveColumnIdx(idx);
                setDropdownAnchorEl(buttonEl);
            }
        },
        [activeColumnIdx, closeDropdown],
    );

    // ── Table-name uniqueness against the live ERD schema ────────────────
    useEffect(() => {
        if (!tableName) {
            setTableNameError('');
            return;
        }
        const normalized = identifierPartsFromText(dialect.quoteIdent(tableName));
        const existing = referenceBase?.tables || [];
        const exists = existing.some((t) => identifierPartsEquivalent(identifierPartsFrom(t.sourceName || t.fullName || t.name, t.sourceParts), normalized, getSqlDialectProfile(dialectId).defaultSchema, dialectId));
        setTableNameError(exists ? `Table "${tableName}" already exists` : '');
    }, [tableName, referenceBase, dialect, dialectId]);

    // ── Outside click + Escape closes the column dropdown ────────────────
    useEffect(() => {
        const onMouseDown = (e) => {
            if (
                !e.target.closest('.add-table-column-options-dropdown') &&
                !e.target.closest('.add-table-dropdown-btn')
            ) {
                closeDropdown();
            }
        };
        const onKeyDown = (e) => {
            if (e.key === 'Escape' && dropdownAnchorEl) { e.preventDefault(); e.stopPropagation(); closeDropdown(); dropdownAnchorEl.focus(); }
        };
        document.addEventListener('mousedown', onMouseDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onMouseDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [closeDropdown, dropdownAnchorEl]);

    // ────────────────────────────────────────────────────────────────────
    // Render
    // ────────────────────────────────────────────────────────────────────

    const renderColumnRow = (col, idx) => {
        const isDup = dupNames.has(identifierKey(identifierPartsFromText(dialect.quoteColumn(col.name || '')), dialectId));
        return (
            <div
                className={`add-table-column-row${isDup ? ' has-error' : ''}`}
                key={col._id}
                data-index={idx + 1}
            >
                <input
                    type="text"
                    className="add-table-col-name"
                    placeholder="column_name"
                    value={col.name}
                    onChange={(e) => updateColumn(idx, { name: e.target.value.replace(/\s+/g, '_') })}
                    required
                    autoComplete="off"
                    spellCheck="false"
                    title={isDup ? 'Duplicate column name' : ''}
                />
                <div className="add-table-type-badges-wrapper">
                    <input
                        list="add-table-types"
                        className="add-table-col-type"
                        placeholder={dialect.computedTypeInferred && col.generated?.trim() ? 'inferred from expression' : col.autoIncrement ? 'auto-detected' : dialectId === 'sqlite' && col.generated ? '(optional)' : 'data type'}
                        value={dialect.computedTypeInferred && col.generated?.trim() ? '' : col.type}
                        disabled={Boolean(dialect.computedTypeInferred && col.generated?.trim())}
                        onChange={(e) => updateColumn(idx, { type: e.target.value })}
                        autoComplete="off"
                        spellCheck="false"
                    />
                    <div className="add-table-col-badges">
                        {col.primaryKey && <span className="add-table-col-badge badge-pk">PK</span>}
                        {col.autoIncrement && <span className="add-table-col-badge badge-ai">AI</span>}
                        {col.notNull && !col.primaryKey && <span className="add-table-col-badge badge-nn">NN</span>}
                        {col.unique && <span className="add-table-col-badge badge-uq">UQ</span>}
                        {col.references?.table && <span className="add-table-col-badge badge-fk">FK</span>}
                        {col.generated && <span className="add-table-col-badge badge-gen">GEN</span>}
                    </div>
                </div>

                <div className="add-table-column-controls">
                    <button
                        type="button"
                        className="add-table-btn-icon add-table-move-btn"
                        title="Move up"
                        aria-label="Move column up"
                        onClick={() => moveColumn(idx, -1)}
                        disabled={idx === 0}
                    >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <polyline points="18 15 12 9 6 15" />
                        </svg>
                    </button>
                    <button
                        type="button"
                        className="add-table-btn-icon add-table-move-btn"
                        title="Move down"
                        aria-label="Move column down"
                        onClick={() => moveColumn(idx, 1)}
                        disabled={idx === columns.length - 1}
                    >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <polyline points="6 9 12 15 18 9" />
                        </svg>
                    </button>
                    <button
                        type="button"
                        className={`add-table-dropdown-btn add-table-btn-icon${activeColumnIdx === idx ? ' active' : ''}`}
                        onClick={(e) => handleConfigureClick(e, idx)}
                        title="Column options"
                        aria-label={`Options for column ${col.name || idx + 1}`}
                    >
                        <ConfigureIcon width="16px" height="16px" />
                    </button>
                    {columns.length > 1 && (
                        <button
                            type="button"
                            onClick={() => removeColumn(idx)}
                            className="add-table-btn-icon btn-remove"
                            title="Remove column"
                            aria-label={`Remove column ${col.name || idx + 1}`}
                        >
                            <RemoveIcon width="16px" height="16px" />
                        </button>
                    )}
                </div>
            </div>
        );
    };

    return (
        <form className="add-table-form-container" onSubmit={handleSubmit}>
            {/* ── Dialect selector ─────────────────────────────────── */}
            <div className="add-table-section add-table-dialect-section">
                <div className="add-table-section-label">Target Database</div>
                <div className="add-table-dialect-row">
                    <div className="add-table-dialect-pills" role="radiogroup" aria-label="SQL dialect">
                        {DIALECTS.map((d) => (
                            <button
                                key={d.id}
                                type="button"
                                role="radio"
                                aria-checked={d.id === dialectId}
                                tabIndex={d.id === dialectId ? 0 : -1}
                                className={`add-table-dialect-pill${d.id === dialectId ? ' is-active' : ''}`}
                                onClick={() => {
                                    setManualDialectId(d.id);
                                    setPreferredDialectId(d.id);
                                }}
                                onKeyDown={(event) => {
                                    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
                                    event.preventDefault();
                                    const current = DIALECTS.findIndex(item => item.id === d.id);
                                    const index = event.key === 'Home' ? 0 : event.key === 'End' ? DIALECTS.length - 1 : (current + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + DIALECTS.length) % DIALECTS.length;
                                    setManualDialectId(DIALECTS[index].id); setPreferredDialectId(DIALECTS[index].id);
                                    event.currentTarget.parentElement.querySelectorAll('[role="radio"]')[index]?.focus();
                                }}
                                title={`Generate ${d.label} syntax`}
                            >
                                {d.label}
                            </button>
                        ))}
                    </div>
                    <label className={`add-table-toggle${ifNotExists ? ' is-checked' : ''}`} title="Add IF NOT EXISTS">
                        <input
                            type="checkbox"
                            checked={ifNotExists}
                            onChange={(e) => setIfNotExists(e.target.checked)}
                        />
                        IF NOT EXISTS
                    </label>
                </div>
                <div className="add-table-dialect-hint">
                    {manualDialectId
                        ? `${dialect.label} selected manually. ${dialectDetection.description}`
                        : detectedDialectId
                            ? `${dialectDetection.description} Target Database selected automatically.`
                            : `${dialectDetection.description} Using ${dialect.label} as the default.`}
                </div>
            </div>

            {/* ── Table Name ────────────────────────────────────────── */}
            <div className="add-table-section">
                <div className="add-table-section-label">Table Name</div>
                <div className="add-table-top-row">
                    <div className={`add-table-name-field${tableNameError ? ' has-error' : ''}`}>
                        <span className="add-table-name-prefix">TABLE</span>
                        <input
                            ref={tableNameRef}
                            className="add-table-input-name"
                            type="text"
                            value={tableName}
                            data-modal-autofocus="true"
                            onChange={(e) => setTableName(e.target.value.replace(/\s+/g, '_'))}
                            placeholder="users"
                            required
                            autoComplete="off"
                            spellCheck="false"
                        />
                    </div>
                    {tableNameError && <span className="add-table-error-message">{tableNameError}</span>}
                </div>
            </div>

            {/* ── Columns ───────────────────────────────────────────── */}
            <div className="add-table-section">
                <div className="add-table-section-label">
                    Columns
                    {dupNames.size > 0 && (
                        <span className="add-table-section-warn">{dupNames.size} duplicate column name{dupNames.size > 1 ? 's' : ''}</span>
                    )}
                </div>

                <datalist id="add-table-types">
                    {typeSuggestions.map((type, index) => (
                        <option key={index} value={type} />
                    ))}
                </datalist>

                <div className="add-table-columns-list">{columns.map(renderColumnRow)}</div>

                <div className="add-table-cols-actions">
                    <button type="button" onClick={addColumn} className="add-table-add-col-btn">
                        + Add Column
                    </button>
                </div>

                {validationErrors.length > 0 && (
                    <div className="add-table-validation-errors" role="alert">
                        {validationErrors.map((message) => (
                            <div key={message}>{message}</div>
                        ))}
                    </div>
                )}
            </div>

            {/* ── SQL Preview ───────────────────────────────────────── */}
            <details className="add-table-section add-table-preview-details">
                <summary className="add-table-section-label" tabIndex={0}>
                    SQL Preview
                    <span className="add-table-dialect-badge">{dialect.label}</span>
                </summary>
                <pre className="add-table-sql-preview">{generatedSql || '-- fill in table name and columns above --'}</pre>
            </details>

            {/* ── Actions ───────────────────────────────────────────── */}
            <div className="add-table-actions-row">
                <button type="button" className="add-table-cancel-btn" onClick={handleCancel}>
                    Cancel
                </button>
                <button type="submit" className="add-table-submit-btn" disabled={!isValid}>
                    Insert into SQL
                </button>
            </div>

            {submitError && <div className="add-table-validation-errors" role="alert">{submitError}</div>}

            <ColumnOptionsDropdown
                column={columns[activeColumnIdx] || {}}
                onUpdate={(patch) => activeColumnIdx !== null && updateColumn(activeColumnIdx, patch)}
                anchorEl={dropdownAnchorEl}
                dialect={dialect}
                schema={referenceSchema}
                tableName={tableName}
                onClose={closeDropdown}
            />
        </form>
    );
};
