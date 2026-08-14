import { useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import MonacoEditor from '@monaco-editor/react';
import { ThemeContext } from '@/contexts/ThemeContext';
import { languageConfiguration } from '@/config/languageConfiguration';
import { monacoOptions } from '@/config/monacoOptions';
import { executeSelectQuery } from '@/features/query-view/lib/queryExecutor';
import SendIcon from '@/icons/SendIcon';
import ClearIcon from '@/icons/ClearIcon';
import './index.css';

function getNowMs() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function executeTimedQuery(tables, query) {
    const startedAt = getNowMs();
    const result = executeSelectQuery({ tables, query });
    const elapsedMs = Math.max(0, getNowMs() - startedAt);
    return { result, elapsedMs };
}

function formatElapsedMs(value) {
    if (value < 1) return '<1 ms';
    if (value < 100) return `${value.toFixed(1)} ms`;
    return `${Math.round(value)} ms`;
}

function QueryCellValue({ value }) {
    if (value === null || value === undefined) return <span className="qv-cell-null">NULL</span>;
    if (typeof value === 'boolean') return <span className={`qv-cell-bool ${value ? 'qv-bool-true' : 'qv-bool-false'}`}>{String(value)}</span>;
    if (typeof value === 'number') return <span className="qv-cell-number">{value}</span>;
    if (Array.isArray(value) || typeof value === 'object') return <span>{JSON.stringify(value)}</span>;
    return <span>{String(value)}</span>;
}

export default function QueryViewer({ querySentence = '', onQuerySentenceChange, tables, queryExecution, executionSchemaKey, onExecuteQuery }) {
    const { theme } = useContext(ThemeContext);
    const editorRef = useRef(null);
    // Monaco commands are registered once on mount. Refs keep Cmd/Ctrl+Enter
    // executing against the latest query, schema key, tables, and callback.
    const queryRef = useRef(querySentence);
    const tablesRef = useRef(tables);
    const executionSchemaKeyRef = useRef(executionSchemaKey);
    const onExecuteQueryRef = useRef(onExecuteQuery);

    const activeExecution = queryExecution?.schemaKey === executionSchemaKey ? queryExecution : null;
    const executedQuery = activeExecution?.query || '';
    const queryResult = activeExecution?.result || null;
    const queryError = queryResult?.errors?.find((entry) => entry.type === 'error');
    const elapsedMs = activeExecution?.elapsedMs || 0;

    useEffect(() => {
        queryRef.current = querySentence;
    }, [querySentence]);

    useEffect(() => {
        tablesRef.current = tables;
    }, [tables]);

    useEffect(() => {
        executionSchemaKeyRef.current = executionSchemaKey;
    }, [executionSchemaKey]);

    useEffect(() => {
        onExecuteQueryRef.current = onExecuteQuery;
    }, [onExecuteQuery]);

    const hasExecutedQuery = executedQuery.trim().length > 0;
    const hasDraftChanges = querySentence !== executedQuery;
    const statusLabel = hasDraftChanges ? 'Edited' : queryError ? 'Error' : hasExecutedQuery ? 'Ready' : 'Idle';

    const runQuery = useCallback(() => {
        const nextQuery = queryRef.current;
        onExecuteQueryRef.current?.({
            query: nextQuery,
            schemaKey: executionSchemaKeyRef.current,
            ...executeTimedQuery(tablesRef.current, nextQuery),
        });
    }, []);

    const handleQueryChange = useCallback(
        (value) => {
            const nextQuery = value || '';
            queryRef.current = nextQuery;
            onQuerySentenceChange?.(nextQuery, { source: 'user' });
        },
        [onQuerySentenceChange],
    );

    const clearQuery = useCallback(() => {
        onQuerySentenceChange?.('', { source: 'user' });
        queryRef.current = '';
        onExecuteQueryRef.current?.({ query: '', result: null, elapsedMs: 0, schemaKey: executionSchemaKeyRef.current });
        editorRef.current?.focus();
    }, [onQuerySentenceChange]);

    const queryEditorOptions = useMemo(
        () => ({
            ...monacoOptions,
            ariaLabel: 'Query SQL editor',
            fontSize: 13,
            lineHeight: 20,
            lineNumbersMinChars: 4,
            lineDecorationsWidth: 12,
            folding: true,
            glyphMargin: false,
            minimap: { enabled: false },
            overviewRulerBorder: false,
            padding: { top: 10, bottom: 10 },
            placeholder: 'SELECT *\nFROM users\nWHERE active = true;',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
        }),
        [],
    );

    const handleEditorMount = useCallback((editor, monaco) => {
        monaco.languages.setLanguageConfiguration('sql', languageConfiguration);
        editorRef.current = editor;
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runQuery);
        editor.focus();
    }, [runQuery]);

    return (
        <div className="qv">
            <div className="qv-toolbar">
                <div className="qv-toolbar-main">
                    <span className="qv-toolbar-title">Query</span>
                    <span className={`qv-status qv-status-${statusLabel.toLowerCase()}`}>
                        <span className="qv-status-dot" />
                        {statusLabel}
                    </span>
                </div>
                <div className="qv-toolbar-actions">
                    <button className="qv-action-btn" type="button" onClick={clearQuery} disabled={!querySentence && !executedQuery} title="Clear query">
                        <ClearIcon width="14px" height="14px" />
                        Clear
                    </button>
                    <button className="qv-action-btn qv-action-primary" type="button" onClick={runQuery} disabled={!querySentence.trim()} title="Run query">
                        <SendIcon width="14px" height="14px" />
                        Run
                    </button>
                </div>
            </div>

            <div className="qv-input-bar">
                <div className="qv-editor-shell">
                    <MonacoEditor height="100%" language="sql" theme={theme === 'dark' ? 'vs-dark' : 'vs'} value={querySentence} onChange={handleQueryChange} onMount={handleEditorMount} options={queryEditorOptions} />
                </div>
            </div>

            <div className="qv-result">
                {queryError ? (
                    <>
                        <div className="qv-result-meta qv-result-meta-error">
                            <span className="qv-result-title">Query error</span>
                            <span className="qv-result-stat">{formatElapsedMs(elapsedMs)}</span>
                        </div>
                        <div className="qv-message qv-message-error">{queryError.message}</div>
                    </>
                ) : !queryResult || queryResult.columns.length === 0 ? (
                    <div className="qv-empty">No query result</div>
                ) : (
                    <>
                        <div className="qv-result-meta">
                            <span className="qv-result-title">Results</span>
                            <span className="qv-result-stat">{queryResult.meta.rowCount} rows</span>
                            <span className="qv-result-stat">{queryResult.columns.length} columns</span>
                            <span className="qv-result-stat">{formatElapsedMs(elapsedMs)}</span>
                        </div>
                        <div className="qv-table-wrap">
                            <table className="qv-table" aria-label="Query result table">
                                <thead>
                                    <tr>
                                        <th className="qv-table-rownum" scope="col">
                                            #
                                        </th>
                                        {queryResult.columns.map((column) => (
                                            <th key={column.key} scope="col" title={column.label}>
                                                {column.label}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {queryResult.rows.length === 0 ? (
                                        <tr>
                                            <td colSpan={queryResult.columns.length + 1}>
                                                <div className="qv-empty qv-empty-table">No rows returned</div>
                                            </td>
                                        </tr>
                                    ) : (
                                        queryResult.rows.map((row, rowIndex) => (
                                            <tr key={rowIndex}>
                                                <td className="qv-table-rownum">{rowIndex + 1}</td>
                                                {row.map((value, cellIndex) => (
                                                    <td key={`${rowIndex}-${cellIndex}`}>
                                                        <QueryCellValue value={value} />
                                                    </td>
                                                ))}
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
