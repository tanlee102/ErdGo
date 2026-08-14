const MULTI_CHAR_OPS = new Set(['<=', '>=', '<>', '!=', '<=>', '||', '::', '->', '->>', '@>', '<@', '?|', '?&', '#>', '#>>', '&&', '<<', '>>', '~*', '!~', '!~*']);

/**
 * Production-ready SQL tokenizer (improved)
 * - returns { tokens, errors }
 */
export function tokenize(sqlInput, opts = {}) {
    const {
        lowercaseIdentifiers = false,
        skipComments = true,
        keywords = [
            // Core DDL
            'CREATE',
            'TYPE',
            'AS',
            'ENUM',
            'TABLE',
            'VIEW',
            'MATERIALIZED',
            'COLUMN',
            'ALTER',
            'DROP',
            'RENAME',
            'TO',

            // Constraints & key words
            'CONSTRAINT',
            'PRIMARY',
            'KEY',
            'FOREIGN',
            'REFERENCES',
            'UNIQUE',
            'CHECK',
            'NOT',
            'NULL',
            'DEFAULT',
            'ADD',
            'IN',
            'BETWEEN',
            'AND',
            'OR',
            'GENERATED',
            'ALWAYS',
            'STORED',
            'VIRTUAL',
            'BY',
            'IF',
            'EXISTS',
            'ONLY',
            'NULLS',
            'DISTINCT',

            // Table-level modifiers (PostgreSQL / MySQL / MSSQL)
            'TEMP',
            'TEMPORARY',
            'UNLOGGED',
            'GLOBAL',
            'LOCAL',
            'INHERITS',
            'LIKE',
            'INCLUDING',
            'EXCLUDING',
            'EXCLUDE',
            'USING',
            'WITH',

            // Common data types (PostgreSQL)
            'INT',
            'INTEGER',
            'BIGINT',
            'SMALLINT',
            'SERIAL',
            'BIGSERIAL',
            'TEXT',
            'VARCHAR',
            'CHAR',
            'BOOLEAN',
            'BOOL',
            'DATE',
            'TIME',
            'TIMESTAMP',
            'TIMESTAMP WITH TIME ZONE',
            'TIMESTAMP WITHOUT TIME ZONE',
            'NUMERIC',
            'DECIMAL',
            'REAL',
            'DOUBLE PRECISION',
            'FLOAT',
            'JSON',
            'JSONB',
            'UUID',
            'BYTEA',
            'MONEY',

            // Additional data types (MySQL)
            'TINYINT',
            'MEDIUMINT',
            'TINYTEXT',
            'MEDIUMTEXT',
            'LONGTEXT',
            'BLOB',
            'YEAR',
            'UNSIGNED',
            'SIGNED',

            // Additional data types (MSSQL)
            'NVARCHAR',
            'NCHAR',
            'NTEXT',
            'DATETIME',
            'DATETIME2',
            'SMALLDATETIME',
            'BIT',
            'VARBINARY',
            'IMAGE',
            'XML',
            'UNIQUEIDENTIFIER',
            'HIERARCHYID',
            'ROWVERSION',
            'SMALLMONEY',
            'DATETIMEOFFSET',
            'SPARSE',
            'FILESTREAM',

            // MySQL column modifiers
            'AUTO_INCREMENT',
            'COMMENT',
            'ENGINE',
            'CHARSET',
            'ZEROFILL',
            'INVISIBLE',
            'VISIBLE',
            'SET',
            'MODIFY',
            'CHANGE',
            'FIRST',
            'AFTER',
            'ENFORCED',

            // SQLite-specific keywords
            'AUTOINCREMENT',
            'STRICT',
            'WITHOUT',
            'ROWID',
            'ABORT',
            'FAIL',
            'IGNORE',
            'REPLACE',
            'CONFLICT',
            'GLOB',
            'REGEXP',

            // Index-related (MySQL / MSSQL)
            'INDEX',
            'FULLTEXT',
            'SPATIAL',

            // MSSQL column/constraint modifiers
            'IDENTITY',
            'CLUSTERED',
            'NONCLUSTERED',
            'PERSISTED',
            'PERIOD',
            'FOR',
            'SYSTEM_TIME',
            'START',
            'END',
            'HIDDEN',
            'TRANSACTION_ID',
            'SEQUENCE_NUMBER',
            'MASKED',
            'ROWGUIDCOL',
            'GO',

            // FK actions (common across all dialects)
            'ON',
            'DELETE',
            'UPDATE',
            'CASCADE',
            'RESTRICT',
            'ACTION',
            'MATCH',
            'FULL',
            'PARTIAL',
            'SIMPLE',
            'DEFERRABLE',
            'INITIALLY',
            'DEFERRED',
            'IMMEDIATE',

            // Character set / collation
            'COLLATE',

            // Functions / sequence helpers (for DEFAULT parsing)
            'NOW',
            'CURRENT_TIMESTAMP',
            'CURRENT_DATE',
            'CURRENT_TIME',
            'NEXTVAL',
            'CURRVAL',
            'ROW',
            'GETDATE',
            'NEWID',
        ],
        source = null,
        maxTokenLength = 20000,
        maxTokens = 200000,
        strict = false,
    } = opts;

    // Keep the original source intact. Positions are consumed by Monaco and
    // must remain UTF-16 offsets into the exact text the user supplied;
    // rewriting CRLF to LF (or stripping a BOM) makes every later offset
    // point one character early. Newline handling lives in `advance()`.
    if (typeof sqlInput !== 'string') throw new TypeError('sql must be string');
    const sql = sqlInput;

    const KWSET = new Set((Array.isArray(keywords) ? keywords : Array.from(keywords)).map((k) => String(k).toUpperCase()));

    // helpers for Unicode letters: use \p{L} with u flag
    const reLetter = /^\p{L}$/u; // single char letter
    const isLetter = (ch) => ch === '_' || (typeof ch === 'string' && ch.length === 1 && reLetter.test(ch));
    const isDigit = (ch) => /[0-9]/.test(ch);
    const isIdentChar = (ch) => {
        if (!ch || ch.length !== 1) return false;
        // letters, digits, underscore, dollar sign, or combining marks
        if (ch === '$' || ch === '_' || /[0-9]/.test(ch)) return true;
        // letters via unicode property
        return reLetter.test(ch);
    };

    let i = 0,
        line = 1,
        col = 1;
    const len = sql.length;
    const tokens = [];
    const errors = [];
    const MSSQL_TEMP_TABLE_PRECEDERS = new Set(['TABLE', 'FROM', 'JOIN', 'INTO', 'UPDATE', 'DELETE', 'INSERT', 'TRUNCATE', 'ON']);
    let tokenLimitReached = false;

    // Strict parentheses validation
    const parenStack = []; // Track opening parentheses with context
    let lastKeyword = null; // Track recent keywords for context

    const makePos = () => ({ idx: i, line, col });

    // Add parentheses validation functions
    function trackOpenParen(token) {
        parenStack.push({
            token,
            position: { ...token.start },
            context: lastKeyword,
            tokens: [],
        });
    }

    function trackCloseParen(token) {
        if (parenStack.length === 0) {
            errors.push({
                kind: 'unmatched_closing_paren',
                message: "Unexpected closing parenthesis ')' without matching opening '('",
                severity: 'error',
                start: token.start,
                end: token.end,
            });
            return;
        }

        const openParen = parenStack.pop();
        const openLine = openParen.position.line;
        const closeLine = token.start?.line || line;

        // Check for suspicious cross-line matching in specific contexts
        if (openParen.context === 'CHECK' && closeLine > openLine) {
            // For CHECK constraints, look for incomplete patterns
            const content = openParen.tokens
                .map((t) => t.value)
                .join(' ')
                .trim();

            // Skip warning if content has logical operators (AND/OR) - this is a complete expression
            const hasLogicalOperators = /\b(AND|OR)\b/i.test(content);

            // Pattern detection for likely missing closing paren
            // Only warn if it's a simple single comparison without logical operators
            if (
                content &&
                !hasLogicalOperators &&
                // Simple comparison that looks incomplete (single condition only)
                /^\s*\w+\s*[><=!]+\s*\w+\s*$/.test(content)
            ) {
                errors.push({
                    kind: 'suspicious_paren_matching',
                    message: `Suspicious parentheses matching in CHECK constraint across lines ${openLine}-${closeLine}. The expression '${content}' may be missing a closing ')' before the line break.`,
                    severity: 'warning',
                    start: openParen.position,
                    end: token.end,
                });
            }
        }
    }

    function addTokenToContext(token) {
        if (parenStack.length > 0) {
            parenStack[parenStack.length - 1].tokens.push(token);
        }

        // Track keywords for context
        if (token.type === 'KW') {
            lastKeyword = token.value.toUpperCase();
        }
    }

    function advance(n = 1) {
        while (n-- > 0 && i < len) {
            // Treat LF, CRLF, and legacy CR as one logical line break while
            // still moving `i` across every source character. This preserves
            // both editor offsets and 1-based line/column diagnostics.
            if (sql[i] === '\r') {
                i += 1;
                if (sql[i] === '\n') i += 1;
                line += 1;
                col = 1;
            } else if (sql[i] === '\n') {
                line += 1;
                col = 1;
                i += 1;
            } else {
                i += 1;
                col += 1;
            }
        }
    }
    function advanceTo(endIdx) {
        while (i < endIdx && i < len) advance(1);
    }
    const peek = (off = 0) => sql[i + off];
    const eof = () => i >= len;
    const sliceRaw = (a, b) => sql.slice(a, b);

    function pushToken(type, value, startPos, endPos) {
        // The token ceiling is a real resource boundary, not merely a
        // diagnostic. Keeping lexing after the limit would still allocate an
        // unbounded token array (and an error for every extra token) for a
        // pasted/generated SQL blob.
        if (tokens.length >= maxTokens) {
            if (!tokenLimitReached) {
                const err = {
                    kind: 'too_many_tokens',
                    message: `token limit exceeded (${maxTokens})`,
                    severity: 'error',
                    start: startPos,
                    end: endPos,
                };
                errors.push(err);
                tokenLimitReached = true;
                if (strict) throw new Error(err.message);
            }
            return null;
        }

        const raw = sliceRaw(startPos.idx, endPos.idx);
        let outValue = value;
        if (type === 'KW') outValue = String(value).toUpperCase();
        if (type === 'IDENT' && lowercaseIdentifiers) outValue = String(value).toLowerCase();
        const tok = { type, value: outValue, raw, start: startPos, end: endPos };
        if (source) tok.source = source;

        // Strict parentheses validation
        if (type === 'PUNC' && value === '(') {
            trackOpenParen(tok);
        } else if (type === 'PUNC' && value === ')') {
            trackCloseParen(tok);
        } else {
            addTokenToContext(tok);
        }

        tokens.push(tok);
        return tok;
    }

    // small safety guard
    let steps = 0;
    const maxSteps = Math.max(1000000, len * 10);

    // A BOM is not SQL syntax, but it is part of the editor's source text.
    // Consume it without changing the source string so subsequent token
    // positions continue to refer to the original input.
    if (sql.charCodeAt(0) === 0xfeff) advance(1);

    while (!eof()) {
        if (tokenLimitReached) break;
        if (++steps > maxSteps) {
            const err = { kind: 'loop_guard', message: 'tokenizer loop guard triggered', severity: 'error' };
            errors.push(err);
            if (strict) throw new Error(err.message);
            break;
        }

        const ch = peek();

        // 1) whitespace
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
            advance(1);
            continue;
        }

        // 2) comments
        if (ch === '-' && peek(1) === '-') {
            const start = makePos();
            advance(2);
            while (!eof() && peek() !== '\n' && peek() !== '\r') advance(1);
            const end = makePos();
            if (!skipComments) pushToken('COMMENT', sliceRaw(start.idx, end.idx), start, end);
            continue;
        }
        // MySQL `#` comments do not require a following space. The only
        // conflicting construct is SQL Server's local/global temp-table
        // identifier (`#temp` / `##temp`), which is valid only where a table
        // name can begin. Emit those as one IDENT token; every other `#`
        // begins a MySQL line comment.
        if (ch === '#' && peek(1) !== '>') {
            const previous = tokens[tokens.length - 1];
            const previousWord = previous && (previous.type === 'KW' || previous.type === 'IDENT') ? String(previous.value).toUpperCase() : '';
            if (MSSQL_TEMP_TABLE_PRECEDERS.has(previousWord)) {
                const start = makePos();
                let name = '';
                // SQL Server permits one # for local and two for global temp
                // tables. Do not absorb a third #; it is not a valid name.
                name += '#';
                advance(1);
                if (peek() === '#') {
                    name += '#';
                    advance(1);
                }
                while (!eof() && isIdentChar(peek())) {
                    name += peek();
                    advance(1);
                }
                if (name.length > 1) {
                    const end = makePos();
                    pushToken('IDENT', name, start, end);
                    continue;
                }
            }

            const start = makePos();
            advance(1);
            while (!eof() && peek() !== '\n' && peek() !== '\r') advance(1);
            const end = makePos();
            if (!skipComments) pushToken('COMMENT', sliceRaw(start.idx, end.idx), start, end);
            continue;
        }
        if (ch === '/' && peek(1) === '*') {
            const start = makePos();
            advance(2);
            let depth = 1;
            let closed = false;
            // PostgreSQL and SQL Server both allow nested block comments.
            // Tracking depth also gives SQLite/MySQL users harmlessly
            // predictable recovery when a generated script contains one.
            while (!eof() && depth > 0) {
                if (peek() === '/' && peek(1) === '*') {
                    depth += 1;
                    advance(2);
                    continue;
                }
                if (peek() === '*' && peek(1) === '/') {
                    advance(2);
                    depth -= 1;
                    closed = depth === 0;
                    continue;
                }
                advance(1);
            }
            const end = makePos();
            if (!closed) {
                errors.push({ kind: 'unclosed_block_comment', message: 'Unclosed block comment', severity: 'error', start, end });
                if (strict) throw new Error('Unclosed block comment');
            }
            if (!skipComments) pushToken('COMMENT', sliceRaw(start.idx, end.idx), start, end);
            continue;
        }

        // 3) dollar-quoted string: $tag$...$tag$
        if (ch === '$') {
            // capture tag
            let j = i + 1;
            let tag = '$';
            while (j < len && /[A-Za-z0-9_]/.test(sql[j])) {
                tag += sql[j];
                j++;
            }
            if (sql[j] === '$') {
                tag += '$';
                const closeIdx = sql.indexOf(tag, j + 1);
                if (closeIdx !== -1) {
                    const innerStart = i + tag.length;
                    const innerEnd = closeIdx;
                    const endIdx = closeIdx + tag.length;
                    const startPos = makePos();
                    // Advance to the source index rather than normalizing
                    // rawText, so CRLF and BOM offsets remain exact.
                    advanceTo(endIdx);
                    const endPos = makePos();
                    const inner = sql.slice(innerStart, innerEnd);
                    pushToken('STRING', inner, startPos, endPos);
                    continue;
                } else {
                    // unclosed - consume rest as string
                    const startPos = makePos();
                    advanceTo(len);
                    const endPos = makePos();
                    errors.push({ kind: 'unclosed_dollar_quote', message: 'Unclosed dollar-quoted string', severity: 'error', start: startPos, end: endPos });
                    pushToken('STRING', sliceRaw(startPos.idx, endPos.idx), startPos, endPos);
                    if (strict) throw new Error('Unclosed dollar-quoted string');
                    continue;
                }
            }
            // else fallthrough: treat $ as IDENT start
        }

        // 4) single-quoted string literal
        // Also handles MSSQL Unicode prefix `N'...'` / `n'...'` — the
        // prefix is purely metadata for the SQL Server parser and the
        // resulting token value is the unprefixed string.
        if (ch === "'" || ((ch === 'N' || ch === 'n') && peek(1) === "'")) {
            const start = makePos();
            if (ch === 'N' || ch === 'n') advance(1);
            advance(1);
            let closed = false;
            let valueBuf = '';
            while (!eof()) {
                const c = peek();
                if (c === "'") {
                    if (peek(1) === "'") {
                        valueBuf += "'";
                        advance(2);
                        continue;
                    }
                    advance(1);
                    closed = true;
                    break;
                }
                // MySQL backslash escape. We support the minimum set that
                // appears in real `mysqldump` output without breaking
                // PostgreSQL semantics where `\` inside a non-`E'…'` string
                // is taken literally:
                //   \\  →  \   (so `'C:\\path'` stays `C:\path`, MySQL semantics)
                //   \'  →  '   (without this, the next char would close the string)
                // Other backslash sequences are kept as-is.
                if (c === '\\') {
                    const nxt = peek(1);
                    if (nxt === "'") {
                        valueBuf += "'";
                        advance(2);
                        continue;
                    }
                    if (nxt === '\\') {
                        valueBuf += '\\';
                        advance(2);
                        continue;
                    }
                    valueBuf += c;
                    advance(1);
                    continue;
                }
                valueBuf += c;
                advance(1);
            }
            const end = makePos();
            if (!closed) {
                errors.push({ kind: 'unclosed_string', message: 'Unclosed single-quoted string', severity: 'error', start, end });
                if (strict) throw new Error('Unclosed single-quoted string');
            }
            pushToken('STRING', valueBuf, start, end);
            continue;
        }

        // 5) quoted identifiers "..." or `...` or [..]
        // Special case: empty `[]` is a PostgreSQL array suffix, NOT an MSSQL identifier.
        // Emit it as two PUNC tokens so callers (e.g. parseAst type collector) can detect array types.
        if (ch === '[' && peek(1) === ']') {
            const startOpen = makePos();
            advance(1);
            const endOpen = makePos();
            pushToken('PUNC', '[', startOpen, endOpen);
            const startClose = makePos();
            advance(1);
            const endClose = makePos();
            pushToken('PUNC', ']', startClose, endClose);
            continue;
        }
        if (ch === '"' || ch === '`' || ch === '[') {
            const start = makePos();
            const opener = ch;
            const closer = opener === '[' ? ']' : opener;
            advance(1);
            let buf = '';
            let closed = false;
            while (!eof()) {
                const c = peek();
                if (c === closer) {
                    // SQL Server escapes a closing bracket in `[identifier]`
                    // as `]]`; ANSI/MySQL quote styles double their opener.
                    if ((closer === '"' || closer === '`' || closer === ']') && peek(1) === closer) {
                        buf += closer;
                        advance(2);
                        continue;
                    }
                    advance(1);
                    closed = true;
                    break;
                } else {
                    buf += c;
                    advance(1);
                }
            }
            const end = makePos();
            if (!closed) {
                errors.push({ kind: 'unclosed_quoted_identifier', message: 'Unclosed quoted identifier', severity: 'error', start, end });
                if (strict) throw new Error('Unclosed quoted identifier');
            }
            pushToken('IDENT', buf, start, end);
            continue;
        }

        // 6) number
        if (isDigit(ch) || (ch === '.' && isDigit(peek(1)))) {
            const start = makePos();
            let num = '';
            while (!eof() && isDigit(peek())) {
                num += peek();
                advance(1);
            }
            if (peek() === '.' && isDigit(peek(1))) {
                num += '.';
                advance(1);
                while (!eof() && isDigit(peek())) {
                    num += peek();
                    advance(1);
                }
            }
            if ((peek() === 'e' || peek() === 'E') && (isDigit(peek(1)) || ((peek(1) === '+' || peek(1) === '-') && isDigit(peek(2))))) {
                num += peek();
                advance(1);
                if (peek() === '+' || peek() === '-') {
                    num += peek();
                    advance(1);
                }
                while (!eof() && isDigit(peek())) {
                    num += peek();
                    advance(1);
                }
            }
            const end = makePos();
            pushToken('NUMBER', num, start, end);
            continue;
        }

        // 7) identifier / keyword
        if (isLetter(ch) || ch === '$') {
            const start = makePos();
            let name = '';
            while (!eof() && isIdentChar(peek())) {
                name += peek();
                advance(1);
            }
            const end = makePos();
            const up = name.toUpperCase();
            if (KWSET.has(up)) pushToken('KW', up, start, end);
            else pushToken('IDENT', name, start, end);
            continue;
        }

        // 8) punctuation (with :: PostgreSQL cast special case)
        if (',();.:'.includes(ch)) {
            if (ch === ':' && peek(1) === ':') {
                const start = makePos();
                advance(2);
                const end = makePos();
                pushToken('OP', '::', start, end);
                continue;
            }
            const start = makePos();
            advance(1);
            const end = makePos();
            pushToken('PUNC', ch, start, end);
            continue;
        }

        // 9) operators
        if ('=<>!+-*/%|&^~@?#'.includes(ch)) {
            const start = makePos();
            const two = ch + peek(1);
            const three = two + peek(2);
            let op = ch;
            if (three && MULTI_CHAR_OPS.has(three)) {
                op = three;
                advance(3);
            } else if (two && MULTI_CHAR_OPS.has(two)) {
                op = two;
                advance(2);
            } else {
                advance(1);
            }
            const end = makePos();
            pushToken('OP', op, start, end);
            continue;
        }

        // 10) fallback: unknown char
        {
            const start = makePos();
            advance(1);
            const end = makePos();
            pushToken('PUNC', sql[start.idx], start, end);
            continue;
        }
    } // while

    // Check for unmatched opening parentheses
    while (parenStack.length > 0) {
        const unclosed = parenStack.pop();
        errors.push({
            kind: 'unmatched_opening_paren',
            message: `Missing closing ')' for '(' at line ${unclosed.position.line}, column ${unclosed.position.col}. Check for incomplete expressions.`,
            severity: 'warning',
            start: unclosed.position,
            end: unclosed.position,
        });
    }

    // final defensive checks
    for (const t of tokens) {
        if ((t.raw && t.raw.length > maxTokenLength) || String(t.value).length > maxTokenLength) {
            const err = {
                kind: 'token_too_long',
                message: 'Token length exceeds maxTokenLength',
                severity: 'error',
                token: { raw: (t.raw || '').slice(0, 80) + '...' },
                start: t.start,
                end: t.end,
            };
            errors.push(err);
            if (strict) throw new Error(err.message);
        }
    }

    return { tokens, errors };
}
