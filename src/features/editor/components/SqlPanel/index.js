import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SqlHeader from '../SqlHeader';
import FileNameInput from '../FileNameInput';
import ErrorDisplay from '../ErrorDisplay';
import MonacoEditorWrapper from '../MonacoEditorWrapper';
import ParseErrorsDisplay from '../ParseErrorsDisplay';
import StatusBar from '../StatusBar';
import ChatInput from '../ChatInput';
import SqlTabsBar from '../SqlTabsBar';
import SqlImportDialog from '../SqlImportDialog';
import { useConfirm } from '@/components/ConfirmDialog';
import { useNotifications } from '@/components/Notifications';
import { createAiTabWorkspace } from '@/features/editor/lib/aiTabProtocol';
import { getAiPreviewDiagnostics } from '@/features/editor/lib/aiPreviewDiagnostics';
import { getAiWorkingWorkspace } from '@/features/editor/lib/aiWorkingWorkspace';

import './index.css';

export default function SqlPanel({ splitter, erdData, aiDiff, sqlTabs, saveOrUpdate, isSaving, activeFileId, aiReviewViewStateCaptureRef, schemaQuality, sqlImportRequestVersion = 0 }) {
    const sqlPanelRef = useRef(null);
    const importDragDepthRef = useRef(0);
    const handledStartImportVersionRef = useRef(0);
    const [isChatCollapsed, setIsChatCollapsed] = useState(false);
    const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
    const [isImportDragging, setIsImportDragging] = useState(false);
    const [importFileRequest, setImportFileRequest] = useState(null);
    const { confirm } = useConfirm();
    const { notifySuccess, notifyWarning } = useNotifications();
    const isTabbedAiReview = erdData.showAiSuggestions && aiDiff?.reviewMode === 'tabs';
    const isDocumentAiReview = erdData.showAiSuggestions && aiDiff?.reviewMode === 'document';
    const isInvalidAiReview = erdData.showAiSuggestions && aiDiff?.reviewMode === 'invalid';
    const isPreviewAiReview = isTabbedAiReview || isDocumentAiReview;
    // AI mode freezes file/tab controls that would invalidate the review base.
    // Users can still inspect tabs and accept/reject review blocks.
    const isAiMode = isPreviewAiReview || erdData.currentlyProcessingAi;

    useEffect(() => {
        if (!sqlImportRequestVersion || isAiMode || handledStartImportVersionRef.current === sqlImportRequestVersion) return;
        handledStartImportVersionRef.current = sqlImportRequestVersion;
        setImportFileRequest({ id: `start-import-${sqlImportRequestVersion}`, files: [] });
        setIsImportDialogOpen(true);
    }, [isAiMode, sqlImportRequestVersion]);

    const openSqlImport = useCallback((files = []) => {
        setImportFileRequest({ id: `sql-import-request-${Date.now()}-${Math.random().toString(36).slice(2)}`, files: Array.from(files || []) });
        setIsImportDialogOpen(true);
    }, []);

    const handleImportFiles = useCallback(
        (files, report) => {
            const importedTabs = sqlTabs.importSqlFiles(files);
            if (importedTabs.length === 0) return;

            if (erdData.isNewFile && (!erdData.fileName || erdData.fileName === 'untitled')) {
                erdData.setFileName(importedTabs.length === 1 ? importedTabs[0].title : 'imported-schema');
            }
            setIsImportDialogOpen(false);
            const issueCount = (report?.errorCount || 0) + (report?.warningCount || 0);
            notifySuccess(
                `${importedTabs.length} SQL file${importedTabs.length === 1 ? '' : 's'} opened in ${importedTabs.length === 1 ? 'a new tab' : 'new tabs'}${report?.tableCount ? ` · ${report.tableCount} table${report.tableCount === 1 ? '' : 's'} found` : ''}.`,
                { title: 'Import complete' },
            );
            if (issueCount > 0) {
                notifyWarning(`${issueCount} parsing issue${issueCount === 1 ? '' : 's'} ${issueCount === 1 ? 'is' : 'are'} available in SQL diagnostics.`, { title: 'Review imported SQL' });
            }
        },
        [erdData, notifySuccess, notifyWarning, sqlTabs],
    );

    const panelHasDraggedFiles = useCallback((event) => Array.from(event?.dataTransfer?.types || []).includes('Files'), []);

    const handlePanelDragEnter = useCallback(
        (event) => {
            if (isAiMode || !panelHasDraggedFiles(event)) return;
            event.preventDefault();
            importDragDepthRef.current += 1;
            setIsImportDragging(true);
        },
        [isAiMode, panelHasDraggedFiles],
    );

    const handlePanelDragLeave = useCallback((event) => {
        if (!panelHasDraggedFiles(event)) return;
        importDragDepthRef.current = Math.max(0, importDragDepthRef.current - 1);
        if (importDragDepthRef.current === 0) setIsImportDragging(false);
    }, [panelHasDraggedFiles]);

    const handlePanelDragOver = useCallback(
        (event) => {
            if (isAiMode || !panelHasDraggedFiles(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
        },
        [isAiMode, panelHasDraggedFiles],
    );

    const handlePanelDrop = useCallback(
        (event) => {
            if (isAiMode || !panelHasDraggedFiles(event)) return;
            event.preventDefault();
            importDragDepthRef.current = 0;
            setIsImportDragging(false);
            openSqlImport(event.dataTransfer.files);
        },
        [isAiMode, openSqlImport, panelHasDraggedFiles],
    );
    const aiPreviewDiagnostics = useMemo(
        () =>
            isPreviewAiReview
                ? getAiPreviewDiagnostics({
                      tabs: isTabbedAiReview ? aiDiff?.previewTabs : null,
                      sql: aiDiff?.previewSql,
                      displayTabs: isTabbedAiReview ? aiDiff?.displayTabs : null,
                      displaySql: aiDiff?.displaySql,
                  })
                : null,
        [aiDiff?.displaySql, aiDiff?.displayTabs, aiDiff?.previewSql, aiDiff?.previewTabs, isPreviewAiReview, isTabbedAiReview],
    );
    // During review, parse errors come from the optimistic candidate but are
    // mapped onto the visible diff display. Outside review, diagnostics come
    // from the committed tab workspace.
    const editorParseErrors = isTabbedAiReview ? (aiPreviewDiagnostics?.all || []).filter((diagnostic) => !diagnostic.tabId || diagnostic.tabId === sqlTabs.activeTabId) : isDocumentAiReview ? aiPreviewDiagnostics?.all || [] : sqlTabs.getActiveDiagnostics(erdData.parseErrors);
    const displayParseErrors = isPreviewAiReview ? aiPreviewDiagnostics?.all || [] : sqlTabs.getAllDiagnostics(erdData.parseErrors);
    const activeTabIsInAiWorkspace = isTabbedAiReview ? !Array.isArray(aiDiff?.displayTabs) || aiDiff.displayTabs.some((tab) => tab.id === sqlTabs.activeTabId) : false;
    const activeAiDisplayData = isPreviewAiReview
        ? isTabbedAiReview
            ? activeTabIsInAiWorkspace
                ? aiDiff?.getDisplayData?.(sqlTabs.activeTabId)
                : { code: sqlTabs.activeSql, visibleBlocks: [] }
            : aiDiff?.getDisplayData?.()
        : null;
    const changedTabCount = Object.values(aiDiff?.tabChanges || {}).filter((change) => change.total > 0).length;
    const aiWorkingWorkspace = useMemo(
        () =>
            getAiWorkingWorkspace({
                tabs: sqlTabs.tabs,
                activeTabId: sqlTabs.activeTabId,
                showAiSuggestions: erdData.showAiSuggestions,
                reviewMode: aiDiff?.reviewMode,
                previewTabs: aiDiff?.previewTabs,
                previewSql: aiDiff?.previewSql,
                requestSource: erdData.aiReviewSource,
                isProcessingAi: erdData.currentlyProcessingAi,
            }),
        [aiDiff?.previewSql, aiDiff?.previewTabs, aiDiff?.reviewMode, erdData.aiReviewSource, erdData.currentlyProcessingAi, erdData.showAiSuggestions, sqlTabs.activeTabId, sqlTabs.tabs],
    );
    // This is the exact tab contract sent to AI. It may describe the pending
    // review candidate so follow-up prompts build on what the user currently
    // sees, even before all blocks are accepted.
    const aiTabWorkspace = useMemo(
        () => createAiTabWorkspace(aiWorkingWorkspace.tabs, aiWorkingWorkspace.activeTabId),
        [aiWorkingWorkspace.activeTabId, aiWorkingWorkspace.tabs],
    );
    const handleAcceptAiBlock = useCallback(
        (blockId) => {
            if (!erdData.currentlyProcessingAi) aiDiff?.handleAcceptBlock?.(blockId);
        },
        [aiDiff, erdData.currentlyProcessingAi],
    );
    const handleRejectAiBlock = useCallback(
        (blockId) => {
            if (!erdData.currentlyProcessingAi) aiDiff?.handleRejectBlock?.(blockId);
        },
        [aiDiff, erdData.currentlyProcessingAi],
    );
    const tabActions = aiDiff?.tabActions || [];
    const jumpToReviewTarget = sqlTabs.jumpToDiagnostic;
    const reviewCodeTargets = useMemo(() => {
        if (!isPreviewAiReview || typeof aiDiff?.getDisplayData !== 'function') return [];

        const displayTargetsForTab = (tabId) => {
            const displayData = aiDiff.getDisplayData(tabId);
            return (displayData?.visibleBlocks || [])
                .map((block) => ({
                    id: block.id,
                    tabId,
                    line: Math.min(block.displayAddRange?.startLine || Number.POSITIVE_INFINITY, block.displayDeleteRange?.startLine || Number.POSITIVE_INFINITY),
                }))
                .filter((target) => Number.isFinite(target.line))
                .sort((left, right) => left.line - right.line);
        };

        if (isDocumentAiReview) return displayTargetsForTab(null);

        const reviewTabs = Array.isArray(aiDiff?.displayTabs) ? aiDiff.displayTabs : sqlTabs.tabs;
        return reviewTabs.flatMap((tab) => displayTargetsForTab(tab.id));
    }, [aiDiff, isDocumentAiReview, isPreviewAiReview, sqlTabs.tabs]);
    const reviewTargetIdRef = useRef(null);
    const navigateReviewChange = useCallback(
        (direction) => {
            if (reviewCodeTargets.length === 0) return;

            const currentIndex = reviewCodeTargets.findIndex((target) => target.id === reviewTargetIdRef.current);
            const nextIndex = currentIndex < 0 ? (direction < 0 ? reviewCodeTargets.length - 1 : 0) : (currentIndex + direction + reviewCodeTargets.length) % reviewCodeTargets.length;
            const target = reviewCodeTargets[nextIndex];
            reviewTargetIdRef.current = target.id;

            // The tabs hook switches models before revealing the local line.
            // Keeping that sequence in one owner avoids duplicate tab commits.
            jumpToReviewTarget?.({ ...(target.tabId ? { tabId: target.tabId } : {}), line: target.line, column: 1 });
        },
        [jumpToReviewTarget, reviewCodeTargets],
    );

    useEffect(() => {
        if (!isPreviewAiReview || reviewCodeTargets.length === 0) return undefined;

        const handleReviewNavigationKey = (event) => {
            if (event.key !== 'F7' || event.altKey || event.ctrlKey || event.metaKey) return;
            event.preventDefault();
            navigateReviewChange(event.shiftKey ? -1 : 1);
        };

        window.addEventListener('keydown', handleReviewNavigationKey);
        return () => window.removeEventListener('keydown', handleReviewNavigationKey);
    }, [isPreviewAiReview, navigateReviewChange, reviewCodeTargets.length]);

    const reviewSummaryText =
        changedTabCount > 0
            ? `${aiDiff?.remainingBlocksCount || 0} change${aiDiff?.remainingBlocksCount === 1 ? '' : 's'} across ${changedTabCount} tab${changedTabCount === 1 ? '' : 's'}${
                  tabActions.length > 0 ? ` plus ${tabActions.length} tab action${tabActions.length === 1 ? '' : 's'}` : ''
              }`
            : `${aiDiff?.remainingBlocksCount || 0} workspace change${aiDiff?.remainingBlocksCount === 1 ? '' : 's'}`;

    const handleRemoveTab = useCallback(
        async (tabId) => {
            const tab = sqlTabs.tabs.find((item) => item.id === tabId);
            if (!tab) return;

            if (tab.sql?.trim()) {
                const confirmed = await confirm({
                    title: 'Close SQL tab?',
                    // Inactive SQL is saved-only, while active SQL participates
                    // in the combined ERD. The confirmation text names that
                    // difference because the deletion impact is different.
                    message: tab.isInactive ? `"${tab.title}" contains inactive SQL. Closing it will permanently remove that saved SQL.` : `"${tab.title}" contains SQL. Closing it will remove that SQL from the combined ERD.`,
                    confirmText: 'Close tab',
                    tone: 'danger',
                });
                if (!confirmed) return;
            }

            sqlTabs.removeTab(tabId);
        },
        [confirm, sqlTabs],
    );

    const handleCloseOtherTabs = useCallback(
        async (tabId) => {
            const tabsToClose = sqlTabs.tabs.filter((item) => item.id !== tabId);
            if (tabsToClose.length === 0) return;

            if (tabsToClose.some((tab) => tab.sql?.trim())) {
                const confirmed = await confirm({
                    title: 'Close other SQL tabs?',
                    message: 'One or more other tabs contain SQL. Closing them will remove active SQL from the ERD and permanently remove inactive SQL.',
                    confirmText: 'Close other tabs',
                    tone: 'danger',
                });
                if (!confirmed) return;
            }

            sqlTabs.closeOtherTabs(tabId);
        },
        [confirm, sqlTabs],
    );

    const registerAiReviewViewStateCapture = useCallback(
        (capture) => {
            if (aiReviewViewStateCaptureRef) aiReviewViewStateCaptureRef.current = capture;
        },
        [aiReviewViewStateCaptureRef],
    );

    return (
        <div
            className="sql-panel"
            ref={sqlPanelRef}
            style={splitter.getPanelStyle(true)}
            onDragEnter={handlePanelDragEnter}
            onDragLeave={handlePanelDragLeave}
            onDragOver={handlePanelDragOver}
            onDrop={handlePanelDrop}
        >
            {erdData.isLoading && (
                <div className="erd-sql-loading-overlay">
                    <div className="erd-sql-loading-spinner"></div>
                    <div className="erd-sql-loading-text">Loading SQL...</div>
                </div>
            )}

            <SqlHeader isOwner={erdData.isOwner} disabled={isAiMode} onImportSql={() => openSqlImport()} />

            {isImportDragging && (
                <div className="sql-import-panel-drop" aria-hidden="true">
                    <strong>Drop SQL files to import</strong>
                    <span>Each file will open in a new tab</span>
                </div>
            )}

            <SqlImportDialog
                isOpen={isImportDialogOpen}
                onClose={() => setIsImportDialogOpen(false)}
                onImport={handleImportFiles}
                fileRequest={importFileRequest}
            />

            <FileNameInput fileName={erdData.fileName} setFileName={erdData.setFileName} hasUnsavedChanges={erdData.hasUnsavedChanges} isSaving={isSaving} saveOrUpdate={saveOrUpdate} isNewFile={erdData.isNewFile} isOwner={erdData.isOwner} disabled={isAiMode} />

            <ErrorDisplay error={isPreviewAiReview ? '' : erdData.error} />

            <SqlTabsBar
                tabs={sqlTabs.tabs}
                activeTabId={sqlTabs.activeTabId}
                dirtyTabIds={sqlTabs.dirtyTabIds}
                onActivateTab={sqlTabs.activateTab}
                onAddTab={sqlTabs.addTab}
                onRemoveTab={handleRemoveTab}
                onDuplicateTab={sqlTabs.duplicateTab}
                onCloseOtherTabs={handleCloseOtherTabs}
                onMoveTab={sqlTabs.moveTab}
                onReorderTab={sqlTabs.reorderTab}
                onRenameTab={sqlTabs.renameTab}
                onToggleTabInactive={sqlTabs.toggleTabInactive}
                reviewMode={isTabbedAiReview}
                reviewTabChanges={aiDiff?.tabChanges}
                disabled={erdData.currentlyProcessingAi || isDocumentAiReview}
            />

            {isTabbedAiReview && aiDiff?.allBlocks?.length > 0 && (
                <div className="ai-tab-review-summary">
                    <div className="ai-tab-review-summary-copy" role="status">
                        <strong>AI review</strong>
                        <span>{reviewSummaryText}</span>
                    </div>
                    <div className="ai-tab-review-toolbar" aria-label="AI review controls">
                        <div className="ai-tab-review-navigation">
                            <button type="button" onClick={() => navigateReviewChange(-1)} disabled={reviewCodeTargets.length === 0} aria-label="Previous code change (Shift+F7)" title="Previous change (Shift+F7)">
                                ↑
                            </button>
                            <button type="button" onClick={() => navigateReviewChange(1)} disabled={reviewCodeTargets.length === 0} aria-label="Next code change (F7)" title="Next change (F7)">
                                ↓
                            </button>
                        </div>
                        <button type="button" className="ai-tab-review-bulk ai-tab-review-bulk--accept" onClick={aiDiff?.handleAcceptAllRemain} disabled={erdData.currentlyProcessingAi || aiDiff.remainingBlocksCount === 0} aria-label={`Accept remaining ${aiDiff.remainingBlocksCount} changes`}>
                            Accept all
                        </button>
                        <button type="button" className="ai-tab-review-bulk ai-tab-review-bulk--reject" onClick={aiDiff?.handleRejectAllRemain} disabled={erdData.currentlyProcessingAi || aiDiff.remainingBlocksCount === 0} aria-label={`Reject remaining ${aiDiff.remainingBlocksCount} changes`}>
                            Reject all
                        </button>
                    </div>
                </div>
            )}

            {isTabbedAiReview && tabActions.length > 0 && (
                <section className="ai-tab-review-actions" aria-label="AI tab changes">
                    {tabActions.map((action) => (
                        <article className={`ai-tab-review-action ai-tab-review-action--${action.status}`} key={action.id}>
                            <div className="ai-tab-review-action-copy">
                                <span>{action.label}</span>
                                {action.type === 'moveStatementsToNewTab' && action.statementCount > 0 && (
                                    <small>
                                        {action.statementCount} {action.statementType} statement{action.statementCount === 1 ? '' : 's'} will be removed from the source tab and placed in the new tab.
                                    </small>
                                )}
                                {(action.type === 'create' || action.type === 'moveStatementsToNewTab') && action.sql && <pre>{action.sql}</pre>}
                                {action.status === 'pending' && action.canAccept === false && <small>Accept the required earlier tab action first.</small>}
                            </div>
                            {action.status === 'pending' && (
                                <div className="ai-tab-review-action-controls">
                                    <button type="button" onClick={() => handleAcceptAiBlock(action.id)} aria-label={`Accept ${action.label}`} disabled={erdData.currentlyProcessingAi || action.canAccept === false}>
                                        Accept
                                    </button>
                                    <button type="button" onClick={() => handleRejectAiBlock(action.id)} aria-label={`Reject ${action.label}`} disabled={erdData.currentlyProcessingAi}>
                                        Reject
                                    </button>
                                </div>
                            )}
                        </article>
                    ))}
                </section>
            )}

            {isDocumentAiReview && (
                <div className="ai-tab-review-summary ai-tab-review-summary-warning" role="status">
                    <strong>AI review</strong>
                    <span>This edit crosses tab boundaries. Accepting it will replace the affected SQL with one tab.</span>
                </div>
            )}

            {isInvalidAiReview && (
                <div className="ai-tab-review-summary ai-tab-review-summary-warning" role="alert">
                    <span>{aiDiff?.reviewError || 'AI returned a tab change that could not be applied safely.'}</span>
                    <button type="button" onClick={aiDiff?.discardReview}>
                        Discard
                    </button>
                </div>
            )}

            <MonacoEditorWrapper
                sqlInput={sqlTabs.activeSql}
                setSqlInput={sqlTabs.setActiveTabSql}
                editorPath={`/sql-tabs/${activeFileId || 'new'}/${sqlTabs.activeTabId || 'default'}.sql`}
                modelReloadKey={sqlTabs.hydrationVersion}
                setIsEditorReady={erdData.setIsEditorReady}
                showAiSuggestions={isPreviewAiReview}
                currentlyProcessingAi={erdData.currentlyProcessingAi}
                displayData={activeAiDisplayData}
                handleAcceptBlock={handleAcceptAiBlock}
                handleRejectBlock={handleRejectAiBlock}
                parseErrors={editorParseErrors}
                onRegisterAiReviewViewStateCapture={registerAiReviewViewStateCapture}
            />

            <ParseErrorsDisplay
                parseErrors={displayParseErrors}
                setParseErrors={isPreviewAiReview ? undefined : erdData.setParseErrors}
                onDiagnosticJump={sqlTabs.jumpToDiagnostic}
                canDismiss={!isPreviewAiReview}
                onDismissDiagnostic={
                    isPreviewAiReview
                        ? undefined
                        : (errorToRemove) => {
                              erdData.setParseErrors((errors) => errors.filter((error) => (errorToRemove.id != null ? error.id !== errorToRemove.id : error !== errorToRemove)));
                          }
                }
            />

            <div className="chat-toggle-wrapper">
                <button type="button" className="chat-toggle-btn" onClick={() => setIsChatCollapsed(!isChatCollapsed)}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        {isChatCollapsed ? <polyline points="18 15 12 9 6 15" /> : <polyline points="6 9 12 15 18 9" />}
                    </svg>
                    {isChatCollapsed && <span>Chat</span>}
                </button>
            </div>

            {/* Send the working workspace SQL, not always committed SQL, so AI follow-ups see accepted + pending review changes. */}
            {/* Freeze the exact request workspace so the incoming AI response is reviewed against the tabs that were sent. */}
            <ChatInput
                activeFileId={activeFileId}
                sqlInput={aiWorkingWorkspace.sql}
                originalSqlInput={erdData.originalSqlInput}
                setOriginalSqlInput={erdData.setOriginalSqlInput}
                showAiSuggestions={erdData.showAiSuggestions}
                setShowAiSuggestions={erdData.setShowAiSuggestions}
                currentlyProcessingAi={erdData.currentlyProcessingAi}
                setCurrentlyProcessingAi={erdData.setCurrentlyProcessingAi}
                setAiSuggestedCode={erdData.setAiSuggestedCode}
                setAiTabChanges={erdData.setAiTabChanges}
                setAcceptedBlocks={erdData.setAcceptedBlocks}
                setRejectedBlocks={erdData.setRejectedBlocks}
                tabWorkspace={aiTabWorkspace}
                remainingBlocksCount={aiDiff?.remainingBlocksCount}
                handleAcceptAllRemain={aiDiff?.handleAcceptAllRemain}
                handleRejectAllRemain={aiDiff?.handleRejectAllRemain}
                onAiRequestStart={() =>
                    erdData.setAiReviewSource((previousReviewSource) => ({
                        // Match the exact active-only workspace sent to AI so
                        // a response can never target an inactive saved draft.
                        tabs: aiTabWorkspace.tabs.map((tab) => ({ ...tab })),
                        activeTabId: aiTabWorkspace.activeTabId,
                        // Local-only ids. They are not sent to the provider, but
                        // let accepted results preserve every excluded draft.
                        protectedInactiveTabIds: sqlTabs.tabs.filter((tab) => tab.isInactive).map((tab) => tab.id),
                        previousReviewSource: previousReviewSource || null,
                    }))
                }
                onAiRequestFailure={() => erdData.setAiReviewSource((requestSource) => requestSource?.previousReviewSource || null)}
                isCollapsed={isChatCollapsed}
            />

            <StatusBar schemaVersion={erdData.schemaVersion} schemaQuality={schemaQuality} />
        </div>
    );
}
