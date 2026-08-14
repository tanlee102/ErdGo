/** Presentational SVG for submitting AI and feedback messages. */
export default function SendIcon({ className = '', width = '24px', height = '24px' }) {
    return (
        <svg height={height} width={width} className={className} viewBox="0 0 24 24">
            <path d="M21.88,4.73,16.2,20.65A2,2,0,0,1,14.3,22h0a2,2,0,0,1-1.9-1.31l-2.12-5.52,1.54-1.54,2.49-2.49a1,1,0,1,0-1.42-1.42l-2.49,2.49L8.82,13.76,3.31,11.63a2,2,0,0,1,0-3.83L19.27,2.12a2,2,0,0,1,2.61,2.61Z"></path>
        </svg>
    );
}
