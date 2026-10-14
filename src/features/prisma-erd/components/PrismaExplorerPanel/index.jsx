/** Searchable model/relation explorer that focuses matching tables in the rendered Prisma ERD. */
import SearchIcon from '@/icons/SearchIcon';
import { formatPrismaCardinality } from '@/features/prisma-erd/lib/prismaExplorer';

function RelationBadge({ children }) {
    if (!children) return null;
    return <span className="prisma-erd-relation-badge">{children}</span>;
}

function RelationInspector({ relation, onClose, onFocusTable }) {
    if (!relation) return null;
    return (
        <article className="prisma-erd-relation-inspector" aria-label="Prisma relation inspector">
            <header className="prisma-erd-relation-inspector-header">
                <div>
                    <span>Relation Inspector</span>
                    <strong>{relation.title}</strong>
                </div>
                <button type="button" onClick={onClose} aria-label="Close relation inspector" title="Close relation inspector">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                    </svg>
                </button>
            </header>
            <dl className="prisma-erd-relation-facts">
                <div>
                    <dt>Kind</dt>
                    <dd>{relation.kind}</dd>
                </div>
                <div>
                    <dt>From</dt>
                    <dd>{relation.fromTable}</dd>
                </div>
                <div>
                    <dt>To</dt>
                    <dd>{relation.toTable}</dd>
                </div>
                <div>
                    <dt>Fields</dt>
                    <dd>{`[${relation.fromColumns.join(', ')}]`}</dd>
                </div>
                <div>
                    <dt>References</dt>
                    <dd>{`[${relation.toColumns.join(', ')}]`}</dd>
                </div>
                <div>
                    <dt>Cardinality</dt>
                    <dd>
                        {formatPrismaCardinality(relation.fromCard)} to {formatPrismaCardinality(relation.toCard)}
                    </dd>
                </div>
                {relation.relationName && (
                    <div>
                        <dt>Name</dt>
                        <dd>{relation.relationName}</dd>
                    </div>
                )}
                {relation.fkName && relation.fkName !== relation.relationName && (
                    <div>
                        <dt>Map</dt>
                        <dd>{relation.fkName}</dd>
                    </div>
                )}
                {relation.actionText && (
                    <div>
                        <dt>Actions</dt>
                        <dd>{relation.actionText}</dd>
                    </div>
                )}
            </dl>
            <div className="prisma-erd-relation-actions">
                <button type="button" onClick={() => onFocusTable(relation.fromTable)}>
                    Focus {relation.fromTable}
                </button>
                <button type="button" onClick={() => onFocusTable(relation.toTable)}>
                    Focus {relation.toTable}
                </button>
            </div>
        </article>
    );
}

function RelatedRelations({ tableName, relations, onSelectRelation }) {
    if (!tableName || relations.length === 0) return null;
    return (
        <div className="prisma-erd-related-relations" aria-label={`${tableName} relations`}>
            <div className="prisma-erd-related-relations-header">
                <span>Model Relations</span>
                <strong>{tableName}</strong>
            </div>
            <div className="prisma-erd-related-relation-list">
                {relations.slice(0, 6).map((relation) => (
                    <button type="button" key={relation.id} onClick={() => onSelectRelation(relation.id)} title={relation.title}>
                        <span>{relation.title}</span>
                        <small>{relation.detail}</small>
                    </button>
                ))}
            </div>
        </div>
    );
}

export default function PrismaExplorerPanel({
    query,
    showResults,
    results,
    selectedItemId,
    activeRelation,
    selectedTableName,
    selectedTableRelations,
    onQueryChange,
    onOpenResults,
    onClearQuery,
    onSelectItem,
    onSelectRelation,
    onCloseRelation,
    onFocusTable,
}) {
    const hasQuery = query.trim().length > 0;

    return (
        <section className="prisma-erd-explorer" aria-label="Prisma schema explorer">
            <div className="prisma-erd-search-control">
                <SearchIcon width="16px" height="16px" className="prisma-erd-search-icon" />
                <input
                    type="search"
                    value={query}
                    onChange={(event) => onQueryChange(event.target.value)}
                    onFocus={onOpenResults}
                    onKeyDown={(event) => {
                        if (event.key === 'Escape') onClearQuery();
                    }}
                    placeholder="Search models, fields, relations"
                    aria-label="Search Prisma schema"
                    autoComplete="off"
                    spellCheck="false"
                />
                {hasQuery && (
                    <button type="button" className="prisma-erd-search-clear" onClick={onClearQuery} aria-label="Clear Prisma search" title="Clear Prisma search">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M18 6 6 18" />
                            <path d="m6 6 12 12" />
                        </svg>
                    </button>
                )}
            </div>

            {hasQuery && showResults && (
                <div className="prisma-erd-search-results" role="listbox" aria-label="Prisma search results">
                    {results.length > 0 ? (
                        results.map((item) => (
                            <button
                                type="button"
                                role="option"
                                aria-selected={item.id === selectedItemId}
                                className={`prisma-erd-search-result${item.id === selectedItemId ? ' is-selected' : ''}`}
                                key={item.id}
                                onClick={() => onSelectItem(item)}
                                title={`${item.typeLabel}: ${item.label}`}
                                aria-label={`${item.typeLabel} ${item.label}${item.detail ? ` ${item.detail}` : ''}`}
                            >
                                <RelationBadge>{item.typeLabel}</RelationBadge>
                                <span className="prisma-erd-search-result-main">
                                    <strong>{item.label}</strong>
                                    {item.detail && <small>{item.detail}</small>}
                                </span>
                            </button>
                        ))
                    ) : (
                        <div className="prisma-erd-search-empty" role="status">
                            No matches
                        </div>
                    )}
                </div>
            )}

            <RelationInspector relation={activeRelation} onClose={onCloseRelation} onFocusTable={onFocusTable} />
            {!activeRelation && <RelatedRelations tableName={selectedTableName} relations={selectedTableRelations} onSelectRelation={onSelectRelation} />}
        </section>
    );
}
