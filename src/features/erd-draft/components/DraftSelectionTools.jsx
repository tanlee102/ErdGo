/** Discoverable fragment editing and shape search, including keyboard-free access. */
import { useState } from 'react';

export default function DraftSelectionTools({ nodes, selectionCount, canPaste, readOnly, blocked, onCopy, onPaste, onDuplicate, onDelete, onArrange, onLock, onFocus }) {
    const [query, setQuery] = useState('');
    const selected = nodes.filter(node => node.selected);
    const movableCount = selected.filter(node => !node.data?.positionLocked).length;
    const allLocked = selected.length > 0 && selected.every(node => node.data?.positionLocked);
    const results = query.trim() ? nodes.filter(node => `${node.data?.label || ''} ${node.data?.shape || ''} ${node.data?.description || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) : [];
    return (
        <section className="erd-draft-selection-tools" aria-label="Selection tools">
            <label htmlFor="erd-draft-search">Find a shape</label>
            <input id="erd-draft-search" type="search" placeholder="Name, type, or description" value={query} onChange={event => setQuery(event.target.value)} disabled={blocked} />
            {query.trim() && <div className="erd-draft-search-results">
                <small aria-live="polite">{results.length} {results.length === 1 ? 'match' : 'matches'}</small>
                {results.slice(0, 50).map(node => <button key={node.id} onClick={() => onFocus(node.id)}>{node.data?.label || 'Untitled'} <small>{node.data?.shape}</small></button>)}
                {results.length > 50 && <small>Showing the first 50. Refine your search.</small>}
            </div>}
            {!readOnly && <details>
                <summary>Selection actions ({selectionCount})</summary>
                <small aria-live="polite">{selectionCount} selected · Ctrl/Cmd-click to select more</small>
                <div className="erd-draft-selection-actions">
                    <button disabled={!selected.length || blocked} onClick={onCopy} title="Copy to Builder clipboard (Ctrl/Cmd+C)">Copy</button>
                    <button disabled={!canPaste || blocked} onClick={onPaste} title="Paste from Builder clipboard (Ctrl/Cmd+V)">Paste</button>
                    <button disabled={!selected.length || blocked} onClick={onDuplicate} title="Duplicate selection (Ctrl/Cmd+D)">Duplicate</button>
                    <button disabled={!selectionCount || blocked} onClick={onDelete}>Delete selected</button>
                    <button disabled={!selected.length || blocked} onClick={() => onLock(!allLocked)}>{allLocked ? 'Unlock positions' : 'Lock positions'}</button>
                </div>
                <fieldset disabled={blocked || movableCount < 2}>
                    <legend>Align unlocked shapes</legend>
                    <div className="erd-draft-selection-actions">
                        {['left', 'center', 'right', 'top', 'middle', 'bottom'].map(mode => <button key={mode} onClick={() => onArrange(mode)} aria-label={`Align ${mode}`}>{mode}</button>)}
                        {['horizontal', 'vertical'].map(mode => <button key={mode} disabled={movableCount < 3} onClick={() => onArrange(mode)} aria-label={`Distribute ${mode}`}>{mode === 'horizontal' ? 'Space across' : 'Space down'}</button>)}
                    </div>
                </fieldset>
            </details>}
        </section>
    );
}
