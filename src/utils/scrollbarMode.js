/** Detects overlay scrollbars once and exposes the result as a document-level CSS hook. */
export function setScrollbarMode(documentRef = typeof document === 'undefined' ? null : document) {
    if (!documentRef?.body || !documentRef.documentElement) return;

    const probe = documentRef.createElement('div');
    probe.style.cssText = 'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll;';
    documentRef.body.appendChild(probe);

    documentRef.documentElement.dataset.scrollbarMode = probe.offsetWidth === probe.clientWidth ? 'overlay' : 'classic';
    probe.remove();
}
