/** Local sample-data workbench. Configuration and previews are ephemeral; only an explicit insert writes SQL. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Database, Download, Plus, RefreshCw, X } from 'lucide-react';
import useModalFocus from '@/components/Modal/useModalFocus';
import { SAMPLE_DATA_LIMITS, SAMPLE_GENERATORS, SAMPLE_NAME_DICTIONARIES } from '@/features/data-view/lib/sampleDataGenerators';
import SampleDataWorker from '@/features/data-view/lib/sampleData.worker.js?worker';
import './index.css';

export default function SampleDataDialog({ sql, onClose, onInsert }) {
    const [dialect, setDialect] = useState('auto');
    const [model, setModel] = useState({ tables: [], errors: [], warnings: [], dialect: 'auto' });
    const [inspecting, setInspecting] = useState(true);
    const [settings, setSettings] = useState({});
    const [expandedTables, setExpandedTables] = useState(() => new Set());
    const [allCount, setAllCount] = useState('20');
    const [seed, setSeed] = useState('erdgo');
    const [locale, setLocale] = useState('en');
    const [nullPercent, setNullPercent] = useState('0');
    const [result, setResult] = useState(null);
    const [error, setError] = useState('');
    const [progress, setProgress] = useState(null);
    const [previewIndex, setPreviewIndex] = useState(0);
    const [copied, setCopied] = useState(false);
    const dialogRef = useRef(null); const previewRef = useRef(null); const workerRef = useRef(null); const copyTimer = useRef(null); const defaultCountRef = useRef('20');
    useModalFocus(dialogRef, true, onClose);
    const createWorker = useCallback(() => {
        const worker = new SampleDataWorker();
        workerRef.current = worker;
        worker.onmessage = ({ data }) => {
            if (workerRef.current !== worker) return;
            if (data.type === 'schema') {
                setModel(data.model);
                // SQL identifiers can also be inherited object keys, such as
                // constructor or __proto__. Only preserve our own settings.
                setSettings(current => Object.fromEntries(data.model.tables.map(table => [table.name, Object.hasOwn(current, table.name) ? current[table.name] : { enabled: true, count: defaultCountRef.current, columns: {} }])));
                setInspecting(false);
            } else if (data.type === 'progress') setProgress(data.progress);
            else if (data.type === 'result') { setResult(data.result); setPreviewIndex(0); setProgress(null); }
            else { worker.terminate(); workerRef.current = null; setError(data.message || 'Sample data could not be generated.'); setProgress(null); setInspecting(false); }
        };
        worker.onerror = () => {
            if (workerRef.current !== worker) return;
            worker.terminate(); workerRef.current = null;
            setError('The generator could not start. Reload the page and try again.'); setProgress(null); setInspecting(false);
        };
        return worker;
    }, []);
    useEffect(() => {
        setInspecting(true); setResult(null); setError(''); setProgress(null);
        setModel({ tables: [], errors: [], warnings: [], dialect });
        try { createWorker().postMessage({ type: 'inspect', sql, dialect }); }
        catch { workerRef.current?.terminate(); workerRef.current = null; setInspecting(false); setError('The generator could not start in this browser.'); }
        // Cancel inspection/generation on replacement or close. A completed
        // worker stays warm only while this dialog is actually open.
        return () => { workerRef.current?.terminate(); workerRef.current = null; };
    }, [sql, dialect, createWorker]);
    useEffect(() => () => { window.clearTimeout(copyTimer.current); }, []);
    useEffect(() => { if (result) previewRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [result]);

    const invalidate = () => { setResult(null); setError(''); setCopied(false); };
    const updateTable = (name, patch) => { invalidate(); setSettings(current => ({ ...current, [name]: { ...current[name], ...patch } })); };
    const updateColumn = (table, column, patch) => {
        invalidate();
        setSettings(current => ({ ...current, [table]: { ...current[table], columns: { ...current[table].columns, [column]: { ...current[table].columns[column], ...patch } } } }));
    };
    const total = model.tables.reduce((sum, table) => sum + (settings[table.name]?.enabled ? Number(settings[table.name].count) || 0 : 0), 0);
    const invalidCount = model.tables.some(table => settings[table.name]?.enabled && (!Number.isInteger(Number(settings[table.name].count)) || Number(settings[table.name].count) < 1 || Number(settings[table.name].count) > SAMPLE_DATA_LIMITS.rowsPerTable));
    const busy = progress !== null;
    const preview = result?.previews[previewIndex] || result?.previews[0];

    const generate = () => {
        invalidate(); setProgress({ completed: 0, total });
        try {
            const worker = workerRef.current || createWorker();
            worker.postMessage({ type: 'generate', sql, dialect, seed, locale, nullPercent: Number(nullPercent), tables: settings });
        } catch { workerRef.current?.terminate(); workerRef.current = null; setError('The generator could not start in this browser.'); setProgress(null); }
    };

    const download = () => {
        const url = URL.createObjectURL(new Blob([result.sql], { type: 'application/sql;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = 'erdgo-sample-data.sql';
        document.body.appendChild(link); link.click(); link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    return createPortal(
        <div className="sample-overlay" onMouseDown={event => event.target === event.currentTarget && onClose()}>
            <section className="sample-dialog" role="dialog" aria-modal="true" aria-labelledby="sample-title" aria-describedby="sample-description" ref={dialogRef} tabIndex={-1}>
                <header className="sample-header">
                    <span className="sample-heading-icon"><Database size={21} aria-hidden="true" /></span>
                    <div><h2 id="sample-title">Generate sample data</h2><p id="sample-description">Choose tables, row counts, and column values.</p></div>
                    <button className="sample-close" type="button" onClick={onClose} aria-label="Close sample data generator"><X size={18} aria-hidden="true" /></button>
                </header>
                <div className="sample-scroll">
                    {model.errors.length > 0 && <div className="sample-message sample-error" role="alert">{model.errors.slice(0, 3).join(' ')}<p>Fix these errors in your active SQL tabs, or make unrelated data tabs inactive, then reopen the generator.</p></div>}
                    <fieldset disabled={busy} className="sample-config">
                        <div className="sample-global">
                            <label>SQL dialect<select value={dialect} onChange={event => { invalidate(); setDialect(event.target.value); }}>
                                <option value="auto">Auto detect</option><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option><option value="mssql">SQL Server</option><option value="sqlite">SQLite</option>
                            </select></label>
                            <label>Repeatable seed<input data-modal-autofocus="true" value={seed} maxLength={80} onChange={event => { invalidate(); setSeed(event.target.value); }} /></label>
                            <label>Name dictionary<select value={locale} onChange={event => { invalidate(); setLocale(event.target.value); }}>{SAMPLE_NAME_DICTIONARIES.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
                            <label>Rows for all tables<input type="number" min="1" max={SAMPLE_DATA_LIMITS.rowsPerTable} value={allCount} onChange={event => { invalidate(); const count = event.target.value; setAllCount(count); defaultCountRef.current = count; setSettings(current => Object.fromEntries(Object.entries(current).map(([name, value]) => [name, { ...value, count }]))); }} /></label>
                            <label>Nullable values (%)<input type="number" min="0" max="100" value={nullPercent} onChange={event => { invalidate(); setNullPercent(event.target.value); }} /></label>
                            <div className="sample-total"><strong>{total.toLocaleString()}</strong><span>new rows · {model.dialect === 'auto' ? 'portable SQL' : model.dialect}</span></div>
                        </div>
                        <p className="sample-help">Up to 5,000 rows per table and 10,000 per batch. Relationships follow your foreign keys. No AI key needed.</p>
                        {inspecting && <p className="sample-help" role="status">Inspecting SQL schema…</p>}
                        <div className="sample-tables">
                            {model.tables.map(table => (
                                <details key={table.name} className="sample-table" open={expandedTables.has(table.name)} onToggle={event => {
                                    const open = event.currentTarget.open;
                                    setExpandedTables(current => {
                                        if (current.has(table.name) === open) return current;
                                        const next = new Set(current);
                                        if (open) next.add(table.name); else next.delete(table.name);
                                        return next;
                                    });
                                }}>
                                    <summary><span>{table.label}</span><span>{table.columns.length} columns · {table.existingRows} existing rows</span></summary>
                                    {expandedTables.has(table.name) && <>
                                    <div className="sample-table-options">
                                        <label className="sample-checkbox"><input type="checkbox" checked={settings[table.name]?.enabled || false} onChange={event => updateTable(table.name, { enabled: event.target.checked })} />Generate rows for {table.label}</label>
                                        <label>New rows<input aria-label={`Rows for ${table.label}`} type="number" min="1" max={SAMPLE_DATA_LIMITS.rowsPerTable} value={settings[table.name]?.count ?? 20} onChange={event => updateTable(table.name, { count: event.target.value })} /></label>
                                    </div>
                                    {table.columns.map(column => {
                                        const config = settings[table.name]?.columns[column.name] || {};
                                        const selectedGenerator = config.generator || column.suggested;
                                        const generator = selectedGenerator === 'auto' ? column.suggested : selectedGenerator;
                                        const managed = column.generatedExpr?.length || column.autoIncrement || column.fk;
                                        return <div className="sample-column" key={column.name}>
                                            <div className="sample-column-name"><strong>{column.name}</strong><small>{column.type}{column.pk ? ' · PK' : ''}{column.notNull ? ' · required' : ''}</small></div>
                                            {managed ? <span className="sample-managed">{column.fk ? `Linked to ${column.refTable}` : column.generatedExpr?.length ? 'Computed by database' : 'Auto increment'}</span> : <div className="sample-column-controls">
                                                <select aria-label={`Generator for ${table.label}.${column.name}`} value={selectedGenerator} onChange={event => updateColumn(table.name, column.name, { generator: event.target.value })}>
                                                    {SAMPLE_GENERATORS.filter(option => (option.id !== 'default' || column.defaultVal != null) && (option.id !== 'null' || !column.notNull && !column.pk)).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                                                </select>
                                                {generator === 'choice' && <textarea aria-label={`Values for ${table.label}.${column.name}`} placeholder="One value per line" rows={3} value={config.choices?.join('\n') ?? (column.enumValues || column.hints.choices || []).join('\n')} onChange={event => updateColumn(table.name, column.name, { choices: event.target.value.split('\n').filter(value => value.length > 0) })} />}
                                                {['integer', 'decimal'].includes(generator) && <div className="sample-range"><input aria-label={`Minimum for ${table.label}.${column.name}`} type="number" step="any" placeholder={String(column.hints.min ?? 0)} value={config.min ?? ''} onChange={event => updateColumn(table.name, column.name, { min: event.target.value })} /><span>to</span><input aria-label={`Maximum for ${table.label}.${column.name}`} type="number" step="any" placeholder={String(column.hints.max ?? 1000)} value={config.max ?? ''} onChange={event => updateColumn(table.name, column.name, { max: event.target.value })} /></div>}
                                                {['date', 'datetime', 'time'].includes(generator) && <div className="sample-range"><input aria-label={`Start date for ${table.label}.${column.name}`} type="date" value={config.startDate || '2024-01-01'} onChange={event => updateColumn(table.name, column.name, { startDate: event.target.value })} /><span>to</span><input aria-label={`End date for ${table.label}.${column.name}`} type="date" value={config.endDate || '2025-12-31'} onChange={event => updateColumn(table.name, column.name, { endDate: event.target.value })} /></div>}
                                            </div>}
                                        </div>;
                                    })}
                                    </>}
                                </details>
                            ))}
                        </div>
                    </fieldset>
                    {model.warnings.length > 0 && <details className="sample-message"><summary>Existing SQL has {model.warnings.length} preview warnings</summary><ul>{model.warnings.slice(0, 5).map(warning => <li key={warning}>{warning}</li>)}</ul></details>}
                    {error && <div className="sample-message sample-error" role="alert">{error}</div>}
                    {busy && <div className="sample-progress" role="status"><progress value={progress.completed} max={progress.total || 1} /><span>Validating {progress.completed.toLocaleString()} of {progress.total.toLocaleString()} rows{progress.table ? ` · ${progress.table}` : ''}…</span><button type="button" onClick={() => { workerRef.current?.terminate(); workerRef.current = null; setProgress(null); }}>Cancel generation</button></div>}
                    {result && <div className="sample-preview" ref={previewRef}>
                        <div className="sample-preview-heading"><h3 aria-live="polite">{result.totalRows.toLocaleString()} rows ready</h3><label>Preview table<select aria-label="Preview table" value={previewIndex} onChange={event => setPreviewIndex(Number(event.target.value))}>{result.previews.map((item, index) => <option key={item.name} value={index}>{item.name} · {item.count} rows</option>)}</select></label></div>
                        <p className="sample-help">First {preview.rows.length} rows shown. All rows passed the Data View constraint checks.</p>
                        <div className="sample-grid"><table aria-label="Generated sample rows"><thead><tr>{preview.columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{preview.rows.map((row, index) => <tr key={index}>{preview.columns.map(column => <td key={column}>{row[column] == null ? <em>NULL</em> : String(row[column])}</td>)}</tr>)}</tbody></table></div>
                        {result.notes.map(note => <p className="sample-help" key={note}>{note}</p>)}
                        <details className="sample-sql"><summary>SQL preview · {(result.sql.length / 1024).toFixed(1)} KB</summary><pre>{result.sql.slice(0, 16000)}{result.sql.length > 16000 ? '\n-- Preview truncated. Download or insert for the complete SQL.' : ''}</pre></details>
                    </div>}
                </div>
                <footer className="sample-footer">
                    <span>Existing rows are preserved.<br />Insert into a new Sample Data tab.</span>
                    <div>{result && <><button type="button" onClick={async () => { try { await navigator.clipboard.writeText(result.sql); setCopied(true); copyTimer.current = window.setTimeout(() => setCopied(false), 2000); } catch { setError('Clipboard unavailable. Download the SQL instead.'); } }}><Copy size={14} aria-hidden="true" />{copied ? 'Copied' : 'Copy SQL'}</button><button type="button" onClick={download}><Download size={14} aria-hidden="true" />Download SQL</button></>}
                        <button type="button" className={result ? '' : 'sample-primary'} onClick={generate} disabled={inspecting || busy || model.errors.length > 0 || invalidCount || total < 1 || total > SAMPLE_DATA_LIMITS.totalRows || Number(nullPercent) < 0 || Number(nullPercent) > 100}><RefreshCw size={14} aria-hidden="true" />{result ? 'Regenerate' : 'Generate preview'}</button>
                        {result && <button className="sample-primary" type="button" onClick={() => { const response = onInsert(result.sql); if (response?.ok === false) setError(response.message); else onClose(); }}><Plus size={15} aria-hidden="true" />Insert into SQL tab</button>}
                    </div>
                </footer>
            </section>
        </div>, document.body,
    );
}
