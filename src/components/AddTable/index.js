import React, { useContext, useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { RootLayoutContext } from '@/contexts/RootLayoutContext';
import { useConfirm } from '@/components/ConfirmDialog';
import { ColumnOptionsDropdown } from './ColumnOptionsDropdown';
import { DIALECTS, DIALECT_BY_ID, DEFAULT_DIALECT_ID, flatTypes, formatDefault } from './dialectConfig';

import './index.css';

import ConfigureIcon from '@/icons/ConfigureIcon';
import RemoveIcon from '@/icons/RemoveIcon';

// ============================================================================
// Add Table — multi-dialect (SQLite / PostgreSQL / MySQL / MSSQL) modal
// ----------------------------------------------------------------------------
// Behavior contract:
//   - The selected dialect drives identifier quoting, type catalog,
//     auto-increment syntax, generated-column syntax, FK action support,
//     and `IF NOT EXISTS` legality.
//   - Composite PK: when ≥ 2 columns are flagged primaryKey, they collapse
//     into a table-level `PRIMARY KEY (a, b, …)` constraint instead of
//     inline `PRIMARY KEY` on each column (which most dialects forbid).
//   - Generated/computed columns suppress DEFAULT / CHECK / FK clauses
//     because they are mutually exclusive in every supported dialect.
//   - Auto-increment normalizes the column type to a dialect-legal integer
//     (PG: SERIAL/BIGSERIAL; MySQL: keeps INT family + AUTO_INCREMENT;
//     MSSQL: keeps INT family + IDENTITY(1,1); SQLite: forces `INTEGER`
//     and emits `AUTOINCREMENT` *after* `PRIMARY KEY`).
//   - Identifier quoting is "smart": only quotes when the identifier needs
//     it (non-bare or reserved word), so generated SQL stays readable.
//
// All emitted SQL round-trips through `parseAst` cleanly — verified by the
// the end-to-end ERD pipeline and dialect configuration.
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
const createColumn = () => ({ ...DEFAULT_COLUMN, _id: nextColumnId++ });

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

export function generateColumnLine(col, dialect) {
    const q = dialect.quoteIdent;
    const parts = [q(col.name || 'col')];

    // Generated/computed column — special-cased; no default/check/fk allowed.
    if (col.generated && col.generated.trim()) {
        parts.push(col.type || 'TEXT');
        parts.push(dialect.generatedSql(col.generated.trim()));
        if (col.notNull) parts.push('NOT NULL');
        return '  ' + parts.join(' ');
    }

    // Auto-increment column — translate type + suffix per dialect.
    //
    // `placement` controls when the suffix is emitted:
    //   • 'after-type' (default — MySQL/MSSQL): suffix follows the type, e.g.
    //     `id INT AUTO_INCREMENT PRIMARY KEY`.
    //   • 'after-pk'   (SQLite):                suffix follows PRIMARY KEY,
    //     e.g. `id INTEGER PRIMARY KEY AUTOINCREMENT`.
    //
    // For SQLite composite-PK columns the inline `PRIMARY KEY` is suppressed,
    // so the `after-pk` suffix is naturally suppressed too (which is correct —
    // SQLite forbids AUTOINCREMENT on composite PKs).
    let aiSuffix = '';
    let aiPlacement = 'after-type';
    if (col.autoIncrement) {
        const ai = dialect.autoIncrement(col.type);
        parts.push(ai.type);
        aiSuffix = ai.suffix || '';
        aiPlacement = ai.placement || 'after-type';
        if (aiSuffix && aiPlacement === 'after-type') parts.push(aiSuffix);
    } else {
        parts.push(col.type || 'TEXT');
    }

    // Inline PRIMARY KEY only when this is the *single* PK column. Composite
    // PKs are emitted as a table-level constraint by the caller.
    if (col.primaryKey && !col._isComposite) {
        parts.push('PRIMARY KEY');
        if (aiSuffix && aiPlacement === 'after-pk') parts.push(aiSuffix);
    }
    if (col.unique) parts.push('UNIQUE');
    if (col.notNull && !col.primaryKey) parts.push('NOT NULL'); // PK implies NN

    if (col.defaultValue && !col.autoIncrement) {
        parts.push(`DEFAULT ${formatDefault(col.defaultValue)}`);
    }

    if (col.check && col.check.trim()) {
        parts.push(`CHECK (${col.check.trim()})`);
    }

    if (col.references?.table && col.references?.column) {
        parts.push(`REFERENCES ${dialect.quoteIdent(col.references.table)}(${dialect.quoteIdent(col.references.column)})`);
        if (dialect.supportsFkActions) {
            if (col.references.onDelete) parts.push(`ON DELETE ${col.references.onDelete}`);
            if (col.references.onUpdate) parts.push(`ON UPDATE ${col.references.onUpdate}`);
        }
    }

    return '  ' + parts.join(' ');
}

export function generateSql({ tableName, columns, dialect, ifNotExists }) {
    if (!tableName) return '';

    const q = dialect.quoteIdent;
    const pkCols = columns.filter((c) => c.primaryKey);
    const isComposite = pkCols.length >= 2;
    const taggedCols = columns.map((c) => ({ ...c, _isComposite: isComposite }));

    const colLines = taggedCols.map((c) => generateColumnLine(c, dialect));

    if (isComposite) {
        const pkList = pkCols.map((c) => q(c.name || 'col')).join(', ');
        colLines.push(`  PRIMARY KEY (${pkList})`);
    }

    const tablePart = q(tableName);
    const head =
        ifNotExists && dialect.supportsIfNotExists
            ? `CREATE TABLE IF NOT EXISTS ${tablePart}`
            : `CREATE TABLE ${tablePart}`;

    let sql = `${head} (\n${colLines.join(',\n')}\n)`;
    if (dialect.tableSuffix) sql += ` ${dialect.tableSuffix}`;
    sql += ';';

    // MSSQL `IF NOT EXISTS` translates to a guarded EXEC.
    if (ifNotExists && !dialect.supportsIfNotExists && dialect.id === 'mssql') {
        const objId = `OBJECT_ID(N'${tableName.replace(/'/g, "''")}', N'U')`;
        sql = `IF ${objId} IS NULL\nBEGIN\n${sql}\nEND;`;
    }

    return sql;
}

function getColumnLabel(col, index) {
    const name = typeof col?.name === 'string' ? col.name.trim() : '';
    return name || `column ${index + 1}`;
}

export function getAddTableValidationErrors({ columns, dialect }) {
    const safeColumns = Array.isArray(columns) ? columns : [];
    const errors = [];

    safeColumns.forEach((col, index) => {
        const label = getColumnLabel(col, index);
        const references = col?.references || {};
        const hasReferenceIntent = Boolean(references.table || references.column || references.onDelete || references.onUpdate);
        const hasGenerated = Boolean(col?.generated && col.generated.trim());

        if (col?.autoIncrement && !col?.primaryKey) {
            errors.push(`${label}: auto-increment requires PRIMARY KEY`);
        }

        if (hasReferenceIntent && !(references.table && references.column)) {
            errors.push(`${label}: choose both reference table and reference column`);
        }

        if (hasGenerated) {
            const hasGeneratedConflict = Boolean(
                col?.autoIncrement ||
                col?.primaryKey ||
                col?.unique ||
                col?.defaultValue ||
                col?.check ||
                references.table ||
                references.column,
            );
            if (hasGeneratedConflict) {
                errors.push(`${label}: generated columns cannot also use PK, UNIQUE, DEFAULT, CHECK, FK, or auto-increment`);
            }
        }
    });

    if (dialect?.id === 'sqlite') {
        const primaryKeyColumns = safeColumns.filter((col) => col?.primaryKey);
        const hasCompositeAutoIncrement = primaryKeyColumns.length >= 2 && primaryKeyColumns.some((col) => col?.autoIncrement);
        if (hasCompositeAutoIncrement) {
            errors.push('SQLite AUTOINCREMENT requires a single INTEGER PRIMARY KEY column');
        }
    }

    return errors;
}

// ────────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────────

export const AddTable = () => {
    const { schemaRef, sqlInput, setSqlInput, setDisplayModalAddTable, runSqlTabOperation } = useContext(RootLayoutContext);
    const { confirm } = useConfirm();

    const [dialectId, setDialectId] = useState(loadDialect);
    const [ifNotExists, setIfNotExists] = useState(false);
    const [tableName, setTableName] = useState('');
    const [columns, setColumns] = useState(() => [createColumn()]);
    const [tableNameError, setTableNameError] = useState('');
    const [activeColumnIdx, setActiveColumnIdx] = useState(null);
    const [dropdownAnchorEl, setDropdownAnchorEl] = useState(null);
    const [schemaSnapshot, setSchemaSnapshot] = useState(null);
    const tableNameRef = useRef(null);

    const dialect = DIALECT_BY_ID[dialectId] || DIALECT_BY_ID[DEFAULT_DIALECT_ID];

    useEffect(() => {
        setSchemaSnapshot(schemaRef.current || null);
    }, [schemaRef, sqlInput]);

    // Persist dialect choice locally so the user picks once.
    useEffect(() => {
        try {
            window.localStorage?.setItem(DIALECT_LS_KEY, dialectId);
            window.localStorage?.setItem(DIALECT_LS_VERSION_KEY, DIALECT_STORAGE_VERSION);
        } catch { /* noop */ }
    }, [dialectId]);

    // ── Type suggestions: dialect catalog ∪ user-defined enums ───────────
    const enumTypes = useMemo(() => {
        return schemaSnapshot?.enums?.map((e) => e.name) || [];
    }, [schemaSnapshot]);

    const typeSuggestions = useMemo(() => {
        const dialectTypes = flatTypes(dialect).map((t) => t.value);
        return [...dialectTypes, ...enumTypes];
    }, [dialect, enumTypes]);

    // ── Column-name duplicate detection ──────────────────────────────────
    const dupNames = useMemo(() => {
        const seen = new Map();
        const dups = new Set();
        for (const c of columns) {
            const n = (c.name || '').toLowerCase().trim();
            if (!n) continue;
            if (seen.has(n)) dups.add(n);
            else seen.set(n, true);
        }
        return dups;
    }, [columns]);

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

    const validationErrors = useMemo(
        () => getAddTableValidationErrors({ columns, dialect }),
        [columns, dialect],
    );

    const isValid = useMemo(() => {
        if (!tableName.trim() || tableNameError) return false;
        if (columns.length === 0) return false;
        if (dupNames.size > 0) return false;
        if (validationErrors.length > 0) return false;
        return columns.every((col) => {
            if (!col.name.trim()) return false;
            // Generated columns may have an empty type only if expr provided.
            if (!col.type.trim() && !(col.generated && col.generated.trim())) return false;
            return true;
        });
    }, [tableName, tableNameError, columns, dupNames, validationErrors]);

    // ── Form lifecycle ───────────────────────────────────────────────────
    const resetForm = useCallback(() => {
        setTableName('');
        setColumns([createColumn()]);
        setActiveColumnIdx(null);
        setDropdownAnchorEl(null);
        setTableNameError('');
        setIfNotExists(false);
    }, []);

    const handleCancel = useCallback(async () => {
        const isModified =
            tableName.trim() !== '' ||
            columns.length > 1 ||
            columns[0].name !== '' ||
            columns[0].type !== '';
        if (isModified) {
            const confirmed = await confirm({
                title: 'Discard changes?',
                message: 'Are you sure you want to discard your changes?',
                confirmText: 'Discard',
                tone: 'danger',
            });
            if (!confirmed) return;
        }
        resetForm();
        setDisplayModalAddTable(false);
    }, [tableName, columns, resetForm, setDisplayModalAddTable, confirm]);

    const handleSubmit = useCallback(
        (e) => {
            e.preventDefault();
            if (!isValid) return;
            // In the tab editor, new table SQL belongs in the focused tab. The
            // fallback keeps this modal usable in any older single-SQL surface.
            const appendedToActiveTab = runSqlTabOperation?.('appendSqlToActiveTab', generatedSql);
            if (!appendedToActiveTab) {
                setSqlInput((prev) => (prev ? `${prev}\n\n${generatedSql}` : generatedSql));
            }
            // New tables are the deliberate exception to the general Auto
            // contrast default: start with adaptive white header/badge text.
            // Choosing Auto later clears this sparse per-table override.
            runSqlTabOperation?.('applyNewTableDefaults', tableName.trim());
            resetForm();
            setDisplayModalAddTable(false);
        },
        [isValid, generatedSql, runSqlTabOperation, setSqlInput, setDisplayModalAddTable, resetForm, tableName],
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
        const normalized = tableName.toLowerCase().trim();
        const existing = schemaSnapshot?.tables || [];
        const exists = existing.some((t) => t.name.toLowerCase() === normalized);
        setTableNameError(exists ? `Table "${tableName}" already exists` : '');
    }, [tableName, schemaSnapshot]);

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
            if (e.key === 'Escape') closeDropdown();
        };
        document.addEventListener('mousedown', onMouseDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onMouseDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [closeDropdown]);

    // ────────────────────────────────────────────────────────────────────
    // Render
    // ────────────────────────────────────────────────────────────────────

    const renderColumnRow = (col, idx) => {
        const isDup = dupNames.has((col.name || '').toLowerCase().trim());
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
                        placeholder={col.autoIncrement ? 'auto-detected' : col.generated ? '(optional)' : 'data type'}
                        value={col.type}
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
                                className={`add-table-dialect-pill${d.id === dialectId ? ' is-active' : ''}`}
                                onClick={() => setDialectId(d.id)}
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
            <div className="add-table-section">
                <div className="add-table-section-label">
                    SQL Preview
                    <span className="add-table-dialect-badge">{dialect.label}</span>
                </div>
                <pre className="add-table-sql-preview">{generatedSql || '-- fill in table name and columns above --'}</pre>
            </div>

            {/* ── Actions ───────────────────────────────────────────── */}
            <div className="add-table-actions-row">
                <button type="button" className="add-table-cancel-btn" onClick={handleCancel}>
                    Cancel
                </button>
                <button type="submit" className="add-table-submit-btn" disabled={!isValid}>
                    Insert into SQL
                </button>
            </div>

            <ColumnOptionsDropdown
                column={columns[activeColumnIdx] || {}}
                onUpdate={(patch) => activeColumnIdx !== null && updateColumn(activeColumnIdx, patch)}
                anchorEl={dropdownAnchorEl}
                dialect={dialect}
                schema={schemaSnapshot}
            />
        </form>
    );
};
