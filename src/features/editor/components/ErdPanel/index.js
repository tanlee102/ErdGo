/** Right-side workbench that switches between ERD, materialized Data, and Query views. */
import { useEffect, useState } from 'react';
import ErdControls from '../ErdControls';
import ErdTopControls from '../ErdTopControls';

import './index.css';

export default function ErdPanel({ splitter, erdRendering, toggleTheme, viewMode = 'erd', onViewModeChange, showTableOwnerLabels = false, onShowTableOwnerLabelsChange, dataContent, queryContent }) {
    const isDataView = viewMode === 'data';
    const isQueryView = viewMode === 'query';
    const isErdView = viewMode === 'erd';
    const [isMinimapOpen, setIsMinimapOpen] = useState(false);

    // The canvas runtime should render its minimap only while the ERD surface is visible.
    useEffect(() => {
        erdRendering?.setMinimapVisible?.(isErdView && isMinimapOpen);
    }, [erdRendering, isErdView, isMinimapOpen]);

    return (
        <div className="erd-panel" style={splitter.getPanelStyle(false)}>
            <div id="erd-container" style={!isErdView ? { position: 'absolute', visibility: 'hidden', pointerEvents: 'none' } : undefined}>
                <canvas id="erd-canvas"></canvas>
                <ErdControls erdRendering={erdRendering} showTableOwnerLabels={showTableOwnerLabels} onShowTableOwnerLabelsChange={onShowTableOwnerLabelsChange} />
                <aside id="erd-minimap" className={`erd-minimap ${isMinimapOpen && isErdView ? 'is-open' : ''}`} aria-hidden={!isMinimapOpen || !isErdView}>
                    <canvas
                        id="erd-minimap-canvas"
                        className="erd-minimap__canvas"
                        role="application"
                        tabIndex={isMinimapOpen && isErdView ? 0 : -1}
                        aria-label="ERD minimap. Click to move, drag the viewport to pan, use arrow keys to pan, or press Home to fit the diagram."
                    />
                </aside>
            </div>

            {isDataView && <div className="erd-data-view">{dataContent}</div>}
            {isQueryView && <div className="erd-query-view">{queryContent}</div>}

            <ErdTopControls
                erdRendering={erdRendering}
                toggleTheme={toggleTheme}
                viewMode={viewMode}
                onViewModeChange={onViewModeChange}
                isMinimapOpen={isMinimapOpen}
                onMinimapOpenChange={setIsMinimapOpen}
            />
        </div>
    );
}
