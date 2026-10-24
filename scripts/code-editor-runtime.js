/** Emit the local editor URL and styles without eagerly importing its engine. */
import path from 'node:path';

const stylesMarker = '__ERDGO_EDITOR_STYLES__';

export default function codeEditorRuntime() {
    let config;
    let referenceId;
    return {
        name: 'code-editor-runtime',
        enforce: 'post',
        configResolved(value) { config = value; },
        load(id) {
            if (config.command !== 'build' || id !== path.resolve(config.root, 'src/components/CodeEditor/runtimeManifest.js')) return;
            // Vite normally drops page entry exports. This independently
            // imported entry must retain its component export.
            referenceId = this.emitFile({ type: 'chunk', id: path.resolve(config.root, 'src/components/CodeEditor/monacoRuntime.js'), name: 'monacoRuntime', preserveSignature: 'strict' });
            return `export default { url: import.meta.ROLLUP_FILE_URL_${referenceId}, styles: ${JSON.stringify(stylesMarker)} };`;
        },
        generateBundle(_, bundle) {
            if (!referenceId) return;
            const entryName = this.getFileName(referenceId);
            const entry = bundle[entryName];
            const styles = [...(entry.viteMetadata?.importedCss || [])].map(name => path.posix.relative(path.posix.dirname(entryName), name));
            for (const output of Object.values(bundle)) {
                if (output.type === 'chunk' && output.code.includes(stylesMarker)) {
                    output.code = output.code.replace(JSON.stringify(stylesMarker), JSON.stringify(styles));
                }
            }
        },
    };
}
