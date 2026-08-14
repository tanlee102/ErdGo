import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { buildTableCsvDownload } from '@/features/data-view/lib/exportTableData';
import './index.css';

function ChevronIcon({ expanded }) {
    return (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`tv-chevron ${expanded ? 'tv-chevron-open' : ''}`}>
            <polyline points="9 18 15 12 9 6" />
        </svg>
    );
}

function KeyIcon() {
    return (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="tv-icon-key">
            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
        </svg>
    );
}

function ChainIcon() {
    return (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="tv-icon-chain">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
    );
}

function DownloadIcon() {
    return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="M7 10l5 5 5-5" />
            <path d="M12 15V3" />
        </svg>
    );
}

function CellValue({ value }) {
    if (value === null || value === undefined) {
        return <span className="tv-cell-null">NULL</span>;
    }
    if (typeof value === 'boolean') {
        return <span className={`tv-cell-bool ${value ? 'tv-bool-true' : 'tv-bool-false'}`}>{String(value)}</span>;
    }
    if (typeof value === 'number') {
        return <span className="tv-cell-number">{value}</span>;
    }
    return <span>{String(value)}</span>;
}

function EnumIcon() {
    return (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="tv-icon-enum">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
        </svg>
    );
}

function IndexIcon() {
    return (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="tv-icon-idx">
            <line x1="4" y1="6" x2="20" y2="6" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="18" x2="14" y2="18" />
            <circle cx="19" cy="18" r="2" />
        </svg>
    );
}

function describeIndexesForColumn(col, indexes) {
    if (!indexes || indexes.length === 0) return '';
    const matching = indexes.filter((idx) => idx.columns.some((c) => c.toLowerCase() === col.name.toLowerCase()));
    if (matching.length === 0) return '';
    return matching
        .map((idx) => {
            const kind = idx.unique ? 'UNIQUE INDEX' : idx.type ? `${idx.type.toUpperCase()} INDEX` : 'INDEX';
            const name = idx.name ? `${idx.name} ` : '';
            const cols = idx.columns.join(', ');
            return `${kind} ${name}(${cols})`;
        })
        .join(' • ');
}

export default function TableViewer({ tables, types, executionLog }) {
    const tabsScrollRef = useRef(null);
    // The table tab strip supports drag-scroll with momentum. Mutable refs keep
    // pointer velocity and click suppression outside render state.
    const dragStateRef = useRef({
        isMouseDown: false,
        isDragging: false,
        startX: 0,
        startScrollLeft: 0,
        suppressClickUntil: 0,
        velocityTracker: [],
        momentumRaf: 0,
    });

    const tableList = useMemo(() => {
        if (!tables || tables.size === 0) return [];
        return Array.from(tables.values());
    }, [tables]);

    const typeList = useMemo(() => {
        if (!types || types.size === 0) return [];
        return Array.from(types.values()).filter((t) => !t.isInline);
    }, [types]);

    const [activeTab, setActiveTab] = useState(0);
    const [showLog, setShowLog] = useState(false);
    const [showTypes, setShowTypes] = useState(false);
    const [schemaOpen, setSchemaOpen] = useState(true);
    const [dataOpen, setDataOpen] = useState(true);
    const [isTabStripDragging, setIsTabStripDragging] = useState(false);
    const [edgeFade, setEdgeFade] = useState({ left: false, right: false });

    const validIdx = activeTab < tableList.length ? activeTab : 0;
    const activeTable = tableList[validIdx] || null;

    const toggleSchema = useCallback(() => setSchemaOpen((p) => !p), []);
    const toggleData = useCallback(() => setDataOpen((p) => !p), []);

    const handleDownloadActiveTableCsv = useCallback((event) => {
        event.stopPropagation();
        if (!activeTable || activeTable.rows.length === 0) return;

        const { csv, fileName } = buildTableCsvDownload(activeTable);
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');

        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.setTimeout(() => URL.revokeObjectURL(url), 100);
    }, [activeTable]);

    const updateEdgeFade = useCallback(() => {
        const el = tabsScrollRef.current;
        if (!el) return;
        const hasLeft = el.scrollLeft > 1;
        const hasRight = el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
        setEdgeFade((prev) => {
            if (prev.left === hasLeft && prev.right === hasRight) return prev;
            return { left: hasLeft, right: hasRight };
        });
    }, []);

    useEffect(() => {
        const el = tabsScrollRef.current;
        if (!el) return;
        updateEdgeFade();
        el.addEventListener('scroll', updateEdgeFade, { passive: true });
        const ro = new ResizeObserver(updateEdgeFade);
        ro.observe(el);
        return () => {
            el.removeEventListener('scroll', updateEdgeFade);
            ro.disconnect();
        };
    }, [updateEdgeFade, tableList.length]);

    const scrollTabIntoView = useCallback((index) => {
        const el = tabsScrollRef.current;
        if (!el) return;
        const btn = el.children[index];
        if (!btn) return;
        const elRect = el.getBoundingClientRect();
        const btnRect = btn.getBoundingClientRect();
        if (btnRect.left < elRect.left) {
            el.scrollTo({ left: el.scrollLeft + btnRect.left - elRect.left - 8, behavior: 'smooth' });
        } else if (btnRect.right > elRect.right) {
            el.scrollTo({ left: el.scrollLeft + btnRect.right - elRect.right + 8, behavior: 'smooth' });
        }
    }, []);

    const startMomentum = useCallback(() => {
        const state = dragStateRef.current;
        const el = tabsScrollRef.current;
        if (!el) return;
        const points = state.velocityTracker;
        if (points.length < 2) return;
        const last = points[points.length - 1];
        const prev = points[Math.max(0, points.length - 3)];
        const dt = last.t - prev.t;
        if (dt <= 0) return;
        let velocity = (last.x - prev.x) / dt;
        const friction = 0.95;
        const step = () => {
            if (Math.abs(velocity) < 0.3) return;
            el.scrollLeft -= velocity * 16;
            velocity *= friction;
            state.momentumRaf = requestAnimationFrame(step);
        };
        state.momentumRaf = requestAnimationFrame(step);
    }, []);

    useEffect(() => {
        const handleMouseMove = (e) => {
            const state = dragStateRef.current;
            const scrollEl = tabsScrollRef.current;
            if (!state.isMouseDown || !scrollEl) return;

            const deltaX = e.clientX - state.startX;
            if (!state.isDragging && Math.abs(deltaX) > 4) {
                state.isDragging = true;
                setIsTabStripDragging(true);
            }

            if (!state.isDragging) return;

            e.preventDefault();
            scrollEl.scrollLeft = state.startScrollLeft - deltaX;
            state.velocityTracker.push({ x: e.clientX, t: performance.now() });
            if (state.velocityTracker.length > 6) state.velocityTracker.shift();
        };

        const finishDrag = () => {
            const state = dragStateRef.current;
            if (!state.isMouseDown) return;

            if (state.isDragging) {
                state.suppressClickUntil = performance.now() + 180;
                startMomentum();
            }

            state.isMouseDown = false;
            state.isDragging = false;
            setIsTabStripDragging(false);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', finishDrag);
        window.addEventListener('blur', finishDrag);

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', finishDrag);
            window.removeEventListener('blur', finishDrag);
        };
    }, [startMomentum]);

    const handleTabsMouseDown = (e) => {
        if (e.button !== 0) return;
        const scrollEl = tabsScrollRef.current;
        if (!scrollEl) return;
        cancelAnimationFrame(dragStateRef.current.momentumRaf);
        const state = dragStateRef.current;
        state.isMouseDown = true;
        state.isDragging = false;
        state.startX = e.clientX;
        state.startScrollLeft = scrollEl.scrollLeft;
        state.velocityTracker = [{ x: e.clientX, t: performance.now() }];
    };

    const handleTabsClickCapture = (e) => {
        if (performance.now() < dragStateRef.current.suppressClickUntil) {
            e.preventDefault();
            e.stopPropagation();
        }
    };

    const handleTouchStart = (e) => {
        const scrollEl = tabsScrollRef.current;
        if (!scrollEl || e.touches.length !== 1) return;
        cancelAnimationFrame(dragStateRef.current.momentumRaf);
        const touch = e.touches[0];
        const state = dragStateRef.current;
        state.isMouseDown = true;
        state.isDragging = false;
        state.startX = touch.clientX;
        state.startScrollLeft = scrollEl.scrollLeft;
        state.velocityTracker = [{ x: touch.clientX, t: performance.now() }];
    };

    const handleTouchMove = (e) => {
        const state = dragStateRef.current;
        const scrollEl = tabsScrollRef.current;
        if (!state.isMouseDown || !scrollEl || e.touches.length !== 1) return;
        const touch = e.touches[0];
        const deltaX = touch.clientX - state.startX;
        if (!state.isDragging && Math.abs(deltaX) > 4) {
            state.isDragging = true;
            setIsTabStripDragging(true);
        }
        if (!state.isDragging) return;
        e.preventDefault();
        scrollEl.scrollLeft = state.startScrollLeft - deltaX;
        state.velocityTracker.push({ x: touch.clientX, t: performance.now() });
        if (state.velocityTracker.length > 6) state.velocityTracker.shift();
    };

    const handleTouchEnd = () => {
        const state = dragStateRef.current;
        if (!state.isMouseDown) return;
        if (state.isDragging) {
            state.suppressClickUntil = performance.now() + 300;
            startMomentum();
        }
        state.isMouseDown = false;
        state.isDragging = false;
        setIsTabStripDragging(false);
    };

    useEffect(() => {
        const el = tabsScrollRef.current;
        if (!el) return;
        const onWheel = (e) => {
            if (Math.abs(e.deltaX) < Math.abs(e.deltaY)) {
                e.preventDefault();
                el.scrollLeft += e.deltaY;
            }
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, []);

    useEffect(() => {
        const dragState = dragStateRef.current;
        return () => cancelAnimationFrame(dragState.momentumRaf);
    }, []);

    if (tableList.length === 0 && typeList.length === 0 && (!executionLog || executionLog.length === 0)) {
        return (
            <div className="tv">
                <div className="tv-empty">
                    <div className="tv-empty-visual">
                        <div className="tv-empty-grid">
                            <div />
                            <div />
                            <div />
                            <div />
                            <div />
                            <div />
                        </div>
                    </div>
                    <h3>No Tables Yet</h3>
                    <p>Write CREATE TABLE, INSERT, UPDATE, or DELETE on the left panel.</p>
                    <div className="tv-empty-code">
                        <code>CREATE TABLE</code>
                        <span className="tv-empty-arrow">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M5 12h14M12 5l7 7-7 7" />
                            </svg>
                        </span>
                        <code>INSERT INTO</code>
                        <span className="tv-empty-arrow">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M5 12h14M12 5l7 7-7 7" />
                            </svg>
                        </span>
                        <span className="tv-empty-result">View Data</span>
                    </div>
                </div>
            </div>
        );
    }

    const errorCount = executionLog.filter((l) => l.type === 'error').length;
    const warningCount = executionLog.filter((l) => l.type === 'warning').length;
    const successCount = executionLog.filter((l) => l.type === 'success').length;

    return (
        <div className="tv">
            {/* Tab Bar */}
            <div className="tv-tabs">
                <div className={`tv-tabs-scroll-wrap ${edgeFade.left ? 'tv-fade-left' : ''} ${edgeFade.right ? 'tv-fade-right' : ''}`}>
                    <div
                        ref={tabsScrollRef}
                        className={`tv-tabs-scroll ${isTabStripDragging ? 'tv-tabs-scroll-dragging' : ''}`}
                        onMouseDown={handleTabsMouseDown}
                        onClickCapture={handleTabsClickCapture}
                        onTouchStart={handleTouchStart}
                        onTouchMove={handleTouchMove}
                        onTouchEnd={handleTouchEnd}
                        onTouchCancel={handleTouchEnd}
                    >
                        {tableList.map((table, i) => (
                            <button
                                key={table.name}
                                className={`tv-tab ${i === validIdx && !showLog && !showTypes ? 'tv-tab-active' : ''}`}
                                title={table.name}
                                aria-label={`Open table ${table.name}`}
                                onClick={() => {
                                    setActiveTab(i);
                                    setShowLog(false);
                                    setShowTypes(false);
                                    scrollTabIntoView(i);
                                }}
                            >
                                <span className="tv-tab-dot" />
                                <span className="tv-tab-label" title={table.name}>
                                    {table.name}
                                </span>
                                {table.rows.length > 0 && <span className="tv-tab-count">{table.rows.length}</span>}
                            </button>
                        ))}
                    </div>
                </div>
                {typeList.length > 0 && (
                    <button
                        className={`tv-tab tv-tab-types ${showTypes ? 'tv-tab-active' : ''}`}
                        title="Types"
                        aria-label="Open types"
                        onClick={() => {
                            setShowTypes(!showTypes);
                            setShowLog(false);
                        }}
                    >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="7" height="7" />
                            <rect x="14" y="3" width="7" height="7" />
                            <rect x="3" y="14" width="7" height="7" />
                            <rect x="14" y="14" width="7" height="7" />
                        </svg>
                        <span className="tv-tab-label">Types</span>
                        <span className="tv-tab-count">{typeList.length}</span>
                    </button>
                )}
                <button
                    className={`tv-tab tv-tab-log ${showLog ? 'tv-tab-active' : ''} ${errorCount > 0 ? 'tv-tab-has-error' : ''} ${warningCount > 0 && errorCount === 0 ? 'tv-tab-has-warn' : ''}`}
                    title="Execution log"
                    aria-label="Open execution log"
                    onClick={() => {
                        setShowLog(!showLog);
                        setShowTypes(false);
                    }}
                >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                    </svg>
                    <span className="tv-tab-label">Log</span>
                    {executionLog.length > 0 && <span className={`tv-tab-count ${errorCount > 0 ? 'tv-count-error' : ''}`}>{executionLog.length}</span>}
                </button>
            </div>

            {/* Log View */}
            {showLog ? (
                <div className="tv-log">
                    {executionLog.length === 0 ? (
                        <div className="tv-log-empty">No statements executed.</div>
                    ) : (
                        <>
                            <div className="tv-log-summary">
                                <span className="tv-log-stat tv-log-stat-ok">{successCount} passed</span>
                                {warningCount > 0 && (
                                    <span className="tv-log-stat tv-log-stat-warn">
                                        {warningCount} warning{warningCount > 1 ? 's' : ''}
                                    </span>
                                )}
                                {errorCount > 0 && (
                                    <span className="tv-log-stat tv-log-stat-err">
                                        {errorCount} error{errorCount > 1 ? 's' : ''}
                                    </span>
                                )}
                            </div>
                            <div className="tv-log-list">
                                {executionLog.map((entry, i) => (
                                    <div key={i} className={`tv-log-row tv-log-${entry.type}`}>
                                        <span className="tv-log-indicator" />
                                        <span className="tv-log-msg">{entry.message}</span>
                                    </div>
                                ))}
                            </div>
                        </>
                    )}
                </div>
            ) : /* Types View */
            showTypes ? (
                <div className="tv-types">
                    {typeList.map((t) => (
                        <div key={t.name} className="tv-type-card">
                            <div className="tv-type-header">
                                <span className={`tv-type-badge tv-type-badge-${t.kind}`}>{t.kind}</span>
                                <span className="tv-type-name">{t.name}</span>
                            </div>
                            {t.kind === 'enum' && t.values && (
                                <div className="tv-type-values">
                                    {t.values.map((v, i) => (
                                        <span key={i} className="tv-enum-val">
                                            {v}
                                        </span>
                                    ))}
                                </div>
                            )}
                            {t.kind === 'composite' && t.fields && (
                                <div className="tv-erd-rows tv-type-fields">
                                    {t.fields.map((f, i) => (
                                        <div key={i} className="tv-erd-row">
                                            <div className="tv-erd-col-name">
                                                <span>{f.name}</span>
                                            </div>
                                            <div className="tv-erd-col-right">
                                                <span className="tv-erd-col-type">{f.type}</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            ) : /* Table Detail View */
            activeTable ? (
                <div className="tv-detail">
                    {/* Structure — ERD-style card */}
                    <div className="tv-section">
                        <button className="tv-section-head tv-section-head--structure" onClick={toggleSchema}>
                            <ChevronIcon expanded={schemaOpen} />
                            <span>{activeTable.name}</span>
                            <span className="tv-section-count">{activeTable.columns.length}</span>
                        </button>
                        <div className={`tv-section-body ${schemaOpen ? 'tv-section-open' : ''}`}>
                            <div className="tv-erd-rows">
                                {activeTable.columns.map((col) => {
                                    const indexTooltip = describeIndexesForColumn(col, activeTable.indexes);
                                    const showIndexIcon = col.indexed && !col.pk && !col.unique;
                                    const rowTitle = col.isEnum && col.enumValues ? `ENUM: ${col.enumValues.join(', ')}` : col.isComposite ? 'Composite type' : indexTooltip || undefined;
                                    return (
                                        <div key={col.name} className="tv-erd-row" title={rowTitle}>
                                            <div className="tv-erd-col-name">
                                                {col.pk && <KeyIcon />}
                                                {col.fk && <ChainIcon />}
                                                {col.isEnum && !col.pk && !col.fk && <EnumIcon />}
                                                {showIndexIcon && <IndexIcon />}
                                                <span>{col.name}</span>
                                            </div>
                                            <div className="tv-erd-col-right">
                                                <span className="tv-erd-col-type">{col.type}</span>
                                                {col.pk && <span className="tv-tag tv-tag-pk">PK</span>}
                                                {col.notNull && !col.pk && <span className="tv-tag tv-tag-nn">NN</span>}
                                                {col.fk && <span className="tv-tag tv-tag-fk">FK</span>}
                                                {col.unique && <span className="tv-tag tv-tag-uq">UQ</span>}
                                                {col.indexed && !col.pk && !col.unique && (
                                                    <span className="tv-tag tv-tag-idx" title={indexTooltip || 'Indexed'}>
                                                        IDX
                                                    </span>
                                                )}
                                                {col.defaultVal && (
                                                    <span className="tv-tag tv-tag-def" title={`DEFAULT ${col.defaultVal}`}>
                                                        DEF
                                                    </span>
                                                )}
                                                {col.check && (
                                                    <span className="tv-tag tv-tag-chk" title={`CHECK (${col.check})`}>
                                                        CHK
                                                    </span>
                                                )}
                                                {col.isEnum && (
                                                    <span className="tv-tag tv-tag-enum" title={col.enumValues ? col.enumValues.join(', ') : ''}>
                                                        ENUM
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>

                    {/* Data Section */}
                    <div className={`tv-section tv-section-grow ${dataOpen ? 'tv-section-expanded' : ''}`}>
                        <div className="tv-section-toolbar">
                            <button className="tv-section-head tv-section-head--data" onClick={toggleData}>
                                <ChevronIcon expanded={dataOpen} />
                                <span>Data</span>
                                <span className="tv-section-count">{activeTable.rows.length}</span>
                            </button>
                            <button
                                type="button"
                                className="tv-download-btn"
                                disabled={activeTable.rows.length === 0}
                                title={activeTable.rows.length === 0 ? 'Add rows before downloading this table' : `Download ${activeTable.name} as CSV`}
                                aria-label={`Download ${activeTable.name} table data as CSV`}
                                onClick={handleDownloadActiveTableCsv}
                            >
                                <DownloadIcon />
                                <span>CSV</span>
                            </button>
                        </div>
                        <div className={`tv-section-body tv-section-body-scroll ${dataOpen ? 'tv-section-open' : ''}`}>
                            {activeTable.rows.length > 0 ? (
                                <table className="tv-data">
                                    <thead>
                                        <tr>
                                            <th className="tv-data-num">#</th>
                                            {activeTable.columns.map((col) => (
                                                <th key={col.name}>
                                                    {col.name}
                                                    {col.pk && <span className="tv-th-pk">PK</span>}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {activeTable.rows.map((row, rowIdx) => (
                                            <tr key={rowIdx}>
                                                <td className="tv-data-num">{rowIdx + 1}</td>
                                                {activeTable.columns.map((col) => (
                                                    <td key={col.name}>
                                                        <CellValue value={row[col.name]} />
                                                    </td>
                                                ))}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            ) : (
                                <div className="tv-data-empty">
                                    <div>
                                        <div>
                                            No rows yet — use <code>INSERT INTO {activeTable.name}</code>
                                        </div>
                                        <div className="tv-data-empty-hint">or ask AI to generate sample data</div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
