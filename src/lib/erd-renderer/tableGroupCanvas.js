/** SQL canvas groups are presentation frames; tables and relationships keep their own geometry. */
import { drawCanvasText, truncateCanvasTextToWidth } from './canvasText.js';

export function drawTableGroupFrames(ctx, frames, darkMode) {
    for (const frame of frames) {
        const left = frame.x - frame.width / 2;
        const top = frame.y - frame.height / 2;
        const color = frame.color || (darkMode ? '#a69bd8' : '#7865ad');
        ctx.save();
        ctx.fillStyle = color;
        ctx.globalAlpha = darkMode ? 0.09 : 0.05;
        ctx.fillRect(left, top, frame.width, frame.height);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(left, top, frame.width, frame.height);
        ctx.globalAlpha = darkMode ? 0.16 : 0.1;
        ctx.fillRect(left, top, frame.width, 32);
        ctx.globalAlpha = 1;
        ctx.fillStyle = darkMode ? '#e8e5f3' : '#3c344e';
        ctx.font = '600 13px Arial, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const count = `${frame.tableNames.length} ${frame.tableNames.length === 1 ? 'table' : 'tables'}`;
        const countWidth = ctx.measureText(count).width;
        drawCanvasText(ctx, truncateCanvasTextToWidth(ctx, frame.name, frame.width - countWidth - 40), left + 12, top + 16);
        ctx.font = '11px Arial, sans-serif';
        ctx.textAlign = 'right';
        drawCanvasText(ctx, count, left + frame.width - 12, top + 16);
        ctx.restore();
    }
}
