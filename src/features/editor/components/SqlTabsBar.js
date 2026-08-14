import { useCallback, useEffect, useRef, useState } from 'react';
import AddIcon from '@/icons/AddIcon';

export default function SqlTabsBar({
    tabs,
    activeTabId,
    dirtyTabIds,
    onActivateTab,
    onAddTab,
    onRemoveTab,
    onDuplicateTab,
    onCloseOtherTabs,
    onMoveTab,
    onReorderTab,
    onRenameTab,
    onToggleTabInactive,
    reviewMode = false,
    reviewTabChanges = {},
    disabled = false,
}) {
    // During AI review the user can inspect changed tabs, but tab structure is
    // locked. Otherwise accepting/rejecting blocks could target a moving tab id.
    const canModifyTabs = !disabled && !reviewMode;
    const canRemove = tabs.length > 1 && canModifyTabs;
    const tabsListRef = useRef(null);
    const draggingTabIdRef = useRef(null);
    const suppressClickRef = useRef(false);
    const [editingTabId, setEditingTabId] = useState(null);
    const [editingTitle, setEditingTitle] = useState('');
    const [draggingTabId, setDraggingTabId] = useState(null);
    const [dragOverTabId, setDragOverTabId] = useState(null);
    const [contextMenu, setContextMenu] = useState(null);
    const [tabScrollState, setTabScrollState] = useState({
        hasOverflow: false,
        canScrollLeft: false,
        canScrollRight: false,
    });
    // Include title/activity/review count so scroll measurements rerun when a
    // tab changes size even if the selected tab id stays the same.
    const tabLayoutKey = tabs.map((tab) => `${tab.id}:${tab.title}:${tab.isInactive ? '1' : '0'}:${reviewTabChanges?.[tab.id]?.pending || 0}`).join('|');
    const contextTab = contextMenu ? tabs.find((tab) => tab.id === contextMenu.tabId) : null;
    const contextTabIndex = contextTab ? tabs.findIndex((tab) => tab.id === contextTab.id) : -1;
    const isTabDirty = (tabId) => (dirtyTabIds instanceof Set ? dirtyTabIds.has(tabId) : Array.isArray(dirtyTabIds) ? dirtyTabIds.includes(tabId) : false);

    const updateTabScrollState = useCallback(() => {
        const tabsList = tabsListRef.current;
        if (!tabsList) return;

        const maxScrollLeft = Math.max(0, tabsList.scrollWidth - tabsList.clientWidth);
        const nextState = {
            hasOverflow: maxScrollLeft > 1,
            canScrollLeft: tabsList.scrollLeft > 1,
            canScrollRight: tabsList.scrollLeft < maxScrollLeft - 1,
        };

        setTabScrollState((currentState) => {
            const hasChanged = Object.keys(nextState).some((key) => currentState[key] !== nextState[key]);
            return hasChanged ? nextState : currentState;
        });
    }, []);

    useEffect(() => {
        const scrollActiveTabIntoView = () => {
            const tabsList = tabsListRef.current;
            const activeTab = tabsList?.querySelector('.sql-tab-item.active');
            if (!tabsList || !activeTab) return;

            activeTab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });

            const listRect = tabsList.getBoundingClientRect();
            const activeRect = activeTab.getBoundingClientRect();
            if (activeRect.left < listRect.left) {
                tabsList.scrollLeft -= listRect.left - activeRect.left;
            } else if (activeRect.right > listRect.right) {
                tabsList.scrollLeft += activeRect.right - listRect.right;
            }

            updateTabScrollState();
        };

        const requestFrame =
            typeof window.requestAnimationFrame === 'function' ? (callback) => window.requestAnimationFrame(callback) : (callback) => window.setTimeout(callback, 0);
        const cancelFrame = typeof window.cancelAnimationFrame === 'function' ? (frameId) => window.cancelAnimationFrame(frameId) : (frameId) => window.clearTimeout(frameId);

        // Scroll once now, then across two frames and one settled timer. This
        // covers Monaco/toolbar layout changes that resize the tabs viewport
        // shortly after file load or review mode toggles.
        scrollActiveTabIntoView();
        let secondFrame = null;
        const firstFrame = requestFrame(() => {
            scrollActiveTabIntoView();
            secondFrame = requestFrame(scrollActiveTabIntoView);
        });
        const settledLayoutTimer = window.setTimeout(scrollActiveTabIntoView, 150);

        return () => {
            cancelFrame(firstFrame);
            if (secondFrame !== null) cancelFrame(secondFrame);
            window.clearTimeout(settledLayoutTimer);
        };
    }, [activeTabId, tabLayoutKey, tabScrollState.hasOverflow, updateTabScrollState]);

    useEffect(() => {
        const tabsList = tabsListRef.current;
        if (!tabsList) return undefined;

        const handleScrollStateChange = () => updateTabScrollState();
        const ResizeObserverConstructor = window.ResizeObserver;
        const resizeObserver = typeof ResizeObserverConstructor === 'function' ? new ResizeObserverConstructor(handleScrollStateChange) : null;

        handleScrollStateChange();
        tabsList.addEventListener('scroll', handleScrollStateChange, { passive: true });
        window.addEventListener('resize', handleScrollStateChange);
        resizeObserver?.observe(tabsList);

        return () => {
            tabsList.removeEventListener('scroll', handleScrollStateChange);
            window.removeEventListener('resize', handleScrollStateChange);
            resizeObserver?.disconnect();
        };
    }, [tabLayoutKey, updateTabScrollState]);

    useEffect(() => {
        if (!contextMenu) return undefined;

        const closeContextMenu = () => setContextMenu(null);
        const handleKeyDown = (event) => {
            if (event.key === 'Escape') {
                closeContextMenu();
            }
        };

        window.addEventListener('click', closeContextMenu);
        window.addEventListener('resize', closeContextMenu);
        window.addEventListener('keydown', handleKeyDown);

        return () => {
            window.removeEventListener('click', closeContextMenu);
            window.removeEventListener('resize', closeContextMenu);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [contextMenu]);

    const startRename = (tab) => {
        if (!canModifyTabs) return;
        setContextMenu(null);
        setEditingTabId(tab.id);
        setEditingTitle(tab.title);
    };

    const cancelRename = () => {
        setEditingTabId(null);
        setEditingTitle('');
    };

    const commitRename = () => {
        if (!editingTabId) return;

        const tab = tabs.find((item) => item.id === editingTabId);
        const nextTitle = editingTitle.trim();
        if (tab && nextTitle && nextTitle !== tab.title) {
            onRenameTab?.(editingTabId, nextTitle);
        }
        cancelRename();
    };

    const handleTabKeyDown = (event, tab) => {
        if (!canModifyTabs) return;

        if (event.key === 'F2') {
            event.preventDefault();
            startRename(tab);
            return;
        }

        if (!event.altKey) return;

        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            onMoveTab?.(tab.id, -1);
        } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            onMoveTab?.(tab.id, 1);
        }
    };

    const openContextMenu = (event, tab) => {
        event.preventDefault();
        event.stopPropagation();
        if (!canModifyTabs) return;

        // Match browser tab behavior: right-click also selects the tab whose
        // menu is being opened.
        onActivateTab(tab.id);
        setContextMenu({
            tabId: tab.id,
            x: event.clientX,
            y: event.clientY,
        });
    };

    const runContextAction = (callback) => {
        setContextMenu(null);
        callback?.();
    };

    const handleDragStart = (event, tabId) => {
        if (!canModifyTabs || editingTabId) {
            event.preventDefault();
            return;
        }

        onActivateTab(tabId);
        draggingTabIdRef.current = tabId;
        setDraggingTabId(tabId);
        event.dataTransfer?.setData('text/plain', tabId);
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
        }
    };

    const clearDragState = () => {
        draggingTabIdRef.current = null;
        setDraggingTabId(null);
        setDragOverTabId(null);
    };

    const handleDragOver = (event, tabId) => {
        const sourceTabId = draggingTabIdRef.current;
        if (!canModifyTabs || !sourceTabId || sourceTabId === tabId) return;

        event.preventDefault();
        setDragOverTabId(tabId);
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'move';
        }
    };

    const handleDrop = (event, tabId) => {
        event.preventDefault();
        if (!canModifyTabs) {
            clearDragState();
            return;
        }
        const sourceTabId = event.dataTransfer?.getData('text/plain') || draggingTabIdRef.current;
        if (sourceTabId && sourceTabId !== tabId) {
            onReorderTab?.(sourceTabId, tabId);
        }
        clearDragState();
    };

    const handleMouseDown = (event, tabId) => {
        if (disabled || editingTabId || event.button !== 0) return;
        if (event.target.closest('.sql-tab-close') || event.target.closest('.sql-tab-rename-input')) return;

        // Select on mouse-down, not click, so pressing and holding a tab before
        // dragging still focuses that tab immediately.
        onActivateTab(tabId);
        if (reviewMode) return;

        const startX = event.clientX;
        const startY = event.clientY;
        const dragState = {
            hasMoved: false,
            sourceTabId: tabId,
            targetTabId: null,
        };

        const getTabIdAtPoint = (clientX, clientY) => {
            if (typeof document.elementFromPoint !== 'function') return null;
            return document.elementFromPoint(clientX, clientY)?.closest('.sql-tab-item')?.dataset.tabId || null;
        };

        const handleMouseMove = (moveEvent) => {
            const deltaX = Math.abs(moveEvent.clientX - startX);
            const deltaY = Math.abs(moveEvent.clientY - startY);
            if (!dragState.hasMoved && deltaX + deltaY < 6) return;

            dragState.hasMoved = true;
            draggingTabIdRef.current = tabId;
            setDraggingTabId(tabId);

            const targetTabId = getTabIdAtPoint(moveEvent.clientX, moveEvent.clientY);
            dragState.targetTabId = targetTabId;
            setDragOverTabId(targetTabId && targetTabId !== tabId ? targetTabId : null);
        };

        const handleMouseUp = (upEvent) => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);

            const targetTabId = dragState.hasMoved ? dragState.targetTabId || getTabIdAtPoint(upEvent.clientX, upEvent.clientY) : null;
            if (dragState.hasMoved) {
                // The real action was reorder, not activation. Suppress the
                // synthetic click that follows mouseup so the dragged tab does
                // not get selected again by accident.
                suppressClickRef.current = true;
                window.setTimeout(() => {
                    suppressClickRef.current = false;
                }, 0);
            }
            if (dragState.hasMoved && targetTabId && targetTabId !== dragState.sourceTabId) {
                onReorderTab?.(dragState.sourceTabId, targetTabId);
            }
            clearDragState();
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    };

    const scrollTabs = (direction) => {
        const tabsList = tabsListRef.current;
        if (!tabsList) return;

        const amount = Math.max(120, Math.floor(tabsList.clientWidth * 0.72)) * direction;
        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

        if (typeof tabsList.scrollBy === 'function') {
            try {
                tabsList.scrollBy({ left: amount, behavior: reduceMotion ? 'auto' : 'smooth' });
            } catch {
                tabsList.scrollLeft += amount;
            }
        } else {
            tabsList.scrollLeft += amount;
        }

        window.setTimeout(updateTabScrollState, reduceMotion ? 0 : 180);
    };

    const tabsBarClassName = [
        'sql-tabs-bar',
        tabScrollState.hasOverflow ? 'has-overflow' : '',
        tabScrollState.canScrollLeft ? 'can-scroll-left' : '',
        tabScrollState.canScrollRight ? 'can-scroll-right' : '',
    ]
        .filter(Boolean)
        .join(' ');

    return (
        <div className={tabsBarClassName}>
            <button
                type="button"
                className="sql-tabs-scroll sql-tabs-scroll-left"
                aria-label="Scroll tabs left"
                title="Scroll tabs left"
                disabled={disabled || !tabScrollState.canScrollLeft}
                onClick={() => scrollTabs(-1)}
            >
                <span aria-hidden="true">&lsaquo;</span>
            </button>
            <div className="sql-tabs-viewport" role="tablist" aria-label="SQL tabs">
                <div className="sql-tabs-list" ref={tabsListRef}>
                    {tabs.map((tab) => {
                        const isActive = tab.id === activeTabId;
                        const isEditing = tab.id === editingTabId;
                        const isDirty = isTabDirty(tab.id);
                        const isInactive = Boolean(tab.isInactive);
                        const reviewChange = reviewTabChanges?.[tab.id];
                        const pendingReviewChanges = reviewChange?.pending || 0;
                        const totalReviewChanges = reviewChange?.total || 0;
                        const itemClassName = [
                            'sql-tab-item',
                            isActive ? 'active' : '',
                            isInactive ? 'inactive' : '',
                            isDirty ? 'dirty' : '',
                            draggingTabId === tab.id ? 'dragging' : '',
                            dragOverTabId === tab.id ? 'drag-over' : '',
                            reviewMode && totalReviewChanges > 0 ? 'ai-review-changed' : '',
                        ]
                            .filter(Boolean)
                            .join(' ');
                        return (
                            <div
                                key={tab.id}
                                className={itemClassName}
                                data-tab-id={tab.id}
                                role="presentation"
                                draggable={canModifyTabs && !isEditing}
                                aria-grabbed={draggingTabId === tab.id}
                                onContextMenu={(event) => openContextMenu(event, tab)}
                                onMouseDown={(event) => handleMouseDown(event, tab.id)}
                                onDragStart={(event) => handleDragStart(event, tab.id)}
                                onDragOver={(event) => handleDragOver(event, tab.id)}
                                onDragLeave={() => setDragOverTabId((currentId) => (currentId === tab.id ? null : currentId))}
                                onDrop={(event) => handleDrop(event, tab.id)}
                                onDragEnd={clearDragState}
                            >
                                {isEditing ? (
                                    <input
                                        className="sql-tab-rename-input"
                                        aria-label={`Rename ${tab.title}`}
                                        value={editingTitle}
                                        autoFocus
                                        onFocus={(event) => event.currentTarget.select()}
                                        onChange={(event) => setEditingTitle(event.target.value)}
                                        onBlur={commitRename}
                                        onClick={(event) => event.stopPropagation()}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter') {
                                                event.preventDefault();
                                                commitRename();
                                            } else if (event.key === 'Escape') {
                                                event.preventDefault();
                                                cancelRename();
                                            }
                                        }}
                                    />
                                ) : (
                                    <button
                                        type="button"
                                        className="sql-tab-button"
                                        role="tab"
                                        aria-selected={isActive}
                                        disabled={disabled}
                                        title={`${tab.title}${isInactive ? ' - inactive: saved only, excluded from parse, ERD, data, and AI' : ''}${isDirty ? ' - unsaved changes' : ''}${reviewMode && totalReviewChanges > 0 ? ` - ${pendingReviewChanges} pending AI change${pendingReviewChanges === 1 ? '' : 's'}` : ''}${canModifyTabs ? ' - double-click to rename, Alt+Left/Right to move' : ''}`}
                                        onClick={(event) => {
                                            if (suppressClickRef.current) {
                                                event.preventDefault();
                                                return;
                                            }
                                            onActivateTab(tab.id);
                                        }}
                                        onDoubleClick={() => canModifyTabs && startRename(tab)}
                                        onKeyDown={(event) => handleTabKeyDown(event, tab)}
                                    >
                                        {isDirty && !isInactive && <span className="sql-tab-dirty-dot" aria-hidden="true" />}
                                        <span className="sql-tab-title">{tab.title}</span>
                                        {reviewMode && totalReviewChanges > 0 && <span className="sql-tab-review-count" aria-hidden="true">{pendingReviewChanges}</span>}
                                    </button>
                                )}
                                <button type="button" className="sql-tab-close" aria-label={`Close ${tab.title}`} title={`Close ${tab.title}`} disabled={!canRemove} onClick={() => onRemoveTab(tab.id)}>
                                    ×
                                </button>
                            </div>
                        );
                    })}
                </div>
            </div>
            <button
                type="button"
                className="sql-tabs-scroll sql-tabs-scroll-right"
                aria-label="Scroll tabs right"
                title="Scroll tabs right"
                disabled={disabled || !tabScrollState.canScrollRight}
                onClick={() => scrollTabs(1)}
            >
                <span aria-hidden="true">&rsaquo;</span>
            </button>
            <button type="button" className="sql-tab-add" aria-label="Add SQL tab" title="Add SQL tab" disabled={!canModifyTabs} onClick={onAddTab}>
                <AddIcon />
            </button>
            {contextTab && (
                <div
                    className="sql-tab-context-menu"
                    role="menu"
                    aria-label={`${contextTab.title} tab menu`}
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                    onClick={(event) => event.stopPropagation()}
                    onContextMenu={(event) => event.preventDefault()}
                >
                    <button type="button" role="menuitem" onClick={() => runContextAction(() => startRename(contextTab))}>
                        Rename
                    </button>
                    <button type="button" role="menuitem" onClick={() => runContextAction(() => onDuplicateTab?.(contextTab.id))}>
                        Duplicate
                    </button>
                    <button type="button" role="menuitemcheckbox" aria-checked={Boolean(contextTab.isInactive)} onClick={() => runContextAction(() => onToggleTabInactive?.(contextTab.id))}>
                        {contextTab.isInactive ? 'Activate tab' : 'Make inactive'}
                    </button>
                    <button type="button" role="menuitem" disabled={contextTabIndex <= 0} onClick={() => runContextAction(() => onMoveTab?.(contextTab.id, -1))}>
                        Move left
                    </button>
                    <button type="button" role="menuitem" disabled={contextTabIndex < 0 || contextTabIndex >= tabs.length - 1} onClick={() => runContextAction(() => onMoveTab?.(contextTab.id, 1))}>
                        Move right
                    </button>
                    <div className="sql-tab-context-divider" role="separator" />
                    <button type="button" role="menuitem" disabled={!canRemove} onClick={() => runContextAction(() => onRemoveTab(contextTab.id))}>
                        Close
                    </button>
                    <button type="button" role="menuitem" disabled={tabs.length <= 1} onClick={() => runContextAction(() => onCloseOtherTabs?.(contextTab.id))}>
                        Close others
                    </button>
                </div>
            )}
        </div>
    );
}
