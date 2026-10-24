// @vitest-environment jsdom
import React, { useLayoutEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CodeEditor from '@/components/CodeEditor';
import { getLoadedCodeEditor, loadCodeEditor } from '@/components/CodeEditor/loadCodeEditor';

vi.mock('@/components/CodeEditor/loadCodeEditor', () => ({ getLoadedCodeEditor: vi.fn(), loadCodeEditor: vi.fn() }));
let mount;
function EnhancedEditor({ onMount }) {
    useLayoutEffect(() => { mount = onMount; }, [onMount]);
    return <div data-testid="enhanced-editor" />;
}
function controlledEditor({ initial = 'CREATE TABLE users(id INT);', path = '/schema.sql', options, onMount } = {}) {
    function Harness() {
        const [value, setValue] = useState(initial);
        return <CodeEditor value={value} onChange={setValue} path={path} options={options} onMount={onMount} />;
    }
    return render(<Harness />);
}
function editorApi(path = '/schema.sql', initial = '') {
    let text = initial;
    let model = { uri: { path }, getValue: () => text, setValue: vi.fn(value => { text = value; }) };
    let changeModel;
    const dispose = vi.fn();
    return {
        getModel: () => model,
        onDidChangeModel: callback => { changeModel = callback; return { dispose }; },
        attach: next => { model = next; changeModel(); },
        setSelection: vi.fn(), setScrollTop: vi.fn(), setScrollLeft: vi.fn(), focus: vi.fn(), dispose,
    };
}

describe('nonblocking code editor startup', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        getLoadedCodeEditor.mockReset().mockReturnValue(null);
        loadCodeEditor.mockReset().mockImplementation(() => new Promise(() => {}));
        mount = null;
    });
    afterEach(() => { cleanup(); delete window.monaco; vi.useRealTimers(); vi.restoreAllMocks(); });

    it('shows controlled source immediately and remains editable through a stalled download', () => {
        controlledEditor();
        const source = screen.getByRole('textbox', { name: 'Editor content' });
        expect(source).toHaveValue('CREATE TABLE users(id INT);');
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
        act(() => vi.advanceTimersByTime(8000));
        expect(screen.getByRole('status')).toHaveTextContent('You can keep editing.');
        expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
        fireEvent.change(source, { target: { value: 'CREATE TABLE edited(id INT);' } });
        expect(source).toHaveValue('CREATE TABLE edited(id INT);');
    });

    it('transfers late edits, selection, focus and scroll only after the correct model is ready', async () => {
        let resolve;
        loadCodeEditor.mockImplementation(() => new Promise(done => { resolve = done; }));
        const onMount = vi.fn();
        controlledEditor({ onMount });
        const source = screen.getByRole('textbox');
        fireEvent.change(source, { target: { value: '-- edited\nCREATE TABLE latest(id INT);' } });
        source.focus(); source.setSelectionRange(10, 16); source.scrollTop = 42;
        await act(async () => resolve(EnhancedEditor));
        const editor = editorApi('/old-tab.sql', 'protected SQL');
        const oldModel = editor.getModel();
        const monaco = { editor: {} };
        act(() => mount(editor, monaco));
        expect(oldModel.setValue).not.toHaveBeenCalled();
        expect(onMount).not.toHaveBeenCalled();
        expect(window.monaco).toBeUndefined();
        expect(source).toBeVisible();
        let latestText = '';
        const latestModel = { uri: { path: '/schema.sql' }, getValue: () => latestText, setValue: value => { latestText = value; } };
        act(() => editor.attach(latestModel));
        expect(window.monaco).toBe(monaco);
        expect(onMount).toHaveBeenCalledOnce();
        expect(latestText).toBe('-- edited\nCREATE TABLE latest(id INT);');
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
        expect(editor.setSelection).toHaveBeenCalledWith({ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 7 });
        expect(editor.setScrollTop).toHaveBeenCalledWith(42);
        expect(editor.focus).toHaveBeenCalledOnce();
        expect(editor.dispose).toHaveBeenCalledOnce();
    });

    it('recovers a rejected download without reloading or losing source', async () => {
        loadCodeEditor.mockRejectedValueOnce(new Error('download unavailable')).mockResolvedValue(EnhancedEditor);
        controlledEditor();
        await act(async () => {});
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'SELECT 42;' } });
        await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
        const editor = editorApi();
        act(() => mount(editor, {}));
        expect(editor.getModel().getValue()).toBe('SELECT 42;');
        expect(loadCodeEditor).toHaveBeenCalledTimes(2);
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('lets a timed-out attempt upgrade later while keeping the latest source', async () => {
        let resolve;
        loadCodeEditor.mockImplementation(() => new Promise(done => { resolve = done; }));
        controlledEditor();
        act(() => vi.advanceTimersByTime(8000));
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'SELECT 99;' } });
        await act(async () => resolve(EnhancedEditor));
        const editor = editorApi();
        act(() => mount(editor, {}));
        expect(editor.getModel().getValue()).toBe('SELECT 99;');
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('preserves read-only AI reviews and generated previews before initialization', () => {
        const onChange = vi.fn();
        render(<CodeEditor value="protected SQL" onChange={onChange} options={{ readOnly: true }} />);
        const source = screen.getByRole('textbox');
        expect(source).toHaveAttribute('readonly');
        fireEvent.change(source, { target: { value: 'invalid edit' } });
        expect(onChange).not.toHaveBeenCalled();
    });

    it('does not interrupt an active IME composition with an editor replacement', async () => {
        let resolve;
        loadCodeEditor.mockImplementation(() => new Promise(done => { resolve = done; }));
        controlledEditor();
        const source = screen.getByRole('textbox');
        fireEvent.compositionStart(source);
        fireEvent.change(source, { target: { value: '-- tiếng Việt' } });
        await act(async () => resolve(EnhancedEditor));
        expect(screen.queryByTestId('enhanced-editor')).not.toBeInTheDocument();
        expect(source).toHaveValue('-- tiếng Việt');
        fireEvent.compositionEnd(source);
        expect(screen.getByTestId('enhanced-editor')).toBeInTheDocument();
        const editor = editorApi();
        act(() => mount(editor, {}));
        expect(editor.getModel().getValue()).toBe('-- tiếng Việt');
    });

    it('ignores startup completion after unmount and cancels feedback timers', async () => {
        let resolve;
        loadCodeEditor.mockImplementation(() => new Promise(done => { resolve = done; }));
        const { unmount } = controlledEditor();
        unmount();
        await act(async () => resolve(EnhancedEditor));
        expect(mount).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps source available when editor construction fails, then retries cleanly', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        function BrokenEditor() { throw new Error('widget failed'); }
        loadCodeEditor.mockResolvedValueOnce(BrokenEditor).mockResolvedValue(EnhancedEditor);
        controlledEditor();
        await act(async () => {});
        expect(screen.getByRole('textbox')).toHaveValue('CREATE TABLE users(id INT);');
        await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
        act(() => mount(editorApi(), {}));
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
        error.mockRestore();
    });
});
