/** Native top-layer dialog avoids clipping inside resized/overflow-hidden editor panes. */
import { useEffect, useId, useRef, useState } from 'react';
import { Download, FileImage, FileText, Image, X } from 'lucide-react';
import { downloadErdExport } from '../../lib/erdExport';
import './index.css';

const FORMATS = [
    { id: 'png', label: 'PNG', detail: 'Image', icon: Image },
    { id: 'svg', label: 'SVG', detail: 'Embedded image', icon: FileImage },
    { id: 'pdf', label: 'PDF', detail: 'Document', icon: FileText },
];
const PRESETS = [
    { id: 'hd', label: 'HD', minWidth: 1280, minHeight: 720, scale: 2 },
    { id: '2k', label: '2K', minWidth: 2560, minHeight: 1440, scale: 3 },
    { id: '4k', label: '4K', minWidth: 3840, minHeight: 2160, scale: 4 },
];

export default function ErdExportDialog({ erdRendering, onClose }) {
    const dialogRef = useRef(null);
    const triggerRef = useRef(null);
    const busyRef = useRef(false);
    const id = useId();
    const [format, setFormat] = useState('png');
    const [preset, setPreset] = useState(PRESETS[1]);
    const [scope, setScope] = useState('viewport');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        // StrictMode replays this effect while the native dialog is still open;
        // keep the original opener instead of capturing a dialog control then.
        triggerRef.current ||= document.activeElement;
        if (!dialogRef.current.open) dialogRef.current.showModal();
        dialogRef.current.querySelector('button:not(:disabled)')?.focus();
        return () => { if (triggerRef.current?.isConnected) triggerRef.current.focus?.({ preventScroll: true }); };
    }, []);

    const download = async (event) => {
        event.preventDefault();
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        setError('');
        try {
            // Yield a paint before the synchronous canvas work, so progress is visible.
            await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
            await downloadErdExport({ erdRendering, format, preset, scope });
            onClose();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Export failed. Please try again.');
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    };

    return (
        <dialog ref={dialogRef} className="erd-export-dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
            onKeyDown={(event) => {
                if (event.key !== 'Tab') return;
                // Explicit steps include buttons even when macOS browser Tab
                // preferences skip them; native arrow keys still own radio groups.
                const controls = [...event.currentTarget.querySelectorAll('button:not(:disabled), input:checked:not(:disabled), select:not(:disabled)')];
                const first = controls[0];
                event.preventDefault();
                if (!first) { event.currentTarget.focus(); return; }
                const current = controls.indexOf(document.activeElement);
                const origin = current < 0 ? (event.shiftKey ? 0 : -1) : current;
                controls[(origin + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
            }}
            onCancel={(event) => { event.preventDefault(); if (!busyRef.current) onClose(); }}
            onClick={(event) => {
                if (event.target !== event.currentTarget || busyRef.current) return;
                const rect = event.currentTarget.getBoundingClientRect();
                if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
            }}>
            <form onSubmit={download} aria-busy={busy}>
                <header className="erd-export-heading">
                    <span className="erd-export-heading-icon"><Download size={22} aria-hidden="true" /></span>
                    <div><h2 id={`${id}-title`}>Export diagram</h2><p id={`${id}-description`}>Choose a format and resolution.</p></div>
                    <button type="button" className="erd-export-close" aria-label="Close export dialog" disabled={busy} onClick={onClose}><X size={20} /></button>
                </header>
                <div className="erd-export-body">
                    <fieldset disabled={busy}>
                        <legend>File format</legend>
                        <div className="erd-export-options">
                            {FORMATS.map(({ id: value, label, detail, icon: Icon }) => (
                                <label className="erd-export-choice" key={value}>
                                    <input type="radio" name={`${id}-format`} value={value} checked={format === value} onChange={() => setFormat(value)} />
                                    <span><Icon size={21} aria-hidden="true" /><strong>{label}</strong><small>{detail}</small></span>
                                </label>
                            ))}
                        </div>
                    </fieldset>
                    <fieldset disabled={busy}>
                        <legend>Resolution <span>Target minimums</span></legend>
                        <div className="erd-export-options erd-export-resolutions">
                            {PRESETS.map((item) => (
                                <label className="erd-export-choice" key={item.id}>
                                    <input type="radio" name={`${id}-resolution`} checked={preset.id === item.id} onChange={() => setPreset(item)} />
                                    <span><strong>{item.label}</strong><small>{item.minWidth} × {item.minHeight}</small></span>
                                </label>
                            ))}
                        </div>
                    </fieldset>
                    <label className="erd-export-scope" htmlFor={`${id}-scope`}>Capture area</label>
                    <select id={`${id}-scope`} value={scope} disabled={busy} onChange={(event) => setScope(event.target.value)}>
                        <option value="viewport">Current view</option>
                        <option value="diagram">Entire diagram</option>
                    </select>
                    <p className="erd-export-note">{scope === 'diagram' ? `Includes all tables${erdRendering.tableGroups ? ', groups,' : ''} and connectors with padding.` : 'Exports the current zoom and visible area.'} Preserves proportions, up to 8192px per side.</p>
                    <p className="erd-export-format-note">{format === 'svg' ? 'SVG contains an embedded PNG, not editable vector shapes.' : format === 'pdf' ? 'One page with an embedded image. Text is not selectable.' : 'High-resolution PNG image.'}</p>
                    {error && <p className="erd-export-error" role="alert">{error}</p>}
                </div>
                <footer className="erd-export-footer">
                    <span aria-live="polite">{busy ? 'Preparing your download…' : `${preset.label} · ${format.toUpperCase()}`}</span>
                    <button type="submit" className="erd-export-download" disabled={busy}><Download size={18} aria-hidden="true" />{busy ? 'Exporting…' : `Download ${format.toUpperCase()}`}</button>
                </footer>
            </form>
        </dialog>
    );
}
