/** Anchored review panel for schema quality findings and inferred foreign-key suggestions. */
import { useLayoutEffect, useRef } from 'react';
import './index.css';

function relationshipLabel(suggestion) {
    return `${suggestion.from.table}.${suggestion.from.column} → ${suggestion.to.table}.${suggestion.to.column}`;
}

function ConfidenceScore({ suggestion }) {
    const level = suggestion.confidenceLevel === 'high' ? 'High' : 'Medium';
    return (
        <div className={`relationship-suggestion-score relationship-suggestion-score--${suggestion.confidenceLevel || 'medium'}`} aria-label={`${suggestion.confidence}% ${level} confidence`}>
            <strong>{suggestion.confidence}%</strong>
            <span>{level}</span>
        </div>
    );
}

function SchemaQualityCard({ quality }) {
    const score = Number.isInteger(quality?.score) && quality.score > 0 ? quality.score : null;
    const categories = Array.isArray(quality?.categories) ? quality.categories : [];
    const findings = Array.isArray(quality?.findings)
        ? quality.findings.filter((finding) => finding.severity !== 'info').slice(0, 3)
        : [];

    return (
        <section className="schema-quality-card" aria-labelledby="schema-quality-title">
            <div className="schema-quality-overview">
                <div className={`schema-quality-value schema-quality-value--${String(quality?.label || 'not-scored').toLowerCase().replace(/\s+/g, '-')}`} aria-label={score ? `ERD score ${score} out of 100, ${quality.label}` : 'ERD score not scored'}>
                    <strong>{score ?? '—'}</strong>
                    {score && <span>/100</span>}
                </div>
                <div>
                    <h3 id="schema-quality-title">ERD score <span>{quality?.label || 'Not scored'}</span></h3>
                    <p>{quality?.summary || 'Add a table to calculate an ERD quality score.'}</p>
                    {score && Number.isFinite(quality?.assessmentCoverage) && (
                        <span className="schema-quality-method">
                            {categories.filter((item) => item.applicable !== false).length}/{categories.length} checks · {quality.assessmentCoverage}% score coverage
                        </span>
                    )}
                </div>
            </div>

            {categories.length > 0 && score && (
                <div className="schema-quality-categories" aria-label="ERD score breakdown">
                    {categories.map((item) => {
                        const displayScore = item.effectiveScore ?? item.score;
                        const displayMaxScore = item.effectiveMaxScore ?? item.maxScore;
                        return (
                            <div className="schema-quality-category" key={item.id} title={item.summary}>
                                <div>
                                    <span>{item.label}</span>
                                    <strong>{item.applicable === false ? 'N/A' : `${displayScore}/${displayMaxScore}`}</strong>
                                </div>
                                <div className={`schema-quality-progress ${item.applicable === false ? 'is-not-applicable' : ''}`} aria-label={item.applicable === false ? `${item.label}: not applicable. ${item.summary}` : `${item.label}: ${displayScore} out of ${displayMaxScore} applicable points${item.summary ? `. ${item.summary}` : ''}`}>
                                    {item.applicable !== false && <i style={{ width: `${item.percentage}%` }} />}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {findings.length > 0 && (
                <div className="schema-quality-findings" aria-label="Highest-impact ERD improvements">
                    <strong>Improve this score</strong>
                    <ul>
                        {findings.map((finding) => <li key={finding.code}>{finding.title}</li>)}
                    </ul>
                </div>
            )}
        </section>
    );
}

export default function RelationshipSuggestionsPanel({ inference, anchorRef }) {
    const panelRef = useRef(null);
    const isOpen = inference?.isOpen;
    const setIsOpen = inference?.setIsOpen;

    useLayoutEffect(() => {
        if (!isOpen) return undefined;

        const updateAnchor = () => {
            const panel = panelRef.current;
            const anchor = anchorRef?.current;
            if (!panel || !anchor) return;

            const panelRect = panel.getBoundingClientRect();
            const anchorRect = anchor.getBoundingClientRect();
            if (panelRect.height <= 0 || anchorRect.height <= 0) return;

            const arrowTop = Math.max(16, Math.min(panelRect.height - 16, anchorRect.top + anchorRect.height / 2 - panelRect.top));
            const panelRight = Math.max(12, window.innerWidth - anchorRect.left + 12);
            panel.style.setProperty('--relationship-suggestions-arrow-top', `${arrowTop}px`);
            panel.style.setProperty('--relationship-suggestions-right', `${panelRight}px`);
        };

        const closeOnOutsidePointer = (event) => {
            const panel = panelRef.current;
            const anchor = anchorRef?.current;
            if (!panel || panel.contains(event.target) || anchor?.contains(event.target)) return;
            setIsOpen(false);
        };

        const closeOnEscape = (event) => {
            if (event.key === 'Escape') setIsOpen(false);
        };

        updateAnchor();
        window.addEventListener('resize', updateAnchor);
        document.addEventListener('pointerdown', closeOnOutsidePointer);
        document.addEventListener('keydown', closeOnEscape);
        const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(updateAnchor) : null;
        const panelElement = panelRef.current;
        if (panelElement) {
            panelElement.addEventListener('animationend', updateAnchor);
            resizeObserver?.observe(panelElement);
        }

        return () => {
            window.removeEventListener('resize', updateAnchor);
            document.removeEventListener('pointerdown', closeOnOutsidePointer);
            document.removeEventListener('keydown', closeOnEscape);
            panelElement?.removeEventListener('animationend', updateAnchor);
            resizeObserver?.disconnect();
        };
    }, [anchorRef, isOpen, setIsOpen]);

    if (!isOpen) return null;

    const suggestions = Array.isArray(inference.suggestions) ? inference.suggestions : [];

    return (
        <section id="relationship-suggestions-panel" ref={panelRef} className="relationship-suggestions-panel" role="dialog" aria-modal="false" aria-label="ERD health">
            <div className="relationship-suggestions-list">
                <SchemaQualityCard quality={inference.schemaQuality} />

                <section className="relationship-suggestions-section" aria-labelledby="smart-relationships-title">
                    <div className="relationship-suggestions-section-heading">
                        <h3 id="smart-relationships-title">Relationship suggestions</h3>
                        <div className="relationship-suggestions-legend" aria-label="Relationship style legend">
                            <span><i className="relationship-legend-line relationship-legend-line--pending" />Suggested</span>
                            <span><i className="relationship-legend-line relationship-legend-line--accepted" />Accepted</span>
                        </div>
                    </div>
                    <label className="relationship-suggestion-connector-toggle">
                        <span>
                            <strong>Show suggested connectors</strong>
                            <small>Preview pending links on the diagram</small>
                        </span>
                        <input
                            type="checkbox"
                            checked={inference.showConnectors === true}
                            onChange={(event) => inference.setShowConnectors(event.target.checked)}
                        />
                        <i aria-hidden="true" />
                    </label>
                {suggestions.length === 0 ? (
                    <div className="relationship-suggestions-empty">
                        <span aria-hidden="true">✓</span>
                        <strong>No likely missing links</strong>
                        <p>Add columns such as <code>user_id</code> beside a <code>users.id</code> primary key to see a suggestion.</p>
                    </div>
                ) : (
                    suggestions.map((suggestion) => {
                        const label = relationshipLabel(suggestion);
                        const accepted = suggestion.inferenceStatus === 'accepted';
                        return (
                            <article className={`relationship-suggestion-card ${accepted ? 'is-accepted' : ''}`} key={suggestion.id}>
                                <div className="relationship-suggestion-card-topline">
                                    <ConfidenceScore suggestion={suggestion} />
                                    {accepted && <span className="relationship-suggestion-accepted">✓ Accepted</span>}
                                </div>

                                <div className="relationship-suggestion-endpoints" title={label}>
                                    <code>{suggestion.from.table}.{suggestion.from.column}</code>
                                    <span aria-hidden="true">→</span>
                                    <code>{suggestion.to.table}.{suggestion.to.column}</code>
                                </div>

                                {Array.isArray(suggestion.reasons) && suggestion.reasons.length > 0 && (
                                    <ul className="relationship-suggestion-reasons" aria-label="Confidence reasons">
                                        {suggestion.reasons.slice(0, 3).map((reason) => <li key={reason}>{reason}</li>)}
                                    </ul>
                                )}

                                <div className="relationship-suggestion-actions">
                                    {!accepted && (
                                        <button
                                            type="button"
                                            className="relationship-suggestion-accept"
                                            disabled={inference.disabled}
                                            aria-label={`Accept relationship ${label}`}
                                            onClick={() => inference.accept(suggestion.id)}
                                        >
                                            Accept
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        className="relationship-suggestion-reject"
                                        disabled={inference.disabled}
                                        aria-label={`${accepted ? 'Remove' : 'Reject'} relationship ${label}`}
                                        onClick={() => inference.reject(suggestion.id)}
                                    >
                                        {accepted ? 'Remove' : 'Reject'}
                                    </button>
                                </div>
                            </article>
                        );
                    })
                )}
                </section>
            </div>

            <footer className="relationship-suggestions-footer">
                <p>{inference.disabled ? 'Finish the AI preview to review these links.' : 'Heuristic design review — accepted suggestions do not change SQL.'}</p>
                {inference.rejectedCount > 0 && (
                    <button type="button" disabled={inference.disabled} onClick={inference.resetRejected}>
                        Restore {inference.rejectedCount} rejected
                    </button>
                )}
            </footer>
        </section>
    );
}
