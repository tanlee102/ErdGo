import { describe, it, expect } from 'vitest';
import { DIALECTS, DIALECT_BY_ID, flatTypes, formatDefault, FK_ACTIONS, DEFAULT_DIALECT_ID } from '@/components/AddTable/dialectConfig';
import { generateSql, getAddTableValidationErrors } from '@/components/AddTable';
import { parseAST } from '@/lib/parse-ast/parseAst';
import { sqlToErdSchema } from '@/lib/erdJsonSchema';

// ════════════════════════════════════════════════════════════════════════════
// dialectConfig.test.js — production sanity for the Add Table modal's
// dialect catalog. Every emitted SQL fragment must round-trip cleanly through
// the project's own parser + ERD JSON pipeline.
// ════════════════════════════════════════════════════════════════════════════

describe('Dialect catalog — registry shape', () => {
    it('exports exactly 4 dialects: postgres, mysql, mssql, sqlite', () => {
        expect(DIALECTS.map((d) => d.id).sort()).toEqual(['mssql', 'mysql', 'postgres', 'sqlite']);
    });

    it('puts SQLite first and uses SQLite as the default Add Table dialect', () => {
        expect(DIALECTS.map((d) => d.id)).toEqual(['sqlite', 'postgres', 'mysql', 'mssql']);
        expect(DEFAULT_DIALECT_ID).toBe('sqlite');
    });

    it('default dialect id is registered', () => {
        expect(DIALECT_BY_ID[DEFAULT_DIALECT_ID]).toBeDefined();
    });

    it('every dialect satisfies the public contract', () => {
        for (const d of DIALECTS) {
            expect(typeof d.id).toBe('string');
            expect(typeof d.label).toBe('string');
            expect(typeof d.quoteIdent).toBe('function');
            expect(Array.isArray(d.typeGroups)).toBe(true);
            expect(d.typeGroups.length).toBeGreaterThan(0);
            expect(Array.isArray(d.defaultChips)).toBe(true);
            expect(d.defaultChips.length).toBeGreaterThan(0);
            expect(typeof d.autoIncrement).toBe('function');
            expect(typeof d.generatedSql).toBe('function');
            expect(typeof d.supportsFkActions).toBe('boolean');
            expect(typeof d.supportsIfNotExists).toBe('boolean');
            expect(typeof d.tableSuffix).toBe('string');
        }
    });

    it('FK_ACTIONS list is non-empty and stable', () => {
        expect(FK_ACTIONS.length).toBeGreaterThan(0);
        expect(FK_ACTIONS).toContain('CASCADE');
        expect(FK_ACTIONS).toContain('SET NULL');
    });
});

describe('Identifier quoting — per dialect', () => {
    it('PostgreSQL uses "ident"', () => {
        expect(DIALECT_BY_ID.postgres.quoteIdent('user')).toBe('"user"'); // reserved
        expect(DIALECT_BY_ID.postgres.quoteIdent('email')).toBe('email');
    });

    it('MySQL uses `ident`', () => {
        expect(DIALECT_BY_ID.mysql.quoteIdent('user')).toBe('`user`');
        expect(DIALECT_BY_ID.mysql.quoteIdent('email')).toBe('email');
    });

    it('MSSQL uses [ident]', () => {
        expect(DIALECT_BY_ID.mssql.quoteIdent('user')).toBe('[user]');
        expect(DIALECT_BY_ID.mssql.quoteIdent('email')).toBe('email');
    });

    it('SQLite uses "ident" (standard double-quote)', () => {
        expect(DIALECT_BY_ID.sqlite.quoteIdent('user')).toBe('"user"');
        expect(DIALECT_BY_ID.sqlite.quoteIdent('email')).toBe('email');
    });

    it('SQLite quotes non-bare identifiers', () => {
        expect(DIALECT_BY_ID.sqlite.quoteIdent('order id')).toBe('"order id"');
        expect(DIALECT_BY_ID.sqlite.quoteIdent('first-name')).toBe('"first-name"');
    });

    // ──────────────────────────────────────────────────────────────────
    // Schema-qualified identifiers — split on `.`, quote each segment
    // independently. Earlier behaviour quoted the whole string as one
    // identifier (`"public.users"`), which Postgres / SQLite parsed as a
    // single weird name with an embedded dot — silently breaking every
    // cross-schema FK.
    // ──────────────────────────────────────────────────────────────────
    describe('schema-qualified (dotted) identifiers — quote each segment', () => {
        it('PostgreSQL: schema.table → "schema"."table" only when needed', () => {
            // Both segments are bare and not reserved → no quotes added.
            expect(DIALECT_BY_ID.postgres.quoteIdent('public.users')).toBe('public.users');
            // `user` is reserved → that segment is quoted, the schema isn't.
            expect(DIALECT_BY_ID.postgres.quoteIdent('public.user')).toBe('public."user"');
            // Both reserved → both quoted.
            expect(DIALECT_BY_ID.postgres.quoteIdent('user.role')).toBe('"user"."role"');
        });

        it('MSSQL: schema.table → [schema].[table]', () => {
            expect(DIALECT_BY_ID.mssql.quoteIdent('dbo.orders')).toBe('dbo.orders');
            expect(DIALECT_BY_ID.mssql.quoteIdent('dbo.user')).toBe('dbo.[user]');
            expect(DIALECT_BY_ID.mssql.quoteIdent('my db.dbo.orders')).toBe('[my db].dbo.orders');
        });

        it('MySQL: db.table → `db`.`table`', () => {
            expect(DIALECT_BY_ID.mysql.quoteIdent('mydb.orders')).toBe('mydb.orders');
            expect(DIALECT_BY_ID.mysql.quoteIdent('mydb.order')).toBe('mydb.`order`');
            expect(DIALECT_BY_ID.mysql.quoteIdent('my db.orders')).toBe('`my db`.orders');
        });

        it('SQLite: schema.table → "schema"."table"', () => {
            expect(DIALECT_BY_ID.sqlite.quoteIdent('main.users')).toBe('main.users');
            expect(DIALECT_BY_ID.sqlite.quoteIdent('main.user')).toBe('main."user"');
        });

        it('three-part MSSQL identifier (db.schema.table) quotes each part', () => {
            expect(DIALECT_BY_ID.mssql.quoteIdent('mydb.dbo.user')).toBe('mydb.dbo.[user]');
        });

        it('strips empty segments from leading / trailing / doubled dots', () => {
            // Stray `.public.users` would otherwise yield `""."public"."users"`.
            expect(DIALECT_BY_ID.postgres.quoteIdent('.public.users')).toBe('public.users');
            expect(DIALECT_BY_ID.postgres.quoteIdent('public.users.')).toBe('public.users');
            expect(DIALECT_BY_ID.postgres.quoteIdent('public..users')).toBe('public.users');
        });

        it('round-trip: a CREATE TABLE with a schema-qualified FK target parses cleanly', () => {
            // The bug we fixed: `"public.users"` rendered the FK target as a
            // single identifier with a literal dot. After the fix, each
            // segment is quoted independently and the parser sees a real
            // schema-qualified reference.
            const D = DIALECT_BY_ID.postgres;
            const ref = D.quoteIdent('public.users');
            const sql = `CREATE TABLE posts (id INT PRIMARY KEY, user_id INT REFERENCES ${ref}(id));`;
            // `"public"."users"` (quoted) and `public.users` (bare) are
            // both valid; the bug was `"public.users"` (one quoted blob).
            expect(sql).not.toMatch(/"public\.users"/);
            const { errors } = parseAST(sql);
            expect(errors.filter((e) => e.severity === 'error')).toEqual([]);
        });
    });
});

describe('Auto-increment — per dialect', () => {
    it('Postgres: BIGINT → BIGSERIAL', () => {
        expect(DIALECT_BY_ID.postgres.autoIncrement('BIGINT')).toEqual({ type: 'BIGSERIAL', suffix: '' });
        expect(DIALECT_BY_ID.postgres.autoIncrement('INT')).toEqual({ type: 'SERIAL', suffix: '' });
    });

    it('MySQL: keeps integer family + AUTO_INCREMENT suffix', () => {
        const r = DIALECT_BY_ID.mysql.autoIncrement('BIGINT');
        expect(r.type).toBe('BIGINT');
        expect(r.suffix).toBe('AUTO_INCREMENT');
    });

    it('MySQL: unknown type falls back to INT', () => {
        const r = DIALECT_BY_ID.mysql.autoIncrement('TEXT');
        expect(r.type).toBe('INT');
    });

    it('MSSQL: emits IDENTITY(1,1)', () => {
        const r = DIALECT_BY_ID.mssql.autoIncrement('BIGINT');
        expect(r.type).toBe('BIGINT');
        expect(r.suffix).toBe('IDENTITY(1,1)');
    });

    it('SQLite: forces INTEGER + AUTOINCREMENT + placement="after-pk"', () => {
        const r = DIALECT_BY_ID.sqlite.autoIncrement('BIGINT'); // user-typed type ignored
        expect(r.type).toBe('INTEGER');
        expect(r.suffix).toBe('AUTOINCREMENT');
        expect(r.placement).toBe('after-pk');
    });

    it('SQLite: ignores user-supplied type even when sane (must be INTEGER)', () => {
        for (const inp of ['INT', 'BIGINT', 'NUMERIC', '', undefined]) {
            const r = DIALECT_BY_ID.sqlite.autoIncrement(inp);
            expect(r.type).toBe('INTEGER');
        }
    });
});

describe('Generated columns — per dialect', () => {
    it('PostgreSQL emits GENERATED ALWAYS AS (...) STORED', () => {
        expect(DIALECT_BY_ID.postgres.generatedSql('price * qty')).toBe('GENERATED ALWAYS AS (price * qty) STORED');
    });

    it('MySQL emits GENERATED ALWAYS AS (...) STORED', () => {
        expect(DIALECT_BY_ID.mysql.generatedSql('a + b')).toBe('GENERATED ALWAYS AS (a + b) STORED');
    });

    it('MSSQL emits AS (...) PERSISTED (bare-AS form)', () => {
        expect(DIALECT_BY_ID.mssql.generatedSql('a + b')).toBe('AS (a + b) PERSISTED');
    });

    it('SQLite emits GENERATED ALWAYS AS (...) STORED', () => {
        expect(DIALECT_BY_ID.sqlite.generatedSql('a + b')).toBe('GENERATED ALWAYS AS (a + b) STORED');
    });
});

describe('Type catalog — per dialect', () => {
    it('every dialect exposes at least one numeric and one text type', () => {
        for (const d of DIALECTS) {
            const flat = flatTypes(d).map((t) => t.value.toUpperCase());
            const hasNumeric = flat.some((t) => /\b(INT|INTEGER|NUMERIC|DECIMAL|REAL|FLOAT|BIGINT)\b/.test(t));
            const hasText = flat.some((t) => /\b(TEXT|VARCHAR|NVARCHAR|CHAR)\b/.test(t));
            expect(hasNumeric, `${d.id}: numeric type`).toBe(true);
            expect(hasText, `${d.id}: text type`).toBe(true);
        }
    });

    it('SQLite lists the five canonical type affinities first', () => {
        const aff = DIALECT_BY_ID.sqlite.typeGroups[0];
        expect(aff.group).toBe('Affinity');
        expect(aff.types).toEqual(['INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB']);
    });

    it('SQLite includes ANY for STRICT mode', () => {
        const flat = flatTypes(DIALECT_BY_ID.sqlite).map((t) => t.value);
        expect(flat).toContain('ANY');
    });
});

describe('Default chips — per dialect', () => {
    it('SQLite default chips include CURRENT_TIMESTAMP and (unixepoch())', () => {
        const vals = DIALECT_BY_ID.sqlite.defaultChips.map((c) => c.value);
        expect(vals).toContain('CURRENT_TIMESTAMP');
        expect(vals).toContain('(unixepoch())');
        expect(vals).toContain('NULL');
    });

    it('formatDefault leaves function calls and keyword literals untouched', () => {
        expect(formatDefault('CURRENT_TIMESTAMP')).toBe('CURRENT_TIMESTAMP');
        expect(formatDefault('now()')).toBe('now()');
        expect(formatDefault('(unixepoch())')).toBe('(unixepoch())'); // parenthesized expression preserved
        expect(formatDefault('NULL')).toBe('NULL');
        expect(formatDefault('TRUE')).toBe('TRUE');
        expect(formatDefault('42')).toBe('42');
        expect(formatDefault("'already quoted'")).toBe("'already quoted'");
        expect(formatDefault('plain text')).toBe("'plain text'");
    });

    // ──────────────────────────────────────────────────────────────────
    // formatDefault — robustness against nested parens & string literals
    // ──────────────────────────────────────────────────────────────────
    // Earlier behaviour relied on a regex that couldn't see past one level
    // of parentheses. That meant any non-trivial DEFAULT was string-quoted
    // (e.g. `coalesce(now(), CURRENT_TIMESTAMP)` → `'coalesce(now()...'`).
    // The fix uses a string-literal-aware paren-balance walker.
    describe('formatDefault — nested function calls preserved', () => {
        it('keeps a function call with a nested call as-is', () => {
            // 1-level nest: arguments contain another `()`
            expect(formatDefault('coalesce(now(), CURRENT_TIMESTAMP)')).toBe(
                'coalesce(now(), CURRENT_TIMESTAMP)',
            );
        });

        it('keeps a function call whose args contain a string with `)`', () => {
            // The closing paren inside the string MUST NOT terminate the
            // function call early. SQL-standard `''` doubling is honoured.
            expect(formatDefault("strftime('%s)', 'now')")).toBe("strftime('%s)', 'now')");
        });

        it('keeps double-nested function calls', () => {
            expect(formatDefault('a(b(c(1)))')).toBe('a(b(c(1)))');
        });

        it('keeps schema-qualified PG function calls', () => {
            expect(formatDefault('pg_catalog.now()')).toBe('pg_catalog.now()');
        });

        it('keeps SQLite parenthesised expressions with nested calls', () => {
            // `(strftime('%s','now'))` is the canonical SQLite default for
            // unix-time stamping. Must round-trip unchanged.
            expect(formatDefault("(strftime('%s','now'))")).toBe("(strftime('%s','now'))");
            expect(formatDefault('(json_object(\'k\',1))')).toBe("(json_object('k',1))");
        });
    });

    describe('formatDefault — paren-shaped non-expressions are still string-quoted', () => {
        it('rejects two adjacent parens like `(a) + (b)` as not-a-single-expr', () => {
            // The string starts with `(` and ends with `)`, but it's NOT a
            // single balanced expression — the first `)` closes back to depth
            // 0 mid-string. Must be string-quoted, not passed through.
            expect(formatDefault('(a) + (b)')).toBe("'(a) + (b)'");
        });

        it('rejects a function-name shape with imbalanced parens', () => {
            expect(formatDefault('foo(bar')).toBe("'foo(bar'");
        });

        it('rejects a function-call shape with trailing junk', () => {
            // Looks function-callish at the start, but content continues
            // beyond the matching `)` — not a single expression. Quote it.
            expect(formatDefault('foo(bar) extra')).toBe("'foo(bar) extra'");
        });

        it('rejects a parenthesised expression with trailing content', () => {
            expect(formatDefault('(a + b) trailing')).toBe("'(a + b) trailing'");
        });

        it('still string-quotes free-form text without paren shape', () => {
            expect(formatDefault('plain text')).toBe("'plain text'");
            expect(formatDefault("doesn't apply")).toBe("'doesn''t apply'");
        });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// SQL emission — round-trip through parseAst + sqlToErdSchema
// ════════════════════════════════════════════════════════════════════════════
//
// These tests import the actual Add Table generator so production UI output and
// round-trip coverage stay locked together.

// ─── shared specs reused across dialects ────────────────────────────────
const SIMPLE_COLS = [
    { name: 'id', type: 'INTEGER', autoIncrement: true, primaryKey: true },
    { name: 'email', type: 'TEXT', notNull: true, unique: true },
    { name: 'name', type: 'TEXT', notNull: true },
];

describe('Round-trip — emitted SQL parses cleanly for every dialect', () => {
    for (const d of DIALECTS) {
        it(`${d.label}: simple users table`, () => {
            const sql = generateSql({ tableName: 'users', columns: SIMPLE_COLS, dialect: d });
            const { errors } = parseAST(sql);
            const fatal = errors.filter((e) => e.severity === 'error');
            expect(fatal, `${d.label} parse errors: ${JSON.stringify(fatal, null, 2)}`).toEqual([]);
        });
    }
});

describe('Round-trip — auto-increment ID is recognized in the ERD JSON', () => {
    for (const d of DIALECTS) {
        it(`${d.label}: users.id autoIncrement = true`, () => {
            const sql = generateSql({ tableName: 'users', columns: SIMPLE_COLS, dialect: d });
            const schema = sqlToErdSchema(sql);
            const id = schema.tables[0].columns.find((c) => c.name.toLowerCase() === 'id');
            expect(id.autoIncrement, `${d.label}: id.autoIncrement`).toBe(true);
            expect(id.pk, `${d.label}: id.pk`).toBe(true);
        });
    }
});

describe('Round-trip — composite PK across dialects', () => {
    const COLS = [
        { name: 'a', type: 'INT', primaryKey: true },
        { name: 'b', type: 'INT', primaryKey: true },
        { name: 'data', type: 'TEXT' },
    ];
    for (const d of DIALECTS) {
        it(`${d.label}: PRIMARY KEY (a, b) emitted as table-level constraint`, () => {
            const sql = generateSql({ tableName: 'pair', columns: COLS, dialect: d });
            expect(sql).toContain('PRIMARY KEY (');
            const schema = sqlToErdSchema(sql);
            const pair = schema.tables[0];
            const a = pair.columns.find((c) => c.name === 'a');
            const b = pair.columns.find((c) => c.name === 'b');
            expect(a.compositePk).toBe(true);
            expect(b.compositePk).toBe(true);
        });
    }
});

describe('Round-trip — generated columns parse on every dialect', () => {
    const COLS = [
        { name: 'id', type: 'INTEGER', autoIncrement: true, primaryKey: true },
        { name: 'price', type: 'DECIMAL(10,2)', notNull: true },
        { name: 'qty', type: 'INT', notNull: true },
        { name: 'total', type: 'DECIMAL(10,2)', generated: 'price * qty' },
    ];
    for (const d of DIALECTS) {
        it(`${d.label}: emits parseable generated column SQL`, () => {
            const sql = generateSql({ tableName: 'line_items', columns: COLS, dialect: d });
            const { errors } = parseAST(sql);
            expect(errors.filter((e) => e.severity === 'error')).toEqual([]);
        });
    }
});

describe('Round-trip — FK with actions parses on every dialect', () => {
    const SETUP = (d) => generateSql({
        tableName: 'users',
        dialect: d,
        columns: [{ name: 'id', type: 'INT', autoIncrement: true, primaryKey: true }],
    });
    const POSTS = (d) =>
        generateSql({
            tableName: 'posts',
            dialect: d,
            columns: [
                { name: 'id', type: 'INT', autoIncrement: true, primaryKey: true },
                {
                    name: 'user_id',
                    type: 'INT',
                    notNull: true,
                    references: { table: 'users', column: 'id', onDelete: 'CASCADE', onUpdate: 'CASCADE' },
                },
            ],
        });

    for (const d of DIALECTS) {
        it(`${d.label}: posts.user_id → users.id with ON DELETE CASCADE survives`, () => {
            const sql = `${SETUP(d)}\n${POSTS(d)}`;
            const schema = sqlToErdSchema(sql);
            expect(schema.relations).toHaveLength(1);
            expect(schema.relations[0].from.column.toLowerCase()).toBe('user_id');
            expect(schema.relations[0].to.column.toLowerCase()).toBe('id');
        });
    }
});

describe('Round-trip — IF NOT EXISTS parses on every dialect', () => {
    for (const d of DIALECTS) {
        it(`${d.label}: CREATE TABLE IF NOT EXISTS users(...) parses`, () => {
            const sql = generateSql({
                tableName: 'users',
                ifNotExists: true,
                dialect: d,
                columns: [{ name: 'id', type: 'INT', primaryKey: true }],
            });
            // MSSQL wraps in IF OBJECT_ID(...) IS NULL — still parseable.
            const { errors } = parseAST(sql);
            expect(errors.filter((e) => e.severity === 'error')).toEqual([]);
        });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// SQLite-specific assertions (the new dialect)
// ════════════════════════════════════════════════════════════════════════════

describe('SQLite — emitted SQL precisely', () => {
    const D = DIALECT_BY_ID.sqlite;

    it('emits "INTEGER PRIMARY KEY AUTOINCREMENT" in that exact order', () => {
        const sql = generateSql({
            tableName: 'users',
            dialect: D,
            columns: [{ name: 'id', type: 'BIGINT', autoIncrement: true, primaryKey: true }],
        });
        // type forced to INTEGER; suffix follows PRIMARY KEY
        expect(sql).toMatch(/id\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/);
        // and AUTOINCREMENT must NOT precede PRIMARY KEY
        expect(sql).not.toMatch(/AUTOINCREMENT\s+PRIMARY\s+KEY/);
    });

    it('emits standard CREATE TABLE IF NOT EXISTS', () => {
        const sql = generateSql({
            tableName: 'users',
            ifNotExists: true,
            dialect: D,
            columns: [{ name: 'id', type: 'INT', primaryKey: true }],
        });
        expect(sql.startsWith('CREATE TABLE IF NOT EXISTS')).toBe(true);
    });

    it('emits FK with ON DELETE CASCADE (SQLite supports FK actions)', () => {
        const sql = generateSql({
            tableName: 'posts',
            dialect: D,
            columns: [
                { name: 'id', type: 'INTEGER', autoIncrement: true, primaryKey: true },
                {
                    name: 'user_id',
                    type: 'INTEGER',
                    notNull: true,
                    references: { table: 'users', column: 'id', onDelete: 'CASCADE' },
                },
            ],
        });
        expect(sql).toMatch(/REFERENCES\s+users\("?id"?\)\s+ON\s+DELETE\s+CASCADE/);
    });

    it('emits GENERATED ALWAYS AS (expr) STORED for computed columns', () => {
        const sql = generateSql({
            tableName: 'line_items',
            dialect: D,
            columns: [
                { name: 'price', type: 'REAL' },
                { name: 'qty', type: 'INTEGER' },
                { name: 'total', type: 'REAL', generated: 'price * qty' },
            ],
        });
        expect(sql).toMatch(/total\s+REAL\s+GENERATED\s+ALWAYS\s+AS\s*\(price \* qty\)\s+STORED/);
    });

    it('composite PK + auto-inc: AUTOINCREMENT is correctly OMITTED (not legal in SQLite)', () => {
        // SQLite forbids AUTOINCREMENT on composite-PK columns. The component
        // already collapses composite PKs into a table-level constraint, so
        // the inline `PRIMARY KEY` (and therefore the after-pk suffix) are
        // suppressed automatically. Verify that fallout here.
        const sql = generateSql({
            tableName: 'pair',
            dialect: D,
            columns: [
                { name: 'a', type: 'INT', autoIncrement: true, primaryKey: true },
                { name: 'b', type: 'INT', primaryKey: true },
            ],
        });
        expect(sql).not.toMatch(/AUTOINCREMENT/);
        expect(sql).toMatch(/PRIMARY KEY \(a, b\)/);
    });

    it('SQLite users + posts: end-to-end ERD has 1 relation with auto-inc IDs', () => {
        const users = generateSql({
            tableName: 'users',
            dialect: D,
            columns: [
                { name: 'id', type: 'INTEGER', autoIncrement: true, primaryKey: true },
                { name: 'email', type: 'TEXT', notNull: true, unique: true },
            ],
        });
        const posts = generateSql({
            tableName: 'posts',
            dialect: D,
            columns: [
                { name: 'id', type: 'INTEGER', autoIncrement: true, primaryKey: true },
                {
                    name: 'user_id',
                    type: 'INTEGER',
                    notNull: true,
                    references: { table: 'users', column: 'id', onDelete: 'CASCADE' },
                },
                { name: 'title', type: 'TEXT', notNull: true },
            ],
        });
        const schema = sqlToErdSchema(`${users}\n${posts}`);
        const fatal = (schema._parseErrors || []).filter((e) => e.severity === 'error');
        expect(fatal).toEqual([]);
        expect(schema.tables).toHaveLength(2);
        expect(schema.relations).toHaveLength(1);
        const usersTbl = schema.tables.find((t) => t.name === 'users');
        const postsTbl = schema.tables.find((t) => t.name === 'posts');
        expect(usersTbl.columns.find((c) => c.name === 'id').autoIncrement).toBe(true);
        expect(postsTbl.columns.find((c) => c.name === 'id').autoIncrement).toBe(true);
    });
});

describe('Add Table validation — complex invalid combinations', () => {
    it('rejects partial foreign-key configuration before insert', () => {
        const errors = getAddTableValidationErrors({
            dialect: DIALECT_BY_ID.sqlite,
            columns: [
                { name: 'id', type: 'INTEGER', primaryKey: true },
                {
                    name: 'user_id',
                    type: 'INTEGER',
                    references: { table: 'users', column: '', onDelete: 'CASCADE', onUpdate: '' },
                },
            ],
        });

        expect(errors).toContain('user_id: choose both reference table and reference column');
    });

    it('rejects auto-increment without primary key if stale state reaches validation', () => {
        const errors = getAddTableValidationErrors({
            dialect: DIALECT_BY_ID.mysql,
            columns: [{ name: 'id', type: 'INT', autoIncrement: true, primaryKey: false }],
        });

        expect(errors).toContain('id: auto-increment requires PRIMARY KEY');
    });

    it('rejects SQLite AUTOINCREMENT on composite primary keys', () => {
        const errors = getAddTableValidationErrors({
            dialect: DIALECT_BY_ID.sqlite,
            columns: [
                { name: 'tenant_id', type: 'INTEGER', primaryKey: true },
                { name: 'invoice_id', type: 'INTEGER', primaryKey: true, autoIncrement: true },
            ],
        });

        expect(errors).toContain('SQLite AUTOINCREMENT requires a single INTEGER PRIMARY KEY column');
    });

    it('rejects stale generated-column conflicts', () => {
        const errors = getAddTableValidationErrors({
            dialect: DIALECT_BY_ID.sqlite,
            columns: [
                {
                    name: 'total',
                    type: 'REAL',
                    generated: 'price * quantity',
                    primaryKey: true,
                    defaultValue: '0',
                    references: { table: 'orders', column: 'id' },
                },
            ],
        });

        expect(errors).toContain('total: generated columns cannot also use PK, UNIQUE, DEFAULT, CHECK, FK, or auto-increment');
    });
});

describe('Add Table generation — complex production-like SQLite schema', () => {
    it('emits parseable SQLite with quoted names, defaults, checks, FK actions, generated columns, and auto-increment', () => {
        const D = DIALECT_BY_ID.sqlite;
        const users = generateSql({
            tableName: 'main.users',
            ifNotExists: true,
            dialect: D,
            columns: [
                { name: 'id', type: 'BIGINT', autoIncrement: true, primaryKey: true },
                { name: 'email', type: 'TEXT', notNull: true, unique: true, check: "length(email) > 3" },
                { name: 'created_at', type: 'TEXT', notNull: true, defaultValue: 'CURRENT_TIMESTAMP' },
            ],
        });
        const invoiceItems = generateSql({
            tableName: 'invoice items',
            ifNotExists: true,
            dialect: D,
            columns: [
                { name: 'id', type: 'BIGINT', autoIncrement: true, primaryKey: true },
                {
                    name: 'user_id',
                    type: 'INTEGER',
                    notNull: true,
                    references: { table: 'main.users', column: 'id', onDelete: 'CASCADE', onUpdate: 'RESTRICT' },
                },
                { name: 'sku', type: 'TEXT', notNull: true, unique: true, defaultValue: 'unknown' },
                { name: 'quantity', type: 'INTEGER', notNull: true, defaultValue: '1', check: 'quantity > 0' },
                { name: 'unit_price', type: 'REAL', notNull: true, defaultValue: '0', check: 'unit_price >= 0' },
                { name: 'line_total', type: 'REAL', generated: 'quantity * unit_price', notNull: true },
            ],
        });
        const sql = `${users}\n${invoiceItems}`;

        expect(users).toMatch(/CREATE TABLE IF NOT EXISTS main\.users/);
        expect(invoiceItems).toMatch(/CREATE TABLE IF NOT EXISTS "invoice items"/);
        expect(invoiceItems).toMatch(/id\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/);
        expect(users).toContain('DEFAULT CURRENT_TIMESTAMP');
        expect(invoiceItems).toContain("DEFAULT 'unknown'");
        expect(invoiceItems).toContain('ON DELETE CASCADE ON UPDATE RESTRICT');
        expect(invoiceItems).toContain('line_total REAL GENERATED ALWAYS AS (quantity * unit_price) STORED NOT NULL');

        const { errors } = parseAST(sql);
        expect(errors.filter((e) => e.severity === 'error')).toEqual([]);

        const schema = sqlToErdSchema(sql);
        const fatal = (schema._parseErrors || []).filter((e) => e.severity === 'error');
        expect(fatal).toEqual([]);
        expect(schema.tables.map((table) => table.name)).toEqual(['users', 'invoice items']);
        expect(schema.relations).toHaveLength(1);
        expect(schema.relations[0]).toMatchObject({
            from: { table: 'invoice items', column: 'user_id' },
            to: { table: 'users', column: 'id' },
        });
    });
});
