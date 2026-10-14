import { useCallback, useMemo, useState } from 'react';
import { DEFAULT_SPREADSHEET_SQL_DIALECT, createIssueReportCsv, createSqlModel, parseSpreadsheetFile, suggestTableName } from '@/features/spreadsheet-to-sql/lib/spreadsheetImport';

export function formatFileSize(size = 0) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function getSheetStats(sheet) {
    if (!sheet?.rows?.length) return { rows: 0, columns: 0 };
    return {
        rows: sheet.rows.length,
        columns: sheet.rows.reduce((max, row) => Math.max(max, row.length), 0),
    };
}

export function useSpreadsheetConverter() {
    const [workbook, setWorkbook] = useState(null);
    const [file, setFile] = useState(null);
    const [selectedSheetIndex, setSelectedSheetIndex] = useState(0);
    const [tableName, setTableName] = useState('uploaded_table');
    const [dialect, setDialect] = useState(DEFAULT_SPREADSHEET_SQL_DIALECT);
    const [hasHeader, setHasHeader] = useState(true);
    const [columnTypeOverrides, setColumnTypeOverrides] = useState({});
    const [isParsing, setIsParsing] = useState(false);
    const [parseProgress, setParseProgress] = useState({ label: '', percent: 0 });
    const [error, setError] = useState('');
    const [copyStatus, setCopyStatus] = useState('idle');

    const activeSheet = workbook?.sheets?.[selectedSheetIndex] || null;
    const sheetStats = useMemo(() => getSheetStats(activeSheet), [activeSheet]);

    // The workbook stays immutable after parsing; every setting change derives
    // a fresh SQL model from the selected sheet and current import options.
    const model = useMemo(() => {
        if (!activeSheet) return null;
        return createSqlModel({
            rows: activeSheet.rows,
            tableName,
            hasHeader,
            dialect,
            columnTypeOverrides,
        });
    }, [activeSheet, tableName, hasHeader, dialect, columnTypeOverrides]);
    const modelSql = model?.sql || '';

    const processFile = useCallback(async (nextFile) => {
        if (!nextFile) return;

        setIsParsing(true);
        setError('');
        setCopyStatus('idle');
        setParseProgress({ label: 'Reading file', percent: 18 });

        try {
            const parsedWorkbook = await parseSpreadsheetFile(nextFile);
            const firstSheet = parsedWorkbook.sheets[0];
            setParseProgress({ label: 'Preparing SQL preview', percent: 86 });

            setFile(nextFile);
            setWorkbook(parsedWorkbook);
            setSelectedSheetIndex(0);
            setTableName(suggestTableName(nextFile.name, firstSheet?.name));
            setColumnTypeOverrides({});
            setParseProgress({ label: 'Ready', percent: 100 });
        } catch (parseError) {
            setFile(null);
            setWorkbook(null);
            setError(parseError.message || 'Could not read that file.');
        } finally {
            setIsParsing(false);
            setParseProgress({ label: '', percent: 0 });
        }
    }, []);

    const selectSheet = useCallback(
        (nextIndex) => {
            const nextSheet = workbook?.sheets?.[nextIndex];
            setSelectedSheetIndex(nextIndex);
            if (file && nextSheet) {
                setTableName(suggestTableName(file.name, nextSheet.name));
            }
            setColumnTypeOverrides({});
        },
        [file, workbook],
    );

    const toggleHeader = useCallback((nextHasHeader) => {
        setHasHeader(nextHasHeader);
        setColumnTypeOverrides({});
    }, []);

    const changeColumnType = useCallback((columnName, nextType) => {
        setColumnTypeOverrides((currentOverrides) => {
            const nextOverrides = { ...currentOverrides };
            if (nextType) {
                nextOverrides[columnName] = nextType;
            } else {
                delete nextOverrides[columnName];
            }
            return nextOverrides;
        });
    }, []);

    const applyImportSettings = useCallback((settings) => {
        setSelectedSheetIndex(settings.selectedSheetIndex);
        setTableName(settings.tableName);
        setDialect(settings.dialect);
        setHasHeader(settings.hasHeader);
        setColumnTypeOverrides({ ...(settings.columnTypeOverrides || {}) });
        setCopyStatus('idle');
    }, []);

    const copySql = useCallback(async () => {
        if (!modelSql) return;

        try {
            await navigator.clipboard.writeText(modelSql);
            setCopyStatus('copied');
            window.setTimeout(() => setCopyStatus('idle'), 1800);
        } catch {
            setCopyStatus('failed');
        }
    }, [modelSql]);

    const downloadSql = useCallback(() => {
        if (!model?.sql) return;

        const blob = new Blob([model.sql], { type: 'text/sql;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${model.tableName || 'uploaded_table'}.sql`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.setTimeout(() => URL.revokeObjectURL(url), 100);
    }, [model]);

    const downloadIssues = useCallback(() => {
        if (!model?.issues?.length) return;

        const blob = new Blob([createIssueReportCsv(model)], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${model.tableName || 'uploaded_table'}-issues.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.setTimeout(() => URL.revokeObjectURL(url), 100);
    }, [model]);

    const previewRows = model?.previewRows || [];
    const previewHiddenCount = model ? Math.max(model.rows.length - previewRows.length, 0) : 0;

    return {
        activeSheet,
        copySql,
        copyStatus,
        dialect,
        downloadIssues,
        downloadSql,
        error,
        file,
        hasHeader,
        isParsing,
        model,
        parseProgress,
        previewHiddenCount,
        previewRows,
        processFile,
        selectSheet,
        selectedSheetIndex,
        setDialect,
        setHasHeader: toggleHeader,
        setTableName,
        changeColumnType,
        applyImportSettings,
        columnTypeOverrides,
        sheetStats,
        tableName,
        workbook,
    };
}
