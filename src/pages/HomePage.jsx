import { useContext, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ThemeContext } from '@/contexts/ThemeContext';
import DarkIcon from '@/icons/DarkIcon';
import HomeIcon from '@/icons/HomeIcon';
import RecentLocalDocuments from '@/features/files/components/RecentLocalDocuments';
import './HomePage.css';

function ArrowIcon() {
    return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M4 10h11m-4-4 4 4-4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
    );
}

export default function HomePage() {
    const { theme, toggleTheme } = useContext(ThemeContext);
    const nextTheme = theme === 'dark' ? 'light' : 'dark';

    useEffect(() => {
        document.title = 'ERD Go — Free SQL to ERD Diagram Editor';
    }, []);

    return (
        <main className="home-page">
            <div className="home-grid" aria-hidden="true" />

            <header className="home-nav">
                <Link className="home-brand" to="/" aria-label="ERD Go home">
                    <span className="home-brand-mark"><HomeIcon /></span>
                    <span>ERD Go</span>
                </Link>

                <button className="home-theme-button" type="button" onClick={toggleTheme} aria-label={`Switch to ${nextTheme} theme`} title={`Switch to ${nextTheme} theme`}>
                    <DarkIcon />
                </button>
            </header>

            <section className="home-hero" aria-labelledby="home-title">
                <div className="home-hero-glow" aria-hidden="true" />
                <p className="home-eyebrow">SQL design · Local first</p>
                <h1 id="home-title">Edit SQL.<br /><span>See the ERD.</span></h1>
                <p className="home-intro">Design your database, explore its data, and run queries directly in your browser.</p>
                <Link className="home-open-button" to="/e/new">
                    <span>Open Editor</span>
                    <ArrowIcon />
                </Link>
                <p className="home-local-note"><span aria-hidden="true" /> No account. Your diagrams stay in this browser.</p>
            </section>
            <section className="home-tools" aria-labelledby="tools-title">
                <h2 id="tools-title">More ways to design your database</h2>
                <div className="home-tool-grid">
                    <Link className="home-tool-card" to="/prisma-to-erd/new"><span>Schema visualizer</span><h3>Prisma to ERD</h3><p>Explore models, fields, and relationships from your Prisma schema.</p><ArrowIcon /></Link>
                    <Link className="home-tool-card" to="/erd-builder/new"><span>Visual design</span><h3>ERD Builder</h3><p>Draw entities and relationships, then review and export SQL.</p><ArrowIcon /></Link>
                    <Link className="home-tool-card" to="/spreadsheet-to-sql"><span>Data import</span><h3>Spreadsheet to SQL</h3><p>Convert CSV, TSV, and Excel worksheets into schema and sample data.</p><ArrowIcon /></Link>
                </div>
            </section>
            <RecentLocalDocuments />
            <footer className="home-footer"><Link to="/docs">Tool guides</Link><a href="https://github.com/tanlee102/ErdGo" target="_blank" rel="noopener noreferrer">Source on GitHub</a><span>Free · Open source · Local first</span></footer>
        </main>
    );
}
