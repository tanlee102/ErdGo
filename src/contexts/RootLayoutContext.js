import { createContext, useCallback, useMemo, useRef, useState } from 'react';
import { sqlToErdSchema } from '@/lib/erdJsonSchema';

const EMPTY_SCHEMA = { enums: [], composites: [], tables: [], relations: [] };
export const RootLayoutContext = createContext(null);

export default function RootLayoutProvider({ children }) {
    const [sqlInput, setSqlInput] = useState('');
    const [displayModalAddTable, setDisplayModalAddTable] = useState(false);
    const [displayModalListFile, setDisplayModalListFile] = useState(false);
    const schemaRef = useRef(EMPTY_SCHEMA);
    const sqlTabOperationsRef = useRef(null);

    const registerSqlTabOperations = useCallback((operations) => {
        sqlTabOperationsRef.current = operations;
        return () => {
            if (sqlTabOperationsRef.current === operations) sqlTabOperationsRef.current = null;
        };
    }, []);
    const runSqlTabOperation = useCallback((name, ...args) => {
        const operation = sqlTabOperationsRef.current?.[name];
        return typeof operation === 'function' ? operation(...args) : undefined;
    }, []);
    const updateSchema = useCallback((sql) => {
        try {
            schemaRef.current = typeof sql === 'string' && sql.trim() ? sqlToErdSchema(sql) : EMPTY_SCHEMA;
            return schemaRef.current;
        } catch (error) {
            console.error('Failed to parse SQL for schema:', error);
            schemaRef.current = EMPTY_SCHEMA;
            return null;
        }
    }, []);
    const value = useMemo(
        () => ({ sqlInput, setSqlInput, schemaRef, updateSchema, registerSqlTabOperations, runSqlTabOperation, displayModalAddTable, setDisplayModalAddTable, displayModalListFile, setDisplayModalListFile }),
        [displayModalAddTable, displayModalListFile, registerSqlTabOperations, runSqlTabOperation, sqlInput, updateSchema],
    );
    return <RootLayoutContext.Provider value={value}>{children}</RootLayoutContext.Provider>;
}
