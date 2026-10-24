import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import ToolNavigation from '@/components/ToolNavigation';
import './DocsPage.css';

const guides = [
    { id: 'sql-to-erd', title: 'SQL to ERD', route: '/e/new', intro: 'Paste a schema or import SQL files to explore an interactive database diagram.', steps: [
        'Start with the sample, a blank schema, or imported SQL files. Each file becomes a tab; enabled tabs run in their displayed order.',
        'Use Add Table, or select a table on the canvas to edit its name and columns. Review destructive changes before applying them. SQL remains the source of truth.',
        'Drag tables to arrange them, reconnect supported foreign keys, or use automatic layout. Review inferred relationships and schema quality in ERD health.',
        'Switch to Data to replay supported schema and sample-data statements. Query runs supported read-only SELECT statements against that in-memory data.',
        'Group tables visually with Table groups. Groups store presentation data and do not change SQL.',
        'Generate sample INSERT statements from Data View, review the preview, and add them as a new SQL tab.',
        'Save the document locally, or export PNG, SVG, or PDF from the diagram toolbar. Save includes SQL tabs, layout, colors, and Query text.',
    ], note: 'The browser SQL engines implement a supported subset of each dialect. They do not connect to a database server; check execution diagnostics for unsupported statements.' },

];

export default function DocsPage() {
    const { guide } = useParams();
    const selected = guides.find(item => item.id === guide) || (!guide ? guides[0] : null);
    useEffect(() => { document.title = `${selected?.title || 'SQL guide'} — ERD Go`; }, [selected]);
    return (
        <div className="docs-page"><ToolNavigation />
            <main className="docs-main">
                <h1>{selected?.title || 'SQL guide'}</h1>
                <p>SQL conversion and editing run in your browser. Saved diagrams stay on this device; no account is required.</p>
                <nav className="docs-links" aria-label="SQL guide">{guides.map(item => <Link key={item.id} to={`/docs/${item.id}`} aria-current={item === selected ? 'page' : undefined}>{item.title}</Link>)}</nav>
                {guide && !selected && <p role="status">This guide was not found. Open the SQL guide above.</p>}
                {(selected ? [selected] : guides).map(item => <article key={item.id}>
                    <h2>{item.title}</h2><p>{item.intro}</p>
                    <ol>{item.steps.map(step => <li key={step}>{step}</li>)}</ol>
                    <p className="docs-note">{item.note}</p>
                    <Link className="docs-open-tool" to={item.route}>Open {item.title} →</Link>
                </article>)}
                <p className="docs-note">Local storage can be cleared by browser settings. Export important diagrams. The optional SQL AI editor sends a request to Gemini only when you provide and enable your own key.</p>
            </main>
        </div>
    );
}
