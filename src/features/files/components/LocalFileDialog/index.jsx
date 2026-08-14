import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { RootLayoutContext } from '@/contexts/RootLayoutContext';
import { useConfirm } from '@/components/ConfirmDialog';
import { useNavigationGuard } from '@/components/NavigationGuard';
import { useNotifications } from '@/components/Notifications';
import { deleteLocalDocument, listLocalDocuments, subscribeToLocalDocuments } from '@/features/files/lib/localFileStore';
import './index.css';

function formatUpdatedAt(value) {
    if (!value) return 'Unknown';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

const DiagramIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v6c0 1.65 3.58 3 8 3s8-1.35 8-3V5M4 11v6c0 1.65 3.58 3 8 3s8-1.35 8-3v-6" />
    </svg>
);

const SearchIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
    </svg>
);

const TrashIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 10v7M14 10v7" />
    </svg>
);

export default function LocalFileDialog() {
    const { displayModalListFile, setDisplayModalListFile } = useContext(RootLayoutContext);
    const { confirm } = useConfirm();
    const { confirmNavigation, runAfterNavigationConfirm } = useNavigationGuard();
    const { notifyError, notifySuccess } = useNotifications();
    const navigate = useNavigate();
    const location = useLocation();
    const [documents, setDocuments] = useState([]);
    const [query, setQuery] = useState('');

    const refresh = useCallback(() => {
        try {
            setDocuments(listLocalDocuments());
        } catch (error) {
            notifyError(error.message, { title: 'Local files unavailable' });
        }
    }, [notifyError]);

    useEffect(() => subscribeToLocalDocuments(refresh), [refresh]);
    useEffect(() => {
        if (displayModalListFile) refresh();
    }, [displayModalListFile, refresh]);

    const filteredDocuments = useMemo(() => {
        const normalizedQuery = query.trim().toLowerCase();
        if (!normalizedQuery) return documents;
        return documents.filter((document) => document.name.toLowerCase().includes(normalizedQuery));
    }, [documents, query]);

    if (!displayModalListFile) return null;

    const activeDocumentId = location.pathname.match(/^\/e\/([^/]+)$/)?.[1] || null;

    const close = () => setDisplayModalListFile(false);
    const openDocument = (id) => {
        runAfterNavigationConfirm(() => {
            close();
            navigate(`/e/${id}`);
        });
    };
    const createNew = () => {
        runAfterNavigationConfirm(() => {
            close();
            navigate('/e/new');
        });
    };
    const removeDocument = async (document) => {
        if (location.pathname === `/e/${document.id}` && !(await confirmNavigation())) return;
        const accepted = await confirm({ title: 'Delete local diagram?', message: `“${document.name}” will be removed from this browser. This cannot be undone.`, confirmText: 'Delete diagram', tone: 'danger' });
        if (!accepted) return;
        try {
            deleteLocalDocument(document.id);
            notifySuccess('The local diagram was deleted.', { title: 'Diagram deleted' });
            if (location.pathname === `/e/${document.id}`) {
                close();
                navigate('/e/new', { replace: true });
            }
        } catch (error) {
            notifyError(error.message, { title: 'Delete failed' });
        }
    };

    return (
        <div className="local-file-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
            <section className="local-file-dialog" role="dialog" aria-modal="true" aria-labelledby="local-files-title">
                <header className="local-file-dialog-header">
                    <div className="local-file-dialog-title">
                        <span className="local-file-dialog-title-icon"><DiagramIcon /></span>
                        <div>
                            <h2 id="local-files-title">Local diagrams</h2>
                            <p>{documents.length} diagram{documents.length === 1 ? '' : 's'} saved in this browser</p>
                        </div>
                    </div>
                    <div className="local-file-dialog-search">
                        <SearchIcon />
                        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search diagrams" aria-label="Search local diagrams" autoFocus />
                        {query && <button type="button" onClick={() => setQuery('')} aria-label="Clear search">×</button>}
                    </div>
                    <button type="button" className="local-file-dialog-close" onClick={close} aria-label="Close local diagrams">×</button>
                </header>
                <div className="local-file-dialog-toolbar">
                    <span>Diagrams are private to this browser.</span>
                    <button type="button" className="local-file-dialog-new" onClick={createNew}><span aria-hidden="true">＋</span> New diagram</button>
                </div>
                <div className="local-file-dialog-table-head" aria-hidden="true">
                    <span>Name</span><span>Date modified</span><span>Date created</span><span>Actions</span>
                </div>
                <div className="local-file-dialog-list" role="list">
                    {filteredDocuments.length === 0 ? (
                        <div className="local-file-dialog-empty">
                            <span className="local-file-dialog-empty-icon"><DiagramIcon /></span>
                            <strong>{documents.length === 0 ? 'No saved diagrams yet' : 'No matching diagrams'}</strong>
                            <span>Use the save button in the editor to keep a diagram locally.</span>
                        </div>
                    ) : filteredDocuments.map((document) => (
                        <article key={document.id} className={`local-file-dialog-item${activeDocumentId === document.id ? ' is-active' : ''}`} role="listitem">
                            <button type="button" className="local-file-dialog-open" onClick={() => openDocument(document.id)}>
                                <span className="local-file-dialog-name-cell">
                                    <span className="local-file-dialog-file-icon"><DiagramIcon /></span>
                                    <span className="local-file-dialog-name-copy">
                                        <strong>{document.name}</strong>
                                        <small>{activeDocumentId === document.id ? 'Current diagram' : 'SQL to ERD'}</small>
                                    </span>
                                    {activeDocumentId === document.id && <span className="local-file-dialog-selected">Selected</span>}
                                </span>
                                <span className="local-file-dialog-date">{formatUpdatedAt(document.updatedAt)}</span>
                                <span className="local-file-dialog-date local-file-dialog-date-created">{formatUpdatedAt(document.createdAt)}</span>
                            </button>
                            <button type="button" className="local-file-dialog-delete" onClick={() => removeDocument(document)} aria-label={`Delete ${document.name}`} title={`Delete ${document.name}`}><TrashIcon /></button>
                        </article>
                    ))}
                </div>
                <footer>
                    <span aria-hidden="true">◆</span>
                    <span>Local storage can be cleared by browser settings. Export important diagrams as a backup.</span>
                </footer>
            </section>
        </div>
    );
}
