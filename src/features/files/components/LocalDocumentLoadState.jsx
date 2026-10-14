/** Blocking load/error state shared by local editor workspaces. */
import './local-document-load-state.css';

export default function LocalDocumentLoadState({ toolLabel, isLoading, error, onRetry, onOpenFiles }) {
    if (!isLoading && !error) return null;

    if (error) {
        return (
            <div className="local-document-load-state" role="alert">
                <div className="local-document-load-card is-error">
                    <span className="local-document-load-icon" aria-hidden="true">!</span>
                    <div>
                        <h2>Couldn’t open this file</h2>
                        <p>{error}</p>
                    </div>
                    <div className="local-document-load-actions">
                        <button type="button" className="primary" onClick={onRetry}>Try again</button>
                        <button type="button" onClick={onOpenFiles}>Open files</button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="local-document-load-state" role="status" aria-live="polite" aria-label={`Opening ${toolLabel} file`}>
            <div className="local-document-load-card">
                <span className="local-document-load-spinner" aria-hidden="true" />
                <div>
                    <h2>Opening {toolLabel}</h2>
                    <p>Restoring your content and diagram layout…</p>
                </div>
            </div>
        </div>
    );
}
