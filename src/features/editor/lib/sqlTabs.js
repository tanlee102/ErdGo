import { DEFAULT_SCHEMA_NAME, identifierPartsFromText } from '@/lib/sqlIdentifierIdentity';
import { tokenize } from '@/lib/parse-ast/tokenize';
import { sqlToErdSchema } from '@/lib/erdJsonSchema';
import { getSqlDialectProfile } from '@/lib/sqlDialectProfiles';
import { MyersDiff } from './diffAlgorithm';

const SQL_TAB_META_VERSION = 2;
export const SQL_TABS_CONTEXT_KEY = 'sqlTabs';
export const INACTIVE_TAB_PLACEHOLDER_SQL = '-- SQL content is stored in inactive tabs.';

// The editor still stores and parses one combined SQL document. Tabs are a UI
// and persistence layer over that document: active tabs compile in workspace
// order, while inactive tabs keep their SQL only in metadata.
let tabIdSequence = 0;

function createSqlTabId() {
    tabIdSequence += 1;
    return `sql_tab_${Date.now().toString(36)}_${tabIdSequence.toString(36)}`;
}

function normalizeSql(value) {
    return typeof value === 'string' ? value : '';
}

function countLines(value) {
    const sql = normalizeSql(value);
    let count = 1;
    for (let i = 0; i < sql.length; i += 1) {
        if (sql[i] === '\r' || (sql[i] === '\n' && sql[i - 1] !== '\r')) count += 1;
    }
    return count;
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validRangeOffset(value, min, max) {
    return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

export function createSqlTab({ id, title, sql = '', createdAt, isInactive = false } = {}) {
    return {
        id: id || createSqlTabId(),
        title: title || 'SQL 1',
        sql: normalizeSql(sql),
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
        isInactive: Boolean(isInactive),
    };
}

export function createSingleSqlTab(sql = '', title = 'SQL 1') {
    return [createSqlTab({ title, sql })];
}

function normalizeTabForWorkspace(tab, index, usedIds) {
    const requestedId = typeof tab?.id === 'string' && tab.id ? tab.id : undefined;
    const nextTab = createSqlTab({
        id: requestedId && !usedIds.has(requestedId) ? requestedId : undefined,
        title: typeof tab?.title === 'string' && tab.title.trim() ? tab.title.trim() : `SQL ${index + 1}`,
        sql: normalizeSql(tab?.sql),
        createdAt: Number.isFinite(tab?.createdAt) ? tab.createdAt : Date.now() + index,
        isInactive: Boolean(tab?.isInactive),
    });
    usedIds.add(nextTab.id);
    return nextTab;
}

/**
 * Merge an active-only workspace (for example, an accepted AI review) back
 * into the complete local workspace. Inactive tabs are private saved drafts:
 * they are deliberately absent from AI input, but must never be deleted when
 * the active result is applied.
 */
export function mergeActiveSqlTabs(currentTabs, nextActiveTabs, protectedInactiveTabIds = null) {
    const safeCurrentTabs = Array.isArray(currentTabs) ? currentTabs : [];
    const usedIds = new Set();
    const protectedIds =
        protectedInactiveTabIds == null
            ? new Set(safeCurrentTabs.filter((tab) => tab?.isInactive).map((tab) => tab.id))
            : new Set(Array.from(protectedInactiveTabIds).filter((id) => typeof id === 'string' && id));

    // Reserve inactive ids first. Apart from preserving Monaco view-state and
    // saved metadata identity, this prevents a generated active tab from
    // shadowing a private draft with the same id.
    const normalizedInactiveByIndex = new Map();
    safeCurrentTabs.forEach((tab, index) => {
        if (!tab?.isInactive || !protectedIds.has(tab.id)) return;
        normalizedInactiveByIndex.set(index, normalizeTabForWorkspace(tab, index, usedIds));
    });

    // Tabs that were part of the AI-visible workspace may themselves become
    // inactive through an accepted setInactive action, so retain their state.
    const requestedWorkspaceTabs = Array.isArray(nextActiveTabs) ? nextActiveTabs : [];
    const normalizedWorkspaceTabs = (requestedWorkspaceTabs.length > 0 ? requestedWorkspaceTabs : createSingleSqlTab('')).map((tab, index) =>
        normalizeTabForWorkspace(tab, index, usedIds),
    );

    // Fill the existing active slots in the new active order. This keeps every
    // inactive draft at the same stable boundary while still allowing active
    // tabs to be reordered, added, or deleted by the accepted workspace.
    const mergedTabs = [];
    let activeIndex = 0;
    safeCurrentTabs.forEach((tab, index) => {
        const inactiveTab = normalizedInactiveByIndex.get(index);
        if (inactiveTab) {
            mergedTabs.push(inactiveTab);
            return;
        }

        if (activeIndex < normalizedWorkspaceTabs.length) {
            mergedTabs.push(normalizedWorkspaceTabs[activeIndex]);
            activeIndex += 1;
        }
    });

    if (activeIndex < normalizedWorkspaceTabs.length) {
        mergedTabs.push(...normalizedWorkspaceTabs.slice(activeIndex));
    }

    return mergedTabs.length > 0 ? mergedTabs : createSingleSqlTab('');
}

function createFallbackTabsFromCombinedSql(nextSql, tabs = []) {
    const safeTabs = Array.isArray(tabs) ? tabs : [];
    const firstActiveTab = safeTabs.find((tab) => !tab?.isInactive);
    const fallbackTab = createSqlTab({
        id: firstActiveTab?.id,
        title: firstActiveTab?.title || 'SQL 1',
        sql: nextSql,
        createdAt: firstActiveTab?.createdAt,
    });
    let insertedFallback = false;
    const nextTabs = safeTabs.reduce((result, tab) => {
        if (tab?.isInactive) {
            result.push({ ...tab });
            return result;
        }
        if (!insertedFallback) {
            result.push(fallbackTab);
            insertedFallback = true;
        }
        return result;
    }, []);

    return insertedFallback ? nextTabs : [fallbackTab, ...nextTabs];
}

function createFallbackTabsFromContextSql(sourceSql, meta) {
    const inactiveTabs = [];
    const usedIds = new Set();

    for (const [index, item] of (meta?.tabs || []).entries()) {
        if (!isObject(item) || item.isInactive !== true) continue;
        const requestedId = typeof item.id === 'string' && item.id ? item.id : undefined;
        const inactiveTab = createSqlTab({
            id: requestedId && !usedIds.has(requestedId) ? requestedId : undefined,
            title: typeof item.title === 'string' && item.title ? item.title : `SQL ${index + 1}`,
            createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now() + index,
            sql: normalizeSql(item.inactiveSql),
            isInactive: true,
        });
        usedIds.add(inactiveTab.id);
        inactiveTabs.push(inactiveTab);
    }

    const metadataIsAllInactive = Array.isArray(meta?.tabs) && meta.tabs.length > 0 && meta.tabs.every((item) => isObject(item) && item.isInactive === true);

    // A valid all-inactive workspace uses the placeholder as its combined SQL.
    // Older saves may have persisted an empty combined field instead. In both
    // cases the inactive metadata is authoritative and must not become a
    // surprise blank active tab on load.
    if (metadataIsAllInactive && inactiveTabs.length > 0 && (sourceSql === INACTIVE_TAB_PLACEHOLDER_SQL || sourceSql === '')) {
        return inactiveTabs;
    }

    return createFallbackTabsFromCombinedSql(sourceSql, inactiveTabs);
}

export function buildCombinedSql(tabs) {
    const safeTabs = Array.isArray(tabs) && tabs.length > 0 ? tabs : createSingleSqlTab('');
    const ranges = [];
    let sql = '';
    let nextStartLine = 1;
    let hasWrittenContent = false;
    const hasInactiveSql = safeTabs.some((tab) => tab?.isInactive && normalizeSql(tab?.sql).trim().length > 0);

    safeTabs.forEach((tab, index) => {
        const isInactive = Boolean(tab?.isInactive);
        const content = isInactive ? '' : normalizeSql(tab?.sql);

        if (content.length > 0 && hasWrittenContent) {
            // A trailing CR joins the separator's first LF into one newline,
            // exactly as the tokenizer does; CRLF must never count twice.
            nextStartLine += sql.endsWith('\r') ? 1 : 2;
            sql += '\n\n';
        }

        const start = sql.length;
        const startLine = nextStartLine;

        if (content.length > 0) {
            sql += content;
            hasWrittenContent = true;
        }

        const lineCount = content.length > 0 ? countLines(content) : 0;
        nextStartLine += Math.max(0, lineCount - 1);
        const end = sql.length;
        ranges.push({
            id: tab?.id,
            title: tab?.title || `SQL ${index + 1}`,
            start,
            end,
            startLine,
            endLine: lineCount > 0 ? startLine + lineCount - 1 : startLine,
            lineCount,
            isInactive,
        });
    });

    // If every tab is inactive, keep a harmless placeholder in the global SQL
    // field so the file is visibly non-empty while no inactive SQL is parsed.
    if (!hasWrittenContent && hasInactiveSql) {
        sql = INACTIVE_TAB_PLACEHOLDER_SQL;
    }

    return { sql, ranges };
}

export function serializeSqlTabs(tabs, activeTabId = null) {
    const { ranges } = buildCombinedSql(tabs);
    const safeActiveTabId = tabs.some((tab) => tab.id === activeTabId) ? activeTabId : null;

    // Persist character ranges into the combined SQL instead of duplicating
    // active tab SQL. Inactive tabs cannot have ranges because they are not
    // present in the compiled document, so their SQL is stored separately.
    return {
        version: SQL_TAB_META_VERSION,
        ...(safeActiveTabId && { activeTabId: safeActiveTabId }),
        tabs: tabs.map((tab, index) => {
            const range = ranges[index] || {};
            return {
                id: tab.id,
                title: tab.title || `SQL ${index + 1}`,
                createdAt: tab.createdAt,
                start: range.start ?? 0,
                end: range.end ?? 0,
                ...(tab.isInactive && { isInactive: true, inactiveSql: normalizeSql(tab.sql) }),
            };
        }),
    };
}

export function getSqlTabsMeta(context) {
    if (!isObject(context)) return null;
    const meta = context[SQL_TABS_CONTEXT_KEY];
    if (!isObject(meta) || !Array.isArray(meta.tabs) || meta.tabs.length === 0) return null;
    return meta;
}

export function getActiveSqlTabIdFromContext(context, tabs) {
    const meta = getSqlTabsMeta(context);
    if (!meta || typeof meta.activeTabId !== 'string') return null;
    return tabs.some((tab) => tab.id === meta.activeTabId) ? meta.activeTabId : null;
}

export function hydrateSqlTabsFromContext(sql, context) {
    const sourceSql = normalizeSql(sql);
    const meta = getSqlTabsMeta(context);

    if (!meta) {
        return createSingleSqlTab(sourceSql);
    }

    // Old or corrupted metadata must never lose user SQL. Any invalid active
    // range falls back to one active tab while preserving inactive drafts.
    const nextTabs = [];
    const usedIds = new Set();
    for (let index = 0; index < meta.tabs.length; index += 1) {
        const item = meta.tabs[index];
        if (!isObject(item)) return createFallbackTabsFromContextSql(sourceSql, meta);

        const isInactive = item.isInactive === true;
        const start = validRangeOffset(item.start, 0, sourceSql.length);
        const end = validRangeOffset(item.end, 0, sourceSql.length);
        if (!isInactive && (start === null || end === null || end < start)) {
            return createFallbackTabsFromContextSql(sourceSql, meta);
        }

        const requestedId = typeof item.id === 'string' && item.id ? item.id : undefined;
        const nextTab = createSqlTab({
            id: requestedId && !usedIds.has(requestedId) ? requestedId : undefined,
            title: typeof item.title === 'string' && item.title ? item.title : `SQL ${index + 1}`,
            createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now() + index,
            sql: isInactive ? normalizeSql(item.inactiveSql) : sourceSql.slice(start, end),
            isInactive,
        });
        usedIds.add(nextTab.id);
        nextTabs.push(nextTab);
    }

    if (nextTabs.length === 0) return createFallbackTabsFromContextSql(sourceSql, meta);

    // Active tab ranges are persisted from a single combined SQL document.
    // If they overlap, arrive out of order, or leave content unowned, refuse
    // to guess an owner and keep the original SQL in one active tab instead.
    const combined = buildCombinedSql(nextTabs);
    const exactRanges = combined.ranges.every((range, index) => range.isInactive || (range.start === meta.tabs[index].start && range.end === meta.tabs[index].end));
    return combined.sql === sourceSql && exactRanges ? nextTabs : createFallbackTabsFromContextSql(sourceSql, meta);
}

export function getDirtySqlTabIds(tabs, savedTabs) {
    if (!Array.isArray(tabs) || tabs.length === 0) return new Set();

    const savedById = new Map((Array.isArray(savedTabs) ? savedTabs : []).map((tab) => [tab.id, tab]));
    const savedIndexById = new Map((Array.isArray(savedTabs) ? savedTabs : []).map((tab, index) => [tab.id, index]));
    return new Set(
        tabs
            .filter((tab, index) => {
                const savedTab = savedById.get(tab.id);
                if (!savedTab) return true;
                return (
                    normalizeSql(tab.sql) !== normalizeSql(savedTab.sql) ||
                    (tab.title || '') !== (savedTab.title || '') ||
                    Boolean(tab.isInactive) !== Boolean(savedTab.isInactive) ||
                    savedIndexById.get(tab.id) !== index
                );
            })
            .map((tab) => tab.id),
    );
}

function findDiffWindow(previousSql, nextSql) {
    if (previousSql === nextSql) {
        return null;
    }

    let start = 0;
    while (start < previousSql.length && start < nextSql.length && previousSql[start] === nextSql[start]) {
        start += 1;
    }

    let previousEnd = previousSql.length;
    let nextEnd = nextSql.length;
    while (previousEnd > start && nextEnd > start && previousSql[previousEnd - 1] === nextSql[nextEnd - 1]) {
        previousEnd -= 1;
        nextEnd -= 1;
    }

    return { start, previousEnd, nextEnd };
}

function rangeTouchesChange(range, changeStart, changeEnd) {
    if (changeEnd > changeStart) {
        return range.start < changeEnd && range.end > changeStart;
    }
    return changeStart >= range.start && changeStart <= range.end;
}

function independentEditWindows(previousSql, nextSql) {
    const offsets = (sql) => {
        const result = [0];
        for (let i = 0; i < sql.length; i += 1) if (sql[i] === '\n') result.push(i + 1);
        result.push(sql.length);
        return result;
    };
    const oldOffsets = offsets(previousSql);
    const nextOffsets = offsets(nextSql);
    const windows = [];
    let oldLine = 0;
    let nextLine = 0;
    let start = null;
    const flush = () => {
        if (!start) return;
        let oldStart = oldOffsets[start.oldLine];
        let newStart = nextOffsets[start.nextLine];
        // A line diff ignores whether its last equal line has a terminator.
        // When appending/removing final lines, include that changed newline in
        // the hunk instead of leaving it outside both slices and losing tabs.
        if (start.oldLine === oldOffsets.length - 1 && oldStart > 0 && nextSql[newStart - 1] === '\n') newStart -= 1;
        if (start.nextLine === nextOffsets.length - 1 && newStart > 0 && previousSql[oldStart - 1] === '\n') oldStart -= 1;
        const oldText = previousSql.slice(oldStart, oldOffsets[oldLine]);
        const newText = nextSql.slice(newStart, nextOffsets[nextLine]);
        const diff = findDiffWindow(oldText, newText);
        if (diff) windows.push({ start: oldStart + diff.start, previousEnd: oldStart + diff.previousEnd, text: newText.slice(diff.start, diff.nextEnd) });
        start = null;
    };
    // The shared diff engine bounds expensive rewrites. Its coarse fallback
    // deliberately collapses ambiguous cross-tab replacements below.
    for (const change of MyersDiff.diff(previousSql, nextSql)) {
        if (change.type === 'equal') {
            flush();
            oldLine += 1;
            nextLine += 1;
        } else {
            start ||= { oldLine, nextLine };
            if (change.type === 'delete') oldLine += 1;
            else nextLine += 1;
        }
    }
    flush();
    return windows;
}

export function reconcileSqlTabsFromCombinedSql(tabs, nextSql) {
    const safeTabs = Array.isArray(tabs) && tabs.length > 0 ? tabs : createSingleSqlTab('');
    const sourceSql = normalizeSql(nextSql);
    const previous = buildCombinedSql(safeTabs);
    const diff = findDiffWindow(previous.sql, sourceSql);

    if (!diff) return safeTabs;
    if (safeTabs.length === 1) {
        if (safeTabs[0].isInactive) {
            return createFallbackTabsFromCombinedSql(sourceSql, safeTabs);
        }
        return [{ ...safeTabs[0], sql: sourceSql }];
    }

    // Keep the fast single-window path for ordinary edits. For independent
    // edits in several tabs, unchanged boundaries can prove each owner.
    const touchedRanges = previous.ranges.filter((range) => !range.isInactive && range.lineCount > 0 && rangeTouchesChange(range, diff.start, diff.previousEnd));
    if (touchedRanges.length !== 1) {
        const editsById = new Map();
        const windows = independentEditWindows(previous.sql, sourceSql);
        for (const edit of windows) {
            const owners = previous.ranges.filter((range) => !range.isInactive && range.lineCount > 0 && rangeTouchesChange(range, edit.start, edit.previousEnd));
            if (owners.length !== 1 || edit.start < owners[0].start || edit.previousEnd > owners[0].end) return createFallbackTabsFromCombinedSql(sourceSql, safeTabs);
            const owner = owners[0];
            if (!editsById.has(owner.id)) editsById.set(owner.id, []);
            editsById.get(owner.id).push({ start: edit.start - owner.start, end: edit.previousEnd - owner.start, text: edit.text });
        }
        const reconciled = safeTabs.map((tab) => {
            const edits = editsById.get(tab.id);
            if (!edits) return tab;
            const sql = edits.sort((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), normalizeSql(tab.sql));
            return { ...tab, sql };
        });
        return buildCombinedSql(reconciled).sql === sourceSql ? reconciled : createFallbackTabsFromCombinedSql(sourceSql, safeTabs);
    }

    const touchedRange = touchedRanges[0];
    const touchedIndex = previous.ranges.findIndex((range) => range.id === touchedRange.id);
    if (touchedIndex < 0) {
        return createFallbackTabsFromCombinedSql(sourceSql, safeTabs);
    }

    const tab = safeTabs[touchedIndex];
    const localStart = Math.max(0, diff.start - touchedRange.start);
    const localEnd = Math.max(localStart, diff.previousEnd - touchedRange.start);
    const replacement = sourceSql.slice(diff.start, diff.nextEnd);
    const nextTabSql = normalizeSql(tab.sql).slice(0, localStart) + replacement + normalizeSql(tab.sql).slice(localEnd);
    const nextTabs = safeTabs.map((item, index) => (index === touchedIndex ? { ...item, sql: nextTabSql } : item));

    return buildCombinedSql(nextTabs).sql === sourceSql ? nextTabs : createFallbackTabsFromCombinedSql(sourceSql, safeTabs);
}

export function mapDiagnosticToSqlTab(error, tabs, ranges = null) {
    const line = error?.line ?? error?.position?.line;
    if (!Number.isInteger(line) || line < 1) return error;

    const range = (ranges || buildCombinedSql(tabs).ranges).find((item) => item.lineCount > 0 && line >= item.startLine && line <= item.endLine);
    if (!range) return error;

    const localLine = line - range.startLine + 1;
    return {
        ...error,
        line: localLine,
        globalLine: line,
        tabId: range.id,
        tabTitle: range.title,
    };
}

export function mapDiagnosticsToSqlTabs(errors, tabs) {
    if (!Array.isArray(errors) || errors.length === 0) return [];
    const { ranges } = buildCombinedSql(tabs);
    return errors.map((error) => mapDiagnosticToSqlTab(error, tabs, ranges));
}

export function mapDiagnosticsToActiveSqlTab(errors, tabs, activeTabId) {
    return mapDiagnosticsToSqlTabs(errors, tabs).filter((error) => !error.tabId || error.tabId === activeTabId);
}

// Reuse the parser tokenizer for comments, dollar strings, escaped names and
// token positions. A raw-text regex cannot distinguish SQL from quoted SQL.
const TABLE_MODIFIERS = new Set(['GLOBAL', 'LOCAL', 'TEMP', 'TEMPORARY', 'VOLATILE', 'TRANSIENT', 'UNLOGGED', 'MULTISET', 'SET']);
const isWord = (token, word) => token && ['KW', 'IDENT'].includes(token.type) && token.raw.toUpperCase() === word;
let cachedDeclarations;
let cachedOwners;

function readTableDeclarations(sql) {
    const source = normalizeSql(sql);
    if (cachedDeclarations?.sql === source) return cachedDeclarations.matches;
    const { tokens } = tokenize(source);
    const matches = [];
    for (let i = 0; i < tokens.length; i += 1) {
        if (!isWord(tokens[i], 'CREATE')) continue;
        const create = tokens[i];
        let cursor = i + 1;
        if (isWord(tokens[cursor], 'OR') && isWord(tokens[cursor + 1], 'REPLACE')) cursor += 2;
        while (TABLE_MODIFIERS.has(tokens[cursor]?.raw.toUpperCase())) cursor += 1;
        if (!isWord(tokens[cursor], 'TABLE')) continue;
        cursor += 1;
        if (isWord(tokens[cursor], 'IF') && isWord(tokens[cursor + 1], 'NOT') && isWord(tokens[cursor + 2], 'EXISTS')) cursor += 3;
        const first = tokens[cursor];
        const parts = [];
        let last;
        while (['IDENT', 'KW'].includes(tokens[cursor]?.type)) {
            last = tokens[cursor];
            parts.push(last.value);
            cursor += 1;
            if (tokens[cursor]?.value !== '.') break;
            cursor += 1;
        }
        if (!parts.length) continue;
        matches.push({ index: create.start.idx, line: create.start.line, column: create.start.col,
            identifierIndex: first.start.idx, identifierLine: first.start.line, identifierColumn: first.start.col,
            identifier: source.slice(first.start.idx, last.end.idx), tableName: parts[parts.length - 1], tableParts: parts });
    }
    cachedDeclarations = { sql: source, matches };
    return matches;
}

function normalizeIdentifierForCompare(value) {
    return normalizeSql(value).trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizedIdentifierParts(parts) {
    return parts.map(normalizeIdentifierForCompare).filter(Boolean);
}

function identifierPartsEqual(leftParts, rightParts) {
    if (leftParts.length !== rightParts.length) return false;
    return leftParts.every((part, index) => part === rightParts[index]);
}

function withDefaultSchema(parts, defaultSchema) {
    return parts.length === 1 && !parts[0].includes('.') ? [defaultSchema, ...parts] : parts;
}

function identifierPartsMatchScore(candidateParts, targetParts, defaultSchema = DEFAULT_SCHEMA_NAME) {
    const exactCandidate = candidateParts.map((part) => normalizeSql(part).trim().replace(/\s+/g, ' ')).filter(Boolean);
    const exactTarget = targetParts.map((part) => normalizeSql(part).trim().replace(/\s+/g, ' ')).filter(Boolean);
    const candidate = normalizedIdentifierParts(candidateParts);
    const target = normalizedIdentifierParts(targetParts);
    if (candidate.length === 0 || target.length === 0) return 0;

    if (target.length === 1) {
        if (candidate[candidate.length - 1] !== target[0]) return 0;
        return exactCandidate[exactCandidate.length - 1] === exactTarget[0] ? 2 : 1;
    }

    const candidateWithDefault = withDefaultSchema(candidate, defaultSchema);
    const targetWithDefault = withDefaultSchema(target, defaultSchema);
    if (!identifierPartsEqual(candidateWithDefault, targetWithDefault)) return 0;

    const exactCandidateWithDefault = withDefaultSchema(exactCandidate, defaultSchema);
    const exactTargetWithDefault = withDefaultSchema(exactTarget, defaultSchema);
    return identifierPartsEqual(exactCandidateWithDefault, exactTargetWithDefault) ? 2 : 1;
}

function chooseDeclaration(matches, targetParts, defaultSchema = DEFAULT_SCHEMA_NAME) {
    const scored = matches.map((match) => ({ ...match, identityMatchScore: identifierPartsMatchScore(match.tableParts, targetParts, defaultSchema) })).filter((match) => match.identityMatchScore > 0);
    const best = Math.max(0, ...scored.map((match) => match.identityMatchScore));
    const candidates = scored.filter((match) => match.identityMatchScore === best);
    return candidates.length === 1 ? candidates[0] : null;
}

export function findCreateTableMatchInSql(sql, tableName) {
    const targetParts = identifierPartsFromText(tableName).map((part) => part.value);
    return targetParts.length ? chooseDeclaration(readTableDeclarations(sql), targetParts) : null;
}

function readTabOwners(tabs) {
    // Retain one workspace index, not a SQL history. Tab titles and membership
    // are checked too; cached locations must always expose the current tab.
    const signature = tabs.map((tab) => [tab.id, tab.title, tab.sql, Boolean(tab.isInactive)]);
    if (cachedOwners && signature.length === cachedOwners.signature.length && signature.every((row, i) => row.every((value, j) => value === cachedOwners.signature[i][j]))) return cachedOwners;
    const combined = buildCombinedSql(tabs);
    const schema = sqlToErdSchema(combined.sql);
    const declarations = new Map(tabs.filter((tab) => !tab.isInactive).map((tab) => [tab.id, readTableDeclarations(tab.sql)]));
    const tables = schema.tables.map((table) => {
        const index = table.sourcePosition?.index;
        const range = combined.ranges.find((r) => !r.isInactive && index >= r.start && index < r.end);
        const tab = range && tabs.find((t) => t.id === range.id);
        const match = tab && declarations.get(tab.id).find((declaration) => declaration.index === index - range.start);
        const prefix = table.schemaName ? `${table.schemaName}.` : '';
        const leaf = prefix && table.fullName?.startsWith(prefix) ? table.fullName.slice(prefix.length) : table.fullName || table.name;
        return { table, parts: prefix ? [table.schemaName, leaf] : [leaf], location: match ? { tab, tabId: tab.id, line: match.line, column: match.column, match: { ...match, identityMatchScore: 2 } } : null };
    });
    cachedOwners = { signature, tables, defaultSchema: getSqlDialectProfile(schema.dialect).defaultSchema || DEFAULT_SCHEMA_NAME };
    return cachedOwners;
}

export function findSqlTabTableLocation(tabs, tableName) {
    if (!tableName || !Array.isArray(tabs)) return null;
    const { tables, defaultSchema } = readTabOwners(tabs);
    // Resolve the renderer's exact display identity first. Only surviving
    // CREATE origins own ERD tables; ALTER renames never transfer ownership.
    const exact = tables.filter((entry) => entry.table.name === tableName);
    if (exact.length) return exact.length === 1 ? exact[0].location : null;
    const targetParts = identifierPartsFromText(tableName).map((part) => part.value);
    const candidates = tables.map((entry) => ({ ...entry, score: identifierPartsMatchScore(entry.parts, targetParts, defaultSchema) })).filter((entry) => entry.score > 0);
    const best = Math.max(0, ...candidates.map((entry) => entry.score));
    const matches = candidates.filter((entry) => entry.score === best);
    return matches.length === 1 ? matches[0].location : null;
}

export function findSqlTabForTable(tabs, tableName) {
    return findSqlTabTableLocation(tabs, tableName)?.tab || null;
}
