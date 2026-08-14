import { DiffDisplayer, DiffManager } from './diffAlgorithm';
import { applyDiffs } from './diffParser';
import { buildCombinedSql, createSqlTab, createSingleSqlTab, reconcileSqlTabsFromCombinedSql } from './sqlTabs';
import { extractStatementsByType, isMovableStatementType, normalizeMovableStatementType } from './sqlStatementActions';

const TAB_ACTION_PREFIX = 'tab-action:';

// AI tab reviews are plans, not mutations. This module turns provider output
// into preview tabs plus accept/reject blocks; the live workspace changes only
// when the hook asks the review to apply selected blocks.
function normalizeTabs(tabs) {
    return Array.isArray(tabs) && tabs.length > 0 ? tabs : createSingleSqlTab('');
}

function getLineOwner(ranges, lineNumber) {
    if (!Number.isInteger(lineNumber) || lineNumber < 1) return null;
    return ranges.find((range) => !range.isInactive && range.lineCount > 0 && lineNumber >= range.startLine && lineNumber <= range.endLine)?.id || null;
}

function findAdjacentOwner(diffLines, startIndex, endIndex, ranges, fallbackTabId) {
    for (let index = startIndex - 1; index >= 0; index -= 1) {
        const owner = getLineOwner(ranges, diffLines[index].originalLine);
        if (owner) return owner;
    }

    for (let index = endIndex + 1; index < diffLines.length; index += 1) {
        const owner = getLineOwner(ranges, diffLines[index].originalLine);
        if (owner) return owner;
    }

    return fallbackTabId || null;
}

// Legacy providers return a whole-document diff. Keep this conservative
// fallback for backward compatibility, but tab-aware providers never use it.
function createSuggestedTabsFromWholeDocumentDiff(tabs, preferredTabId, suggestedSql) {
    const originalTabs = normalizeTabs(tabs);
    const previous = buildCombinedSql(originalTabs);
    const diffLines = DiffDisplayer.createGitHubStyleDiff(previous.sql, suggestedSql);
    const activeTabs = originalTabs.filter((tab) => !tab.isInactive);
    const fallbackTabId = activeTabs.some((tab) => tab.id === preferredTabId) ? preferredTabId : activeTabs[activeTabs.length - 1]?.id || null;
    const ownerByDiffLine = new Map();

    for (let index = 0; index < diffLines.length; index += 1) {
        if (diffLines[index].type === 'equal') continue;

        const startIndex = index;
        const ownerIds = new Set();
        while (index < diffLines.length && diffLines[index].type !== 'equal') {
            const owner = getLineOwner(previous.ranges, diffLines[index].originalLine);
            if (owner) ownerIds.add(owner);
            index += 1;
        }

        const endIndex = index - 1;
        const owner = ownerIds.size === 1 ? [...ownerIds][0] : ownerIds.size === 0 ? findAdjacentOwner(diffLines, startIndex, endIndex, previous.ranges, fallbackTabId) : null;
        if (!owner) return null;

        for (let changedIndex = startIndex; changedIndex <= endIndex; changedIndex += 1) {
            ownerByDiffLine.set(changedIndex, owner);
        }
    }

    const linesByTabId = new Map(activeTabs.map((tab) => [tab.id, []]));
    diffLines.forEach((line, index) => {
        if (line.type === 'delete') return;

        const owner = line.type === 'insert' ? ownerByDiffLine.get(index) : getLineOwner(previous.ranges, line.originalLine);
        if (owner) {
            linesByTabId.get(owner)?.push(line.content);
        }
    });

    const suggestedTabs = originalTabs.map((tab) => (tab.isInactive ? tab : { ...tab, sql: (linesByTabId.get(tab.id) || []).join('\n') }));
    return buildCombinedSql(suggestedTabs).sql === suggestedSql ? suggestedTabs : null;
}

function toLocalBlockSet(blockIds, tabId) {
    const prefix = `${tabId}:`;
    return new Set([...blockIds].filter((blockId) => blockId.startsWith(prefix)).map((blockId) => blockId.slice(prefix.length)));
}

function normalizeTabTitle(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeTabTitleKey(value) {
    return normalizeTabTitle(value).toLowerCase();
}

function resolveTabTitleReference(tabs, title, label) {
    const safeTitle = normalizeTabTitle(title);
    if (!safeTitle) return null;

    const exactMatches = tabs.filter((tab) => normalizeTabTitle(tab.title) === safeTitle);
    if (exactMatches.length === 1) return { id: exactMatches[0].id };
    if (exactMatches.length > 1) {
        return { error: `The AI response referenced the duplicated ${label} tab title "${safeTitle}".` };
    }

    const titleKey = normalizeTabTitleKey(safeTitle);
    const caseInsensitiveMatches = tabs.filter((tab) => normalizeTabTitleKey(tab.title) === titleKey);
    if (caseInsensitiveMatches.length === 1) return { id: caseInsensitiveMatches[0].id };
    if (caseInsensitiveMatches.length > 1) {
        return { error: `The AI response referenced the duplicated ${label} tab title "${safeTitle}".` };
    }

    return null;
}

function resolveTabReference(tabs, { tabId, tabTitle }, label = 'target') {
    // Prefer exact ids, but allow a unique title as a human-friendly fallback.
    // Ambiguous titles are rejected because applying a diff to the wrong tab is
    // worse than asking the user to retry with a clearer request.
    if (tabId) {
        if (tabs.some((tab) => tab.id === tabId)) return { id: tabId };

        const titleRef = resolveTabTitleReference(tabs, tabTitle || tabId, label);
        if (titleRef) return titleRef;

        return { error: `The AI response referenced an unknown ${label} tab id or title "${tabId}".` };
    }

    if (!normalizeTabTitle(tabTitle)) {
        return { error: `The AI response did not identify the ${label} tab.` };
    }

    const titleRef = resolveTabTitleReference(tabs, tabTitle, label);
    if (titleRef) return titleRef;

    return { error: `The AI response referenced an unknown ${label} tab title "${normalizeTabTitle(tabTitle)}".` };
}

function resolveOptionalTabReference(tabs, reference, label = 'target') {
    if (!reference?.tabId && !reference?.tabTitle) return { id: null };
    return resolveTabReference(tabs, reference, label);
}

function getActionLabel(action, tabs) {
    const tabTitle = (tabId) => tabs.find((tab) => tab.id === tabId)?.title || 'tab';

    switch (action.type) {
        case 'create':
            return `Create tab "${action.title}"`;
        case 'rename':
            return `Rename "${tabTitle(action.tabId)}" to "${action.title}"`;
        case 'move':
            return action.afterTabId ? `Move "${tabTitle(action.tabId)}" after "${tabTitle(action.afterTabId)}"` : `Move "${tabTitle(action.tabId)}" to the end`;
        case 'setInactive':
            return `${action.isInactive ? 'Deactivate' : 'Activate'} "${tabTitle(action.tabId)}"`;
        case 'delete':
            return `Delete tab "${tabTitle(action.tabId)}"`;
        case 'moveStatementsToNewTab':
            return `Move ${action.statementType} statements from "${tabTitle(action.sourceTabId)}" to "${action.title}"`;
        default:
            return 'Apply tab change';
    }
}

function createTabPlan(tabs, tabChanges) {
    const originalTabs = normalizeTabs(tabs);
    const suggestedTabsById = new Map(originalTabs.map((tab) => [tab.id, { ...tab }]));

    // First apply tab-local SQL diffs to cloned tabs. The review is a plan only:
    // user SQL is not mutated until a block/action is accepted.
    for (const update of tabChanges?.updates || []) {
        const updateRef = resolveTabReference(originalTabs, { tabId: update?.tabId, tabTitle: update?.tabTitle }, 'update');
        if (updateRef.error) return { error: updateRef.error };

        const tab = suggestedTabsById.get(updateRef.id);
        if (!tab || !Array.isArray(update?.diffs) || update.diffs.length === 0) {
            return { error: 'The AI response referenced an unknown tab or an invalid tab diff.' };
        }
        if (tab.isInactive) {
            return { error: `The AI response attempted to update inactive tab "${tab.title}". Activate the tab before asking AI to edit it.` };
        }

        // The tab protocol requires an exact, unique search block. Tolerant
        // matching is retained only for legacy whole-document responses;
        // guessing here can edit the wrong repeated SQL statement.
        const result = applyDiffs(tab.sql, update.diffs, 0.75, { exactOnly: true, requireUnique: true });
        if (!result.success) {
            const failedMethod = result.failed[0]?.method;
            const reason = failedMethod === 'ambiguous-exact' ? 'the search block appears more than once' : 'the search block is not an exact match';
            return { error: `The AI response could not safely apply the update for tab "${tab.title}" because ${reason}.` };
        }

        suggestedTabsById.set(tab.id, { ...tab, sql: result.result });
    }

    const actions = [];
    const knownIds = new Set(originalTabs.map((tab) => tab.id));
    const reservedIds = new Set(knownIds);
    const creatorActionIdByTabId = new Map();
    const movedStatementTypesBySource = new Map();
    let referenceTabs = originalTabs.map((tab) => ({ ...tab }));

    // Then validate structural tab actions in response order. `referenceTabs`
    // mirrors ids/titles created, renamed, or deleted earlier in the same AI
    // response so later actions can refer to the updated workspace.
    for (const [index, action] of (tabChanges?.actions || []).entries()) {
        if (!action || typeof action.type !== 'string') {
            return { error: 'The AI response contained an invalid tab action.' };
        }
        if (action.type === 'invalid') {
            return { error: action.reason || 'The AI response contained invalid tab changes.' };
        }

        if (action.type === 'create') {
            const afterRef = resolveOptionalTabReference(referenceTabs, { tabId: action.afterTabId, tabTitle: action.afterTabTitle }, 'after');
            if (afterRef.error) return { error: afterRef.error };
            if (!action.title?.trim() || typeof action.sql !== 'string') {
                return { error: 'The AI response contained an invalid create-tab action.' };
            }
            let createdTabId = `ai_tab_${index + 1}`;
            let duplicateIndex = 2;
            while (reservedIds.has(createdTabId)) {
                createdTabId = `ai_tab_${index + 1}_${duplicateIndex}`;
                duplicateIndex += 1;
            }
            reservedIds.add(createdTabId);
            const actionId = `${TAB_ACTION_PREFIX}${index}`;
            const requiredActionIds = creatorActionIdByTabId.has(afterRef.id) ? [creatorActionIdByTabId.get(afterRef.id)] : [];
            actions.push({
                ...action,
                id: actionId,
                createdTabId,
                title: action.title.trim(),
                afterTabId: afterRef.id,
                requiredActionIds,
            });
            creatorActionIdByTabId.set(createdTabId, actionId);
            referenceTabs = [...referenceTabs, { id: createdTabId, title: action.title.trim() }];
            continue;
        }

        if (action.type === 'moveStatementsToNewTab') {
            const sourceRef = resolveTabReference(referenceTabs, { tabId: action.sourceTabId, tabTitle: action.sourceTabTitle }, 'source');
            if (sourceRef.error) return { error: sourceRef.error };
            const afterRef =
                action.afterTabId || action.afterTabTitle
                    ? resolveOptionalTabReference(referenceTabs, { tabId: action.afterTabId, tabTitle: action.afterTabTitle }, 'after')
                    : { id: sourceRef.id };
            if (afterRef.error) return { error: afterRef.error };

            const sourceTab = suggestedTabsById.get(sourceRef.id);
            const statementType = normalizeMovableStatementType(action.statementType);
            const afterTabId = afterRef.id || sourceRef.id;
            if (!sourceTab || !action.title?.trim() || !isMovableStatementType(statementType)) {
                return { error: 'The AI response contained an invalid move-statements action.' };
            }
            if (sourceTab.isInactive) {
                return { error: `The AI response attempted to move SQL from inactive tab "${sourceTab.title}". Activate the tab before asking AI to edit it.` };
            }
            const requestedTypes = statementType === 'DML' ? ['INSERT', 'UPDATE', 'DELETE'] : [statementType];
            const movedTypes = movedStatementTypesBySource.get(sourceRef.id) || new Set();
            if (requestedTypes.some((type) => movedTypes.has(type))) {
                return { error: 'The AI response requested overlapping statement moves from the same tab.' };
            }
            requestedTypes.forEach((type) => movedTypes.add(type));
            movedStatementTypesBySource.set(sourceRef.id, movedTypes);

            const extracted = extractStatementsByType(sourceTab.sql, statementType);
            if (!extracted.success) {
                return { error: `The AI response asked to move ${statementType} statements, but none were found in tab "${sourceTab.title}".` };
            }

            // The extracted SQL is stored on the action for preview. On accept,
            // extraction is run again against the current accepted source tab so
            // accepted diff blocks and move actions compose correctly.
            let createdTabId = `ai_tab_${index + 1}`;
            let duplicateIndex = 2;
            while (reservedIds.has(createdTabId)) {
                createdTabId = `ai_tab_${index + 1}_${duplicateIndex}`;
                duplicateIndex += 1;
            }
            reservedIds.add(createdTabId);
            const actionId = `${TAB_ACTION_PREFIX}${index}`;
            const requiredActionIds = [creatorActionIdByTabId.get(sourceRef.id), creatorActionIdByTabId.get(afterTabId)].filter(Boolean);
            actions.push({
                ...action,
                id: actionId,
                createdTabId,
                title: action.title.trim(),
                sourceTabId: sourceRef.id,
                statementType,
                afterTabId,
                sql: extracted.extractedSql,
                statementCount: extracted.matchedCount,
                requiredActionIds: [...new Set(requiredActionIds)],
            });
            creatorActionIdByTabId.set(createdTabId, actionId);
            referenceTabs = [...referenceTabs, { id: createdTabId, title: action.title.trim() }];
            continue;
        }

        const actionRef = resolveTabReference(referenceTabs, { tabId: action.tabId, tabTitle: action.tabTitle }, 'target');
        if (actionRef.error) return { error: actionRef.error };
        const resolvedAction = { ...action, tabId: actionRef.id };

        if (resolvedAction.type === 'rename' && !resolvedAction.title?.trim()) {
            return { error: 'The AI response contained an invalid rename action.' };
        }
        if (resolvedAction.type === 'move') {
            const afterRef = resolveOptionalTabReference(referenceTabs, { tabId: action.afterTabId, tabTitle: action.afterTabTitle }, 'after');
            if (afterRef.error) return { error: afterRef.error };
            resolvedAction.afterTabId = afterRef.id;
            if (resolvedAction.afterTabId === resolvedAction.tabId) {
                return { error: 'The AI response contained an invalid move-tab action.' };
            }
        }
        if (resolvedAction.type === 'setInactive' && typeof resolvedAction.isInactive !== 'boolean') {
            return { error: 'The AI response contained an invalid tab activity action.' };
        }
        if (!['rename', 'move', 'setInactive', 'delete'].includes(resolvedAction.type)) {
            return { error: 'The AI response requested an unsupported tab action.' };
        }

        const requiredActionIds = [creatorActionIdByTabId.get(resolvedAction.tabId), creatorActionIdByTabId.get(resolvedAction.afterTabId)].filter(Boolean);
        actions.push({
            ...resolvedAction,
            id: `${TAB_ACTION_PREFIX}${index}`,
            requiredActionIds: [...new Set(requiredActionIds)],
            ...(resolvedAction.title && { title: resolvedAction.title.trim() }),
        });
        if (resolvedAction.type === 'rename') {
            referenceTabs = referenceTabs.map((tab) => (tab.id === resolvedAction.tabId ? { ...tab, title: resolvedAction.title.trim() } : tab));
        } else if (resolvedAction.type === 'delete') {
            referenceTabs = referenceTabs.filter((tab) => tab.id !== resolvedAction.tabId);
        }
    }

    return {
        suggestedTabs: originalTabs.map((tab) => suggestedTabsById.get(tab.id) || tab),
        actions,
    };
}

function applyTabAction(tabs, action) {
    // Tab actions are idempotent: accepting the same action twice must not
    // duplicate a tab or remove SQL twice while React state catches up.
    if (action.type === 'create') {
        if (tabs.some((tab) => tab.id === action.createdTabId)) return tabs;
        const nextTab = createSqlTab({
            id: action.createdTabId,
            title: action.title,
            sql: action.sql,
            isInactive: action.isInactive,
        });
        const afterIndex = action.afterTabId ? tabs.findIndex((tab) => tab.id === action.afterTabId) : -1;
        return afterIndex >= 0 ? [...tabs.slice(0, afterIndex + 1), nextTab, ...tabs.slice(afterIndex + 1)] : [...tabs, nextTab];
    }

    if (action.type === 'moveStatementsToNewTab') {
        if (tabs.some((tab) => tab.id === action.createdTabId)) return tabs;

        const sourceIndex = tabs.findIndex((tab) => tab.id === action.sourceTabId);
        if (sourceIndex < 0) return tabs;

        const extracted = extractStatementsByType(tabs[sourceIndex].sql, action.statementType);
        if (!extracted.success) return tabs;

        const movedTab = createSqlTab({
            id: action.createdTabId,
            title: action.title,
            sql: extracted.extractedSql,
            isInactive: action.isInactive,
        });
        const tabsWithUpdatedSource = tabs.map((tab, index) => (index === sourceIndex ? { ...tab, sql: extracted.remainingSql } : tab));
        const afterIndex = action.afterTabId ? tabsWithUpdatedSource.findIndex((tab) => tab.id === action.afterTabId) : -1;

        return afterIndex >= 0 ? [...tabsWithUpdatedSource.slice(0, afterIndex + 1), movedTab, ...tabsWithUpdatedSource.slice(afterIndex + 1)] : [...tabsWithUpdatedSource, movedTab];
    }

    const tabIndex = tabs.findIndex((tab) => tab.id === action.tabId);
    if (tabIndex < 0) return tabs;

    if (action.type === 'rename') {
        return tabs.map((tab) => (tab.id === action.tabId ? { ...tab, title: action.title } : tab));
    }
    if (action.type === 'setInactive') {
        return tabs.map((tab) => (tab.id === action.tabId ? { ...tab, isInactive: action.isInactive } : tab));
    }
    if (action.type === 'delete') {
        return tabs.filter((tab) => tab.id !== action.tabId);
    }
    if (action.type === 'move') {
        const [tab] = tabs.slice(tabIndex, tabIndex + 1);
        const withoutTab = tabs.filter((item) => item.id !== action.tabId);
        const afterIndex = action.afterTabId ? withoutTab.findIndex((item) => item.id === action.afterTabId) : -1;
        return afterIndex >= 0 ? [...withoutTab.slice(0, afterIndex + 1), tab, ...withoutTab.slice(afterIndex + 1)] : [...withoutTab, tab];
    }

    return tabs;
}

export class AiTabDiffReview {
    constructor({ tabs, preferredTabId, suggestedSql, tabChanges = null }) {
        this.originalTabs = normalizeTabs(tabs).map((tab) => ({ ...tab }));
        this.suggestedSql = typeof suggestedSql === 'string' ? suggestedSql : '';
        this.tabActions = [];
        this.reviewError = null;

        if (tabChanges) {
            // Preferred path: providers return explicit tab operations, so every
            // SQL diff is scoped to one tab and every structural change is a
            // separate accept/reject block.
            const plan = createTabPlan(this.originalTabs, tabChanges);
            this.reviewError = plan.error || null;
            this.suggestedTabs = plan.suggestedTabs || this.originalTabs;
            this.tabActions = plan.actions || [];
            this.mode = this.reviewError ? 'invalid' : 'tabs';
        } else {
            // Compatibility path for legacy whole-document diffs. If ownership
            // cannot be proven safely, fall back to document mode.
            this.suggestedTabs = createSuggestedTabsFromWholeDocumentDiff(this.originalTabs, preferredTabId, this.suggestedSql);
            this.mode = this.suggestedTabs ? 'tabs' : 'document';
        }

        if (this.mode === 'tabs') {
            this.tabEntries = this.originalTabs.map((tab) => {
                const suggestedTab = this.suggestedTabs.find((item) => item.id === tab.id) || tab;
                return {
                    tab,
                    suggestedTab,
                    diffManager: new DiffManager(tab.sql, suggestedTab.sql),
                };
            });
            this.documentDiffManager = null;
        } else if (this.mode === 'document') {
            this.tabEntries = [];
            this.documentDiffManager = new DiffManager(buildCombinedSql(this.originalTabs).sql, this.suggestedSql);
        } else {
            this.tabEntries = [];
            this.documentDiffManager = null;
        }
    }

    getAllBlocks() {
        if (this.mode === 'invalid') return [];
        if (this.mode === 'document') {
            return this.documentDiffManager.getAllBlocks().map((block) => ({ ...block, id: `document:${block.id}`, tabId: null }));
        }

        const diffBlocks = this.tabEntries.flatMap((entry) => entry.diffManager.getAllBlocks().map((block) => ({ ...block, id: `${entry.tab.id}:${block.id}`, tabId: entry.tab.id, kind: 'sql' })));
        const actionBlocks = this.tabActions.map((action) => ({ id: action.id, tabId: action.tabId || action.sourceTabId || null, kind: 'tab-action' }));
        return [...diffBlocks, ...actionBlocks];
    }

    getDisplayData(tabId, acceptedBlocks, rejectedBlocks) {
        if (this.mode === 'invalid') {
            const tab = this.originalTabs.find((item) => item.id === tabId);
            return { code: tab?.sql || '', visibleBlocks: [] };
        }
        if (this.mode === 'document') {
            const displayData = this.documentDiffManager.getDisplayData(toLocalBlockSet(acceptedBlocks, 'document'), toLocalBlockSet(rejectedBlocks, 'document'));
            return {
                ...displayData,
                visibleBlocks: displayData.visibleBlocks.map((block) => ({ ...block, id: `document:${block.id}` })),
            };
        }

        const acceptedSqlAction = this.tabActions.find(
            (action) =>
                acceptedBlocks.has(action.id) &&
                ((action.type === 'create' && action.createdTabId === tabId) ||
                    (action.type === 'moveStatementsToNewTab' && (action.sourceTabId === tabId || action.createdTabId === tabId))),
        );
        if (acceptedSqlAction) {
            // Created/moved tabs do not have a normal diff entry. Once accepted,
            // show the materialized accepted tab immediately so users do not
            // need to switch tabs to refresh the editor.
            const acceptedTab = this.applySelectedChanges(acceptedBlocks).find((tab) => tab.id === tabId);
            return { code: acceptedTab?.sql || '', visibleBlocks: [] };
        }

        const entry = this.tabEntries.find((item) => item.tab.id === tabId);
        if (!entry) {
            const tab = this.originalTabs.find((item) => item.id === tabId);
            return { code: tab?.sql || '', visibleBlocks: [] };
        }

        const displayData = entry.diffManager.getDisplayData(toLocalBlockSet(acceptedBlocks, tabId), toLocalBlockSet(rejectedBlocks, tabId));
        return {
            ...displayData,
            visibleBlocks: displayData.visibleBlocks.map((block) => ({ ...block, id: `${tabId}:${block.id}` })),
        };
    }

    getDisplayTabs(acceptedBlocks, rejectedBlocks) {
        if (this.mode === 'invalid') return this.originalTabs.map((tab) => ({ ...tab }));

        if (this.mode === 'document') {
            return reconcileSqlTabsFromCombinedSql(this.originalTabs, this.getDisplayData(null, acceptedBlocks, rejectedBlocks).code);
        }

        // Display tabs preserve pending red/green diff blocks for Monaco. This
        // can differ from preview tabs, which optimistically include pending
        // accepted candidates for parser/ERD/data calculations.
        const acceptedTabs = this.applySelectedChanges(acceptedBlocks);
        return acceptedTabs.map((tab) => {
            if (!this.tabEntries.some((entry) => entry.tab.id === tab.id)) return tab;
            return { ...tab, sql: this.getDisplayData(tab.id, acceptedBlocks, rejectedBlocks).code };
        });
    }

    getDisplaySql(acceptedBlocks, rejectedBlocks) {
        if (this.mode === 'document') {
            return this.getDisplayData(null, acceptedBlocks, rejectedBlocks).code;
        }

        return buildCombinedSql(this.getDisplayTabs(acceptedBlocks, rejectedBlocks)).sql;
    }

    // A pending change is a candidate for the final SQL. Parse the candidate
    // (accepted + pending, excluding rejected blocks) so a proposed deletion
    // can clear its error before acceptance. The separate display workspace
    // keeps red deletion lines visible and diagnostics are mapped back to it.
    getPreviewTabs(acceptedBlocks, rejectedBlocks) {
        if (this.mode === 'invalid') return this.originalTabs.map((tab) => ({ ...tab }));

        const candidateAccepted = new Set(acceptedBlocks);
        this.getAllBlocks().forEach((block) => {
            if (!rejectedBlocks.has(block.id)) {
                candidateAccepted.add(block.id);
            }
        });

        return this.applySelectedChanges(candidateAccepted);
    }

    getPreviewSql(acceptedBlocks, rejectedBlocks) {
        return buildCombinedSql(this.getPreviewTabs(acceptedBlocks, rejectedBlocks)).sql;
    }

    getTabChanges(acceptedBlocks, rejectedBlocks) {
        if (this.mode !== 'tabs') return {};

        return Object.fromEntries(
            this.tabEntries.map((entry) => {
                const blocks = entry.diffManager.getAllBlocks();
                const prefix = `${entry.tab.id}:`;
                const pending = blocks.filter((block) => !acceptedBlocks.has(`${prefix}${block.id}`) && !rejectedBlocks.has(`${prefix}${block.id}`)).length;
                const accepted = blocks.filter((block) => acceptedBlocks.has(`${prefix}${block.id}`)).length;
                const rejected = blocks.filter((block) => rejectedBlocks.has(`${prefix}${block.id}`)).length;
                return [entry.tab.id, { total: blocks.length, pending, accepted, rejected }];
            }),
        );
    }

    getTabActions(acceptedBlocks, rejectedBlocks) {
        return this.tabActions.map((action) => ({
            ...action,
            label: getActionLabel(action, this.originalTabs),
            status: acceptedBlocks.has(action.id) ? 'accepted' : rejectedBlocks.has(action.id) ? 'rejected' : 'pending',
            canAccept: (action.requiredActionIds || []).every((actionId) => acceptedBlocks.has(actionId)),
        }));
    }

    getDependentBlockIds(blockId) {
        const dependentIds = new Set();
        let frontier = new Set([blockId]);

        while (frontier.size > 0) {
            const nextFrontier = new Set();
            this.tabActions.forEach((action) => {
                if (dependentIds.has(action.id)) return;
                if ((action.requiredActionIds || []).some((requiredId) => frontier.has(requiredId))) {
                    dependentIds.add(action.id);
                    nextFrontier.add(action.id);
                }
            });
            frontier = nextFrontier;
        }

        return [...dependentIds];
    }

    applySelectedChanges(acceptedBlocks) {
        if (this.mode === 'invalid') return this.originalTabs;
        if (this.mode === 'document') {
            const finalSql = this.documentDiffManager.applySelectedChanges(toLocalBlockSet(acceptedBlocks, 'document'));
            return reconcileSqlTabsFromCombinedSql(this.originalTabs, finalSql);
        }

        // SQL block acceptance happens before structural tab actions. That order
        // lets actions like "move statements" operate on the same tab content
        // the user sees after accepted SQL diffs.
        const changedTabs = this.originalTabs.map((tab) => {
            const entry = this.tabEntries.find((item) => item.tab.id === tab.id);
            if (!entry) return tab;

            return {
                ...tab,
                sql: entry.diffManager.applySelectedChanges(toLocalBlockSet(acceptedBlocks, tab.id)),
            };
        });

        const nextTabs = this.tabActions
            .filter((action) => acceptedBlocks.has(action.id) && (action.requiredActionIds || []).every((actionId) => acceptedBlocks.has(actionId)))
            .reduce(applyTabAction, changedTabs);
        return nextTabs.length > 0 ? nextTabs : createSingleSqlTab('');
    }
}

export function createAiTabDiffReview(options) {
    return new AiTabDiffReview(options);
}
