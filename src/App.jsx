import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import '@/styles/globals.css';
import ThemeProvider from '@/contexts/ThemeContext';
import HomePage from '@/pages/HomePage';

const EditorWorkspace = lazy(() => import('@/pages/EditorWorkspace'));

function EditorLoader() {
    return <div className="page-loader" role="status" aria-label="Loading editor"><span className="page-loader-spinner" /></div>;
}

export default function App() {
    return (
        <ThemeProvider>
            <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/e/:index" element={<Suspense fallback={<EditorLoader />}><EditorWorkspace /></Suspense>} />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
        </ThemeProvider>
    );
}
