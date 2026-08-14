import { tokenize } from './tokenize.js';
import { detectSqlDialectProfile, getSqlDialectProfile, normalizeSqlDialect } from '../sqlDialectProfiles.js';

/**
 * Keywords that, when seen immediately after a token like `KEY`/`INDEX` in a
 * column entry, prove that the surrounding token is actually a column name
 * rather than a MySQL index/key constraint. Kept narrow and scalar — no
 * structural keywords like `(` or `WITH`.
 */
const DATA_TYPE_KEYWORDS = new Set([
    'INT',
    'INTEGER',
    'BIGINT',
    'SMALLINT',
    'TINYINT',
    'MEDIUMINT',
    'SERIAL',
    'BIGSERIAL',
    'TEXT',
    'TINYTEXT',
    'MEDIUMTEXT',
    'LONGTEXT',
    'VARCHAR',
    'CHAR',
    'NVARCHAR',
    'NCHAR',
    'NTEXT',
    'BOOLEAN',
    'BOOL',
    'BIT',
    'DATE',
    'TIME',
    'TIMESTAMP',
    'DATETIME',
    'DATETIME2',
    'SMALLDATETIME',
    'DATETIMEOFFSET',
    'NUMERIC',
    'DECIMAL',
    'REAL',
    'FLOAT',
    'DOUBLE',
    'JSON',
    'JSONB',
    'UUID',
    'BYTEA',
    'BLOB',
    'VARBINARY',
    'IMAGE',
    'XML',
    'YEAR',
    'MONEY',
    'SMALLMONEY',
    'UNIQUEIDENTIFIER',
    'HIERARCHYID',
    'ROWVERSION',
    'ENUM',
    'SET',
]);

/**
 * ════════════════════════════════════════════════════════════════════════════
 *  parseAST — SQL DDL → AST for the ERD pipeline
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  AT-A-GLANCE READING ORDER (for humans and AI agents)
 *  ----------------------------------------------------
 *  The single exported entry point is `parseAST(sql, options?)` at the bottom of
 *  this file. Internally it composes one big closure with the helpers
 *  below. If you need to understand or modify behaviour, read in this
 *  order — top-down builds context the same way the parser does:
 *
 *    1. SECTION A — cursor primitives (peek/next/expect/parseIdentifier)
 *    2. SECTION B — expression-text reconstruction (`applyNaturalSpacing`)
 *    3. SECTION C — `parseCreateType`           (PG/MySQL ENUM + composite)
 *    4. SECTION D — `parseConstraintWithTempParser` (table-level PK/UQ/FK/CHECK)
 *    5. SECTION E — `parseCreateTable`          (the heart of the parser)
 *    6. SECTION F — `makeTempParser` + `parseColumnDefinitionForEntry`
 *                   (single column: type, constraints, defaults, identity, …)
 *    7. SECTION G — `parseAlterTable`           (ADD constraints to ERD)
 *    8. SECTION G2 — `parseCreateIndex`         (standalone CREATE INDEX)
 *    9. SECTION H — top-level dispatch          (the while-loop at the end)
 *
 *  The file ends with a post-parse FK-target validation pass that flags
 *  references to tables not present in the script.
 *
 *  KEY INVARIANT FOR NAVIGATION
 *  ----------------------------
 *  Every parser advances the shared cursor `idx` ONLY through `next()` /
 *  `expect()`. Helpers operating on a sliced token slice (everything
 *  produced by `makeTempParser(toks)`) maintain their own private cursor
 *  so they don't disturb the main one. If you ever see a function
 *  manipulate `idx` directly, treat it as suspicious — it almost
 *  certainly belongs in a helper.
 *
 *  PURPOSE
 *  -------
 *  Parses a (potentially mixed-dialect) SQL DDL script into a normalized AST
 *  that downstream consumers — `erdJsonSchema.js`, the canvas renderer, the
 *  Monaco-editor inline error UI — can use without re-implementing dialect
 *  quirks.
 *
 *  DIALECT COVERAGE
 *  ----------------
 *  PostgreSQL:  CREATE TYPE ... AS ENUM/composite, SERIAL/BIGSERIAL,
 *               GENERATED [ALWAYS|BY DEFAULT] AS IDENTITY, GENERATED ALWAYS
 *               AS (expr) STORED, INHERITS, schema-qualified refs, arrays,
 *               JSONB/UUID/TIMESTAMPTZ, INTERVAL, partitioning hints.
 *  MySQL:       AUTO_INCREMENT, ENGINE=/CHARSET=/COLLATE=/ROW_FORMAT=,
 *               inline KEY/INDEX/FULLTEXT/SPATIAL definitions,
 *               backticked identifiers, ON UPDATE CURRENT_TIMESTAMP, SET
 *               column type, generated columns (STORED|VIRTUAL).
 *  MSSQL:       IDENTITY(seed, increment), bracket-quoted identifiers,
 *               CLUSTERED/NONCLUSTERED, computed columns
 *               `col AS (expr) [PERSISTED [NOT NULL]]`, UNIQUEIDENTIFIER,
 *               ROWVERSION, DATETIMEOFFSET, SPARSE/FILESTREAM, filtered
 *               indexes, CREATE SEQUENCE, GO batch separator.
 *  SQLite:      AUTOINCREMENT (no underscore), WITHOUT ROWID, STRICT,
 *               ON CONFLICT clauses (ABORT/FAIL/IGNORE/REPLACE/ROLLBACK),
 *               type-affinity (typeless columns), bracket / double-quote
 *               identifier flexibility.
 *
 *  DIALECT QUIRKS — one-line cheat sheet
 *  -------------------------------------
 *  | Feature           | SQLite          | PostgreSQL          | MySQL              | MSSQL                       |
 *  |-------------------|-----------------|---------------------|--------------------|-----------------------------|
 *  | Auto-increment    | AUTOINCREMENT   | SERIAL/BIGSERIAL    | AUTO_INCREMENT     | IDENTITY(seed, step)        |
 *  |                   |                 | GENERATED AS IDEN.  |                    |                             |
 *  | Identifier quote  | "x" or [x]      | "x"                 | `x`                | [x]                         |
 *  | Comment line      | --              | --                  | -- or # (mysqldump)| --                          |
 *  | String literal    | 'x' (`''` esc)  | 'x' (`''` esc)      | 'x' (`''`/`\'` esc)| 'x' or N'x' (Unicode lit)   |
 *  | Computed column   | GENERATED AS    | GENERATED AS        | GENERATED AS       | col AS (expr) [PERSISTED]   |
 *  |                   | (expr) STORED   | (expr) STORED       | (expr) [STORED|VIRT]|                            |
 *  | Inline ENUM       | n/a             | CREATE TYPE … AS ENUM | ENUM('a','b')    | n/a                         |
 *  | Inline SET        | n/a             | n/a                 | SET('a','b')       | n/a                         |
 *  | Schema-qualified  | bare            | schema.table        | db.table or db.tbl.col | schema.table or [s].[t] |
 *  | Trailing options  | WITHOUT ROWID,  | INHERITS, WITH,     | ENGINE=, CHARSET=, | ON [PRIMARY], TEXTIMAGE_ON, |
 *  |                   | STRICT          | TABLESPACE          | ROW_FORMAT=, …     | WITH (FILLFACTOR=…)         |
 *
 *  These are the *only* places the four pipelines diverge. Anywhere else
 *  the AST is identical — that's the point of this normalizer.
 *
 *  ARCHITECTURE
 *  ------------
 *  • Lexing is delegated to ./tokenize.js — `tokenize(sql, opts)` returns
 *    `{ tokens, errors }` where each token is `{ type, value, raw, start }`
 *    and `start = { line, col, idx }`.
 *  • Parsing is a hand-written recursive descent over `tokens` with a single
 *    integer cursor `idx`. Helpers `peek`, `next`, `expect`, `consumeIfKeyword`
 *    abstract token consumption. Paren-balanced sub-strings are extracted by
 *    `readParenContent` / `readParenContentRaw` for opaque expressions
 *    (CHECK, DEFAULT, computed-column expressions).
 *  • Statement boundary recovery is anchor-driven: on any unrecoverable error
 *    inside a CREATE TABLE / ALTER / CREATE TYPE we fast-forward to the next
 *    `;` or `CREATE` / `ALTER` / `DROP` keyword at depth 0 so a single bad
 *    statement never sinks the rest of the script.
 *  • Reserved-keyword identifiers (`KEY`, `INDEX`, `VALUE`, …) are
 *    disambiguated by the heuristic in `parseTableEntry`: if the token
 *    immediately following is a `DATA_TYPE_KEYWORDS` member or a column
 *    modifier, the keyword is treated as a column name; otherwise it is
 *    treated as a constraint/index keyword.
 *  • Errors and warnings are collected via `addError` / `addWarning` into a
 *    single ordered `parseErrors` list. Each entry carries
 *    `{ message, severity: 'error' | 'warning', position: { line, column,
 *    index }, token? }`. Tokenizer-level errors are normalized to the same
 *    shape so the UI never has to branch on origin.
 *
 *  RETURN SHAPE (frozen contract)
 *  ------------------------------
 *  parseAST(sql, { dialect?: 'auto'|'sqlite'|'postgres'|'mysql'|'mssql',
 *                  defaultSchema?: string|null }) → {
 *    errors:  ParseError[],     // mixed errors + warnings, ordered by source
 *                               //   index. Each entry has shape:
 *                               //     { message, severity: 'error'|'warning',
 *                               //       position: { line, column, index },
 *                               //       token? }
 *    ast: {
 *      types:  Array<{ kind: 'enum'|'composite', name, values?, fields? }>,
 *      tables: Array<{
 *        name,
 *        columns: Array<{
 *          name, type, notNull, unique, primary,
 *          default?, check?, references?,
 *          autoIncrement?, computed?,
 *          extras?: string[]
 *        }>,
 *        constraints: Array<{
 *          name?, kind: 'primary'|'unique'|'foreign'|'check', ...
 *        }>
 *      }>,
 *      alters: Array<AlterTableAddConstraint>,
 *      indexes: Array<{
 *        name: string|null,        // null for inline MySQL `KEY (...)`
 *        table: string,            // schema-qualified or bare
 *        columns: string[],        // projectable flat column names
 *        expressions: string[],    // preserved functional/expression entries
 *        unique: boolean,
 *        kind: 'plain'|'fulltext'|'spatial',
 *        position: { start, end }
 *      }>,
 *      drops: Array<{ kind: 'table'|'type'|'index', name, position }>,
 *    }
 *  }
 *
 *  INVARIANTS
 *  ----------
 *  • parseAST is pure: same `string` input → same output, no globals mutated.
 *  • parseAST never throws on a string input. Malformed SQL surfaces as
 *    entries in `errors`; the AST is best-effort partial.
 *  • Non-string input throws `TypeError('sql must be string')` from the
 *    underlying tokenizer — callers in the React layer guard with a string
 *    coercion / nullish check before invoking parseAST.
 *  • Empty / whitespace-only string input returns the canonical empty AST
 *    with no errors so live-typing in the editor doesn't flicker.
 *  • Identifiers preserve their original casing (option `lowercaseIdentifiers:
 *    false` is passed to the tokenizer).
 */
export function parseAST(sql, options = {}) {
    const { tokens, errors: tokenErrors } = tokenize(sql, { lowercaseIdentifiers: false, skipComments: true });
    const parseOptions = typeof options === 'string' ? { dialect: options } : options || {};
    const requestedDialect = normalizeSqlDialect(parseOptions.dialect || 'auto');
    const detectedDialect = requestedDialect === 'auto' ? detectSqlDialectProfile(sql) : null;
    const dialect = requestedDialect === 'auto' ? detectedDialect.profile.id : requestedDialect;
    const dialectProfile = getSqlDialectProfile(dialect);
    let idx = 0;
    const len = tokens.length;

    const ast = { types: [], tables: [], alters: [], indexes: [], drops: [] };
    // Normalize tokenizer errors to the same shape used by parseAst's addError
    // so downstream consumers (UI and validators) only need to read one
    // consistent `position: { line, column, index }` field — tokenizer emits
    // `start: { line, col, idx }`, which is preserved as a fallback.
    const parseErrors = tokenErrors.map((e) => {
        if (e && !e.position && e.start) {
            return {
                ...e,
                position: {
                    // `??` (not `||`) so a 1-based 1 / 0-based 0 stays as the
                    // real source location instead of being clobbered by the
                    // safety fallback. The previous `|| 1` also masked 0,
                    // which is the legitimate first-character offset.
                    line: e.start.line ?? 1,
                    column: e.start.col ?? 1,
                    index: e.start.idx ?? 0,
                },
            };
        }
        return e;
    });

    // Error reporting utilities
    function addError(message, token = null, severity = 'error') {
        const posToken = token || tokens[Math.min(idx, len - 1)] || tokens[Math.max(0, len - 1)] || null;
        const error = {
            message,
            severity,
            // `position.index` is a CHARACTER offset into the source SQL —
            // NOT a token index. Mixing the two confuses the editor's
            // jump-to-error logic (Monaco wants a char offset). The
            // posToken.start.idx field IS a char offset, so prefer it
            // and fall back to the LAST KNOWN char offset (not the token
            // counter). `??` everywhere so a legitimate 0 isn't masked.
            position: posToken
                ? {
                      line: posToken.start?.line ?? 1,
                      column: posToken.start?.col ?? 1,
                      index: posToken.start?.idx ?? lastCharIndex(),
                  }
                : {
                      line: 1,
                      column: 1,
                      index: lastCharIndex(),
                  },
            token: token
                ? {
                      type: token.type,
                      value: token.value,
                      raw: token.raw,
                  }
                : null,
        };
        parseErrors.push(error);
    }

    // Best-effort character-offset fallback for `addError` when no token
    // is around to anchor the error. We pick the END index of the most
    // recently consumed token; falling back to 0 if the input was empty.
    function lastCharIndex() {
        const ref = tokens[Math.min(idx, len - 1)] || tokens[Math.max(0, len - 1)] || null;
        if (!ref) return 0;
        return ref.end?.idx ?? ref.start?.idx ?? 0;
    }

    function addWarning(message, token = null) {
        addError(message, token, 'warning');
    }

    function attachHiddenMeta(target, key, value) {
        if (!target || value === undefined) return target;
        Object.defineProperty(target, key, {
            value,
            enumerable: false,
            configurable: true,
        });
        return target;
    }

    function peek(off = 0) {
        const targetIdx = idx + off;
        if (targetIdx < 0 || targetIdx >= tokens.length) return null;
        return tokens[targetIdx];
    }
    function next() {
        const t = peek();
        if (t) idx += 1;
        return t;
    }
    function expect(type, value = null) {
        const t = peek();
        if (!t) {
            // Use the last available token for position info
            const lastToken = tokens[Math.max(0, idx - 1)];
            addWarning(`Expected ${type}${value ? ` '${value}'` : ''} but reached end of input`, lastToken);
            return null;
        }
        if (t.type !== type) {
            addWarning(`Expected ${type}${value ? ` '${value}'` : ''} but got ${t.type} '${t.value}'`, t);
            return null;
        }
        if (value !== null && String(t.value).toUpperCase() !== String(value).toUpperCase()) {
            addWarning(`Expected '${value}' but got '${t.value}'`, t);
            return null;
        }
        return next();
    }

    function consumeIfKeyword(val) {
        const t = peek();
        if (t && t.type === 'KW' && String(t.value).toUpperCase() === String(val).toUpperCase()) return next();
        return null;
    }

    /**
     * Consume the current token only if it's an IDENT whose value (case-
     * insensitive) matches `val`. Used for non-keyword soft keywords such as
     * `CONCURRENTLY`, `INCLUDE`, `NULLS`, that the tokenizer keeps as IDENT.
     */
    function consumeIfIdent(val) {
        const t = peek();
        if (t && t.type === 'IDENT' && String(t.value).toUpperCase() === String(val).toUpperCase()) return next();
        return null;
    }

    function isKeywordAt(off, val) {
        const t = peek(off);
        return !!(t && t.type === 'KW' && String(t.value).toUpperCase() === String(val).toUpperCase());
    }

    function consumeCreateOrReplace() {
        if (isKeywordAt(0, 'OR') && isKeywordAt(1, 'REPLACE')) {
            next();
            next();
            return true;
        }
        return false;
    }

    // ════════════════════════════════════════════════════════════════════
    //  SECTION A — Token-stream cursor primitives
    // ════════════════════════════════════════════════════════════════════
    //  All higher-level parsers use these helpers to walk the token array.
    //  Mutating `idx` outside of `next()` / `expect()` is forbidden — those
    //  two are the only sanctioned cursor advancers so error positions stay
    //  consistent.
    //
    //   peek(off)           — look ahead, no advance. Returns null at EOF.
    //   next()              — consume + return the current token.
    //   expect(type, value?)— consume IF type/value match; otherwise emit a
    //                         warning and return null.
    //   consumeIfKeyword(v) — consume the current token only if it's the
    //                         given keyword. Used for optional clauses
    //                         (IF NOT EXISTS, AS, etc.).
    //   parseIdentifier()   — single ident, also accepts strings and
    //                         keyword-as-ident (the parseTableEntry
    //                         disambiguator decides if that's wise).
    //   parseQualifiedIdentifierInfo()
    //                       — handles `schema.table` and bare `table`.
    //                         The dotted form is preserved; downstream
    //                         (`stripSchema` in erdJsonSchema) collapses it.
    //   readParenContent / readParenContentRaw
    //                       — extract a paren-balanced substring as a
    //                         joined string. Used for opaque expressions
    //                         (CHECK / DEFAULT / generated-column).
    // ════════════════════════════════════════════════════════════════════

    function isQuotedIdentifierToken(token) {
        if (!token) return false;
        if (token.type === 'STRING') return true;
        if (token.type !== 'IDENT') return false;
        return typeof token.raw === 'string' && (token.raw.startsWith('"') || token.raw.startsWith('`') || token.raw.startsWith('['));
    }

    function parseIdentifierInfo() {
        const t = peek();
        if (!t) return null;
        if (t.type === 'IDENT' || t.type === 'STRING') {
            const tok = next();
            return {
                value: String(tok.value),
                raw: tok.raw,
                quoted: isQuotedIdentifierToken(tok),
            };
        }
        if (t.type === 'KW') {
            const tok = next();
            return {
                value: String(tok.raw || tok.value),
                raw: tok.raw,
                quoted: false,
            };
        }
        return null;
    }

    function parseIdentifier() {
        return parseIdentifierInfo()?.value || null;
    }

    function qualifiedIdentifierName(parts) {
        return parts.map((part) => part.value).join('.');
    }

    function parseQualifiedIdentifierInfo() {
        // Parse a dotted identifier of any depth: `name`, `schema.name`, or
        // `db.schema.name` (MSSQL three-part) — and even four-part
        // `server.db.schema.name`. Downstream `stripSchema` reduces it to
        // the leaf, but we MUST consume every segment here so the next
        // token in the stream is whatever followed the qualified name —
        // not a stray `.tail` that would derail subsequent parsing
        // (e.g. silently making `CREATE TABLE db.schema.t (id INT)` look
        // like garbage and dropping the entire CREATE).
        const first = parseIdentifierInfo();
        if (!first) return null;

        const parts = [first];
        while (peek() && peek().type === 'PUNC' && peek().value === '.') {
            next(); // consume dot
            const segment = parseIdentifierInfo();
            if (!segment) {
                // Malformed (`schema.`) — stop here; caller's recovery handles the rest.
                break;
            }
            parts.push(segment);
        }
        return { name: qualifiedIdentifierName(parts), parts };
    }

    function splitTopLevelCommaGroups(toks) {
        const groups = [[]];
        let depth = 0;
        for (const tok of toks || []) {
            if (tok.type === 'PUNC' && tok.value === '(') depth++;
            else if (tok.type === 'PUNC' && tok.value === ')') depth--;
            if (tok.type === 'PUNC' && tok.value === ',' && depth === 0) {
                groups.push([]);
                continue;
            }
            groups[groups.length - 1].push(tok);
        }
        return groups;
    }

    function identifierInfoFromTokenGroup(group) {
        if (!Array.isArray(group) || group.length === 0) return null;
        const parts = [];
        let i = 0;
        const readPart = (tok) => {
            if (!tok) return null;
            if (tok.type === 'IDENT' || tok.type === 'STRING') {
                return { value: String(tok.value), raw: tok.raw, quoted: isQuotedIdentifierToken(tok) };
            }
            if (tok.type === 'KW') return { value: String(tok.raw || tok.value), raw: tok.raw, quoted: false };
            return null;
        };

        const first = readPart(group[i]);
        if (!first) return null;
        parts.push(first);
        i++;

        while (group[i] && group[i].type === 'PUNC' && group[i].value === '.') {
            const nextPart = readPart(group[i + 1]);
            if (!nextPart) break;
            parts.push(nextPart);
            i += 2;
        }

        return { name: qualifiedIdentifierName(parts), parts };
    }

    function identifierNameFromTokenGroup(group) {
        return identifierInfoFromTokenGroup(group)?.name || null;
    }

    function extractIdentifierListFromTokens(toks) {
        const infos = splitTopLevelCommaGroups(toks)
            .map(identifierInfoFromTokenGroup)
            .filter(Boolean);
        const names = infos.map((info) => info.name);
        attachHiddenMeta(names, 'identifierParts', infos.map((info) => info.parts));
        return names;
    }

    function localIdentifierPartKey(part) {
        const value = String(part?.value ?? '');
        return dialect === 'postgres' && part?.quoted ? value : value.toLowerCase();
    }

    function columnMatchesIdentifier(column, name, parts = null) {
        const columnPart = column?.nameParts?.[0] || { value: column?.name, quoted: false };
        const requestedPart = parts?.[parts.length - 1] || { value: name, quoted: false };
        return localIdentifierPartKey(columnPart) === localIdentifierPartKey(requestedPart);
    }

    function extractExpressionEntriesFromTokens(toks) {
        return splitTopLevelCommaGroups(toks)
            .filter((group) => {
                if (group.length === 0) return false;
                if (group[0]?.type === 'PUNC' && group[0]?.value === '(') return true;
                if (group[1]?.type === 'PUNC' && group[1]?.value === '(') return true;
                return !identifierNameFromTokenGroup(group);
            })
            .map((group) => tokensToNaturalText(group).trim())
            .filter(Boolean);
    }

    function readParenTokensFromCursor(cursor) {
        const start = cursor.expect('PUNC', '(');
        if (!start) return null;
        let depth = 1;
        const out = [];
        while (cursor.peek()) {
            const current = cursor.peek();
            if (current.type === 'PUNC' && current.value === ';') break;
            if (current.type === 'KW') {
                const keyword = String(current.value).toUpperCase();
                if (keyword === 'CREATE' || keyword === 'ALTER' || keyword === 'GO') break;
            }
            const tok = cursor.next();
            if (tok.type === 'PUNC' && tok.value === '(') {
                depth++;
                out.push(tok);
                continue;
            }
            if (tok.type === 'PUNC' && tok.value === ')') {
                depth--;
                if (depth === 0) break;
                out.push(tok);
                continue;
            }
            out.push(tok);
        }
        return out;
    }

    function readIdentifierListFromCursor(cursor) {
        const toks = readParenTokensFromCursor(cursor);
        return toks ? extractIdentifierListFromTokens(toks) : null;
    }

    function readIdentifierList() {
        return readIdentifierListFromCursor({ expect, peek, next });
    }

    function normalizeReferenceAction(tokens) {
        return tokens.map((tok) => String(tok.raw || tok.value).toUpperCase()).join(' ');
    }

    function readReferenceAction(cursor) {
        const first = cursor.peek();
        if (!first || first.type === 'PUNC') return null;
        const actionTokens = [cursor.next()];
        const firstValue = String(first.value).toUpperCase();
        if ((firstValue === 'SET' || firstValue === 'NO') && cursor.peek() && cursor.peek().type !== 'PUNC') {
            actionTokens.push(cursor.next());
        }
        return normalizeReferenceAction(actionTokens);
    }

    function parseReferenceOptions(cursor, references) {
        if (!references) return references;
        while (cursor.peek() && cursor.peek().type === 'KW') {
            const kw = String(cursor.peek().value).toUpperCase();
            if (kw === 'MATCH') {
                cursor.next();
                if (cursor.peek() && cursor.peek().type !== 'PUNC') {
                    references.match = String(cursor.next().value).toUpperCase();
                }
                continue;
            }
            if (kw === 'ON') {
                cursor.next();
                const event = cursor.peek() && cursor.peek().type !== 'PUNC' ? String(cursor.next().value).toUpperCase() : null;
                const action = readReferenceAction(cursor);
                if (event === 'DELETE') references.onDelete = action;
                else if (event === 'UPDATE') references.onUpdate = action;
                continue;
            }
            if (kw === 'DEFERRABLE') {
                cursor.next();
                references.deferrable = true;
                continue;
            }
            if (kw === 'NOT' && cursor.peek(1) && cursor.peek(1).type === 'KW' && String(cursor.peek(1).value).toUpperCase() === 'DEFERRABLE') {
                cursor.next();
                cursor.next();
                references.deferrable = false;
                continue;
            }
            if (kw === 'INITIALLY') {
                cursor.next();
                if (cursor.peek() && cursor.peek().type !== 'PUNC') {
                    references.initially = String(cursor.next().value).toUpperCase();
                }
                continue;
            }
            break;
        }
        return references;
    }

    function readParenContent() {
        const start = expect('PUNC', '(');
        if (!start) return null;
        let depth = 1;
        const parts = [];
        while (peek()) {
            const t = peek();
            if (t.type === 'PUNC' && t.value === ';') break;
            if (t.type === 'KW' && String(t.value).toUpperCase() === 'CREATE') break;
            const tok = next();
            if (tok.type === 'PUNC' && tok.value === '(') {
                depth++;
                parts.push(tok.value);
                continue;
            }
            if (tok.type === 'PUNC' && tok.value === ')') {
                depth--;
                if (depth === 0) break;
                parts.push(tok.value);
                continue;
            }
            // STRING tokens carry the *unquoted* inner text on `value`; the
            // quoting lives only on `raw`. Joining via `value` quietly turns
            // `CHECK (x = 'ok')` into `x = ok` — silently corrupting the
            // expression text the renderer surfaces. Use `raw` for strings
            // so quotes (and any escape sequences) round-trip.
            if (tok.type === 'STRING') {
                parts.push(tok.raw);
                continue;
            }
            parts.push(tok.value);
        }
        return parts.join(' ');
    }

    function readParenContentRaw() {
        const start = expect('PUNC', '(');
        if (!start) return null;
        let depth = 1;
        const parts = [];
        while (peek()) {
            const t = peek();
            if (t.type === 'PUNC' && t.value === ';') break;
            if (t.type === 'KW' && String(t.value).toUpperCase() === 'CREATE') break;
            const tok = next();
            if (tok.type === 'PUNC' && tok.value === '(') {
                depth++;
                parts.push(tok.raw);
                continue;
            }
            if (tok.type === 'PUNC' && tok.value === ')') {
                depth--;
                if (depth === 0) break;
                parts.push(tok.raw);
                continue;
            }
            parts.push(tok.raw);
        }
        return parts.join('');
    }

    // Cache compiled regex patterns for better performance
    const SPACING_PATTERNS = {
        parenthesesOpen: /\s*\(\s*/g,
        parenthesesClose: /\s*\)/g,
        comma: /\s*,\s*/g,
        dot: /\s*\.\s*/g,
        operators: /\s*(>=|<=|<>|=|>|<|\+|\-|\*|\/)\s*/g,
        multipleSpaces: /\s+/g,
        arrayBracketsOpen: /\s*\[\s*/g,
        arrayBracketsClose: /\s*\]\s*/g,
    };

    // ════════════════════════════════════════════════════════════════════
    //  SECTION B — Expression text reconstruction helpers
    // ════════════════════════════════════════════════════════════════════
    //  When we extract a paren-balanced substring (CHECK, DEFAULT, computed
    //  column expression, …) the tokens have already been split by the
    //  lexer. Joining them with single spaces produces ugly text like
    //  "( a > - 1 )". `applyNaturalSpacing` re-collapses operator spacing
    //  to look like the user wrote it: `(a > -1)`.
    //
    //  Touchy areas (do NOT change without focused parser validation):
    //    • Unary `+` / `-` after `(`, `,`, `=` must stick to its operand.
    //    • Binary operators get one space on each side.
    //    • `::cast` should hug the value with no spaces.
    //    • Function calls `f ( x )` should collapse to `f(x)`.
    // ════════════════════════════════════════════════════════════════════

    /**
     * Re-collapse the loose-spaces output of "join tokens with spaces"
     * back to the user-friendly form a human would write. Keeps the
     * source intent recognisable in DEFAULT / CHECK / generated-column
     * expressions when the AST is rendered back into the ERD UI.
     *
     * @param   {string} text  Raw, space-separated reconstruction.
     * @returns {string}       Naturally-spaced expression.
     * @example
     *   applyNaturalSpacing('( a > - 1 )')        // → '(a > -1)'
     *   applyNaturalSpacing('lower ( email )')    // → 'lower(email)'
     *   applyNaturalSpacing('a + b * c')          // → 'a + b * c'
     *   applyNaturalSpacing('name :: text')       // → 'name::text'  (PG cast)
     */
    function applyNaturalSpacing(text) {
        const stringLiterals = [];
        const protectedText = String(text || '').replace(/'(?:''|\\'|[^'])*'|"(?:""|[^"])*"/g, (literal) => {
            const placeholder = `__SQL_LITERAL_${stringLiterals.length}__`;
            stringLiterals.push(literal);
            return placeholder;
        });
        // Apply natural spacing rules with cached regex patterns
        const spaced = protectedText
            .replace(SPACING_PATTERNS.parenthesesOpen, '(')
            .replace(SPACING_PATTERNS.parenthesesClose, ')')
            .replace(SPACING_PATTERNS.comma, ', ')
            .replace(SPACING_PATTERNS.dot, '.')
            .replace(SPACING_PATTERNS.operators, ' $1 ')
            .replace(SPACING_PATTERNS.arrayBracketsOpen, '[')
            .replace(SPACING_PATTERNS.arrayBracketsClose, ']')
            .replace(/\s*::\s*/g, '::')
            .replace(SPACING_PATTERNS.multipleSpaces, ' ')
            // Normalize unary minus/plus before a numeric literal: "- 1" → "-1"
            // Only when the sign appears at the very start of the value or
            // immediately after an opening paren / comma / '=' (no spaces in between),
            // so binary operators like "10 * 2 + 1" are NOT collapsed to "10 * 2 +1".
            .replace(/(^|[(,=])\s*([+\-])\s+(\d)/g, '$1$2$3')
            .trim();
        return spaced.replace(/__SQL_LITERAL_(\d+)__/g, (_match, index) => stringLiterals[Number(index)] || '');
    }

    function tokenText(tok) {
        return tok?.type === 'STRING' ? tok.raw : tok?.raw || tok?.value || '';
    }

    function tokensToNaturalText(toks) {
        return applyNaturalSpacing((toks || []).map(tokenText).join(' '))
            .replace(/(\[[^\]]+\])(?=[A-Za-z_])/g, '$1 ');
    }

    // Cache constraint keywords for performance
    const CONSTRAINT_KEYWORDS = new Set(['PRIMARY', 'UNIQUE', 'NOT', 'NULL', 'DEFAULT', 'CHECK', 'REFERENCES', 'CONSTRAINT', 'GENERATED', 'AUTO_INCREMENT', 'AUTOINCREMENT', 'IDENTITY', 'COMMENT', 'CHARSET', 'COLLATE', 'ON', 'FIRST', 'AFTER']);

    function tokenWordValue(token) {
        return token && (token.type === 'KW' || token.type === 'IDENT') ? String(token.value || token.raw || '').toUpperCase() : '';
    }

    function isCharacterSetOptionStart(token, nextToken = null) {
        const word = tokenWordValue(token);
        if (word === 'CHARSET') return true;
        return word === 'CHARACTER' && tokenWordValue(nextToken) === 'SET';
    }

    function isColumnTypeOptionStart(token, nextToken = null) {
        if (isCharacterSetOptionStart(token, nextToken)) return true;
        return token?.type === 'KW' && CONSTRAINT_KEYWORDS.has(String(token.value).toUpperCase());
    }

    // Inline ENUM pattern: ENUM('a', 'b', 'c')
    const INLINE_ENUM_REGEX = /^ENUM\s*\(\s*(.+)\s*\)$/i;
    // MySQL SET pattern: SET('a', 'b', 'c') — semantically a multi-value enum
    const INLINE_SET_REGEX = /^SET\s*\(\s*(.+)\s*\)$/i;
    const QUOTED_STRING_REGEX = /'(?:''|[^'])*'|"(?:""|[^"])*"/g;

    /**
     * Extract the literal values from a MySQL inline `ENUM(...)` type string.
     *
     * Returns the raw, unquoted string values in source order. Supports both
     * single- and double-quoted literals and handles SQL-standard `''`/`""`
     * doubling. Returns `null` (not an empty array) when the input doesn't
     * match the inline-ENUM shape so callers can branch cheaply.
     *
     * @param   {string|null|undefined} rawType  Raw column-type text such as
     *                                           `ENUM('admin','user')`. Whitespace
     *                                           and case-insensitive ENUM keyword
     *                                           are accepted.
     * @returns {string[]|null}                  Parsed values, or null when not
     *                                           an inline ENUM.
     * @example
     *   parseInlineEnum("ENUM('a','b','c')")   // → ['a','b','c']
     *   parseInlineEnum("VARCHAR(50)")          // → null
     */
    function parseInlineEnum(rawType) {
        const match = rawType?.match(INLINE_ENUM_REGEX);
        if (!match) return null;

        return Array.from(match[1].matchAll(QUOTED_STRING_REGEX) || []).map((m) => {
            const s = m[0];
            return s.slice(1, -1).replace(/''/g, "'").replace(/""/g, '"');
        });
    }

    /**
     * MySQL inline `SET('a','b','c')` parser. Same shape as `parseInlineEnum`
     * but for the multi-valued SET domain. We model SET as an enum-like type
     * for ERD purposes — at storage time MySQL stores comma-separated values,
     * but for badge / type-display the domain is what matters.
     *
     * @param   {string|null|undefined} rawType
     * @returns {string[]|null}                  Parsed values, or null.
     * @example
     *   parseInlineSet("SET('r','w','x')")     // → ['r','w','x']
     */
    function parseInlineSet(rawType) {
        const match = rawType?.match(INLINE_SET_REGEX);
        if (!match) return null;

        return Array.from(match[1].matchAll(QUOTED_STRING_REGEX) || []).map((m) => {
            const s = m[0];
            return s.slice(1, -1).replace(/''/g, "'").replace(/""/g, '"');
        });
    }

    /**
     * Register an inline-ENUM (or inline-SET) entry on `ast.types`. Idempotent —
     * calling it twice with the same column name and suffix is a no-op so
     * repeated CREATE TABLE re-declarations don't produce duplicate types.
     *
     * @param   {string}   columnName  The column the ENUM/SET is declared on.
     * @param   {string[]} values      The ENUM/SET values in declaration order.
     * @param   {string}   [suffix]    `_enum` (default) or `_set`. Distinguishes
     *                                 the two domains downstream.
     * @returns {string}               The synthetic type name (`<col><suffix>`),
     *                                 ready to be assigned to the column's
     *                                 `type` field as a stable reference.
     * @example
     *   registerInlineEnum('role', ['admin','user'])      // → 'role_enum'
     *   registerInlineEnum('perms', ['r','w'], '_set')    // → 'perms_set'
     */
    function sameInlineEnumValues(left, right) {
        return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, idx) => value === right[idx]);
    }

    function safeSyntheticNamePart(value) {
        return String(value || '')
            .replace(/[^A-Za-z0-9_$]+/g, '_')
            .replace(/^_+|_+$/g, '') || 'inline';
    }

    function registerInlineEnum(columnName, values, suffix = '_enum', tableName = null) {
        const enumName = `${columnName}${suffix}`;
        const existing = ast.types.find((t) => t.kind === 'enum' && t.name === enumName);
        if (!existing) {
            ast.types.push({ kind: 'enum', name: enumName, values, isInline: true });
            return enumName;
        }
        if (sameInlineEnumValues(existing.values, values)) return enumName;

        const tableLeaf = tableName ? tableName.substring(tableName.lastIndexOf('.') + 1) : null;
        const base = `${safeSyntheticNamePart(tableLeaf)}_${safeSyntheticNamePart(columnName)}${suffix}`;
        let candidate = base;
        let counter = 2;
        while (ast.types.some((t) => t.kind === 'enum' && t.name === candidate && !sameInlineEnumValues(t.values, values))) {
            candidate = `${base}_${counter++}`;
        }
        if (!ast.types.some((t) => t.kind === 'enum' && t.name === candidate)) {
            ast.types.push({ kind: 'enum', name: candidate, values, isInline: true });
        }
        return candidate;
    }

    // ════════════════════════════════════════════════════════════════════
    //  SECTION C — CREATE TYPE parser (PostgreSQL / MySQL ENUM-style)
    // ════════════════════════════════════════════════════════════════════
    //  Handles two shapes:
    //    CREATE TYPE [schema.]name AS ENUM ('v1', 'v2', …);
    //    CREATE TYPE [schema.]name AS (field1 TYPE, field2 TYPE, …);
    //
    //  Output AST entry:
    //    { kind: 'enum',      name, values: string[] }
    //    { kind: 'composite', name, fields: [{ name, type }, …] }
    //
    //  Schema prefixes are preserved on the AST `name` and stripped later
    //  in `erdJsonSchema.js`. We don't strip here so error messages can
    //  point at the user's original text.
    // ════════════════════════════════════════════════════════════════════

    function parseCreateType(createToken = null) {
        // we are after CREATE TYPE
        if (!consumeIfKeyword('TYPE')) {
            addWarning("Expected 'TYPE' after 'CREATE'", peek());
            return;
        }
        const nameInfo = parseQualifiedIdentifierInfo();
        const name = nameInfo?.name || null;
        if (!name) {
            addWarning("Expected type name after 'CREATE TYPE'", peek());
            return;
        }
        if (!consumeIfKeyword('AS')) {
            addWarning("Expected 'AS' after type name", peek());
            return;
        }
        const after = peek();
        if (after && after.type === 'KW' && String(after.value).toUpperCase() === 'ENUM') {
            // enum
            next(); // consume ENUM
            const valsRaw = readParenContentRaw();
            if (!valsRaw) {
                addWarning("Expected '(' after ENUM", peek());
                return;
            }

            // Extract quoted strings from the raw content
            const values = Array.from(valsRaw.matchAll(/'(?:''|[^'])*'|"(?:""|[^"])*"/g) || []).map((m) => {
                const s = m[0];
                // strip quotes
                if ((s[0] === "'" && s[s.length - 1] === "'") || (s[0] === '"' && s[s.length - 1] === '"')) return s.slice(1, -1).replace(/''/g, "'").replace(/\"\"/g, '"');
                return s;
            });
            const enumType = attachHiddenMeta({ kind: 'enum', name, values }, 'nameParts', nameInfo.parts);
            attachHiddenMeta(enumType, 'position', { start: createToken?.start || null, end: peek(-1)?.end || null });
            ast.types.push(enumType);
            return;
        }
        if (after && after.type === 'PUNC' && after.value === '(') {
            // composite type
            const fieldsRaw = readParenContent();
            if (fieldsRaw === null) {
                addWarning("Expected '(' for composite type definition", peek());
                return;
            }

            if (!fieldsRaw || fieldsRaw.trim() === '') {
                // Empty composite type
                const compositeType = attachHiddenMeta({ kind: 'composite', name, fields: [] }, 'nameParts', nameInfo.parts);
                attachHiddenMeta(compositeType, 'position', { start: createToken?.start || null, end: peek(-1)?.end || null });
                ast.types.push(compositeType);
                return;
            }

            // Split by commas at top-level - we will split by commas not inside parentheses
            const fields = [];
            let buf = '';
            let depth = 0;
            for (let i = 0; i < fieldsRaw.length; i++) {
                const ch = fieldsRaw[i];
                if (ch === '(') {
                    depth++;
                    buf += ch;
                    continue;
                }
                if (ch === ')') {
                    depth--;
                    buf += ch;
                    continue;
                }
                if (ch === ',' && depth === 0) {
                    if (buf.trim()) fields.push(buf.trim());
                    buf = '';
                    continue;
                }
                buf += ch;
            }
            if (buf.trim()) fields.push(buf.trim());

            const parsed = fields
                .map((f) => {
                    const field = f.trim();
                    if (!field) return null;

                    // Match field name (identifier) followed by whitespace and type
                    const m = field.match(/^([a-zA-Z_][\w$_]*|"[^"]*")\s+(.+)$/);
                    if (!m) return null;

                    let fieldName = m[1].replace(/^["`\[\]]+|["`\[\]]+$/g, '');
                    let fieldType = applyNaturalSpacing(m[2].trim());
                    return { name: fieldName, type: fieldType };
                })
                .filter(Boolean);

            const compositeType = attachHiddenMeta({ kind: 'composite', name, fields: parsed }, 'nameParts', nameInfo.parts);
            attachHiddenMeta(compositeType, 'position', { start: createToken?.start || null, end: peek(-1)?.end || null });
            ast.types.push(compositeType);
            return;
        }
        // unknown form - invalid type definition
        addWarning(`Invalid type definition. Expected 'ENUM' or composite type '(' after 'AS'`, peek());
        // skip to semicolon
        while (peek() && !(peek().type === 'PUNC' && peek().value === ';')) next();
    }

    // ════════════════════════════════════════════════════════════════════
    //  SECTION D — Table-level constraint parsers (PK / UQ / FK / CHECK)
    // ════════════════════════════════════════════════════════════════════
    //  Used by both inline (`CREATE TABLE … , CONSTRAINT …`) and
    //  ALTER (`ALTER TABLE … ADD CONSTRAINT …`) flows. Operates on a
    //  "temp parser" cursor over a sliced token list — keeps the main
    //  parser's `idx` independent.
    //
    //  Output shape (uniform across kinds):
    //    {
    //      name?:        string,
    //      kind:         'primary' | 'unique' | 'foreign' | 'check',
    //      columns?:     string[],         // for PK / UQ / FK
    //      references?:  { table, columns, onDelete?, onUpdate?, … },
    //      expression?:  string,           // for CHECK
    //    }
    // ════════════════════════════════════════════════════════════════════

    /**
     * Parse one PK / UQ / FK constraint expression starting at `tmp`'s
     * cursor. Used in two places that look syntactically identical:
     *
     *   • inline in CREATE TABLE — `tmp` wraps a comma-separated entry.
     *   • inline in ALTER TABLE  — `tmp` wraps the tokens after `ADD`.
     *
     * The function consumes only as much of `tmp` as the constraint
     * occupies; the caller is responsible for advancing past anything
     * that follows.
     *
     * @param   {ReturnType<typeof makeTempParser>} tmp  Sub-parser cursor.
     * @returns {object|null}                            AST node:
     *   { name?: string,
     *     kind: 'primary'|'unique'|'foreign',
     *     columns: string[],
     *     references?: { table, columns },
     *     _token: Token  // for error positioning
     *   }
     *   Returns null when the entry isn't a PK / UQ / FK (callers fall
     *   through to other entry kinds — CHECK, column definition, …).
     *
     * @example
     *   // CONSTRAINT pk_users PRIMARY KEY (id)
     *   //   → { name: 'pk_users', kind: 'primary', columns: ['id'] }
     *   //
     *   // FOREIGN KEY (user_id) REFERENCES users(id)
     *   //   → { name: null, kind: 'foreign', columns: ['user_id'],
     *   //       references: { table: 'users', columns: ['id'] } }
     */
    function parseConstraintWithTempParser(tmp) {
        // Parse table-level constraints using temp parser
        let name = null;

        // Check if starts with CONSTRAINT keyword
        const first = tmp.peek();
        const constraintToken = first; // Store the first token for position info
        if (first && first.type === 'KW' && String(first.value).toUpperCase() === 'CONSTRAINT') {
            tmp.next(); // consume CONSTRAINT
            name = tmp.parseIdentifier();
        }

        const t = tmp.peek();
        if (!t || t.type !== 'KW') return null;

        const k = String(t.value).toUpperCase();
        if (k === 'PRIMARY') {
            tmp.next(); // consume PRIMARY
            if (tmp.peek() && tmp.peek().type === 'KW' && String(tmp.peek().value).toUpperCase() === 'KEY') {
                tmp.next(); // consume KEY
            }
            // MSSQL: skip CLUSTERED / NONCLUSTERED
            tmp.consumeIfKeyword('CLUSTERED');
            tmp.consumeIfKeyword('NONCLUSTERED');
            // Skip optional index name (MySQL/MSSQL: PRIMARY KEY pk_name (...))
            if (tmp.peek() && tmp.peek().type === 'IDENT') tmp.next();
            const cols = readIdentifierListFromCursor(tmp);
            if (!cols || cols.length === 0) {
                addError(`PRIMARY KEY constraint missing column list`, constraintToken);
                return null;
            }
            if (cols.every((col) => !col)) {
                addError(`PRIMARY KEY constraint has empty column list`, constraintToken);
                return null;
            }
            return { name, kind: 'primary', columns: cols, _token: constraintToken };
        }

        if (k === 'UNIQUE') {
            tmp.next(); // consume UNIQUE
            let nullsNotDistinct = null;
            // PostgreSQL 15+: UNIQUE NULLS [NOT] DISTINCT (...)
            if (tmp.consumeIfKeyword('NULLS')) {
                const hasNot = tmp.consumeIfKeyword('NOT');
                if (tmp.consumeIfKeyword('DISTINCT')) nullsNotDistinct = hasNot;
            }
            // MySQL: UNIQUE KEY / UNIQUE INDEX
            tmp.consumeIfKeyword('KEY') || tmp.consumeIfKeyword('INDEX');
            // MSSQL: skip CLUSTERED / NONCLUSTERED
            tmp.consumeIfKeyword('CLUSTERED');
            tmp.consumeIfKeyword('NONCLUSTERED');
            // Preserve optional index name (MySQL: UNIQUE KEY idx_name (...))
            if (tmp.peek() && !(tmp.peek().type === 'PUNC' && tmp.peek().value === '(')) {
                const inlineName = tmp.parseIdentifier();
                if (!name && inlineName) name = inlineName;
            }
            const uniqueTokens = readParenTokensFromCursor(tmp);
            const cols = uniqueTokens ? extractIdentifierListFromTokens(uniqueTokens) : null;
            const expressions = uniqueTokens ? extractExpressionEntriesFromTokens(uniqueTokens) : [];
            if (!cols || cols.length === 0) {
                if (expressions.length > 0) {
                    addWarning('Expression-based UNIQUE index is preserved but cannot be projected as a column UNIQUE badge.', constraintToken);
                    return { name, kind: 'unique_expression', columns: [], expressions, nullsNotDistinct, _token: constraintToken };
                }
                addError(`UNIQUE constraint missing column list`, constraintToken);
                return null;
            }
            if (cols.every((col) => !col)) {
                addError(`UNIQUE constraint has empty column list`, constraintToken);
                return null;
            }
            return { name, kind: 'unique', columns: cols, nullsNotDistinct, _token: constraintToken };
        }

        if (k === 'FOREIGN') {
            tmp.next(); // consume FOREIGN
            if (tmp.peek() && tmp.peek().type === 'KW' && String(tmp.peek().value).toUpperCase() === 'KEY') {
                tmp.next(); // consume KEY
            }
            const cols = readIdentifierListFromCursor(tmp);
            if (!cols || cols.length === 0) {
                addError(`FOREIGN KEY constraint missing column list`, constraintToken);
                return null;
            }
            if (cols.every((col) => !col)) {
                addError(`FOREIGN KEY constraint has empty column list`, constraintToken);
                return null;
            }

            // Expect REFERENCES
            if (!tmp.peek() || tmp.peek().type !== 'KW' || String(tmp.peek().value).toUpperCase() !== 'REFERENCES') {
                addError(`FOREIGN KEY constraint missing REFERENCES clause`, constraintToken);
                return null;
            }
            tmp.next(); // consume REFERENCES

            const refTableInfo = tmp.parseQualifiedIdentifierInfo();
            const refTable = refTableInfo?.name || null;
            if (!refTable) {
                addError(`FOREIGN KEY constraint missing referenced table name`, constraintToken);
                return null;
            }

            let refCols = [];
            if (tmp.peek() && tmp.peek().type === 'PUNC' && tmp.peek().value === '(') {
                refCols = readIdentifierListFromCursor(tmp) || [];
            }
            const references = attachHiddenMeta({ table: refTable, columns: refCols }, 'tableParts', refTableInfo.parts);
            parseReferenceOptions(tmp, references);
            return { name, kind: 'foreign', columns: cols, references, _token: constraintToken };
        }

        return null;
    }

    // ════════════════════════════════════════════════════════════════════
    //  SECTION E — CREATE TABLE parser (the heart of the parser)
    // ════════════════════════════════════════════════════════════════════
    //  Splits the comma-separated entries inside `CREATE TABLE name (...)`
    //  at depth 0, then routes each entry to `parseTableEntry` which
    //  classifies it as a column or a constraint. Trailing options after
    //  the closing paren (ENGINE=, CHARSET=, INHERITS, WITH OIDS,
    //  ROW_FORMAT, etc.) are consumed as best-effort token-soup until the
    //  statement-terminating `;` or the next CREATE/ALTER/DROP keyword.
    //
    //  Statement-boundary recovery: if any entry can't be parsed, this
    //  function emits an `error`-severity entry via `addError` and skips
    //  to the next comma at depth 0. If the entire statement is broken
    //  (e.g. unclosed paren), the main loop's recovery anchor takes over.
    // ════════════════════════════════════════════════════════════════════

    function parseCreateTable(createToken = null) {
        // Use the passed CREATE token or try to find it
        const tableStartPos = createToken ? createToken.start : null;

        // Optional table modifiers (PostgreSQL / MSSQL):
        //   CREATE [GLOBAL|LOCAL] [TEMP|TEMPORARY] TABLE
        //   CREATE UNLOGGED TABLE
        // These are silently consumed for ERD purposes.
        consumeIfKeyword('GLOBAL') || consumeIfKeyword('LOCAL');
        consumeIfKeyword('TEMPORARY') || consumeIfKeyword('TEMP') || consumeIfKeyword('UNLOGGED');

        if (!consumeIfKeyword('TABLE')) {
            addWarning("Expected 'TABLE' after 'CREATE'", peek());
            return;
        }

        // optional IF NOT EXISTS
        if (consumeIfKeyword('IF')) {
            consumeIfKeyword('NOT');
            consumeIfKeyword('EXISTS');
        }

        // optional ONLY
        consumeIfKeyword('ONLY');
        const tableNameInfo = parseQualifiedIdentifierInfo();
        const tableName = tableNameInfo?.name || null;
        if (!tableName) {
            addWarning("Expected table name after 'CREATE TABLE'", peek());
            return;
        }
        const tableContext = { tableName, tableNameParts: tableNameInfo.parts };
        // expect (
        if (!peek()) {
            // Use the last available token for position info
            const lastToken = tokens[Math.max(0, idx - 1)];
            addWarning("Expected '(' after table name but reached end of input", lastToken);
            return;
        }
        if (!(peek().type === 'PUNC' && peek().value === '(')) {
            addWarning("Expected '(' after table name", peek());
            // skip until semicolon
            while (peek() && !(peek().type === 'PUNC' && peek().value === ';')) next();
            return;
        }

        // consume '('
        next();
        const columns = [];
        const tableConstraints = [];
        // Inline MySQL `INDEX/KEY/FULLTEXT/SPATIAL (col)` entries — collected
        // here, then pushed onto `ast.indexes` once the table name is known.
        const inlineIndexes = [];

        // parse until matching )
        let depth = 1;
        // We'll parse entries separated by top-level commas
        let entryTokens = [];
        let lastWasComma = false; // Track comma state for validation
        let unclosedBodyReported = false;

        while (peek()) {
            const t = peek();

            // Error recovery: `;` or `CREATE` inside table body means unbalanced parens
            if (t.type === 'PUNC' && t.value === ';' && depth > 0) {
                addError(`Unclosed parenthesis in table '${tableName}'. Found ';' while still inside parenthesized expression (depth ${depth}). Check for missing ')'.`, t);
                unclosedBodyReported = true;
                break;
            }
            if (t.type === 'KW' && String(t.value).toUpperCase() === 'CREATE' && depth > 0) {
                addError(`Unclosed parenthesis in table '${tableName}'. Found new 'CREATE' statement while still inside parenthesized expression (depth ${depth}). Check for missing ')'.`, t);
                unclosedBodyReported = true;
                break;
            }

            if (t.type === 'PUNC' && t.value === '(') {
                depth++;
                entryTokens.push(next());
                continue;
            }
            if (t.type === 'PUNC' && t.value === ')') {
                depth--;
                if (depth === 0) {
                    // Check for trailing comma before closing parenthesis
                    if (lastWasComma && entryTokens.length === 0) {
                        addError("Unexpected trailing comma before closing parenthesis. Remove the comma before ')'.", t);
                    }
                    next();
                    break;
                }
                entryTokens.push(next());
                lastWasComma = false;
                continue;
            }
            // split entries by top-level comma
            if (t.type === 'PUNC' && t.value === ',' && depth === 1) {
                // Check for empty entry (double comma or leading comma)
                if (entryTokens.length === 0) {
                    addError('Unexpected comma. Missing column or constraint definition before comma.', t);
                    next(); // consume comma
                    lastWasComma = true;
                    continue;
                }

                // parse entryTokens
                const entryAst = parseTableEntry(entryTokens, tableContext);
                if (entryAst) {
                    if (entryAst.type === 'column' && entryAst.value) columns.push(entryAst.value);
                    else if (entryAst.type === 'constraint') tableConstraints.push(entryAst.value);
                    else if (entryAst.type === 'index' && entryAst.value) inlineIndexes.push(entryAst.value);
                }
                entryTokens = [];
                next(); // consume comma
                lastWasComma = true;

                // Check for consecutive comma (double comma)
                if (peek() && peek().type === 'PUNC' && peek().value === ',') {
                    addError("Unexpected double comma ',,'. Missing column or constraint definition between commas.", peek());
                    next(); // consume the second comma to avoid redundant error
                    continue;
                }
                continue;
            }
            entryTokens.push(next());
            lastWasComma = false; // Reset comma flag when we add content
        }

        if (depth > 0 && !unclosedBodyReported) {
            const lastToken = tokens[Math.max(0, idx - 1)] || createToken;
            addError(`Unclosed parenthesis in table '${tableName}'. Reached end of input while still inside parenthesized expression (depth ${depth}). Check for missing ')'.`, lastToken);
        }

        // Check if we have table-level CHECK constraints after all column definitions
        // Parse any remaining CHECK constraints at table level
        while (peek() && peek().type === 'KW' && String(peek().value).toUpperCase() === 'CHECK') {
            next(); // consume CHECK
            const checkExpr = readParenContent();
            if (checkExpr) {
                tableConstraints.push({ name: null, kind: 'check', expression: checkExpr.trim() });
            }
            // consume optional comma
            if (peek() && peek().type === 'PUNC' && peek().value === ',') {
                next();
            }
        }
        // final entryTokens if any
        if (entryTokens.length > 0) {
            const entryAst = parseTableEntry(entryTokens, tableContext);
            if (entryAst) {
                if (entryAst.type === 'column' && entryAst.value) columns.push(entryAst.value);
                else if (entryAst.type === 'constraint') tableConstraints.push(entryAst.value);
                else if (entryAst.type === 'index' && entryAst.value) inlineIndexes.push(entryAst.value);
            }
        }

        // Validate table has content. PostgreSQL allows the body to be empty
        // when a table inherits from one or more parents (`INHERITS (...)`), so
        // peek ahead and treat that case as legal — we just register the table
        // with no own columns and let the trailing-options loop consume the
        // INHERITS clause below.
        if (columns.length === 0 && tableConstraints.length === 0) {
            const nextTok = peek();
            const inheritsAhead = nextTok && nextTok.type === 'KW' && String(nextTok.value).toUpperCase() === 'INHERITS';
            const permitsEmptyTable = dialect === 'postgres';
            if (!inheritsAhead && !permitsEmptyTable) {
                addError(`Table '${tableName}' has no columns or constraints defined`, peek());
                return;
            }
            // Otherwise: register as an inherited-only table (still has zero own columns).
        }

        const tableOptions = {
            strict: false,
            withoutRowid: false,
        };

        // Skip trailing dialect-specific table options up to ';' (or EOF / next statement):
        //   PostgreSQL: INHERITS (parent), WITH (storage_options), TABLESPACE name
        //   MySQL:      ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=... COMMENT '...' ROW_FORMAT=...
        //   MSSQL:      ON [PRIMARY], WITH (FILLFACTOR=80), TEXTIMAGE_ON ...
        // We don't model any of these in the ERD, but they must be consumed so the parser
        // doesn't trip over them or misinterpret them as the next statement.
        while (peek()) {
            const tok = peek();
            if (tok.type === 'PUNC' && tok.value === ';') break;
            if (tok.type === 'KW') {
                const upTok = String(tok.value).toUpperCase();
                if (upTok === 'CREATE' || upTok === 'ALTER' || upTok === 'GO') break;
                // SQLite: WITHOUT ROWID — consume the two-keyword modifier.
                if (upTok === 'WITHOUT') {
                    next(); // consume WITHOUT
                    if (consumeIfKeyword('ROWID')) tableOptions.withoutRowid = true;
                    continue;
                }
                // SQLite: STRICT table option — consume silently.
                if (upTok === 'STRICT') {
                    next(); // consume STRICT
                    tableOptions.strict = true;
                    // Consume optional comma separator (e.g. `) STRICT, WITHOUT ROWID;`)
                    if (peek() && peek().type === 'PUNC' && peek().value === ',') next();
                    continue;
                }
            }
            // Consume parenthesized groups in one shot so unmatched parens don't trip us up.
            if (tok.type === 'PUNC' && tok.value === '(') {
                let depth = 0;
                while (peek()) {
                    const x = peek();
                    if (x.type === 'PUNC' && x.value === '(') {
                        depth++;
                        next();
                        continue;
                    }
                    if (x.type === 'PUNC' && x.value === ')') {
                        depth--;
                        next();
                        if (depth === 0) break;
                        continue;
                    }
                    next();
                }
                continue;
            }
            next();
        }

        // Capture table end position
        let tableEndPos = null;
        if (peek() && peek().type === 'PUNC' && peek().value === ';') {
            const semicolonToken = next();
            tableEndPos = semicolonToken.end;
        } else {
            // If no semicolon, use the position right after the last parsed token
            const lastToken = peek(-1);
            tableEndPos = lastToken ? lastToken.end : null;
        }

        // Validate constraints and update column flags
        // This ensures backward compatibility while also setting column.primary = true
        tableConstraints.forEach((constraint, idx) => {
            if (!constraint) return;

            if (constraint.columns) {
                // Validate that referenced columns exist
                constraint.columns.forEach((colName, columnIndex) => {
                    const requestedParts = constraint.columns.identifierParts?.[columnIndex] || null;
                    const column = columns.find((col) => columnMatchesIdentifier(col, colName, requestedParts));
                    if (!column) {
                        addError(`Constraint references undefined column '${colName}'. Available columns: ${columns.map((c) => c.name).join(', ')}`, constraint._token, 'error');
                        // Mark constraint as invalid
                        tableConstraints[idx] = null;
                        return;
                    }

                    // Set column flags based on constraint type
                    if (constraint.kind === 'primary') {
                        column.primary = true;
                    } else if (constraint.kind === 'unique') {
                        column.unique = true;
                    }
                });
            }
        });

        if (dialect === 'sqlite') {
            const strictTypes = new Set(['INT', 'INTEGER', 'REAL', 'TEXT', 'BLOB', 'ANY']);
            if (tableOptions.strict) {
                columns.forEach((column) => {
                    const declaredType = String(column.type || '').trim().toUpperCase();
                    if (column.declaredTypeMissing) {
                        addError(`STRICT SQLite table '${tableName}' requires a declared type for column '${column.name}'.`, column._token);
                    } else if (!strictTypes.has(declaredType)) {
                        addError(`STRICT SQLite table '${tableName}' does not allow declared type '${column.type}' on column '${column.name}'. Use INT, INTEGER, REAL, TEXT, BLOB, or ANY.`, column._token);
                    }
                });
            }

            const primaryColumns = columns.filter((column) => column.primary);
            if (tableOptions.withoutRowid && primaryColumns.length === 0) {
                addError(`SQLite WITHOUT ROWID table '${tableName}' requires a PRIMARY KEY.`, createToken);
            }
            columns.filter((column) => column.autoIncrement).forEach((column) => {
                if (String(column.type || '').toUpperCase() !== 'INTEGER' || !column.primary) {
                    addError(`SQLite AUTOINCREMENT column '${column.name}' must be an exact INTEGER PRIMARY KEY.`, column._token);
                }
                if (tableOptions.withoutRowid) {
                    addError(`SQLite AUTOINCREMENT is not allowed on WITHOUT ROWID table '${tableName}'.`, column._token);
                }
            });
        }

        // Add position information to the table
        const tableWithPosition = {
            name: tableName,
            columns,
            constraints: tableConstraints,
            position: {
                start: tableStartPos,
                end: tableEndPos,
            },
        };
        attachHiddenMeta(tableWithPosition, 'nameParts', tableNameInfo.parts);
        attachHiddenMeta(tableWithPosition, 'options', tableOptions);

        ast.tables.push(tableWithPosition);

        // Promote inline MySQL `INDEX/KEY/FULLTEXT/SPATIAL (col)` entries to
        // top-level `ast.indexes` so they share the same downstream pipeline
        // as `CREATE INDEX` statements (badge generation in erdJsonSchema).
        if (inlineIndexes.length > 0) {
            inlineIndexes.forEach((ix) => {
                ast.indexes.push(
                    attachHiddenMeta(
                        {
                            name: ix.name || null,
                            table: tableName,
                            columns: ix.columns || [],
                            expressions: ix.expressions || [],
                            unique: !!ix.unique,
                            kind: ix.kind || 'plain',
                            position: { start: tableStartPos, end: tableEndPos },
                        },
                        'tableParts',
                        tableNameInfo.parts,
                    ),
                );
            });
        }
    }

    /**
     * Parse one comma-separated entry from inside `CREATE TABLE (...)`.
     *
     * Each entry is one of:
     *   • a column definition (e.g. `id INT PRIMARY KEY`)
     *   • a table-level CHECK         (`CHECK (expr)`)
     *   • a named CONSTRAINT          (`CONSTRAINT pk PRIMARY KEY (a, b)`)
     *   • a bare PRIMARY/UNIQUE/FOREIGN constraint
     *   • a MySQL bare KEY/INDEX/FULLTEXT/SPATIAL index definition (captured
     *     as `{ type: 'index', value }` and promoted to ast.indexes by the
     *     caller — used by the IDX-badge renderer)
     *   • a PostgreSQL `LIKE source_table` clone clause (skipped)
     *   • a PostgreSQL `EXCLUDE` exclusion constraint (skipped)
     *
     * @param   {Token[]} entryTokens  The tokens for this single entry,
     *                                 already split at the top-level
     *                                 comma by `parseCreateTable`.
     * @returns {{ type: 'column'|'constraint'|'index', value: object } | null}
     *                                 Null when the entry is a deliberate
     *                                 skip (LIKE / EXCLUDE / unrecognised
     *                                 clause) or unparseable (`addError`
     *                                 will already have recorded the
     *                                 diagnostic).
     *
     * @example
     *   parseTableEntry([id, INT, PRIMARY, KEY])
     *     → { type: 'column',
     *         value: { name: 'id', type: 'INT', primary: true, … } }
     *
     *   parseTableEntry([CONSTRAINT, fk_post, FOREIGN, KEY, '(', user_id, ')',
     *                    REFERENCES, users, '(', id, ')'])
     *     → { type: 'constraint',
     *         value: { name: 'fk_post', kind: 'foreign',
     *                  columns: ['user_id'],
     *                  references: { table: 'users', columns: ['id'] } } }
     *
     *   parseTableEntry([KEY, ix_email, '(', email, ')'])
     *     → { type: 'index',
     *         value: { name: null, columns: ['email'], unique: false,
     *                  kind: 'plain' } }
     */
    function parseTableEntry(entryTokens, context = {}) {
        if (!entryTokens || entryTokens.length === 0) return null;
        const first = entryTokens[0];
        const firstWord = tokenWordValue(first);

        // SQL Server temporal-table metadata. PERIOD is a table element, not
        // a column; treating it as a column invents a bogus ERD field.
        if (firstWord === 'PERIOD') {
            const tmp = makeTempParser(entryTokens, context);
            tmp.next(); // PERIOD
            tmp.consumeIfKeyword('FOR');
            tmp.consumeIfKeyword('SYSTEM_TIME');
            const periodColumns = readIdentifierListFromCursor(tmp) || [];
            if (periodColumns.length !== 2) {
                addError('PERIOD FOR SYSTEM_TIME requires exactly two columns', first);
            }
            return {
                type: 'constraint',
                value: { name: null, kind: 'period', columns: periodColumns, _token: first },
            };
        }

        // Check for table-level CHECK constraint first
        if (first.type === 'KW' && String(first.value).toUpperCase() === 'CHECK') {
            // This is a table-level CHECK constraint
            const tmp = makeTempParser(entryTokens, context);
            tmp.next(); // consume CHECK
            const checkExpr = tmp.readParenContentSpaced();
            return { type: 'constraint', value: { name: null, kind: 'check', expression: checkExpr ? checkExpr.trim() : null } };
        }

        if (first.type === 'KW' && String(first.value).toUpperCase() === 'CONSTRAINT') {
            const tmp = makeTempParser(entryTokens, context);
            tmp.next(); // consume CONSTRAINT
            const nmInfo = tmp.parseIdentifierInfo();
            const nm = nmInfo?.value || null;
            const after = tmp.peek();
            if (!after) return null;
            if (after.type === 'KW') {
                const k = String(after.value).toUpperCase();
                if (k === 'PRIMARY' || k === 'UNIQUE' || k === 'FOREIGN') {
                    const parsed = parseConstraintWithTempParser(tmp);
                    if (parsed) {
                        parsed.name = nm;
                        attachHiddenMeta(parsed, 'nameParts', nmInfo ? [nmInfo] : []);
                    }
                    return { type: 'constraint', value: parsed };
                }
                if (k === 'CHECK') {
                    tmp.next(); // consume CHECK
                    const checkExpr = tmp.readParenContentSpaced();
                    const constraint = { name: nm, kind: 'check', expression: checkExpr ? checkExpr.trim() : null };
                    attachHiddenMeta(constraint, 'nameParts', nmInfo ? [nmInfo] : []);
                    return { type: 'constraint', value: constraint };
                }
                if (k === 'DEFAULT') {
                    tmp.next(); // consume DEFAULT
                    const expressionTokens = [];
                    let depth = 0;
                    while (tmp.peek()) {
                        const token = tmp.peek();
                        const word = tokenWordValue(token);
                        if (depth === 0 && word === 'FOR') break;
                        const consumed = tmp.next();
                        if (consumed.type === 'PUNC' && consumed.value === '(') depth++;
                        else if (consumed.type === 'PUNC' && consumed.value === ')') depth--;
                        expressionTokens.push(consumed);
                    }
                    tmp.consumeIfKeyword('FOR');
                    const column = tmp.parseIdentifier();
                    if (!column) addError(`DEFAULT constraint '${nm}' is missing its FOR column`, first);
                    const constraint = {
                        name: nm,
                        kind: 'default',
                        column,
                        expression: tokensToNaturalText(expressionTokens),
                        _token: first,
                    };
                    attachHiddenMeta(constraint, 'nameParts', nmInfo ? [nmInfo] : []);
                    return {
                        type: 'constraint',
                        value: constraint,
                    };
                }
            }
            return null;
        }
        // if starts with PRIMARY/UNIQUE/FOREIGN directly
        if (first.type === 'KW' && ['PRIMARY', 'UNIQUE', 'FOREIGN'].includes(String(first.value).toUpperCase())) {
            const tmp = makeTempParser(entryTokens, context);
            const parsed = parseConstraintWithTempParser(tmp);
            return { type: 'constraint', value: parsed };
        }

        // MySQL: bare KEY / INDEX / FULLTEXT / SPATIAL [name] [USING method] (col[, ...])
        // Caveat: `KEY` is non-reserved in PostgreSQL/MSSQL and is a valid column name.
        // Disambiguation rules (in order):
        //   1. If the second token is a known data-type keyword, treat as column
        //      (e.g. `key VARCHAR(128)`, `index INT`).
        //   2. If there is no `(` anywhere in the entry, treat as column.
        //   3. Otherwise, parse as an inline index — captured for IDX badges.
        if (first.type === 'KW' && ['KEY', 'INDEX', 'FULLTEXT', 'SPATIAL'].includes(String(first.value).toUpperCase())) {
            const second = entryTokens[1];
            const secondIsType = second && second.type === 'KW' && DATA_TYPE_KEYWORDS.has(String(second.value).toUpperCase());
            const hasOpenParen = entryTokens.some((t) => t.type === 'PUNC' && t.value === '(');
            if (!secondIsType && hasOpenParen) {
                const kw = String(first.value).toUpperCase();
                const indexKind = kw === 'FULLTEXT' ? 'fulltext' : kw === 'SPATIAL' ? 'spatial' : 'plain';
                const tmp = makeTempParser(entryTokens, context);
                tmp.next(); // consume KEY/INDEX/FULLTEXT/SPATIAL
                // Consume optional `INDEX` after FULLTEXT/SPATIAL (e.g. `FULLTEXT INDEX (col)`).
                if (kw === 'FULLTEXT' || kw === 'SPATIAL') {
                    const after = tmp.peek();
                    if (after && after.type === 'KW' && ['INDEX', 'KEY'].includes(String(after.value).toUpperCase())) tmp.next();
                }
                // Optional index name (identifier). Capture it so the
                // renderer can show the user-supplied label (matches the
                // shape of `CREATE INDEX <name> ON ...`).
                let inlineName = null;
                if (tmp.peek() && (tmp.peek().type === 'IDENT' || tmp.peek().type === 'STRING')) {
                    const nameTok = tmp.next();
                    inlineName = String(nameTok.value);
                }
                // Optional USING <method>.
                if (tmp.peek() && tmp.peek().type === 'KW' && String(tmp.peek().value).toUpperCase() === 'USING') {
                    tmp.next();
                    if (tmp.peek() && (tmp.peek().type === 'IDENT' || tmp.peek().type === 'KW')) tmp.next();
                }
                // Walk the inline paren list as tokens too — same reasoning
                // as parseCreateIndex (preserve quoted-identifier fidelity).
                const colTokens = [];
                if (tmp.peek() && tmp.peek().type === 'PUNC' && tmp.peek().value === '(') {
                    tmp.next(); // consume '('
                    let d = 1;
                    while (tmp.peek()) {
                        const tk = tmp.next();
                        if (tk.type === 'PUNC' && tk.value === '(') { d++; colTokens.push(tk); continue; }
                        if (tk.type === 'PUNC' && tk.value === ')') { d--; if (d === 0) break; colTokens.push(tk); continue; }
                        colTokens.push(tk);
                    }
                }
                const cols = extractIndexColumnsFromTokens(colTokens);
                const expressions = extractExpressionEntriesFromTokens(colTokens);
                if (expressions.length > 0) {
                    addWarning('Expression index entries are preserved but are not projected as column index badges.', first);
                }
                return { type: 'index', value: { name: inlineName, columns: cols, expressions, unique: false, kind: indexKind } };
            }
        }

        // PostgreSQL: LIKE source_table [INCLUDING ...] — copies columns from another table.
        // We don't materialize copied columns for ERD, but skip cleanly.
        if (first.type === 'KW' && String(first.value).toUpperCase() === 'LIKE') {
            return null;
        }

        // PostgreSQL: EXCLUDE [USING idx_method] (... WITH ...) — exclusion constraint, ignore.
        if (first.type === 'KW' && String(first.value).toUpperCase() === 'EXCLUDE') {
            return null;
        }

        // else assume column definition
        const tmp = makeTempParser(entryTokens, context);
        const col = tmp.parseColumnDefinitionForEntry();
        return { type: 'column', value: col };
    }

    // ════════════════════════════════════════════════════════════════════
    //  SECTION F — Temp-parser factory + column-definition parser
    // ════════════════════════════════════════════════════════════════════
    //  `makeTempParser(toks)` returns a self-contained cursor over a
    //  pre-sliced token array. It exposes the same surface as the main
    //  parser (peek / next / expect / parseIdentifier / readParenContent
    //  / etc.) so constraint and column-definition parsers can be reused
    //  for both inline-in-CREATE-TABLE and stand-alone-in-ALTER contexts.
    //
    //  The most important method is `parseColumnDefinitionForEntry()` —
    //  it walks ALL of the dialect-specific column modifiers in one big
    //  switch. Add new modifiers there; they will then work everywhere
    //  a column is allowed.
    //
    //  Modifiers handled (compact list — see method body for syntax):
    //    type modifiers:        VARCHAR(n), NUMERIC(p, s), arrays, INTERVAL
    //    nullability:           NOT NULL, NULL
    //    uniqueness/key:        PRIMARY KEY, UNIQUE
    //    default:               DEFAULT <value-expression-soup>
    //    identity / serial:     SERIAL, BIGSERIAL, AUTO_INCREMENT,
    //                           GENERATED [ALWAYS|BY DEFAULT] AS IDENTITY,
    //                           IDENTITY(seed, increment)
    //    foreign-key inline:    REFERENCES table(col) [ON DELETE/UPDATE …]
    //    check inline:          CHECK (expression)
    //    computed:              GENERATED ALWAYS AS (expr) STORED|VIRTUAL,
    //                           col AS (expr) [PERSISTED [NOT NULL]]   (MSSQL)
    //    misc dialect:          COLLATE, CHARACTER SET, COMMENT, ON UPDATE
    //                           CURRENT_TIMESTAMP, SPARSE, FILESTREAM,
    //                           CLUSTERED / NONCLUSTERED, etc.
    // ════════════════════════════════════════════════════════════════════

    /**
     * Build a self-contained sub-parser cursor over a pre-sliced token
     * array. Mirrors the surface of the main parser closely enough that
     * column / constraint logic is reusable in two contexts:
     *
     *   • inline inside `CREATE TABLE (...)` — where the entry has already
     *     been split off at the top-level comma.
     *   • inline inside `ALTER TABLE … ADD …` — same constraint grammar,
     *     different anchoring.
     *
     * The temp parser maintains its own private `p` cursor; advancing it
     * NEVER touches the outer `idx`. That isolation is what lets the
     * column-definition machinery be hoisted into one place rather than
     * duplicated.
     *
     * Public surface returned by `makeTempParser(toks)`:
     *
     *   peek()                          → Token | null
     *   next()                          → Token | null   (advances p)
     *   expect(type, val?)              → Token | null   (no error log)
     *   parseIdentifier()               → string | null  (KW-as-ident OK)
     *   parseQualifiedIdentifier()      → "schema.table" | "table" | null
     *   consumeIfKeyword(v)             → boolean
     *   readParenContent()              → raw paren-balanced string
     *   readParenContentSpaced()        → naturally-spaced version (used
     *                                     for CHECK / DEFAULT / generated)
     *   parseColumnDefinitionForEntry() → full column AST (see below)
     *
     * @param   {Token[]} toks  The pre-sliced token array.
     * @returns {object}        Cursor object with the methods above.
     */
    function makeTempParser(toks, context = {}) {
        let p = 0;
        return {
            context,
            // Look at the token at offset `off` from the cursor without
            // advancing. Default off=0 (next token). Negative offsets are
            // not supported — there's never a need to look backwards in
            // any of the call sites.
            peek(off = 0) {
                return toks[p + off] || null;
            },
            next() {
                return toks[p++] || null;
            },
            expect(type, val) {
                const t = this.peek();
                if (!t) return null;
                if (t.type !== type) return null;
                if (val && String(t.value).toUpperCase() !== String(val).toUpperCase()) return null;
                return this.next();
            },
            parseIdentifierInfo() {
                const t = this.peek();
                if (!t) return null;
                if (t.type === 'IDENT' || t.type === 'STRING') {
                    const tok = this.next();
                    return {
                        value: String(tok.value),
                        raw: tok.raw,
                        quoted: isQuotedIdentifierToken(tok),
                    };
                }
                if (t.type === 'KW') {
                    const tok = this.next();
                    return {
                        value: String(tok.raw || tok.value),
                        raw: tok.raw,
                        quoted: false,
                    };
                }
                return null;
            },
            parseIdentifier() {
                return this.parseIdentifierInfo()?.value || null;
            },
            parseQualifiedIdentifierInfo() {
                // Parse a dotted identifier of any depth (temp parser version
                // — matches the main parser so `db.schema.table` parses
                // identically here).
                const first = this.parseIdentifierInfo();
                if (!first) return null;

                const parts = [first];
                while (
                    this.peek() &&
                    this.peek().type === 'PUNC' &&
                    this.peek().value === '.'
                ) {
                    this.next(); // consume dot
                    const segment = this.parseIdentifierInfo();
                    if (!segment) break;
                    parts.push(segment);
                }
                return { name: qualifiedIdentifierName(parts), parts };
            },
            parseQualifiedIdentifier() {
                return this.parseQualifiedIdentifierInfo()?.name || null;
            },
            consumeIfKeyword(v) {
                const t = this.peek();
                if (t && t.type === 'KW' && String(t.value).toUpperCase() === String(v).toUpperCase()) {
                    this.next();
                    return true;
                }
                return false;
            },
            readParenContent() {
                const start = this.expect('PUNC', '(');
                if (!start) return null;
                let depth = 1;
                const parts = [];
                while (this.peek()) {
                    const t = this.next();
                    if (t.type === 'PUNC' && t.value === '(') {
                        depth++;
                        parts.push(t.raw);
                        continue;
                    }
                    if (t.type === 'PUNC' && t.value === ')') {
                        depth--;
                        if (depth === 0) break;
                        parts.push(t.raw);
                        continue;
                    }
                    parts.push(t.raw);
                }
                return parts.join('');
            },
            readParenContentSpaced() {
                // Read content within parentheses and apply natural spacing (temp parser version)
                const start = this.expect('PUNC', '(');
                if (!start) return null;

                let depth = 1;
                const parts = [];

                while (this.peek()) {
                    const t = this.next();

                    if (t.type === 'PUNC' && t.value === '(') {
                        depth++;
                        parts.push(t.value);
                        continue;
                    }

                    if (t.type === 'PUNC' && t.value === ')') {
                        depth--;
                        if (depth === 0) break;
                        parts.push(t.value);
                        continue;
                    }

                    // Use raw for strings to preserve quotes
                    const tokenValue = t.type === 'STRING' ? t.raw : t.value;
                    parts.push(tokenValue);
                }

                return applyNaturalSpacing(parts.join(' '));
            },

            parseColumnDefinitionForEntry() {
                const colNameTok = this.peek();
                const colNameInfo = this.parseIdentifierInfo();
                const colName = colNameInfo?.value || null;

                // MSSQL computed column. Both forms supported:
                //   <name> AS (expression) [PERSISTED [NOT NULL]]      -- parenthesized
                //   <name> AS expression  [PERSISTED [NOT NULL]]       -- bare (T-SQL allows it)
                // Bare examples that real T-SQL ships:
                //   ExpectedHarvest AS DATEADD(DAY, c.Days, PlantingDate) PERSISTED
                //   QtyAvailable    AS QtyOrdered - QtyShipped
                //   FullName        AS dbo.FormatName(first, last) PERSISTED NOT NULL
                // Detect this BEFORE type parsing, otherwise `AS` is swallowed as part of the type.
                    if (colName && this.peek() && this.peek().type === 'KW' && String(this.peek().value).toUpperCase() === 'AS') {
                        this.next(); // consume AS
                        const genParts = ['AS'];
                        if (this.peek() && this.peek().type === 'PUNC' && this.peek().value === '(') {
                            const expr = this.readParenContentSpaced();
                            if (expr) genParts.push(`(${expr})`);
                        } else {
                            // Bare expression: read tokens until a column-terminator
                            // at paren-depth 0. Stoppers:
                            //   • `,`  (next column)
                            //   • `)`  (end of column list)
                            //   • `;`  (end of statement)
                            //   • PERSISTED (optional storage modifier — handled below)
                            //   • NOT NULL  (the alternate T-SQL ordering — see tail loop)
                            const exprParts = [];
                            let depth = 0;
                            let started = false;
                            while (this.peek()) {
                                const t = this.peek();
                                if (depth === 0) {
                                    if (t.type === 'PUNC' && (t.value === ',' || t.value === ';')) break;
                                    if (t.type === 'PUNC' && t.value === ')') break;
                                    if (t.type === 'KW') {
                                        const ku = String(t.value).toUpperCase();
                                        if (ku === 'PERSISTED') break;
                                        if (ku === 'NOT' && this.peek(1) && this.peek(1).type === 'KW' && String(this.peek(1).value).toUpperCase() === 'NULL') break;
                                    }
                                }
                                const tok = this.next();
                                if (tok.type === 'PUNC' && tok.value === '(') depth++;
                                else if (tok.type === 'PUNC' && tok.value === ')') depth--;
                                const tokenValue = tok.type === 'STRING' ? tok.raw : tok.value;
                            exprParts.push(tokenValue);
                            started = true;
                        }
                        if (!started) {
                            addError(`MSSQL computed column '${colName}' missing expression after AS`, colNameTok);
                        } else {
                            genParts.push(applyNaturalSpacing(exprParts.join(' ')));
                        }
                    }
                    // Trailing modifiers — T-SQL accepts BOTH orderings, e.g.
                    //   AS (expr) PERSISTED NOT NULL          (canonical)
                    //   AS (expr) NOT NULL PERSISTED          (also legal)
                    // Walk the tail repeatedly and accept either token first.
                    let mssqlNotNull = false;
                    let consumed = true;
                    while (consumed) {
                        consumed = false;
                        if (this.consumeIfKeyword('PERSISTED')) {
                            genParts.push('PERSISTED');
                            consumed = true;
                            continue;
                        }
                        if (
                            this.peek() && this.peek().type === 'KW' && String(this.peek().value).toUpperCase() === 'NOT' &&
                            this.peek(1) && this.peek(1).type === 'KW' && String(this.peek(1).value).toUpperCase() === 'NULL'
                        ) {
                            this.consumeIfKeyword('NOT');
                            this.consumeIfKeyword('NULL');
                            genParts.push('NOT', 'NULL');
                            mssqlNotNull = true;
                            consumed = true;
                            continue;
                        }
                    }
                    const computedColumn = {
                        name: colName,
                        type: 'COMPUTED',
                        notNull: mssqlNotNull,
                        unique: false,
                        primary: false,
                        default: null,
                        check: null,
                        references: null,
                        generated: genParts.join(' '),
                        _token: colNameTok,
                    };
                    attachHiddenMeta(computedColumn, 'nameParts', colNameInfo ? [colNameInfo] : []);
                    return computedColumn;
                }

                const typeParts = [];
                const rawTypeParts = []; // Keep raw tokens for inline ENUM extraction
                let parenDepth = 0;

                while (this.peek()) {
                    const t = this.peek();

                    // Track parentheses depth
                    if (t.type === 'PUNC' && t.value === '(') {
                        parenDepth++;
                        const tok = this.next();
                        typeParts.push(tok.value);
                        rawTypeParts.push(tok.raw || tok.value);
                        continue;
                    }
                    if (t.type === 'PUNC' && t.value === ')') {
                        parenDepth--;
                        const tok = this.next();
                        typeParts.push(tok.value);
                        rawTypeParts.push(tok.raw || tok.value);
                        // If we've closed all parentheses and next is a constraint keyword, stop
                        if (parenDepth === 0) {
                            const nextToken = this.peek();
                            if (isColumnTypeOptionStart(nextToken, this.peek(1))) {
                                break;
                            }
                        }
                        continue;
                    }

                    // Stop at comma or closing paren at top level
                    if (t.type === 'PUNC' && (t.value === ',' || t.value === ')') && parenDepth === 0) break;

                    // Only stop at constraint keywords if we're not inside parentheses
                    if (parenDepth === 0 && isColumnTypeOptionStart(t, this.peek(1))) break;

                    const tok = this.next();
                    typeParts.push(tok.value);
                    rawTypeParts.push(tok.raw || tok.value);
                }
                const type = applyNaturalSpacing(typeParts.join(' '));
                const rawType = rawTypeParts.join(''); // Raw type with quotes for ENUM extraction

                // Validate column definition
                if (!colName) {
                    addError('Column definition missing name', colNameTok);
                    return null;
                }
                const missingDeclaredType = !type || type.trim() === '';
                if (missingDeclaredType && dialect !== 'sqlite') {
                    addError(`Column '${colName}' missing data type`, colNameTok);
                    return null;
                }

                // Handle inline ENUM: register and replace type with enum name
                // SQLite permits an omitted declared type on ordinary tables.
                // `UNTYPED` is an ERD-facing sentinel, not a fabricated SQL
                // declaration; STRICT-table validation below rejects it.
                let finalType = missingDeclaredType ? 'UNTYPED' : type;
                const enumValues = parseInlineEnum(rawType);
                if (enumValues?.length && colName) {
                    finalType = registerInlineEnum(colName, enumValues, '_enum', this.context?.tableName);
                } else {
                    // MySQL inline SET — modeled as a multi-value enum-like type for ERD purposes.
                    const setValues = parseInlineSet(rawType);
                    if (setValues?.length && colName) {
                        finalType = registerInlineEnum(colName, setValues, '_set', this.context?.tableName);
                    }
                }

                // PostgreSQL SERIAL/BIGSERIAL/SMALLSERIAL imply NOT NULL + auto-increment
                const upperType = (finalType || '').toUpperCase().trim();
                const isSerial = upperType === 'SERIAL' || upperType === 'BIGSERIAL' || upperType === 'SMALLSERIAL';

                const column = {
                    name: colName,
                    type: finalType || null,
                    notNull: !!isSerial,
                    unique: false,
                    primary: false,
                    default: null,
                    check: null,
                    references: null,
                    generated: null,
                    autoIncrement: !!isSerial,
                    declaredTypeMissing: missingDeclaredType,
                    _token: colNameTok,
                };
                attachHiddenMeta(column, 'nameParts', colNameInfo ? [colNameInfo] : []);
                while (this.peek()) {
                    const t = this.peek();
                    if (t.type === 'PUNC' && (t.value === ',' || t.value === ')')) break;
                    if (isCharacterSetOptionStart(t, this.peek(1))) {
                        this.next();
                        if (tokenWordValue(t) === 'CHARACTER' && tokenWordValue(this.peek()) === 'SET') {
                            this.next();
                        }
                        if (this.peek() && this.peek().type === 'OP' && this.peek().value === '=') {
                            this.next();
                        }
                        if (this.peek() && (this.peek().type === 'IDENT' || this.peek().type === 'KW')) {
                            this.next();
                        }
                        continue;
                    }
                    if (t.type === 'KW') {
                        const kw = String(t.value).toUpperCase();
                        if (kw === 'PRIMARY') {
                            this.next();
                            this.consumeIfKeyword('KEY');
                            column.primary = true;
                            continue;
                        }
                        if (kw === 'UNIQUE') {
                            this.next();
                            column.unique = true;
                            continue;
                        }
                        if (kw === 'NOT') {
                            this.next();
                            if (this.consumeIfKeyword('NULL')) column.notNull = true;
                            continue;
                        }
                        // Explicit NULL (MySQL) — column is nullable (already default)
                        if (kw === 'NULL') {
                            this.next();
                            continue;
                        }
                        if (kw === 'DEFAULT') {
                            this.next();

                            // Collect tokens for DEFAULT expression (temp parser version)
                            const defTokens = [];
                            let depth = 0;

                            while (this.peek()) {
                                const x = this.peek();

                                // Stop at top-level delimiters
                                if (x.type === 'PUNC' && (x.value === ',' || x.value === ')') && depth === 0) break;

                                // Track parentheses depth
                                if (x.type === 'PUNC' && x.value === '(') depth++;
                                if (x.type === 'PUNC' && x.value === ')') depth--;

                                // Stop at top-level constraint keywords — but allow NULL as the
                                // literal first token (i.e. `DEFAULT NULL` is a valid value, not
                                // the start of a NOT NULL clause).
                                if (x.type === 'KW' && CONSTRAINT_KEYWORDS.has(String(x.value).toUpperCase()) && depth === 0) {
                                    if (defTokens.length === 0 && String(x.value).toUpperCase() === 'NULL') {
                                        defTokens.push(this.next());
                                        continue;
                                    }
                                    break;
                                }

                                defTokens.push(this.next());
                            }

                            // Convert tokens to natural spacing format
                            const parts = defTokens.map((token) => (token.type === 'STRING' ? token.raw : token.value));
                            column.default = applyNaturalSpacing(parts.join(' '));
                            continue;
                        }
                        if (kw === 'CHECK') {
                            this.next();
                            column.check = this.readParenContentSpaced();
                            continue;
                        }
                        if (kw === 'REFERENCES') {
                            this.next();
                            const refTableInfo = this.parseQualifiedIdentifierInfo();
                            const refTable = refTableInfo?.name || null;
                            if (!refTable) {
                                addError(`REFERENCES constraint missing table name`, this.peek());
                                continue;
                            }
                            let refCols = [];
                            if (this.peek() && this.peek().type === 'PUNC' && this.peek().value === '(') {
                                refCols = readIdentifierListFromCursor(this) || [];
                            }
                            column.references = attachHiddenMeta({ table: refTable, columns: refCols }, 'tableParts', refTableInfo.parts);
                            parseReferenceOptions(this, column.references);
                            continue;
                        }
                        // FK actions: ON DELETE/UPDATE CASCADE|RESTRICT|SET NULL|SET DEFAULT|NO ACTION
                        if (kw === 'ON') {
                            this.next(); // consume ON
                            if (this.peek() && this.peek().type !== 'PUNC') this.next(); // consume DELETE or UPDATE
                            if (this.peek() && this.peek().type !== 'PUNC') {
                                const actionTok = this.next();
                                const actionVal = String(actionTok.value).toUpperCase();
                                if ((actionVal === 'SET' || actionVal === 'NO') && this.peek() && this.peek().type !== 'PUNC') {
                                    this.next(); // consume NULL, DEFAULT, or ACTION
                                }
                            }
                            continue;
                        }
                        if (kw === 'GENERATED') {
                            this.next(); // consume GENERATED

                            let genParts = ['GENERATED'];
                            if (this.consumeIfKeyword('ALWAYS')) {
                                genParts.push('ALWAYS');
                            } else if (this.consumeIfKeyword('BY')) {
                                genParts.push('BY');
                                if (this.consumeIfKeyword('DEFAULT')) genParts.push('DEFAULT');
                            }

                            if (this.consumeIfKeyword('AS')) genParts.push('AS');

                            // PostgreSQL: GENERATED [ALWAYS|BY DEFAULT] AS IDENTITY [ ( seq options ) ]
                            // This is an auto-increment, NOT a stored/virtual generated column.
                            // Don't pollute column.generated with it.
                            if (this.peek() && this.peek().type === 'KW' && String(this.peek().value).toUpperCase() === 'IDENTITY') {
                                this.next(); // consume IDENTITY
                                if (this.peek() && this.peek().type === 'PUNC' && this.peek().value === '(') {
                                    this.readParenContent();
                                }
                                column.autoIncrement = true;
                                continue;
                            }

                            // SQL Server temporal/ledger system columns:
                            // GENERATED ALWAYS AS ROW START|END [HIDDEN]
                            // GENERATED ALWAYS AS TRANSACTION_ID START|END [HIDDEN]
                            // GENERATED ALWAYS AS SEQUENCE_NUMBER START|END [HIDDEN]
                            const systemGenerationKind = tokenWordValue(this.peek());
                            if (dialect === 'mssql' && ['ROW', 'TRANSACTION_ID', 'SEQUENCE_NUMBER'].includes(systemGenerationKind)) {
                                genParts.push(systemGenerationKind);
                                this.next();
                                const boundary = tokenWordValue(this.peek());
                                if (boundary === 'START' || boundary === 'END') {
                                    genParts.push(boundary);
                                    this.next();
                                }
                                let hidden = false;
                                if (this.consumeIfKeyword('HIDDEN')) {
                                    genParts.push('HIDDEN');
                                    hidden = true;
                                }
                                column.generated = genParts.join(' ');
                                column.systemGenerated = {
                                    kind: systemGenerationKind,
                                    boundary: boundary === 'START' || boundary === 'END' ? boundary : null,
                                    hidden,
                                };
                                continue;
                            }

                            if (this.peek() && this.peek().type === 'PUNC' && this.peek().value === '(') {
                                const expr = this.readParenContentSpaced();
                                if (expr) genParts.push(`(${expr})`);
                            }

                            if (this.consumeIfKeyword('STORED')) genParts.push('STORED');
                            else if (this.consumeIfKeyword('VIRTUAL')) genParts.push('VIRTUAL');

                            column.generated = genParts.join(' ');
                            continue;
                        }
                        // MySQL: AUTO_INCREMENT
                        if (kw === 'AUTO_INCREMENT') {
                            this.next();
                            column.autoIncrement = true;
                            continue;
                        }
                        // SQLite: AUTOINCREMENT (no underscore)
                        if (kw === 'AUTOINCREMENT') {
                            this.next();
                            column.autoIncrement = true;
                            continue;
                        }
                        // MSSQL: IDENTITY(seed, increment)
                        if (kw === 'IDENTITY') {
                            this.next();
                            if (this.peek() && this.peek().type === 'PUNC' && this.peek().value === '(') {
                                this.readParenContent();
                            }
                            column.autoIncrement = true;
                            continue;
                        }
                        // MySQL ALTER TABLE column placement. Keep it out of
                        // the data type and replay the ordering downstream.
                        if (kw === 'FIRST') {
                            this.next();
                            column.placement = { first: true, after: null };
                            continue;
                        }
                        if (kw === 'AFTER') {
                            this.next();
                            const after = this.parseIdentifier();
                            column.placement = { first: false, after };
                            continue;
                        }
                        // MySQL: COMMENT 'text'
                        if (kw === 'COMMENT') {
                            this.next();
                            if (this.peek() && this.peek().type === 'STRING') {
                                this.next();
                            }
                            continue;
                        }
                        // COLLATE collation_name
                        if (kw === 'COLLATE') {
                            this.next();
                            if (this.peek() && (this.peek().type === 'IDENT' || this.peek().type === 'KW')) {
                                this.next();
                            }
                            continue;
                        }
                    }
                    this.next();
                }
                return column;
            },
        };
    }

    // ════════════════════════════════════════════════════════════════════
    //  SECTION G — ALTER TABLE parser (ordered ERD schema transitions)
    // ════════════════════════════════════════════════════════════════════
    //  Recognised actions and their AST shape (`alter.action`):
    //    'add_foreign'  — ADD CONSTRAINT name? FOREIGN KEY (cols) REFERENCES …
    //    'add_primary'  — ADD CONSTRAINT name? PRIMARY KEY (cols)
    //    'add_unique'   — ADD CONSTRAINT name? UNIQUE (cols)
    //    'add_check'    — ADD CONSTRAINT name? CHECK (expression)
    //    'add_column' / 'drop_column' / 'rename_column'
    //    'alter_column_type' / 'alter_column_set_not_null' /
    //      'alter_column_default' / 'modify_column' / 'change_column'
    //    'drop_constraint' / 'rename_constraint' / 'rename_index'
    //    'rename_table'
    // ════════════════════════════════════════════════════════════════════

    /**
     * Parse the body of an ALTER TABLE statement (the cursor is already
     * past `ALTER`). Pushes one or more entries onto `ast.alters`.
     *
     * Action shape pushed to `ast.alters`:
     *   {
     *     table:      string,                  // qualified or bare name
     *     action:     string,                    // one transition listed above
     *     name?:      string,                  // optional CONSTRAINT name
     *     columns?:   string[],                // for PK / UQ / FK
     *     references?: { table, columns },     // for FK
     *     expression?: string,                 // for CHECK
     *     position:   { start, end }
     *   }
     *
     * @param {Token|null} alterToken  The ALTER token captured by the
     *                                 dispatch loop, used solely for
     *                                 producing accurate position info.
     *
     * @example
     *   ALTER TABLE posts
     *     ADD CONSTRAINT fk_user
     *       FOREIGN KEY (user_id) REFERENCES users(id);
     *   // → ast.alters.push({
     *   //     table: 'posts', action: 'add_foreign', name: 'fk_user',
     *   //     columns: ['user_id'],
     *   //     references: { table: 'users', columns: ['id'] }, … })
     */
    function parseAlterTable(alterToken = null) {
        const alterStartPos = alterToken ? alterToken.start : null;

        consumeIfKeyword('TABLE');
        const tableNameInfo = parseQualifiedIdentifierInfo();
        const tableName = tableNameInfo?.name || null;
        if (!tableName) return;

        let alterEndPos = null;

        const pushAlter = (payload) => {
            const alter = attachHiddenMeta(
                {
                    table: tableName,
                    ...payload,
                    position: {
                        start: alterStartPos,
                        end: null,
                    },
                },
                'tableParts',
                tableNameInfo.parts,
            );
            if (payload?.newTableParts !== undefined) {
                attachHiddenMeta(alter, 'newTableParts', payload.newTableParts);
            }
            if (payload?.oldNameParts !== undefined) attachHiddenMeta(alter, 'oldNameParts', payload.oldNameParts);
            if (payload?.newNameParts !== undefined) attachHiddenMeta(alter, 'newNameParts', payload.newNameParts);
            if (payload?.columnParts !== undefined) attachHiddenMeta(alter, 'columnParts', payload.columnParts);
            if (payload?.nameParts !== undefined) attachHiddenMeta(alter, 'nameParts', payload.nameParts);
            ast.alters.push(alter);
        };

        const consumeClauseSeparator = () => {
            if (peek() && peek().type === 'PUNC' && peek().value === ',') {
                next();
                return true;
            }
            return false;
        };

        const skipOptionalIfExists = () => {
            if (consumeIfKeyword('IF')) consumeIfKeyword('EXISTS');
        };

        const skipOptionalIfNotExists = () => {
            if (!consumeIfKeyword('IF')) return;
            consumeIfKeyword('NOT');
            consumeIfKeyword('EXISTS');
        };

        const tokenText = (tok) => (tok?.type === 'STRING' ? tok.raw : tok?.raw || tok?.value || '');
        const tokensToNaturalText = (toks) => applyNaturalSpacing((toks || []).map(tokenText).join(' '));

        const readClauseTokens = (extraStopKeywords = []) => {
            const stopKeywords = new Set(extraStopKeywords.map((word) => String(word).toUpperCase()));
            const out = [];
            let depth = 0;
            while (peek()) {
                const x = peek();
                if (depth === 0) {
                    if (x.type === 'PUNC' && (x.value === ';' || x.value === ',')) break;
                    if (x.type === 'KW') {
                        const up = String(x.value).toUpperCase();
                        if (stopKeywords.has(up)) break;
                        if (out.length > 0 && ['ADD', 'DROP', 'RENAME', 'ALTER', 'MODIFY', 'CHANGE'].includes(up)) break;
                    }
                }
                const tok = next();
                if (tok.type === 'PUNC' && tok.value === '(') depth++;
                else if (tok.type === 'PUNC' && tok.value === ')') depth--;
                out.push(tok);
            }
            return out;
        };

        const parseTypeTokensAndNullability = (toks) => {
            const filtered = [];
            let notNull = null;
            let depth = 0;
            for (let i = 0; i < (toks || []).length; i++) {
                const tok = toks[i];
                if (tok.type === 'PUNC' && tok.value === '(') depth++;
                if (tok.type === 'PUNC' && tok.value === ')') depth--;
                const up = tok.type === 'KW' ? String(tok.value).toUpperCase() : null;
                const nextTok = toks[i + 1];
                const nextUp = nextTok?.type === 'KW' ? String(nextTok.value).toUpperCase() : null;
                if (depth === 0 && up === 'NOT' && nextUp === 'NULL') {
                    notNull = true;
                    i++;
                    continue;
                }
                if (depth === 0 && up === 'NULL') {
                    notNull = false;
                    continue;
                }
                filtered.push(tok);
            }
            return { type: tokensToNaturalText(filtered), notNull };
        };

        const readColumnDefinitionForAlter = () => {
            const colTokens = readClauseTokens();
            if (colTokens.length === 0) return null;
            const tmp = makeTempParser(colTokens, { tableName, tableNameParts: tableNameInfo.parts });
            return tmp.parseColumnDefinitionForEntry();
        };

        while (peek()) {
            if (peek().type === 'PUNC' && peek().value === ';') {
                const semicolonToken = next();
                alterEndPos = semicolonToken.end;
                break;
            }
            if (peek().type === 'PUNC' && peek().value === ',') {
                next();
                continue;
            }

            const current = peek();
            const currentValue = current?.type === 'KW' ? String(current.value).toUpperCase() : null;

            if (currentValue === 'ADD') {
                const addToken = next();
                let conName = null;
                let conNameInfo = null;
                if (consumeIfKeyword('CONSTRAINT')) {
                    conNameInfo = parseIdentifierInfo();
                    conName = conNameInfo?.value || null;
                }
                const t = peek();
                const tokenValue = t ? String(t.value).toUpperCase() : null;
                const explicitColumnKeyword = t && tokenValue === 'COLUMN';
                const constraintStart = t && t.type === 'KW' && ['PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'DEFAULT', 'PERIOD'].includes(tokenValue);
                const ignoredIndexStart = t && t.type === 'KW' && ['INDEX', 'KEY', 'FULLTEXT', 'SPATIAL'].includes(tokenValue);

                // MySQL permits indexes to be added inside ALTER TABLE. Store
                // them in the same global index stream as CREATE INDEX so ERD
                // replay preserves statement order and badge semantics.
                if (!conName && ignoredIndexStart) {
                    let kind = 'plain';
                    if (tokenValue === 'FULLTEXT') kind = 'fulltext';
                    if (tokenValue === 'SPATIAL') kind = 'spatial';
                    next();
                    if (tokenValue === 'FULLTEXT' || tokenValue === 'SPATIAL') {
                        consumeIfKeyword('INDEX') || consumeIfKeyword('KEY');
                    }

                    let indexName = null;
                    if (peek() && !(peek().type === 'PUNC' && peek().value === '(')) {
                        indexName = parseIdentifier();
                    }
                    if (!peek() || peek().type !== 'PUNC' || peek().value !== '(') {
                        addError('ALTER TABLE ADD INDEX missing column list', peek() || addToken);
                        readClauseTokens();
                        consumeClauseSeparator();
                        continue;
                    }

                    const indexTokens = readParenTokens();
                    const columns = extractIndexColumnsFromTokens(indexTokens);
                    const expressions = extractExpressionEntriesFromTokens(indexTokens);
                    if (columns.length === 0 && expressions.length === 0) {
                        addError('ALTER TABLE ADD INDEX has no supported columns', addToken);
                    } else {
                        if (expressions.length > 0) {
                            addWarning('Expression index entries are preserved but are not projected as column index badges.', addToken);
                        }
                        ast.indexes.push(
                            attachHiddenMeta(
                                {
                                    name: indexName,
                                    table: tableName,
                                    columns,
                                    expressions,
                                    unique: false,
                                    kind,
                                    where: null,
                                    position: { start: addToken.start, end: peek(-1)?.end || addToken.end },
                                },
                                'tableParts',
                                tableNameInfo.parts,
                            ),
                        );
                    }
                    consumeClauseSeparator();
                    continue;
                }

                if (!conName && t && !constraintStart && !ignoredIndexStart) {
                    if (explicitColumnKeyword) next();
                    skipOptionalIfNotExists();
                    const column = readColumnDefinitionForAlter();
                    if (column) {
                        pushAlter({
                            action: 'add_column',
                            column,
                        });
                    }
                    consumeClauseSeparator();
                    continue;
                }

                if (t && t.type === 'KW') {
                    const k = String(t.value).toUpperCase();
                    if (k === 'PRIMARY') {
                        next();
                        consumeIfKeyword('KEY');
                        consumeIfKeyword('CLUSTERED');
                        consumeIfKeyword('NONCLUSTERED');
                        if (peek() && peek().type === 'IDENT') next();
                        const cols = readIdentifierList();
                        if (!cols || cols.length === 0) {
                            addError(`ALTER TABLE ADD PRIMARY KEY missing column list`, peek());
                            continue;
                        }
                        pushAlter({ action: 'add_primary', name: conName, nameParts: conNameInfo ? [conNameInfo] : [], columns: cols });
                        consumeClauseSeparator();
                        continue;
                    }
                    if (k === 'UNIQUE') {
                        next();
                        consumeIfKeyword('KEY') || consumeIfKeyword('INDEX');
                        consumeIfKeyword('CLUSTERED');
                        consumeIfKeyword('NONCLUSTERED');
                        let uniqueName = conName;
                        let uniqueNameInfo = conNameInfo;
                        if (peek() && !(peek().type === 'PUNC' && peek().value === '(')) {
                            const parsedNameInfo = parseIdentifierInfo();
                            const parsedName = parsedNameInfo?.value || null;
                            if (!uniqueName && parsedName) {
                                uniqueName = parsedName;
                                uniqueNameInfo = parsedNameInfo;
                            }
                        }
                        const cols = readIdentifierList();
                        if (!cols || cols.length === 0) {
                            addError(`ALTER TABLE ADD UNIQUE missing column list`, peek());
                            continue;
                        }
                        pushAlter({ action: 'add_unique', name: uniqueName, nameParts: uniqueNameInfo ? [uniqueNameInfo] : [], columns: cols });
                        consumeClauseSeparator();
                        continue;
                    }
                    if (k === 'FOREIGN') {
                        next();
                        if (!consumeIfKeyword('KEY')) {
                            addError(`ALTER TABLE ADD FOREIGN KEY missing KEY keyword`, peek());
                            continue;
                        }
                        const cols = readIdentifierList();
                        if (!cols || cols.length === 0) {
                            addError(`ALTER TABLE ADD FOREIGN KEY missing column list`, peek());
                            continue;
                        }
                        if (!consumeIfKeyword('REFERENCES')) {
                            addError(`ALTER TABLE ADD FOREIGN KEY missing REFERENCES keyword`, peek());
                            continue;
                        }
                        const refTableInfo = parseQualifiedIdentifierInfo();
                        const refTable = refTableInfo?.name || null;
                        if (!refTable) {
                            addError(`ALTER TABLE ADD FOREIGN KEY missing referenced table`, peek());
                            continue;
                        }
                        let refCols = [];
                        if (peek() && peek().type === 'PUNC' && peek().value === '(') {
                            refCols = readIdentifierList() || [];
                        }
                        const references = attachHiddenMeta({ table: refTable, columns: refCols }, 'tableParts', refTableInfo.parts);
                        parseReferenceOptions({ expect, peek, next }, references);
                        pushAlter({ action: 'add_foreign', name: conName, nameParts: conNameInfo ? [conNameInfo] : [], columns: cols, references });
                        consumeClauseSeparator();
                        continue;
                    }
                    if (k === 'CHECK') {
                        next();
                        const checkExpr = readParenContent();
                        if (checkExpr) {
                            pushAlter({ action: 'add_check', name: conName, nameParts: conNameInfo ? [conNameInfo] : [], expression: checkExpr.trim() });
                        }
                        consumeClauseSeparator();
                        continue;
                    }
                    if (k === 'DEFAULT') {
                        next();
                        const defaultTokens = readClauseTokens();
                        let depth = 0;
                        let forIndex = -1;
                        for (let tokenIndex = 0; tokenIndex < defaultTokens.length; tokenIndex++) {
                            const token = defaultTokens[tokenIndex];
                            if (token.type === 'PUNC' && token.value === '(') depth++;
                            else if (token.type === 'PUNC' && token.value === ')') depth--;
                            if (depth === 0 && tokenWordValue(token) === 'FOR') {
                                forIndex = tokenIndex;
                                break;
                            }
                        }
                        const expressionTokens = forIndex >= 0 ? defaultTokens.slice(0, forIndex) : defaultTokens;
                        const columnTokens = forIndex >= 0 ? defaultTokens.slice(forIndex + 1) : [];
                        const column = identifierNameFromTokenGroup(columnTokens);
                        const expression = tokensToNaturalText(expressionTokens);
                        if (!column) addError('ALTER TABLE ADD DEFAULT is missing its FOR column', addToken);
                        if (column && expression) pushAlter({ action: 'add_default', name: conName, nameParts: conNameInfo ? [conNameInfo] : [], column, expression });
                        consumeClauseSeparator();
                        continue;
                    }
                    if (k === 'PERIOD') {
                        next();
                        consumeIfKeyword('FOR');
                        consumeIfKeyword('SYSTEM_TIME');
                        const columns = readIdentifierList() || [];
                        if (columns.length !== 2) addError('ALTER TABLE ADD PERIOD FOR SYSTEM_TIME requires exactly two columns', addToken);
                        else pushAlter({ action: 'add_period', columns });
                        consumeClauseSeparator();
                        continue;
                    }
                }
            }

            if (currentValue === 'RENAME') {
                next();
                if (consumeIfKeyword('COLUMN')) {
                    const oldNameInfo = parseIdentifierInfo();
                    const oldName = oldNameInfo?.value || null;
                    consumeIfKeyword('TO');
                    const newNameInfo = parseIdentifierInfo();
                    const newName = newNameInfo?.value || null;
                    if (oldName && newName) {
                        const payload = { action: 'rename_column', oldName, newName };
                        attachHiddenMeta(payload, 'oldNameParts', oldNameInfo ? [oldNameInfo] : []);
                        attachHiddenMeta(payload, 'newNameParts', newNameInfo ? [newNameInfo] : []);
                        pushAlter(payload);
                    }
                    consumeClauseSeparator();
                    continue;
                }

                if (consumeIfKeyword('INDEX') || consumeIfKeyword('KEY')) {
                    const oldNameInfo = parseIdentifierInfo();
                    const oldName = oldNameInfo?.value || null;
                    consumeIfKeyword('TO');
                    const newNameInfo = parseIdentifierInfo();
                    const newName = newNameInfo?.value || null;
                    if (oldName && newName) {
                        pushAlter({
                            action: 'rename_index',
                            oldName,
                            oldNameParts: [oldNameInfo],
                            newName,
                            newNameParts: [newNameInfo],
                        });
                    }
                    consumeClauseSeparator();
                    continue;
                }

                if (consumeIfKeyword('CONSTRAINT')) {
                    const oldNameInfo = parseIdentifierInfo();
                    const oldName = oldNameInfo?.value || null;
                    consumeIfKeyword('TO');
                    const newNameInfo = parseIdentifierInfo();
                    const newName = newNameInfo?.value || null;
                    if (oldName && newName) {
                        pushAlter({
                            action: 'rename_constraint',
                            oldName,
                            oldNameParts: [oldNameInfo],
                            newName,
                            newNameParts: [newNameInfo],
                        });
                    }
                    consumeClauseSeparator();
                    continue;
                }

                consumeIfKeyword('TO');
                const newTableInfo = parseQualifiedIdentifierInfo();
                const newName = newTableInfo?.name || null;
                if (newName) {
                    const payload = attachHiddenMeta({ action: 'rename_table', newName }, 'newTableParts', newTableInfo.parts);
                    pushAlter(payload);
                }
                consumeClauseSeparator();
                continue;
            }

            if (currentValue === 'DROP') {
                const dropToken = next();
                const afterDrop = peek();
                const afterDropValue = afterDrop?.type === 'KW' ? String(afterDrop.value).toUpperCase() : null;

                if (afterDropValue === 'COLUMN') {
                    next();
                    skipOptionalIfExists();
                    const columnNameInfo = parseIdentifierInfo();
                    const columnName = columnNameInfo?.value || null;
                    if (columnName) pushAlter({ action: 'drop_column', column: columnName, columnParts: [columnNameInfo] });
                    consumeClauseSeparator();
                    continue;
                }

                if (afterDropValue === 'CONSTRAINT') {
                    next();
                    skipOptionalIfExists();
                    const constraintNameInfo = parseIdentifierInfo();
                    const constraintName = constraintNameInfo?.value || null;
                    if (constraintName) pushAlter({ action: 'drop_constraint', name: constraintName, nameParts: [constraintNameInfo], constraintKind: 'constraint' });
                    consumeClauseSeparator();
                    continue;
                }

                if (afterDropValue === 'FOREIGN') {
                    next();
                    consumeIfKeyword('KEY');
                    const constraintNameInfo = parseIdentifierInfo();
                    const constraintName = constraintNameInfo?.value || null;
                    if (constraintName) pushAlter({ action: 'drop_constraint', name: constraintName, nameParts: [constraintNameInfo], constraintKind: 'foreign' });
                    consumeClauseSeparator();
                    continue;
                }

                if (afterDropValue === 'PRIMARY') {
                    next();
                    consumeIfKeyword('KEY');
                    pushAlter({ action: 'drop_constraint', name: null, constraintKind: 'primary' });
                    consumeClauseSeparator();
                    continue;
                }

                if (afterDropValue === 'INDEX' || afterDropValue === 'KEY') {
                    next();
                    skipOptionalIfExists();
                    const indexNameInfo = parseIdentifierInfo();
                    const indexName = indexNameInfo?.value || null;
                    if (indexName) {
                        pushAlter({ action: 'drop_constraint', name: indexName, constraintKind: 'index' });
                        const indexDrop = {
                            kind: 'index',
                            name: indexName,
                            table: tableName,
                            position: { start: dropToken?.start || alterStartPos, end: peek(-1)?.end || dropToken?.end || null },
                        };
                        attachHiddenMeta(indexDrop, 'nameParts', indexNameInfo ? [indexNameInfo] : []);
                        attachHiddenMeta(indexDrop, 'tableParts', tableNameInfo.parts);
                        ast.drops.push(indexDrop);
                    }
                    consumeClauseSeparator();
                    continue;
                }

                skipOptionalIfExists();
                const columnNameInfo = parseIdentifierInfo();
                const columnName = columnNameInfo?.value || null;
                if (columnName) pushAlter({ action: 'drop_column', column: columnName, columnParts: [columnNameInfo] });
                consumeClauseSeparator();
                continue;
            }

            if (currentValue === 'ALTER') {
                next();
                consumeIfKeyword('COLUMN');
                const columnNameInfo = parseIdentifierInfo();
                const columnName = columnNameInfo?.value || null;
                if (!columnName) {
                    readClauseTokens();
                    consumeClauseSeparator();
                    continue;
                }

                if (consumeIfKeyword('SET')) {
                    if (consumeIfKeyword('NOT')) {
                        consumeIfKeyword('NULL');
                        pushAlter({ action: 'alter_column_set_not_null', column: columnName, columnParts: [columnNameInfo], notNull: true });
                    } else if (consumeIfKeyword('DEFAULT')) {
                        const expression = tokensToNaturalText(readClauseTokens());
                        if (expression) pushAlter({ action: 'alter_column_default', column: columnName, columnParts: [columnNameInfo], expression });
                    } else if (consumeIfKeyword('DATA') || consumeIfIdent('DATA')) {
                        consumeIfKeyword('TYPE');
                        const typeTokens = readClauseTokens(['USING']);
                        const { type, notNull } = parseTypeTokensAndNullability(typeTokens);
                        if (type) pushAlter({ action: 'alter_column_type', column: columnName, columnParts: [columnNameInfo], type, notNull });
                    }
                    consumeClauseSeparator();
                    continue;
                }

                if (consumeIfKeyword('DROP')) {
                    if (consumeIfKeyword('NOT')) {
                        consumeIfKeyword('NULL');
                        pushAlter({ action: 'alter_column_set_not_null', column: columnName, columnParts: [columnNameInfo], notNull: false });
                    } else if (consumeIfKeyword('DEFAULT')) {
                        pushAlter({ action: 'alter_column_default', column: columnName, columnParts: [columnNameInfo], expression: null });
                    }
                    consumeClauseSeparator();
                    continue;
                }

                if (consumeIfKeyword('TYPE')) {
                    const typeTokens = readClauseTokens(['USING']);
                    const { type, notNull } = parseTypeTokensAndNullability(typeTokens);
                    if (type) pushAlter({ action: 'alter_column_type', column: columnName, columnParts: [columnNameInfo], type, notNull });
                    consumeClauseSeparator();
                    continue;
                }

                const typeTokens = readClauseTokens(['USING']);
                const { type, notNull } = parseTypeTokensAndNullability(typeTokens);
                if (type) pushAlter({ action: 'alter_column_type', column: columnName, columnParts: [columnNameInfo], type, notNull });
                consumeClauseSeparator();
                continue;
            }

            if (currentValue === 'MODIFY') {
                next();
                consumeIfKeyword('COLUMN');
                const column = readColumnDefinitionForAlter();
                if (column) pushAlter({ action: 'modify_column', column });
                consumeClauseSeparator();
                continue;
            }

            if (currentValue === 'CHANGE') {
                next();
                consumeIfKeyword('COLUMN');
                const oldNameInfo = parseIdentifierInfo();
                const oldName = oldNameInfo?.value || null;
                const column = readColumnDefinitionForAlter();
                if (oldName && column) pushAlter({ action: 'change_column', oldName, oldNameParts: [oldNameInfo], column });
                consumeClauseSeparator();
                continue;
            }

            next();
        }

        if (alterEndPos) {
            ast.alters.forEach((alter) => {
                if (alter.table === tableName && alter.position && !alter.position.end) {
                    alter.position.end = alterEndPos;
                }
            });
        }
    }

    function parseDropStatement(dropToken = null) {
        const objectToken = peek();
        const objectKind = tokenWordValue(objectToken).toLowerCase();
        if (!['table', 'type', 'index'].includes(objectKind)) {
            while (peek() && !(peek().type === 'PUNC' && peek().value === ';')) next();
            if (peek()?.type === 'PUNC' && peek().value === ';') next();
            return;
        }
        next(); // TABLE / TYPE / INDEX
        if (consumeIfKeyword('IF')) consumeIfKeyword('EXISTS');

        const pending = [];
        while (peek()) {
            const word = tokenWordValue(peek());
            if (word === 'CASCADE' || word === 'RESTRICT') break;
            const nameInfo = parseQualifiedIdentifierInfo();
            if (!nameInfo?.name) break;
            pending.push(nameInfo);
            if (!peek() || peek().type !== 'PUNC' || peek().value !== ',') break;
            next();
        }

        // MySQL and SQL Server qualify DROP INDEX with its owning table:
        //   DROP INDEX ix_name ON schema.table
        // Preserve that identity so indexes with the same table-scoped name
        // on different tables do not invalidate one another during replay.
        let indexTableInfo = null;
        if (objectKind === 'index' && consumeIfKeyword('ON')) {
            indexTableInfo = parseQualifiedIdentifierInfo();
        }

        const dropBehavior = ['CASCADE', 'RESTRICT'].includes(tokenWordValue(peek()))
            ? tokenWordValue(next())
            : null;

        while (peek() && !(peek().type === 'PUNC' && peek().value === ';')) next();
        let end = peek(-1)?.end || dropToken?.end || null;
        if (peek()?.type === 'PUNC' && peek().value === ';') end = next().end;
        pending.forEach((nameInfo) => {
            const drop = {
                kind: objectKind,
                name: nameInfo.name,
                position: { start: dropToken?.start || null, end },
            };
            attachHiddenMeta(drop, 'nameParts', nameInfo.parts);
            if (dropBehavior) attachHiddenMeta(drop, 'behavior', dropBehavior);
            if (indexTableInfo?.name) {
                drop.table = indexTableInfo.name;
                attachHiddenMeta(drop, 'tableParts', indexTableInfo.parts);
            }
            ast.drops.push(drop);
        });
    }

    // ════════════════════════════════════════════════════════════════════
    //  SECTION G2 — CREATE INDEX parser
    // ════════════════════════════════════════════════════════════════════
    //  Recognised forms (PostgreSQL / MySQL / MSSQL all subsumed):
    //
    //    CREATE [UNIQUE] [CLUSTERED|NONCLUSTERED|COLUMNSTORE|FULLTEXT|SPATIAL]
    //           INDEX [CONCURRENTLY] [IF NOT EXISTS] [name]
    //           ON [ONLY] table [USING method] (col[, col, ...])
    //           [INCLUDE (...)] [WHERE ...] [WITH (...)]
    //           [TABLESPACE ...] ;
    //
    //  We do NOT model the index itself in the ERD — we only need the
    //  (unique?, table, columns[]) triple so each column can grow an
    //  `IDX` (or `UQ`) badge in the renderer. Anything after the column
    //  list is consumed as opaque token-soup until the statement-terminating
    //  semicolon (or the next CREATE/ALTER, for unterminated scripts).
    //
    //  Robustness contract:
    //    • Any malformed prefix (missing INDEX keyword, missing ON, missing
    //      paren list) emits a `warning` and gracefully recovers to the
    //      next `;`. We never throw on `CREATE INDEX` garbage.
    //    • Functional-index entries `((expr))` and entries whose first token
    //      is not an identifier are omitted from the badgeable column list,
    //      preserved in `expressions`, and surfaced with a warning.
    // ════════════════════════════════════════════════════════════════════

    /**
     * Read tokens between matching `(` and `)` from the cursor, returning
     * the inner token array (the parens themselves are consumed).
     * Bails out cleanly on `;` or a top-level `CREATE` so a malformed
     * paren list can't swallow the rest of the script.
     */
    function readParenTokens() {
        const start = expect('PUNC', '(');
        if (!start) return null;
        let depth = 1;
        const out = [];
        while (peek()) {
            const t = peek();
            if (t.type === 'PUNC' && t.value === ';') break;
            if (t.type === 'KW' && String(t.value).toUpperCase() === 'CREATE') break;
            const tok = next();
            if (tok.type === 'PUNC' && tok.value === '(') { depth++; out.push(tok); continue; }
            if (tok.type === 'PUNC' && tok.value === ')') { depth--; if (depth === 0) break; out.push(tok); continue; }
            out.push(tok);
        }
        return out;
    }

    /**
     * Given the tokens inside an index column-list `( ... )`, return the
     * column-name string for each comma-separated entry:
     *
     *   `(a, b)`                       → ['a', 'b']
     *   `(a ASC, b DESC NULLS LAST)`   → ['a', 'b']
     *   `("col one", [col two])`       → ['col one', 'col two']
     *   `(lower(a), b)`                → ['b']           (expression is stored separately)
     *   `(a COLLATE "C" ASC, b)`       → ['a', 'b']
     *
     * Algorithm: split tokens at top-level commas, then for each chunk
     * take the first IDENT/STRING/KW-as-ident token. If the very next
     * token is `(`, the chunk is a function call and is dropped — there
     * is no single column to badge.
     */
    function extractIndexColumnsFromTokens(toks) {
        if (!toks || toks.length === 0) return [];
        const groups = [[]];
        let depth = 0;
        for (const t of toks) {
            if (t.type === 'PUNC' && t.value === '(') depth++;
            else if (t.type === 'PUNC' && t.value === ')') depth--;
            if (t.type === 'PUNC' && t.value === ',' && depth === 0) {
                groups.push([]);
                continue;
            }
            groups[groups.length - 1].push(t);
        }

        const infos = groups
            .map((g) => {
                if (g.length === 0) return null;
                const head = g[0];
                // Functional/expression entry: `(expr)` — skip.
                if (head.type === 'PUNC' && head.value === '(') return null;
                // Function call: `fn ( …` — drop.
                const second = g[1];
                if (second && second.type === 'PUNC' && second.value === '(') return null;
                return identifierInfoFromTokenGroup(g);
            })
            .filter(Boolean);
        const names = infos.map((info) => info.name);
        attachHiddenMeta(names, 'identifierParts', infos.map((info) => info.parts));
        return names;
    }

    /**
     * Parse a standalone `CREATE INDEX` statement (the cursor is already
     * past `CREATE`; sub-keywords like UNIQUE / CLUSTERED / NONCLUSTERED /
     * COLUMNSTORE / FULLTEXT / SPATIAL / CONCURRENTLY are consumed inline).
     *
     * Pushes one entry onto `ast.indexes`:
     *   {
     *     name:    string|null,    // null when omitted (PG allows it)
     *     table:   string,         // schema-qualified or bare
     *     columns: string[],       // projectable flat column names
     *     expressions: string[],   // functional/expression entries preserved
     *     unique:  boolean,
     *     kind:    'plain'|'fulltext'|'spatial',
     *     where:   string|null,     // partial/filtered predicate, if present
     *     position:{ start, end }
     *   }
     *
     * @param {Token} createToken  The CREATE token saved by the dispatch
     *                             loop (used only for `position.start`).
     *
     * @example
     *   CREATE UNIQUE INDEX CONCURRENTLY ix_users_email
     *     ON users USING btree (email)
     *     INCLUDE (created_at)
     *     WHERE deleted_at IS NULL;
     *   // → ast.indexes.push({
     *   //     name: 'ix_users_email', table: 'users',
     *   //     columns: ['email'], unique: true, kind: 'plain',
     *   //     where: 'deleted_at IS NULL', … })
     */
    function parseCreateIndex(createToken) {
        const startPos = createToken ? createToken.start : null;

        // Modifiers in any order (PG/MySQL/MSSQL all differ slightly):
        //   UNIQUE | CLUSTERED | NONCLUSTERED | COLUMNSTORE | FULLTEXT | SPATIAL
        let unique = false;
        let kind = 'plain';
        for (let safety = 0; safety < 6; safety++) {
            const t = peek();
            if (!t || t.type !== 'KW') break;
            const up = String(t.value).toUpperCase();
            if (up === 'UNIQUE') { unique = true; next(); continue; }
            if (up === 'CLUSTERED' || up === 'NONCLUSTERED') { next(); continue; }
            if (up === 'COLUMNSTORE') { next(); continue; }
            if (up === 'FULLTEXT') { kind = 'fulltext'; next(); continue; }
            if (up === 'SPATIAL') { kind = 'spatial'; next(); continue; }
            break;
        }

        if (!consumeIfKeyword('INDEX')) {
            addWarning("Expected 'INDEX' after CREATE [UNIQUE|CLUSTERED|...]", peek() || createToken);
            // Recovery: skip to ;
            while (peek() && !(peek().type === 'PUNC' && peek().value === ';')) next();
            if (peek() && peek().type === 'PUNC' && peek().value === ';') next();
            return;
        }

        // PostgreSQL: CREATE INDEX CONCURRENTLY ...
        consumeIfIdent('CONCURRENTLY');

        // Optional `IF NOT EXISTS`
        if (consumeIfKeyword('IF')) {
            consumeIfKeyword('NOT');
            consumeIfKeyword('EXISTS');
        }

        // Optional index name (qualified). The ON keyword tells us the name was omitted.
        let indexName = null;
        let indexNameInfo = null;
        const beforeNameTok = peek();
        if (beforeNameTok && !(beforeNameTok.type === 'KW' && String(beforeNameTok.value).toUpperCase() === 'ON')) {
            indexNameInfo = parseQualifiedIdentifierInfo();
            indexName = indexNameInfo?.name || null;
        }

        if (!consumeIfKeyword('ON')) {
            addWarning("Expected 'ON' in CREATE INDEX statement", peek() || createToken);
            while (peek() && !(peek().type === 'PUNC' && peek().value === ';')) next();
            if (peek() && peek().type === 'PUNC' && peek().value === ';') next();
            return;
        }

        // Optional ONLY (PostgreSQL)
        consumeIfKeyword('ONLY');

        const tableNameInfo = parseQualifiedIdentifierInfo();
        const tableName = tableNameInfo?.name || null;
        if (!tableName) {
            addWarning("Expected table name after 'ON' in CREATE INDEX", peek() || createToken);
            while (peek() && !(peek().type === 'PUNC' && peek().value === ';')) next();
            if (peek() && peek().type === 'PUNC' && peek().value === ';') next();
            return;
        }

        // Optional `USING method` (PG/MySQL place it before the column list).
        if (consumeIfKeyword('USING')) {
            // method name token (IDENT or KW), e.g. btree, hash, gin, gist.
            if (peek() && (peek().type === 'IDENT' || peek().type === 'KW')) next();
        }

        if (!peek() || !(peek().type === 'PUNC' && peek().value === '(')) {
            addWarning("Expected '(' for column list in CREATE INDEX", peek() || createToken);
            while (peek() && !(peek().type === 'PUNC' && peek().value === ';')) next();
            if (peek() && peek().type === 'PUNC' && peek().value === ';') next();
            return;
        }

        // Walk tokens directly so quoted identifiers (which the lexer
        // already unwrapped — `"col one"` → STRING with value `col one`)
        // and `ASC`/`DESC` modifiers stay distinguishable.
        const colTokens = readParenTokens();
        const columns = extractIndexColumnsFromTokens(colTokens);
        const expressions = extractExpressionEntriesFromTokens(colTokens);
        if (expressions.length > 0) {
            addWarning('Expression index entries are preserved but are not projected as column index badges.', createToken);
        }
        let where = null;

        const tokenKeyword = (tok) => (tok && (tok.type === 'KW' || tok.type === 'IDENT') ? String(tok.value).toUpperCase() : null);
        const isStatementBoundary = (tok) => ['CREATE', 'ALTER', 'GO'].includes(tokenKeyword(tok));
        const isIndexTailBoundary = (tok) => ['INCLUDE', 'WITH', 'TABLESPACE', 'USING', 'CREATE', 'ALTER', 'GO'].includes(tokenKeyword(tok));

        // Consume the rest of the statement: WHERE / INCLUDE / WITH / USING (MySQL)
        // / TABLESPACE / nested parens — anything until `;` (or next CREATE/ALTER).
        while (peek()) {
            const t = peek();
            if (t.type === 'PUNC' && t.value === ';') break;
            if (isStatementBoundary(t)) break;
            if (tokenKeyword(t) === 'WHERE') {
                next();
                const predicateTokens = [];
                let depth = 0;
                while (peek()) {
                    const x = peek();
                    if (x.type === 'PUNC' && x.value === ';' && depth === 0) break;
                    if (depth === 0 && isIndexTailBoundary(x)) break;
                    const tok = next();
                    if (tok.type === 'PUNC' && tok.value === '(') depth++;
                    else if (tok.type === 'PUNC' && tok.value === ')') depth = Math.max(0, depth - 1);
                    predicateTokens.push(tok);
                }
                const predicate = tokensToNaturalText(predicateTokens).trim();
                if (predicate) where = predicate;
                continue;
            }
            // Parenthesized groups (INCLUDE (...), WITH (...), WHERE (...) sub-exprs)
            if (t.type === 'PUNC' && t.value === '(') {
                let d = 0;
                while (peek()) {
                    const x = peek();
                    if (x.type === 'PUNC' && x.value === '(') { d++; next(); continue; }
                    if (x.type === 'PUNC' && x.value === ')') { d--; next(); if (d === 0) break; continue; }
                    next();
                }
                continue;
            }
            next();
        }

        let endPos = null;
        if (peek() && peek().type === 'PUNC' && peek().value === ';') {
            const semi = next();
            endPos = semi.end;
        } else {
            const lastTok = peek(-1);
            endPos = lastTok ? lastTok.end : null;
        }

        const parsedIndex = attachHiddenMeta(
                {
                    name: indexName,
                    table: tableName,
                    columns,
                    expressions,
                    unique,
                    kind,
                    where: where || null,
                    position: { start: startPos, end: endPos },
                },
                'tableParts',
                tableNameInfo.parts,
            );
        if (indexNameInfo?.parts) attachHiddenMeta(parsedIndex, 'nameParts', indexNameInfo.parts);
        ast.indexes.push(parsedIndex);
    }

    function parseAlterIndex(alterToken) {
        consumeIfKeyword('INDEX');
        if (consumeIfKeyword('IF')) consumeIfKeyword('EXISTS');
        const oldNameInfo = parseQualifiedIdentifierInfo();
        if (!oldNameInfo?.name) return;

        if (!consumeIfKeyword('RENAME')) {
            while (peek() && !(peek().type === 'PUNC' && peek().value === ';')) next();
            if (peek()?.type === 'PUNC' && peek().value === ';') next();
            return;
        }
        consumeIfKeyword('TO');
        const parsedNewNameInfo = parseQualifiedIdentifierInfo();
        if (!parsedNewNameInfo?.name) return;
        let newParts = parsedNewNameInfo.parts;
        if (newParts.length === 1 && oldNameInfo.parts.length > 1) {
            newParts = [...oldNameInfo.parts.slice(0, -1), ...newParts];
        }
        const newName = qualifiedIdentifierName(newParts);
        let end = peek(-1)?.end || alterToken?.end || null;
        while (peek() && !(peek().type === 'PUNC' && peek().value === ';')) next();
        if (peek()?.type === 'PUNC' && peek().value === ';') end = next().end;
        const alter = {
            table: null,
            action: 'rename_index_global',
            oldName: oldNameInfo.name,
            newName,
            position: { start: alterToken?.start || null, end },
        };
        attachHiddenMeta(alter, 'oldNameParts', oldNameInfo.parts);
        attachHiddenMeta(alter, 'newNameParts', newParts);
        ast.alters.push(alter);
    }

    function parseRenameTable(renameToken) {
        consumeIfKeyword('TABLE');
        while (peek()) {
            const oldNameInfo = parseQualifiedIdentifierInfo();
            if (!oldNameInfo?.name || !consumeIfKeyword('TO')) break;
            const newNameInfo = parseQualifiedIdentifierInfo();
            if (!newNameInfo?.name) break;
            const alter = {
                table: oldNameInfo.name,
                action: 'rename_table',
                newName: newNameInfo.name,
                position: { start: renameToken?.start || null, end: peek(-1)?.end || renameToken?.end || null },
            };
            attachHiddenMeta(alter, 'tableParts', oldNameInfo.parts);
            attachHiddenMeta(alter, 'newTableParts', newNameInfo.parts);
            ast.alters.push(alter);
            if (!peek() || peek().type !== 'PUNC' || peek().value !== ',') break;
            next();
        }
        while (peek() && !(peek().type === 'PUNC' && peek().value === ';')) next();
        if (peek()?.type === 'PUNC' && peek().value === ';') next();
    }

    function identifierPartsFromSpRenameText(value) {
        const text = String(value || '').trim();
        const rawParts = [];
        let current = '';
        let quote = null;
        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            if (!quote && (char === '[' || char === '"' || char === '`')) {
                quote = char === '[' ? ']' : char;
                current += char;
                continue;
            }
            if (quote && char === quote) {
                current += char;
                quote = null;
                continue;
            }
            if (!quote && char === '.') {
                rawParts.push(current);
                current = '';
                continue;
            }
            current += char;
        }
        rawParts.push(current);
        return rawParts.map((rawPart) => {
            const raw = rawPart.trim();
            const bracketed = raw.startsWith('[') && raw.endsWith(']');
            const quoted = bracketed || ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith('`') && raw.endsWith('`')));
            const valueText = quoted ? raw.slice(1, -1) : raw;
            return { value: valueText.replace(bracketed ? /]]/g : /(["`])\1/g, '$1'), raw, quoted };
        }).filter((part) => part.value);
    }

    function parseSqlServerSpRename(execToken) {
        const procedureInfo = parseQualifiedIdentifierInfo();
        const procedureLeaf = procedureInfo?.parts?.at(-1)?.value?.toLowerCase();
        const statementTokens = [];
        while (peek() && !(peek().type === 'PUNC' && peek().value === ';')) statementTokens.push(next());
        let end = peek(-1)?.end || execToken?.end || null;
        if (peek()?.type === 'PUNC' && peek().value === ';') end = next().end;
        if (procedureLeaf !== 'sp_rename') return;

        const stringArguments = statementTokens.filter((token) => token.type === 'STRING').map((token) => String(token.value));
        const [objectName, newName, rawObjectType = 'OBJECT'] = stringArguments;
        if (!objectName || !newName) return;
        const objectParts = identifierPartsFromSpRenameText(objectName);
        const newParts = identifierPartsFromSpRenameText(newName);
        const objectType = rawObjectType.toUpperCase();
        if (objectParts.length === 0 || newParts.length === 0) return;

        const position = { start: execToken?.start || null, end };
        if (objectType === 'COLUMN' || objectType === 'INDEX') {
            if (objectParts.length < 2) return;
            const tableParts = objectParts.slice(0, -1);
            const oldPart = objectParts.at(-1);
            const newPart = newParts.at(-1);
            const alter = {
                table: qualifiedIdentifierName(tableParts),
                action: objectType === 'COLUMN' ? 'rename_column' : 'rename_index',
                oldName: oldPart.value,
                newName: newPart.value,
                position,
            };
            attachHiddenMeta(alter, 'tableParts', tableParts);
            attachHiddenMeta(alter, 'oldNameParts', [oldPart]);
            attachHiddenMeta(alter, 'newNameParts', [newPart]);
            ast.alters.push(alter);
            return;
        }

        let targetParts = newParts;
        if (newParts.length === 1 && objectParts.length > 1) targetParts = [...objectParts.slice(0, -1), ...newParts];
        const alter = {
            table: qualifiedIdentifierName(objectParts),
            action: 'rename_table',
            newName: qualifiedIdentifierName(targetParts),
            position,
        };
        attachHiddenMeta(alter, 'tableParts', objectParts);
        attachHiddenMeta(alter, 'newTableParts', targetParts);
        ast.alters.push(alter);
    }

    // ════════════════════════════════════════════════════════════════════
    //  SECTION H — Top-level dispatch loop
    // ════════════════════════════════════════════════════════════════════
    //  Walks the token stream and fires the right sub-parser for each
    //  top-level keyword. Statements we recognise:
    //
    //    CREATE TYPE …          → parseCreateType
    //    CREATE TABLE …         → parseCreateTable
    //    ALTER TABLE/INDEX …     → migration lifecycle metadata
    //    RENAME TABLE …          → MySQL table rename lifecycle metadata
    //    EXEC sp_rename …        → SQL Server table/column/index rename metadata
    //    DROP TABLE/TYPE/INDEX   → final-object lifecycle metadata
    //    GO                     → MSSQL batch separator, skip
    //    everything else        → consumed and ignored
    //
    //  Safety belt: `maxIter` caps the loop iterations to `2 × tokens`
    //  so a sub-parser that forgets to advance can never spin forever —
    //  it surfaces as the "Parser safety limit reached" error and the
    //  rest of the script still runs through the recovery path.
    // ════════════════════════════════════════════════════════════════════
    const maxIter = len * 2 + 100;
    let iterCount = 0;
    while (idx < len) {
        if (++iterCount > maxIter) {
            addError('Parser safety limit reached — input may be malformed');
            break;
        }
        const t = peek();
        if (!t) break;
        const tokenWord = (t.type === 'KW' || t.type === 'IDENT') ? String(t.value).toUpperCase() : '';
        if (tokenWord === 'EXEC' || tokenWord === 'EXECUTE') {
            const execToken = next();
            parseSqlServerSpRename(execToken);
            continue;
        }
        if (t.type === 'KW') {
            const up = String(t.value).toUpperCase();

            // MSSQL batch separator — silently skip
            if (up === 'GO') {
                next();
                continue;
            }

            if (up === 'CREATE') {
                const createToken = peek();
                next(); // consume CREATE
                consumeCreateOrReplace();
                const nextKW = peek();
                if (!nextKW) {
                    addWarning("Expected 'TYPE' or 'TABLE' after 'CREATE' but reached end of input", createToken);
                    continue;
                }

                const kwValue = nextKW.type === 'KW' ? String(nextKW.value).toUpperCase() : null;

                if (kwValue === 'TYPE') {
                    parseCreateType(createToken);
                    continue;
                }
                if (kwValue === 'TABLE') {
                    parseCreateTable(createToken);
                    continue;
                }
                // Table-level modifiers: CREATE [GLOBAL|LOCAL] [TEMP|TEMPORARY] TABLE / CREATE UNLOGGED TABLE
                // Look ahead through up to 3 modifier keywords for a 'TABLE' keyword and dispatch to parseCreateTable.
                if (kwValue === 'TEMP' || kwValue === 'TEMPORARY' || kwValue === 'UNLOGGED' || kwValue === 'GLOBAL' || kwValue === 'LOCAL') {
                    let lookahead = 0;
                    let foundTable = false;
                    while (lookahead < 3) {
                        const probe = peek(lookahead);
                        if (!probe || probe.type !== 'KW') break;
                        const v = String(probe.value).toUpperCase();
                        if (v === 'TABLE') {
                            foundTable = true;
                            break;
                        }
                        if (v !== 'TEMP' && v !== 'TEMPORARY' && v !== 'UNLOGGED' && v !== 'GLOBAL' && v !== 'LOCAL') break;
                        lookahead++;
                    }
                    if (foundTable) {
                        parseCreateTable(createToken);
                        continue;
                    }
                }

                // CREATE [UNIQUE] [CLUSTERED|NONCLUSTERED|COLUMNSTORE|FULLTEXT|SPATIAL] INDEX …
                // Look ahead through up to 4 modifier keywords for an `INDEX` token.
                if (
                    kwValue === 'INDEX' ||
                    kwValue === 'UNIQUE' ||
                    kwValue === 'CLUSTERED' ||
                    kwValue === 'NONCLUSTERED' ||
                    kwValue === 'COLUMNSTORE' ||
                    kwValue === 'FULLTEXT' ||
                    kwValue === 'SPATIAL'
                ) {
                    let probeIdx = 0;
                    let foundIndex = kwValue === 'INDEX';
                    while (!foundIndex && probeIdx < 4) {
                        const probe = peek(probeIdx);
                        if (!probe || probe.type !== 'KW') break;
                        const v = String(probe.value).toUpperCase();
                        if (v === 'INDEX') { foundIndex = true; break; }
                        if (v !== 'UNIQUE' && v !== 'CLUSTERED' && v !== 'NONCLUSTERED' &&
                            v !== 'COLUMNSTORE' && v !== 'FULLTEXT' && v !== 'SPATIAL') break;
                        probeIdx++;
                    }
                    if (foundIndex) {
                        parseCreateIndex(createToken);
                        continue;
                    }
                }

                // Skip non-table/type CREATE statements (SCHEMA, PROCEDURE, VIEW, etc.)
                while (peek() && !(peek().type === 'PUNC' && peek().value === ';')) next();
                if (peek() && peek().type === 'PUNC' && peek().value === ';') next();
                continue;
            }
            if (up === 'ALTER') {
                const alterToken = peek(); // Save ALTER token before consuming it
                next(); // consume ALTER
                const nextKW = peek();
                if (!nextKW) {
                    // Use the ALTER token for position info
                    addWarning("Expected 'TABLE' after 'ALTER' but reached end of input", alterToken);
                    continue;
                }
                const alterObjectKind = nextKW.type === 'KW' ? String(nextKW.value).toUpperCase() : null;
                if (alterObjectKind === 'INDEX') {
                    parseAlterIndex(alterToken);
                    continue;
                }
                if (alterObjectKind !== 'TABLE') {
                    addWarning(`Expected 'TABLE' or 'INDEX' after 'ALTER' but got ${nextKW.type} '${nextKW.value}'`, nextKW);
                    // skip until semicolon
                    while (peek() && !(peek().type === 'PUNC' && peek().value === ';')) next();
                    if (peek() && peek().type === 'PUNC' && peek().value === ';') next();
                    continue;
                }
                // Pass the ALTER token position to parseAlterTable
                parseAlterTable(alterToken);
                continue;
            }
            if (up === 'RENAME') {
                const renameToken = next();
                parseRenameTable(renameToken);
                continue;
            }
            if (up === 'DROP') {
                const dropToken = next();
                parseDropStatement(dropToken);
                continue;
            }
        }
        // skip anything else
        next();
    }

    // Post-parsing validation: Check foreign key references after all tables are parsed
    // Build set of table names for lookup (both full and unqualified for schema-aware matching)
    const tableNameSet = new Set();
    const addTableNameCandidate = (name) => {
        if (!name) return;
        tableNameSet.add(String(name).toLowerCase());
        const dot = String(name).lastIndexOf('.');
        if (dot >= 0) tableNameSet.add(String(name).substring(dot + 1).toLowerCase());
    };
    const alterRenameTargetName = (alter) => {
        if (!alter || alter.action !== 'rename_table' || !alter.newName) return null;
        const newParts = alter.newTableParts || [{ value: alter.newName }];
        if (newParts.length === 1 && alter.tableParts?.length > 1 && !String(newParts[0]?.value || '').includes('.')) {
            return qualifiedIdentifierName([...alter.tableParts.slice(0, -1), ...newParts]);
        }
        return qualifiedIdentifierName(newParts);
    };
    ast.tables.forEach((t) => {
        addTableNameCandidate(t.name);
    });
    ast.alters.forEach((alter) => {
        addTableNameCandidate(alterRenameTargetName(alter));
    });

    function refTableExists(refName) {
        if (!refName) return false;
        if (tableNameSet.has(refName.toLowerCase())) return true;
        const dot = refName.lastIndexOf('.');
        if (dot >= 0) return tableNameSet.has(refName.substring(dot + 1).toLowerCase());
        return false;
    }

    ast.tables.forEach((table) => {
        table.constraints.forEach((constraint) => {
            if (constraint && constraint.kind === 'foreign' && constraint.references) {
                if (!refTableExists(constraint.references.table)) {
                    addWarning(`FOREIGN KEY references table '${constraint.references.table}' which is not defined in this script. Ensure the table exists.`, constraint._token);
                }
            }
        });
        table.columns.forEach((column) => {
            if (!column || !column.name) return;
            if (column.references && column.references.table) {
                if (!refTableExists(column.references.table)) {
                    addWarning(`Column '${column.name}' references table '${column.references.table}' which is not defined in this script. Ensure the table exists.`, column._token);
                }
            }
        });
    });

    ast.alters.forEach((alter) => {
        if (alter && alter.action === 'add_foreign' && alter.references?.table) {
            if (!refTableExists(alter.references.table)) {
                const posToken = alter.position?.start ? { start: alter.position.start } : null;
                addWarning(`ALTER TABLE '${alter.table}' references table '${alter.references.table}' which is not defined in this script. Ensure the table exists.`, posToken);
            }
        }
    });

    attachHiddenMeta(ast, 'dialect', dialect);
    attachHiddenMeta(ast, 'dialectProfile', dialectProfile);
    attachHiddenMeta(ast, 'dialectConfidence', requestedDialect === 'auto' ? detectedDialect?.confidence || 'low' : 'explicit');
    attachHiddenMeta(ast, 'parseOptions', parseOptions);

    return { ast, errors: parseErrors };
}
