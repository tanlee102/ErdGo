// ============================================================================
// SHARED DIFF PARSER & MATCHER
// Used by the local bring-your-own-key Gemini editing workflow.
// ============================================================================

// AI providers return lightweight XML-like diff blocks, not guaranteed-valid
// XML. This parser is defensive by design: incomplete or ambiguous tab changes
// become review errors instead of partially editing user SQL.
function parseDiffBlocks(content) {
    const diffs = [];
    const diffRegex = /<diff>\s*<search>([\s\S]*?)<\/search>\s*<replace>([\s\S]*?)<\/replace>\s*<\/diff>/g;
    let match;

    while ((match = diffRegex.exec(content)) !== null) {
        diffs.push({
            search: match[1],
            replace: match[2],
        });
    }

    return diffs;
}

function decodeXml(value) {
    return String(value || '')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function parseAttributes(source) {
    const attributes = {};
    const attributeRegex = /([a-z_]+)\s*=\s*(["'])([\s\S]*?)\2/g;
    let match;

    while ((match = attributeRegex.exec(source)) !== null) {
        attributes[match[1]] = decodeXml(match[3]);
    }

    return attributes;
}

function getExplanationAfter(text, closingTag) {
    const closeIndex = text.indexOf(closingTag);
    return closeIndex >= 0 ? text.slice(closeIndex + closingTag.length).trim() : text.trim();
}

const INCOMPLETE_TAB_RESPONSE_EXPLANATION = 'The AI response was incomplete, so this request was not applied. Please retry with a smaller, tab-specific request.';

function createInvalidTabChanges(reason) {
    return {
        updates: [],
        actions: [{ type: 'invalid', reason }],
        explanation: INCOMPLETE_TAB_RESPONSE_EXPLANATION,
    };
}

function countTags(text, expression) {
    return [...text.matchAll(expression)].length;
}

function isClosedInlineOperation(source, tag) {
    const operation = source.trim();
    return operation.endsWith('/>') || operation.endsWith(`</${tag}>`);
}

function findIncompleteTabOperation(content) {
    const pairedTags = ['update_tab', 'diff', 'search', 'replace', 'create_tab', 'sql', 'rename_tab'];

    for (const tag of pairedTags) {
        const openingCount = countTags(content, new RegExp(`<${tag}\\b[^>]*>`, 'g'));
        const closingCount = countTags(content, new RegExp(`</${tag}>`, 'g'));
        if (openingCount !== closingCount) {
            return `The AI response was truncated or malformed inside <${tag}>. No SQL changes were applied.`;
        }
    }

    return null;
}

function parseTabChanges(text) {
    const tabChangesMatch = text.match(/<tab_changes>([\s\S]*?)<\/tab_changes>/);
    if (!tabChangesMatch) {
        // A started-but-unclosed tab response is unsafe. Return an invalid tab
        // action so the UI can explain the problem without applying partial SQL.
        return text.includes('<tab_changes>') ? createInvalidTabChanges('The AI response was truncated before it closed the <tab_changes> block. No SQL changes were applied.') : null;
    }

    const content = tabChangesMatch[1];
    const incompleteOperation = findIncompleteTabOperation(content);
    if (incompleteOperation) return createInvalidTabChanges(incompleteOperation);

    const updates = [];
    const actions = [];

    // Every parser below checks that the number of parsed operations matches
    // the raw tag count. That catches malformed nested XML before any review
    // object can be built from incomplete AI output.
    const updateRegex = /<update_tab\b([^>]*)>([\s\S]*?)<\/update_tab>/g;
    const updateMatches = [...content.matchAll(updateRegex)];
    if (updateMatches.length !== countTags(content, /<update_tab\b[^>]*>/g)) {
        return createInvalidTabChanges('The AI response contains an invalid <update_tab> operation. No SQL changes were applied.');
    }
    for (const match of updateMatches) {
        const attributes = parseAttributes(match[1]);
        const diffs = parseDiffBlocks(match[2]);
        const tabId = attributes.id || null;
        const tabTitle = attributes.title || attributes.name || null;
        if (!(tabId || tabTitle) || diffs.length === 0) {
            return createInvalidTabChanges('The AI response contains an update without a target tab and complete diff. No SQL changes were applied.');
        }
        updates.push({ ...(tabId && { tabId }), ...(tabTitle && { tabTitle }), diffs });
    }

    const createRegex = /<create_tab\b([^>]*)>\s*<sql>([\s\S]*?)<\/sql>\s*<\/create_tab>/g;
    const createMatches = [...content.matchAll(createRegex)];
    if (createMatches.length !== countTags(content, /<create_tab\b[^>]*>/g)) {
        return createInvalidTabChanges('The AI response contains an invalid <create_tab> operation. No SQL changes were applied.');
    }
    for (const match of createMatches) {
        const attributes = parseAttributes(match[1]);
        if (!attributes.title || !match[2].trim()) {
            return createInvalidTabChanges('The AI response contains a create-tab action without a title and SQL. No SQL changes were applied.');
        }
        actions.push({
            type: 'create',
            position: match.index,
            title: attributes.title,
            ...(attributes.after && { afterTabId: attributes.after }),
            ...(attributes.after_title && { afterTabTitle: attributes.after_title }),
            isInactive: attributes.inactive === 'true',
            sql: match[2].trim(),
        });
    }

    const renameRegex = /<rename_tab\b([^>]*)>([\s\S]*?)<\/rename_tab>/g;
    const renameMatches = [...content.matchAll(renameRegex)];
    if (renameMatches.length !== countTags(content, /<rename_tab\b[^>]*>/g)) {
        return createInvalidTabChanges('The AI response contains an invalid <rename_tab> operation. No SQL changes were applied.');
    }
    for (const match of renameMatches) {
        const attributes = parseAttributes(match[1]);
        const title = decodeXml(match[2]).trim();
        const tabId = attributes.id || null;
        const tabTitle = attributes.title || attributes.name || null;
        if (!(tabId || tabTitle) || !title) {
            return createInvalidTabChanges('The AI response contains a rename action without a target tab and title. No SQL changes were applied.');
        }
        actions.push({ type: 'rename', position: match.index, ...(tabId && { tabId }), ...(tabTitle && { tabTitle }), title });
    }

    const moveRegex = /<move_tab\b([^>]*)\/?>(?:\s*<\/move_tab>)?/g;
    const moveMatches = [...content.matchAll(moveRegex)];
    if (moveMatches.length !== countTags(content, /<move_tab\b/g) || moveMatches.some((item) => !isClosedInlineOperation(item[0], 'move_tab'))) {
        return createInvalidTabChanges('The AI response contains an invalid <move_tab> operation. No SQL changes were applied.');
    }
    for (const match of moveMatches) {
        const attributes = parseAttributes(match[1]);
        const tabId = attributes.id || null;
        const tabTitle = attributes.title || attributes.name || null;
        if (!(tabId || tabTitle)) {
            return createInvalidTabChanges('The AI response contains a move action without a target tab. No SQL changes were applied.');
        }
        actions.push({ type: 'move', position: match.index, ...(tabId && { tabId }), ...(tabTitle && { tabTitle }), ...(attributes.after && { afterTabId: attributes.after }), ...(attributes.after_title && { afterTabTitle: attributes.after_title }) });
    }

    const inactiveRegex = /<set_inactive\b([^>]*)\/?>(?:\s*<\/set_inactive>)?/g;
    const inactiveMatches = [...content.matchAll(inactiveRegex)];
    if (inactiveMatches.length !== countTags(content, /<set_inactive\b/g) || inactiveMatches.some((item) => !isClosedInlineOperation(item[0], 'set_inactive'))) {
        return createInvalidTabChanges('The AI response contains an invalid <set_inactive> operation. No SQL changes were applied.');
    }
    for (const match of inactiveMatches) {
        const attributes = parseAttributes(match[1]);
        const tabId = attributes.id || null;
        const tabTitle = attributes.title || attributes.name || null;
        if (!(tabId || tabTitle) || (attributes.value !== 'true' && attributes.value !== 'false')) {
            return createInvalidTabChanges('The AI response contains an invalid tab activity action. No SQL changes were applied.');
        }
        actions.push({ type: 'setInactive', position: match.index, ...(tabId && { tabId }), ...(tabTitle && { tabTitle }), isInactive: attributes.value === 'true' });
    }

    const moveStatementsRegex = /<move_statements\b([^>]*)\/?>(?:\s*<\/move_statements>)?/g;
    const moveStatementMatches = [...content.matchAll(moveStatementsRegex)];
    if (moveStatementMatches.length !== countTags(content, /<move_statements\b/g) || moveStatementMatches.some((item) => !isClosedInlineOperation(item[0], 'move_statements'))) {
        return createInvalidTabChanges('The AI response contains an invalid <move_statements> operation. No SQL changes were applied.');
    }
    for (const match of moveStatementMatches) {
        const attributes = parseAttributes(match[1]);
        const statementType = (attributes.statement || attributes.type || '').trim().toUpperCase();
        const sourceTabId = attributes.source || null;
        const sourceTabTitle = attributes.source_title || null;
        if (!(sourceTabId || sourceTabTitle) || !attributes.title || !statementType) {
            return createInvalidTabChanges('The AI response contains an invalid move-statements action. No SQL changes were applied.');
        }
        actions.push({
            type: 'moveStatementsToNewTab',
            position: match.index,
            ...(sourceTabId && { sourceTabId }),
            ...(sourceTabTitle && { sourceTabTitle }),
            title: attributes.title,
            ...((attributes.after || attributes.source) && { afterTabId: attributes.after || attributes.source }),
            ...((attributes.after_title || (!attributes.after && !attributes.source ? sourceTabTitle : null)) && { afterTabTitle: attributes.after_title || sourceTabTitle }),
            isInactive: attributes.inactive === 'true',
            statementType,
        });
    }

    const deleteRegex = /<delete_tab\b([^>]*)\/?>(?:\s*<\/delete_tab>)?/g;
    const deleteMatches = [...content.matchAll(deleteRegex)];
    if (deleteMatches.length !== countTags(content, /<delete_tab\b/g) || deleteMatches.some((item) => !isClosedInlineOperation(item[0], 'delete_tab'))) {
        return createInvalidTabChanges('The AI response contains an invalid <delete_tab> operation. No SQL changes were applied.');
    }
    for (const match of deleteMatches) {
        const attributes = parseAttributes(match[1]);
        const tabId = attributes.id || null;
        const tabTitle = attributes.title || attributes.name || null;
        if (!(tabId || tabTitle)) {
            return createInvalidTabChanges('The AI response contains a delete action without a target tab. No SQL changes were applied.');
        }
        actions.push({ type: 'delete', position: match.index, ...(tabId && { tabId }), ...(tabTitle && { tabTitle }) });
    }

    if (updates.length === 0 && actions.length === 0) {
        return createInvalidTabChanges('The AI response did not contain a complete tab operation. No SQL changes were applied.');
    }

    return {
        updates,
        // Preserve the order from the model response. Some actions intentionally
        // depend on previous actions, e.g. rename a tab, then move statements
        // using the new title.
        actions: actions.sort((first, second) => first.position - second.position).map(({ position: _position, ...action }) => action),
        explanation: getExplanationAfter(text, '</tab_changes>'),
    };
}

/**
 * Parse either the legacy whole-document diff response or the tab-aware
 * response. Legacy parsing is intentionally retained for older providers.
 */
export function parseResponse(text) {
    const source = typeof text === 'string' ? text : '';
    const tabChanges = parseTabChanges(source);
    if (tabChanges) {
        return {
            hasDiffs: false,
            diffs: [],
            hasTabChanges: true,
            tabChanges: {
                updates: tabChanges.updates,
                actions: tabChanges.actions,
            },
            explanation: tabChanges.explanation,
        };
    }

    const diffsMatch = source.match(/<diffs>([\s\S]*?)<\/diffs>/);

    // If no <diffs> block found, treat entire text as conversational explanation
    if (!diffsMatch) {
        return {
            hasDiffs: false,
            diffs: [],
            hasTabChanges: false,
            tabChanges: null,
            explanation: source.trim(),
        };
    }

    const diffs = parseDiffBlocks(diffsMatch[1]);

    // If no diffs found inside <diffs> block, treat as conversational
    if (diffs.length === 0) {
        return {
            hasDiffs: false,
            diffs: [],
            hasTabChanges: false,
            tabChanges: null,
            explanation: source.trim(),
        };
    }

    // Extract explanation (everything after </diffs>)
    const explanation = getExplanationAfter(source, '</diffs>');

    return { hasDiffs: true, diffs, hasTabChanges: false, tabChanges: null, explanation };
}

/**
 * Levenshtein distance with early termination
 */
function levenshtein(s1, s2, maxDist = Infinity) {
    const len1 = s1.length,
        len2 = s2.length;
    if (Math.abs(len1 - len2) > maxDist) return maxDist + 1;

    let prev = Array(len2 + 1)
        .fill(0)
        .map((_, i) => i);
    let curr = Array(len2 + 1).fill(0);

    for (let i = 1; i <= len1; i++) {
        curr[0] = i;
        let minRow = i;

        for (let j = 1; j <= len2; j++) {
            const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
            curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
            minRow = Math.min(minRow, curr[j]);
        }

        if (minRow > maxDist) return maxDist + 1;
        [prev, curr] = [curr, prev];
    }

    return prev[len2];
}

/**
 * Calculate similarity score between two strings
 */
function similarity(s1, s2) {
    if (s1 === s2) return 1.0;
    const maxLen = Math.max(s1.length, s2.length);
    if (maxLen === 0) return 1.0;
    const maxDist = Math.ceil(maxLen * 0.25);
    const dist = levenshtein(s1, s2, maxDist);
    return dist > maxDist ? 0 : 1 - dist / maxLen;
}

/**
 * Normalize text for matching
 */
function normalize(text) {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join('\n');
}

/**
 * Map normalized index back to original text index
 */
function mapToOriginal(orig, norm, normIdx) {
    let oIdx = 0,
        nIdx = 0;

    while (nIdx < normIdx && oIdx < orig.length) {
        const oChar = orig[oIdx];
        const nChar = norm[nIdx];

        if (/\s/.test(oChar) && (nIdx >= norm.length || oChar !== nChar)) {
            oIdx++;
        } else if (oChar === nChar) {
            oIdx++;
            nIdx++;
        } else {
            oIdx++;
        }
    }

    return oIdx;
}

/**
 * Find a diff search block. Legacy whole-document diffs can opt into
 * compatibility matching, while tab-aware updates require a unique exact
 * target so an AI response can never modify a similar SQL block by accident.
 */
function findMatch(search, haystack, threshold = 0.75, options = {}) {
    const { exactOnly = false, requireUnique = false } = options;
    const searchTrimmed = search.trim();

    // Handle END marker
    if (searchTrimmed === 'END') {
        return {
            found: true,
            index: haystack.length,
            length: 0,
            score: 1.0,
            method: 'end',
        };
    }

    // Strategy 1: Exact match
    let idx = haystack.indexOf(search);
    if (idx !== -1) {
        if (requireUnique && haystack.indexOf(search, idx + 1) !== -1) {
            return {
                found: false,
                index: -1,
                length: 0,
                score: 1.0,
                method: 'ambiguous-exact',
            };
        }
        return {
            found: true,
            index: idx,
            length: search.length,
            score: 1.0,
            method: 'exact',
        };
    }

    if (exactOnly) {
        return { found: false, score: 0, method: 'exact-required' };
    }

    // Strategy 2: Trimmed exact match
    if (searchTrimmed !== search) {
        idx = haystack.indexOf(searchTrimmed);
        if (idx !== -1) {
            return {
                found: true,
                index: idx,
                length: searchTrimmed.length,
                score: 0.99,
                method: 'exact-trim',
            };
        }
    }

    // Strategy 3: Normalized exact match
    const ns = normalize(search);
    const nh = normalize(haystack);
    idx = nh.indexOf(ns);

    if (idx !== -1) {
        const origIdx = mapToOriginal(haystack, nh, idx);
        return {
            found: true,
            index: origIdx,
            length: search.length,
            score: 0.96,
            method: 'norm-exact',
        };
    }

    // Strategy 4: Fuzzy sliding window
    const sLen = search.length;
    const hLen = haystack.length;

    if (sLen > hLen) {
        return { found: false, score: 0, method: 'none' };
    }

    let best = {
        found: false,
        index: -1,
        length: 0,
        score: 0,
        method: 'fuzzy',
    };

    const minWin = Math.floor(sLen * 0.75);
    const maxWin = Math.min(hLen, Math.ceil(sLen * 1.25));

    // Prioritize exact size, then nearby sizes
    const sizes = [sLen];
    for (let d = 1; d <= Math.ceil(sLen * 0.25); d++) {
        if (sLen - d >= minWin) sizes.push(sLen - d);
        if (sLen + d <= maxWin) sizes.push(sLen + d);
    }

    for (const winSize of sizes) {
        const stride = Math.max(1, Math.floor(winSize * 0.1));

        for (let i = 0; i <= hLen - winSize; i += stride) {
            const candidate = haystack.substring(i, i + winSize);
            const score = similarity(ns, normalize(candidate));

            if (score > best.score) {
                best = {
                    found: score >= threshold,
                    index: i,
                    length: winSize,
                    score,
                    method: 'fuzzy',
                };

                if (score >= 0.95) return best;
            }
        }

        if (best.score >= 0.9) break;
    }

    return best.found ? best : { found: false, score: best.score, method: 'none' };
}

/**
 * Apply diffs to SQL code
 */
export function applyDiffs(sql, diffs, threshold = 0.75, options = {}) {
    let result = sql;
    const applied = [];
    const failed = [];

    for (let i = 0; i < diffs.length; i++) {
        const { search, replace } = diffs[i];

        try {
            const match = findMatch(search, result, threshold, options);

            if (match.found) {
                const before = result.substring(0, match.index);
                const after = result.substring(match.index + match.length);
                result = before + replace + after;

                applied.push({
                    index: i,
                    method: match.method,
                    score: match.score.toFixed(3),
                    searchLen: search.length,
                    replaceLen: replace.length,
                });
            } else {
                failed.push({
                    index: i,
                    method: match.method,
                    bestScore: match.score.toFixed(3),
                    searchPreview: search.substring(0, 50).replace(/\n/g, '↵'),
                });
            }
        } catch (error) {
            failed.push({
                index: i,
                error: error.message,
                searchPreview: search.substring(0, 50).replace(/\n/g, '↵'),
            });
        }
    }

    return {
        success: failed.length === 0,
        result,
        applied,
        failed,
        stats: {
            total: diffs.length,
            applied: applied.length,
            failed: failed.length,
        },
    };
}
