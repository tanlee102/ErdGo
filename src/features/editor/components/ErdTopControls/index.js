// Shared editor and Prisma toolbar; export UI and file creation have separate owners.
import { useState } from 'react';
import ErdExportDialog from '../ErdExportDialog';
import ExportIcon from '@/icons/ExportIcon';
import DarkIcon from '@/icons/DarkIcon';
import ConfigureIcon from '@/icons/ConfigureIcon';
import ErdControlHelp from '../ErdControlHelp';

export default function ErdTopControls({ erdRendering, toggleTheme, viewMode, onViewModeChange, isMinimapOpen = false, onMinimapOpenChange }) {
    const [isExportOpen, setIsExportOpen] = useState(false);
    const canToggleHeaderActions = typeof erdRendering?.setHeaderActionsAlwaysVisible === 'function';
    const headerActionsAlwaysVisible = erdRendering?.headerActionsAlwaysVisible !== false;

    return (
        <ErdControlHelp id="erd-top-controls" placement="bottom">
            {onViewModeChange && (
                <div className="erd-view-toggle">
                    <button className={`erd-view-toggle-btn ${viewMode === 'erd' ? 'active' : ''}`} type="button" data-erd-help="View tables and relationships" aria-pressed={viewMode === 'erd'} onClick={viewMode !== 'erd' ? () => onViewModeChange('erd') : undefined}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="18" height="18" rx="2" />
                            <line x1="3" y1="9" x2="21" y2="9" />
                            <line x1="9" y1="21" x2="9" y2="9" />
                        </svg>
                        ERD
                    </button>
                    <button className={`erd-view-toggle-btn ${viewMode === 'data' ? 'active' : ''}`} type="button" data-erd-help="Browse rows from your SQL" aria-pressed={viewMode === 'data'} onClick={viewMode !== 'data' ? () => onViewModeChange('data') : undefined}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <ellipse cx="12" cy="5" rx="9" ry="3" />
                            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                        </svg>
                        Data
                    </button>
                    <button className={`erd-view-toggle-btn ${viewMode === 'query' ? 'active' : ''}`} type="button" data-erd-help="Run SELECT queries on your data" aria-pressed={viewMode === 'query'} onClick={viewMode !== 'query' ? () => onViewModeChange('query') : undefined}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 6h16" />
                            <path d="M4 12h16" />
                            <path d="M4 18h10" />
                            <circle cx="18" cy="18" r="2" />
                        </svg>
                        Query
                    </button>
                </div>
            )}

            <button
                className="erd-top-btn"
                aria-label="Toggle Dark Mode"
                data-erd-help="Switch light or dark theme"
                onClick={() => {
                    toggleTheme();
                    if (viewMode === 'erd') erdRendering.setFlag((f) => f + 1);
                }}
            >
                <DarkIcon width="22px" height="22px" />
            </button>

            {canToggleHeaderActions && (
                <button
                    className={`erd-top-btn erd-top-btn--toggle ${headerActionsAlwaysVisible ? 'active' : ''}`}
                    type="button"
                    aria-label="Toggle table header tools visibility"
                    data-erd-help={headerActionsAlwaysVisible ? 'Show table tools only on hover' : 'Keep table tools always visible'}
                    aria-pressed={headerActionsAlwaysVisible}
                    style={viewMode !== 'erd' ? { display: 'none' } : undefined}
                    onClick={() => erdRendering.setHeaderActionsAlwaysVisible(!headerActionsAlwaysVisible)}
                >
                    <ConfigureIcon className="erd-header-tools-icon" width="22px" height="22px" />
                </button>
            )}

            {typeof onMinimapOpenChange === 'function' && (
                <button
                    className={`erd-top-btn erd-top-btn--toggle ${isMinimapOpen ? 'active' : ''}`}
                    type="button"
                    aria-label={isMinimapOpen ? 'Hide ERD minimap' : 'Show ERD minimap'}
                    data-erd-help={isMinimapOpen ? 'Hide the diagram overview' : 'Open an overview to navigate the diagram'}
                    aria-controls="erd-minimap"
                    aria-pressed={isMinimapOpen}
                    style={viewMode !== 'erd' ? { display: 'none' } : undefined}
                    onClick={() => onMinimapOpenChange(!isMinimapOpen)}
                >
                    <svg className="erd-minimap-toggle-icon" width="24" height="24" viewBox="3 0 26 28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <ellipse cx="16" cy="9.5" rx="8.25" ry="6.9" />
                        <line x1="16" y1="16.4" x2="16" y2="26.2" />
                    </svg>
                </button>
            )}

            <div className="erd-export-wrap" style={viewMode !== 'erd' ? { display: 'none' } : undefined}>
                <button className="erd-top-btn" id="export-btn" aria-label="Export ERD" data-erd-help="Export as PNG, SVG, or PDF" type="button" aria-haspopup="dialog" aria-expanded={isExportOpen && viewMode === 'erd'} onClick={(event) => {
                    // Firefox/WebKit on macOS need an explicit opener focus.
                    event.currentTarget.focus({ preventScroll: true });
                    setIsExportOpen((open) => !open);
                }}>
                    <ExportIcon width="22px" height="22px" />
                </button>
                {isExportOpen && viewMode === 'erd' && (
                    <ErdExportDialog erdRendering={erdRendering} onClose={() => setIsExportOpen(false)} />
                )}
            </div>
        </ErdControlHelp>
    );
}
