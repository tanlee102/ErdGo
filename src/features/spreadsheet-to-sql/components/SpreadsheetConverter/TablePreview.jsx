/** Bounded visual preview of normalized spreadsheet headers, rows, and inferred SQL values. */
import { formatCellForDisplay } from '@/features/spreadsheet-to-sql/lib/spreadsheetImport';

export default function TablePreview({ activeSheet, model, previewHiddenCount, previewRows }) {
    return (
        <section className="spreadsheet-preview-panel" aria-label="Spreadsheet table preview">
            <div className="spreadsheet-panel-header">
                <div>
                    <span className="spreadsheet-panel-label">Visual preview</span>
                    <h2>{activeSheet.name}</h2>
                </div>
                {previewHiddenCount > 0 && <span className="spreadsheet-row-limit">Showing first 100 rows</span>}
            </div>

            <div className="spreadsheet-table-wrap">
                <table className="spreadsheet-table">
                    <thead>
                        <tr>
                            <th>#</th>
                            {model.columns.map((column) => (
                                <th key={column.name}>
                                    <span>{column.name}</span>
                                    <small>{column.sqlType}</small>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {previewRows.length > 0 ? (
                            previewRows.map((row, rowIndex) => (
                                <tr key={`row-${rowIndex}`}>
                                    <td>{model.previewRowNumbers?.[rowIndex] ?? rowIndex + 1}</td>
                                    {model.columns.map((column, columnIndex) => (
                                        <td key={`${column.name}-${columnIndex}`}>{formatCellForDisplay(row[columnIndex])}</td>
                                    ))}
                                </tr>
                            ))
                        ) : (
                            <tr>
                                <td colSpan={model.columns.length + 1} className="spreadsheet-empty-cell">
                                    No data rows found.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </section>
    );
}
