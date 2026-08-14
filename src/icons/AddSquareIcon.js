/** Presentational SVG for adding a table or boxed item. */
export default function AddSquareIcon({ className = '', width = '24px', height = '24px' }) {
    return (
        <svg className={className} width={width} height={height} viewBox="0 0 24 24" fill="none">
            <path d="M9 12H12M15 12H12M12 12V9M12 12V15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M21 3.6V20.4C21 20.7314 20.7314 21 20.4 21H3.6C3.26863 21 3 20.7314 3 20.4V3.6C3 3.26863 3.26863 3 3.6 3H20.4C20.7314 3 21 3.26863 21 3.6Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}
