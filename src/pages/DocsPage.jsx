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
        'Save the document locally, or export PNG, SVG, or PDF from the diagram toolbar. Save includes SQL tabs, layout, colors, and Query text.',
    ], note: 'The browser SQL engines implement a supported subset of each dialect. They do not connect to a database server; check execution diagnostics for unsupported statements.' },
    { id: 'prisma-to-erd', title: 'Prisma to ERD', route: '/prisma-to-erd/new', intro: 'Visualize schema.prisma models, views, enums, composite types, and relations.', steps: [
        'Choose the sample or a blank Prisma schema, then paste your schema into the editor.',
        'Use the explorer to find models and fields, inspect relationships, and jump between source and diagram.',
        'Review parser diagnostics, including unsupported or incomplete schema declarations.',
        'Arrange and color the diagram, then save the source and renderer layout locally or export the diagram.',
    ], note: 'Prisma conversion is a browser implementation with diagnostics. It does not run Prisma migrations or contact your datasource.' },
    { id: 'erd-builder', title: 'ERD Builder', route: '/erd-builder/new', intro: 'Design a conceptual ER diagram with entities, relationships, attributes, and extended ER shapes.', steps: [
        'Choose the healthcare sample or an empty canvas. Add shapes from the library and connect them.',
        'Select shapes or connectors to edit labels, keys, cardinality, participation, and appearance.',
        'Use undo and redo, automatic layout, selection tools, and the minimap to organize your diagram.',
        'Open SQL export, choose a dialect, and review the mapping diagnostics. Download SQL or open the generated schema in the SQL editor.',
        'Save the graph and viewport locally, or export a diagram image.',
    ], note: 'Some conceptual shapes require mapping decisions or are unsupported in SQL export. Review the export diagnostics before using generated SQL.' },
    { id: 'spreadsheet-to-sql', title: 'Spreadsheet to SQL', route: '/spreadsheet-to-sql', intro: 'Convert a worksheet into CREATE TABLE and INSERT statements entirely in the browser.', steps: [
        'Upload a CSV, TSV, text file, or XLSX workbook. Files are limited to 25 MiB; older XLS workbooks are unsupported.',
        'Choose a worksheet, header row, table name, and SQLite, PostgreSQL, MySQL, or SQL Server output.',
        'Review inferred types and override columns in Settings. Apply the settings to regenerate SQL.',
        'Inspect the preview and conversion issues, then copy SQL or download SQL and the issue report. Import that SQL in the SQL editor to visualize it.',
    ], note: 'Spreadsheet conversion is temporary. Download your SQL before leaving the tool; formula cells use cached workbook values when available.' },
];

export default function DocsPage() {
    const { guide } = useParams();
    const selected = guides.find(item => item.id === guide);
    useEffect(() => { document.title = `${selected?.title || 'Tool guides'} — ERD Go`; }, [selected]);
    return (
        <div className="docs-page"><ToolNavigation />
            <main className="docs-main">
                <h1>{selected?.title || 'Tool guides'}</h1>
                <p>All tools run in your browser. Saved diagrams stay on this device; no account is required.</p>
                <nav className="docs-links" aria-label="Tool guides">{guides.map(item => <Link key={item.id} to={`/docs/${item.id}`} aria-current={item === selected ? 'page' : undefined}>{item.title}</Link>)}</nav>
                {guide && !selected && <p role="status">This guide was not found. Choose one of the tools above.</p>}
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
