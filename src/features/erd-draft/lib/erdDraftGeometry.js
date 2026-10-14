/** Pure coordinate helpers for Builder node placement, edge endpoints, controls, waypoints, and labels. */
export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

const nodeSizeProfiles = {
    entity: { width: 180, height: 92, paddingX: 36, paddingY: 24, widthRatio: 1, heightRatio: 1, fontSize: 15, charWidth: 7.4 },
    relationship: { width: 148, height: 116, paddingX: 20, paddingY: 20, widthRatio: 0.58, expandedWidthRatio: 0.76, heightRatio: 0.52, fontSize: 15, charWidth: 7.4 },
    attribute: { width: 180, height: 88, paddingX: 36, paddingY: 24, widthRatio: 0.76, expandedWidthRatio: 0.86, heightRatio: 0.62, fontSize: 15, charWidth: 7.4 },
    isa: { width: 150, height: 100, paddingX: 0, paddingY: 0, widthRatio: 0.58, expandedWidthRatio: 0.72, heightRatio: 0.44, fontSize: 11, charWidth: 5.7 },
    category: { width: 104, height: 104, paddingX: 28, paddingY: 28, widthRatio: 0.72, expandedWidthRatio: 0.82, heightRatio: 0.52, fontSize: 11, charWidth: 5.7, category: true },
    aggregation: { width: 230, height: 116, paddingX: 36, paddingY: 32, widthRatio: 1, heightRatio: 1, fontSize: 12, charWidth: 6.2, caption: true },
    note: { width: 190, height: 110, paddingX: 36, paddingY: 24, widthRatio: 1, heightRatio: 1, fontSize: 12, charWidth: 6.2 },
};

const CATEGORY_GAP = 46;
const LABEL_LINE_HEIGHT = 1.22;
const LABEL_BREATHING_FACTOR = 1.08;
// Dense paragraphs need a glyph-width allowance without expanding short labels.
const WRAP_WIDTH_FACTOR = 1.1;
// The canvas uses a moderately heavy system font, whose actual glyph widths are
// wider than the inexpensive character estimate below for long identifiers.
// Keep enough room that a complete word always fits instead of overflowing or
// being split by the browser.
const WORD_BREATHING_FACTOR = 1.2;

function sizeProfileForShape(shape) {
    const normalizedShape = String(shape || 'entity');
    if (normalizedShape === 'relationship' || normalizedShape === 'identifyingRelationship') return nodeSizeProfiles.relationship;
    if (normalizedShape === 'isa') return nodeSizeProfiles.isa;
    if (normalizedShape === 'category') return nodeSizeProfiles.category;
    if (normalizedShape === 'aggregation') return nodeSizeProfiles.aggregation;
    if (normalizedShape === 'note') return nodeSizeProfiles.note;
    if (normalizedShape.toLowerCase().includes('attribute')) return nodeSizeProfiles.attribute;
    return nodeSizeProfiles.entity;
}

function characterUnits(value) {
    return [...value].reduce((units, character) => {
        if (/\s/.test(character)) return units + 0.5;
        if (/[ilI1|.,'`:;]/.test(character)) return units + 0.55;
        if (/[MW@#%&]/.test(character)) return units + 1.35;
        if (character.codePointAt(0) > 0x2ff) return units + 1.8;
        if (/[A-Z]/.test(character)) return units + 1.08;
        return units + 1;
    }, 0);
}

function wrappedLineCount(label, capacity) {
    return String(label || '').replace(/\r/g, '').split('\n').reduce((lineTotal, explicitLine) => {
        if (!explicitLine) return lineTotal + 1;
        const words = explicitLine.trim().split(/\s+/);
        let lines = 1;
        let used = 0;
        words.forEach((word) => {
            const remaining = characterUnits(word);
            const separator = used > 0 ? 0.5 : 0;
            if (remaining + used + separator <= capacity) {
                used += remaining + separator;
                return;
            }
            if (used > 0) {
                lines += 1;
                used = 0;
            }
            used = remaining;
        });
        return lineTotal + lines;
    }, 0);
}

function minimumWidthGrowthForCompleteWords(label, profile, itemScale, textScale) {
    const longestWord = String(label || '')
        .replace(/\r/g, '')
        .split(/\s+/)
        .reduce((longest, word) => Math.max(longest, characterUnits(word)), 0);
    if (!longestWord) return 1;
    const requiredAreaWidth = longestWord
        * profile.charWidth
        * textScale
        * WORD_BREATHING_FACTOR;
    return Math.max(
        1,
        (requiredAreaWidth / profile.widthRatio + profile.paddingX) / (profile.width * itemScale),
    );
}

function labelProfileForContent(profile, label, itemScale, textScale) {
    // Match the caption space reserved by aggregation CSS, including its font scale.
    if (profile.caption) profile = { ...profile, paddingY: profile.paddingY + 10 * textScale };
    if (!profile.expandedWidthRatio) return profile;
    const longestWord = String(label || '')
        .replace(/\r/g, '')
        .split(/\s+/)
        .reduce((longest, word) => Math.max(longest, characterUnits(word)), 0);
    const requiredAreaWidth = longestWord
        * profile.charWidth
        * textScale
        * WORD_BREATHING_FACTOR;
    const baseAreaWidth = Math.max(1, (profile.width * itemScale - profile.paddingX) * profile.widthRatio);
    return requiredAreaWidth > baseAreaWidth
        ? { ...profile, widthRatio: profile.expandedWidthRatio }
        : profile;
}

/** Returns the matching safe text-width ratio used by the visual label. */
export function draftLabelWidthRatio(shape, label = '', sizeScale = 1, textScale = 1) {
    const itemScale = Math.max(0.1, Number(sizeScale) || 1);
    const labelScale = Math.max(0.1, Number(textScale) || 1);
    return labelProfileForContent(sizeProfileForShape(shape), label, itemScale, labelScale).widthRatio;
}

function dimensionsAtScale(profile, itemScale, widthGrowth = 1, heightGrowth = widthGrowth) {
    if (profile.category) {
        // Categories are circles, so their label fit must keep both axes equal.
        const diameter = profile.width * Math.max(widthGrowth, heightGrowth) * itemScale;
        return { width: diameter + CATEGORY_GAP * itemScale, height: diameter };
    }
    return {
        width: profile.width * widthGrowth * itemScale,
        height: profile.height * heightGrowth * itemScale,
    };
}

function usableTextArea(profile, dimensions, itemScale) {
    const shapeWidth = profile.category
        ? dimensions.width - CATEGORY_GAP * itemScale
        : dimensions.width;
    return {
        width: Math.max(1, (shapeWidth - profile.paddingX) * profile.widthRatio),
        height: Math.max(1, (dimensions.height - profile.paddingY) * profile.heightRatio),
    };
}

function requiredTextHeight(label, profile, areaWidth, textScale) {
    const capacity = Math.max(1, areaWidth / (profile.charWidth * textScale));
    let wrappedLines = wrappedLineCount(label, capacity);
    if (wrappedLines >= 5) wrappedLines = wrappedLineCount(label, capacity / WRAP_WIDTH_FACTOR);
    const safeLines = wrappedLines >= 5 ? wrappedLines + 1 : wrappedLines;
    return safeLines
        * profile.fontSize
        * textScale
        * LABEL_LINE_HEIGHT
        * LABEL_BREATHING_FACTOR;
}

function labelLayoutAtGrowth(label, profile, itemScale, labelScale, widthGrowth, heightGrowth = 1) {
    const dimensions = dimensionsAtScale(profile, itemScale, widthGrowth, heightGrowth);
    const textArea = usableTextArea(profile, dimensions, itemScale);
    const textHeight = requiredTextHeight(label, profile, textArea.width, labelScale);
    return { dimensions, textArea, textHeight };
}

function minimumHeightGrowthForText(textHeight, profile, itemScale) {
    return Math.max(
        1,
        (textHeight / profile.heightRatio + profile.paddingY) / (profile.height * itemScale),
    );
}

/** Returns deterministic dimensions that fit whole words without making a node larger than needed. */
export function draftNodeSize(shape, sizeScale = 1, label = '', textScale = 1) {
    const itemScale = Math.max(0.1, Number(sizeScale) || 1);
    const labelScale = Math.max(0.1, Number(textScale) || 1);
    const profile = labelProfileForContent(sizeProfileForShape(shape), label, itemScale, labelScale);
    let widthGrowth = minimumWidthGrowthForCompleteWords(label, profile, itemScale, labelScale);
    // Semantic badges and captions must fit even when the main label is short.
    if (shape === 'isa') widthGrowth = Math.max(widthGrowth, 44 * labelScale / (0.3 * profile.width * itemScale));
    if (profile.caption) widthGrowth = Math.max(widthGrowth, (72 * labelScale + 24) / (profile.width * itemScale));
    let layout = labelLayoutAtGrowth(label, profile, itemScale, labelScale, widthGrowth);
    let heightGrowth = minimumHeightGrowthForText(layout.textHeight, profile, itemScale);
    if (profile.category) heightGrowth = Math.max(heightGrowth, (layout.textHeight + 29 * labelScale + 8 + profile.paddingY) / (profile.height * itemScale));
    if (shape === 'isa') heightGrowth = Math.max(heightGrowth, (9.6 * labelScale + layout.textHeight / 2 + 4) / (0.37 * profile.height * itemScale));

    // A circle must retain its circular notation. Other Chen shapes can widen
    // for an unbroken identifier while adding height only for actual extra rows.
    layout = labelLayoutAtGrowth(
        label,
        profile,
        itemScale,
        labelScale,
        widthGrowth,
        profile.category ? Math.max(widthGrowth, heightGrowth) : heightGrowth,
    );

    const { dimensions } = layout;

    return {
        width: Math.ceil(dimensions.width),
        height: Math.ceil(dimensions.height),
    };
}

function rectanglesOverlap(first, second, gap) {
    return first.x < second.x + second.width + gap
        && first.x + first.width + gap > second.x
        && first.y < second.y + second.height + gap
        && first.y + first.height + gap > second.y;
}

export function findOpenNodePosition(origin, size, occupiedRectangles, gap = 24) {
    const occupied = Array.isArray(occupiedRectangles) ? occupiedRectangles : [];
    const stepX = Math.max(210, Number(size?.width) + gap);
    const stepY = Math.max(132, Number(size?.height) + gap);
    const offsets = [{ x: 0, y: 0 }];
    for (let ring = 1; ring <= 6; ring += 1) {
        offsets.push(
            { x: stepX * ring, y: 0 },
            { x: -stepX * ring, y: 0 },
            { x: 0, y: stepY * ring },
            { x: 0, y: -stepY * ring },
            { x: stepX * ring, y: stepY * ring },
            { x: -stepX * ring, y: stepY * ring },
            { x: stepX * ring, y: -stepY * ring },
            { x: -stepX * ring, y: -stepY * ring },
        );
    }

    const normalizedOrigin = { x: Number(origin?.x) || 0, y: Number(origin?.y) || 0 };
    const normalizedSize = { width: Number(size?.width) || 0, height: Number(size?.height) || 0 };
    const available = offsets.find((offset) => {
        const candidate = { ...normalizedSize, x: normalizedOrigin.x + offset.x, y: normalizedOrigin.y + offset.y };
        return occupied.every((rectangle) => !rectanglesOverlap(candidate, rectangle, gap));
    });
    return available
        ? { x: normalizedOrigin.x + available.x, y: normalizedOrigin.y + available.y }
        // A dense canvas can exhaust the nearby candidates. Place beyond every
        // occupied right edge rather than returning another potentially occupied spot.
        : { x: Math.max(normalizedOrigin.x + stepX * 7, ...occupied.map(rectangle => rectangle.x + rectangle.width + gap)), y: normalizedOrigin.y };
}

export function pointOnConnector(start, end, control, t) {
    if (!control) {
        return {
            x: start.x + (end.x - start.x) * t,
            y: start.y + (end.y - start.y) * t,
        };
    }
    const inverse = 1 - t;
    return {
        x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
        y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y,
    };
}

export function tangentOnConnector(start, end, control, t) {
    if (!control) return { x: end.x - start.x, y: end.y - start.y };
    return {
        x: 2 * (1 - t) * (control.x - start.x) + 2 * t * (end.x - control.x),
        y: 2 * (1 - t) * (control.y - start.y) + 2 * t * (end.y - control.y),
    };
}

export function connectorFrame(start, end, control, t) {
    const point = pointOnConnector(start, end, control, t);
    const tangent = tangentOnConnector(start, end, control, t);
    const length = Math.hypot(tangent.x, tangent.y);
    const normal = length > 0.0001
        ? { x: -tangent.y / length, y: tangent.x / length }
        : { x: 0, y: 1 };
    return { point, normal };
}

export function closestConnectorPosition(point, start, end, control) {
    let t;
    if (!control) {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lengthSquared = dx * dx + dy * dy;
        t = lengthSquared > 0.0001
            ? clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0.02, 0.98)
            : 0.5;
    } else {
        const samples = 48;
        let bestT = 0;
        let bestDistance = Infinity;
        for (let index = 0; index <= samples; index += 1) {
            const sampleT = index / samples;
            const sample = pointOnConnector(start, end, control, sampleT);
            const distance = (sample.x - point.x) ** 2 + (sample.y - point.y) ** 2;
            if (distance < bestDistance) {
                bestDistance = distance;
                bestT = sampleT;
            }
        }
        let low = Math.max(0.02, bestT - 1 / samples);
        let high = Math.min(0.98, bestT + 1 / samples);
        for (let iteration = 0; iteration < 10; iteration += 1) {
            const first = low + (high - low) / 3;
            const second = high - (high - low) / 3;
            const firstPoint = pointOnConnector(start, end, control, first);
            const secondPoint = pointOnConnector(start, end, control, second);
            const firstDistance = (firstPoint.x - point.x) ** 2 + (firstPoint.y - point.y) ** 2;
            const secondDistance = (secondPoint.x - point.x) ** 2 + (secondPoint.y - point.y) ** 2;
            if (firstDistance <= secondDistance) high = second;
            else low = first;
        }
        t = (low + high) / 2;
    }
    const frame = connectorFrame(start, end, control, t);
    return {
        t,
        offset: (point.x - frame.point.x) * frame.normal.x + (point.y - frame.point.y) * frame.normal.y,
    };
}

export function resolveConnectorLabel(position, fallbackT, start, end, control) {
    let relative;
    if (Number.isFinite(position?.t)) {
        relative = { t: clamp(position.t, 0.02, 0.98), offset: Number(position.offset) || 0 };
    } else if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) {
        relative = closestConnectorPosition(position, start, end, control);
    } else {
        relative = { t: fallbackT, offset: 0 };
    }
    const frame = connectorFrame(start, end, control, relative.t);
    return {
        relative,
        point: {
            x: frame.point.x + frame.normal.x * relative.offset,
            y: frame.point.y + frame.normal.y * relative.offset,
        },
    };
}

export function connectorControlFromPoint(point, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared <= 0.0001) {
        return { t: 0.5, offset: point.y - start.y };
    }
    const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, -2, 3);
    const length = Math.sqrt(lengthSquared);
    const normal = { x: -dy / length, y: dx / length };
    const baseline = pointOnConnector(start, end, null, t);
    return {
        t,
        offset: (point.x - baseline.x) * normal.x + (point.y - baseline.y) * normal.y,
    };
}

export function resolveConnectorControl(position, start, end) {
    if (!position) return null;
    const relative = Number.isFinite(position.t)
        ? { t: clamp(position.t, -2, 3), offset: Number(position.offset) || 0 }
        : connectorControlFromPoint(position, start, end);
    const frame = connectorFrame(start, end, null, relative.t);
    return {
        relative,
        point: {
            x: frame.point.x + frame.normal.x * relative.offset,
            y: frame.point.y + frame.normal.y * relative.offset,
        },
    };
}
