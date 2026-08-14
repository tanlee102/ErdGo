import { useEffect, useState } from 'react';
import { jsPDF } from 'jspdf';
import ExportIcon from '@/icons/ExportIcon';
import DarkIcon from '@/icons/DarkIcon';
import ConfigureIcon from '@/icons/ConfigureIcon';

export default function ErdTopControls({ erdRendering, toggleTheme, viewMode, onViewModeChange, isMinimapOpen = false, onMinimapOpenChange }) {
    const exportPresets = [
        { id: 'hd', label: 'HD', minWidth: 1280, minHeight: 720, scale: 2 },
        { id: '2k', label: '2K', minWidth: 2560, minHeight: 1440, scale: 3 },
        { id: '4k', label: '4K', minWidth: 3840, minHeight: 2160, scale: 4 },
    ];
    const [isExportOpen, setIsExportOpen] = useState(false);
    const canToggleHeaderActions = typeof erdRendering?.setHeaderActionsAlwaysVisible === 'function';
    const headerActionsAlwaysVisible = erdRendering?.headerActionsAlwaysVisible !== false;
    const headerActionsToggleLabel = headerActionsAlwaysVisible ? 'Header tools always visible' : 'Header tools on hover';

    useEffect(() => {
        const handleOutsideClick = (e) => {
            if (isExportOpen && !e.target.closest('.erd-export-wrap')) {
                setIsExportOpen(false);
            }
        };
        document.addEventListener('click', handleOutsideClick);
        return () => document.removeEventListener('click', handleOutsideClick);
    }, [isExportOpen]);

    const handleExport = (format, preset) => {
        try {
            const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
            const sizeSuffix = preset?.id ? `-${preset.id}` : '';

            const exportData = getExportData(preset);
            if (!exportData) {
                console.error('Export data not available');
                return;
            }

            if (format === 'png') {
                exportHighQualityPNG(exportData, `erd-diagram-${timestamp}${sizeSuffix}.png`);
            } else if (format === 'svg') {
                exportVectorSVG(exportData, `erd-diagram-${timestamp}${sizeSuffix}.svg`);
            } else if (format === 'pdf') {
                exportPDF(exportData, `erd-diagram-${timestamp}${sizeSuffix}.pdf`);
            }

            // Export completed successfully
        } catch (error) {
            console.error('Error exporting ERD:', error);
        } finally {
            setIsExportOpen(false);
        }
    };

    const getExportData = (preset) => {
        if (erdRendering?.exportPng) {
            const data = erdRendering.exportPng({
                minWidth: preset?.minWidth ?? 3840,
                minHeight: preset?.minHeight ?? 2160,
                scale: preset?.scale ?? 4,
                maxSize: 8192,
            });
            if (data?.dataUrl) return data;
        }

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

    const exportPDF = (exportData, fileName) => {
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

    return (
        <div id="erd-top-controls">
            {onViewModeChange && (
                <div className="erd-view-toggle">
                    <button className={`erd-view-toggle-btn ${viewMode === 'erd' ? 'active' : ''}`} type="button" aria-pressed={viewMode === 'erd'} onClick={viewMode !== 'erd' ? () => onViewModeChange('erd') : undefined}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="18" height="18" rx="2" />
                            <line x1="3" y1="9" x2="21" y2="9" />
                            <line x1="9" y1="21" x2="9" y2="9" />
                        </svg>
                        ERD
                    </button>
                    <button className={`erd-view-toggle-btn ${viewMode === 'data' ? 'active' : ''}`} type="button" aria-pressed={viewMode === 'data'} onClick={viewMode !== 'data' ? () => onViewModeChange('data') : undefined}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <ellipse cx="12" cy="5" rx="9" ry="3" />
                            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                        </svg>
                        Data
                    </button>
                    <button className={`erd-view-toggle-btn ${viewMode === 'query' ? 'active' : ''}`} type="button" aria-pressed={viewMode === 'query'} onClick={viewMode !== 'query' ? () => onViewModeChange('query') : undefined}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 6h16" />
                            <path d="M4 12h16" />
                            <path d="M4 18h10" />
                            <circle cx="18" cy="18" r="2" />
                        </svg>
                        Query
                    </button>
                </div>
            )}

            <button
                className="erd-top-btn"
                title="Toggle Dark Mode"
                onClick={() => {
                    toggleTheme();
                    if (viewMode === 'erd') erdRendering.setFlag((f) => f + 1);
                }}
            >
                <DarkIcon width="22px" height="22px" />
            </button>

            {canToggleHeaderActions && (
                <button
                    className={`erd-top-btn erd-top-btn--toggle ${headerActionsAlwaysVisible ? 'active' : ''}`}
                    type="button"
                    title={headerActionsToggleLabel}
                    aria-label="Toggle table header tools visibility"
                    aria-pressed={headerActionsAlwaysVisible}
                    style={viewMode !== 'erd' ? { display: 'none' } : undefined}
                    onClick={() => erdRendering.setHeaderActionsAlwaysVisible(!headerActionsAlwaysVisible)}
                >
                    <ConfigureIcon className="erd-header-tools-icon" width="22px" height="22px" />
                </button>
            )}

            {typeof onMinimapOpenChange === 'function' && (
                <button
                    className={`erd-top-btn erd-top-btn--toggle ${isMinimapOpen ? 'active' : ''}`}
                    type="button"
                    title={isMinimapOpen ? 'Hide ERD minimap' : 'Show ERD minimap'}
                    aria-label={isMinimapOpen ? 'Hide ERD minimap' : 'Show ERD minimap'}
                    aria-controls="erd-minimap"
                    aria-pressed={isMinimapOpen}
                    style={viewMode !== 'erd' ? { display: 'none' } : undefined}
                    onClick={() => onMinimapOpenChange(!isMinimapOpen)}
                >
                    <svg className="erd-minimap-toggle-icon" width="24" height="24" viewBox="3 0 26 28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <ellipse cx="16" cy="9.5" rx="8.25" ry="6.9" />
                        <line x1="16" y1="16.4" x2="16" y2="26.2" />
                    </svg>
                </button>
            )}

            <div className="erd-export-wrap" style={viewMode !== 'erd' ? { display: 'none' } : undefined}>
                <button className="erd-top-btn" id="export-btn" title="Export ERD" aria-haspopup="menu" aria-expanded={isExportOpen} onClick={() => setIsExportOpen((open) => !open)}>
                    <ExportIcon width="22px" height="22px" />
                </button>
                {isExportOpen && (
                    <div className="erd-export-menu" role="menu" aria-label="Export ERD">
                        <div className="erd-export-group">
                            <div className="erd-export-group-label">PNG</div>
                            {exportPresets.map((preset) => (
                                <button key={`png-${preset.id}`} className="erd-export-item" role="menuitem" onClick={() => handleExport('png', preset)}>
                                    <span className="erd-export-title">{preset.label}</span>
                                    <span className="erd-export-meta">
                                        {preset.minWidth}×{preset.minHeight}
                                    </span>
                                </button>
                            ))}
                        </div>
                        <div className="erd-export-group">
                            <div className="erd-export-group-label">SVG</div>
                            {exportPresets.map((preset) => (
                                <button key={`svg-${preset.id}`} className="erd-export-item" role="menuitem" onClick={() => handleExport('svg', preset)}>
                                    <span className="erd-export-title">{preset.label}</span>
                                    <span className="erd-export-meta">
                                        {preset.minWidth}×{preset.minHeight}
                                    </span>
                                </button>
                            ))}
                        </div>
                        <div className="erd-export-group">
                            <div className="erd-export-group-label">PDF</div>
                            {exportPresets.map((preset) => (
                                <button key={`pdf-${preset.id}`} className="erd-export-item" role="menuitem" onClick={() => handleExport('pdf', preset)}>
                                    <span className="erd-export-title">{preset.label}</span>
                                    <span className="erd-export-meta">
                                        {preset.minWidth}×{preset.minHeight}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
