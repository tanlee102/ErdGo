import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import codeEditorRuntime from './scripts/code-editor-runtime.js';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    plugins: [react({ include: '**/*.{jsx,js}' }), codeEditorRuntime()],
    resolve: { alias: { '@': path.resolve(projectRoot, './src') } },
    server: { port: 3000, strictPort: true },
    build: {
        outDir: 'dist',
        sourcemap: false,
        chunkSizeWarningLimit: 2000,
        rollupOptions: {
            output: {
                manualChunks(id) {
                    if (id.endsWith('/components/CodeEditor/monacoRuntime.js')) return 'vendor-monaco';
                    if (id.includes('vite/preload-helper') || id.includes('commonjsHelpers')) return 'runtime-helpers';
                    if (!id.includes('node_modules')) return undefined;
                    if (id.includes('/react-dom/') && /(?:server\.|react-dom-server)/.test(id)) return 'vendor-react-server';
                    if (id.includes('monaco-editor') || id.includes('@monaco-editor')) return 'vendor-monaco';
                    if (id.includes('/node_modules/react/') || id.includes('react-dom') || id.includes('react-router')) return 'vendor-react';
                    if (id.includes('elkjs')) return 'vendor-elkjs';
                    if (id.includes('react-markdown') || id.includes('@google/genai')) return 'vendor-ai';
                    if (id.includes('sql-formatter')) return 'vendor-utils';
                    return undefined;
                },
            },
        },
    },
    esbuild: { loader: 'jsx', include: /\.(jsx?|js)$/, exclude: [], drop: ['debugger'] },
    optimizeDeps: { esbuildOptions: { loader: { '.js': 'jsx' } }, include: ['react-dom/server', '@monaco-editor/react', 'monaco-editor/esm/vs/editor/edcore.main.js', 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js'] },
    worker: { format: 'es' },
    test: { globals: true, maxWorkers: 4, environment: 'node', setupFiles: ['./tests/setup/vitest.setup.js'] },
});
