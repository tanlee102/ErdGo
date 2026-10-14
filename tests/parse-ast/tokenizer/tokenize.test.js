import { describe, it, expect } from 'vitest';
import { tokenize } from '@/lib/parse-ast/tokenize.js';

// ════════════════════════════════════════════════════════════════════
// Tokenizer parity tests — SQLite / PostgreSQL / MySQL / MSSQL
// ════════════════════════════════════════════════════════════════════
// The tokenizer is the foundation of both parseAst (ERD pipeline) and
// sqlExecutor (Data View runtime). These tests pin down the lexical
// surface that all four dialects need: identifier quoting, comments,
// string literals, and numeric / operator handling. Anything that
// regresses here will silently break BOTH downstream parsers, so this
// suite is intentionally exhaustive on the small set of "weird" forms.
// ════════════════════════════════════════════════════════════════════

function tok(sql) {
    return tokenize(sql);
}

function values(toks, opts = {}) {
    const filter = opts.type ? (t) => t.type === opts.type : () => true;
    return toks.filter(filter).map((t) => ({ type: t.type, value: t.value }));
}

// ════════════════════════════════════════════════════════════════════
// Comments — line / block / dialect-specific
// ════════════════════════════════════════════════════════════════════
describe('Tokenizer — comments', () => {
    it('strips standard SQL `--` line comments', () => {
        const { tokens, errors } = tok(`-- a comment\nCREATE TABLE t (id INT);`);
        expect(errors).toHaveLength(0);
        const kw = tokens.find((t) => t.value === 'CREATE');
        expect(kw).toBeTruthy();
    });

    it('strips C-style /* ... */ block comments', () => {
        const { tokens, errors } = tok(`/* big\n  multiline */\nCREATE TABLE t (id INT);`);
        expect(errors).toHaveLength(0);
        expect(tokens.find((t) => t.value === 'CREATE')).toBeTruthy();
    });

    it('strips nested block comments used by PostgreSQL and SQL Server', () => {
        const { tokens, errors } = tok(`/* outer /* inner */ still outer */ CREATE TABLE t (id INT);`);
        expect(errors).toHaveLength(0);
        expect(tokens.find((t) => t.value === 'CREATE')).toBeTruthy();
        expect(tokens.some((t) => t.value === 'still')).toBe(false);
    });

    it('reports an error on unclosed block comment', () => {
        const { errors } = tok(`/* never closed`);
        expect(errors.some((e) => e.kind === 'unclosed_block_comment')).toBe(true);
    });

    // MySQL line-comment marker. Must not regress MSSQL #temp identifiers.
    it('treats MySQL `#` followed by space as a line comment', () => {
        const { tokens, errors } = tok(`# Host: localhost\nCREATE TABLE t (id INT);`);
        expect(errors).toHaveLength(0);
        // No PUNC `#` token should leak through into the stream.
        expect(tokens.some((t) => t.type === 'PUNC' && t.value === '#')).toBe(false);
        expect(tokens.find((t) => t.value === 'CREATE')).toBeTruthy();
    });

    it('treats `# end-of-line` (no space) as a comment too', () => {
        const { tokens, errors } = tok(`SELECT 1\n# trailing\nCREATE TABLE t (id INT);`);
        expect(errors).toHaveLength(0);
        expect(tokens.find((t) => t.value === 'CREATE')).toBeTruthy();
    });

    it('treats MySQL `#comment` without a space as a line comment', () => {
        const { tokens, errors } = tok(`#comment without a space\nCREATE TABLE t (id INT);`);
        expect(errors).toHaveLength(0);
        expect(tokens.find((t) => t.value === 'CREATE')).toBeTruthy();
        expect(tokens.some((t) => String(t.value).includes('comment'))).toBe(false);
    });

    it('emits `#temp` (MSSQL temp-table) as one identifier, not a comment', () => {
        const { tokens } = tok(`CREATE TABLE #temp (id INT);`);
        expect(tokens).toContainEqual(expect.objectContaining({ type: 'IDENT', value: '#temp' }));
    });

    it('keeps a SQL Server temp table after CREATE INDEX ON intact', () => {
        const { tokens } = tok(`CREATE INDEX ix_temp ON #temp (id);`);
        expect(tokens).toContainEqual(expect.objectContaining({ type: 'IDENT', value: '#temp' }));
    });
});

// ════════════════════════════════════════════════════════════════════
// String literals — every dialect's preferred quote/escape style
// ════════════════════════════════════════════════════════════════════
describe('Tokenizer — string literals', () => {
    it('parses a basic single-quoted string', () => {
        const { tokens } = tok(`'hello'`);
        expect(tokens[0]).toMatchObject({ type: 'STRING', value: 'hello' });
    });

    it("handles SQL-standard '' escape inside a single-quoted string", () => {
        const { tokens } = tok(`'It''s SQL'`);
        expect(tokens[0]).toMatchObject({ type: 'STRING', value: "It's SQL" });
    });

    it("handles MySQL backslash-escaped quote", () => {
        // mysqldump emits this for any single-quote inside a VALUES literal.
        const { tokens, errors } = tok(`'a\\'b'`);
        expect(errors).toHaveLength(0);
        expect(tokens[0]).toMatchObject({ type: 'STRING', value: "a'b" });
    });

    it('handles MySQL backslash-escaped backslash', () => {
        const { tokens, errors } = tok(`'C:\\\\foo'`);
        expect(errors).toHaveLength(0);
        // Logical value is C:\foo, MySQL semantics. PG users explicitly
        // opting into literal `\` will see the same — we collapse both
        // dialects to the MySQL-correct interpretation since dumps use it.
        expect(tokens[0].value).toBe('C:\\foo');
    });

    it('parses MSSQL `N\'unicode\'` Unicode literal', () => {
        const { tokens, errors } = tok(`N'tomás'`);
        expect(errors).toHaveLength(0);
        expect(tokens).toHaveLength(1);
        expect(tokens[0]).toMatchObject({ type: 'STRING', value: 'tomás' });
    });

    it('parses lowercase `n\'…\'` Unicode literal too', () => {
        const { tokens } = tok(`n'foo'`);
        expect(tokens[0]).toMatchObject({ type: 'STRING', value: 'foo' });
    });

    it('does NOT treat bare `N` as a Unicode-literal prefix', () => {
        // `WHERE N = 5` — N is a column name, not a string prefix.
        const { tokens } = tok(`N = 5`);
        expect(tokens[0]).toMatchObject({ type: 'IDENT', value: 'N' });
        expect(tokens[1]).toMatchObject({ type: 'OP', value: '=' });
        expect(tokens[2]).toMatchObject({ type: 'NUMBER', value: '5' });
    });

    it('parses PostgreSQL dollar-quoted strings', () => {
        const { tokens, errors } = tok(`$body$line one
line two$body$`);
        expect(errors).toHaveLength(0);
        expect(tokens[0]).toMatchObject({ type: 'STRING', value: 'line one\nline two' });
    });

    it('reports unclosed single-quoted string', () => {
        const { errors } = tok(`'never closed`);
        expect(errors.some((e) => e.kind === 'unclosed_string')).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════
// Identifier quoting — ANSI " ", MySQL `, MSSQL [ ]
// ════════════════════════════════════════════════════════════════════
describe('Tokenizer — identifier quoting', () => {
    it('parses ANSI-style `"col"` identifiers (PostgreSQL / SQLite)', () => {
        const { tokens } = tok(`"my col"`);
        expect(tokens[0]).toMatchObject({ type: 'IDENT', value: 'my col' });
    });

    it('parses MySQL backtick identifiers', () => {
        const { tokens } = tok('`my col`');
        expect(tokens[0]).toMatchObject({ type: 'IDENT', value: 'my col' });
    });

    it('parses MSSQL bracket identifiers', () => {
        const { tokens } = tok(`[my col]`);
        expect(tokens[0]).toMatchObject({ type: 'IDENT', value: 'my col' });
    });

    it('parses escaped closing brackets inside MSSQL identifiers', () => {
        const { tokens, errors } = tok(`[my]] table]`);
        expect(errors).toHaveLength(0);
        expect(tokens).toHaveLength(1);
        expect(tokens[0]).toMatchObject({ type: 'IDENT', value: 'my] table' });
    });

    it('handles doubled `""` inside a quoted identifier', () => {
        const { tokens } = tok(`"col with ""quotes"" inside"`);
        expect(tokens[0]).toMatchObject({ type: 'IDENT', value: 'col with "quotes" inside' });
    });

    it('emits empty `[]` as two PUNCs (PostgreSQL array suffix, NOT MSSQL ident)', () => {
        // `INT[]` should tokenize as INT plus `[`, `]` — array of int.
        const { tokens } = tok(`INT[]`);
        const types = values(tokens);
        expect(types).toEqual([
            { type: 'KW', value: 'INT' },
            { type: 'PUNC', value: '[' },
            { type: 'PUNC', value: ']' },
        ]);
    });
});

// ════════════════════════════════════════════════════════════════════
// Numbers / operators / punctuation — basic sanity
// ════════════════════════════════════════════════════════════════════
describe('Tokenizer — numbers and operators', () => {
    it('parses decimals and scientific notation', () => {
        const r = tok(`1 1.5 1.5e10 1e-3`);
        const nums = values(r.tokens, { type: 'NUMBER' }).map((t) => t.value);
        expect(nums).toEqual(['1', '1.5', '1.5e10', '1e-3']);
    });

    it('parses multi-character operators', () => {
        const ops = ['<=', '>=', '<>', '!=', '<=>', '||', '::', '->', '->>', '@>', '<@', '?|', '?&', '#>', '#>>', '&&', '~*', '!~', '!~*'];
        for (const op of ops) {
            const { tokens } = tok(op);
            expect(tokens.some((t) => t.type === 'OP' && t.value === op)).toBe(true);
        }
    });

    it('handles unmatched closing parenthesis as an error', () => {
        const { errors } = tok(`)`);
        expect(errors.some((e) => e.kind === 'unmatched_closing_paren')).toBe(true);
    });

    it('enforces maxTokens as a hard resource boundary with one diagnostic', () => {
        const { tokens, errors } = tokenize(`CREATE TABLE t (id INT, name TEXT, active BOOLEAN);`, { maxTokens: 3 });

        expect(tokens).toHaveLength(3);
        expect(errors.filter((error) => error.kind === 'too_many_tokens')).toHaveLength(1);
        expect(errors[0].start.idx).toBeGreaterThan(0);
    });

    it('throws immediately at the token boundary in strict mode', () => {
        expect(() => tokenize(`CREATE TABLE t (id INT);`, { maxTokens: 1, strict: true })).toThrow(/token limit exceeded/i);
    });

    it('anchors oversized-token diagnostics at the offending token', () => {
        const { errors } = tokenize(`x 'abcdef'`, { maxTokenLength: 3 });
        const error = errors.find((entry) => entry.kind === 'token_too_long' && entry.token.raw.includes('abcdef'));

        expect(error).toBeTruthy();
        expect(error.start.idx).toBe(2);
        expect(error.end.idx).toBeGreaterThan(error.start.idx);
    });
});

// ════════════════════════════════════════════════════════════════════
// Cross-dialect smoke — same logical schema in 4 syntaxes
// ════════════════════════════════════════════════════════════════════
describe('Tokenizer — cross-dialect smoke', () => {
    const SCHEMAS = {
        SQLite: `CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL) WITHOUT ROWID;`,
        PostgreSQL: `CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL);`,
        MySQL: 'CREATE TABLE `users` (`id` INT AUTO_INCREMENT PRIMARY KEY, `name` VARCHAR(255) NOT NULL) ENGINE=InnoDB;',
        MSSQL: `CREATE TABLE [users] ([id] INT IDENTITY(1,1) PRIMARY KEY, [name] NVARCHAR(255) NOT NULL);`,
    };

    for (const [dialect, sql] of Object.entries(SCHEMAS)) {
        it(`tokenizes the ${dialect} schema with zero errors`, () => {
            const { tokens, errors } = tok(sql);
            expect(errors).toHaveLength(0);
            // Every dialect must have a CREATE/TABLE/PRIMARY/KEY skeleton.
            const kws = tokens.filter((t) => t.type === 'KW').map((t) => t.value);
            expect(kws).toEqual(expect.arrayContaining(['CREATE', 'TABLE', 'PRIMARY', 'KEY']));
        });
    }

    it('handles a mixed-dialect script with all four flavors of identifier quoting', () => {
        const sql = `
            -- SQLite
            CREATE TABLE "lite" ("id" INTEGER PRIMARY KEY AUTOINCREMENT);
            -- PostgreSQL
            CREATE TABLE "pg" ("id" SERIAL PRIMARY KEY);
            # MySQL (note the # comment)
            CREATE TABLE \`my\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY);
            -- MSSQL
            CREATE TABLE [ms] ([id] INT IDENTITY(1,1) PRIMARY KEY);
        `;
        const { errors, tokens } = tok(sql);
        expect(errors).toHaveLength(0);
        // 4 CREATE keywords, 4 TABLE keywords.
        expect(tokens.filter((t) => t.value === 'CREATE')).toHaveLength(4);
        expect(tokens.filter((t) => t.value === 'TABLE')).toHaveLength(4);
    });
});
