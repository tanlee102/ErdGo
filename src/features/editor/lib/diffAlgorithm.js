// ============================================
// MYERS DIFF ALGORITHM - Core diff engine
// ============================================
const MAX_EXACT_MYERS_EDIT_DISTANCE = 200;

export class MyersDiff {
    static diff(originalText, newText) {
        const originalLines = originalText.split('\n');
        const newLines = newText.split('\n');
        const sharedLength = Math.min(originalLines.length, newLines.length);
        let prefixLength = 0;
        while (prefixLength < sharedLength && originalLines[prefixLength] === newLines[prefixLength]) {
            prefixLength += 1;
        }

        let suffixLength = 0;
        while (
            suffixLength < sharedLength - prefixLength &&
            originalLines[originalLines.length - suffixLength - 1] === newLines[newLines.length - suffixLength - 1]
        ) {
            suffixLength += 1;
        }

        const originalMiddleEnd = originalLines.length - suffixLength;
        const newMiddleEnd = newLines.length - suffixLength;
        const middleDiff = this.computeDiff(originalLines.slice(prefixLength, originalMiddleEnd), newLines.slice(prefixLength, newMiddleEnd)).map((change) => ({
            ...change,
            oldLine: change.oldLine < 0 ? -1 : change.oldLine + prefixLength,
            newLine: change.newLine < 0 ? -1 : change.newLine + prefixLength,
        }));
        const prefix = Array.from({ length: prefixLength }, (_, index) => ({ type: 'equal', oldLine: index, newLine: index }));
        const suffix = Array.from({ length: suffixLength }, (_, index) => ({
            type: 'equal',
            oldLine: originalMiddleEnd + index,
            newLine: newMiddleEnd + index,
        }));

        return [...prefix, ...middleDiff, ...suffix];
    }

    static buildCoarseDiff(a, b) {
        return [
            ...a.map((_line, oldLine) => ({ type: 'delete', oldLine, newLine: -1 })),
            ...b.map((_line, newLine) => ({ type: 'insert', oldLine: -1, newLine })),
        ];
    }

    static computeDiff(a, b) {
        const n = a.length;
        const m = b.length;
        const max = n + m;
        if (max > MAX_EXACT_MYERS_EDIT_DISTANCE) {
            const smaller = n <= m ? a : b;
            const largerValues = new Set(n <= m ? b : a);
            if (!smaller.some((line) => largerValues.has(line))) {
                return this.buildCoarseDiff(a, b);
            }
        }
        const trace = [];
        const v = {};
        v[1] = 0;

        for (let d = 0; d <= max; d++) {
            // A very large edit distance makes a minimal line diff expensive
            // and produces an unreadable set of tiny hunks. Keep the shared
            // prefix/suffix from `diff`, then use one deterministic replacement
            // block for the changed middle so review never freezes the browser.
            if (d > MAX_EXACT_MYERS_EDIT_DISTANCE) {
                return this.buildCoarseDiff(a, b);
            }
            trace.push({ ...v });
            for (let k = -d; k <= d; k += 2) {
                let x;
                if (k === -d || (k !== d && v[k - 1] < v[k + 1])) {
                    x = v[k + 1];
                } else {
                    x = v[k - 1] + 1;
                }
                let y = x - k;

                while (x < n && y < m && a[x] === b[y]) {
                    x++;
                    y++;
                }
                v[k] = x;

                if (x >= n && y >= m) {
                    return this.buildDiff(a, b, trace, d);
                }
            }
        }
        return [];
    }

    static buildDiff(a, b, trace, d) {
        const n = a.length;
        const m = b.length;
        let x = n;
        let y = m;
        const path = [];

        for (let t = d; t >= 0; t--) {
            const v = trace[t];
            const k = x - y;
            let prevK;

            if (k === -t || (k !== t && v[k - 1] < v[k + 1])) {
                prevK = k + 1;
            } else {
                prevK = k - 1;
            }

            const prevX = v[prevK];
            const prevY = prevX - prevK;

            while (x > prevX && y > prevY) {
                path.push({ type: 'equal', oldLine: x - 1, newLine: y - 1 });
                x--;
                y--;
            }

            if (t > 0) {
                if (x > prevX) {
                    path.push({ type: 'delete', oldLine: x - 1, newLine: -1 });
                    x--;
                } else {
                    path.push({ type: 'insert', oldLine: -1, newLine: y - 1 });
                    y--;
                }
            }
        }
        return path.reverse();
    }
}

// ============================================
// DIFF DISPLAYER - Creates visual diff view
// ============================================
export class DiffDisplayer {
    static createGitHubStyleDiff(originalText, newText) {
        const originalLines = originalText.split('\n');
        const newLines = newText.split('\n');
        const diff = MyersDiff.diff(originalText, newText);
        const result = [];

        diff.forEach((change) => {
            if (change.type === 'equal') {
                result.push({
                    type: 'equal',
                    content: originalLines[change.oldLine],
                    originalLine: change.oldLine + 1,
                    newLine: change.newLine + 1,
                });
            } else if (change.type === 'delete') {
                result.push({
                    type: 'delete',
                    content: originalLines[change.oldLine],
                    originalLine: change.oldLine + 1,
                    newLine: null,
                });
            } else if (change.type === 'insert') {
                result.push({
                    type: 'insert',
                    content: newLines[change.newLine],
                    originalLine: null,
                    newLine: change.newLine + 1,
                });
            }
        });

        return result;
    }

    static getChangeBlocks(originalText, newText) {
        const diffLines = this.createGitHubStyleDiff(originalText, newText);
        const blocks = [];
        let currentBlock = null;
        let blockId = 0;

        diffLines.forEach((line, index) => {
            const lineNum = index + 1;

            if (line.type === 'delete' || line.type === 'insert') {
                if (!currentBlock) {
                    currentBlock = {
                        id: `block_${blockId++}`,
                        deleteLines: [],
                        insertLines: [],
                        deleteRange: { start: null, end: null },
                        insertRange: { start: null, end: null },
                    };
                }

                if (line.type === 'delete') {
                    currentBlock.deleteLines.push(lineNum);
                    if (currentBlock.deleteRange.start === null) {
                        currentBlock.deleteRange.start = lineNum;
                    }
                    currentBlock.deleteRange.end = lineNum;
                } else if (line.type === 'insert') {
                    currentBlock.insertLines.push(lineNum);
                    if (currentBlock.insertRange.start === null) {
                        currentBlock.insertRange.start = lineNum;
                    }
                    currentBlock.insertRange.end = lineNum;
                }
            } else {
                // Context line - close current block
                if (currentBlock) {
                    blocks.push(currentBlock);
                    currentBlock = null;
                }
            }
        });

        // Don't forget the last block
        if (currentBlock) {
            blocks.push(currentBlock);
        }

        return blocks;
    }
}

// ============================================
// DIFF MANAGER - Orchestrates all diff operations
// ============================================
export class DiffManager {
    constructor(originalCode, aiSuggestedCode) {
        this.originalCode = originalCode;
        this.aiSuggestedCode = aiSuggestedCode;
        // The review endpoints are immutable. Cache their line diff once so
        // preview, diagnostics, and accept/reject composition stay linear and
        // never rerun Myers several times in one React render.
        this.diffLines = DiffDisplayer.createGitHubStyleDiff(this.originalCode, this.aiSuggestedCode);
        this.allBlocks = this._calculateAllBlocks(this.diffLines);
        this.deleteBlockByLine = new Map();
        this.insertBlockByLine = new Map();
        this.allBlocks.forEach((block) => {
            block.deleteLineNumbers.forEach((lineNumber) => this.deleteBlockByLine.set(lineNumber, block));
            block.insertLineNumbers.forEach((lineNumber) => this.insertBlockByLine.set(lineNumber, block));
        });
    }

    _calculateAllBlocks(diffLines) {
        const blocks = [];
        let currentBlock = null;
        let blockIndex = 0;

        diffLines.forEach((line, idx) => {
            const lineNum = idx + 1;

            if (line.type === 'delete' || line.type === 'insert') {
                if (!currentBlock) {
                    currentBlock = {
                        id: `block_${blockIndex++}`,
                        originalDeleteLines: [],
                        originalInsertLines: [],
                        deleteLineNumbers: [],
                        insertLineNumbers: [],
                    };
                }

                if (line.type === 'delete') {
                    currentBlock.originalDeleteLines.push(line);
                    currentBlock.deleteLineNumbers.push(lineNum);
                } else if (line.type === 'insert') {
                    currentBlock.originalInsertLines.push(line);
                    currentBlock.insertLineNumbers.push(lineNum);
                }
            } else {
                if (currentBlock) {
                    blocks.push(currentBlock);
                    currentBlock = null;
                }
            }
        });

        if (currentBlock) {
            blocks.push(currentBlock);
        }

        return blocks;
    }

    _getBlockForLine(line, lineNumber) {
        if (line.type === 'delete') return this.deleteBlockByLine.get(lineNumber) || null;
        if (line.type === 'insert') return this.insertBlockByLine.get(lineNumber) || null;
        return null;
    }

    getAllBlocks() {
        return this.allBlocks;
    }

    areAllBlocksProcessed(acceptedBlocks, rejectedBlocks) {
        if (this.allBlocks.length === 0) return false;
        return this.allBlocks.every((block) => acceptedBlocks.has(block.id) || rejectedBlocks.has(block.id));
    }

    getRemainingBlocksCount(acceptedBlocks, rejectedBlocks) {
        return this.allBlocks.filter((block) => !acceptedBlocks.has(block.id) && !rejectedBlocks.has(block.id)).length;
    }

    getDisplayData(acceptedBlocks, rejectedBlocks) {
        const filteredLines = [];
        const visibleBlocksData = [];

        let displayLineNum = 0;
        let currentProcessingBlock = null;

        this.diffLines.forEach((line, originalIdx) => {
            const originalLineNum = originalIdx + 1;
            const belongsToBlock = this._getBlockForLine(line, originalLineNum);

            let shouldIncludeLine = true;

            if (belongsToBlock) {
                if (acceptedBlocks.has(belongsToBlock.id)) {
                    shouldIncludeLine = line.type !== 'delete';
                } else if (rejectedBlocks.has(belongsToBlock.id)) {
                    shouldIncludeLine = line.type !== 'insert';
                } else {
                    // A replacement has both a deleted line and its new
                    // counterpart. Show only the executable candidate so a
                    // SQL VALUES list never appears duplicated in preview.
                    // Pure deletions still show their old line in red.
                    const hasReplacementText = belongsToBlock.originalInsertLines.length > 0;
                    shouldIncludeLine = line.type !== 'delete' || !hasReplacementText;

                    if (belongsToBlock !== currentProcessingBlock) {
                        currentProcessingBlock = belongsToBlock;
                        visibleBlocksData.push({
                            block: belongsToBlock,
                            displayDeleteRange: { start: null, end: null },
                            displayInsertRange: { start: null, end: null },
                        });
                    }
                }
            }

            if (shouldIncludeLine) {
                displayLineNum++;
                filteredLines.push(line.content);

                if (belongsToBlock && !acceptedBlocks.has(belongsToBlock.id) && !rejectedBlocks.has(belongsToBlock.id)) {
                    const visibleBlock = visibleBlocksData.find((vb) => vb.block.id === belongsToBlock.id);
                    if (visibleBlock) {
                        if (line.type === 'delete') {
                            if (visibleBlock.displayDeleteRange.start === null) {
                                visibleBlock.displayDeleteRange.start = displayLineNum;
                            }
                            visibleBlock.displayDeleteRange.end = displayLineNum;
                        } else if (line.type === 'insert') {
                            if (visibleBlock.displayInsertRange.start === null) {
                                visibleBlock.displayInsertRange.start = displayLineNum;
                            }
                            visibleBlock.displayInsertRange.end = displayLineNum;
                        }
                    }
                }
            }
        });

        const finalVisibleBlocks = visibleBlocksData
            .filter((vb) => vb.displayDeleteRange.start !== null || vb.displayInsertRange.start !== null)
            .map((vb) => ({
                id: vb.block.id,
                displayDeleteRange: vb.displayDeleteRange.start
                    ? {
                          startLine: vb.displayDeleteRange.start,
                          endLine: vb.displayDeleteRange.end,
                      }
                    : null,
                displayAddRange: vb.displayInsertRange.start
                    ? {
                          startLine: vb.displayInsertRange.start,
                          endLine: vb.displayInsertRange.end,
                      }
                    : null,
            }));

        return {
            code: filteredLines.join('\n'),
            visibleBlocks: finalVisibleBlocks,
        };
    }

    applySelectedChanges(acceptedBlocks) {
        const originalLines = this.originalCode.split('\n');
        const newLines = this.aiSuggestedCode.split('\n');

        const result = [];
        const processedOriginalLines = new Set();
        const processedNewLines = new Set();

        this.diffLines.forEach((line, diffIndex) => {
            const belongsToBlock = this._getBlockForLine(line, diffIndex + 1);

            if (line.type === 'equal') {
                if (line.originalLine !== null && !processedOriginalLines.has(line.originalLine)) {
                    result.push(originalLines[line.originalLine - 1]);
                    processedOriginalLines.add(line.originalLine);
                }
            } else if (line.type === 'delete') {
                if (!belongsToBlock || !acceptedBlocks.has(belongsToBlock.id)) {
                    if (line.originalLine !== null && !processedOriginalLines.has(line.originalLine)) {
                        result.push(originalLines[line.originalLine - 1]);
                        processedOriginalLines.add(line.originalLine);
                    }
                }
            } else if (line.type === 'insert') {
                if (belongsToBlock && acceptedBlocks.has(belongsToBlock.id)) {
                    if (line.newLine !== null && !processedNewLines.has(line.newLine)) {
                        result.push(newLines[line.newLine - 1]);
                        processedNewLines.add(line.newLine);
                    }
                }
            }
        });

        return result.join('\n');
    }
}
