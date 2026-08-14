export const monacoOptions = {
    /* 🎨 GENERAL UI / DISPLAY */
    fontSize: 13, // Font size in the editor
    minimap: { enabled: false }, // Disable minimap (mini preview on the right)
    wordWrap: 'off', // Disable automatic word wrap
    automaticLayout: true, // Auto-resize when the container changes size
    roundedSelection: true, // Round the corners of the selection region
    scrollBeyondLastLine: true, // Allow scrolling past the last line (adds empty space below)

    /* 🧭 LINE / MARGIN / CODE LAYOUT SETTINGS */
    lineNumbers: 'on', // Show line numbers
    lineNumbersMinChars: 3, // ✅ Reduce minimum chars for line number gutter (default is 5)
    lineDecorationsWidth: 10, // ✅ Reduce width of the line number display area
    glyphMargin: false, // ❌ Disable breakpoint/error glyph margin (leftmost margin)
    folding: false, // ❌ Disable code folding arrows (triangles)

    /* 🧱 CODE FORMATTING SETTINGS */
    tabSize: 2, // Size of each tab (2 spaces)
    insertSpaces: true, // Pressing Tab inserts spaces instead of tab character

    /* 🌈 VISUAL SUPPORT */
    bracketPairColorization: { enabled: true }, // Colorize matching bracket pairs
    guides: {
        bracketPairs: true, // Show connecting guides between bracket pairs
        indentation: true, // Show indentation guides
    },

    /* 💡 SUGGESTIONS & CODE COMPLETION */
    suggest: {
        showKeywords: true, // Show keyword suggestions
        showSnippets: true, // Show code snippet suggestions
    },
};
