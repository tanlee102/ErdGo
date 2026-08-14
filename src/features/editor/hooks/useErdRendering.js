import { useState, useEffect, useCallback, useContext, useMemo, useRef } from 'react';
import { RootLayoutContext } from '@/contexts/RootLayoutContext';
import { deleteTableFromSql, getTableDeletionInfo } from '@/lib/deleteTableFromSql';
import runErdScript from '@/lib/genErdScript';
import { inferRelationships } from '@/lib/relationshipInference';
import { scoreErdSchema } from '@/lib/schemaQualityScore';
import { useConfirm } from '@/components/ConfirmDialog';

const RELATIONSHIP_INFERENCE_CONTEXT_KEY = 'relationshipInferenceDecisions';

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

export function useErdRendering({ theme, erdContextRef, isEditorReady, isLoading, isAiPreview = false, contextLoadVersion = 0, schemaVersion = 0 }) {
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
    const exportPngRef = useRef(null);
    const setMinimapVisibleRef = useRef(null);
    const renderSeqRef = useRef(0);
    const autoColorNextRef = useRef(false);
    const knownTableNamesRef = useRef(new Set());
    const knownTablesContextVersionRef = useRef(null);
    const jumpToTableCallbackRef = useRef(null);

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
        [confirm, isAiPreview, runSqlTabOperation, sqlInput, setSqlInput, schemaRef],
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
        () => relationshipSuggestions.filter((candidate) => candidate.inferenceStatus === 'accepted' || showRelationshipSuggestionConnectors),
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

    // Trigger ERD re-render when SQL changes
    useEffect(() => {
        if (!isLoading) {
            setFlag((f) => f + 1);
        }
    }, [sqlInput, isLoading]);

    // Render ERD when schema changes
    useEffect(() => {
        if (schemaRef.current && isEditorReady && !isLoading) {
            if (!isErdRendererDomReady()) {
                const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 0);
                const cancel = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;
                const retryId = schedule(() => setFlag((f) => f + 1));
                return () => cancel(retryId);
            }

            const runId = (renderSeqRef.current += 1);
            const shouldAutoColor = autoColorNextRef.current;
            autoColorNextRef.current = false;

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
                fullConnect,
                inferredRelations: inferredRelationsToRender,
                onTableDelete: handleTableDelete,
                onJumpToTable: handleJumpToTable,
                onContextChange: onErdContextChange,
                tableOwners,
                // Both visual controls are file preferences. They affect only
                // canvas display; SQL, parsing, and table ownership stay intact.
                showTableOwnerLabels,
                headerActionsAlwaysVisible,
                initialContext,
                autoColor: shouldAutoColor,
            })
                .then((api) => {
                    if (renderSeqRef.current !== runId) return;
                    exportPngRef.current = api?.exportPng || null;
                    setMinimapVisibleRef.current = api?.setMinimapVisible || null;
                })
                .catch((error) => {
                    if (renderSeqRef.current !== runId) return;
                    console.error('ERD render failed:', error);
                    exportPngRef.current = null;
                    setMinimapVisibleRef.current = null;
                });
        }
    }, [flag, isEditorReady, theme, fullConnect, handleTableDelete, handleJumpToTable, onErdContextChange, schemaRef, isLoading, erdContextRef, isAiPreview, runSqlTabOperation, showTableOwnerLabels, headerActionsAlwaysVisible, inferredRelationsToRender, contextLoadVersion]);

    const triggerAutoColor = useCallback(() => {
        autoColorNextRef.current = true;
    }, []);

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
        erdContextVersion,
        setErdContextVersion,
        handleTableDelete,
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
