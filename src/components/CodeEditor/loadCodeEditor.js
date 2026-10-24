/** Shares the local editor download; explicit retries bypass failed module URLs. */
import runtime from './runtimeManifest.js';

let editorPromise = null;
let runtimePromise = null;
let loadedEditor = null;
let attempt = 0;
const styleLoads = new Map();

function loadStyle(href, retryNumber) {
    if (styleLoads.has(href)) return styleLoads.get(href);
    const url = new URL(href);
    if (retryNumber) url.searchParams.set('editor-retry', String(retryNumber));
    const promise = new Promise((resolve, reject) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = url.href;
        link.onload = () => resolve();
        link.onerror = () => {
            link.remove();
            styleLoads.delete(href);
            reject(new Error('Editor stylesheet is unavailable'));
        };
        document.head.appendChild(link);
    });
    styleLoads.set(href, promise);
    return promise;
}

export function getLoadedCodeEditor() {
    return loadedEditor;
}

export function loadCodeEditor() {
    if (!editorPromise) {
        const entry = new URL(runtime.url, window.location.href);
        // Browsers cache failed modules. The emitted entry contains the engine
        // itself, so changing its URL retries the code without duplicating
        // React or reloading (and losing) the user's document.
        const retryNumber = attempt++;
        if (retryNumber) entry.searchParams.set('editor-retry', String(retryNumber));
        const styles = runtime.styles.map(name => {
            const url = new URL(name, entry);
            return loadStyle(url.href, retryNumber);
        });
        // A stylesheet retry reuses successfully downloaded code, and vice
        // versa. In particular, never evaluate a second copy of the engine
        // merely because its stylesheet failed.
        runtimePromise ??= import(/* @vite-ignore */ entry.href).catch(error => {
            runtimePromise = null;
            throw error;
        });
        editorPromise = Promise.all([runtimePromise, ...styles]).then(([module]) => {
            loadedEditor = module.default;
            return loadedEditor;
        }).catch(error => {
            editorPromise = null;
            throw error;
        });
    }
    return editorPromise;
}
