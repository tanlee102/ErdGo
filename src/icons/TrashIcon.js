/** Presentational SVG for destructive delete or clear actions. */
export default function TrashIcon({ className = '', width = '24px', height = '24px' }) {
    return (
        <svg width={width} height={height} className={className} viewBox="1.1 0 21 21" fill="none">
            <path d="M5.99999 6C5.99999 11.8587 4.63107 20 12 20C19.3689 20 18 11.8587 18 6M4 6H20M15 6V5C15 3.22496 13.3627 3 12 3C10.6373 3 9 3.22496 9 5V6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}
