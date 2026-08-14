/** Presentational SVG for a generic add action. */
export default function AddIcon({ className = '', width = '24px', height = '24px' }) {
    return (
        <svg viewBox="0 0 24 24" width={width} height={height} className={className}>
            <g>
                <line fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" x1="12" x2="12" y1="19" y2="5" />
                <line fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" x1="5" x2="19" y1="12" y2="12" />
            </g>
        </svg>
    );
}
