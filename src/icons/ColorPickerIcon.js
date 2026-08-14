/** Presentational SVG for table-color controls. */
export default function ColorPickerIcon({ className = '', width = '24px', height = '24px' }) {
    return (
        <svg version="1.1" viewBox="0 0 512 512" width={width} height={height} className={className}>
            <rect x="106.146" y="349.091" style={{ fill: '#4ACFD9' }} width="395.069" height="136.231" />
            <rect x="106.146" y="349.091" style={{ fill: '#365558' }} width="131.69" height="136.231" />
            <rect x="237.836" y="349.091" style={{ fill: '#0295AA' }} width="131.69" height="136.231" />
            <rect x="24.408" y="8.514" style={{ fill: '#FF8C29' }} width="136.231" height="395.069" />
            <rect x="24.408" y="271.894" style={{ fill: '#F0353D' }} width="136.231" height="131.69" />
            <rect x="24.408" y="140.204" style={{ fill: '#FD6A33' }} width="136.231" height="131.69" />
            <circle style={{ fill: '#FFD1A9' }} cx="97.064" cy="417.206" r="86.279" />
            <circle style={{ fill: '#687F82' }} cx="97.064" cy="417.206" r="49.951" />
        </svg>
    );
}
