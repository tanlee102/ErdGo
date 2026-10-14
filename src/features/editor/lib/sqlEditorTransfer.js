/** Validated, route-scoped SQL handoff. History state survives reload without storage keys. */
export function readSqlEditorTransfer(state) {
    const transfer = state?.sqlEditorTransfer;
    if (!transfer || transfer.version !== 1 || typeof transfer.sql !== 'string' || !transfer.sql.trim()
        || !['sqlite', 'postgres', 'mysql', 'mssql'].includes(transfer.dialect)) return null;
    return { sql: transfer.sql, name: typeof transfer.name === 'string' && transfer.name.trim() ? transfer.name.trim() : 'Converted ERD', dialect: transfer.dialect };
}
