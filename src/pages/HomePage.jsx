import { useContext, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ThemeContext } from '@/contexts/ThemeContext';
import DarkIcon from '@/icons/DarkIcon';
import HomeIcon from '@/icons/HomeIcon';
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
        </main>
    );
}
