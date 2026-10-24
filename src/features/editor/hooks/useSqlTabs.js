import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { deleteTableFromSql, getTableDeletionInfo } from '@/lib/deleteTableFromSql';
import { parseAST } from '@/lib/parse-ast/parseAst';
import { DEFAULT_SCHEMA_NAME, identifierPartsEquivalent, identifierPartsFrom } from '@/lib/sqlIdentifierIdentity';
import { prepareCanvasEditInTabs } from '@/features/editor/lib/canvasSchemaEdits';
import { detectEditorSqlDialect } from '@/features/editor/lib/sqlDialectDetection';
import { getRelationshipReconnectTargetsInTabs, reconnectRelationshipInTabs } from '@/features/editor/lib/relationshipReconnect';
import {
    SQL_TABS_CONTEXT_KEY,
    buildCombinedSql,
    createSqlTab,
    createSingleSqlTab,
    findSqlTabTableLocation,
    getActiveSqlTabIdFromContext,
    getDirtySqlTabIds,
    getSqlTabsMeta,
    hydrateSqlTabsFromContext,
    mapDiagnosticsToActiveSqlTab,
    mapDiagnosticsToSqlTabs,
    mergeActiveSqlTabs,
    reconcileSqlTabsFromCombinedSql,
    serializeSqlTabs,
} from '@/features/editor/lib/sqlTabs';

function getFirstTabId(tabs) {
    return Array.isArray(tabs) && tabs.length > 0 ? tabs[0].id : null;
}

function getNextTitle(tabs) {
    const titleKeys = new Set(tabs.map((tab) => String(tab?.title || '').trim().toLowerCase()));
    let number = 1;
    while (titleKeys.has(`sql ${number}`)) {
        number += 1;
    }
    return `SQL ${number}`;
}

function getCopyTitle(tabs, title) {
    const baseTitle = `${title || 'SQL'} copy`;
    const titleKeys = new Set(tabs.map((tab) => String(tab?.title || '').trim().toLowerCase()));
    if (!titleKeys.has(baseTitle.toLowerCase())) return baseTitle;

    let copyIndex = 2;
    while (titleKeys.has(`${baseTitle} ${copyIndex}`.toLowerCase())) {
        copyIndex += 1;
    }
    return `${baseTitle} ${copyIndex}`;
}

function getUniqueImportedTitle(usedTitles, requestedTitle) {
    const baseTitle = String(requestedTitle || 'Imported SQL').trim() || 'Imported SQL';
    if (!usedTitles.has(baseTitle.toLowerCase())) {
        usedTitles.add(baseTitle.toLowerCase());
        return baseTitle;
    }

    let suffix = 2;
    while (usedTitles.has(`${baseTitle} ${suffix}`.toLowerCase())) suffix += 1;
    const uniqueTitle = `${baseTitle} ${suffix}`;
    usedTitles.add(uniqueTitle.toLowerCase());
    return uniqueTitle;
}

function moveItem(items, fromIndex, toIndex) {
    const nextItems = [...items];
    const [item] = nextItems.splice(fromIndex, 1);
    nextItems.splice(toIndex, 0, item);
    return nextItems;
}

function getWorkspaceIdentifierOptions(tabs) {
    const combinedSql = buildCombinedSql(tabs).sql;
    if (!combinedSql.trim()) return {};

    try {
        const { ast } = parseAST(combinedSql);
        return ast?.dialect ? { dialect: ast.dialect } : {};
    } catch {
        return {};
    }
}

function getTabsAfterTableDeletion(tabs, tableName) {
    let changed = false;
    const ownerLocation = findSqlTabTableLocation(tabs, tableName);
    if (getTableDeletionBlockReason(tabs, ownerLocation)) return null;
    const identifierOptions = {
        ...getWorkspaceIdentifierOptions(tabs),
        targetIdentifier: ownerLocation?.match?.identifier || tableName,
    };
    const nextTabs = tabs.map((tab) => {
        if (tab.isInactive) return tab;

        // Table deletion is tab-local, but FK cleanup may affect other active
        // tabs. Keep dependent columns and remove only FK constraints so the
        // user's surrounding schema remains intact.
        const nextSql = deleteTableFromSql(tab.sql, tableName, {
            removeReferencesWhenTargetMissing: true,
            preserveReferencingColumns: true,
            ...identifierOptions,
        });
        if (nextSql === tab.sql) return tab;
        changed = true;
        return { ...tab, sql: nextSql };
    });

    return changed ? nextTabs : null;
}

function getTableDeletionBlockReason(tabs, ownerLocation) {
    if (!ownerLocation) return 'The table has no unambiguous SQL tab owner. Use its qualified name in SQL.';
    const { ast } = parseAST(buildCombinedSql(tabs).sql);
    const target = identifierPartsFrom(ownerLocation.match.identifier);
    const defaultSchema = ast.dialectProfile?.defaultSchema || DEFAULT_SCHEMA_NAME;
    const matches = (name, parts) => identifierPartsEquivalent(target, identifierPartsFrom(name, parts), defaultSchema, ast.dialect);
    // The existing deletion engine matches names, not table incarnations.
    // Never let a repeated name remove a dropped/renamed table's CREATE or
    // a later replacement. Source jumps can still use precise provenance.
    if (ast.tables.filter((table) => matches(table.name, table.nameParts)).length > 1
        || ast.drops.some((drop) => drop.kind === 'table' && matches(drop.name, drop.nameParts))
        || ast.alters.some((alter) => alter.action === 'rename_table' && matches(alter.table, alter.tableParts))) {
        return 'This table is part of a rename or drop/recreate migration. Delete the intended table at the correct point in SQL.';
    }
    return null;
}

function createSavedTabsSnapshot(savedSql, savedContext, currentTabs = []) {
    const snapshot = hydrateSqlTabsFromContext(typeof savedSql === 'string' ? savedSql : '', savedContext);
    const hasSavedTabMeta = Boolean(getSqlTabsMeta(savedContext));

    if (!hasSavedTabMeta && snapshot.length === 1 && currentTabs.length === 1) {
        return [{ ...snapshot[0], id: currentTabs[0].id }];
    }
    const persistedIds = new Set(getSqlTabsMeta(savedContext)?.tabs.map((tab) => tab?.id));
    // Hydrating corrupt/missing IDs repairs them with fresh workspace IDs.
    // Reuse that repair for the saved baseline when its content still matches;
    // generating another ID would mark an untouched loaded tab dirty.
    return snapshot.map((tab, index) => {
        const current = currentTabs[index];
        return !persistedIds.has(tab.id) && current && current.sql === tab.sql && current.title === tab.title && Boolean(current.isInactive) === Boolean(tab.isInactive)
            ? { ...tab, id: current.id } : tab;
    });
}

/**
 * Owns the SQL tab workspace while preserving the legacy single `sqlInput`
 * contract. Every tab mutation still compiles back to one combined SQL string
 * so older editor, renderer, save, and AI paths can continue reading the same
 * root value.
 */
export function useSqlTabs({ sqlInput, setSqlInput, loadVersion, savedSql, savedContext, erdContextRef, onContextChange, isLoading = false }) {
    const [tabs, setTabs] = useState(() => createSingleSqlTab(sqlInput || ''));
    const [savedTabsSnapshot, setSavedTabsSnapshot] = useState(() => tabs);
    const [activeTabId, setActiveTabId] = useState(() => getFirstTabId(tabs));
    const [hydrationVersion, setHydrationVersion] = useState(0);

    const tabsRef = useRef(tabs);
    const activeTabIdRef = useRef(activeTabId);
    const lastCombinedSqlRef = useRef(buildCombinedSql(tabs).sql);
    const manualCommitVersionRef = useRef(0);
    const renderManualCommitVersion = manualCommitVersionRef.current;

    // Hydration, commitTabs and activateTab update refs before state. Mirroring
    // older render state in passive effects can overwrite those newer writes,
    // including the repaired IDs needed by the initial saved baseline.

    const syncContext = useCallback(
        (nextTabs = tabsRef.current, nextActiveTabId = activeTabIdRef.current) => {
            if (!erdContextRef?.current) return false;

            // Active tab selection is part of file context, not SQL text. This
            // lets reload restore and scroll to the selected tab without dirtying
            // the combined SQL document.
            erdContextRef.current = {
                ...erdContextRef.current,
                [SQL_TABS_CONTEXT_KEY]: serializeSqlTabs(nextTabs, nextActiveTabId),
            };
            return true;
        },
        [erdContextRef],
    );

    const commitTabs = useCallback(
        (nextTabs, options = {}) => {
            const safeTabs = Array.isArray(nextTabs) && nextTabs.length > 0 ? nextTabs : createSingleSqlTab('');
            const nextActiveId = options.activeTabId || (safeTabs.some((tab) => tab.id === activeTabIdRef.current) ? activeTabIdRef.current : getFirstTabId(safeTabs));
            const combined = buildCombinedSql(safeTabs).sql;

            // Central write path for tabs. Keep refs in lock-step with React
            // state so immediate follow-up actions (AI accept, save, ERD redraw)
            // read the just-committed workspace before React finishes rendering.
            manualCommitVersionRef.current += 1;
            tabsRef.current = safeTabs;
            activeTabIdRef.current = nextActiveId;
            lastCombinedSqlRef.current = combined;

            setTabs(safeTabs);
            setActiveTabId(nextActiveId);

            if (options.writeSql !== false) {
                setSqlInput(combined);
            }

            if (options.syncContext !== false) {
                syncContext(safeTabs, nextActiveId);
            }

            if (options.notifyContextChanged) {
                onContextChange?.(options.contextChangeReason);
            }

            return combined;
        },
        [onContextChange, setSqlInput, syncContext],
    );
    const commitTabsRef = useRef(commitTabs);
    useEffect(() => {
        commitTabsRef.current = commitTabs;
    }, [commitTabs]);

    // Hydrate before paint. On /e/new the sample dialog can appear immediately;
    // a very fast click must not beat an older blank hydration effect.
    useLayoutEffect(() => {
        if (isLoading) return;
        if (manualCommitVersionRef.current !== renderManualCommitVersion) return;

        const nextTabs = hydrateSqlTabsFromContext(sqlInput || '', savedContext);
        const combined = buildCombinedSql(nextTabs).sql;
        const nextActiveId = getActiveSqlTabIdFromContext(savedContext, nextTabs) || getFirstTabId(nextTabs);

        tabsRef.current = nextTabs;
        activeTabIdRef.current = nextActiveId;
        lastCombinedSqlRef.current = combined;

        setTabs(nextTabs);
        setSavedTabsSnapshot(nextTabs);
        setActiveTabId(nextActiveId);
        setHydrationVersion((version) => version + 1);
        // Hydration mirrors persisted state. Do not write context here, or old
        // single-document files would become dirty immediately after loading.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isLoading, loadVersion]);

    useEffect(() => {
        if (typeof savedSql !== 'string') return;
        setSavedTabsSnapshot(createSavedTabsSnapshot(savedSql, savedContext, tabsRef.current));
    }, [savedSql, savedContext]);

    useEffect(() => {
        const nextSql = typeof sqlInput === 'string' ? sqlInput : '';
        if (nextSql === lastCombinedSqlRef.current) return;

        // Some older features still write the global SQL string directly. When
        // that happens, reconcile the edit back into tabs instead of letting
        // tab state drift away from `sqlInput`.
        const nextTabs = reconcileSqlTabsFromCombinedSql(tabsRef.current, nextSql);
        const nextActiveId = nextTabs.some((tab) => tab.id === activeTabIdRef.current) ? activeTabIdRef.current : getFirstTabId(nextTabs);

        commitTabsRef.current(nextTabs, {
            activeTabId: nextActiveId,
            writeSql: false,
            syncContext: true,
            notifyContextChanged: false,
        });
        // This bridge must run only for an actual root SQL change. Depending on
        // `commitTabs` would also rerun it when callback props change identity,
        // while the parent may still expose the pre-commit SQL for one render.
    }, [sqlInput]);

    const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId) || tabs[0] || createSingleSqlTab('')[0], [activeTabId, tabs]);

    const combinedSql = useMemo(() => buildCombinedSql(tabs).sql, [tabs]);

    const dialectDetection = useMemo(() => detectEditorSqlDialect(activeTab.sql, combinedSql), [activeTab.sql, combinedSql]);
    // Global Add Table stays mounted while hidden. Read current refs when it
    // opens so switching tabs also refreshes its default without a SQL edit.
    const getSqlDialectDetection = useCallback(() => {
        const focusedTab = tabsRef.current.find((tab) => tab.id === activeTabIdRef.current);
        return detectEditorSqlDialect(focusedTab?.sql || '', buildCombinedSql(tabsRef.current).sql);
    }, []);

    const getAddTableContext = useCallback(() => {
        const current = tabsRef.current;
        const index = current.findIndex(tab => tab.id === activeTabIdRef.current);
        if (index < 0) return null;
        // Include the focused inactive draft for validation only. Other inactive
        // tabs remain private, and later active tabs are not forward FK targets.
        const before = current.slice(0, index + 1).map((tab, i) => i === index ? { ...tab, isInactive: false } : tab);
        return { beforeSql: buildCombinedSql(before).sql, afterSql: buildCombinedSql(current.slice(index + 1)).sql,
            revision: JSON.stringify([loadVersion, activeTabIdRef.current, current.map(tab => [tab.id, tab.sql, tab.isInactive === true])]) };
    }, [loadVersion]);

    const canvasLoadVersionRef = useRef(loadVersion);
    useLayoutEffect(() => { canvasLoadVersionRef.current = loadVersion; }, [loadVersion]);
    const editCanvasSchema = useCallback((action, { preview = false, expectedRevision = null } = {}) => {
        const previousTabs = tabsRef.current;
        const snapshot = (list) => JSON.stringify(list.map((tab) => [tab.id, tab.sql, tab.isInactive === true]));
        const revision = JSON.stringify([loadVersion, snapshot(previousTabs)]);
        if (expectedRevision && expectedRevision !== revision) return { ok: false, message: 'SQL changed while reviewing this action. Try again to see its current impact.' };
        const result = prepareCanvasEditInTabs(previousTabs, action);
        if (!result.ok || preview) return { ok: result.ok, message: result.message, impacts: result.impacts, revision, ...(result.canCascade ? { canCascade: true } : {}) };
        if (action.kind === 'add-column' && erdContextRef?.current?.tableCompactModes?.[action.table] === true) {
            // Reveal the new field immediately; other tables keep their views.
            erdContextRef.current = { ...erdContextRef.current, tableCompactModes: { ...erdContextRef.current.tableCompactModes, [action.table]: false } };
        }
        commitTabs(result.nextTabs, { syncContext: true, notifyContextChanged: true });
        const committed = snapshot(result.nextTabs);
        const undo = () => {
            if (canvasLoadVersionRef.current !== loadVersion || snapshot(tabsRef.current) !== committed) return false;
            const oldSql = new Map(previousTabs.map((tab) => [tab.id, tab.sql]));
            commitTabs(tabsRef.current.map((tab) => ({ ...tab, sql: oldSql.get(tab.id) })), { syncContext: true, notifyContextChanged: true });
            return true;
        };
        return { ...result, revision, undo };
    }, [commitTabs, erdContextRef, loadVersion]);

    const getRelationshipReconnectTargets = useCallback(async (relation, endpoint) => {
        const previousTabs = tabsRef.current;
        const result = await getRelationshipReconnectTargetsInTabs(previousTabs, relation, endpoint);
        // Suggestions may yield while the user edits SQL. Discard that result;
        // commit also validates independently against the current refs.
        if (tabsRef.current !== previousTabs) return { ok: false, targets: [], message: 'SQL tabs changed. Reopen the connector to refresh its choices.' };
        return result;
    }, []);

    const reconnectRelationship = useCallback((relation, endpoint, target, { preview = false } = {}) => {
        // Revalidate against live refs at release, including edits made while a
        // connector was being dragged. Never write into the focused tab by default.
        const previousTabs = tabsRef.current;
        const result = reconnectRelationshipInTabs(previousTabs, relation, endpoint, target);
        let undo;
        if (result.ok && !result.unchanged && !preview) {
            commitTabs(result.nextTabs, { syncContext: true, notifyContextChanged: true });
            const snapshot = (tabs) => JSON.stringify(tabs.map((tab) => [tab.id, tab.sql, tab.isInactive === true]));
            const committedSnapshot = snapshot(result.nextTabs);
            undo = () => {
                // Never overwrite SQL edits made after this reconnect. Cosmetic
                // tab renames and focus changes are retained when undo is safe.
                if (canvasLoadVersionRef.current !== loadVersion || snapshot(tabsRef.current) !== committedSnapshot) return false;
                const oldSql = new Map(previousTabs.map((tab) => [tab.id, tab.sql]));
                commitTabs(tabsRef.current.map((tab) => ({ ...tab, sql: oldSql.get(tab.id) })), { syncContext: true, notifyContextChanged: true });
                return true;
            };
        }
        return { ok: result.ok, unchanged: result.unchanged, message: result.message, undo };
    }, [commitTabs, loadVersion]);

    const dirtyTabIds = useMemo(() => getDirtySqlTabIds(tabs, savedTabsSnapshot), [savedTabsSnapshot, tabs]);

    const setActiveTabSql = useCallback(
        (nextSql) => {
            const activeTab = tabsRef.current.find((tab) => tab.id === activeTabIdRef.current);
            const nextTabs = tabsRef.current.map((tab) => (tab.id === activeTabIdRef.current ? { ...tab, sql: typeof nextSql === 'string' ? nextSql : '' } : tab));
            // Editing an inactive tab changes saved context but not compiled SQL,
            // so notify change tracking even when the combined SQL is unchanged.
            commitTabs(nextTabs, { syncContext: true, notifyContextChanged: Boolean(activeTab?.isInactive) });
        },
        [commitTabs],
    );

    const appendSqlToActiveTab = useCallback(
        (sqlToAppend, { expectedRevision = null } = {}) => {
            if (expectedRevision && getAddTableContext()?.revision !== expectedRevision) return false;
            const addition = typeof sqlToAppend === 'string' ? sqlToAppend.trim() : '';
            const activeTab = tabsRef.current.find((tab) => tab.id === activeTabIdRef.current);
            if (!addition || !activeTab) return false;

            const nextSql = activeTab.sql.trim() ? `${activeTab.sql}\n\n${addition}` : addition;
            const nextTabs = tabsRef.current.map((tab) => (tab.id === activeTab.id ? { ...tab, sql: nextSql } : tab));
            commitTabs(nextTabs, { syncContext: true, notifyContextChanged: true });
            return true;
        },
        [commitTabs, getAddTableContext],
    );

    const deleteTableFromTabs = useCallback(
        (tableName) => {
            if (!tableName) return false;

            const nextTabs = getTabsAfterTableDeletion(tabsRef.current, tableName);
            if (!nextTabs) return false;
            commitTabs(nextTabs, { syncContext: true, notifyContextChanged: true });
            return true;
        },
        [commitTabs],
    );

    const getTableOwner = useCallback((tableName) => {
        const location = findSqlTabTableLocation(tabsRef.current, tableName);
        if (!location) return null;

        return {
            tabId: location.tabId,
            title: location.tab.title,
            line: location.line,
            column: location.column,
        };
    }, []);

    const getTableOwners = useCallback(
        (tableNames) => {
            if (!Array.isArray(tableNames)) return {};
            return tableNames.reduce((owners, tableName) => {
                const owner = getTableOwner(tableName);
                if (owner) owners[tableName] = owner;
                return owners;
            }, {});
        },
        [getTableOwner],
    );

    const getTableDeletionPreview = useCallback(
        (tableName) => {
            const owner = getTableOwner(tableName);
            const references = [];
            const ownerLocation = findSqlTabTableLocation(tabsRef.current, tableName);
            const blockedReason = getTableDeletionBlockReason(tabsRef.current, ownerLocation);
            if (blockedReason) return { tableName, owner, references, blockedReason };
            const identifierOptions = {
                ...getWorkspaceIdentifierOptions(tabsRef.current),
                targetIdentifier: ownerLocation?.match?.identifier || tableName,
            };

            tabsRef.current.forEach((tab) => {
                if (tab.isInactive) return;

                const info = getTableDeletionInfo(tab.sql, tableName, identifierOptions);
                info.items
                    .filter((item) => item.type !== 'table')
                    .forEach((item) => {
                        references.push({
                            tabId: tab.id,
                            tabTitle: tab.title,
                            table: item.table || item.name,
                            columns: item.columns || [],
                            type: item.type,
                            description: item.description,
                        });
                    });
            });

            return { tableName, owner, references };
        },
        [getTableOwner],
    );

    const addTab = useCallback(() => {
        const nextTab = createSqlTab({
            title: getNextTitle(tabsRef.current),
            sql: '',
            createdAt: Date.now(),
        });
        commitTabs([...tabsRef.current, nextTab], {
            activeTabId: nextTab.id,
            syncContext: true,
            notifyContextChanged: true,
        });
    }, [commitTabs]);

    const importSqlFiles = useCallback(
        (importFiles) => {
            const safeFiles = Array.isArray(importFiles) ? importFiles.filter((file) => typeof file?.sql === 'string' && file.sql.trim()) : [];
            if (safeFiles.length === 0) return [];

            const currentTabs = tabsRef.current;
            // The untouched tab behind the new-file chooser is scaffolding, not
            // user content. Replace it so every selected file maps to exactly one
            // visible tab; append to any established workspace.
            const replaceBlankWorkspace = currentTabs.length === 1 && !currentTabs[0]?.isInactive && !currentTabs[0]?.sql?.trim();
            const retainedTabs = replaceBlankWorkspace ? [] : currentTabs;
            const usedTitles = new Set(retainedTabs.map((tab) => String(tab?.title || '').trim().toLowerCase()));
            const importedAt = Date.now();
            const importedTabs = safeFiles.map((file, index) =>
                createSqlTab({
                    title: getUniqueImportedTitle(usedTitles, file.title || file.name),
                    sql: file.sql,
                    createdAt: importedAt + index,
                }),
            );
            const nextTabs = [...retainedTabs, ...importedTabs];

            commitTabs(nextTabs, {
                activeTabId: importedTabs[0].id,
                syncContext: true,
                notifyContextChanged: true,
            });
            return importedTabs;
        },
        [commitTabs],
    );

    const getSampleDataContext = useCallback(() => ({
        sql: buildCombinedSql(tabsRef.current).sql,
        revision: JSON.stringify([canvasLoadVersionRef.current, tabsRef.current.map(tab => [tab.id, tab.sql, tab.isInactive === true])]),
    }), []);

    const insertSampleDataTab = useCallback((sql, expectedRevision) => {
        // A generated fixture belongs to the exact committed workspace that
        // supplied its keys. Never apply it to changed SQL or a reloaded file.
        if (!expectedRevision || getSampleDataContext().revision !== expectedRevision) {
            return { ok: false, message: 'The SQL workspace changed. Close the generator and open it again to generate fresh data.' };
        }
        if (typeof sql !== 'string' || !sql.trim()) return { ok: false, message: 'Generate a preview before inserting data.' };
        importSqlFiles([{ title: 'Sample Data', sql }]);
        return { ok: true };
    }, [getSampleDataContext, importSqlFiles]);

    const removeTab = useCallback(
        (tabId = activeTabIdRef.current) => {
            const currentTabs = tabsRef.current;
            if (currentTabs.length <= 1) return false;

            const removeIndex = currentTabs.findIndex((tab) => tab.id === tabId);
            if (removeIndex < 0) return false;

            const nextTabs = currentTabs.filter((tab) => tab.id !== tabId);
            // Closing a background tab must not pull the user away from the
            // tab they are editing. Pick a neighbor only when the active tab
            // itself was closed.
            const activeTabWasClosed = tabId === activeTabIdRef.current;
            const nextActiveTab = activeTabWasClosed
                ? currentTabs[removeIndex + 1] || currentTabs[removeIndex - 1] || nextTabs[0]
                : nextTabs.find((tab) => tab.id === activeTabIdRef.current) || nextTabs[0];

            commitTabs(nextTabs, {
                activeTabId: nextActiveTab?.id,
                syncContext: true,
                notifyContextChanged: true,
            });
            return true;
        },
        [commitTabs],
    );

    const duplicateTab = useCallback(
        (tabId = activeTabIdRef.current) => {
            const currentTabs = tabsRef.current;
            const sourceIndex = currentTabs.findIndex((tab) => tab.id === tabId);
            if (sourceIndex < 0) return false;

            const sourceTab = currentTabs[sourceIndex];
            const nextTab = createSqlTab({
                title: getCopyTitle(currentTabs, sourceTab.title),
                sql: sourceTab.sql,
                createdAt: Date.now(),
                // Duplicates start inactive so copying large DML or scratch SQL
                // never changes ERD/data output until the user activates it.
                isInactive: true,
            });
            const nextTabs = [...currentTabs.slice(0, sourceIndex + 1), nextTab, ...currentTabs.slice(sourceIndex + 1)];

            commitTabs(nextTabs, {
                activeTabId: nextTab.id,
                syncContext: true,
                notifyContextChanged: true,
            });
            return true;
        },
        [commitTabs],
    );

    const toggleTabInactive = useCallback(
        (tabId = activeTabIdRef.current) => {
            const currentTabs = tabsRef.current;
            const currentTab = currentTabs.find((tab) => tab.id === tabId);
            if (!currentTab) return false;

            const nextTabs = currentTabs.map((tab) => (tab.id === tabId ? { ...tab, isInactive: !tab.isInactive } : tab));
            commitTabs(nextTabs, {
                activeTabId: activeTabIdRef.current,
                syncContext: true,
                notifyContextChanged: true,
            });
            return true;
        },
        [commitTabs],
    );

    const closeOtherTabs = useCallback(
        (tabId = activeTabIdRef.current) => {
            const currentTabs = tabsRef.current;
            if (currentTabs.length <= 1) return false;

            const tabToKeep = currentTabs.find((tab) => tab.id === tabId);
            if (!tabToKeep) return false;

            commitTabs([tabToKeep], {
                activeTabId: tabToKeep.id,
                syncContext: true,
                notifyContextChanged: true,
            });
            return true;
        },
        [commitTabs],
    );

    const moveTab = useCallback(
        (tabId, direction) => {
            const safeDirection = direction > 0 ? 1 : direction < 0 ? -1 : 0;
            if (safeDirection === 0) return false;

            const currentTabs = tabsRef.current;
            const currentIndex = currentTabs.findIndex((tab) => tab.id === tabId);
            if (currentIndex < 0) return false;

            const nextIndex = currentIndex + safeDirection;
            if (nextIndex < 0 || nextIndex >= currentTabs.length) return false;

            commitTabs(moveItem(currentTabs, currentIndex, nextIndex), {
                activeTabId: activeTabIdRef.current,
                syncContext: true,
                notifyContextChanged: true,
            });
            return true;
        },
        [commitTabs],
    );

    const reorderTab = useCallback(
        (tabId, targetTabId) => {
            if (tabId === targetTabId) return false;

            const currentTabs = tabsRef.current;
            const currentIndex = currentTabs.findIndex((tab) => tab.id === tabId);
            const targetIndex = currentTabs.findIndex((tab) => tab.id === targetTabId);
            if (currentIndex < 0 || targetIndex < 0) return false;

            commitTabs(moveItem(currentTabs, currentIndex, targetIndex), {
                activeTabId: activeTabIdRef.current,
                syncContext: true,
                notifyContextChanged: true,
            });
            return true;
        },
        [commitTabs],
    );

    const renameTab = useCallback(
        (tabId, title) => {
            const nextTitle = typeof title === 'string' ? title.trim() : '';
            if (!nextTitle) return false;

            const currentTabs = tabsRef.current;
            const currentTab = currentTabs.find((tab) => tab.id === tabId);
            if (!currentTab || currentTab.title === nextTitle) return false;

            const nextTabs = currentTabs.map((tab) => (tab.id === tabId ? { ...tab, title: nextTitle } : tab));
            commitTabs(nextTabs, {
                activeTabId: activeTabIdRef.current,
                // A title change is saved in context only. Avoid rewriting SQL
                // so a pure rename does not disturb editor content or cursor.
                writeSql: false,
                syncContext: true,
                notifyContextChanged: true,
                contextChangeReason: 'tab-title',
            });
            return true;
        },
        [commitTabs],
    );

    const activateTab = useCallback((tabId) => {
        if (!tabsRef.current.some((tab) => tab.id === tabId)) return;
        if (activeTabIdRef.current === tabId) return;
        activeTabIdRef.current = tabId;
        setActiveTabId(tabId);
        // Selection is persisted immediately so reload restores the last viewed
        // tab even if the user did not edit SQL after switching tabs.
        syncContext(tabsRef.current, tabId);
        onContextChange?.();
    }, [onContextChange, syncContext]);

    const replaceWithSingleTab = useCallback(
        (nextSql, title = 'SQL 1') => {
            const nextTabs = createSingleSqlTab(nextSql || '', title);
            commitTabs(nextTabs, {
                activeTabId: getFirstTabId(nextTabs),
                syncContext: true,
                notifyContextChanged: true,
            });
        },
        [commitTabs],
    );

    const applyTabs = useCallback(
        (nextTabs, preferredActiveTabId = activeTabIdRef.current) => {
            const safeTabs = Array.isArray(nextTabs) && nextTabs.length > 0 ? nextTabs : createSingleSqlTab('');
            const nextActiveTabId = safeTabs.some((tab) => tab.id === preferredActiveTabId) ? preferredActiveTabId : getFirstTabId(safeTabs);

            return commitTabs(safeTabs, {
                activeTabId: nextActiveTabId,
                syncContext: true,
                notifyContextChanged: true,
            });
        },
        [commitTabs],
    );

    const applyActiveTabs = useCallback(
        (nextActiveTabs, options = {}) => {
            const preferredActiveTabId = options.preferredActiveTabId || activeTabIdRef.current;
            const mergedTabs = mergeActiveSqlTabs(tabsRef.current, nextActiveTabs, options.protectedInactiveTabIds);
            const nextActiveTabId = mergedTabs.some((tab) => tab.id === preferredActiveTabId) ? preferredActiveTabId : getFirstTabId(mergedTabs);

            return commitTabs(mergedTabs, {
                activeTabId: nextActiveTabId,
                syncContext: true,
                notifyContextChanged: true,
            });
        },
        [commitTabs],
    );

    const getActiveDiagnostics = useCallback((errors) => mapDiagnosticsToActiveSqlTab(errors, tabsRef.current, activeTabIdRef.current), []);

    const getAllDiagnostics = useCallback((errors) => mapDiagnosticsToSqlTabs(errors, tabsRef.current), []);

    const jumpToDiagnostic = useCallback((diagnostic) => {
        const line = diagnostic?.line;
        if (!line) return false;

        // Diagnostics are already mapped to tab-local line numbers by sqlTabs.
        // Switch tabs first, then let Monaco reveal the local line on the next
        // task after the editor model has changed.
        if (diagnostic.tabId) {
            activateTab(diagnostic.tabId);
        }

        window.setTimeout(() => {
            const editors = typeof window !== 'undefined' ? window.monaco?.editor?.getEditors?.() : null;
            if (!editors?.length) return;
            const editor = editors[0];
            const column = diagnostic.column || diagnostic.position?.column || 1;
            editor.revealLineInCenter(line);
            editor.setPosition({ lineNumber: line, column });
            editor.focus();
        }, 0);

        return true;
    }, [activateTab]);

    const jumpToTable = useCallback(
        (tableName) => {
            const targetLocation = findSqlTabTableLocation(tabsRef.current, tableName);
            if (targetLocation?.tabId) {
                activateTab(targetLocation.tabId);
            }

            // The ERD knows table names, while Monaco needs tab-local location.
            // Pass both so the editor can jump to the exact CREATE TABLE line.
            window.setTimeout(() => {
                if (typeof window.jumpToTableInEditor === 'function') {
                    window.jumpToTableInEditor(tableName, targetLocation);
                }
            }, 0);
        },
        [activateTab],
    );

    return {
        tabs,
        activeTabId,
        activeTab,
        activeSql: activeTab?.sql || '',
        hydrationVersion,
        combinedSql,
        dialectDetection,
        getSqlDialectDetection,
        getAddTableContext,
        editCanvasSchema,
        getRelationshipReconnectTargets,
        reconnectRelationship,
        dirtyTabIds,
        setActiveTabSql,
        appendSqlToActiveTab,
        deleteTableFromTabs,
        getTableOwner,
        getTableOwners,
        getTableDeletionPreview,
        addTab,
        importSqlFiles,
        getSampleDataContext,
        insertSampleDataTab,
        removeTab,
        duplicateTab,
        toggleTabInactive,
        closeOtherTabs,
        moveTab,
        reorderTab,
        renameTab,
        activateTab,
        replaceWithSingleTab,
        applyTabs,
        applyActiveTabs,
        syncContext,
        getActiveDiagnostics,
        getAllDiagnostics,
        jumpToDiagnostic,
        jumpToTable,
    };
}
