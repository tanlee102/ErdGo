import { getColorContrastRatio } from '@/lib/smartTableColors.js';

/**
 * Pure color contracts for the canvas renderer.
 *
 * Keep this module independent from DOM and renderer state. Both UI previews
 * and the canvas runtime use these functions, so deterministic inputs must
 * always produce deterministic CSS/canvas colors.
 */
export const paletteColors = [
    '#5983d0', '#1a73cc', '#0D47A1', '#2563EB', '#0EA5E9', '#0891B2',
    '#00796B', '#0F766E', '#388E3C', '#65A30D', '#FBC02D', '#FFA000',
    '#F57C00', '#E64A19', '#D32F2F', '#E11D48', '#DB2777', '#C026D3',
    '#7B1FA2', '#9333EA', '#4F46E5', '#475569', '#455A64', '#111827',
];

const gradientTableColors = [
    { value: 'gradient:#2563EB:#06B6D4', title: 'Blue to Cyan', colors: ['#2563EB', '#06B6D4'] },
    { value: 'gradient:#0F766E:#84CC16', title: 'Teal to Lime', colors: ['#0F766E', '#84CC16'] },
    { value: 'gradient:#16A34A:#F59E0B', title: 'Green to Amber', colors: ['#16A34A', '#F59E0B'] },
    { value: 'gradient:#F97316:#DC2626', title: 'Orange to Red', colors: ['#F97316', '#DC2626'] },
    { value: 'gradient:#E11D48:#F97316', title: 'Rose to Orange', colors: ['#E11D48', '#F97316'] },
    { value: 'gradient:#DB2777:#7C3AED', title: 'Pink to Violet', colors: ['#DB2777', '#7C3AED'] },
    { value: 'gradient:#4F46E5:#9333EA', title: 'Indigo to Purple', colors: ['#4F46E5', '#9333EA'] },
    { value: 'gradient:#0F172A:#475569', title: 'Slate Depth', colors: ['#0F172A', '#475569'] },
    { value: 'gradient:#0369A1:#0F766E', title: 'Ocean', colors: ['#0369A1', '#0F766E'] },
    { value: 'gradient:#7C2D12:#B45309', title: 'Copper', colors: ['#7C2D12', '#B45309'] },
    { value: 'gradient:#0284C7:#4F46E5', title: 'Sky to Indigo', colors: ['#0284C7', '#4F46E5'] },
    { value: 'gradient:#059669:#14B8A6', title: 'Emerald to Teal', colors: ['#059669', '#14B8A6'] },
];

const GRADIENT_COLOR_PREFIX = 'gradient:';

export function parseGradientColor(color) {
    if (typeof color !== 'string') return null;
    const value = color.trim();
    if (!value.startsWith(GRADIENT_COLOR_PREFIX)) return null;

    const colors = value
        .slice(GRADIENT_COLOR_PREFIX.length)
        .split(':')
        .map((part) => part.trim())
        .filter(Boolean);

    if (colors.length < 2 || colors.some((part) => !/^#[0-9a-fA-F]{6}$/.test(part))) return null;
    return { colors };
}

export function getPrimaryCanvasColor(color) {
    return parseGradientColor(color)?.colors[0] ?? color;
}

export function getCanvasColorCss(color) {
    const gradient = parseGradientColor(color);
    return gradient ? `linear-gradient(135deg, ${gradient.colors.join(', ')})` : color;
}

export function getColorSwatchGroups() {
    return {
        solid: paletteColors.map((color) => ({ type: 'solid', value: color, title: color, colors: [color] })),
        gradient: gradientTableColors.map((gradient) => ({ ...gradient, type: 'gradient' })),
    };
}

export function getTableHeaderFillStyle(ctx, table, color, headerHeight) {
    const gradient = parseGradientColor(color);
    if (!gradient) return color;

    const x = table.x - table.width / 2;
    const y = table.y - table.height / 2;
    const fill = ctx.createLinearGradient(x, y, x + table.width, y + headerHeight);
    gradient.colors.forEach((stopColor, index) => {
        fill.addColorStop(index / (gradient.colors.length - 1), stopColor);
    });
    return fill;
}

function parseCanvasColor(color) {
    if (typeof color !== 'string') return null;
    const value = String(getPrimaryCanvasColor(color) || '').trim();
    const hexMatch = value.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
    if (hexMatch) {
        const hex = hexMatch[1];
        if (hex.length === 3) {
            return {
                r: parseInt(hex[0] + hex[0], 16),
                g: parseInt(hex[1] + hex[1], 16),
                b: parseInt(hex[2] + hex[2], 16),
            };
        }
        return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
    }

    const rgbMatch = value.match(/^rgba?\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s*,\s*(-?\d+(?:\.\d+)?))?\s*\)$/i);
    if (!rgbMatch) return null;
    return {
        r: Math.max(0, Math.min(255, Number(rgbMatch[1]))),
        g: Math.max(0, Math.min(255, Number(rgbMatch[2]))),
        b: Math.max(0, Math.min(255, Number(rgbMatch[3]))),
    };
}

export function resolveTableHeaderColor(configuredColor, fallbackColor) {
    return parseGradientColor(configuredColor) || parseCanvasColor(configuredColor) ? configuredColor : fallbackColor;
}

function rgbToHsl({ r, g, b }) {
    const [rn, gn, bn] = [r / 255, g / 255, b / 255];
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const lightness = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: lightness };

    const delta = max - min;
    const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    let hue;
    if (max === rn) hue = (gn - bn) / delta + (gn < bn ? 6 : 0);
    else if (max === gn) hue = (bn - rn) / delta + 2;
    else hue = (rn - gn) / delta + 4;
    return { h: hue / 6, s: saturation, l: lightness };
}

function rgbToHex({ r, g, b }) {
    const toHex = (value) => Math.round(value).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function mixCanvasColors(first, second, amount) {
    return {
        r: first.r * (1 - amount) + second.r * amount,
        g: first.g * (1 - amount) + second.g * amount,
        b: first.b * (1 - amount) + second.b * amount,
    };
}

function canvasColorWithAlpha(color, alpha) {
    const rgb = parseCanvasColor(color);
    return rgb
        ? `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}, ${alpha})`
        : `rgba(89, 131, 208, ${alpha})`;
}

export function getTableConnectorColor(color, darkMode = false) {
    const source = parseCanvasColor(color);
    if (!source) return darkMode ? '#a6a6a6' : '#64748b';
    if (darkMode && rgbToHsl(source).l < 0.18) return '#a6a6a6';

    const background = darkMode ? '#3c3c3c' : '#ffffff';
    const sourceHex = rgbToHex(source);
    if (getColorContrastRatio(sourceHex, background) >= 4.5) return sourceHex;

    const black = { r: 0, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };
    const destination = getColorContrastRatio('#000000', background) > getColorContrastRatio('#ffffff', background) ? black : white;
    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < 14; iteration += 1) {
        const midpoint = (low + high) / 2;
        const candidate = rgbToHex(mixCanvasColors(source, destination, midpoint));
        if (getColorContrastRatio(candidate, background) >= 4.5) high = midpoint;
        else low = midpoint;
    }
    return rgbToHex(mixCanvasColors(source, destination, high));
}

function isVeryDarkCanvasColor(color) {
    const rgb = parseCanvasColor(color);
    return rgb ? rgbToHsl(rgb).l < 0.18 : false;
}

function isVeryLightCanvasColor(color) {
    const rgb = parseCanvasColor(color);
    return rgb ? rgbToHsl(rgb).l > 0.86 : false;
}

export function getTableRelationshipFieldFillColor(color, darkMode = false) {
    if (darkMode && isVeryDarkCanvasColor(color)) return 'rgba(255, 255, 255, 0.1)';
    if (!darkMode && isVeryLightCanvasColor(color)) return 'rgba(15, 23, 42, 0.08)';
    return canvasColorWithAlpha(color, darkMode ? 0.34 : 0.2);
}

export function getTableSelectionAccentColor(color, darkMode = false) {
    if (darkMode && isVeryDarkCanvasColor(color)) return 'rgba(255, 255, 255, 0.64)';
    if (!darkMode && isVeryLightCanvasColor(color)) return 'rgba(15, 23, 42, 0.64)';
    return getPrimaryCanvasColor(color);
}

export function getTableRowHoverOutlineColor(color, darkMode = false) {
    if (darkMode && isVeryDarkCanvasColor(color)) return 'rgba(255, 255, 255, 0.58)';
    if (!darkMode && isVeryLightCanvasColor(color)) return 'rgba(15, 23, 42, 0.42)';
    return getTableConnectorColor(color, darkMode);
}

export function getInferredRelationVisual(relation, darkMode = false) {
    if (relation?.inferred !== true) return null;
    const accepted = relation.inferenceStatus === 'accepted';
    const sourceColor = accepted ? (darkMode ? '#34d399' : '#059669') : (darkMode ? '#fbbf24' : '#d97706');
    return {
        status: accepted ? 'accepted' : 'pending',
        stroke: getTableConnectorColor(sourceColor, darkMode),
        dash: accepted ? [8, 5] : [5, 5],
        badgeFill: accepted ? (darkMode ? '#065f46' : '#047857') : (darkMode ? '#92400e' : '#b45309'),
    };
}
