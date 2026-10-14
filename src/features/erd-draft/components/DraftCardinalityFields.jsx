/** Transactional cardinality input: incomplete/invalid edits never replace saved values. */
import { useId, useRef, useState } from 'react';
import { validateDraftCardinality } from '../lib/erdDraftSemantics';

export default function DraftCardinalityFields({ end, endpoint, data, mode, onChange, readOnly }) {
    const errorId = useId();
    const saved = {
        [`${end}Role`]: data[`${end}Role`] || '',
        [`${end}Min`]: data[`${end}Min`] ?? '0',
        [`${end}Max`]: data[`${end}Max`] ?? 'N',
    };
    const savedKey = JSON.stringify(saved);
    const [edit, setEdit] = useState({ base: savedKey, values: saved });
    const committedRef = useRef(null);
    // Undo, reload, and external edits replace drafts; ordinary keystrokes remain local.
    if (edit.base !== savedKey) setEdit({ base: savedKey, values: saved });
    const values = edit.base === savedKey ? edit.values : saved;
    const problem = validateDraftCardinality({ ...values, cardinalityMode: mode }, end);
    const dirty = JSON.stringify(values) !== savedKey;
    const commit = () => {
        const transaction = `${savedKey}:${JSON.stringify(values)}`;
        if (!readOnly && dirty && !problem && committedRef.current !== transaction) {
            committedRef.current = transaction;
            onChange(values);
        }
    };
    const cancel = (event) => {
        event.preventDefault();
        event.stopPropagation();
        setEdit({ base: savedKey, values: saved });
    };
    const field = (label, suffix, numeric = false) => {
        const key = `${end}${suffix}`;
        const inputProps = {
            value: values[key],
            onChange: (event) => {
                committedRef.current = null;
                setEdit({ base: savedKey, values: { ...values, [key]: event.target.value } });
            },
            onBlur: commit,
            onKeyDown: (event) => {
                if (event.key === 'Escape') cancel(event);
                if (event.key === 'Enter') {
                    event.preventDefault();
                    event.stopPropagation();
                    commit();
                    if (!problem) event.currentTarget.blur();
                }
            },
            'aria-invalid': suffix !== 'Role' && Boolean(problem),
            'aria-describedby': problem ? errorId : undefined,
        };
        return (
            <label className="erd-draft-field">
                <span>{label}</span>
                {mode === 'classic' && suffix === 'Max' ? (
                    <select {...inputProps} disabled={readOnly}>
                        {!['1', 'N', 'M', '*'].includes(values[key]) && <option value={values[key]}>{values[key] || 'Choose…'} (invalid)</option>}
                        <option value="1">1 · one</option>
                        <option value="N">N · many</option>
                        <option value="M">M · many</option>
                        <option value="*">* · many</option>
                    </select>
                ) : <input {...inputProps} inputMode={numeric ? 'numeric' : undefined} readOnly={readOnly} />}
            </label>
        );
    };
    return (
        <div className="erd-draft-cardinality-role">
            <div className="erd-draft-cardinality-heading"><span>{endpoint?.data?.label || (end === 'source' ? 'From' : 'To')}</span><small>{end} role</small></div>
            {field('Role name', 'Role')}
            {mode === 'classic' ? field('Maximum cardinality', 'Max') : (
                <div className="erd-draft-field-row">
                    {field('Minimum', 'Min', true)}
                    {field('Maximum', 'Max')}
                </div>
            )}
            {dirty && !problem && <p className="erd-draft-route-tip">Press Enter or leave the field to apply. Escape cancels.</p>}
            {problem && <p id={errorId} role="alert" className="erd-draft-field-error">{problem.message}{dirty ? ' Changes are not applied. Correct them or press Escape to cancel.' : ''}</p>}
        </div>
    );
}
