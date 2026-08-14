/**
 * ════════════════════════════════════════════════════════════════════════════
 *  erdRendererRuntime — internal interactive ERD canvas renderer
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  PURPOSE
 *  -------
 *  Renders an interactive Entity-Relationship Diagram into `#erd-canvas`
 *  (HTMLCanvasElement). This is the user-facing visualisation half of the
 *  ERD pipeline — its sibling is `erdJsonSchema.js`, which produces the
 *  `schema` object this file consumes.
 *
 *  PUBLIC API
 *  ----------
 *  default async function runErdScript(schema, options) → Promise<void>
 *
 *    schema  — the renderer-facing schema produced by `sqlToErdSchema`. See
 *              the docblock in `erdJsonSchema.js` for the frozen shape
 *              (enums, composites, tables, relations, _parseErrors).
 *    options — {
 *      darkMode:        boolean    — switches palette + connector colors
 *      fullConnect:     boolean    — when true, all connectors are always
 *                                    drawn full-opacity (no fade on idle)
 *      inferredRelations: Array    — diagram-only relationship suggestions.
 *                                    These render as scored dashed overlays
 *                                    and never affect automatic layout.
 *      onTableDelete:   (tableName) => Promise<boolean>
 *                                  — invoked when the user clicks the trash
 *                                    icon on a table; the parent confirms and
 *                                    removes the table before returning true
 *      onJumpToTable:   (tableName) => void
 *                                  — invoked when the user clicks the "jump"
 *                                    icon; parent typically scrolls the SQL
 *                                    editor to the corresponding CREATE TABLE
 *      tableOwners:     { [tableName]: { title, line, ... } }
 *                                  — SQL-tab ownership used in the table
 *                                    navigator and, when enabled, labels.
 *      showTableOwnerLabels: boolean
 *                                  — opt-in display of SQL tab names in table
 *                                    headers; leaves ownership behavior intact.
 *      headerActionsAlwaysVisible: boolean
 *                                  — when false, table header action icons
 *                                    appear only while hovering the header.
 *      onContextChange: (context) => void
 *                                  — fires whenever the user mutates
 *                                    persistent state (colors, positions,
 *                                    zoom, layout, hidden columns, …).
 *                                    Parent persists this for re-hydration.
 *      initialContext:  object|null
 *                                  — previously-saved context from this
 *                                    same callback. Re-hydrated verbatim.
 *      maxFitZoom:      number     — upper bound for the "Fit to screen"
 *                                    button. Defaults to 2.0 so small ERDs
 *                                    don't get pixelated when zoomed in.
 *      autoColor:       boolean    — when true, tables receive deterministic
 *                                    schema-aware, relationship-safe colors
 *                                    until the user manually picks a color.
 *    }
 *
 *  ARCHITECTURE — file organisation (sections in source order)
 *  -----------------------------------------------------------
 *    [Imported pure modules]
 *      · `erd-renderer/` owns colors, layout, constraint badges, interaction
 *        state, and text measurement. Keep new deterministic behavior there.
 *      · drawRoundRect remains local because it directly mutates a canvas path.
 *
 *    Inside `runErdScript` (one closure per render — owns all per-canvas state):
 *       1. Initialise ContextManager   (persistent state hub)
 *          + COMPACT MODE helpers      (hide/show non-FK columns)
 *       2. DOM bootstrap               (clone canvas, build toolbar, hook
 *                                       observers / event listeners)
 *       3. UI constants                (sizes, spacing, fonts in CSS pixels)
 *       4. Layout                      (Best auto selector, ELK for LR/RL;
 *                                       greedy radial for SF)
 *       5. Drawing helpers             (table card, header, columns, badges)
 *       6. Connector path generation   (table-to-table FK arrows + cardinality
 *                                       symbols; full-connect vs grouped)
 *       7. Canvas setup                (resize, devicePixelRatio, zoom/pan
 *                                       transform matrix)
 *       8. Fit-to-screen               (auto pan/zoom to bounding box)
 *       9. Main draw                   (single rAF loop; layered z-index:
 *                                       connectors → hovered → tables → tt)
 *      10. Pointer events              (drag tables, pan canvas, hover hits;
 *                                       includes a Touch event branch)
 *      11. Toolbar buttons             (zoom in/out/fit, auto-layout, color
 *                                       picker, table delete, layout switch)
 *      12. Initial draw + state restore
 *      13. Schema-change cleanup       (purges selection / hover state when
 *                                       the parent removes a table)
 *
 *  COORDINATE SYSTEMS
 *  ------------------
 *    * Canvas pixels (CSS pixels × devicePixelRatio): what we actually draw
 *      to. The 2D context is scaled by DPR once per resize so all draw code
 *      can stay in CSS-pixel units.
 *    * World coordinates: each table's `(x, y)` lives in this space. They
 *      are transformed to screen by `screenX = (worldX + offsetX) * zoom`.
 *    * Screen coordinates: pointer events arrive in here (CSS pixels
 *      relative to canvas). The inverse transform `(screen / zoom) - offset`
 *      gives the world point under the cursor.
 *
 *  PERSISTENT CONTEXT (managed by ContextManager.js)
 *  -------------------------------------------------
 *    Anything that should survive across re-renders or page reloads goes
 *    through ContextManager. Snapshotted fields include: `tablePositions`,
 *    `tableColors`, `tableHeaderTextModes`, `tableCompactModes`, `priorityTableNames`, `zoom`,
 *    `offsetX`, `offsetY`, `layoutMode`, and `selectedNodeName`. Mutating
 *    these through ContextManager triggers `onContextChange` and the parent
 *    persists the diff.
 *
 *  AI-FRIENDLY GOTCHAS (read before refactoring)
 *  ---------------------------------------------
 *  • The canvas is CLONED at the top of every invocation to clear stale
 *    listeners. Hold references to `canvas` returned from this script —
 *    the original DOM node is replaced.
 *  • All drawing happens in CSS-pixel units; the 2D context is pre-scaled
 *    by `devicePixelRatio`. Do not multiply coordinates by DPR yourself.
 *  • The render loop is request-animation-frame coalesced; never call
 *    `draw()` directly — schedule a redraw via `scheduleDraw()`.
 *  • Connector geometry is computed lazily and memoised per (zoom, layout,
 *    table positions) tuple; if you add inputs that affect geometry, bump
 *    the memo key or the diagram will go stale.
 *  • Layout (`ELK` async) runs on a worker; calls return Promises. Do not
 *    block on layout inside a synchronous event handler.
 *  • The flowing-dot connector overlay uses a fixed `strokeStyle` of white
 *    in BOTH themes per product decision — see prior conversation if you
 *    are tempted to "improve" the contrast.
 * ════════════════════════════════════════════════════════════════════════════
 */

/**
 * Polyfill for ctx.roundRect for older browsers
 */
function drawRoundRect(ctx, x, y, w, h, r) {
    if (typeof r === 'number') r = [r, r, r, r];
    else if (!Array.isArray(r)) r = [0, 0, 0, 0];
    ctx.beginPath();
    ctx.moveTo(x + r[0], y);
    ctx.lineTo(x + w - r[1], y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r[1]);
    ctx.lineTo(x + w, y + h - r[2]);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r[2], y + h);
    ctx.lineTo(x + r[3], y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r[3]);
    ctx.lineTo(x, y + r[0]);
    ctx.quadraticCurveTo(x, y, x + r[0], y);
    ctx.closePath();
}

// Color palette for tables
import {
    getCanvasColorCss,
    getColorSwatchGroups,
    getInferredRelationVisual,
    getPrimaryCanvasColor,
    getTableConnectorColor,
    getTableHeaderFillStyle,
    getTableRelationshipFieldFillColor,
    getTableRowHoverOutlineColor,
    getTableSelectionAccentColor,
    paletteColors,
    parseGradientColor,
    resolveTableHeaderColor,
} from './erd-renderer/colorSystem.js';

// Re-export pure helpers to preserve the renderer's established public API.
export {
    getCanvasColorCss,
    getColorSwatchGroups,
    getInferredRelationVisual,
    getPrimaryCanvasColor,
    getTableConnectorColor,
    getTableHeaderFillStyle,
    getTableRelationshipFieldFillColor,
    getTableRowHoverOutlineColor,
    getTableSelectionAccentColor,
    parseGradientColor,
    resolveTableHeaderColor,
} from './erd-renderer/colorSystem.js';
import {
    analyzeErdLayoutGraph,
    buildGridLayoutPositions,
    buildLayoutEdges,
    chooseBestLayoutStrategy,
    getLayoutModeLabel,
    getLayoutModeTitle,
    getToolbarPopupPosition,
    LAYOUT_MODES,
    LAYOUT_MODE_OPTIONS,
    normalizeLayoutMode,
    orderTablesForSmartLayout,
    SMART_LAYOUT_STRATEGIES,
} from './erd-renderer/layoutSystem.js';

// Preserve the renderer entry module's established helper exports.
export {
    analyzeErdLayoutGraph,
    buildGridLayoutPositions,
    chooseBestLayoutStrategy,
    getLayoutModeLabel,
    getToolbarPopupPosition,
    LAYOUT_MODES,
} from './erd-renderer/layoutSystem.js';

import {
    getColumnHoverTreatment,
    getLivePriorityTableNames,
    getPriorityLayerState,
    getRelationshipFieldKey,
    getSelectedRelationshipFieldKeys,
} from './erd-renderer/interactionState.js';

export { calculateSelfReferenceConnectorLoop } from './erd-renderer/layoutSystem.js';

export {
    getColumnHoverTreatment,
    getLivePriorityTableNames,
    getPriorityLayerState,
    getRelationshipFieldKey,
    getSelectedRelationshipFieldKeys,
} from './erd-renderer/interactionState.js';
import { truncateCanvasTextToWidth, wrapCanvasTextToWidth } from './erd-renderer/canvasText.js';
import {
    calculateEditableConnectorRoute,
    chooseConnectorSideFromPointer,
    getAutomaticConnectorSides,
    getConnectorRelationKey,
    normalizeConnectorSide,
} from './erd-renderer/connectorRouting.js';
import './erd-renderer/connectorEndpointEditor.css';

export { truncateCanvasTextToWidth, wrapCanvasTextToWidth } from './erd-renderer/canvasText.js';
export {
    calculateEditableConnectorRoute,
    chooseConnectorSideFromPointer,
    getAutomaticConnectorSides,
    getConnectorRelationKey,
    normalizeConnectorSide,
} from './erd-renderer/connectorRouting.js';
export { normalizeConnectorEndpointSides } from './erd-renderer/connectorRouting.js';
import ELK from 'elkjs/lib/elk.bundled.js';
import ContextManager from './ContextManager.js';
import { calculateErdMinimapModel, erdMinimapPointToWorld, getErdMinimapPanUpdate, getErdViewportWorldRect } from './erdMinimap.js';
import { calculateErdPinchUpdate, calculateErdViewportFit, clampErdZoom, getAnchoredZoomUpdate } from './erdViewport.js';
import { generateSmartTableColors, getRecommendedTableColorMode, getTableHeaderContrastTreatment } from './smartTableColors.js';

const elk = new ELK();

import {
    CONSTRAINT_PILL_FONT,
    composeCanvasAlpha,
    getCenteredCanvasTextBaseline,
    getCompositeConstraintPillColors,
    getConstraintPillLayout,
    getConstraintPillTextMode,
    getTableConstraintPillAppearance,
    getTableHeaderTextColorForMode,
    measureConstraintPillText,
} from './erd-renderer/constraintPills.js';

export {
    composeCanvasAlpha,
    getCenteredCanvasTextBaseline,
    getCompositeConstraintPillColors,
    getConstraintPillLayout,
    getConstraintPillTextMode,
    getTableConstraintPillAppearance,
    getTableHeaderTextColorForMode,
    measureConstraintPillText,
} from './erd-renderer/constraintPills.js';

export default async function runErdScript(schema, { darkMode = false, fullConnect = false, inferredRelations = [], onTableDelete = null, onJumpToTable = null, onContextChange = null, tableOwners = {}, showTableOwnerLabels = false, headerActionsAlwaysVisible = true, initialContext = null, maxFitZoom = 2.0, autoColor = false } = {}) {
    // Normalize schema to prevent null access crashes
    if (!schema) schema = { enums: [], composites: [], tables: [], relations: [] };
    if (!Array.isArray(schema.tables)) schema.tables = [];
    if (!Array.isArray(schema.relations)) schema.relations = [];
    if (!Array.isArray(schema.enums)) schema.enums = [];
    if (!Array.isArray(schema.composites)) schema.composites = [];
    const safeInferredRelations = Array.isArray(inferredRelations)
        ? inferredRelations.filter((relation) => relation?.inferred === true && relation?.from?.table && relation?.from?.column && relation?.to?.table && relation?.to?.column)
        : [];

    // ════════════════════════════════════════════════════════════════════
    //  SECTION 1 — Persistent context bootstrap
    // ════════════════════════════════════════════════════════════════════
    //  ContextManager is the single source of truth for everything that
    //  must survive a re-render (positions, colors, zoom, layout choice,
    //  compact-mode flag, hidden columns, selected table). It dispatches
    //  `onContextChange(snapshot)` upstream whenever any tracked field
    //  mutates, so the parent component can persist + re-hydrate via
    //  `initialContext` on the next mount.
    // ════════════════════════════════════════════════════════════════════

    const contextManager = new ContextManager(initialContext, onContextChange);
    const connectorGradientColorCache = new Map();

    // Ownership stays available to the table navigator, deletion preview, and
    // jump-to-SQL action. This preference only changes what table headers draw.
    const getVisibleTableOwnerTitle = (tableName) => {
        if (showTableOwnerLabels !== true) return '';
        const title = tableOwners?.[tableName]?.title;
        return typeof title === 'string' && title.trim() ? title : '';
    };

    const getConnectorGradientColor = (color) => {
        if (connectorGradientColorCache.has(color)) return connectorGradientColorCache.get(color);
        const visibleColor = getTableConnectorColor(color, darkMode);
        connectorGradientColorCache.set(color, visibleColor);
        return visibleColor;
    };

    let selectedNode = null; // currently selected table (object)
    let draggingNode = null,
        dragOffsetX = 0,
        dragOffsetY = 0; // table drag state
    let panning = false,
        panStartX = 0,
        panStartY = 0,
        panOriginX = 0,
        panOriginY = 0; // canvas pan state
    let needsRedraw = false; // flag to prevent excessive redraws
    let connectorPaths = []; // array of connector paths
    let hoveredConnectorIdx = null; // index of the hovered connector
    let hoveredConnectorPoint = null; // world point where connector hover began
    let selectedConnectorKey = null; // connector kept active by click/tap
    let draggingConnectorEndpoint = null; // direct left/right endpoint edit gesture
    let connectorTooltipCache = null; // cached measurements for the active connector inspector
    let hoveredConnectorIdxList = []; // list of connectors related to the hovered row
    let hoveredHeaderTableName = null;
    let selectedRelationshipFieldKeys = new Set(); // relation endpoint fields tied to the selected table
    let priorityLayerState = getPriorityLayerState([], contextManager.priorityTableNames);
    // Animated "river" flow offset for connectors tied to the selected table.
    // Incremented in the rAF loop only when a table is selected, so CPU stays
    // idle otherwise. Canvas `lineDashOffset` + a short dash pattern is the
    // cheapest way to get a smooth flowing-segment effect (no shadows/filters).
    let flowOffset = 0;
    const CONNECTOR_LINE_WIDTH = 1.25;
    const CONNECTOR_CARDINALITY_SCALE = 1.18;
    const CONNECTOR_HOVER_HIT_WIDTH = 20;
    const HOVERED_CONNECTOR_WIDTH = CONNECTOR_LINE_WIDTH * 1.12;
    const SELECTED_CONNECTOR_WIDTH = CONNECTOR_LINE_WIDTH * 1.12;
    const SELECTED_HOVERED_CONNECTOR_WIDTH = CONNECTOR_LINE_WIDTH * 1.18;
    let hoveredRow = { table: null, rowIdx: null }; // State tracking which row is hovered
    let currentLayoutMode = normalizeLayoutMode(contextManager.layoutMode);

    const inferredRelationshipFieldKeys = new Set();
    safeInferredRelations.forEach((relation) => {
        inferredRelationshipFieldKeys.add(getRelationshipFieldKey(relation.from.table, relation.from.column));
        inferredRelationshipFieldKeys.add(getRelationshipFieldKey(relation.to.table, relation.to.column));
    });

    // ════════════════════════════════════════════════════════════════════
    //  SECTION 1B — Compact mode (hide unreferenced columns)
    // ════════════════════════════════════════════════════════════════════
    //  Compact mode = render only columns that are part of a relation
    //  (PK or FK) plus any columns the user has explicitly pinned. Useful
    //  for huge schemas where most columns are noise.
    //
    //  State: `contextManager.compactMode: boolean` and
    //         `contextManager.pinnedColumns: Set<"table.col">`.
    //  Backward-compat: older saved contexts may not have these fields —
    //  helpers below default to "show everything" when state is missing.
    // ════════════════════════════════════════════════════════════════════

    function getVisibleColumns(tbl) {
        if (!tbl || !tbl.columns) return [];
        const isCompact = contextManager.getTableCompactMode(tbl.name);
        if (!isCompact) return tbl.columns;
        // In compact mode, keep explicit key fields plus endpoints needed by
        // visible inferred overlays. Inference never sets `fk`, so the diagram
        // does not claim that a database constraint exists when it does not.
        return tbl.columns.filter((col) => col.pk || col.fk || inferredRelationshipFieldKeys.has(getRelationshipFieldKey(tbl.name, col.name)));
    }

    // Color theme based on light/dark mode
    const theme = {
        background: darkMode ? '#3c3c3cff' : '#ffffff',

        headerText: '#ffffff',
        text: darkMode ? '#e4e4e4ff' : '#222222',
        typeText: darkMode ? '#bdbdbdff' : '#6b6b6bff',
        constraintText: darkMode ? '#828282ff' : '#828282ff',
        cardinalityText: darkMode ? '#ffffffff' : '#000000ff',

        connector: getTableConnectorColor(darkMode ? '#888888' : '#bbbbbb', darkMode),
        connectorHover: darkMode ? paletteColors[0] : paletteColors[0],

        nodeFill: darkMode ? '#323232ff' : '#f8f9fa',
        nodeBorder: darkMode ? '#00000084' : '#cccccc',
        headerBg: darkMode ? paletteColors[0] : paletteColors[0],
        highlightCol: darkMode ? '#000000ff' : '#cccccc',
        shadow: darkMode ? '#212121ff' : '#00000022',

        tooltipBg: darkMode ? '#000000ff' : '#f5f5f5',
        tooltipStroke: darkMode ? '#000000ff' : '#cccccc',
        tooltipText: darkMode ? '#edededff' : '#475569',
    };

    function getRelationshipFieldHighlightFill(tableName) {
        const tableColor = contextManager.getTableColor(tableName) || theme.headerBg;
        return getTableRelationshipFieldFillColor(tableColor, darkMode);
    }

    function isSelectedRelationshipField(tableName, columnName) {
        return selectedRelationshipFieldKeys.has(getRelationshipFieldKey(tableName, columnName));
    }

    function getPriorityTableAlpha(tableName) {
        if (!priorityLayerState.active) return 1;
        return priorityLayerState.visibleTables.has(tableName) ? 1 : 0.16;
    }

    function getPriorityConnectorAlpha(connectorIndex) {
        if (!priorityLayerState.active) return 1;
        return priorityLayerState.connectorIndexes.has(connectorIndex) ? 1 : 0.12;
    }

    function drawWithAlpha(ctx, alpha, drawFn) {
        ctx.save();
        ctx.globalAlpha *= alpha;
        drawFn();
        ctx.restore();
    }

    // Build enum map: { enumName: [values] }
    const enumMap = {};
    if (schema.enums && Array.isArray(schema.enums)) {
        for (const en of schema.enums) {
            if (en && en.name && Array.isArray(en.values)) {
                enumMap[en.name] = en.values;
            }
        }
    }

    // Build composite map: { compositeName: [fields] }
    const compositeMap = {};
    if (schema.composites && Array.isArray(schema.composites)) {
        for (const comp of schema.composites) {
            compositeMap[comp.name] = comp.fields;
        }
    }

    // ════════════════════════════════════════════════════════════════════
    //  SECTION 2 — DOM bootstrap (canvas clone + toolbar wiring)
    // ════════════════════════════════════════════════════════════════════
    //  This section is run-once-per-invocation. It:
    //    • Clones #erd-canvas to drop ALL stale event listeners. The clone
    //      replaces the original DOM node; downstream code holds the clone.
    //    • Reads `getBoundingClientRect()` to get the CSS-pixel size, then
    //      sizes the canvas backing store to size × devicePixelRatio.
    //    • Wires up the toolbar buttons (zoom, fit, layout, color, delete,
    //      compact mode) and the canvas-level pointer / wheel / touch
    //      listeners (those live in section 10 — this section just creates
    //      the DOM nodes they hang off).
    //    • Sets up a ResizeObserver so the canvas re-fits whenever its
    //      container reflows (parent grid / split-pane drag).
    //
    //  IMPORTANT: never reach DOM elements via `document.getElementById`
    //  later in this closure — always use the references captured here.
    //  The clone trick means the IDs you'd find in the DOM may belong to
    //  the *previous* invocation if it hasn't been GC'd yet.
    // ════════════════════════════════════════════════════════════════════


    // DOM variables
    const colorBtn = document.getElementById('color-btn');
    const colorControlPopover = document.getElementById('color-control-popover');
    const colorPopup = document.getElementById('color-popup');
    const colorDotRow = document.getElementById('color-dot-row');
    const colorHexInput = document.getElementById('color-hex-input');
    const colorTextOptions = document.getElementById('color-text-options');
    const deleteTableBtn = document.getElementById('delete-table-btn');
    const layoutModeBtn = document.getElementById('layout-mode-btn');
    const layoutModeLabel = document.getElementById('layout-mode-label');
    const layoutPopup = document.getElementById('layout-popup');
    const layoutOptionList = document.getElementById('layout-option-list');
    const tableNavBtn = document.getElementById('table-nav-btn');
    const tableNavPopup = document.getElementById('table-nav-popup');
    const tableNavSearch = document.getElementById('table-nav-search');
    const tableNavList = document.getElementById('table-nav-list');
    const clearPriorityBtn = document.getElementById('clear-priority-btn');
    const autoColorOnlyBtn = document.getElementById('auto-color-only-btn');
    const autoColorPopup = document.getElementById('auto-color-popup');

    function updateLayoutModeButton() {
        if (!layoutModeBtn) return;
        if (layoutModeLabel) {
            layoutModeLabel.textContent = getLayoutModeLabel(currentLayoutMode);
        }
        const layoutTitle = getLayoutModeTitle(currentLayoutMode);
        layoutModeBtn.title = `Layout Mode: ${layoutTitle}`;
        layoutModeBtn.setAttribute('aria-label', `Layout Mode: ${layoutTitle}`);
    }

    function updateAutoColorButtonExpanded(isExpanded) {
        if (!autoColorOnlyBtn) return;
        autoColorOnlyBtn.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
    }

    function positionToolbarPopup(popup, trigger) {
        if (!popup || !trigger) return;
        const panel = trigger.closest('.erd-panel');
        const panelRect = panel?.getBoundingClientRect() || {
            top: 0,
            right: window.innerWidth,
            bottom: window.innerHeight,
            left: 0,
            width: window.innerWidth,
            height: window.innerHeight,
        };
        const margin = 8;
        popup.style.maxWidth = `${Math.max(1, panelRect.width - margin * 2)}px`;
        const maxPopupHeight = Math.max(1, panelRect.height - margin * 2);
        popup.style.maxHeight = `${maxPopupHeight}px`;
        popup.style.setProperty('--toolbar-popup-max-height', `${maxPopupHeight}px`);

        const position = getToolbarPopupPosition({
            triggerRect: trigger.getBoundingClientRect(),
            popupRect: { width: popup.offsetWidth, height: popup.offsetHeight },
            bounds: panelRect,
            margin,
        });
        popup.style.left = `${position.left}px`;
        popup.style.top = `${position.top}px`;
        popup.style.right = 'auto';
        popup.dataset.placement = position.placement;
        popup.style.setProperty('--toolbar-popup-arrow-top', `${position.arrowTop}px`);
    }

    function hideLayoutPopup() {
        if (!layoutPopup) return;
        layoutPopup.style.display = 'none';
        layoutModeBtn?.setAttribute('aria-expanded', 'false');
    }

    function renderLayoutModeOptions() {
        if (!layoutOptionList) return;
        layoutOptionList.innerHTML = '';
        const selectedMode = normalizeLayoutMode(currentLayoutMode);

        const layoutIcons = {
            [LAYOUT_MODES.BEST]: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.7 4.9L19 9.6l-4.2 3.1 1.5 5-4.3-3-4.3 3 1.5-5L5 9.6l5.3-1.7L12 3Z"/><path d="M4 20h16"/></svg>',
            [LAYOUT_MODES.LEFT_TO_RIGHT]: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
            [LAYOUT_MODES.RIGHT_TO_LEFT]: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>',
            [LAYOUT_MODES.SNOWFLAKE]: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/><line x1="19.07" y1="4.93" x2="4.93" y2="19.07"/></svg>',
        };

        LAYOUT_MODE_OPTIONS.forEach((option) => {
            const optionEl = document.createElement('div');
            optionEl.className = 'layout-option' + (option.mode === selectedMode ? ' selected' : '');
            optionEl.setAttribute('role', 'button');
            optionEl.setAttribute('tabindex', '0');
            optionEl.dataset.layoutMode = option.mode;

            // Icon
            const iconWrap = document.createElement('div');
            iconWrap.className = 'layout-option-icon';
            iconWrap.innerHTML = layoutIcons[option.mode] || '';

            // Content
            const contentEl = document.createElement('div');
            contentEl.className = 'layout-option-content';

            const titleEl = document.createElement('div');
            titleEl.className = 'layout-option-title';
            titleEl.textContent = option.title;

            const noteEl = document.createElement('div');
            noteEl.className = 'layout-option-note';
            noteEl.textContent = option.note;

            contentEl.appendChild(titleEl);
            contentEl.appendChild(noteEl);

            // Check mark
            const checkEl = document.createElement('div');
            checkEl.className = 'layout-option-check';
            checkEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

            optionEl.appendChild(iconWrap);
            optionEl.appendChild(contentEl);
            optionEl.appendChild(checkEl);
            layoutOptionList.appendChild(optionEl);
        });
    }

    async function selectLayoutMode(nextMode) {
        const normalizedMode = normalizeLayoutMode(nextMode);
        currentLayoutMode = normalizedMode;
        contextManager.setLayoutMode(currentLayoutMode);
        updateLayoutModeButton();
        hideLayoutPopup();
        await relayoutWithCurrentMode();
    }

    function showLayoutPopup() {
        if (!layoutPopup) return;
        renderLayoutModeOptions();
        layoutPopup.style.visibility = 'hidden';
        layoutPopup.style.display = 'block';
        positionToolbarPopup(layoutPopup, layoutModeBtn);
        layoutPopup.style.visibility = '';
        layoutModeBtn?.setAttribute('aria-expanded', 'true');
        layoutPopup.querySelector('.layout-option.selected')?.focus({ preventScroll: true });
    }

    function hideTableNavPopup() {
        if (!tableNavPopup) return;
        tableNavPopup.style.display = 'none';
        tableNavBtn?.setAttribute('aria-expanded', 'false');
    }

    function getVisiblePriorityTableNames() {
        return getLivePriorityTableNames(schema.tables, contextManager.priorityTableNames);
    }

    function renderTableNavList(filter = '') {
        if (!tableNavList) return;
        tableNavList.innerHTML = '';

        const needle = (filter || '').trim().toLowerCase();
        // Defensive: skip relations that lost a side (validator drops these,
        // but the toolbar can be invoked between parse stages).
        const relationCountByTable = {};
        (schema.relations || []).forEach((rel) => {
            if (!rel || !rel.from || !rel.to) return;
            if (rel.from.table) relationCountByTable[rel.from.table] = (relationCountByTable[rel.from.table] || 0) + 1;
            if (rel.to.table) relationCountByTable[rel.to.table] = (relationCountByTable[rel.to.table] || 0) + 1;
        });

        const tableItems = (schema.tables || [])
            .filter((tbl) => tbl && tbl.name)
            .filter((tbl) => !needle || tbl.name.toLowerCase().includes(needle))
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));

        // Update count badge
        const countEl = document.getElementById('table-nav-count');
        if (countEl) {
            const total = (schema.tables || []).length;
            countEl.textContent = needle && tableItems.length !== total ? `${tableItems.length}/${total}` : `${total}`;
        }

        if (tableItems.length === 0) {
            const emptyEl = document.createElement('div');
            emptyEl.className = 'table-nav-empty';
            emptyEl.textContent = needle ? 'No matching tables' : 'No tables found';
            tableNavList.appendChild(emptyEl);
            return;
        }

        tableItems.forEach((tbl, idx) => {
            const itemEl = document.createElement('div');
            itemEl.className = 'table-nav-item' + (selectedNode && selectedNode.name === tbl.name ? ' active' : '');
            itemEl.setAttribute('role', 'button');
            itemEl.setAttribute('tabindex', '0');
            itemEl.dataset.tableName = tbl.name;
            itemEl.style.animationDelay = `${Math.min(idx * 20, 300)}ms`;

            // Table icon
            const iconWrap = document.createElement('div');
            iconWrap.className = 'table-nav-item-icon';
            iconWrap.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="3" x2="9" y2="21"/></svg>';

            // Content wrapper
            const contentEl = document.createElement('div');
            contentEl.className = 'table-nav-item-content';

            const nameEl = document.createElement('div');
            nameEl.className = 'table-nav-name';
            nameEl.textContent = tbl.name;

            const metaEl = document.createElement('div');
            metaEl.className = 'table-nav-meta';
            const columnCount = Array.isArray(tbl.columns) ? tbl.columns.length : 0;
            const relationCount = relationCountByTable[tbl.name] || 0;

            const colTag = document.createElement('span');
            colTag.className = 'table-nav-meta-tag';
            colTag.textContent = `${columnCount} col${columnCount === 1 ? '' : 's'}`;

            const relTag = document.createElement('span');
            relTag.className = 'table-nav-meta-tag';
            relTag.textContent = `${relationCount} rel${relationCount === 1 ? '' : 's'}`;

            metaEl.appendChild(colTag);
            metaEl.appendChild(relTag);
            const owner = tableOwners?.[tbl.name];
            if (owner?.title) {
                // Ownership comes from SQL tabs, not the parsed schema. It makes
                // the navigator explain where a table definition will be edited.
                const ownerTag = document.createElement('span');
                ownerTag.className = 'table-nav-meta-tag';
                ownerTag.textContent = `Tab: ${owner.title}`;
                ownerTag.title = `SQL tab: ${owner.title}, line ${owner.line}`;
                metaEl.appendChild(ownerTag);
            }
            contentEl.appendChild(nameEl);
            contentEl.appendChild(metaEl);

            // Arrow
            const arrowEl = document.createElement('div');
            arrowEl.className = 'table-nav-item-arrow';
            arrowEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';

            itemEl.appendChild(iconWrap);
            itemEl.appendChild(contentEl);
            itemEl.appendChild(arrowEl);
            tableNavList.appendChild(itemEl);
        });
    }

    function showTableNavPopup() {
        if (!tableNavPopup) return;
        if (tableNavSearch) tableNavSearch.value = '';
        renderTableNavList('');
        tableNavPopup.style.visibility = 'hidden';
        tableNavPopup.style.display = 'block';
        positionToolbarPopup(tableNavPopup, tableNavBtn);
        tableNavPopup.style.visibility = '';
        tableNavBtn?.setAttribute('aria-expanded', 'true');
        if (tableNavSearch) {
            tableNavSearch.focus({ preventScroll: true });
        }
    }

    function clearAllTableColors() {
        (schema.tables || []).forEach((tbl) => {
            contextManager.setTableColor(tbl.name, theme.headerBg);
        });
        contextManager.clearAllTableHeaderTextModes();
        if (selectedNode && colorHexInput) {
            colorHexInput.value = theme.headerBg.replace('#', '');
        }
        scheduleDraw();
    }

    function autoColorAllTables(paletteMode = getRecommendedTableColorMode(darkMode)) {
        const colors = generateSmartTableColors(schema, { inferredRelations: safeInferredRelations, paletteMode });
        contextManager.bulkSetTableColors(colors);

        if (selectedNode && colorHexInput) {
            const selectedColor = contextManager.getTableColor(selectedNode.name) || theme.headerBg;
            colorHexInput.value = parseGradientColor(selectedColor) ? '' : selectedColor.replace('#', '');
        }
        scheduleDraw();
    }

    function getAutoColorOptions() {
        return autoColorPopup ? [...autoColorPopup.querySelectorAll('.auto-color-option')] : [];
    }

    function updateAutoColorPopupLayout() {
        if (!autoColorPopup || !autoColorOnlyBtn || autoColorPopup.style.display !== 'flex') return;
        const panel = autoColorOnlyBtn.closest('.erd-panel');
        const panelRect = panel?.getBoundingClientRect() || { top: 0, right: window.innerWidth, bottom: window.innerHeight, left: 0, width: window.innerWidth, height: window.innerHeight };
        const buttonRect = autoColorOnlyBtn.getBoundingClientRect();
        const margin = 8;
        const availableLeft = buttonRect.left - panelRect.left - margin * 2;
        const useStackedPlacement = availableLeft < 170;
        const popupWidth = useStackedPlacement ? Math.max(120, Math.min(238, panelRect.width - margin * 2)) : Math.max(160, Math.min(238, availableLeft));

        autoColorPopup.classList.toggle('auto-color-popup--stacked', useStackedPlacement);
        autoColorPopup.style.width = `${popupWidth}px`;
        const maxPopupHeight = Math.max(72, panelRect.height - margin * 2);
        autoColorPopup.style.maxHeight = `${maxPopupHeight}px`;
        autoColorPopup.style.setProperty('--auto-color-popup-max-height', `${maxPopupHeight}px`);
        if (useStackedPlacement) {
            autoColorPopup.style.left = `${panelRect.left + margin}px`;
        } else {
            autoColorPopup.style.left = `${buttonRect.left - margin - popupWidth}px`;
        }
        autoColorPopup.style.right = 'auto';

        const popupHeight = autoColorPopup.offsetHeight;
        const minimumTop = panelRect.top + margin;
        const maximumTop = Math.max(minimumTop, panelRect.bottom - margin - popupHeight);
        let desiredTop = buttonRect.top + buttonRect.height / 2 - popupHeight / 2;
        if (useStackedPlacement) {
            desiredTop = buttonRect.bottom + margin;
            if (desiredTop > maximumTop) desiredTop = buttonRect.top - popupHeight - margin;
        }
        const popupTop = Math.max(minimumTop, Math.min(desiredTop, maximumTop));
        autoColorPopup.style.top = `${popupTop}px`;
        const arrowY = Math.max(16, Math.min(buttonRect.top + buttonRect.height / 2 - popupTop, Math.max(16, popupHeight - 16)));
        autoColorPopup.style.setProperty('--auto-color-arrow-y', `${arrowY}px`);
    }

    function hideAutoColorPopup(restoreFocus = false) {
        if (!autoColorPopup) return;
        autoColorPopup.style.display = 'none';
        updateAutoColorButtonExpanded(false);
        if (restoreFocus && autoColorOnlyBtn) autoColorOnlyBtn.focus({ preventScroll: true });
    }

    function showAutoColorPopup() {
        if (!autoColorPopup) return;
        autoColorPopup.style.display = 'flex';
        updateAutoColorButtonExpanded(true);
        updateAutoColorPopupLayout();
        getAutoColorOptions()[0]?.focus({ preventScroll: true });
        setTimeout(() => {
            if (autoColorPopup.style.display === 'flex') updateAutoColorPopupLayout();
        }, 200);
    }

    // Show/hide color picker button and delete table button
    function updateButtonsVisibility() {
        const showButtons = selectedNode !== null;
        if (colorControlPopover) colorControlPopover.style.display = showButtons ? 'block' : 'none';
        colorBtn.style.display = showButtons ? 'flex' : 'none';
        deleteTableBtn.style.display = showButtons ? 'flex' : 'none';
        if (!showButtons && colorPopup?.style.display === 'flex') hideColorPopup();
        if (clearPriorityBtn) {
            clearPriorityBtn.style.display = getVisiblePriorityTableNames().length > 0 ? 'flex' : 'none';
        }
    }

    // Helper: validate hex color string
    function isValidHex(hex) {
        return /^#?[0-9a-fA-F]{6}$/.test(hex);
    }

    function updateColorPopupLayout() {
        if (!colorPopup || !colorDotRow) return;

        const dotSize = 23;
        const dotGap = 5;
        const popupPadX = 12;
        const colorSwatchGroups = getColorSwatchGroups();
        const solidCount = colorSwatchGroups.solid.length;
        const gradientCount = colorSwatchGroups.gradient.length;
        const maxSolidCols = 6;
        const maxGradientCols = 6;

        const maxPopupWidth = Math.max(170, Math.min(280, window.innerWidth - 96));
        const maxColsByWidth = Math.max(3, Math.floor((maxPopupWidth - popupPadX * 2 + dotGap) / (dotSize + dotGap)));
        const solidCols = Math.max(1, Math.min(maxSolidCols, solidCount, maxColsByWidth));
        const gradientCols = Math.max(1, Math.min(maxGradientCols, gradientCount, maxColsByWidth));

        const solidWidth = solidCols * dotSize + Math.max(0, solidCols - 1) * dotGap;
        const gradientWidth = gradientCols * dotSize + Math.max(0, gradientCols - 1) * dotGap;
        const contentWidth = Math.max(solidWidth, gradientWidth);

        colorPopup.style.setProperty('--color-dot-size', `${dotSize}px`);
        colorPopup.style.setProperty('--color-dot-gap', `${dotGap}px`);
        colorPopup.style.setProperty('--color-solid-cols', `${solidCols}`);
        colorPopup.style.setProperty('--color-gradient-cols', `${gradientCols}`);
        colorPopup.style.setProperty('--color-popup-content-width', `${contentWidth}px`);
    }

    let colorPopupTargetTableName = null;
    let colorPopupAnchorSource = 'toolbar';
    let colorPopupFocusTimer = null;

    function getColorPopupTargetNode() {
        const targetName = colorPopupTargetTableName || selectedNode?.name;
        if (!targetName) return null;
        return schema.tables.find((tbl) => tbl.name === targetName) || null;
    }

    function updateColorButtonExpanded(isExpanded) {
        if (colorBtn) colorBtn.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
    }

    function getColorTextModeButtons() {
        return colorTextOptions ? [...colorTextOptions.querySelectorAll('[data-table-text-color]')] : [];
    }

    function updateColorTextModeButtons(tableName) {
        const currentMode = contextManager.getTableHeaderTextMode(tableName);
        getColorTextModeButtons().forEach((button) => {
            button.setAttribute('aria-pressed', button.dataset.tableTextColor === currentMode ? 'true' : 'false');
        });
    }

    function resetColorPopupPosition() {
        if (!colorPopup) return;
        colorPopup.classList.remove('color-popup--canvas-anchor');
        colorPopup.removeAttribute('data-placement');
        colorPopup.style.removeProperty('position');
        colorPopup.style.removeProperty('left');
        colorPopup.style.removeProperty('top');
        colorPopup.style.removeProperty('right');
        colorPopup.style.removeProperty('bottom');
        colorPopup.style.removeProperty('transform');
        colorPopup.style.removeProperty('--color-popup-arrow-top');
        colorPopup.style.removeProperty('--color-popup-max-content-height');
    }

    function worldToViewportCssPoint(x, y) {
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        return {
            x: rect.left + (x * contextManager.zoom + contextManager.offsetX) / dpr,
            y: rect.top + (y * contextManager.zoom + contextManager.offsetY) / dpr,
        };
    }

    function positionColorPopupAtViewportPoint(anchor) {
        if (!colorPopup || !anchor) return;
        const margin = 8;
        const gap = 12;
        const viewportWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
        const viewportHeight = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
        const panelRect = colorBtn?.closest('.erd-panel')?.getBoundingClientRect();
        const bounds = panelRect && panelRect.width > 0 && panelRect.height > 0
            ? {
                left: Math.max(margin, panelRect.left + margin),
                right: Math.min(viewportWidth - margin, panelRect.right - margin),
                top: Math.max(margin, panelRect.top + margin),
                bottom: Math.min(viewportHeight - margin, panelRect.bottom - margin),
            }
            : { left: margin, right: viewportWidth - margin, top: margin, bottom: viewportHeight - margin };

        colorPopup.style.setProperty('--color-popup-max-content-height', `${Math.max(72, bounds.bottom - bounds.top - 22)}px`);
        const popupRect = colorPopup.getBoundingClientRect();

        let placement = 'right';
        let left = anchor.x + gap;
        if (left + popupRect.width > bounds.right) {
            placement = 'left';
            left = anchor.x - popupRect.width - gap;
        }

        left = Math.max(bounds.left, Math.min(left, bounds.right - popupRect.width));
        let top = anchor.y - popupRect.height / 2;
        top = Math.max(bounds.top, Math.min(top, bounds.bottom - popupRect.height));

        const arrowTop = Math.max(14, Math.min(anchor.y - top, popupRect.height - 14));

        colorPopup.classList.add('color-popup--canvas-anchor');
        colorPopup.dataset.placement = placement;
        colorPopup.style.position = 'fixed';
        colorPopup.style.left = `${Math.round(left)}px`;
        colorPopup.style.top = `${Math.round(top)}px`;
        colorPopup.style.right = 'auto';
        colorPopup.style.bottom = 'auto';
        colorPopup.style.transform = 'none';
        colorPopup.style.setProperty('--color-popup-arrow-top', `${Math.round(arrowTop)}px`);
    }

    function positionColorPopupAtTable(icon) {
        if (!icon) return;
        positionColorPopupAtViewportPoint(worldToViewportCssPoint(icon.x, icon.y));
    }

    function positionColorPopupAtButton() {
        if (!colorBtn) return;
        const rect = colorBtn.getBoundingClientRect();
        positionColorPopupAtViewportPoint({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    }

    // Show color picker popup for a target table. Toolbar calls use the
    // selected table; table-header calls pass an explicit anchor icon.
    function showColorPopup(targetNode = selectedNode, options = {}) {
        const targetTable = targetNode || selectedNode;
        if (!targetTable) return;
        colorPopupTargetTableName = targetTable.name;
        colorPopupAnchorSource = options.source === 'table-header' ? 'table-header' : 'toolbar';
        // Render colors according to palette and auto-arrange in a responsive grid
        colorDotRow.innerHTML = '';
        const currentColor = contextManager.getTableColor(targetTable.name) || theme.headerBg;
        const colorSwatchGroups = getColorSwatchGroups();

        const appendSwatch = (gridEl, swatch) => {
            const dot = document.createElement('button');
            dot.type = 'button';
            dot.className = 'color-dot' + (currentColor.toLowerCase() === swatch.value.toLowerCase() ? ' selected' : '') + (swatch.type === 'gradient' ? ' color-dot--gradient' : '');
            dot.style.background = getCanvasColorCss(swatch.value);
            dot.title = swatch.title;
            dot.setAttribute('aria-label', `Use ${swatch.title} table color`);
            dot.setAttribute('aria-pressed', currentColor.toLowerCase() === swatch.value.toLowerCase() ? 'true' : 'false');
            dot.onclick = (e) => {
                e.stopPropagation();
                const colorTarget = getColorPopupTargetNode();
                if (!colorTarget) return;
                // Update color in context
                contextManager.setTableColor(colorTarget.name, swatch.value);
                colorHexInput.value = swatch.type === 'gradient' ? '' : swatch.value.replace('#', '');
                scheduleDraw();
                hideColorPopup(true);
            };
            gridEl.appendChild(dot);
        };

        const appendSwatchSection = (title, swatches, gridClassName) => {
            const section = document.createElement('div');
            section.className = 'color-swatch-section';

            const label = document.createElement('div');
            label.className = 'color-swatch-section-label';
            label.textContent = title;

            const grid = document.createElement('div');
            grid.className = `color-swatch-grid ${gridClassName}`;
            swatches.forEach((swatch) => appendSwatch(grid, swatch));

            section.appendChild(label);
            section.appendChild(grid);
            colorDotRow.appendChild(section);
        };

        appendSwatchSection(
            'Solid',
            colorSwatchGroups.solid,
            'color-swatch-grid--solid',
        );
        appendSwatchSection('Gradient', colorSwatchGroups.gradient, 'color-swatch-grid--gradient');

        // Set input hex theo context
        colorHexInput.value = parseGradientColor(currentColor) ? '' : currentColor.replace('#', '');
        updateColorTextModeButtons(targetTable.name);
        updateColorPopupLayout();
        resetColorPopupPosition();
        colorPopup.style.visibility = 'hidden';
        colorPopup.style.display = 'flex';
        updateColorButtonExpanded(true);
        if (colorPopupAnchorSource === 'table-header') positionColorPopupAtTable(options.anchorIcon);
        else positionColorPopupAtButton();
        colorPopup.style.visibility = '';
        const focusTargetTableName = targetTable.name;
        clearTimeout(colorPopupFocusTimer);
        colorPopupFocusTimer = setTimeout(() => {
            if (colorPopup.style.display !== 'flex' || colorPopupTargetTableName !== focusTargetTableName) return;
            const activeModeButton = getColorTextModeButtons().find((button) => button.getAttribute('aria-pressed') === 'true');
            (activeModeButton || colorHexInput).focus();
        }, 100);
    }

    // Hide color picker popup
    function hideColorPopup(restoreFocus = false) {
        clearTimeout(colorPopupFocusTimer);
        colorPopupFocusTimer = null;
        colorPopupTargetTableName = null;
        colorPopup.style.display = 'none';
        colorPopup.style.visibility = '';
        resetColorPopupPosition();
        updateColorButtonExpanded(false);
        if (restoreFocus && colorBtn) colorBtn.focus({ preventScroll: true });
    }

    updateLayoutModeButton();

    // ════════════════════════════════════════════════════════════════════
    //  SECTION 3 — UI dimension constants (CSS-pixel units)
    // ════════════════════════════════════════════════════════════════════
    //  Every constant below is in CSS pixels. The 2D context is pre-scaled
    //  by `devicePixelRatio` once per resize so all draw code can stay in
    //  CSS-pixel units — do NOT multiply these by DPR yourself.
    //
    //  Changing these values rebalances the visual density of the diagram:
    //    • PADDING_TABLE_LR : whitespace inside each card
    //    • NODE_H           : header row height (table name + icons)
    //    • ROW_H            : per-column row height (lines stack vertically)
    //
    //  Section 4 (layout) and section 5 (drawing) both consume these — keep
    //  them tightly coupled, otherwise text overflows or columns clip.
    // ════════════════════════════════════════════════════════════════════
    // Left/right padding for tables
    const PADDING_TABLE_LR = 10;
    // Table header height
    const NODE_H = 30;
    // Height of each column row
    const ROW_H = 28;
    // Connector exit length from table
    const CONNECTOR_OFFSET = 24;
    // 0..N is the widest cardinality glyph: (17 + 4) * 1.18 = 24.78px.
    // Add the largest rounded-corner radius (8px) plus visual breathing room.
    const CONNECTOR_HEAD_CLEARANCE = 38;
    // Overlap distance threshold (nearby tables also count as overlap)
    const OVERLAP_PAD = CONNECTOR_OFFSET + 35;

    // ════════════════════════════════════════════════════════════════════
    //  SECTION 4 — Layout (ELK auto-layout + Snowflake fallback)
    // ════════════════════════════════════════════════════════════════════
    //  Computes (x, y) for every table in WORLD coordinates. Four modes:
    //    • BEST    — inspects the relationship graph, then chooses a packed
    //                grid, semantic parent-to-child ELK, or radial hub layout.
    //    • LR / RL — uses ELK (elkjs worker) with `layered` algorithm and
    //                a `direction` of RIGHT / LEFT. Good for transactional
    //                schemas with clear FK direction.
    //    • SF      — Snowflake. Greedy radial layout: the most-connected
    //                table goes in the center, satellites are placed around
    //                it on a ring. No worker; fully synchronous. Good for
    //                warehouse / star schemas.
    //
    //  Per-table dimensions are computed first by `getTableWidth()` /
    //  `getTableHeight()` (text-measured against the live canvas font), then
    //  fed to the layout algorithm as node sizes. ELK runs OFF the main
    //  thread; do not await it inside a synchronous event handler.
    //
    //  Persisted positions in `contextManager.tablePositions` short-circuit
    //  layout for tables the user has manually moved — only NEW tables get
    //  auto-positioned, so re-renders don't snap dragged tables back.
    // ════════════════════════════════════════════════════════════════════
    // Dynamically calculate width for each table based on table name, column names, types, constraints, and icons
    function getTableWidth(tbl, ctx) {
        if (!tbl || !tbl.columns) return 180;
        ctx.save();
        ctx.font = 'bold 16px sans-serif';
        const ownerTitle = getVisibleTableOwnerTitle(tbl.name);
        ctx.font = '11px sans-serif';
        const ownerWidth = ownerTitle ? ctx.measureText(ownerTitle).width + 18 : 0;
        ctx.font = 'bold 16px sans-serif';
        let max = ctx.measureText(tbl.name).width + ownerWidth + 132; // owner label + enlarged priority, jump-to-code, color, and compact-mode icons
        ctx.font = '14px sans-serif';
        tbl.columns.forEach((col) => {
            const colNameW = ctx.measureText(col.name).width;
            let suffix = col.type;
            if (col.pk) suffix += ' 🔑';
            if (col.fk) suffix += ' 🔗';
            let typeW = ctx.measureText(suffix).width;
            let constraintW = 0;
            if (col.constraints && Array.isArray(col.constraints) && col.constraints.length > 0) {
                ctx.font = '12px sans-serif';
                col.constraints.forEach((c, _idx) => {
                    constraintW += 8; // spacing
                    constraintW += ctx.measureText(c).width + 4;
                });
                ctx.font = '14px sans-serif';
            }
            const totalW = PADDING_TABLE_LR + colNameW + 16 + typeW + constraintW + PADDING_TABLE_LR;
            if (totalW > max) max = totalW;
        });
        ctx.restore();
        return Math.max(180, Math.min(max, 420));
    }

    function buildSnowflakeLayoutPositions(schema, edges) {
        const tables = schema.tables || [];
        if (tables.length === 0) return {};

        const tableNames = tables.map((tbl) => tbl.name);
        const adjacency = new Map(tableNames.map((name) => [name, new Set()]));

        edges.forEach((edge) => {
            if (!adjacency.has(edge.source) || !adjacency.has(edge.target) || edge.source === edge.target) return;
            adjacency.get(edge.source).add(edge.target);
            adjacency.get(edge.target).add(edge.source);
        });

        const getDegree = (name) => adjacency.get(name)?.size || 0;
        const pickHighestDegree = (names) => {
            if (!names || names.length === 0) return null;
            return [...names].sort((a, b) => {
                const degreeDiff = getDegree(b) - getDegree(a);
                if (degreeDiff !== 0) return degreeDiff;
                return a.localeCompare(b);
            })[0];
        };

        const levels = new Map();
        const hubName = pickHighestDegree(tableNames) || tableNames[0];
        levels.set(hubName, 0);

        const bfsWithin = (seedName, levelOffset, allowNode) => {
            const queue = [seedName];
            const localLevels = new Map([[seedName, 0]]);
            let maxLocalLevel = 0;

            while (queue.length > 0) {
                const current = queue.shift();
                const currentLevel = localLevels.get(current);
                const neighbors = adjacency.get(current) ? [...adjacency.get(current)] : [];
                neighbors.sort((a, b) => {
                    const degreeDiff = getDegree(b) - getDegree(a);
                    if (degreeDiff !== 0) return degreeDiff;
                    return a.localeCompare(b);
                });

                neighbors.forEach((neighbor) => {
                    if (!allowNode(neighbor) || levels.has(neighbor) || localLevels.has(neighbor)) return;
                    const nextLevel = currentLevel + 1;
                    localLevels.set(neighbor, nextLevel);
                    if (nextLevel > maxLocalLevel) maxLocalLevel = nextLevel;
                    queue.push(neighbor);
                });
            }

            localLevels.forEach((localLevel, name) => {
                levels.set(name, levelOffset + localLevel);
            });
            return maxLocalLevel;
        };

        // Main component: start from the most-connected table
        bfsWithin(hubName, 0, () => true);

        // Disconnected components will be placed in the next outer ring
        const unassigned = new Set(tableNames.filter((name) => !levels.has(name)));
        let nextLevelOffset = levels.size > 0 ? Math.max(...levels.values()) + 1 : 0;

        while (unassigned.size > 0) {
            const seed = pickHighestDegree([...unassigned]);
            if (!seed) break;
            const componentMaxLocalLevel = bfsWithin(seed, nextLevelOffset, (name) => unassigned.has(name));
            levels.forEach((_, name) => {
                if (unassigned.has(name)) unassigned.delete(name);
            });
            if (unassigned.has(seed)) unassigned.delete(seed);
            nextLevelOffset += componentMaxLocalLevel + 1;
        }

        const averageNodeSize = tables.reduce((sum, tbl) => sum + Math.max(tbl.width || 180, tbl.height || 120), 0) / tables.length;
        const radialStep = Math.max(280, averageNodeSize + 90);
        const groupedLevels = new Map();

        levels.forEach((level, tableName) => {
            if (!groupedLevels.has(level)) groupedLevels.set(level, []);
            groupedLevels.get(level).push(tableName);
        });

        const positions = {};
        const orderedLevels = [...groupedLevels.keys()].sort((a, b) => a - b);

        orderedLevels.forEach((level) => {
            const names = groupedLevels.get(level);
            names.sort((a, b) => {
                const degreeDiff = getDegree(b) - getDegree(a);
                if (degreeDiff !== 0) return degreeDiff;
                return a.localeCompare(b);
            });

            if (level === 0) {
                positions[names[0]] = { x: 0, y: 0 };
                return;
            }

            const count = names.length;
            const estimatedCircumference = count * (averageNodeSize + 70);
            const minRadius = estimatedCircumference / (2 * Math.PI);
            const radius = Math.max(radialStep * level, minRadius + 40);

            names.forEach((tableName, idx) => {
                const angle = -Math.PI / 2 + (2 * Math.PI * idx) / count;
                positions[tableName] = {
                    x: Math.cos(angle) * radius,
                    y: Math.sin(angle) * radius,
                };
            });
        });

        // Fallback position for any table that does not have coordinates yet
        tableNames.forEach((name, idx) => {
            if (!positions[name]) {
                positions[name] = {
                    x: 200 + (idx % 3) * 400,
                    y: 200 + Math.floor(idx / 3) * 300,
                };
            }
        });

        return positions;
    }

    // Function to compute table layout with ELK
    async function computeTableLayoutWithELK(schema, layoutMode = currentLayoutMode) {
        // 1. Calculate width/height first. Defensive: a malformed schema
        //    coming from a half-typed editor or a buggy upstream caller
        //    can ship tables with missing/non-array `columns`. Treat those
        //    as zero-column placeholders so layout can still proceed
        //    (matches the empty-table semantics elsewhere in the renderer).
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');
        schema.tables.forEach((tbl) => {
            const colCount = Array.isArray(tbl.columns) ? tbl.columns.length : 0;
            tbl.width = Number(getTableWidth(tbl, tempCtx));
            tbl.height = Number(NODE_H + colCount * ROW_H);
        });

        // 2. Prepare valid nodes and edges. Drop relations missing either
        //    side (parser/upstream might have produced `{ from: null }` on
        //    a malformed FK). Without this guard, the `nodeIds.has(...)`
        //    chain throws on `undefined.table`, which fails the entire
        //    layout pass and leaves the canvas unrendered.
        const normalizedMode = normalizeLayoutMode(layoutMode);
        const isBestMode = normalizedMode === LAYOUT_MODES.BEST;
        const nodeIds = new Set(schema.tables.map((t) => t.name));
        const graphProfile = isBestMode ? analyzeErdLayoutGraph(schema.tables, schema.relations) : null;
        const bestStrategy = isBestMode ? chooseBestLayoutStrategy(graphProfile) : null;
        const orderedTables = isBestMode ? orderTablesForSmartLayout(schema.tables, graphProfile) : schema.tables;
        const children = orderedTables.map((tbl) => ({
            id: tbl.name,
            width: tbl.width,
            height: tbl.height,
        }));
        const edges = buildLayoutEdges(schema.relations, nodeIds, {
            semanticDirection: isBestMode,
            dedupe: isBestMode,
            skipSelf: isBestMode,
        });

        // 3. Run layout based on mode
        let computedPositions = {};

        try {
            if (isBestMode && bestStrategy === SMART_LAYOUT_STRATEGIES.GRID) {
                computedPositions = buildGridLayoutPositions(orderedTables);
            } else if (normalizedMode === LAYOUT_MODES.SNOWFLAKE || (isBestMode && bestStrategy === SMART_LAYOUT_STRATEGIES.RADIAL)) {
                computedPositions = buildSnowflakeLayoutPositions({ ...schema, tables: orderedTables }, edges);
            } else {
                const layoutOptions = {
                    'elk.algorithm': 'layered',
                    'elk.direction': normalizedMode === LAYOUT_MODES.RIGHT_TO_LEFT ? 'LEFT' : 'RIGHT',
                    'elk.spacing.nodeNode': isBestMode ? '48' : '40',
                    'elk.layered.spacing.nodeNodeBetweenLayers': isBestMode ? '120' : '80',
                    'elk.layered.edgeRouting': 'ORTHOGONAL',
                    'elk.layered.mergeEdges': 'false',
                    'elk.padding': '30',
                    'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
                };

                if (isBestMode) {
                    Object.assign(layoutOptions, {
                        'elk.layered.cycleBreaking.strategy': 'GREEDY',
                        'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
                        'elk.spacing.edgeNode': '28',
                        'elk.spacing.edgeEdge': '18',
                    });
                }

                const elkGraph = {
                    id: 'root',
                    layoutOptions,
                    children,
                    edges,
                };

                const g = await elk.layout(elkGraph);
                computedPositions = {};
                (g.children || []).forEach((node) => {
                    computedPositions[node.id] = {
                        x: node.x + node.width / 2,
                        y: node.y + node.height / 2,
                    };
                });
            }
        } catch (err) {
            console.error('Layout error:', err);
            computedPositions = {};
        }

        // 4. Restore previously saved positions; use new layout for new tables
        schema.tables.forEach((tbl, idx) => {
            const savedPosition = contextManager.getTablePosition(tbl.name);
            if (savedPosition) {
                tbl.x = savedPosition.x;
                tbl.y = savedPosition.y;
                return;
            }

            const position = computedPositions[tbl.name];
            if (position && typeof position.x === 'number' && typeof position.y === 'number' && !isNaN(position.x) && !isNaN(position.y)) {
                tbl.x = position.x;
                tbl.y = position.y;
                contextManager.setTablePosition(tbl.name, tbl.x, tbl.y);
                return;
            }

            if (typeof tbl.x !== 'number' || typeof tbl.y !== 'number' || isNaN(tbl.x) || isNaN(tbl.y)) {
                tbl.x = 200 + (idx % 3) * 400;
                tbl.y = 200 + Math.floor(idx / 3) * 300;
            }
        });
    }

    // Compute initial table layout
    await computeTableLayoutWithELK(schema, currentLayoutMode);

    // Clone the canvas node to clear all previous event listeners on each
    // script run. Bail out gracefully if the host page never mounted the
    // `#erd-canvas` element (e.g. component unmount races, SSR pre-paint,
        // headless callers invoking runErdScript without a DOM) — silently returning is
    // safer than throwing inside an async render that the caller can't
    // catch easily.
    const oldCanvas = document.getElementById('erd-canvas');
    if (!oldCanvas || !oldCanvas.parentNode) {
        return;
    }
    const newCanvas = oldCanvas.cloneNode(true);
    oldCanvas.parentNode.replaceChild(newCanvas, oldCanvas);
    const canvas = newCanvas;
    const ctx = canvas.getContext('2d'); // get canvas context
    const baseCanvas = canvas;
    const baseCtx = ctx;
    const minimapPanel = document.getElementById('erd-minimap');
    const oldMinimapCanvas = document.getElementById('erd-minimap-canvas');
    let minimapCanvas = null;
    let minimapCtx = null;
    if (oldMinimapCanvas?.parentNode) {
        minimapCanvas = oldMinimapCanvas.cloneNode(true);
        oldMinimapCanvas.parentNode.replaceChild(minimapCanvas, oldMinimapCanvas);
        minimapCtx = minimapCanvas.getContext('2d');
    }
    let minimapVisible = minimapPanel?.classList.contains('is-open') === true;
    let minimapModel = null;
    let minimapDrag = null;
    const connectorPopupHost = canvas.closest('.erd-panel') || canvas.parentElement;
    connectorPopupHost?.querySelectorAll('[data-erd-connector-side-editor="true"]').forEach((element) => element.remove());
    const connectorSidePopup = document.createElement('section');
    connectorSidePopup.className = 'erd-connector-side-popup';
    connectorSidePopup.dataset.erdConnectorSideEditor = 'true';
    connectorSidePopup.setAttribute('role', 'dialog');
    connectorSidePopup.setAttribute('aria-label', 'Connector endpoint sides');
    connectorPopupHost?.appendChild(connectorSidePopup);

    function getConnectorByKey(relationKey) {
        if (!relationKey) return null;
        return connectorPaths.find((connector) => connector?.relationKey === relationKey) || null;
    }

    function hideConnectorSidePopup({ clearSelection = true } = {}) {
        connectorSidePopup.classList.remove('is-open');
        connectorSidePopup.replaceChildren();
        if (clearSelection) selectedConnectorKey = null;
        requestRedraw();
    }

    function renderConnectorSidePopup(connector) {
        if (!connector?.relation || !connector.relationKey) return;
        const relation = connector.relation;
        const overrides = contextManager.getConnectorEndpointSides(connector.relationKey);
        connectorSidePopup.replaceChildren();

        const header = document.createElement('div');
        header.className = 'erd-connector-side-popup__header';
        const headingGroup = document.createElement('div');
        const title = document.createElement('h3');
        title.className = 'erd-connector-side-popup__title';
        title.textContent = `${relation.from.table}.${relation.from.column} → ${relation.to.table}.${relation.to.column}`;
        const hint = document.createElement('p');
        hint.className = 'erd-connector-side-popup__hint';
        hint.textContent = 'Choose a side, or drag either dot across its table.';
        headingGroup.append(title, hint);
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'erd-connector-side-popup__close';
        close.setAttribute('aria-label', 'Close connector editor');
        close.textContent = '×';
        close.onclick = () => hideConnectorSidePopup();
        header.append(headingGroup, close);
        connectorSidePopup.appendChild(header);

        const addEndpointRow = (endpoint, label, tableName, columnName) => {
            const row = document.createElement('div');
            row.className = 'erd-connector-side-popup__row';
            const endpointText = document.createElement('div');
            endpointText.className = 'erd-connector-side-popup__endpoint';
            const endpointLabel = document.createElement('strong');
            endpointLabel.textContent = label;
            const endpointField = document.createElement('span');
            endpointField.textContent = `${tableName}.${columnName}`;
            endpointText.append(endpointLabel, endpointField);

            const options = document.createElement('div');
            options.className = 'erd-connector-side-popup__options';
            options.setAttribute('role', 'group');
            options.setAttribute('aria-label', `${label} connector side`);
            ['auto', 'left', 'right'].forEach((side) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'erd-connector-side-popup__option';
                const isSelected = side === 'auto' ? !overrides[endpoint] : overrides[endpoint] === side;
                button.classList.toggle('is-selected', isSelected);
                button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
                button.title = side === 'auto' ? 'Choose the nearest safe side automatically' : `Attach to the ${side} side`;
                button.textContent = side === 'auto' ? 'Auto' : side === 'left' ? 'L' : 'R';
                button.onclick = () => {
                    if (side === 'auto') contextManager.clearConnectorEndpointSide(connector.relationKey, endpoint);
                    else contextManager.setConnectorEndpointSide(connector.relationKey, endpoint, side);
                    connectorTooltipCache = null;
                    requestRedraw();
                    const updatedConnector = getConnectorByKey(connector.relationKey) || connector;
                    renderConnectorSidePopup(updatedConnector);
                };
                options.appendChild(button);
            });
            row.append(endpointText, options);
            connectorSidePopup.appendChild(row);
        };

        addEndpointRow('from', 'From / outgoing', relation.from.table, relation.from.column);
        addEndpointRow('to', 'To / incoming', relation.to.table, relation.to.column);
    }

    function refreshConnectorSidePopup(connector) {
        if (!connectorSidePopup.classList.contains('is-open') || connector?.relationKey !== selectedConnectorKey) return;
        renderConnectorSidePopup(connector);
    }

    function positionConnectorSidePopup(clientX, clientY) {
        if (!connectorPopupHost) return;
        const hostRect = connectorPopupHost.getBoundingClientRect();
        const margin = 10;
        const gap = 12;
        const popupWidth = connectorSidePopup.offsetWidth || 280;
        const popupHeight = connectorSidePopup.offsetHeight || 154;
        const controlsRect = connectorPopupHost.querySelector('#erd-controls')?.getBoundingClientRect();
        const rightBoundary = controlsRect ? Math.max(margin + popupWidth, controlsRect.left - hostRect.left - 8) : hostRect.width - margin;
        let left = clientX - hostRect.left + gap;
        let top = clientY - hostRect.top + gap;
        if (left + popupWidth > rightBoundary) left = clientX - hostRect.left - popupWidth - gap;
        if (top + popupHeight > hostRect.height - margin) top = clientY - hostRect.top - popupHeight - gap;
        connectorSidePopup.style.left = `${Math.max(margin, Math.min(left, rightBoundary - popupWidth))}px`;
        connectorSidePopup.style.top = `${Math.max(margin, Math.min(top, hostRect.height - popupHeight - margin))}px`;
    }

    function showConnectorSidePopup(connector, clientX, clientY) {
        if (!connector?.relationKey) return;
        selectedConnectorKey = connector.relationKey;
        renderConnectorSidePopup(connector);
        connectorSidePopup.classList.add('is-open');
        positionConnectorSidePopup(clientX, clientY);
        requestRedraw();
    }

    connectorSidePopup.addEventListener('mousedown', (event) => event.stopPropagation());
    connectorSidePopup.addEventListener('touchstart', (event) => event.stopPropagation(), { passive: true });
    connectorSidePopup.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        hideConnectorSidePopup();
        canvas.focus({ preventScroll: true });
    });

    // ════════════════════════════════════════════════════════════════════
    //  SECTION 5 — Drawing primitives (table card + columns + badges)
    // ════════════════════════════════════════════════════════════════════
    //  All draw helpers in this section assume the caller has already set
    //  up the world→screen transform on `ctx` (translate by offset, scale
    //  by zoom). They draw in WORLD coordinates.
    //
    //  Visual hierarchy of a single table card (top to bottom):
    //    ┌──────────────────────────────────────┐
    //    │  ▶ icon  TableName        ⤤ ✎ ✕     │  ← header (NODE_H tall)
    //    ├──────────────────────────────────────┤
    //    │  PK 🔑 id          int               │  ← column row (ROW_H tall)
    //    │  FK 🔗 user_id     int               │
    //    │       email        varchar  UQ NN    │  ← extras as right-side badges
    //    └──────────────────────────────────────┘
    //
    //  Drawing order matters for hit-testing — the table is drawn AFTER
    //  connectors so the card visually sits on top, but pointer events go
    //  through hit-testing in `pointerHit()` (section 10) which iterates
    //  in REVERSE order so the topmost card claims the click.
    // ════════════════════════════════════════════════════════════════════
    // --- Helper: Draw node box ---
    function drawNodeBox(ctx, tbl, borderTableRadius) {
        ctx.save();
        // If this is the selected node, use a darker shadow
        if (selectedNode && selectedNode.name === tbl.name) {
            ctx.shadowColor = theme.shadow;
            ctx.shadowBlur = 20;
        } else {
            ctx.shadowColor = theme.shadow;
            ctx.shadowBlur = 7;
        }
        ctx.fillStyle = theme.nodeFill;
        ctx.strokeStyle = theme.nodeBorder;
        ctx.lineWidth = 0.3;
        drawRoundRect(ctx, tbl.x - tbl.width / 2, tbl.y - tbl.height / 2, tbl.width, tbl.height, borderTableRadius);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    function getHeaderIconLayout(tbl) {
        const iconY = tbl.y - tbl.height / 2 + NODE_H / 2;
        const eyeX = tbl.x + tbl.width / 2 - 18;
        const iconGap = 24;
        const jumpX = eyeX - iconGap;
        const colorX = jumpX - iconGap;
        const priorityX = colorX - iconGap;
        const prioritySize = 19;
        const colorSize = 16.5;

        return {
            iconY,
            hitSize: 24,
            eye: { x: eyeX, y: iconY, size: 18 },
            color: { x: colorX, y: iconY, size: colorSize },
            jump: { x: jumpX, y: iconY, size: 17 },
            priority: { x: priorityX, y: iconY, size: prioritySize },
            textRight: priorityX - prioritySize / 2 - 8,
        };
    }

    function isPointInHeaderIcon(x, y, icon, hitSize) {
        return x >= icon.x - hitSize / 2 && x <= icon.x + hitSize / 2 && y >= icon.y - hitSize / 2 && y <= icon.y + hitSize / 2;
    }

    function isPointInTableHeader(x, y, tbl) {
        return x >= tbl.x - tbl.width / 2 && x <= tbl.x + tbl.width / 2 && y >= tbl.y - tbl.height / 2 && y <= tbl.y - tbl.height / 2 + NODE_H;
    }

    function shouldDrawHeaderActions(tbl) {
        return headerActionsAlwaysVisible !== false || hoveredHeaderTableName === tbl.name;
    }

    // --- Helper: Draw node title ---
    function drawNodeTitle(ctx, tbl, borderTableRadius) {
        ctx.save();
        // Get color from context; use default if not set
        const configuredColor = contextManager.getTableColor(tbl.name) || theme.headerBg;
        const color = resolveTableHeaderColor(configuredColor, theme.headerBg);
        const requestedTextColor = getTableHeaderTextColorForMode(contextManager.getTableHeaderTextMode(tbl.name));
        const headerContrast = getTableHeaderContrastTreatment(color, 4.75, theme.nodeFill, requestedTextColor);
        const headerTextColor = headerContrast.textColor;
        const headerX = tbl.x - tbl.width / 2;
        const headerY = tbl.y - tbl.height / 2;
        ctx.fillStyle = getTableHeaderFillStyle(ctx, tbl, color, NODE_H);
        drawRoundRect(ctx, headerX, headerY, tbl.width, NODE_H, [borderTableRadius, borderTableRadius, 0, 0]);
        ctx.fill();
        if (headerContrast.overlayAlpha > 0) {
            ctx.save();
            ctx.globalAlpha = composeCanvasAlpha(ctx.globalAlpha, headerContrast.overlayAlpha);
            ctx.fillStyle = headerContrast.overlayColor;
            drawRoundRect(ctx, headerX, headerY, tbl.width, NODE_H, [borderTableRadius, borderTableRadius, 0, 0]);
            ctx.fill();
            ctx.restore();
        }
        const iconLayout = getHeaderIconLayout(tbl);
        const drawHeaderActions = shouldDrawHeaderActions(tbl);
        // Draw compact mode toggle icon in the rightmost header slot.
        const isCompact = contextManager.getTableCompactMode(tbl.name);
        const iconPath = isCompact ? eyeOffIconPath : eyeIconPath;

        if (drawHeaderActions) {
            ctx.save();
            ctx.translate(iconLayout.eye.x - iconLayout.eye.size / 2, iconLayout.eye.y - iconLayout.eye.size / 2);
            ctx.scale(iconLayout.eye.size / 24, iconLayout.eye.size / 24);
            ctx.fillStyle = headerTextColor;
            ctx.fill(iconPath);
            ctx.restore();

            // Draw per-table color picker icon between priority and jump.
            ctx.save();
            const colorIcon = iconLayout.color;
            ctx.translate(colorIcon.x - colorIcon.size / 2, colorIcon.y - colorIcon.size / 2);
            ctx.scale(colorIcon.size / 512, colorIcon.size / 512);
            ctx.strokeStyle = headerTextColor;
            ctx.lineWidth = 42;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.miterLimit = 10;
            ctx.stroke(colorBucketIconPath);
            ctx.stroke(colorDropIconPath);
            ctx.restore();

            // Draw priority star in the leftmost header action slot.
            const isPriority = contextManager.isPriorityTableName(tbl.name);
            ctx.save();
            ctx.translate(iconLayout.priority.x - iconLayout.priority.size / 2, iconLayout.priority.y - iconLayout.priority.size / 2);
            ctx.scale(iconLayout.priority.size / 24, iconLayout.priority.size / 24);
            ctx.fillStyle = headerTextColor;
            ctx.strokeStyle = headerTextColor;
            ctx.lineWidth = 2;
            ctx.lineJoin = 'round';
            if (isPriority) {
                ctx.fill(priorityIconPath);
                ctx.stroke(priorityIconPath);
            } else {
                ctx.stroke(priorityIconPath);
            }
            ctx.restore();
        }

        const textX = headerX + PADDING_TABLE_LR;
        const textY = headerY + NODE_H / 2;
        const textRight = iconLayout.textRight;
        const textMaxWidth = Math.max(0, textRight - textX);
        ctx.font = 'bold 14px sans-serif';
        ctx.fillStyle = headerTextColor;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';

        ctx.save();
        ctx.beginPath();
        ctx.rect(textX, headerY, textMaxWidth, NODE_H);
        ctx.clip();
        const tableNameText = truncateCanvasTextToWidth(ctx, tbl.name, textMaxWidth);
        ctx.fillText(tableNameText, textX, textY);

        const ownerTitle = getVisibleTableOwnerTitle(tbl.name);
        if (ownerTitle && tableNameText) {
            const tableNameWidth = ctx.measureText(tableNameText).width;
            const ownerLabel = `· ${ownerTitle}`;
            ctx.font = '11px sans-serif';
            const ownerX = textX + tableNameWidth + 7;
            const ownerMaxWidth = Math.max(0, textRight - ownerX);
            const ownerText = truncateCanvasTextToWidth(ctx, ownerLabel, ownerMaxWidth);
            if (ownerText) {
                ctx.fillText(ownerText, ownerX, textY);
            }
        }
        ctx.restore();

        if (drawHeaderActions) {
            ctx.save();
            ctx.translate(iconLayout.jump.x - iconLayout.jump.size / 2, iconLayout.jump.y - iconLayout.jump.size / 2);
            ctx.scale(iconLayout.jump.size / 24, iconLayout.jump.size / 24);
            ctx.strokeStyle = headerTextColor;
            ctx.lineWidth = 2.2;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.stroke(jumpToCodeIconPath);
            ctx.restore();
        }

        ctx.restore();
    }

    // --- SVG ICON PATHS ---
    const keyIconPath = new Path2D('M12.3212 10.6852L4 19L6 21M7 16L9 18M20 7.5C20 9.98528 17.9853 12 15.5 12C13.0147 12 11 9.98528 11 7.5C11 5.01472 13.0147 3 15.5 3C17.9853 3 20 5.01472 20 7.5Z');
    const chainIconPath = new Path2D(
        'M22.0545 5.94619C24.2785 8.17032 24.2785 11.7763 22.0545 14.0005L20.6067 15.4483C20.2943 15.7608 20.2943 16.2673 20.6067 16.5797L21.0862 17.0592C21.3986 17.3716 21.9051 17.3716 22.2175 17.0592L23.6653 15.6113C26.7789 12.4976 26.7789 7.44912 23.6653 4.33534C20.5517 1.22155 15.5035 1.22155 12.3898 4.33534L10.942 5.78321C10.6296 6.09563 10.6296 6.60218 10.942 6.91461L11.4215 7.39406C11.7339 7.70649 12.2404 7.70649 12.5528 7.39407L14.0006 5.94619C16.2246 3.72206 19.8305 3.72206 22.0545 5.94619Z M5.94601 22.0538C8.17004 24.278 11.7759 24.278 13.9999 22.0538L15.4477 20.606C15.7601 20.2935 16.2667 20.2935 16.5791 20.606L17.0585 21.0854C17.3709 21.3979 17.3709 21.9044 17.0585 22.2168L15.6107 23.6647C12.4971 26.7785 7.44886 26.7785 4.33523 23.6647C1.22159 20.5509 1.22159 15.5025 4.33523 12.3887L5.78303 10.9408C6.09544 10.6284 6.60197 10.6284 6.91438 10.9408L7.39382 11.4203C7.70623 11.7327 7.70623 12.2393 7.39382 12.5517L5.94601 13.9996C3.72198 16.2237 3.72198 19.8297 5.94601 22.0538Z M17.8593 9.80361C17.5078 9.45213 16.938 9.45213 16.5865 9.80361L9.80535 16.5851C9.45389 16.9366 9.45389 17.5064 9.80535 17.8579L10.1434 18.1959C10.4948 18.5474 11.0647 18.5474 11.4161 18.1959L18.1973 11.4145C18.5487 11.063 18.5487 10.4931 18.1973 10.1416L17.8593 9.80361Z',
    );
    // Eye icons for compact mode toggle
    const eyeIconPath = new Path2D('M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z');
    const eyeOffIconPath = new Path2D(
        'M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z',
    );
    // Jump-to-code icon (code brackets: </>)
    const jumpToCodeIconPath = new Path2D('M7.5 6L2.5 12L7.5 18M16.5 6L21.5 12L16.5 18M14 4L10 20');
    const priorityIconPath = new Path2D('M12 3L14.65 8.38L20.6 9.24L16.3 13.43L17.31 19.36L12 16.57L6.69 19.36L7.7 13.43L3.4 9.24L9.35 8.38L12 3Z');
    const colorDropIconPath = new Path2D('M419.1,337.45a3.94,3.94,0,0,0-6.1,0c-10.5,12.4-45,46.55-45,77.66,0,27,21.5,48.89,48,48.89h0c26.5,0,48-22,48-48.89C464,384,429.7,349.85,419.1,337.45Z');
    const colorBucketIconPath = new Path2D('M387,287.9,155.61,58.36a36,36,0,0,0-51,0l-5.15,5.15a36,36,0,0,0,0,51l52.89,52.89,57-57L56.33,263.2a28,28,0,0,0,.3,40l131.2,126a28.05,28.05,0,0,0,38.9-.1c37.8-36.6,118.3-114.5,126.7-122.9,5.8-5.8,18.2-7.1,28.7-7.1h.3A6.53,6.53,0,0,0,387,287.9Z');

    /// --- Helper: Draw note box for enum/composite/extras ---
    // --- 1. Draw triangle at point (px, py) ---
    function drawPointer(ctx, boxX, centerY, width = 10, height = 14) {
        ctx.save();
        ctx.beginPath();
        // Top edge of the box
        ctx.moveTo(boxX, centerY - height / 2);
        // Arrow tip pointing to the left (toward the table)
        ctx.lineTo(boxX - width + 2, centerY);
        // Bottom edge of the box
        ctx.lineTo(boxX, centerY + height / 2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    // --- 2. Draw multi-line tooltip box ---
    /**
     * Draw tooltip box for multiple lines with corner radius
     * @param ctx
     * @param {string[]} texts        array of text lines
     * @param {number} x              X coordinate of the left side of the box
     * @param {number} topY           Y coordinate of the top side of the box
     * @param {boolean} showPointer   whether to draw the pointer triangle
     * @param {object} opts
     *   - fillStyle, strokeStyle, textColor
     *   - radius: {
     *       tl: boolean,  // top-left
     *       tr: boolean,  // top-right
     *       br: boolean,  // bottom-right
     *       bl: boolean   // bottom-left
     *     }
     */
    function drawHoverNoteList(ctx, texts, x, topY, showPointer = true, opts = {}) {
        const FONT = '12px monospace';
        ctx.save();
        ctx.font = FONT;

        // Styles
        const fillStyle = opts.fillStyle || theme.tooltipBg;
        const strokeStyle = opts.strokeStyle || theme.tooltipStroke;
        const textColor = opts.textColor || theme.tooltipText;

        // Radius flags (default all corners rounded)
        const R = opts.cornerRadius ?? 3;
        const { tl = true, tr = true, br = true, bl = true } = opts.radius || {};

        // Build radius array for drawRoundRect: [tl, tr, br, bl]
        const radii = [tl ? R : 0, tr ? R : 0, br ? R : 0, bl ? R : 0];

        // Dimensions
        const PAD_X = 8;
        const boxH = ROW_H * texts.length;
        const widths = texts.map((t) => ctx.measureText(t.trim()).width);
        const boxW = Math.max(...widths) + PAD_X * 2;
        const boxX = x;
        const shiftY = showPointer ? 1 : 3;

        ctx.fillStyle = fillStyle;
        ctx.strokeStyle = strokeStyle;

        // Optional pointer
        if (showPointer) {
            ctx.lineWidth = 0.1;
            drawPointer(ctx, boxX, topY + ROW_H / 2);
        }

        // Draw rounded rectangle with per-corner radii
        ctx.lineWidth = 0.1;
        drawRoundRect(ctx, boxX, topY + shiftY, boxW, boxH, radii);
        ctx.fill();
        ctx.stroke();

        // Draw text lines
        ctx.fillStyle = textColor;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        texts.forEach((t, i) => {
            const lineY = topY + ROW_H * i + ROW_H / 2 + shiftY;
            ctx.fillText(t.trim(), boxX + PAD_X, lineY + 1); // +1 to align with 12px font
        });

        ctx.restore();
    }

    function getRelationFkName(rel) {
        if (!rel || typeof rel !== 'object') return null;
        const candidates = [rel.fkName, rel.constraintName, rel.foreignKeyName, rel.name];
        const value = candidates.find((item) => typeof item === 'string' && item.trim());
        return value ? value.trim() : null;
    }

    function getRelationActionParts(rel) {
        const actions = rel && typeof rel.actions === 'object' ? rel.actions : null;
        if (!actions || Array.isArray(actions)) return [];

        const parts = [];
        if (actions.onDelete) parts.push(`ON DELETE ${actions.onDelete}`);
        if (actions.onUpdate) parts.push(`ON UPDATE ${actions.onUpdate}`);
        if (actions.match) parts.push(`MATCH ${actions.match}`);
        if (typeof actions.deferrable === 'boolean') parts.push(actions.deferrable ? 'DEFERRABLE' : 'NOT DEFERRABLE');
        if (actions.initially) parts.push(`INITIALLY ${actions.initially}`);
        return parts;
    }

    function getConnectorTooltipAnchor(conn) {
        if (hoveredConnectorPoint && Number.isFinite(hoveredConnectorPoint.x) && Number.isFinite(hoveredConnectorPoint.y)) {
            return hoveredConnectorPoint;
        }
        if (!conn || !conn.points || conn.points.length === 0) return null;
        return conn.points[Math.floor(conn.points.length / 2)];
    }

    function getConnectorInspectorLines(rel, connector) {
        const lines = [`${rel.from.table}.${rel.from.column} -> ${rel.to.table}.${rel.to.column}`];
        if (rel.inferred === true) {
            const statusLabel = rel.inferenceStatus === 'accepted' ? 'Accepted diagram inference' : 'Suggested relationship';
            lines.push(statusLabel);
            if (Number.isFinite(rel.confidence)) {
                const level = typeof rel.confidenceLevel === 'string' ? ` (${rel.confidenceLevel})` : '';
                lines.push(`Confidence: ${Math.round(rel.confidence)}%${level}`);
            }
            if (Array.isArray(rel.reasons) && rel.reasons.length > 0) {
                lines.push(`Why: ${rel.reasons.join('; ')}`);
            }
        }
        if (rel.fromCard || rel.toCard) {
            lines.push(`Cardinality: ${rel.fromCard || '?'} -> ${rel.toCard || '?'}`);
        }
        const fkName = getRelationFkName(rel);
        if (fkName) {
            lines.push(`FK: ${fkName}`);
        }
        const actionParts = getRelationActionParts(rel);
        if (actionParts.length > 0) {
            lines.push(`Actions: ${actionParts.join(', ')}`);
        }
        if (connector?.fromSide && connector?.toSide) {
            const fromMode = connector.sideOverrides?.from ? connector.fromSide : `auto ${connector.fromSide}`;
            const toMode = connector.sideOverrides?.to ? connector.toSide : `auto ${connector.toSide}`;
            lines.push(`Endpoints: ${fromMode} → ${toMode} · click line to edit`);
        }
        return lines;
    }

    function getConnectorInspectorLayout(ctx, rel, connector, maxTextW, padX, padY, lineH) {
        const actionKey = JSON.stringify(rel.actions || {});
        const inferenceKey = rel.inferred === true ? `${rel.inferenceStatus || 'pending'}|${rel.confidence || ''}|${JSON.stringify(rel.reasons || [])}` : '';
        const sideKey = `${connector?.sideOverrides?.from || 'auto'}:${connector?.fromSide || ''}|${connector?.sideOverrides?.to || 'auto'}:${connector?.toSide || ''}`;
        const cacheKey = `${rel.from.table}.${rel.from.column}->${rel.to.table}.${rel.to.column}|${rel.fromCard || ''}|${rel.toCard || ''}|${getRelationFkName(rel) || ''}|${actionKey}|${inferenceKey}|${sideKey}|${Math.round(maxTextW)}`;
        if (connectorTooltipCache && connectorTooltipCache.key === cacheKey) {
            return connectorTooltipCache;
        }

        const lines = getConnectorInspectorLines(rel, connector);
        const wrappedLines = lines.flatMap((line, idx) => {
            ctx.font = idx === 0 ? '600 12px sans-serif' : '12px sans-serif';
            return wrapCanvasTextToWidth(ctx, line, maxTextW).map((text) => ({
                text,
                isPrimary: idx === 0,
            }));
        });
        const textW = Math.max(
            ...wrappedLines.map((line) => {
                ctx.font = line.isPrimary ? '600 12px sans-serif' : '12px sans-serif';
                return ctx.measureText(line.text).width;
            }),
            0,
        );

        connectorTooltipCache = {
            key: cacheKey,
            wrappedLines,
            boxW: Math.ceil(textW + padX * 2),
            boxH: Math.ceil(padY * 2 + wrappedLines.length * lineH),
        };
        return connectorTooltipCache;
    }

    function drawConnectorInspectorTooltip(ctx, conn, transform, targetCanvas) {
        if (!conn || !conn.relation || !conn.points || conn.points.length < 2) return;
        const anchor = getConnectorTooltipAnchor(conn);
        if (!anchor) return;

        const rel = conn.relation;

        ctx.save();
        ctx.font = '12px sans-serif';

        const padX = 9;
        const padY = 7;
        const lineH = 17;
        const zoom = Math.max(Number(transform.zoom) || 1, 0.001);
        const canvasW = Math.max(1, targetCanvas.width || canvas.width || 1);
        const canvasH = Math.max(1, targetCanvas.height || canvas.height || 1);
        const viewportLeft = (0 - transform.offsetX) / zoom;
        const viewportTop = (0 - transform.offsetY) / zoom;
        const viewportRight = (canvasW - transform.offsetX) / zoom;
        const viewportBottom = (canvasH - transform.offsetY) / zoom;
        const viewportW = viewportRight - viewportLeft;
        const viewportH = viewportBottom - viewportTop;
        const margin = 10 / zoom;
        const maxBoxW = Math.max(120, Math.min(380, viewportW - margin * 2));
        const maxTextW = Math.max(80, maxBoxW - padX * 2);
        const tooltipLayout = getConnectorInspectorLayout(ctx, rel, conn, maxTextW, padX, padY, lineH);
        const { wrappedLines } = tooltipLayout;
        const boxW = Math.min(maxBoxW, tooltipLayout.boxW);
        const boxH = tooltipLayout.boxH;

        let boxX = anchor.x + 14;
        let boxY = anchor.y + 14;
        if (boxX + boxW > viewportRight - margin) boxX = anchor.x - boxW - 14;
        if (boxY + boxH > viewportBottom - margin) boxY = anchor.y - boxH - 14;

        const minX = viewportLeft + margin;
        const maxX = viewportRight - boxW - margin;
        const minY = viewportTop + margin;
        const maxY = viewportBottom - boxH - margin;
        boxX = maxX >= minX ? Math.max(minX, Math.min(boxX, maxX)) : viewportLeft + Math.max(0, (viewportW - boxW) / 2);
        boxY = maxY >= minY ? Math.max(minY, Math.min(boxY, maxY)) : viewportTop + Math.max(0, (viewportH - boxH) / 2);

        ctx.fillStyle = darkMode ? 'rgba(15, 15, 15, 0.94)' : 'rgba(255, 255, 255, 0.96)';
        ctx.strokeStyle = darkMode ? 'rgba(255, 255, 255, 0.16)' : 'rgba(15, 23, 42, 0.16)';
        ctx.lineWidth = 1;
        drawRoundRect(ctx, boxX, boxY, boxW, boxH, 4);
        ctx.fill();
        ctx.stroke();

        wrappedLines.forEach((line, idx) => {
            ctx.font = line.isPrimary ? '600 12px sans-serif' : '12px sans-serif';
            ctx.fillStyle = idx === 0 ? theme.text : theme.tooltipText;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(line.text, boxX + padX, boxY + padY + lineH * idx + lineH / 2);
        });
        ctx.restore();
    }

    // --- Helper: draw a single constraint pill and return its width ---
    function drawConstraintPill(ctx, x, y, text, opts = {}) {
        const radius = 2;

        ctx.save();
        // TextMetrics ascent/descent are relative to the active baseline.
        // Set the drawing baseline before measuring so an inherited `middle`
        // baseline cannot shift and clip the glyph when we draw alphabetically.
        const textMetrics = measureConstraintPillText(ctx, text, opts.font || CONSTRAINT_PILL_FONT);
        const pillLayout = getConstraintPillLayout(textMetrics.width);
        const pillY = y - pillLayout.height / 2;
        const drawPillShape = () => drawRoundRect(ctx, x, pillY, pillLayout.width, pillLayout.height, radius);

        // background
        ctx.fillStyle = opts.bg || (selectedNode ? getPrimaryCanvasColor(contextManager.getTableColor(selectedNode.name) || theme.headerBg) : theme.headerBg);
        // if a lighter composite pill is desired, caller will pass a different opts.bg
        drawPillShape();
        ctx.fill();

        if (opts.overlayAlpha > 0) {
            ctx.save();
            ctx.globalAlpha = composeCanvasAlpha(ctx.globalAlpha, opts.overlayAlpha);
            ctx.fillStyle = opts.overlayColor;
            drawPillShape();
            ctx.fill();
            ctx.restore();
        }

        // light stroke to stand out
        ctx.lineWidth = 0.5;
        ctx.strokeStyle = darkMode ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.10)';
        drawPillShape();
        ctx.stroke();

        // text
        ctx.fillStyle = opts.color || '#ffffff';
        ctx.fillText(text, x + pillLayout.width / 2, getCenteredCanvasTextBaseline(y, textMetrics));
        ctx.restore();

        return pillLayout.width;
    }

    // --- Helper: Draw columns of a node ---
    function drawNodeColumns(ctx, tbl) {
        ctx.save();
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const visibleCols = getVisibleColumns(tbl);
        const configuredTableColor = contextManager.getTableColor(tbl.name) || theme.headerBg;
        const normalPillBackground = getPrimaryCanvasColor(resolveTableHeaderColor(configuredTableColor, theme.headerBg));
        const compositePillBackground = getCompositeConstraintPillColors(darkMode).background;
        const tableTextMode = contextManager.getTableHeaderTextMode(tbl.name);
        let normalPillAppearance = null;
        let compositePillAppearance = null;
        const getPillAppearance = (isComposite) => {
            if (isComposite) {
                if (!compositePillAppearance) {
                    compositePillAppearance = getTableConstraintPillAppearance(compositePillBackground, getConstraintPillTextMode(true, tableTextMode), theme.nodeFill);
                }
                return compositePillAppearance;
            }
            if (!normalPillAppearance) {
                normalPillAppearance = getTableConstraintPillAppearance(normalPillBackground, getConstraintPillTextMode(false, tableTextMode), theme.nodeFill);
            }
            return normalPillAppearance;
        };
        visibleCols.forEach((col, i) => {
            const y = tbl.y - tbl.height / 2 + NODE_H + (i + 0.5) * ROW_H;
            const isSelectedRelationField = isSelectedRelationshipField(tbl.name, col.name);
            // Highlight if hovering this row
            let highlightGray = false;
            // Only highlight gray if hovering this row AND it is a PK, FK, enum, or extras row
            if (hoveredRow.table === tbl.name && hoveredRow.rowIdx === i && (col.pk || col.fk || enumMap[col.type] || compositeMap[col.type] || (Array.isArray(col.extras) && col.extras.length > 0))) highlightGray = true;
            // If this is the highlighted connector end (hoveredConnectorIdxList)
            if (!highlightGray && hoveredConnectorIdxList.length > 0) {
                for (const idx of hoveredConnectorIdxList) {
                    const conn = connectorPaths[idx];
                    if (!conn || !conn.relation) continue;
                    if ((conn.relation.from.table === tbl.name && conn.relation.from.column === col.name) || (conn.relation.to.table === tbl.name && conn.relation.to.column === col.name)) {
                        highlightGray = true;
                        break;
                    }
                }
            }
            if (isSelectedRelationField) {
                ctx.save();
                ctx.fillStyle = getRelationshipFieldHighlightFill(tbl.name);
                ctx.fillRect(tbl.x - tbl.width / 2, y - ROW_H / 2, tbl.width, ROW_H);
                ctx.restore();
            }
            const hoverTreatment = getColumnHoverTreatment({
                isSelectedRelationField,
                isHoverHighlighted: highlightGray,
            });
            if (hoverTreatment.fillHover) {
                ctx.save();
                ctx.fillStyle = theme.highlightCol; // Highlight background color
                ctx.fillRect(tbl.x - tbl.width / 2, y - ROW_H / 2, tbl.width, ROW_H);
                ctx.restore();
            }
            if (isSelectedRelationField) {
                ctx.save();
                ctx.fillStyle = getTableSelectionAccentColor(contextManager.getTableColor(tbl.name) || theme.headerBg, darkMode);
                ctx.fillRect(tbl.x - tbl.width / 2, y - ROW_H / 2, 3, ROW_H);
                ctx.restore();
            }
            if (hoverTreatment.outlineHover) {
                const rowX = tbl.x - tbl.width / 2 + 1;
                const rowY = y - ROW_H / 2 + 1;
                const rowW = tbl.width - 2;
                const rowH = ROW_H - 2;
                const tableColor = contextManager.getTableColor(tbl.name) || theme.headerBg;
                ctx.save();
                ctx.strokeStyle = getTableRowHoverOutlineColor(tableColor, darkMode);
                ctx.lineWidth = 1.6;
                ctx.strokeRect(rowX, rowY, rowW, rowH);
                ctx.restore();
            }
            // Do NOT bold text on hover
            ctx.fillStyle = theme.text;
            ctx.font = '14px sans-serif';
            // Draw attribute name
            let name = col.name;
            ctx.fillText(name, tbl.x - tbl.width / 2 + PADDING_TABLE_LR, y);
            // Draw icon
            let iconX = tbl.x - tbl.width / 2 + PADDING_TABLE_LR + ctx.measureText(name).width + 6;
            let iconSize = 12;
            if (col.pk) {
                ctx.save();
                ctx.translate(iconX, y - iconSize / 2);
                ctx.scale(iconSize / 24, iconSize / 24);
                ctx.strokeStyle = theme.text;
                ctx.lineWidth = 1.5;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.stroke(keyIconPath);
                ctx.restore();
                iconX += iconSize + 2;
            }
            if (col.fk) {
                ctx.save();
                ctx.translate(iconX, y - iconSize / 2);
                ctx.scale(iconSize / 28, iconSize / 28);
                ctx.fillStyle = theme.text;
                ctx.fill(chainIconPath);
                ctx.restore();
                iconX += iconSize + 2;
            }
            // Calculate total width (type + constraint)
            ctx.textAlign = 'right';
            ctx.font = '14px sans-serif';
            let typeStr = col.type;
            let typeW = ctx.measureText(typeStr).width;
            let constraintW = 0;
            let constraintArr = [];
            if (col.constraints && Array.isArray(col.constraints) && col.constraints.length > 0) {
                ctx.font = CONSTRAINT_PILL_FONT;
                col.constraints.forEach((c) => {
                    const textWidth = ctx.measureText(c).width;
                    constraintArr.push({ text: c, pillWidth: getConstraintPillLayout(textWidth).width });
                });
                constraintW = 5 + constraintArr.reduce((width, constraint) => width + constraint.pillWidth, 0) + Math.max(0, constraintArr.length - 1) * 5;
                ctx.font = '14px sans-serif';
            }
            let totalW = typeW + constraintW;
            let baseX = tbl.x + tbl.width / 2 - PADDING_TABLE_LR - totalW;
            // Draw type
            ctx.font = '14px sans-serif';
            ctx.fillStyle = theme.typeText;
            ctx.textAlign = 'left';
            ctx.fillText(typeStr, baseX, y);

            // Draw constraint text (PK/UQ); composite pills are lighter
            let cx = baseX + typeW + 5;
            constraintArr.forEach(({ text }) => {
                const isComposite =
                    (col.compositePk && text === 'PK') ||
                    (col.compositeUq && text === 'UQ') ||
                    (col.compositePartialUq && text === 'PUQ') ||
                    (col.compositeIdx && text === 'IDX');

                const pillAppearance = getPillAppearance(isComposite);
                // drawConstraintPill returns the width already drawn
                const wPill = drawConstraintPill(ctx, cx, y, text, {
                    bg: pillAppearance.background,
                    color: pillAppearance.textColor,
                    overlayColor: pillAppearance.overlayColor,
                    overlayAlpha: pillAppearance.overlayAlpha,
                    font: CONSTRAINT_PILL_FONT,
                });
                cx += wPill + 5; // spacing between pills
            });

            ctx.font = '14px sans-serif';
            ctx.fillStyle = '#888';
            ctx.textAlign = 'left';
        });
        ctx.restore();
    }

    // ════════════════════════════════════════════════════════════════════
    //  SECTION 6 — Connector geometry (FK arrows + cardinality marks)
    // ════════════════════════════════════════════════════════════════════
    //  For each `schema.relations` entry we compute a poly-line path:
    //
    //     fromColumnRow ──┐
    //                     └─→  ┌─── (mid-x channel)
    //                          └─→  toColumnRow
    //
    //  The path leaves the source column row horizontally, jogs vertically
    //  in a "channel" between the two cards, then enters the target row
    //  horizontally. Channel x-position is chosen to minimise overlap with
    //  other cards (`OVERLAP_PAD`) and other connectors going the same way
    //  (`CONNECTOR_OFFSET` × index in the parallel-connector group).
    //
    //  Both endpoints are decorated with Crow's-Foot cardinality glyphs
    //  derived from `rel.fromCard` / `rel.toCard`:
    //    '1'    → single perpendicular tick
    //    'n'    → three-pronged crow's-foot
    //    '0..1' → tick + circle
    //    '0..n' → crow's-foot + circle
    //
    //  The flowing-dot animation overlay is drawn separately in section 9
    //  on top of the connector — the geometry computed here is shared.
    // ════════════════════════════════════════════════════════════════════
    // --- Helper: Calculate path points for a connector ---
    function getConnectorPoints(rel, schema, _groupCount, _groupIndex, _inCount, _inIndex) {
        const fromTbl = schema.tables.find((t) => t.name === rel.from.table);
        const toTbl = schema.tables.find((t) => t.name === rel.to.table);
        // If the table does not exist, do not draw connector
        if (!fromTbl || !toTbl) return { points: [], radius: 0 };
        // If the table does not have a position yet (x, y undefined), do not draw connector
        if (fromTbl.x === undefined || toTbl.x === undefined) return { points: [], radius: 0 };
        // Use visible columns to calculate the correct position
        const fromIdx = getVisibleColumns(fromTbl).findIndex((c) => c.name === rel.from.column);
        const toIdx = getVisibleColumns(toTbl).findIndex((c) => c.name === rel.to.column);
        // If column is not visible (compact mode), do not draw connector
        if (fromIdx === -1 || toIdx === -1) return { points: [], radius: 0 };
        const fromY = fromTbl.y - fromTbl.height / 2 + NODE_H + (fromIdx + 0.5) * ROW_H;
        const toY = toTbl.y - toTbl.height / 2 + NODE_H + (toIdx + 0.5) * ROW_H;
        const relationKey = getConnectorRelationKey(rel);
        const savedSides = contextManager.getConnectorEndpointSides(relationKey);
        const automaticSides = getAutomaticConnectorSides(fromTbl, toTbl, {
            sameColumn: rel.from.column === rel.to.column,
            overlapPadding: OVERLAP_PAD,
        });
        const fromSide = normalizeConnectorSide(savedSides.from) || automaticSides.from;
        const toSide = normalizeConnectorSide(savedSides.to) || automaticSides.to;
        const groupKey = `${fromTbl.name}:${fromSide}->${toTbl.name}:${toSide}`;
        const parallelIndex = _groupIndex[groupKey] || 0;
        _groupIndex[groupKey] = parallelIndex + 1;
        const route = calculateEditableConnectorRoute({
            fromTable: fromTbl,
            toTable: toTbl,
            fromY,
            toY,
            fromSide,
            toSide,
            connectorOffset: CONNECTOR_OFFSET,
            headClearance: CONNECTOR_HEAD_CLEARANCE,
            parallelIndex,
            radius: 5,
        });
        return {
            ...route,
            relationKey,
            fromSide,
            toSide,
            automaticSides,
            sideOverrides: savedSides,
        };
    }

    // --- Helper: Draw Crow's Foot Notation symbol at connector endpoint ---
    // Draws standard cardinality symbols at position (ex, ey) with direction dir (+1 right, -1 left)
    function drawCrowsFootSymbol(ctx, cardinality, ex, ey, dir, color, lw) {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(lw, 1.2);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const S = 7 * CONNECTOR_CARDINALITY_SCALE;
        const endpoint = (value) => value * CONNECTOR_CARDINALITY_SCALE;
        switch (cardinality) {
            case '1': {
                ctx.beginPath();
                ctx.moveTo(ex + dir * endpoint(6), ey - S);
                ctx.lineTo(ex + dir * endpoint(6), ey + S);
                ctx.moveTo(ex + dir * endpoint(10), ey - S);
                ctx.lineTo(ex + dir * endpoint(10), ey + S);
                ctx.stroke();
                break;
            }
            case 'n':
            case '1+': {
                ctx.beginPath();
                ctx.moveTo(ex + dir * endpoint(12), ey);
                ctx.lineTo(ex, ey - S);
                ctx.moveTo(ex + dir * endpoint(12), ey);
                ctx.lineTo(ex, ey + S);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(ex + dir * endpoint(15), ey - S);
                ctx.lineTo(ex + dir * endpoint(15), ey + S);
                ctx.stroke();
                break;
            }
            case '0..1': {
                ctx.beginPath();
                ctx.moveTo(ex + dir * endpoint(5), ey - S);
                ctx.lineTo(ex + dir * endpoint(5), ey + S);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(ex + dir * endpoint(12), ey, endpoint(4), 0, 2 * Math.PI);
                ctx.fillStyle = theme.background;
                ctx.fill();
                ctx.strokeStyle = color;
                ctx.stroke();
                break;
            }
            case '0..n': {
                ctx.beginPath();
                ctx.moveTo(ex + dir * endpoint(12), ey);
                ctx.lineTo(ex, ey - S);
                ctx.moveTo(ex + dir * endpoint(12), ey);
                ctx.lineTo(ex, ey + S);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(ex + dir * endpoint(17), ey, endpoint(4), 0, 2 * Math.PI);
                ctx.fillStyle = theme.background;
                ctx.fill();
                ctx.strokeStyle = color;
                ctx.stroke();
                break;
            }
        }
        ctx.restore();
    }

    function getPointBounds(points) {
        if (!Array.isArray(points) || points.length === 0) return null;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        points.forEach((point) => {
            if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
            minX = Math.min(minX, point.x);
            minY = Math.min(minY, point.y);
            maxX = Math.max(maxX, point.x);
            maxY = Math.max(maxY, point.y);
        });
        if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
            return null;
        }
        return { minX, minY, maxX, maxY };
    }

    // --- Helper: Build connectorPaths array from schema.relations ---
    function buildConnectorPaths(schema, inferred = []) {
        // Pre-filter to only well-formed relations. Validator should have
        // already dropped orphans, but the renderer is downstream of every
        // editor keystroke and must NOT throw on a transient malformed
        // schema. A single bad rel would otherwise blank the entire ERD.
        const explicitRelations = (schema.relations || []).filter(
            (rel) => rel && rel.from && rel.to && rel.from.table && rel.to.table,
        );
        const relationKey = (relation) => `${relation.from.table}.${relation.from.column}->${relation.to.table}.${relation.to.column}`.toLowerCase();
        const explicitKeys = new Set(explicitRelations.map(relationKey));
        const safeRelations = [
            ...explicitRelations,
            ...(Array.isArray(inferred) ? inferred : []).filter(
                (rel) => rel && rel.from && rel.to && rel.from.table && rel.to.table && !explicitKeys.has(relationKey(rel)),
            ),
        ];
        const groupCount = {};
        safeRelations.forEach((rel) => {
            const key = rel.from.table + '->' + rel.to.table;
            groupCount[key] = (groupCount[key] || 0) + 1;
        });
        const groupIndex = {};
        const inCount = {};
        safeRelations.forEach((rel) => {
            const toId = rel.to.table + '-' + rel.to.column;
            inCount[toId] = (inCount[toId] || 0) + 1;
        });
        const inIndex = {};
        return safeRelations.map((rel) => {
            const conn = getConnectorPoints(rel, schema, groupCount, groupIndex, inCount, inIndex);
            conn.relation = rel;
            conn.bounds = getPointBounds(conn.points);
            return conn;
        });
    }

    function getActiveConnectorIndex() {
        if (draggingConnectorEndpoint && connectorPaths[draggingConnectorEndpoint.connectorIndex]) return draggingConnectorEndpoint.connectorIndex;
        if (hoveredConnectorIdx !== null && connectorPaths[hoveredConnectorIdx]) return hoveredConnectorIdx;
        if (!selectedConnectorKey) return null;
        const selectedIndex = connectorPaths.findIndex((connector) => connector?.relationKey === selectedConnectorKey);
        return selectedIndex >= 0 ? selectedIndex : null;
    }

    function getConnectorEndpointDetails(connector, endpoint) {
        if (!connector?.relation || !Array.isArray(connector.points) || connector.points.length < 2) return null;
        const isFrom = endpoint === 'from';
        const tableName = isFrom ? connector.relation.from.table : connector.relation.to.table;
        const table = schema.tables.find((candidate) => candidate.name === tableName);
        if (!table) return null;
        return {
            endpoint: isFrom ? 'from' : 'to',
            table,
            point: isFrom ? connector.points[0] : connector.points.at(-1),
            side: isFrom ? connector.fromSide : connector.toSide,
        };
    }

    function getConnectorEndpointHit(x, y, { includeAll = false } = {}) {
        const indexes = includeAll ? connectorPaths.map((_connector, index) => index) : [getActiveConnectorIndex()].filter((index) => index !== null);
        const hitRadius = 13 / Math.max(contextManager.zoom, 0.001);
        let closest = null;
        indexes.forEach((connectorIndex) => {
            const connector = connectorPaths[connectorIndex];
            ['from', 'to'].forEach((endpoint) => {
                const details = getConnectorEndpointDetails(connector, endpoint);
                if (!details) return;
                const distance = Math.hypot(x - details.point.x, y - details.point.y);
                if (distance > hitRadius || (closest && closest.distance <= distance)) return;
                closest = { ...details, connector, connectorIndex, distance };
            });
        });
        return closest;
    }

    function getPointToSegmentDistance(point, start, end) {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lengthSquared = dx * dx + dy * dy;
        if (lengthSquared <= 0) return Math.hypot(point.x - start.x, point.y - start.y);
        const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
        return Math.hypot(point.x - (start.x + dx * ratio), point.y - (start.y + dy * ratio));
    }

    function findConnectorAtPoint(x, y, hitWidth = CONNECTOR_HOVER_HIT_WIDTH) {
        const threshold = hitWidth / Math.max(contextManager.zoom, 0.001) / 2;
        for (let connectorIndex = connectorPaths.length - 1; connectorIndex >= 0; connectorIndex -= 1) {
            const connector = connectorPaths[connectorIndex];
            if (!connector?.points || connector.points.length < 2) continue;
            const bounds = connector.bounds;
            if (bounds && (x < bounds.minX - threshold || x > bounds.maxX + threshold || y < bounds.minY - threshold || y > bounds.maxY + threshold)) continue;
            for (let pointIndex = 1; pointIndex < connector.points.length; pointIndex += 1) {
                if (getPointToSegmentDistance({ x, y }, connector.points[pointIndex - 1], connector.points[pointIndex]) <= threshold) return connectorIndex;
            }
        }
        return null;
    }

    function drawConnectorEndpointHandles(ctx, connector, zoom) {
        if (!connector) return;
        const safeZoom = Math.max(Number(zoom) || 1, 0.001);
        const radius = 6 / safeZoom;
        const strokeWidth = 2 / safeZoom;
        ['from', 'to'].forEach((endpoint) => {
            const details = getConnectorEndpointDetails(connector, endpoint);
            if (!details) return;
            const direction = details.side === 'left' ? -1 : 1;
            const isDragging = draggingConnectorEndpoint?.connectorIndex === getActiveConnectorIndex() && draggingConnectorEndpoint?.endpoint === endpoint;
            const isOverridden = Boolean(connector.sideOverrides?.[endpoint]);
            ctx.save();
            ctx.shadowColor = darkMode ? 'rgba(0, 0, 0, 0.72)' : 'rgba(15, 23, 42, 0.22)';
            ctx.shadowBlur = 5 / safeZoom;
            ctx.fillStyle = isDragging || isOverridden ? getPrimaryCanvasColor(contextManager.getTableColor(details.table.name) || theme.headerBg) : theme.background;
            ctx.strokeStyle = getPrimaryCanvasColor(contextManager.getTableColor(details.table.name) || theme.headerBg);
            ctx.lineWidth = strokeWidth;
            ctx.beginPath();
            ctx.arc(details.point.x, details.point.y, radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.shadowBlur = 0;
            ctx.strokeStyle = isDragging || isOverridden ? '#ffffff' : getPrimaryCanvasColor(contextManager.getTableColor(details.table.name) || theme.headerBg);
            ctx.lineWidth = 1.5 / safeZoom;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(details.point.x - direction * (2 / safeZoom), details.point.y - 2.3 / safeZoom);
            ctx.lineTo(details.point.x + direction * (1.4 / safeZoom), details.point.y);
            ctx.lineTo(details.point.x - direction * (2 / safeZoom), details.point.y + 2.3 / safeZoom);
            ctx.stroke();
            ctx.restore();
        });
    }

    // Helper: Draw rounded corner
    function drawRoundedElbowPath(ctx, points, radius) {
        if (points.length < 2) return;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            const prev = points[i - 1];
            const curr = points[i];
            const next = points[i + 1];
            if (!next) {
                ctx.lineTo(curr.x, curr.y);
                continue;
            }
            const v1x = curr.x - prev.x;
            const v1y = curr.y - prev.y;
            const v1len = Math.hypot(v1x, v1y);
            const v2x = curr.x - next.x;
            const v2y = curr.y - next.y;
            const v2len = Math.hypot(v2x, v2y);
            const r = Math.min(radius, v1len / 2, v2len / 2);
            const p1x = curr.x - (v1x / v1len) * r;
            const p1y = curr.y - (v1y / v1len) * r;
            const p2x = curr.x - (v2x / v2len) * r;
            const p2y = curr.y - (v2y / v2len) * r;
            ctx.lineTo(p1x, p1y);
            ctx.arcTo(curr.x, curr.y, p2x, p2y, r);
        }
        ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    }

    // --- Helper: Draw connector line with the computed path ---
    function renderConnector(ctx, conn, isFullConnect, isDrawCardinality, defaultColor, defaultWidth, flowing = false) {
        // Skip if no points to render
        if (!conn || !conn.points || conn.points.length < 2) return;

        // 1) strokeStyle & lineWidth
        let strokeStyle, lineWidth;
        const isInferred = conn.relation?.inferred === true;
        const isAcceptedInference = conn.relation?.inferenceStatus === 'accepted';
        const inferenceVisual = getInferredRelationVisual(conn.relation, darkMode);
        const useFlowing = flowing && !isInferred;
        const p0 = conn.points[0];
        const pN = conn.points[conn.points.length - 1];
        const haveGradient = p0 && pN && [p0.x, p0.y, pN.x, pN.y].every(Number.isFinite);

        if (isInferred) {
            strokeStyle = inferenceVisual.stroke;
            lineWidth = defaultWidth * (isAcceptedInference ? 1.45 : 1.25);
        } else if (isFullConnect || useFlowing) {
            if (haveGradient) {
                const rawC0 = contextManager.getTableColor(conn.relation.from.table);
                const rawC1 = contextManager.getTableColor(conn.relation.to.table);
                const c0 = typeof rawC0 === 'string' && rawC0.trim() ? rawC0 : theme.headerBg;
                const c1 = typeof rawC1 === 'string' && rawC1.trim() ? rawC1 : theme.headerBg;
                const visibleC0 = getConnectorGradientColor(c0);
                const visibleC1 = getConnectorGradientColor(c1);
                const grad = ctx.createLinearGradient(p0.x, p0.y, pN.x, pN.y);
                grad.addColorStop(0, visibleC0);
                grad.addColorStop(1, visibleC1);
                strokeStyle = grad;
            } else {
                strokeStyle = defaultColor;
            }
            // Flowing connectors get slightly bolder lines so the selected
            // table's relationships stand out from unrelated ones.
            lineWidth = useFlowing ? defaultWidth * 2 : defaultWidth * 1.5;
        } else {
            strokeStyle = defaultColor;
            lineWidth = defaultWidth;
        }

        // 2) Draw base path
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (!isInferred && (isFullConnect || useFlowing)) {
            ctx.strokeStyle = darkMode ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
            ctx.lineWidth = lineWidth + (useFlowing ? 1.2 : 0.9);
            ctx.beginPath();
            drawRoundedElbowPath(ctx, conn.points, conn.radius);
            ctx.stroke();
        }
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = lineWidth;
        if (isInferred) ctx.setLineDash(inferenceVisual.dash);
        ctx.beginPath();
        drawRoundedElbowPath(ctx, conn.points, conn.radius);
        ctx.stroke();
        if (isInferred) ctx.setLineDash([]);

        // 2b) Flowing overlay — a short bright dash animated along the path
        // produces a "river flowing" feel without shadows or extra geometry.
        // Two cheap strokes per connector keep this well within budget even
        // with dozens of relations visible at once.
        if (useFlowing) {
            // Fewer, more graceful "droplets": short bright dash + long dark
            // gap so the eye reads one travelling light segment per connector,
            // not a busy marching-ants strip.
            const dashLen = Math.max(4, lineWidth * 2);
            const gapLen = Math.max(42, lineWidth * 18);
            const period = dashLen + gapLen;
            ctx.beginPath();
            drawRoundedElbowPath(ctx, conn.points, conn.radius);
            ctx.setLineDash([dashLen, gapLen]);
            // Positive offset makes the dashes travel from source → target.
            ctx.lineDashOffset = -((flowOffset % period) + period) % period;
            ctx.lineWidth = Math.max(1, lineWidth * 0.55);
            ctx.strokeStyle = darkMode ? 'rgba(255,255,255,1)' : 'rgba(255,255,255,0.9)';
            ctx.globalCompositeOperation = 'source-over';
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // 3) Draw Crow's Foot cardinality symbols at connector endpoints
        if (conn.relation.fromCard || conn.relation.toCard) {
            const pts = conn.points;
            if (conn.relation.fromCard && pts.length >= 2) {
                const dirFrom = Math.sign(pts[1].x - pts[0].x);
                if (dirFrom !== 0) drawCrowsFootSymbol(ctx, conn.relation.fromCard, pts[0].x, pts[0].y, dirFrom, strokeStyle, lineWidth);
            }
            if (conn.relation.toCard && pts.length >= 2) {
                const dirTo = Math.sign(pts[pts.length - 2].x - pts[pts.length - 1].x);
                if (dirTo !== 0) drawCrowsFootSymbol(ctx, conn.relation.toCard, pts[pts.length - 1].x, pts[pts.length - 1].y, dirTo, strokeStyle, lineWidth);
            }
        }

        ctx.restore();
    }

    function getPolylineMidpoint(points) {
        if (!Array.isArray(points) || points.length < 2) return null;
        const segments = [];
        let totalLength = 0;
        for (let index = 1; index < points.length; index += 1) {
            const start = points[index - 1];
            const end = points[index];
            const length = Math.hypot(end.x - start.x, end.y - start.y);
            if (!Number.isFinite(length) || length <= 0) continue;
            segments.push({ start, end, length });
            totalLength += length;
        }
        if (segments.length === 0 || totalLength <= 0) return null;

        const target = totalLength / 2;
        let walked = 0;
        for (const segment of segments) {
            if (walked + segment.length >= target) {
                const ratio = (target - walked) / segment.length;
                return {
                    x: segment.start.x + (segment.end.x - segment.start.x) * ratio,
                    y: segment.start.y + (segment.end.y - segment.start.y) * ratio,
                };
            }
            walked += segment.length;
        }
        return segments.at(-1).end;
    }

    function drawInferenceConfidencePill(ctx, conn) {
        const relation = conn?.relation;
        if (relation?.inferred !== true || !Number.isFinite(relation.confidence)) return;
        const midpoint = getPolylineMidpoint(conn.points);
        if (!midpoint) return;

        const visual = getInferredRelationVisual(relation, darkMode);
        const label = `${Math.round(relation.confidence)}%`;
        const height = 18;
        const padX = 6;

        ctx.save();
        ctx.font = '700 11px sans-serif';
        const width = Math.ceil(ctx.measureText(label).width + padX * 2);
        const x = midpoint.x - width / 2;
        const y = midpoint.y - height / 2;
        ctx.fillStyle = visual.badgeFill;
        ctx.strokeStyle = darkMode ? 'rgba(15, 23, 42, 0.9)' : 'rgba(255, 255, 255, 0.96)';
        ctx.lineWidth = 2;
        drawRoundRect(ctx, x, y, width, height, 9);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, midpoint.x, midpoint.y + 0.5);
        ctx.restore();
    }

    // ════════════════════════════════════════════════════════════════════
    //  SECTION 7 — Canvas sizing + transform matrix (DPR-aware)
    // ════════════════════════════════════════════════════════════════════
    //  Keeps three sizes in sync:
    //    1. CSS size       : `canvas.style.{width, height}` — what the user
    //                        sees in layout.
    //    2. Backing-store  : `canvas.{width, height}` = CSS × DPR — the
    //                        resolution we actually rasterise to.
    //    3. Context scale  : `ctx.scale(DPR, DPR)` — applied once per
    //                        resize so the rest of the code can ignore DPR.
    //
    //  Zoom / pan are stored in `contextManager.zoom`, `offsetX`, `offsetY`
    //  (world-coordinate units). The world→screen transform for a point
    //  `(wx, wy)` is:
    //                screenX = (wx + offsetX) * zoom
    //                screenY = (wy + offsetY) * zoom
    //
    //  Wheel events drive zoom; click+drag on empty canvas drives pan;
    //  click+drag on a table card drives table reposition (section 10).
    // ════════════════════════════════════════════════════════════════════
    // Function to resize canvas when window size changes
    function resizeCanvas() {
        const dpr = window.devicePixelRatio || 1;
        const container = document.getElementById('erd-container');
        const w = container.clientWidth;
        const h = container.clientHeight;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
    }
    resizeCanvas();

    // Cleanup old event listeners before adding new ones
    const handleResize = () => {
        resizeCanvas();
        if (colorPopup && colorPopup.style.display === 'flex') {
            updateColorPopupLayout();
            const colorTarget = getColorPopupTargetNode();
            if (colorPopupAnchorSource === 'table-header' && colorTarget) positionColorPopupAtTable(getHeaderIconLayout(colorTarget).color);
            else positionColorPopupAtButton();
        }
        if (autoColorPopup && autoColorPopup.style.display === 'flex') updateAutoColorPopupLayout();
        if (layoutPopup && layoutPopup.style.display === 'block') positionToolbarPopup(layoutPopup, layoutModeBtn);
        if (tableNavPopup && tableNavPopup.style.display === 'block') positionToolbarPopup(tableNavPopup, tableNavBtn);
        // If no zoom/pan context exists, fit to screen; otherwise just redraw
        const hasZoomContext =
            contextManager && typeof contextManager.zoom === 'number' && typeof contextManager.offsetX === 'number' && typeof contextManager.offsetY === 'number' && !isNaN(contextManager.zoom) && !isNaN(contextManager.offsetX) && !isNaN(contextManager.offsetY);
        if (!hasZoomContext) {
            fitToScreen();
        } else {
            clampCurrentZoomToLimits();
        }
        scheduleDraw();
    };

    const handleForceFit = () => {
        resizeCanvas();
        fitToScreen();
        scheduleDraw();
    };

    // Remove old listeners if exist (cleanup from previous runErdScript calls)
    if (window._erdResizeHandler) {
        window.removeEventListener('resize', window._erdResizeHandler);
    }
    if (window._erdForceFitHandler) {
        window.removeEventListener('erd-force-fit', window._erdForceFitHandler);
    }
    // Tear down the previous run's document-level "click outside dismisses
    // popup" handler. Set up by SECTION 11 (Toolbar), referenced here so
    // the cleanup happens BEFORE we begin building the new render's state.
    if (window._erdDocMouseDownHandler) {
        document.removeEventListener('mousedown', window._erdDocMouseDownHandler);
        window._erdDocMouseDownHandler = null;
    }

    // Signal the previous run's animation loop to exit so it stops painting
    // into a detached canvas and releases its offscreen cache buffers. Each
    // run holds its own `disposed` closure, flipped by the next run's setter
    // on `window._erdStopPrev`.
    if (typeof window._erdStopPrev === 'function') {
        try {
            window._erdStopPrev();
        } catch {
            /* old run already gone */
        }
    }
    let disposed = false;
    window._erdStopPrev = () => {
        disposed = true;
    };

    // Store handlers for cleanup
    window._erdResizeHandler = handleResize;
    window._erdForceFitHandler = handleForceFit;

    // Add new listeners
    window.addEventListener('resize', handleResize);
    window.addEventListener('erd-force-fit', handleForceFit);

    // ════════════════════════════════════════════════════════════════════
    //  SECTION 8 — Fit-to-screen (auto-zoom + auto-pan to bounding box)
    // ════════════════════════════════════════════════════════════════════
    //  Computes the world-space bounding box of every visible table, then
    //  sets `zoom` and `(offsetX, offsetY)` so the box fills the canvas
    //  with a small margin. `maxFitZoom` (option) caps the upper bound so
    //  small ERDs don't end up pixelated when zoomed all the way in.
    //
    //  Triggered by:
    //    • Toolbar "Fit to screen" button (section 11).
    //    • The custom `'erd-force-fit'` window event (used by parent code
    //      after schema swaps so the new diagram doesn't sit off-screen).
    // ════════════════════════════════════════════════════════════════════

    // Zoom variables: minZoom, maxZoom. The lower bound is schema-aware and
    // must be recalculated even when zoom/pan is restored from context;
    // otherwise large diagrams can get stuck at the old default clamp.
    let minZoom = 0.0001,
        maxZoom = 5;

    function getViewportFit() {
        syncTableHeights();
        return calculateErdViewportFit({
            tables: schema.tables,
            viewportWidth: canvas.width,
            viewportHeight: canvas.height,
            maxFitZoom,
        });
    }

    function refreshZoomLimits() {
        const fit = getViewportFit();
        if (!fit) return null;
        minZoom = fit.minZoom;
        maxZoom = fit.maxZoom;
        return { minZoom, maxZoom };
    }

    function clampCurrentZoomToLimits() {
        if (!refreshZoomLimits()) return;
        const clampedZoom = clampErdZoom(contextManager.zoom, { minZoom, maxZoom });
        if (!clampedZoom || Math.abs(clampedZoom - contextManager.zoom) < 0.000001) return;

        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;
        const worldX = (centerX - contextManager.offsetX) / contextManager.zoom;
        const worldY = (centerY - contextManager.offsetY) / contextManager.zoom;
        const update = getAnchoredZoomUpdate({
            anchorX: centerX,
            anchorY: centerY,
            worldX,
            worldY,
            zoom: clampedZoom,
        });
        if (update) {
            contextManager.batchUpdate(update);
        }
    }

    function fitToScreen() {
        const fit = getViewportFit();

        if (!fit) {
            console.warn('fitToScreen: No valid tables or viewport size');
            return;
        }

        minZoom = fit.minZoom;
        maxZoom = fit.maxZoom;

        contextManager.batchUpdate({
            zoom: fit.zoom,
            offsetX: fit.offsetX,
            offsetY: fit.offsetY,
        });
    }

    function syncTableHeights() {
        schema.tables.forEach((tbl) => {
            const visibleCount = getVisibleColumns(tbl).length;
            tbl.height = NODE_H + visibleCount * ROW_H;
        });
    }

    // ════════════════════════════════════════════════════════════════════
    //  SECTION 9 — Main draw loop (layered z-order, single rAF)
    // ════════════════════════════════════════════════════════════════════
    //  `draw(options)` paints exactly one frame. It is request-animation-
    //  frame coalesced via `scheduleDraw()` — never call `draw()` directly
    //  unless you're rendering off-screen (e.g. PNG export).
    //
    //  Z-order, bottom to top:
    //    1.   Normal connectors                (faded if a table is selected)
    //    1.5  Hovered-row connectors           (highlighted color)
    //    2.   Selected-table connectors        (full opacity, on top of 1)
    //    --- flowing-dot overlay (drawn between 2 and 3 every frame) ---
    //    3.   Hovered connector                (top among connectors)
    //    4.   Tables                           (cards on top of all wires)
    //    5.   Hovered-row tooltip / enum tip   (single popup over everything)
    //
    //  `layer` parameter:
    //    'full'  — render all bands (default; PNG export uses this)
    //    'below' — bands 1 + 1.5 only       (cached as a static bitmap)
    //    'above' — bands 3 + 4 + 5 only     (cached as a static bitmap)
    //  Splitting the work lets the per-frame flowing-dot animation just
    //  blit the two cached bitmaps and draw the moving dots on top — no
    //  full-scene re-rasterisation per frame.
    // ════════════════════════════════════════════════════════════════════
    function draw(options = {}) {
        // `layer` decides which z-bands get rendered:
        //   'full'   — everything (default; also used by PNG export)
        //   'below'  — background + normal / hover-row connectors (z1, z1.5)
        //   'above'  — hovered connector + tables + tooltip (z3–z5)
        // Splitting lets us cache the parts under and over the flowing layer
        // separately, so per-frame flowing animation only blits two bitmaps.
        const { targetCtx = baseCtx, targetCanvas = baseCanvas, zoom = contextManager.zoom, offsetX = contextManager.offsetX, offsetY = contextManager.offsetY, background = theme.background, skipFlowingConnectors = false, showConnectorEditor = true, layer = 'full' } = options;
        const drawCtx = targetCtx;
        const drawCanvas = targetCanvas;
        const wantBelow = layer === 'full' || layer === 'below';
        const wantFlow = layer === 'full' && !skipFlowingConnectors;
        const wantAbove = layer === 'full' || layer === 'above';

        // Recalculate height of each table based on visible columns
        syncTableHeights();

        // 1) reset transform to default
        drawCtx.setTransform(1, 0, 0, 1, 0, 0);
        // 2) clear canvas
        drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
        // 3) fill background — only the 'below' / 'full' pass paints the
        //    background. 'above' is kept transparent so it composites over
        //    whatever sits underneath it on the main canvas.
        if (wantBelow) {
            drawCtx.fillStyle = background;
            drawCtx.fillRect(0, 0, drawCanvas.width, drawCanvas.height);
        }
        // 4) transform to world coordinates
        drawCtx.setTransform(zoom, 0, 0, zoom, offsetX, offsetY);

        connectorPaths = buildConnectorPaths(schema, safeInferredRelations);
        selectedRelationshipFieldKeys = getSelectedRelationshipFieldKeys(connectorPaths, selectedNode?.name);
        priorityLayerState = getPriorityLayerState(connectorPaths, contextManager.priorityTableNames);

        if (wantBelow) {
            // ====== Z-INDEX: 1. DRAW NORMAL CONNECTORS OR FULL CONNECT ======
            connectorPaths.forEach((conn, i) => {
                if (!conn || !conn.relation || !conn.points || conn.points.length < 2) return;
                // if not fullConnect and this connector is highlighted, defer drawing
                if (!fullConnect && ((selectedNode && (conn.relation.from.table === selectedNode.name || conn.relation.to.table === selectedNode.name)) || hoveredConnectorIdx === i || hoveredConnectorIdxList.includes(i))) {
                    return;
                }
                drawWithAlpha(drawCtx, getPriorityConnectorAlpha(i), () => {
                    renderConnector(drawCtx, conn, fullConnect, fullConnect, theme.connector, CONNECTOR_LINE_WIDTH);
                });
            });

            // ====== Z-INDEX: 1.5. DRAW HOVERED ROW CONNECTORS (highlighted color) ======
            if (hoveredConnectorIdxList && hoveredConnectorIdxList.length > 0) {
                hoveredConnectorIdxList.forEach((idx) => {
                    const conn = connectorPaths[idx];
                    if (!conn || !conn.relation || !conn.points || conn.points.length < 2) return;
                    drawWithAlpha(drawCtx, getPriorityConnectorAlpha(idx), () => {
                        renderConnector(drawCtx, conn, true, true, theme.connector, HOVERED_CONNECTOR_WIDTH);
                    });
                });
            }
        }

        if (wantFlow) {
            // ====== Z-INDEX: 2. DRAW CONNECTORS RELATED TO SELECTED NODE (middle layer) ======
            // Hovered siblings stay in this layer so they keep the flowing
            // animation; they're drawn last so they paint on top of the other
            // siblings for a clear hover emphasis.
            if (selectedNode) {
                const hoveredSiblingIdx = isHoveredSelectedSibling() ? hoveredConnectorIdx : -1;
                connectorPaths.forEach((conn, i) => {
                    if (!conn || !conn.relation || !conn.points || conn.points.length < 2) return;
                    if (i === hoveredSiblingIdx) return;
                    if (conn.relation.from.table === selectedNode.name || conn.relation.to.table === selectedNode.name) {
                        drawWithAlpha(drawCtx, getPriorityConnectorAlpha(i), () => {
                            renderConnector(drawCtx, conn, true, true, theme.connector, SELECTED_CONNECTOR_WIDTH, /* flowing */ true);
                        });
                    }
                });
                if (hoveredSiblingIdx >= 0) {
                    const conn = connectorPaths[hoveredSiblingIdx];
                    if (conn && conn.relation && conn.points && conn.points.length >= 2) {
                        drawWithAlpha(drawCtx, getPriorityConnectorAlpha(hoveredSiblingIdx), () => {
                            renderConnector(drawCtx, conn, true, true, theme.connector, SELECTED_HOVERED_CONNECTOR_WIDTH, /* flowing */ true);
                        });
                    }
                }
            }
        }

        if (!wantAbove) return;

        // ====== Z-INDEX: 3. DRAW HOVERED CONNECTOR (highest among connectors) ======
        // When the hovered connector already flows (i.e. it belongs to the
        // selected table) it's drawn in the flowing layer above, so skip it
        // here to avoid double-stroking which would dull the gradient.
        if (hoveredConnectorIdx !== null && connectorPaths[hoveredConnectorIdx] && !isHoveredSelectedSibling()) {
            try {
                const conn = connectorPaths[hoveredConnectorIdx];
                if (conn && conn.relation && conn.points && conn.points.length >= 2) {
                    drawWithAlpha(drawCtx, getPriorityConnectorAlpha(hoveredConnectorIdx), () => {
                        renderConnector(drawCtx, conn, true, true, theme.connector, HOVERED_CONNECTOR_WIDTH);
                    });
                }
            } catch {
                // Silently ignore render errors for hover state
            }
        }

        // ====== Z-INDEX: 3.5. DRAW INFERENCE CONFIDENCE SCORES ======
        // Scores sit above their dashed connector but below table cards, so a
        // label can never obscure a column when an edge passes behind a table.
        connectorPaths.forEach((conn, index) => {
            if (conn?.relation?.inferred !== true || !conn.points || conn.points.length < 2) return;
            drawWithAlpha(drawCtx, getPriorityConnectorAlpha(index), () => drawInferenceConfidencePill(drawCtx, conn));
        });

        // ====== Z-INDEX: 4. DRAW TABLES (top layer) ======
        schema.tables.forEach((tbl) => {
            const borderTableRadius = 4;
            drawWithAlpha(drawCtx, getPriorityTableAlpha(tbl.name), () => {
                drawNodeBox(drawCtx, tbl, borderTableRadius);
                drawNodeTitle(drawCtx, tbl, borderTableRadius);
                drawNodeColumns(drawCtx, tbl);
            });
        });

        // Handles paint above table edges so the attachment point remains
        // visible and draggable even when the connector itself is underneath.
        if (showConnectorEditor) {
            const activeConnectorIndex = getActiveConnectorIndex();
            if (activeConnectorIndex !== null) drawConnectorEndpointHandles(drawCtx, connectorPaths[activeConnectorIndex], zoom);
        }

        // ====== Z-INDEX: 4.5. DRAW HOVERED CONNECTOR INSPECTOR ======
        // Canvas-only tooltip: no DOM nodes, no observers, and drawn in the
        // current world transform so it scales with tables during zoom.
        if (hoveredConnectorIdx !== null && connectorPaths[hoveredConnectorIdx]) {
            drawConnectorInspectorTooltip(
                drawCtx,
                connectorPaths[hoveredConnectorIdx],
                { zoom, offsetX, offsetY },
                drawCanvas,
            );
        }

        // ====== Z-INDEX: 5. DRAW HOVERED ROW tooltip (if any) ======
        if (hoveredRow.table !== null) {
            const tbl = schema.tables.find((t) => t.name === hoveredRow.table);
            if (!tbl) return;
            const visibleCols = getVisibleColumns(tbl);
            const col = visibleCols[hoveredRow.rowIdx];
            if (!col) return;
            const isEnum = !!enumMap[col.type];
            const isComp = !!compositeMap[col.type];
            const hasExtras = Array.isArray(col.extras) && col.extras.length > 0;

            // ==== ENUM / COMPOSITE / EXTRAS TOOLTIP ====
            const rowY = tbl.y - tbl.height / 2 + NODE_H + (hoveredRow.rowIdx + 0.5) * ROW_H;
            const rowTopY = rowY - ROW_H / 2;
            const noteX = tbl.x + tbl.width / 2 + 10;

            const noteColor = getPrimaryCanvasColor(contextManager.getTableColor(tbl.name) || theme.headerBg);

            // 1) Enum always has a pointer, drawn at rowTopY
            if (isEnum) {
                drawHoverNoteList(drawCtx, enumMap[col.type], noteX, rowTopY, true, {
                    fillStyle: noteColor,
                    strokeStyle: noteColor,
                    textColor: '#ffffffff',
                    cornerRadius: 3,
                    radius: { tl: true, tr: true, br: true, bl: !hasExtras },
                });
            }

            // 2) Composite also always has a pointer
            if (isComp) {
                const lines = compositeMap[col.type].map((f) => `${f.name}: ${f.type}`);
                drawHoverNoteList(drawCtx, lines, noteX, rowTopY, true, {
                    fillStyle: noteColor,
                    strokeStyle: noteColor,
                    textColor: '#efefefff',
                    cornerRadius: 3,
                    radius: { tl: true, tr: true, br: true, bl: !hasExtras },
                });
            }

            // 3) Extras: if enum or composite exists, draw below; no pointer
            if (hasExtras) {
                const enumLines = isEnum ? enumMap[col.type].length : 0;
                const compLines = isComp ? compositeMap[col.type].length : 0;
                const extrasTopY = rowTopY + (enumLines + compLines) * ROW_H;
                const hasPointer = !isEnum && !isComp;
                drawHoverNoteList(drawCtx, col.extras, noteX, extrasTopY, hasPointer, {
                    fillStyle: noteColor,
                    strokeStyle: noteColor,
                    textColor: '#efefefff',
                    cornerRadius: 3,
                    radius: { tl: hasPointer, tr: true, br: true, bl: true },
                });
            }
        }
    }

    // ════════════════════════════════════════════════════════════════════
    //  SECTION 9B — Interactive minimap
    // ════════════════════════════════════════════════════════════════════
    //  The overview intentionally draws simplified geometry. Reusing the
    //  full renderer here would duplicate text measurement, shadows, and
    //  connector decoration for a view where those pixels cannot be read.
    //  Both canvases still share the exact world transform, so the viewport
    //  rectangle and click/drag navigation remain mathematically precise.
    // ════════════════════════════════════════════════════════════════════

    function resizeMinimapCanvas() {
        if (!minimapCanvas || !minimapCtx || !minimapVisible) return false;
        const rect = minimapCanvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const dpr = window.devicePixelRatio || 1;
        const nextWidth = Math.max(1, Math.round(rect.width * dpr));
        const nextHeight = Math.max(1, Math.round(rect.height * dpr));
        if (minimapCanvas.width !== nextWidth || minimapCanvas.height !== nextHeight) {
            minimapCanvas.width = nextWidth;
            minimapCanvas.height = nextHeight;
        }
        return true;
    }

    function drawMinimapRoundedRect(drawCtx, x, y, width, height, radius) {
        const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
        drawCtx.beginPath();
        if (typeof drawCtx.roundRect === 'function') {
            drawCtx.roundRect(x, y, width, height, safeRadius);
        } else {
            drawCtx.rect(x, y, width, height);
        }
    }

    function renderMinimap() {
        if (!minimapVisible || !resizeMinimapCanvas()) return;

        const width = minimapCanvas.width;
        const height = minimapCanvas.height;
        const dpr = window.devicePixelRatio || 1;
        minimapCtx.setTransform(1, 0, 0, 1, 0, 0);
        minimapCtx.clearRect(0, 0, width, height);
        minimapCtx.fillStyle = darkMode ? '#20242b' : '#f8fafc';
        minimapCtx.fillRect(0, 0, width, height);

        syncTableHeights();
        const viewport = getErdViewportWorldRect({
            zoom: contextManager.zoom,
            offsetX: contextManager.offsetX,
            offsetY: contextManager.offsetY,
            viewportWidth: canvas.width,
            viewportHeight: canvas.height,
        });
        minimapModel = calculateErdMinimapModel({
            tables: schema.tables,
            viewport,
            width,
            height,
            padding: 11 * dpr,
        });

        if (!minimapModel) {
            minimapCtx.fillStyle = darkMode ? 'rgba(226,232,240,0.58)' : 'rgba(71,85,105,0.68)';
            minimapCtx.font = `${10 * dpr}px Arial, sans-serif`;
            minimapCtx.textAlign = 'center';
            minimapCtx.textBaseline = 'middle';
            minimapCtx.fillText('No tables yet', width / 2, height / 2);
            return;
        }

        // Subtle dot field gives movement enough visual reference without
        // competing with the table silhouettes.
        minimapCtx.fillStyle = darkMode ? 'rgba(148,163,184,0.13)' : 'rgba(100,116,139,0.13)';
        const dotStep = 14 * dpr;
        for (let y = dotStep / 2; y < height; y += dotStep) {
            for (let x = dotStep / 2; x < width; x += dotStep) {
                minimapCtx.beginPath();
                minimapCtx.arc(x, y, Math.max(0.7, dpr * 0.55), 0, Math.PI * 2);
                minimapCtx.fill();
            }
        }

        const tableRectByName = new Map(minimapModel.tableRects.map((rect) => [rect.name, rect]));
        minimapCtx.lineWidth = Math.max(1, dpr * 0.8);
        minimapCtx.strokeStyle = darkMode ? 'rgba(148,163,184,0.38)' : 'rgba(71,85,105,0.3)';
        (schema.relations || []).forEach((relation) => {
            const from = tableRectByName.get(relation?.from?.table);
            const to = tableRectByName.get(relation?.to?.table);
            if (!from || !to) return;
            minimapCtx.beginPath();
            minimapCtx.moveTo(from.x + from.width / 2, from.y + from.height / 2);
            minimapCtx.lineTo(to.x + to.width / 2, to.y + to.height / 2);
            minimapCtx.stroke();
        });

        minimapModel.tableRects.forEach((rect) => {
            const drawWidth = Math.max(4 * dpr, rect.width);
            const drawHeight = Math.max(3 * dpr, rect.height);
            const drawX = rect.x + (rect.width - drawWidth) / 2;
            const drawY = rect.y + (rect.height - drawHeight) / 2;
            const tableColor = getPrimaryCanvasColor(contextManager.getTableColor(rect.name) || theme.headerBg);
            drawMinimapRoundedRect(minimapCtx, drawX, drawY, drawWidth, drawHeight, 1.8 * dpr);
            minimapCtx.fillStyle = tableColor;
            minimapCtx.globalAlpha = selectedNode?.name === rect.name ? 1 : 0.82;
            minimapCtx.fill();
            minimapCtx.globalAlpha = 1;
            if (selectedNode?.name === rect.name) {
                minimapCtx.lineWidth = Math.max(1.5, dpr * 1.25);
                minimapCtx.strokeStyle = darkMode ? '#f8fafc' : '#0f172a';
                minimapCtx.stroke();
            }
        });

        if (minimapModel.viewport) {
            const camera = minimapModel.viewport;
            const edgeInset = Math.max(1, dpr * 1.25);
            const cameraX = Math.max(edgeInset, Math.min(width - edgeInset, camera.x));
            const cameraY = Math.max(edgeInset, Math.min(height - edgeInset, camera.y));
            const cameraRight = Math.max(edgeInset, Math.min(width - edgeInset, camera.x + camera.width));
            const cameraBottom = Math.max(edgeInset, Math.min(height - edgeInset, camera.y + camera.height));
            const cameraWidth = Math.max(1, cameraRight - cameraX);
            const cameraHeight = Math.max(1, cameraBottom - cameraY);
            minimapCtx.save();
            minimapCtx.beginPath();
            minimapCtx.rect(0, 0, width, height);
            minimapCtx.clip();
            drawMinimapRoundedRect(minimapCtx, cameraX, cameraY, cameraWidth, cameraHeight, 3 * dpr);
            minimapCtx.fillStyle = darkMode ? 'rgba(96,165,250,0.11)' : 'rgba(37,99,235,0.09)';
            minimapCtx.fill();
            minimapCtx.lineWidth = Math.max(1.5, dpr * 1.35);
            minimapCtx.strokeStyle = darkMode ? 'rgba(125,211,252,0.95)' : 'rgba(37,99,235,0.9)';
            minimapCtx.stroke();
            minimapCtx.restore();
        }
    }

    function setMinimapVisible(visible) {
        minimapVisible = visible === true;
        if (minimapCanvas) minimapCanvas.tabIndex = minimapVisible ? 0 : -1;
        if (!minimapVisible) {
            minimapDrag = null;
            return;
        }
        requestRedraw();
    }

    // ════════════════════════════════════════════════════════════════════
    //  Animation loop — rAF-coalesced redraw
    // ════════════════════════════════════════════════════════════════════
    //  All callers schedule redraws via `scheduleDraw()`. The function uses
    //  a single `requestAnimationFrame` token so dozens of mutations in one
    //  task (drag + scroll + hover) collapse into ONE draw per frame.
    //
    //  When a table is selected, the loop also bumps `flowOffset` every
    //  frame so the connector dash pattern visibly flows. When nothing is
    //  selected the loop short-circuits and the CPU stays idle.
    // ════════════════════════════════════════════════════════════════════

    //
    // When a table is selected, we'd otherwise have to redraw every table,
    // column, icon, and connector on every animation frame just to scroll a
    // dash offset across a few relations — that's where the lag comes from
    // on large schemas. Instead, we cache the entire static scene (minus the
    // flowing connectors) into an offscreen canvas, and on each animated
    // frame we just `drawImage` that cache and restroke the 1-N flowing
    // connectors on top. Cost per animation frame drops from
    //   O(tables + relations) worth of canvas ops
    // to
    //   1 bitmap blit + O(selected-relations) strokes.
    // The cache is invalidated any time `scheduleDraw`/`requestRedraw` is
    // called (i.e. something about the scene really changed: pan, zoom,
    // hover, drag, resize, schema edit, theme change, etc.).

    // Two-layer cache so the flowing connectors can render between them,
    // preserving the original z-order (tables must paint OVER connectors,
    // including the flowing ones):
    //   belowCache = background + normal/hover-row connectors   (under flow)
    //   aboveCache = hovered connector + tables + hovered tooltip (over flow)
    let belowCanvas = null;
    let belowCtx = null;
    let aboveCanvas = null;
    let aboveCtx = null;
    let staticCacheValid = false;

    function invalidateStaticCache() {
        staticCacheValid = false;
    }

    // Returns `true` only when both cache canvases exist and have non-zero
    // dimensions. During layout transitions (splitter collapsed, panel hidden,
    // tab just switched in) the host container may briefly report a 0×0 size,
    // which would make `drawImage` throw `InvalidStateError`. In that case we
    // skip the cached path and let the next scheduled draw rebuild it.
    function ensureCacheCanvases() {
        const w = baseCanvas.width;
        const h = baseCanvas.height;
        if (w === 0 || h === 0) return false;
        if (!belowCanvas || belowCanvas.width !== w || belowCanvas.height !== h) {
            belowCanvas = document.createElement('canvas');
            belowCanvas.width = w;
            belowCanvas.height = h;
            belowCtx = belowCanvas.getContext('2d');
            staticCacheValid = false;
        }
        if (!aboveCanvas || aboveCanvas.width !== w || aboveCanvas.height !== h) {
            aboveCanvas = document.createElement('canvas');
            aboveCanvas.width = w;
            aboveCanvas.height = h;
            aboveCtx = aboveCanvas.getContext('2d');
            staticCacheValid = false;
        }
        return true;
    }

    function cacheCanvasesReady() {
        return !!(belowCanvas && belowCanvas.width > 0 && belowCanvas.height > 0 && aboveCanvas && aboveCanvas.width > 0 && aboveCanvas.height > 0 && baseCanvas.width > 0 && baseCanvas.height > 0);
    }

    // True when the currently hovered connector is also attached to the
    // selected table (so it should keep the flowing treatment instead of
    // collapsing to the plain hover style).
    function isHoveredSelectedSibling() {
        if (!selectedNode || hoveredConnectorIdx === null) return false;
        const conn = connectorPaths[hoveredConnectorIdx];
        if (!conn || !conn.relation) return false;
        return conn.relation.from.table === selectedNode.name || conn.relation.to.table === selectedNode.name;
    }

    // Strokes only the connectors tied to the selected table. Called each
    // frame between the two cache blits so tables still paint over them.
    // The hovered sibling is drawn last so it sits on top of its peers.
    function drawFlowingOverlay(ctx) {
        if (!selectedNode || !connectorPaths || connectorPaths.length === 0) return;
        const zoom = contextManager.zoom;
        const offsetX = contextManager.offsetX;
        const offsetY = contextManager.offsetY;
        const hoveredSiblingIdx = isHoveredSelectedSibling() ? hoveredConnectorIdx : -1;
        ctx.save();
        ctx.setTransform(zoom, 0, 0, zoom, offsetX, offsetY);
        for (let i = 0; i < connectorPaths.length; i++) {
            if (i === hoveredSiblingIdx) continue;
            const conn = connectorPaths[i];
            if (!conn || !conn.relation || !conn.points || conn.points.length < 2) continue;
            if (conn.relation.from.table !== selectedNode.name && conn.relation.to.table !== selectedNode.name) continue;
            drawWithAlpha(ctx, getPriorityConnectorAlpha(i), () => {
                renderConnector(ctx, conn, true, true, theme.connector, SELECTED_CONNECTOR_WIDTH, /* flowing */ true);
            });
        }
        if (hoveredSiblingIdx >= 0) {
            const conn = connectorPaths[hoveredSiblingIdx];
            if (conn && conn.relation && conn.points && conn.points.length >= 2) {
                drawWithAlpha(ctx, getPriorityConnectorAlpha(hoveredSiblingIdx), () => {
                    renderConnector(ctx, conn, true, true, theme.connector, SELECTED_HOVERED_CONNECTOR_WIDTH, /* flowing */ true);
                });
            }
        }
        ctx.restore();
    }

    // Re-bakes the below/above cache pair and paints a composite frame.
    // Called whenever the scene actually changed. When the container is
    // momentarily 0×0 we bail out quietly — the next valid paint will pick
    // it back up once the layout settles.
    function renderFullScene() {
        if (baseCanvas.width === 0 || baseCanvas.height === 0) {
            staticCacheValid = false;
            return;
        }
        // With reduced-motion we skip the flowing animation entirely and
        // render everything in a single pass — no per-frame work, no offscreen
        // cache, just a crisp static ERD.
        if (selectedNode && !prefersReducedMotion) {
            if (!ensureCacheCanvases()) {
                staticCacheValid = false;
                return;
            }
            draw({ targetCtx: belowCtx, targetCanvas: belowCanvas, layer: 'below' });
            draw({ targetCtx: aboveCtx, targetCanvas: aboveCanvas, layer: 'above' });
            staticCacheValid = true;
            compositeFrame();
        } else {
            draw();
            staticCacheValid = false;
        }
        renderMinimap();
    }

    // Per-animation-frame fast path: blit cached layers and restroke only
    // the flowing connectors in between. Guarded so a mid-layout 0×0 canvas
    // can't throw InvalidStateError.
    function compositeFrame() {
        if (!cacheCanvasesReady()) return;
        baseCtx.save();
        baseCtx.setTransform(1, 0, 0, 1, 0, 0);
        baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
        baseCtx.drawImage(belowCanvas, 0, 0);
        baseCtx.restore();
        drawFlowingOverlay(baseCtx);
        baseCtx.save();
        baseCtx.setTransform(1, 0, 0, 1, 0, 0);
        baseCtx.drawImage(aboveCanvas, 0, 0);
        baseCtx.restore();
    }

    function renderFlowingFrame() {
        if (!selectedNode) return;
        if (!staticCacheValid || !cacheCanvasesReady()) {
            renderFullScene();
            return;
        }
        compositeFrame();
    }

    // Any "the scene actually changed" signal flows through scheduleDraw /
    // requestRedraw, so we invalidate the cache at both entry points.
    function scheduleDraw() {
        if (disposed) return;
        invalidateStaticCache();
        if (!needsRedraw) {
            needsRedraw = true;
            requestAnimationFrame(() => {
                if (disposed) return;
                needsRedraw = false;
                renderFullScene();
            });
        }
    }

    function requestRedraw() {
        if (disposed) return;
        invalidateStaticCache();
        needsRedraw = true;
    }

    // Respect the OS-level "reduce motion" preference. When on, we never run
    // the flowing-connector animation — selected-table relations still render
    // bold and gradient-coloured, just statically. This also drops the whole
    // per-frame compositing loop for accessibility-conscious users and, as a
    // nice bonus, for anyone running with reduced motion on a low-end device.
    const prefersReducedMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Animation loop — advances the connector "river" offset when a table is
    // selected and the tab is visible. If the scene didn't change, only the
    // cheap flowing layer is redrawn. Exits cleanly when the run is disposed
    // (the next `runErdScript` call flips the flag) so we don't paint into a
    // detached canvas or leak offscreen cache buffers.
    //
    // Flowing-frame rendering is capped at ~30fps. The dash pattern moves at
    // 60 px/s, so halving the frame rate still feels smooth to the eye but
    // cuts the per-frame CPU cost roughly in half — crucial on low-end
    // phones where blitting two HiDPI bitmaps and re-stroking N connectors
    // at 60Hz would otherwise dominate the frame budget.
    let lastFlowRenderTs = 0;
    // Pixels/second: low enough to feel smooth, high enough to feel alive.
    const FLOW_SPEED = 60;
    const FLOW_MIN_INTERVAL = 1000 / 30;
    function animationLoop(ts) {
        if (disposed) {
            // Drop references so the GC can reclaim the offscreen canvases.
            belowCanvas = belowCtx = aboveCanvas = aboveCtx = null;
            return;
        }
        const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
        // A detached / collapsed container reports 0×0; skip entirely until
        // the next resize brings it back.
        const hasSize = baseCanvas.width > 0 && baseCanvas.height > 0;

        if (needsRedraw && hasSize) {
            needsRedraw = false;
            renderFullScene();
            lastFlowRenderTs = ts;
        } else if (selectedNode && visible && hasSize && !prefersReducedMotion) {
            const elapsed = lastFlowRenderTs ? ts - lastFlowRenderTs : FLOW_MIN_INTERVAL;
            if (elapsed >= FLOW_MIN_INTERVAL) {
                const dt = Math.min(50, elapsed);
                flowOffset += (dt * FLOW_SPEED) / 1000;
                renderFlowingFrame();
                lastFlowRenderTs = ts;
            }
        }
        requestAnimationFrame(animationLoop);
    }

    // Start animation loop
    requestAnimationFrame(animationLoop);

    const exportDefaults = {
        scale: 2,
        minWidth: 1920,
        minHeight: 1080,
        maxSize: 8192,
        background: theme.background,
    };

    function exportPng(options = {}) {
        const { scale = exportDefaults.scale, minWidth = exportDefaults.minWidth, minHeight = exportDefaults.minHeight, maxSize = exportDefaults.maxSize, background = exportDefaults.background } = options;

        if (!canvas || !canvas.width || !canvas.height) return null;

        const baseWidth = canvas.width;
        const baseHeight = canvas.height;
        const minScale = Math.max(minWidth / baseWidth, minHeight / baseHeight, 1);
        const maxScale = Math.min(maxSize / baseWidth, maxSize / baseHeight);
        let exportScale = Math.max(scale, minScale);
        exportScale = Math.min(exportScale, maxScale);
        if (!isFinite(exportScale) || exportScale <= 0) {
            exportScale = 1;
        }

        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = Math.round(baseWidth * exportScale);
        exportCanvas.height = Math.round(baseHeight * exportScale);

        const exportCtx = exportCanvas.getContext('2d', {
            alpha: false,
            desynchronized: false,
            willReadFrequently: false,
        });
        if (!exportCtx) return null;

        const exportZoom = contextManager.zoom * exportScale;
        const exportOffsetX = contextManager.offsetX * exportScale;
        const exportOffsetY = contextManager.offsetY * exportScale;

        draw({
            targetCtx: exportCtx,
            targetCanvas: exportCanvas,
            zoom: exportZoom,
            offsetX: exportOffsetX,
            offsetY: exportOffsetY,
            background,
            showConnectorEditor: false,
        });

        const exportWidth = exportCanvas.width;
        const exportHeight = exportCanvas.height;
        const dataUrl = exportCanvas.toDataURL('image/png', 1.0);

        // Release memory ASAP
        exportCanvas.width = 0;
        exportCanvas.height = 0;

        return {
            dataUrl,
            width: exportWidth,
            height: exportHeight,
            scale: exportScale,
        };
    }

    function getMinimapEventPoint(event) {
        if (!minimapCanvas) return null;
        const rect = minimapCanvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        return {
            x: (event.clientX - rect.left) * (minimapCanvas.width / rect.width),
            y: (event.clientY - rect.top) * (minimapCanvas.height / rect.height),
        };
    }

    function panFromMinimapPoint(point, dragState) {
        const update = getErdMinimapPanUpdate({
            model: minimapModel,
            mapX: point?.x,
            mapY: point?.y,
            zoom: contextManager.zoom,
            viewportWidth: canvas.width,
            viewportHeight: canvas.height,
            grabOffsetX: dragState?.grabOffsetX,
            grabOffsetY: dragState?.grabOffsetY,
        });
        if (!update) return;
        contextManager.batchUpdate(update);
        requestRedraw();
    }

    if (minimapCanvas) {
        minimapCanvas.addEventListener('pointerdown', (event) => {
            if (!minimapVisible || event.button !== 0) return;
            if (!minimapModel) renderMinimap();
            const point = getMinimapEventPoint(event);
            const worldPoint = point ? erdMinimapPointToWorld(minimapModel, point.x, point.y) : null;
            const viewport = getErdViewportWorldRect({
                zoom: contextManager.zoom,
                offsetX: contextManager.offsetX,
                offsetY: contextManager.offsetY,
                viewportWidth: canvas.width,
                viewportHeight: canvas.height,
            });
            if (!point || !worldPoint || !viewport) return;

            const camera = minimapModel?.viewport;
            const grabbedCamera = camera && point.x >= camera.x && point.x <= camera.x + camera.width && point.y >= camera.y && point.y <= camera.y + camera.height;
            minimapDrag = {
                pointerId: event.pointerId,
                grabOffsetX: grabbedCamera ? worldPoint.x - viewport.x : viewport.width / 2,
                grabOffsetY: grabbedCamera ? worldPoint.y - viewport.y : viewport.height / 2,
            };
            minimapCanvas.setPointerCapture?.(event.pointerId);
            panFromMinimapPoint(point, minimapDrag);
            event.preventDefault();
        });

        minimapCanvas.addEventListener('pointermove', (event) => {
            if (!minimapDrag || minimapDrag.pointerId !== event.pointerId) return;
            const point = getMinimapEventPoint(event);
            if (point) panFromMinimapPoint(point, minimapDrag);
            event.preventDefault();
        });

        const endMinimapDrag = (event) => {
            if (!minimapDrag || minimapDrag.pointerId !== event.pointerId) return;
            minimapCanvas.releasePointerCapture?.(event.pointerId);
            minimapDrag = null;
            event.preventDefault();
        };
        minimapCanvas.addEventListener('pointerup', endMinimapDrag);
        minimapCanvas.addEventListener('pointercancel', endMinimapDrag);

        minimapCanvas.addEventListener('keydown', (event) => {
            const viewport = getErdViewportWorldRect({
                zoom: contextManager.zoom,
                offsetX: contextManager.offsetX,
                offsetY: contextManager.offsetY,
                viewportWidth: canvas.width,
                viewportHeight: canvas.height,
            });
            if (!viewport) return;
            if (event.key === 'Home') {
                fitToScreen();
                requestRedraw();
                event.preventDefault();
                return;
            }

            const stepX = viewport.width * (event.shiftKey ? 0.3 : 0.1);
            const stepY = viewport.height * (event.shiftKey ? 0.3 : 0.1);
            const delta = {
                ArrowLeft: { x: -stepX, y: 0 },
                ArrowRight: { x: stepX, y: 0 },
                ArrowUp: { x: 0, y: -stepY },
                ArrowDown: { x: 0, y: stepY },
            }[event.key];
            if (!delta) return;
            contextManager.batchUpdate({
                offsetX: contextManager.offsetX - delta.x * contextManager.zoom,
                offsetY: contextManager.offsetY - delta.y * contextManager.zoom,
            });
            requestRedraw();
            event.preventDefault();
        });
    }

    // ════════════════════════════════════════════════════════════════════
    //  SECTION 10 — Pointer events (drag tables / pan canvas / hover)
    // ════════════════════════════════════════════════════════════════════
    //  Mouse + wheel handlers attached to the cloned canvas:
    //
    //    mousedown   →  hit-test in REVERSE table order so the topmost card
    //                   wins. A hit on a table starts a drag; a hit on
    //                   empty canvas starts a pan.
    //    mousemove   →  during drag/pan, mutate the relevant world coords
    //                   and call `scheduleDraw()`. Otherwise update hover
    //                   state for tooltips and the connector spotlight.
    //    mouseup     →  finalise drag/pan and persist via ContextManager.
    //    wheel       →  zoom around the cursor anchor (preserves the
    //                   world-point under the mouse so the user feels like
    //                   the canvas zooms toward their finger).
    //    contextmenu →  suppressed during drag to avoid native menu
    //                   stealing the pointer-up event.
    //
    //  Touch events live in the next sub-section (mobile drag/pan/pinch).
    // ════════════════════════════════════════════════════════════════════

    function screenToWorld(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const x = (clientX - rect.left) * dpr;
        const y = (clientY - rect.top) * dpr;
        return {
            x: (x - contextManager.offsetX) / contextManager.zoom,
            y: (y - contextManager.offsetY) / contextManager.zoom,
        };
    }

    function hideHeaderActionPopups({ keepColor = false } = {}) {
        if (!keepColor && colorPopup && colorPopup.style.display === 'flex') hideColorPopup();
        if (layoutPopup && layoutPopup.style.display === 'block') hideLayoutPopup();
        if (tableNavPopup && tableNavPopup.style.display === 'block') hideTableNavPopup();
        if (autoColorPopup && autoColorPopup.style.display === 'flex') hideAutoColorPopup();
    }

    // Helper: Check click on header action icons.
    function checkToggleClick(x, y) {
        for (let i = schema.tables.length - 1; i >= 0; i--) {
            const tbl = schema.tables[i];
            const iconLayout = getHeaderIconLayout(tbl);
            if (!shouldDrawHeaderActions(tbl)) continue;

            if (isPointInHeaderIcon(x, y, iconLayout.priority, iconLayout.hitSize)) {
                hideHeaderActionPopups();
                contextManager.togglePriorityTableName(tbl.name);
                updateButtonsVisibility();
                scheduleDraw();
                return true;
            }

            if (isPointInHeaderIcon(x, y, iconLayout.jump, iconLayout.hitSize)) {
                hideHeaderActionPopups();
                if (typeof onJumpToTable === 'function') {
                    // Parent resolves the table name back to the owning tab and
                    // CREATE TABLE line; the canvas intentionally stays SQL-free.
                    onJumpToTable(tbl.name);
                }
                return true;
            }

            if (isPointInHeaderIcon(x, y, iconLayout.color, iconLayout.hitSize)) {
                selectedNode = tbl;
                contextManager.setSelectedNode(tbl.name);
                hoveredConnectorIdx = null;
                hoveredConnectorPoint = null;
                connectorTooltipCache = null;
                hideHeaderActionPopups({ keepColor: true });
                updateButtonsVisibility();
                showColorPopup(tbl, { source: 'table-header', anchorIcon: iconLayout.color });
                requestRedraw();
                return true;
            }

            if (isPointInHeaderIcon(x, y, iconLayout.eye, iconLayout.hitSize)) {
                hideHeaderActionPopups();
                // Toggle compact mode using ContextManager for persistence
                const currentMode = contextManager.getTableCompactMode(tbl.name);
                contextManager.setTableCompactMode(tbl.name, !currentMode);
                scheduleDraw();
                return true;
            }
        }
        return false;
    }

    canvas.addEventListener('mousedown', (e) => {
        const { x, y } = screenToWorld(e.clientX, e.clientY);

        const endpointHit = getConnectorEndpointHit(x, y);
        if (endpointHit) {
            draggingConnectorEndpoint = {
                connectorIndex: endpointHit.connectorIndex,
                relationKey: endpointHit.connector.relationKey,
                endpoint: endpointHit.endpoint,
                startClientX: e.clientX,
                startClientY: e.clientY,
                didMove: false,
            };
            selectedConnectorKey = endpointHit.connector.relationKey;
            hoveredConnectorIdx = endpointHit.connectorIndex;
            hoveredConnectorPoint = { x, y };
            canvas.style.cursor = 'ew-resize';
            e.preventDefault();
            e.stopPropagation();
            requestRedraw();
            return;
        }

        // Check toggle icon click first
        if (checkToggleClick(x, y)) {
            hideConnectorSidePopup();
            e.stopPropagation();
            return;
        }

        for (let i = schema.tables.length - 1; i >= 0; i--) {
            const tbl = schema.tables[i];
            if (x >= tbl.x - tbl.width / 2 && x <= tbl.x + tbl.width / 2 && y >= tbl.y - tbl.height / 2 && y <= tbl.y + tbl.height / 2) {
                hideConnectorSidePopup();
                draggingNode = tbl;
                dragOffsetX = x - tbl.x;
                dragOffsetY = y - tbl.y;
                canvas.style.cursor = 'grabbing';
                selectedNode = tbl;
                hoveredConnectorIdx = null;
                hoveredConnectorPoint = null;
                connectorTooltipCache = null;
                contextManager.setSelectedNode(tbl.name);
                updateButtonsVisibility();
                requestRedraw();
                return;
            }
        }

        const connectorIndex = findConnectorAtPoint(x, y);
        if (connectorIndex !== null) {
            const connector = connectorPaths[connectorIndex];
            hoveredConnectorIdx = connectorIndex;
            hoveredConnectorPoint = { x, y };
            connectorTooltipCache = null;
            showConnectorSidePopup(connector, e.clientX, e.clientY);
            canvas.style.cursor = 'pointer';
            e.preventDefault();
            return;
        }
        // Pan
        hideConnectorSidePopup();
        panning = true;
        panStartX = e.clientX;
        panStartY = e.clientY;
        panOriginX = contextManager.offsetX ?? 0;
        panOriginY = contextManager.offsetY ?? 0;
        canvas.style.cursor = 'grabbing';
        selectedNode = null;
        hoveredConnectorIdx = null;
        hoveredConnectorPoint = null;
        connectorTooltipCache = null;
        contextManager.setSelectedNode(null);
        updateButtonsVisibility();
        requestRedraw();
    });

    canvas.addEventListener('dblclick', (e) => {
        if (typeof onJumpToTable !== 'function') return;

        const { x, y } = screenToWorld(e.clientX, e.clientY);
        for (let i = schema.tables.length - 1; i >= 0; i--) {
            const tbl = schema.tables[i];
            if (x < tbl.x - tbl.width / 2 || x > tbl.x + tbl.width / 2 || y < tbl.y - tbl.height / 2 || y > tbl.y + tbl.height / 2) continue;

            e.preventDefault();
            onJumpToTable(tbl.name);
            return;
        }
    });
    canvas.addEventListener('mousemove', (e) => {
        if (draggingConnectorEndpoint) {
            const { x, y } = screenToWorld(e.clientX, e.clientY);
            const connector = connectorPaths[draggingConnectorEndpoint.connectorIndex];
            const details = getConnectorEndpointDetails(connector, draggingConnectorEndpoint.endpoint);
            if (connector && details) {
                const currentSide = draggingConnectorEndpoint.endpoint === 'from' ? connector.fromSide : connector.toSide;
                const nextSide = chooseConnectorSideFromPointer(x, details.table.x, currentSide, 12 / Math.max(contextManager.zoom, 0.001));
                const currentOverride = contextManager.getConnectorEndpointSides(connector.relationKey)[draggingConnectorEndpoint.endpoint];
                if (currentOverride !== nextSide) {
                    contextManager.setConnectorEndpointSide(connector.relationKey, draggingConnectorEndpoint.endpoint, nextSide);
                    refreshConnectorSidePopup(connector);
                }
                draggingConnectorEndpoint.didMove = draggingConnectorEndpoint.didMove || Math.hypot(e.clientX - draggingConnectorEndpoint.startClientX, e.clientY - draggingConnectorEndpoint.startClientY) >= 4;
                hoveredConnectorIdx = draggingConnectorEndpoint.connectorIndex;
                hoveredConnectorPoint = { x, y };
                connectorTooltipCache = null;
                canvas.style.cursor = 'ew-resize';
                requestRedraw();
            }
            return;
        }
        if (draggingNode) {
            const { x, y } = screenToWorld(e.clientX, e.clientY);
            draggingNode.x = x - dragOffsetX;
            draggingNode.y = y - dragOffsetY;
            contextManager.setTablePosition(draggingNode.name, draggingNode.x, draggingNode.y);
            requestRedraw();
            return;
        } else if (panning) {
            const dpr = window.devicePixelRatio || 1;
            const newOffsetX = panOriginX + (e.clientX - panStartX) * dpr;
            const newOffsetY = panOriginY + (e.clientY - panStartY) * dpr;
            contextManager.setOffset(newOffsetX, newOffsetY);
            requestRedraw();
            return;
        }
        // Only hover connector when not dragging node or panning
        const { x, y } = screenToWorld(e.clientX, e.clientY);
        const endpointHover = getConnectorEndpointHit(x, y);
        if (endpointHover) {
            hoveredConnectorIdx = endpointHover.connectorIndex;
            hoveredConnectorPoint = { x, y };
            connectorTooltipCache = null;
            canvas.style.cursor = 'ew-resize';
            requestRedraw();
            return;
        }
        let overTable = false;
        let newHoveredHeaderTableName = null;
        let foundRow = { table: null, rowIdx: null };
        let newHoveredConnectorIdxList = [];
        for (let i = schema.tables.length - 1; i >= 0; i--) {
            const tbl = schema.tables[i];
            if (x >= tbl.x - tbl.width / 2 && x <= tbl.x + tbl.width / 2 && y >= tbl.y - tbl.height / 2 && y <= tbl.y + tbl.height / 2) {
                overTable = true;
                if (isPointInTableHeader(x, y, tbl)) {
                    newHoveredHeaderTableName = tbl.name;
                }
                // Check which row is being hovered
                const relY = y - (tbl.y - tbl.height / 2);
                const visibleCols = getVisibleColumns(tbl);
                if (relY >= NODE_H) {
                    const rowIdx = Math.floor((relY - NODE_H) / ROW_H);
                    if (rowIdx >= 0 && rowIdx < visibleCols.length) {
                        foundRow = { table: tbl.name, rowIdx };
                        // If it is a PK/FK, find related connectors
                        const col = visibleCols[rowIdx];
                        if (col && (col.pk || col.fk)) {
                            connectorPaths.forEach((conn, idx) => {
                                if (!conn || !conn.relation) return;
                                // If this is the from or to end of the connector
                                if ((conn.relation.from.table === tbl.name && conn.relation.from.column === col.name) || (conn.relation.to.table === tbl.name && conn.relation.to.column === col.name)) {
                                    newHoveredConnectorIdxList.push(idx);
                                }
                            });
                        }
                    }
                }
                break;
            }
        }
        if (hoveredHeaderTableName !== newHoveredHeaderTableName) {
            hoveredHeaderTableName = newHoveredHeaderTableName;
            requestRedraw();
        }
        if (hoveredRow.table !== foundRow.table || hoveredRow.rowIdx !== foundRow.rowIdx) {
            hoveredRow = foundRow;
            hoveredConnectorIdxList = newHoveredConnectorIdxList;
            requestRedraw();
        }

        if (overTable) {
            if (hoveredConnectorIdx !== null || hoveredConnectorPoint !== null) {
                hoveredConnectorIdx = null;
                hoveredConnectorPoint = null;
                connectorTooltipCache = null;
                requestRedraw();
            }
            // Show pointer cursor when hovering over header icons.
            let isOverHeaderIcon = false;
            for (let i = schema.tables.length - 1; i >= 0; i--) {
                const tbl = schema.tables[i];
                if (!shouldDrawHeaderActions(tbl)) continue;
                const iconLayout = getHeaderIconLayout(tbl);
                if (
                    isPointInHeaderIcon(x, y, iconLayout.priority, iconLayout.hitSize) ||
                    isPointInHeaderIcon(x, y, iconLayout.jump, iconLayout.hitSize) ||
                    isPointInHeaderIcon(x, y, iconLayout.color, iconLayout.hitSize) ||
                    isPointInHeaderIcon(x, y, iconLayout.eye, iconLayout.hitSize)
                ) {
                    isOverHeaderIcon = true;
                    break;
                }
            }
            canvas.style.cursor = isOverHeaderIcon ? 'pointer' : 'default';
            return;
        }
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const px = (e.clientX - rect.left) * dpr;
        const py = (e.clientY - rect.top) * dpr;
        let found = null;
        const hitPadding = CONNECTOR_HOVER_HIT_WIDTH / Math.max(contextManager.zoom, 0.001);
        ctx.save();
        ctx.setTransform(contextManager.zoom, 0, 0, contextManager.zoom, contextManager.offsetX, contextManager.offsetY);
        ctx.lineWidth = CONNECTOR_HOVER_HIT_WIDTH;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (let i = 0; i < connectorPaths.length; ++i) {
            const connPath = connectorPaths[i];
            // Skip if no valid points
            if (!connPath || !connPath.points || connPath.points.length < 2) continue;
            const bounds = connPath.bounds;
            if (bounds && (x < bounds.minX - hitPadding || x > bounds.maxX + hitPadding || y < bounds.minY - hitPadding || y > bounds.maxY + hitPadding)) {
                continue;
            }
            ctx.beginPath();
            drawRoundedElbowPath(ctx, connPath.points, connPath.radius);
            if (ctx.isPointInStroke(px, py)) {
                found = i;
                break;
            }
        }
        ctx.restore();
        if (found !== hoveredConnectorIdx) {
            hoveredConnectorIdx = found;
            hoveredConnectorPoint = found !== null ? { x, y } : null;
            connectorTooltipCache = null;
            requestRedraw();
        } else if (found !== null && hoveredConnectorPoint === null) {
            hoveredConnectorPoint = { x, y };
            requestRedraw();
        }
        if (found === null) {
            canvas.style.cursor = 'default';
        }
    });
    canvas.addEventListener('mouseup', (e) => {
        if (draggingConnectorEndpoint) {
            const drag = draggingConnectorEndpoint;
            const connector = connectorPaths[drag.connectorIndex];
            if (connector && !drag.didMove) {
                const currentSide = drag.endpoint === 'from' ? connector.fromSide : connector.toSide;
                contextManager.setConnectorEndpointSide(connector.relationKey, drag.endpoint, currentSide === 'left' ? 'right' : 'left');
                refreshConnectorSidePopup(connector);
            }
            draggingConnectorEndpoint = null;
            canvas.style.cursor = 'ew-resize';
            connectorTooltipCache = null;
            requestRedraw();
            return;
        }
        draggingNode = null;
        panning = false;
        canvas.style.cursor = 'default';
        // If mouseup is not on a node, deselect
        const { x, y } = screenToWorld(e.clientX, e.clientY);
        let found = false;
        for (const tbl of schema.tables) {
            if (x >= tbl.x - tbl.width / 2 && x <= tbl.x + tbl.width / 2 && y >= tbl.y - tbl.height / 2 && y <= tbl.y + tbl.height / 2) {
                found = true;
                break;
            }
        }
        if (!found) {
            selectedNode = null;
            contextManager.setSelectedNode(null);
            updateButtonsVisibility();
            requestRedraw();
        }
    });
    canvas.addEventListener('mouseleave', (_e) => {
        draggingConnectorEndpoint = null;
        draggingNode = null;
        panning = false;
        canvas.style.cursor = 'default';
        hoveredConnectorIdx = null;
        hoveredConnectorPoint = null;
        connectorTooltipCache = null;
        hoveredConnectorIdxList = []; // Clear hover row when leaving canvas
        hoveredRow = { table: null, rowIdx: null }; // Clear hover row when leaving canvas
        hoveredHeaderTableName = null;
        requestRedraw();
    });
    // Wheel smoothing state (helps trackpad feel)
    let wheelDelta = 0;
    let wheelFrame = null;
    let wheelPx = 0;
    let wheelPy = 0;
    let wheelMouse = { x: 0, y: 0 };
    let lastWheelTime = 0;
    let lastWheelDir = 0;
    // Zoom wheel
    canvas.addEventListener(
        'wheel',
        (e) => {
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            const px = (e.clientX - rect.left) * dpr;
            const py = (e.clientY - rect.top) * dpr;
            const mouse = screenToWorld(e.clientX, e.clientY);
            // Normalize wheel delta and smooth zoom for trackpads
            let pixelDelta = e.deltaY;
            if (e.deltaMode === 1) pixelDelta *= 16; // line -> px
            if (e.deltaMode === 2) pixelDelta *= 100; // page -> px
            const isTrackpad = e.deltaMode === 0 && Math.abs(e.deltaY) < 12;
            const zoomIntensity = isTrackpad ? 0.0075 : 0.0011;
            const now = performance.now();
            const dir = Math.sign(pixelDelta);
            if (dir && dir !== lastWheelDir) {
                wheelDelta = 0;
            }
            if (now - lastWheelTime > 80) {
                wheelDelta = 0;
            }
            lastWheelTime = now;
            if (dir) lastWheelDir = dir;
            wheelDelta += pixelDelta;
            wheelPx = px;
            wheelPy = py;
            wheelMouse = mouse;
            if (!wheelFrame) {
                wheelFrame = requestAnimationFrame(() => {
                    refreshZoomLimits();
                    const clamp = isTrackpad ? 60 : 120;
                    const clampedDelta = Math.max(-clamp, Math.min(clamp, wheelDelta));
                    const zoomFactor = Math.exp(-clampedDelta * zoomIntensity);
                    const targetZoom = contextManager.zoom * zoomFactor;
                    const newZoom = clampErdZoom(targetZoom, { minZoom, maxZoom });
                    const update = newZoom
                        ? getAnchoredZoomUpdate({
                            anchorX: wheelPx,
                            anchorY: wheelPy,
                            worldX: wheelMouse.x,
                            worldY: wheelMouse.y,
                            zoom: newZoom,
                        })
                        : null;
                    if (update) {
                        contextManager.batchUpdate(update);
                        requestRedraw();
                    }
                    wheelDelta = 0;
                    wheelFrame = null;
                });
            }
        },
        { passive: false },
    );

    // ════════════════════════════════════════════════════════════════════
    //  SECTION 10B — Touch events (single-finger drag / pan, pinch zoom)
    // ════════════════════════════════════════════════════════════════════
    //  Mirrors section 10 for `touchstart` / `touchmove` / `touchend`.
    //  Single-finger touch behaves identically to mouse drag/pan.
    //  Two-finger touch enters pinch mode: the midpoint anchors the zoom
    //  origin and the inter-finger distance drives the zoom factor — same
    //  visual effect as mouse-wheel zoom around the cursor.
    //
    //  `e.preventDefault()` is called only on canvas-active gestures so the
    //  page outside the canvas can still scroll naturally on mobile.
    // ════════════════════════════════════════════════════════════════════

    let pinchGesture = null;
    let suppressSingleTouchUntilEnd = false;

    function getTouchCanvasPoint(touch) {
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        return {
            x: (touch.clientX - rect.left) * dpr,
            y: (touch.clientY - rect.top) * dpr,
        };
    }

    function getTouchPos(touch) {
        const { x, y } = getTouchCanvasPoint(touch);
        return {
            x: (x - contextManager.offsetX) / contextManager.zoom,
            y: (y - contextManager.offsetY) / contextManager.zoom,
            rawX: x,
            rawY: y,
        };
    }

    function getPinchMetrics(touches) {
        if (!touches || touches.length < 2) return null;
        const first = getTouchCanvasPoint(touches[0]);
        const second = getTouchCanvasPoint(touches[1]);
        const distance = Math.hypot(second.x - first.x, second.y - first.y);
        if (!Number.isFinite(distance) || distance <= 1) return null;

        return {
            distance,
            midpointX: (first.x + second.x) / 2,
            midpointY: (first.y + second.y) / 2,
        };
    }

    function beginPinch(touches) {
        const metrics = getPinchMetrics(touches);
        const startZoom = contextManager.zoom;
        if (!metrics || !Number.isFinite(startZoom) || startZoom <= 0) return false;

        refreshZoomLimits();
        pinchGesture = {
            startDistance: metrics.distance,
            startZoom,
            worldX: (metrics.midpointX - contextManager.offsetX) / startZoom,
            worldY: (metrics.midpointY - contextManager.offsetY) / startZoom,
        };
        suppressSingleTouchUntilEnd = true;

        // A second finger can arrive after the first one started a drag. Pinch
        // owns the gesture from this point, so cancel every single-touch mode.
        draggingConnectorEndpoint = null;
        draggingNode = null;
        panning = false;
        hideConnectorSidePopup();
        canvas.style.cursor = 'grabbing';
        return true;
    }

    canvas.addEventListener(
        'touchstart',
        (e) => {
            if (!e.touches || e.touches.length === 0) return;
            if (e.touches.length >= 2) {
                if (!pinchGesture) beginPinch(e.touches);
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            if (suppressSingleTouchUntilEnd) {
                e.preventDefault();
                return;
            }
            const touch = e.touches[0];
            const { x, y } = getTouchPos(touch);

            const endpointHit = getConnectorEndpointHit(x, y, { includeAll: true });
            if (endpointHit) {
                draggingConnectorEndpoint = {
                    connectorIndex: endpointHit.connectorIndex,
                    relationKey: endpointHit.connector.relationKey,
                    endpoint: endpointHit.endpoint,
                    startClientX: touch.clientX,
                    startClientY: touch.clientY,
                    didMove: false,
                };
                selectedConnectorKey = endpointHit.connector.relationKey;
                hoveredConnectorIdx = endpointHit.connectorIndex;
                hoveredConnectorPoint = { x, y };
                canvas.style.cursor = 'ew-resize';
                requestRedraw();
                e.preventDefault();
                e.stopPropagation();
                return;
            }

            // Check toggle/jump icon tap before table drag
            if (checkToggleClick(x, y)) {
                hideConnectorSidePopup();
                e.preventDefault();
                e.stopPropagation();
                return;
            }

            for (const tbl of schema.tables) {
                if (x >= tbl.x - tbl.width / 2 && x <= tbl.x + tbl.width / 2 && y >= tbl.y - tbl.height / 2 && y <= tbl.y + tbl.height / 2) {
                    hideConnectorSidePopup();
                    draggingNode = tbl;
                    dragOffsetX = x - tbl.x;
                    dragOffsetY = y - tbl.y;
                    canvas.style.cursor = 'grabbing';
                    selectedNode = tbl;
                    contextManager.setSelectedNode(tbl.name);
                    updateButtonsVisibility();
                    requestRedraw();
                    e.preventDefault();
                    return;
                }
            }
            const connectorIndex = findConnectorAtPoint(x, y, 28);
            if (connectorIndex !== null) {
                const connector = connectorPaths[connectorIndex];
                hoveredConnectorIdx = connectorIndex;
                hoveredConnectorPoint = { x, y };
                connectorTooltipCache = null;
                showConnectorSidePopup(connector, touch.clientX, touch.clientY);
                requestRedraw();
                e.preventDefault();
                return;
            }
            // Pan
            hideConnectorSidePopup();
            panning = true;
            panStartX = touch.clientX;
            panStartY = touch.clientY;
            panOriginX = contextManager.offsetX ?? 0;
            panOriginY = contextManager.offsetY ?? 0;
            canvas.style.cursor = 'grabbing';
            selectedNode = null;
            contextManager.setSelectedNode(null);
            updateButtonsVisibility();
            requestRedraw();
            e.preventDefault();
        },
        { passive: false },
    );
    canvas.addEventListener(
        'touchmove',
        (e) => {
            if (!e.touches || e.touches.length === 0) return;
            if (e.touches.length >= 2) {
                if (!pinchGesture && !beginPinch(e.touches)) return;
                const metrics = getPinchMetrics(e.touches);
                if (metrics) {
                    const update = calculateErdPinchUpdate({
                        ...pinchGesture,
                        currentDistance: metrics.distance,
                        anchorX: metrics.midpointX,
                        anchorY: metrics.midpointY,
                        minZoom,
                        maxZoom,
                    });
                    if (update) {
                        contextManager.batchUpdate(update);
                        requestRedraw();
                    }
                }
                e.preventDefault();
                return;
            }
            if (pinchGesture || suppressSingleTouchUntilEnd) {
                e.preventDefault();
                return;
            }
            const touch = e.touches[0];
            if (draggingConnectorEndpoint) {
                const { x, y } = getTouchPos(touch);
                const connector = connectorPaths[draggingConnectorEndpoint.connectorIndex];
                const details = getConnectorEndpointDetails(connector, draggingConnectorEndpoint.endpoint);
                if (connector && details) {
                    const currentSide = draggingConnectorEndpoint.endpoint === 'from' ? connector.fromSide : connector.toSide;
                    const nextSide = chooseConnectorSideFromPointer(x, details.table.x, currentSide, 12 / Math.max(contextManager.zoom, 0.001));
                    const currentOverride = contextManager.getConnectorEndpointSides(connector.relationKey)[draggingConnectorEndpoint.endpoint];
                    if (currentOverride !== nextSide) {
                        contextManager.setConnectorEndpointSide(connector.relationKey, draggingConnectorEndpoint.endpoint, nextSide);
                        refreshConnectorSidePopup(connector);
                    }
                    draggingConnectorEndpoint.didMove = draggingConnectorEndpoint.didMove || Math.hypot(touch.clientX - draggingConnectorEndpoint.startClientX, touch.clientY - draggingConnectorEndpoint.startClientY) >= 6;
                    hoveredConnectorIdx = draggingConnectorEndpoint.connectorIndex;
                    hoveredConnectorPoint = { x, y };
                    connectorTooltipCache = null;
                    requestRedraw();
                }
                e.preventDefault();
                return;
            }
            if (draggingNode) {
                const { x, y } = getTouchPos(touch);
                draggingNode.x = x - dragOffsetX;
                draggingNode.y = y - dragOffsetY;
                contextManager.setTablePosition(draggingNode.name, draggingNode.x, draggingNode.y);
                requestRedraw();
                e.preventDefault();
                return;
            } else if (panning) {
                const dpr = window.devicePixelRatio || 1;
                const newOffsetX = panOriginX + (touch.clientX - panStartX) * dpr;
                const newOffsetY = panOriginY + (touch.clientY - panStartY) * dpr;
                contextManager.setOffset(newOffsetX, newOffsetY);
                requestRedraw();
                e.preventDefault();
                return;
            }
            // Do not handle connector hover on mobile
        },
        { passive: false },
    );
    function endTouch(e) {
        if (pinchGesture || suppressSingleTouchUntilEnd) {
            pinchGesture = null;
            draggingConnectorEndpoint = null;
            draggingNode = null;
            panning = false;
            canvas.style.cursor = 'default';

            // When one finger remains after a pinch, ignore it until it is
            // lifted. This prevents an abrupt pinch-to-table-drag transition.
            suppressSingleTouchUntilEnd = Boolean(e.touches && e.touches.length > 0);
            requestRedraw();
            e.preventDefault();
            return;
        }
        if (draggingConnectorEndpoint) {
            const drag = draggingConnectorEndpoint;
            const connector = connectorPaths[drag.connectorIndex];
            if (connector && !drag.didMove) {
                const currentSide = drag.endpoint === 'from' ? connector.fromSide : connector.toSide;
                contextManager.setConnectorEndpointSide(connector.relationKey, drag.endpoint, currentSide === 'left' ? 'right' : 'left');
                refreshConnectorSidePopup(connector);
            }
            draggingConnectorEndpoint = null;
            connectorTooltipCache = null;
            requestRedraw();
            return;
        }
        draggingNode = null;
        panning = false;
        canvas.style.cursor = 'default';
        hoveredConnectorIdx = null;
        hoveredConnectorIdxList = [];
        hoveredRow = { table: null, rowIdx: null };
        requestRedraw();
    }
    canvas.addEventListener('touchend', endTouch, { passive: false });
    canvas.addEventListener('touchcancel', endTouch, { passive: false });

    function getCanvasCenter() {
        const rect = canvas.getBoundingClientRect();
        return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
        };
    }

    // ════════════════════════════════════════════════════════════════════
    //  SECTION 11 — Toolbar buttons (zoom / fit / layout / color / delete)
    // ════════════════════════════════════════════════════════════════════
    //  Wires every toolbar control to its handler. Buttons reuse the same
    //  state mutations as the pointer handlers (zoom, layout switch, table
    //  removal) so behaviour is identical regardless of input source.
    //
    //  Color picker:
    //    • Palette swatches (paletteColors) — one click to apply.
    //    • Custom HEX input — accepts `#RRGGBB`, validates client-side.
    //    • Choice persists in `contextManager.tableColors[tableName]`.
    //
    //  Delete:
    //    • Removes the table from the LOCAL `schema.tables` for visual
    //      response, then calls the parent-supplied `onTableDelete` so the
    //      parent can patch its own SQL source. The SQL editor will
    //      eventually re-run sqlToErdSchema and reach the same state.
    // ════════════════════════════════════════════════════════════════════


    // Zoom buttons
    document.getElementById('zoom-in').onclick = () => {
        refreshZoomLimits();
        const { x: cx, y: cy } = getCanvasCenter();
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const px = (cx - rect.left) * dpr;
        const py = (cy - rect.top) * dpr;
        const mouse = screenToWorld(cx, cy);
        const newZoom = clampErdZoom(contextManager.zoom * 1.1, { minZoom, maxZoom });
        const update = newZoom
            ? getAnchoredZoomUpdate({
                anchorX: px,
                anchorY: py,
                worldX: mouse.x,
                worldY: mouse.y,
                zoom: newZoom,
            })
            : null;
        if (update) {
            contextManager.batchUpdate(update);
            requestRedraw();
        }
    };
    document.getElementById('zoom-out').onclick = () => {
        refreshZoomLimits();
        const { x: cx, y: cy } = getCanvasCenter();
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const px = (cx - rect.left) * dpr;
        const py = (cy - rect.top) * dpr;
        const mouse = screenToWorld(cx, cy);
        const newZoom = clampErdZoom(contextManager.zoom / 1.1, { minZoom, maxZoom });
        const update = newZoom
            ? getAnchoredZoomUpdate({
                anchorX: px,
                anchorY: py,
                worldX: mouse.x,
                worldY: mouse.y,
                zoom: newZoom,
            })
            : null;
        if (update) {
            contextManager.batchUpdate(update);
            requestRedraw();
        }
    };

    // Attach event for Fit button
    document.getElementById('fit-btn').onclick = () => {
        fitToScreen();
        requestRedraw();
    };

    async function relayoutWithCurrentMode() {
        selectedNode = null;
        updateButtonsVisibility();
        contextManager.resetPositions();
        contextManager.resetZoomPan();
        contextManager.setSelectedNode(null);
        await computeTableLayoutWithELK(schema, currentLayoutMode);
        fitToScreen();
        schema.tables.forEach((tbl) => {
            if (typeof tbl.x === 'number' && typeof tbl.y === 'number' && !isNaN(tbl.x) && !isNaN(tbl.y)) {
                contextManager.setTablePosition(tbl.name, tbl.x, tbl.y);
            }
            if (!contextManager.getTableColor(tbl.name)) {
                contextManager.setTableColor(tbl.name, theme.headerBg);
            }
        });
        requestRedraw();
    }

    function zoomToTable(tableName) {
        const tbl = (schema.tables || []).find((t) => t.name === tableName);
        if (!tbl) return;

        refreshZoomLimits();
        const rect = canvas.getBoundingClientRect();
        const viewportCssW = Math.max(1, rect.width);
        const viewportCssH = Math.max(1, rect.height);
        const paddingX = 220;
        const paddingY = 170;
        const zoomBoost = 1.12;
        // Use CSS viewport size to avoid over-zooming on high-DPI screens.
        const targetZoomBase = Math.min(viewportCssW / Math.max(1, tbl.width + paddingX), viewportCssH / Math.max(1, tbl.height + paddingY));
        const targetZoom = clampErdZoom(targetZoomBase * zoomBoost, { minZoom, maxZoom }) || contextManager.zoom;

        const viewportW = canvas.width;
        const viewportH = canvas.height;
        const targetOffsetX = viewportW / 2 - tbl.x * targetZoom;
        const targetOffsetY = viewportH / 2 - tbl.y * targetZoom;

        selectedNode = tbl;
        contextManager.batchUpdate({
            selectedNodeName: tbl.name,
            zoom: targetZoom,
            offsetX: targetOffsetX,
            offsetY: targetOffsetY,
        });
        updateButtonsVisibility();
        requestRedraw();
    }

    if (layoutModeBtn) {
        layoutModeBtn.onclick = (e) => {
            if (layoutPopup && layoutPopup.contains(e.target)) return;
            if (layoutPopup && layoutPopup.style.display === 'block') {
                hideLayoutPopup();
            } else {
                if (tableNavPopup && tableNavPopup.style.display === 'block') hideTableNavPopup();
                if (colorPopup && colorPopup.style.display === 'flex') hideColorPopup();
                if (autoColorPopup && autoColorPopup.style.display === 'flex') hideAutoColorPopup();
                showLayoutPopup();
            }
        };
    }

    if (layoutOptionList) {
        layoutOptionList.onclick = async (e) => {
            if (!(e.target instanceof Element)) return;
            const optionEl = e.target.closest('.layout-option');
            if (!optionEl) return;
            const selectedMode = optionEl.dataset.layoutMode;
            if (!selectedMode) return;
            await selectLayoutMode(selectedMode);
        };

        layoutOptionList.onkeydown = async (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            if (!(e.target instanceof Element)) return;
            const optionEl = e.target.closest('.layout-option');
            if (!optionEl) return;
            const selectedMode = optionEl.dataset.layoutMode;
            if (!selectedMode) return;
            e.preventDefault();
            await selectLayoutMode(selectedMode);
        };
    }

    if (layoutPopup) {
        layoutPopup.onkeydown = (e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            hideLayoutPopup();
            layoutModeBtn?.focus({ preventScroll: true });
        };
    }

    if (tableNavBtn) {
        tableNavBtn.onclick = (e) => {
            if (tableNavPopup && tableNavPopup.contains(e.target)) return;
            if (tableNavPopup && tableNavPopup.style.display === 'block') {
                hideTableNavPopup();
            } else {
                if (layoutPopup && layoutPopup.style.display === 'block') hideLayoutPopup();
                if (colorPopup && colorPopup.style.display === 'flex') hideColorPopup();
                if (autoColorPopup && autoColorPopup.style.display === 'flex') hideAutoColorPopup();
                showTableNavPopup();
            }
        };
    }

    if (tableNavSearch) {
        tableNavSearch.oninput = () => {
            renderTableNavList(tableNavSearch.value || '');
        };
        tableNavSearch.onkeydown = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                hideTableNavPopup();
                tableNavBtn?.focus({ preventScroll: true });
            }
        };
    }

    if (tableNavPopup) {
        tableNavPopup.onkeydown = (e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            hideTableNavPopup();
            tableNavBtn?.focus({ preventScroll: true });
        };
    }

    if (tableNavList) {
        tableNavList.onclick = (e) => {
            if (!(e.target instanceof Element)) return;
            const itemEl = e.target.closest('.table-nav-item');
            if (!itemEl) return;
            const tableName = itemEl.dataset.tableName;
            if (!tableName) return;
            hideTableNavPopup();
            zoomToTable(tableName);
            if (typeof onJumpToTable === 'function') onJumpToTable(tableName);
        };

        tableNavList.onkeydown = (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            if (!(e.target instanceof Element)) return;
            const itemEl = e.target.closest('.table-nav-item');
            if (!itemEl) return;
            const tableName = itemEl.dataset.tableName;
            if (!tableName) return;
            e.preventDefault();
            hideTableNavPopup();
            zoomToTable(tableName);
            if (typeof onJumpToTable === 'function') onJumpToTable(tableName);
        };
    }

    if (clearPriorityBtn) {
        clearPriorityBtn.onclick = () => {
            contextManager.clearPriorityTableNames();
            if (layoutPopup && layoutPopup.style.display === 'block') hideLayoutPopup();
            if (tableNavPopup && tableNavPopup.style.display === 'block') hideTableNavPopup();
            if (colorPopup && colorPopup.style.display === 'flex') hideColorPopup();
            if (autoColorPopup && autoColorPopup.style.display === 'flex') hideAutoColorPopup();
            updateButtonsVisibility();
            scheduleDraw();
        };
    }

    if (autoColorOnlyBtn) {
        autoColorOnlyBtn.onclick = () => {
            if (autoColorPopup && autoColorPopup.style.display === 'flex') {
                hideAutoColorPopup();
            } else {
                if (layoutPopup && layoutPopup.style.display === 'block') hideLayoutPopup();
                if (tableNavPopup && tableNavPopup.style.display === 'block') hideTableNavPopup();
                if (colorPopup && colorPopup.style.display === 'flex') hideColorPopup();
                showAutoColorPopup();
            }
        };
    }

    if (autoColorPopup) {
        const handleAutoColorAction = (action) => {
            if (action === 'clear') {
                clearAllTableColors();
            } else if (['bright', 'balanced', 'deep'].includes(action)) {
                autoColorAllTables(action);
            } else {
                return;
            }
            hideAutoColorPopup(true);
            if (colorPopup && colorPopup.style.display === 'flex') hideColorPopup();
        };

        autoColorPopup.onclick = (e) => {
            if (!(e.target instanceof Element)) return;
            const optionEl = e.target.closest('.auto-color-option');
            if (!optionEl) return;
            const action = optionEl.dataset.autoColorAction;
            if (!action) return;
            handleAutoColorAction(action);
        };

        autoColorPopup.onkeydown = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                hideAutoColorPopup(true);
                return;
            }
            if (e.key === 'Tab') {
                setTimeout(() => {
                    if (autoColorPopup.style.display === 'flex' && !autoColorPopup.contains(document.activeElement)) hideAutoColorPopup();
                }, 0);
                return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
            const options = getAutoColorOptions();
            if (options.length === 0) return;
            const currentIndex = options.indexOf(document.activeElement);
            const nextIndex = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : e.key === 'ArrowUp' ? (currentIndex - 1 + options.length) % options.length : (currentIndex + 1) % options.length;
            e.preventDefault();
            options[nextIndex].focus({ preventScroll: true });
        };
    }

    // Handle delete table button
    document.getElementById('delete-table-btn').onclick = async () => {
        if (!selectedNode) return;

        const tableName = selectedNode.name;
        const deleted = typeof onTableDelete === 'function' ? await onTableDelete(tableName) : false;
        if (!deleted) return;

        // Clear selection
        selectedNode = null;
        contextManager.setSelectedNode(null);

        // Hide buttons
        updateButtonsVisibility();

        // Request redraw
        scheduleDraw();
    };

    // Click-outside-to-dismiss for every popup the toolbar opens. We attach
    // ONE document-level listener per render and tear down the previous one
    // through `window._erdDocMouseDownHandler` — without this, every
    // re-render (every keystroke in the SQL editor) would stack a fresh
    // listener on `document`, leaking memory and firing the dismiss logic
    // N times per click. Mirrors the resize / force-fit handler pattern
    // established at line 1816.
    if (window._erdDocMouseDownHandler) {
        document.removeEventListener('mousedown', window._erdDocMouseDownHandler);
    }
    const docMouseDownHandler = (e) => {
        if (disposed) return;
        if (colorPopup && colorBtn && colorPopup.style.display === 'flex' && !colorPopup.contains(e.target) && !colorBtn.contains(e.target)) {
            hideColorPopup();
        }
        if (layoutPopup && layoutModeBtn && layoutPopup.style.display === 'block' && !layoutPopup.contains(e.target) && !layoutModeBtn.contains(e.target)) {
            hideLayoutPopup();
        }
        if (tableNavPopup && tableNavBtn && tableNavPopup.style.display === 'block' && !tableNavPopup.contains(e.target) && !tableNavBtn.contains(e.target)) {
            hideTableNavPopup();
        }
        if (autoColorPopup && autoColorOnlyBtn && autoColorPopup.style.display === 'flex' && !autoColorPopup.contains(e.target) && !autoColorOnlyBtn.contains(e.target)) {
            hideAutoColorPopup();
        }
        if (connectorSidePopup.classList.contains('is-open') && !connectorSidePopup.contains(e.target) && e.target !== canvas) {
            hideConnectorSidePopup();
        }
    };
    window._erdDocMouseDownHandler = docMouseDownHandler;
    document.addEventListener('mousedown', docMouseDownHandler);

    // Handle hex input when manually typed
    if (colorPopup) {
        colorPopup.onclick = (e) => e.stopPropagation();
        colorPopup.onkeydown = (e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            hideColorPopup(true);
        };
        colorPopup.onfocusout = () => {
            setTimeout(() => {
                if (colorPopup.style.display === 'flex' && !colorPopup.contains(document.activeElement)) hideColorPopup();
            }, 0);
        };
    }

    if (colorTextOptions) {
        colorTextOptions.onclick = (e) => {
            if (!(e.target instanceof Element)) return;
            const option = e.target.closest('[data-table-text-color]');
            if (!option) return;
            const colorTarget = getColorPopupTargetNode();
            if (!colorTarget) return;
            const mode = option.dataset.tableTextColor;
            if (!['auto', 'white', 'black'].includes(mode)) return;
            contextManager.setTableHeaderTextMode(colorTarget.name, mode);
            updateColorTextModeButtons(colorTarget.name);
            scheduleDraw();
        };
        colorTextOptions.onkeydown = (e) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
            const options = getColorTextModeButtons();
            if (options.length === 0) return;
            const currentIndex = Math.max(0, options.indexOf(document.activeElement));
            const nextIndex = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (currentIndex - 1 + options.length) % options.length : (currentIndex + 1) % options.length;
            e.preventDefault();
            options[nextIndex].focus({ preventScroll: true });
            options[nextIndex].click();
        };
    }

    document.getElementById('color-hex-input').oninput = () => {
        const colorTarget = getColorPopupTargetNode();
        if (!colorTarget) return;
        let val = colorHexInput.value.trim();
        if (val[0] === '#') val = val.slice(1);
        if (isValidHex(val)) {
            // Update color in context
            contextManager.setTableColor(colorTarget.name, '#' + val);
            scheduleDraw();
            // If color matches a palette color, highlight that dot
            colorDotRow.querySelectorAll('.color-dot').forEach((dot) => {
                const selected = dot.title.replace('#', '').toLowerCase() === val.toLowerCase();
                dot.classList.toggle('selected', selected);
                dot.setAttribute('aria-pressed', selected ? 'true' : 'false');
            });
        }
    };

    // Handle color button click
    document.getElementById('color-btn').onclick = () => {
        if (!selectedNode) return;
        if (colorPopup.style.display === 'flex') {
            hideColorPopup(true);
            return;
        }
        if (layoutPopup && layoutPopup.style.display === 'block') hideLayoutPopup();
        if (tableNavPopup && tableNavPopup.style.display === 'block') hideTableNavPopup();
        if (autoColorPopup && autoColorPopup.style.display === 'flex') hideAutoColorPopup();
        showColorPopup(selectedNode, { source: 'toolbar' });
    };

    // ════════════════════════════════════════════════════════════════════
    //  SECTION 12 — First paint + state hydration from initialContext
    // ════════════════════════════════════════════════════════════════════
    //  Runs once at the end of `runErdScript`. Order of operations:
    //    1. Re-apply persisted positions / colors / zoom from
    //       initialContext (already loaded into `contextManager`).
    //    2. Run layout for any table without a persisted position so newly-
    //       added tables don't all stack at (0, 0).
    //    3. If no zoom was persisted, call `fitToScreen()` so the user
    //       sees the full diagram on first load.
    //    4. Schedule the first draw.
    //
    //  Anything you want a fresh visit to "just remember" must be pushed
    //  into `contextManager` before this section runs.
    // ════════════════════════════════════════════════════════════════════

    // Restore previously selected table if any
    if (contextManager.selectedNodeName) {
        selectedNode = schema.tables.find((t) => t.name === contextManager.selectedNodeName) || null;
    }
    refreshZoomLimits();
    if (!contextManager.hasExplicitZoomPan) {
        fitToScreen();
        schema.tables.forEach((tbl) => {
            if (typeof tbl.x === 'number' && typeof tbl.y === 'number' && !isNaN(tbl.x) && !isNaN(tbl.y)) {
                contextManager.setTablePosition(tbl.name, tbl.x, tbl.y);
            }
            if (!autoColor && !contextManager.getTableColor(tbl.name)) {
                contextManager.setTableColor(tbl.name, theme.headerBg);
            }
        });
        if (autoColor) {
            autoColorAllTables();
        }
    } else {
        clampCurrentZoomToLimits();
    }
    requestRedraw();
    updateButtonsVisibility();

    // ════════════════════════════════════════════════════════════════════
    //  SECTION 13 — Schema-change cleanup
    // ════════════════════════════════════════════════════════════════════
    //  The parent component may swap the `schema` underneath us when the
    //  user edits SQL. If the previously-selected or hovered table no
    //  longer exists in the new schema, the corresponding state would
    //  point at a phantom — this section purges it so we never try to
    //  draw a tooltip / spotlight for a missing table.
    //
    //  Persisted ContextManager fields (positions, colors) intentionally
    //  survive the cleanup so re-creating a table with the same name
    //  restores its previous look.
    // ════════════════════════════════════════════════════════════════════

    // Only clear selection for removed tables; keep positions, colors,
    // and compact modes so they survive temporary parse errors (e.g.
    // unbalanced parentheses) and are restored when the user fixes the SQL.
    const tableNames = new Set(schema.tables.map((t) => t.name));
    if (contextManager.context.selectedNodeName && !tableNames.has(contextManager.context.selectedNodeName)) {
        contextManager.context.selectedNodeName = null;
        contextManager._scheduleNotifyChange();
    }
    const validPriorityTableNames = getVisiblePriorityTableNames();
    if (validPriorityTableNames.length !== contextManager.priorityTableNames.length) {
        contextManager.setPriorityTableNames(validPriorityTableNames);
        updateButtonsVisibility();
    }

    return {
        exportPng,
        setMinimapVisible,
    };
}
