/** Original toolbar export implementation, extracted so the responsive dialog only owns UI. */

export async function downloadErdExport({ erdRendering, format, preset, scope = 'viewport' }) {
    const getExportData = async (preset) => {
        if (erdRendering?.exportPng) {
            const data = await erdRendering.exportPng({
                minWidth: preset?.minWidth ?? 3840,
                minHeight: preset?.minHeight ?? 2160,
                scale: preset?.scale ?? 4,
                maxSize: 8192,
                ...(scope === 'diagram' ? { scope: 'diagram' } : {}),
            });
            if (data?.dataUrl) return data;
        }

        // The original canvas fallback is valid only for current-view capture.
        if (scope === 'diagram') return null;
        const canvas = document.getElementById('erd-canvas');
        if (!canvas) return null;

        return {
            dataUrl: canvas.toDataURL('image/png', 1.0),
            width: canvas.width,
            height: canvas.height,
            scale: 1,
        };
    };

    const exportHighQualityPNG = (exportData, fileName) => {
        const link = document.createElement('a');
        link.download = fileName;
        link.href = exportData.dataUrl;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const exportVectorSVG = (exportData, fileName) => {
        const width = exportData.width;
        const height = exportData.height;
        // Create SVG with viewBox for better scaling
        let svg = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n';
        svg += `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" `;
        svg += 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ';
        svg += 'version="1.1">\n';

        // Metadata to help SVG editors recognize the file better
        svg += '<metadata>\n';
        svg += '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n';
        svg += '    <rdf:Description>\n';
        svg += '      <dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">ERD Diagram</dc:title>\n';
        svg += '    </rdf:Description>\n';
        svg += '  </rdf:RDF>\n';
        svg += '</metadata>\n';

        // Define filters to improve quality
        svg += '<defs>\n';
        svg += '  <filter id="sharpen" color-interpolation-filters="sRGB">\n';
        svg += '    <feConvolveMatrix order="3" kernelMatrix="0 -1 0 -1 5 -1 0 -1 0" preserveAlpha="true"/>\n';
        svg += '  </filter>\n';
        svg += '</defs>\n';

        // Background
        svg += `<rect width="${width}" height="${height}" fill="#FFFFFF"/>\n`;

        // Embed high-quality PNG data
        svg += `<image href="${exportData.dataUrl}" `;
        svg += `width="${width}" height="${height}" `;
        svg += 'preserveAspectRatio="none" ';
        svg += 'image-rendering="optimizeQuality" ';
        svg += 'filter="url(#sharpen)"/>\n';

        svg += '</svg>';

        // Export SVG
        const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);

        const link = document.createElement('a');
        link.download = fileName;
        link.href = url;

        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        // Cleanup
        setTimeout(() => URL.revokeObjectURL(url), 100);
    };

    const exportPDF = async (exportData, fileName) => {
        // PDF generation is an export cost, not a prerequisite for opening the editor.
        const { jsPDF } = await import('jspdf');
        const width = exportData.width;
        const height = exportData.height;
        const orientation = width >= height ? 'landscape' : 'portrait';
        const pdf = new jsPDF({
            orientation,
            unit: 'px',
            format: [width, height],
            compress: true,
        });
        pdf.addImage(exportData.dataUrl, 'PNG', 0, 0, width, height, undefined, 'FAST');
        pdf.save(fileName);
    };

    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const sizeSuffix = preset?.id ? `-${preset.id}` : '';
    const exportData = await getExportData(preset);
    if (!exportData) throw new Error('Export data not available. Please wait for the diagram and try again.');
    if (format === 'png') exportHighQualityPNG(exportData, `erd-diagram-${timestamp}${sizeSuffix}.png`);
    else if (format === 'svg') exportVectorSVG(exportData, `erd-diagram-${timestamp}${sizeSuffix}.svg`);
    else if (format === 'pdf') await exportPDF(exportData, `erd-diagram-${timestamp}${sizeSuffix}.pdf`);
}
