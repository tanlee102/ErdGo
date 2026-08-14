const COLOR_PRESETS = Object.freeze({
    bright: Object.freeze({
        identity: Object.freeze(['#5F62F0', '#8050F2', '#3B82F6', '#A145F3']),
        commerce: Object.freeze(['#3B82F6', '#0EA5E9', '#06B6D4', '#14B8A6']),
        finance: Object.freeze(['#10B981', '#14B8A6', '#22C55E', '#84CC16']),
        operations: Object.freeze(['#F97316', '#F59E0B', '#EF4444', '#F43F5E']),
        analytics: Object.freeze(['#0EA5E9', '#5F62F0', '#06B6D4', '#8050F2']),
        communication: Object.freeze(['#EC4899', '#F43F5E', '#D946EF', '#A145F3']),
        content: Object.freeze(['#A145F3', '#D946EF', '#5F62F0', '#EC4899']),
        geography: Object.freeze(['#14B8A6', '#06B6D4', '#10B981', '#0EA5E9']),
    }),
    balanced: Object.freeze({
        identity: Object.freeze(['#4F46E5', '#7C3AED', '#2563EB', '#6D28D9']),
        commerce: Object.freeze(['#2563EB', '#0369A1', '#0E7490', '#0F766E']),
        finance: Object.freeze(['#047857', '#0F766E', '#15803D', '#166534']),
        operations: Object.freeze(['#C2410C', '#B45309', '#DC2626', '#BE123C']),
        analytics: Object.freeze(['#0369A1', '#4F46E5', '#0E7490', '#6D28D9']),
        communication: Object.freeze(['#DB2777', '#E11D48', '#A21CAF', '#7C3AED']),
        content: Object.freeze(['#7C3AED', '#A21CAF', '#4F46E5', '#BE185D']),
        geography: Object.freeze(['#0F766E', '#0E7490', '#047857', '#0369A1']),
    }),
    deep: Object.freeze({
        identity: Object.freeze(['#312E81', '#3730A3', '#4C1D95', '#1E3A8A']),
        commerce: Object.freeze(['#1E40AF', '#075985', '#155E75', '#115E59']),
        finance: Object.freeze(['#065F46', '#115E59', '#166534', '#3F6212']),
        operations: Object.freeze(['#9A3412', '#92400E', '#991B1B', '#9F1239']),
        analytics: Object.freeze(['#1E3A8A', '#312E81', '#164E63', '#4C1D95']),
        communication: Object.freeze(['#9D174D', '#9F1239', '#701A75', '#581C87']),
        content: Object.freeze(['#581C87', '#701A75', '#312E81', '#9D174D']),
        geography: Object.freeze(['#115E59', '#155E75', '#065F46', '#075985']),
    }),
});

const FAMILY_NAMES = Object.freeze(Object.keys(COLOR_PRESETS.balanced));
const DEFAULT_PALETTE_MODE = 'bright';

function getColorPreset(mode) {
    return COLOR_PRESETS[mode] || COLOR_PRESETS[DEFAULT_PALETTE_MODE];
}

const DOMAIN_KEYWORDS = Object.freeze({
    identity: new Set(['auth', 'user', 'account', 'identity', 'role', 'permission', 'tenant', 'team', 'member', 'session', 'token', 'credential', 'profile', 'login', 'security', 'access']),
    commerce: new Set(['commerce', 'order', 'cart', 'product', 'catalog', 'inventory', 'shipment', 'fulfillment', 'customer', 'store', 'sku', 'line', 'item', 'purchase']),
    finance: new Set(['finance', 'billing', 'payment', 'invoice', 'transaction', 'ledger', 'price', 'pricing', 'subscription', 'plan', 'currency', 'tax', 'refund', 'credit', 'balance']),
    operations: new Set(['operation', 'job', 'queue', 'worker', 'task', 'workflow', 'deploy', 'release', 'config', 'setting', 'feature', 'flag', 'webhook', 'integration', 'system']),
    analytics: new Set(['analytics', 'report', 'reporting', 'event', 'metric', 'measure', 'log', 'audit', 'history', 'tracking', 'stat', 'warehouse', 'fact', 'dimension']),
    communication: new Set(['message', 'chat', 'conversation', 'notification', 'email', 'sms', 'comment', 'like', 'follow', 'social', 'contact', 'inbox']),
    content: new Set(['content', 'post', 'article', 'page', 'document', 'file', 'asset', 'media', 'image', 'video', 'category', 'tag', 'attachment']),
    geography: new Set(['address', 'location', 'country', 'region', 'city', 'geo', 'map', 'coordinate', 'zone', 'place']),
});

const JUNCTION_KEYWORDS = new Set(['junction', 'join', 'link', 'map', 'member', 'membership', 'association', 'assignment', 'bridge', 'relation', 'xref']);

function stableHash(value) {
    let hash = 2166136261;
    const text = String(value || '');
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function singularizeToken(token) {
    if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
    if (token.length > 4 && token.endsWith('ses')) return token.slice(0, -2);
    if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
    return token;
}

export function tokenizeSchemaName(value) {
    const cleaned = String(value || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[`"\[\]]/g, '')
        .toLowerCase();
    const tokens = cleaned.split(/[^a-z0-9]+/).filter(Boolean);
    return [...new Set(tokens.flatMap((token) => [token, singularizeToken(token)]))];
}

function parseColor(color) {
    const value = String(color || '').trim();
    const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value);
    if (hexMatch) {
        const hex = hexMatch[1];
        if (hex.length === 3) {
            return {
                r: Number.parseInt(hex[0] + hex[0], 16),
                g: Number.parseInt(hex[1] + hex[1], 16),
                b: Number.parseInt(hex[2] + hex[2], 16),
                a: 1,
            };
        }
        return {
            r: Number.parseInt(hex.slice(0, 2), 16),
            g: Number.parseInt(hex.slice(2, 4), 16),
            b: Number.parseInt(hex.slice(4, 6), 16),
            a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
        };
    }

    const rgbMatch = /^rgba?\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s*,\s*(-?\d+(?:\.\d+)?))?\s*\)$/i.exec(value);
    if (!rgbMatch) return null;
    return {
        r: Math.max(0, Math.min(255, Number(rgbMatch[1]))),
        g: Math.max(0, Math.min(255, Number(rgbMatch[2]))),
        b: Math.max(0, Math.min(255, Number(rgbMatch[3]))),
        a: Math.max(0, Math.min(1, rgbMatch[4] === undefined ? 1 : Number(rgbMatch[4]))),
    };
}

function flattenColor(color, backdrop = '#FFFFFF') {
    const parsed = typeof color === 'string' ? parseColor(color) : color;
    if (!parsed) return null;
    if (parsed.a === undefined || parsed.a >= 1) return { r: parsed.r, g: parsed.g, b: parsed.b, a: 1 };
    const parsedBackdrop = typeof backdrop === 'string' ? parseColor(backdrop) : backdrop;
    const opaqueBackdrop = parsedBackdrop ? flattenColor(parsedBackdrop, '#FFFFFF') : { r: 255, g: 255, b: 255, a: 1 };
    return {
        r: parsed.r * parsed.a + opaqueBackdrop.r * (1 - parsed.a),
        g: parsed.g * parsed.a + opaqueBackdrop.g * (1 - parsed.a),
        b: parsed.b * parsed.a + opaqueBackdrop.b * (1 - parsed.a),
        a: 1,
    };
}

function getRelativeLuminance(rgb) {
    if (!rgb) return 0;
    const channel = (value) => {
        const normalized = value / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    return channel(rgb.r) * 0.2126 + channel(rgb.g) * 0.7152 + channel(rgb.b) * 0.0722;
}

function getContrastRatioFromLuminances(first, second) {
    const lighter = Math.max(first, second);
    const darker = Math.min(first, second);
    return (lighter + 0.05) / (darker + 0.05);
}

export function getColorContrastRatio(foreground, background) {
    const resolvedBackground = flattenColor(background, '#FFFFFF');
    const resolvedForeground = flattenColor(foreground, resolvedBackground);
    const first = getRelativeLuminance(resolvedForeground);
    const second = getRelativeLuminance(resolvedBackground);
    return getContrastRatioFromLuminances(first, second);
}

function getPaintStops(color, backdrop) {
    const value = String(color || '').trim();
    const rawStops = value.startsWith('gradient:') ? value.slice('gradient:'.length).split(':') : [value];
    return rawStops.map((stop) => flattenColor(stop, backdrop)).filter(Boolean);
}

function compositeColor(background, overlay, alpha) {
    const backgroundRgb = typeof background === 'string' ? flattenColor(background) : background;
    const overlayRgb = typeof overlay === 'string' ? flattenColor(overlay) : overlay;
    if (!backgroundRgb || !overlayRgb) return backgroundRgb;
    const blend = (backgroundChannel, overlayChannel) => Math.round(Math.max(0, Math.min(255, backgroundChannel * (1 - alpha) + overlayChannel * alpha)));
    return {
        r: blend(backgroundRgb.r, overlayRgb.r),
        g: blend(backgroundRgb.g, overlayRgb.g),
        b: blend(backgroundRgb.b, overlayRgb.b),
        a: 1,
    };
}

function interpolateColor(first, second, amount) {
    return {
        r: first.r * (1 - amount) + second.r * amount,
        g: first.g * (1 - amount) + second.g * amount,
        b: first.b * (1 - amount) + second.b * amount,
        a: 1,
    };
}

function getPaintSamples(color, backdrop) {
    const stops = getPaintStops(color, backdrop);
    if (stops.length <= 1) return stops;
    const samples = [];
    const samplesPerSegment = 32;
    for (let stopIndex = 1; stopIndex < stops.length; stopIndex += 1) {
        const first = stops[stopIndex - 1];
        const second = stops[stopIndex];
        for (let sampleIndex = stopIndex === 1 ? 0 : 1; sampleIndex <= samplesPerSegment; sampleIndex += 1) {
            samples.push(interpolateColor(first, second, sampleIndex / samplesPerSegment));
        }
    }
    return samples;
}

const TABLE_TEXT_CONTRAST_TARGET = 4.75;
const WHITE_TEXT_SWITCH_CONTRAST = 4.5;
const TABLE_TEXT_INKS = Object.freeze(['#000000', '#FFFFFF']);
const TABLE_HEADER_TREATMENT_CACHE = new Map();
const TABLE_HEADER_TREATMENT_CACHE_LIMIT = 512;

/**
 * Prefers white table text and switches to black only when the unadjusted
 * paint is too bright for white to meet WCAG AA. For mixed-luminance
 * gradients, computes the smallest neutral scrim needed for the chosen ink.
 * The 4.75 target leaves a small safety margin over WCAG AA's 4.5:1 floor.
 */
export function getTableHeaderContrastTreatment(color, minimumContrast = TABLE_TEXT_CONTRAST_TARGET, backdrop = '#FFFFFF', requestedTextColor = null) {
    const normalizedRequestedTextColor = TABLE_TEXT_INKS.includes(String(requestedTextColor || '').trim().toUpperCase()) ? String(requestedTextColor).trim().toUpperCase() : null;
    const cacheKey = `${String(color || '').trim().toLowerCase()}|${minimumContrast}|${String(backdrop || '').trim().toLowerCase()}|${normalizedRequestedTextColor || 'auto'}`;
    const cached = TABLE_HEADER_TREATMENT_CACHE.get(cacheKey);
    if (cached) return cached;

    const stops = getPaintSamples(color, backdrop);
    if (stops.length === 0) return getTableHeaderContrastTreatment(backdrop, minimumContrast, '#FFFFFF', normalizedRequestedTextColor);

    const treatments = TABLE_TEXT_INKS.map((textColor) => {
        const overlayColor = textColor === '#FFFFFF' ? '#000000' : '#FFFFFF';
        const textLuminance = getRelativeLuminance(flattenColor(textColor));
        const overlayRgb = flattenColor(overlayColor);
        const getMinimumContrast = (alpha) => {
            let minimum = Number.POSITIVE_INFINITY;
            for (const stop of stops) {
                const backgroundLuminance = getRelativeLuminance(compositeColor(stop, overlayRgb, alpha));
                minimum = Math.min(minimum, getContrastRatioFromLuminances(textLuminance, backgroundLuminance));
            }
            return minimum;
        };
        const unadjustedContrast = getMinimumContrast(0);
        if (unadjustedContrast >= minimumContrast) {
            return { textColor, overlayColor, overlayAlpha: 0, minimumContrast: unadjustedContrast, unadjustedContrast };
        }

        let low = 0;
        let high = 1;
        for (let iteration = 0; iteration < 14; iteration += 1) {
            const midpoint = (low + high) / 2;
            if (getMinimumContrast(midpoint) >= minimumContrast) high = midpoint;
            else low = midpoint;
        }
        return { textColor, overlayColor, overlayAlpha: high, minimumContrast: getMinimumContrast(high), unadjustedContrast };
    });

    const whiteTreatment = treatments.find((treatment) => treatment.textColor === '#FFFFFF');
    const blackTreatment = treatments.find((treatment) => treatment.textColor === '#000000');
    let treatment;
    if (normalizedRequestedTextColor) treatment = treatments.find((candidate) => candidate.textColor === normalizedRequestedTextColor);
    else treatment = whiteTreatment.unadjustedContrast >= WHITE_TEXT_SWITCH_CONTRAST ? whiteTreatment : blackTreatment;
    if (TABLE_HEADER_TREATMENT_CACHE.size >= TABLE_HEADER_TREATMENT_CACHE_LIMIT) {
        TABLE_HEADER_TREATMENT_CACHE.delete(TABLE_HEADER_TREATMENT_CACHE.keys().next().value);
    }
    TABLE_HEADER_TREATMENT_CACHE.set(cacheKey, treatment);
    return treatment;
}

export function getReadableTableTextColor(color, backdrop = '#FFFFFF') {
    return getTableHeaderContrastTreatment(color, TABLE_TEXT_CONTRAST_TARGET, backdrop).textColor;
}

function colorDistance(firstColor, secondColor) {
    const first = parseColor(firstColor);
    const second = parseColor(secondColor);
    if (!first || !second) return 0;
    const redMean = (first.r + second.r) / 2;
    const red = first.r - second.r;
    const green = first.g - second.g;
    const blue = first.b - second.b;
    // Red-mean distance tracks perceived RGB differences better than plain
    // Euclidean distance while remaining tiny enough for interactive use.
    return Math.sqrt((2 + redMean / 256) * red * red + 4 * green * green + (2 + (255 - redMean) / 256) * blue * blue);
}

function getLeafName(value) {
    const parts = String(value || '').split('.');
    return parts[parts.length - 1] || '';
}

function createTableResolver(tables) {
    const exact = new Map(tables.map((table) => [table.name, table.name]));
    const leafNames = new Map();
    tables.forEach((table) => {
        const leaf = getLeafName(table.name).toLowerCase();
        if (!leafNames.has(leaf)) leafNames.set(leaf, []);
        leafNames.get(leaf).push(table.name);
    });
    return (name) => {
        if (exact.has(name)) return exact.get(name);
        const matches = leafNames.get(getLeafName(name).toLowerCase()) || [];
        return matches.length === 1 ? matches[0] : null;
    };
}

function normalizeConfidence(value) {
    if (!Number.isFinite(value)) return 0;
    return value <= 1 ? Math.max(0, Math.min(1, value)) : Math.max(0, Math.min(1, value / 100));
}

function getRelationWeight(relation, inferred) {
    if (!inferred) return 10;
    const confidence = normalizeConfidence(relation?.confidence);
    if (relation?.inferenceStatus === 'accepted') return 4 + confidence * 3;
    if (confidence >= 0.85) return 2 + confidence * 2;
    if (confidence >= 0.7) return 1 + confidence;
    return 0;
}

function buildRelationshipGraph(tables, relations, inferredRelations) {
    const resolveTable = createTableResolver(tables);
    const graph = new Map(tables.map((table) => [table.name, new Map()]));
    const relationColumns = new Map(tables.map((table) => [table.name, new Set()]));

    const addRelations = (items, inferred) => {
        (Array.isArray(items) ? items : []).forEach((relation) => {
            const from = resolveTable(relation?.from?.table);
            const to = resolveTable(relation?.to?.table);
            const weight = getRelationWeight(relation, inferred);
            if (!from || !to || weight <= 0) return;
            if (relation?.from?.column) relationColumns.get(from)?.add(relation.from.column);
            if (relation?.to?.column) relationColumns.get(to)?.add(relation.to.column);
            if (from === to) return;
            graph.get(from).set(to, (graph.get(from).get(to) || 0) + weight);
            graph.get(to).set(from, (graph.get(to).get(from) || 0) + weight);
        });
    };

    addRelations(relations, false);
    addRelations(inferredRelations, true);
    return { graph, relationColumns };
}

function getSemanticScores(table) {
    const scores = Object.fromEntries(FAMILY_NAMES.map((family) => [family, 0]));
    const nameParts = String(table?.name || '').split('.');
    const leafTokens = tokenizeSchemaName(nameParts.pop());
    const namespaceTokens = tokenizeSchemaName(nameParts.join('.'));
    const columnTokens = (Array.isArray(table?.columns) ? table.columns : []).flatMap((column) => tokenizeSchemaName(column?.name));

    FAMILY_NAMES.forEach((family) => {
        const keywords = DOMAIN_KEYWORDS[family];
        leafTokens.forEach((token) => {
            if (keywords.has(token)) scores[family] += 4;
        });
        namespaceTokens.forEach((token) => {
            if (keywords.has(token)) scores[family] += 3;
        });
        columnTokens.forEach((token) => {
            if (keywords.has(token)) scores[family] += 0.2;
        });
    });
    return scores;
}

function getBestFamily(scores, fallbackKey) {
    const ranked = FAMILY_NAMES.map((family) => ({ family, score: scores?.[family] || 0 })).sort((first, second) => second.score - first.score || first.family.localeCompare(second.family));
    if (ranked[0]?.score > 0) return ranked[0].family;
    return FAMILY_NAMES[stableHash(fallbackKey) % FAMILY_NAMES.length];
}

function getComponents(tableNames, graph) {
    const unseen = new Set(tableNames);
    const components = [];
    while (unseen.size > 0) {
        const start = [...unseen].sort((a, b) => a.localeCompare(b))[0];
        const stack = [start];
        const component = [];
        unseen.delete(start);
        while (stack.length > 0) {
            const current = stack.pop();
            component.push(current);
            [...(graph.get(current)?.keys() || [])]
                .sort((a, b) => b.localeCompare(a))
                .forEach((neighbor) => {
                    if (!unseen.has(neighbor)) return;
                    unseen.delete(neighbor);
                    stack.push(neighbor);
                });
        }
        components.push(component.sort((a, b) => a.localeCompare(b)));
    }
    return components;
}

function chooseNodeColor({ tableName, preferredFamily, componentFamily, assigned, graph, componentUsage, componentSize, colorFamilies }) {
    const preferred = colorFamilies[preferredFamily];
    const component = colorFamilies[componentFamily];
    const candidates = [...new Set([...preferred, ...component])];
    const directNeighborNames = [...(graph.get(tableName)?.keys() || [])];
    const neighborColors = directNeighborNames.map((neighbor) => assigned.get(neighbor)).filter(Boolean);
    const directNeighborSet = new Set(directNeighborNames);
    const nearbyColors = directNeighborNames
        .flatMap((neighbor) => [...(graph.get(neighbor)?.keys() || [])])
        .filter((nearbyName) => nearbyName !== tableName && !directNeighborSet.has(nearbyName))
        .map((nearbyName) => assigned.get(nearbyName))
        .filter(Boolean);

    if (componentSize === 1) {
        return preferred[stableHash(tableName) % preferred.length];
    }

    return candidates
        .map((color, index) => {
            const distances = neighborColors.map((neighborColor) => colorDistance(color, neighborColor));
            const nearbyDistances = nearbyColors.map((nearbyColor) => colorDistance(color, nearbyColor));
            const minimumDistance = distances.length > 0 ? Math.min(...distances) : 0;
            const averageDistance = distances.length > 0 ? distances.reduce((sum, value) => sum + value, 0) / distances.length : 0;
            const nearbyMinimumDistance = nearbyDistances.length > 0 ? Math.min(...nearbyDistances) : 0;
            const preferredIndex = preferred.indexOf(color);
            const componentIndex = component.indexOf(color);
            const semanticScore = preferredIndex >= 0 ? 70 - preferredIndex * 6 : componentIndex >= 0 ? 28 - componentIndex * 3 : 0;
            const collisionPenalty = neighborColors.includes(color) ? 1000 : 0;
            const nearbyCollisionPenalty = nearbyColors.includes(color) ? 240 : 0;
            const usagePenalty = (componentUsage.get(color) || 0) * 4;
            const stableTieBreak = (stableHash(`${tableName}:${color}`) % 1000) / 1000;
            return {
                color,
                index,
                score: semanticScore + minimumDistance * 0.24 + averageDistance * 0.06 + nearbyMinimumDistance * 0.08 - collisionPenalty - nearbyCollisionPenalty - usagePenalty + stableTieBreak,
            };
        })
        .sort((first, second) => second.score - first.score || first.index - second.index)[0].color;
}

function colorComponent(component, graph, preferredFamilies, componentFamily, assigned, colorFamilies) {
    const remaining = new Set(component);
    const usage = new Map();
    while (remaining.size > 0) {
        const nextName = [...remaining]
            .map((name) => {
                const neighbors = graph.get(name) || new Map();
                const coloredNeighborColors = new Set([...neighbors.keys()].map((neighbor) => assigned.get(neighbor)).filter(Boolean));
                const weightedDegree = [...neighbors.values()].reduce((sum, weight) => sum + weight, 0);
                return { name, saturation: coloredNeighborColors.size, weightedDegree };
            })
            .sort((first, second) => second.saturation - first.saturation || second.weightedDegree - first.weightedDegree || first.name.localeCompare(second.name))[0].name;

        const color = chooseNodeColor({
            tableName: nextName,
            preferredFamily: preferredFamilies.get(nextName),
            componentFamily,
            assigned,
            graph,
            componentUsage: usage,
            componentSize: component.length,
            colorFamilies,
        });
        assigned.set(nextName, color);
        usage.set(color, (usage.get(color) || 0) + 1);
        remaining.delete(nextName);
    }
}

function isJunctionTable(table, graph, relationColumns) {
    const neighbors = graph.get(table.name) || new Map();
    if (neighbors.size < 2) return false;
    const columns = Array.isArray(table.columns) ? table.columns : [];
    const relatedColumns = relationColumns.get(table.name)?.size || 0;
    const hasJunctionName = tokenizeSchemaName(getLeafName(table.name)).some((token) => JUNCTION_KEYWORDS.has(token));
    const relationDensity = columns.length > 0 ? relatedColumns / columns.length : 0;
    return hasJunctionName || (columns.length <= 8 && relatedColumns >= 2 && relationDensity >= 0.5);
}

function applyJunctionGradients(tables, graph, relationColumns, solidColors) {
    const result = new Map(solidColors);
    tables.forEach((table) => {
        if (!isJunctionTable(table, graph, relationColumns)) return;
        const neighborColors = [...(graph.get(table.name) || new Map()).entries()]
            .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))
            .map(([name]) => solidColors.get(name))
            .filter(Boolean);
        const distinctColors = [...new Set(neighborColors)];
        if (distinctColors.length < 2) return;
        result.set(table.name, `gradient:${distinctColors[0]}:${distinctColors[1]}`);
    });
    return result;
}

export function generateSmartTableColors(schema, { inferredRelations = [], paletteMode = DEFAULT_PALETTE_MODE } = {}) {
    const tables = (Array.isArray(schema?.tables) ? schema.tables : []).filter((table) => typeof table?.name === 'string' && table.name.trim());
    if (tables.length === 0) return {};

    const sortedTables = [...tables].sort((first, second) => first.name.localeCompare(second.name));
    const tableByName = new Map(sortedTables.map((table) => [table.name, table]));
    const semanticScores = new Map(sortedTables.map((table) => [table.name, getSemanticScores(table)]));
    const { graph, relationColumns } = buildRelationshipGraph(sortedTables, schema?.relations, inferredRelations);
    const components = getComponents(sortedTables.map((table) => table.name), graph);
    const preferredFamilies = new Map();
    const assigned = new Map();
    const colorFamilies = getColorPreset(paletteMode);

    components.forEach((component) => {
        const componentScores = Object.fromEntries(FAMILY_NAMES.map((family) => [family, 0]));
        component.forEach((name) => {
            FAMILY_NAMES.forEach((family) => {
                componentScores[family] += semanticScores.get(name)?.[family] || 0;
            });
        });
        const componentFamily = getBestFamily(componentScores, component.join('|'));
        component.forEach((name) => {
            const scores = semanticScores.get(name);
            const directFamily = getBestFamily(scores, name);
            const directStrength = Math.max(...FAMILY_NAMES.map((family) => scores?.[family] || 0));
            preferredFamilies.set(name, directStrength >= 3 ? directFamily : componentFamily);
        });
        colorComponent(component, graph, preferredFamilies, componentFamily, assigned, colorFamilies);
    });

    const withJunctions = applyJunctionGradients(sortedTables, graph, relationColumns, assigned);
    return Object.fromEntries([...tableByName.keys()].map((name) => [name, withJunctions.get(name)]));
}

export function getSmartTableColorFamilies(paletteMode = DEFAULT_PALETTE_MODE) {
    return Object.fromEntries(Object.entries(getColorPreset(paletteMode)).map(([family, colors]) => [family, [...colors]]));
}

export function getSmartTableColorModes() {
    return Object.keys(COLOR_PRESETS);
}

export function getRecommendedTableColorMode(darkMode = false) {
    return darkMode === true ? 'bright' : 'balanced';
}
