/** Presentational SVG for export/download actions. */
export default function ExportIcon({ className = '', width = '20px', height = '20px' }) {
    return (
        <svg className={className} width={width} height={height} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M21 21H3M18 11L12 17M12 17L6 11M12 17V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}
