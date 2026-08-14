import { useContext, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RootLayoutContext } from '@/contexts/RootLayoutContext';
import { useConfirm } from '@/components/ConfirmDialog';
import { useNavigationGuard } from '@/components/NavigationGuard';

import HomeIcon from '@/icons/HomeIcon';
import ListIcon from '@/icons/ListIcon';
import AddIcon from '@/icons/AddIcon';
import ClearIcon from '@/icons/ClearIcon';
import FormatIcon from '@/icons/FormatIcon';
import ImportSqlIcon from '@/icons/ImportSqlIcon';
import ActionsMenuIcon from '@/icons/ActionsMenuIcon';

export default function SqlHeader({ disabled = false, onImportSql }) {
    const navigate = useNavigate();
    const { sqlInput, setSqlInput, setDisplayModalListFile } = useContext(RootLayoutContext);
    const { confirm } = useConfirm();
    const { runAfterNavigationConfirm } = useNavigationGuard();
    const [showActionsMenu, setShowActionsMenu] = useState(false);
    const actionsMenuRef = useRef(null);
    const actionsMenuTriggerRef = useRef(null);

    useEffect(() => {
        if (!showActionsMenu) return undefined;

        const focusTimer = window.setTimeout(() => {
            actionsMenuRef.current?.querySelector('[role="menuitem"]')?.focus();
        }, 0);

        const handlePointerDown = (event) => {
            if (actionsMenuRef.current?.contains(event.target) || actionsMenuTriggerRef.current?.contains(event.target)) return;
            setShowActionsMenu(false);
        };
        const handleKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            setShowActionsMenu(false);
            actionsMenuTriggerRef.current?.focus();
        };

        document.addEventListener('mousedown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            window.clearTimeout(focusTimer);
            document.removeEventListener('mousedown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [showActionsMenu]);

    useEffect(() => {
        if (disabled) setShowActionsMenu(false);
    }, [disabled]);

    const handleClearEditor = async () => {
        if (disabled) return;
        if (!sqlInput?.trim()) return;
        const confirmed = await confirm({
            title: 'Clear SQL editor?',
            message: 'This will remove all SQL in the editor. This cannot be undone.',
            confirmText: 'Clear editor',
            tone: 'danger',
        });
        if (confirmed) {
            setSqlInput('');
        }
    };

    const handleFormatCode = () => {
        if (disabled) return;
        if (typeof window !== 'undefined' && window.formatSqlCode) {
            window.formatSqlCode();
        }
    };

    const handleNewFile = () => {
        if (disabled) return;
        runAfterNavigationConfirm(() => navigate('/e/new', { replace: true }));
    };

    const handleHome = () => {
        if (disabled) return;
        runAfterNavigationConfirm(() => navigate('/'));
    };

    const runMenuAction = (action) => {
        setShowActionsMenu(false);
        if (typeof action === 'function') action();
    };

    return (
        <div className="panel-header">
                <div className="panel-header-left">
                    <button type="button" className="logo-homepage" title="ERD Go home" aria-label="ERD Go home" disabled={disabled} onClick={handleHome}>
                            <HomeIcon />
                    </button>
                    <button type="button" className="btn-list-sql" title="Local diagrams" aria-label="Open local diagrams" onClick={() => setDisplayModalListFile(true)}>
                            <ListIcon />
                    </button>
                </div>
                <div className="panel-actions-shell">
                    <div className="panel-actions panel-actions-wide">
                        <button className="action-btn" title="Import SQL files" aria-label="Import SQL files" disabled={disabled} onClick={onImportSql}>
                            <ImportSqlIcon />
                        </button>
                        <button className="action-btn" title="New SQL file" aria-label="New SQL file" disabled={disabled} onClick={handleNewFile}>
                            <AddIcon />
                        </button>
                        <button className="action-btn" title="Format SQL (Shift+Alt+F)" disabled={disabled} onClick={handleFormatCode}>
                            <FormatIcon />
                        </button>
                        <button className="action-btn" title="Clear SQL editor" aria-label="Clear SQL editor" disabled={disabled} onClick={handleClearEditor}>
                            <ClearIcon />
                        </button>
                    </div>

                    <div className="panel-actions-compact">
                        <div className="panel-actions-menu-wrap">
                            <button
                                ref={actionsMenuTriggerRef}
                                type="button"
                                className="action-btn panel-actions-menu-trigger"
                                title="More editor actions"
                                aria-label="More editor actions"
                                aria-haspopup="menu"
                                aria-expanded={showActionsMenu}
                                disabled={disabled}
                                onClick={() => setShowActionsMenu((value) => !value)}
                            >
                                <ActionsMenuIcon className="panel-actions-menu-icon" />
                            </button>

                            {showActionsMenu && (
                                <div ref={actionsMenuRef} className="panel-actions-menu" role="menu" aria-label="Editor actions">
                                    <button type="button" role="menuitem" title="Import SQL files" onClick={() => runMenuAction(onImportSql)}>
                                        <ImportSqlIcon />
                                        <span>Import SQL files</span>
                                    </button>
                                    <button type="button" role="menuitem" title="New SQL file" onClick={() => runMenuAction(handleNewFile)}>
                                        <AddIcon />
                                        <span>New SQL file</span>
                                    </button>
                                    <button type="button" role="menuitem" title="Format SQL (Shift+Alt+F)" onClick={() => runMenuAction(handleFormatCode)}>
                                        <FormatIcon />
                                        <span>Format SQL</span>
                                        <kbd>Shift Alt F</kbd>
                                    </button>
                                    <button type="button" role="menuitem" title="Clear SQL editor" onClick={() => runMenuAction(handleClearEditor)}>
                                        <ClearIcon />
                                        <span>Clear SQL editor</span>
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>

                </div>
            </div>
    );
}
