/** Presentational SVG for search controls. */
export default function SearchIcon({ className = '', width = '24px', height = '24px' }) {
    return (
        <svg width={width} height={height} viewBox="0 0 24 24" fill="none" className={className}>
            <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2" />
            <path d="m21 21-4.35-4.35" stroke="currentColor" strokeWidth="2" />
        </svg>
    );
}
