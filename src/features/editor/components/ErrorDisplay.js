/** Minimal accessible error surface for feature-level string messages. */
export default function ErrorDisplay({ error }) {
    if (!error) return null;

    return (
        <div className="error-message-display" role="alert">
            {error}
        </div>
    );
}
