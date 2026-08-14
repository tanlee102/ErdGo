/** Presentational SVG for the row/action overflow menu. */
export default function ActionsMenuIcon({ className = '', width = '18px', height = '18px' }) {
    return (
        <svg className={className} width={width} height={height} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <line x1="4" y1="7" x2="13" y2="7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <line x1="4" y1="12" x2="11" y2="12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <line x1="4" y1="17" x2="13" y2="17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <polyline className="actions-menu-icon-chevron" points="15.5 10.5 18.5 13.5 21.5 10.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}
