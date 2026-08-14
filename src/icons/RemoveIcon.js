/** Presentational SVG for removing an item. */
export default function RemoveIcon({ className = '', width = '24px', height = '24px' }) {
    return (
        <svg width={width} height={height} className={className} viewBox="0 0 1024 1024">
            <path fill="currentColor" d="M352 480h320a32 32 0 1 1 0 64H352a32 32 0 0 1 0-64z" /> <path fill="currentColor" d="M512 896a384 384 0 1 0 0-768 384 384 0 0 0 0 768zm0 64a448 448 0 1 1 0-896 448 448 0 0 1 0 896z" />
        </svg>
    );
}
