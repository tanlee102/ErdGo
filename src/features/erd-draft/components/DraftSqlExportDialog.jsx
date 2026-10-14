/** Reviewable conceptual-to-relational conversion and automatic SQL-editor handoff. */
import { useId, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, Code2, Database, KeyRound, Link2, X } from 'lucide-react';
import useModalFocus from '@/components/Modal/useModalFocus';
import { convertErdDraftToSql } from '../lib/erdDraftToSql';
import { ERD_DRAFT_SQL_DIALECTS, ERD_DRAFT_SQL_TYPES } from '../lib/erdDraftSqlDialect';
import { isDraftAttributeShape } from '../lib/erdDraftSemantics';
import './draft-sql-export.css';

export default function DraftSqlExportDialog({ graph, onClose, onOpenEditor }) {
    const id = useId();
    const dialogRef = useRef(null);
    const choicesRef = useRef(null);
    const issuesRef = useRef(null);
    const notesRef = useRef(null);
    const [options, setOptions] = useState({ dialect: 'postgres', missingKeys: 'generate', derivedAttributes: 'omit', relationshipTables: false, includeComments: true, decisions: {}, attributeTypes: {} });
    const [reviewedMapping, setReviewedMapping] = useState(null);
    const [preview, setPreview] = useState('mapping');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const busyRef = useRef(false);
    useModalFocus(dialogRef, true, () => { if (!busyRef.current) onClose(); });
    const result = useMemo(() => convertErdDraftToSql(graph, options), [graph, options]);
    const warnings = result.issues.filter(issue => issue.level !== 'error');
    const errors = result.issues.filter(issue => issue.level === 'error');
    // Review belongs to the relational result, not presentation settings such as
    // SQL comments. Incomplete mappings cannot be acknowledged as final schemas.
    const reviewKey = JSON.stringify({ dialect: result.dialect, tables: result.tables, issues: result.issues });
    const reviewed = result.canConvert && reviewedMapping === reviewKey;
    const pendingChoices = result.choices.filter(choice => !choice.resolved);
    const remaining = pendingChoices.length;
    const oneToOnePending = remaining > 0 && pendingChoices.every(choice => choice.key.startsWith('holder:'));
    // Acknowledging notes never supplies semantic choices. Keep the next required
    // action beside the disabled button, even when the review pane is scrolled.
    const footerHint = busy ? 'Opening your SQL document…' : errors.length
        ? `Resolve ${errors.length} blocking ${errors.length === 1 ? 'issue' : 'issues'} to continue.`
        : remaining ? `Complete ${remaining}${oneToOnePending ? ' one-to-one' : ''} mapping ${remaining === 1 ? 'choice' : 'choices'} to continue.`
            : warnings.length && !reviewed ? 'Review the conversion notes and confirm the checkbox to continue.'
                : 'Opens a new SQL document with your generated schema already loaded.';
    const reviewAction = busy ? null : errors.length ? 'Review blocking issues'
        : remaining ? 'Review mapping choices' : warnings.length && !reviewed ? 'Review conversion notes' : null;
    const reviewNextStep = () => {
        if (errors.length) issuesRef.current?.focus();
        else if (remaining) choicesRef.current?.querySelector('[aria-invalid="true"]')?.focus();
        else if (notesRef.current) { notesRef.current.open = true; notesRef.current.querySelector('summary')?.focus(); }
    };
    const attributes = graph.nodes.filter(node => isDraftAttributeShape(node.data?.shape) && node.data.shape !== 'compositeAttribute' && (options.derivedAttributes === 'store' || node.data.shape !== 'derivedAttribute'));
    const attributeOwners = new Map();
    for (const table of result.tables) for (const column of table.columns) if (column.sourceId) attributeOwners.set(column.sourceId, table.name);
    const setOption = (key, value) => {
        setOptions(current => ({ ...current, [key]: value }));
        setError('');
    };
    const openEditor = async () => {
        if (busyRef.current || !result.canConvert || (warnings.length && !reviewed)) return;
        busyRef.current = true;
        setBusy(true);
        try {
            await onOpenEditor({ sql: result.sql, dialect: result.dialect, name: graph.name });
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not open SQL to ERD. Please try again.');
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    };

    return (
        <div className="draft-sql-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
            <section ref={dialogRef} className="draft-sql-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} tabIndex={-1} aria-busy={busy}>
                <header className="draft-sql-heading">
                    <span className="draft-sql-heading-icon"><Database size={23} aria-hidden="true" /></span>
                    <div><h2 id={`${id}-title`}>Convert ERD to SQL</h2><p id={`${id}-description`}>Choose a database and review the table mapping.</p></div>
                    <button type="button" className="draft-sql-close" aria-label="Close SQL conversion" disabled={busy} onClick={onClose}><X size={20} /></button>
                </header>
                <div className="draft-sql-body">
                    <div className="draft-sql-settings">
                        <fieldset disabled={busy} className="draft-sql-dialects">
                            <legend>Database dialect</legend>
                            <div>{ERD_DRAFT_SQL_DIALECTS.map(dialect => (
                                <label key={dialect.id} className="draft-sql-dialect" title={dialect.detail}>
                                    <input type="radio" name={`${id}-dialect`} value={dialect.id} checked={options.dialect === dialect.id} onChange={() => setOption('dialect', dialect.id)} />
                                    <span><strong>{dialect.label}</strong></span>
                                    {options.dialect === dialect.id && <Check size={15} aria-hidden="true" />}
                                </label>
                            ))}</div>
                            <p className="draft-sql-help draft-sql-profile">{ERD_DRAFT_SQL_DIALECTS.find(dialect => dialect.id === options.dialect).detail}</p>
                        </fieldset>
                        <label className="draft-sql-field">Entities without a key
                            <select disabled={busy} value={options.missingKeys} onChange={event => setOption('missingKeys', event.target.value)}>
                                <option value="generate">Add an integer primary key</option><option value="require">Require a key in the diagram</option>
                            </select>
                        </label>
                        <label className="draft-sql-field">Derived attributes
                            <select disabled={busy} value={options.derivedAttributes} onChange={event => setOption('derivedAttributes', event.target.value)}>
                                <option value="omit">Document without storing</option><option value="store">Store as ordinary columns</option>
                            </select>
                        </label>
                        <label className="draft-sql-checkbox"><input type="checkbox" aria-describedby={`${id}-relationship-help`} disabled={busy} checked={options.relationshipTables} onChange={event => setOption('relationshipTables', event.target.checked)} />Prefer separate relationship tables</label>
                        <p id={`${id}-relationship-help`} className="draft-sql-help draft-sql-relationship-help">Optional. Leave off to use foreign keys where appropriate.</p>
                        <label className="draft-sql-checkbox"><input type="checkbox" disabled={busy} checked={options.includeComments} onChange={event => setOption('includeComments', event.target.checked)} />Include diagram notes and mapping comments</label>
                        <p className="draft-sql-help">Composite attributes become columns. Multivalued attributes get their own tables. Subtypes share their parent’s key.</p>
                        {attributes.length > 0 && <details className="draft-sql-types"><summary>Column types <span>{attributes.length} attributes · optional</span></summary>
                            <p className="draft-sql-help">Domains supply types when recognized. Missing domains use bounded text; choose a type here to override.</p>
                            {attributes.map(node => <label className="draft-sql-field" key={node.id}><span>{node.data.label || 'Untitled attribute'}<small>{attributeOwners.get(String(node.id)) || 'Unmapped attribute'} · {node.data.domain || 'No domain specified'}</small></span>
                                <select aria-label={`SQL type for ${node.data.label || node.id}`} disabled={busy} value={options.attributeTypes[node.id] || 'auto'} onChange={event => setOption('attributeTypes', { ...options.attributeTypes, [node.id]: event.target.value })}>{ERD_DRAFT_SQL_TYPES.map(type => <option key={type.id} value={type.id}>{type.label}</option>)}</select>
                            </label>)}
                        </details>}
                    </div>
                    <div className="draft-sql-review">
                        <div className="draft-sql-stats" aria-live="polite"><span><b>{result.tables.length}</b> tables</span><span><b>{result.tables.reduce((count, table) => count + table.foreignKeys.length, 0)}</b> foreign keys</span><span className={remaining || errors.length ? 'needs-review' : ''}>{errors.length ? `${errors.length} blocking issues` : remaining ? `${remaining} choices needed` : 'Mapping ready'}</span></div>
                        {result.choices.length > 0 && <section ref={choicesRef} className="draft-sql-decisions" aria-label="Mapping choices"><h3>{remaining ? 'Required mapping choices' : 'Mapping choices complete'}</h3><p>{remaining ? oneToOnePending ? 'Each one-to-one link can live in either table. Choose its table below, or choose a separate relationship table. Other settings are optional.' : 'Answer the highlighted choices to finish the mapping. Optional settings can stay unchanged.' : 'These choices apply to this conversion; your diagram stays unchanged.'}</p>{result.choices.map(choice => <label key={choice.key} className="draft-sql-field">{choice.title}
                            {choice.kind === 'text' ? <input required aria-invalid={!choice.resolved} disabled={busy} value={choice.value} onChange={event => setOption('decisions', { ...options.decisions, [choice.key]: event.target.value })} placeholder="For example, manager or employee" /> : <select required aria-invalid={!choice.resolved} disabled={busy} value={choice.value} onChange={event => setOption('decisions', { ...options.decisions, [choice.key]: event.target.value })}><option value="">Choose a mapping…</option>{choice.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}
                        </label>)}</section>}
                        {errors.length > 0 && <section ref={issuesRef} tabIndex={-1} className="draft-sql-errors" role="alert"><h3>Resolve these issues</h3><ul>{errors.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul></section>}
                        <div className="draft-sql-preview-toggle" aria-label="Conversion preview"><button type="button" aria-pressed={preview === 'mapping'} onClick={() => setPreview('mapping')}><Database size={15} />Table mapping</button><button type="button" aria-pressed={preview === 'sql'} onClick={() => setPreview('sql')}><Code2 size={15} />SQL preview</button></div>
                        {preview === 'mapping' ? <div className="draft-sql-table-list">{result.tables.map(table => <article key={table.name} className="draft-sql-table"><h3><Database size={14} />{table.name}<span>{table.kind === 'multivalued' ? 'Multiple values' : table.kind === 'relationship' ? 'Relationship' : 'Entity'}</span></h3>{result.mappings.filter(mapping => mapping.target === table.name).map(mapping => <p key={mapping.sourceId}>{mapping.label} → {mapping.detail}</p>)}<ul>{table.columns.map(column => {
                            const reference = table.foreignKeys.find(fk => fk.columns.includes(column.name));
                            return <li key={column.name} title={reference ? `References ${reference.target} (${reference.references.join(', ')})` : undefined}>{table.primaryKey.includes(column.name) ? <KeyRound size={12} aria-label="Primary key" /> : reference ? <Link2 size={12} className="draft-sql-foreign-key" aria-label="Foreign key" /> : <span className="draft-sql-column-marker" />}<code>{column.name}</code><small>{column.type}{column.nullable ? '' : ' · required'}{table.unique.some(columns => columns.length === 1 && columns[0] === column.name) ? ' · unique' : ''}</small></li>;
                        })}</ul>{(table.foreignKeys.length > 0 || table.unique.length > 0 || table.checks.length > 0) && <details className="draft-sql-constraints" aria-label={`Constraints for ${table.name}`}><summary>Constraints <span>{table.foreignKeys.length + table.unique.length + table.checks.length}</span></summary><ul>
                            {table.foreignKeys.map((fk, index) => <li key={`fk-${index}`}><Link2 size={12} aria-hidden="true" /><span><code>{fk.columns.join(', ')}</code> → <code>{fk.target} ({fk.references.join(', ')})</code><small>{fk.nullable ? 'Optional reference' : 'Required reference'}</small></span></li>)}
                            {table.unique.map((columns, index) => <li key={`uq-${index}`}><KeyRound size={12} aria-hidden="true" /><span>Unique: <code>{columns.join(', ')}</code><small>{columns.some(name => table.columns.find(column => column.name === name)?.nullable) ? 'Populated values must be unique; empty references may repeat.' : 'This complete combination must be unique.'}</small></span></li>)}
                            {table.checks.map((check, index) => <li key={`check-${index}`}><Check size={12} aria-hidden="true" /><span>{check.kind === 'boolean' ? 'Boolean values must be 0 or 1.' : check.kind === 'all-or-none' ? <>All filled or all empty: <code>{check.columns.join(', ')}</code></> : check.kind === 'exactly-one' ? 'Exactly one complete union member reference is required.' : 'Relationship attributes require a populated reference.'}</span></li>)}
                        </ul></details>}</article>)}</div> : <textarea className="draft-sql-code" aria-label="Generated SQL preview" readOnly value={result.sql || 'Complete the mapping choices and fix blocking issues to preview SQL.'} spellCheck={false} />}
                        {warnings.length > 0 && <details ref={notesRef} className="draft-sql-notes"><summary tabIndex={0}>Conversion notes <span>{warnings.length}</span></summary><ul>{warnings.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul></details>}
                        {warnings.length > 0 && <label className="draft-sql-checkbox draft-sql-acknowledge"><input type="checkbox" aria-describedby={!result.canConvert ? `${id}-status` : undefined} disabled={busy || !result.canConvert} checked={reviewed} onChange={event => setReviewedMapping(event.target.checked && result.canConvert ? reviewKey : null)} />I have reviewed the assumptions and constraints above.</label>}
                        {error && <p role="alert" className="draft-sql-errors">{error}</p>}
                    </div>
                </div>
                <footer className="draft-sql-footer"><div className="draft-sql-footer-status"><p id={`${id}-status`} role="status">{footerHint}</p>{reviewAction && <button type="button" className="draft-sql-review-link" onClick={reviewNextStep}>{reviewAction}<ArrowRight size={12} aria-hidden="true" /></button>}</div><div className="draft-sql-footer-actions"><button type="button" className="draft-sql-cancel" disabled={busy} onClick={onClose}>Cancel</button><button type="button" className="draft-sql-open" aria-describedby={`${id}-status`} disabled={busy || !result.canConvert || (warnings.length > 0 && !reviewed)} onClick={openEditor}>{busy ? 'Opening…' : 'Open in SQL to ERD'}<ArrowRight size={17} aria-hidden="true" /></button></div></footer>
            </section>
        </div>
    );
}
