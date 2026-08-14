import { useState, useEffect, useRef, useContext, useCallback } from 'react';
import { RootLayoutContext } from '@/contexts/RootLayoutContext';
import { getLocalDocument } from '@/features/files/lib/localFileStore';

const createDefaultContext = () => ({
    tablePositions: {},
    tableColors: {},
    tableHeaderTextModes: {},
    tableCompactModes: {},
    zoom: undefined,
    offsetX: undefined,
    offsetY: undefined,
    selectedNodeName: null,
    splitterSize: undefined,
    // File-scoped display preferences. Older contexts may omit these keys;
    // the renderer treats missing or malformed values as the legacy defaults.
    fullConnect: false,
    showTableOwnerLabels: false,
    headerActionsAlwaysVisible: true,
});

export function useErdData(index) {
    const { sqlInput, setSqlInput, updateSchema } = useContext(RootLayoutContext);

    // General State
    const [error, setError] = useState('');
    const [parseErrors, setParseErrors] = useState([]);
    const [isEditorReady, setIsEditorReady] = useState(false);
    const [fileName, setFileName] = useState('untitled');
    const [originalSqlInput, setOriginalSqlInput] = useState('');
    const [isNewFile, setIsNewFile] = useState(index === 'new');
    const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
    const [originalData, setOriginalData] = useState({ sql: '', fileName: 'untitled', context: null });
    // Saved files begin with an empty global SQL state until their local read
    // completes. Start in loading state so nothing hydrates from that blank
    // placeholder or flashes an empty editor on a browser reload.
    const [isLoading, setIsLoading] = useState(index !== 'new');
    const [isOwner, setIsOwner] = useState(true);
    const [loadVersion, setLoadVersion] = useState(0);
    const [schemaVersion, setSchemaVersion] = useState(0);

    // AI Suggestion States
    const [showAiSuggestions, setShowAiSuggestions] = useState(false);
    const [currentlyProcessingAi, setCurrentlyProcessingAi] = useState(false);
    const [acceptedBlocks, setAcceptedBlocks] = useState(new Set());
    const [rejectedBlocks, setRejectedBlocks] = useState(new Set());
    const [aiSuggestedCode, setAiSuggestedCode] = useState('');
    const [aiTabChanges, setAiTabChanges] = useState(null);
    // Snapshot of the tab workspace sent with the in-flight AI request. This
    // keeps the response review stable even if accepted blocks update live tabs.
    const [aiReviewSource, setAiReviewSource] = useState(null);
    // Non-persisted candidate SQL used for parse/ERD/data while AI review is
    // visible. Clearing it returns every feature to committed `sqlInput`.
    const [aiWorkingSql, setAiWorkingSql] = useState(null);

    const [lineMapping, setLineMapping] = useState(null);

    const erdContextRef = useRef(createDefaultContext());
    const isLoadingRef = useRef(false);
    const prevIndexRef = useRef(null);
    const loadSeqRef = useRef(0);

    // Reset AI-related UI/state whenever route file changes
    useEffect(() => {
        setShowAiSuggestions(false);
        setCurrentlyProcessingAi(false);
        setAcceptedBlocks(new Set());
        setRejectedBlocks(new Set());
        setAiSuggestedCode('');
        setAiTabChanges(null);
        setAiReviewSource(null);
        setAiWorkingSql(null);
        setOriginalSqlInput('');
        setLineMapping(null);
    }, [index]);

    // Parse the committed SQL normally, or the non-persisted AI candidate
    // while a review is pending. The candidate never writes through to SQL.
    const parseTimerRef = useRef(null);
    const effectiveSql = typeof aiWorkingSql === 'string' ? aiWorkingSql : sqlInput;

    const processParseErrors = useCallback(
        (errors) => {
            if (!errors || errors.length === 0) {
                setParseErrors([]);
                return;
            }
            const sortedErrors = [...errors]
                .map((err) => (err.severity ? err : { ...err, severity: 'error' }))
                .filter((err) => err.severity === 'error' || err.severity === 'warning')
                .sort((a, b) => {
                    if (a.severity === 'error' && b.severity === 'warning') return -1;
                    if (a.severity === 'warning' && b.severity === 'error') return 1;
                    const lineA = a.position?.line || a.start?.line || 0;
                    const lineB = b.position?.line || b.start?.line || 0;
                    return lineA - lineB;
                });

            const allDisplayErrors = sortedErrors.map((err, idx) => {
                let line = err.position?.line || err.start?.line || null;
                let column = err.position?.column || err.start?.col || null;

                if (line !== null && (line < 1 || !Number.isInteger(line))) line = null;
                if (column !== null && (column < 1 || !Number.isInteger(column))) column = null;

                if (showAiSuggestions && lineMapping && line) {
                    const mappedLine = lineMapping[line];
                    if (mappedLine && Number.isInteger(mappedLine) && mappedLine > 0) {
                        line = mappedLine;
                    }
                }

                return {
                    id: `err_${idx}_${line}_${column}`,
                    message: err.message || 'Unknown error',
                    severity: err.severity || 'error',
                    kind: err.kind || null,
                    line,
                    column,
                };
            });
            setParseErrors(allDisplayErrors);
        },
        [showAiSuggestions, lineMapping],
    );

    useEffect(() => {
        if (isLoading) return;
        if (error && error.startsWith('Failed to load local diagram:')) return;

        if (typeof effectiveSql !== 'string' || !effectiveSql.trim()) {
            setParseErrors([]);
            if (!error?.startsWith('Failed to load local diagram:')) setError('');
            updateSchema('');
            setSchemaVersion((version) => version + 1);
            return;
        }

        let schemaErrors = null;
        try {
            const schema = updateSchema(effectiveSql);
            setSchemaVersion((version) => version + 1);
            if (!schema) {
                setError('Failed to parse SQL schema');
                setParseErrors([]);
                return;
            }
            setError('');
            schemaErrors = schema._parseErrors;
        } catch (e) {
            setError(`SQL parsing error: ${e.message}`);
            setParseErrors([]);
            return;
        }

        // Debounce only the error display update (cosmetic, not blocking rendering)
        if (parseTimerRef.current) clearTimeout(parseTimerRef.current);
        parseTimerRef.current = setTimeout(() => processParseErrors(schemaErrors), 200);
        return () => {
            if (parseTimerRef.current) clearTimeout(parseTimerRef.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [effectiveSql, showAiSuggestions, lineMapping, isLoading]);

    useEffect(() => {
        const indexChanged = prevIndexRef.current !== index;
        prevIndexRef.current = index;
        // Invalidate older route work before handling the next document.
        const loadId = ++loadSeqRef.current;

        const loadErdData = () => {
            if (index === 'new') {
                // Reset state when navigating TO /e/new (including first mount).
                // Skip duplicate resets so in-progress work survives rerenders.
                if (indexChanged) {
                    setIsNewFile(true);
                    setIsOwner(true);
                    setSqlInput('');
                    setFileName('untitled');
                    setOriginalData({ id: null, uuid: null, created_at: null, updated_at: null, sql: '', fileName: 'untitled', context: null });
                    erdContextRef.current = createDefaultContext();
                    setHasUnsavedChanges(false);
                    setError('');
                    setLoadVersion((version) => version + 1);
                }
                isLoadingRef.current = false;
                setIsLoading(false);
                return;
            }

            try {
                isLoadingRef.current = true;
                setIsLoading(true);

                const data = getLocalDocument(index);

                // Discard stale result — a newer load was triggered
                if (loadSeqRef.current !== loadId) return;

                if (!data) {
                    throw new Error('This diagram does not exist in this browser.');
                }

                const decodedSql = data.sql || '';
                const fileName = data.name || 'untitled';
                const dataContext = data.context || null;
                erdContextRef.current = dataContext ? { ...dataContext } : createDefaultContext();

                setError('');
                setFileName(fileName);
                setIsOwner(true);
                setOriginalData({
                    id: data.id,
                    uuid: index,
                    created_at: data.createdAt || null,
                    updated_at: data.updatedAt || null,
                    sql: decodedSql,
                    fileName: fileName,
                    context: dataContext ? JSON.parse(JSON.stringify(dataContext)) : null,
                });
                setIsNewFile(false);
                setHasUnsavedChanges(false);
                setSqlInput(decodedSql);
                setLoadVersion((version) => version + 1);
            } catch (error) {
                if (loadSeqRef.current !== loadId) return;
                console.error('Failed to load local diagram:', error);
                setError('Failed to load local diagram: ' + error.message);
            } finally {
                if (loadSeqRef.current === loadId) {
                    isLoadingRef.current = false;
                    setIsLoading(false);
                }
            }
        };

        loadErdData();
    }, [index, setSqlInput]);

    return {
        sqlInput,
        setSqlInput,
        originalSqlInput,
        setOriginalSqlInput,
        error,
        setError,
        parseErrors,
        setParseErrors,
        isEditorReady,
        setIsEditorReady,
        fileName,
        setFileName,
        isNewFile,
        setIsNewFile,
        hasUnsavedChanges,
        setHasUnsavedChanges,
        originalData,
        setOriginalData,
        isLoading,
        loadVersion,
        schemaVersion,
        isOwner,

        // Refs
        erdContextRef,
        isLoadingRef,

        // AI Suggestion States
        showAiSuggestions,
        setShowAiSuggestions,
        currentlyProcessingAi,
        setCurrentlyProcessingAi,
        acceptedBlocks,
        setAcceptedBlocks,
        rejectedBlocks,
        setRejectedBlocks,
        aiSuggestedCode,
        setAiSuggestedCode,
        aiTabChanges,
        setAiTabChanges,
        aiReviewSource,
        setAiReviewSource,
        aiWorkingSql,
        setAiWorkingSql,
        setLineMapping,
    };
}
