import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import '@/styles/globals.css';
import ThemeProvider from '@/contexts/ThemeContext';
import HomePage from '@/pages/HomePage';

const EditorWorkspace = lazy(() => import('@/pages/EditorWorkspace'));
const EditorPage = lazy(() => import('@/pages/EditorPage'));
const PrismaToErdPage = lazy(() => import('@/pages/PrismaToErdPage'));
const ErdDraftPage = lazy(() => import('@/pages/ErdDraftPage'));
const SpreadsheetToSqlPage = lazy(() => import('@/pages/SpreadsheetToSqlPage'));
const DocsPage = lazy(() => import('@/pages/DocsPage'));

function EditorLoader() {
    return <div className="page-loader" role="status" aria-label="Loading editor"><span className="page-loader-spinner" /></div>;
}

export default function App() {
    return (
        <ThemeProvider>
            <Routes>
                <Route path="/" element={<HomePage />} />
                <Route element={<Suspense fallback={<EditorLoader />}><EditorWorkspace /></Suspense>}>
                    <Route path="/e/:index" element={<Suspense fallback={<EditorLoader />}><EditorPage /></Suspense>} />
                    <Route path="/prisma-to-erd" element={<Navigate to="/prisma-to-erd/new" replace />} />
                    <Route path="/prisma-to-erd/:index" element={<Suspense fallback={<EditorLoader />}><PrismaToErdPage /></Suspense>} />
                    <Route path="/erd-builder" element={<Navigate to="/erd-builder/new" replace />} />
                    <Route path="/erd-builder/:index" element={<Suspense fallback={<EditorLoader />}><ErdDraftPage /></Suspense>} />
                    <Route path="/erd-designer" element={<Navigate to="/erd-builder/new" replace />} />
                    <Route path="/erd-draft" element={<Navigate to="/erd-builder/new" replace />} />
                    <Route path="/spreadsheet-to-sql" element={<Suspense fallback={<EditorLoader />}><SpreadsheetToSqlPage /></Suspense>} />
                </Route>
                <Route path="/docs" element={<Suspense fallback={<EditorLoader />}><DocsPage /></Suspense>} />
                <Route path="/docs/:guide" element={<Suspense fallback={<EditorLoader />}><DocsPage /></Suspense>} />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
        </ThemeProvider>
    );
}
