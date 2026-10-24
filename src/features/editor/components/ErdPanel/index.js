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
    const [mountedViews, setMountedViews] = useState(() => ({
        data: isDataView,
        query: isQueryView,
    }));
    const [retainedDataContent, setRetainedDataContent] = useState(dataContent);
    const [showRenderProgress, setShowRenderProgress] = useState(false);
    const isRendering = erdRendering?.isRendering === true;
    // Fast paints need no flashing status. A slow fetch/layout gets compact
    // feedback until the renderer reports an actual, nonzero canvas frame.
    useEffect(() => {
        if (!isRendering) { setShowRenderProgress(false); return; }
        const timer = window.setTimeout(() => setShowRenderProgress(true), 150);
        return () => window.clearTimeout(timer);
    }, [isRendering]);

    // Mount each workbench lazily, then hide it instead of unmounting it. This
    // preserves table selection, native scroll positions, and editor view state
    // while the user moves between ERD, Data, and Query.
    useEffect(() => {
        if (!isDataView && !isQueryView) return;
        setMountedViews((current) => {
            if ((isDataView && current.data) || (isQueryView && current.query)) return current;
            return {
                ...current,
                data: current.data || isDataView,
                query: current.query || isQueryView,
            };
        });
    }, [isDataView, isQueryView]);

    // EditorPage intentionally stops materializing Data View while ERD alone is
    // active. Keep the last rendered child so that optimization does not tear
    // down the hidden TableViewer and its local interaction state.
    useEffect(() => {
        if (dataContent != null) {
            setRetainedDataContent(dataContent);
        }
    }, [dataContent]);

    // The canvas runtime should render its minimap only while the ERD surface is visible.
    useEffect(() => {
        erdRendering?.setMinimapVisible?.(isErdView && isMinimapOpen);
    }, [erdRendering, isErdView, isMinimapOpen]);

    return (
        <div className="erd-panel" style={splitter.getPanelStyle(false)}>
            <div id="erd-container" aria-busy={isRendering || undefined} style={!isErdView ? { position: 'absolute', visibility: 'hidden', pointerEvents: 'none' } : undefined}>
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
            {isErdView && (erdRendering?.renderError || isRendering && showRenderProgress) && (
                <div className="erd-render-status" role={erdRendering?.renderError ? 'alert' : 'status'}>
                    {erdRendering?.renderError ? <><span>Couldn’t draw the diagram.</span><button type="button" onClick={() => erdRendering.setFlag(value => value + 1)}>Retry</button></> : <><span className="erd-render-spinner" aria-hidden="true" /><span>Drawing diagram…</span></>}
                </div>
            )}

            {(mountedViews.data || isDataView) && (
                <div className="erd-data-view" hidden={!isDataView} aria-hidden={!isDataView}>
                    {dataContent ?? retainedDataContent}
                </div>
            )}
            {(mountedViews.query || isQueryView) && (
                <div className="erd-query-view" hidden={!isQueryView} aria-hidden={!isQueryView}>
                    {queryContent}
                </div>
            )}

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
