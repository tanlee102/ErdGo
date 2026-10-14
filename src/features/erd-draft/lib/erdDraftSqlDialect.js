/** Bounded, portable types and identifiers for conceptual-model SQL generation. */
export const ERD_DRAFT_SQL_DIALECTS = [
    { id: 'sqlite', label: 'SQLite', detail: 'Local and embedded databases' },
    { id: 'postgres', label: 'PostgreSQL', detail: 'Native boolean, UUID, and JSON types' },
    { id: 'mysql', label: 'MySQL', detail: 'MySQL 8.0.16+, InnoDB with utf8mb4 and a 16 KB page size' },
    { id: 'mssql', label: 'SQL Server', detail: 'SQL Server 2016+, Unicode text and filtered unique indexes' },
];

export const ERD_DRAFT_SQL_TYPES = [
    { id: 'auto', label: 'Use attribute domain' },
    { id: 'text', label: 'Text' },
    { id: 'integer', label: 'Integer' },
    { id: 'decimal', label: 'Decimal' },
    { id: 'boolean', label: 'Boolean' },
    { id: 'date', label: 'Date' },
    { id: 'timestamp', label: 'Date and time' },
    { id: 'uuid', label: 'UUID' },
    { id: 'json', label: 'JSON' },
];

export function draftSqlIdentifier(value, fallback = 'item') {
    const name = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '').toLowerCase();
    return (name ? (/^\d/.test(name) ? `_${name}` : name) : fallback).slice(0, 63);
}

export function quoteDraftSqlIdentifier(value, dialect) {
    if (dialect === 'mysql') return `\`${String(value).replace(/`/g, '``')}\``;
    if (dialect === 'mssql') return `[${String(value).replace(/\]/g, ']]')}]`;
    return `"${String(value).replace(/"/g, '""')}"`;
}

/** Domains are data, never executable SQL. Unknown prose gets an explicit fallback. */
export function resolveDraftSqlType(domain, override, dialect, key = false) {
    const portable = {
        text: dialect === 'mssql' ? `NVARCHAR(${key ? 128 : 255})` : `VARCHAR(${key ? 128 : 255})`,
        integer: dialect === 'sqlite' ? 'INTEGER' : 'BIGINT',
        decimal: 'DECIMAL(18, 4)',
        boolean: dialect === 'postgres' ? 'BOOLEAN' : dialect === 'mysql' ? 'BOOLEAN' : dialect === 'mssql' ? 'BIT' : 'INTEGER',
        date: 'DATE',
        timestamp: dialect === 'mssql' ? 'DATETIME2' : dialect === 'mysql' ? 'DATETIME' : dialect === 'sqlite' ? 'TEXT' : 'TIMESTAMP',
        uuid: dialect === 'postgres' ? 'UUID' : dialect === 'mssql' ? 'UNIQUEIDENTIFIER' : 'CHAR(36)',
        json: dialect === 'postgres' ? 'JSONB' : dialect === 'mysql' ? 'JSON' : dialect === 'mssql' ? 'NVARCHAR(MAX)' : 'TEXT',
    };
    if (override && override !== 'auto' && portable[override]) return { type: portable[override], assumed: false, boolean: override === 'boolean' };
    const raw = typeof domain === 'string' ? domain.trim().toUpperCase().replace(/\s+/g, ' ') : '';
    if (!raw) return { type: portable.text, assumed: true };
    const alias = { STRING: 'text', BOOLEAN: 'boolean', BOOL: 'boolean', BIT: 'boolean', UUID: 'uuid', UNIQUEIDENTIFIER: 'uuid', JSON: 'json', JSONB: 'json', DATETIME: 'timestamp', DATETIME2: 'timestamp', TIMESTAMP: 'timestamp' };
    if (alias[raw]) return { type: portable[alias[raw]], assumed: false, boolean: alias[raw] === 'boolean' };
    if (/^(?:SMALLINT|INT|INTEGER|BIGINT|TINYINT)$/.test(raw)) return { type: dialect === 'sqlite' ? 'INTEGER' : raw === 'TINYINT' && dialect === 'postgres' ? 'SMALLINT' : raw === 'INTEGER' ? 'INT' : raw, assumed: false };
    if (/^(?:DATE|TIME|REAL|FLOAT)$/.test(raw)) return { type: raw, assumed: false };
    if (/^DOUBLE(?: PRECISION)?$/.test(raw)) return { type: dialect === 'postgres' ? 'DOUBLE PRECISION' : dialect === 'mssql' ? 'FLOAT' : 'DOUBLE', assumed: false };
    const sized = raw.match(/^(N?VARCHAR|N?CHAR)\s*\(\s*(\d+)\s*\)$/);
    const maxSize = dialect === 'mssql' ? 4000 : dialect === 'mysql' ? (/CHAR$/.test(sized?.[1] || '') && !/VARCHAR$/.test(sized?.[1] || '') ? 255 : 16383) : 10485760;
    if (sized && Number(sized[2]) >= 1 && Number(sized[2]) <= maxSize) {
        const type = dialect === 'mssql' ? sized[1].replace(/^N?/, 'N') : sized[1].replace(/^N/, '');
        return { type: `${type}(${Number(sized[2])})`, assumed: false };
    }
    const decimal = raw.match(/^(?:DECIMAL|NUMERIC)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?$/);
    if (decimal && (!decimal[1] || (Number(decimal[1]) >= 1 && Number(decimal[1]) <= 38 && Number(decimal[2] || 0) <= Number(decimal[1])))) {
        return { type: decimal[1] ? `DECIMAL(${Number(decimal[1])}, ${Number(decimal[2] || 0)})` : 'DECIMAL(18, 4)', assumed: false };
    }
    if (['TEXT', 'CLOB'].includes(raw)) return { type: key ? portable.text : dialect === 'mssql' ? 'NVARCHAR(MAX)' : 'TEXT', assumed: key, reason: key ? 'Text keys use bounded text so they can be indexed.' : undefined };
    if (['BLOB', 'BINARY', 'BYTEA'].includes(raw)) return { type: dialect === 'postgres' ? 'BYTEA' : dialect === 'mssql' ? 'VARBINARY(MAX)' : 'BLOB', assumed: false };
    return { type: portable.text, assumed: true, reason: `Domain “${domain}” is not a supported SQL type. Choose a column type or use the text fallback.` };
}

// Preserve the Builder facade while sharing native limits with Add Table.
export { validateSqlTableLimits as validateDraftSqlTable } from '@/lib/sqlTableLimits';
