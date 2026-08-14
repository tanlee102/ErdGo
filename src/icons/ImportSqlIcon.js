/** Presentational SVG for importing SQL files. */
export default function ImportSqlIcon({ className = '', width = '20px', height = '20px' }) {
    return (
        <svg className={`import-sql-icon ${className}`.trim()} width={width} height={height} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M19 6.5c0 1.657-3.134 3-7 3s-7-1.343-7-3 3.134-3 7-3 7 1.343 7 3Z" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M5 6.5v5c0 1.657 3.134 3 7 3 .72 0 1.414-.047 2.067-.134M5 11.5v5c0 1.657 3.134 3 7 3 .72 0 1.414-.047 2.067-.134" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M18 11v8m0 0-2.75-2.75M18 19l2.75-2.75" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}
