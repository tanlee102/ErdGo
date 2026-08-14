import { tokenize } from '@/lib/parse-ast/tokenize.js';

// Internal Data View runtime composition. External callers use sqlExecutor.js.
import { executeSelectQuery } from '@/features/query-view/lib/queryExecutor.js';
import { detectSqlDialectProfile, getSqlDialectProfile } from '@/lib/sqlDialectProfiles.js';
import { SUPPORTED_DATA_VIEW_WHERE_OPERATORS, unsupportedOperatorMessage } from './dataViewLanguage.js';
import { DEFAULT_SENTINEL, generateUuid, UUID_FN_NAMES } from './dataValues.js';
import {
    isSqliteBlobValue,
    sqliteBinaryCompare,
    sqliteColumnAffinity,
    sqliteNumericValue,
    sqliteStorageClassLabel,
    sqliteStorageCompare,
    sqliteStrictTypeFamily,
} from './sqliteSemantics.js';

/**
 * ════════════════════════════════════════════════════════════════════════════
 *  createSqlExecutor — in-memory SQL engine for the Data View
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  PURPOSE
 *  -------
 *  Powers the "Data View" tab: applies the user's DDL+DML script and returns
 *  the resulting tables, types, and an ordered execution log that drives the
 *  Tables / Types / Log UI panels. This is NOT a full SQL engine — it
 *  implements the subset needed for ERD validation and small-fixture data
 *  exploration.
 *
 *  SCOPE
 *  -----
 *  Supported statements (case-insensitive, all three dialects):
 *    DDL:  CREATE TABLE, ALTER TABLE (ADD/DROP/RENAME/MODIFY column,
 *          ADD CONSTRAINT), DROP TABLE, TRUNCATE TABLE,
 *          CREATE TYPE (ENUM | composite), DROP TYPE,
 *          CREATE [UNIQUE|FULLTEXT|SPATIAL] INDEX, DROP INDEX.
 *    DML:  INSERT INTO ... VALUES (...) [, (...), ...]   (multi-tuple),
 *          UPDATE ... SET ... [WHERE ...],
 *          DELETE FROM ... [WHERE ...] (including explicit ON DELETE CASCADE).
 *    Transactions: BEGIN / START TRANSACTION, COMMIT, ROLLBACK,
 *                  SAVEPOINT, ROLLBACK TO, RELEASE. SQLite/PostgreSQL and
 *                  SQL Server retain transactional DDL; MySQL DDL commits
 *                  the active transaction, matching its engine rule.
 *    Connection settings: SQLite `PRAGMA foreign_keys = ON|OFF` and MySQL
 *                         `SET FOREIGN_KEY_CHECKS = 1|0` affect later DML.
 *    Tolerated (no-op): USE, unrelated SET/PRAGMA statements, GO, COMMENT
 *                       ON, and unrecognised top-level statements.
 *
 *  Supported defaults / generators:
 *    • Auto-increment / SERIAL / BIGSERIAL / IDENTITY(seed, increment) /
 *      AUTO_INCREMENT — counter is stored on the table and bumped past any
 *      explicit numeric value the user inserts.
 *    • UUID-generating functions in DEFAULT and inline VALUES:
 *      gen_random_uuid(), uuid_generate_v1/3/4/5(), UUID(), NEWID(),
 *      NEWSEQUENTIALID(), SYS_GUID() — see UUID_FN_NAMES.
 *    • Time defaults: CURRENT_TIMESTAMP, NOW(), and GETDATE() resolve to an
 *      ISO timestamp; CURRENT_DATE and CURRENT_TIME resolve to SQL-shaped
 *      `YYYY-MM-DD` and `HH:MM:SS` values.
 *    • Boolean / NULL literals.
 *    • String, numeric, and quoted-string literals.
 *    • The `DEFAULT` keyword inside VALUES(...) — DEFAULT_SENTINEL signals
 *      "use the column's declared default (or auto-increment)".
 *
 *  Supported WHERE expression grammar:
 *    chained AND/OR with SQL precedence and parenthesized groups,
 *    `=  !=  <>  <  <=  >  >=`, `IN (...)`, `NOT IN (...)`, `BETWEEN x AND y`,
 *    `NOT BETWEEN x AND y`, `LIKE 'pattern'`, `ILIKE 'pattern'`,
 *    `NOT LIKE 'pattern'`, `NOT ILIKE 'pattern'` (`%` and `_` wildcards),
 *    `IS NULL`, `IS NOT NULL`, `IS TRUE/FALSE/UNKNOWN`,
 *    `IS [NOT] DISTINCT FROM`.
 *
 *  SQL-STANDARD SEMANTICS (notable)
 *  --------------------------------
 *  • NULL participates in three-valued logic. `col = NULL`, `col != NULL`,
 *    `col > NULL`, `col IN (NULL, 1)` against NULL data, etc. all yield
 *    UNKNOWN → false in WHERE. Explicit `IS` predicates and
 *    `IS [NOT] DISTINCT FROM` provide NULL-safe checks.
 *  • Composite PRIMARY KEY (a, b) checks tuple uniqueness — `(1, 2)` and
 *    `(1, 3)` are NOT a duplicate. Same for composite UNIQUE constraints
 *    (stored separately on `table.compositeUniques`).
 *  • Single-column unique flag is only set when the constraint is itself
 *    single-column, so composite uniques don't generate spurious
 *    "duplicate value in column X" warnings.
 *  • Identifier resolution is case-insensitive for INSERT column lists,
 *    UPDATE/DELETE table targets, and column lookups.
 *
 *  ARCHITECTURE
 *  ------------
 *  1. The user script is tokenized once with `tokenize(sql, ...)` from the
 *     shared tokenizer. The same `extendedKeywords` list ensures DML keywords
 *     are correctly classified as `KW` rather than `IDENT`.
 *  2. A statement-boundary scanner walks the token stream, tracking paren
 *     depth, and produces an array of `{ startIdx, kind: 'ddl' | 'dml' }`
 *     entries. Boundaries are `;`, `GO`, or any RECOVERY_STARTERS keyword
 *     seen at depth 0 — so an unterminated CREATE doesn't hang the rest.
 *  3. DDL is executed in document order. DML whose target table doesn't yet
 *     exist is *deferred* and retried after every DDL has run, so scripts
 *     that interleave INSERTs above their CREATE TABLEs still work
 *     (mirrors how pg_dump emits dependency-ordered chunks).
 *  4. Every executed statement appends one or more `{ type, message,
 *     timestamp }` entries to `executionLog`. UI renders the log with
 *     severity-coded badges. Severities: `success`, `warning`, `error`.
 *
 *  RETURN SHAPE (frozen contract)
 *  ------------------------------
 *  createSqlExecutor({ dialect?: 'auto' | 'sqlite' | 'postgres' |
 *                      'mysql' | 'mssql' }) → {
 *    execute(sql):     runs the script, returns { tables, types, log },
 *    tables:           Map<string, Table> — keyed by the cleaned (un-quoted)
 *                                            declared name. Lookups should go
 *                                            through `findTable(name)` which
 *                                            is case-insensitive and strips
 *                                            schema prefixes,
 *    types:            Map<string, Type>  — keyed by the cleaned declared
 *                                            type name (case-preserving),
 *    executionLog:     Array<{ type: 'success'|'warning'|'error',
 *                              message: string, timestamp: number }>
 *  }
 *
 *  INVARIANTS
 *  ----------
 *  • execute() never throws on user input — all failures surface in
 *    executionLog.
 *  • Empty / whitespace-only / non-string input returns the current state
 *    unchanged with no log entries.
 *  • Re-running CREATE TABLE for an existing name emits a warning, replaces
 *    the definition, and reports how many rows were preserved.
 *  • TRUNCATE resets the auto-increment counter to its declared seed.
 */
export function createSqlExecutor(options = {}) {
    const configuredDialectProfile = getSqlDialectProfile(options?.dialect);
    let dialectProfile = configuredDialectProfile;
    const tables = new Map();
    const types = new Map();
    const executionLog = [];
    let transactionState = null;
    // A Data View executor represents one database connection. Keep the
    // connection-level FK switch here (rather than on every table) because
    // SQLite's PRAGMA and MySQL's FOREIGN_KEY_CHECKS affect later DML in the
    // same session. `null` means "use this dialect's native default".
    let foreignKeyEnforcement = null;

    // Anchor for any log entry that doesn't supply its own position. Set
    // at the top of `executeStatement` to the first token of the current
    // statement, so per-statement diagnostics ("table does not exist",
    // "PK collision", "missing VALUES keyword", …) all jump the editor
    // to the correct CREATE / INSERT / ALTER line by default — without
    // forcing every callsite to thread a token through.
    let currentStatementToken = null;

    /**
     * Append one entry to the execution log.
     *
     * @param {string} type     'success' | 'warning' | 'error' | 'info'
     * @param {string} message  Human-readable diagnostic.
     * @param {object|null} positionSource
     *      Optional anchor for the diagnostic. Accepted shapes:
     *        • A token from `tokenize()`:    `{ start: { idx, line, col } }`
     *        • A {start, end} pair (statements): `{ start: { idx, line, col } }`
     *        • A pre-built `{ line, column, index }` position object.
     *      When omitted, falls back to the current statement's start
     *      token so the entry still anchors at the right SQL line.
     */
    function log(type, message, positionSource = null) {
        const entry = { type, message, timestamp: Date.now() };
        const pos = toPosition(positionSource) || toPosition(currentStatementToken);
        if (pos) entry.position = pos;
        executionLog.push(entry);

        // PostgreSQL has a deliberately strict transaction rule: one ERROR
        // aborts the current transaction and every ordinary statement is
        // rejected until ROLLBACK (or ROLLBACK TO a savepoint). Recording the
        // state at the common diagnostic boundary keeps parser errors,
        // constraint errors, and query-evaluation errors consistent.
        if (type === 'error' && transactionState && dialectProfile.id === 'postgres') {
            transactionState.aborted = true;
        }
    }

    // Normalize a positionSource into the public `{ line, column, index }`
    // contract the editor's gutter / Monaco markers consume. Returns null
    // when nothing positional is recoverable so callers can omit the field.
    function toPosition(src) {
        if (!src) return null;
        // Already in the public shape — accept verbatim.
        if (typeof src.line === 'number' && typeof src.column === 'number') {
            return {
                line: src.line ?? 1,
                column: src.column ?? 1,
                index: src.index ?? 0,
            };
        }
        // Tokenizer shape: `{ start: { idx, line, col } }`.
        if (src.start && typeof src.start === 'object') {
            return {
                line: src.start.line ?? 1,
                column: src.start.col ?? 1,
                index: src.start.idx ?? 0,
            };
        }
        return null;
    }

    function execute(sql) {
        if (typeof sql !== 'string' || !sql.trim()) return { tables, types, log: executionLog };

        // Automatic selection is intentionally conservative. It applies only
        // to scripts with a strong native marker; portable SQL keeps the
        // existing neutral behavior unless a caller requests a profile.
        if (configuredDialectProfile.id === 'auto') {
            const detected = detectSqlDialectProfile(sql);
            if (detected.confidence === 'high') dialectProfile = detected.profile;
        }

        const extendedKeywords = [
            'CREATE',
            'TABLE',
            'VIEW',
            'MATERIALIZED',
            'ALGORITHM',
            'ALTER',
            'DROP',
            'OR',
            'REPLACE',
            'IF',
            'EXISTS',
            'NOT',
            'NULL',
            'PRIMARY',
            'KEY',
            'FOREIGN',
            'REFERENCES',
            'UNIQUE',
            'CHECK',
            'DEFAULT',
            'CONSTRAINT',
            'ADD',
            'TYPE',
            'AS',
            'ENUM',
            'ONLY',
            'TEMP',
            'TEMPORARY',
            'GLOBAL',
            'UNLOGGED',
            'DEFINER',
            'SQL',
            'SECURITY',
            'INVOKER',
            'UNDEFINED',
            'MERGE',
            'TEMPTABLE',
            'LOCAL',
            'CASCADED',
            'OPTION',
            'DATA',
            'NO',
            'SCHEMABINDING',
            'ENCRYPTION',
            'VIEW_METADATA',
            'INSERT',
            'INTO',
            'VALUES',
            'UPDATE',
            'SET',
            'PRAGMA',
            'DELETE',
            'FROM',
            'WHERE',
            'SELECT',
            'DISTINCT',
            'AND',
            'OR',
            'IN',
            'BETWEEN',
            'LIKE',
            'ILIKE',
            'IS',
            'TRUE',
            'FALSE',
            'UNKNOWN',
            'ON',
            'CASCADE',
            'RESTRICT',
            'ACTION',
            'DEFERRABLE',
            'DEFERRED',
            'IMMEDIATE',
            'INITIALLY',
            'GENERATED',
            'ALWAYS',
            'STORED',
            'VIRTUAL',
            'BY',
            'AUTO_INCREMENT',
            'IDENTITY',
            'COMMENT',
            'CHARSET',
            'COLLATE',
            'INDEX',
            'USING',
            'CONCURRENTLY',
            'INCLUDE',
            'WITH',
            'TABLESPACE',
            'BTREE',
            'HASH',
            'GIST',
            'GIN',
            'FULLTEXT',
            'SPATIAL',
            'CLUSTERED',
            'NONCLUSTERED',
            'GO',
            'BEGIN',
            'START',
            'TRANSACTION',
            'WORK',
            'COMMIT',
            'ROLLBACK',
            'SAVEPOINT',
            'RELEASE',
            'TRUNCATE',
            'COLUMN',
            'MODIFY',
            'CHANGE',
            'RENAME',
            'TO',
            'DATA',
            'INT',
            'INTEGER',
            'BIGINT',
            'SMALLINT',
            'SERIAL',
            'BIGSERIAL',
            'SMALLSERIAL',
            'TEXT',
            'VARCHAR',
            'CHAR',
            'BOOLEAN',
            'BOOL',
            'DATE',
            'TIME',
            'TIMESTAMP',
            'NUMERIC',
            'DECIMAL',
            'REAL',
            'FLOAT',
            'JSON',
            'JSONB',
            'UUID',
            'BYTEA',
            'MONEY',
            'TINYINT',
            'MEDIUMINT',
            'NVARCHAR',
            'NCHAR',
            'DATETIME',
            'DATETIME2',
            'BIT',
            'VARBINARY',
            'IMAGE',
            'XML',
            'DOUBLE',
            'PRECISION',
            'UNSIGNED',
            'SIGNED',
            'YEAR',
            'NOW',
            'CURRENT_TIMESTAMP',
            'CURRENT_DATE',
            'CURRENT_TIME',
            'NEXTVAL',
            'CURRVAL',
            'GETDATE',
            'NEWID',
            'NEWSEQUENTIALID',
            'GEN_RANDOM_UUID',
            'UUID_GENERATE_V1',
            'UUID_GENERATE_V3',
            'UUID_GENERATE_V4',
            'UUID_GENERATE_V5',
            'SYS_GUID',

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
        ];

        const { tokens, errors: tokenErrors } = tokenize(sql, {
            lowercaseIdentifiers: false,
            skipComments: true,
            keywords: extendedKeywords,
        });

        // Tokenizer recovery deliberately returns a best-effort token stream
        // for the ERD editor. The Data View must be stricter: an unterminated
        // literal/comment must be visible as an execution error and must not
        // be silently inserted as though it were complete SQL.
        const lexicalErrors = tokenErrors.filter((error) => error?.severity !== 'warning');
        lexicalErrors.forEach((error) => log('error', `SQL syntax error: ${error.message}`, error));

        let idx = 0;
        const len = tokens.length;

        // Transaction snapshots deliberately clone the executor state rather
        // than merely keeping row-array references. DDL can mutate columns,
        // indexes, types and auto-increment counters in place, all of which
        // must be restored by ROLLBACK / ROLLBACK TO SAVEPOINT.
        function cloneTransactionValue(value) {
            if (value instanceof Uint8Array) return new Uint8Array(value);
            if (value instanceof ArrayBuffer) return value.slice(0);
            if (Array.isArray(value)) return value.map((item) => cloneTransactionValue(item));
            if (value && typeof value === 'object') return { ...value };
            return value;
        }

        function cloneTableForTransaction(table) {
            return {
                ...table,
                columns: (table.columns || []).map((column) => ({
                    ...column,
                    enumValues: Array.isArray(column.enumValues) ? [...column.enumValues] : column.enumValues,
                    refColumns: Array.isArray(column.refColumns) ? [...column.refColumns] : column.refColumns,
                    generatedExpr: Array.isArray(column.generatedExpr) ? [...column.generatedExpr] : column.generatedExpr,
                })),
                rows: (table.rows || []).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, cloneTransactionValue(value)]))),
                _autoInc: table._autoInc instanceof Map
                    ? new Map(Array.from(table._autoInc, ([key, value]) => [key, { ...value }]))
                    : table._autoInc,
                indexes: (table.indexes || []).map((index) => ({
                    ...index,
                    columns: Array.isArray(index.columns) ? [...index.columns] : index.columns,
                    include: Array.isArray(index.include) ? [...index.include] : index.include,
                })),
                compositePk: Array.isArray(table.compositePk) ? [...table.compositePk] : table.compositePk,
                compositeUniques: (table.compositeUniques || []).map((unique) => ({ ...unique, cols: Array.isArray(unique.cols) ? [...unique.cols] : unique.cols })),
                foreignKeys: (table.foreignKeys || []).map((foreignKey) => ({
                    ...foreignKey,
                    columns: Array.isArray(foreignKey.columns) ? [...foreignKey.columns] : foreignKey.columns,
                    refColumns: Array.isArray(foreignKey.refColumns) ? [...foreignKey.refColumns] : foreignKey.refColumns,
                })),
                checks: (table.checks || []).map((check) => ({ ...check, expression: Array.isArray(check.expression) ? [...check.expression] : check.expression })),
            };
        }

        function snapshotTransactionState() {
            return {
                tables: new Map(Array.from(tables, ([name, table]) => [name, cloneTableForTransaction(table)])),
                types: new Map(Array.from(types, ([name, type]) => [name, {
                    ...type,
                    values: Array.isArray(type.values) ? [...type.values] : type.values,
                    fields: Array.isArray(type.fields) ? type.fields.map((field) => ({ ...field })) : type.fields,
                }])),
            };
        }

        function restoreTransactionState(snapshot) {
            // Sequences / identity / auto-increment generators are not
            // transactional in PostgreSQL, MySQL and SQL Server. Retain the
            // current counter for a table that existed at the rollback point,
            // while SQLite deliberately restores its counter with the rest of
            // the transaction state.
            const nonTransactionalCounters = new Map(Array.from(tables, ([name, table]) => [
                name.toLowerCase(),
                table?.dialect === 'sqlite' || !(table?._autoInc instanceof Map)
                    ? null
                    : new Map(Array.from(table._autoInc, ([key, value]) => [key, { ...value }])),
            ]));
            tables.clear();
            types.clear();
            for (const [name, table] of snapshot.tables) {
                const restoredTable = cloneTableForTransaction(table);
                const retainedCounter = nonTransactionalCounters.get(name.toLowerCase());
                if (restoredTable.dialect !== 'sqlite' && retainedCounter) restoredTable._autoInc = retainedCounter;
                tables.set(name, restoredTable);
            }
            for (const [name, type] of snapshot.types) {
                types.set(name, {
                    ...type,
                    values: Array.isArray(type.values) ? [...type.values] : type.values,
                    fields: Array.isArray(type.fields) ? type.fields.map((field) => ({ ...field })) : type.fields,
                });
            }
        }

        function peek(off = 0) {
            const t = idx + off;
            return t >= 0 && t < len ? tokens[t] : null;
        }
        function next() {
            const t = peek();
            if (t) idx++;
            return t;
        }
        function isKW(val) {
            const t = peek();
            return t && t.type === 'KW' && t.value.toUpperCase() === val.toUpperCase();
        }
        function consumeKW(val) {
            if (isKW(val)) {
                next();
                return true;
            }
            return false;
        }
        function isWordToken(token, val) {
            return !!(token && (token.type === 'KW' || token.type === 'IDENT') && String(token.value).toUpperCase() === val.toUpperCase());
        }
        function consumeWord(val) {
            if (isWordToken(peek(), val)) {
                next();
                return true;
            }
            return false;
        }
        function isKeywordAt(off, val) {
            const t = peek(off);
            return !!(t && t.type === 'KW' && t.value.toUpperCase() === val.toUpperCase());
        }
        function consumeCreateMode() {
            if (isKeywordAt(0, 'OR') && isKeywordAt(1, 'REPLACE')) {
                next();
                next();
                return 'replace';
            }
            if (isKeywordAt(0, 'OR') && isKeywordAt(1, 'ALTER')) {
                next();
                next();
                return 'alter';
            }
            return null;
        }
        function parseIdent() {
            const t = peek();
            if (!t) return null;
            if (t.type === 'IDENT' || t.type === 'STRING') return String(next().value);
            if (t.type === 'KW') {
                const tok = next();
                return String(tok.raw || tok.value);
            }
            return null;
        }
        function parseQualifiedIdent() {
            // Accept any number of dotted parts (db.schema.table, schema.table,
            // table) and return the last segment as the effective object name.
            let last = parseIdent();
            if (!last) return null;
            while (peek() && peek().type === 'PUNC' && peek().value === '.') {
                next();
                const part = parseIdent();
                if (!part) break;
                last = part;
            }
            return last;
        }
        function skipToSemicolon() {
            // Stop at the next `;` OR at the start of a new top-level statement.
            // Without the strong-anchor check, a missing terminator (e.g. an
            // unclosed clause inside the previous statement) would consume the
            // entire rest of the script, hiding every later CREATE / ALTER /
            // INSERT from the parser.
            while (peek()) {
                const t = peek();
                if (t.type === 'PUNC' && t.value === ';') break;
                if (isStrongStatementAnchor(idx)) break;
                next();
            }
            if (peek() && peek().type === 'PUNC' && peek().value === ';') next();
        }

        // ════════════════════════════════════════════════════════════════
        //  Strong statement anchors — for cross-statement error recovery
        // ════════════════════════════════════════════════════════════════
        //  Two-keyword combinations that unambiguously start a new top-level
        //  statement in our supported subset and CANNOT appear inside a
        //  CREATE TABLE / ALTER TABLE / CREATE TYPE body:
        //
        //    CREATE [OR REPLACE|OR ALTER] [GLOBAL|LOCAL|TEMP|TEMPORARY|
        //            UNLOGGED|UNIQUE|FULLTEXT|SPATIAL|CLUSTERED|
        //            NONCLUSTERED|CONCURRENTLY]*
        //           (TABLE | TYPE | INDEX)
        //    ALTER  TABLE
        //    DROP   (TABLE | TYPE | INDEX)
        //    TRUNCATE TABLE
        //
        //  When the boundary scanner — or the inner CREATE TABLE body loop —
        //  encounters one of these even while paren depth > 0, the previous
        //  statement is considered terminated. This mirrors parseAst.js's
        //  anchor recovery (see `Found new 'CREATE'` at parseAst.js:772-780)
        //  so a single broken statement can never sink the rest of a script.
        //
        //  INSERT / UPDATE / DELETE / DROP / TRUNCATE alone are intentionally
        //  NOT strong anchors at depth > 0 — they appear as positional
        //  keywords inside other statements (e.g. `ON DELETE CASCADE`,
        //  `ON UPDATE RESTRICT`). At depth 0 they're already handled via the
        //  RECOVERY_STARTERS check below.
        // ════════════════════════════════════════════════════════════════
        const STRONG_CREATE_MODIFIERS = new Set([
            'GLOBAL', 'LOCAL', 'TEMP', 'TEMPORARY', 'UNLOGGED',
            'UNIQUE', 'FULLTEXT', 'SPATIAL', 'CLUSTERED', 'NONCLUSTERED',
            'CONCURRENTLY', 'COLUMNSTORE', 'OR', 'REPLACE', 'ALTER', 'MATERIALIZED',
            'ALGORITHM', 'DEFINER', 'SQL', 'SECURITY',
        ]);
        const STRONG_CREATE_TARGETS = new Set(['TABLE', 'TYPE', 'INDEX', 'VIEW']);
        const STRONG_DROP_TARGETS = new Set(['TABLE', 'TYPE', 'INDEX', 'VIEW']);

        function isStrongStatementAnchor(at, opts = {}) {
            // `allowDrop` (default true) treats `DROP TABLE/TYPE/INDEX` as a
            // strong anchor. Disable it inside ALTER's body (and inside the
            // boundary scanner) because `ALTER TABLE t DROP INDEX foo` /
            // `DROP CONSTRAINT pk_t` / `DROP COLUMN c` are legitimate ALTER
            // subactions that look identical to a top-level `DROP INDEX foo`.
            // Without this guard, the boundary scanner would silently cut
            // every ALTER short at its first DROP subaction.
            const allowDrop = opts.allowDrop !== false;
            const a = at >= 0 && at < len ? tokens[at] : null;
            if (!a || a.type !== 'KW') return false;
            const ka = String(a.value).toUpperCase();

            if (ka === 'CREATE') {
                // Walk forward across optional modifiers (up to 4) looking for
                // a TABLE/TYPE/INDEX keyword. If we see anything else first,
                // this is not a recoverable anchor (e.g. CREATE SCHEMA, CREATE
                // PROCEDURE — those don't appear inside table bodies anyway,
                // but we stay strict to keep false positives at zero).
                for (let k = 1; k <= 5 && at + k < len; k++) {
                    const b = tokens[at + k];
                    if (!b || b.type !== 'KW') return false;
                    const kb = String(b.value).toUpperCase();
                    if (STRONG_CREATE_TARGETS.has(kb)) return true;
                    if (!STRONG_CREATE_MODIFIERS.has(kb)) return false;
                }
                return false;
            }
            if (ka === 'ALTER') {
                const b = at + 1 < len ? tokens[at + 1] : null;
                return !!(b && b.type === 'KW' && String(b.value).toUpperCase() === 'TABLE');
            }
            if (ka === 'DROP' && allowDrop) {
                const b = at + 1 < len ? tokens[at + 1] : null;
                return !!(b && b.type === 'KW' && STRONG_DROP_TARGETS.has(String(b.value).toUpperCase()));
            }
            if (ka === 'TRUNCATE') {
                // TRUNCATE only ever starts a statement in our subset; the
                // optional TABLE keyword is handled by parseTruncate itself.
                return true;
            }
            return false;
        }

        function stripSchema(name) {
            if (!name) return name;
            const dot = name.lastIndexOf('.');
            return dot >= 0 ? name.substring(dot + 1) : name;
        }

        function findTable(name) {
            if (!name) return null;
            const clean = stripSchema(name).toLowerCase();
            for (const [key, val] of tables) {
                if (key.toLowerCase() === clean) return val;
            }
            return null;
        }

        function findColumn(table, colName) {
            if (!table || !colName) return null;
            return table.columns.find((c) => c.name.toLowerCase() === colName.toLowerCase());
        }

        function readParenList() {
            if (!(peek() && peek().type === 'PUNC' && peek().value === '(')) return null;
            next();
            const items = [];
            let depth = 1;
            while (peek()) {
                const t = peek();
                if (t.type === 'PUNC' && t.value === ')') {
                    depth--;
                    if (depth === 0) {
                        next();
                        break;
                    }
                }
                if (t.type === 'PUNC' && t.value === '(') depth++;
                if (t.type === 'PUNC' && t.value === ',' && depth === 1) {
                    next();
                    continue;
                }
                if (depth === 1 && (t.type === 'IDENT' || t.type === 'KW' || t.type === 'STRING')) {
                    // Use .value to get the unquoted identifier/string content.
                    // Using .raw would keep surrounding backticks/brackets/quotes
                    // (e.g. `CorsoID`) and break downstream column lookups.
                    items.push(t.value);
                }
                next();
            }
            return items;
        }

        function skipParens() {
            if (!(peek() && peek().type === 'PUNC' && peek().value === '(')) return;
            next();
            let depth = 1;
            while (peek() && depth > 0) {
                const t = next();
                if (t.type === 'PUNC' && t.value === '(') depth++;
                if (t.type === 'PUNC' && t.value === ')') depth--;
            }
        }

        // Read a parenthesized SQL expression without interpreting it.  CHECK
        // expressions are evaluated later against the candidate row, after
        // defaults, affinity and generated columns have been resolved.
        function readParenExpression() {
            if (!(peek() && peek().type === 'PUNC' && peek().value === '(')) return null;
            next();
            const expression = [];
            let depth = 1;
            while (peek() && depth > 0) {
                const token = next();
                if (token.type === 'PUNC' && token.value === '(') {
                    depth++;
                    expression.push(token);
                    continue;
                }
                if (token.type === 'PUNC' && token.value === ')') {
                    depth--;
                    if (depth === 0) break;
                }
                expression.push(token);
            }
            return expression;
        }

        // ════════════════════════════════════════════════════════════════
        //  CREATE TYPE — ENUM and composite user-defined types
        // ════════════════════════════════════════════════════════════════
        //  Stores the type in `types` map keyed by cleaned name. Two kinds:
        //
        //    CREATE TYPE mood AS ENUM ('sad', 'happy');
        //         → { kind: 'enum', name, values: string[] }
        //
        //    CREATE TYPE address AS (street TEXT, zip INT);
        //         → { kind: 'composite', name, fields: [{name, type}, …] }
        //
        //  The renderer / DML use this map to (a) validate INSERT values
        //  against an ENUM's allowed set and (b) display ENUM badges in
        //  the table view. Re-declaring a type emits a warning.
        // ════════════════════════════════════════════════════════════════

        function parseCreateType() {
            consumeKW('TYPE');
            const typeName = parseQualifiedIdent();
            if (!typeName) {
                skipToSemicolon();
                return;
            }
            const cleanName = stripSchema(typeName);

            if (!consumeKW('AS')) {
                skipToSemicolon();
                return;
            }

            if (isKW('ENUM')) {
                next();
                const values = readEnumValues();
                types.set(cleanName, { kind: 'enum', name: cleanName, values });
                log('success', `Type "${cleanName}" created as ENUM (${values.length} values)`);
                if (peek() && peek().type === 'PUNC' && peek().value === ';') next();
                return;
            }

            // Composite type: CREATE TYPE name AS (field type, ...)
            if (peek() && peek().type === 'PUNC' && peek().value === '(') {
                next();
                const fields = [];
                let depth = 1;
                let entryTokens = [];
                let unclosedParens = false;

                while (peek()) {
                    const t = peek();
                    // Cross-statement recovery — see CREATE TABLE for rationale.
                    if (t.type === 'PUNC' && t.value === ';' && depth > 0) {
                        log('error', `CREATE TYPE "${cleanName}": unclosed parenthesis (depth ${depth}). Found ';' before the matching ')'.`);
                        unclosedParens = true;
                        next();
                        break;
                    }
                    if (depth > 0 && isStrongStatementAnchor(idx)) {
                        log('error', `CREATE TYPE "${cleanName}": unclosed parenthesis (depth ${depth}). Found new '${String(t.value).toUpperCase()}' before the matching ')'.`);
                        unclosedParens = true;
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
                            next();
                            break;
                        }
                        entryTokens.push(next());
                        continue;
                    }
                    if (t.type === 'PUNC' && t.value === ',' && depth === 1) {
                        if (entryTokens.length >= 2) {
                            const fName = entryTokens[0].raw || entryTokens[0].value;
                            const fType = entryTokens
                                .slice(1)
                                .map((x) => x.value)
                                .join(' ')
                                .trim();
                            fields.push({ name: fName, type: fType });
                        }
                        entryTokens = [];
                        next();
                        continue;
                    }
                    entryTokens.push(next());
                }
                if (!unclosedParens && entryTokens.length >= 2) {
                    const fName = entryTokens[0].raw || entryTokens[0].value;
                    const fType = entryTokens
                        .slice(1)
                        .map((x) => x.value)
                        .join(' ')
                        .trim();
                    fields.push({ name: fName, type: fType });
                }

                types.set(cleanName, { kind: 'composite', name: cleanName, fields });
                log('success', `Type "${cleanName}" created as COMPOSITE (${fields.length} fields)`);
                if (peek() && peek().type === 'PUNC' && peek().value === ';') next();
                return;
            }

            skipToSemicolon();
        }

        function readEnumValues() {
            if (!(peek() && peek().type === 'PUNC' && peek().value === '(')) return [];
            next();
            const values = [];
            let depth = 1;
            while (peek() && depth > 0) {
                const t = peek();
                if (t.type === 'PUNC' && t.value === ')') {
                    depth--;
                    next();
                    break;
                }
                if (t.type === 'PUNC' && t.value === '(') {
                    depth++;
                    next();
                    continue;
                }
                if (t.type === 'PUNC' && t.value === ',' && depth === 1) {
                    next();
                    continue;
                }
                if (t.type === 'STRING') values.push(t.value);
                next();
            }
            return values;
        }

        function findType(name) {
            if (!name) return null;
            const clean = stripSchema(name).toLowerCase();
            for (const [key, val] of types) {
                if (key.toLowerCase() === clean) return val;
            }
            return null;
        }

        // ════════════════════════════════════════════════════════════════
        //  CREATE TABLE — column + constraint parsing
        // ════════════════════════════════════════════════════════════════
        //  This is the longest function in the file. It parses the
        //  comma-separated entries inside `CREATE TABLE name (...)`,
        //  classifying each entry as one of:
        //    • column definition          → push to `columns[]`
        //    • bare PK / UQ / FK / CHECK  → table-level constraint
        //    • CONSTRAINT name … (…)      → named constraint
        //    • MySQL bare KEY / INDEX     → skipped (no rows-affecting
        //      effect; index is registered separately for the indexes UI)
        //
        //  Resulting `Table` shape (frozen contract — DML reads these):
        //    {
        //      name:             string (case-preserved declared name),
        //      columns:          Array<Column>,
        //      rows:             Array<Row>,
        //      _autoInc:         { [colName]: nextValue },
        //      indexes:          Array<{ name, cols, unique?, kind? }>,
        //      compositePk:      string[]    // empty / single → []
        //                                     // n>1 → tuple-uniqueness key
        //      compositeUniques: Array<{ name?, cols: string[] }>,
        //      foreignKeys:      Array<{ columns, refTable, refColumns,
        //                              onDelete?, onUpdate?, name? }>,
        //    }
        //
        //  Re-running CREATE TABLE for an existing name PRESERVES the rows
        //  by carrying `existing.rows` over to the new definition (any
        //  newly-introduced NOT NULL columns will simply hold `undefined`
        //  on those rows — the next INSERT validates as usual).
        // ════════════════════════════════════════════════════════════════

        const CONSTRAINT_STARTS = new Set(['PRIMARY', 'UNIQUE', 'FOREIGN', 'CONSTRAINT', 'CHECK', 'KEY', 'INDEX', 'FULLTEXT', 'SPATIAL']);

        const COL_STOP_KW = new Set(['PRIMARY', 'UNIQUE', 'NOT', 'NULL', 'DEFAULT', 'CHECK', 'REFERENCES', 'CONSTRAINT', 'GENERATED', 'AUTO_INCREMENT', 'AUTOINCREMENT', 'IDENTITY', 'COMMENT', 'CHARSET', 'COLLATE', 'ON']);

        function tokenWordValue(token) {
            return token && (token.type === 'KW' || token.type === 'IDENT') ? String(token.value || token.raw || '').toUpperCase() : '';
        }

        function isCharacterSetOptionStartAt(toks, p) {
            const word = tokenWordValue(toks[p]);
            if (word === 'CHARSET') return true;
            return word === 'CHARACTER' && tokenWordValue(toks[p + 1]) === 'SET';
        }

        function isColumnTypeOptionStartAt(toks, p) {
            const t = toks[p];
            if (isCharacterSetOptionStartAt(toks, p)) return true;
            return t?.type === 'KW' && COL_STOP_KW.has(String(t.value).toUpperCase());
        }

        function consumeCreateTableModifiers() {
            let consumed = true;
            while (consumed) {
                consumed =
                    consumeKW('GLOBAL') ||
                    consumeKW('LOCAL') ||
                    consumeKW('TEMPORARY') ||
                    consumeKW('TEMP') ||
                    consumeKW('UNLOGGED');
            }
        }

        function parseCreateTable({ orReplace = false } = {}) {
            consumeCreateTableModifiers();
            consumeKW('TABLE');
            if (consumeKW('IF')) {
                consumeKW('NOT');
                consumeKW('EXISTS');
            }
            consumeKW('ONLY');

            const tableName = parseQualifiedIdent();
            if (!tableName) {
                skipToSemicolon();
                return;
            }
            const cleanName = stripSchema(tableName);

            if (!peek() || !(peek().type === 'PUNC' && peek().value === '(')) {
                skipToSemicolon();
                return;
            }
            next();

            const columns = [];
            const pendingConstraints = [];
            let depth = 1;
            let entryTokens = [];
            let unclosedParens = false;

            while (peek()) {
                const t = peek();

                // ── Cross-statement recovery anchors (mirrors parseAst.js:772-780).
                //    A `;` at depth > 0, or a fresh top-level statement keyword
                //    (CREATE TABLE / ALTER TABLE / DROP / TRUNCATE) at depth > 0,
                //    means the user forgot a `)`. Bail out of the table body so
                //    the *next* statement can still parse instead of being
                //    silently consumed by this broken one.
                if (t.type === 'PUNC' && t.value === ';' && depth > 0) {
                    log('error', `CREATE TABLE "${cleanName}": unclosed parenthesis (depth ${depth}). Found ';' before the matching ')'. Check for a missing ')'.`);
                    unclosedParens = true;
                    next();
                    break;
                }
                if (depth > 0 && isStrongStatementAnchor(idx)) {
                    log('error', `CREATE TABLE "${cleanName}": unclosed parenthesis (depth ${depth}). Found new '${String(t.value).toUpperCase()}' before the matching ')'. Check for a missing ')'.`);
                    unclosedParens = true;
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
                        next();
                        break;
                    }
                    entryTokens.push(next());
                    continue;
                }
                if (t.type === 'PUNC' && t.value === ',' && depth === 1) {
                    if (entryTokens.length > 0) processEntry(entryTokens, columns, pendingConstraints);
                    entryTokens = [];
                    next();
                    continue;
                }
                entryTokens.push(next());
            }
            // Flush the last entry only when the body actually closed cleanly —
            // a half-parsed entry from an unclosed-paren table is more confusing
            // than helpful (it tries to interpret garbage as a column).
            if (!unclosedParens && entryTokens.length > 0) processEntry(entryTokens, columns, pendingConstraints);

            // Consume trailing table options before the semicolon:
            //   SQLite:  WITHOUT ROWID, STRICT
            //   MySQL:   ENGINE=InnoDB, DEFAULT CHARSET=utf8, etc.
            // Most are display-only in Data View, but SQLite's WITHOUT ROWID
            // changes whether an exact INTEGER PRIMARY KEY receives an
            // implicit rowid, so retain that semantic flag.
            let withoutRowid = false;
            let strict = false;
            while (peek()) {
                const tok = peek();
                if (tok.type === 'PUNC' && tok.value === ';') break;
                if (tok.type === 'KW') {
                    const upTok = tok.value.toUpperCase();
                    if (upTok === 'CREATE' || upTok === 'ALTER' || upTok === 'DROP' ||
                        upTok === 'INSERT' || upTok === 'UPDATE' || upTok === 'DELETE' ||
                        upTok === 'GO' || upTok === 'TRUNCATE') break;
                }
                if (isWordToken(tok, 'WITHOUT') && isWordToken(peek(1), 'ROWID')) {
                    withoutRowid = true;
                }
                if (isWordToken(tok, 'STRICT')) strict = true;
                next();
            }
            if (peek() && peek().type === 'PUNC' && peek().value === ';') next();

            // Apply table-level constraints back to columns
            const indexes = [];
            // Composite PK / UNIQUE tuples are validated as a unit (per SQL
            // standard) — `compositePk` collects the multi-col PK column list
            // and `compositeUniques` collects every multi-col UNIQUE tuple.
            // Single-column constraints continue to flow through col.pk /
            // col.unique so existing per-column checks keep working.
            let compositePk = null;
            let primaryKeyName = null;
            const compositeUniques = [];
            const foreignKeys = [];
            const tableForeignKeyColumns = new Set();
            const checks = [];
            pendingConstraints.forEach((c) => {
                if (c.kind === 'primary' && c.cols) {
                    c.cols.forEach((name) => {
                        const col = columns.find((x) => x.name.toLowerCase() === name.toLowerCase());
                        if (col) {
                            const wasExplicitlyNotNull = col.notNull;
                            col.pk = true;
                            col.notNull = true;
                            // A table-level PK supplies NOT NULL itself. Keep
                            // that fact so a later DROP CONSTRAINT preserves
                            // an independently-declared NOT NULL column.
                            col.pkImpliedNotNull = !wasExplicitlyNotNull;
                        }
                    });
                    if (c.cols.length > 1) compositePk = [...c.cols];
                    primaryKeyName = c.name || null;
                } else if (c.kind === 'unique' && c.cols) {
                    // Only mark a column's `unique` flag when the constraint
                    // covers exactly that one column. Composite UNIQUE is a
                    // tuple constraint — the individual columns are NOT
                    // unique on their own (that's tracked via `compositeUniques`).
                    if (c.cols.length === 1) {
                        const col = columns.find((x) => x.name.toLowerCase() === c.cols[0].toLowerCase());
                        if (col) col.unique = true;
                    } else {
                        compositeUniques.push({ name: c.name || null, cols: [...c.cols] });
                    }
                    indexes.push({
                        name: c.name || null,
                        columns: c.cols,
                        unique: true,
                        constraint: true,
                        type: null,
                        clustered: null,
                        where: null,
                        include: [],
                    });
                } else if (c.kind === 'foreign' && c.cols) {
                    // Stamp `refTable` on each FK source column so downstream
                    // tooling (badges, lineage, FK validation hooks) can
                    // resolve the target — matches ALTER ADD FOREIGN KEY.
                    const refTable = c.refTable ? stripSchema(c.refTable) : null;
                    const refColumns = Array.isArray(c.refCols) ? c.refCols : [];
                    c.cols.forEach((name) => {
                        const col = columns.find((x) => x.name.toLowerCase() === name.toLowerCase());
                        if (col) {
                            tableForeignKeyColumns.add(col.name.toLowerCase());
                            col.fk = true;
                            if (refTable) col.refTable = refTable;
                            col.refColumns = refColumns;
                            col.onDelete = c.onDelete || null;
                            col.onUpdate = c.onUpdate || null;
                        }
                    });
                    if (refTable) {
                        foreignKeys.push({
                            name: c.name || null,
                            columns: [...c.cols],
                            refTable,
                            refColumns,
                            onDelete: c.onDelete || null,
                            onUpdate: c.onUpdate || null,
                            deferrable: Boolean(c.deferrable),
                            initiallyDeferred: Boolean(c.initiallyDeferred),
                        });
                    }
                } else if (c.kind === 'check' && c.expression) {
                    checks.push({ name: c.name || null, expression: c.expression });
                } else if (c.kind === 'index' && c.cols) {
                    indexes.push({
                        name: c.name || null,
                        columns: c.cols,
                        unique: false,
                        type: c.type || null,
                        clustered: null,
                        where: null,
                        include: [],
                    });
                }
            });

            // Inline `column REFERENCES parent(id) ON DELETE CASCADE` clauses
            // arrive as column metadata rather than table constraints.
            for (const column of columns) {
                if (!column.fk || !column.refTable || tableForeignKeyColumns.has(column.name.toLowerCase())) continue;
                foreignKeys.push({
                    name: column.foreignKeyConstraintName || null,
                    columns: [column.name],
                    refTable: stripSchema(column.refTable),
                    refColumns: Array.isArray(column.refColumns) ? column.refColumns : [],
                    onDelete: column.onDelete || null,
                    onUpdate: column.onUpdate || null,
                    deferrable: Boolean(column.deferrable),
                    initiallyDeferred: Boolean(column.initiallyDeferred),
                });
            }

            // Inline named PRIMARY/UNIQUE constraints do not appear in the
            // table-level constraint list. Materialize just enough metadata
            // here for DROP CONSTRAINT to remove exactly that rule later.
            if (!primaryKeyName) {
                primaryKeyName = columns.find((column) => column.primaryKeyConstraintName)?.primaryKeyConstraintName || null;
            }
            for (const column of columns) {
                if (!column.uniqueConstraintName) continue;
                indexes.push({
                    name: column.uniqueConstraintName,
                    columns: [column.name],
                    unique: true,
                    constraint: true,
                    type: null,
                    clustered: null,
                    where: null,
                    include: [],
                });
            }

            configureDialectColumnSemantics(columns, { withoutRowid, compositePk });

            // Remove any existing entry with a case-insensitive name match so
            // re-creating a table with different casing doesn't leave stale
            // duplicates in the Map.
            const existingTable = findTable(cleanName);
            const wasReplaced = !!existingTable;
            if (existingTable) tables.delete(existingTable.name);
            const preservedRows = existingTable && !orReplace && !existingTable.isView ? existingTable.rows : [];
            const autoInc = buildAutoCounters(columns, preservedRows);
            const tableObj = {
                name: cleanName,
                columns,
                rows: preservedRows,
                _autoInc: autoInc,
                indexes: [],
                compositePk,
                primaryKeyName,
                compositeUniques,
                foreignKeys,
                checks,
                dialect: dialectProfile.id,
                withoutRowid,
                strict,
            };
            tables.set(cleanName, tableObj);
            indexes.forEach((idx) => addIndexToTable(tableObj, idx));
            if (wasReplaced && orReplace) {
                log('success', `Table "${cleanName}" replaced by CREATE OR REPLACE`);
            } else if (wasReplaced) {
                log('warning', `Table "${cleanName}" already exists — definition replaced (${preservedRows.length} preserved row(s))`);
            }
            log('success', `Table "${cleanName}" created with ${columns.length} columns`);
        }

        // Register an index on a table and mark its columns as `indexed`.
        // Duplicate names are replaced (matches DB semantics where CREATE INDEX
        // with an existing name is an error, but re-parsing a DDL dump should
        // not blow up).
        function addIndexToTable(table, idx) {
            if (!table || !idx || !Array.isArray(idx.columns) || idx.columns.length === 0) return;
            table.indexes = table.indexes || [];
            if (idx.name) {
                const i = table.indexes.findIndex((x) => x.name && x.name.toLowerCase() === idx.name.toLowerCase());
                if (i >= 0) removeIndexFromTable(table, idx.name);
            }
            table.indexes.push(idx);
            idx.columns.forEach((colName) => {
                const col = findColumn(table, colName);
                if (col) col.indexed = true;
            });
            registerUniqueIndexConstraint(table, idx);
        }

        // A UNIQUE index is a data constraint, not merely display metadata.
        // Keep the compact column flags / tuple list used by validation in
        // sync with the richer index object used by the UI. This is also what
        // lets CREATE UNIQUE INDEX and ALTER ... ADD UNIQUE behave alike.
        function registerUniqueIndexConstraint(table, index) {
            if (!index?.unique || !Array.isArray(index.columns) || index.columns.length === 0) return;
            // A filtered/partial unique index only constrains rows that match
            // its WHERE predicate. It cannot be represented by a plain
            // `column.unique` flag or an unconditional tuple list; DML checks
            // it separately against that predicate below.
            if (index.where) return;
            if (index.columns.length === 1) {
                const column = findColumn(table, index.columns[0]);
                if (column) column.unique = true;
                return;
            }
            table.compositeUniques = table.compositeUniques || [];
            const alreadyRegistered = table.compositeUniques.some((unique) =>
                String(unique?.name || '').toLowerCase() === String(index.name || '').toLowerCase() &&
                unique?.cols?.length === index.columns.length &&
                unique.cols.every((column, position) => column.toLowerCase() === index.columns[position].toLowerCase()),
            );
            if (!alreadyRegistered) {
                table.compositeUniques.push({ name: index.name || null, cols: [...index.columns] });
            }
        }

        function refreshSingleColumnUniqueFlags(table) {
            for (const column of table.columns || []) {
                const supportedByUniqueIndex = (table.indexes || []).some((index) =>
                    index.unique && !index.where && index.columns?.length === 1 &&
                    index.columns[0].toLowerCase() === column.name.toLowerCase(),
                );
                column.unique = Boolean(column.inlineUnique || supportedByUniqueIndex);
            }
        }

        // Remove an index by name. Returns true if the index existed.
        function removeIndexFromTable(table, name) {
            if (!table || !table.indexes || !name) return false;
            const i = table.indexes.findIndex((x) => x.name && x.name.toLowerCase() === name.toLowerCase());
            if (i < 0) return false;
            const removed = table.indexes.splice(i, 1)[0];
            if (removed.unique) {
                table.compositeUniques = (table.compositeUniques || []).filter((unique) =>
                    !unique?.name || !removed.name || unique.name.toLowerCase() !== removed.name.toLowerCase(),
                );
                refreshSingleColumnUniqueFlags(table);
            }
            // Re-evaluate `indexed` flag on affected columns.
            removed.columns.forEach((colName) => {
                const col = findColumn(table, colName);
                if (!col) return;
                const stillIndexed = table.indexes.some((x) => x.columns.some((c) => c.toLowerCase() === colName.toLowerCase()));
                if (!stillIndexed) col.indexed = false;
            });
            return true;
        }

        function refreshForeignKeyColumnMetadata(table) {
            for (const column of table.columns || []) {
                const remaining = (table.foreignKeys || []).find((foreignKey) =>
                    foreignKey.columns?.some((name) => name.toLowerCase() === column.name.toLowerCase()),
                );
                if (!remaining) {
                    column.fk = false;
                    column.refTable = null;
                    column.refColumns = [];
                    column.onDelete = null;
                    column.onUpdate = null;
                }
            }
        }

        // All named constraints are retained as first-class metadata.  This
        // routine is deliberately conservative: when a name cannot be found,
        // callers report it instead of pretending ALTER TABLE succeeded.
        function dropNamedConstraint(table, name) {
            if (!table || !name) return false;
            const expected = String(name).toLowerCase();
            let removed = false;

            if (String(table.primaryKeyName || '').toLowerCase() === expected) {
                table.columns.forEach((column) => {
                    if (!column.pk) return;
                    column.pk = false;
                    if (column.pkImpliedNotNull) column.notNull = false;
                    delete column.pkImpliedNotNull;
                });
                table.compositePk = null;
                table.primaryKeyName = null;
                removed = true;
            }

            const beforeChecks = (table.checks || []).length;
            table.checks = (table.checks || []).filter((check) => String(check?.name || '').toLowerCase() !== expected);
            removed ||= table.checks.length !== beforeChecks;
            for (const column of table.columns || []) {
                if (String(column.checkConstraintName || '').toLowerCase() !== expected) continue;
                column.check = null;
                column.checkConstraintName = null;
                removed = true;
            }

            const beforeForeignKeys = (table.foreignKeys || []).length;
            table.foreignKeys = (table.foreignKeys || []).filter((foreignKey) => String(foreignKey?.name || '').toLowerCase() !== expected);
            if (table.foreignKeys.length !== beforeForeignKeys) {
                refreshForeignKeyColumnMetadata(table);
                removed = true;
            }

            // UNIQUE table constraints are represented by their backing
            // unique index as well as validation metadata. A standalone
            // CREATE UNIQUE INDEX is *not* a constraint, so do not remove it
            // merely because its name appears in DROP CONSTRAINT.
            const backingConstraintIndex = (table.indexes || []).find((index) =>
                index.constraint && index.name && index.name.toLowerCase() === expected,
            );
            if (backingConstraintIndex && removeIndexFromTable(table, name)) removed = true;
            refreshSingleColumnUniqueFlags(table);
            return removed;
        }

        // Apply the small set of dialect semantics that materially affect
        // preview rows. Shared parsing remains intentionally dialect-neutral;
        // profiles only opt into behavior that is unambiguous for that engine.
        function configureDialectColumnSemantics(columns, { withoutRowid, compositePk }) {
            if (!dialectProfile.implicitIntegerPrimaryKey || withoutRowid || (compositePk && compositePk.length > 1)) return;

            const primaryKeys = columns.filter((column) => column.pk);
            if (primaryKeys.length !== 1) return;
            const [primaryKey] = primaryKeys;
            if (String(primaryKey.type || '').trim().toUpperCase() === 'INTEGER') {
                primaryKey.sqliteRowidAlias = true;
            }
        }

        // Initialize auto-increment counters for a freshly (re)created table.
        // If the table has existing rows whose values exceed the declared
        // seed, the counter is bumped so the next auto-assignment won't
        // collide with stored data.
        function buildAutoCounters(columns, rows) {
            const map = new Map();
            for (const col of columns) {
                if (!col.autoIncrement) continue;
                const step = col.identityStep || 1;
                let next = col.identitySeed || 1;
                for (const row of rows) {
                    const v = Number(row[col.name]);
                    if (!isNaN(v) && v >= next) next = v + step;
                }
                map.set(col.name.toLowerCase(), { next, step });
            }
            return map;
        }

        function processEntry(toks, columns, constraints) {
            if (!toks.length) return;
            const first = toks[0];

            // Table-level constraint
            if (first.type === 'KW' && CONSTRAINT_STARTS.has(first.value.toUpperCase())) {
                const kw = first.value.toUpperCase();

                // KEY and INDEX are also common column names (especially `key`
                // in SQLite key-value tables). Disambiguate:
                //   MySQL inline index:   KEY (cols)   or   KEY idx_name (cols)
                //   Column definition:    key TEXT …   or   key VARCHAR(50) …
                // Rule: a MySQL KEY/INDEX entry always has `(` at position 1
                // (bare: `KEY (a,b)`) or position 2 (named: `KEY name (a,b)`).
                // If neither pattern matches, treat as a column definition.
                if (kw === 'KEY' || kw === 'INDEX') {
                    const parenAt1 = toks[1] && toks[1].type === 'PUNC' && toks[1].value === '(';
                    const parenAt2 = toks[2] && toks[2].type === 'PUNC' && toks[2].value === '(';
                    if (!parenAt1 && !parenAt2) {
                        // This is a column named `key` or `index`, not a MySQL index entry.
                        const col = extractColumn(toks);
                        if (col) columns.push(col);
                        return;
                    }
                }

                const c = parseTableConstraint(toks);
                if (c) constraints.push(c);
                return;
            }

            // Column definition
            const col = extractColumn(toks);
            if (col) columns.push(col);
        }

        function parseTableConstraint(toks) {
            let p = 0;
            let constraintName = null;
            const peekT = () => toks[p] || null;
            const nextT = () => toks[p++] || null;
            const kwMatch = (val) => {
                const t = peekT();
                return t && t.type === 'KW' && t.value.toUpperCase() === val;
            };
            const consumeT = (val) => {
                if (kwMatch(val)) {
                    nextT();
                    return true;
                }
                return false;
            };

            // CONSTRAINT name ...
            if (consumeT('CONSTRAINT')) {
                if (peekT() && (peekT().type === 'IDENT' || peekT().type === 'STRING' || peekT().type === 'KW')) {
                    constraintName = String(nextT().value);
                }
            }

            const t = peekT();
            if (!t || t.type !== 'KW') return null;
            const kw = t.value.toUpperCase();

            if (kw === 'PRIMARY') {
                nextT();
                consumeT('KEY');
                const cols = readParenFromTokens(toks, p);
                return { kind: 'primary', name: constraintName, cols };
            }
            if (kw === 'UNIQUE') {
                nextT();
                consumeT('KEY');
                consumeT('INDEX');
                // Optional index name
                let name = null;
                if (peekT() && (peekT().type === 'IDENT' || peekT().type === 'STRING')) {
                    name = peekT().value;
                    nextT();
                }
                const cols = readParenFromTokens(toks, p);
                return { kind: 'unique', name: name || constraintName, cols };
            }
            if (kw === 'FOREIGN') {
                nextT();
                consumeT('KEY');
                const cols = readParenFromTokens(toks, p);
                // Advance past the `(...)` we just consumed for FK source columns.
                p = skipParenFromTokens(toks, p);
                // Optional `REFERENCES <qualified_table> [(refCols)]` —
                // capture the target table so callers can stamp `refTable`
                // on the source column(s), matching ALTER TABLE ADD FOREIGN KEY.
                let refTable = null;
                let refCols = [];
                if (consumeT('REFERENCES')) {
                    const headTok = peekT();
                    if (headTok && (headTok.type === 'IDENT' || headTok.type === 'STRING' || headTok.type === 'KW')) {
                        // Use token values, not raw text: raw retains MySQL
                        // backticks and SQL Server brackets, which would make
                        // the inverse FK lookup miss an otherwise matching
                        // parsed table name.
                        let name = String(headTok.value);
                        nextT();
                        // Consume `.next` segments (schema.table or db.schema.table).
                        while (peekT() && peekT().type === 'PUNC' && peekT().value === '.') {
                            nextT();
                            const seg = peekT();
                            if (seg && (seg.type === 'IDENT' || seg.type === 'STRING' || seg.type === 'KW')) {
                                name += `.${seg.value}`;
                                nextT();
                            } else break;
                        }
                        refTable = name;
                    }
                    refCols = readParenFromTokens(toks, p);
                    p = skipParenFromTokens(toks, p);
                }
                const actions = readReferenceActionsFromTokens(toks, p);
                const deferrability = readDeferrabilityFromTokens(toks, p);
                return { kind: 'foreign', name: constraintName, cols, refTable, refCols, ...actions, ...deferrability };
            }
            if (kw === 'CHECK') {
                nextT();
                const start = p;
                p = skipParenFromTokens(toks, p);
                const expression = toks.slice(start + 1, Math.max(start + 1, p - 1));
                return { kind: 'check', name: constraintName, expression };
            }
            // MySQL inline index entries inside CREATE TABLE:
            //   KEY [name] (cols) [USING method]
            //   INDEX [name] (cols) [USING method]
            //   FULLTEXT [KEY|INDEX] [name] (cols)
            //   SPATIAL [KEY|INDEX] [name] (cols)
            if (kw === 'KEY' || kw === 'INDEX') {
                nextT();
                let name = null;
                if (peekT() && (peekT().type === 'IDENT' || peekT().type === 'STRING')) {
                    name = peekT().value;
                    nextT();
                }
                const cols = readParenFromTokens(toks, p);
                return { kind: 'index', name, cols, type: null };
            }
            if (kw === 'FULLTEXT' || kw === 'SPATIAL') {
                const idxType = kw.toLowerCase();
                nextT();
                consumeT('KEY');
                consumeT('INDEX');
                let name = null;
                if (peekT() && (peekT().type === 'IDENT' || peekT().type === 'STRING')) {
                    name = peekT().value;
                    nextT();
                }
                const cols = readParenFromTokens(toks, p);
                return { kind: 'index', name, cols, type: idxType };
            }
            return null;
        }

        function readParenFromTokens(toks, startIdx) {
            let p = startIdx;
            while (p < toks.length && !(toks[p].type === 'PUNC' && toks[p].value === '(')) p++;
            if (p >= toks.length) return [];
            p++; // skip (
            const items = [];
            let depth = 1;
            while (p < toks.length && depth > 0) {
                const t = toks[p];
                if (t.type === 'PUNC' && t.value === '(') depth++;
                else if (t.type === 'PUNC' && t.value === ')') {
                    depth--;
                    if (depth === 0) break;
                } else if (t.type === 'PUNC' && t.value === ',') {
                    /* skip */
                } else if (depth === 1 && (t.type === 'IDENT' || t.type === 'KW' || t.type === 'STRING')) {
                    // Use `.value` (unquoted) so downstream column lookups
                    // match regardless of backtick/bracket/quote style.
                    items.push(t.value);
                }
                p++;
            }
            return items;
        }

        function skipParenFromTokens(toks, startIdx) {
            let p = startIdx;
            while (p < toks.length && !(toks[p].type === 'PUNC' && toks[p].value === '(')) p++;
            if (p >= toks.length) return p;
            let depth = 0;
            do {
                const token = toks[p];
                if (token.type === 'PUNC' && token.value === '(') depth++;
                else if (token.type === 'PUNC' && token.value === ')') depth--;
                p++;
            } while (p < toks.length && depth > 0);
            return p;
        }

        function readReferenceActionsFromTokens(toks, startIdx) {
            let p = startIdx;
            let onDelete = null;
            let onUpdate = null;
            while (p < toks.length) {
                if (!isWordToken(toks[p], 'ON')) {
                    p++;
                    continue;
                }
                const event = tokenWordValue(toks[p + 1]);
                const first = tokenWordValue(toks[p + 2]);
                if ((event !== 'DELETE' && event !== 'UPDATE') || !first) {
                    p++;
                    continue;
                }
                let action = first;
                let consumed = 3;
                const second = tokenWordValue(toks[p + 3]);
                if ((first === 'SET' || first === 'NO') && second) {
                    action = `${first} ${second}`;
                    consumed++;
                }
                if (event === 'DELETE') onDelete = action;
                else onUpdate = action;
                p += consumed;
            }
            return { onDelete, onUpdate };
        }

        function readDeferrabilityFromTokens(toks, startIdx = 0) {
            let deferrable = false;
            let initiallyDeferred = false;
            for (let p = startIdx; p < toks.length; p++) {
                const word = tokenWordValue(toks[p]);
                const nextWord = tokenWordValue(toks[p + 1]);
                if (word === 'NOT' && nextWord === 'DEFERRABLE') {
                    deferrable = false;
                    initiallyDeferred = false;
                    p++;
                } else if (word === 'DEFERRABLE') {
                    deferrable = true;
                } else if (word === 'INITIALLY' && nextWord === 'DEFERRED') {
                    deferrable = true;
                    initiallyDeferred = true;
                    p++;
                } else if (word === 'INITIALLY' && nextWord === 'IMMEDIATE') {
                    initiallyDeferred = false;
                    p++;
                }
            }
            return { deferrable, initiallyDeferred };
        }

        function extractColumn(toks) {
            if (!toks.length) return null;
            const first = toks[0];
            let name = null;
            if (first.type === 'IDENT' || first.type === 'STRING') name = first.value;
            else if (first.type === 'KW') name = first.raw || first.value;
            if (!name) return null;

            // MSSQL computed column. Two equivalent forms in T-SQL:
            //   <name> AS (<expression>) [PERSISTED [NOT NULL]]
            //   <name> AS  <expression>  [PERSISTED [NOT NULL]]   (bare expr)
            //
            // Register a real column slot so positional INSERTs line up and
            // retain the expression for evaluation just like a generated
            // column.  Treating a NOT NULL computed expression as NULL made
            // valid SQL Server inserts fail validation.
            if (toks[1] && toks[1].type === 'KW' && String(toks[1].value).toUpperCase() === 'AS') {
                let q = 2;
                let d = 0;
                while (q < toks.length) {
                    const x = toks[q];
                    if (x.type === 'PUNC' && x.value === '(') {
                        d++;
                        q++;
                        continue;
                    }
                    if (x.type === 'PUNC' && x.value === ')') {
                        if (d === 0) break;
                        d--;
                        q++;
                        continue;
                    }
                    if (d === 0 && x.type === 'PUNC' && (x.value === ',' || x.value === ';')) break;
                    if (d === 0 && x.type === 'KW') {
                        const ku = String(x.value).toUpperCase();
                        if (ku === 'PERSISTED' || ku === 'NOT') break;
                    }
                    q++;
                }
                // T-SQL accepts the trailing modifiers in either order:
                //   AS (expr) PERSISTED NOT NULL          (canonical)
                //   AS (expr) NOT NULL PERSISTED          (also legal)
                // Walk both possibilities — set the flag when NOT NULL is
                // present anywhere in the trailing tail.
                let computedNotNull = false;
                let progressed = true;
                while (progressed && q < toks.length) {
                    progressed = false;
                    const x = toks[q];
                    if (!x || x.type !== 'KW') break;
                    const ku = String(x.value).toUpperCase();
                    if (ku === 'PERSISTED') { q++; progressed = true; continue; }
                    if (ku === 'NOT' && toks[q + 1] && toks[q + 1].type === 'KW' && String(toks[q + 1].value).toUpperCase() === 'NULL') {
                        computedNotNull = true;
                        q += 2;
                        progressed = true;
                        continue;
                    }
                }
                return {
                    name,
                    type: 'COMPUTED',
                    pk: false,
                    notNull: computedNotNull,
                    unique: false,
                    inlineUnique: false,
                    fk: false,
                    defaultVal: null,
                    check: null,
                    refTable: null,
                    isEnum: false,
                    enumValues: null,
                    isComposite: false,
                    autoIncrement: false,
                    identitySeed: 1,
                    identityStep: 1,
                    autoUuid: false,
                    computed: true,
                    generatedExpr: toks.slice(2, q),
                };
            }

            // Parse type (collect raw tokens too for inline ENUM detection)
            const typeParts = [];
            const rawTypeParts = [];
            let p = 1;
            let parenD = 0;
            while (p < toks.length) {
                const t = toks[p];
                if (t.type === 'PUNC' && t.value === '(') {
                    parenD++;
                    typeParts.push(t.value);
                    rawTypeParts.push(t.value);
                    p++;
                    continue;
                }
                if (t.type === 'PUNC' && t.value === ')') {
                    parenD--;
                    typeParts.push(t.value);
                    rawTypeParts.push(t.value);
                    p++;
                    continue;
                }
                if (parenD === 0 && isColumnTypeOptionStartAt(toks, p)) break;
                typeParts.push(t.value);
                rawTypeParts.push(t.type === 'STRING' ? `'${t.value}'` : t.raw || t.value);
                p++;
            }
            let type = typeParts
                .join(' ')
                .replace(/\s*\(\s*/g, '(')
                .replace(/\s*\)/g, ')')
                .replace(/\s*,\s*/g, ',')
                .trim();
            const rawType = rawTypeParts.join('');

            // Detect inline ENUM: ENUM('a','b','c')
            let enumValues = null;
            const enumMatch = rawType.match(/^ENUM\s*\(\s*(.+)\s*\)$/i);
            if (enumMatch) {
                enumValues = Array.from(enumMatch[1].matchAll(/'(?:''|[^'])*'|"(?:""|[^"])*"/g) || []).map((m) => m[0].slice(1, -1));
                const inlineName = `${name}_enum`;
                types.set(inlineName, { kind: 'enum', name: inlineName, values: enumValues, isInline: true });
                type = 'ENUM';
            }
            // Detect inline MySQL SET: SET('a','b','c'). For ERD/Data View
            // purposes we model it the same way as an enum (multi-value
            // domain) — see parseAst.js for the matching behavior. Stored
            // values are still strings, validation against the SET domain
            // is opportunistic.
            if (!enumValues) {
                const setMatch = rawType.match(/^SET\s*\(\s*(.+)\s*\)$/i);
                if (setMatch) {
                    enumValues = Array.from(setMatch[1].matchAll(/'(?:''|[^'])*'|"(?:""|[^"])*"/g) || []).map((m) => m[0].slice(1, -1));
                    const inlineName = `${name}_set`;
                    types.set(inlineName, { kind: 'enum', name: inlineName, values: enumValues, isInline: true });
                    type = 'SET';
                }
            }

            // Resolve custom type reference
            let resolvedType = findType(type);
            let isEnum = !!enumValues;
            let isComposite = false;
            if (!isEnum && resolvedType) {
                if (resolvedType.kind === 'enum') {
                    isEnum = true;
                    enumValues = resolvedType.values;
                } else if (resolvedType.kind === 'composite') {
                    isComposite = true;
                }
            }

            // Parse constraints
            let pk = false,
                notNull = false,
                unique = false,
                fk = false;
            let defaultVal = null,
                check = null,
                refTable = null;
            let refColumns = [];
            let onDelete = null;
            let onUpdate = null;
            let autoIncrement = false;
            let identitySeed = 1;
            let identityStep = 1;
            let generatedExpr = null;
            let pendingConstraintName = null;
            let primaryKeyConstraintName = null;
            let uniqueConstraintName = null;
            let foreignKeyConstraintName = null;
            let checkConstraintName = null;
            let pkImpliedNotNull = false;
            let deferrable = false;
            let initiallyDeferred = false;

            // PostgreSQL SERIAL family — these types imply auto-increment
            // and NOT NULL (Postgres expands SERIAL to INT DEFAULT nextval()).
            const upType = (type || '').toUpperCase().trim();
            if (upType === 'SERIAL' || upType === 'SERIAL4' || upType === 'BIGSERIAL' || upType === 'SERIAL8' || upType === 'SMALLSERIAL' || upType === 'SERIAL2') {
                autoIncrement = true;
                notNull = true;
            }
            while (p < toks.length) {
                const t = toks[p];
                if (t.type === 'KW') {
                    const kw = t.value.toUpperCase();
                    // Column constraints can be named too:
                    // `email TEXT CONSTRAINT uq_email UNIQUE`. Keep that
                    // name so ALTER TABLE ... DROP CONSTRAINT mutates the
                    // same validation metadata as table-level constraints.
                    if (kw === 'CONSTRAINT') {
                        p++;
                        const nameToken = toks[p];
                        if (nameToken && (nameToken.type === 'IDENT' || nameToken.type === 'STRING' || nameToken.type === 'KW')) {
                            pendingConstraintName = String(nameToken.value);
                            p++;
                        }
                        continue;
                    }
                    if (kw === 'PRIMARY') {
                        pkImpliedNotNull = !notNull;
                        pk = true;
                        notNull = true;
                        primaryKeyConstraintName = pendingConstraintName;
                        pendingConstraintName = null;
                        p++;
                        if (p < toks.length && toks[p].type === 'KW' && toks[p].value.toUpperCase() === 'KEY') p++;
                        continue;
                    }
                    if (kw === 'NOT') {
                        p++;
                        if (p < toks.length && toks[p].type === 'KW' && toks[p].value.toUpperCase() === 'NULL') {
                            notNull = true;
                            p++;
                        } else if (p < toks.length && toks[p].type === 'KW' && toks[p].value.toUpperCase() === 'DEFERRABLE') {
                            deferrable = false;
                            initiallyDeferred = false;
                            p++;
                        }
                        continue;
                    }
                    if (kw === 'NULL') {
                        p++;
                        continue;
                    }
                    if (kw === 'UNIQUE') {
                        unique = true;
                        uniqueConstraintName = pendingConstraintName;
                        pendingConstraintName = null;
                        p++;
                        continue;
                    }
                    if (kw === 'REFERENCES') {
                        fk = true;
                        foreignKeyConstraintName = pendingConstraintName;
                        pendingConstraintName = null;
                        p++;
                        if (p < toks.length && (toks[p].type === 'IDENT' || toks[p].type === 'STRING' || toks[p].type === 'KW')) {
                            // Keep the semantic identifier, not its SQL
                            // delimiter form (`name` / [name] / "name"), so
                            // inverse FK lookup works across all dialects.
                            refTable = String(toks[p].value);
                            p++;
                            while (p + 1 < toks.length && toks[p].type === 'PUNC' && toks[p].value === '.' && (toks[p + 1].type === 'IDENT' || toks[p + 1].type === 'STRING' || toks[p + 1].type === 'KW')) {
                                refTable += `.${toks[p + 1].value}`;
                                p += 2;
                            }
                        }
                        if (p < toks.length && toks[p].type === 'PUNC' && toks[p].value === '(') {
                            refColumns = readParenFromTokens(toks, p);
                            p = skipParenFromTokens(toks, p);
                        }
                        continue;
                    }
                    if (kw === 'DEFERRABLE') {
                        deferrable = true;
                        p++;
                        continue;
                    }
                    if (kw === 'INITIALLY') {
                        const mode = toks[p + 1];
                        if (mode?.type === 'KW') {
                            const word = mode.value.toUpperCase();
                            if (word === 'DEFERRED') {
                                deferrable = true;
                                initiallyDeferred = true;
                                p += 2;
                                continue;
                            }
                            if (word === 'IMMEDIATE') {
                                initiallyDeferred = false;
                                p += 2;
                                continue;
                            }
                        }
                    }
                    if (kw === 'DEFAULT') {
                        p++;
                        const defParts = [];
                        let dd = 0;
                        while (p < toks.length) {
                            const x = toks[p];
                            if (x.type === 'PUNC' && (x.value === ',' || x.value === ')') && dd === 0) break;
                            if (x.type === 'PUNC' && x.value === '(') dd++;
                            if (x.type === 'PUNC' && x.value === ')') dd--;
                            if (x.type === 'KW' && COL_STOP_KW.has(x.value.toUpperCase()) && dd === 0 && x.value.toUpperCase() !== 'DEFAULT') break;
                            defParts.push(x.type === 'STRING' ? `'${x.value}'` : x.raw || x.value);
                            p++;
                        }
                        defaultVal = defParts.join(' ').trim() || null;
                        continue;
                    }
                    if (kw === 'CHECK') {
                        checkConstraintName = pendingConstraintName;
                        pendingConstraintName = null;
                        p++;
                        const checkParts = [];
                        if (p < toks.length && toks[p].type === 'PUNC' && toks[p].value === '(') {
                            let d = 1;
                            p++;
                            while (p < toks.length && d > 0) {
                                if (toks[p].type === 'PUNC' && toks[p].value === '(') d++;
                                else if (toks[p].type === 'PUNC' && toks[p].value === ')') {
                                    d--;
                                    if (d === 0) {
                                        p++;
                                        break;
                                    }
                                }
                                checkParts.push(toks[p].raw || toks[p].value);
                                p++;
                            }
                        }
                        check = checkParts.join(' ').trim() || null;
                        continue;
                    }
                    if (kw === 'AUTO_INCREMENT') {
                        autoIncrement = true;
                        p++;
                        continue;
                    }
                    // SQLite: AUTOINCREMENT (no underscore)
                    if (kw === 'AUTOINCREMENT') {
                        autoIncrement = true;
                        p++;
                        continue;
                    }
                    if (kw === 'IDENTITY') {
                        autoIncrement = true;
                        p++;
                        // MSSQL: IDENTITY(seed, step) — optional parenthesized args.
                        if (p < toks.length && toks[p].type === 'PUNC' && toks[p].value === '(') {
                            const r = parseIdentityArgs(toks, p);
                            p = r.p;
                            identitySeed = r.seed;
                            identityStep = r.step;
                        }
                        continue;
                    }
                    if (kw === 'GENERATED') {
                        p++;
                        // GENERATED ALWAYS | GENERATED BY DEFAULT
                        if (p < toks.length && toks[p].type === 'KW') {
                            const n1 = toks[p].value.toUpperCase();
                            if (n1 === 'ALWAYS') p++;
                            else if (n1 === 'BY') {
                                p++;
                                if (p < toks.length && toks[p].type === 'KW' && toks[p].value.toUpperCase() === 'DEFAULT') p++;
                            }
                        }
                        // AS
                        if (p < toks.length && toks[p].type === 'KW' && toks[p].value.toUpperCase() === 'AS') p++;
                        // IDENTITY [(options)] — auto-increment.
                        // (expr) [STORED|VIRTUAL] — computed column (not auto-inc).
                        if (p < toks.length && toks[p].type === 'KW' && toks[p].value.toUpperCase() === 'IDENTITY') {
                            autoIncrement = true;
                            p++;
                            if (p < toks.length && toks[p].type === 'PUNC' && toks[p].value === '(') {
                                const r = parseIdentityArgs(toks, p);
                                p = r.p;
                                identitySeed = r.seed;
                                identityStep = r.step;
                            }
                        } else if (p < toks.length && toks[p].type === 'PUNC' && toks[p].value === '(') {
                            // Capture generated expression tokens for evaluation
                            const exprTokens = [];
                            let d = 1;
                            p++;
                            while (p < toks.length && d > 0) {
                                if (toks[p].type === 'PUNC' && toks[p].value === '(') d++;
                                else if (toks[p].type === 'PUNC' && toks[p].value === ')') {
                                    d--;
                                    if (d === 0) { p++; break; }
                                }
                                exprTokens.push(toks[p]);
                                p++;
                            }
                            generatedExpr = exprTokens;
                            if (p < toks.length && toks[p].type === 'KW') {
                                const tail = toks[p].value.toUpperCase();
                                if (tail === 'STORED' || tail === 'VIRTUAL') p++;
                            }
                        }
                        continue;
                    }
                    if (kw === 'ON') {
                        const event = tokenWordValue(toks[p + 1]);
                        const first = tokenWordValue(toks[p + 2]);
                        if ((event !== 'DELETE' && event !== 'UPDATE') || !first) {
                            p++;
                            continue;
                        }
                        let action = first;
                        p += 3;
                        const second = tokenWordValue(toks[p]);
                        if ((first === 'SET' || first === 'NO') && second) {
                            action = `${first} ${second}`;
                            p++;
                        }
                        if (event === 'DELETE') onDelete = action;
                        else onUpdate = action;
                        continue;
                    }
                }
                p++;
            }

            return {
                name,
                type: type || 'TEXT',
                pk,
                notNull,
                unique,
                // Keep the origin separate from table/index UNIQUE metadata.
                // ALTER ... DROP CONSTRAINT can then remove a named table
                // constraint without accidentally disabling `email UNIQUE`
                // declared directly on the column.
                inlineUnique: unique && !uniqueConstraintName,
                fk,
                defaultVal,
                check,
                refTable,
                refColumns,
                onDelete,
                onUpdate,
                isEnum,
                enumValues,
                isComposite,
                autoIncrement,
                identitySeed,
                identityStep,
                autoUuid: isUuidDefault(defaultVal),
                generatedExpr: generatedExpr || null,
                primaryKeyConstraintName,
                uniqueConstraintName,
                foreignKeyConstraintName,
                checkConstraintName,
                pkImpliedNotNull,
                deferrable,
                initiallyDeferred,
            };
        }

        // Parse optional argument block following IDENTITY / GENERATED AS IDENTITY.
        // Handles two dialects:
        //   • MSSQL:    IDENTITY(seed, step)      — positional numbers
        //   • Postgres: IDENTITY (START WITH n INCREMENT BY m MINVALUE ... MAXVALUE ... CACHE ... [NO] CYCLE)
        // Unknown options are ignored. Returns { p, seed, step } where `p`
        // points just past the closing `)`.
        function parseIdentityArgs(toks, p) {
            if (!(toks[p] && toks[p].type === 'PUNC' && toks[p].value === '(')) {
                return { p, seed: 1, step: 1 };
            }
            p++;
            let seed = 1;
            let step = 1;
            let positionalIdx = 0;
            let usedNamed = false;
            let prevNamed = '';
            while (p < toks.length) {
                const t = toks[p];
                if (t.type === 'PUNC' && t.value === ')') {
                    p++;
                    break;
                }
                const tv = String(t.raw || t.value || '').toUpperCase();
                if (tv === 'START') {
                    usedNamed = true;
                    prevNamed = 'START';
                    p++;
                    continue;
                }
                if (tv === 'INCREMENT') {
                    usedNamed = true;
                    prevNamed = 'INCREMENT';
                    p++;
                    continue;
                }
                if (tv === 'WITH' || tv === 'BY' || tv === 'NO') {
                    p++;
                    continue;
                }
                if (tv === 'MINVALUE' || tv === 'MAXVALUE' || tv === 'CACHE' || tv === 'CYCLE') {
                    prevNamed = tv;
                    p++;
                    continue;
                }
                // Signed numeric literal (possibly `-N`)
                let sign = 1;
                if (t.type === 'OP' && t.value === '-' && toks[p + 1] && toks[p + 1].type === 'NUMBER') {
                    sign = -1;
                    p++;
                }
                const nTok = toks[p];
                if (nTok && nTok.type === 'NUMBER') {
                    const n = sign * Number(nTok.value);
                    if (usedNamed) {
                        if (prevNamed === 'START') seed = n;
                        else if (prevNamed === 'INCREMENT') step = n;
                        prevNamed = '';
                    } else {
                        if (positionalIdx === 0) seed = n;
                        else if (positionalIdx === 1) step = n;
                        positionalIdx++;
                    }
                    p++;
                    continue;
                }
                // Skip commas and anything else we don't recognize.
                p++;
            }
            return { p, seed, step };
        }

        // ════════════════════════════════════════════════════════════════
        //  ALTER TABLE — schema mutation + index/constraint tweaks
        // ════════════════════════════════════════════════════════════════
        //  Supported actions (errors gracefully on unknown sub-clauses):
        //    ADD COLUMN col TYPE [constraints]
        //    DROP COLUMN col
        //    RENAME COLUMN old TO new
        //    RENAME [TABLE] old TO new
        //    MODIFY [COLUMN] col TYPE [constraints]   (MySQL syntax)
        //    ALTER COLUMN col TYPE | SET / DROP NOT NULL / DEFAULT / IDENTITY
        //    ADD CONSTRAINT name { PRIMARY | UNIQUE | FOREIGN | CHECK }
        //    DROP CONSTRAINT name
        //    ADD CHECK (expr)
        //
        //  Existing rows are mutated in-place where the action allows it
        //  (RENAME COLUMN rewrites every row's key, ADD COLUMN adds a slot
        //  initialised to NULL or DEFAULT, DROP COLUMN deletes the slot).
        //  Constraint actions update `compositePk` / `compositeUniques`
        //  and re-validate the existing rows so the user is alerted if
        //  the new constraint conflicts with stored data.
        // ════════════════════════════════════════════════════════════════

        function parseAlterTable() {
            consumeKW('TABLE');
            if (consumeKW('IF')) consumeKW('EXISTS');
            consumeKW('ONLY');

            const tableName = parseQualifiedIdent();
            if (!tableName) {
                skipToSemicolon();
                return;
            }
            const table = findTable(tableName);

            while (peek() && !(peek().type === 'PUNC' && peek().value === ';')) {
                // Cross-statement recovery: if we encounter a fresh top-level
                // CREATE / ALTER without a terminating `;`, stop chewing up
                // the rest of the script. NOTE: DROP / TRUNCATE are NOT
                // anchors here — `DROP COLUMN`, `DROP CONSTRAINT` and
                // `DROP INDEX` are legitimate ALTER subactions, and
                // `TRUNCATE` never appears mid-ALTER. Only the two-keyword
                // combinations `CREATE (TABLE|TYPE|INDEX|…)` and
                // `ALTER TABLE` unambiguously start a new top-level
                // statement.
                {
                    const lookKw = peek() && peek().type === 'KW' ? String(peek().value).toUpperCase() : null;
                    if ((lookKw === 'CREATE' || lookKw === 'ALTER') && isStrongStatementAnchor(idx)) break;
                }

                // Skip optional IF [NOT] EXISTS between actions (rare).
                if (consumeKW('IF')) {
                    consumeKW('NOT');
                    consumeKW('EXISTS');
                    continue;
                }

                if (consumeKW('ADD')) {
                    // Capture the optional CONSTRAINT name so it can be used
                    // as a label on the resulting index / composite-UNIQUE
                    // entry. Was previously parsed-and-discarded, which
                    // silently lost the user's `uq_xxx` / `fk_xxx` labels.
                    let constraintName = null;
                    if (consumeKW('CONSTRAINT')) {
                        constraintName = parseIdent();
                    }

                    if (isKW('PRIMARY')) {
                        next();
                        consumeKW('KEY');
                        const cols = readParenList();
                        if (table && cols) {
                            cols.forEach((c) => {
                                const col = findColumn(table, c);
                                if (col) {
                                    const wasExplicitlyNotNull = col.notNull;
                                    col.pk = true;
                                    col.notNull = true;
                                    col.pkImpliedNotNull = !wasExplicitlyNotNull;
                                }
                            });
                            table.primaryKeyName = constraintName || null;
                            log('success', `Added PRIMARY KEY (${cols.join(', ')}) to "${table.name}"`);
                        }
                        continue;
                    }
                    if (isKW('UNIQUE')) {
                        next();
                        consumeKW('KEY');
                        consumeKW('INDEX');
                        let name = null;
                        if (peek() && (peek().type === 'IDENT' || peek().type === 'STRING')) {
                            name = peek().value;
                            next();
                        }
                        // Prefer the explicit CONSTRAINT name when no
                        // INDEX-style name was supplied — this preserves
                        // the user-friendly label across both syntaxes:
                        //   ADD CONSTRAINT uq_ab UNIQUE (a, b)         ← constraintName='uq_ab'
                        //   ADD UNIQUE KEY uq_ab (a, b)                ← name='uq_ab'
                        if (!name && constraintName) name = constraintName;
                        const cols = readParenList();
                        if (table && cols && cols.length > 0) {
                            const uniqueIndex = {
                                name,
                                columns: cols,
                                unique: true,
                                constraint: true,
                                type: null,
                                clustered: null,
                                where: null,
                                include: [],
                            };
                            const existingRowErrors = validateUniqueIndexRows(table, uniqueIndex);
                            if (existingRowErrors.length > 0) {
                                existingRowErrors.forEach((message) => log('error', message));
                                continue;
                            }
                            // Mirror CREATE TABLE behaviour: a single-column
                            // UNIQUE flips that one column's `unique` flag
                            // (so per-row dup checks fire), while a
                            // multi-column UNIQUE is a TUPLE constraint —
                            // the individual columns are NOT unique on their
                            // own; the tuple is. Track multi-column UNIQUE
                            // in `compositeUniques` so `validateRow` enforces
                            // it as a tuple, matching SQL semantics.
                            if (cols.length === 1) {
                                const col = findColumn(table, cols[0]);
                                if (col) col.unique = true;
                            } else {
                                if (!Array.isArray(table.compositeUniques)) table.compositeUniques = [];
                                const dupe = table.compositeUniques.some(
                                    (cu) =>
                                        cu.cols.length === cols.length &&
                                        cu.cols.every((c, i) => c.toLowerCase() === cols[i].toLowerCase()),
                                );
                                if (!dupe) table.compositeUniques.push({ name: name || null, cols: [...cols] });
                            }
                            addIndexToTable(table, uniqueIndex);
                            log('success', `Added UNIQUE (${cols.join(', ')}) to "${table.name}"`);
                        }
                        continue;
                    }
                    // MySQL: ADD [FULLTEXT|SPATIAL] [INDEX|KEY] [name] (cols) [USING method]
                    if (isKW('FULLTEXT') || isKW('SPATIAL')) {
                        const type = peek().value.toLowerCase();
                        next();
                        consumeKW('INDEX');
                        consumeKW('KEY');
                        let name = null;
                        if (peek() && (peek().type === 'IDENT' || peek().type === 'STRING')) {
                            name = peek().value;
                            next();
                        }
                        const cols = readParenList();
                        if (consumeKW('USING')) {
                            if (peek() && (peek().type === 'KW' || peek().type === 'IDENT')) next();
                        }
                        if (table && cols) {
                            addIndexToTable(table, {
                                name,
                                columns: cols,
                                unique: false,
                                type,
                                clustered: null,
                                where: null,
                                include: [],
                            });
                            log('success', `Added ${type.toUpperCase()} INDEX${name ? ` "${name}"` : ''} (${cols.join(', ')}) to "${table.name}"`);
                        }
                        continue;
                    }
                    // MySQL: ADD [INDEX|KEY] [name] (cols) [USING method]
                    if (isKW('INDEX') || isKW('KEY')) {
                        next();
                        let name = null;
                        if (peek() && (peek().type === 'IDENT' || peek().type === 'STRING')) {
                            name = peek().value;
                            next();
                        }
                        const cols = readParenList();
                        let method = null;
                        if (consumeKW('USING')) {
                            const m = peek();
                            if (m && (m.type === 'KW' || m.type === 'IDENT')) {
                                method = String(m.value || '').toLowerCase();
                                next();
                            }
                        }
                        if (table && cols) {
                            addIndexToTable(table, {
                                name,
                                columns: cols,
                                unique: false,
                                type: method,
                                clustered: null,
                                where: null,
                                include: [],
                            });
                            log('success', `Added INDEX${name ? ` "${name}"` : ''} (${cols.join(', ')}) to "${table.name}"`);
                        }
                        continue;
                    }
                    if (isKW('FOREIGN')) {
                        next();
                        consumeKW('KEY');
                        const cols = readParenList();
                        consumeKW('REFERENCES');
                        const refTable = parseQualifiedIdent();
                        const refColumns = readParenList() || [];
                        let onDelete = null;
                        let onUpdate = null;
                        let deferrable = false;
                        let initiallyDeferred = false;
                        while (consumeKW('ON')) {
                            const eventToken = next();
                            const event = tokenWordValue(eventToken);
                            const first = tokenWordValue(peek());
                            if ((event !== 'DELETE' && event !== 'UPDATE') || !first) continue;
                            next();
                            let action = first;
                            const second = tokenWordValue(peek());
                            if ((first === 'SET' || first === 'NO') && second) {
                                action = `${first} ${second}`;
                                next();
                            }
                            if (event === 'DELETE') onDelete = action;
                            else onUpdate = action;
                        }
                        if (consumeKW('NOT')) {
                            if (consumeKW('DEFERRABLE')) {
                                deferrable = false;
                                initiallyDeferred = false;
                            }
                        } else if (consumeKW('DEFERRABLE')) {
                            deferrable = true;
                        }
                        if (consumeKW('INITIALLY')) {
                            if (consumeKW('DEFERRED')) {
                                deferrable = true;
                                initiallyDeferred = true;
                            } else if (consumeKW('IMMEDIATE')) {
                                initiallyDeferred = false;
                            }
                        }
                        if (table && cols) {
                            cols.forEach((c) => {
                                const col = findColumn(table, c);
                                if (col) {
                                    col.fk = true;
                                    if (refTable) col.refTable = refTable;
                                    col.refColumns = refColumns;
                                    col.onDelete = onDelete;
                                    col.onUpdate = onUpdate;
                                }
                            });
                            if (refTable) {
                                table.foreignKeys = table.foreignKeys || [];
                                table.foreignKeys.push({
                                    name: constraintName || null,
                                    columns: cols,
                                    refTable: stripSchema(refTable),
                                    refColumns,
                                    onDelete,
                                    onUpdate,
                                    deferrable,
                                    initiallyDeferred,
                                });
                            }
                            log('success', `Added FOREIGN KEY (${cols.join(', ')}) to "${table.name}"`);
                        }
                        continue;
                    }
                    if (isKW('CHECK')) {
                        next();
                        const expression = readParenExpression();
                        if (table && expression) {
                            if (!Array.isArray(table.checks)) table.checks = [];
                            table.checks.push({ name: constraintName || null, expression });
                            log('success', `Added CHECK constraint to "${table.name}"`);
                        } else if (table) {
                            log('error', `ALTER TABLE "${table.name}": CHECK requires a parenthesized expression`);
                        }
                        continue;
                    }

                    // ADD [COLUMN] <name> <type> [constraints]
                    consumeKW('COLUMN');
                    if (consumeKW('IF')) {
                        consumeKW('NOT');
                        consumeKW('EXISTS');
                    }
                    parseAddColumn(table);
                    continue;
                }

                if (consumeKW('DROP')) {
                    // DROP CONSTRAINT <name> / DROP PRIMARY KEY / DROP INDEX <name>
                    if (consumeKW('CONSTRAINT')) {
                        const ifExists = consumeKW('IF') && consumeKW('EXISTS');
                        const constraintName = parseIdent();
                        if (table && constraintName) {
                            if (dropNamedConstraint(table, constraintName)) {
                                log('success', `Dropped constraint "${constraintName}" from "${table.name}"`);
                            } else if (!ifExists) {
                                log('error', `ALTER "${table.name}": constraint "${constraintName}" does not exist`);
                            }
                        }
                        skipAlterActionTail();
                        continue;
                    }
                    if (isKW('PRIMARY')) {
                        next();
                        consumeKW('KEY');
                        if (table) {
                            table.columns.forEach((c) => {
                                if (c.pkImpliedNotNull) c.notNull = false;
                                c.pk = false;
                                delete c.pkImpliedNotNull;
                            });
                            table.compositePk = null;
                            table.primaryKeyName = null;
                            log('success', `Dropped PRIMARY KEY on "${table.name}"`);
                        }
                        continue;
                    }
                    if (consumeKW('INDEX') || consumeKW('KEY')) {
                        if (consumeKW('IF')) consumeKW('EXISTS');
                        const idxName = parseIdent();
                        if (table && idxName) {
                            if (removeIndexFromTable(table, idxName)) {
                                log('success', `Dropped index "${idxName}" on "${table.name}"`);
                            } else {
                                log('warning', `ALTER "${table.name}": index "${idxName}" does not exist`);
                            }
                        }
                        continue;
                    }
                    // DROP [COLUMN] [IF EXISTS] <name>
                    consumeKW('COLUMN');
                    if (consumeKW('IF')) consumeKW('EXISTS');
                    const colName = parseIdent();
                    if (table && colName) {
                        const i = table.columns.findIndex((c) => c.name.toLowerCase() === colName.toLowerCase());
                        if (i >= 0) {
                            const removed = table.columns.splice(i, 1)[0];
                            table.rows.forEach((r) => {
                                delete r[removed.name];
                            });
                            if (table._autoInc) table._autoInc.delete(removed.name.toLowerCase());
                            // Clean up indexes that referenced this column.
                            if (table.indexes && table.indexes.length) {
                                const target = removed.name.toLowerCase();
                                table.indexes = table.indexes
                                    .map((idx) => ({ ...idx, columns: idx.columns.filter((c) => c.toLowerCase() !== target) }))
                                    .filter((idx) => idx.columns.length > 0);
                            }
                            log('success', `Dropped column "${colName}" from "${table.name}"`);
                        } else {
                            log('warning', `ALTER "${table.name}": column "${colName}" does not exist`);
                        }
                    }
                    skipAlterActionTail();
                    continue;
                }

                // MODIFY [COLUMN] <name> <type> (MySQL)
                if (consumeKW('MODIFY')) {
                    consumeKW('COLUMN');
                    parseModifyColumn(table, null);
                    continue;
                }

                // CHANGE [COLUMN] <old> <new> <type> (MySQL)
                if (consumeKW('CHANGE')) {
                    consumeKW('COLUMN');
                    const oldName = parseIdent();
                    parseModifyColumn(table, oldName);
                    continue;
                }

                // ALTER [COLUMN] <name> TYPE <type> / SET NOT NULL / DROP NOT NULL / SET DEFAULT ...
                if (consumeKW('ALTER')) {
                    consumeKW('COLUMN');
                    parseAlterColumnAction(table);
                    continue;
                }

                // RENAME [COLUMN] <old> TO <new>  |  RENAME TO <new>
                if (consumeKW('RENAME')) {
                    if (consumeKW('COLUMN') || (peek() && peek().type !== 'KW')) {
                        const oldName = parseIdent();
                        consumeKW('TO');
                        const newName = parseIdent();
                        if (table && oldName && newName) {
                            const col = findColumn(table, oldName);
                            if (col) {
                                const oldKey = col.name;
                                col.name = newName;
                                table.rows.forEach((r) => {
                                    if (Object.prototype.hasOwnProperty.call(r, oldKey)) {
                                        r[newName] = r[oldKey];
                                        delete r[oldKey];
                                    }
                                });
                                if (table._autoInc && table._autoInc.has(oldKey.toLowerCase())) {
                                    const state = table._autoInc.get(oldKey.toLowerCase());
                                    table._autoInc.delete(oldKey.toLowerCase());
                                    table._autoInc.set(newName.toLowerCase(), state);
                                }
                                if (table.indexes) {
                                    const target = oldKey.toLowerCase();
                                    table.indexes.forEach((idx) => {
                                        idx.columns = idx.columns.map((c) => (c.toLowerCase() === target ? newName : c));
                                    });
                                }
                                log('success', `Renamed column "${oldName}" to "${newName}" in "${table.name}"`);
                            }
                        }
                        continue;
                    }
                    // RENAME TO <new_table>
                    consumeKW('TO');
                    const newTable = parseIdent();
                    if (table && newTable) {
                        tables.delete(table.name);
                        const renamed = { ...table, name: newTable };
                        tables.set(newTable, renamed);
                        log('success', `Renamed table "${table.name}" to "${newTable}"`);
                    }
                    continue;
                }

                next();
            }
            if (peek() && peek().type === 'PUNC' && peek().value === ';') next();
        }

        // Consume any trailing tokens until a comma or semicolon at depth 0
        // so multi-action ALTER statements stay synchronized.
        function skipAlterActionTail() {
            let d = 0;
            while (peek()) {
                const t = peek();
                if (t.type === 'PUNC' && t.value === '(') {
                    d++;
                    next();
                    continue;
                }
                if (t.type === 'PUNC' && t.value === ')') {
                    d--;
                    next();
                    continue;
                }
                if (d === 0 && t.type === 'PUNC' && (t.value === ',' || t.value === ';')) return;
                next();
            }
        }

        // Parse ADD COLUMN body: "<name> <type> [constraints]" using the same
        // token-collection logic as CREATE TABLE column entries.
        function parseAddColumn(table) {
            const entryTokens = collectAlterColumnEntry();
            if (!table || entryTokens.length === 0) return;
            const col = extractColumn(entryTokens);
            if (!col) return;
            const existing = findColumn(table, col.name);
            if (existing) {
                log('warning', `ALTER "${table.name}": column "${col.name}" already exists`);
                return;
            }
            table.columns.push(col);
            // ALTER TABLE ADD COLUMN can carry the same inline constraints
            // as CREATE TABLE. Mirror them into table-level execution
            // metadata so FK enforcement and a later DROP CONSTRAINT do not
            // disagree with the column badge shown in the UI.
            if (col.primaryKeyConstraintName) table.primaryKeyName = col.primaryKeyConstraintName;
            if (col.uniqueConstraintName) {
                addIndexToTable(table, {
                    name: col.uniqueConstraintName,
                    columns: [col.name],
                    unique: true,
                    constraint: true,
                    type: null,
                    clustered: null,
                    where: null,
                    include: [],
                });
            }
            if (col.fk && col.refTable) {
                table.foreignKeys = table.foreignKeys || [];
                table.foreignKeys.push({
                    name: col.foreignKeyConstraintName || null,
                    columns: [col.name],
                    refTable: stripSchema(col.refTable),
                    refColumns: Array.isArray(col.refColumns) ? col.refColumns : [],
                    onDelete: col.onDelete || null,
                    onUpdate: col.onUpdate || null,
                    deferrable: Boolean(col.deferrable),
                    initiallyDeferred: Boolean(col.initiallyDeferred),
                });
            }
            if (col.autoIncrement) {
                if (!table._autoInc) table._autoInc = new Map();
                const step = col.identityStep || 1;
                let next = col.identitySeed || 1;
                for (const r of table.rows) {
                    const v = Number(r[col.name]);
                    if (!isNaN(v) && v >= next) next = v + step;
                }
                table._autoInc.set(col.name.toLowerCase(), { next, step });
            }
            // Backfill existing rows. Defaults are evaluated PER row so that
            // non-deterministic defaults (UUID, CURRENT_TIMESTAMP, …) produce
            // a distinct value for each existing row.
            table.rows.forEach((r) => {
                if (Object.prototype.hasOwnProperty.call(r, col.name)) return;
                if (col.autoIncrement) {
                    resolveAutoIncrement(table, r);
                } else {
                    r[col.name] = col.defaultVal != null ? evalDefault(col.defaultVal) : null;
                }
            });
            log('success', `Added column "${col.name}" to "${table.name}"`);
        }

        // Parse MODIFY/CHANGE COLUMN body and replace the existing column
        // definition in place. When `renameFrom` is provided, the old column
        // name is renamed to the new name from the entry.
        function parseModifyColumn(table, renameFrom) {
            const entryTokens = collectAlterColumnEntry();
            if (!table || entryTokens.length === 0) return;
            const newCol = extractColumn(entryTokens);
            if (!newCol) return;
            const oldName = renameFrom || newCol.name;
            const idx2 = table.columns.findIndex((c) => c.name.toLowerCase() === oldName.toLowerCase());
            if (idx2 < 0) {
                log('warning', `ALTER "${table.name}": column "${oldName}" does not exist`);
                return;
            }
            const prevName = table.columns[idx2].name;
            table.columns[idx2] = newCol;
            if (prevName !== newCol.name) {
                table.rows.forEach((r) => {
                    if (Object.prototype.hasOwnProperty.call(r, prevName)) {
                        r[newCol.name] = r[prevName];
                        delete r[prevName];
                    }
                });
            }
            // Re-synchronize auto-increment state with the replacement column
            // definition. If the old column was auto-inc and the new one is
            // not (or vice versa), update the counters map accordingly.
            if (table._autoInc) {
                table._autoInc.delete(prevName.toLowerCase());
                if (newCol.autoIncrement) {
                    const step = newCol.identityStep || 1;
                    let next = newCol.identitySeed || 1;
                    for (const r of table.rows) {
                        const v = Number(r[newCol.name]);
                        if (!isNaN(v) && v >= next) next = v + step;
                    }
                    table._autoInc.set(newCol.name.toLowerCase(), { next, step });
                }
            }
            log('success', `Modified column "${oldName}" on "${table.name}"`);
        }

        // ALTER COLUMN <name> TYPE <type> / SET NOT NULL / DROP NOT NULL /
        // SET DEFAULT <value> / DROP DEFAULT (PostgreSQL flavor).
        function parseAlterColumnAction(table) {
            const name = parseIdent();
            if (!name) {
                skipAlterActionTail();
                return;
            }
            const col = table ? findColumn(table, name) : null;

            if (consumeKW('TYPE') || consumeKW('SET')) {
                // SET NOT NULL / SET DEFAULT ... / SET DATA TYPE ...
                if (isKW('NOT')) {
                    next();
                    consumeKW('NULL');
                    if (col) col.notNull = true;
                    skipAlterActionTail();
                    return;
                }
                if (consumeKW('DEFAULT')) {
                    const def = parseValue();
                    if (col) col.defaultVal = def != null ? String(def) : null;
                    skipAlterActionTail();
                    return;
                }
                if (consumeKW('DATA')) consumeKW('TYPE');
                // Treat remaining tokens up to , or ; as the new type string.
                const parts = [];
                while (peek()) {
                    const t = peek();
                    if (t.type === 'PUNC' && (t.value === ',' || t.value === ';')) break;
                    parts.push(t.raw || t.value);
                    next();
                }
                if (col && parts.length) col.type = parts.join(' ').trim();
                return;
            }
            if (consumeKW('DROP')) {
                if (consumeKW('NOT')) {
                    consumeKW('NULL');
                    if (col) col.notNull = false;
                } else if (consumeKW('DEFAULT')) {
                    if (col) col.defaultVal = null;
                }
                skipAlterActionTail();
                return;
            }
            skipAlterActionTail();
        }

        // Collect tokens that make up a single column definition inside an
        // ALTER TABLE ADD/MODIFY/CHANGE COLUMN clause, respecting parentheses
        // and stopping at the next top-level comma or statement terminator.
        function collectAlterColumnEntry() {
            const out = [];
            let d = 0;
            while (peek()) {
                const t = peek();
                if (t.type === 'PUNC' && t.value === '(') {
                    d++;
                    out.push(next());
                    continue;
                }
                if (t.type === 'PUNC' && t.value === ')') {
                    if (d === 0) break;
                    d--;
                    out.push(next());
                    continue;
                }
                if (d === 0 && t.type === 'PUNC' && (t.value === ',' || t.value === ';')) break;
                out.push(next());
            }
            return out;
        }

        // ════════════════════════════════════════════════════════════════
        //  Validation helpers — NOT NULL / PK / UQ / CHECK / FK
        // ════════════════════════════════════════════════════════════════
        //  Every INSERT and UPDATE candidate ends up here before it can be
        //  committed.  Mutations are statement-atomic: one integrity error
        //  rejects the full statement, rather than rendering a state that a
        //  database could never contain.  The helpers return diagnostics so
        //  the parser keeps its "never throw on user SQL" contract.
        //
        //  Order of checks (matches the comments inline below):
        //    1. NOT NULL (PK implies NN — columns flagged either way).
        //    2. PRIMARY KEY uniqueness — composite PK uses TUPLE equality.
        //    3. Single-column UNIQUE — only set on truly single-col UQ.
        //    4. Composite UNIQUE — tuple equality, like composite PK.
        //
        //  All column lookups are case-insensitive so INSERT column lists
        //  with different casing than the CREATE TABLE still match.
        // ════════════════════════════════════════════════════════════════

        function validateRow(table, row, rowLabel, { ignoreRow = null, constraintIndexes = null } = {}) {
            const warnings = [];
            // Build a case-insensitive map once so we tolerate INSERT col-list
            // case differences (USERS vs users) without false NOT-NULL hits.
            const rowKeys = Object.keys(row);
            const keyOf = (name) => rowKeys.find((k) => k.toLowerCase() === name.toLowerCase());

            for (const col of table.columns) {
                const k = keyOf(col.name);
                const val = k ? row[k] : undefined;
                // NOT NULL violation (PK implies NOT NULL)
                if ((col.notNull || col.pk) && (val === null || val === undefined)) {
                    warnings.push(`${rowLabel}: NOT NULL column "${col.name}" got NULL`);
                }
            }

            // ── PK uniqueness ──
            // Composite PKs: the constraint is on the TUPLE, not on each
            // column independently — fall back to single-column check when
            // the table has exactly one PK column.
            const pkCols = table.compositePk && table.compositePk.length > 1 ? table.compositePk : table.columns.filter((c) => c.pk).map((c) => c.name);
            if (pkCols.length > 0) {
                const tuple = pkCols.map((n) => {
                    const k = keyOf(n);
                    return k ? row[k] : undefined;
                });
                const anyNull = tuple.some((v) => v === null || v === undefined);
                if (!anyNull) {
                    const tupleKey = tuple.map((v) => String(v)).join('\u0001');
                    const dup = constraintIndexes?.pkKeys
                        ? constraintIndexes.pkKeys.has(tupleKey)
                        : table.rows.find((r) => {
                            if (r === row || r === ignoreRow) return false;
                            const otherKey = pkCols
                                .map((n) => {
                                    const k = Object.keys(r).find((x) => x.toLowerCase() === n.toLowerCase());
                                    return k ? String(r[k]) : 'undefined';
                                })
                                .join('\u0001');
                            return otherKey === tupleKey;
                        });
                    if (dup) {
                        const label = pkCols.length > 1 ? `composite PRIMARY KEY (${pkCols.join(', ')})` : `PRIMARY KEY "${pkCols[0]}"`;
                        const valueLabel = pkCols.length > 1 ? `(${tuple.map((v) => JSON.stringify(v)).join(', ')})` : JSON.stringify(tuple[0]);
                        warnings.push(`${rowLabel}: duplicate ${label} = ${valueLabel}`);
                    }
                }
            }

            // ── Single-column UNIQUE ──
            for (const col of table.columns) {
                if (!col.unique || col.pk) continue;
                const k = keyOf(col.name);
                const val = k ? row[k] : undefined;
                // PostgreSQL, MySQL, and SQLite allow any number of NULLs in
                // a UNIQUE key. SQL Server treats NULL as a comparable value,
                // so its ordinary UNIQUE constraint permits only one NULL.
                if ((val === null || val === undefined) && table.dialect !== 'mssql') continue;
                const uniqueKey = col.name.toLowerCase();
                const valueKey = uniqueConstraintValueKey(table, val);
                const dup = constraintIndexes?.singleUniqueKeys?.has(uniqueKey)
                    ? constraintIndexes.singleUniqueKeys.get(uniqueKey).has(valueKey)
                    : table.rows.find((r) => {
                        if (r === row || r === ignoreRow) return false;
                        const ok = Object.keys(r).find((x) => x.toLowerCase() === col.name.toLowerCase());
                        return ok && uniqueConstraintValueKey(table, r[ok]) === valueKey;
                    });
                if (dup) warnings.push(`${rowLabel}: duplicate UNIQUE "${col.name}" = ${JSON.stringify(val)}`);
            }

            // ── Composite UNIQUE tuples ──
            if (Array.isArray(table.compositeUniques)) {
                for (let uqIndex = 0; uqIndex < table.compositeUniques.length; uqIndex++) {
                    const uq = table.compositeUniques[uqIndex];
                    if (!uq.cols || uq.cols.length < 2) continue;
                    const tuple = uq.cols.map((n) => {
                        const k = keyOf(n);
                        return k ? row[k] : undefined;
                    });
                    const includeNulls = table.dialect === 'mssql';
                    if (!includeNulls && tuple.some((v) => v === null || v === undefined)) continue;
                    const tupleKey = constraintTupleKey(tuple, { includeNulls });
                    const indexedKeys = constraintIndexes?.compositeUniqueKeys?.[uqIndex];
                    const dup = indexedKeys
                        ? indexedKeys.has(tupleKey)
                        : table.rows.find((r) => {
                            if (r === row || r === ignoreRow) return false;
                            const otherKey = constraintTupleKey(uq.cols.map((n) => rowValue(r, n)), { includeNulls });
                            return otherKey === tupleKey;
                        });
                    if (dup) {
                        const valueLabel = `(${tuple.map((v) => JSON.stringify(v)).join(', ')})`;
                        warnings.push(`${rowLabel}: duplicate composite UNIQUE${uq.name ? ` "${uq.name}"` : ''} (${uq.cols.join(', ')}) = ${valueLabel}`);
                    }
                }
            }
            return warnings;
        }

        function quoteQueryIdentifier(identifier) {
            return `"${String(identifier || '').replace(/"/g, '""')}"`;
        }

        function validationTablesFor(table, rows) {
            const validationTables = new Map(tables);
            let replaced = false;
            for (const [key, candidate] of validationTables) {
                if (candidate === table || key.toLowerCase() === String(table?.name || '').toLowerCase()) {
                    validationTables.set(key, { ...table, rows });
                    replaced = true;
                    break;
                }
            }
            if (!replaced && table?.name) validationTables.set(table.name, { ...table, rows });
            return validationTables;
        }

        // A CHECK accepts TRUE and UNKNOWN (NULL).  Only an explicit FALSE
        // is a violation, which is exactly what `WHERE NOT (<check>)`
        // captures.  We intentionally use the Query View evaluator here so
        // DML and Query View share expression, NULL and dialect semantics.
        function validateCheckExpression(table, row, rowLabel, expression, label, _rows = table.rows) {
            const sql = typeof expression === 'string' ? expression.trim() : tokensToSql(expression || []).trim();
            if (!sql) return [];
            const query = `SELECT 1 FROM ${quoteQueryIdentifier(table.name)} WHERE NOT (${sql})`;
            const result = executeSelectQuery({ tables: validationTablesFor(table, [row]), query });
            if (result.errors?.length > 0) {
                return [`${rowLabel}: cannot faithfully evaluate CHECK${label ? ` "${label}"` : ''} (${result.errors[0].message})`];
            }
            return result.rows.length > 0
                ? [`${rowLabel}: CHECK${label ? ` "${label}"` : ''} constraint failed (${sql})`]
                : [];
        }

        function validateChecks(table, row, rowLabel, { rows = table.rows } = {}) {
            const errors = [];
            for (const column of table.columns || []) {
                if (column.check) {
                    errors.push(...validateCheckExpression(table, row, rowLabel, column.check, column.checkConstraintName || column.name, rows));
                }
                if (column.isEnum && Array.isArray(column.enumValues)) {
                    const value = rowValue(row, column.name);
                    if (value === null || value === undefined) continue;
                    const allowed = new Set(column.enumValues.map((item) => String(item)));
                    const values = String(value).split(',').map((item) => item.trim());
                    if (values.some((item) => !allowed.has(item))) {
                        errors.push(`${rowLabel}: value ${JSON.stringify(value)} is not valid for ${column.type} column "${column.name}"`);
                    }
                }
            }
            for (const check of table.checks || []) {
                errors.push(...validateCheckExpression(table, row, rowLabel, check.expression, check.name, rows));
            }
            return errors;
        }

        function uniqueIndexTupleKey(table, index, row) {
            const values = (index.columns || []).map((column) => rowValue(row, column));
            // PostgreSQL, MySQL, and SQLite do not consider two NULL key
            // values equal for a UNIQUE index. SQL Server does, unless the
            // filtered predicate excludes those rows.
            return constraintTupleKey(values, { includeNulls: table.dialect === 'mssql' });
        }

        function rowMatchesPartialUniqueIndex(table, row, index, rowLabel) {
            if (!index.where) return { matches: true, error: null };
            const query = `SELECT 1 FROM ${quoteQueryIdentifier(table.name)} WHERE (${index.where})`;
            const result = executeSelectQuery({ tables: validationTablesFor(table, [row]), query });
            if (result.errors?.length > 0) {
                return {
                    matches: false,
                    error: `${rowLabel}: cannot faithfully evaluate partial UNIQUE INDEX${index.name ? ` "${index.name}"` : ''} (${result.errors[0].message})`,
                };
            }
            return { matches: result.rows.length > 0, error: null };
        }

        function validateUniqueIndexCandidate(table, index, row, rowLabel, { rows = table.rows, ignoreRow = null } = {}) {
            const candidateMatch = rowMatchesPartialUniqueIndex(table, row, index, rowLabel);
            if (candidateMatch.error) return [candidateMatch.error];
            if (!candidateMatch.matches) return [];

            const candidateKey = uniqueIndexTupleKey(table, index, row);
            if (candidateKey == null) return [];
            for (const otherRow of rows || []) {
                if (otherRow === row || otherRow === ignoreRow) continue;
                const otherMatch = rowMatchesPartialUniqueIndex(table, otherRow, index, rowLabel);
                if (otherMatch.error) return [otherMatch.error];
                if (!otherMatch.matches) continue;
                if (uniqueIndexTupleKey(table, index, otherRow) === candidateKey) {
                    const values = (index.columns || []).map((column) => rowValue(row, column));
                    const label = index.columns?.length > 1
                        ? `(${index.columns.join(', ')})`
                        : `"${index.columns?.[0] || '?'}"`;
                    const value = index.columns?.length > 1
                        ? `(${values.map((item) => JSON.stringify(item)).join(', ')})`
                        : JSON.stringify(values[0]);
                    return [`${rowLabel}: duplicate UNIQUE INDEX${index.name ? ` "${index.name}"` : ''} ${label} = ${value}`];
                }
            }
            return [];
        }

        function validateUniqueIndexRows(table, index, rows = table.rows) {
            if (!index?.unique) return [];
            const seen = [];
            for (const row of rows || []) {
                const errors = validateUniqueIndexCandidate(table, index, row, `CREATE UNIQUE INDEX${index.name ? ` "${index.name}"` : ''}`, { rows: seen });
                if (errors.length > 0) return errors;
                seen.push(row);
            }
            return [];
        }

        function validatePartialUniqueIndexes(table, row, rowLabel, { rows = table.rows, ignoreRow = null } = {}) {
            const errors = [];
            for (const index of table.indexes || []) {
                if (!index?.unique || !index.where) continue;
                errors.push(...validateUniqueIndexCandidate(table, index, row, rowLabel, { rows, ignoreRow }));
            }
            return errors;
        }

        function isInitiallyDeferredForeignKey(table, foreignKey) {
            return Boolean(
                table?.dialect === 'postgres' &&
                transactionState &&
                foreignKey?.deferrable &&
                foreignKey?.initiallyDeferred,
            );
        }

        function validateForeignKeyReference(table, row, rowLabel, foreignKey, { rows = table.rows, tableRows = null } = {}) {
            const sourceColumns = Array.isArray(foreignKey.columns) ? foreignKey.columns : [];
            if (sourceColumns.length === 0) return [];
            const sourceValues = sourceColumns.map((column) => rowValue(row, column));
            // SQL permits an unpopulated FK. For a composite FK, any NULL
            // suppresses the check under MATCH SIMPLE, the portable default
            // used by SQLite/PostgreSQL/MySQL/SQL Server.
            if (sourceValues.some((value) => value === null || value === undefined)) return [];

            const parentTable = findTable(foreignKey.refTable);
            if (!parentTable || parentTable.isView) {
                return [`${rowLabel}: FOREIGN KEY (${sourceColumns.join(', ')}) references missing table "${foreignKey.refTable}"`];
            }
            const targetColumns = referencedColumns(parentTable, foreignKey);
            if (targetColumns.length === 0 || targetColumns.length !== sourceColumns.length) {
                return [`${rowLabel}: FOREIGN KEY (${sourceColumns.join(', ')}) has an invalid referenced key on "${parentTable.name}"`];
            }
            if (!isReferencedKeyUnique(parentTable, targetColumns)) {
                return [`${rowLabel}: FOREIGN KEY (${sourceColumns.join(', ')}) references "${parentTable.name}" columns (${targetColumns.join(', ')}) that are not PRIMARY KEY or unconditional UNIQUE`];
            }
            const parentRows = tableRows?.get(parentTable) || (parentTable === table ? rows : parentTable.rows);
            const matches = parentRows.some((parentRow) => foreignKeyMatchesParentRow(row, parentRow, parentTable, foreignKey));
            return matches
                ? []
                : [`${rowLabel}: FOREIGN KEY (${sourceColumns.join(', ')}) has no matching key in "${parentTable.name}"`];
        }

        function validateForeignKeys(table, row, rowLabel, { rows = table.rows, tableRows = null } = {}) {
            if (!isForeignKeyEnforcementEnabled()) return [];
            const errors = [];
            for (const foreignKey of table.foreignKeys || []) {
                // PostgreSQL defers this class of FK until COMMIT. Keeping
                // the row in the preview lets a later statement create its
                // parent key, while commit-time validation still rejects any
                // transaction that remains inconsistent.
                if (isInitiallyDeferredForeignKey(table, foreignKey)) continue;
                errors.push(...validateForeignKeyReference(table, row, rowLabel, foreignKey, { rows, tableRows }));
            }
            return errors;
        }

        function validateDeferredForeignKeysAtCommit() {
            if (!isForeignKeyEnforcementEnabled() || dialectProfile.id !== 'postgres') return [];
            const tableRows = new Map(Array.from(tables.values()).map((table) => [table, table.rows]));
            const errors = [];
            for (const table of tables.values()) {
                if (!table || table.isView) continue;
                for (const foreignKey of table.foreignKeys || []) {
                    if (!foreignKey?.deferrable || !foreignKey?.initiallyDeferred) continue;
                    for (const row of table.rows || []) {
                        errors.push(...validateForeignKeyReference(table, row, `COMMIT "${table.name}"`, foreignKey, { rows: table.rows, tableRows }));
                    }
                }
            }
            return errors;
        }

        function isForeignKeyEnforcementEnabled() {
            // SQLite starts with foreign keys disabled unless the connection
            // enables PRAGMA foreign_keys. The server dialects covered here
            // enforce declared FKs by default. An explicit session command
            // always wins over that default.
            return foreignKeyEnforcement ?? dialectProfile.id !== 'sqlite';
        }

        function validateMutationRow(table, row, rowLabel, {
            rows = table.rows,
            ignoreRow = null,
            constraintIndexes = null,
            tableRows = null,
        } = {}) {
            const validationTable = rows === table.rows ? table : { ...table, rows };
            return [
                ...validateRow(validationTable, row, rowLabel, { ignoreRow, constraintIndexes }),
                ...validateSqliteStrictTypes(table, row, rowLabel),
                ...validateChecks(table, row, rowLabel, { rows }),
                ...validatePartialUniqueIndexes(table, row, rowLabel, { rows, ignoreRow }),
                ...validateForeignKeys(table, row, rowLabel, { rows, tableRows }),
            ];
        }

        function normalizeSqliteRow(table, row) {
            if (table?.dialect !== 'sqlite') return;
            for (const column of table.columns) {
                const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === column.name.toLowerCase());
                if (!key || row[key] === null || row[key] === undefined) continue;
                const type = String(column.type || '').toUpperCase();
                if (/INT/.test(type)) {
                    const numeric = sqliteNumericValue(row[key]);
                    if (numeric != null && Number.isInteger(numeric)) row[key] = numeric;
                    continue;
                }
                if (/REAL|FLOA|DOUB|NUMERIC|DECIMAL/.test(type)) {
                    const numeric = sqliteNumericValue(row[key]);
                    if (numeric != null) row[key] = numeric;
                    continue;
                }
                if (/CHAR|CLOB|TEXT/.test(type)) {
                    if (!isSqliteBlobValue(row[key])) row[key] = String(row[key]);
                }
            }
        }

        function validateSqliteStrictTypes(table, row, rowLabel) {
            if (table?.dialect !== 'sqlite' || !table.strict) return [];
            const warnings = [];
            for (const column of table.columns) {
                const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === column.name.toLowerCase());
                if (!key || row[key] === null || row[key] === undefined) continue;

                const family = sqliteStrictTypeFamily(column.type);
                // SQLite itself rejects invalid STRICT declarations during
                // CREATE TABLE. Data View keeps DDL parsing tolerant for mixed
                // dialect previews, so unknown strict types remain display-only
                // here instead of retroactively deleting the table.
                if (!family) continue;

                const value = row[key];
                if (family === 'any') continue;
                if (family === 'integer') {
                    const numeric = sqliteNumericValue(value);
                    if (numeric != null && Number.isInteger(numeric)) continue;
                    warnings.push(`${rowLabel}: cannot store ${sqliteStorageClassLabel(value)} value in ${column.type} column "${column.name}"`);
                    continue;
                }
                if (family === 'real') {
                    if (sqliteNumericValue(value) != null) continue;
                    warnings.push(`${rowLabel}: cannot store ${sqliteStorageClassLabel(value)} value in ${column.type} column "${column.name}"`);
                    continue;
                }
                if (family === 'text') {
                    if (!isSqliteBlobValue(value)) continue;
                    warnings.push(`${rowLabel}: cannot store BLOB value in ${column.type} column "${column.name}"`);
                    continue;
                }
                if (family === 'blob') {
                    if (isSqliteBlobValue(value)) continue;
                    warnings.push(`${rowLabel}: cannot store ${sqliteStorageClassLabel(value)} value in ${column.type} column "${column.name}"`);
                }
            }
            return warnings;
        }


        function cloneAutoIncrementState(autoInc) {
            if (!autoInc) return autoInc;
            const cloned = new Map();
            for (const [key, state] of autoInc) {
                cloned.set(key, { ...state });
            }
            return cloned;
        }

        function uniqueConstraintValueKey(table, value) {
            // Use an unambiguous sentinel: a real string value such as
            // "null" must never collide with SQL NULL in a SQL Server
            // UNIQUE key. Other values retain the executor's existing
            // string-comparison behavior.
            if (table?.dialect === 'mssql' && (value === null || value === undefined)) return '\u0000NULL';
            return String(value);
        }

        function constraintTupleKey(values, { includeNulls = false } = {}) {
            if (!includeNulls && values.some((value) => value === null || value === undefined)) return null;
            return values.map((value) =>
                value === null || value === undefined ? '\u0000NULL' : String(value),
            ).join('\u0001');
        }

        function rowConstraintKey(row, cols, { includeNulls = false } = {}) {
            const values = cols.map((name) => {
                const key = Object.keys(row || {}).find((candidate) => candidate.toLowerCase() === String(name || '').toLowerCase());
                return key ? row[key] : undefined;
            });
            return constraintTupleKey(values, { includeNulls });
        }

        function buildConstraintIndexes(table, rows) {
            const pkCols = table.compositePk && table.compositePk.length > 1
                ? table.compositePk
                : table.columns.filter((column) => column.pk).map((column) => column.name);
            const singleUniqueColumns = table.columns.filter((column) => column.unique && !column.pk);
            const indexes = {
                pkCols,
                pkKeys: pkCols.length > 0 ? new Set() : null,
                singleUniqueColumns,
                singleUniqueKeys: new Map(singleUniqueColumns.map((column) => [column.name.toLowerCase(), new Set()])),
                compositeUniqueKeys: Array.isArray(table.compositeUniques)
                    ? table.compositeUniques.map(() => new Set())
                    : [],
            };
            (rows || []).forEach((row) => addRowToConstraintIndexes(table, indexes, row));
            return indexes;
        }

        function addRowToConstraintIndexes(table, indexes, row) {
            if (!indexes || !row) return;
            if (indexes.pkKeys && indexes.pkCols.length > 0) {
                const key = rowConstraintKey(row, indexes.pkCols);
                if (key != null) indexes.pkKeys.add(key);
            }
            for (const column of indexes.singleUniqueColumns || []) {
                const rowKey = Object.keys(row).find((candidate) => candidate.toLowerCase() === column.name.toLowerCase());
                const value = rowKey ? row[rowKey] : undefined;
                if ((value === null || value === undefined) && table.dialect !== 'mssql') continue;
                indexes.singleUniqueKeys.get(column.name.toLowerCase())?.add(uniqueConstraintValueKey(table, value));
            }
            if (Array.isArray(table.compositeUniques)) {
                table.compositeUniques.forEach((unique, index) => {
                    if (!unique?.cols || unique.cols.length < 2) return;
                    const key = rowConstraintKey(row, unique.cols, { includeNulls: table.dialect === 'mssql' });
                    if (key != null) indexes.compositeUniqueKeys[index]?.add(key);
                });
            }
        }

        // ── Foreign-key referential actions ────────────────────────────
        // DML must never leave a dangling key.  We stage delete actions over
        // the whole relation graph and only mutate the real tables once the
        // plan is valid. `RESTRICT` and immediate `NO ACTION` are equivalent
        // here; PostgreSQL's explicitly deferred NO ACTION is validated at
        // COMMIT so a transaction may repair the relationship first.
        function rowValue(row, columnName) {
            const key = Object.keys(row || {}).find((candidate) => candidate.toLowerCase() === String(columnName || '').toLowerCase());
            return key ? row[key] : undefined;
        }

        function referencedColumns(parentTable, foreignKey) {
            const explicit = Array.isArray(foreignKey?.refColumns) ? foreignKey.refColumns.filter(Boolean) : [];
            if (explicit.length > 0) return explicit;
            if (Array.isArray(parentTable?.compositePk) && parentTable.compositePk.length > 0) return parentTable.compositePk;
            return (parentTable?.columns || []).filter((column) => column.pk).map((column) => column.name);
        }

        function columnsMatchKey(left, right) {
            return left.length === right.length && left.every((column, index) =>
                String(column).toLowerCase() === String(right[index]).toLowerCase(),
            );
        }

        function isReferencedKeyUnique(parentTable, targetColumns) {
            if (!parentTable || !Array.isArray(targetColumns) || targetColumns.length === 0) return false;
            const primaryKeyColumns = parentTable.compositePk?.length
                ? parentTable.compositePk
                : (parentTable.columns || []).filter((column) => column.pk).map((column) => column.name);
            if (columnsMatchKey(primaryKeyColumns, targetColumns)) return true;
            if (targetColumns.length === 1 && findColumn(parentTable, targetColumns[0])?.unique) return true;

            // A filtered/partial unique index cannot be a foreign-key target:
            // values outside its predicate may still be duplicated. Only an
            // unconditional UNIQUE index/constraint provides a parent key.
            return (parentTable.indexes || []).some((index) =>
                index.unique && !index.where && columnsMatchKey(index.columns || [], targetColumns),
            );
        }

        function foreignKeyMatchesParentRow(childRow, parentRow, parentTable, foreignKey) {
            const sourceColumns = Array.isArray(foreignKey?.columns) ? foreignKey.columns : [];
            const targetColumns = referencedColumns(parentTable, foreignKey);
            if (sourceColumns.length === 0 || sourceColumns.length !== targetColumns.length) return false;

            return sourceColumns.every((sourceColumn, index) => {
                const childValue = rowValue(childRow, sourceColumn);
                const targetColumn = targetColumns[index];
                const parentValue = rowValue(parentRow, targetColumn);
                // A NULL in a foreign-key column does not reference a parent
                // row under SQL's FK semantics.
                if (childValue === null || childValue === undefined || parentValue === null || parentValue === undefined) return false;
                // SQLite compares FK values using the parent key column's
                // affinity/collation. This matters for cases like parent
                // INTEGER id=1 and child TEXT pid='01': SQLite treats them as
                // equal and cascades. Plain string equality would miss it.
                if (parentTable?.dialect === 'sqlite') {
                    const parentColumn = findColumn(parentTable, targetColumn);
                    return compareWhereValues(parentValue, childValue, parentColumn, parentTable) === 0;
                }
                return String(childValue) === String(parentValue);
            });
        }

        function referentialAction(action) {
            return String(action || 'NO ACTION').trim().toUpperCase();
        }

        function planDelete(table, initialRows) {
            const deletingByTable = new Map();
            const updatingRows = new Map();
            const errors = [];

            // With FK checks disabled, a database leaves existing child rows
            // untouched: it neither rejects the parent DELETE nor performs a
            // CASCADE / SET NULL action. Stage only the rows the user asked
            // to delete so Data View follows that connection setting.
            if (!isForeignKeyEnforcementEnabled()) {
                deletingByTable.set(table, new Set(initialRows || []));
                return { deletingByTable, updatingRows, errors };
            }

            const deleting = (candidateTable) => {
                if (!deletingByTable.has(candidateTable)) deletingByTable.set(candidateTable, new Set());
                return deletingByTable.get(candidateTable);
            };
            const isDeleting = (candidateTable, row) => deletingByTable.get(candidateTable)?.has(row) || false;

            const stageDelete = (parentTable, rows) => {
                const freshRows = (rows || []).filter((row) => row && !isDeleting(parentTable, row));
                if (freshRows.length === 0) return;
                freshRows.forEach((row) => deleting(parentTable).add(row));

                for (const childTable of tables.values()) {
                    if (!childTable || childTable.isView || !Array.isArray(childTable.foreignKeys)) continue;
                    for (const foreignKey of childTable.foreignKeys) {
                        if (!foreignKey?.refTable || stripSchema(foreignKey.refTable).toLowerCase() !== parentTable.name.toLowerCase()) continue;
                        const childRows = childTable.rows.filter((childRow) =>
                            !isDeleting(childTable, childRow) && freshRows.some((parentRow) =>
                                foreignKeyMatchesParentRow(childRow, parentRow, parentTable, foreignKey),
                            ),
                        );
                        if (childRows.length === 0) continue;

                        const action = referentialAction(foreignKey.onDelete);
                        if (action === 'NO ACTION' && isInitiallyDeferredForeignKey(childTable, foreignKey)) {
                            // PostgreSQL permits this temporary dangling key
                            // until COMMIT, where validateDeferred… checks
                            // the final state of the transaction.
                            continue;
                        }
                        if (action === 'CASCADE') {
                            stageDelete(childTable, childRows);
                            continue;
                        }
                        if (action === 'SET NULL' || action === 'SET DEFAULT') {
                            for (const childRow of childRows) {
                                const candidate = { ...(updatingRows.get(childRow)?.row || childRow) };
                                for (const sourceColumn of foreignKey.columns || []) {
                                    const column = findColumn(childTable, sourceColumn);
                                    candidate[sourceColumn] = action === 'SET NULL'
                                        ? null
                                        : (column?.defaultVal != null ? evalDefault(column.defaultVal) : null);
                                }
                                normalizeSqliteRow(childTable, candidate);
                                resolveGeneratedColumns(childTable, candidate);
                                updatingRows.set(childRow, { table: childTable, row: candidate, action });
                            }
                            continue;
                        }
                        errors.push(`DELETE FROM "${parentTable.name}": FOREIGN KEY (${foreignKey.columns.join(', ')}) in "${childTable.name}" prevents deleting ${childRows.length} referenced row(s) (${action})`);
                    }
                }
            };

            stageDelete(table, initialRows);

            // SET NULL / SET DEFAULT can themselves violate NOT NULL, CHECK,
            // UNIQUE, enum, or another foreign key.  Validate the *final*
            // multi-table state so `SET DEFAULT` cannot quietly retain the
            // very parent row that this plan is deleting.
            const finalRows = new Map(Array.from(tables.values()).map((candidateTable) => [
                candidateTable,
                candidateTable.rows
                    .filter((row) => !isDeleting(candidateTable, row))
                    .map((row) => updatingRows.get(row)?.row || row),
            ]));
            for (const [originalRow, update] of updatingRows) {
                if (isDeleting(update.table, originalRow)) continue;
                errors.push(...validateMutationRow(update.table, update.row, `ON DELETE ${update.action} "${update.table.name}"`, {
                    rows: finalRows.get(update.table) || update.table.rows,
                    ignoreRow: update.row,
                    tableRows: finalRows,
                }));
            }

            return { deletingByTable, updatingRows, errors };
        }

        function applyDeletePlan(plan) {
            for (const [originalRow, update] of plan.updatingRows) {
                if (!plan.deletingByTable.get(update.table)?.has(originalRow)) Object.assign(originalRow, update.row);
            }
            let deleted = 0;
            for (const [table, rows] of plan.deletingByTable) {
                table.rows = table.rows.filter((row) => !rows.has(row));
                deleted += rows.size;
            }
            return deleted;
        }

        function sameReferencedValue(left, right, column, table) {
            return compareWhereValues(left, right, column, table) === 0;
        }

        // Stage every child-table effect of updating a referenced parent key.
        // The plan is recursive, so `parent → child → grandchild` cascades
        // commit as one unit. PostgreSQL's explicitly deferred NO ACTION is
        // the one exception: a transaction may repair it before COMMIT.
        function planUpdateReferentialActions(rootTable, initialUpdates) {
            if (!isForeignKeyEnforcementEnabled()) {
                return {
                    updates: new Map(Array.from(initialUpdates, ([originalRow, row]) => [
                        originalRow,
                        { table: row.table || rootTable, row: row.row || row },
                    ])),
                    errors: [],
                };
            }
            const updates = new Map(Array.from(initialUpdates, ([originalRow, row]) => [
                originalRow,
                { table: rootTable, row },
            ]));
            const errors = [];
            const rowIds = new WeakMap();
            const processedTransitions = new Set();
            let nextRowId = 1;
            const rowId = (row) => {
                if (!rowIds.has(row)) rowIds.set(row, nextRowId++);
                return rowIds.get(row);
            };
            const currentRow = (row) => updates.get(row)?.row || row;
            const tableRows = () => new Map(Array.from(tables.values()).map((table) => [
                table,
                table.rows.map((row) => currentRow(row)),
            ]));
            const queue = Array.from(initialUpdates, ([originalRow, update]) => ({
                table: update.table || rootTable,
                originalRow,
                before: originalRow,
                after: update.row || update,
            }));

            while (queue.length > 0 && errors.length === 0) {
                const parentChange = queue.shift();
                const transitionKey = `${parentChange.table.name}:${rowId(parentChange.originalRow)}:${JSON.stringify(parentChange.after)}`;
                if (processedTransitions.has(transitionKey)) continue;
                processedTransitions.add(transitionKey);

                for (const childTable of tables.values()) {
                    if (!childTable || childTable.isView || !Array.isArray(childTable.foreignKeys)) continue;
                    for (const foreignKey of childTable.foreignKeys) {
                        if (!foreignKey?.refTable || stripSchema(foreignKey.refTable).toLowerCase() !== parentChange.table.name.toLowerCase()) continue;
                        const targetColumns = referencedColumns(parentChange.table, foreignKey);
                        const sourceColumns = Array.isArray(foreignKey.columns) ? foreignKey.columns : [];
                        if (targetColumns.length === 0 || targetColumns.length !== sourceColumns.length) {
                            errors.push(`UPDATE "${parentChange.table.name}": FOREIGN KEY (${sourceColumns.join(', ')}) in "${childTable.name}" has an invalid referenced key`);
                            continue;
                        }
                        const keyChanged = targetColumns.some((targetColumn) => {
                            const column = findColumn(parentChange.table, targetColumn);
                            return !sameReferencedValue(
                                rowValue(parentChange.before, targetColumn),
                                rowValue(parentChange.after, targetColumn),
                                column,
                                parentChange.table,
                            );
                        });
                        if (!keyChanged) continue;

                        const affectedRows = childTable.rows.filter((originalChildRow) =>
                            foreignKeyMatchesParentRow(currentRow(originalChildRow), parentChange.before, parentChange.table, foreignKey),
                        );
                        if (affectedRows.length === 0) continue;

                        const action = referentialAction(foreignKey.onUpdate);
                        if (action === 'NO ACTION' && isInitiallyDeferredForeignKey(childTable, foreignKey)) {
                            continue;
                        }
                        if (action !== 'CASCADE' && action !== 'SET NULL' && action !== 'SET DEFAULT') {
                            errors.push(`UPDATE "${parentChange.table.name}": FOREIGN KEY (${sourceColumns.join(', ')}) in "${childTable.name}" prevents updating ${affectedRows.length} referenced row(s) (${action})`);
                            continue;
                        }

                        for (const originalChildRow of affectedRows) {
                            const before = currentRow(originalChildRow);
                            const candidate = { ...before };
                            sourceColumns.forEach((sourceColumn, index) => {
                                const column = findColumn(childTable, sourceColumn);
                                if (action === 'CASCADE') candidate[sourceColumn] = rowValue(parentChange.after, targetColumns[index]);
                                else if (action === 'SET NULL') candidate[sourceColumn] = null;
                                else candidate[sourceColumn] = column?.defaultVal != null ? evalDefault(column.defaultVal) : null;
                            });
                            normalizeSqliteRow(childTable, candidate);
                            resolveGeneratedColumns(childTable, candidate);
                            updates.set(originalChildRow, { table: childTable, row: candidate, action });
                            queue.push({ table: childTable, originalRow: originalChildRow, before, after: candidate });
                        }
                    }
                }
            }

            if (errors.length === 0) {
                const finalRows = tableRows();
                for (const [, update] of updates) {
                    const rows = finalRows.get(update.table) || update.table.rows;
                    errors.push(...validateMutationRow(update.table, update.row, `UPDATE "${update.table.name}"`, {
                        rows,
                        // `rows` contains the candidate object, so pass it as
                        // the ignored self row for uniqueness validation.
                        ignoreRow: update.row,
                        tableRows: finalRows,
                    }));
                }
            }
            return { updates, errors };
        }

        // ════════════════════════════════════════════════════════════════
        //  INSERT — multi-tuple values + DEFAULT keyword
        // ════════════════════════════════════════════════════════════════
        //  Grammar accepted:
        //    INSERT INTO table [(col, col, …)] VALUES
        //        (val, val, …)
        //      [, (val, val, …)]*
        //      [;]
        //    INSERT INTO table [(col, col, …)] SELECT ...
        //
        //  Each VALUES tuple or SELECT result row becomes one table row. A
        //  bare `DEFAULT` in the value list resolves to the column's declared
        //  default — or the next auto-increment value if the column has one —
        //  via the `DEFAULT_SENTINEL` symbol from `parseParenValues`.
        //
        //  Auto-increment columns: any explicit numeric value the user
        //  inserts also bumps the counter past it, so subsequent DEFAULTs
        //  don't collide. Mirrors PostgreSQL/MySQL/MSSQL behaviour.
        //
        //  All validation goes through `validateMutationRow`. Failed
        //  validation rejects the complete statement and preserves the
        //  prior table state.
        // ════════════════════════════════════════════════════════════════

        function parseInsert() {
            // The Data View intentionally models a focused INSERT subset.
            // Do not partially apply dialect-specific conflict/returning
            // syntax: applying only the VALUES prefix would show data that
            // the source database might have ignored, replaced, or updated.
            const first = peek();
            const second = peek(1);
            const firstWord = first && (first.type === 'KW' || first.type === 'IDENT') ? String(first.value).toUpperCase() : '';
            const secondWord = second && (second.type === 'KW' || second.type === 'IDENT') ? String(second.value).toUpperCase() : '';
            if (firstWord === 'IGNORE' || (firstWord === 'OR' && ['IGNORE', 'REPLACE', 'ABORT', 'FAIL', 'ROLLBACK'].includes(secondWord))) {
                log('error', 'INSERT conflict modifiers are not supported in Data View; no rows were applied.');
                skipToSemicolon();
                return;
            }

            let depth = 0;
            let seenValues = false;
            for (let lookahead = idx; lookahead < len; lookahead++) {
                const token = tokens[lookahead];
                if (token.type === 'PUNC' && token.value === '(') depth++;
                else if (token.type === 'PUNC' && token.value === ')') depth--;
                else if (depth === 0 && token.type === 'PUNC' && token.value === ';') break;

                if (depth !== 0) continue;
                const word = token && (token.type === 'KW' || token.type === 'IDENT') ? String(token.value).toUpperCase() : '';
                const nextWord = tokens[lookahead + 1] && (tokens[lookahead + 1].type === 'KW' || tokens[lookahead + 1].type === 'IDENT') ? String(tokens[lookahead + 1].value).toUpperCase() : '';
                if (word === 'VALUES') seenValues = true;
                if (seenValues && ((word === 'ON' && (nextWord === 'CONFLICT' || nextWord === 'DUPLICATE')) || word === 'RETURNING')) {
                    log('error', 'INSERT conflict/RETURNING clauses are not supported in Data View; no rows were applied.');
                    skipToSemicolon();
                    return;
                }
            }

            consumeKW('INTO');
            const tableName = parseQualifiedIdent();
            if (!tableName) {
                log('error', 'INSERT: missing table name');
                skipToSemicolon();
                return;
            }

            const table = findTable(tableName);
            if (!table) {
                log('error', `INSERT INTO "${tableName}": table does not exist`);
                skipToSemicolon();
                return;
            }

            let specifiedColumns = null;
            if (peek() && peek().type === 'PUNC' && peek().value === '(') {
                specifiedColumns = readParenList();
            }
            const cols = specifiedColumns || table.columns.map((c) => c.name);

            // Validate specified columns exist
            if (specifiedColumns) {
                const unknownCols = specifiedColumns.filter((c) => !findColumn(table, c));
                if (unknownCols.length > 0) {
                    log('error', `INSERT INTO "${table.name}": unknown column(s): ${unknownCols.join(', ')}`);
                    skipToSemicolon();
                    return;
                }
                const seenColumns = new Set();
                const duplicateCols = [];
                for (const columnName of specifiedColumns) {
                    const key = String(columnName || '').toLowerCase();
                    if (seenColumns.has(key)) duplicateCols.push(columnName);
                    else seenColumns.add(key);
                }
                if (duplicateCols.length > 0) {
                    log('error', `INSERT INTO "${table.name}": duplicate column(s): ${duplicateCols.join(', ')}`);
                    skipToSemicolon();
                    return;
                }
            }

            let rowCount = 0;
            let attemptedRowCount = 0;
            // An INSERT is a single statement in every supported engine. Do
            // all validation against staged rows, then commit once; never
            // retain tuple 1 when tuple 2 violates a constraint.
            const atomicInsert = true;
            // SQLite rolls its rowid/autoincrement state back with a failed
            // statement. PostgreSQL sequences and SQL Server/MySQL identity
            // counters may intentionally leave gaps, so only SQLite gets a
            // transactional copy of its counter state here.
            const transactionalAutoIncrement = table.dialect === 'sqlite';
            const stagedRows = [];
            const stagedAutoInc = transactionalAutoIncrement ? cloneAutoIncrementState(table._autoInc) : table._autoInc;
            const insertErrors = [];
            const stagedRowObjects = () => stagedRows.map(({ row }) => row);

            function insertValues(values, valueColumns = cols) {
                if (!values) return;
                attemptedRowCount++;
                const rowLabel = `INSERT INTO "${table.name}" row ${attemptedRowCount}`;
                // Column count mismatch
                if (values.length !== valueColumns.length) {
                    const message = `${rowLabel}: expected ${valueColumns.length} values but got ${values.length}`;
                    insertErrors.push(message);
                    return;
                }

                const row = {};
                table.columns.forEach((c) => {
                    row[c.name] = c.defaultVal != null ? evalDefault(c.defaultVal) : null;
                });
                valueColumns.forEach((colName, i) => {
                    const mc = findColumn(table, colName);
                    if (!mc) return;
                    let val = i < values.length ? values[i] : null;
                    if (mc.generatedExpr?.length > 0 && val !== DEFAULT_SENTINEL) {
                        insertErrors.push(`${rowLabel}: cannot insert an explicit value into generated column "${mc.name}"`);
                        return;
                    }
                    // `DEFAULT` keyword in VALUES list — fall back to the
                    // declared column default (or NULL when none). Auto-inc
                    // resolution below will then assign a fresh id.
                    if (val === DEFAULT_SENTINEL) {
                        val = mc.defaultVal != null ? evalDefault(mc.defaultVal) : null;
                    }
                    row[mc.name] = val;
                });

                // SQLite applies column affinity before generated expressions
                // and constraint checks (for example, INTEGER receives '01'
                // as the numeric value 1). Store that normalized value so the
                // preview cannot retain a state SQLite would reject.
                normalizeSqliteRow(table, row);
                // Resolve auto-increment / IDENTITY / SERIAL columns.
                resolveAutoIncrement(table, row, atomicInsert ? {
                    rows: [...table.rows, ...stagedRowObjects()],
                    autoInc: stagedAutoInc,
                } : undefined);
                // Resolve UUID default columns (gen_random_uuid, NEWID, …).
                resolveUuidDefaults(table, row);
                // Evaluate GENERATED ALWAYS AS (...) STORED columns.
                resolveGeneratedColumns(table, row);

                stagedRows.push({ row, rowLabel });
            }

            if (consumeKW('DEFAULT')) {
                if (!consumeKW('VALUES')) {
                    log('error', `INSERT INTO "${table.name}": expected VALUES after DEFAULT`);
                    skipToSemicolon();
                    return;
                }
                insertValues([], []);
            } else if (consumeKW('VALUES')) {
                let sawTuple = false;
                do {
                    if (!(peek() && peek().type === 'PUNC' && peek().value === '(')) break;
                    sawTuple = true;
                    insertValues(parseParenValues());
                } while (peek() && peek().type === 'PUNC' && peek().value === ',' && next());
                if (!sawTuple) insertErrors.push(`INSERT INTO "${table.name}": VALUES requires at least one row tuple`);
            } else if (isSelectStartToken(peek())) {
                const queryTokens = readStatementTailTokens();
                const result = executeSelectTokens(queryTokens, `INSERT INTO "${table.name}" SELECT`, 'error');
                if (result?.ok) {
                    result.rows.forEach((values) => insertValues(values));
                }
            } else {
                log('error', `INSERT INTO "${table.name}": expected VALUES or SELECT query`);
                skipToSemicolon();
                return;
            }

            if (peek() && peek().type === 'PUNC' && peek().value === ';') next();
            if (insertErrors.length === 0 && stagedRows.length > 0) {
                const finalRows = [...table.rows, ...stagedRowObjects()];
                const finalTableRows = new Map(Array.from(tables.values()).map((candidateTable) => [
                    candidateTable,
                    candidateTable === table ? finalRows : candidateTable.rows,
                ]));
                const insertConstraintIndexes = buildConstraintIndexes(table, table.rows);
                const priorRows = [...table.rows];
                for (const { row, rowLabel } of stagedRows) {
                    const rowErrors = validateMutationRow(table, row, rowLabel, {
                        rows: priorRows,
                        constraintIndexes: insertConstraintIndexes,
                        tableRows: finalTableRows,
                    });
                    if (rowErrors.length > 0) {
                        insertErrors.push(...rowErrors);
                        break;
                    }
                    priorRows.push(row);
                    addRowToConstraintIndexes(table, insertConstraintIndexes, row);
                }
            }
            if (insertErrors.length > 0) {
                insertErrors.forEach((message) => log('error', message));
                return;
            }
            if (stagedRows.length > 0) {
                table.rows.push(...stagedRowObjects());
                if (transactionalAutoIncrement && stagedAutoInc) table._autoInc = stagedAutoInc;
                rowCount = stagedRows.length;
            }
            if (rowCount > 0) {
                log('success', `Inserted ${rowCount} row(s) into "${table.name}"`);
            }
        }

        // Fill in auto-increment / IDENTITY / SERIAL column values on a row
        // being inserted. When the caller provided an explicit numeric value,
        // bump the counter past it so future auto-assignments stay unique.
        // SQLite's non-AUTOINCREMENT `INTEGER PRIMARY KEY` is special: it
        // aliases rowid and uses the current maximum rowid, allowing a deleted
        // maximum to be reused. That rule is enabled only by the SQLite
        // dialect profile.
        function resolveAutoIncrement(table, row, { rows = table.rows, autoInc: autoIncState = table._autoInc } = {}) {
            for (const col of table.columns) {
                if (!col.sqliteRowidAlias || col.autoIncrement) continue;
                const current = row[col.name];
                if (current === null || current === undefined) {
                    let max = null;
                    for (const existingRow of rows) {
                        const value = Number(existingRow[col.name]);
                        if (Number.isFinite(value) && Number.isInteger(value) && (max === null || value > max)) max = value;
                    }
                    row[col.name] = max === null ? 1 : max + 1;
                }
            }

            const autoInc = autoIncState;
            if (!autoInc || autoInc.size === 0) return;
            for (const col of table.columns) {
                if (!col.autoIncrement) continue;
                const state = autoInc.get(col.name.toLowerCase());
                if (!state) continue;
                const current = row[col.name];
                if (current === null || current === undefined) {
                    row[col.name] = state.next;
                    state.next += state.step;
                } else {
                    const nv = Number(current);
                    if (!isNaN(nv)) {
                        // Keep counter strictly ahead so the next auto id is unique.
                        const bumped = nv + state.step;
                        if (state.step > 0 ? bumped > state.next : bumped < state.next) {
                            state.next = bumped;
                        }
                    }
                }
            }
        }

        // Fill in UUID values for columns whose default is a UUID-generating
        // function and whose value is still missing (column omitted, explicit
        // NULL, or DEFAULT keyword resolving to NULL). Mirrors the
        // `resolveAutoIncrement` behavior so a `NULL` in VALUES also gets a
        // fresh UUID rather than being stored as null.
        function resolveUuidDefaults(table, row) {
            for (const col of table.columns) {
                if (!col.autoUuid) continue;
                const cur = row[col.name];
                if (cur === null || cur === undefined) {
                    row[col.name] = generateUuid();
                }
            }
        }

        function evalDefault(val) {
            if (!val) return null;
            const literalCast = parseDefaultLiteralCast(val);
            if (literalCast) return applyLiteralCast(literalCast.value, literalCast.targetType);

            const up = val.toUpperCase().replace(/[\s()]/g, '');
            if (up === 'CURRENT_TIMESTAMP' || up === 'NOW' || up === 'CURRENT_DATE' || up === 'CURRENT_TIME' || up === 'GETDATE') {
                return currentTemporalValue(up);
            }
            if (UUID_FN_NAMES.has(up)) {
                return generateUuid();
            }
            if (up === 'NULL') return null;
            if (up === 'TRUE') return true;
            if (up === 'FALSE') return false;
            if (/^'.*'$/.test(val)) return val.slice(1, -1);
            const n = Number(val);
            if (!isNaN(n)) return n;
            return val;
        }

        function currentTemporalValue(name) {
            const iso = new Date().toISOString();
            const normalized = String(name || '').toUpperCase().replace(/[\s()]/g, '');
            if (normalized === 'CURRENT_DATE') return iso.slice(0, 10);
            if (normalized === 'CURRENT_TIME') return iso.slice(11, 19);
            return iso;
        }

        function roundHalfAwayFromZero(value, precision = 0) {
            const numericValue = Number(value);
            const numericPrecision = Number(precision);
            if (!Number.isFinite(numericValue) || !Number.isInteger(numericPrecision)) return null;
            const factor = 10 ** numericPrecision;
            if (!Number.isFinite(factor) || factor === 0) return null;
            const scaled = numericValue * factor;
            if (!Number.isFinite(scaled)) return null;
            // Decimal SQL literals are exact, but their JavaScript binary
            // representation can land just below a half boundary (1.005 is
            // the classic example). Offset only representation-sized drift
            // before applying SQL's half-away-from-zero rule.
            const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
            const rounded = scaled >= 0
                ? Math.floor(scaled + 0.5 + tolerance)
                : Math.ceil(scaled - 0.5 - tolerance);
            return rounded / factor;
        }

        function parseDefaultLiteralCast(val) {
            const text = String(val).trim();
            const quoted = text.match(/^'((?:''|[^'])*)'\s*::\s*(.+)$/i);
            if (quoted) {
                return {
                    value: quoted[1].replace(/''/g, "'"),
                    targetType: quoted[2].toUpperCase(),
                };
            }

            const bare = text.match(/^(NULL|TRUE|FALSE|[-+]?\d+(?:\.\d+)?)\s*::\s*(.+)$/i);
            if (!bare) return null;

            const rawValue = bare[1].toUpperCase();
            let value = bare[1];
            if (rawValue === 'NULL') value = null;
            else if (rawValue === 'TRUE') value = true;
            else if (rawValue === 'FALSE') value = false;
            else value = parseNumeric(value);

            return {
                value,
                targetType: bare[2].toUpperCase(),
            };
        }

        // ────────────────────────────────────────────────────────────────────
        // GENERATED column evaluator
        // Evaluate GENERATED ALWAYS AS (expr) STORED expressions.
        // Supports: column refs, arithmetic (+, -, *, /), numeric literals,
        // function calls (COALESCE, ABS, ROUND, etc.), and nested parens.
        // ────────────────────────────────────────────────────────────────────
        function resolveGeneratedColumns(table, row) {
            for (const col of table.columns) {
                if (!col.generatedExpr || col.generatedExpr.length === 0) continue;
                try {
                    row[col.name] = evaluateGeneratedExpr(col.generatedExpr, row, table);
                } catch {
                    row[col.name] = null;
                }
            }
        }

        function evaluateGeneratedExpr(tokens, row, table) {
            let pos = 0;
            function current() { return pos < tokens.length ? tokens[pos] : null; }
            function advance() { return tokens[pos++]; }

            function parseExpr() { return parseAdditive(); }

            function parseAdditive() {
                let left = parseMultiplicative();
                while (current() && current().type === 'OP' && (current().value === '+' || current().value === '-')) {
                    const op = advance().value;
                    const right = parseMultiplicative();
                    if (left == null || right == null) return null;
                    left = op === '+' && (typeof left === 'string' || typeof right === 'string')
                        ? `${left}${right}`
                        : (op === '+' ? Number(left) + Number(right) : Number(left) - Number(right));
                }
                return left;
            }

            function parseMultiplicative() {
                let left = parseUnary();
                while (current() && current().type === 'OP' && (current().value === '*' || current().value === '/' || current().value === '%')) {
                    const op = advance().value;
                    const right = parseUnary();
                    if (left == null || right == null) return null;
                    const ln = Number(left), rn = Number(right);
                    if (op === '*') left = ln * rn;
                    else if (op === '/') left = rn === 0 ? null : ln / rn;
                    else left = rn === 0 ? null : ln % rn;
                }
                return left;
            }

            function parseUnary() {
                if (current() && current().type === 'OP' && current().value === '-') {
                    advance();
                    const v = parseUnary();
                    return v == null ? null : -Number(v);
                }
                return parsePostfix(parsePrimary());
            }

            function parsePostfix(value) {
                let result = value;
                while (current() && current().type === 'OP' && current().value === '::') {
                    advance();
                    const typeTokens = [];
                    while (current()) {
                        const t = current();
                        if (t.type === 'IDENT' || t.type === 'KW' || t.type === 'NUMBER') {
                            typeTokens.push(advance());
                            continue;
                        }
                        if (t.type === 'PUNC' && t.value === '.') {
                            typeTokens.push(advance());
                            continue;
                        }
                        if (t.type === 'PUNC' && t.value === '(') {
                            typeTokens.push(advance());
                            let d = 1;
                            while (current() && d > 0) {
                                const inner = advance();
                                typeTokens.push(inner);
                                if (inner.type === 'PUNC' && inner.value === '(') d++;
                                if (inner.type === 'PUNC' && inner.value === ')') d--;
                            }
                            continue;
                        }
                        break;
                    }
                    result = castGeneratedValue(result, tokensToSql(typeTokens).toUpperCase());
                }
                return result;
            }

            function parsePrimary() {
                const t = current();
                if (!t) return null;

                // Parenthesized expression
                if (t.type === 'PUNC' && t.value === '(') {
                    advance();
                    const val = parseExpr();
                    if (current() && current().type === 'PUNC' && current().value === ')') advance();
                    return val;
                }

                // Number
                if (t.type === 'NUMBER') {
                    advance();
                    return parseNumeric(t.value);
                }

                // String
                if (t.type === 'STRING') {
                    advance();
                    return t.value;
                }

                // NULL
                if (t.type === 'KW' && t.value.toUpperCase() === 'NULL') {
                    advance();
                    return null;
                }

                // Boolean
                if (t.type === 'KW' && (t.value.toUpperCase() === 'TRUE' || t.value.toUpperCase() === 'FALSE')) {
                    advance();
                    return t.value.toUpperCase() === 'TRUE';
                }

                // Function call or column reference
                if (t.type === 'IDENT' || t.type === 'KW') {
                    const name = advance().value;

                    // Function call: name(...)
                    if (current() && current().type === 'PUNC' && current().value === '(') {
                        advance(); // consume '('
                        const args = [];
                        while (current() && !(current().type === 'PUNC' && current().value === ')')) {
                            if (current().type === 'PUNC' && current().value === ',') { advance(); continue; }
                            args.push(parseExpr());
                        }
                        if (current()) advance(); // consume ')'
                        return evaluateGeneratedFunc(name.toUpperCase(), args);
                    }

                    // Column reference — look up the row value
                    const colObj = findColumn(table, name);
                    if (colObj) {
                        const v = row[colObj.name];
                        return v === undefined ? null : v;
                    }
                    // Might be a number-like identifier or keyword
                    const n = Number(name);
                    return isNaN(n) ? null : n;
                }

                advance(); // skip unknown
                return null;
            }

            return parseExpr();
        }

        function tokensToSql(exprTokens) {
            return exprTokens.map((token) => token.raw || token.value).join(' ').replace(/\s+\./g, '.').replace(/\.\s+/g, '.').replace(/\s+\)/g, ')').replace(/\(\s+/g, '(');
        }

        function isSelectStartToken(token) {
            return !!token && (token.type === 'KW' || token.type === 'IDENT') && (String(token.value).toUpperCase() === 'SELECT' || String(token.value).toUpperCase() === 'WITH');
        }

        function executeSelectTokens(queryTokens, label, severity = 'warning') {
            const query = tokensToSql(queryTokens || []);
            if (!query.trim()) {
                log(severity, `${label}: empty SELECT query`);
                return { ok: false, columns: [], rows: [] };
            }
            try {
                const result = executeSelectQuery({ tables, query });
                if (result.errors.length > 0) {
                    log(severity, `${label} error: ${result.errors[0].message}`);
                    return { ok: false, columns: [], rows: [] };
                }
                return { ok: true, columns: result.columns, rows: result.rows };
            } catch (error) {
                log(severity, `${label} failed: ${error.message}`);
                return { ok: false, columns: [], rows: [] };
            }
        }

        function evaluateScalarSelectTokens(queryTokens, label) {
            const result = executeSelectTokens(queryTokens, label, 'warning');
            if (!result.ok || result.rows.length === 0) return null;
            return result.rows[0]?.[0] ?? null;
        }

        function uniqueColumnNames(names) {
            const counts = new Map();
            return names.map((name, index) => {
                const base = String(name || `column_${index + 1}`);
                const key = base.toLowerCase();
                const count = counts.get(key) || 0;
                counts.set(key, count + 1);
                return count === 0 ? base : `${base}_${count + 1}`;
            });
        }

        function queryResultToViewTable(name, result, columnAliases = [], viewSql = '', { noData = false } = {}) {
            const columnNames = uniqueColumnNames(
                result.columns.map((column, index) => columnAliases[index] || column.label || `column_${index + 1}`),
            );
            return {
                name,
                columns: columnNames.map((columnName) => ({ name: columnName, type: 'QUERY' })),
                rows: (noData ? [] : result.rows).map((row) => {
                    const out = {};
                    columnNames.forEach((columnName, index) => {
                        out[columnName] = row[index];
                    });
                    return out;
                }),
                _autoInc: new Map(),
                indexes: [],
                compositePk: null,
                compositeUniques: [],
                isView: true,
                viewSql,
                viewColumnAliases: columnAliases,
                viewNoData: noData,
            };
        }

        function applyViewResult(cleanName, result, columnAliases, viewSql, { mode = null, noData = false } = {}) {
            if (columnAliases.length > 0 && columnAliases.length !== result.columns.length) {
                log('error', `CREATE VIEW "${cleanName}": declared ${columnAliases.length} column alias(es) but SELECT returns ${result.columns.length} column(s)`);
                return;
            }

            const existing = findTable(cleanName);
            if (existing) tables.delete(existing.name);
            tables.set(cleanName, queryResultToViewTable(cleanName, result, columnAliases, viewSql, { noData }));

            if (existing && mode === 'replace') {
                log('success', `View "${cleanName}" replaced by CREATE OR REPLACE`);
            } else if (existing && mode === 'alter') {
                log('success', `View "${cleanName}" replaced by CREATE OR ALTER`);
            } else if (existing) {
                log('warning', `View "${cleanName}" already exists — definition replaced`);
            }
            log('success', `View "${cleanName}" created with ${result.columns.length} columns and ${noData ? 0 : result.rows.length} row(s)`);
        }

        function refreshViews() {
            const views = Array.from(tables.values()).filter((table) => table?.isView && table.viewSql);
            for (const view of views) {
                const result = executeSelectQuery({ tables, query: view.viewSql });
                if (result.errors.length > 0) {
                    log('warning', `Refresh view "${view.name}" error: ${result.errors[0].message}`);
                    continue;
                }
                tables.set(view.name, queryResultToViewTable(view.name, result, view.viewColumnAliases || [], view.viewSql, { noData: !!view.viewNoData }));
            }
        }

        function stripViewTailClauses(queryTokens) {
            const source = Array.isArray(queryTokens) ? queryTokens : [];
            let depth = 0;
            for (let i = 0; i < source.length; i++) {
                const token = source[i];
                if (token.type === 'PUNC' && token.value === '(') depth++;
                else if (token.type === 'PUNC' && token.value === ')') depth--;
                if (depth !== 0 || !isWordToken(token, 'WITH')) continue;

                const tail = source.slice(i);
                let p = 1;
                if (isWordToken(tail[p], 'LOCAL') || isWordToken(tail[p], 'CASCADED')) p++;
                if (isWordToken(tail[p], 'CHECK') && isWordToken(tail[p + 1], 'OPTION') && p + 2 === tail.length) {
                    return { queryTokens: source.slice(0, i), noData: false };
                }

                p = 1;
                let noData = false;
                if (isWordToken(tail[p], 'NO')) {
                    noData = true;
                    p++;
                }
                if (isWordToken(tail[p], 'DATA') && p + 1 === tail.length) {
                    return { queryTokens: source.slice(0, i), noData };
                }
            }
            return { queryTokens: source, noData: false };
        }

        function readStatementTailTokens() {
            const out = [];
            let depth = 0;
            let consumedAny = false;
            while (peek()) {
                const t = peek();
                if (depth === 0 && t.type === 'PUNC' && t.value === ';') break;
                if (consumedAny && depth === 0 && isStatementRecoveryToken(idx)) break;
                if (t.type === 'PUNC' && t.value === '(') depth++;
                else if (t.type === 'PUNC' && t.value === ')') {
                    if (depth === 0) break;
                    depth--;
                }
                out.push(next());
                consumedAny = true;
            }
            return out;
        }

        function isStatementRecoveryToken(tokenIdx) {
            if (isStrongStatementAnchor(tokenIdx, { allowDrop: false })) return true;
            const token = tokens[tokenIdx];
            if (!token || token.type !== 'KW') return false;
            const up = token.value.toUpperCase();
            if (up !== 'CREATE' && up !== 'TRUNCATE' && up !== 'INSERT' && up !== 'UPDATE') return false;
            const prev = tokenIdx > 0 ? tokens[tokenIdx - 1] : null;
            return !(up === 'UPDATE' && prev && prev.type === 'KW' && prev.value.toUpperCase() === 'ON');
        }

        function readParenthesizedSubqueryTokensFromCursor() {
            if (!(peek() && peek().type === 'PUNC' && peek().value === '(' && isSelectStartToken(peek(1)))) return null;
            next();
            const out = [];
            let depth = 1;
            while (peek()) {
                const t = peek();
                if (t.type === 'PUNC' && t.value === '(') {
                    depth++;
                    out.push(next());
                    continue;
                }
                if (t.type === 'PUNC' && t.value === ')') {
                    depth--;
                    if (depth === 0) {
                        next();
                        break;
                    }
                    out.push(next());
                    continue;
                }
                out.push(next());
            }
            return out;
        }

        function readParenthesizedSubqueryTokensFromList(exprTokens, startIndex) {
            if (!(exprTokens[startIndex]?.type === 'PUNC' && exprTokens[startIndex].value === '(' && isSelectStartToken(exprTokens[startIndex + 1]))) {
                return null;
            }
            const out = [];
            let depth = 1;
            let p = startIndex + 1;
            while (p < exprTokens.length) {
                const t = exprTokens[p];
                if (t.type === 'PUNC' && t.value === '(') {
                    depth++;
                    out.push(t);
                    p++;
                    continue;
                }
                if (t.type === 'PUNC' && t.value === ')') {
                    depth--;
                    if (depth === 0) return { tokens: out, nextIndex: p + 1 };
                    out.push(t);
                    p++;
                    continue;
                }
                out.push(t);
                p++;
            }
            return null;
        }

        function valueToExpressionToken(value) {
            if (value === null || value === undefined) return { type: 'KW', value: 'NULL', raw: 'NULL' };
            if (typeof value === 'number') return { type: 'NUMBER', value: String(value), raw: String(value) };
            if (typeof value === 'boolean') return { type: 'KW', value: value ? 'TRUE' : 'FALSE', raw: value ? 'TRUE' : 'FALSE' };
            return { type: 'STRING', value: String(value), raw: `'${String(value).replace(/'/g, "''")}'` };
        }

        function materializeScalarSubqueries(exprTokens, label) {
            const out = [];
            for (let i = 0; i < exprTokens.length;) {
                const subquery = readParenthesizedSubqueryTokensFromList(exprTokens, i);
                if (subquery) {
                    out.push(valueToExpressionToken(evaluateScalarSelectTokens(subquery.tokens, label)));
                    i = subquery.nextIndex;
                    continue;
                }
                out.push(exprTokens[i]);
                i++;
            }
            return out;
        }

        function castGeneratedValue(value, targetType) {
            if (value === null || value === undefined) return null;
            const type = String(targetType || '').replace(/^[A-Z_][A-Z0-9_]*\./i, '').toUpperCase();
            if (/^(INT|INTEGER|BIGINT|SMALLINT|TINYINT|MEDIUMINT)/.test(type)) {
                const n = Number(value);
                return Number.isNaN(n) ? null : Math.trunc(n);
            }
            if (/^(FLOAT|DOUBLE|REAL|NUMERIC|DECIMAL|NUMBER)/.test(type)) {
                const n = Number(value);
                return Number.isNaN(n) ? null : n;
            }
            if (/^(TEXT|VARCHAR|NVARCHAR|CHAR|NCHAR|STRING|CLOB)/.test(type)) return String(value);
            if (/^(BOOL|BOOLEAN)/.test(type)) return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
            if (/^DATE\b/.test(type)) {
                const d = new Date(value);
                return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
            }
            return value;
        }

        function evaluateGeneratedFunc(name, args) {
            switch (name) {
                case 'COALESCE': return args.find((a) => a != null) ?? null;
                case 'ABS': return args[0] == null ? null : Math.abs(Number(args[0]));
                case 'ROUND': {
                    if (args[0] == null) return null;
                    const prec = args[1] != null ? Number(args[1]) : 0;
                    return roundHalfAwayFromZero(args[0], prec);
                }
                case 'CEIL': case 'CEILING': return args[0] == null ? null : Math.ceil(Number(args[0]));
                case 'FLOOR': return args[0] == null ? null : Math.floor(Number(args[0]));
                case 'GREATEST': return args.filter((a) => a != null).reduce((best, v) => best == null || v > best ? v : best, null);
                case 'LEAST': return args.filter((a) => a != null).reduce((best, v) => best == null || v < best ? v : best, null);
                case 'CONCAT': return args.map((a) => a == null ? '' : String(a)).join('');
                case 'LOWER': return args[0] == null ? null : String(args[0]).toLowerCase();
                case 'UPPER': return args[0] == null ? null : String(args[0]).toUpperCase();
                case 'LENGTH': return args[0] == null ? null : String(args[0]).length;
                case 'NULLIF': return args[0] == args[1] ? null : args[0];
                case 'NOW':
                case 'CURRENT_TIMESTAMP':
                case 'CURRENT_DATE':
                case 'CURRENT_TIME':
                case 'GETDATE':
                    return currentTemporalValue(name);
                default: return null;
            }
        }

        // A column is "auto UUID" when its declared DEFAULT is one of the
        // server-side UUID-generating functions. Used to auto-assign UUIDs
        // when the column is omitted, set to NULL, or given DEFAULT.
        function isUuidDefault(defaultVal) {
            if (!defaultVal) return false;
            const up = String(defaultVal).toUpperCase().replace(/[\s()]/g, '');
            return UUID_FN_NAMES.has(up);
        }

        function skipOptionalParens() {
            if (peek() && peek().type === 'PUNC' && peek().value === '(') {
                next();
                let d = 1;
                while (peek() && d > 0) {
                    const t = next();
                    if (t.type === 'PUNC' && t.value === '(') d++;
                    if (t.type === 'PUNC' && t.value === ')') d--;
                }
            }
        }

        function consumePostgresCastTarget() {
            if (!(peek() && peek().type === 'OP' && peek().value === '::')) return '';
            next();

            const typeParts = [];
            while (peek()) {
                const t = peek();
                if (t.type === 'IDENT' || t.type === 'KW' || t.type === 'NUMBER') {
                    typeParts.push(String(next().value));
                    continue;
                }
                if (t.type === 'PUNC' && t.value === '(') {
                    typeParts.push(readBalancedCastSuffix());
                    continue;
                }
                if (t.type === 'PUNC' && (t.value === '.' || t.value === '[' || t.value === ']')) {
                    typeParts.push(String(next().value));
                    continue;
                }
                break;
            }

            return typeParts.join(' ').trim().toUpperCase();
        }

        function readBalancedCastSuffix() {
            const parts = [];
            let depth = 0;
            while (peek()) {
                const t = next();
                parts.push(String(t.value));
                if (t.type === 'PUNC' && t.value === '(') depth++;
                if (t.type === 'PUNC' && t.value === ')') {
                    depth--;
                    if (depth === 0) break;
                }
            }
            return parts.join('');
        }

        function applyLiteralCast(value, targetType) {
            if (!targetType) return value;
            const normalizedType = targetType.replace(/\s+/g, ' ');

            if (/\bJSONB?\b/.test(normalizedType) && typeof value === 'string') {
                return parseJsonLiteral(value);
            }

            if (/\b(CHAR|TEXT|UUID|VARCHAR|NVARCHAR)\b/.test(normalizedType)) {
                return value == null ? null : String(value);
            }

            if (/\b(BOOL|BOOLEAN)\b/.test(normalizedType)) {
                if (value == null) return null;
                if (typeof value === 'string') {
                    const lower = value.trim().toLowerCase();
                    if (['true', 't', '1', 'yes', 'y'].includes(lower)) return true;
                    if (['false', 'f', '0', 'no', 'n'].includes(lower)) return false;
                }
                return Boolean(value);
            }

            if (/\b(SMALLINT|INTEGER|INT|BIGINT)\b/.test(normalizedType)) {
                const numberValue = Number(value);
                return Number.isNaN(numberValue) ? value : Math.trunc(numberValue);
            }

            if (/\b(NUMERIC|DECIMAL|REAL|FLOAT|DOUBLE PRECISION)\b/.test(normalizedType)) {
                const numberValue = Number(value);
                return Number.isNaN(numberValue) ? value : numberValue;
            }

            return value;
        }

        function parseJsonLiteral(value) {
            try {
                return JSON.parse(value);
            } catch {
                return value;
            }
        }

        function parseParenValues() {
            if (!(peek() && peek().type === 'PUNC' && peek().value === '(')) return null;
            next();
            const values = [];
            let depth = 1;
            let currentParts = [];

            function flushCurrent() {
                if (currentParts.length === 0) {
                    values.push(null);
                    return;
                }
                if (currentParts.length === 1) {
                    values.push(currentParts[0]);
                    currentParts = [];
                    return;
                }
                values.push(currentParts.join(' '));
                currentParts = [];
            }

            while (peek()) {
                const t = peek();
                if (t.type === 'PUNC' && t.value === ')') {
                    depth--;
                    if (depth === 0) {
                        flushCurrent();
                        next();
                        break;
                    }
                    currentParts.push(t.value);
                    next();
                    continue;
                }
                if (t.type === 'PUNC' && t.value === '(') {
                    const subTokens = readParenthesizedSubqueryTokensFromCursor();
                    if (subTokens) {
                        currentParts.push(evaluateScalarSelectTokens(subTokens, 'INSERT subquery'));
                        continue;
                    }
                    depth++;
                    currentParts.push(t.value);
                    next();
                    continue;
                }
                if (t.type === 'PUNC' && t.value === ',' && depth === 1) {
                    flushCurrent();
                    next();
                    continue;
                }

                next();
                if (t.type === 'STRING') currentParts.push(applyLiteralCast(t.value, consumePostgresCastTarget()));
                else if (t.type === 'NUMBER') currentParts.push(applyLiteralCast(parseNumeric(t.value), consumePostgresCastTarget()));
                else if (t.type === 'OP' && t.value === '-' && peek() && peek().type === 'NUMBER') {
                    currentParts.push(applyLiteralCast(-parseNumeric(next().value), consumePostgresCastTarget()));
                } else if (t.type === 'KW' && t.value.toUpperCase() === 'NULL') currentParts.push(applyLiteralCast(null, consumePostgresCastTarget()));
                else if (t.type === 'KW' && t.value.toUpperCase() === 'DEFAULT') currentParts.push(DEFAULT_SENTINEL);
                else if (t.type === 'KW' && t.value.toUpperCase() === 'TRUE') currentParts.push(applyLiteralCast(true, consumePostgresCastTarget()));
                else if (t.type === 'KW' && t.value.toUpperCase() === 'FALSE') currentParts.push(applyLiteralCast(false, consumePostgresCastTarget()));
                else if (t.type === 'KW' && (t.value.toUpperCase() === 'CURRENT_TIMESTAMP' || t.value.toUpperCase() === 'NOW' || t.value.toUpperCase() === 'CURRENT_DATE' || t.value.toUpperCase() === 'CURRENT_TIME')) {
                    currentParts.push(currentTemporalValue(t.value));
                    skipOptionalParens();
                    consumePostgresCastTarget();
                } else if (t.type === 'KW' && t.value.toUpperCase() === 'GETDATE') {
                    currentParts.push(currentTemporalValue(t.value));
                    skipOptionalParens();
                    consumePostgresCastTarget();
                } else if (t.type === 'KW' && UUID_FN_NAMES.has(t.value.toUpperCase())) {
                    currentParts.push(generateUuid());
                    skipOptionalParens();
                    consumePostgresCastTarget();
                } else if (t.type === 'IDENT') {
                    // MySQL/phpMyAdmin dumps use double-quoted strings in VALUES
                    // (e.g. "Matematica"). Our tokenizer classifies `"..."` as
                    // a quoted identifier, so treat IDENT values as string data
                    // using the unquoted content.
                    currentParts.push(applyLiteralCast(t.value, consumePostgresCastTarget()));
                } else currentParts.push(t.raw || t.value);
            }
            return values;
        }

        function parseNumeric(val) {
            const n = Number(val);
            return isNaN(n) ? val : n;
        }

        // ════════════════════════════════════════════════════════════════
        //  UPDATE — SET assignments + optional WHERE
        // ════════════════════════════════════════════════════════════════
        //  Grammar accepted:
        //    UPDATE table SET col = val [, col = val]* [WHERE …] [;]
        //
        //  RHS values may be literals, DEFAULT, NULL, NOW(),
        //  CURRENT_TIMESTAMP, UUID(), gen_random_uuid(), and simple row
        //  expressions such as `SET v = v + 1`.
        //
        //  WHERE missing / no rows match: clean no-op (zero log spam, no
        //  warning). WHERE matches but the new value violates a
        //  constraint: warning entry, value still applied (consistent
        //  with INSERT behaviour).
        // ════════════════════════════════════════════════════════════════

        function parseUpdate() {
            const tableName = parseQualifiedIdent();
            if (!tableName) {
                log('error', 'UPDATE: missing table name');
                skipToSemicolon();
                return;
            }
            const table = findTable(tableName);
            if (!table) {
                log('error', `UPDATE "${tableName}": table does not exist`);
                skipToSemicolon();
                return;
            }
            if (!consumeKW('SET')) {
                log('error', `UPDATE "${table.name}": expected SET keyword`);
                skipToSemicolon();
                return;
            }

            const assignments = [];
            do {
                const colName = parseIdent();
                if (!colName) break;
                if (!(peek() && peek().type === 'OP' && peek().value === '=')) break;
                next();
                assignments.push({ column: colName, valueTokens: readUpdateAssignmentTokens() });
            } while (peek() && peek().type === 'PUNC' && peek().value === ',' && next());

            // Validate columns exist
            const unknownCols = assignments.filter((a) => !findColumn(table, a.column));
            if (unknownCols.length > 0) {
                unknownCols.forEach((a) => log('warning', `UPDATE "${table.name}": column "${a.column}" does not exist, skipped`));
            }

            // Generated columns are read-only in every supported engine.
            // Treat an attempted write as a statement error before evaluating
            // any row, so `SET base = 3, generated = 999` cannot partially
            // mutate the preview when the source database would reject it.
            const generatedAssignments = assignments
                .map((assignment) => findColumn(table, assignment.column))
                .filter((column) => column?.generatedExpr?.length > 0);
            if (generatedAssignments.length > 0) {
                log('error', `UPDATE "${table.name}": cannot assign to generated column(s): ${generatedAssignments.map((column) => column.name).join(', ')}`);
                skipToSemicolon();
                return;
            }

            const whereFilter = consumeKW('WHERE') ? parseWhereConditions() : null;
            if (whereFilter?.invalid) return;

            if (!whereFilter && table.rows.length > 0) {
                log('warning', `UPDATE "${table.name}": no WHERE clause — all ${table.rows.length} row(s) will be affected`);
            }

            let updated = 0;
            const matchedRows = table.rows.filter((row) => !whereFilter || matchesWhere(row, whereFilter, table));
            const buildCandidate = (row) => {
                // SQL evaluates every SET right-hand side from the row as
                // it existed before the UPDATE. Applying assignments one
                // at a time turns `SET a = b, b = a` into two copies of
                // b, which is not what SQLite/PostgreSQL/MySQL/MSSQL do.
                const sourceRow = { ...row };
                const resolvedAssignments = assignments.map(({ column, valueTokens }) => {
                    const mc = findColumn(table, column);
                    if (!mc) return null;
                    return {
                        column: mc,
                        value: evaluateUpdateAssignment(valueTokens, sourceRow, table, mc),
                    };
                }).filter(Boolean);

                const candidate = { ...row };
                resolvedAssignments.forEach(({ column, value }) => {
                    candidate[column.name] = value;
                });
                normalizeSqliteRow(table, candidate);
                // Generated values are calculated from the complete next row,
                // after every ordinary assignment has been applied.
                resolveGeneratedColumns(table, candidate);
                return candidate;
            };

            const staged = new Map();
            const workingRows = [...table.rows];
            const updateErrors = [];
            for (const row of matchedRows) {
                const candidate = buildCandidate(row);
                staged.set(row, candidate);
                // Immediate unique/primary-key checks are deliberately made
                // against the visitation state.  It catches `SET id=id+1`
                // collisions instead of accepting an impossible transient
                // state, and keeps the statement all-or-nothing.
                updateErrors.push(...validateMutationRow(table, candidate, `UPDATE "${table.name}"`, {
                    rows: workingRows,
                    ignoreRow: row,
                }));
                if (updateErrors.length > 0) break;
                const workingIndex = workingRows.indexOf(row);
                if (workingIndex >= 0) workingRows[workingIndex] = candidate;
            }
            if (updateErrors.length > 0) {
                if (peek() && peek().type === 'PUNC' && peek().value === ';') next();
                updateErrors.forEach((message) => log('error', message));
                return;
            }
            const referentialPlan = planUpdateReferentialActions(table, staged);
            if (referentialPlan.errors.length > 0) {
                if (peek() && peek().type === 'PUNC' && peek().value === ';') next();
                referentialPlan.errors.forEach((message) => log('error', message));
                return;
            }
            for (const [row, update] of referentialPlan.updates) {
                Object.assign(row, update.row);
            }
            updated = staged.size;

            if (peek() && peek().type === 'PUNC' && peek().value === ';') next();
            log('success', `Updated ${updated} row(s) in "${table.name}"`);
        }

        function readUpdateAssignmentTokens() {
            const out = [];
            let depth = 0;
            while (peek()) {
                const t = peek();
                if (depth === 0 && t.type === 'PUNC' && (t.value === ',' || t.value === ';')) break;
                if (depth === 0 && t.type === 'KW' && t.value.toUpperCase() === 'WHERE') break;
                if (t.type === 'PUNC' && t.value === '(') depth++;
                else if (t.type === 'PUNC' && t.value === ')') {
                    if (depth === 0) break;
                    depth--;
                }
                out.push(next());
            }
            return out;
        }

        function evaluateUpdateAssignment(valueTokens, row, table, col) {
            const rawExpr = (valueTokens || []).filter(Boolean);
            const wholeSubquery = readParenthesizedSubqueryTokensFromList(rawExpr, 0);
            if (wholeSubquery && wholeSubquery.nextIndex === rawExpr.length) {
                return evaluateScalarSelectTokens(wholeSubquery.tokens, 'UPDATE subquery');
            }

            const expr = materializeScalarSubqueries(rawExpr, 'UPDATE subquery');
            if (expr.length === 0) return null;

            if (expr.length === 1) {
                const t = expr[0];
                if (t.type === 'KW') {
                    const kw = t.value.toUpperCase();
                    if (kw === 'NULL') return null;
                    if (kw === 'TRUE') return true;
                    if (kw === 'FALSE') return false;
                    if (kw === 'DEFAULT') return col.defaultVal != null ? evalDefault(col.defaultVal) : null;
                    if (kw === 'CURRENT_TIMESTAMP' || kw === 'CURRENT_DATE' || kw === 'CURRENT_TIME' || kw === 'GETDATE' || kw === 'NOW') {
                        return currentTemporalValue(kw);
                    }
                    if (UUID_FN_NAMES.has(kw)) return generateUuid();
                }
                if (t.type === 'IDENT' || t.type === 'KW') {
                    const ref = findColumn(table, t.value);
                    if (ref) {
                        const key = Object.keys(row).find((k) => k.toLowerCase() === ref.name.toLowerCase());
                        return key ? row[key] : null;
                    }
                    return t.value;
                }
            }

            try {
                return evaluateGeneratedExpr(expr, row, table);
            } catch {
                return expr.map((t) => t.raw || t.value).join(' ').trim() || null;
            }
        }

        // ════════════════════════════════════════════════════════════════
        //  DELETE — optional WHERE filter
        // ════════════════════════════════════════════════════════════════
        //  Grammar accepted:
        //    DELETE FROM table [WHERE …] [;]
        //
        //  No WHERE clause = clear ALL rows. The user's auto-increment
        //  counter is intentionally NOT reset — that's `TRUNCATE TABLE`'s
        //  job. This matches PostgreSQL/MySQL/MSSQL.
        //
        //  WHERE matches zero rows: clean no-op, no warning. Explicit
        //  Referential actions are planned across the relation graph and
        //  committed only when the final state satisfies every constraint.
        // ════════════════════════════════════════════════════════════════

        function parseDelete() {
            consumeKW('FROM');
            const tableName = parseQualifiedIdent();
            if (!tableName) {
                log('error', 'DELETE: missing table name');
                skipToSemicolon();
                return;
            }
            const table = findTable(tableName);
            if (!table) {
                log('error', `DELETE FROM "${tableName}": table does not exist`);
                skipToSemicolon();
                return;
            }

            const whereFilter = consumeKW('WHERE') ? parseWhereConditions() : null;
            if (whereFilter?.invalid) return;

            if (!whereFilter) {
                const count = table.rows.length;
                if (count > 0) {
                    log('warning', `DELETE FROM "${table.name}": no WHERE clause — all ${count} row(s) will be removed`);
                }
                const plan = planDelete(table, [...table.rows]);
                if (plan.errors.length > 0) {
                    plan.errors.forEach((message) => log('error', message));
                    if (peek() && peek().type === 'PUNC' && peek().value === ';') next();
                    return;
                }
                const totalDeleted = applyDeletePlan(plan);
                const cascaded = Math.max(0, totalDeleted - count);
                log('success', `Deleted all ${count} row(s) from "${table.name}"${cascaded > 0 ? ` (${cascaded} cascaded row${cascaded === 1 ? '' : 's'})` : ''}`);
            } else {
                const rowsToDelete = table.rows.filter((row) => matchesWhere(row, whereFilter, table));
                const deleted = rowsToDelete.length;
                const plan = planDelete(table, rowsToDelete);
                if (plan.errors.length > 0) {
                    plan.errors.forEach((message) => log('error', message));
                    if (peek() && peek().type === 'PUNC' && peek().value === ';') next();
                    return;
                }
                const totalDeleted = applyDeletePlan(plan);
                const cascaded = Math.max(0, totalDeleted - deleted);
                log('success', `Deleted ${deleted} row(s) from "${table.name}"${cascaded > 0 ? ` (${cascaded} cascaded row${cascaded === 1 ? '' : 's'})` : ''}`);
            }
            if (peek() && peek().type === 'PUNC' && peek().value === ';') next();
        }

        // ════════════════════════════════════════════════════════════════
        //  DROP TABLE / DROP TYPE — destructive removal
        // ════════════════════════════════════════════════════════════════
        //  Grammar accepted:
        //    DROP TABLE [IF EXISTS] name [, name]* [CASCADE | RESTRICT];
        //    DROP TYPE  [IF EXISTS] name [, name]*;
        //    TRUNCATE [TABLE] name;          (handled separately, here)
        //
        //  IF EXISTS suppresses the "doesn't exist" warning. CASCADE /
        //  RESTRICT are accepted but ignored — relations are NOT
        //  cascade-removed; the renderer will simply drop dangling FKs
        //  on its next pass via `validateSchema`.
        //
        //  TRUNCATE clears all rows AND resets every auto-increment
        //  counter to its declared seed. This is the ONLY operation that
        //  resets the counter.
        // ════════════════════════════════════════════════════════════════

        // ════════════════════════════════════════════════════════════════
        //  CREATE INDEX / DROP INDEX — schema metadata only
        // ════════════════════════════════════════════════════════════════
        //  Grammar accepted:
        //    CREATE [UNIQUE | FULLTEXT | SPATIAL] INDEX name
        //        ON table (col [, col]*)
        //        [WHERE …]                     (filtered index, captured)
        //        [USING method]                (hash/btree/gin, captured);
        //    DROP INDEX [IF EXISTS] name [ON table];
        //
        //  Indexes are stored on the table object as `indexes: [{name,
        //  cols, unique, kind, where?}]` purely for the indexes UI
        //  panel — they DO NOT affect query execution (there's no query
        //  planner). UNIQUE indexes DO add a uniqueness constraint though,
        //  routed through the same composite-uniques machinery as
        //  table-level UNIQUE constraints.
        // ════════════════════════════════════════════════════════════════

        // CREATE [UNIQUE|FULLTEXT|SPATIAL] [CLUSTERED|NONCLUSTERED] INDEX
        //   [CONCURRENTLY] [IF NOT EXISTS] <name>
        //   ON <table> [USING <method>] (<col_list>)
        //   [INCLUDE (<cols>)]
        //   [WHERE <predicate>]
        //   [WITH (<options>)]
        //   [TABLESPACE <name>]
        //
        // Covers PostgreSQL, MySQL, and MSSQL dialects. Unknown trailing
        // options are tolerated (tokens are consumed until the next top-level
        // `;`).
        function parseCreateIndex() {
            let unique = false;
            let type = null;
            let clustered = null;

            // Modifier keywords may appear in any order before INDEX.
            while (peek() && peek().type === 'KW') {
                const kw = peek().value.toUpperCase();
                if (kw === 'UNIQUE') {
                    unique = true;
                    next();
                } else if (kw === 'FULLTEXT') {
                    type = 'fulltext';
                    next();
                } else if (kw === 'SPATIAL') {
                    type = 'spatial';
                    next();
                } else if (kw === 'CLUSTERED') {
                    clustered = true;
                    next();
                } else if (kw === 'NONCLUSTERED') {
                    clustered = false;
                    next();
                } else if (kw === 'CONCURRENTLY') {
                    next();
                } else {
                    break;
                }
            }

            if (!consumeKW('INDEX')) {
                skipToSemicolon();
                return;
            }
            consumeKW('CONCURRENTLY');
            if (consumeKW('IF')) {
                consumeKW('NOT');
                consumeKW('EXISTS');
            }

            // Index name is optional in PostgreSQL (auto-generated), required
            // in MySQL/MSSQL. Parse it if present.
            let indexName = null;
            if (peek() && peek().type !== 'KW' && peek().type !== 'PUNC') {
                indexName = parseIdent();
            } else if (peek() && peek().type === 'KW' && peek().value.toUpperCase() !== 'ON') {
                // Some parsers tokenize arbitrary identifiers as KW if they
                // collide with our extended keyword list. If the next token
                // isn't ON, treat it as the index name.
                indexName = parseIdent();
            }

            if (!consumeKW('ON')) {
                log('error', `CREATE INDEX: expected ON clause`);
                skipToSemicolon();
                return;
            }

            // ONLY (Postgres), schema.table, quoted, etc.
            consumeKW('ONLY');
            const tableName = parseQualifiedIdent();
            if (!tableName) {
                skipToSemicolon();
                return;
            }

            // Optional USING <method> (btree, hash, gin, gist, …).
            if (consumeKW('USING')) {
                const methodTok = peek();
                if (methodTok && (methodTok.type === 'KW' || methodTok.type === 'IDENT')) {
                    const method = (methodTok.value || '').toLowerCase();
                    next();
                    if (!type) type = method;
                }
            }

            // Column list — accept expression-based indexes by reading raw
            // identifiers; any non-identifier token is ignored so expressions
            // like `(lower(name))` still yield `name` as the indexed column.
            const columns = readParenList() || [];

            // Optional INCLUDE (cols) covering-index clause (Postgres/MSSQL).
            const include = [];
            if (consumeKW('INCLUDE')) {
                const inc = readParenList() || [];
                include.push(...inc);
            }

            // Optional partial-index WHERE predicate — capture raw text up to
            // the next top-level WITH / TABLESPACE / ; so validation tools can
            // display it.
            let whereText = null;
            if (consumeKW('WHERE')) {
                const parts = [];
                while (peek()) {
                    const t = peek();
                    if (t.type === 'PUNC' && t.value === ';') break;
                    if (t.type === 'KW') {
                        const up = t.value.toUpperCase();
                        if (up === 'WITH' || up === 'TABLESPACE') break;
                    }
                    parts.push(t.raw || t.value);
                    next();
                }
                whereText = parts.join(' ').trim() || null;
            }

            // Swallow trailing options (WITH (...), TABLESPACE <name>) and
            // anything else until the next top-level `;`.
            while (peek()) {
                const t = peek();
                if (t.type === 'PUNC' && t.value === ';') break;
                if (t.type === 'KW' && t.value.toUpperCase() === 'WITH') {
                    next();
                    skipParens();
                    continue;
                }
                if (t.type === 'KW' && t.value.toUpperCase() === 'TABLESPACE') {
                    next();
                    parseIdent();
                    continue;
                }
                next();
            }
            if (peek() && peek().type === 'PUNC' && peek().value === ';') next();

            const table = findTable(tableName);
            if (!table) {
                log('error', `CREATE INDEX "${indexName || '<anon>'}": table "${tableName}" does not exist`);
                return;
            }
            if (columns.length === 0) {
                log('error', `CREATE INDEX "${indexName || '<anon>'}" on "${table.name}": no columns specified`);
                return;
            }
            if (whereText && dialectProfile.id === 'mysql') {
                // MySQL has no partial/filtered-index WHERE clause. Reject
                // it instead of registering an index whose enforcement would
                // disagree with a real MySQL server.
                log('error', `CREATE INDEX "${indexName || '<anon>'}": MySQL does not support a WHERE predicate on an index`);
                return;
            }

            const indexDefinition = {
                name: indexName || null,
                columns,
                unique,
                type,
                clustered,
                where: whereText,
                include,
            };
            // Creating a unique index over existing duplicate rows is an
            // error in every supported engine. Validate before registering
            // metadata so the Data View never shows an impossible index.
            const indexErrors = validateUniqueIndexRows(table, indexDefinition);
            if (indexErrors.length > 0) {
                indexErrors.forEach((message) => log('error', message));
                return;
            }
            addIndexToTable(table, indexDefinition);
            const tag = unique ? 'UNIQUE INDEX' : type ? `${type.toUpperCase()} INDEX` : 'INDEX';
            log('success', `Created ${tag} "${indexName || '<anon>'}" on "${table.name}" (${columns.join(', ')})`);
        }

        // DROP INDEX [IF EXISTS] <name> [, <name> ...] [ON <table>]
        // The ON clause is required in MySQL/MSSQL and absent in PostgreSQL.
        // When absent, we search every table for a matching index name.
        function parseDropIndex() {
            consumeKW('INDEX');
            const ifExists = consumeKW('IF') && consumeKW('EXISTS');

            const names = [];
            while (peek()) {
                const n = parseIdent();
                if (!n) break;
                names.push(n);
                if (!(peek() && peek().type === 'PUNC' && peek().value === ',')) break;
                next();
            }

            let targetTable = null;
            if (consumeKW('ON')) {
                const t = parseQualifiedIdent();
                if (t) targetTable = findTable(t);
            }

            for (const name of names) {
                let removed = false;
                if (targetTable) {
                    removed = removeIndexFromTable(targetTable, name);
                } else {
                    for (const table of tables.values()) {
                        if (removeIndexFromTable(table, name)) {
                            removed = true;
                            break;
                        }
                    }
                }
                if (removed) log('success', `Dropped index "${name}"`);
                else if (!ifExists) log('error', `DROP INDEX: index "${name}" does not exist`);
            }

            // Tolerate CASCADE/RESTRICT and other trailing tokens.
            skipToSemicolon();
        }

        function parseDropTable() {
            consumeKW('TABLE');
            const ifExists = consumeKW('IF') && consumeKW('EXISTS');

            // DROP TABLE a, b, c
            const names = [];
            while (peek()) {
                const n = parseQualifiedIdent();
                if (!n) break;
                names.push(stripSchema(n));
                if (!(peek() && peek().type === 'PUNC' && peek().value === ',')) break;
                next();
            }

            for (const clean of names) {
                const table = findTable(clean);
                if (table) {
                    tables.delete(table.name);
                    log('success', `Dropped table "${clean}"`);
                } else if (!ifExists) {
                    log('error', `DROP: table "${clean}" does not exist`);
                }
            }
            // Ignore trailing CASCADE/RESTRICT and skip to end of statement.
            skipToSemicolon();
        }

        function parseDropView() {
            consumeKW('MATERIALIZED');
            consumeKW('VIEW');
            const ifExists = consumeKW('IF') && consumeKW('EXISTS');

            const names = [];
            while (peek()) {
                const n = parseQualifiedIdent();
                if (!n) break;
                names.push(stripSchema(n));
                if (!(peek() && peek().type === 'PUNC' && peek().value === ',')) break;
                next();
            }

            for (const clean of names) {
                const table = findTable(clean);
                if (table) {
                    tables.delete(table.name);
                    log('success', `Dropped view "${clean}"`);
                } else if (!ifExists) {
                    log('error', `DROP VIEW: view "${clean}" does not exist`);
                }
            }
            skipToSemicolon();
        }

        function parseTruncate() {
            consumeKW('TABLE');
            consumeKW('ONLY');
            const names = [];
            while (peek()) {
                const n = parseQualifiedIdent();
                if (!n) break;
                names.push(stripSchema(n));
                if (!(peek() && peek().type === 'PUNC' && peek().value === ',')) break;
                next();
            }
            for (const clean of names) {
                const table = findTable(clean);
                if (table) {
                    const count = table.rows.length;
                    table.rows = [];
                    // TRUNCATE resets the auto-increment/identity counter on
                    // both MySQL and MSSQL. PostgreSQL preserves it unless
                    // `RESTART IDENTITY` is used — for an in-memory tool we
                    // lean toward the more-common "fresh start" behavior.
                    if (table._autoInc) {
                        for (const [colKey, state] of table._autoInc) {
                            const col = table.columns.find((c) => c.name.toLowerCase() === colKey);
                            if (col) {
                                state.next = col.identitySeed || 1;
                                state.step = col.identityStep || 1;
                            }
                        }
                    }
                    log('success', `Truncated "${clean}" (${count} row(s) removed)`);
                } else {
                    log('error', `TRUNCATE: table "${clean}" does not exist`);
                }
            }
            skipToSemicolon();
        }

        function parseDropType() {
            consumeKW('TYPE');
            if (consumeKW('IF')) {
                consumeKW('EXISTS');
            }
            const typeName = parseQualifiedIdent();
            if (typeName) {
                const clean = stripSchema(typeName);
                const existing = findType(clean);
                if (existing) {
                    types.delete(existing.name);
                    log('success', `Dropped type "${clean}"`);
                } else log('error', `DROP: type "${clean}" does not exist`);
            }
            skipToSemicolon();
        }

        function consumeViewPrefixOptions() {
            let progressed = true;
            while (progressed) {
                progressed = false;
                if (consumeWord('ALGORITHM')) {
                    if (peek() && (peek().type === 'OP' || peek().type === 'PUNC') && peek().value === '=') next();
                    parseIdent();
                    progressed = true;
                    continue;
                }
                if (consumeWord('DEFINER')) {
                    if (peek() && (peek().type === 'OP' || peek().type === 'PUNC') && peek().value === '=') next();
                    while (peek() && !isWordToken(peek(), 'SQL') && !isWordToken(peek(), 'VIEW') && !(peek().type === 'PUNC' && peek().value === ';')) {
                        next();
                    }
                    progressed = true;
                    continue;
                }
                if (consumeWord('SQL')) {
                    consumeWord('SECURITY');
                    parseIdent();
                    progressed = true;
                }
            }
        }

        function consumeViewOptionsBeforeAs() {
            while (peek()) {
                const token = peek();
                if (isWordToken(token, 'AS')) break;
                if (token.type === 'PUNC' && token.value === ';') break;
                if (isStatementRecoveryToken(idx)) break;
                next();
            }
        }

        function parseCreateView({ mode = null } = {}) {
            consumeKW('TEMPORARY') || consumeKW('TEMP');
            consumeKW('MATERIALIZED');
            consumeViewPrefixOptions();
            if (!consumeKW('VIEW')) {
                skipToSemicolon();
                return;
            }

            const ifNotExists = consumeKW('IF') && consumeKW('NOT') && consumeKW('EXISTS');
            const viewName = parseQualifiedIdent();
            if (!viewName) {
                log('error', 'CREATE VIEW: missing view name');
                skipToSemicolon();
                return;
            }
            const cleanName = stripSchema(viewName);
            const existing = findTable(cleanName);
            if (ifNotExists && existing && !mode) {
                log('warning', `View "${cleanName}" already exists — CREATE VIEW IF NOT EXISTS skipped`);
                skipToSemicolon();
                return;
            }

            const columnAliases = peek() && peek().type === 'PUNC' && peek().value === '(' ? readParenList() : [];
            consumeViewOptionsBeforeAs();
            if (!consumeKW('AS')) {
                log('error', `CREATE VIEW "${cleanName}": expected AS SELECT`);
                skipToSemicolon();
                return;
            }

            const rawQueryTokens = readStatementTailTokens();
            const { queryTokens, noData } = stripViewTailClauses(rawQueryTokens);
            const viewSql = tokensToSql(queryTokens);
            const result = executeSelectQuery({ tables, query: viewSql });
            if (peek() && peek().type === 'PUNC' && peek().value === ';') next();

            if (result.errors.length > 0) {
                log('error', `CREATE VIEW "${cleanName}" error: ${result.errors[0].message}`);
                return;
            }
            applyViewResult(cleanName, result, columnAliases, viewSql, { mode, noData });
        }

        // ════════════════════════════════════════════════════════════════
        //  WHERE / Value helpers — value parsing + condition evaluation
        // ════════════════════════════════════════════════════════════════
        //  Three concerns live here:
        //
        //    1. `parseValue()`         — converts the next token(s) to a JS
        //                                value. Handles strings, numbers
        //                                (including unary minus), NULL,
        //                                booleans, time defaults
        //                                (CURRENT_TIMESTAMP/NOW/GETDATE),
        //                                UUID-generating functions, and
        //                                scalar `(SELECT ...)` subqueries.
        //    2. `parseInList()`        — `(v1, v2, …)` value list for IN or
        //                                `(SELECT ...)` first-column values.
        //    3. `parseWhereConditions` /
        //       `parseSingleCondition` — full WHERE grammar (see grammar
        //                                block below `parseWhereConditions`).
        //
        //  `evalCondition(row, cond)` evaluates one parsed condition
        //  against one row using SQL-standard 3-valued logic — every
        //  comparison involving NULL (except IS NULL / IS NOT NULL)
        //  yields `false` (UNKNOWN → false in WHERE).
        // ════════════════════════════════════════════════════════════════

        function parseValue() {
            const t = peek();
            if (!t) return null;
            const subTokens = readParenthesizedSubqueryTokensFromCursor();
            if (subTokens) {
                return evaluateScalarSelectTokens(subTokens, 'WHERE subquery');
            }
            if (t.type === 'STRING') {
                next();
                return applyLiteralCast(t.value, consumePostgresCastTarget());
            }
            if (t.type === 'NUMBER') {
                next();
                return applyLiteralCast(parseNumeric(t.value), consumePostgresCastTarget());
            }
            if (t.type === 'KW') {
                const kw = t.value.toUpperCase();
                if (kw === 'NULL') {
                    next();
                    return applyLiteralCast(null, consumePostgresCastTarget());
                }
                if (kw === 'TRUE') {
                    next();
                    return applyLiteralCast(true, consumePostgresCastTarget());
                }
                if (kw === 'FALSE') {
                    next();
                    return applyLiteralCast(false, consumePostgresCastTarget());
                }
                if (kw === 'CURRENT_TIMESTAMP' || kw === 'NOW' || kw === 'CURRENT_DATE' || kw === 'CURRENT_TIME' || kw === 'GETDATE') {
                    next();
                    skipOptionalParens();
                    return applyLiteralCast(currentTemporalValue(kw), consumePostgresCastTarget());
                }
                if (UUID_FN_NAMES.has(kw)) {
                    next();
                    skipOptionalParens();
                    return applyLiteralCast(generateUuid(), consumePostgresCastTarget());
                }
            }
            if (t.type === 'OP' && t.value === '-' && peek(1) && peek(1).type === 'NUMBER') {
                next();
                return applyLiteralCast(-parseNumeric(next().value), consumePostgresCastTarget());
            }
            next();
            // Treat quoted identifiers (MySQL double-quoted strings like
            // "Marco") as string literals using the unquoted content so that
            // WHERE/IN comparisons match the stored row values.
            if (t.type === 'IDENT') return applyLiteralCast(t.value, consumePostgresCastTarget());
            return applyLiteralCast(t.raw || t.value, consumePostgresCastTarget());
        }

        function isQuotedIdentifierValue(token) {
            if (!token || token.type !== 'IDENT') return false;
            const raw = String(token.raw || '');
            return raw.startsWith('"') || raw.startsWith('`') || raw.startsWith('[');
        }

        function parseWhereValue() {
            const t = peek();
            if (t?.type === 'IDENT' && !isQuotedIdentifierValue(t)) {
                next();
                return { kind: 'columnRef', name: t.value };
            }
            return parseValue();
        }

        function resolveWhereValue(value, row) {
            if (Array.isArray(value)) return value.map((item) => resolveWhereValue(item, row));
            if (value?.kind === 'columnRef') return rowValue(row, value.name);
            return value;
        }

        function parseInList() {
            const vals = [];
            if (!(peek() && peek().type === 'PUNC' && peek().value === '(')) return vals;
            const subTokens = readParenthesizedSubqueryTokensFromCursor();
            if (subTokens) {
                const result = executeSelectTokens(subTokens, 'WHERE IN subquery', 'warning');
                return result.ok ? result.rows.map((row) => row[0] ?? null) : [];
            }
            next();
            while (peek()) {
                if (peek().type === 'PUNC' && peek().value === ')') {
                    next();
                    break;
                }
                if (peek().type === 'PUNC' && peek().value === ',') {
                    next();
                    continue;
                }
                vals.push(parseValue());
            }
            return vals;
        }

        // ── WHERE clause grammar ──
        //
        // <where>      ::= <or-expr>
        // <or-expr>    ::= <and-expr> ( 'OR' <and-expr> )*
        // <and-expr>   ::= <primary>  ( 'AND' <primary> )*
        // <primary>    ::= '(' <or-expr> ')' | <cond>
        // <cond>       ::= <ident> <op> <rhs> | <ident>
        // <op>         ::= '='  '!='  '<>'  '<'  '<='  '>'  '>='
        //                | 'IS' ['NOT'] ('NULL'|'TRUE'|'FALSE'|'UNKNOWN')
        //                | 'IS' ['NOT'] 'DISTINCT' 'FROM' <value>
        //                | ['NOT'] ('LIKE'|'ILIKE')
        //                | ['NOT'] 'IN' '(' <values> ')'
        //                | ['NOT'] 'BETWEEN' <value> 'AND' <value>
        //
        // Unsupported or malformed filters fail closed. This is important:
        // a bad WHERE must never degrade into an empty condition list, because
        // that would turn UPDATE/DELETE into an accidental whole-table write.
        function parseWhereConditions() {
            let parseError = null;
            const fail = (message, token = peek(), options = {}) => {
                if (!parseError) parseError = { message, token, ...options };
                return null;
            };
            const tokenLabel = (token) => {
                if (!token) return 'end of statement';
                return String(token.raw || token.value || token.type || '?');
            };

            function parseOrExpr() {
                let left = parseAndExpr();
                if (!left) return null;
                while (consumeKW('OR')) {
                    const right = parseAndExpr();
                    if (!right) return fail('expected condition after OR');
                    left = { type: 'or', left, right };
                }
                return left;
            }

            function parseAndExpr() {
                let left = parseWherePrimary();
                if (!left) return null;
                while (consumeKW('AND')) {
                    const right = parseWherePrimary();
                    if (!right) return fail('expected condition after AND');
                    left = { type: 'and', left, right };
                }
                return left;
            }

            function parseWherePrimary() {
                const token = peek();
                if (token?.type === 'PUNC' && token.value === '(') {
                    const open = next();
                    if (peek()?.type === 'PUNC' && peek().value === ')') {
                        return fail('empty parenthesized condition', open);
                    }
                    const expr = parseOrExpr();
                    if (!expr) return null;
                    if (!(peek()?.type === 'PUNC' && peek().value === ')')) {
                        return fail('expected closing ")" in WHERE clause', peek() || open);
                    }
                    next();
                    return expr;
                }
                return parseSingleCondition(fail);
            }

            const ast = parseOrExpr();
            if (!ast && !parseError) fail('expected a condition after WHERE');

            const trailing = peek();
            if (
                !parseError &&
                trailing &&
                !(trailing.type === 'PUNC' && trailing.value === ';') &&
                !isStatementRecoveryToken(idx)
            ) {
                fail(`unexpected token "${tokenLabel(trailing)}" in WHERE clause`, trailing);
            }

            if (parseError) {
                log('error', `${parseError.unsupported ? '' : 'WHERE clause could not be parsed: '}${parseError.message}`, parseError.token);
                skipToSemicolon();
                return { kind: 'whereAst', invalid: true, ast: null };
            }

            return { kind: 'whereAst', invalid: false, ast };
        }

        function parseSingleCondition(fail = () => null) {
            const start = peek();
            const col = parseIdent();
            if (!col) return fail('expected column name', start);
            const opTok = peek();
            if (!opTok || (opTok.type === 'PUNC' && (opTok.value === ';' || opTok.value === ')'))) {
                return { type: 'condition', column: col, op: 'IS TRUE', value: null };
            }

            if (opTok.type === 'OP') {
                if (!SUPPORTED_DATA_VIEW_WHERE_OPERATORS.has(String(opTok.value))) {
                    return fail(unsupportedOperatorMessage(opTok, 'Data View'), opTok, { unsupported: true });
                }
                const op = next().value;
                return { type: 'condition', column: col, op, value: parseWhereValue() };
            }
            if (opTok.type === 'KW' || opTok.type === 'IDENT') {
                const kw = String(opTok.value).toUpperCase();
                if (kw === 'IS') {
                    next();
                    const negated = consumeKW('NOT');
                    if (consumeKW('DISTINCT')) {
                        if (!consumeKW('FROM')) return fail(`expected FROM after IS ${negated ? 'NOT ' : ''}DISTINCT`, peek());
                        return {
                            type: 'condition',
                            column: col,
                            op: negated ? 'IS NOT DISTINCT FROM' : 'IS DISTINCT FROM',
                            value: parseWhereValue(),
                        };
                    }
                    if (consumeKW('NULL')) {
                        return { type: 'condition', column: col, op: negated ? 'IS NOT NULL' : 'IS NULL', value: null };
                    }
                    if (consumeKW('TRUE')) {
                        return { type: 'condition', column: col, op: negated ? 'IS NOT TRUE' : 'IS TRUE', value: null };
                    }
                    if (consumeKW('FALSE')) {
                        return { type: 'condition', column: col, op: negated ? 'IS NOT FALSE' : 'IS FALSE', value: null };
                    }
                    if (consumeKW('UNKNOWN')) {
                        return { type: 'condition', column: col, op: negated ? 'IS NOT UNKNOWN' : 'IS UNKNOWN', value: null };
                    }
                    return fail(`expected NULL, TRUE, FALSE, UNKNOWN, or DISTINCT FROM after IS${negated ? ' NOT' : ''}`, peek());
                }
                if (kw === 'LIKE' || kw === 'ILIKE') {
                    next();
                    return { type: 'condition', column: col, op: kw, value: parseWhereValue() };
                }
                if (kw === 'IN') {
                    next();
                    return { type: 'condition', column: col, op: 'IN', value: parseInList() };
                }
                if (kw === 'BETWEEN') {
                    next();
                    const lo = parseWhereValue();
                    consumeKW('AND');
                    const hi = parseWhereValue();
                    return { type: 'condition', column: col, op: 'BETWEEN', value: [lo, hi] };
                }
                if (kw === 'NOT') {
                    const saved = idx;
                    next();
                    if (isKW('IN')) {
                        next();
                        return { type: 'condition', column: col, op: 'NOT IN', value: parseInList() };
                    }
                    if (isKW('BETWEEN')) {
                        next();
                        const lo = parseWhereValue();
                        consumeKW('AND');
                        const hi = parseWhereValue();
                        return { type: 'condition', column: col, op: 'NOT BETWEEN', value: [lo, hi] };
                    }
                    if (isKW('LIKE') || isKW('ILIKE')) {
                        const op = peek().value.toUpperCase();
                        next();
                        return { type: 'condition', column: col, op: `NOT ${op}`, value: parseWhereValue() };
                    }
                    idx = saved;
                    return fail('expected IN, BETWEEN, LIKE, or ILIKE after NOT', opTok);
                }
            }
            return fail(`expected operator after "${col}"`, opTok);
        }

        function isSqlTruthy(value) {
            if (value === true) return true;
            if (value === false || value === null || value === undefined) return false;
            if (typeof value === 'number') return value !== 0;
            const normalized = String(value).trim().toLowerCase();
            return normalized === 'true' || normalized === 't' || normalized === 'yes' || normalized === 'y' || normalized === '1';
        }

        function isSqlFalsey(value) {
            if (value === false) return true;
            if (value === true || value === null || value === undefined) return false;
            if (typeof value === 'number') return value === 0;
            const normalized = String(value).trim().toLowerCase();
            return normalized === 'false' || normalized === 'f' || normalized === 'no' || normalized === 'n' || normalized === '0';
        }

        function evalCondition(row, column, op, value, table = null) {
            const colKey = Object.keys(row).find((k) => k.toLowerCase() === column.toLowerCase());
            if (!colKey && op !== 'IS NULL' && op !== 'IS NOT NULL') return false;
            const rv = colKey ? row[colKey] : undefined;
            const columnMeta = table ? findColumn(table, column) : null;
            value = resolveWhereValue(value, row);

            // SQL standard NULL semantics: any comparison involving NULL on
            // either side (other than IS NULL / IS NOT NULL) yields UNKNOWN,
            // which is treated as false in WHERE evaluation.
            const rvNull = rv === null || rv === undefined;
            const valNull = value === null || value === undefined;
            const NULL_OPS = new Set([
                'IS NULL',
                'IS NOT NULL',
                'IS TRUE',
                'IS NOT TRUE',
                'IS FALSE',
                'IS NOT FALSE',
                'IS UNKNOWN',
                'IS NOT UNKNOWN',
                'IS DISTINCT FROM',
                'IS NOT DISTINCT FROM',
            ]);
            if (!NULL_OPS.has(op)) {
                if (op === 'IN' || op === 'NOT IN' || op === 'BETWEEN' || op === 'NOT BETWEEN') {
                    if (rvNull) return false;
                } else if (rvNull || valNull) {
                    return false;
                }
            }

            switch (op) {
                case '=':
                    return compareWhereValues(rv, value, columnMeta, table) === 0;
                case '!=':
                case '<>':
                    return compareWhereValues(rv, value, columnMeta, table) !== 0;
                case '>':
                    return compareWhereValues(rv, value, columnMeta, table) > 0;
                case '<':
                    return compareWhereValues(rv, value, columnMeta, table) < 0;
                case '>=':
                    return compareWhereValues(rv, value, columnMeta, table) >= 0;
                case '<=':
                    return compareWhereValues(rv, value, columnMeta, table) <= 0;
                case 'IS NULL':
                    return rvNull;
                case 'IS NOT NULL':
                    return !rvNull;
                case 'IS TRUE':
                    return !rvNull && isSqlTruthy(rv);
                case 'IS NOT TRUE':
                    return rvNull || !isSqlTruthy(rv);
                case 'IS FALSE':
                    return !rvNull && isSqlFalsey(rv);
                case 'IS NOT FALSE':
                    return rvNull || !isSqlFalsey(rv);
                case 'IS UNKNOWN':
                    return rvNull;
                case 'IS NOT UNKNOWN':
                    return !rvNull;
                case 'IS DISTINCT FROM':
                    if (rvNull && valNull) return false;
                    if (rvNull || valNull) return true;
                    return compareWhereValues(rv, value, columnMeta, table) !== 0;
                case 'IS NOT DISTINCT FROM':
                    if (rvNull && valNull) return true;
                    if (rvNull || valNull) return false;
                    return compareWhereValues(rv, value, columnMeta, table) === 0;
                case 'IN': {
                    if (!Array.isArray(value)) return false;
                    return value.some((v) => v !== null && v !== undefined && compareWhereValues(rv, v, columnMeta, table) === 0);
                }
                case 'NOT IN': {
                    // SQL three-valued logic: `x NOT IN (a, NULL, b)` is
                    // equivalent to `x != a AND x != NULL AND x != b`. Any
                    // comparison against NULL is UNKNOWN, which propagates
                    // through AND and yields UNKNOWN — false in WHERE. So a
                    // NULL anywhere in the list, when no concrete element
                    // matched, must return false (not true).
                    if (!Array.isArray(value)) return false;
                    if (value.some((v) => v !== null && v !== undefined && compareWhereValues(rv, v, columnMeta, table) === 0)) return false;
                    if (value.some((v) => v === null || v === undefined)) return false;
                    return true;
                }
                case 'BETWEEN': {
                    if (!Array.isArray(value)) return false;
                    const [lo, hi] = value;
                    // SQL: NULL bound makes the whole predicate UNKNOWN.
                    if (lo === null || lo === undefined || hi === null || hi === undefined) return false;
                    return compareWhereValues(rv, lo, columnMeta, table) >= 0 && compareWhereValues(rv, hi, columnMeta, table) <= 0;
                }
                case 'NOT BETWEEN': {
                    if (!Array.isArray(value)) return false;
                    const [lo, hi] = value;
                    if (lo === null || lo === undefined || hi === null || hi === undefined) return false;
                    return !(compareWhereValues(rv, lo, columnMeta, table) >= 0 && compareWhereValues(rv, hi, columnMeta, table) <= 0);
                }
                case 'LIKE': {
                    if (typeof value !== 'string') return false;
                    return likeRegex(value, table?.dialect !== 'postgres').test(String(rv ?? ''));
                }
                case 'ILIKE': {
                    if (typeof value !== 'string') return false;
                    return likeRegex(value, true).test(String(rv ?? ''));
                }
                case 'NOT LIKE': {
                    if (typeof value !== 'string') return false;
                    return !likeRegex(value, table?.dialect !== 'postgres').test(String(rv ?? ''));
                }
                case 'NOT ILIKE': {
                    if (typeof value !== 'string') return false;
                    return !likeRegex(value, true).test(String(rv ?? ''));
                }
                default:
                    return false;
            }
        }

        function compareWhereValues(left, right, column, table) {
            if (table?.dialect !== 'sqlite') {
                // Numeric-looking TEXT remains lexical in SQL. Preserve the
                // common case-insensitive defaults for MySQL / SQL Server and
                // UUID canonical equality, while PostgreSQL text remains
                // exact and case-sensitive.
                if (typeof left === 'string' && typeof right === 'string') {
                    const uuidComparison = /\bUUID\b/i.test(String(column?.type || ''));
                    const caseInsensitive = uuidComparison || table?.dialect === 'mysql' || table?.dialect === 'mssql';
                    const normalizedLeft = caseInsensitive ? left.toLowerCase() : left;
                    const normalizedRight = caseInsensitive ? right.toLowerCase() : right;
                    return sqliteBinaryCompare(normalizedLeft, normalizedRight);
                }
                const ln = Number(left);
                const rn = Number(right);
                if (!Number.isNaN(ln) && !Number.isNaN(rn)) return ln - rn;
                return sqliteBinaryCompare(String(left), String(right));
            }

            const affinity = sqliteColumnAffinity(column?.type);
            if (affinity === 'text') return sqliteBinaryCompare(String(left), String(right));
            if (affinity === 'numeric') {
                const ln = sqliteNumericValue(left);
                const rn = sqliteNumericValue(right);
                if (ln != null && rn != null) return ln - rn;
            }
            return sqliteStorageCompare(left, right);
        }


        // Compile a SQL LIKE pattern into a JavaScript RegExp.
        //
        // Translation rules:
        //   • `%`  →  `.*`   (any sequence)
        //   • `_`  →  `.`    (single character)
        //   • Every other regex metacharacter (`.`, `(`, `[`, `\`, etc.) is
        //     escaped so the pattern matches literally — without this,
        //     `WHERE name LIKE 'a.b'` would erroneously match `'aXb'`,
        //     `'a/b'`, etc., and patterns containing `(` or `[` would throw.
        //   • Backslash escapes: `\\%` → literal `%`, `\\_` → literal `_`,
        //     `\\\\` → literal `\`. Other escape sequences pass through as
        //     the literal character (matches PG's default `LIKE` behaviour).
        // Case sensitivity is supplied by the dialect-aware caller: PostgreSQL
        // LIKE is case-sensitive while ILIKE is not. Neutral/SQLite/MySQL/MSSQL
        // profiles retain their existing common case-insensitive behavior.
        function likeRegex(pattern, caseInsensitive = true) {
            let out = '';
            for (let i = 0; i < pattern.length; i++) {
                const c = pattern[i];
                if (c === '\\' && i + 1 < pattern.length) {
                    const nxt = pattern[i + 1];
                    if (nxt === '%' || nxt === '_' || nxt === '\\') {
                        // Escape literal `%`/`_`/`\` so they appear in the
                        // output regex unchanged.
                        out += nxt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        i++;
                        continue;
                    }
                }
                if (c === '%') { out += '.*'; continue; }
                if (c === '_') { out += '.'; continue; }
                // Escape every regex metacharacter so it matches literally.
                if (/[.*+?^${}()|[\]\\]/.test(c)) { out += '\\' + c; continue; }
                out += c;
            }
            return new RegExp(`^${out}$`, caseInsensitive ? 'i' : '');
        }

        function evalWhereAst(row, node, table = null) {
            if (!node) return false;
            if (node.type === 'and') return evalWhereAst(row, node.left, table) && evalWhereAst(row, node.right, table);
            if (node.type === 'or') return evalWhereAst(row, node.left, table) || evalWhereAst(row, node.right, table);
            if (node.type === 'condition') return evalCondition(row, node.column, node.op, node.value, table);
            return false;
        }

        function matchesWhere(row, conditions, table = null) {
            if (!conditions) return true;
            if (conditions.kind === 'whereAst') {
                if (conditions.invalid) return false;
                return evalWhereAst(row, conditions.ast, table);
            }
            if (!conditions.length) return true;
            // Legacy array support for older internal callers, if any remain.
            const orGroups = [[]];
            for (const c of conditions) {
                if (c.conj === 'OR') orGroups.push([c]);
                else orGroups[orGroups.length - 1].push(c);
            }
            return orGroups.some((group) => group.every(({ column, op, value }) => evalCondition(row, column, op, value, table)));
        }

        // ════════════════════════════════════════════════════════════════
        //  Main entry — statement boundary scanner + two-pass execution
        // ════════════════════════════════════════════════════════════════
        //  Drives the whole pipeline:
        //    1. Walk the token stream, tracking paren depth, and slice the
        //       script into `statements: { startIdx, kind: 'ddl'|'dml' }[]`.
        //       Boundaries are `;`, `GO` (MSSQL batch separator), or any
        //       RECOVERY_STARTERS keyword at depth 0 — so an unterminated
        //       statement doesn't lock up the whole script.
        //    2. Two-pass execution (see banner inside the function for
        //       the full deferred-DML rationale): pass 1 runs every DDL
        //       in order and defers DML whose target table doesn't exist
        //       yet; pass 2 replays the deferred bucket so dump-style
        //       scripts that interleave INSERT above CREATE TABLE work.
        //
        //  Invariant: this function never throws. Every error surfaces as
        //  an entry in `executionLog` (which is returned and rendered as
        //  the Log tab in the Data View).
        // ════════════════════════════════════════════════════════════════
        // Execute statements in original order so DDL like DROP + re-CREATE
        // preserves expected semantics. If an INSERT/UPDATE/DELETE targets a
        // table that does not yet exist at that point, defer it and retry
        // after the full script has run so data sections placed before their
        // CREATE TABLE still succeed.

        // First: scan statement boundaries and classify each statement. A
        // statement runs from its starter keyword up to the earliest of:
        //   (a) a top-level `;` (the preferred terminator),
        //   (b) a top-level `GO` batch separator (MSSQL), or
        //   (c) a recovery point where we encounter another top-level
        //       statement-starter keyword at depth 0.
        // For recovery (c) we only consider starters that never appear as
        // internal/positional keywords in another statement's body:
        //   • CREATE, TRUNCATE, INSERT — pure starters.
        //   • UPDATE — needs an extra guard because `ON UPDATE CASCADE` also
        //     places UPDATE at depth 0; we skip recovery when the previous
        //     token is `ON`.
        // ALTER/DROP/DELETE are deliberately excluded because they appear
        // as action keywords inside ALTER TABLE and as part of `ON DELETE`
        // clauses — users relying on those need explicit semicolons.
        const RECOVERY_STARTERS = new Set(['CREATE', 'TRUNCATE', 'INSERT', 'UPDATE', 'BEGIN', 'START', 'COMMIT', 'ROLLBACK']);
        const statements = [];
        let scanI = 0;
        while (scanI < len) {
            while (scanI < len && tokens[scanI].type === 'PUNC' && tokens[scanI].value === ';') scanI++;
            if (scanI >= len) break;

            const t = tokens[scanI];

            if (t.type === 'KW' && t.value.toUpperCase() === 'GO') {
                scanI++;
                continue;
            }

            let kind = 'other';
            if (t.type === 'KW') {
                const kw = t.value.toUpperCase();
                if (kw === 'CREATE' || kw === 'ALTER' || kw === 'DROP' || kw === 'TRUNCATE') kind = 'ddl';
                else if (kw === 'INSERT' || kw === 'UPDATE' || kw === 'DELETE') kind = 'dml';
                else if (kw === 'BEGIN' || kw === 'START' || kw === 'COMMIT' || kw === 'ROLLBACK' || kw === 'SAVEPOINT' || kw === 'RELEASE') kind = 'transaction';
                else if (kw === 'SET' || kw === 'PRAGMA') kind = 'session';
                else if (kw === 'REPLACE' || kw === 'MERGE') kind = 'unsupported-dml';
            }

            const startIdx = scanI;
            let depth = 0;
            // Advance past the starter keyword so that keyword itself doesn't
            // trigger the recovery branch on the very first iteration.
            scanI++;
            while (scanI < len) {
                const tt = tokens[scanI];
                if (tt.type === 'PUNC' && tt.value === '(') {
                    depth++;
                } else if (tt.type === 'PUNC' && tt.value === ')') {
                    depth--;
                } else if (tt.type === 'PUNC' && tt.value === ';' && depth === 0) {
                    scanI++;
                    break;
                } else if (tt.type === 'KW' && tt.value.toUpperCase() === 'GO' && depth === 0) {
                    break;
                } else if (isStrongStatementAnchor(scanI, { allowDrop: false })) {
                    // Strong two-keyword anchors (CREATE TABLE / ALTER TABLE /
                    // TRUNCATE) terminate the current statement EVEN at depth
                    // > 0, so an unclosed paren or missing semicolon in one
                    // statement never absorbs the next one. Mirrors the
                    // anchor-driven recovery in parseAst.js (see SECTION H).
                    //
                    // DROP is intentionally excluded here — it doubles as an
                    // ALTER subaction (`ALTER TABLE t DROP INDEX i`,
                    // `DROP CONSTRAINT c`, `DROP COLUMN c`). DROP at depth 0
                    // is still handled below via RECOVERY_STARTERS.
                    break;
                } else if (kind !== 'unsupported-dml' && depth === 0 && tt.type === 'KW' && RECOVERY_STARTERS.has(tt.value.toUpperCase())) {
                    // Guard against positional `ON UPDATE CASCADE`.
                    const prev = scanI > 0 ? tokens[scanI - 1] : null;
                    if (prev && prev.type === 'KW' && prev.value.toUpperCase() === 'ON') {
                        scanI++;
                        continue;
                    }
                    break;
                }
                scanI++;
            }

            if (kind !== 'other') statements.push({ startIdx, endIdx: scanI, kind });
        }

        function hasLexicalErrorInStatement(stmt) {
            if (!stmt || lexicalErrors.length === 0) return false;
            const start = tokens[stmt.startIdx]?.start?.idx;
            const end = tokens[Math.max(stmt.startIdx, stmt.endIdx - 1)]?.end?.idx;
            if (start == null || end == null) return false;
            return lexicalErrors.some((error) => {
                const offset = error?.start?.idx;
                return typeof offset === 'number' && offset >= start && offset < end;
            });
        }

        // Peek at the target table name for a DML statement without consuming
        // tokens or logging anything, so we can detect "table not found" early.
        function dmlTargetTable(stmt) {
            const savedIdx = idx;
            idx = stmt.startIdx;
            const kwTok = peek();
            if (!kwTok || kwTok.type !== 'KW') {
                idx = savedIdx;
                return null;
            }
            const kw = kwTok.value.toUpperCase();
            next();
            if (kw === 'INSERT') consumeKW('INTO');
            else if (kw === 'DELETE') consumeKW('FROM');
            const name = parseQualifiedIdent();
            idx = savedIdx;
            return name;
        }

        function consumeTransactionTerminator() {
            if (peek() && peek().type === 'PUNC' && peek().value === ';') next();
        }

        function latestSavepointIndex(name) {
            const expected = String(name || '').toLowerCase();
            for (let index = transactionState.savepoints.length - 1; index >= 0; index--) {
                if (transactionState.savepoints[index].name.toLowerCase() === expected) return index;
            }
            return -1;
        }

        function parseSessionBoolean() {
            let wrapped = false;
            if (peek()?.type === 'OP' && peek().value === '=') next();
            else if (peek()?.type === 'PUNC' && peek().value === '(') {
                wrapped = true;
                next();
            }
            const token = next();
            const value = String(token?.value ?? token?.raw ?? '').toUpperCase();
            if (wrapped && peek()?.type === 'PUNC' && peek().value === ')') next();
            if (value === 'ON' || value === 'TRUE' || value === '1') return true;
            if (value === 'OFF' || value === 'FALSE' || value === '0') return false;
            return null;
        }

        function parseSessionSetting(keyword) {
            if (keyword === 'PRAGMA') {
                const setting = parseQualifiedIdent();
                if (String(setting || '').toLowerCase() !== 'foreign_keys') {
                    skipToSemicolon();
                    return;
                }
                const enabled = parseSessionBoolean();
                if (enabled == null) {
                    log('info', `PRAGMA foreign_keys is ${isForeignKeyEnforcementEnabled() ? 'ON' : 'OFF'}`);
                } else if (dialectProfile.id !== 'sqlite') {
                    log('warning', 'PRAGMA foreign_keys is a SQLite-only connection setting; no change was applied');
                } else if (transactionState) {
                    // SQLite deliberately ignores this PRAGMA while a
                    // transaction is active. Avoid falsely showing a change
                    // that a real SQLite connection would not make.
                    log('warning', 'PRAGMA foreign_keys cannot change inside a SQLite transaction; no change was applied');
                } else {
                    foreignKeyEnforcement = enabled;
                    log('success', `SQLite foreign-key enforcement ${enabled ? 'enabled' : 'disabled'} for this connection`);
                }
                skipToSemicolon();
                return;
            }

            const setting = parseIdent();
            if (String(setting || '').toUpperCase() === 'CONSTRAINTS') {
                // PostgreSQL can change a deferrable constraint from its
                // initial timing with SET CONSTRAINTS. The executor supports
                // INITIALLY DEFERRED at COMMIT, but not arbitrary per-name or
                // IMMEDIATE timing, so do not silently pretend this command
                // changed validation behavior.
                log('error', 'SET CONSTRAINTS timing changes are not supported in Data View; no changes were applied');
                skipToSemicolon();
                return;
            }
            if (String(setting || '').toUpperCase() !== 'FOREIGN_KEY_CHECKS') {
                // Other SET variables are intentionally display-only. They do
                // not change relational rows or schema in the Data View.
                skipToSemicolon();
                return;
            }
            const enabled = parseSessionBoolean();
            if (enabled == null) {
                log('error', 'SET FOREIGN_KEY_CHECKS expects 0/1, OFF/ON, or FALSE/TRUE');
            } else if (dialectProfile.id !== 'mysql' && dialectProfile.id !== 'auto') {
                log('warning', 'FOREIGN_KEY_CHECKS is a MySQL connection setting; no change was applied');
            } else {
                foreignKeyEnforcement = enabled;
                log('success', `MySQL foreign-key checks ${enabled ? 'enabled' : 'disabled'} for this connection`);
            }
            skipToSemicolon();
        }

        function parseTransactionControl(keyword) {
            if (keyword === 'BEGIN' || keyword === 'START') {
                if (keyword === 'START') consumeKW('TRANSACTION');
                else consumeKW('TRANSACTION') || consumeKW('WORK');
                if (transactionState) {
                    log('warning', 'BEGIN: a transaction is already active');
                } else {
                    transactionState = { base: snapshotTransactionState(), savepoints: [], aborted: false };
                    log('success', 'Transaction started');
                }
                consumeTransactionTerminator();
                return;
            }

            if (keyword === 'COMMIT') {
                consumeKW('TRANSACTION') || consumeKW('WORK');
                if (!transactionState) log('warning', 'COMMIT: no transaction is active');
                else if (transactionState.aborted && dialectProfile.id === 'postgres') {
                    // In PostgreSQL COMMIT after an ERROR completes as a
                    // rollback. Restoring the original snapshot makes the
                    // preview state match that observable outcome.
                    restoreTransactionState(transactionState.base);
                    transactionState = null;
                    log('warning', 'COMMIT: PostgreSQL transaction was aborted and has been rolled back');
                }
                else {
                    const deferredErrors = validateDeferredForeignKeysAtCommit();
                    if (deferredErrors.length > 0) {
                        // A deferred FK violation is reported by COMMIT, and
                        // PostgreSQL does not retain the transaction's rows.
                        // Restore the full snapshot so the preview cannot
                        // expose data that a successful commit would reject.
                        deferredErrors.forEach((message) => log('error', message));
                        restoreTransactionState(transactionState.base);
                        transactionState = null;
                        log('warning', 'COMMIT: deferred foreign-key validation failed and the transaction was rolled back');
                    } else {
                        transactionState = null;
                        log('success', 'Transaction committed');
                    }
                }
                consumeTransactionTerminator();
                return;
            }

            if (keyword === 'SAVEPOINT') {
                const name = parseIdent();
                if (!name) log('error', 'SAVEPOINT: missing name');
                else if (!transactionState) log('error', `SAVEPOINT "${name}": no transaction is active`);
                else {
                    transactionState.savepoints.push({ name, snapshot: snapshotTransactionState() });
                    log('success', `Savepoint "${name}" created`);
                }
                consumeTransactionTerminator();
                return;
            }

            if (keyword === 'RELEASE') {
                consumeKW('SAVEPOINT');
                const name = parseIdent();
                if (!name) log('error', 'RELEASE: missing savepoint name');
                else if (!transactionState) log('error', `RELEASE "${name}": no transaction is active`);
                else {
                    const savepointIndex = latestSavepointIndex(name);
                    if (savepointIndex < 0) log('error', `RELEASE: savepoint "${name}" does not exist`);
                    else {
                        transactionState.savepoints.splice(savepointIndex);
                        log('success', `Savepoint "${name}" released`);
                    }
                }
                consumeTransactionTerminator();
                return;
            }

            // ROLLBACK [TRANSACTION|WORK] | ROLLBACK [TRANSACTION] TO [SAVEPOINT] name
            consumeKW('TRANSACTION') || consumeKW('WORK');
            const isRollbackTo = consumeKW('TO');
            if (isRollbackTo) consumeKW('SAVEPOINT');
            const savepointName = isRollbackTo ? parseIdent() : null;
            if (!transactionState) {
                log('error', 'ROLLBACK: no transaction is active');
            } else if (isRollbackTo) {
                if (!savepointName) log('error', 'ROLLBACK TO: missing savepoint name');
                else {
                    const savepointIndex = latestSavepointIndex(savepointName);
                    if (savepointIndex < 0) log('error', `ROLLBACK TO: savepoint "${savepointName}" does not exist`);
                    else {
                        restoreTransactionState(transactionState.savepoints[savepointIndex].snapshot);
                        // SQL keeps the target savepoint active and discards
                        // savepoints nested after it.
                        transactionState.savepoints.splice(savepointIndex + 1);
                        // PostgreSQL's ROLLBACK TO is the recovery route from
                        // an aborted transaction, provided the savepoint was
                        // created before the failing statement.
                        transactionState.aborted = false;
                        log('success', `Rolled back to savepoint "${savepointName}"`);
                    }
                }
            } else {
                restoreTransactionState(transactionState.base);
                transactionState = null;
                log('success', 'Transaction rolled back');
            }
            consumeTransactionTerminator();
        }

        function commitMySqlDdlTransaction() {
            if (transactionState && dialectProfile.id === 'mysql') {
                transactionState = null;
                log('info', 'MySQL implicitly committed the active transaction before DDL');
            }
        }

        function executeStatement(stmt) {
            idx = stmt.startIdx;
            const t = peek();
            if (!t || t.type !== 'KW') return;
            // Anchor every log entry emitted while parsing this statement
            // to its leading keyword's source position by default. Callsites
            // can still override per-call by passing an explicit token to
            // log() (used for sub-statement granularity, e.g. per-column).
            currentStatementToken = t;
            const kw = t.value.toUpperCase();

            if (kw === 'BEGIN' || kw === 'START' || kw === 'COMMIT' || kw === 'ROLLBACK' || kw === 'SAVEPOINT' || kw === 'RELEASE') {
                next();
                if (
                    transactionState?.aborted &&
                    dialectProfile.id === 'postgres' &&
                    kw !== 'ROLLBACK' &&
                    kw !== 'COMMIT'
                ) {
                    log('error', 'current transaction is aborted; use ROLLBACK or ROLLBACK TO SAVEPOINT before issuing another command');
                    skipToSemicolon();
                    return;
                }
                return parseTransactionControl(kw);
            }

            if (transactionState?.aborted && dialectProfile.id === 'postgres') {
                log('error', 'current transaction is aborted; use ROLLBACK or ROLLBACK TO SAVEPOINT before issuing another command');
                skipToSemicolon();
                return;
            }

            if (kw === 'SET' || kw === 'PRAGMA') {
                next();
                return parseSessionSetting(kw);
            }

            if (stmt.kind === 'ddl') commitMySqlDdlTransaction();

            if (kw === 'CREATE') {
                next();
                const createMode = consumeCreateMode();
                // CREATE [OR REPLACE|OR ALTER] [modifiers...] TABLE/TYPE/VIEW/INDEX ...
                // Peek ahead through object modifiers without consuming them;
                // each sub-parser consumes the modifiers it owns.
                let lookahead = 0;
                while (peek(lookahead)) {
                    const la = peek(lookahead);
                    if (lookahead > 0 && (la.type === 'OP' || la.type === 'PUNC') && la.value !== ';' && la.value !== '(') {
                        lookahead++;
                        continue;
                    }
                    if (lookahead > 0 && (la.type === 'IDENT' || la.type === 'STRING')) {
                        lookahead++;
                        continue;
                    }
                    if (la.type !== 'KW') break;
                    const lk = la.value.toUpperCase();
                    if (
                        lk === 'UNIQUE' ||
                        lk === 'FULLTEXT' ||
                        lk === 'SPATIAL' ||
                        lk === 'CLUSTERED' ||
                        lk === 'NONCLUSTERED' ||
                        lk === 'CONCURRENTLY' ||
                        lk === 'COLUMNSTORE' ||
                        lk === 'GLOBAL' ||
                        lk === 'LOCAL' ||
                        lk === 'TEMP' ||
                        lk === 'TEMPORARY' ||
                        lk === 'UNLOGGED' ||
                        lk === 'MATERIALIZED' ||
                        lk === 'ALGORITHM' ||
                        lk === 'DEFINER' ||
                        lk === 'SQL' ||
                        lk === 'SECURITY' ||
                        lk === 'UNDEFINED' ||
                        lk === 'MERGE' ||
                        lk === 'TEMPTABLE' ||
                        lk === 'INVOKER'
                    ) {
                        lookahead++;
                        continue;
                    }
                    break;
                }
                const after = peek(lookahead);
                if (after && after.type === 'KW') {
                    const ak = after.value.toUpperCase();
                    if (ak === 'TABLE') return parseCreateTable({ orReplace: createMode === 'replace' });
                    if (ak === 'TYPE') return parseCreateType();
                    if (ak === 'VIEW') return parseCreateView({ mode: createMode });
                    if (ak === 'INDEX') return parseCreateIndex();
                }
                skipToSemicolon();
                return;
            }
            if (kw === 'ALTER') {
                next();
                return parseAlterTable();
            }
            if (kw === 'DROP') {
                next();
                if (isKW('TYPE')) return parseDropType();
                if (isKW('INDEX')) return parseDropIndex();
                if (isKW('MATERIALIZED') || isKW('VIEW')) return parseDropView();
                return parseDropTable();
            }
            if (kw === 'TRUNCATE') {
                next();
                return parseTruncate();
            }
            if (kw === 'INSERT') {
                next();
                return parseInsert();
            }
            if (kw === 'REPLACE' || kw === 'MERGE') {
                log('error', `${kw} statements are not supported in Data View; no changes were applied.`);
                skipToSemicolon();
                return;
            }
            if (kw === 'UPDATE') {
                next();
                return parseUpdate();
            }
            if (kw === 'DELETE') {
                next();
                return parseDelete();
            }
        }

        // ── Two-pass execution ──
        //
        // Pass 1: run every statement in document order, but DEFER any DML
        //         whose target table does not exist yet. This lets users
        //         write scripts where INSERT statements appear above their
        //         CREATE TABLE (a common pattern in patched dumps and AI-
        //         generated examples).
        //
        // Pass 2: replay the deferred DML. By now every CREATE TABLE has
        //         executed, so genuinely-orphan INSERTs will surface the
        //         normal "table does not exist" error from parseInsert /
        //         parseUpdate / parseDelete.
        //
        // We never reorder DDL — it executes in document order so error
        // messages line up with the user's source. Order within the deferred
        // bucket is also preserved.
        const deferred = [];
        // The pre-existing dump convenience of replaying DML after later DDL
        // would violate transaction ordering. Once a script (or prior call)
        // is transactional, execute each statement exactly where it appears.
        const usesTransactionControl = statements.some((stmt) => stmt.kind === 'transaction') || !!transactionState;
        for (const stmt of statements) {
            // The lexer error has already been logged above. Skip only the
            // affected statement so valid statements before/after it still
            // populate the Data View during editing and recovery.
            if (hasLexicalErrorInStatement(stmt)) continue;
            if (!usesTransactionControl && stmt.kind === 'dml') {
                const targetName = dmlTargetTable(stmt);
                if (targetName && !findTable(targetName)) {
                    deferred.push(stmt);
                    continue;
                }
            }
            executeStatement(stmt);
        }

        for (const stmt of deferred) executeStatement(stmt);
        refreshViews();

        return { tables, types, log: executionLog };
    }

    return { tables, types, executionLog, execute };
}
