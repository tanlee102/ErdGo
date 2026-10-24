import { useContext } from 'react';
import { Link } from 'react-router-dom';
import { ThemeContext } from '@/contexts/ThemeContext';
import './index.css';

export default function ToolNavigation() {
    const { theme, toggleTheme } = useContext(ThemeContext);
    return (
        <header className="tool-navigation">
            <Link to="/" className="tool-navigation-brand">ERD Go</Link>
            <nav aria-label="SQL editor navigation">
                <Link to="/e/new">SQL to ERD</Link>
                <Link to="/docs">SQL guide</Link>
            </nav>
            <button type="button" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>{theme === 'dark' ? '☀' : '☾'}</button>
        </header>
    );
}
