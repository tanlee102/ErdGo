import { createAiTabDiffReview } from './aiTabDiff';
import { getAiPreviewDiagnostics } from './aiPreviewDiagnostics';
import { createSingleSqlTab } from './sqlTabs';

function getSourceWorkspace(tabWorkspace, sqlInput) {
    const workspaceTabs = Array.isArray(tabWorkspace?.tabs) && tabWorkspace.tabs.length > 0 ? tabWorkspace.tabs : createSingleSqlTab(typeof sqlInput === 'string' ? sqlInput : '');
    const activeTabId = workspaceTabs.some((tab) => tab.id === tabWorkspace?.activeTabId) ? tabWorkspace.activeTabId : workspaceTabs[0]?.id || null;

    return {
        tabs: workspaceTabs.map((tab) => ({ ...tab })),
        activeTabId,
        hasTabWorkspace: Array.isArray(tabWorkspace?.tabs) && tabWorkspace.tabs.length > 0,
    };
}

function diagnosticKey(diagnostic) {
    return [diagnostic.tabId || '', diagnostic.kind || '', diagnostic.message || ''].join('|');
}

function getIntroducedParseError(sourceTabs, candidateTabs, activeTabId) {
    const baseline = getAiPreviewDiagnostics({ tabs: sourceTabs, activeTabId }).all.filter((diagnostic) => diagnostic.severity === 'error');
    const baselineKeys = new Set(baseline.map(diagnosticKey));
    // Existing user parse errors should not block unrelated AI edits. Only fail
    // preflight when the candidate introduces a new error signature.
    const introduced = getAiPreviewDiagnostics({ tabs: candidateTabs, activeTabId }).all.find((diagnostic) => diagnostic.severity === 'error' && !baselineKeys.has(diagnosticKey(diagnostic)));

    if (!introduced) return null;
    const tabLabel = introduced.tabId ? ` in tab "${candidateTabs.find((tab) => tab.id === introduced.tabId)?.title || introduced.tabId}"` : '';
    return `The proposed SQL introduces a new parse error${tabLabel}: ${introduced.message}`;
}

/**
 * Validate the exact candidate that would be shown in AI review. This keeps
 * unsafe model output out of the review UI without mutating user SQL.
 */
export function preflightAiResult({ result, tabWorkspace, sqlInput }) {
    if (!result || typeof result !== 'object') {
        return { ok: false, reason: 'The AI returned an empty response.' };
    }
    if (result.isConversational) return { ok: true, review: null, candidateTabs: null };
    if (result.success === false) {
        return { ok: false, reason: 'The AI response could not be applied to the current SQL.' };
    }
    if (Array.isArray(tabWorkspace?.tabs) && tabWorkspace.tabs.length === 0) {
        // An all-inactive workspace deliberately sends no SQL or tab ids to
        // the model. Refuse an edit rather than recreating a phantom active
        // tab from the placeholder SQL. Conversational answers remain allowed
        // by the early return above.
        return {
            ok: false,
            repairable: false,
            reason: 'All SQL tabs are inactive. Activate a tab before asking AI to edit SQL.',
        };
    }

    const { tabs, activeTabId, hasTabWorkspace } = getSourceWorkspace(tabWorkspace, sqlInput);
    const invalidAction = result.tabChanges?.actions?.find((action) => action.type === 'invalid');
    if (invalidAction) {
        return { ok: false, reason: invalidAction.reason || 'The AI returned a malformed tab change.' };
    }
    if (hasTabWorkspace && !result.tabChanges) {
        return { ok: false, reason: 'The AI returned a document-wide diff. This workspace requires one complete <tab_changes> response with tab-local operations.' };
    }
    if (!result.tabChanges && typeof result.suggestedCode !== 'string') {
        return { ok: false, reason: 'The AI did not return SQL changes to review.' };
    }

    const review = createAiTabDiffReview({
        tabs,
        preferredTabId: activeTabId,
        suggestedSql: result.suggestedCode,
        tabChanges: result.tabChanges,
    });
    if (review.mode === 'invalid') {
        return { ok: false, reason: review.reviewError || 'The AI response could not be safely applied to the current tab workspace.' };
    }

    // Validate the same optimistic candidate that parse/ERD/data will use while
    // the review is pending. If it is unsafe, ChatInput performs one repair
    // attempt before showing anything to the user.
    const candidateTabs = review.getPreviewTabs(new Set(), new Set());
    const parseError = getIntroducedParseError(tabs, candidateTabs, activeTabId);
    if (parseError) {
        return { ok: false, reason: parseError };
    }

    return { ok: true, review, candidateTabs };
}

export function buildAiRepairInstruction(reason) {
    const safeReason = typeof reason === 'string' ? reason.slice(0, 700) : 'The previous response was not safe to apply.';
    return `[AUTOMATIC VALIDATION FAILED]\n${safeReason}\n\nReturn one corrected response for the same request. Keep the requested scope, use the supplied tab workspace exactly, and return only a complete, closed <tab_changes> block plus a short explanation.`;
}
