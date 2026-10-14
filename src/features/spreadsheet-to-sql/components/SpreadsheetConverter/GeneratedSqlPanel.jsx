/** Generated-SQL output panel with copy, SQL download, and issue-report actions. */
import GeneratedSqlEditor from './GeneratedSqlEditor';

export default function GeneratedSqlPanel({ copyStatus, model, onCopySql, onDownloadIssues, onDownloadSql }) {
    const fileName = `${model.tableName || 'uploaded_table'}.sql`;
    const hasSql = Boolean(model.sql?.trim());
    const hasIssues = Boolean(model.issues?.length);

    return (
        <section className="spreadsheet-sql-panel" aria-label="Generated SQL">
            <div className="spreadsheet-panel-header">
                <div>
                    <span className="spreadsheet-panel-label">Generated SQL</span>
                    <h2>{fileName}</h2>
                </div>
                <div className="spreadsheet-sql-actions">
                    <button type="button" className="spreadsheet-secondary-btn" disabled={!hasSql} onClick={onCopySql}>
                        {copyStatus === 'copied' ? 'Copied' : copyStatus === 'failed' ? 'Copy failed' : 'Copy SQL'}
                    </button>
                    {hasIssues && (
                        <button type="button" className="spreadsheet-secondary-btn" onClick={onDownloadIssues}>
                            Download issues
                        </button>
                    )}
                    <button type="button" className="spreadsheet-primary-btn" disabled={!hasSql} onClick={onDownloadSql}>
                        Download
                    </button>
                </div>
            </div>
            <GeneratedSqlEditor fileName={fileName} sql={model.sql} />
        </section>
    );
}
