/** SQL canvas groups are saved display metadata; membership never changes SQL. */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight, Group, Plus, Search, Table2, Ungroup, X } from 'lucide-react';
import { getToolbarPopupPosition } from '@/lib/genErdScript';
import { normalizeTableGroups } from '@/lib/erd-renderer/tableGroups';
import './index.css';

const GROUP_COLORS = ['#3b82f6', '#8b5cf6', '#14b8a6', '#f59e0b', '#ef4444', '#ec4899'];

function newGroupId(groups) {
    let id;
    do { id = `group-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`; }
    while (groups.some((group) => group.id === id));
    return id;
}

export default function ErdTableGroupsControl({ controller }) {
    const [isOpen, setIsOpen] = useState(false);
    const [draft, setDraft] = useState(null);
    const [search, setSearch] = useState('');
    const [error, setError] = useState('');
    const buttonRef = useRef(null);
    const panelRef = useRef(null);
    const nameRef = useRef(null);
    const handledRequestRef = useRef(null);
    const panelId = useId();
    const nameId = useId();
    const groups = controller.groups;
    const disabled = controller.disabled === true;

    const close = useCallback((restoreFocus = true) => {
        setIsOpen(false);
        setDraft(null);
        setError('');
        if (restoreFocus) buttonRef.current?.focus();
    }, []);

    function editGroup(group) {
        setDraft({ ...group, tableNames: [...group.tableNames] });
        setSearch('');
        setError('');
    }

    useEffect(() => {
        if (disabled) close(false);
    }, [close, disabled]);

    useEffect(() => {
        const request = controller.editRequest;
        if (!request || handledRequestRef.current === request) return;
        handledRequestRef.current = request;
        if (disabled) return;
        const group = groups.find((item) => item.id === request.id);
        if (!group) return;
        setIsOpen(true);
        setDraft({ ...group, tableNames: [...group.tableNames] });
        setSearch('');
        setError('');
    }, [controller.editRequest, disabled, groups]);

    useLayoutEffect(() => {
        if (!isOpen) return undefined;
        const panel = panelRef.current;
        const toolbar = buttonRef.current?.closest('#erd-controls');
        const updatePosition = () => {
            const anchor = buttonRef.current?.getBoundingClientRect();
            if (!anchor || !panel) return;
            // Use the same side placement, 8px gap and arrow as the other
            // canvas popups. Offset sizes stay stable during the entry fade.
            const position = getToolbarPopupPosition({
                triggerRect: anchor,
                popupRect: { width: panel.offsetWidth, height: panel.offsetHeight },
                bounds: { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
            });
            panel.style.left = `${position.left}px`;
            panel.style.top = `${position.top}px`;
            panel.style.setProperty('--table-groups-arrow-top', `${position.arrowTop}px`);
            panel.dataset.placement = position.placement;
        };
        const outside = (event) => {
            if (!panel?.contains(event.target) && !buttonRef.current?.contains(event.target)) close(false);
        };
        const keyboard = (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            close();
        };
        updatePosition();
        (nameRef.current || panel?.querySelector('button'))?.focus();
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(updatePosition) : null;
        if (panel) observer?.observe(panel);
        window.addEventListener('resize', updatePosition);
        toolbar?.addEventListener('scroll', updatePosition, { passive: true });
        document.addEventListener('pointerdown', outside);
        document.addEventListener('focusin', outside);
        document.addEventListener('keydown', keyboard);
        return () => {
            observer?.disconnect();
            window.removeEventListener('resize', updatePosition);
            toolbar?.removeEventListener('scroll', updatePosition);
            document.removeEventListener('pointerdown', outside);
            document.removeEventListener('focusin', outside);
            document.removeEventListener('keydown', keyboard);
        };
    }, [close, isOpen]);

    const draftId = draft?.id;
    useEffect(() => {
        if (draftId) nameRef.current?.focus();
        else if (isOpen) panelRef.current?.querySelector('button')?.focus();
    }, [draftId, isOpen]);

    const names = [...new Set([...controller.tables.map((table) => table.name), ...(draft?.tableNames || [])])];
    const available = new Set(controller.tables.map((table) => table.name));
    const owners = new Map(groups.flatMap((group) => group.tableNames.map((name) => [name, group])));
    const visibleNames = names.filter((name) => name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    const editing = draft && groups.some((group) => group.id === draft.id);
    const moving = draft?.tableNames.some((name) => owners.has(name) && owners.get(name).id !== draft.id);

    function save(event) {
        event.preventDefault();
        if (disabled || !draft) return;
        if (!draft.name.trim()) { setError('Give this group a name.'); nameRef.current?.focus(); return; }
        if (draft.tableNames.length === 0) { setError('Choose at least one table.'); return; }
        const selected = new Set(draft.tableNames);
        const updated = groups.map((group) => group.id === draft.id ? draft : { ...group, tableNames: group.tableNames.filter((name) => !selected.has(name)) }).filter((group) => group.tableNames.length > 0);
        if (!editing) updated.push(draft);
        if (!controller.update(normalizeTableGroups(updated))) { setError('The canvas changed. Reopen Table groups and try again.'); return; }
        setDraft(null);
        setError('');
    }

    return (
        <>
            <button ref={buttonRef} id="table-groups-btn" className={`erd-btn erd-btn--toggle ${isOpen ? 'active' : ''}`} type="button" aria-label="Table groups" data-erd-help="Organize tables into named canvas groups" aria-haspopup="dialog" aria-expanded={isOpen} aria-controls={panelId} disabled={disabled} onClick={() => isOpen ? close() : setIsOpen(true)}>
                <Group size={20} strokeWidth={1.8} aria-hidden="true" />
            </button>
            {isOpen && createPortal(
                <section ref={panelRef} id={panelId} className="erd-table-groups" role="dialog" aria-modal="false" aria-label="Table groups" onPointerDown={(event) => event.stopPropagation()}>
                    <header className="erd-table-groups-heading">
                        <Group size={18} aria-hidden="true" />
                        <h2>{draft ? editing ? 'Edit group' : 'New group' : 'Table groups'}</h2>
                        {!draft && <span className="erd-table-groups-count">{groups.length}</span>}
                        <button type="button" aria-label="Close table groups" onClick={() => close()}><X size={14} aria-hidden="true" /></button>
                    </header>
                    {draft ? (
                        <form onSubmit={save}>
                            <div className="erd-table-groups-body">
                                <label className="erd-table-groups-field" htmlFor={nameId}>Group name<input ref={nameRef} id={nameId} maxLength={160} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} autoComplete="off" /></label>
                                <fieldset className="erd-table-groups-colors"><legend>Group color</legend>{GROUP_COLORS.map((color) => <button key={color} type="button" style={{ '--group-color': color }} aria-label={`Group color ${color}`} aria-pressed={draft.color === color} onClick={() => setDraft({ ...draft, color })}>{draft.color === color && <Check size={13} strokeWidth={2.5} aria-hidden="true" />}</button>)}<label className="erd-table-groups-custom-color" title="Custom group color"><span>Custom</span><input type="color" aria-label="Custom group color" value={draft.color || GROUP_COLORS[0]} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /></label></fieldset>
                                <div className="erd-table-groups-section-label"><span>Tables</span><span>{draft.tableNames.length} selected</span></div>
                                <label className="erd-table-groups-search"><Search size={13} aria-hidden="true" /><input type="search" aria-label="Find tables to group" placeholder="Find a table…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
                                <div className="erd-table-groups-members" role="group" aria-label="Group tables">{visibleNames.map((name) => {
                                    const owner = owners.get(name);
                                    return <label key={name}><input type="checkbox" aria-label={`Include ${name}`} checked={draft.tableNames.includes(name)} onChange={(event) => setDraft({ ...draft, tableNames: event.target.checked ? [...draft.tableNames, name] : draft.tableNames.filter((item) => item !== name) })} /><Table2 size={14} aria-hidden="true" /><span><strong>{name}</strong>{!available.has(name) ? <small>Not in current SQL · retained in this group</small> : owner && owner.id !== draft.id ? <small>Move from {owner.name}</small> : null}</span></label>;
                                })}{visibleNames.length === 0 && <p className="erd-table-groups-empty">No matching tables.</p>}</div>
                                {moving && <p className="erd-table-groups-hint">Selected tables move out of their current groups. Groups left empty are removed.</p>}
                                {error && <p className="erd-table-groups-error" role="alert">{error}</p>}
                            </div>
                            <footer>{editing && <button className="erd-table-groups-ungroup" type="button" onClick={() => { if (controller.update(groups.filter((group) => group.id !== draft.id))) { setDraft(null); setError(''); } else setError('The canvas changed. Reopen Table groups and try again.'); }}><Ungroup size={13} aria-hidden="true" />Ungroup tables</button>}<button className="erd-table-groups-cancel" type="button" onClick={() => { setDraft(null); setError(''); }}>Cancel</button><button className="erd-table-groups-save" type="submit">{editing ? <Check size={13} aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />}{editing ? 'Save group' : 'Create group'}</button></footer>
                        </form>
                    ) : (
                        <><div className="erd-table-groups-body erd-table-groups-list">{groups.length ? groups.map((group) => <button key={group.id} type="button" onClick={() => editGroup(group)}><span className="erd-table-groups-list-icon" style={{ '--group-color': group.color || GROUP_COLORS[0] }}><Group size={17} aria-hidden="true" /></span><span className="erd-table-groups-list-copy"><strong>{group.name}</strong><small>{group.tableNames.length} {group.tableNames.length === 1 ? 'table' : 'tables'}</small></span><ChevronRight size={14} className="erd-table-groups-chevron" aria-hidden="true" /></button>) : <div className="erd-table-groups-empty"><Group size={26} strokeWidth={1.5} aria-hidden="true" /><strong>Keep related tables together</strong><p>Create a group, then drag its canvas header to move the tables together.</p></div>}</div><footer><span>{groups.length}/50 groups</span><button className="erd-table-groups-save" type="button" disabled={groups.length >= 50 || controller.tables.length === 0} onClick={() => editGroup({ id: newGroupId(groups), name: '', color: GROUP_COLORS[groups.length % GROUP_COLORS.length], tableNames: available.has(controller.selectedTableName) ? [controller.selectedTableName] : [] })}><Plus size={14} aria-hidden="true" />New group</button></footer></>
                    )}
                </section>, document.body,
            )}
        </>
    );
}
