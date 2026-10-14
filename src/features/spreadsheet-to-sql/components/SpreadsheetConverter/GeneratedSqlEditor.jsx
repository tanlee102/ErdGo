/** Read-only Monaco surface for generated SQL plus compact line/character statistics. */
import { useContext, useMemo } from 'react';
import MonacoEditor from '@monaco-editor/react';
import { ThemeContext } from '@/contexts/ThemeContext';
import { languageConfiguration } from '@/config/languageConfiguration';
import { monacoOptions } from '@/config/monacoOptions';

const generatedSqlOptions = {
    ...monacoOptions,
    readOnly: true,
    domReadOnly: true,
    folding: true,
    wordWrap: 'on',
    wrappingIndent: 'same',
    scrollBeyondLastLine: false,
    renderLineHighlight: 'line',
    minimap: { enabled: false },
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    acceptSuggestionOnEnter: 'off',
    parameterHints: { enabled: false },
    scrollbar: {
        alwaysConsumeMouseWheel: false,
    },
};

function getEditorStats(sql) {
    if (!sql?.trim()) {
        return {
            lineCount: 0,
            statementCount: 0,
        };
    }

    return {
        lineCount: sql.split(/\r\n|\n|\r/).length,
        statementCount: sql
            .split(';')
            .map((statement) => statement.trim())
            .filter(Boolean).length,
    };
}

export default function GeneratedSqlEditor({ fileName, sql = '' }) {
    const { theme } = useContext(ThemeContext);
    const editorTheme = theme === 'dark' ? 'vs-dark' : 'vs';
    const stats = useMemo(() => getEditorStats(sql), [sql]);

    return (
        <div className="spreadsheet-sql-editor-card">
            <div className="spreadsheet-sql-editor-toolbar">
                <div className="spreadsheet-sql-tab" title={fileName}>
                    <span className="spreadsheet-sql-dot" aria-hidden="true" />
                    <strong>{fileName}</strong>
                </div>
                <span className="spreadsheet-sql-meta">
                    Read-only preview | {stats.lineCount} line{stats.lineCount === 1 ? '' : 's'} | {stats.statementCount} statement{stats.statementCount === 1 ? '' : 's'}
                </span>
            </div>
            <div className="spreadsheet-sql-monaco-shell">
                <MonacoEditor
                    height="100%"
                    language="sql"
                    theme={editorTheme}
                    value={sql}
                    onMount={(_, monaco) => {
                        monaco.languages.setLanguageConfiguration('sql', languageConfiguration);
                    }}
                    options={generatedSqlOptions}
                />
            </div>
        </div>
    );
}
