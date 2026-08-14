import { useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { ThemeContext } from '@/contexts/ThemeContext';
import { RootLayoutContext } from '@/contexts/RootLayoutContext';
import useSplitter from '@/features/editor/hooks/useSplitter';
import Splitter from '@/features/editor/components/Splitter';
import SqlPanel from '@/features/editor/components/SqlPanel';
import ErdPanel from '@/features/editor/components/ErdPanel';
import CreateNewFileDialog from '@/components/CreateNewFileDialog';
import { useErdData } from '@/features/editor/hooks/useErdData';
import { useErdRendering } from '@/features/editor/hooks/useErdRendering';
import { useChangeTracking } from '@/features/editor/hooks/useChangeTracking';
import { useSaveLogic } from '@/features/editor/hooks/useSaveLogic';
import { useCanvasResize } from '@/features/editor/hooks/useCanvasResize';
import { useAiTabDiff } from '@/features/editor/hooks/useAiTabDiff';
import { useSqlTabs } from '@/features/editor/hooks/useSqlTabs';
import { useUnsavedChangesWarning } from '@/features/files/hooks/useUnsavedChangesWarning';
import { sampleDataSQL, sampleSchemaSQL } from '@/features/editor/lib/sampleSQL';
import { createSqlTab } from '@/features/editor/lib/sqlTabs';
import { getAiWorkingWorkspace } from '@/features/editor/lib/aiWorkingWorkspace';
import { createSqlExecutor } from '@/features/data-view/lib/sqlExecutor';
import TableViewer from '@/features/data-view/components/TableViewer';
import QueryViewer from '@/features/query-view/components/QueryViewer';
import { applyPersistedQueryToContext, getPersistedQueryFromContext, shouldPersistQueryValue } from '@/features/query-view/lib/persistedQuery';

function quoteQueryIdentifier(name) {
    const value = String(name || '').trim();
    if (!value) return '';
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return value;
    return `"${value.replace(/"/g, '""')}"`;
}

function buildFirstTableSampleQuery(tables) {
    const firstTable = tables instanceof Map ? Array.from(tables.values())[0] : null;
    const tableName = firstTable?.name;
    const identifier = quoteQueryIdentifier(tableName);
    if (!identifier) return '';
    return `SELECT *\nFROM ${identifier}\nLIMIT 100;`;
}

function buildQuerySchemaKey(sql) {
    const value = String(sql || '');
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `${value.length}:${hash >>> 0}`;
}

const EMPTY_QUERY_EXECUTION_STATE = { query: '', result: null, elapsedMs: 0, schemaKey: null };

const BLANK_SCHEMA_STARTER = `-- Start your database schema here.
-- Add CREATE TABLE statements, then define relationships and indexes.
-- Project: https://github.com/tanlee102/ErdGo

`;

export default function EditorPage() {
    // Get index from params
    const { index } = useParams();

    // Contexts
    const { theme, toggleTheme } = useContext(ThemeContext);
    const { sqlInput, setSqlInput, registerSqlTabOperations } = useContext(RootLayoutContext);

    // State for Create New File Dialog
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [dialogShown, setDialogShown] = useState(false);
    const [sqlImportRequestVersion, setSqlImportRequestVersion] = useState(0);

    // View mode: 'erd', 'data', or 'query'
    const [viewMode, setViewMode] = useState('erd');
    const [querySentence, setQuerySentence] = useState('');
    const [queryExecutionState, setQueryExecutionState] = useState(EMPTY_QUERY_EXECUTION_STATE);
    const generatedQueryRef = useRef('');
    const queryUserEditedRef = useRef(false);
    const loadedQueryKeyRef = useRef(null);
    const suppressNextQueryContextSyncRef = useRef(false);
    const aiReviewViewStateCaptureRef = useRef(null);
    const wasAiWorkingPreviewRef = useRef(false);

    const handleViewModeChange = useCallback((mode) => {
        setViewMode(mode);
    }, []);

    const erdData = useErdData(index);
    useEffect(() => {
        document.title = `${erdData.fileName || 'Untitled'} — ERD Go`;
    }, [erdData.fileName]);

    // Show dialog when index is 'new' and not shown before
    useEffect(() => {
        if (index === 'new' && !dialogShown) {
            setShowCreateDialog(true);
            setDialogShown(true);
        } else if (index !== 'new') {
            setDialogShown(false);
        }
    }, [index, dialogShown]);

    // ERD Rendering - must be before splitter to use setErdContextVersion
    const erdRendering = useErdRendering({
        theme,
        erdContextRef: erdData.erdContextRef,
        isEditorReady: erdData.isEditorReady,
        isLoading: erdData.isLoading,
        isAiPreview: erdData.showAiSuggestions || erdData.currentlyProcessingAi,
        contextLoadVersion: erdData.loadVersion,
        schemaVersion: erdData.schemaVersion,
    });
    const { setErdContextVersion, setFlag, jumpToTableCallbackRef } = erdRendering;
    const { showAiSuggestions, setLineMapping, aiWorkingSql, setAiWorkingSql, erdContextRef } = erdData;

    const handleSqlTabsContextChange = useCallback((reason) => {
        setErdContextVersion((version) => version + 1);
        if (reason === 'tab-title') {
            setFlag((flag) => flag + 1);
        }
    }, [setErdContextVersion, setFlag]);

    const sqlTabs = useSqlTabs({
        sqlInput,
        setSqlInput,
        loadVersion: erdData.loadVersion,
        savedSql: erdData.originalData?.sql,
        savedContext: erdData.originalData?.context,
        erdContextRef: erdData.erdContextRef,
        onContextChange: handleSqlTabsContextChange,
        isLoading: erdData.isLoading,
    });
    const { jumpToTable: jumpToSqlTabTable, replaceWithSingleTab, applyTabs, syncContext: syncSqlTabsContext } = sqlTabs;

    useEffect(() => {
        if (typeof registerSqlTabOperations !== 'function') return undefined;
        // Expose tab-aware operations to older cross-cutting features that only
        // know about the root SQL context: Add Table, ERD delete, and ERD owner
        // labels all come through this narrow bridge.
        const unregister = registerSqlTabOperations({
            appendSqlToActiveTab: sqlTabs.appendSqlToActiveTab,
            applyNewTableDefaults: erdRendering.applyNewTableDefaults,
            deleteTableFromTabs: sqlTabs.deleteTableFromTabs,
            getTableOwner: sqlTabs.getTableOwner,
            getTableOwners: sqlTabs.getTableOwners,
            getTableDeletionPreview: sqlTabs.getTableDeletionPreview,
        });
        setFlag((flag) => flag + 1);
        return unregister;
    }, [registerSqlTabOperations, setFlag, erdRendering.applyNewTableDefaults, sqlTabs.appendSqlToActiveTab, sqlTabs.deleteTableFromTabs, sqlTabs.getTableOwner, sqlTabs.getTableOwners, sqlTabs.getTableDeletionPreview]);

    // Connect ERD jump-to-table to Monaco editor
    useEffect(() => {
        jumpToTableCallbackRef.current = (tableName) => {
            jumpToSqlTabTable(tableName);
        };
        return () => {
            jumpToTableCallbackRef.current = null;
        };
    }, [jumpToTableCallbackRef, jumpToSqlTabTable]);

    // State for splitter size - initialized from saved context when data loads
    const [splitterSizeFromContext, setSplitterSizeFromContext] = useState(35);

    // Version counter that increments each time a new file is successfully loaded
    // This is the KEY to ensuring splitter size re-applies on every file switch
    const [fileLoadVersion, setFileLoadVersion] = useState(0);

    // Track which index we've processed to avoid duplicate processing
    const processedDataRef = useRef({ index: null, originalDataId: null });

    useEffect(() => {
        if (erdData.isLoading || !erdData.originalData) return;

        const dataId = erdData.originalData.context ? JSON.stringify(erdData.originalData.context) : erdData.originalData.sql?.slice(0, 100) || '';

        if (processedDataRef.current.index === index && processedDataRef.current.originalDataId === dataId) {
            return;
        }
        processedDataRef.current = { index, originalDataId: dataId };

        const savedSize = erdData.originalData.context?.splitterSize;
        const targetSize = typeof savedSize === 'number' && savedSize >= 0 && savedSize <= 100 ? savedSize : 35;

        setSplitterSizeFromContext(targetSize);
        setFileLoadVersion((v) => v + 1);
    }, [erdData.isLoading, erdData.originalData, index]);

    // Callback to update erdContextRef when splitter size changes
    // Also trigger erdContextVersion to notify change tracking
    const handleSplitterSizeChange = useCallback(
        (newSize) => {
            if (erdContextRef.current) {
                erdContextRef.current.splitterSize = newSize;
                // Trigger change tracking by incrementing erdContextVersion
                setErdContextVersion((prev) => prev + 1);
            }
        },
        [erdContextRef, setErdContextVersion],
    );

    // Splitter - pass fileLoadVersion to force size re-application on file change
    const splitter = useSplitter({
        initialSize: splitterSizeFromContext,
        minThreshold: { desktop: 12, mobile: 15 },
        maxThreshold: { desktop: 88, mobile: 85 },
        defaultRestoreSize: 35,
        onSizeChange: handleSplitterSizeChange,
        forceUpdateVersion: fileLoadVersion, // Force re-apply when new file loads
    });

    // Canvas resize
    useCanvasResize(erdData.isEditorReady);

    // AI Diff logic
    const aiDiff = useAiTabDiff({
        // Use the request-time snapshot when present. The live tab workspace may
        // already include accepted blocks, but the incoming AI response must be
        // reviewed against the exact tabs that were sent to the provider.
        tabs: erdData.aiReviewSource?.tabs || sqlTabs.tabs,
        preferredTabId: erdData.aiReviewSource?.activeTabId || sqlTabs.activeTabId,
        showAiSuggestions: erdData.showAiSuggestions,
        setShowAiSuggestions: erdData.setShowAiSuggestions,
        aiSuggestedCode: erdData.aiSuggestedCode,
        tabChanges: erdData.aiTabChanges,
        acceptedBlocks: erdData.acceptedBlocks,
        setAcceptedBlocks: erdData.setAcceptedBlocks,
        rejectedBlocks: erdData.rejectedBlocks,
        setRejectedBlocks: erdData.setRejectedBlocks,
        setOriginalSqlInput: erdData.setOriginalSqlInput,
        // AI receives active tabs only. Merge its accepted result back into the
        // complete workspace so inactive private drafts are never discarded.
        onApplyTabs: (nextTabs) =>
            sqlTabs.applyActiveTabs(nextTabs, {
                protectedInactiveTabIds: erdData.aiReviewSource?.protectedInactiveTabIds,
            }),
        onClearReview: () => erdData.setAiReviewSource(null),
        onBeforeFinalize: () => aiReviewViewStateCaptureRef.current?.(),
    });

    const aiWorkingWorkspace = useMemo(
        () =>
            getAiWorkingWorkspace({
                tabs: sqlTabs.tabs,
                activeTabId: sqlTabs.activeTabId,
                showAiSuggestions: erdData.showAiSuggestions,
                reviewMode: aiDiff.reviewMode,
                previewTabs: aiDiff.previewTabs,
                previewSql: aiDiff.previewSql,
                requestSource: erdData.aiReviewSource,
                isProcessingAi: erdData.currentlyProcessingAi,
            }),
        [aiDiff.previewSql, aiDiff.previewTabs, aiDiff.reviewMode, erdData.aiReviewSource, erdData.currentlyProcessingAi, erdData.showAiSuggestions, sqlTabs.activeTabId, sqlTabs.tabs],
    );
    const querySchemaKey = useMemo(() => buildQuerySchemaKey(aiWorkingWorkspace.sql), [aiWorkingWorkspace.sql]);

    // Publish the non-persisted AI candidate to useErdData so parse, ERD, data,
    // and query views reflect what the user currently sees in green.
    useEffect(() => {
        setAiWorkingSql(aiWorkingWorkspace.isPreview ? aiWorkingWorkspace.sql : null);
    }, [aiWorkingWorkspace.isPreview, aiWorkingWorkspace.sql, setAiWorkingSql]);

    // useErdData parses the working workspace first; this redraw keeps the
    // canvas synchronized with pending green AI changes without persisting them.
    useEffect(() => {
        const isPreview = typeof aiWorkingSql === 'string';
        if (!erdData.isLoading && (isPreview || wasAiWorkingPreviewRef.current)) {
            setFlag((flag) => flag + 1);
        }
        wasAiWorkingPreviewRef.current = isPreview;
    }, [aiWorkingSql, erdData.isLoading, setFlag]);

    // A review preview owns its own line mapping, while accepted blocks update
    // the real tab workspace immediately.
    useEffect(() => {
        setLineMapping(null);
    }, [setLineMapping, showAiSuggestions]);

    // Change tracking
    useChangeTracking({
        sqlInput: sqlInput,
        fileName: erdData.fileName,
        originalData: erdData.originalData,
        isNewFile: erdData.isNewFile,
        erdContextRef: erdData.erdContextRef,
        erdContextVersion: erdRendering.erdContextVersion,
        setHasUnsavedChanges: erdData.setHasUnsavedChanges,
    });

    // Query View auto-generates a starter SELECT from the first table. Only
    // persist the query once the user has actually edited it, so saved files do
    // not accumulate disposable generated text.
    const syncQuerySentenceToContext = useCallback(
        (nextQuery) => {
            if (
                !shouldPersistQueryValue({
                    query: nextQuery,
                    generatedQuery: generatedQueryRef.current,
                    userEdited: queryUserEditedRef.current,
                })
            ) {
                return false;
            }
            return applyPersistedQueryToContext(erdData.erdContextRef.current, nextQuery);
        },
        [erdData.erdContextRef],
    );

    useEffect(() => {
        if (erdData.isLoading) return;

        const loadKey = `${index}:${erdData.originalData?.uuid || ''}`;
        if (loadedQueryKeyRef.current === loadKey) return;
        loadedQueryKeyRef.current = loadKey;

        const savedQuery = getPersistedQueryFromContext(erdData.originalData?.context);
        queryUserEditedRef.current = false;
        suppressNextQueryContextSyncRef.current = true;
        generatedQueryRef.current = '';
        setQuerySentence(savedQuery);
        setQueryExecutionState({ ...EMPTY_QUERY_EXECUTION_STATE, schemaKey: querySchemaKey });
    }, [index, erdData.isLoading, erdData.originalData?.uuid, erdData.originalData?.context, querySchemaKey]);

    useEffect(() => {
        if (suppressNextQueryContextSyncRef.current) {
            suppressNextQueryContextSyncRef.current = false;
            return;
        }
        if (syncQuerySentenceToContext(querySentence)) {
            erdRendering.setErdContextVersion((v) => v + 1);
        }
    }, [querySentence, syncQuerySentenceToContext, erdRendering]);

    const handleQuerySentenceChange = useCallback((nextQuery, meta = {}) => {
        if (meta.source === 'user') {
            queryUserEditedRef.current = true;
        }
        setQuerySentence(nextQuery);
    }, []);

    useUnsavedChangesWarning(erdData.hasUnsavedChanges, true);

    // Save logic
    const { saveOrUpdate, isSaving } = useSaveLogic({
        index,
        isNewFile: erdData.isNewFile,
        setIsNewFile: erdData.setIsNewFile,
        fileName: erdData.fileName,
        originalData: erdData.originalData,
        setOriginalData: erdData.setOriginalData,
        setHasUnsavedChanges: erdData.setHasUnsavedChanges,
        erdContextRef: erdData.erdContextRef,
        setErdContextVersion: erdRendering.setErdContextVersion,
    });

    const handleSaveOrUpdate = useCallback(async () => {
        let sqlOverride;
        syncQuerySentenceToContext(querySentence);

        if (erdData.showAiSuggestions && aiDiff?.acceptAllRemainAndFinalize) {
            // Saving while a review is open means "save what I am looking at".
            // Finalize remaining blocks first and pass that combined SQL to the
            // save layer so async React updates cannot save stale text.
            sqlOverride = aiDiff.acceptAllRemainAndFinalize();
        }

        syncSqlTabsContext();

        if (typeof sqlOverride === 'string') {
            await saveOrUpdate({ sqlOverride });
            return;
        }

        await saveOrUpdate();
    }, [querySentence, syncQuerySentenceToContext, syncSqlTabsContext, erdData.showAiSuggestions, aiDiff, saveOrUpdate]);

    // Handle Create New File Dialog selections
    const handleSelectSample = () => {
        erdRendering.triggerAutoColor();
        // Starter files are born tab-aware: schema and sample data are separate
        // tabs from the first save, so later AI/data actions have clear owners.
        const schemaTab = createSqlTab({ title: 'Schema', sql: sampleSchemaSQL.trimStart() });
        const sampleDataTab = createSqlTab({ title: 'Sample Data', sql: sampleDataSQL.trimStart() });
        applyTabs([schemaTab, sampleDataTab], schemaTab.id);
        setShowCreateDialog(false);
    };

    const handleSelectBlank = () => {
        replaceWithSingleTab(BLANK_SCHEMA_STARTER, 'Schema');
        setShowCreateDialog(false);
    };

    const handleSelectImport = () => {
        setShowCreateDialog(false);
        setSqlImportRequestVersion((version) => version + 1);
    };

    // Data/query view executor — only runs when a table-backed view is active
    const dataViewResult = useMemo(() => {
        if (viewMode !== 'data' && viewMode !== 'query') return null;
        const executor = createSqlExecutor();
        return executor.execute(aiWorkingWorkspace.sql);
    }, [aiWorkingWorkspace.sql, viewMode]);

    useEffect(() => {
        setQueryExecutionState({ ...EMPTY_QUERY_EXECUTION_STATE, schemaKey: querySchemaKey });
    }, [querySchemaKey]);

    useEffect(() => {
        if (viewMode !== 'query' || !dataViewResult) return;
        const nextGeneratedQuery = buildFirstTableSampleQuery(dataViewResult.tables);
        const currentGeneratedQuery = generatedQueryRef.current;
        const queryIsStillGenerated = querySentence === currentGeneratedQuery;

        if (!queryIsStillGenerated || nextGeneratedQuery === currentGeneratedQuery) return;

        generatedQueryRef.current = nextGeneratedQuery;
        setQuerySentence(nextGeneratedQuery);
    }, [viewMode, aiWorkingWorkspace.sql, dataViewResult, querySentence]);

    const dataContent = useMemo(() => {
        if (!dataViewResult) return null;
        return <TableViewer tables={new Map(dataViewResult.tables)} types={new Map(dataViewResult.types)} executionLog={dataViewResult.log} />;
    }, [dataViewResult]);

    const queryContent = useMemo(
        () => (
            <QueryViewer
                querySentence={querySentence}
                onQuerySentenceChange={handleQuerySentenceChange}
                tables={dataViewResult?.tables}
                queryExecution={queryExecutionState}
                executionSchemaKey={querySchemaKey}
                onExecuteQuery={setQueryExecutionState}
            />
        ),
        [querySentence, handleQuerySentenceChange, dataViewResult?.tables, queryExecutionState, querySchemaKey],
    );

    // Re-render canvas when switching back to ERD view
    useEffect(() => {
        if (viewMode === 'erd') {
            erdRendering.setFlag((f) => f + 1);
        }
    }, [viewMode]); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <>
            <CreateNewFileDialog isDisplay={showCreateDialog} onSelectSample={handleSelectSample} onSelectBlank={handleSelectBlank} onSelectImport={handleSelectImport} />

            <div className={`sql-editor-container ${splitter.containerClassName}`} role="application" aria-label="SQL to ERD Editor">
                <SqlPanel
                    splitter={splitter}
                    erdData={erdData}
                    aiDiff={aiDiff}
                    sqlTabs={sqlTabs}
                    saveOrUpdate={handleSaveOrUpdate}
                    isSaving={isSaving}
                    activeFileId={index}
                    aiReviewViewStateCaptureRef={aiReviewViewStateCaptureRef}
                    schemaQuality={erdRendering.schemaQuality}
                    sqlImportRequestVersion={sqlImportRequestVersion}
                />

                <Splitter onMouseDown={splitter.handleSplitterMouseDown} toggleButtonText={splitter.toggleButtonText} toggleButtonTitle={splitter.toggleButtonTitle} onToggleClick={splitter.toggleCollapse} splitterRef={splitter.splitterRef} />

                <ErdPanel
                    splitter={splitter}
                    erdRendering={erdRendering}
                    toggleTheme={toggleTheme}
                    viewMode={viewMode}
                    onViewModeChange={handleViewModeChange}
                    showTableOwnerLabels={erdRendering.showTableOwnerLabels}
                    onShowTableOwnerLabelsChange={erdRendering.setShowTableOwnerLabels}
                    dataContent={dataContent}
                    queryContent={queryContent}
                />
            </div>
        </>
    );
}
