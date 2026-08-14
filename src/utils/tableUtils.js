import { sqlToErdSchema } from '../lib/erdJsonSchema';

export function extractTablesInfo(sqlInput, schema = null) {
    try {
        // Use provided schema if available, otherwise parse SQL
        const tableSchema = schema || sqlToErdSchema(sqlInput);
        return tableSchema.tables.map((table) => ({
            name: table.name,
            columns: table.columns.map((col) => col.name),
        }));
    } catch (error) {
        console.warn('Failed to parse SQL for table info:', error);
        return [];
    }
}
