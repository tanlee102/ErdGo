/**
 * Canvas text measurement, wrapping, and truncation helpers.
 * Measurements depend only on the supplied 2D context; renderer state belongs
 * in genErdScript and must not leak into this module.
 */
function splitCanvasTokenToWidth(ctx, token, maxWidth) {
    const value = String(token ?? '');
    const lines = [];
    let start = 0;

    while (start < value.length) {
        let low = start + 1;
        let high = value.length;
        let best = start + 1;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const candidate = value.slice(start, mid);
            if (ctx.measureText(candidate).width <= maxWidth) {
                best = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        lines.push(value.slice(start, best));
        start = best;
    }

    return lines;
}

export function wrapCanvasTextToWidth(ctx, text, maxWidth) {
    const value = String(text ?? '');
    if (!value) return [''];
    if (!Number.isFinite(maxWidth) || maxWidth <= 0 || ctx.measureText(value).width <= maxWidth) {
        return [value];
    }

    const lines = [];
    const tokens = value.trim().split(/\s+/);
    let currentLine = '';

    tokens.forEach((token) => {
        const candidate = currentLine ? `${currentLine} ${token}` : token;
        if (ctx.measureText(candidate).width <= maxWidth) {
            currentLine = candidate;
            return;
        }

        if (currentLine) {
            lines.push(currentLine);
            currentLine = '';
        }

        if (ctx.measureText(token).width <= maxWidth) {
            currentLine = token;
            return;
        }

        const tokenLines = splitCanvasTokenToWidth(ctx, token, maxWidth);
        lines.push(...tokenLines.slice(0, -1));
        currentLine = tokenLines[tokenLines.length - 1] || '';
    });

    if (currentLine) lines.push(currentLine);
    return lines.length > 0 ? lines : [value];
}

export function truncateCanvasTextToWidth(ctx, text, maxWidth) {
    const value = String(text ?? '');
    if (!value) return '';
    if (!Number.isFinite(maxWidth) || maxWidth <= 0) return '';
    if (ctx.measureText(value).width <= maxWidth) return value;

    const ellipsis = '...';
    if (ctx.measureText(ellipsis).width > maxWidth) return '';

    let low = 0;
    let high = value.length;
    let best = '';

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const candidate = `${value.slice(0, mid)}${ellipsis}`;
        if (ctx.measureText(candidate).width <= maxWidth) {
            best = candidate;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    return best || ellipsis;
}

/**
 * runErdScript
 * -----------------------------------------------------------------------------
 * Render an interactive Entity-Relationship Diagram (ERD) into the `#erd-canvas`
 * element based on a normalised `schema` object. The diagram supports:
 *   • Auto-layout tables via Best, ELK LR/RL, and Snowflake modes
 *   • Mouse/touch zoom & pan with inertia-free UX
 *   • Drag-and-drop tables with position persistence (saved in initialContext)
 *   • Hover/selection highlighting, enum tool-tips & connector cardinalities
 *   • Per-table colour picker with palette + custom HEX input
 *   • Fit-to-screen & Auto-layout utility buttons
 *
 * The script is idempotent – on every invocation it clones the canvas to clear
 * previous event listeners while *preserving* global context (zoom, offsets,
 * table positions, colours, selected node) via `initialContext`.
 *
 * @param {Object} schema  Normalised schema:
 *   {
 *     enums:     [ { name: String, values: String[] } ],
 *     tables:    [ { name, columns:[{ name,type,pk?,fk?,constraints? }] } ],
 *     relations: [ { from:{table,column}, to:{table,column}, fromCard?,toCard?, fkName? } ]
 *   }
 */
