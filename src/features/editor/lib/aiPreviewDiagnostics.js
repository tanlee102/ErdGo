import { sqlToErdSchema } from '@/lib/erdJsonSchema';
import { DiffDisplayer } from './diffAlgorithm';
import { buildCombinedSql, mapDiagnosticsToSqlTabs } from './sqlTabs';

function getPositionValue(error, property, fallbackProperty) {
    return error?.[property] ?? error?.position?.[property] ?? error?.start?.[fallbackProperty];
}

function normalizeDiagnostic(error, index) {
    const rawLine = getPositionValue(error, 'line', 'line');
    const rawColumn = getPositionValue(error, 'column', 'col');
    const line = Number.isInteger(rawLine) && rawLine > 0 ? rawLine : null;
    const column = Number.isInteger(rawColumn) && rawColumn > 0 ? rawColumn : null;
    const severity = error?.severity === 'warning' ? 'warning' : 'error';
    const message = error?.message || 'Unknown SQL diagnostic';

    return {
        ...error,
        id: `ai-preview_${error?.kind || severity}_${line || 'none'}_${column || 'none'}_${index}`,
        message,
        severity,
        line,
        column,
    };
}

function sortDiagnostics(diagnostics, tabs) {
    const tabOrder = new Map((Array.isArray(tabs) ? tabs : []).map((tab, index) => [tab.id, index]));

    return diagnostics.sort((first, second) => {
        if (first.severity !== second.severity) return first.severity === 'error' ? -1 : 1;
        const firstTabOrder = tabOrder.get(first.tabId) ?? Number.MAX_SAFE_INTEGER;
        const secondTabOrder = tabOrder.get(second.tabId) ?? Number.MAX_SAFE_INTEGER;
        if (firstTabOrder !== secondTabOrder) return firstTabOrder - secondTabOrder;
        return (first.line || 0) - (second.line || 0);
    });
}

function createDisplayLineMap(candidateSql, displaySql) {
    if (candidateSql === displaySql) return null;

    const map = new Map();
    // Diagnostics are produced from the candidate SQL, but Monaco may display
    // red/green review lines. Map equal lines back to the visible editor so
    // error jumps land where the user is looking.
    DiffDisplayer.createGitHubStyleDiff(candidateSql, displaySql).forEach((line) => {
        if (line.type === 'equal' && line.originalLine && line.newLine) {
            map.set(line.originalLine, line.newLine);
        }
    });
    return map;
}

function mapDiagnosticsToDisplayLines(diagnostics, candidateTabs, displayTabs, candidateSql, displaySql) {
    if (Array.isArray(candidateTabs) && candidateTabs.length > 0 && Array.isArray(displayTabs) && displayTabs.length > 0) {
        const displayById = new Map(displayTabs.map((tab) => [tab.id, typeof tab.sql === 'string' ? tab.sql : '']));
        const mapsByTabId = new Map();

        // Build maps lazily per tab because only tabs with diagnostics need the
        // candidate-to-display conversion.
        return diagnostics.map((diagnostic) => {
            if (!diagnostic.tabId || !Number.isInteger(diagnostic.line)) return diagnostic;
            if (!mapsByTabId.has(diagnostic.tabId)) {
                const candidateTab = candidateTabs.find((tab) => tab.id === diagnostic.tabId);
                const displayTabSql = displayById.has(diagnostic.tabId) ? displayById.get(diagnostic.tabId) : candidateTab?.sql || '';
                mapsByTabId.set(diagnostic.tabId, candidateTab ? createDisplayLineMap(candidateTab.sql || '', displayTabSql) : null);
            }
            const map = mapsByTabId.get(diagnostic.tabId);
            const line = map?.get(diagnostic.line);
            return line ? { ...diagnostic, line } : diagnostic;
        });
    }

    const map = typeof displaySql === 'string' ? createDisplayLineMap(candidateSql, displaySql) : null;
    return map ? diagnostics.map((diagnostic) => (map.get(diagnostic.line) ? { ...diagnostic, line: map.get(diagnostic.line) } : diagnostic)) : diagnostics;
}

/**
 * Parse the effective AI candidate during review and map its diagnostics to
 * the diff-rendered lines. The shared schema also uses this candidate for the
 * ERD and data tools, while persistence remains on the committed workspace.
 */
export function getAiPreviewDiagnostics({ tabs = null, sql, displayTabs = null, displaySql, activeTabId = null } = {}) {
    const sourceSql = typeof sql === 'string' ? sql : buildCombinedSql(tabs || []).sql;

    let rawDiagnostics;
    try {
        rawDiagnostics = sqlToErdSchema(sourceSql)._parseErrors || [];
    } catch (error) {
        rawDiagnostics = [{ message: `SQL parsing error: ${error.message}`, severity: 'error' }];
    }

    const mappedDiagnostics = Array.isArray(tabs) && tabs.length > 0 ? mapDiagnosticsToSqlTabs(rawDiagnostics, tabs) : rawDiagnostics;
    const displayMappedDiagnostics = mapDiagnosticsToDisplayLines(mappedDiagnostics, tabs, displayTabs, sourceSql, displaySql);
    const all = sortDiagnostics(displayMappedDiagnostics.map(normalizeDiagnostic), tabs);
    const active = Array.isArray(tabs) && tabs.length > 0 ? all.filter((diagnostic) => !diagnostic.tabId || diagnostic.tabId === activeTabId) : all;

    return { all, active };
}
