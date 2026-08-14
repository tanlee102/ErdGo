import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    plugins: [react({ include: '**/*.{jsx,js}' })],
    resolve: { alias: { '@': path.resolve(projectRoot, './src') } },
    server: { port: 3001 },
    build: {
        outDir: 'dist',
        sourcemap: false,
        chunkSizeWarningLimit: 2000,
        rollupOptions: {
            output: {
                manualChunks(id) {
                    if (!id.includes('node_modules')) return undefined;
                    if (id.includes('monaco-editor') || id.includes('@monaco-editor')) return 'vendor-monaco';
                    if (id.includes('react-dom') || id.includes('react-router')) return 'vendor-react';
                    if (id.includes('elkjs')) return 'vendor-elkjs';
                    if (id.includes('react-markdown') || id.includes('@google/genai')) return 'vendor-ai';
                    if (id.includes('sql-formatter')) return 'vendor-utils';
                    return undefined;
                },
            },
        },
    },
    esbuild: { loader: 'jsx', include: /\.(jsx?|js)$/, exclude: [], drop: ['debugger'] },
    optimizeDeps: { esbuildOptions: { loader: { '.js': 'jsx' } }, exclude: ['monaco-editor'] },
    worker: { format: 'es' },
});
