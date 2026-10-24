/** Controlled code surface: source is editable before optional editor tools load. */
import { Component, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getLoadedCodeEditor, loadCodeEditor } from './loadCodeEditor';
import './index.css';

class EditorToolsBoundary extends Component {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    componentDidCatch() { this.props.onFailure(); }
    render() { return this.state.failed ? null : this.props.children; }
}

function textPosition(value, offset) {
    const lines = value.slice(0, offset).split('\n');
    return { lineNumber: lines.length, column: lines.at(-1).length + 1 };
}

export default function CodeEditor({ value = '', onChange, onMount, options = {}, height = '100%', width = '100%', ...editorProps }) {
    const [Editor, setEditor] = useState(() => getLoadedCodeEditor());
    const [ready, setReady] = useState(false);
    const [notice, setNotice] = useState(null);
    const [attempt, setAttempt] = useState(0);
    const [composing, setComposing] = useState(false);
    const fallbackRef = useRef(null);
    const interactedRef = useRef(false);
    const readyRef = useRef(false);
    const latestRef = useRef(null);
    const modelListenerRef = useRef(null);
    const mountedEditorRef = useRef(null);
    const focusOnReadyRef = useRef(false);
    const path = editorProps.path || editorProps.defaultPath;
    const sourceRef = useRef({ value, path });
    useLayoutEffect(() => { sourceRef.current = { value, path }; }, [value, path]);
    useLayoutEffect(() => { latestRef.current = { onMount, attempt }; });
    useLayoutEffect(() => {
        // A hidden widget cannot receive browser focus. Wait for React to
        // reveal it before handing off the active source field's caret.
        if (ready && focusOnReadyRef.current) {
            focusOnReadyRef.current = false;
            mountedEditorRef.current?.focus?.();
        }
    }, [ready]);
    useEffect(() => () => {
        mountedEditorRef.current = null;
        modelListenerRef.current?.dispose?.();
    }, []);

    useEffect(() => {
        let active = true;
        readyRef.current = false;
        setNotice(null);
        const showProgress = window.setTimeout(() => {
            if (!readyRef.current) setNotice('preparing');
        }, 150);
        // A failed or stalled enhancement never hides the source or blocks work.
        // Late success may still upgrade this same attempt without a page reload.
        const deadline = window.setTimeout(() => {
            if (!readyRef.current) setNotice('recover');
        }, 8000);
        loadCodeEditor().then(editor => {
            if (active) setEditor(() => editor);
        }).catch(() => {
            if (!active) return;
            window.clearTimeout(showProgress);
            window.clearTimeout(deadline);
            setNotice('recover');
        });
        return () => {
            active = false;
            window.clearTimeout(showProgress);
            window.clearTimeout(deadline);
        };
    }, [attempt]);

    const handleMount = (editor, monaco) => {
        if (latestRef.current.attempt !== attempt) return;
        mountedEditorRef.current = editor;
        const finish = () => {
            if (mountedEditorRef.current !== editor) return;
            const current = sourceRef.current;
            const model = editor.getModel?.();
            // Cached tab models may attach after mount. Never replace the
            // source surface with the wrong tab or write its SQL into that tab.
            if (!model || model.isDisposed?.() || current.path && model.uri?.path !== current.path) return;
            // Consumers may reject source edits while their editor ref owns a
            // different tab. Publish this widget only after its model matches.
            latestRef.current.onMount?.(editor, monaco);
            if (model.getValue() !== current.value) model.setValue(current.value);
            // The previous CDN runtime exposed this API for every workspace,
            // including the schema and Query editors. Publish it only after
            // this widget owns the correct model, so model access means ready.
            window.monaco = monaco;
            const fallback = fallbackRef.current;
            const focused = document.activeElement === fallback;
            if (fallback && interactedRef.current) {
                const start = textPosition(fallback.value, fallback.selectionStart);
                const end = textPosition(fallback.value, fallback.selectionEnd);
                editor.setSelection?.({ startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column });
                editor.setScrollTop?.(fallback.scrollTop);
                editor.setScrollLeft?.(fallback.scrollLeft);
                focusOnReadyRef.current = focused;
            }
            modelListenerRef.current?.dispose?.();
            modelListenerRef.current = null;
            readyRef.current = true;
            setReady(true);
            setNotice(null);
        };
        modelListenerRef.current?.dispose?.();
        modelListenerRef.current = editor.onDidChangeModel?.(finish);
        finish();
    };

    const handleFailure = () => {
        focusOnReadyRef.current = false;
        mountedEditorRef.current = null;
        modelListenerRef.current?.dispose?.();
        modelListenerRef.current = null;
        readyRef.current = false;
        setReady(false);
        setEditor(null);
        setNotice('recover');
    };
    const retry = () => {
        focusOnReadyRef.current = false;
        modelListenerRef.current?.dispose?.();
        modelListenerRef.current = null;
        mountedEditorRef.current = null;
        readyRef.current = false;
        setReady(false);
        setEditor(null);
        setAttempt(number => number + 1);
        fallbackRef.current?.focus();
    };
    const readOnly = options.readOnly === true || options.domReadOnly === true;

    return (
        <div className="code-editor" style={{ height, width }}>
            {Editor && !composing && (
                <div className={`code-editor-rich${ready ? ' is-ready' : ''}`} aria-hidden={!ready || undefined}>
                    <EditorToolsBoundary key={attempt} onFailure={handleFailure}>
                        <Editor {...editorProps} value={value} onChange={onChange} onMount={handleMount} options={options} height="100%" width="100%" loading={null} />
                    </EditorToolsBoundary>
                </div>
            )}
            {!ready && (
                <>
                    <textarea
                        ref={fallbackRef}
                        className="code-editor-source"
                        aria-label={options.ariaLabel || 'Editor content'}
                        data-editor-path={editorProps.path}
                        value={value}
                        readOnly={readOnly}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        wrap={options.wordWrap === 'on' ? 'soft' : 'off'}
                        style={{ fontSize: options.fontSize || 13, tabSize: options.tabSize || 2 }}
                        onChange={event => {
                            if (readOnly) return;
                            interactedRef.current = true;
                            sourceRef.current = { path, value: event.target.value };
                            onChange?.(event.target.value);
                        }}
                        onFocus={() => { interactedRef.current = true; }}
                        onScroll={() => { interactedRef.current = true; }}
                        onCompositionStart={() => setComposing(true)}
                        onCompositionEnd={() => setComposing(false)}
                    />
                    {notice && (
                        <div className="code-editor-status" role="status">
                            <span>{notice === 'recover' ? 'Editor tools aren’t ready. You can keep editing.' : 'Preparing editor…'}</span>
                            {notice === 'recover' && <button type="button" onClick={retry}>Retry</button>}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
