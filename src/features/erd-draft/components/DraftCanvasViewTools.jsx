/** Temporary views and badge settings, plus compact owner history controls. */
import { useEffect, useId, useRef, useState } from 'react';
import { Circle, Focus, Redo2, Settings2, Undo2, X } from 'lucide-react';

export default function DraftCanvasViewTools({ showAttributes, onShowAttributes, showAttributeCounts = false, onShowAttributeCounts, focusId, focusName, selectedNode, onFocus, blocked, hasAttributes, history }) {
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const settingsId = useId();
    const settingsRef = useRef(null);
    const settingsButtonRef = useRef(null);
    const countsRef = useRef(null);
    useEffect(() => {
        if (!isSettingsOpen) return undefined;
        countsRef.current?.focus();
        const closeOutside = event => {
            if (!settingsRef.current?.contains(event.target)) setIsSettingsOpen(false);
        };
        document.addEventListener('pointerdown', closeOutside);
        return () => document.removeEventListener('pointerdown', closeOutside);
    }, [isSettingsOpen]);
    return (
        <div className="erd-draft-view-tools" role="group" aria-label="Diagram view">
            <button type="button" aria-label="Show attributes" title={showAttributes ? 'Hide attributes' : 'Show attributes'} aria-pressed={showAttributes} disabled={blocked || !hasAttributes} onClick={() => onShowAttributes(!showAttributes)}><Circle size={12} /><span>Attributes</span></button>
            <button type="button" aria-label="Focus selection" title="Focus selected shape" disabled={blocked || !selectedNode} onClick={() => onFocus(selectedNode.id)}><Focus size={12} /><span>Focus</span></button>
            {focusId && <button type="button" aria-label="Clear diagram focus" title={focusName ? `Clear focus on ${focusName}` : 'Clear diagram focus'} disabled={blocked} onClick={() => onFocus(null)}><X size={12} /><span>{focusName || 'Clear focus'}</span></button>}
            {history && <>
                <button type="button" className="erd-draft-mobile-history" aria-label="Undo canvas change" title="Undo canvas change" disabled={blocked || !history.canUndo} onClick={history.onUndo}><Undo2 size={12} /></button>
                <button type="button" className="erd-draft-mobile-history" aria-label="Redo canvas change" title="Redo canvas change" disabled={blocked || !history.canRedo} onClick={history.onRedo}><Redo2 size={12} /></button>
            </>}
            <div ref={settingsRef} className="erd-draft-view-settings-anchor nodrag nopan nokey"
                onBlur={event => {
                    // Tapping label text briefly blurs its input before forwarding the click.
                    // Outside pointer input closes separately; retain that checkbox interaction.
                    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setIsSettingsOpen(false);
                }}
                onKeyDown={event => {
                    if (event.key !== 'Escape' || !isSettingsOpen) return;
                    event.preventDefault();
                    event.stopPropagation();
                    setIsSettingsOpen(false);
                    settingsButtonRef.current?.focus();
                }}>
                <button ref={settingsButtonRef} type="button" aria-label="Diagram view settings" title="Diagram view settings" aria-expanded={isSettingsOpen} aria-controls={settingsId} disabled={blocked} onClick={() => setIsSettingsOpen(open => !open)}><Settings2 size={12} /></button>
                {isSettingsOpen && <div id={settingsId} className="erd-draft-view-settings" role="group" aria-label="Diagram view settings">
                    <label><input ref={countsRef} type="checkbox" checked={showAttributeCounts} disabled={blocked} onChange={event => onShowAttributeCounts(event.target.checked)} /><span>Show attribute counts</span></label>
                </div>}
            </div>
        </div>
    );
}
