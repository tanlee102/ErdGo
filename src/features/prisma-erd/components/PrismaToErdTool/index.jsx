/**
 * Top-level Prisma-to-ERD workbench.
 * It coordinates Monaco input, parser diagnostics, deferred rendering, explorer focus,
 * local documents, canvas export, and responsive split-panel behavior.
 */
import { useCallback, useContext, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import MonacoEditor from '@monaco-editor/react';
import { ThemeContext } from '@/contexts/ThemeContext';
import { RootLayoutContext } from '@/contexts/RootLayoutContext';
import { convertPrismaToErdSchema, SAMPLE_PRISMA_SCHEMA } from '@/features/prisma-erd/lib/prismaToSql';
import { usePrismaErdRendering } from '@/features/prisma-erd/hooks/usePrismaErdRendering';
import { usePrismaCanvasResize } from '@/features/prisma-erd/hooks/usePrismaCanvasResize';
import usePrismaSplitter from '@/features/prisma-erd/hooks/usePrismaSplitter';
import PrismaSplitter from '@/features/prisma-erd/components/PrismaSplitter';
import PrismaExplorerPanel from '@/features/prisma-erd/components/PrismaExplorerPanel';
import CreateNewFileDialog from '@/components/CreateNewFileDialog';
import SchemaStat from '@/components/SchemaStat';
import { monacoOptions } from '@/config/monacoOptions';
import { configurePrismaMonaco, PRISMA_DARK_THEME, PRISMA_LIGHT_THEME } from '@/features/prisma-erd/lib/prismaMonaco';
import {
    buildPrismaExplorer,
    getPrismaExplorerRelationsForTable,
    searchPrismaExplorerItems,
} from '@/features/prisma-erd/lib/prismaExplorer';
import ErdControls from '@/features/editor/components/ErdControls';
import ErdTopControls from '@/features/editor/components/ErdTopControls';
import LocalDocumentLoadState from '@/features/files/components/LocalDocumentLoadState';
import HomeIcon from '@/icons/HomeIcon';
import ListIcon from '@/icons/ListIcon';
import SaveIcon from '@/icons/SaveIcon';
import ClearIcon from '@/icons/ClearIcon';
import { useConfirm } from '@/components/ConfirmDialog';
import { useNotifications } from '@/components/Notifications';
import { getLocalToolDocument, saveLocalDocument } from '@/features/files/lib/localFileStore';
import { FILE_KINDS } from '@/features/files/lib/fileDocuments';
import { createLocalDocumentSnapshot, useLocalDocumentState } from '@/features/files/hooks/useLocalDocumentState';
import { useUnsavedChangesWarning } from '@/features/files/hooks/useUnsavedChangesWarning';
import {
    countPrismaDiagnostics,
    getPrismaDiagnosticGroupLimits,
    getPrismaDiagnosticHint,
    getPrismaDiagnosticKey,
    groupPrismaDiagnostics,
} from '@/features/prisma-erd/lib/prismaDiagnostics';

import '@/features/editor/components/SqlPanel/index.css';
import '@/features/editor/components/Splitter/index.css';
import '@/features/editor/components/ErdPanel/index.css';
import './index.css';

const EMPTY_ERD_SCHEMA = { sourceType: 'prisma', enums: [], composites: [], tables: [], relations: [], _parseErrors: [] };
const PRISMA_EDITOR_OPTIONS = {
    ...monacoOptions,
    wordWrap: 'off',
    scrollBeyondLastLine: false,
    padding: { top: 12, bottom: 12 },
};
const PRISMA_DIAGNOSTIC_GROUP_LIMITS = getPrismaDiagnosticGroupLimits();
const LOCAL_HYDRATION_SETTLE_MS = 500;
const PRISMA_HYDRATION_TIMEOUT_MS = 5_000;

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createDefaultContext() {
    return {
        tablePositions: {},
        tableColors: {},
        tableHeaderTextModes: {},
        tableCompactModes: {},
        zoom: undefined,
        offsetX: undefined,
        offsetY: undefined,
        selectedNodeName: null,
        headerActionsAlwaysVisible: true,
        splitterSize: undefined,
    };
}

function normalizeStoredErdContext(context) {
    if (!context || typeof context !== 'object') return createDefaultContext();
    const zoom = Number(context.zoom);
    const offsetX = Number(context.offsetX);
    const offsetY = Number(context.offsetY);
    return {
        ...createDefaultContext(),
        ...context,
        zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : undefined,
        offsetX: Number.isFinite(offsetX) ? offsetX : undefined,
        offsetY: Number.isFinite(offsetY) ? offsetY : undefined,
    };
}

function formatDiagnosticLocation(item) {
    return item.line ? `Line ${item.line}` : item.severity || 'Note';
}

function getStoredSplitterSize(context) {
    const value = context?.splitterSize;
    return typeof value === 'number' && value >= 0 && value <= 100 ? value : 35;
}

function formatPrismaProvider(provider) {
    const labels = {
        postgresql: 'PostgreSQL',
        mysql: 'MySQL',
        sqlite: 'SQLite',
        sqlserver: 'SQL Server',
        mongodb: 'MongoDB',
        cockroachdb: 'CockroachDB',
    };
    return labels[provider] || 'Prisma';
}

export default function PrismaToErdTool({ index = 'new' }) {
    const navigate = useNavigate();
    const { theme, toggleTheme } = useContext(ThemeContext);
    const { openTypedFileList } = useContext(RootLayoutContext);
    const { confirm } = useConfirm();
    const { notifyError, notifySuccess } = useNotifications();
    const [prismaInput, setPrismaInput] = useState(() => (!index || index === 'new' ? SAMPLE_PRISMA_SCHEMA : ''));
    const [isStartDialogOpen, setIsStartDialogOpen] = useState(() => !index || index === 'new');
    const [isFirstPrismaErdLoad] = useState(() => !index || index === 'new');
    const [explorerQuery, setExplorerQuery] = useState('');
    const [isExplorerResultsOpen, setIsExplorerResultsOpen] = useState(false);
    const [selectedExplorerItemId, setSelectedExplorerItemId] = useState(null);
    const [selectedExplorerTable, setSelectedExplorerTable] = useState(null);
    const [activeRelationId, setActiveRelationId] = useState(null);
    const [schemaStats, setSchemaStats] = useState({ modelCount: 0, viewCount: 0, enumCount: 0, compositeCount: 0, relationCount: 0 });
    const [isDiagnosticsCollapsed, setIsDiagnosticsCollapsed] = useState(false);
    const [isCanvasReady, setIsCanvasReady] = useState(() => !index || index === 'new');
    const [rendererHydrationSource, setRendererHydrationSource] = useState(null);
    const [localName, setLocalName] = useState('Prisma ERD');
    const [isLocalLoading, setIsLocalLoading] = useState(() => Boolean(index && index !== 'new'));
    const [localLoadError, setLocalLoadError] = useState('');
    const [localLoadAttempt, setLocalLoadAttempt] = useState(0);
    const [isDocumentReady, setIsDocumentReady] = useState(() => !index || index === 'new');
    const [initialErdContext] = useState(createDefaultContext);
    const [localRendererContext, setLocalRendererContext] = useState(initialErdContext);
    const editorRef = useRef(null);
    const monacoRef = useRef(null);
    const jumpDecorationsRef = useRef(null);
    const jumpHighlightTimerRef = useRef(null);
    const prismaSchemaRef = useRef(EMPTY_ERD_SCHEMA);
    const erdContextRef = useRef(initialErdContext);
    const localLoadSequenceRef = useRef(0);
    const localHydrationCommitTimerRef = useRef(null);
    const pendingLocalHydrationRef = useRef(null);
    const renderCompleteCallbackRef = useRef(null);
    const deferredPrismaInput = useDeferredValue(prismaInput);

    const conversion = useMemo(() => convertPrismaToErdSchema(deferredPrismaInput), [deferredPrismaInput]);
    const prismaExplorer = useMemo(() => buildPrismaExplorer(conversion.schema || EMPTY_ERD_SCHEMA), [conversion.schema]);
    const explorerTableNames = useMemo(() => new Set((conversion.schema?.tables || []).map((table) => table.name)), [conversion.schema]);
    const explorerResults = useMemo(() => searchPrismaExplorerItems(prismaExplorer.items, explorerQuery, 12), [explorerQuery, prismaExplorer.items]);
    const activeRelation = useMemo(() => prismaExplorer.relationById.get(activeRelationId) || null, [activeRelationId, prismaExplorer.relationById]);
    const selectedTableRelations = useMemo(
        () => getPrismaExplorerRelationsForTable(prismaExplorer, selectedExplorerTable),
        [prismaExplorer, selectedExplorerTable],
    );
    const handleRendererComplete = useCallback((rendererContext) => {
        renderCompleteCallbackRef.current?.(rendererContext);
    }, []);

    const erdRendering = usePrismaErdRendering({
        theme,
        schemaRef: prismaSchemaRef,
        erdContextRef,
        isCanvasReady,
        autoColorOnFirstRender: isFirstPrismaErdLoad,
        initialHeaderActionsAlwaysVisible: initialErdContext.headerActionsAlwaysVisible !== false,
        onRenderComplete: handleRendererComplete,
    });
    const { erdContextVersion, renderError, setErdContextVersion, setFlag: requestErdRender, setJumpToTableCallback, triggerAutoColor } = erdRendering;
    const activeUuid = index && index !== 'new' ? index : null;
    const isReadOnlyLocalFile = Boolean(activeUuid && !isDocumentReady);
    const isLocalLoadBlocked = isLocalLoading || Boolean(localLoadError);
    const isDocumentOpening = Boolean(activeUuid && !localLoadError && (isLocalLoading || !isCanvasReady));
    const prismaEditorOptions = useMemo(
        () => ({
            ...PRISMA_EDITOR_OPTIONS,
            readOnly: isLocalLoadBlocked || isReadOnlyLocalFile,
            domReadOnly: isLocalLoadBlocked || isReadOnlyLocalFile,
        }),
        [isLocalLoadBlocked, isReadOnlyLocalFile],
    );
    const currentLocalPayload = useMemo(
        () => ({
            schemaVersion: 1,
            source: prismaInput,
            rendererContext: localRendererContext,
        }),
        [localRendererContext, prismaInput],
    );
    const currentLocalSnapshot = useMemo(
        () => createLocalDocumentSnapshot(localName, currentLocalPayload),
        [localName, currentLocalPayload],
    );
    const {
        isLocalSaving,
        hasUnsavedChanges,
        resetLocalState,
        beginLocalLoad,
        finishLocalLoad,
        failLocalLoad,
        beginLocalSave,
        finishLocalSave,
        failLocalSave,
    } = useLocalDocumentState({
        currentSnapshot: currentLocalSnapshot,
    });
    useUnsavedChangesWarning(
        hasUnsavedChanges && !isLocalLoadBlocked && !isStartDialogOpen && !isReadOnlyLocalFile,
    );
    const handleSplitterSizeChange = useCallback(
        (newSize) => {
            erdContextRef.current = {
                ...(erdContextRef.current || createDefaultContext()),
                splitterSize: newSize,
            };
            setErdContextVersion((value) => value + 1);
        },
        [setErdContextVersion],
    );
    const splitter = usePrismaSplitter({
        initialSize: getStoredSplitterSize(initialErdContext),
        minThreshold: { desktop: 12, mobile: 15 },
        maxThreshold: { desktop: 88, mobile: 85 },
        defaultRestoreSize: 35,
        onSizeChange: handleSplitterSizeChange,
    });
    const setSplitterPanelSize = splitter.setPanelSize;
    usePrismaCanvasResize(isCanvasReady);

    useEffect(() => {
        setLocalRendererContext(normalizeStoredErdContext(erdContextRef.current || createDefaultContext()));
    }, [erdContextVersion]);

    useEffect(() => {
        const commitHydratedLocalSnapshot = () => {
            const pending = pendingLocalHydrationRef.current;
            if (!pending || pending.uuid !== activeUuid) return;

            const rendererContext = normalizeStoredErdContext(erdContextRef.current || createDefaultContext());
            pendingLocalHydrationRef.current = null;
            localHydrationCommitTimerRef.current = null;
            setLocalRendererContext(rendererContext);
            finishLocalLoad(
                createLocalDocumentSnapshot(pending.name, {
                    schemaVersion: 1,
                    source: pending.source,
                    rendererContext,
                }),
            );
        };
        const scheduleHydratedLocalSnapshot = () => {
            window.clearTimeout(localHydrationCommitTimerRef.current);
            localHydrationCommitTimerRef.current = window.setTimeout(commitHydratedLocalSnapshot, LOCAL_HYDRATION_SETTLE_MS);
        };

        renderCompleteCallbackRef.current = () => {
            const pending = pendingLocalHydrationRef.current;
            if (!pending || pending.uuid !== activeUuid) return;
            pending.rendererComplete = true;
            scheduleHydratedLocalSnapshot();
        };

        return () => {
            window.clearTimeout(localHydrationCommitTimerRef.current);
            localHydrationCommitTimerRef.current = null;
            renderCompleteCallbackRef.current = null;
        };
    }, [activeUuid, finishLocalLoad]);

    useEffect(() => {
        if (!pendingLocalHydrationRef.current?.rendererComplete) return;
        renderCompleteCallbackRef.current?.(erdContextRef.current);
    }, [erdContextVersion]);

    useEffect(() => {
        return () => {
            if (jumpHighlightTimerRef.current) clearTimeout(jumpHighlightTimerRef.current);
            if (jumpDecorationsRef.current) jumpDecorationsRef.current.clear();
        };
    }, []);

    useEffect(() => {
        if (rendererHydrationSource === null) return undefined;
        if (deferredPrismaInput === rendererHydrationSource) {
            setRendererHydrationSource(null);
            setIsCanvasReady(true);
            return undefined;
        }

        // React's deferred editor value should settle quickly while loading is
        // read-only. Bound the wait anyway so an interrupted concurrent render
        // becomes a retryable error instead of an infinite opening overlay.
        const timeoutId = window.setTimeout(() => {
            setRendererHydrationSource(null);
            failLocalLoad();
            setLocalLoadError('The Prisma diagram took too long to prepare. Try loading the file again.');
        }, PRISMA_HYDRATION_TIMEOUT_MS);
        return () => window.clearTimeout(timeoutId);
    }, [activeUuid, deferredPrismaInput, failLocalLoad, rendererHydrationSource]);

    useEffect(() => {
        setIsStartDialogOpen(!activeUuid);
    }, [activeUuid]);

    useEffect(() => {
        const loadSequence = ++localLoadSequenceRef.current;
        if (!activeUuid) {
            window.clearTimeout(localHydrationCommitTimerRef.current);
            localHydrationCommitTimerRef.current = null;
            pendingLocalHydrationRef.current = null;
            setRendererHydrationSource(null);
            setIsCanvasReady(true);
            setIsLocalLoading(false);
            setLocalLoadError('');
            setIsDocumentReady(true);
            resetLocalState();
            return undefined;
        }

        let cancelled = false;
        window.clearTimeout(localHydrationCommitTimerRef.current);
        localHydrationCommitTimerRef.current = null;
        pendingLocalHydrationRef.current = null;
        setRendererHydrationSource(null);
        setIsCanvasReady(false);
        const emptyRendererContext = createDefaultContext();
        erdContextRef.current = emptyRendererContext;
        setLocalRendererContext(emptyRendererContext);
        setPrismaInput('');
        setLocalName('Prisma ERD');
        setLocalLoadError('');
        setIsLocalLoading(true);
        setIsDocumentReady(false);
        beginLocalLoad();

        const loadLocalDocument = async () => {
            try {
                const data = getLocalToolDocument(activeUuid, FILE_KINDS.PRISMA_ERD);
                if (cancelled || localLoadSequenceRef.current !== loadSequence) return;

                const source = data.payload?.source;
                const rendererContext = data.payload?.rendererContext;
                if (typeof source !== 'string' || !rendererContext || typeof rendererContext !== 'object' || Array.isArray(rendererContext)) {
                    throw new Error('Saved Prisma document is incomplete');
                }

                setPrismaInput(source);
                const normalizedRendererContext = normalizeStoredErdContext(rendererContext);
                erdContextRef.current = normalizedRendererContext;
                setLocalRendererContext(normalizedRendererContext);
                setRendererHydrationSource(source);
                setSplitterPanelSize(getStoredSplitterSize(rendererContext));
                setErdContextVersion((value) => value + 1);
                const loadedName = data.name || 'Prisma ERD';
                setLocalName(loadedName);
                setIsDocumentReady(true);
                pendingLocalHydrationRef.current = {
                    uuid: activeUuid,
                    name: loadedName,
                    source,
                };
                finishLocalLoad(
                    createLocalDocumentSnapshot(loadedName, {
                        schemaVersion: 1,
                        source,
                        rendererContext: normalizedRendererContext,
                    }),
                );
            } catch (error) {
                if (cancelled || localLoadSequenceRef.current !== loadSequence) return;
                failLocalLoad();
                const message = error.message || 'Failed to load Prisma file';
                setLocalLoadError(message);
                notifyError(message, { title: 'Could not open file' });
            } finally {
                if (!cancelled && localLoadSequenceRef.current === loadSequence) setIsLocalLoading(false);
            }
        };

        loadLocalDocument();
        return () => {
            cancelled = true;
        };
    }, [activeUuid, beginLocalLoad, localLoadAttempt, failLocalLoad, finishLocalLoad, navigate, notifyError, resetLocalState, setErdContextVersion, setSplitterPanelSize]);

    useEffect(() => {
        prismaSchemaRef.current = conversion.schema || EMPTY_ERD_SCHEMA;
        setSchemaStats(conversion.stats || { modelCount: 0, viewCount: 0, enumCount: 0, compositeCount: 0, relationCount: 0 });
        requestErdRender((value) => value + 1);
    }, [conversion.schema, conversion.stats, requestErdRender]);

    useEffect(() => {
        if (!activeRelationId) return;
        if (!prismaExplorer.relationById.has(activeRelationId)) {
            setActiveRelationId(null);
            setSelectedExplorerItemId(null);
        }
    }, [activeRelationId, prismaExplorer.relationById]);

    useEffect(() => {
        if (!selectedExplorerTable || explorerTableNames.has(selectedExplorerTable)) return;
        setSelectedExplorerTable(null);
        setSelectedExplorerItemId(null);
    }, [explorerTableNames, selectedExplorerTable]);

    const diagnostics = useMemo(() => {
        const parserDiagnostics = conversion.diagnostics || [];
        if (!renderError) return parserDiagnostics;
        return [...parserDiagnostics, { severity: 'error', message: renderError }];
    }, [conversion.diagnostics, renderError]);

    const parseErrors = useMemo(() => {
        return diagnostics
            .filter((item) => item.line)
            .map((item, index) => ({
                id: `prisma_${index}_${item.line}`,
                severity: item.severity || 'warning',
                message: item.message,
                line: item.line,
                column: item.column || 1,
                endLine: item.endLine,
                endColumn: item.endColumn,
            }));
    }, [diagnostics]);
    const diagnosticGroups = useMemo(() => groupPrismaDiagnostics(diagnostics, PRISMA_DIAGNOSTIC_GROUP_LIMITS), [diagnostics]);
    const diagnosticCounts = useMemo(() => countPrismaDiagnostics(diagnostics), [diagnostics]);

    const handleEditorMount = useCallback((editor, monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;
        editor.focus();
    }, []);

    const jumpEditorToPrismaLine = useCallback((line, fallbackTableName) => {
        const editor = editorRef.current;
        const monaco = monacoRef.current;
        const model = editor?.getModel?.();
        if (!editor || !model) return;

        let targetLine = Number(line) || 0;
        if ((!targetLine || targetLine > model.getLineCount()) && fallbackTableName) {
            const matches = model.findMatches(`\\b(?:model|view)\\s+${escapeRegex(fallbackTableName)}\\s*\\{`, false, true, false, null, false);
            targetLine = matches[0]?.range?.startLineNumber || 0;
        }
        if (!targetLine || targetLine > model.getLineCount()) return;

        const lineContent = model.getLineContent(targetLine) || '';
        editor.revealLineInCenter(targetLine);
        editor.setSelection({
            startLineNumber: targetLine,
            startColumn: 1,
            endLineNumber: targetLine,
            endColumn: lineContent.length + 1,
        });
        editor.setPosition({ lineNumber: targetLine, column: 1 });

        if (monaco?.Range) {
            if (jumpHighlightTimerRef.current) clearTimeout(jumpHighlightTimerRef.current);
            if (jumpDecorationsRef.current) jumpDecorationsRef.current.clear();
            jumpDecorationsRef.current = editor.createDecorationsCollection([
                {
                    range: new monaco.Range(targetLine, 1, targetLine, lineContent.length + 1),
                    options: {
                        className: 'jump-to-table-highlight',
                        isWholeLine: true,
                    },
                },
            ]);
            jumpHighlightTimerRef.current = setTimeout(() => {
                jumpDecorationsRef.current?.clear();
                jumpDecorationsRef.current = null;
            }, 1500);
        }
        editor.focus();
    }, []);

    const focusPrismaTable = useCallback(
        (tableName, line = null) => {
            if (!tableName) return;
            setSelectedExplorerTable(tableName);
            erdContextRef.current = {
                ...(erdContextRef.current || createDefaultContext()),
                selectedNodeName: tableName,
            };
            setErdContextVersion((value) => value + 1);
            requestErdRender((value) => value + 1);
            jumpEditorToPrismaLine(line, tableName);
        },
        [jumpEditorToPrismaLine, requestErdRender, setErdContextVersion],
    );

    useEffect(() => {
        const editor = editorRef.current;
        const monaco = monacoRef.current;
        const model = editor?.getModel?.();
        if (!editor || !monaco || !model) return;

        const totalLines = model.getLineCount();
        const markers = [...parseErrors]
            .filter((item) => item.line > 0 && item.line <= totalLines)
            .sort((left, right) => {
                if (left.severity !== right.severity) return left.severity === 'error' ? -1 : 1;
                return left.line - right.line;
            })
            .slice(0, 100)
            .map((item) => {
                const lineContent = model.getLineContent(item.line) || '';
                const firstContentColumn = Math.max(1, lineContent.search(/\S/) + 1);
                const hint = getPrismaDiagnosticHint(item);
                const markerSeverity =
                    item.severity === 'error'
                        ? monaco.MarkerSeverity.Error
                        : item.severity === 'info'
                          ? monaco.MarkerSeverity.Info
                          : monaco.MarkerSeverity.Warning;
                return {
                    severity: markerSeverity,
                    message: hint ? `${item.message}\n\nSuggested fix: ${hint}` : item.message,
                    startLineNumber: item.line,
                    startColumn: Math.max(firstContentColumn, item.column || 1),
                    endLineNumber: item.endLine || item.line,
                    endColumn: item.endColumn || Math.max(2, lineContent.length + 1),
                };
            });

        monaco.editor.setModelMarkers(model, 'prisma-to-erd', markers);
    }, [parseErrors]);

    useEffect(() => {
        setJumpToTableCallback((modelName) => {
            const editor = editorRef.current;
            const monaco = monacoRef.current;
            const model = editor?.getModel?.();
            if (!editor || !monaco || !model || !modelName) return;

            const matches = model.findMatches(`\\bmodel\\s+${escapeRegex(modelName)}\\s*\\{`, false, true, false, null, false);
            if (!matches.length) return;

            const targetLine = matches[0].range.startLineNumber;
            const lineContent = model.getLineContent(targetLine);
            editor.revealLineInCenter(targetLine);
            editor.setSelection({
                startLineNumber: targetLine,
                startColumn: 1,
                endLineNumber: targetLine,
                endColumn: lineContent.length + 1,
            });
            editor.setPosition({ lineNumber: targetLine, column: 1 });

            if (jumpHighlightTimerRef.current) clearTimeout(jumpHighlightTimerRef.current);
            if (jumpDecorationsRef.current) jumpDecorationsRef.current.clear();
            jumpDecorationsRef.current = editor.createDecorationsCollection([
                {
                    range: new monaco.Range(targetLine, 1, targetLine, lineContent.length + 1),
                    options: {
                        className: 'jump-to-table-highlight',
                        isWholeLine: true,
                    },
                },
            ]);
            jumpHighlightTimerRef.current = setTimeout(() => {
                jumpDecorationsRef.current?.clear();
                jumpDecorationsRef.current = null;
            }, 1500);
            editor.focus();
        });

        return () => {
            setJumpToTableCallback(null);
        };
    }, [setJumpToTableCallback]);

    const replaceEditorContent = useCallback(
        (nextValue) => {
            if (prismaInput === nextValue) {
                editorRef.current?.focus();
                return;
            }
            erdContextRef.current = createDefaultContext();
            triggerAutoColor();
            setPrismaInput(nextValue);
            editorRef.current?.focus();
        },
        [prismaInput, triggerAutoColor],
    );

    const handleClear = useCallback(async () => {
        if (!prismaInput.trim()) return;
        const confirmed = await confirm({
            title: 'Clear Prisma editor?',
            message: 'This will remove the current Prisma schema from the editor. This cannot be undone.',
            confirmText: 'Clear editor',
            tone: 'danger',
        });
        if (confirmed) replaceEditorContent('');
    }, [confirm, prismaInput, replaceEditorContent]);

    const handleStartWithSample = useCallback(() => {
        replaceEditorContent(SAMPLE_PRISMA_SCHEMA);
        setIsStartDialogOpen(false);
    }, [replaceEditorContent]);

    const handleStartBlank = useCallback(() => {
        replaceEditorContent('');
        setIsStartDialogOpen(false);
    }, [replaceEditorContent]);

    const handleDiagnosticClick = useCallback((item) => {
        if (!item?.line) return;
        const editor = editorRef.current;
        const model = editor?.getModel?.();
        if (!editor || !model || item.line > model.getLineCount()) return;

        const lineContent = model.getLineContent(item.line) || '';
        editor.revealLineInCenter(item.line);
        const startColumn = Math.max(1, Math.min(item.column || 1, lineContent.length + 1));
        editor.setSelection({
            startLineNumber: item.line,
            startColumn,
            endLineNumber: item.endLine || item.line,
            endColumn: item.endColumn || lineContent.length + 1,
        });
        editor.setPosition({ lineNumber: item.line, column: startColumn });
        editor.focus();
    }, []);
    const handleSelectExplorerItem = useCallback(
        (item) => {
            if (!item) return;
            setSelectedExplorerItemId(item.id);
            setIsExplorerResultsOpen(false);
            if (item.tableName) {
                focusPrismaTable(item.tableName, item.line);
            } else {
                setSelectedExplorerTable(null);
                if (item.line) jumpEditorToPrismaLine(item.line);
            }

            if (item.relationId) {
                setActiveRelationId(item.relationId);
            } else {
                setActiveRelationId(null);
            }
        },
        [focusPrismaTable, jumpEditorToPrismaLine],
    );
    const handleSelectRelation = useCallback(
        (relationId) => {
            const relation = prismaExplorer.relationById.get(relationId);
            if (!relation) return;
            setActiveRelationId(relation.id);
            setSelectedExplorerItemId(`relation:${relation.id}`);
            setIsExplorerResultsOpen(false);
            focusPrismaTable(relation.fromTable, relation.line);
        },
        [focusPrismaTable, prismaExplorer.relationById],
    );
    const handleCloseRelation = useCallback(() => {
        setActiveRelationId(null);
        setSelectedExplorerItemId(null);
        setSelectedExplorerTable(null);
    }, []);
    const handleClearExplorerQuery = useCallback(() => {
        setExplorerQuery('');
        setIsExplorerResultsOpen(false);
        setSelectedExplorerItemId(null);
        setSelectedExplorerTable(null);
        setActiveRelationId(null);
    }, []);
    const handleExplorerQueryChange = useCallback((value) => {
        const hasQuery = Boolean(value.trim());
        setExplorerQuery(value);
        setIsExplorerResultsOpen(hasQuery);
        setSelectedExplorerItemId(null);
        setSelectedExplorerTable(null);
        setActiveRelationId(null);
    }, []);
    const handleOpenExplorerResults = useCallback(() => {
        if (explorerQuery.trim()) setIsExplorerResultsOpen(true);
    }, [explorerQuery]);

    const performLocalSave = useCallback(async () => {
        if (activeUuid && !isDocumentReady) return;
        const normalizedName = localName.trim();
        if (normalizedName.length < 3 || normalizedName.length > 259) {
            notifyError('Use a file name between 3 and 259 characters.', { title: 'Cannot save yet' });
            return;
        }
        if (!prismaInput.trim()) {
            notifyError('Add a Prisma schema before saving.', { title: 'Cannot save yet' });
            return;
        }

        if (!beginLocalSave()) return;
        const payload = {
            schemaVersion: 1,
            source: prismaInput,
            rendererContext: normalizeStoredErdContext(erdContextRef.current || createDefaultContext()),
        };
        try {
            const shouldCreate = !activeUuid;
            const saved = saveLocalDocument({
                id: activeUuid, kind: FILE_KINDS.PRISMA_ERD, name: normalizedName, payload,
            });
            setIsDocumentReady(true);
            finishLocalSave(createLocalDocumentSnapshot(normalizedName, payload));
            notifySuccess('Your Prisma ERD was saved.', {
                title: shouldCreate ? 'Local file created' : 'Local file updated',
            });

            if (shouldCreate && saved?.id) {
                navigate(`/prisma-to-erd/${saved.id}`, { replace: true });
            }
        } catch (error) {
            failLocalSave();
            notifyError(error.message || 'Failed to save Prisma file', { title: 'Local save failed' });
        }
    }, [activeUuid, beginLocalSave, localName, failLocalSave, finishLocalSave, isDocumentReady, navigate, notifyError, notifySuccess, prismaInput]);

    const handleLocalSave = useCallback(() => { void performLocalSave(); }, [performLocalSave]);

    const handleOpenLocalFiles = useCallback(() => {
        openTypedFileList({ fileKind: FILE_KINDS.PRISMA_ERD, routeBase: '/prisma-to-erd' });
    }, [openTypedFileList]);

    const isLocalSaveDisabled = isLocalSaving
        || isLocalLoadBlocked
        || !prismaInput.trim()
        || !hasUnsavedChanges;

    return (
        <main className={`sql-editor-container prisma-erd-workspace ${splitter.containerClassName}`} role="application" aria-label="Prisma to ERD converter">
            <aside className="sql-panel prisma-erd-source-panel" style={splitter.getPanelStyle(true)}>
                <div className="panel-header">
                    <div className="panel-header-left">
                        <Link to="/" aria-label="Home">
                            <div className="logo-homepage">
                                <HomeIcon />
                            </div>
                        </Link>
                        <div className="prisma-erd-header-title">
                            <span>Tools</span>
                            <h1>Prisma to ERD</h1>
                        </div>
                    </div>
                    <div className="panel-actions">
                        <button
                            type="button"
                            className="prisma-erd-toolbar-button prisma-erd-files-button"
                            onClick={handleOpenLocalFiles}
                            title="Open Prisma ERD files"
                            aria-label="Open Prisma ERD files"
                        >
                            <ListIcon />
                        </button>
                        {!isReadOnlyLocalFile && (
                            <button type="button" className="prisma-erd-toolbar-button prisma-erd-clear-action" onClick={handleClear} disabled={isLocalLoadBlocked || !prismaInput.trim()} title="Clear Prisma editor" aria-label="Clear Prisma editor">
                                <ClearIcon />
                            </button>
                        )}
                    </div>
                </div>

                <div className="file-input-container prisma-erd-file-input">
                    <input
                        className="prisma-erd-local-name"
                        type="text"
                        value={localName}
                        onChange={(event) => setLocalName(event.target.value)}
                        readOnly={isLocalLoadBlocked || isReadOnlyLocalFile}
                        maxLength={259}
                        title="Prisma ERD local file name"
                        aria-label="Prisma ERD local file name"
                        placeholder="Local file name"
                    />
                    {(!activeUuid || isDocumentReady) && (
                        <button
                            type="button"
                            className={`prisma-erd-save-button${isLocalSaveDisabled ? ' disabled' : ''}`}
                            onClick={handleLocalSave}
                            disabled={isLocalSaveDisabled}
                            title="Save Prisma ERD locally"
                            aria-label="Save Prisma ERD locally"
                        >
                            {isLocalSaving ? <span className="save-spinner" /> : <SaveIcon width="16px" height="16px" />}
                        </button>
                    )}
                </div>

                <PrismaExplorerPanel
                    query={explorerQuery}
                    showResults={isExplorerResultsOpen}
                    results={explorerResults}
                    selectedItemId={selectedExplorerItemId}
                    activeRelation={activeRelation}
                    selectedTableName={selectedExplorerTable}
                    selectedTableRelations={selectedTableRelations}
                    onQueryChange={handleExplorerQueryChange}
                    onOpenResults={handleOpenExplorerResults}
                    onClearQuery={handleClearExplorerQuery}
                    onSelectItem={handleSelectExplorerItem}
                    onSelectRelation={handleSelectRelation}
                    onCloseRelation={handleCloseRelation}
                    onFocusTable={focusPrismaTable}
                />

                <div className="editor-container">
                    <MonacoEditor
                        value={prismaInput}
                        onChange={(value) => setPrismaInput(value || '')}
                        language="prisma"
                        theme={theme === 'dark' ? PRISMA_DARK_THEME : PRISMA_LIGHT_THEME}
                        options={prismaEditorOptions}
                        beforeMount={configurePrismaMonaco}
                        onMount={handleEditorMount}
                    />
                </div>

                {diagnostics.length > 0 && (
                    <section
                        className={`parse-errors-container ${isDiagnosticsCollapsed ? 'is-collapsed' : ''}`}
                        aria-label="Prisma diagnostics"
                        aria-live="polite"
                    >
                        <button
                            type="button"
                            className="parse-errors-header"
                            onClick={() => setIsDiagnosticsCollapsed((value) => !value)}
                            aria-expanded={!isDiagnosticsCollapsed}
                            aria-controls="prisma-diagnostics-list"
                            title={isDiagnosticsCollapsed ? 'Open Prisma diagnostics' : 'Collapse Prisma diagnostics'}
                        >
                            <span className="parse-errors-header-main">
                                <span className="parse-errors-toggle-icon" aria-hidden="true">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        {isDiagnosticsCollapsed ? <polyline points="6 9 12 15 18 9" /> : <polyline points="18 15 12 9 6 15" />}
                                    </svg>
                                </span>
                                <span className="parse-errors-title-group">
                                    <span className="parse-errors-title">Prisma diagnostics</span>
                                    <span className="parse-errors-subtitle">
                                        {diagnostics.length} diagnostic{diagnostics.length === 1 ? '' : 's'}
                                    </span>
                                </span>
                            </span>
                            <span
                                className="parse-errors-summary"
                                aria-label={`${diagnosticCounts.error} errors, ${diagnosticCounts.warning} warnings, and ${diagnosticCounts.info} notes`}
                            >
                                {diagnosticCounts.error > 0 && <span className="diagnostic-count error-count">{diagnosticCounts.error} error{diagnosticCounts.error === 1 ? '' : 's'}</span>}
                                {diagnosticCounts.warning > 0 && <span className="diagnostic-count warning-count">{diagnosticCounts.warning} warning{diagnosticCounts.warning === 1 ? '' : 's'}</span>}
                                {diagnosticCounts.info > 0 && <span className="diagnostic-count info-count">{diagnosticCounts.info} note{diagnosticCounts.info === 1 ? '' : 's'}</span>}
                            </span>
                        </button>

                        {!isDiagnosticsCollapsed && (
                            <div id="prisma-diagnostics-list" className="parse-errors-body">
                                {diagnosticGroups.map((group) => (
                                    <div className="parse-error-group" key={group.severity}>
                                        <div className="parse-error-group-title">
                                            <span>{group.label}</span>
                                            <span className="parse-error-group-count">{group.total}</span>
                                        </div>
                                        {group.items.map((item, index) => {
                                            const isJumpable = Boolean(item.line);
                                            const location = formatDiagnosticLocation(item);
                                            const hint = getPrismaDiagnosticHint(item);
                                            return (
                                                <div key={getPrismaDiagnosticKey(item, index)} className={`parse-error-item ${group.severity}-item`}>
                                                    <div
                                                        className="error-content"
                                                        onClick={() => handleDiagnosticClick(item)}
                                                        onKeyDown={(event) => {
                                                            if (isJumpable && (event.key === 'Enter' || event.key === ' ')) {
                                                                event.preventDefault();
                                                                handleDiagnosticClick(item);
                                                            }
                                                        }}
                                                        role={isJumpable ? 'button' : undefined}
                                                        tabIndex={isJumpable ? 0 : undefined}
                                                        style={{ cursor: isJumpable ? 'pointer' : 'default' }}
                                                        title={isJumpable ? `Go to ${location.toLowerCase()}` : ''}
                                                        aria-label={isJumpable ? `${location}: ${item.message}` : undefined}
                                                    >
                                                        <div className="diagnostic-meta">
                                                            <span className={`diagnostic-severity-pill ${group.severity}-pill`}>{group.severity === 'info' ? 'Note' : group.severity === 'warning' ? 'Warning' : 'Error'}</span>
                                                            <span className="diagnostic-location">{location}</span>
                                                        </div>
                                                        <span className="error-message diagnostic-message">{item.message}</span>
                                                        {hint && <span className="diagnostic-hint">{hint}</span>}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                        {group.hiddenCount > 0 && (
                                            <div className="prisma-diagnostic-overflow" role="status">
                                                {group.hiddenCount} more {group.label.toLowerCase()} are available in the editor markers.
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>
                )}

                <div className="status-bar">
                    <div className="schema-info">
                        <SchemaStat kind="models" label="Models" value={schemaStats.modelCount} />
                        {schemaStats.viewCount > 0 && <SchemaStat kind="views" label="Views" value={schemaStats.viewCount} />}
                        <SchemaStat kind="relations" label="Relations" value={schemaStats.relationCount} />
                        <SchemaStat kind="enums" label="Enums" value={schemaStats.enumCount} />
                        {schemaStats.compositeCount > 0 && <SchemaStat kind="composites" label="Types" value={schemaStats.compositeCount} />}
                    </div>
                    <span>{formatPrismaProvider(conversion.datasource?.provider)}</span>
                </div>
            </aside>

            <PrismaSplitter onMouseDown={splitter.handleSplitterMouseDown} toggleButtonText={splitter.toggleButtonText} toggleButtonTitle={splitter.toggleButtonTitle} onToggleClick={splitter.toggleCollapse} splitterRef={splitter.splitterRef} />

            <section className="erd-panel prisma-erd-diagram-panel" style={splitter.getPanelStyle(false)} aria-label="Generated ERD preview">
                <div id="erd-container">
                    <canvas id="erd-canvas"></canvas>
                    <ErdControls erdRendering={erdRendering} canEditSchema={false} />
                </div>
                <ErdTopControls erdRendering={erdRendering} toggleTheme={toggleTheme} viewMode="erd" />
            </section>
            <CreateNewFileDialog
                isDisplay={isStartDialogOpen}
                onSelectSample={handleStartWithSample}
                onSelectBlank={handleStartBlank}
                title="Create New Prisma ERD"
                sampleTitle="Create with Prisma Sample"
                sampleDescription="Explore a ready Prisma schema and its relationships"
                blankTitle="Create Empty Prisma File"
                blankDescription="Start with an empty Prisma editor"
            />
            <LocalDocumentLoadState
                toolLabel="Prisma ERD"
                isLoading={isDocumentOpening}
                error={localLoadError}
                onRetry={() => setLocalLoadAttempt((value) => value + 1)}
                onOpenFiles={handleOpenLocalFiles}
            />
        </main>
    );
}
