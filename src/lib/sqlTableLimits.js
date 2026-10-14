/** Maximum encoded width of the whitelist's types, for the generated index profile. */
function keyBytes(type, dialect) {
    const sized = type.match(/^(N?VARCHAR|N?CHAR)\((\d+)\)$/);
    if (sized) return Number(sized[2]) * (dialect === 'mysql' ? 4 : 2);
    const decimal = type.match(/^DECIMAL\((\d+),\s*(\d+)\)$/);
    if (decimal) {
        const precision = Number(decimal[1]);
        if (dialect === 'mssql') return precision <= 9 ? 5 : precision <= 19 ? 9 : precision <= 28 ? 13 : 17;
        const scale = Number(decimal[2]);
        const packed = digits => Math.floor(digits / 9) * 4 + Math.ceil((digits % 9) / 2);
        return packed(precision - scale) + packed(scale);
    }
    const sizes = { TINYINT: 1, SMALLINT: 2, INT: 4, INTEGER: 4, BIGINT: 8, BOOLEAN: 1, BIT: 1, REAL: dialect === 'mysql' ? 8 : 4, FLOAT: dialect === 'mysql' ? 4 : 8, DOUBLE: 8, DATE: 3, TIME: 8, TIMESTAMP: 8, DATETIME: 8, DATETIME2: 8, UNIQUEIDENTIFIER: 16 };
    return sizes[type] ?? null;
}

/** Validate final keys, including copied entity keys in junction/value tables.
 * MySQL targets utf8mb4, DYNAMIC rows and the default 16 KB InnoDB page size.
 * SQL Server targets the default clustered PK and 2016+ nonclustered indexes.
 * Never shorten a domain or use a prefix index: either would change uniqueness.
 */
export function validateSqlTableLimits(table, dialect) {
    const issues = [];
    const maxColumns = { sqlite: 2000, postgres: 1600, mysql: 1017, mssql: 1024 }[dialect];
    const maxParts = { sqlite: 2000, postgres: 32, mysql: 16, mssql: 32 }[dialect];
    if (table.columns.length > maxColumns) issues.push({ code: 'table-column-limit', message: `${table.name} has ${table.columns.length} columns; this ${dialect} profile allows ${maxColumns}. Split the entity or reduce its attributes.` });
    const groups = [
        { kind: 'primary key', columns: table.primaryKey, bytes: dialect === 'mysql' ? 3072 : 900 },
        ...table.unique.map(columns => ({ kind: 'unique key', columns, bytes: dialect === 'mysql' ? 3072 : 1700 })),
        ...table.foreignKeys.map(fk => ({ kind: 'foreign key', columns: fk.columns, bytes: dialect === 'mysql' ? 3072 : 900 })),
    ];
    for (const group of groups) {
        if (group.columns.length > maxParts) issues.push({ code: 'key-column-limit', message: `The ${group.kind} (${group.columns.join(', ')}) on ${table.name} has ${group.columns.length} columns; ${dialect} allows ${maxParts}. Reduce the key or choose another dialect.` });
        if (!['mysql', 'mssql'].includes(dialect)) continue;
        const widths = group.columns.map(name => keyBytes(table.columns.find(column => column.name === name)?.type || '', dialect));
        if (widths.some(width => width === null)) continue; // Unindexable types receive their own diagnostic in the converter.
        const total = widths.reduce((sum, width) => sum + width, 0);
        if (total > group.bytes) issues.push({ code: 'key-width-exceeded', message: `The ${group.kind} (${group.columns.join(', ')}) on ${table.name} can use ${total} bytes, above this ${dialect} profile’s ${group.bytes}-byte limit. Choose smaller column domains or types; keys will not be truncated automatically.` });
    }
    return issues;
}
