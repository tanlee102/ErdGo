import { getPrimaryCanvasColor, resolveTableHeaderColor } from './colorSystem.js';
import { getReadableTableTextColor, getTableHeaderContrastTreatment } from '@/lib/smartTableColors.js';

/** Pure sizing and contrast rules for column-constraint badges. */
export function getCompositeConstraintPillColors(darkMode = false) {
    // A slightly lifted slate keeps neutral badges distinct from the dark
    // canvas without competing with table colors or weakening white text.
    const background = darkMode ? '#4F5E70' : '#64748B';
    return {
        background,
        text: getReadableTableTextColor(background),
    };
}

export function getTableHeaderTextColorForMode(mode) {
    if (typeof mode !== 'string') return null;
    const normalizedMode = mode.trim().toLowerCase();
    if (normalizedMode === 'white') return '#FFFFFF';
    if (normalizedMode === 'black') return '#000000';
    return null;
}

export function getConstraintPillTextMode(isComposite, tableTextMode = 'auto') {
    return isComposite ? 'white' : tableTextMode;
}

export function composeCanvasAlpha(parentAlpha, layerAlpha) {
    return parentAlpha * layerAlpha;
}

const CONSTRAINT_PILL_PADDING_X = 3;
const CONSTRAINT_PILL_HEIGHT = 16;
export const CONSTRAINT_PILL_FONT = '700 12px sans-serif';

export function getConstraintPillLayout(textWidth) {
    const safeTextWidth = Number.isFinite(textWidth) ? Math.max(0, textWidth) : 0;
    return {
        width: Math.ceil(safeTextWidth + CONSTRAINT_PILL_PADDING_X * 2),
        height: CONSTRAINT_PILL_HEIGHT,
        paddingX: CONSTRAINT_PILL_PADDING_X,
    };
}

export function measureConstraintPillText(ctx, text, font = CONSTRAINT_PILL_FONT) {
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    return ctx.measureText(text);
}

export function getCenteredCanvasTextBaseline(centerY, metrics, fallbackFontSize = 12) {
    const ascent = Number(metrics?.actualBoundingBoxAscent);
    const descent = Number(metrics?.actualBoundingBoxDescent);
    const baseline =
        Number.isFinite(ascent) && Number.isFinite(descent) && ascent + descent > 0
            ? centerY + (ascent - descent) / 2
            : centerY + fallbackFontSize * 0.25;

    // Half-pixel snapping keeps the glyph equally crisp above and below its
    // visual center across Chromium's Windows and macOS font rasterizers.
    return Math.round(baseline * 2) / 2;
}

export function getTableConstraintPillAppearance(background, textMode = 'auto', backdrop = '#FFFFFF') {
    const resolvedBackground = getPrimaryCanvasColor(resolveTableHeaderColor(background, backdrop));
    const requestedTextColor = getTableHeaderTextColorForMode(textMode);
    const treatment = getTableHeaderContrastTreatment(resolvedBackground, 4.75, backdrop, requestedTextColor);
    return {
        background: resolvedBackground,
        textColor: treatment.textColor,
        overlayColor: treatment.overlayColor,
        overlayAlpha: treatment.overlayAlpha,
        minimumContrast: treatment.minimumContrast,
    };
}
