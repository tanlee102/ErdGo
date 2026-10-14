import React, { useLayoutEffect, useRef, useState, useMemo } from 'react';
import { getAddTableReferenceTargets } from './tableModel';

import './index.css';

// ============================================================================
// ColumnOptionsDropdown — per-column options panel anchored to the gear icon
// ----------------------------------------------------------------------------
// All dialect-aware behavior is delegated to the `dialect` config object.
// This component never branches on dialect.id directly.
// ============================================================================

export const ColumnOptionsDropdown = ({ column, onUpdate, anchorEl, dialect, schema = null, onClose, tableName = '' }) => {
    const tables = useMemo(() => anchorEl ? getAddTableReferenceTargets({ schema, column, dialect, tableName }) : [], [anchorEl, schema, column, dialect, tableName]);
    const [position, setPosition] = useState(null);

    const dropdownRef = useRef(null);

    // Invalidated choices stay visible until corrected; validation blocks
    // insertion instead of silently discarding the user's foreign-key intent.

    // ── Enum value preview (read-only — informational chip) ─────────────
    const enumValues = useMemo(() => {
        if (column.type && schema) {
            const e = schema.enums?.find((x) => x.name === column.type);
            return e?.values || [];
        }
        return [];
    }, [column.type, schema]);

    // ── Position anchored to the gear button, clamped to viewport ───────
    useLayoutEffect(() => {
        if (!anchorEl || !dropdownRef.current) {
            setPosition(null);
            return;
        }

        const calc = () => {
            try {
                if (!anchorEl || !dropdownRef.current) return;
                const buttonRect = anchorEl.getBoundingClientRect();
                const ddRect = dropdownRef.current.getBoundingClientRect();
                const vw = window.innerWidth;
                const vh = window.innerHeight;
                const margin = 8;

                let left = Math.round(buttonRect.left - ddRect.width - margin);
                if (left < margin) {
                    const rightSpace = vw - buttonRect.right - margin;
                    if (rightSpace >= ddRect.width) {
                        left = Math.round(buttonRect.right + margin);
                    } else {
                        left = Math.max(margin, Math.min(Math.round(buttonRect.left), vw - ddRect.width - margin));
                    }
                }

                let top = Math.round(buttonRect.top);
                if (top + ddRect.height > vh - margin) {
                    top = Math.max(margin, vh - ddRect.height - margin);
                }

                left = Math.max(margin, Math.min(left, vw - ddRect.width - margin));
                top = Math.max(margin, Math.min(top, vh - ddRect.height - margin));

                setPosition({ top, left });
            } catch (err) {
                console.error('Error calculating dropdown position:', err);
                setPosition(null);
            }
        };

        let frameId = window.requestAnimationFrame(calc);
        const onScrollResize = () => {
            if (frameId) window.cancelAnimationFrame(frameId);
            frameId = window.requestAnimationFrame(calc);
        };
        window.addEventListener('resize', onScrollResize);
        window.addEventListener('scroll', onScrollResize, true);
        return () => {
            if (frameId) window.cancelAnimationFrame(frameId);
            window.removeEventListener('resize', onScrollResize);
            window.removeEventListener('scroll', onScrollResize, true);
        };
    }, [anchorEl, column._id, tables, enumValues.length, column.references?.table, column.references?.column]);

    if (!anchorEl) return null;

    // ── Computed flags ───────────────────────────────────────────────────
    const hasGenerated = !!(column.generated && column.generated.trim());
    const isFkSet = !!column.references?.table && !!column.references?.column;

    return (
        <div
            ref={dropdownRef}
            className="add-table-column-options-dropdown"
            style={{
                position: 'fixed',
                top: position ? `${position.top}px` : '-9999px',
                left: position ? `${position.left}px` : '-9999px',
                zIndex: 9999,
                visibility: position ? 'visible' : 'hidden',
                maxWidth: '340px',
                width: 'auto',
                pointerEvents: 'auto',
            }}
            role="dialog"
            aria-label={`Options for column ${column.name || 'new column'}`}
            aria-hidden={!position}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose?.(); anchorEl.focus(); } }}
        >
            <div className="add-table-dropdown-content">
                {/* ── Constraints ── */}
                <div className="add-table-constraint-group">
                    <label
                        className={`add-table-small-check${column.notNull ? ' is-checked' : ''}`}
                        title="NOT NULL"
                    >
                        <input
                            type="checkbox"
                            checked={!!column.notNull}
                            onChange={(e) => onUpdate({ notNull: e.target.checked })}
                        />
                        NOT NULL
                    </label>
                    <label
                        className={`add-table-small-check${column.unique ? ' is-checked' : ''}${hasGenerated ? ' is-disabled' : ''}`}
                        title="UNIQUE"
                    >
                        <input
                            type="checkbox"
                            checked={!!column.unique}
                            onChange={(e) => onUpdate({ unique: e.target.checked })}
                            disabled={hasGenerated}
                        />
                        UNIQUE
                    </label>
                    <label
                        className={`add-table-small-check${column.primaryKey ? ' is-checked' : ''}${hasGenerated ? ' is-disabled' : ''}`}
                        title="PRIMARY KEY"
                    >
                        <input
                            type="checkbox"
                            checked={!!column.primaryKey}
                            onChange={(e) => onUpdate({ primaryKey: e.target.checked })}
                            disabled={hasGenerated}
                        />
                        PRIMARY KEY
                    </label>
                </div>

                {/* ── Auto-increment ── */}
                <div className="add-table-constraint-group">
                    <label
                        className={`add-table-small-check add-table-small-check-wide${column.autoIncrement ? ' is-checked' : ''}${hasGenerated ? ' is-disabled' : ''}`}
                        title={`Auto-increment (${dialect.label} syntax)`}
                    >
                        <input
                            type="checkbox"
                            checked={!!column.autoIncrement}
                            onChange={(e) => onUpdate({ autoIncrement: e.target.checked })}
                            disabled={hasGenerated}
                        />
                        AUTO-INCREMENT
                        <span className="add-table-hint">
                            {dialect.id === 'postgres' && '→ SERIAL / BIGSERIAL'}
                            {dialect.id === 'mysql' && '→ AUTO_INCREMENT'}
                            {dialect.id === 'mssql' && '→ IDENTITY(1,1)'}
                            {dialect.id === 'sqlite' && '→ INTEGER PRIMARY KEY AUTOINCREMENT'}
                        </span>
                    </label>
                </div>

                {/* ── DEFAULT (own field with chip suggestions) ── */}
                <div className="add-table-field">
                    <div className="add-table-field-label">
                        <span>Default value</span>
                        {(hasGenerated || column.autoIncrement) && (
                            <span className="add-table-field-disabled-note">
                                disabled — {hasGenerated ? 'generated column' : 'auto-increment'}
                            </span>
                        )}
                    </div>
                    <input
                        className="add-table-field-input"
                        placeholder={`e.g. ${dialect.defaultChips[0]?.value || 'value'}`}
                        value={column.defaultValue || ''}
                        onChange={(e) => onUpdate({ defaultValue: e.target.value })}
                        onClick={(e) => e.stopPropagation()}
                        autoComplete="off"
                        spellCheck="false"
                        disabled={hasGenerated || column.autoIncrement}
                    />
                    {!hasGenerated && !column.autoIncrement && (
                        <div className="add-table-default-chips">
                            {dialect.defaultChips.map((chip) => (
                                <button
                                    key={chip.value}
                                    type="button"
                                    className={`add-table-default-chip${column.defaultValue === chip.value ? ' is-active' : ''}`}
                                    onClick={() => onUpdate({ defaultValue: chip.value })}
                                    title={`Set DEFAULT ${chip.value}`}
                                >
                                    {chip.label}
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {/* ── CHECK constraint ── */}
                <div className="add-table-field">
                    <div className="add-table-field-label">
                        <span>Check constraint</span>
                    </div>
                    <input
                        className="add-table-field-input add-table-field-input-mono"
                        placeholder="e.g. age >= 0 AND age <= 150"
                        value={column.check || ''}
                        onChange={(e) => onUpdate({ check: e.target.value })}
                        onClick={(e) => e.stopPropagation()}
                        autoComplete="off"
                        spellCheck="false"
                        disabled={hasGenerated}
                    />
                </div>

                {/* ── Generated / computed column ── */}
                <div className="add-table-field">
                    <div className="add-table-field-label">
                        <span>Generated column</span>
                        <span className="add-table-field-hint">
                            {dialect.id === 'mssql' ? 'AS (expr) PERSISTED' : 'GENERATED ALWAYS AS (expr) STORED'}
                        </span>
                    </div>
                    <input
                        className="add-table-field-input add-table-field-input-mono"
                        placeholder="expression — e.g. price * qty"
                        value={column.generated || ''}
                        onChange={(e) => onUpdate({ generated: e.target.value })}
                        onClick={(e) => e.stopPropagation()}
                        autoComplete="off"
                        spellCheck="false"
                    />
                </div>

                {/* ── Enum values (informational, read-only) ── */}
                {enumValues.length > 0 && (
                    <div className="add-table-field">
                        <div className="add-table-field-label">
                            <span>Enum values</span>
                            <span className="add-table-field-hint">{enumValues.length}</span>
                        </div>
                        <div className="add-table-enum-values-list">
                            {enumValues.map((value, idx) => (
                                <span key={idx} className="add-table-enum-value-tag">
                                    {value}
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                {/* ── Foreign Key ── */}
                <div className="add-table-field add-table-field-fk">
                    <div className="add-table-field-label">
                        <span>Foreign key</span>
                        {column.references?.table && (
                            <button
                                type="button"
                                className="add-table-fk-clear"
                                onClick={() =>
                                    onUpdate({ references: { table: '', column: '', onDelete: '', onUpdate: '' } })
                                }
                                title="Clear foreign key"
                            >
                                clear
                            </button>
                        )}
                    </div>

                    <div className="add-table-fk-row">
                        <select
                            aria-label="Reference table"
                            value={column.references?.table || ''}
                            onChange={(e) =>
                                onUpdate({
                                    references: {
                                        table: e.target.value,
                                        column: '',
                                        onDelete: column.references?.onDelete || '',
                                        onUpdate: column.references?.onUpdate || '',
                                    },
                                })
                            }
                            className="add-table-field-select"
                            onClick={(e) => e.stopPropagation()}
                            disabled={hasGenerated}
                        >
                            <option value="">— Reference table —</option>
                            {column.references?.table && !tables.some(t => t.value === column.references.table) && <option value={column.references.table} disabled>{column.references.table} · unavailable</option>}
                            {tables.map((table) => (
                                <option key={table.value} value={table.value}>
                                    {table.name}
                                </option>
                            ))}
                        </select>

                        <select
                            aria-label="Reference column"
                            value={column.references?.column || ''}
                            onChange={(e) =>
                                onUpdate({
                                    references: {
                                        table: column.references?.table || '',
                                        column: e.target.value,
                                        columnQuoted: tables.find(t => t.value === column.references?.table)?.columns.find(c => c.name === e.target.value)?.nameParts?.[0]?.quoted === true,
                                        onDelete: column.references?.onDelete || '',
                                        onUpdate: column.references?.onUpdate || '',
                                    },
                                })
                            }
                            disabled={!column.references?.table || hasGenerated}
                            className="add-table-field-select"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <option value="">— Reference column —</option>
                            {column.references?.column && !tables.find(t => t.value === column.references?.table)?.columns.some(c => c.name === column.references.column) && <option value={column.references.column} disabled>{column.references.column} · unavailable</option>}
                            {tables
                                .find((t) => t.value === column.references?.table)
                                ?.columns.map((target) => (
                                    <option key={target.name} value={target.name}>
                                        {target.name} · {target.type}
                                    </option>
                                ))}
                        </select>
                    </div>

                    {isFkSet && dialect.supportsFkActions && (
                        <div className="add-table-fk-actions">
                            <select
                                aria-label="On delete"
                                value={column.references?.onDelete || ''}
                                onChange={(e) =>
                                    onUpdate({
                                        references: { ...column.references, onDelete: e.target.value },
                                    })
                                }
                                className="add-table-field-select"
                                onClick={(e) => e.stopPropagation()}
                            >
                                <option value="">ON DELETE …</option>
                                {column.references?.onDelete && !dialect.fkActions.includes(column.references.onDelete) && <option value={column.references.onDelete} disabled>ON DELETE {column.references.onDelete} · unsupported</option>}
                                {dialect.fkActions.map((a) => (
                                    <option key={a} value={a}>
                                        ON DELETE {a}
                                    </option>
                                ))}
                            </select>
                            <select
                                aria-label="On update"
                                value={column.references?.onUpdate || ''}
                                onChange={(e) =>
                                    onUpdate({
                                        references: { ...column.references, onUpdate: e.target.value },
                                    })
                                }
                                className="add-table-field-select"
                                onClick={(e) => e.stopPropagation()}
                            >
                                <option value="">ON UPDATE …</option>
                                {column.references?.onUpdate && !dialect.fkActions.includes(column.references.onUpdate) && <option value={column.references.onUpdate} disabled>ON UPDATE {column.references.onUpdate} · unsupported</option>}
                                {dialect.fkActions.map((a) => (
                                    <option key={a} value={a}>
                                        ON UPDATE {a}
                                    </option>
                                ))}
                            </select>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
