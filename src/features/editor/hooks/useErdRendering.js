import { useState, useEffect, useLayoutEffect, useCallback, useContext, useMemo, useRef } from 'react';
import { RootLayoutContext } from '@/contexts/RootLayoutContext';
import { deleteTableFromSql, getTableDeletionInfo } from '@/lib/deleteTableFromSql';
import runErdScript from '@/lib/genErdScript';
import { inferRelationships } from '@/lib/relationshipInference';
import { scoreErdSchema } from '@/lib/schemaQualityScore';
import { normalizeTableGroups } from '@/lib/erd-renderer/tableGroups';
import { useConfirm } from '@/components/ConfirmDialog';
import { useNotifications } from '@/components/Notifications';

const RELATIONSHIP_INFERENCE_CONTEXT_KEY = 'relationshipInferenceDecisions';
const NO_INFERRED_RELATIONS = [];

function buildTableDeletionMessage(tableName, preview) {
    const owner = preview?.owner;
    const references = preview?.references || [];
    const source = owner ? `Tab: "${owner.title}" (line ${owner.line}).` : 'The table owner could not be identified.';
    const referenceLines = references.length > 0 ? references.map((reference) => `- ${reference.tabTitle || 'SQL workspace'}: ${reference.description}`).join('\n') : '- No active foreign-key constraints reference this table.';

    return [`Delete table "${tableName}"?`, source, '', 'Related SQL to remove:', referenceLines, '', 'All SQL tabs and dependent columns will remain.'].join('\n');
}

function getRenderContext(erdContextRef, isAiPreview) {
    if (!isAiPreview) return erdContextRef.current;

    // ContextManager copies the top-level object but mutates nested maps.
    // Keep those preview-only layout changes away from saved ERD context.
    return JSON.parse(JSON.stringify(erdContextRef.current || {}));
}

function getStoredBoolean(context, key) {
    return context?.[key] === true;
}

function getStoredBooleanDefaultTrue(context, key) {
    return context?.[key] !== false;
}

function getBooleanPreferences(context) {
    const preferences = {};
    if (typeof context?.fullConnect === 'boolean') preferences.fullConnect = context.fullConnect;
    if (typeof context?.showTableOwnerLabels === 'boolean') preferences.showTableOwnerLabels = context.showTableOwnerLabels;
    if (typeof context?.headerActionsAlwaysVisible === 'boolean') preferences.headerActionsAlwaysVisible = context.headerActionsAlwaysVisible;
    return preferences;
}

function normalizeDecisionIds(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))].sort();
}

function sameDecisionIds(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function getRelationshipInferenceDecisions(context) {
    const decisions = context?.[RELATIONSHIP_INFERENCE_CONTEXT_KEY];
    return {
        accepted: normalizeDecisionIds(decisions?.accepted),
        rejected: normalizeDecisionIds(decisions?.rejected),
    };
}

export function applyNewTableTextDefault(context, tableName) {
    if (!context || typeof context !== 'object' || Array.isArray(context)) return false;
    const normalizedTableName = typeof tableName === 'string' ? tableName.trim() : '';
    if (!normalizedTableName) return false;

    const currentModes = context.tableHeaderTextModes;
    const safeModes = currentModes && typeof currentModes === 'object' && !Array.isArray(currentModes) ? currentModes : {};
    if (Object.prototype.hasOwnProperty.call(safeModes, normalizedTableName)) return false;

    context.tableHeaderTextModes = { ...safeModes, [normalizedTableName]: 'white' };
    return true;
}

export function getSchemaTableNameSet(schema) {
    return new Set(
        (Array.isArray(schema?.tables) ? schema.tables : [])
            .map((table) => (typeof table?.name === 'string' ? table.name.trim() : ''))
            .filter(Boolean),
    );
}

export function getAddedTableNames(previousNames, currentNames) {
    const previous = previousNames instanceof Set ? previousNames : new Set();
    const current = currentNames instanceof Set ? currentNames : new Set();
    return [...current].filter((tableName) => !previous.has(tableName));
}

function isErdRendererDomReady() {
    if (typeof document === 'undefined') return true;
    const canvas = document.getElementById('erd-canvas');
    return !canvas || Boolean(canvas.parentNode);
}

export function useErdRendering({ theme, erdContextRef, isLoading, isAiPreview = false, contextLoadVersion = 0, schemaVersion = 0 }) {
    const { sqlInput, setSqlInput, schemaRef, runSqlTabOperation } = useContext(RootLayoutContext);
    const { confirm } = useConfirm();

    const [flag, setFlag] = useState(0);
    const [fullConnect, setFullConnectState] = useState(false);
    const [showTableOwnerLabels, setShowTableOwnerLabelsState] = useState(false);
    const [headerActionsAlwaysVisible, setHeaderActionsAlwaysVisibleState] = useState(true);
    const [relationshipInferenceOpen, setRelationshipInferenceOpen] = useState(false);
    const [showRelationshipSuggestionConnectors, setShowRelationshipSuggestionConnectors] = useState(false);
    const [relationshipCandidates, setRelationshipCandidates] = useState([]);
    const [relationshipInferenceDecisions, setRelationshipInferenceDecisions] = useState({ accepted: [], rejected: [] });
    const [schemaQuality, setSchemaQuality] = useState(() => scoreErdSchema(null));
    const [erdContextVersion, setErdContextVersion] = useState(0);
    const [renderState, setRenderState] = useState({ phase: 'idle', contextLoadVersion });
    const [tableGroupEditRequest, setTableGroupEditRequest] = useState(null);
    const [tableGroupsReady, setTableGroupsReady] = useState(false);
    const [tableGroupsView, setTableGroupsView] = useState({ groups: [], tables: [], selectedTableName: undefined });
    const exportPngRef = useRef(null);
    const setMinimapVisibleRef = useRef(null);
    const renderSeqRef = useRef(0);
    const autoColorRequestRef = useRef(null);
    const knownTableNamesRef = useRef(new Set());
    const knownTablesContextVersionRef = useRef(null);
    const jumpToTableCallbackRef = useRef(null);
    const tableGroupsApiRef = useRef(null);
    const paintedRenderRef = useRef(null);
    const tableGroupsAccessRef = useRef({ isLoading, isAiPreview, contextLoadVersion });
    useLayoutEffect(() => {
        tableGroupsAccessRef.current = { isLoading, isAiPreview, contextLoadVersion };
    }, [isLoading, isAiPreview, contextLoadVersion]);
    // Preferences live in the saved file context rather than local storage.
    // Exact booleans preserve old files safely: missing or malformed keys keep
    // their long-standing off/default behavior without rewriting the file.
    useEffect(() => {
        if (isLoading) return;
        const context = erdContextRef.current;
        setFullConnectState(getStoredBoolean(context, 'fullConnect'));
        setShowTableOwnerLabelsState(getStoredBoolean(context, 'showTableOwnerLabels'));
        setHeaderActionsAlwaysVisibleState(getStoredBooleanDefaultTrue(context, 'headerActionsAlwaysVisible'));
        setRelationshipInferenceOpen(false);
        setShowRelationshipSuggestionConnectors(false);
        setTableGroupEditRequest(null);
    }, [contextLoadVersion, erdContextRef, isLoading]);

    const updateFilePreference = useCallback(
        (key, nextValue, setState) => {
            const normalizedValue = nextValue === true;
            const currentContext = erdContextRef.current;
            erdContextRef.current = {
                ...(currentContext && typeof currentContext === 'object' && !Array.isArray(currentContext) ? currentContext : {}),
                [key]: normalizedValue,
            };
            setState(normalizedValue);
            setErdContextVersion((version) => version + 1);
        },
        [erdContextRef],
    );

    const setFullConnect = useCallback((nextValue) => updateFilePreference('fullConnect', nextValue, setFullConnectState), [updateFilePreference]);
    const setShowTableOwnerLabels = useCallback((nextValue) => updateFilePreference('showTableOwnerLabels', nextValue, setShowTableOwnerLabelsState), [updateFilePreference]);
    const setHeaderActionsAlwaysVisible = useCallback((nextValue) => updateFilePreference('headerActionsAlwaysVisible', nextValue, setHeaderActionsAlwaysVisibleState), [updateFilePreference]);

    // Callback to receive context updates from runErdScript
    // IMPORTANT: Merge with existing context to preserve splitterSize and other UI state
    const onErdContextChange = useCallback(
        (newContext) => {
            if (isAiPreview) return;

            // Preserve UI state not mutated by ContextManager. This prevents a
            // stale canvas callback from discarding a just-clicked file option.
            const preservedSplitterSize = erdContextRef.current?.splitterSize;
            const booleanPreferences = getBooleanPreferences(erdContextRef.current);
            const relationshipInferenceDecisions = erdContextRef.current?.[RELATIONSHIP_INFERENCE_CONTEXT_KEY];
            const { fullConnect: _canvasFullConnect, showTableOwnerLabels: _canvasShowTableOwnerLabels, headerActionsAlwaysVisible: _canvasHeaderActionsAlwaysVisible, ...canvasContext } = newContext || {};
            erdContextRef.current = {
                ...canvasContext,
                ...booleanPreferences,
                ...(relationshipInferenceDecisions && { [RELATIONSHIP_INFERENCE_CONTEXT_KEY]: relationshipInferenceDecisions }),
                ...(preservedSplitterSize !== undefined && { splitterSize: preservedSplitterSize }),
            };
            setErdContextVersion((prev) => prev + 1);
        },
        [erdContextRef, isAiPreview],
    );

    const { notifySuccess, notifyWarning } = useNotifications();
    const handleCanvasSchemaEdit = useCallback((action, options = {}) => {
        const operate = (opts, change = action) => isAiPreview
            ? { ok: false, message: 'Finish the AI review before changing the schema.' }
            : runSqlTabOperation?.('editCanvasSchema', change, opts) || { ok: false, message: 'The SQL editor is not ready yet.' };
        const report = (result) => {
            if (result.ok) notifySuccess(result.message, {
                title: action.kind === 'add-relationship' ? 'Connection added' : action.kind === 'remove-relationship' ? 'Connection deleted' : action.kind === 'add-column' ? 'Column added' : 'Column removed',
                duration: 10000,
                action: result.undo ? { label: 'Undo', onClick: () => {
                    if (!result.undo()) notifyWarning('SQL changed since this action. Undo it in the SQL editor.', { title: 'Undo unavailable' });
                } } : undefined,
            });
            return result;
        };
        if (options.preview) return operate(options);
        if (action.kind === 'remove-relationship') return (async () => {
            const preview = operate({ preview: true });
            if (!preview.ok) { notifyWarning(preview.message, { title: 'Connection unchanged' }); return preview; }
            const label = preview.impacts[0].label;
            const approved = await confirm({ title: action.relation.composite ? 'Delete composite connection?' : 'Delete connection?', message: `Delete ${label}?\n\n${action.relation.composite ? 'The entire multi-column foreign-key constraint will be removed.' : 'The foreign-key constraint will be removed from SQL.'}\nBoth tables and all columns are kept.`, confirmText: 'Delete connection', tone: 'danger' });
            if (!approved) return { ok: false, cancelled: true };
            const result = report(operate({ expectedRevision: preview.revision }));
            if (!result.ok) notifyWarning(result.message, { title: 'Connection unchanged' });
            return result;
        })();
        if (action.kind !== 'remove-column') return report(operate(options));
        return (async () => {
            let requested = action;
            let preview = operate({ preview: true }, requested);
            if (!preview.ok && preview.canCascade) { requested = { ...action, cascade: true }; preview = operate({ preview: true }, requested); }
            if (!preview.ok) {
                notifyWarning(preview.message, { title: 'Column unchanged' });
                return preview;
            }
            const labels = { 'remove-relationship': 'Connection', 'remove-index': 'Index', 'remove-key': 'Key', 'remove-column': 'Generated column', 'remove-check': 'Check', 'remove-view': 'View', 'remove-trigger': 'Trigger', 'remove-migration': 'Migration change', 'remove-statement': 'SQL statement', 'rewrite-data': 'Keep data' };
            const impact = preview.impacts.map((i) => `${labels[i.kind] || 'Dependency'}: ${i.label}`).join('\n');
            const warning = preview.impacts.some((i) => i.kind === 'remove-statement') ? '\n\nSQL statements marked for removal are deleted in full.' : '';
            const approved = await confirm({ title: requested.cascade ? 'Remove column with dependencies?' : 'Remove column?', message: `Remove ${action.table}.${action.column}?${impact ? `\n\n${requested.cascade ? 'Cascade changes' : 'Also removes'}:\n` + impact : ''}${warning}`, confirmText: requested.cascade ? 'Remove with cascade' : 'Remove column', tone: 'danger' });
            if (!approved) return { ok: false, cancelled: true };
            const result = report(operate({ expectedRevision: preview.revision }, requested));
            if (!result.ok) notifyWarning(result.message, { title: 'Column unchanged' });
            return result;
        })();
    }, [confirm, isAiPreview, notifySuccess, notifyWarning, runSqlTabOperation]);
    const handleRelationshipReconnectTargets = useCallback((relation, endpoint) => isAiPreview
        ? { ok: false, targets: [], message: 'Finish the AI review before changing relationships.' }
        : runSqlTabOperation?.('getRelationshipReconnectTargets', relation, endpoint) || { ok: false, targets: [], message: 'The SQL editor is not ready yet.' }, [isAiPreview, runSqlTabOperation]);
    const handleRelationshipReconnect = useCallback((relation, endpoint, target, options = {}) => {
        const result = isAiPreview
            ? { ok: false, message: 'Finish the AI review before changing relationships.' }
            : runSqlTabOperation?.('reconnectRelationship', relation, endpoint, target, options) || { ok: false, message: 'The SQL editor is not ready yet.' };
        if (!options.preview) {
            if (result.ok && !result.unchanged) {
                const nextFrom = endpoint === 'from' ? target : relation.from;
                const nextTo = endpoint === 'to' ? target : relation.to;
                notifySuccess(`${nextFrom.table}.${nextFrom.column} → ${nextTo.table}.${nextTo.column}`, {
                    title: 'Relationship SQL updated', duration: 10000,
                    action: result.undo ? { label: 'Undo', onClick: () => {
                        if (!result.undo()) notifyWarning('SQL changed since this move. Undo it in the SQL editor.', { title: 'Undo unavailable' });
                    } } : undefined,
                });
            }
            else if (!result.ok) notifyWarning(result.message, { title: 'Relationship unchanged' });
        }
        return result;
    }, [isAiPreview, runSqlTabOperation, notifySuccess, notifyWarning]);

    // Handle jump-to-table from ERD canvas
    const handleJumpToTable = useCallback((tableName) => {
        if (typeof jumpToTableCallbackRef.current === 'function') {
            jumpToTableCallbackRef.current(tableName);
        }
    }, []);

    // Handle table deletion
    const handleTableDelete = useCallback(
        async (tableName) => {
            if (isAiPreview) return;
            if (!schemaRef.current) return;
            if (!tableName) return;

            // Prefer tab-aware preview when EditorPage has registered it. The
            // fallback preserves legacy single-document behavior.
            const previewFromTabs = runSqlTabOperation?.('getTableDeletionPreview', tableName);
            const preview = previewFromTabs === undefined ? { tableName, owner: null, references: getTableDeletionInfo(sqlInput, tableName).items.filter((item) => item.type !== 'table') } : previewFromTabs;
            if (preview?.blockedReason) {
                notifyWarning(preview.blockedReason, { title: 'Table SQL unchanged' });
                return false;
            }
            const confirmed = await confirm({
                title: 'Delete table?',
                message: buildTableDeletionMessage(tableName, preview),
                confirmText: 'Delete table',
                tone: 'danger',
            });
            if (!confirmed) return false;

            const newSchema = {
                ...schemaRef.current,
                tables: schemaRef.current.tables.filter((t) => t.name !== tableName),
                relations: schemaRef.current.relations.filter((r) => r.from.table !== tableName && r.to.table !== tableName),
            };

            try {
                // Tab-aware deletion removes SQL from the owning tab and cleans
                // cross-tab FK constraints without flattening the workspace.
                const deletedTabs = runSqlTabOperation?.('deleteTableFromTabs', tableName);
                if (deletedTabs === undefined) {
                    const newSql = deleteTableFromSql(sqlInput, tableName);
                    if (newSql === sqlInput) return false;
                    setSqlInput(newSql);
                } else if (!deletedTabs) {
                    return false;
                }

                schemaRef.current = newSchema;
                setFlag((f) => f + 1);
                return true;
            } catch {
                setFlag((f) => f + 1);
                return false;
            }
        },
        [confirm, isAiPreview, runSqlTabOperation, sqlInput, setSqlInput, schemaRef, notifyWarning],
    );

    useEffect(() => {
        setRelationshipCandidates(inferRelationships(schemaRef.current));
    }, [flag, schemaRef, schemaVersion]);

    useEffect(() => {
        const next = getRelationshipInferenceDecisions(erdContextRef.current);
        setRelationshipInferenceDecisions((current) => (
            sameDecisionIds(current.accepted, next.accepted) && sameDecisionIds(current.rejected, next.rejected)
                ? current
                : next
        ));
    }, [contextLoadVersion, erdContextRef, erdContextVersion]);

    const relationshipSuggestions = useMemo(() => {
        const accepted = new Set(relationshipInferenceDecisions.accepted);
        const rejected = new Set(relationshipInferenceDecisions.rejected);
        return relationshipCandidates
            .filter((candidate) => !rejected.has(candidate.id))
            .map((candidate) => ({
                ...candidate,
                inferenceStatus: accepted.has(candidate.id) ? 'accepted' : 'pending',
            }));
    }, [relationshipCandidates, relationshipInferenceDecisions]);

    const inferredRelationsToRender = useMemo(
        () => {
            const visible = relationshipSuggestions.filter((candidate) => candidate.inferenceStatus === 'accepted' || showRelationshipSuggestionConnectors);
            // Rechecking suggestions must not restart layout when no inferred
            // connectors are visible, including during the first SQL parse.
            return visible.length ? visible : NO_INFERRED_RELATIONS;
        },
        [relationshipSuggestions, showRelationshipSuggestionConnectors],
    );

    useEffect(() => {
        const acceptedInferredRelations = relationshipSuggestions.filter((candidate) => candidate.inferenceStatus === 'accepted');
        setSchemaQuality(scoreErdSchema(schemaRef.current, {
            acceptedInferredRelations,
            rejectedInferredRelationIds: relationshipInferenceDecisions.rejected,
            relationshipCandidates,
        }));
    }, [relationshipCandidates, relationshipInferenceDecisions.rejected, relationshipSuggestions, schemaRef, schemaVersion]);

    const updateRelationshipDecision = useCallback(
        (candidateId, nextStatus) => {
            if (isAiPreview || typeof candidateId !== 'string' || !candidateId) return false;

            const currentContext = erdContextRef.current;
            const nextContext = currentContext && typeof currentContext === 'object' && !Array.isArray(currentContext) ? currentContext : {};
            const current = getRelationshipInferenceDecisions(nextContext);
            const accepted = new Set(current.accepted);
            const rejected = new Set(current.rejected);

            accepted.delete(candidateId);
            rejected.delete(candidateId);
            if (nextStatus === 'accepted') accepted.add(candidateId);
            if (nextStatus === 'rejected') rejected.add(candidateId);

            erdContextRef.current = {
                ...nextContext,
                [RELATIONSHIP_INFERENCE_CONTEXT_KEY]: {
                    accepted: [...accepted].sort(),
                    rejected: [...rejected].sort(),
                },
            };
            setErdContextVersion((version) => version + 1);
            setFlag((value) => value + 1);
            return true;
        },
        [erdContextRef, isAiPreview],
    );

    const acceptRelationshipSuggestion = useCallback((candidateId) => updateRelationshipDecision(candidateId, 'accepted'), [updateRelationshipDecision]);
    const rejectRelationshipSuggestion = useCallback((candidateId) => updateRelationshipDecision(candidateId, 'rejected'), [updateRelationshipDecision]);

    const resetRejectedRelationshipSuggestions = useCallback(() => {
        if (isAiPreview) return false;
        const currentContext = erdContextRef.current;
        const nextContext = currentContext && typeof currentContext === 'object' && !Array.isArray(currentContext) ? currentContext : {};
        const current = getRelationshipInferenceDecisions(nextContext);
        if (current.rejected.length === 0) return false;

        erdContextRef.current = {
            ...nextContext,
            [RELATIONSHIP_INFERENCE_CONTEXT_KEY]: {
                accepted: current.accepted,
                rejected: [],
            },
        };
        setErdContextVersion((version) => version + 1);
        setFlag((value) => value + 1);
        return true;
    }, [erdContextRef, isAiPreview]);

    const updateTableGroups = useCallback((groups) => {
        const access = tableGroupsAccessRef.current;
        const api = tableGroupsApiRef.current;
        // A toolbar callback may outlive its document or a pending layout. Only
        // the current painted SQL canvas can write its own group context.
        if (access.isLoading || access.isAiPreview || access.contextLoadVersion !== contextLoadVersion
            || api?.contextLoadVersion !== contextLoadVersion || api.runId !== renderSeqRef.current
            || paintedRenderRef.current !== api.runId) return false;
        return api.setTableGroups(normalizeTableGroups(groups)) === true;
    }, [contextLoadVersion]);

    useEffect(() => {
        setTableGroupsView({
            groups: normalizeTableGroups(erdContextRef.current?.tableGroups),
            // SQL quoted identifiers may contain leading/trailing spaces. Use
            // trimming only to reject empty names, never to change identity.
            tables: [...new Set((schemaRef.current?.tables || []).map((table) => table.name).filter((name) => typeof name === 'string' && name.trim()))].map((name) => ({ name })),
            selectedTableName: erdContextRef.current?.selectedNodeName,
        });
    }, [erdContextRef, schemaRef, contextLoadVersion, erdContextVersion, schemaVersion, flag]);

    // Trigger ERD re-render when SQL changes
    useEffect(() => {
        if (!isLoading) {
            setFlag((f) => f + 1);
        }
    }, [sqlInput, isLoading]);

    // Render ERD when schema changes
    useEffect(() => {
        // The parsed schema and canvas are independent of Monaco's deferred
        // download. Start layout as soon as document hydration has completed.
        if (schemaRef.current && !isLoading) {
            if (!isErdRendererDomReady()) {
                const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 0);
                const cancel = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;
                const retryId = schedule(() => setFlag((f) => f + 1));
                return () => cancel(retryId);
            }

            const runId = (renderSeqRef.current += 1);
            const isCurrentRender = () => renderSeqRef.current === runId;
            tableGroupsApiRef.current = null;
            paintedRenderRef.current = null;
            setTableGroupsReady(false);
            setRenderState({ phase: 'rendering', contextLoadVersion });
            const autoColorRequest = autoColorRequestRef.current;
            const shouldAutoColor = autoColorRequest?.contextLoadVersion === contextLoadVersion;
            if (autoColorRequest && !shouldAutoColor) autoColorRequestRef.current = null;

            // A loaded file establishes the baseline and is never rewritten.
            // After that, tables newly introduced through SQL paste, typing,
            // AI acceptance, or the Add Table form get the deliberate white
            // text exception. Sample starters keep their smart Auto colors.
            if (!isAiPreview) {
                const currentTableNames = getSchemaTableNameSet(schemaRef.current);
                const isNewContext = knownTablesContextVersionRef.current !== contextLoadVersion;
                let appliedNewTableDefault = false;

                if (!isNewContext && !shouldAutoColor) {
                    getAddedTableNames(knownTableNamesRef.current, currentTableNames).forEach((tableName) => {
                        appliedNewTableDefault = applyNewTableTextDefault(erdContextRef.current, tableName) || appliedNewTableDefault;
                    });
                }

                knownTableNamesRef.current = currentTableNames;
                knownTablesContextVersionRef.current = contextLoadVersion;
                if (appliedNewTableDefault) setErdContextVersion((version) => version + 1);
            }

            const initialContext = getRenderContext(erdContextRef, isAiPreview);
            const tableOwners = runSqlTabOperation?.(
                'getTableOwners',
                schemaRef.current.tables.map((table) => table.name),
            ) || {};
            // tableOwners lets the canvas label each table with its SQL tab and
            // lets the table navigator/jump action target the correct tab line.
            runErdScript(JSON.parse(JSON.stringify(schemaRef.current)), {
                darkMode: theme === 'dark',
                // Read hydrated preferences immediately, including the first
                // run before their matching React control state has committed.
                fullConnect: getStoredBoolean(initialContext, 'fullConnect'),
                inferredRelations: inferredRelationsToRender,
                onTableDelete: handleTableDelete,
                onJumpToTable: handleJumpToTable,
                sqlDialect: schemaRef.current.dialect,
                // The renderer receives a JSON clone; native options are hidden
                // schema metadata and must travel through this read-only bridge.
                getCanvasColumnOptions: (table) => schemaRef.current.tables.find((model) => model.name === table.name)?.options || {},
                onCanvasSchemaEdit: isAiPreview ? null : handleCanvasSchemaEdit,
                onRelationshipReconnect: handleRelationshipReconnect,
                onRelationshipReconnectTargets: handleRelationshipReconnectTargets,
                onContextChange: context => { if (isCurrentRender()) onErdContextChange(context); },
                isCurrentRender,
                onFirstPaint: () => {
                    if (!isCurrentRender()) return;
                    paintedRenderRef.current = runId;
                    setRenderState({ phase: 'ready', contextLoadVersion });
                },
                tableGroupsEnabled: true,
                onTableGroupEdit: isAiPreview ? null : (id) => {
                    const access = tableGroupsAccessRef.current;
                    if (!isCurrentRender() || access.isLoading || access.isAiPreview || access.contextLoadVersion !== contextLoadVersion) return;
                    setTableGroupEditRequest((request) => ({ id, version: (request?.version || 0) + 1 }));
                },
                tableOwners,
                // Both visual controls are file preferences. They affect only
                // canvas display; SQL, parsing, and table ownership stay intact.
                showTableOwnerLabels: getStoredBoolean(initialContext, 'showTableOwnerLabels'),
                headerActionsAlwaysVisible: getStoredBooleanDefaultTrue(initialContext, 'headerActionsAlwaysVisible'),
                initialContext,
                autoColor: shouldAutoColor,
            })
                .then((api) => {
                    if (renderSeqRef.current !== runId) return;
                    // A cancelled layout never applied its starter colors.
                    // Consume the document-scoped request only after the
                    // current renderer has initialized them successfully.
                    if (api && autoColorRequestRef.current === autoColorRequest) autoColorRequestRef.current = null;
                    exportPngRef.current = api?.exportPng || null;
                    setMinimapVisibleRef.current = api?.setMinimapVisible || null;
                    tableGroupsApiRef.current = typeof api?.setTableGroups === 'function' ? { runId, contextLoadVersion, setTableGroups: api.setTableGroups } : null;
                    setTableGroupsReady(Boolean(tableGroupsApiRef.current));
                })
                .catch((error) => {
                    if (renderSeqRef.current !== runId) return;
                    console.error('ERD render failed:', error);
                    setRenderState({ phase: 'error', contextLoadVersion });
                    exportPngRef.current = null;
                    setMinimapVisibleRef.current = null;
                    tableGroupsApiRef.current = null;
                });
            // Pending layouts and notifications belong to this committed run,
            // including when a route unmounts before its layout has resolved.
            return () => {
                if (!isCurrentRender()) return;
                renderSeqRef.current += 1;
                tableGroupsApiRef.current = null;
                paintedRenderRef.current = null;
            };
        }
    }, [flag, theme, fullConnect, handleTableDelete, handleCanvasSchemaEdit, handleJumpToTable, handleRelationshipReconnect, handleRelationshipReconnectTargets, onErdContextChange, schemaRef, isLoading, erdContextRef, isAiPreview, runSqlTabOperation, showTableOwnerLabels, headerActionsAlwaysVisible, inferredRelationsToRender, contextLoadVersion]);

    const triggerAutoColor = useCallback(() => {
        autoColorRequestRef.current = { contextLoadVersion };
    }, [contextLoadVersion]);

    const applyNewTableDefaults = useCallback(
        (tableName) => {
            if (!applyNewTableTextDefault(erdContextRef.current, tableName)) return false;
            setErdContextVersion((version) => version + 1);
            return true;
        },
        [erdContextRef],
    );

    return {
        flag,
        setFlag,
        fullConnect,
        setFullConnect,
        showTableOwnerLabels,
        setShowTableOwnerLabels,
        headerActionsAlwaysVisible,
        setHeaderActionsAlwaysVisible,
        relationshipInference: {
            isOpen: relationshipInferenceOpen,
            setIsOpen: setRelationshipInferenceOpen,
            showConnectors: showRelationshipSuggestionConnectors,
            setShowConnectors: setShowRelationshipSuggestionConnectors,
            suggestions: relationshipSuggestions,
            pendingCount: relationshipSuggestions.filter((candidate) => candidate.inferenceStatus === 'pending').length,
            acceptedCount: relationshipSuggestions.filter((candidate) => candidate.inferenceStatus === 'accepted').length,
            rejectedCount: relationshipInferenceDecisions.rejected.length,
            disabled: isAiPreview,
            accept: acceptRelationshipSuggestion,
            reject: rejectRelationshipSuggestion,
            resetRejected: resetRejectedRelationshipSuggestions,
            schemaQuality,
        },
        schemaQuality,
        tableGroups: {
            ...tableGroupsView,
            documentKey: contextLoadVersion,
            editRequest: tableGroupEditRequest,
            disabled: isLoading || isAiPreview || renderState.contextLoadVersion !== contextLoadVersion || renderState.phase !== 'ready' || !tableGroupsReady,
            update: updateTableGroups,
        },
        erdContextVersion,
        isRendering: isLoading || renderState.contextLoadVersion === contextLoadVersion && renderState.phase === 'rendering',
        renderError: !isLoading && renderState.contextLoadVersion === contextLoadVersion && renderState.phase === 'error',
        setErdContextVersion,
        handleTableDelete,
        handleJumpToTable,
        triggerAutoColor,
        applyNewTableDefaults,
        jumpToTableCallbackRef,
        exportPng: (options) => {
            const exporter = exportPngRef.current;
            return exporter ? exporter(options) : null;
        },
        setMinimapVisible: (visible) => {
            setMinimapVisibleRef.current?.(visible === true);
        },
    };
}
