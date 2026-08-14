/** Compact, accessible schema counter shared by schema-oriented tool footers. */
import './index.css';

const TABLE_ICON = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 9h18M9 9v11" />
    </svg>
);

const SCHEMA_STAT_ICONS = {
    tables: TABLE_ICON,
    models: TABLE_ICON,
    views: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
            <circle cx="12" cy="12" r="2.5" />
        </svg>
    ),
    relations: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="5" cy="12" r="2.5" />
            <circle cx="19" cy="6" r="2.5" />
            <circle cx="19" cy="18" r="2.5" />
            <path d="M7.5 12h2.5c3.5 0 3.5-6 6.5-6M10 12c3.5 0 3.5 6 6.5 6" />
        </svg>
    ),
    enums: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="5" cy="6" r="1" fill="currentColor" stroke="none" />
            <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
            <circle cx="5" cy="18" r="1" fill="currentColor" stroke="none" />
            <path d="M9 6h11M9 12h11M9 18h11" />
        </svg>
    ),
    composites: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
            <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
        </svg>
    ),
};

export default function SchemaStat({ kind, label, value }) {
    const accessibleLabel = `${label}: ${value}`;
    return (
        <span className={`schema-stat schema-stat--${kind} ${value === 0 ? 'is-empty' : ''}`} aria-label={accessibleLabel} data-tooltip={accessibleLabel} tabIndex="0">
            <span className="schema-stat-icon" aria-hidden="true">{SCHEMA_STAT_ICONS[kind]}</span>
            <strong>{value}</strong>
        </span>
    );
}
