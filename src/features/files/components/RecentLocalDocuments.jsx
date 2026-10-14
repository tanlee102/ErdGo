import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listLocalDocuments, subscribeToLocalDocuments } from '@/features/files/lib/localFileStore';
import { getDocumentKindLabel, getDocumentRoute } from '@/features/files/lib/fileDocuments';

export default function RecentLocalDocuments() {
    const [documents, setDocuments] = useState([]);
    const [error, setError] = useState('');
    const [showAll, setShowAll] = useState(false);
    const refresh = useCallback(() => {
        try { setDocuments(listLocalDocuments()); setError(''); }
        catch (error) { setError(error.message); }
    }, []);
    useEffect(() => { refresh(); return subscribeToLocalDocuments(refresh); }, [refresh]);
    if (error) return <p role="alert" className="home-storage-error">{error}</p>;
    if (!documents.length) return null;
    return (
        <section className="home-tools home-recent" aria-labelledby="recent-title">
            <h2 id="recent-title">Your local diagrams</h2>
            <div className="home-tool-grid">
                {(showAll ? documents : documents.slice(0, 6)).map(document => (
                    <Link className="home-tool-card" key={document.id} to={getDocumentRoute(document)}>
                        <span>{getDocumentKindLabel(document)}</span>
                        <h3>{document.name}</h3>
                        <p>Saved in this browser</p>
                    </Link>
                ))}
            </div>
            {documents.length > 6 && <button type="button" className="home-show-files" onClick={() => setShowAll(value => !value)}>{showAll ? 'Show recent diagrams' : `Show all ${documents.length} diagrams`}</button>}
        </section>
    );
}
