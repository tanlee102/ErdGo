import { useContext } from 'react';
import { Link } from 'react-router-dom';
import { ThemeContext } from '@/contexts/ThemeContext';
import './index.css';

export default function ToolNavigation() {
    const { theme, toggleTheme } = useContext(ThemeContext);
    return (
        <header className="tool-navigation">
            <Link to="/" className="tool-navigation-brand">ERD Go</Link>
            <nav aria-label="Tools">
                <Link to="/e/new">SQL to ERD</Link>
                <Link to="/prisma-to-erd/new">Prisma</Link>
                <Link to="/erd-builder/new">Builder</Link>
                <Link to="/spreadsheet-to-sql">Spreadsheet</Link>
                <Link to="/docs">Docs</Link>
            </nav>
            <button type="button" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>{theme === 'dark' ? '☀' : '☾'}</button>
        </header>
    );
}
