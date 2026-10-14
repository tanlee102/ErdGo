import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfirm } from '@/components/ConfirmDialog';
import runErdScript from '@/lib/genErdScript';

export function createPrismaRenderSchema(schema) {
    const renderSchema = JSON.parse(JSON.stringify(schema));
    renderSchema.relations = (renderSchema.relations || []).filter(
        (relation) =>
            !(
                relation?.prisma?.kind === 'implicit-many-to-many' &&
                relation.from?.table === relation.to?.table &&
                relation.from?.column === relation.to?.column
            ),
    );
    return renderSchema;
}

function getBooleanPreferences(context) {
    const preferences = {};
    if (typeof context?.headerActionsAlwaysVisible === 'boolean') preferences.headerActionsAlwaysVisible = context.headerActionsAlwaysVisible;
    return preferences;
}

export function applyPrismaAutoColorTextDefaults(context, schema) {
    if (!context || typeof context !== 'object' || Array.isArray(context)) return false;

    const currentModes = context.tableHeaderTextModes;
    const nextModes = currentModes && typeof currentModes === 'object' && !Array.isArray(currentModes)
        ? { ...currentModes }
        : {};
    let changed = false;

    (Array.isArray(schema?.tables) ? schema.tables : []).forEach((table) => {
        const tableName = typeof table?.name === 'string' ? table.name.trim() : '';
        if (!tableName || Object.prototype.hasOwnProperty.call(nextModes, tableName)) return;
        nextModes[tableName] = 'white';
        changed = true;
    });

    if (changed) context.tableHeaderTextModes = nextModes;
    return changed;
}

function getPrismaTableNames(schema) {
    return new Set(
        (Array.isArray(schema?.tables) ? schema.tables : [])
            .map((table) => (typeof table?.name === 'string' ? table.name.trim() : ''))
            .filter(Boolean),
    );
}

function applyPrismaAddedTableTextDefaults(context, previousTableNames, currentTableNames) {
    const addedTables = [...currentTableNames]
        .filter((tableName) => !previousTableNames.has(tableName))
        .map((name) => ({ name }));
    return applyPrismaAutoColorTextDefaults(context, { tables: addedTables });
}

export function usePrismaErdRendering({
    theme,
    schemaRef,
    erdContextRef,
    isCanvasReady,
    autoColorOnFirstRender = false,
    initialHeaderActionsAlwaysVisible = true,
    onRenderComplete,
}) {
    const { confirm } = useConfirm();
    const [flag, setFlag] = useState(0);
    const [fullConnect, setFullConnect] = useState(false);
    const [headerActionsAlwaysVisible, setHeaderActionsAlwaysVisibleState] = useState(initialHeaderActionsAlwaysVisible !== false);
    const [erdContextVersion, setErdContextVersion] = useState(0);
    const [renderError, setRenderError] = useState(null);
    const exportPngRef = useRef(null);
    const renderSeqRef = useRef(0);
    const autoColorNextRef = useRef(autoColorOnFirstRender);
    const jumpToTableCallbackRef = useRef(null);
    const knownTableNamesRef = useRef(new Set());
    const hasTableBaselineRef = useRef(false);

    const setJumpToTableCallback = useCallback((callback) => {
        jumpToTableCallbackRef.current = typeof callback === 'function' ? callback : null;
    }, []);

    const setHeaderActionsAlwaysVisible = useCallback(
        (nextValue) => {
            const value = Boolean(nextValue);
            erdContextRef.current = {
                ...(erdContextRef.current || {}),
                headerActionsAlwaysVisible: value,
            };
            setHeaderActionsAlwaysVisibleState(value);
            setErdContextVersion((current) => current + 1);
        },
        [erdContextRef],
    );

    const onErdContextChange = useCallback(
        (newContext) => {
            const preservedSplitterSize = erdContextRef.current?.splitterSize;
            const booleanPreferences = getBooleanPreferences(erdContextRef.current);
            const { headerActionsAlwaysVisible: _canvasHeaderActionsAlwaysVisible, ...canvasContext } = newContext || {};
            erdContextRef.current = {
                ...canvasContext,
                ...booleanPreferences,
                ...(preservedSplitterSize !== undefined && { splitterSize: preservedSplitterSize }),
            };
            setErdContextVersion((value) => value + 1);
        },
        [erdContextRef],
    );

    const handleJumpToTable = useCallback((tableName) => {
        if (typeof jumpToTableCallbackRef.current === 'function') {
            jumpToTableCallbackRef.current(tableName);
        }
    }, []);

    useEffect(() => {
        if (!schemaRef.current || !isCanvasReady) return undefined;

        const runId = (renderSeqRef.current += 1);
        let cancelled = false;
        const hasRenderableTables = Array.isArray(schemaRef.current?.tables) && schemaRef.current.tables.length > 0;
        const shouldAutoColor = autoColorNextRef.current && hasRenderableTables;
        // The workbench mounts before its deferred Prisma conversion reaches
        // schemaRef. Keep the one-shot request pending through that empty pass
        // so the actual sample tables receive both smart colors and white text.
        if (shouldAutoColor) autoColorNextRef.current = false;
        setRenderError(null);

        // Fresh/sample Prisma diagrams use the same deliberate white header
        // text as newly created SQL tables. Stored files skip auto-color and
        // therefore retain every saved per-table text preference unchanged.
        const currentTableNames = getPrismaTableNames(schemaRef.current);
        if (shouldAutoColor) {
            applyPrismaAutoColorTextDefaults(erdContextRef.current, schemaRef.current);
        } else if (hasTableBaselineRef.current) {
            applyPrismaAddedTableTextDefaults(erdContextRef.current, knownTableNamesRef.current, currentTableNames);
        }
        knownTableNamesRef.current = currentTableNames;
        hasTableBaselineRef.current = true;

        // Prisma implicit self many-to-many relations map both virtual fields
        // to one scalar key row. Keep that relation in the Prisma schema and
        // explorer, but omit its degenerate canvas-only edge. This hook is
        // Prisma-specific; SQL to ERD passes its schema directly to the shared
        // renderer and remains unchanged.
        runErdScript(createPrismaRenderSchema(schemaRef.current), {
            darkMode: theme === 'dark',
            fullConnect,
            onTableDelete: null,
            onJumpToTable: handleJumpToTable,
            onContextChange: (newContext) => {
                if (cancelled || renderSeqRef.current !== runId) return;
                onErdContextChange(newContext);
            },
            onConfirm: confirm,
            initialContext: erdContextRef.current,
            headerActionsAlwaysVisible,
            autoColor: shouldAutoColor,
        })
            .then((api) => {
                if (cancelled || renderSeqRef.current !== runId) return;
                exportPngRef.current = api?.exportPng || null;
                onRenderComplete?.(erdContextRef.current);
            })
            .catch(() => {
                if (cancelled || renderSeqRef.current !== runId) return;
                exportPngRef.current = null;
                setRenderError('The ERD renderer could not draw this schema. Review the diagnostics or simplify the schema and try again.');
            });

        return () => {
            cancelled = true;
            if (renderSeqRef.current === runId) renderSeqRef.current += 1;
        };
    }, [flag, isCanvasReady, theme, fullConnect, handleJumpToTable, onErdContextChange, schemaRef, erdContextRef, confirm, headerActionsAlwaysVisible, onRenderComplete]);

    const triggerAutoColor = useCallback(() => {
        autoColorNextRef.current = true;
    }, []);

    return {
        flag,
        setFlag,
        fullConnect,
        setFullConnect,
        headerActionsAlwaysVisible,
        setHeaderActionsAlwaysVisible,
        renderError,
        erdContextVersion,
        setErdContextVersion,
        triggerAutoColor,
        setJumpToTableCallback,
        jumpToTableCallbackRef,
        exportPng: (options) => {
            const exporter = exportPngRef.current;
            return exporter ? exporter(options) : null;
        },
    };
}
