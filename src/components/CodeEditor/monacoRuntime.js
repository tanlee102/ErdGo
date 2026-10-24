/** Worker-backed Monaco is loaded only by a mounted CodeEditor, from this app. */
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main.js';
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import MonacoEditor, { loader } from '@monaco-editor/react';

// SQL uses Monarch tokenization in both schema and Query editors.
// Only the core editor worker is needed; unrelated language servers stay out.
self.MonacoEnvironment = {
    ...self.MonacoEnvironment,
    getWorker: () => new EditorWorker(),
};
loader.config({ monaco });

export default MonacoEditor;
