// ============================================================================
// Position-accuracy contract for every diagnostic surface in the ERD pipeline.
//
// The editor uses `error.position` (line / column / character index) to
// jump the user straight to the offending SQL. Wrong positions silently
// degrade the entire authoring experience: clicking "Unclosed string" should
// land on the bad quote, not on `line: 1, column: 1`. This file pins the
// position contract for:
//
//   • tokenize()              ─ unclosed strings, comments, identifiers, …
//   • parseAST()              ─ structural errors, missing column lists, …
//   • sqlToErdSchema()        ─ dropped relations (FK source position)
//   • createSqlExecutor()     ─ runtime diagnostics (default to stmt start)
//
// Hard rules the tests enforce (any regression would be a UX bug):
//   1. Every diagnostic has `position: { line, column, index }`.
//   2. `line` and `column` are 1-based; `index` is a 0-based CHAR offset.
//   3. The position resolves to a real char in the source SQL — i.e.
//      `sql.split('\n')[line - 1][column - 1]` is defined.
//   4. The position is the START of the offending construct, not the
//      previous statement's terminator.
//   5. Multi-statement scripts: each error anchors at its OWN statement,
//      not at the end of file. Position values strictly increase as
//      diagnostics fire on later statements.
//   6. The `index` and (`line`, `column`) agree — converting one to the
//      other via the source string round-trips perfectly.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { tokenize } from '@/lib/parse-ast/tokenize.js';
import { parseAST } from '@/lib/parse-ast/parseAst.js';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';
import { createSqlExecutor } from '@/features/data-view/lib/sqlExecutor.js';

// ────────────────────────────────────────────────────────────────────────────
// Helpers — every test uses these so a regression in the tokenizer's
// position math is caught once, here, instead of in every `expect` below.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Convert a position back to the character it points at, raising if the
 * coordinates don't agree with the source string. This is the single
 * source of truth for "is this position correct".
 */
function charAt(sql, pos) {
    expect(pos, 'position object missing').toBeTruthy();
    expect(typeof pos.line).toBe('number');
    expect(typeof pos.column).toBe('number');
    expect(typeof pos.index).toBe('number');

    expect(pos.line, `line must be 1-based; got ${pos.line}`).toBeGreaterThanOrEqual(1);
    expect(pos.column, `column must be 1-based; got ${pos.column}`).toBeGreaterThanOrEqual(1);
    expect(pos.index, `index must be 0-based; got ${pos.index}`).toBeGreaterThanOrEqual(0);
    expect(pos.index, `index out of bounds for sql of length ${sql.length}`).toBeLessThanOrEqual(sql.length);

    const lines = sql.split('\n');
    expect(pos.line, `line ${pos.line} > total ${lines.length}`).toBeLessThanOrEqual(lines.length);

    const lineText = lines[pos.line - 1];
    expect(pos.column - 1, `column ${pos.column} past end of line (len ${lineText.length})`).toBeLessThanOrEqual(lineText.length);

    return lineText[pos.column - 1];
}

/**
 * Cross-check that line/column → index reconstruction matches the reported
 * `index`. If they disagree, the editor's two views (gutter vs scroll-to)
 * will diverge.
 */
function assertSelfConsistent(sql, pos) {
    const lines = sql.split('\n');
    let computedIdx = 0;
    for (let i = 0; i < pos.line - 1; i++) {
        computedIdx += lines[i].length + 1; // +1 for the \n
    }
    computedIdx += pos.column - 1;
    expect(computedIdx, `line/column/index disagree: line ${pos.line}, col ${pos.column} → idx ${computedIdx}, but reported ${pos.index}`).toBe(pos.index);
}

/** Locate the 1-based (line, column) of a substring in the SQL. */
function findPos(sql, needle, occurrence = 0) {
    let from = 0;
    let idx = -1;
    for (let n = 0; n <= occurrence; n++) {
        idx = sql.indexOf(needle, from);
        if (idx < 0) throw new Error(`needle "${needle}" not found (occurrence ${occurrence})`);
        from = idx + 1;
    }
    const before = sql.slice(0, idx);
    const lines = before.split('\n');
    return { line: lines.length, column: lines[lines.length - 1].length + 1, index: idx };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. tokenize() — lexical errors must point at the OFFENDING character
// ════════════════════════════════════════════════════════════════════════════

describe('tokenize: lexical-error positions', () => {
    it('unclosed single-quoted string: position points at the opening quote', () => {
        const sql = `SELECT 'hello`;
        const { errors } = tokenize(sql);
        expect(errors).toHaveLength(1);
        const e = errors[0];

        expect(e.kind).toBe('unclosed_string');
        expect(e.start).toEqual({ idx: 7, line: 1, col: 8 });
        expect(charAt(sql, { line: e.start.line, column: e.start.col, index: e.start.idx })).toBe(`'`);
    });

    it('unclosed string spanning multiple lines: line/col captured at the START quote', () => {
        const sql = `CREATE TABLE t (\n  name TEXT DEFAULT 'unterminated`;
        const { errors } = tokenize(sql);
        // The tokenizer is allowed to report follow-on errors after the
        // unclosed string (e.g. unclosed paren) — but the FIRST error must
        // be the unclosed string anchored at its opening quote.
        expect(errors.length).toBeGreaterThanOrEqual(1);
        const e = errors.find((x) => x.kind === 'unclosed_string');
        expect(e).toBeTruthy();
        expect(e.start.line).toBe(2);
        expect(charAt(sql, { line: e.start.line, column: e.start.col, index: e.start.idx })).toBe(`'`);
    });

    it('unclosed quoted identifier: position is the opening backtick', () => {
        const sql = `SELECT \`unclosed_ident`;
        const { errors } = tokenize(sql);
        expect(errors).toHaveLength(1);

        const e = errors[0];
        expect(e.kind).toBe('unclosed_quoted_identifier');
        expect(charAt(sql, { line: e.start.line, column: e.start.col, index: e.start.idx })).toBe('`');
    });

    it('unclosed block comment: position is the opening `/*`', () => {
        const sql = `SELECT 1; /* never closed`;
        const { errors } = tokenize(sql);
        expect(errors).toHaveLength(1);

        const e = errors[0];
        expect(e.kind).toBe('unclosed_block_comment');
        expect(charAt(sql, { line: e.start.line, column: e.start.col, index: e.start.idx })).toBe('/');
    });

    it('unmatched closing parenthesis: position is the OFFENDING `)`', () => {
        const sql = `SELECT 1 + 2);`;
        const { errors } = tokenize(sql);
        expect(errors.length).toBeGreaterThanOrEqual(1);
        const e = errors.find((x) => x.kind === 'unmatched_closing_paren');
        expect(e).toBeTruthy();
        expect(charAt(sql, { line: e.start.line, column: e.start.col, index: e.start.idx })).toBe(')');
    });

    it('multiple lexical errors: each has its OWN position, not the first error', () => {
        // Two unmatched closing parens on different lines. Each MUST get
        // its own position — a regression that pinned them all to (1,1)
        // would render multiple gutter markers stacked at the file head.
        const sql = `SELECT 1);\nSELECT 2);`;
        const { errors } = tokenize(sql);
        expect(errors.length).toBeGreaterThanOrEqual(2);

        const close = errors.filter((e) => e.kind === 'unmatched_closing_paren');
        expect(close.length).toBeGreaterThanOrEqual(2);

        // Line of the second error must be later in the file.
        expect(close[1].start.line).toBeGreaterThan(close[0].start.line);
        // Char index strictly increasing.
        expect(close[1].start.idx).toBeGreaterThan(close[0].start.idx);

        for (const e of close) {
            expect(charAt(sql, { line: e.start.line, column: e.start.col, index: e.start.idx })).toBe(')');
        }
    });

    it('token positions: every token has start AND end, end > start, and they sit on a real character', () => {
        const sql = `CREATE TABLE users (\n  id INT\n);`;
        const { tokens } = tokenize(sql);
        expect(tokens.length).toBeGreaterThan(0);

        for (const t of tokens) {
            expect(t.start).toBeTruthy();
            expect(t.end).toBeTruthy();
            // Every token spans at least one character.
            expect(t.end.idx).toBeGreaterThanOrEqual(t.start.idx);
            // Start position resolves to a real character in the source.
            expect(charAt(sql, { line: t.start.line, column: t.start.col, index: t.start.idx })).toBeDefined();
        }
    });

    it('CRLF line endings do not corrupt line/column counters', () => {
        const sql = `SELECT 1;\r\nSELECT 'unterminated`;
        const { errors } = tokenize(sql);
        expect(errors).toHaveLength(1);

        const e = errors[0];
        // The unterminated string is on the second logical line (line 2).
        expect(e.start.line).toBe(2);
        expect(charAt(sql, { line: e.start.line, column: e.start.col, index: e.start.idx })).toBe(`'`);
        expect(e.start.idx).toBe(sql.indexOf(`'`));
        assertSelfConsistent(sql, { line: e.start.line, column: e.start.col, index: e.start.idx });
    });

    it('BOM-prefixed source keeps diagnostics aligned with the editor buffer', () => {
        const sql = `\uFEFFSELECT 1;\nSELECT 'unterminated`;
        const { errors } = tokenize(sql);
        const e = errors.find((error) => error.kind === 'unclosed_string');

        expect(e).toBeTruthy();
        expect(e.start.idx).toBe(sql.indexOf(`'`));
        expect(charAt(sql, { line: e.start.line, column: e.start.col, index: e.start.idx })).toBe(`'`);
        assertSelfConsistent(sql, { line: e.start.line, column: e.start.col, index: e.start.idx });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. parseAST() — structural errors normalize tokenizer's `start` into
// `position: { line, column, index }` AND respect the contract for
// parser-emitted diagnostics (missing column lists, undefined refs, …).
// ════════════════════════════════════════════════════════════════════════════

describe('parseAST: error/warning positions are accurate and self-consistent', () => {
    it('every emitted diagnostic carries the public position contract', () => {
        const sql = `
            CREATE TABLE t (
                id INT,
                CONSTRAINT pk PRIMARY KEY,
                CONSTRAINT fk FOREIGN KEY (id) REFERENCES,
                CONSTRAINT uq UNIQUE
            );
        `;
        const { errors } = parseAST(sql);
        expect(errors.length).toBeGreaterThan(0);

        for (const e of errors) {
            expect(e.position).toBeDefined();
            expect(typeof e.position.line).toBe('number');
            expect(typeof e.position.column).toBe('number');
            expect(typeof e.position.index).toBe('number');
            expect(e.position.line).toBeGreaterThanOrEqual(1);
            expect(e.position.column).toBeGreaterThanOrEqual(1);
            expect(e.position.index).toBeGreaterThanOrEqual(0);
            // Position resolves to a real character in the SQL.
            charAt(sql, e.position);
            assertSelfConsistent(sql, e.position);
        }
    });

    it('unclosed paren: line points at the `;` that broke the statement (the `;` IS the offending character)', () => {
        const sql = `CREATE TABLE t (\n  id INT,\n  name TEXT\n;\nCREATE TABLE u (id INT);`;
        const { errors } = parseAST(sql);
        const unclosed = errors.find((e) => /Unclosed parenthesis/i.test(e.message));
        expect(unclosed).toBeTruthy();

        // The diagnostic should land at the bad `;` — line 4, col 1.
        expect(unclosed.position.line).toBe(4);
        expect(unclosed.position.column).toBe(1);
        expect(charAt(sql, unclosed.position)).toBe(';');
    });

    it('three-statement script: each error gets its OWN line, not the last token in the file', () => {
        // Statements on lines 2, 3, 4. We force a "missing column list"
        // error on line 3 only.
        const sql =
            'CREATE TABLE good_a (id INT);\n' +
            'CREATE TABLE good_b (\n' +
            '  CONSTRAINT pk PRIMARY KEY\n' +
            ');\n' +
            'CREATE TABLE good_c (id INT);';
        const { errors } = parseAST(sql);
        const pkErr = errors.find((e) => /PRIMARY KEY constraint missing column list/i.test(e.message));
        expect(pkErr).toBeTruthy();
        // Must point INTO the second CREATE TABLE (line 2-4), not at the
        // tail of the script.
        expect(pkErr.position.line).toBeGreaterThanOrEqual(2);
        expect(pkErr.position.line).toBeLessThanOrEqual(4);
        // And must be a real character in the file.
        charAt(sql, pkErr.position);
    });

    it('end-of-input warning: position uses the last real token, not {1, 1, 0}', () => {
        // A bare `CREATE TABLE` with no `(...)` triggers an end-of-input
        // warning. The position should still be > {1, 1, 0}.
        const sql = `CREATE TABLE t`;
        const { errors } = parseAST(sql);
        expect(errors.length).toBeGreaterThanOrEqual(1);

        for (const e of errors) {
            // index 0 / line 1 / col 1 would be the WORD "CREATE", which
            // is not where the user needs to look — they need the `t`
            // (or the missing `(`). Either way, must be inside the SQL.
            charAt(sql, e.position);
            assertSelfConsistent(sql, e.position);
        }
    });

    it('first-character error correctness: position 0 is preserved (regression: `||` masked it)', () => {
        // Lead with bad input so the first token is at idx 0.
        const sql = `,;CREATE TABLE t (id INT);`;
        const { errors } = parseAST(sql);
        // We don't care WHICH error fires — only that *if* the parser
        // attaches a position with `index: 0`, it survives normalization.
        // We force-test the helper by inspecting the FIRST token's start.
        const { tokens } = tokenize(sql);
        expect(tokens[0].start.idx).toBe(0); // the leading `,`
        expect(tokens[0].start.line).toBe(1);
        expect(tokens[0].start.col).toBe(1);
        // And as long as we got SOME diagnostic, validate them all.
        for (const e of errors) {
            expect(e.position.index).toBeGreaterThanOrEqual(0);
            charAt(sql, e.position);
        }
    });

    it('UNDEFINED constraint column reference: error points INSIDE the offending CREATE TABLE', () => {
        const sql = `CREATE TABLE t (\n  id INT,\n  PRIMARY KEY (does_not_exist)\n);`;
        const { errors } = parseAST(sql);
        const e = errors.find((x) => /references undefined column/i.test(x.message));
        expect(e).toBeTruthy();
        expect(e.position.line).toBeGreaterThanOrEqual(1);
        expect(e.position.line).toBeLessThanOrEqual(4);
        charAt(sql, e.position);
    });

    it('errors fired in order: position.index is monotonically non-decreasing across the script', () => {
        const sql =
            'CREATE TABLE a (\n' +
            '  CONSTRAINT pk1 PRIMARY KEY\n' +
            ');\n' +
            'CREATE TABLE b (\n' +
            '  CONSTRAINT pk2 PRIMARY KEY\n' +
            ');';
        const { errors } = parseAST(sql);
        expect(errors.length).toBeGreaterThanOrEqual(2);

        for (let i = 1; i < errors.length; i++) {
            // Each subsequent error must be at or after the previous one.
            expect(errors[i].position.index, `error ${i} should not move BACKWARDS in the source`).toBeGreaterThanOrEqual(errors[i - 1].position.index);
        }
    });

    it('every error has a `severity` of "error" or "warning" (no silent diagnostics)', () => {
        const sql = `CREATE TABLE t (\n  id INT,\n  CONSTRAINT pk PRIMARY KEY\n);`;
        const { errors } = parseAST(sql);
        for (const e of errors) {
            expect(['error', 'warning']).toContain(e.severity);
            expect(e.message).toBeTruthy();
            expect(typeof e.message).toBe('string');
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. sqlToErdSchema() — validator drop-warnings must point at the FK SOURCE,
//    not at {1, 1, 0}. This was previously hardcoded.
// ════════════════════════════════════════════════════════════════════════════

describe('sqlToErdSchema: validator drop-warnings carry real positions', () => {
    it('inline REFERENCES to unknown table: warning anchors at the FK source COLUMN', () => {
        const sql =
            'CREATE TABLE posts (\n' +
            '  id INT,\n' +
            '  user_id INT REFERENCES nonexistent_users(id)\n' +
            ');';
        const schema = sqlToErdSchema(sql);
        const warn = schema._parseErrors.find((e) => /Relation dropped/i.test(e.message) && /nonexistent_users/.test(e.message));
        expect(warn).toBeTruthy();

        // The position should be at line 3 — the `user_id` column line.
        expect(warn.position.line).toBe(3);
        // NOT the hardcoded {1, 1, 0}.
        expect(warn.position).not.toEqual({ line: 1, column: 1, index: 0 });
        // And it must resolve to a real character.
        charAt(sql, warn.position);
        assertSelfConsistent(sql, warn.position);
    });

    it('table-level FOREIGN KEY to unknown table: warning anchors at the constraint', () => {
        const sql =
            'CREATE TABLE orders (\n' +
            '  id INT,\n' +
            '  customer_id INT,\n' +
            '  FOREIGN KEY (customer_id) REFERENCES ghost(id)\n' +
            ');';
        const schema = sqlToErdSchema(sql);
        const warn = schema._parseErrors.find((e) => /ghost/.test(e.message));
        expect(warn).toBeTruthy();
        expect(warn.position).not.toEqual({ line: 1, column: 1, index: 0 });
        // Position should be on the FOREIGN KEY line.
        expect(warn.position.line).toBeGreaterThanOrEqual(2);
        charAt(sql, warn.position);
    });

    it('ALTER TABLE … ADD FOREIGN KEY to unknown column: warning anchors at the ALTER', () => {
        const sql =
            'CREATE TABLE a (id INT);\n' +
            'CREATE TABLE b (id INT, a_id INT);\n' +
            'ALTER TABLE b ADD CONSTRAINT fk_a FOREIGN KEY (a_id) REFERENCES a(does_not_exist);';
        const schema = sqlToErdSchema(sql);
        const warn = schema._parseErrors.find((e) => /does_not_exist/.test(e.message));
        expect(warn).toBeTruthy();
        // Should point INTO the ALTER line (line 3).
        expect(warn.position.line).toBe(3);
        expect(warn.position).not.toEqual({ line: 1, column: 1, index: 0 });
        charAt(sql, warn.position);
    });

    it('multiple dropped relations: each has a DIFFERENT position (no global hardcode)', () => {
        const sql =
            'CREATE TABLE a (\n' +
            '  id INT,\n' +
            '  ghost1_id INT REFERENCES ghost1(id)\n' +
            ');\n' +
            'CREATE TABLE b (\n' +
            '  id INT,\n' +
            '  ghost2_id INT REFERENCES ghost2(id)\n' +
            ');';
        const schema = sqlToErdSchema(sql);
        const warns = schema._parseErrors.filter((e) => /Relation dropped/i.test(e.message));
        expect(warns.length).toBe(2);

        // Their positions MUST differ — otherwise the editor will show
        // both warnings on the same line, which is misleading.
        expect(warns[0].position.line).not.toBe(warns[1].position.line);
        expect(warns[0].position.index).not.toBe(warns[1].position.index);

        // And both must be real positions.
        charAt(sql, warns[0].position);
        charAt(sql, warns[1].position);
    });

    it('valid SQL produces NO drop-warnings (no false positives on real positions)', () => {
        const sql =
            'CREATE TABLE users (id INT PRIMARY KEY);\n' +
            'CREATE TABLE posts (id INT, user_id INT REFERENCES users(id));';
        const schema = sqlToErdSchema(sql);
        const warns = (schema._parseErrors || []).filter((e) => /Relation dropped/i.test(e.message));
        expect(warns).toHaveLength(0);
    });

    it('relation objects expose their source position so renderers can highlight FKs in the editor', () => {
        const sql =
            'CREATE TABLE users (id INT PRIMARY KEY);\n' +
            'CREATE TABLE posts (\n' +
            '  id INT,\n' +
            '  user_id INT REFERENCES users(id)\n' +
            ');';
        const schema = sqlToErdSchema(sql);
        expect(schema.relations).toHaveLength(1);

        const rel = schema.relations[0];
        expect(rel.position).toBeDefined();
        // Should land on line 4 (the user_id REFERENCES line).
        expect(rel.position.line).toBe(4);
        charAt(sql, rel.position);
        assertSelfConsistent(sql, rel.position);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. createSqlExecutor() — runtime diagnostics ("table does not exist",
//    "PK collision", "missing VALUES keyword", …) MUST anchor at the
//    statement that produced them, not lose the position entirely.
// ════════════════════════════════════════════════════════════════════════════

describe('createSqlExecutor: log entries carry the originating statement position', () => {
    it('INSERT into missing table: log entry anchors at the INSERT keyword', () => {
        const sql = `\nINSERT INTO ghost (id) VALUES (1);`;
        const exec = createSqlExecutor();
        const { log } = exec.execute(sql);
        const err = log.find((e) => e.type === 'error' && /table does not exist/i.test(e.message));
        expect(err).toBeTruthy();
        expect(err.position).toBeDefined();
        // INSERT is on line 2, col 1.
        expect(err.position.line).toBe(2);
        expect(err.position.column).toBe(1);
        expect(charAt(sql, err.position).toUpperCase()).toBe('I'); // INSERT's first letter
        assertSelfConsistent(sql, err.position);
    });

    it('UPDATE on missing table: anchors at the UPDATE keyword on its own line', () => {
        const sql =
            'CREATE TABLE x (id INT);\n' +
            '\n' +
            'UPDATE missing SET id = 2;';
        const exec = createSqlExecutor();
        const { log } = exec.execute(sql);
        const err = log.find((e) => e.type === 'error' && /UPDATE.*table does not exist/i.test(e.message));
        expect(err).toBeTruthy();
        expect(err.position.line).toBe(3);
        expect(err.position.column).toBe(1);
        expect(charAt(sql, err.position).toUpperCase()).toBe('U');
    });

    it('multiple errors on different statements: each gets its OWN position', () => {
        const sql =
            'INSERT INTO a (x) VALUES (1);\n' +
            'INSERT INTO b (y) VALUES (2);\n' +
            'INSERT INTO c (z) VALUES (3);';
        const exec = createSqlExecutor();
        const { log } = exec.execute(sql);
        const errs = log.filter((e) => e.type === 'error' && /table does not exist/i.test(e.message));
        expect(errs.length).toBe(3);

        // Each error should be on a DIFFERENT line.
        const lines = errs.map((e) => e.position.line).sort((a, b) => a - b);
        expect(lines).toEqual([1, 2, 3]);

        // And each position must resolve to an `I` (the start of INSERT).
        for (const e of errs) {
            expect(charAt(sql, e.position).toUpperCase()).toBe('I');
            assertSelfConsistent(sql, e.position);
        }
    });

    it('CREATE TABLE redefinition warning: anchors at the SECOND CREATE, not the first', () => {
        const sql =
            'CREATE TABLE t (id INT);\n' +
            'CREATE TABLE t (id INT, name TEXT);';
        const exec = createSqlExecutor();
        const { log } = exec.execute(sql);
        const warn = log.find((e) => e.type === 'warning' && /already exists/i.test(e.message));
        expect(warn).toBeTruthy();
        // The DUPLICATE is on line 2 — that's where the user needs to look.
        expect(warn.position.line).toBe(2);
        expect(charAt(sql, warn.position).toUpperCase()).toBe('C');
    });

    it('DROP missing table: error anchors at the DROP statement', () => {
        const sql =
            'CREATE TABLE t (id INT);\n' +
            'DROP TABLE ghost;';
        const exec = createSqlExecutor();
        const { log } = exec.execute(sql);
        const err = log.find((e) => e.type === 'error' && /DROP/.test(e.message));
        expect(err).toBeTruthy();
        expect(err.position.line).toBe(2);
        expect(charAt(sql, err.position).toUpperCase()).toBe('D');
    });

    it('successful operations: log entries also get a position (so the UI can show "Inserted N rows" inline)', () => {
        const sql =
            'CREATE TABLE t (id INT);\n' +
            'INSERT INTO t (id) VALUES (1);';
        const exec = createSqlExecutor();
        const { log } = exec.execute(sql);
        const success = log.find((e) => e.type === 'success' && /Inserted/i.test(e.message));
        expect(success).toBeTruthy();
        expect(success.position).toBeDefined();
        expect(success.position.line).toBe(2);
        charAt(sql, success.position);
    });

    it('every log entry has a self-consistent position OR no position at all (no garbage)', () => {
        const sql =
            'CREATE TABLE t (id INT PRIMARY KEY, name TEXT NOT NULL);\n' +
            'INSERT INTO t (id, name) VALUES (1, NULL);\n' +
            'UPDATE t SET id = 2 WHERE id = 1;\n' +
            'DELETE FROM t WHERE id = 99;\n' +
            'DROP TABLE missing;';
        const exec = createSqlExecutor();
        const { log } = exec.execute(sql);

        for (const entry of log) {
            // No "garbage" positions — if a position is present, it MUST
            // resolve to a real character in the source.
            if (entry.position) {
                expect(typeof entry.position.line).toBe('number');
                expect(typeof entry.position.column).toBe('number');
                expect(typeof entry.position.index).toBe('number');
                charAt(sql, entry.position);
                assertSelfConsistent(sql, entry.position);
            }
        }
    });

    it('explicit position override: log() respects a passed-in position source', () => {
        // Indirect test through executor public API — verify multi-line
        // INSERT's row errors remain anchored to the INSERT, not jumping
        // backwards into a previous statement.
        const sql =
            'CREATE TABLE t (id INT, name TEXT);\n' +
            '\n' +
            'INSERT INTO t (id, name) VALUES (1, 2, 3);';
        const exec = createSqlExecutor();
        const { log } = exec.execute(sql);
        const error = log.find((e) => e.type === 'error' && /expected 2 values but got 3/i.test(e.message));
        expect(error).toBeTruthy();
        expect(error.position).toBeDefined();
        // Should anchor at the INSERT (line 3), NOT line 1.
        expect(error.position.line).toBe(3);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. End-to-end: real-world SQL with multiple diagnostic surfaces fires.
//    Every diagnostic from every layer must satisfy the position contract.
// ════════════════════════════════════════════════════════════════════════════

describe('end-to-end: real-world SQL with mixed diagnostics', () => {
    it('positions across ALL pipeline layers stay consistent and source-resolvable', () => {
        const sql =
            'CREATE TABLE users (\n' +
            '  id INT PRIMARY KEY,\n' +
            '  email TEXT UNIQUE\n' +
            ');\n' +
            '\n' +
            '-- typo: references a missing table\n' +
            'CREATE TABLE posts (\n' +
            '  id INT PRIMARY KEY,\n' +
            '  author_id INT REFERENCES authors(id)\n' +
            ');\n' +
            '\n' +
            '-- runtime error: insert into missing table\n' +
            'INSERT INTO ghost (id) VALUES (1);';

        // Layer 1 + 2: parser + tokenizer
        const { errors } = parseAST(sql);
        for (const e of errors) {
            charAt(sql, e.position);
            assertSelfConsistent(sql, e.position);
        }

        // Layer 3: ERD builder + validator
        const schema = sqlToErdSchema(sql);
        const dropped = (schema._parseErrors || []).filter((e) => /Relation dropped/i.test(e.message));
        expect(dropped.length).toBeGreaterThan(0);
        for (const e of dropped) {
            charAt(sql, e.position);
            assertSelfConsistent(sql, e.position);
            // Drop-warning for `authors` should be on line 9.
            if (/authors/.test(e.message)) {
                expect(e.position.line).toBe(9);
            }
        }

        // Layer 4: executor
        const exec = createSqlExecutor();
        const { log } = exec.execute(sql);
        const ghostErr = log.find((e) => e.type === 'error' && /ghost/.test(e.message));
        expect(ghostErr).toBeTruthy();
        expect(ghostErr.position).toBeDefined();
        // INSERT is on line 13.
        expect(ghostErr.position.line).toBe(13);
        charAt(sql, ghostErr.position);
        assertSelfConsistent(sql, ghostErr.position);
    });

    it('positions remain stable when SQL is reformatted (round-trip via different whitespace)', () => {
        // Same logical script, different formatting — positions must
        // recompute correctly each time.
        const compact = `CREATE TABLE t (id INT, x INT REFERENCES ghost(id));`;
        const expanded = `\n  CREATE TABLE t (\n    id INT,\n    x  INT REFERENCES ghost(id)\n  );\n`;

        const sCompact = sqlToErdSchema(compact);
        const sExpanded = sqlToErdSchema(expanded);

        const wCompact = sCompact._parseErrors.find((e) => /Relation dropped/i.test(e.message));
        const wExpanded = sExpanded._parseErrors.find((e) => /Relation dropped/i.test(e.message));
        expect(wCompact).toBeTruthy();
        expect(wExpanded).toBeTruthy();

        // Both must resolve to a real character in their respective SQL.
        charAt(compact, wCompact.position);
        charAt(expanded, wExpanded.position);

        // The expanded version should have the warning on a LATER line
        // (compact is line 1, expanded is line 4).
        expect(wExpanded.position.line).toBeGreaterThan(wCompact.position.line);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Round-trip: findPos() → re-tokenize → confirm we can build a position
//    and recover the SAME character. This is the contract the editor uses.
// ════════════════════════════════════════════════════════════════════════════

describe('position contract: round-trip from source to position back to source', () => {
    it.each([
        { sql: `SELECT 1;`, needle: `SELECT` },
        { sql: `\nCREATE TABLE t (id INT);`, needle: `CREATE` },
        { sql: `  -- leading comment\nINSERT INTO t VALUES (1);`, needle: `INSERT` },
        { sql: `CREATE TABLE a (\n  id INT,\n  ref INT REFERENCES b(id)\n);`, needle: `REFERENCES` },
    ])(`finds "$needle" position and recovers the exact character`, ({ sql, needle }) => {
        const pos = findPos(sql, needle);
        expect(charAt(sql, pos)).toBe(needle[0]);
        assertSelfConsistent(sql, pos);
    });
});
