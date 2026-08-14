import './renderDiffBlocks.css';

// Store cleanup function globally for proper disposal
let currentCleanup = null;

export const renderDiffBlocks = (editor, monaco, diffBlocks, onAccept, onReject) => {
    // Clean up previous render first
    if (currentCleanup) {
        currentCleanup();
        currentCleanup = null;
    }

    if (!editor || !monaco || !diffBlocks?.length) return;

    const decorations = [];
    const widgets = [];
    let rafId = null;
    let scrollListener = null;
    let layoutListener = null;
    let clickHandler = null;

    // Pre-compute decorations
    for (let i = 0; i < diffBlocks.length; i++) {
        const block = diffBlocks[i];

        if (block.displayDeleteRange) {
            const r = block.displayDeleteRange;
            decorations.push({
                range: new monaco.Range(r.startLine, 1, r.endLine, 1),
                options: {
                    isWholeLine: true,
                    className: 'delete-block',
                    glyphMarginClassName: 'delete-glyph',
                },
            });
        }

        if (block.displayAddRange) {
            const r = block.displayAddRange;
            decorations.push({
                range: new monaco.Range(r.startLine, 1, r.endLine, 1),
                options: {
                    isWholeLine: true,
                    className: 'add-block',
                    glyphMarginClassName: 'add-glyph',
                },
            });
        }
    }

    // Batch decoration update
    if (window.diffDecorations) {
        try {
            editor.deltaDecorations(window.diffDecorations, []);
        } catch {
            // Editor disposed - ignore
        }
    }
    window.diffDecorations = editor.deltaDecorations([], decorations);

    // Cache DOM references
    const editorContainer = editor.getContainerDomNode();
    const existingButtons = editorContainer.querySelectorAll('.diff-action-buttons');
    existingButtons.forEach((btn) => btn.remove());

    // RAF-based position update
    const updateAllButtons = () => {
        if (rafId) cancelAnimationFrame(rafId);

        rafId = requestAnimationFrame(() => {
            try {
                const scrollTop = editor.getScrollTop();
                for (let i = 0; i < widgets.length; i++) {
                    const pos = editor.getBottomForLineNumber(widgets[i].endLine) - scrollTop;
                    widgets[i].dom.style.transform = `translateY(${pos}px)`;
                }
            } catch {
                // Editor disposed - ignore
            }
            rafId = null;
        });
    };

    // Create buttons
    const fragment = document.createDocumentFragment();
    const blockMap = new Map();

    for (let i = 0; i < diffBlocks.length; i++) {
        const block = diffBlocks[i];
        const position = i + 1;
        const total = diffBlocks.length;
        const dom = document.createElement('div');
        dom.className = 'diff-action-buttons';
        dom.style.cssText = 'position:absolute;top:0;right:16px;z-index:1000;will-change:transform';
        dom.innerHTML = `
            <span class="diff-action-position" aria-hidden="true">${position}/${total}</span>
            <button type="button" class="accept-btn" title="Accept change" aria-label="Accept change ${position} of ${total}"><span aria-hidden="true">✓</span></button>
            <button type="button" class="reject-btn" title="Reject change" aria-label="Reject change ${position} of ${total}"><span aria-hidden="true">✕</span></button>
        `;

        fragment.appendChild(dom);
        widgets.push({
            dom,
            endLine: block.displayAddRange?.endLine || block.displayDeleteRange?.endLine || 1,
        });
        blockMap.set(dom, block.id);
    }

    editorContainer.appendChild(fragment);

    // Event delegation
    clickHandler = (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;

        const container = btn.closest('.diff-action-buttons');
        if (!container) return;

        const blockId = blockMap.get(container);
        if (!blockId) return;

        e.preventDefault();
        e.stopPropagation();

        if (btn.classList.contains('accept-btn')) {
            onAccept(blockId);
        } else if (btn.classList.contains('reject-btn')) {
            onReject(blockId);
        }

        // React removes the widget only after the review state confirms the action.
    };

    editorContainer.addEventListener('click', clickHandler);
    updateAllButtons();

    scrollListener = editor.onDidScrollChange(updateAllButtons);
    layoutListener = editor.onDidLayoutChange(updateAllButtons);

    // Store cleanup function
    currentCleanup = () => {
        if (rafId) cancelAnimationFrame(rafId);
        if (scrollListener) scrollListener.dispose();
        if (layoutListener) layoutListener.dispose();

        // Remove event listener
        if (clickHandler && editorContainer) {
            editorContainer.removeEventListener('click', clickHandler);
        }

        widgets.forEach(({ dom }) => dom.remove());

        if (window.diffDecorations) {
            try {
                editor.deltaDecorations(window.diffDecorations, []);
            } catch {
                // Editor disposed - ignore
            }
            window.diffDecorations = null;
        }

        blockMap.clear();
    };

    return currentCleanup;
};
