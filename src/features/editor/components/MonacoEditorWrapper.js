import { useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { format as formatSQL } from 'sql-formatter';
import { ThemeContext } from '@/contexts/ThemeContext';
import { monacoOptions } from '@/config/monacoOptions';
import { languageConfiguration } from '@/config/languageConfiguration';
import { findCreateTableMatchInSql } from '../lib/sqlTabs';
import { renderDiffBlocks } from '../lib/renderDiffBlocks';
import MonacoEditor from '@monaco-editor/react';

// 📐 SQL Format config - synced with monacoOptions
const sqlFormatConfig = {
    language: 'mysql',
    tabWidth: monacoOptions.tabSize || 2, // Taken from monacoOptions
    useTabs: !monacoOptions.insertSpaces, // false = use spaces
    keywordCase: 'upper',
    dataTypeCase: 'upper',
    functionCase: 'upper',
    identifierCase: 'preserve',
    linesBetweenQueries: 2,
};

function getValidJumpLocation(location, model) {
    const line = Number(location?.line);
    if (!Number.isInteger(line) || line < 1 || line > model.getLineCount()) {
        return null;
    }

    const lineContent = model.getLineContent(line);
    const column = Number.isInteger(location?.column) ? Math.max(1, Math.min(location.column, lineContent.length + 1)) : 1;

    return { line, column };
}

export function syncEditorModelValue(editor, nextValue) {
    const model = editor?.getModel?.();
    if (!model || model.isDisposed?.() || typeof nextValue !== 'string') return false;
    if (model.getValue?.() === nextValue) return false;

    model.setValue(nextValue);
    return true;
}

export function listenForEditorModelChanges(editor, getCurrentCode) {
    return (
        editor?.onDidChangeModel?.(() => {
            syncEditorModelValue(editor, getCurrentCode());
        }) || null
    );
}

export function syncEditorModelOnMount(editor, currentCodeRef) {
    return syncEditorModelValue(editor, currentCodeRef?.current || '');
}

export function scheduleEditorModelSync(editor, getCurrentCode) {
    const sync = () => syncEditorModelValue(editor, getCurrentCode());
    sync();

    // Monaco can attach its cached tab model after React has committed the
    // new value, and slow extension/worker loading can make that attachment
    // happen later than the first frame. Retry briefly so a loaded active tab
    // is never left showing an empty/stale model until the user switches tabs.
    const timeoutIds = [0, 16, 50, 150, 350].map((delay) => window.setTimeout(sync, delay));
    const frameIds = [];
    if (typeof window.requestAnimationFrame === 'function') {
        const scheduleFrameSync = (remainingFrames) => {
            const frameId = window.requestAnimationFrame(() => {
                sync();
                if (remainingFrames > 1) scheduleFrameSync(remainingFrames - 1);
            });
            frameIds.push(frameId);
        };
        scheduleFrameSync(3);
    }

    return () => {
        timeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
        if (typeof window.cancelAnimationFrame === 'function') {
            frameIds.forEach((frameId) => window.cancelAnimationFrame(frameId));
        }
    };
}

export function captureEditorViewState(editor) {
    const model = editor?.getModel?.();
    if (!model || model.isDisposed?.()) return null;

    return {
        position: editor.getPosition?.() || null,
        scrollTop: editor.getScrollTop?.(),
        scrollLeft: editor.getScrollLeft?.(),
    };
}

export function restoreEditorViewState(editor, savedState) {
    const model = editor?.getModel?.();
    if (!model || model.isDisposed?.() || !savedState) return false;

    const position = getValidJumpLocation(
        {
            line: savedState.position?.lineNumber,
            column: savedState.position?.column,
        },
        model,
    );
    if (position) {
        editor.setPosition?.({ lineNumber: position.line, column: position.column });
    }
    if (Number.isFinite(savedState.scrollLeft)) {
        editor.setScrollLeft?.(savedState.scrollLeft);
    }
    if (Number.isFinite(savedState.scrollTop)) {
        editor.setScrollTop?.(savedState.scrollTop);
    }

    return true;
}

export default function MonacoEditorWrapper({ sqlInput, setSqlInput, editorPath = 'sql-editor.sql', modelReloadKey = 0, setIsEditorReady, showAiSuggestions, currentlyProcessingAi, displayData, handleAcceptBlock, handleRejectBlock, parseErrors, onRegisterAiReviewViewStateCapture }) {
    const { theme } = useContext(ThemeContext);
    const editorRef = useRef(null);
    const monacoRef = useRef(null);
    const jumpHighlightTimerRef = useRef(null);
    const jumpDecorationsRef = useRef(null);
    const showAiSuggestionsRef = useRef(showAiSuggestions);
    const currentCodeRef = useRef('');
    const modelChangeListenerRef = useRef(null);
    const mountModelSyncCleanupRef = useRef(null);
    const previewViewStatesRef = useRef(new Map());
    const wasReviewingRef = useRef(showAiSuggestions);
    const currentCode = showAiSuggestions ? displayData?.code : sqlInput;
    const modelPath = showAiSuggestions ? `${editorPath}.ai-review` : editorPath;

    useEffect(() => {
        showAiSuggestionsRef.current = showAiSuggestions;
    }, [showAiSuggestions]);

    useEffect(() => {
        if (!onRegisterAiReviewViewStateCapture) return undefined;

        const captureCurrentPreviewView = () => {
            if (!showAiSuggestions) return false;
            const state = captureEditorViewState(editorRef.current);
            if (!state) return false;
            previewViewStatesRef.current.set(editorPath, state);
            return true;
        };

        onRegisterAiReviewViewStateCapture(captureCurrentPreviewView);
        return () => onRegisterAiReviewViewStateCapture(null);
    }, [editorPath, onRegisterAiReviewViewStateCapture, showAiSuggestions]);

    // Preview and live SQL deliberately use separate Monaco models. Remember
    // each preview tab's view so accepting the review never returns the user
    // to the top of the corresponding live tab.
    useEffect(() => {
        const previewEditor = editorRef.current;
        const previewModel = previewEditor?.getModel?.();
        if (!showAiSuggestions || !previewModel || previewModel.isDisposed?.()) return undefined;

        const savePreviewViewState = () => {
            // Tab switches can replace the editor model before this effect's
            // cleanup runs. Never write that newer tab's state under the old
            // tab id.
            if (editorRef.current !== previewEditor || previewEditor.getModel?.() !== previewModel) return;
            const state = captureEditorViewState(previewEditor);
            if (state) previewViewStatesRef.current.set(editorPath, state);
        };
        savePreviewViewState();

        const scrollListener = previewEditor.onDidScrollChange?.(savePreviewViewState);
        const cursorListener = previewEditor.onDidChangeCursorPosition?.(savePreviewViewState);
        return () => {
            savePreviewViewState();
            scrollListener?.dispose?.();
            cursorListener?.dispose?.();
        };
    }, [currentCode, editorPath, showAiSuggestions]);

    const handleEditorDidMount = (editor, monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;
        syncEditorModelOnMount(editor, currentCodeRef);
        mountModelSyncCleanupRef.current?.();
        mountModelSyncCleanupRef.current = scheduleEditorModelSync(editor, () => currentCodeRef.current);
        modelChangeListenerRef.current?.dispose?.();
        modelChangeListenerRef.current = listenForEditorModelChanges(editor, () => currentCodeRef.current);
        window.monaco = monaco;
        setIsEditorReady(true);
        monaco.languages.setLanguageConfiguration('sql', languageConfiguration);

        // 🎨 Register Format Document provider for SQL
        monaco.languages.registerDocumentFormattingEditProvider('sql', {
            provideDocumentFormattingEdits: (model) => {
                const text = model.getValue();
                if (!text?.trim()) return [];

                try {
                    const formatted = formatSQL(text, sqlFormatConfig);

                    return [
                        {
                            range: model.getFullModelRange(),
                            text: formatted,
                        },
                    ];
                } catch {
                    return [];
                }
            },
        });

        // 🎹 Add keyboard shortcut: Shift+Alt+F (Windows) or Shift+Option+F (Mac)
        editor.addAction({
            id: 'format-sql',
            label: 'Format SQL',
            keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
            run: () => {
                if (!showAiSuggestionsRef.current) {
                    editor.getAction('editor.action.formatDocument').run();
                }
            },
        });

        // 🌐 Expose format function globally for button access
        window.formatSqlCode = () => {
            if (!showAiSuggestionsRef.current) {
                editor.getAction('editor.action.formatDocument').run();
            }
        };

        // 🎯 Expose jump-to-table function for ERD → SQL navigation
        window.jumpToTableInEditor = (tableName, location = null) => {
            if (!editor || !tableName) return;

            const model = editor.getModel();
            if (!model || model.isDisposed()) return;

            const targetLocation = getValidJumpLocation(location, model) || getValidJumpLocation(findCreateTableMatchInSql(model.getValue(), tableName), model);
            if (!targetLocation) return;

            // Clear any previous highlight (prevent stacking on rapid clicks)
            if (jumpHighlightTimerRef.current) {
                clearTimeout(jumpHighlightTimerRef.current);
                jumpHighlightTimerRef.current = null;
            }
            if (jumpDecorationsRef.current) {
                jumpDecorationsRef.current.clear();
                jumpDecorationsRef.current = null;
            }

            // Scroll to the line centered in viewport
            editor.revealLineInCenter(targetLocation.line);

            // Select the CREATE TABLE line for visual feedback
            const lineContent = model.getLineContent(targetLocation.line);
            editor.setSelection({
                startLineNumber: targetLocation.line,
                startColumn: 1,
                endLineNumber: targetLocation.line,
                endColumn: lineContent.length + 1,
            });

            // Position cursor at the matched CREATE keyword column.
            editor.setPosition({ lineNumber: targetLocation.line, column: targetLocation.column });

            // Apply flash highlight decoration
            jumpDecorationsRef.current = editor.createDecorationsCollection([
                {
                    range: new monaco.Range(targetLocation.line, 1, targetLocation.line, lineContent.length + 1),
                    options: {
                        className: 'jump-to-table-highlight',
                        isWholeLine: true,
                    },
                },
            ]);

            // Auto-clear highlight after animation completes
            jumpHighlightTimerRef.current = setTimeout(() => {
                if (jumpDecorationsRef.current) {
                    jumpDecorationsRef.current.clear();
                    jumpDecorationsRef.current = null;
                }
                jumpHighlightTimerRef.current = null;
            }, 1500);

            // Focus the editor
            editor.focus();
        };
    };

    // Cleanup global functions and timers on unmount
    useEffect(() => {
        return () => {
            delete window.jumpToTableInEditor;
            delete window.formatSqlCode;
            if (jumpHighlightTimerRef.current) {
                clearTimeout(jumpHighlightTimerRef.current);
            }
            if (jumpDecorationsRef.current) {
                jumpDecorationsRef.current.clear();
            }
            modelChangeListenerRef.current?.dispose?.();
            modelChangeListenerRef.current = null;
            mountModelSyncCleanupRef.current?.();
            mountModelSyncCleanupRef.current = null;
        };
    }, []);

    // Render diff decorations
    useEffect(() => {
        let cleanup = null;

        if (editorRef.current && monacoRef.current && showAiSuggestions && displayData?.visibleBlocks?.length > 0) {
            cleanup = renderDiffBlocks(editorRef.current, monacoRef.current, displayData.visibleBlocks, handleAcceptBlock, handleRejectBlock);
        }

        return () => {
            if (typeof cleanup === 'function') {
                cleanup();
            }
        };
    }, [displayData?.visibleBlocks, showAiSuggestions, handleAcceptBlock, handleRejectBlock]);

    // 🎯 Render error markers (red/yellow underlines)
    useEffect(() => {
        const editor = editorRef.current;
        const monaco = monacoRef.current;
        if (!editor || !monaco) return;

        const model = editor.getModel();
        if (!model) return;

        // Get total lines to validate line numbers
        const totalLines = model.getLineCount();

        if (parseErrors && parseErrors.length > 0) {
            // Convert parse errors to Monaco markers (limit to 10 markers for performance)
            const markers = parseErrors
                .filter((err) => err.line && err.line > 0 && err.line <= totalLines)
                .slice(0, 10) // Limit markers for performance
                .map((err) => {
                    const lineNumber = err.line;
                    const columnStart = Math.max(1, err.column || 1);

                    // Get line content to determine end column
                    let lineContent = '';
                    try {
                        lineContent = model.getLineContent(lineNumber);
                    } catch {
                        return null;
                    }

                    const lineLength = lineContent?.length || 0;
                    // Underline from column to end of line, or at least 10 characters
                    const columnEnd = Math.max(columnStart + 1, lineLength + 1);

                    return {
                        severity:
                            err.severity === 'error'
                                ? monaco.MarkerSeverity.Error // 🔴 Red
                                : monaco.MarkerSeverity.Warning, // 🟡 Yellow
                        message: err.message,
                        startLineNumber: lineNumber,
                        startColumn: columnStart,
                        endLineNumber: lineNumber,
                        endColumn: columnEnd,
                    };
                })
                .filter(Boolean);

            monaco.editor.setModelMarkers(model, 'sql-parser', markers);
        } else {
            monaco.editor.setModelMarkers(model, 'sql-parser', []);
        }

        // Cleanup on unmount or when errors change
        return () => {
            try {
                if (model && !model.isDisposed() && monaco?.editor) {
                    monaco.editor.setModelMarkers(model, 'sql-parser', []);
                }
            } catch {
                // Model already disposed - ignore
            }
        };
    }, [editorPath, parseErrors]);

    useLayoutEffect(() => {
        const wasReviewing = wasReviewingRef.current;
        wasReviewingRef.current = showAiSuggestions;
        if (showAiSuggestions || !wasReviewing) return undefined;

        const savedState = previewViewStatesRef.current.get(editorPath);
        if (!savedState) return undefined;

        let firstFrameId = null;
        let secondFrameId = null;
        const restore = () => restoreEditorViewState(editorRef.current, savedState);
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            // The first frame lets Monaco attach the live model; the second
            // restores scroll after it has measured the model's layout.
            firstFrameId = window.requestAnimationFrame(() => {
                secondFrameId = window.requestAnimationFrame(restore);
            });
            return () => {
                window.cancelAnimationFrame(firstFrameId);
                if (secondFrameId !== null) window.cancelAnimationFrame(secondFrameId);
            };
        }

        const timeoutId = setTimeout(restore, 0);
        return () => clearTimeout(timeoutId);
    }, [editorPath, showAiSuggestions]);

    // Monaco retains a model for each tab path. Keep both review and live
    // models synchronized so accepting a tab action updates the active tab
    // immediately rather than waiting for a tab switch to replace its model.
    useLayoutEffect(() => {
        currentCodeRef.current = currentCode || '';
        return scheduleEditorModelSync(editorRef.current, () => currentCodeRef.current);
    }, [currentCode, editorPath, showAiSuggestions]);

    return (
        <div className="editor-container">
            <MonacoEditor
                // Recreate only after persisted tab hydration. Preview/live
                // transitions must retain the same editor so accept/reject
                // can preserve the user's scroll position.
                key={`hydration:${modelReloadKey}`}
                height="100%"
                language="sql"
                path={modelPath}
                theme={theme === 'dark' ? 'vs-dark' : 'vs'}
                value={currentCode}
                onChange={(value) => {
                    if (!showAiSuggestions) {
                        setSqlInput(value || '');
                    }
                }}
                onMount={handleEditorDidMount}
                options={{
                    ...monacoOptions,
                    readOnly: showAiSuggestions || currentlyProcessingAi,
                    glyphMargin: true,
                }}
            />
        </div>
    );
}
