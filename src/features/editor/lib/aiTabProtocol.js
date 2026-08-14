const AI_TAB_WORKSPACE_VERSION = 1;

function normalizeText(value) {
    return typeof value === 'string' ? value : '';
}

/**
 * Build the stable workspace contract sent to tab-aware AI providers.
 * SQL remains tab-local so the model never has to infer ownership from a
 * concatenated document.
 */
export function createAiTabWorkspace(tabs, activeTabId) {
    // Inactive tabs are private saved drafts. They are intentionally absent
    // from AI context, so neither their SQL nor their tab IDs can be edited by
    // a response while they are excluded from parse/ERD/data execution.
    const safeTabs = (Array.isArray(tabs) ? tabs : []).filter((tab) => !tab?.isInactive);

    return {
        version: AI_TAB_WORKSPACE_VERSION,
        activeTabId: safeTabs.some((tab) => tab?.id === activeTabId) ? activeTabId : safeTabs[0]?.id || null,
        tabs: safeTabs.map((tab, index) => ({
            id: normalizeText(tab?.id),
            title: normalizeText(tab?.title) || `SQL ${index + 1}`,
            order: index,
            isInactive: Boolean(tab?.isInactive),
            sql: normalizeText(tab?.sql),
        })),
    };
}

export function formatAiTabWorkspace(workspace) {
    return JSON.stringify(workspace, null, 2);
}
