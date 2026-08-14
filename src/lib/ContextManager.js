import { normalizeConnectorEndpointSides, normalizeConnectorSide } from './erd-renderer/connectorRouting.js';

const TABLE_HEADER_TEXT_MODES = new Set(['white', 'black']);

function normalizeTableHeaderTextMode(mode) {
    if (typeof mode !== 'string') return null;
    const normalized = mode.trim().toLowerCase();
    return TABLE_HEADER_TEXT_MODES.has(normalized) ? normalized : null;
}

function normalizeTableHeaderTextModes(modes) {
    if (!modes || typeof modes !== 'object' || Array.isArray(modes)) return {};
    return Object.fromEntries(
        Object.entries(modes)
            .map(([tableName, mode]) => [tableName, normalizeTableHeaderTextMode(mode)])
            .filter(([tableName, mode]) => typeof tableName === 'string' && tableName.trim() && mode),
    );
}

/**
 * ContextManager - State Management for ERD Canvas
 * =================================================
 *
 * Manages zoom, pan, table positions, colors, compact modes, and selections
 * with validation and performance optimization.
 *
 * @version 2.0.0
 * @description Production-ready state manager with deep copy protection
 */

export default class ContextManager {
    /**
     * Initialize ContextManager
     * @param {Object} initialContext - Initial context to restore from
     * @param {Function} onContextChange - Callback when context changes
     */
    constructor(initialContext, onContextChange) {
        this.context = {
            tablePositions: {},
            tableColors: {},
            tableHeaderTextModes: {},
            tableCompactModes: {},
            connectorEndpointSides: {},
            zoom: undefined,
            offsetX: undefined,
            offsetY: undefined,
            selectedNodeName: null,
            priorityTableNames: [],
            ...(initialContext || {}),
        };

        // Backward compatibility: ensure nested objects exist
        if (!this.context.tablePositions) this.context.tablePositions = {};
        if (!this.context.tableColors) this.context.tableColors = {};
        this.context.tableHeaderTextModes = normalizeTableHeaderTextModes(this.context.tableHeaderTextModes);
        if (!this.context.tableCompactModes) this.context.tableCompactModes = {};
        this.context.connectorEndpointSides = normalizeConnectorEndpointSides(this.context.connectorEndpointSides);
        this.context.priorityTableNames = this._normalizeTableNameList(this.context.priorityTableNames);

        this.onContextChange = onContextChange;
        this._pendingNotification = false;
    }

    // ===== GETTER METHODS =====

    get zoom() {
        return this.context.zoom ?? 1;
    }

    get offsetX() {
        return this.context.offsetX ?? 0;
    }

    get offsetY() {
        return this.context.offsetY ?? 0;
    }

    get hasExplicitZoomPan() {
        return typeof this.context.zoom === 'number' && !isNaN(this.context.zoom) && typeof this.context.offsetX === 'number' && !isNaN(this.context.offsetX) && typeof this.context.offsetY === 'number' && !isNaN(this.context.offsetY);
    }

    get selectedNodeName() {
        return this.context.selectedNodeName;
    }

    get priorityTableNames() {
        return this.context.priorityTableNames || [];
    }

    get layoutMode() {
        return this.context.layoutMode;
    }

    get tablePositions() {
        return this.context.tablePositions;
    }

    get tableColors() {
        return this.context.tableColors;
    }

    get tableHeaderTextModes() {
        return this.context.tableHeaderTextModes;
    }

    get tableCompactModes() {
        return this.context.tableCompactModes || {};
    }

    get connectorEndpointSides() {
        return this.context.connectorEndpointSides || {};
    }

    // ===== SETTER METHODS =====

    setZoom(value) {
        if (value !== undefined && (typeof value !== 'number' || isNaN(value) || value <= 0)) {
            return false;
        }

        if (this.context.zoom !== value) {
            this.context.zoom = value;
            this._scheduleNotifyChange();
        }
        return true;
    }

    setOffset(x, y) {
        const validX = x === undefined || (typeof x === 'number' && !isNaN(x));
        const validY = y === undefined || (typeof y === 'number' && !isNaN(y));

        if (!validX || !validY) {
            return false;
        }

        if (this.context.offsetX !== x || this.context.offsetY !== y) {
            this.context.offsetX = x;
            this.context.offsetY = y;
            this._scheduleNotifyChange();
        }
        return true;
    }

    setOffsetX(value) {
        if (value !== undefined && (typeof value !== 'number' || isNaN(value))) {
            return false;
        }

        if (this.context.offsetX !== value) {
            this.context.offsetX = value;
            this._scheduleNotifyChange();
        }
        return true;
    }

    setOffsetY(value) {
        if (value !== undefined && (typeof value !== 'number' || isNaN(value))) {
            return false;
        }

        if (this.context.offsetY !== value) {
            this.context.offsetY = value;
            this._scheduleNotifyChange();
        }
        return true;
    }

    setSelectedNode(nodeName) {
        if (nodeName !== null && typeof nodeName !== 'string') {
            return false;
        }

        if (this.context.selectedNodeName !== nodeName) {
            this.context.selectedNodeName = nodeName;
            this._scheduleNotifyChange();
        }
        return true;
    }

    setPriorityTableNames(tableNames) {
        const normalized = this._normalizeTableNameList(tableNames);
        if (!Array.isArray(tableNames)) {
            return false;
        }

        if (JSON.stringify(this.context.priorityTableNames || []) !== JSON.stringify(normalized)) {
            this.context.priorityTableNames = normalized;
            this._scheduleNotifyChange();
        }
        return true;
    }

    togglePriorityTableName(tableName) {
        if (typeof tableName !== 'string' || !tableName.trim()) {
            return false;
        }

        const normalizedName = tableName.trim();
        const current = new Set(this.priorityTableNames);
        if (current.has(normalizedName)) current.delete(normalizedName);
        else current.add(normalizedName);
        return this.setPriorityTableNames([...current]);
    }

    clearPriorityTableNames() {
        return this.setPriorityTableNames([]);
    }

    setLayoutMode(layoutMode) {
        if (layoutMode !== undefined && (typeof layoutMode !== 'string' || !layoutMode.trim())) {
            return false;
        }

        const normalizedMode = typeof layoutMode === 'string' ? layoutMode.trim() : undefined;
        if (this.context.layoutMode !== normalizedMode) {
            this.context.layoutMode = normalizedMode;
            this._scheduleNotifyChange();
        }
        return true;
    }

    setTablePosition(tableName, x, y) {
        if (typeof tableName !== 'string' || !tableName.trim()) {
            return false;
        }

        if (typeof x !== 'number' || typeof y !== 'number' || isNaN(x) || isNaN(y)) {
            return false;
        }

        const currentPos = this.context.tablePositions[tableName];
        if (!currentPos || currentPos.x !== x || currentPos.y !== y) {
            this.context.tablePositions[tableName] = { x, y };
            this._scheduleNotifyChange();
        }
        return true;
    }

    setTableColor(tableName, color) {
        if (typeof tableName !== 'string' || !tableName.trim()) {
            return false;
        }

        if (typeof color !== 'string' || !color.trim()) {
            return false;
        }

        if (this.context.tableColors[tableName] !== color) {
            this.context.tableColors[tableName] = color;
            this._scheduleNotifyChange();
        }
        return true;
    }

    setTableHeaderTextMode(tableName, mode) {
        if (typeof tableName !== 'string' || !tableName.trim()) return false;
        if (typeof mode === 'string' && mode.trim().toLowerCase() === 'auto') return this.clearTableHeaderTextMode(tableName);
        const normalizedMode = normalizeTableHeaderTextMode(mode);
        if (!normalizedMode) return false;

        if (this.context.tableHeaderTextModes[tableName] !== normalizedMode) {
            this.context.tableHeaderTextModes[tableName] = normalizedMode;
            this._scheduleNotifyChange();
        }
        return true;
    }

    clearTableHeaderTextMode(tableName) {
        if (typeof tableName !== 'string' || !tableName.trim()) return false;
        if (Object.prototype.hasOwnProperty.call(this.context.tableHeaderTextModes, tableName)) {
            delete this.context.tableHeaderTextModes[tableName];
            this._scheduleNotifyChange();
        }
        return true;
    }

    setTableCompactMode(tableName, isCompact) {
        if (typeof tableName !== 'string' || !tableName.trim()) {
            return false;
        }

        if (typeof isCompact !== 'boolean') {
            return false;
        }

        if (!this.context.tableCompactModes) {
            this.context.tableCompactModes = {};
        }

        // Convert to boolean for proper comparison (handles undefined vs false)
        const currentValue = !!this.context.tableCompactModes[tableName];

        if (currentValue !== isCompact) {
            this.context.tableCompactModes[tableName] = isCompact;
            this._scheduleNotifyChange();
        }
        return true;
    }

    setConnectorEndpointSide(relationKey, endpoint, side) {
        if (typeof relationKey !== 'string' || !relationKey.trim() || !['from', 'to'].includes(endpoint)) return false;
        const normalizedSide = normalizeConnectorSide(side);
        if (!normalizedSide) return false;

        const current = this.context.connectorEndpointSides[relationKey] || {};
        if (current[endpoint] !== normalizedSide) {
            this.context.connectorEndpointSides[relationKey] = { ...current, [endpoint]: normalizedSide };
            this._scheduleNotifyChange();
        }
        return true;
    }

    clearConnectorEndpointSide(relationKey, endpoint) {
        if (typeof relationKey !== 'string' || !relationKey.trim() || !['from', 'to'].includes(endpoint)) return false;
        const current = this.context.connectorEndpointSides[relationKey];
        if (!current || !current[endpoint]) return true;

        const next = { ...current };
        delete next[endpoint];
        if (Object.keys(next).length > 0) this.context.connectorEndpointSides[relationKey] = next;
        else delete this.context.connectorEndpointSides[relationKey];
        this._scheduleNotifyChange();
        return true;
    }

    // ===== GETTER METHODS FOR TABLE DATA =====

    getTablePosition(tableName) {
        return this.context.tablePositions[tableName];
    }

    getTableColor(tableName) {
        return this.context.tableColors[tableName];
    }

    getTableHeaderTextMode(tableName) {
        return this.context.tableHeaderTextModes[tableName] || 'auto';
    }

    getTableCompactMode(tableName) {
        return !!(this.context.tableCompactModes && this.context.tableCompactModes[tableName]);
    }

    getConnectorEndpointSides(relationKey) {
        if (typeof relationKey !== 'string' || !relationKey.trim()) return {};
        return this.context.connectorEndpointSides[relationKey] || {};
    }

    isPriorityTableName(tableName) {
        return this.priorityTableNames.includes(tableName);
    }

    // ===== BATCH OPERATIONS =====

    batchUpdate(updates) {
        if (!updates || typeof updates !== 'object') {
            return false;
        }

        let hasChanges = false;
        const allowedKeys = ['zoom', 'offsetX', 'offsetY', 'selectedNodeName', 'priorityTableNames', 'layoutMode', 'tablePositions', 'tableColors', 'tableHeaderTextModes', 'tableCompactModes', 'connectorEndpointSides'];

        Object.keys(updates).forEach((key) => {
            if (!allowedKeys.includes(key)) return;

            const newValue = updates[key];

            // Mirror the per-field setter validation so a corrupted
            // persisted payload (zoom = 0, offsetX = NaN, ...) can never
            // poison the in-memory state. Without this, getTouchPos /
            // screenToWorld divide by zero and the canvas freezes — a real
            // failure mode after a user mashes the wheel during a layout
            // swap and the resulting context blob is reloaded next mount.
            if (key === 'zoom') {
                if (typeof newValue !== 'number' || !isFinite(newValue) || newValue <= 0) return;
            } else if (key === 'offsetX' || key === 'offsetY') {
                if (typeof newValue !== 'number' || !isFinite(newValue)) return;
            } else if (key === 'priorityTableNames') {
                if (!Array.isArray(newValue)) return;
            }

            if (key === 'connectorEndpointSides') {
                const normalizedSides = normalizeConnectorEndpointSides(newValue);
                if (JSON.stringify(this.context.connectorEndpointSides) !== JSON.stringify(normalizedSides)) {
                    this.context.connectorEndpointSides = normalizedSides;
                    hasChanges = true;
                }
            } else if (key === 'tableHeaderTextModes') {
                if (typeof newValue === 'object' && newValue !== null && !Array.isArray(newValue)) {
                    Object.entries(normalizeTableHeaderTextModes(newValue)).forEach(([tableName, mode]) => {
                        if (this.context.tableHeaderTextModes[tableName] !== mode) {
                            this.context.tableHeaderTextModes[tableName] = mode;
                            hasChanges = true;
                        }
                    });
                }
            } else if (key === 'tablePositions' || key === 'tableColors' || key === 'tableCompactModes') {
                if (typeof newValue === 'object' && newValue !== null) {
                    if (!this.context[key]) this.context[key] = {};
                    Object.keys(newValue).forEach((subKey) => {
                        if (JSON.stringify(this.context[key][subKey]) !== JSON.stringify(newValue[subKey])) {
                            this.context[key][subKey] = newValue[subKey];
                            hasChanges = true;
                        }
                    });
                }
            } else {
                const valueToStore = key === 'priorityTableNames' ? this._normalizeTableNameList(newValue) : newValue;
                if (JSON.stringify(this.context[key]) !== JSON.stringify(valueToStore)) {
                    this.context[key] = valueToStore;
                    hasChanges = true;
                }
            }
        });

        if (hasChanges) {
            this._scheduleNotifyChange();
        }
        return true;
    }

    bulkSetTablePositions(positions) {
        if (!positions || typeof positions !== 'object') {
            return false;
        }

        let hasChanges = false;
        Object.keys(positions).forEach((tableName) => {
            const { x, y } = positions[tableName];
            if (typeof x === 'number' && typeof y === 'number' && !isNaN(x) && !isNaN(y)) {
                const currentPos = this.context.tablePositions[tableName];
                if (!currentPos || currentPos.x !== x || currentPos.y !== y) {
                    this.context.tablePositions[tableName] = { x, y };
                    hasChanges = true;
                }
            }
        });

        if (hasChanges) {
            this._scheduleNotifyChange();
        }
        return true;
    }

    bulkSetTableColors(colors) {
        if (!colors || typeof colors !== 'object') {
            return false;
        }

        let hasChanges = false;
        Object.keys(colors).forEach((tableName) => {
            const color = colors[tableName];
            if (typeof color === 'string' && color.trim()) {
                if (this.context.tableColors[tableName] !== color) {
                    this.context.tableColors[tableName] = color;
                    hasChanges = true;
                }
            }
        });

        if (hasChanges) {
            this._scheduleNotifyChange();
        }
        return true;
    }

    // ===== RESET OPERATIONS =====

    resetPositions() {
        if (Object.keys(this.context.tablePositions).length > 0) {
            this.context.tablePositions = {};
            this._scheduleNotifyChange();
        }
    }

    resetZoomPan() {
        const hasChanges = this.context.zoom !== undefined || this.context.offsetX !== undefined || this.context.offsetY !== undefined;

        if (hasChanges) {
            this.context.zoom = undefined;
            this.context.offsetX = undefined;
            this.context.offsetY = undefined;
            this._scheduleNotifyChange();
        }
    }

    clearAllTableHeaderTextModes() {
        if (Object.keys(this.context.tableHeaderTextModes).length > 0) {
            this.context.tableHeaderTextModes = {};
            this._scheduleNotifyChange();
        }
        return true;
    }

    removeTableData(tableName) {
        if (typeof tableName !== 'string' || !tableName.trim()) {
            return false;
        }

        let hasChanges = false;

        if (this.context.tablePositions[tableName]) {
            delete this.context.tablePositions[tableName];
            hasChanges = true;
        }

        if (this.context.tableColors[tableName]) {
            delete this.context.tableColors[tableName];
            hasChanges = true;
        }

        if (this.context.tableHeaderTextModes[tableName]) {
            delete this.context.tableHeaderTextModes[tableName];
            hasChanges = true;
        }

        if (this.context.tableCompactModes && this.context.tableCompactModes[tableName]) {
            delete this.context.tableCompactModes[tableName];
            hasChanges = true;
        }

        if (this.context.selectedNodeName === tableName) {
            this.context.selectedNodeName = null;
            hasChanges = true;
        }

        if ((this.context.priorityTableNames || []).includes(tableName)) {
            this.context.priorityTableNames = this.context.priorityTableNames.filter((name) => name !== tableName);
            hasChanges = true;
        }

        if (hasChanges) {
            this._scheduleNotifyChange();
        }
        return true;
    }

    // ===== UTILITY METHODS =====

    getFullContext() {
        return { ...this.context };
    }

    // ===== PRIVATE METHODS =====

    _normalizeTableNameList(tableNames) {
        if (!Array.isArray(tableNames)) return [];

        const unique = [];
        const seen = new Set();
        tableNames.forEach((tableName) => {
            if (typeof tableName !== 'string') return;
            const normalizedName = tableName.trim();
            if (!normalizedName || seen.has(normalizedName)) return;
            seen.add(normalizedName);
            unique.push(normalizedName);
        });
        return unique;
    }

    _scheduleNotifyChange() {
        if (this._pendingNotification) return;

        this._pendingNotification = true;

        const scheduler = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : (cb) => setTimeout(cb, 0);

        scheduler(() => {
            this._pendingNotification = false;
            this._notifyChange();
        });
    }

    _notifyChange() {
        if (!this.onContextChange) return;

        // CRITICAL: Send DEEP COPY to prevent reference pollution
        // Shallow copy causes nested objects to share references,
        // leading to comparison bugs when detecting changes
        try {
            const deepCopy = JSON.parse(JSON.stringify(this.context));
            this.onContextChange(deepCopy);
        } catch {
            // Fallback to shallow copy if deep copy fails
            this.onContextChange({ ...this.context });
        }
    }
}
