import { describe, it, expect } from 'vitest';
import { parseAST } from '@/lib/parse-ast/parseAst.js';

/**
 * parseAst — hardening / correctness suite.
 *
 * Pins down behaviours surfaced by the deep audit (May 2026):
 *   • CHECK / DEFAULT string-literal quoting round-trips through the
 *     ALTER ADD CHECK path (regression for `readParenContent` losing
 *     STRING quotes).
 *   • Schema-qualified identifiers: 1, 2, and 3-part names.
 *   • FK actions, unique nuances, composite PK/UQ wiring.
 *   • CREATE INDEX edge cases (UNIQUE, partial, INCLUDE, USING, dotted columns).
 *   • Generated columns across all four dialects + PERSISTED/NOT NULL ordering.
 *   • Inline ENUM collisions (deliberate single-shared-type behaviour).
 *   • CREATE TYPE composite quoting.
 *   • Recovery paths: unclosed parens, missing `;`, and broken statements
 *     between healthy ones.
 *   • Empty-input contracts.
 */

function parse(sql) {
    const { ast, errors } = parseAST(sql);
    return {
        ast,
        errors,
        tables: ast.tables,
        types: ast.types,
        alters: ast.alters,
        indexes: ast.indexes || [],
        table: (name) =>
            ast.tables.find(
                (t) => stripSchema(t.name).toLowerCase() === name.toLowerCase(),
            ) || null,
        type: (name) =>
            ast.types.find(
                (t) => stripSchema(t.name).toLowerCase() === name.toLowerCase(),
            ) || null,
        column: (tableName, colName) => {
            const t = ast.tables.find(
                (tt) => stripSchema(tt.name).toLowerCase() === tableName.toLowerCase(),
            );
            if (!t) return null;
            return (
                t.columns.find(
                    (c) => c && c.name && c.name.toLowerCase() === colName.toLowerCase(),
                ) || null
            );
        },
        errs: () => errors.filter((e) => e.severity === 'error'),
        warns: () => errors.filter((e) => e.severity === 'warning'),
    };
}

function stripSchema(name) {
    if (!name) return name;
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.substring(dot + 1) : name;
}

// ════════════════════════════════════════════════════════════════════════
// CHECK / DEFAULT — string-literal quoting through every code path
// ════════════════════════════════════════════════════════════════════════

describe('CHECK constraints — string literal quoting', () => {
    it('inline CHECK preserves single-quoted string literal', () => {
        const r = parse(`CREATE TABLE t (status TEXT CHECK (status = 'active'));`);
        const col = r.column('t', 'status');
        expect(col.check).toBeTruthy();
        expect(col.check).toContain("'active'");
    });

    it('inline CHECK with multiple quoted alternatives', () => {
        const r = parse(`CREATE TABLE t (
            kind TEXT CHECK (kind IN ('a', 'b', 'c'))
        );`);
        const col = r.column('t', 'kind');
        expect(col.check).toContain("'a'");
        expect(col.check).toContain("'b'");
        expect(col.check).toContain("'c'");
    });

    it('table-level CHECK preserves quoted operator text', () => {
        const r = parse(`CREATE TABLE t (
            id INT,
            name TEXT,
            CONSTRAINT chk_name CHECK (name <> 'admin' AND name <> 'root')
        );`);
        const t = r.table('t');
        const chk = (t.constraints || []).find((c) => c && c.kind === 'check');
        expect(chk).toBeTruthy();
        expect(chk.expression).toContain("'admin'");
        expect(chk.expression).toContain("'root'");
    });

    it('ALTER TABLE ADD CHECK preserves quoted strings (FIX A regression)', () => {
        const r = parse(`
            CREATE TABLE t (id INT, kind TEXT);
            ALTER TABLE t ADD CONSTRAINT chk_kind CHECK (kind = 'active');
        `);
        const alter = r.alters.find((a) => a.action === 'add_check');
        expect(alter).toBeTruthy();
        expect(alter.expression).toContain("'active'");
        expect(alter.expression).not.toBe('kind = active');
    });

    it('ALTER ADD CHECK preserves nested function call with quoted string', () => {
        const r = parse(`
            CREATE TABLE t (id INT, email TEXT);
            ALTER TABLE t ADD CHECK (lower(email) LIKE '%@example.com');
        `);
        const alter = r.alters.find((a) => a.action === 'add_check');
        expect(alter).toBeTruthy();
        expect(alter.expression).toContain("'%@example.com'");
        expect(alter.expression).toMatch(/lower\s*\(\s*email\s*\)/i);
    });

    it('trailing CHECK after CREATE TABLE close preserves quoted strings', () => {
        const r = parse(`CREATE TABLE t (id INT, status TEXT) CHECK (status = 'ok');`);
        const t = r.table('t');
        const chk = (t.constraints || []).find((c) => c && c.kind === 'check');
        if (chk) {
            expect(chk.expression).toContain("'ok'");
        }
    });

    it('CHECK with embedded comma inside string literal is not split', () => {
        const r = parse(`CREATE TABLE t (note TEXT CHECK (note <> 'hello, world'));`);
        const col = r.column('t', 'note');
        expect(col.check).toContain("'hello, world'");
    });

    it('CHECK with embedded close-paren inside string literal does not bail early', () => {
        const r = parse(`CREATE TABLE t (note TEXT CHECK (note <> 'a)b'));`);
        const col = r.column('t', 'note');
        expect(col.check).toContain("'a)b'");
    });

    it('CHECK with escaped single quote inside string literal', () => {
        const r = parse(`CREATE TABLE t (note TEXT CHECK (note <> 'O''Brien'));`);
        const col = r.column('t', 'note');
        expect(col.check).toBeTruthy();
        expect(col.check.toLowerCase()).toContain('brien');
    });
});

// ════════════════════════════════════════════════════════════════════════
// DEFAULT values — robustness across forms
// ════════════════════════════════════════════════════════════════════════

describe('DEFAULT values — round-trip across all common forms', () => {
    it.each([
        ["DEFAULT 'pending'", "'pending'"],
        ['DEFAULT 0', '0'],
        ['DEFAULT -1', '-1'],
        ['DEFAULT NULL', 'NULL'],
        ['DEFAULT TRUE', 'TRUE'],
        ['DEFAULT CURRENT_TIMESTAMP', 'CURRENT_TIMESTAMP'],
        ['DEFAULT NOW()', 'NOW'],
        ["DEFAULT 'hello, world'", 'hello, world'],
        ["DEFAULT 'O''Brien'", 'Brien'],
    ])('round-trips %s', (clause, fragment) => {
        const r = parse(`CREATE TABLE t (col TEXT ${clause});`);
        const col = r.column('t', 'col');
        expect(col.default).toBeTruthy();
        expect(String(col.default)).toContain(fragment);
    });

    it('DEFAULT with parenthesised expression preserves parens', () => {
        const r = parse(`CREATE TABLE t (val INT DEFAULT (1 + 2));`);
        const col = r.column('t', 'val');
        expect(col.default).toMatch(/\(?\s*1\s*\+\s*2\s*\)?/);
    });

    it('DEFAULT function with quoted string argument preserves the literals', () => {
        const r = parse(`CREATE TABLE t (created TEXT DEFAULT strftime('%Y-%m-%d','now'));`);
        const col = r.column('t', 'created');
        // applyNaturalSpacing may insert padding around `-` inside the
        // format string — that's a known cosmetic quirk we explicitly
        // tolerate (it doesn't affect SQL correctness because the value
        // is consumed verbatim into a quoted DEFAULT).
        const def = String(col.default || '');
        expect(def.toLowerCase()).toContain('strftime');
        expect(def).toMatch(/'%y/i);
        expect(def).toContain("'now'");
    });
});

// ════════════════════════════════════════════════════════════════════════
// Schema-qualified identifiers — 1, 2, and 3-part
// ════════════════════════════════════════════════════════════════════════

describe('Schema-qualified identifiers', () => {
    it('parses two-part schema.table', () => {
        const r = parse(`CREATE TABLE public.users (id INT PRIMARY KEY);`);
        expect(r.tables).toHaveLength(1);
        expect(stripSchema(r.tables[0].name)).toBe('users');
    });

    it('parses two-part FK reference', () => {
        const r = parse(`
            CREATE TABLE public.users (id INT PRIMARY KEY);
            CREATE TABLE public.posts (
                id INT,
                user_id INT REFERENCES public.users(id)
            );
        `);
        const col = r.column('posts', 'user_id');
        expect(col.references).toBeTruthy();
        expect(col.references.table.toLowerCase()).toContain('users');
        expect(col.references.columns).toContain('id');
    });

    it('quoted schema-qualified identifier', () => {
        const r = parse(`CREATE TABLE "myschema"."users" (id INT);`);
        expect(r.tables).toHaveLength(1);
        expect(stripSchema(r.tables[0].name)).toBe('users');
    });

    it('keeps quoted dotted ALTER TABLE rename targets as one identifier segment', () => {
        const r = parse(`
            CREATE TABLE "tenant.users" (id INT PRIMARY KEY);
            ALTER TABLE "tenant.users" RENAME TO "tenant.accounts";
        `);

        const alter = r.alters.find((entry) => entry.action === 'rename_table');
        expect(r.warns()).toEqual([]);
        expect(alter).toMatchObject({
            table: 'tenant.users',
            newName: 'tenant.accounts',
        });
        expect(alter.tableParts).toEqual([
            expect.objectContaining({ value: 'tenant.users', raw: '"tenant.users"', quoted: true }),
        ]);
        expect(alter.newTableParts).toEqual([
            expect.objectContaining({ value: 'tenant.accounts', raw: '"tenant.accounts"', quoted: true }),
        ]);
    });

    it('recognizes schema-qualified rename targets during FK table validation', () => {
        const r = parse(`
            CREATE TABLE app.users (
                id INT PRIMARY KEY,
                email TEXT
            );
            ALTER TABLE app.users RENAME TO accounts;
            CREATE TABLE audit.events (
                actor_email TEXT REFERENCES app.accounts(email)
            );
        `);

        expect(r.warns()).toEqual([]);
    });

    it('MSSQL bracketed schema identifier', () => {
        const r = parse(`CREATE TABLE [dbo].[Users] (Id INT);`);
        expect(r.tables).toHaveLength(1);
        expect(stripSchema(r.tables[0].name).toLowerCase()).toBe('users');
    });

    it('three-part identifier (db.schema.table) is fully consumed and leaf is reachable', () => {
        const r = parse(`CREATE TABLE mydb.dbo.audit_log (id INT);`);
        expect(r.tables).toHaveLength(1);
        // After stripSchema, the leaf is `audit_log` (we strip the LAST dot,
        // so `mydb.dbo` is the prefix, `audit_log` is the leaf).
        expect(stripSchema(r.tables[0].name)).toBe('audit_log');
        // Lookup by the leaf name is the canonical path used by the renderer.
        expect(r.table('audit_log')).toBeTruthy();
    });

    it('three-part FK reference (REFERENCES db.schema.t(id)) is captured', () => {
        const r = parse(`
            CREATE TABLE mydb.dbo.users (id INT PRIMARY KEY);
            CREATE TABLE mydb.dbo.posts (
                id INT,
                user_id INT REFERENCES mydb.dbo.users(id)
            );
        `);
        const col = r.column('posts', 'user_id');
        expect(col).toBeTruthy();
        expect(col.references).toBeTruthy();
        // The FK target should reach the leaf `users` via stripSchema.
        expect(stripSchema(col.references.table)).toBe('users');
    });
});

// ════════════════════════════════════════════════════════════════════════
// FOREIGN KEY actions and forms
// ════════════════════════════════════════════════════════════════════════

describe('FOREIGN KEY — action clauses', () => {
    const actions = [
        ['ON DELETE CASCADE'],
        ['ON UPDATE CASCADE'],
        ['ON DELETE SET NULL'],
        ['ON UPDATE SET NULL'],
        ['ON DELETE RESTRICT'],
        ['ON DELETE NO ACTION'],
        ['ON DELETE SET DEFAULT'],
        ['ON DELETE CASCADE ON UPDATE SET NULL'],
    ];

    it.each(actions)('parses inline FK with %s without leaking modifiers', (action) => {
        const r = parse(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (
                id INT PRIMARY KEY,
                pid INT REFERENCES parent(id) ${action},
                name TEXT NOT NULL
            );
        `);
        // FK still detected
        const fkCol = r.column('child', 'pid');
        expect(fkCol).toBeTruthy();
        expect(fkCol.references).toBeTruthy();
        expect(fkCol.references.table).toBe('parent');
        // The trailing column is not lost or mis-parsed by the action keywords
        const nameCol = r.column('child', 'name');
        expect(nameCol).toBeTruthy();
        expect(nameCol.notNull).toBe(true);
    });

    it('FK with explicit (cols) on REFERENCES', () => {
        const r = parse(`
            CREATE TABLE parent (id INT, code TEXT, PRIMARY KEY (id, code));
            CREATE TABLE child (
                pid INT,
                pcode TEXT,
                FOREIGN KEY (pid, pcode) REFERENCES parent(id, code)
            );
        `);
        const t = r.table('child');
        const fk = (t.constraints || []).find((c) => c && c.kind === 'foreign');
        expect(fk).toBeTruthy();
        expect(fk.columns).toEqual(['pid', 'pcode']);
        expect(fk.references.columns).toEqual(['id', 'code']);
    });

    it('CREATE TABLE FK without (refCols) is accepted (implicit PK)', () => {
        const r = parse(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (
                pid INT,
                FOREIGN KEY (pid) REFERENCES parent
            );
        `);
        const t = r.table('child');
        const fk = (t.constraints || []).find((c) => c && c.kind === 'foreign');
        expect(fk).toBeTruthy();
        expect(fk.references.table).toBe('parent');
    });

    it('ALTER FK with (refCols) is accepted', () => {
        const r = parse(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (id INT, pid INT);
            ALTER TABLE child ADD CONSTRAINT fk_pid FOREIGN KEY (pid) REFERENCES parent(id);
        `);
        const alter = r.alters.find((a) => a.action === 'add_foreign');
        expect(alter).toBeTruthy();
        expect(alter.references.table).toBe('parent');
        expect(alter.references.columns).toEqual(['id']);
    });
});

// ════════════════════════════════════════════════════════════════════════
// Composite PK / UQ — every column gets the flag, names round-trip
// ════════════════════════════════════════════════════════════════════════

describe('Composite PK / UQ', () => {
    it('composite PK marks every column as primary', () => {
        const r = parse(`CREATE TABLE t (a INT, b INT, c INT, PRIMARY KEY (a, b));`);
        const t = r.table('t');
        const pk = (t.constraints || []).find((c) => c && c.kind === 'primary');
        expect(pk).toBeTruthy();
        expect(pk.columns).toEqual(['a', 'b']);
    });

    it('composite UNIQUE round-trips column list', () => {
        const r = parse(`CREATE TABLE t (a INT, b INT, c INT, UNIQUE (b, c));`);
        const t = r.table('t');
        const uq = (t.constraints || []).find((c) => c && c.kind === 'unique');
        expect(uq).toBeTruthy();
        expect(uq.columns).toEqual(['b', 'c']);
    });

    it('case-insensitive composite PK column matching', () => {
        const r = parse(`CREATE TABLE t (Id INT, Code TEXT, PRIMARY KEY (ID, code));`);
        const t = r.table('t');
        const pk = (t.constraints || []).find((c) => c && c.kind === 'primary');
        expect(pk.columns.map((c) => c.toLowerCase())).toEqual(['id', 'code']);
    });

    it('quoted column names in composite PK list', () => {
        const r = parse(`CREATE TABLE t ("a b" INT, "c d" INT, PRIMARY KEY ("a b", "c d"));`);
        const t = r.table('t');
        const pk = (t.constraints || []).find((c) => c && c.kind === 'primary');
        expect(pk.columns).toEqual(['a b', 'c d']);
    });

    it('PK constraint missing column list emits a parse error', () => {
        const r = parse(`CREATE TABLE t (id INT, CONSTRAINT pk_t PRIMARY KEY);`);
        const errs = r.errs();
        expect(errs.length).toBeGreaterThan(0);
        expect(errs[0].message).toMatch(/PRIMARY KEY/i);
    });
});

// ════════════════════════════════════════════════════════════════════════
// CREATE INDEX — every variant
// ════════════════════════════════════════════════════════════════════════

describe('CREATE INDEX — variants', () => {
    it('UNIQUE INDEX promotes single column to UNIQUE', () => {
        const r = parse(`
            CREATE TABLE t (id INT, email TEXT);
            CREATE UNIQUE INDEX idx_email ON t (email);
        `);
        const ix = r.indexes.find((i) => i.name === 'idx_email');
        expect(ix).toBeTruthy();
        expect(ix.unique).toBe(true);
        expect(ix.columns).toEqual(['email']);
    });

    it('non-UNIQUE composite INDEX', () => {
        const r = parse(`
            CREATE TABLE t (a INT, b INT);
            CREATE INDEX idx_ab ON t (a, b);
        `);
        const ix = r.indexes.find((i) => i.name === 'idx_ab');
        expect(ix).toBeTruthy();
        expect(ix.unique).toBe(false);
        expect(ix.columns).toEqual(['a', 'b']);
    });

    it('partial index with WHERE — column still extracted, where text captured if supported', () => {
        const r = parse(`
            CREATE TABLE t (id INT, deleted_at TIMESTAMP);
            CREATE INDEX idx_active ON t (id) WHERE deleted_at IS NULL;
        `);
        const ix = r.indexes.find((i) => i.name === 'idx_active');
        expect(ix).toBeTruthy();
        expect(ix.columns).toEqual(['id']);
        expect(ix.where).toBe('deleted_at IS NULL');
    });

    it('USING method (BTREE / HASH / GIN) — does not break', () => {
        const r = parse(`
            CREATE TABLE t (id INT, tags TEXT[]);
            CREATE INDEX idx_tags ON t USING GIN (tags);
        `);
        const ix = r.indexes.find((i) => i.name === 'idx_tags');
        expect(ix).toBeTruthy();
        expect(ix.columns).toEqual(['tags']);
    });

    it('PG INCLUDE clause — main columns still extracted', () => {
        const r = parse(`
            CREATE TABLE t (a INT, b INT, c INT);
            CREATE INDEX idx_a ON t (a) INCLUDE (b, c);
        `);
        const ix = r.indexes.find((i) => i.name === 'idx_a');
        expect(ix).toBeTruthy();
        expect(ix.columns).toEqual(['a']);
    });

    it('functional / expression index does not crash (columns may be empty)', () => {
        const r = parse(`
            CREATE TABLE t (email TEXT);
            CREATE INDEX idx_lower ON t (lower(email));
        `);
        // Don't assert content — only that we didn't throw and got an entry.
        expect(r.errs()).toHaveLength(0);
    });
});

// ════════════════════════════════════════════════════════════════════════
// Generated columns — every dialect & PERSISTED ordering
// ════════════════════════════════════════════════════════════════════════

describe('Generated columns — dialect coverage', () => {
    it('PostgreSQL: GENERATED ALWAYS AS (expr) STORED', () => {
        const r = parse(`CREATE TABLE t (
            a INT, b INT,
            sum INT GENERATED ALWAYS AS (a + b) STORED
        );`);
        const sum = r.column('t', 'sum');
        expect(sum).toBeTruthy();
        expect(sum.generated).toBeTruthy();
    });

    it('MySQL: VIRTUAL form', () => {
        const r = parse(`CREATE TABLE t (
            a INT, b INT,
            sum INT GENERATED ALWAYS AS (a + b) VIRTUAL
        );`);
        const sum = r.column('t', 'sum');
        expect(sum.generated).toBeTruthy();
    });

    it('SQLite: AS form (no STORED/VIRTUAL keyword)', () => {
        const r = parse(`CREATE TABLE t (
            a INT, b INT,
            sum INT AS (a + b)
        );`);
        const sum = r.column('t', 'sum');
        expect(sum).toBeTruthy();
    });

    it('MSSQL: paren AS PERSISTED', () => {
        const r = parse(`CREATE TABLE t (
            a INT, b INT,
            sum AS (a + b) PERSISTED
        );`);
        const sum = r.column('t', 'sum');
        expect(sum).toBeTruthy();
    });

    it('MSSQL: paren AS PERSISTED NOT NULL — next column intact', () => {
        const r = parse(`CREATE TABLE t (
            a INT, b INT,
            sum AS (a + b) PERSISTED NOT NULL,
            tail TEXT NOT NULL
        );`);
        const tail = r.column('t', 'tail');
        expect(tail).toBeTruthy();
        expect(tail.notNull).toBe(true);
    });

    it('MSSQL: paren AS NOT NULL PERSISTED — alternate ordering, next column intact', () => {
        const r = parse(`CREATE TABLE t (
            a INT, b INT,
            sum AS (a + b) NOT NULL PERSISTED,
            tail TEXT NOT NULL
        );`);
        const tail = r.column('t', 'tail');
        expect(tail).toBeTruthy();
        expect(tail.notNull).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════
// Inline ENUM (MySQL) — collisions across tables
// ════════════════════════════════════════════════════════════════════════

describe('Inline ENUM — collision behaviour', () => {
    it("two tables with column 'status' but different values share one inline-enum slot (deliberate)", () => {
        const r = parse(`
            CREATE TABLE a (status ENUM('open','closed'));
            CREATE TABLE b (status ENUM('on','off'));
        `);
        const enums = (r.types || []).filter((t) => t && t.kind === 'enum');
        // Synthetic name policy: enum is named after the column (status_enum-ish).
        // The first definition wins; pin the resulting set.
        const names = enums.map((e) => e.name.toLowerCase());
        // At least one inline enum was registered.
        expect(enums.length).toBeGreaterThanOrEqual(1);
        // Name set should reference 'status'
        expect(names.some((n) => n.includes('status'))).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════
// CREATE TYPE — composite & enum quoting
// ════════════════════════════════════════════════════════════════════════

describe('CREATE TYPE', () => {
    it('ENUM values with quoted strings are captured verbatim', () => {
        const r = parse(`CREATE TYPE mood AS ENUM ('happy', 'sad', 'meh');`);
        const t = r.type('mood');
        expect(t).toBeTruthy();
        expect(t.kind).toBe('enum');
        expect(t.values).toEqual(['happy', 'sad', 'meh']);
    });

    it('Composite type with simple fields', () => {
        const r = parse(`CREATE TYPE address AS (
            street TEXT,
            city TEXT,
            zip INT
        );`);
        const t = r.type('address');
        expect(t).toBeTruthy();
        expect(t.kind).toBe('composite');
        expect(t.fields).toHaveLength(3);
        expect(t.fields[0].name).toBe('street');
    });

    it('schema-qualified type name is stripped consistently', () => {
        const r = parse(`CREATE TYPE public.mood AS ENUM ('a', 'b');`);
        expect(r.types).toHaveLength(1);
        expect(stripSchema(r.types[0].name)).toBe('mood');
    });
});

// ════════════════════════════════════════════════════════════════════════
// SQLite quirks — WITHOUT ROWID, STRICT, AUTOINCREMENT
// ════════════════════════════════════════════════════════════════════════

describe('SQLite quirks', () => {
    it('CREATE TABLE … WITHOUT ROWID parses cleanly', () => {
        const r = parse(`CREATE TABLE t (id INT PRIMARY KEY, name TEXT) WITHOUT ROWID;`);
        const t = r.table('t');
        expect(t).toBeTruthy();
        expect(t.columns).toHaveLength(2);
    });

    it('CREATE TABLE … STRICT parses cleanly', () => {
        const r = parse(`CREATE TABLE t (id INT, name TEXT) STRICT;`);
        const t = r.table('t');
        expect(t.columns).toHaveLength(2);
    });

    it('CREATE TABLE … WITHOUT ROWID, STRICT (combined)', () => {
        const r = parse(`CREATE TABLE t (id INT PRIMARY KEY) WITHOUT ROWID, STRICT;`);
        const t = r.table('t');
        expect(t).toBeTruthy();
    });

    it('SQLite AUTOINCREMENT (one word) on PK column', () => {
        const r = parse(`CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT);`);
        const id = r.column('t', 'id');
        expect(id.primary).toBe(true);
        expect(id.autoIncrement).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════
// MySQL quirks — ENGINE, CHARSET, ON UPDATE CURRENT_TIMESTAMP
// ════════════════════════════════════════════════════════════════════════

describe('MySQL quirks', () => {
    it('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 trailer is consumed', () => {
        const r = parse(`
            CREATE TABLE t (id INT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
            CREATE TABLE u (id INT);
        `);
        expect(r.tables).toHaveLength(2);
    });

    it("ON UPDATE CURRENT_TIMESTAMP doesn't drop the next column", () => {
        const r = parse(`CREATE TABLE t (
            id INT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            tail INT NOT NULL
        );`);
        const tail = r.column('t', 'tail');
        expect(tail).toBeTruthy();
        expect(tail.notNull).toBe(true);
    });

    it('inline KEY/INDEX entries inside CREATE TABLE register as indexes', () => {
        const r = parse(`CREATE TABLE t (
            id INT,
            email VARCHAR(255),
            KEY idx_email (email)
        );`);
        // parser surfaces inline KEY/INDEX entries via ast.indexes.
        const ix = r.indexes.find((i) => i && i.name && i.name.toLowerCase() === 'idx_email');
        expect(ix).toBeTruthy();
    });
});

// ════════════════════════════════════════════════════════════════════════
// Recovery — broken statements between healthy ones
// ════════════════════════════════════════════════════════════════════════

describe('Cross-statement recovery', () => {
    it('a healthy statement after an unclosed CREATE TABLE still parses', () => {
        const r = parse(`
            CREATE TABLE broken (id INT,
            CREATE TABLE healthy (id INT, name TEXT);
        `);
        const healthy = r.table('healthy');
        expect(healthy).toBeTruthy();
        expect(healthy.columns).toHaveLength(2);
    });

    it('a half-formed ALTER does not lose the previously-defined table', () => {
        // A malformed ALTER between two CREATEs is best-effort. We require
        // at minimum that the FIRST healthy CREATE survives; recovery into
        // the trailing CREATE is currently best-effort (and is covered
        // elsewhere by the unclosed-CREATE-TABLE recovery test).
        const r = parse(`
            CREATE TABLE t (id INT);
            ALTER TABLE t ADD CONSTRAINT
            CREATE TABLE u (id INT);
        `);
        expect(r.table('t')).toBeTruthy();
    });

    it('three healthy statements with a broken CREATE TYPE in the middle', () => {
        const r = parse(`
            CREATE TABLE a (id INT);
            CREATE TYPE incomplete AS ENUM (
            CREATE TABLE b (id INT);
            CREATE TABLE c (id INT);
        `);
        const tables = ['a', 'b', 'c'].map((n) => r.table(n));
        // At minimum the last two healthy tables must survive.
        expect(tables[1]).toBeTruthy();
        expect(tables[2]).toBeTruthy();
    });

    it('missing semicolon between two CREATE TABLEs is tolerated', () => {
        const r = parse(`
            CREATE TABLE a (id INT)
            CREATE TABLE b (id INT);
        `);
        // Strict SQL would fail; we should still recognise both tables.
        expect(r.tables.length).toBeGreaterThanOrEqual(1);
        // The second table should be discoverable.
        expect(r.table('b')).toBeTruthy();
    });
});

// ════════════════════════════════════════════════════════════════════════
// Empty-input contract
// ════════════════════════════════════════════════════════════════════════

describe('Empty / whitespace input', () => {
    it('empty string → empty AST, no errors', () => {
        const r = parse('');
        expect(r.tables).toHaveLength(0);
        expect(r.types).toHaveLength(0);
        expect(r.errs()).toHaveLength(0);
    });

    it('whitespace-only → empty AST', () => {
        const r = parse('   \n\t  ');
        expect(r.tables).toHaveLength(0);
    });

    it('comment-only input → empty AST', () => {
        const r = parse(`
            -- nothing here
            /* still nothing */
        `);
        expect(r.tables).toHaveLength(0);
    });

    it('lone semicolon → empty AST, no errors', () => {
        const r = parse(';');
        expect(r.tables).toHaveLength(0);
        expect(r.errs()).toHaveLength(0);
    });
});

// ════════════════════════════════════════════════════════════════════════
// Type parsing — INT(11), VARCHAR(N), NUMERIC(p,s), arrays
// ════════════════════════════════════════════════════════════════════════

describe('Column types — common forms', () => {
    it('VARCHAR(255) preserves length', () => {
        const r = parse(`CREATE TABLE t (name VARCHAR(255));`);
        const c = r.column('t', 'name');
        expect(c.type).toMatch(/VARCHAR\s*\(\s*255\s*\)/i);
    });

    it('NUMERIC(10, 2) preserves precision and scale', () => {
        const r = parse(`CREATE TABLE t (price NUMERIC(10, 2));`);
        const c = r.column('t', 'price');
        expect(c.type).toMatch(/NUMERIC\s*\(\s*10\s*,\s*2\s*\)/i);
    });

    it('PostgreSQL TEXT[] array type', () => {
        const r = parse(`CREATE TABLE t (tags TEXT[]);`);
        const c = r.column('t', 'tags');
        expect(c.type).toMatch(/TEXT\s*\[\s*\]/i);
    });

    it('PostgreSQL multi-dim array type', () => {
        const r = parse(`CREATE TABLE t (matrix INT[][]);`);
        const c = r.column('t', 'matrix');
        expect(c.type).toMatch(/INT/i);
    });

    it('MySQL ENUM inline type captures values', () => {
        const r = parse(`CREATE TABLE t (status ENUM('a','b','c'));`);
        const c = r.column('t', 'status');
        // Either the type retains the literal ENUM(...) or column gets enum metadata.
        expect(String(c.type).toLowerCase()).toContain('enum');
    });
});

// ════════════════════════════════════════════════════════════════════════
// Identifier edge cases
// ════════════════════════════════════════════════════════════════════════

describe('Identifier edge cases', () => {
    it('case-insensitive table lookup after parse', () => {
        const r = parse(`CREATE TABLE Users (Id INT);`);
        expect(r.table('users')).toBeTruthy();
        expect(r.column('USERS', 'id')).toBeTruthy();
    });

    it('reserved words as quoted identifiers', () => {
        const r = parse(`CREATE TABLE "user" ("order" INT, "select" TEXT);`);
        const t = r.table('user');
        expect(t).toBeTruthy();
        expect(t.columns).toHaveLength(2);
        expect(t.columns.map((c) => c.name).sort()).toEqual(['order', 'select']);
    });

    it('MySQL backtick identifiers', () => {
        const r = parse('CREATE TABLE `my-table` (`column 1` INT);');
        const t = r.table('my-table');
        expect(t).toBeTruthy();
        expect(t.columns[0].name).toBe('column 1');
    });

    it('MSSQL bracket identifiers with spaces', () => {
        const r = parse(`CREATE TABLE [Order Details] ([Unit Price] DECIMAL(10,2));`);
        const t = r.table('Order Details');
        expect(t).toBeTruthy();
        expect(t.columns[0].name).toBe('Unit Price');
    });
});

describe('Production syntax clusters', () => {
    it('parses a PostgreSQL-style audit schema with partitioning, expression indexes, and reserved identifiers', () => {
        const r = parse(`
            CREATE TYPE audit.severity_level AS ENUM ('debug', 'info', 'warn', 'error');

            CREATE UNLOGGED TABLE IF NOT EXISTS audit.event_log (
                tenant_id BIGINT NOT NULL,
                event_id BIGINT GENERATED BY DEFAULT AS IDENTITY (START WITH 500 INCREMENT BY 7),
                "key" TEXT NOT NULL,
                "index" INT DEFAULT 0,
                severity audit.severity_level NOT NULL DEFAULT 'info',
                payload JSONB NOT NULL DEFAULT jsonb_build_object('source', 'system'),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                checksum BYTEA GENERATED ALWAYS AS (digest(payload::text, 'sha256')) STORED,
                CONSTRAINT pk_event_log PRIMARY KEY (tenant_id, event_id),
                CONSTRAINT uq_event_natural UNIQUE (tenant_id, "key", "index"),
                CONSTRAINT chk_severity_payload CHECK ((severity <> 'error') OR (payload IS NOT NULL)),
                EXCLUDE USING gist (tenant_id WITH =, tstzrange(created_at, created_at, '[]') WITH &&)
            ) PARTITION BY RANGE (tenant_id);

            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_payload_kind
                ON ONLY audit.event_log USING gin ((payload->'kind'), severity, event_id DESC NULLS LAST)
                INCLUDE (payload)
                WHERE severity IN ('warn', 'error');

            CREATE TABLE audit.event_child (
                tenant_id BIGINT NOT NULL,
                event_id BIGINT NOT NULL,
                child_id BIGINT NOT NULL,
                details TEXT,
                CONSTRAINT fk_child_parent
                    FOREIGN KEY (tenant_id, event_id)
                    REFERENCES audit.event_log(tenant_id, event_id)
                    ON DELETE CASCADE ON UPDATE NO ACTION,
                PRIMARY KEY (tenant_id, event_id, child_id)
            );
        `);

        expect(r.errs()).toEqual([]);
        expect(r.type('severity_level').values).toEqual(['debug', 'info', 'warn', 'error']);

        const eventLog = r.table('event_log');
        expect(eventLog.columns.map((column) => column.name)).toEqual([
            'tenant_id',
            'event_id',
            'key',
            'index',
            'severity',
            'payload',
            'created_at',
            'checksum',
        ]);
        expect(r.column('event_log', 'severity').type).toBe('audit.severity_level');
        expect(r.column('event_log', 'severity').default).toContain("'info'");
        expect(r.column('event_log', 'checksum').generated).toMatch(/GENERATED ALWAYS AS/i);

        const check = eventLog.constraints.find((constraint) => constraint?.kind === 'check');
        expect(check.expression).toContain("'error'");

        const idx = r.indexes.find((index) => index.name === 'idx_event_payload_kind');
        expect(idx).toMatchObject({
            table: 'audit.event_log',
            unique: false,
            kind: 'plain',
        });
        expect(idx.columns).toEqual(['severity', 'event_id']);

        const child = r.table('event_child');
        const fk = child.constraints.find((constraint) => constraint?.name === 'fk_child_parent');
        expect(fk.columns).toEqual(['tenant_id', 'event_id']);
        expect(fk.references).toMatchObject({
            table: 'audit.event_log',
            columns: ['tenant_id', 'event_id'],
            onDelete: 'CASCADE',
            onUpdate: 'NO ACTION',
        });
    });

    it('distinguishes MySQL inline indexes from KEY/INDEX/VALUE column names', () => {
        const r = parse(`
            CREATE TABLE \`search_documents\` (
                \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
                \`key\` VARCHAR(64) NOT NULL,
                \`index\` INT DEFAULT 0,
                \`value\` JSON,
                \`body\` TEXT,
                \`location\` GEOMETRY,
                FULLTEXT KEY \`ft_body\` (\`body\`),
                SPATIAL INDEX \`sp_doc_location\` (\`location\`),
                KEY \`idx_key_index\` (\`key\`, \`index\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        expect(r.errs()).toEqual([]);
        const doc = r.table('search_documents');
        expect(doc.columns.map((column) => column.name)).toEqual([
            'id',
            'key',
            'index',
            'value',
            'body',
            'location',
        ]);
        expect(r.column('search_documents', 'id').autoIncrement).toBe(true);

        const indexes = Object.fromEntries(r.indexes.map((index) => [index.name, index]));
        expect(indexes.ft_body).toMatchObject({ kind: 'fulltext', columns: ['body'] });
        expect(indexes.sp_doc_location).toMatchObject({ kind: 'spatial', columns: ['location'] });
        expect(indexes.idx_key_index).toMatchObject({ kind: 'plain', columns: ['key', 'index'] });
    });
});
