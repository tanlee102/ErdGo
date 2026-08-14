import { buildCombinedSql, createSingleSqlTab } from './sqlTabs';

function normalizeTabs(tabs) {
    return Array.isArray(tabs) && tabs.length > 0 ? tabs : createSingleSqlTab('');
}

/**
 * Pending AI changes form a working workspace for read-only consumers. The
 * candidate is never persisted until the user accepts the review.
 */
export function getAiWorkingWorkspace({ tabs, activeTabId, showAiSuggestions, reviewMode, previewTabs, previewSql, requestSource, isProcessingAi = false } = {}) {
    const savedTabs = normalizeTabs(tabs);
    const keepsRequestCandidate = Boolean(isProcessingAi && Array.isArray(requestSource?.tabs) && requestSource.tabs.length > 0);
    const candidateTabs = keepsRequestCandidate ? requestSource.tabs : previewTabs;
    const candidateActiveTabId = keepsRequestCandidate ? requestSource.activeTabId : activeTabId;
    const isPreview = Boolean((keepsRequestCandidate || showAiSuggestions) && (keepsRequestCandidate || reviewMode === 'tabs' || reviewMode === 'document') && Array.isArray(candidateTabs) && candidateTabs.length > 0);
    const workingTabs = isPreview ? candidateTabs : savedTabs;
    const workingActiveTabId = workingTabs.some((tab) => tab.id === candidateActiveTabId) ? candidateActiveTabId : workingTabs[0]?.id || null;

    return {
        tabs: workingTabs,
        activeTabId: workingActiveTabId,
        sql: isPreview && !keepsRequestCandidate && typeof previewSql === 'string' ? previewSql : buildCombinedSql(workingTabs).sql,
        isPreview,
    };
}
