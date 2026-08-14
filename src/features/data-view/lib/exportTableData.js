/** Serializes materialized Data View rows to safe downloadable CSV. */
const CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/;

function getColumnName(column) {
    if (column && typeof column === 'object') return column.name || '';
    return String(column || '');
}

function formatDateForCsv(value) {
    if (Number.isNaN(value.getTime())) return '';
    return value.toISOString();
}

function normalizeCellValue(value) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return formatDateForCsv(value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);

    const text = String(value);
    return CSV_FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

export function escapeCsvCell(value) {
    const text = normalizeCellValue(value);
    const escaped = text.replaceAll('"', '""');
    return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

export function buildTableCsv(table) {
    const columns = Array.isArray(table?.columns) ? table.columns : [];
    const rows = Array.isArray(table?.rows) ? table.rows : [];
    const columnNames = columns.map(getColumnName).filter(Boolean);

    const csvRows = [columnNames.map(escapeCsvCell)];

    rows.forEach((row) => {
        csvRows.push(columnNames.map((name) => escapeCsvCell(row?.[name])));
    });

    return `${csvRows.map((row) => row.join(',')).join('\r\n')}\r\n`;
}

export function sanitizeCsvFileName(value, fallback = 'table') {
    const cleaned = String(value || '')
        .trim()
        .replace(/[^a-z0-9._-]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);

    return cleaned || fallback;
}

export function buildTableCsvDownload(table, now = new Date()) {
    const stamp = now.toISOString().replace(/\.\d{3}Z$/, '').replace(/[:T]/g, '-');
    const tableName = sanitizeCsvFileName(table?.name, 'table-data');

    return {
        csv: `\uFEFF${buildTableCsv(table)}`,
        fileName: `${tableName}-${stamp}.csv`,
    };
}
