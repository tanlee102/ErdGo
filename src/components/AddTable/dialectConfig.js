/**
 * Dialect configuration — single source of truth for the Add Table modal.
 * ============================================================================
 *
 * Each dialect describes everything the modal needs to emit *correct, native*
 * SQL for that engine:
 *
 *   - id / label                       — internal id + UI label
 *   - quoteStyle                       — ', `, or [
 *   - reservedWords                    — minimal subset; identifiers in this
 *                                        set are always quoted
 *   - typeGroups                       — ordered groups for the datalist
 *   - defaultChips                     — quick-pick DEFAULT helpers
 *   - autoIncrement(type)              — returns { type, suffix, placement }
 *                                        for an auto-increment column.
 *                                        placement = 'after-type' (default —
 *                                        MySQL/MSSQL) or 'after-pk' (SQLite,
 *                                        for `INTEGER PRIMARY KEY
 *                                        AUTOINCREMENT` ordering).
 *   - generatedSql(expr)               — emits dialect-specific generated
 *                                        column syntax
 *   - supportsFkActions                — whether ON DELETE / ON UPDATE
 *                                        are honored
 *   - supportsIfNotExists              — whether `IF NOT EXISTS` is legal
 *                                        on `CREATE TABLE`
 *   - tableSuffix                      — engine/charset clause (MySQL only)
 *
 * The contract is intentionally narrow so callers (the modal + the dropdown)
 * never branch on dialect id directly — they just consume the config.
 *
 * Round-trip guarantee: every SQL fragment produced by these helpers is
 * parsed cleanly by `src/lib/parse-ast/parseAst.js` (covered by the
 * end-to-end parser pipeline).
 */

// ────────────────────────────────────────────────────────────────────────────
// Identifier quoting (smart: only quotes when actually necessary)
// ────────────────────────────────────────────────────────────────────────────

const BARE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const COMMON_RESERVED = new Set([
    'select', 'from', 'where', 'table', 'index', 'key', 'order', 'group',
    'by', 'as', 'and', 'or', 'not', 'null', 'true', 'false', 'primary',
    'foreign', 'references', 'unique', 'check', 'default', 'create',
    'alter', 'drop', 'insert', 'update', 'delete', 'into', 'values',
    'user', 'role', 'type', 'case', 'when', 'then', 'end', 'is', 'in',
    'between', 'like', 'desc', 'asc',
]);

/**
 * Build a smart quoter for one dialect. Two non-obvious behaviours:
 *
 *  1. Schema-qualified identifiers like `public.users`, `dbo.orders`, or
 *     even three-part `mydb.dbo.orders` (MSSQL) are split on `.` and each
 *     segment is independently smart-quoted, then re-joined with `.`. So
 *     `quoteIdent('public.users')` → `"public"."users"` (PG/SQLite),
 *     not `"public.users"` (which would render as a single weird name).
 *     Empty segments (a stray leading/trailing `.`) are dropped to avoid
 *     emitting `"public"."users".""`.
 *  2. Bare segments that aren't reserved words pass through unquoted so
 *     the generated SQL stays human-readable (`users`, not `"users"`).
 */
function quoteFactory(open, close) {
    const escapeRe = new RegExp(close.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const quoteOne = (text) => {
        const lower = text.toLowerCase();
        if (BARE_IDENT.test(text) && !COMMON_RESERVED.has(lower)) return text;
        return `${open}${text.replace(escapeRe, close + close)}${close}`;
    };
    return (s) => {
        if (s == null || s === '') return s;
        const text = String(s);
        if (!text.includes('.')) return quoteOne(text);
        return text
            .split('.')
            .filter((part) => part !== '')
            .map(quoteOne)
            .join('.');
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Default-value helper — quote literals that look like text, leave function
// calls (`now()`, `CURRENT_TIMESTAMP`, etc.) untouched.
// ────────────────────────────────────────────────────────────────────────────

const KEYWORD_LITERAL = /^(?:CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|NULL|TRUE|FALSE)$/i;
const NUMERIC_LITERAL = /^-?\d+(?:\.\d+)?$/;
const ALREADY_QUOTED = /^(['"]).*\1$/s;
const FN_NAME_HEAD = /^[a-zA-Z_][a-zA-Z0-9_.]*\s*\(/;

/**
 * Walk `v` from `start` and return the index *just past* the closing `)`
 * that matches the `(` at `start`. Returns -1 on imbalance / no closer.
 *
 * String-literal aware: `(` and `)` inside `'...'` / `"..."` are ignored,
 * SQL-standard `''` / `""` doubled-quote escapes are honoured. This is
 * what lets us correctly recognise `(strftime('%s', 'now'))` and
 * `coalesce(now(), CURRENT_TIMESTAMP)` as balanced expressions instead of
 * stringifying them.
 */
function matchParen(v, start) {
    if (v[start] !== '(') return -1;
    let depth = 0;
    let inStr = false;
    let strCh = '';
    for (let i = start; i < v.length; i++) {
        const c = v[i];
        if (inStr) {
            if (c === strCh) {
                if (v[i + 1] === strCh) { i++; continue; }   // doubled-quote escape
                inStr = false;
            }
            continue;
        }
        if (c === "'" || c === '"') { inStr = true; strCh = c; continue; }
        if (c === '(') depth++;
        else if (c === ')') {
            depth--;
            if (depth === 0) return i + 1;
            if (depth < 0) return -1;
        }
    }
    return -1;
}

/** True when `v` is a single balanced `(...)` expression spanning the entire string. */
function isParenExpr(v) {
    if (v.length < 2 || v[0] !== '(') return false;
    return matchParen(v, 0) === v.length;
}

/**
 * True when `v` looks like a function call (optionally schema-qualified)
 * spanning the entire string — `now()`, `gen_random_uuid()`,
 * `strftime('%s', 'now')`, `coalesce(now(), CURRENT_TIMESTAMP)`,
 * `pg_catalog.now()`. The earlier regex-only check `^ident\s*\([^)]*\)$`
 * mishandled both nested parens AND embedded string literals containing
 * `)`, so non-trivial defaults got string-quoted.
 */
function isFunctionCall(v) {
    const m = v.match(FN_NAME_HEAD);
    if (!m) return false;
    const parenIdx = m[0].length - 1;
    return matchParen(v, parenIdx) === v.length;
}

export function formatDefault(raw) {
    if (raw == null || raw === '') return '';
    const v = String(raw).trim();
    if (
        isFunctionCall(v) ||
        KEYWORD_LITERAL.test(v) ||
        NUMERIC_LITERAL.test(v) ||
        ALREADY_QUOTED.test(v) ||
        isParenExpr(v)
    ) {
        return v;
    }
    return `'${v.replace(/'/g, "''")}'`;
}

// ────────────────────────────────────────────────────────────────────────────
// Per-dialect configurations
// ────────────────────────────────────────────────────────────────────────────

const PG_TYPES = [
    { group: 'Numeric',   types: ['SMALLINT', 'INTEGER', 'BIGINT', 'DECIMAL(10,2)', 'NUMERIC(18,4)', 'REAL', 'DOUBLE PRECISION'] },
    { group: 'Auto-inc',  types: ['SERIAL', 'BIGSERIAL'] },
    { group: 'Text',      types: ['TEXT', 'VARCHAR(255)', 'VARCHAR(64)', 'CHAR(1)', 'CITEXT'] },
    { group: 'Date/Time', types: ['DATE', 'TIME', 'TIMESTAMP', 'TIMESTAMPTZ', 'INTERVAL'] },
    { group: 'Boolean',   types: ['BOOLEAN'] },
    { group: 'Binary',    types: ['BYTEA'] },
    { group: 'JSON',      types: ['JSON', 'JSONB'] },
    { group: 'UUID',      types: ['UUID'] },
    { group: 'Network',   types: ['INET', 'CIDR', 'MACADDR'] },
];

const MY_TYPES = [
    { group: 'Numeric',   types: ['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'BIGINT', 'DECIMAL(10,2)', 'FLOAT', 'DOUBLE'] },
    { group: 'Unsigned',  types: ['INT UNSIGNED', 'BIGINT UNSIGNED'] },
    { group: 'Text',      types: ['VARCHAR(255)', 'VARCHAR(64)', 'CHAR(1)', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT'] },
    { group: 'Date/Time', types: ['DATE', 'TIME', 'DATETIME', 'TIMESTAMP', 'YEAR'] },
    { group: 'Boolean',   types: ['BOOLEAN', 'BIT(1)'] },
    { group: 'Binary',    types: ['BLOB', 'MEDIUMBLOB', 'LONGBLOB', 'BINARY(16)', 'VARBINARY(255)'] },
    { group: 'JSON',      types: ['JSON'] },
    { group: 'Spatial',   types: ['GEOMETRY', 'POINT', 'LINESTRING', 'POLYGON'] },
];

const MS_TYPES = [
    { group: 'Numeric',   types: ['TINYINT', 'SMALLINT', 'INT', 'BIGINT', 'DECIMAL(18,2)', 'NUMERIC(18,4)', 'MONEY', 'FLOAT', 'REAL'] },
    { group: 'Text',      types: ['NVARCHAR(255)', 'NVARCHAR(MAX)', 'VARCHAR(255)', 'VARCHAR(MAX)', 'CHAR(1)', 'NCHAR(1)', 'TEXT', 'NTEXT'] },
    { group: 'Date/Time', types: ['DATE', 'TIME', 'DATETIME', 'DATETIME2', 'DATETIMEOFFSET', 'SMALLDATETIME'] },
    { group: 'Boolean',   types: ['BIT'] },
    { group: 'Binary',    types: ['VARBINARY(MAX)', 'VARBINARY(255)', 'BINARY(16)', 'IMAGE'] },
    { group: 'GUID',      types: ['UNIQUEIDENTIFIER'] },
    { group: 'XML/JSON',  types: ['XML'] },
    { group: 'Other',     types: ['SQL_VARIANT', 'HIERARCHYID'] },
];

// SQLite uses *type affinity* rather than strict types — almost any token is
// accepted by the parser, but only the five affinities (TEXT/NUMERIC/INTEGER/
// REAL/BLOB) are actually enforced. We expose:
//   1. The five canonical affinities first (most idiomatic in modern SQLite).
//   2. Common named conveniences (VARCHAR, BOOLEAN, DATETIME) that map to an
//      affinity but read naturally in DDL written by users coming from other
//      engines.
//   3. STRICT-mode `ANY` for SQLite ≥ 3.37 strict tables.
const SQLITE_TYPES = [
    { group: 'Affinity',  types: ['INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB'] },
    { group: 'Numeric',   types: ['BIGINT', 'SMALLINT', 'DECIMAL(10,2)', 'BOOLEAN'] },
    { group: 'Text',      types: ['VARCHAR(255)', 'VARCHAR(64)', 'CHAR(1)'] },
    { group: 'Date/Time', types: ['DATETIME', 'DATE', 'TIME', 'TIMESTAMP'] },
    { group: 'JSON',      types: ['JSON'] },
    { group: 'STRICT',    types: ['ANY'] },
];

const PG_DEFAULT_CHIPS = [
    { label: 'now()',                value: 'now()' },
    { label: 'CURRENT_TIMESTAMP',    value: 'CURRENT_TIMESTAMP' },
    { label: 'gen_random_uuid()',    value: 'gen_random_uuid()' },
    { label: 'TRUE',                 value: 'TRUE' },
    { label: 'FALSE',                value: 'FALSE' },
    { label: '0',                    value: '0' },
    { label: 'NULL',                 value: 'NULL' },
];

const MY_DEFAULT_CHIPS = [
    { label: 'CURRENT_TIMESTAMP',    value: 'CURRENT_TIMESTAMP' },
    { label: 'UUID()',               value: 'UUID()' },
    { label: 'TRUE',                 value: 'TRUE' },
    { label: 'FALSE',                value: 'FALSE' },
    { label: '0',                    value: '0' },
    { label: 'NULL',                 value: 'NULL' },
];

const MS_DEFAULT_CHIPS = [
    { label: 'GETDATE()',            value: 'GETDATE()' },
    { label: 'SYSUTCDATETIME()',     value: 'SYSUTCDATETIME()' },
    { label: 'NEWID()',              value: 'NEWID()' },
    { label: 'NEWSEQUENTIALID()',    value: 'NEWSEQUENTIALID()' },
    { label: '1',                    value: '1' },
    { label: '0',                    value: '0' },
    { label: 'NULL',                 value: 'NULL' },
];

const SQLITE_DEFAULT_CHIPS = [
    { label: 'CURRENT_TIMESTAMP',    value: 'CURRENT_TIMESTAMP' },
    { label: 'CURRENT_DATE',         value: 'CURRENT_DATE' },
    { label: '(unixepoch())',        value: '(unixepoch())' },
    { label: '0',                    value: '0' },
    { label: '1',                    value: '1' },
    { label: 'NULL',                 value: 'NULL' },
];

// Auto-increment translators. Each returns the *replacement* type and an
// optional `suffix` clause appended after the constraints. A null `type`
// means "keep whatever the user typed".
function pgAutoInc(type) {
    const upper = (type || '').toUpperCase().trim();
    if (upper === 'BIGINT' || upper === 'BIGSERIAL') return { type: 'BIGSERIAL', suffix: '' };
    return { type: 'SERIAL', suffix: '' };
}

function myAutoInc(type) {
    const upper = (type || '').toUpperCase().trim();
    const usable = ['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'BIGINT', 'INT UNSIGNED', 'BIGINT UNSIGNED'].includes(upper)
        ? upper
        : 'INT';
    return { type: usable, suffix: 'AUTO_INCREMENT' };
}

function msAutoInc(type) {
    const upper = (type || '').toUpperCase().trim();
    const usable = ['TINYINT', 'SMALLINT', 'INT', 'BIGINT'].includes(upper) ? upper : 'INT';
    return { type: usable, suffix: 'IDENTITY(1,1)' };
}

// SQLite's auto-increment idiom is `INTEGER PRIMARY KEY AUTOINCREMENT`. The
// type MUST be exactly `INTEGER` (not BIGINT, not INT) for the column to
// alias ROWID, and the keyword `AUTOINCREMENT` MUST come AFTER `PRIMARY KEY`.
// We signal the latter via `placement: 'after-pk'` so the renderer can
// schedule the suffix correctly. In composite-PK scenarios the suffix is
// omitted entirely (SQLite forbids AUTOINCREMENT on composite PKs) — that
// fallout is handled naturally by the column generator: when the column is
// part of a composite PK, the inline `PRIMARY KEY` is suppressed, so the
// `after-pk` suffix is also suppressed.
function liteAutoInc(/* type ignored — SQLite REQUIRES INTEGER */) {
    return { type: 'INTEGER', suffix: 'AUTOINCREMENT', placement: 'after-pk' };
}

const POSTGRES = {
    id: 'postgres',
    label: 'PostgreSQL',
    quoteIdent: quoteFactory('"', '"'),
    typeGroups: PG_TYPES,
    defaultChips: PG_DEFAULT_CHIPS,
    autoIncrement: pgAutoInc,
    generatedSql: (expr) => `GENERATED ALWAYS AS (${expr}) STORED`,
    supportsFkActions: true,
    supportsIfNotExists: true,
    tableSuffix: '',
};

const MYSQL = {
    id: 'mysql',
    label: 'MySQL',
    quoteIdent: quoteFactory('`', '`'),
    typeGroups: MY_TYPES,
    defaultChips: MY_DEFAULT_CHIPS,
    autoIncrement: myAutoInc,
    generatedSql: (expr) => `GENERATED ALWAYS AS (${expr}) STORED`,
    supportsFkActions: true,
    supportsIfNotExists: true,
    tableSuffix: 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
};

const MSSQL = {
    id: 'mssql',
    label: 'MSSQL',
    quoteIdent: quoteFactory('[', ']'),
    typeGroups: MS_TYPES,
    defaultChips: MS_DEFAULT_CHIPS,
    autoIncrement: msAutoInc,
    generatedSql: (expr) => `AS (${expr}) PERSISTED`,
    supportsFkActions: true,
    supportsIfNotExists: false, // emitted as `IF NOT EXISTS (SELECT…)` separately
    tableSuffix: '',
};

const SQLITE = {
    id: 'sqlite',
    label: 'SQLite',
    quoteIdent: quoteFactory('"', '"'),
    typeGroups: SQLITE_TYPES,
    defaultChips: SQLITE_DEFAULT_CHIPS,
    autoIncrement: liteAutoInc,
    generatedSql: (expr) => `GENERATED ALWAYS AS (${expr}) STORED`,
    supportsFkActions: true,
    supportsIfNotExists: true,
    tableSuffix: '',
};

export const DIALECTS = [SQLITE, POSTGRES, MYSQL, MSSQL];
export const DIALECT_BY_ID = Object.fromEntries(DIALECTS.map((d) => [d.id, d]));

export const FK_ACTIONS = ['CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT', 'NO ACTION'];

export const DEFAULT_DIALECT_ID = 'sqlite';

/**
 * Flatten the type groups for a `<datalist>` while keeping group order.
 * Returns `[{ value, group }]` so callers can render headers if they want.
 */
export function flatTypes(dialect) {
    const out = [];
    for (const g of dialect.typeGroups) {
        for (const t of g.types) out.push({ value: t, group: g.group });
    }
    return out;
}
