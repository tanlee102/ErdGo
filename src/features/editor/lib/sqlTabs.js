import { DEFAULT_SCHEMA_NAME } from '@/lib/sqlIdentifierIdentity';

const SQL_TAB_META_VERSION = 2;
export const SQL_TABS_CONTEXT_KEY = 'sqlTabs';
export const INACTIVE_TAB_PLACEHOLDER_SQL = '-- SQL content is stored in inactive tabs.';

// The editor still stores and parses one combined SQL document. Tabs are a UI
// and persistence layer over that document: active tabs compile in creation
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
    return normalizeSql(value).split('\n').length;
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clampRange(value, min, max) {
    if (!Number.isInteger(value)) return null;
    return Math.max(min, Math.min(max, value));
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
    let hasWrittenContent = false;
    const hasInactiveSql = safeTabs.some((tab) => tab?.isInactive && normalizeSql(tab?.sql).trim().length > 0);

    safeTabs.forEach((tab, index) => {
        const isInactive = Boolean(tab?.isInactive);
        const content = isInactive ? '' : normalizeSql(tab?.sql);

        if (content.length > 0 && hasWrittenContent) {
            sql += '\n\n';
        }

        const start = sql.length;
        const startLine = countLines(sql);

        if (content.length > 0) {
            sql += content;
            hasWrittenContent = true;
        }

        const lineCount = content.length > 0 ? countLines(content) : 0;
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
        const start = clampRange(item.start, 0, sourceSql.length);
        const end = clampRange(item.end, 0, sourceSql.length);
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
    return buildCombinedSql(nextTabs).sql === sourceSql ? nextTabs : createFallbackTabsFromContextSql(sourceSql, meta);
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

    // This bridge handles legacy/global writes to `sqlInput`. We only map the
    // change back to a tab when exactly one active tab range was touched; cross-
    // tab edits collapse to a single tab to avoid assigning SQL to the wrong tab.
    const touchedRanges = previous.ranges.filter((range) => !range.isInactive && range.lineCount > 0 && rangeTouchesChange(range, diff.start, diff.previousEnd));
    if (touchedRanges.length !== 1) {
        return createFallbackTabsFromCombinedSql(sourceSql, safeTabs);
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

export function mapDiagnosticToSqlTab(error, tabs) {
    const line = error?.line ?? error?.position?.line;
    if (!Number.isInteger(line) || line < 1) return error;

    const { ranges } = buildCombinedSql(tabs);
    const range = ranges.find((item) => item.lineCount > 0 && line >= item.startLine && line <= item.endLine);
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
    return errors.map((error) => mapDiagnosticToSqlTab(error, tabs));
}

export function mapDiagnosticsToActiveSqlTab(errors, tabs, activeTabId) {
    return mapDiagnosticsToSqlTabs(errors, tabs).filter((error) => !error.tabId || error.tabId === activeTabId);
}

const CREATE_TABLE_PREFIX_REGEX = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL|LOCAL|TEMP|TEMPORARY|VOLATILE|TRANSIENT|UNLOGGED|MULTISET|SET)\s+)*TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/gi;

function getLineColumnAtIndex(sql, index) {
    const safeSql = normalizeSql(sql);
    const safeIndex = Math.max(0, Math.min(index, safeSql.length));
    const previousNewlineIndex = safeSql.lastIndexOf('\n', safeIndex - 1);
    const line = safeSql.slice(0, safeIndex).split('\n').length;

    return {
        line,
        column: safeIndex - previousNewlineIndex,
    };
}

function isCodePosition(sql, targetIndex) {
    const safeSql = normalizeSql(sql);
    let state = null;

    for (let index = 0; index < targetIndex; index += 1) {
        const char = safeSql[index];
        const next = safeSql[index + 1];

        if (state === 'lineComment') {
            if (char === '\n') state = null;
            continue;
        }

        if (state === 'blockComment') {
            if (char === '*' && next === '/') {
                index += 1;
                state = null;
            }
            continue;
        }

        if (state === 'singleQuote') {
            if (char === "'" && next === "'") {
                index += 1;
            } else if (char === "'") {
                state = null;
            }
            continue;
        }

        if (state === 'doubleQuote') {
            if (char === '"' && next === '"') {
                index += 1;
            } else if (char === '"') {
                state = null;
            }
            continue;
        }

        if (state === 'backtick') {
            if (char === '`' && next === '`') {
                index += 1;
            } else if (char === '`') {
                state = null;
            }
            continue;
        }

        if (state === 'bracket') {
            if (char === ']' && next === ']') {
                index += 1;
            } else if (char === ']') {
                state = null;
            }
            continue;
        }

        if (char === '-' && next === '-') {
            index += 1;
            state = 'lineComment';
        } else if (char === '/' && next === '*') {
            index += 1;
            state = 'blockComment';
        } else if (char === "'") {
            state = 'singleQuote';
        } else if (char === '"') {
            state = 'doubleQuote';
        } else if (char === '`') {
            state = 'backtick';
        } else if (char === '[') {
            state = 'bracket';
        }
    }

    return state === null;
}

function skipWhitespace(sql, index) {
    let nextIndex = index;
    while (nextIndex < sql.length && /\s/.test(sql[nextIndex])) {
        nextIndex += 1;
    }
    return nextIndex;
}

function readQuotedIdentifierPart(sql, index, openChar, closeChar = openChar) {
    let nextIndex = index + 1;
    let value = '';

    while (nextIndex < sql.length) {
        const char = sql[nextIndex];
        const next = sql[nextIndex + 1];

        if (char === closeChar && next === closeChar) {
            value += closeChar;
            nextIndex += 2;
            continue;
        }

        if (char === closeChar) {
            return {
                raw: sql.slice(index, nextIndex + 1),
                value,
                endIndex: nextIndex + 1,
            };
        }

        value += char;
        nextIndex += 1;
    }

    return null;
}

function readBareIdentifierPart(sql, index) {
    let nextIndex = index;
    while (nextIndex < sql.length && !/[\s().,;]/.test(sql[nextIndex])) {
        nextIndex += 1;
    }

    const value = sql.slice(index, nextIndex);
    if (!value) return null;

    return {
        raw: value,
        value,
        endIndex: nextIndex,
    };
}

function readIdentifierPart(sql, index) {
    const char = sql[index];
    if (char === '"') return readQuotedIdentifierPart(sql, index, '"');
    if (char === '`') return readQuotedIdentifierPart(sql, index, '`');
    if (char === '[') return readQuotedIdentifierPart(sql, index, '[', ']');
    return readBareIdentifierPart(sql, index);
}

function parseSqlIdentifierAt(sql, startIndex) {
    const safeSql = normalizeSql(sql);
    const parts = [];
    const rawStart = skipWhitespace(safeSql, startIndex);
    let index = rawStart;
    let rawEnd = rawStart;

    while (index < safeSql.length) {
        index = skipWhitespace(safeSql, index);
        const part = readIdentifierPart(safeSql, index);
        if (!part) break;

        parts.push(part.value);
        rawEnd = part.endIndex;
        index = skipWhitespace(safeSql, part.endIndex);

        if (safeSql[index] !== '.') {
            break;
        }

        index += 1;
    }

    if (parts.length === 0) return null;

    return {
        parts,
        raw: safeSql.slice(rawStart, rawEnd),
        startIndex: rawStart,
        endIndex: index,
    };
}

function cleanIdentifierTextPart(part) {
    const value = normalizeSql(part).trim();
    if (!value) return '';

    if (value.startsWith('"') && value.endsWith('"')) {
        return value.slice(1, -1).replace(/""/g, '"');
    }
    if (value.startsWith('`') && value.endsWith('`')) {
        return value.slice(1, -1).replace(/``/g, '`');
    }
    if (value.startsWith('[') && value.endsWith(']')) {
        return value.slice(1, -1).replace(/]]/g, ']');
    }

    return value;
}

function splitIdentifierText(value) {
    const text = normalizeSql(value).trim();
    if (!text) return [];

    const parts = [];
    let current = '';
    let state = null;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];

        if (state === 'doubleQuote') {
            current += char;
            if (char === '"' && next === '"') {
                current += next;
                index += 1;
            } else if (char === '"') {
                state = null;
            }
            continue;
        }

        if (state === 'backtick') {
            current += char;
            if (char === '`' && next === '`') {
                current += next;
                index += 1;
            } else if (char === '`') {
                state = null;
            }
            continue;
        }

        if (state === 'bracket') {
            current += char;
            if (char === ']' && next === ']') {
                current += next;
                index += 1;
            } else if (char === ']') {
                state = null;
            }
            continue;
        }

        if (char === '"') {
            state = 'doubleQuote';
            current += char;
        } else if (char === '`') {
            state = 'backtick';
            current += char;
        } else if (char === '[') {
            state = 'bracket';
            current += char;
        } else if (char === '.') {
            parts.push(cleanIdentifierTextPart(current));
            current = '';
        } else {
            current += char;
        }
    }

    parts.push(cleanIdentifierTextPart(current));
    return parts.filter(Boolean);
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

function withDefaultSchema(parts) {
    return parts.length === 1 && !parts[0].includes('.') ? [DEFAULT_SCHEMA_NAME, ...parts] : parts;
}

function identifierPartsMatch(candidateParts, targetParts) {
    const candidate = normalizedIdentifierParts(candidateParts);
    const target = normalizedIdentifierParts(targetParts);
    if (candidate.length === 0 || target.length === 0) return false;

    if (target.length === 1) {
        return candidate[candidate.length - 1] === target[0];
    }

    const candidateWithDefault = withDefaultSchema(candidate);
    const targetWithDefault = withDefaultSchema(target);
    if (identifierPartsEqual(candidateWithDefault, targetWithDefault)) return true;

    return false;
}

export function findCreateTableMatchInSql(sql, tableName) {
    const safeSql = normalizeSql(sql);
    const targetParts = splitIdentifierText(tableName);
    if (targetParts.length === 0) return null;

    // Regex finds only CREATE TABLE prefixes. Identifier parsing then verifies
    // schema-qualified and quoted names while `isCodePosition` skips comments
    // and string literals.
    const prefixRegex = new RegExp(CREATE_TABLE_PREFIX_REGEX.source, CREATE_TABLE_PREFIX_REGEX.flags);
    let match;

    while ((match = prefixRegex.exec(safeSql))) {
        if (!isCodePosition(safeSql, match.index)) continue;

        const identifier = parseSqlIdentifierAt(safeSql, prefixRegex.lastIndex);
        if (!identifier || !identifierPartsMatch(identifier.parts, targetParts)) continue;

        const start = getLineColumnAtIndex(safeSql, match.index);
        const identifierStart = getLineColumnAtIndex(safeSql, identifier.startIndex);

        return {
            index: match.index,
            line: start.line,
            column: start.column,
            identifierIndex: identifier.startIndex,
            identifierLine: identifierStart.line,
            identifierColumn: identifierStart.column,
            identifier: identifier.raw,
            tableName: identifier.parts[identifier.parts.length - 1],
            tableParts: identifier.parts,
        };
    }

    return null;
}

export function findSqlTabTableLocation(tabs, tableName) {
    if (!tableName || !Array.isArray(tabs)) return null;

    // Inactive tabs are saved drafts only. They do not own rendered ERD tables,
    // parse diagnostics, table jumps, or table-deletion targets.
    for (const tab of tabs) {
        if (tab?.isInactive) continue;
        const match = findCreateTableMatchInSql(tab?.sql, tableName);
        if (match) {
            return {
                tab,
                tabId: tab.id,
                line: match.line,
                column: match.column,
                match,
            };
        }
    }

    return null;
}

export function findSqlTabForTable(tabs, tableName) {
    return findSqlTabTableLocation(tabs, tableName)?.tab || null;
}
