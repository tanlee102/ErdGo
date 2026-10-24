/** Minimal accessible error surface for feature-level string messages. */
export default function ErrorDisplay({ error, onRetry, retryDisabled = false }) {
    if (!error) return null;

    return (
        <div className="error-message-display" role="alert">
            {error}
            {onRetry && <button type="button" className="error-message-retry" onClick={onRetry} disabled={retryDisabled}>Retry loading SQL</button>}
        </div>
    );
}
