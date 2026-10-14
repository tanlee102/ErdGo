import { describe, it, expect } from 'vitest';
import { createSqlExecutor } from '@/features/data-view/lib/sqlExecutor.js';

/**
 * sqlExecutor — hardening / correctness suite.
 *
 * Covers behaviours surfaced by the May 2026 audit + the 5 fixes shipped
 * with this changeset:
 *   • FIX B — `NOT IN (..., NULL, ...)` now obeys SQL three-valued logic.
 *   • FIX C — `LIKE` / `NOT LIKE` escapes regex metacharacters in patterns.
 *   • FIX D — `ALTER TABLE … ADD UNIQUE (a, b)` enforces TUPLE uniqueness
 *             via `compositeUniques` (not per-column `unique`).
 *   • FIX E — Table-level `FOREIGN KEY (col) REFERENCES tbl(col)` now
 *             stamps `refTable` on the source column (matches ALTER FK).
 *
 * Plus comprehensive WHERE / DML / DDL edge-case coverage that pins
 * deliberately-limited behaviours so they don't drift silently.
 */

function exec(sql, options = {}) {
    const executor = createSqlExecutor(options);
    const result = executor.execute(sql);
    return {
        tables: result.tables,
        types: result.types,
        log: result.log,
        executor,
        table: (name) => {
            for (const [, v] of result.tables) {
                if (v.name.toLowerCase() === name.toLowerCase()) return v;
            }
            return null;
        },
        col: (tableName, colName) => {
            for (const [, v] of result.tables) {
                if (v.name.toLowerCase() === tableName.toLowerCase()) {
                    return (
                        v.columns.find(
                            (c) => c.name.toLowerCase() === colName.toLowerCase(),
                        ) || null
                    );
                }
            }
            return null;
        },
        rowsOf: (name) => {
            for (const [, v] of result.tables) {
                if (v.name.toLowerCase() === name.toLowerCase()) return v.rows;
            }
            return null;
        },
        errors: () => result.log.filter((l) => l.type === 'error'),
        warnings: () => result.log.filter((l) => l.type === 'warning'),
        successes: () => result.log.filter((l) => l.type === 'success'),
    };
}

// ════════════════════════════════════════════════════════════════════════
// FIX B — NOT IN with NULL in the list
// ════════════════════════════════════════════════════════════════════════

describe('WHERE — NOT IN with NULL (SQL three-valued logic)', () => {
    it('NOT IN excludes rows when list contains NULL (UNKNOWN → false)', () => {
        const r = exec(`
            CREATE TABLE t (id INT, x INT);
            INSERT INTO t VALUES (1, 1), (2, 2), (3, 3);
            DELETE FROM t WHERE x NOT IN (1, NULL);
        `);
        // Per SQL: `x NOT IN (1, NULL)` is `x != 1 AND x != NULL`.
        // The second clause is UNKNOWN, AND-merged into the first → UNKNOWN.
        // UNKNOWN treated as false in WHERE means NO rows match, NO rows deleted.
        const rows = r.rowsOf('t');
        expect(rows).toHaveLength(3);
    });

    it('NOT IN with NO NULLs in the list still works normally', () => {
        // Rows: (1,1),(2,2),(3,3). DELETE WHERE x NOT IN (1,2) → only x=3 deleted.
        // Surviving rows: x=1 and x=2.
        const r = exec(`
            CREATE TABLE t (id INT, x INT);
            INSERT INTO t VALUES (1, 1), (2, 2), (3, 3);
            DELETE FROM t WHERE x NOT IN (1, 2);
        `);
        const rows = r.rowsOf('t');
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.x).sort()).toEqual([1, 2]);
    });

    it('IN with NULL in list ignores the NULL element', () => {
        const r = exec(`
            CREATE TABLE t (id INT, x INT);
            INSERT INTO t VALUES (1, 1), (2, 2), (3, 3);
            DELETE FROM t WHERE x IN (2, NULL);
        `);
        // NULL list element matches nothing; only x=2 deleted.
        const rows = r.rowsOf('t');
        expect(rows).toHaveLength(2);
        expect(rows.map((r2) => r2.x).sort()).toEqual([1, 3]);
    });
});

// ════════════════════════════════════════════════════════════════════════
// FIX C — LIKE / NOT LIKE regex metacharacter escaping
// ════════════════════════════════════════════════════════════════════════

describe('WHERE — LIKE escapes regex metacharacters (FIX C)', () => {
    it("LIKE 'a.b' matches literal 'a.b' only — NOT 'aXb'", () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t VALUES (1, 'a.b'), (2, 'aXb'), (3, 'aYb');
            DELETE FROM t WHERE name LIKE 'a.b';
        `);
        const rows = r.rowsOf('t');
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.name).sort()).toEqual(['aXb', 'aYb']);
    });

    it("LIKE 'a%' wildcard still works (% → .*)", () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t VALUES (1, 'apple'), (2, 'banana'), (3, 'avocado');
            DELETE FROM t WHERE name LIKE 'a%';
        `);
        const rows = r.rowsOf('t');
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe('banana');
    });

    it("LIKE 'a_c' wildcard still works (_ → .)", () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t VALUES (1, 'abc'), (2, 'aXc'), (3, 'abbc');
            DELETE FROM t WHERE name LIKE 'a_c';
        `);
        const rows = r.rowsOf('t');
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe('abbc');
    });

    it("LIKE pattern with regex meta '(' does not throw", () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t VALUES (1, 'foo(bar)'), (2, 'foobar');
            DELETE FROM t WHERE name LIKE 'foo(bar)';
        `);
        const rows = r.rowsOf('t');
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe('foobar');
    });

    it("LIKE pattern with bracketed character class is treated as literal", () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t VALUES (1, '[abc]'), (2, 'a'), (3, 'b'), (4, 'c');
            DELETE FROM t WHERE name LIKE '[abc]';
        `);
        const rows = r.rowsOf('t');
        expect(rows).toHaveLength(3); // 'a','b','c' kept; only literal '[abc]' deleted
        expect(rows.map((row) => row.name).sort()).toEqual(['a', 'b', 'c']);
    });

    it("NOT LIKE inverts correctly with literal '.' in pattern", () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t VALUES (1, 'a.b'), (2, 'aXb');
            DELETE FROM t WHERE name NOT LIKE 'a.b';
        `);
        const rows = r.rowsOf('t');
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe('a.b');
    });

    it("LIKE backslash-escaped wildcard matches literally", () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t VALUES (1, '50%'), (2, '50abc');
            DELETE FROM t WHERE name LIKE '50\\%';
        `);
        const rows = r.rowsOf('t');
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe('50abc');
    });
});

// ════════════════════════════════════════════════════════════════════════
// FIX D — ALTER ADD UNIQUE composite vs single column
// ════════════════════════════════════════════════════════════════════════

describe('ALTER TABLE ADD UNIQUE — composite vs single (FIX D)', () => {
    it('single-column ADD UNIQUE flips that column.unique=true', () => {
        const r = exec(`
            CREATE TABLE t (id INT, email TEXT);
            ALTER TABLE t ADD UNIQUE (email);
        `);
        const t = r.table('t');
        const email = t.columns.find((c) => c.name === 'email');
        expect(email.unique).toBe(true);
        // No composite-unique slot for single-column UNIQUE.
        expect(t.compositeUniques || []).toHaveLength(0);
    });

    it('composite ADD UNIQUE goes to compositeUniques, NOT individual cols', () => {
        const r = exec(`
            CREATE TABLE t (a INT, b INT, c INT);
            ALTER TABLE t ADD CONSTRAINT uq_ab UNIQUE (a, b);
        `);
        const t = r.table('t');
        // Individual columns must NOT be marked unique on their own —
        // it's a TUPLE constraint.
        expect(t.columns.find((c) => c.name === 'a').unique).toBeFalsy();
        expect(t.columns.find((c) => c.name === 'b').unique).toBeFalsy();
        // Tuple uniqueness recorded.
        expect(t.compositeUniques).toEqual([
            { name: 'uq_ab', cols: ['a', 'b'] },
        ]);
    });

    it('composite ADD UNIQUE ENFORCES tuple uniqueness on INSERT', () => {
        const r = exec(`
            CREATE TABLE t (a INT, b INT);
            ALTER TABLE t ADD UNIQUE (a, b);
            INSERT INTO t VALUES (1, 2);
            INSERT INTO t VALUES (1, 3);   -- ok: tuple differs
            INSERT INTO t VALUES (1, 2);   -- duplicate tuple: rejects statement
        `);
        const dupe = r.errors().some((m) => /unique/i.test(m.message));
        expect(dupe).toBe(true);
        expect(r.rowsOf('t')).toHaveLength(2);
    });

    it('composite ADD UNIQUE allows insert when ANY component differs', () => {
        const r = exec(`
            CREATE TABLE t (a INT, b INT);
            ALTER TABLE t ADD UNIQUE (a, b);
            INSERT INTO t VALUES (1, 2);
            INSERT INTO t VALUES (2, 2);
            INSERT INTO t VALUES (1, 3);
        `);
        // No warnings — all three tuples are distinct.
        const w = r.warnings().filter((x) => /unique/i.test(x.message));
        expect(w).toHaveLength(0);
        expect(r.rowsOf('t')).toHaveLength(3);
    });

    it('does not double-register the same composite UNIQUE on ALTER replay', () => {
        const r = exec(`
            CREATE TABLE t (a INT, b INT);
            ALTER TABLE t ADD UNIQUE (a, b);
            ALTER TABLE t ADD UNIQUE (a, b);
        `);
        const t = r.table('t');
        expect(t.compositeUniques).toHaveLength(1);
    });
});

// ════════════════════════════════════════════════════════════════════════
// FIX E — Table-level FOREIGN KEY captures REFERENCES target
// ════════════════════════════════════════════════════════════════════════

describe('CREATE TABLE — table-level FOREIGN KEY refTable (FIX E)', () => {
    it('table-level FK stamps refTable on source column', () => {
        const r = exec(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (
                id INT PRIMARY KEY,
                pid INT,
                FOREIGN KEY (pid) REFERENCES parent(id)
            );
        `);
        const pid = r.col('child', 'pid');
        expect(pid.fk).toBe(true);
        expect(pid.refTable).toBe('parent');
    });

    it('CONSTRAINT name FOREIGN KEY (col) REFERENCES other(id) — refTable set', () => {
        const r = exec(`
            CREATE TABLE other (id INT PRIMARY KEY);
            CREATE TABLE owner (
                id INT,
                other_id INT,
                CONSTRAINT fk_other FOREIGN KEY (other_id) REFERENCES other(id)
            );
        `);
        const c = r.col('owner', 'other_id');
        expect(c.fk).toBe(true);
        expect(c.refTable).toBe('other');
    });

    it('schema-qualified REFERENCES strips the schema', () => {
        const r = exec(`
            CREATE TABLE public.users (id INT PRIMARY KEY);
            CREATE TABLE public.posts (
                id INT,
                author_id INT,
                FOREIGN KEY (author_id) REFERENCES public.users(id)
            );
        `);
        const c = r.col('posts', 'author_id');
        expect(c.fk).toBe(true);
        expect(c.refTable).toBe('users');
    });

    it('composite FOREIGN KEY stamps refTable on EVERY source column', () => {
        const r = exec(`
            CREATE TABLE parent (a INT, b INT, PRIMARY KEY (a, b));
            CREATE TABLE child (
                pa INT, pb INT,
                FOREIGN KEY (pa, pb) REFERENCES parent(a, b)
            );
        `);
        expect(r.col('child', 'pa').refTable).toBe('parent');
        expect(r.col('child', 'pb').refTable).toBe('parent');
    });
});

// ════════════════════════════════════════════════════════════════════════
// WHERE — BETWEEN, IS NULL, mixed types, AND/OR precedence
// ════════════════════════════════════════════════════════════════════════

describe('WHERE — broad correctness suite', () => {
    it('IS NULL matches NULL rows; IS NOT NULL matches non-NULL', () => {
        const r = exec(`
            CREATE TABLE t (id INT, x INT);
            INSERT INTO t (id, x) VALUES (1, 10);
            INSERT INTO t (id) VALUES (2);
            DELETE FROM t WHERE x IS NULL;
        `);
        const rows = r.rowsOf('t');
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(1);
    });

    it('= between two NULLs is NOT a match (UNKNOWN, not equal)', () => {
        const r = exec(`
            CREATE TABLE t (id INT, x INT);
            INSERT INTO t (id) VALUES (1);
            INSERT INTO t (id) VALUES (2);
            DELETE FROM t WHERE x = NULL;
        `);
        // SQL: nothing equals NULL. Both rows survive.
        expect(r.rowsOf('t')).toHaveLength(2);
    });

    it('BETWEEN with NULL bound returns false (UNKNOWN)', () => {
        const r = exec(`
            CREATE TABLE t (id INT, x INT);
            INSERT INTO t VALUES (1, 5);
            DELETE FROM t WHERE x BETWEEN 1 AND NULL;
        `);
        // UNKNOWN → false → row survives.
        expect(r.rowsOf('t')).toHaveLength(1);
    });

    it('AND has higher precedence than OR (SQL standard)', () => {
        const r = exec(`
            CREATE TABLE t (id INT, x INT, y INT);
            INSERT INTO t VALUES (1, 1, 10), (2, 2, 20), (3, 3, 30);
            DELETE FROM t WHERE x = 1 OR x = 2 AND y = 30;
            -- Equivalent to: x=1 OR (x=2 AND y=30) → only row 1 matches.
        `);
        const rows = r.rowsOf('t');
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.id).sort()).toEqual([2, 3]);
    });

    it('UPDATE with WHERE applies to matching rows only', () => {
        const r = exec(`
            CREATE TABLE t (id INT, status TEXT);
            INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'a');
            UPDATE t SET status = 'X' WHERE status = 'a';
        `);
        const rows = r.rowsOf('t').sort((a, b) => a.id - b.id);
        expect(rows.map((row) => row.status)).toEqual(['X', 'b', 'X']);
    });

    it('DELETE without WHERE clears the table', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            INSERT INTO t VALUES (1), (2), (3);
            DELETE FROM t;
        `);
        expect(r.rowsOf('t')).toHaveLength(0);
    });

    it('parenthesized OR groups do not degrade into a whole-table match', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, active BOOLEAN, mark TEXT);
            INSERT INTO t VALUES (1, TRUE, 'keep'), (2, FALSE, 'keep'), (3, TRUE, 'keep');
            UPDATE t SET mark = 'hit' WHERE (id = 1 OR id = 2) AND active = TRUE;
        `);
        const rows = r.rowsOf('t').sort((a, b) => a.id - b.id);
        expect(rows.map((row) => row.mark)).toEqual(['hit', 'keep', 'keep']);
        expect(r.errors()).toEqual([]);
    });

    it('malformed WHERE clauses fail closed and leave rows unchanged', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, mark TEXT);
            INSERT INTO t VALUES (1, 'a'), (2, 'b');
            DELETE FROM t WHERE (id = 1 OR id = 2;
        `);
        expect(r.rowsOf('t')).toHaveLength(2);
        expect(r.errors().some((entry) => /WHERE clause could not be parsed/.test(entry.message))).toBe(true);
    });

    it('supports boolean IS predicates without treating IS TRUE as IS NULL', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, flag BOOLEAN, mark TEXT);
            INSERT INTO t VALUES (1, TRUE, 'keep'), (2, FALSE, 'keep'), (3, NULL, 'keep');
            UPDATE t SET mark = 'truthy' WHERE flag IS TRUE;
            UPDATE t SET mark = 'not_true' WHERE flag IS NOT TRUE;
        `);
        const rows = r.rowsOf('t').sort((a, b) => a.id - b.id);
        expect(rows.map((row) => row.mark)).toEqual(['truthy', 'not_true', 'not_true']);
    });

    it('supports ILIKE and NULL-safe DISTINCT predicates', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, name TEXT, old_name TEXT);
            INSERT INTO t VALUES (1, 'Ada', 'ada'), (2, 'Linus', NULL), (3, NULL, NULL);
            UPDATE t SET old_name = 'matched' WHERE name ILIKE 'a%';
            DELETE FROM t WHERE name IS NOT DISTINCT FROM old_name;
        `);
        const rows = r.rowsOf('t').sort((a, b) => a.id - b.id);
        expect(rows.map((row) => row.id)).toEqual([1, 2]);
        expect(rows[0].old_name).toBe('matched');
    });
});

// ════════════════════════════════════════════════════════════════════════
// INSERT semantics — DEFAULT, multi-row, type coercion
// ════════════════════════════════════════════════════════════════════════

describe('INSERT semantics', () => {
    it('omitted columns receive their declared DEFAULT', () => {
        const r = exec(`
            CREATE TABLE t (id INT, status TEXT DEFAULT 'pending', count INT DEFAULT 0);
            INSERT INTO t (id) VALUES (1);
        `);
        const row = r.rowsOf('t')[0];
        expect(row.id).toBe(1);
        expect(row.status).toBe('pending');
        expect(row.count).toBe(0);
    });

    it('explicit DEFAULT keyword resolves to declared default', () => {
        const r = exec(`
            CREATE TABLE t (id INT, status TEXT DEFAULT 'on');
            INSERT INTO t VALUES (1, DEFAULT);
        `);
        expect(r.rowsOf('t')[0].status).toBe('on');
    });

    it('DEFAULT VALUES inserts a row using defaults and generators', () => {
        const r = exec(`
            CREATE TABLE t (
                id INT PRIMARY KEY AUTO_INCREMENT,
                status TEXT DEFAULT 'new',
                count INT DEFAULT 0
            );
            INSERT INTO t DEFAULT VALUES;
        `);
        expect(r.errors()).toEqual([]);
        expect(r.rowsOf('t')).toEqual([{ id: 1, status: 'new', count: 0 }]);
    });

    it('duplicate INSERT column names reject the full statement', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, name TEXT);
            INSERT INTO t (id, id, name) VALUES (1, 2, 'bad');
        `);
        expect(r.rowsOf('t')).toHaveLength(0);
        expect(r.errors().some((entry) => /duplicate column/i.test(entry.message))).toBe(true);
    });

    it('explicit values for generated columns are rejected instead of silently overwritten', () => {
        const r = exec(`
            CREATE TABLE t (a INT, b INT, sum INT GENERATED ALWAYS AS (a + b) STORED);
            INSERT INTO t VALUES (1, 2, 999);
        `);
        expect(r.rowsOf('t')).toHaveLength(0);
        expect(r.errors().some((entry) => /generated column "sum"/i.test(entry.message))).toBe(true);
    });

    it('multi-row INSERT lands all rows', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c');
        `);
        expect(r.rowsOf('t')).toHaveLength(3);
    });

    it('AUTO_INCREMENT counter advances across inserts', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY AUTO_INCREMENT, name TEXT);
            INSERT INTO t (name) VALUES ('a'), ('b'), ('c');
        `);
        const ids = r.rowsOf('t').map((row) => row.id);
        expect(new Set(ids).size).toBe(3);
        // Strictly monotonically increasing.
        for (let i = 1; i < ids.length; i++) {
            expect(ids[i]).toBeGreaterThan(ids[i - 1]);
        }
    });

    it('explicit INSERT into AUTO_INCREMENT column does not collide with later auto values', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY AUTO_INCREMENT, name TEXT);
            INSERT INTO t VALUES (100, 'a');
            INSERT INTO t (name) VALUES ('b');
        `);
        const rows = r.rowsOf('t').sort((a, b) => a.id - b.id);
        // Auto value should bump past the explicit 100.
        expect(rows[0].id).toBe(100);
        expect(rows[1].id).toBeGreaterThan(100);
    });

    it('PostgreSQL SERIAL behaves like AUTO_INCREMENT', () => {
        const r = exec(`
            CREATE TABLE t (id SERIAL PRIMARY KEY, name TEXT);
            INSERT INTO t (name) VALUES ('a'), ('b');
        `);
        const rows = r.rowsOf('t');
        expect(rows).toHaveLength(2);
        expect(rows[0].id).not.toBe(rows[1].id);
    });

    it('MSSQL IDENTITY(seed, step) starts at seed and increments by step', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY IDENTITY(100, 5), name VARCHAR(50));
            INSERT INTO t (name) VALUES ('a'), ('b'), ('c');
        `);
        const ids = r.rowsOf('t').map((row) => row.id).sort((a, b) => a - b);
        expect(ids).toEqual([100, 105, 110]);
    });

    it('PG GENERATED BY DEFAULT AS IDENTITY allows explicit override', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY, name TEXT);
            INSERT INTO t VALUES (50, 'manual');
            INSERT INTO t (name) VALUES ('auto');
        `);
        const rows = r.rowsOf('t').sort((a, b) => a.id - b.id);
        expect(rows[0].id).toBe(50);
        expect(rows[1].id).toBeGreaterThan(50);
    });

    it('validates self-referencing foreign keys against the whole multi-row statement', () => {
        const r = exec(`
            CREATE TABLE categories (
                id INT PRIMARY KEY,
                parent_id INT REFERENCES categories(id),
                name TEXT
            );
            INSERT INTO categories (id, parent_id, name) VALUES
                (2, 1, 'child before parent'),
                (1, NULL, 'root'),
                (3, 3, 'self');
        `);
        expect(r.errors()).toEqual([]);
        expect(r.rowsOf('categories').map((row) => row.id).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    });

    it('keeps multi-row INSERT atomic when a self-reference remains missing', () => {
        const r = exec(`
            CREATE TABLE categories (
                id INT PRIMARY KEY,
                parent_id INT REFERENCES categories(id),
                name TEXT
            );
            INSERT INTO categories (id, parent_id, name) VALUES
                (1, NULL, 'root'),
                (2, 99, 'orphan');
        `);
        expect(r.rowsOf('categories')).toHaveLength(0);
        expect(r.errors().some((entry) => /FOREIGN KEY/.test(entry.message))).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════
// PK uniqueness — single + composite
// ════════════════════════════════════════════════════════════════════════

describe('PK uniqueness — across statement boundaries', () => {
    it('duplicate single-col PK in two separate INSERTs rejects the second', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY);
            INSERT INTO t VALUES (1);
            INSERT INTO t VALUES (1);
        `);
        const dup = r.errors().filter((w) => /primary|unique/i.test(w.message));
        expect(dup.length).toBeGreaterThan(0);
        expect(r.rowsOf('t')).toHaveLength(1);
    });

    it('composite PK enforced across separate INSERTs', () => {
        const r = exec(`
            CREATE TABLE t (a INT, b INT, PRIMARY KEY (a, b));
            INSERT INTO t VALUES (1, 2);
            INSERT INTO t VALUES (1, 3);
            INSERT INTO t VALUES (1, 2);
        `);
        const dup = r.errors().filter((w) => /primary|unique/i.test(w.message));
        expect(dup.length).toBeGreaterThan(0);
        expect(r.rowsOf('t')).toHaveLength(2);
    });
});

// ════════════════════════════════════════════════════════════════════════
// Default value evaluation — UUID, time, expressions
// ════════════════════════════════════════════════════════════════════════

describe('DEFAULT value evaluation', () => {
    it('UUID DEFAULT generates a unique-ish value per row', () => {
        const r = exec(`
            CREATE TABLE t (id UUID DEFAULT gen_random_uuid(), name TEXT);
            INSERT INTO t (name) VALUES ('a'), ('b'), ('c');
        `);
        const ids = r.rowsOf('t').map((row) => row.id);
        // Each ID should be a non-empty string.
        ids.forEach((id) => {
            expect(typeof id).toBe('string');
            expect(id.length).toBeGreaterThan(0);
        });
        // All distinct.
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('CURRENT_TIMESTAMP DEFAULT yields a non-empty string/Date', () => {
        const r = exec(`
            CREATE TABLE t (id INT, ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            INSERT INTO t (id) VALUES (1);
        `);
        const row = r.rowsOf('t')[0];
        expect(row.ts).toBeTruthy();
    });

    it('NOW() DEFAULT yields a value', () => {
        const r = exec(`
            CREATE TABLE t (id INT, ts TIMESTAMP DEFAULT NOW());
            INSERT INTO t (id) VALUES (1);
        `);
        const row = r.rowsOf('t')[0];
        expect(row.ts).toBeTruthy();
    });

    it('numeric DEFAULT survives INSERT', () => {
        const r = exec(`
            CREATE TABLE t (id INT, c INT DEFAULT 42);
            INSERT INTO t (id) VALUES (1);
        `);
        expect(r.rowsOf('t')[0].c).toBe(42);
    });

    it('string DEFAULT (with quotes) round-trips', () => {
        const r = exec(`
            CREATE TABLE t (id INT, s TEXT DEFAULT 'hello world');
            INSERT INTO t (id) VALUES (1);
        `);
        expect(r.rowsOf('t')[0].s).toBe('hello world');
    });
});

// ════════════════════════════════════════════════════════════════════════
// Schema-qualified table resolution
// ════════════════════════════════════════════════════════════════════════

describe('Schema-qualified table resolution', () => {
    it('CREATE TABLE schema.t / INSERT INTO schema.t round-trip', () => {
        const r = exec(`
            CREATE TABLE public.users (id INT PRIMARY KEY);
            INSERT INTO public.users VALUES (1), (2);
        `);
        expect(r.rowsOf('users')).toHaveLength(2);
    });

    it('lookup is case-insensitive', () => {
        const r = exec(`
            CREATE TABLE Users (Id INT PRIMARY KEY);
            INSERT INTO USERS (id) VALUES (1);
            UPDATE users SET id = 2 WHERE ID = 1;
        `);
        expect(r.rowsOf('Users')[0].Id).toBe(2);
    });
});

// ════════════════════════════════════════════════════════════════════════
// Recovery — strong anchors and deferred DML
// ════════════════════════════════════════════════════════════════════════

describe('Cross-statement recovery', () => {
    it('healthy CREATE after broken CREATE TABLE survives', () => {
        const r = exec(`
            CREATE TABLE bad (id INT,
            CREATE TABLE good (id INT, name TEXT);
        `);
        expect(r.table('good')).toBeTruthy();
    });

    it('INSERT before its CREATE TABLE is deferred and applied on second pass', () => {
        // The executor explicitly supports forward-references in the same script:
        //   INSERT INTO t ... ;
        //   CREATE TABLE t (...);
        // Pin that contract.
        const r = exec(`
            INSERT INTO t VALUES (1, 'first');
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t VALUES (2, 'second');
        `);
        const rows = r.rowsOf('t');
        // Both rows should land.
        expect(rows).toHaveLength(2);
        const ids = rows.map((row) => row.id).sort();
        expect(ids).toEqual([1, 2]);
    });

    it('INSERT into a never-defined table errors on second pass', () => {
        const r = exec(`
            CREATE TABLE good (id INT);
            INSERT INTO does_not_exist VALUES (1);
        `);
        const errs = r.errors();
        expect(errs.some((e) => /does_not_exist|not.*found/i.test(e.message))).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════
// MSSQL bare-AS computed columns — pin the regression fix from prior round
// ════════════════════════════════════════════════════════════════════════

describe('MSSQL computed columns — bare AS', () => {
    it('AS (expr) — column slot exists, type is COMPUTED', () => {
        const r = exec(`
            CREATE TABLE t (a INT, b INT, sum AS (a + b));
        `);
        const c = r.col('t', 'sum');
        expect(c).toBeTruthy();
        expect(String(c.type).toUpperCase()).toBe('COMPUTED');
    });

    it('AS (expr) PERSISTED NOT NULL — next column intact', () => {
        const r = exec(`
            CREATE TABLE t (
                a INT, b INT,
                total AS (a + b) PERSISTED NOT NULL,
                tail VARCHAR(50) NOT NULL
            );
        `);
        const tail = r.col('t', 'tail');
        expect(tail).toBeTruthy();
        expect(tail.notNull).toBe(true);
    });

    it('AS (expr) NOT NULL PERSISTED — alternate ordering, next column intact', () => {
        const r = exec(`
            CREATE TABLE t (
                a INT, b INT,
                total AS (a + b) NOT NULL PERSISTED,
                tail VARCHAR(50) NOT NULL
            );
        `);
        const tail = r.col('t', 'tail');
        expect(tail).toBeTruthy();
        expect(tail.notNull).toBe(true);
    });

    it('positional INSERT leaves the computed slot read-only and evaluates it', () => {
        const r = exec(`
            CREATE TABLE t (a INT, b INT, sum AS (a + b));
            INSERT INTO t (a, b) VALUES (1, 2);
        `);
        const row = r.rowsOf('t')[0];
        expect(row.a).toBe(1);
        expect(row.b).toBe(2);
        expect(row.sum).toBe(3);
    });
});

// ════════════════════════════════════════════════════════════════════════
// SQLite STRICT — datatype enforcement and statement atomicity
// ════════════════════════════════════════════════════════════════════════

describe('SQLite STRICT — Data View datatype correctness', () => {
    it('applies lossless STRICT affinity and preserves ANY values', () => {
        const r = exec(`
            CREATE TABLE strict_types (
                id INTEGER PRIMARY KEY,
                qty INTEGER NOT NULL,
                price REAL NOT NULL,
                label TEXT NOT NULL,
                payload ANY
            ) STRICT;
            INSERT INTO strict_types (id, qty, price, label, payload)
            VALUES (1, '01', '1.5', 99, '01');
        `, { dialect: 'sqlite' });

        expect(r.errors()).toHaveLength(0);
        expect(r.rowsOf('strict_types')).toEqual([
            { id: 1, qty: 1, price: 1.5, label: '99', payload: '01' },
        ]);
    });

    it('rejects lossy INTEGER values and rolls back the whole multi-row INSERT', () => {
        const r = exec(`
            CREATE TABLE strict_types (
                id INTEGER PRIMARY KEY,
                qty INTEGER NOT NULL,
                price REAL NOT NULL,
                label TEXT NOT NULL,
                payload ANY
            ) STRICT;
            INSERT INTO strict_types (id, qty, price, label, payload) VALUES
                (1, '01', '1.5', 99, 'valid-first-row'),
                (2, '1.5', 3, 'bad-second-row', 'payload');
        `, { dialect: 'sqlite' });

        expect(r.errors().some((entry) => /cannot store REAL value in INTEGER column "qty"/i.test(entry.message))).toBe(true);
        // SQLite aborts the entire statement, so the valid first tuple must
        // not leak into the preview.
        expect(r.rowsOf('strict_types')).toEqual([]);
    });

    it('rejects non-numeric REAL values and keeps earlier table state unchanged', () => {
        const r = exec(`
            CREATE TABLE strict_real_guard (
                id INTEGER PRIMARY KEY,
                amount REAL NOT NULL
            ) STRICT;
            INSERT INTO strict_real_guard VALUES (1, 10.5);
            INSERT INTO strict_real_guard VALUES (2, 'abc');
        `, { dialect: 'sqlite' });

        expect(r.errors().some((entry) => /cannot store TEXT value in REAL column "amount"/i.test(entry.message))).toBe(true);
        expect(r.rowsOf('strict_real_guard')).toEqual([{ id: 1, amount: 10.5 }]);
    });

    it('rolls back a STRICT UPDATE when candidate rows conflict with UNIQUE', () => {
        const r = exec(`
            CREATE TABLE strict_update_guard (
                id INTEGER PRIMARY KEY,
                tag TEXT NOT NULL UNIQUE
            ) STRICT;
            INSERT INTO strict_update_guard VALUES (1, 'alpha'), (2, 'beta');
            UPDATE strict_update_guard SET tag = 'same' WHERE id IN (1, 2);
        `, { dialect: 'sqlite' });

        expect(r.errors().some((entry) => /duplicate UNIQUE "tag"/i.test(entry.message))).toBe(true);
        expect(r.rowsOf('strict_update_guard')).toEqual([
            { id: 1, tag: 'alpha' },
            { id: 2, tag: 'beta' },
        ]);
    });

    it('rejects SQLite row-order PK conflicts such as UPDATE id = id + 1', () => {
        const r = exec(`
            CREATE TABLE strict_pk_shift (
                id INTEGER PRIMARY KEY,
                tag TEXT NOT NULL
            ) STRICT;
            INSERT INTO strict_pk_shift VALUES (1, 'alpha'), (2, 'beta');
            UPDATE strict_pk_shift SET id = id + 1;
        `, { dialect: 'sqlite' });

        expect(r.errors().some((entry) => /duplicate PRIMARY KEY "id"/i.test(entry.message))).toBe(true);
        expect(r.rowsOf('strict_pk_shift')).toEqual([
            { id: 1, tag: 'alpha' },
            { id: 2, tag: 'beta' },
        ]);
    });

    it('uses parent-key SQLite affinity for ON DELETE CASCADE matching', () => {
        const r = exec(`
            PRAGMA foreign_keys = ON;
            CREATE TABLE parent (
                id INTEGER PRIMARY KEY
            ) STRICT;
            CREATE TABLE child (
                id INTEGER PRIMARY KEY,
                parent_id TEXT REFERENCES parent(id) ON DELETE CASCADE
            ) STRICT;
            INSERT INTO parent VALUES (1);
            INSERT INTO child VALUES (1, '01');
            DELETE FROM parent WHERE id = 1;
        `, { dialect: 'sqlite' });

        expect(r.errors()).toHaveLength(0);
        expect(r.rowsOf('child')).toEqual([]);
    });
});

describe('Transactions and savepoints — Data View correctness', () => {
    it('commits only work that survives a SAVEPOINT rollback', () => {
        const r = exec(`
            CREATE TABLE ledger (
                id INTEGER PRIMARY KEY,
                amount INTEGER NOT NULL CHECK (amount >= 0)
            ) STRICT;
            BEGIN TRANSACTION;
            INSERT INTO ledger VALUES (1, 10);
            SAVEPOINT before_adjustment;
            UPDATE ledger SET amount = 25 WHERE id = 1;
            INSERT INTO ledger VALUES (2, 30);
            ROLLBACK TO SAVEPOINT before_adjustment;
            RELEASE SAVEPOINT before_adjustment;
            COMMIT;
        `, { dialect: 'sqlite' });

        expect(r.errors()).toEqual([]);
        expect(r.rowsOf('ledger')).toEqual([{ id: 1, amount: 10 }]);
        expect(r.successes().some((entry) => /Rolled back to savepoint/.test(entry.message))).toBe(true);
    });

    it('rolls back both DDL and DML, including across execute calls', () => {
        const executor = createSqlExecutor({ dialect: 'sqlite' });
        executor.execute('BEGIN; CREATE TABLE transient_rows (id INTEGER PRIMARY KEY) STRICT; INSERT INTO transient_rows VALUES (1);');
        const result = executor.execute('ROLLBACK;');

        expect(Array.from(result.tables.values()).find((table) => table.name === 'transient_rows')).toBeUndefined();
        expect(result.log.some((entry) => entry.type === 'success' && entry.message === 'Transaction rolled back')).toBe(true);
    });

    it('keeps non-SQLite sequence gaps after rollback while SQLite restores its counter', () => {
        const postgres = exec(`
            CREATE TABLE pg_sequence (id SERIAL PRIMARY KEY, label TEXT);
            BEGIN;
            INSERT INTO pg_sequence (label) VALUES ('rolled-back');
            ROLLBACK;
            INSERT INTO pg_sequence (label) VALUES ('committed');
        `, { dialect: 'postgres' });
        expect(postgres.rowsOf('pg_sequence')).toEqual([{ id: 2, label: 'committed' }]);

        const sqlite = exec(`
            CREATE TABLE sqlite_sequence (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT) STRICT;
            BEGIN;
            INSERT INTO sqlite_sequence (label) VALUES ('rolled-back');
            ROLLBACK;
            INSERT INTO sqlite_sequence (label) VALUES ('committed');
        `, { dialect: 'sqlite' });
        expect(sqlite.rowsOf('sqlite_sequence')).toEqual([{ id: 1, label: 'committed' }]);
    });

    it('models MySQL implicit DDL commit instead of pretending the schema rolls back', () => {
        const r = exec(`
            BEGIN;
            CREATE TABLE ddl_commit (id INT PRIMARY KEY);
            INSERT INTO ddl_commit VALUES (1);
            ROLLBACK;
        `, { dialect: 'mysql' });

        expect(r.table('ddl_commit').rows).toEqual([{ id: 1 }]);
        expect(r.log.some((entry) => entry.type === 'info' && /implicitly committed/.test(entry.message))).toBe(true);
        expect(r.errors().some((entry) => /no transaction is active/.test(entry.message))).toBe(true);
    });

    it('fails closed for invalid savepoint control statements', () => {
        const r = exec('ROLLBACK TO missing_point; RELEASE SAVEPOINT missing_point;', { dialect: 'sqlite' });
        expect(r.errors().filter((entry) => /no transaction is active/.test(entry.message))).toHaveLength(2);
    });

    it('models PostgreSQL aborted transactions and SAVEPOINT recovery', () => {
        const aborted = exec(`
            CREATE TABLE pg_abort_demo (id INT PRIMARY KEY, note TEXT);
            BEGIN;
            INSERT INTO pg_abort_demo VALUES (1, 'first');
            INSERT INTO pg_abort_demo VALUES (1, 'duplicate');
            INSERT INTO pg_abort_demo VALUES (2, 'must-not-run');
            COMMIT;
        `, { dialect: 'postgres' });

        // PostgreSQL rolls the complete transaction back after an error;
        // later ordinary statements are rejected rather than partially run.
        expect(aborted.rowsOf('pg_abort_demo')).toEqual([]);
        expect(aborted.errors().some((entry) => /current transaction is aborted/.test(entry.message))).toBe(true);

        const recovered = exec(`
            CREATE TABLE pg_savepoint_demo (id INT PRIMARY KEY, note TEXT);
            BEGIN;
            INSERT INTO pg_savepoint_demo VALUES (1, 'kept');
            SAVEPOINT before_duplicate;
            INSERT INTO pg_savepoint_demo VALUES (1, 'duplicate');
            ROLLBACK TO SAVEPOINT before_duplicate;
            INSERT INTO pg_savepoint_demo VALUES (2, 'recovered');
            COMMIT;
        `, { dialect: 'postgres' });
        expect(recovered.rowsOf('pg_savepoint_demo')).toEqual([
            { id: 1, note: 'kept' },
            { id: 2, note: 'recovered' },
        ]);
    });

    it('defers PostgreSQL INITIALLY DEFERRED foreign keys until COMMIT', () => {
        const repaired = exec(`
            CREATE TABLE deferred_parent (id INT PRIMARY KEY);
            CREATE TABLE deferred_child (
                id INT PRIMARY KEY,
                parent_id INT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED
            );
            BEGIN;
            INSERT INTO deferred_child VALUES (10, 1);
            INSERT INTO deferred_parent VALUES (1);
            COMMIT;
        `, { dialect: 'postgres' });
        expect(repaired.errors()).toEqual([]);
        expect(repaired.rowsOf('deferred_child')).toEqual([{ id: 10, parent_id: 1 }]);

        const unrepaired = exec(`
            CREATE TABLE deferred_parent_fail (id INT PRIMARY KEY);
            CREATE TABLE deferred_child_fail (
                id INT PRIMARY KEY,
                parent_id INT REFERENCES deferred_parent_fail(id) DEFERRABLE INITIALLY DEFERRED
            );
            BEGIN;
            INSERT INTO deferred_child_fail VALUES (10, 999);
            COMMIT;
        `, { dialect: 'postgres' });
        expect(unrepaired.errors().some((entry) => /COMMIT .*FOREIGN KEY/.test(entry.message))).toBe(true);
        expect(unrepaired.rowsOf('deferred_child_fail')).toEqual([]);
        expect(unrepaired.log.some((entry) => /deferred foreign-key validation failed/.test(entry.message))).toBe(true);

        const timingChange = exec('BEGIN; SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;', { dialect: 'postgres' });
        expect(timingChange.errors().some((entry) => /SET CONSTRAINTS timing changes/.test(entry.message))).toBe(true);
    });

    it('allows a deferred NO ACTION delete to be repaired before COMMIT', () => {
        const repaired = exec(`
            CREATE TABLE deferred_delete_parent (id INT PRIMARY KEY);
            CREATE TABLE deferred_delete_child (
                id INT PRIMARY KEY,
                parent_id INT REFERENCES deferred_delete_parent(id) DEFERRABLE INITIALLY DEFERRED
            );
            INSERT INTO deferred_delete_parent VALUES (1);
            INSERT INTO deferred_delete_child VALUES (10, 1);
            BEGIN;
            DELETE FROM deferred_delete_parent WHERE id = 1;
            DELETE FROM deferred_delete_child WHERE id = 10;
            COMMIT;
        `, { dialect: 'postgres' });
        expect(repaired.errors()).toEqual([]);
        expect(repaired.rowsOf('deferred_delete_parent')).toEqual([]);
        expect(repaired.rowsOf('deferred_delete_child')).toEqual([]);

        const unrepaired = exec(`
            CREATE TABLE deferred_delete_parent_fail (id INT PRIMARY KEY);
            CREATE TABLE deferred_delete_child_fail (
                id INT PRIMARY KEY,
                parent_id INT REFERENCES deferred_delete_parent_fail(id) DEFERRABLE INITIALLY DEFERRED
            );
            INSERT INTO deferred_delete_parent_fail VALUES (1);
            INSERT INTO deferred_delete_child_fail VALUES (10, 1);
            BEGIN;
            DELETE FROM deferred_delete_parent_fail WHERE id = 1;
            COMMIT;
        `, { dialect: 'postgres' });
        expect(unrepaired.errors().some((entry) => /COMMIT .*FOREIGN KEY/.test(entry.message))).toBe(true);
        // A failed commit restores every row that existed before BEGIN.
        expect(unrepaired.rowsOf('deferred_delete_parent_fail')).toEqual([{ id: 1 }]);
        expect(unrepaired.rowsOf('deferred_delete_child_fail')).toEqual([{ id: 10, parent_id: 1 }]);
    });
});

describe('Connection-level foreign-key switches', () => {
    it('uses SQLite’s OFF-by-default connection setting and honors PRAGMA changes', () => {
        const executor = createSqlExecutor({ dialect: 'sqlite' });
        const disabled = executor.execute(`
            CREATE TABLE parent (id INTEGER PRIMARY KEY);
            CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE);
            INSERT INTO child VALUES (1, 999);
        `);
        expect(disabled.log.filter((entry) => entry.type === 'error')).toEqual([]);
        expect(Array.from(disabled.tables.values()).find((table) => table.name === 'child').rows).toEqual([{ id: 1, parent_id: 999 }]);

        const enabled = executor.execute(`
            PRAGMA foreign_keys = ON;
            INSERT INTO child VALUES (2, 998);
        `);
        expect(enabled.log.some((entry) => entry.type === 'error' && /FOREIGN KEY/.test(entry.message))).toBe(true);
        expect(Array.from(enabled.tables.values()).find((table) => table.name === 'child').rows).toEqual([{ id: 1, parent_id: 999 }]);
    });

    it('honors MySQL FOREIGN_KEY_CHECKS for validation and referential actions', () => {
        const r = exec(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (id INT PRIMARY KEY, parent_id INT REFERENCES parent(id) ON DELETE CASCADE);
            SET FOREIGN_KEY_CHECKS = 0;
            INSERT INTO child VALUES (1, 999);
            SET FOREIGN_KEY_CHECKS = 1;
            INSERT INTO child VALUES (2, 998);
        `, { dialect: 'mysql' });

        expect(r.rowsOf('child')).toEqual([{ id: 1, parent_id: 999 }]);
        expect(r.errors().filter((entry) => /FOREIGN KEY/.test(entry.message))).toHaveLength(1);
    });
});

describe('Named constraints and unique indexes — executable metadata', () => {
    it('enforces and then removes named UNIQUE, CHECK, and FOREIGN KEY constraints', () => {
        const r = exec(`
            PRAGMA foreign_keys = ON;
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (
                id INT PRIMARY KEY,
                parent_id INT,
                code TEXT,
                CONSTRAINT fk_child_parent FOREIGN KEY (parent_id) REFERENCES parent(id),
                CONSTRAINT uq_child_code UNIQUE (code),
                CONSTRAINT chk_child_code CHECK (code <> '')
            );
            INSERT INTO parent VALUES (1);
            INSERT INTO child VALUES (1, 1, 'same');
            ALTER TABLE child DROP CONSTRAINT uq_child_code;
            ALTER TABLE child DROP CONSTRAINT chk_child_code;
            ALTER TABLE child DROP CONSTRAINT fk_child_parent;
            INSERT INTO child VALUES (2, 999, 'same');
            INSERT INTO child VALUES (3, 998, '');
        `, { dialect: 'sqlite' });

        expect(r.errors()).toEqual([]);
        expect(r.rowsOf('child')).toEqual([
            { id: 1, parent_id: 1, code: 'same' },
            { id: 2, parent_id: 999, code: 'same' },
            { id: 3, parent_id: 998, code: '' },
        ]);
    });

    it('also tracks names placed inside column definitions', () => {
        const r = exec(`
            PRAGMA foreign_keys = ON;
            CREATE TABLE column_named_parent (id INT PRIMARY KEY);
            CREATE TABLE column_named_child (
                id INT CONSTRAINT pk_column_named_child PRIMARY KEY,
                parent_id INT CONSTRAINT fk_column_named_parent REFERENCES column_named_parent(id),
                code TEXT CONSTRAINT uq_column_named_code UNIQUE,
                qty INT CONSTRAINT chk_column_named_qty CHECK (qty >= 0)
            );
            INSERT INTO column_named_parent VALUES (1);
            INSERT INTO column_named_child VALUES (1, 1, 'same', 1);
            ALTER TABLE column_named_child DROP CONSTRAINT pk_column_named_child;
            ALTER TABLE column_named_child DROP CONSTRAINT fk_column_named_parent;
            ALTER TABLE column_named_child DROP CONSTRAINT uq_column_named_code;
            ALTER TABLE column_named_child DROP CONSTRAINT chk_column_named_qty;
            INSERT INTO column_named_child VALUES (1, 999, 'same', -1);
        `, { dialect: 'sqlite' });

        expect(r.errors()).toEqual([]);
        expect(r.rowsOf('column_named_child')).toEqual([
            { id: 1, parent_id: 1, code: 'same', qty: 1 },
            { id: 1, parent_id: 999, code: 'same', qty: -1 },
        ]);
    });

    it('keeps inline constraints executable when ALTER TABLE adds the column', () => {
        const r = exec(`
            PRAGMA foreign_keys = ON;
            CREATE TABLE alter_column_parent (id INT PRIMARY KEY);
            CREATE TABLE alter_column_child (id INT PRIMARY KEY);
            ALTER TABLE alter_column_child
                ADD parent_id INT CONSTRAINT fk_added_parent REFERENCES alter_column_parent(id),
                ADD code TEXT CONSTRAINT uq_added_code UNIQUE;
            INSERT INTO alter_column_parent VALUES (1);
            INSERT INTO alter_column_child VALUES (1, 1, 'same');
            INSERT INTO alter_column_child VALUES (2, 999, 'other');
            INSERT INTO alter_column_child VALUES (2, 1, 'same');
            ALTER TABLE alter_column_child DROP CONSTRAINT fk_added_parent;
            ALTER TABLE alter_column_child DROP CONSTRAINT uq_added_code;
            INSERT INTO alter_column_child VALUES (2, 999, 'same');
        `, { dialect: 'sqlite' });

        expect(r.errors().filter((entry) => /FOREIGN KEY|duplicate UNIQUE/.test(entry.message))).toHaveLength(2);
        expect(r.rowsOf('alter_column_child')).toEqual([
            { id: 1, parent_id: 1, code: 'same' },
            { id: 2, parent_id: 999, code: 'same' },
        ]);
    });

    it('treats CREATE UNIQUE INDEX as an enforced constraint until DROP INDEX', () => {
        const r = exec(`
            CREATE TABLE indexed_unique (id INT PRIMARY KEY, code TEXT);
            CREATE UNIQUE INDEX indexed_unique_code ON indexed_unique (code);
            INSERT INTO indexed_unique VALUES (1, 'same');
            INSERT INTO indexed_unique VALUES (2, 'same');
            DROP INDEX indexed_unique_code;
            INSERT INTO indexed_unique VALUES (2, 'same');
        `);

        expect(r.errors().filter((entry) => /duplicate UNIQUE/.test(entry.message))).toHaveLength(1);
        expect(r.rowsOf('indexed_unique')).toEqual([
            { id: 1, code: 'same' },
            { id: 2, code: 'same' },
        ]);
    });

    it('enforces a partial UNIQUE index only for rows selected by its WHERE predicate', () => {
        const r = exec(`
            CREATE TABLE partial_unique_accounts (
                id INT PRIMARY KEY,
                email TEXT NOT NULL,
                deleted_at TEXT
            );
            CREATE UNIQUE INDEX active_email_unique
                ON partial_unique_accounts (email)
                WHERE deleted_at IS NULL;
            INSERT INTO partial_unique_accounts VALUES (1, 'ada@example.test', NULL);
            INSERT INTO partial_unique_accounts VALUES (2, 'ada@example.test', '2026-01-01');
            INSERT INTO partial_unique_accounts VALUES (3, 'ada@example.test', NULL);
            UPDATE partial_unique_accounts SET deleted_at = NULL WHERE id = 2;
            DELETE FROM partial_unique_accounts WHERE id = 1;
            UPDATE partial_unique_accounts SET deleted_at = NULL WHERE id = 2;
        `, { dialect: 'sqlite' });

        // The duplicate INSERT and the transition back into the indexed set
        // both fail atomically; after removing the active row, the same
        // transition becomes valid.
        expect(r.errors().filter((entry) => /partial UNIQUE INDEX|duplicate UNIQUE INDEX/.test(entry.message))).toHaveLength(2);
        expect(r.rowsOf('partial_unique_accounts')).toEqual([
            { id: 2, email: 'ada@example.test', deleted_at: null },
        ]);
    });

    it('keeps filtered-index behavior aligned with PostgreSQL, SQL Server, and MySQL', () => {
        const filteredIndexSql = `
            CREATE TABLE filtered_profile_accounts (id INT PRIMARY KEY, email TEXT, deleted_at TEXT);
            CREATE UNIQUE INDEX filtered_profile_email
                ON filtered_profile_accounts (email)
                WHERE deleted_at IS NULL;
            INSERT INTO filtered_profile_accounts VALUES (1, 'same', NULL);
            INSERT INTO filtered_profile_accounts VALUES (2, 'same', NULL);
        `;
        for (const dialect of ['postgres', 'mssql']) {
            const result = exec(filteredIndexSql, { dialect });
            expect(result.errors().filter((entry) => /duplicate UNIQUE INDEX/.test(entry.message))).toHaveLength(1);
            expect(result.rowsOf('filtered_profile_accounts')).toHaveLength(1);
        }

        const mysql = exec(filteredIndexSql, { dialect: 'mysql' });
        expect(mysql.errors().some((entry) => /MySQL does not support a WHERE predicate/.test(entry.message))).toBe(true);
        expect(mysql.table('filtered_profile_accounts').indexes).toEqual([]);
    });

    it('rejects CREATE/ALTER UNIQUE when stored rows already conflict', () => {
        const createIndex = exec(`
            CREATE TABLE duplicate_before_index (id INT PRIMARY KEY, code TEXT);
            INSERT INTO duplicate_before_index VALUES (1, 'dup'), (2, 'dup');
            CREATE UNIQUE INDEX duplicate_before_index_code ON duplicate_before_index (code);
        `);
        expect(createIndex.errors().some((entry) => /duplicate UNIQUE INDEX/.test(entry.message))).toBe(true);
        expect(createIndex.table('duplicate_before_index').indexes).toEqual([]);

        const alterConstraint = exec(`
            CREATE TABLE duplicate_before_constraint (id INT PRIMARY KEY, code TEXT);
            INSERT INTO duplicate_before_constraint VALUES (1, 'dup'), (2, 'dup');
            ALTER TABLE duplicate_before_constraint ADD CONSTRAINT uq_code UNIQUE (code);
        `);
        expect(alterConstraint.errors().some((entry) => /duplicate UNIQUE INDEX/.test(entry.message))).toBe(true);
        expect(alterConstraint.table('duplicate_before_constraint').indexes).toEqual([]);

        const partialIndex = exec(`
            CREATE TABLE duplicate_before_partial_index (id INT PRIMARY KEY, code TEXT, archived INT);
            INSERT INTO duplicate_before_partial_index VALUES
                (1, 'dup', 0), (2, 'dup', 0), (3, 'dup', 1);
            CREATE UNIQUE INDEX duplicate_active_code
                ON duplicate_before_partial_index (code) WHERE archived = 0;
        `, { dialect: 'sqlite' });
        expect(partialIndex.errors().some((entry) => /duplicate UNIQUE INDEX/.test(entry.message))).toBe(true);
        expect(partialIndex.table('duplicate_before_partial_index').indexes).toEqual([]);
    });

    it('does not let DROP CONSTRAINT remove a standalone CREATE UNIQUE INDEX', () => {
        const r = exec(`
            CREATE TABLE standalone_unique_index (id INT PRIMARY KEY, code TEXT);
            CREATE UNIQUE INDEX standalone_unique_index_code ON standalone_unique_index (code);
            ALTER TABLE standalone_unique_index DROP CONSTRAINT standalone_unique_index_code;
            INSERT INTO standalone_unique_index VALUES (1, 'same');
            INSERT INTO standalone_unique_index VALUES (2, 'same');
        `);

        expect(r.errors().some((entry) => /constraint .* does not exist/.test(entry.message))).toBe(true);
        expect(r.errors().some((entry) => /duplicate UNIQUE/.test(entry.message))).toBe(true);
        expect(r.rowsOf('standalone_unique_index')).toEqual([{ id: 1, code: 'same' }]);
    });

    it('matches SQL Server UNIQUE NULL behavior without changing the other profiles', () => {
        const sql = `
            CREATE TABLE nullable_unique (id INT PRIMARY KEY, email TEXT UNIQUE);
            INSERT INTO nullable_unique VALUES (1, NULL);
            INSERT INTO nullable_unique VALUES (2, NULL);
        `;
        const sqlServer = exec(sql, { dialect: 'mssql' });
        expect(sqlServer.rowsOf('nullable_unique')).toEqual([{ id: 1, email: null }]);
        expect(sqlServer.errors().some((entry) => /duplicate UNIQUE/.test(entry.message))).toBe(true);

        for (const dialect of ['sqlite', 'postgres', 'mysql']) {
            const result = exec(sql, { dialect });
            expect(result.errors()).toEqual([]);
            expect(result.rowsOf('nullable_unique')).toHaveLength(2);
        }
    });

    it('applies the same SQL Server NULL rule to composite UNIQUE keys', () => {
        const sql = `
            CREATE TABLE nullable_composite_unique (
                id INT PRIMARY KEY,
                tenant_id INT,
                external_id TEXT,
                CONSTRAINT uq_tenant_external UNIQUE (tenant_id, external_id)
            );
            INSERT INTO nullable_composite_unique VALUES (1, NULL, 'shared');
            INSERT INTO nullable_composite_unique VALUES (2, NULL, 'shared');
        `;
        const sqlServer = exec(sql, { dialect: 'mssql' });
        expect(sqlServer.rowsOf('nullable_composite_unique')).toEqual([
            { id: 1, tenant_id: null, external_id: 'shared' },
        ]);
        expect(sqlServer.errors().some((entry) => /duplicate composite UNIQUE/.test(entry.message))).toBe(true);

        for (const dialect of ['sqlite', 'postgres', 'mysql']) {
            const result = exec(sql, { dialect });
            expect(result.errors()).toEqual([]);
            expect(result.rowsOf('nullable_composite_unique')).toHaveLength(2);
        }
    });
});

// ════════════════════════════════════════════════════════════════════════
// Enforced integrity — regressions here must fail closed
// ════════════════════════════════════════════════════════════════════════

describe('Enforced integrity — statement atomicity', () => {
    it('requires an unconditional PRIMARY KEY or UNIQUE key as a FOREIGN KEY target', () => {
        const nonUnique = exec(`
            PRAGMA foreign_keys = ON;
            CREATE TABLE fk_parent_non_unique (id INT PRIMARY KEY, code TEXT);
            CREATE TABLE fk_child_non_unique (
                id INT PRIMARY KEY,
                parent_code TEXT REFERENCES fk_parent_non_unique(code)
            );
            INSERT INTO fk_parent_non_unique VALUES (1, 'shared'), (2, 'shared');
            INSERT INTO fk_child_non_unique VALUES (1, 'shared');
        `, { dialect: 'sqlite' });
        expect(nonUnique.errors().some((entry) => /not PRIMARY KEY or unconditional UNIQUE/.test(entry.message))).toBe(true);
        expect(nonUnique.rowsOf('fk_child_non_unique')).toEqual([]);

        const partialUnique = exec(`
            PRAGMA foreign_keys = ON;
            CREATE TABLE fk_parent_partial (id INT PRIMARY KEY, code TEXT, active INT);
            CREATE UNIQUE INDEX fk_parent_partial_active_code
                ON fk_parent_partial(code) WHERE active = 1;
            CREATE TABLE fk_child_partial (
                id INT PRIMARY KEY,
                parent_code TEXT REFERENCES fk_parent_partial(code)
            );
            INSERT INTO fk_parent_partial VALUES (1, 'only-active', 1);
            INSERT INTO fk_child_partial VALUES (1, 'only-active');
        `, { dialect: 'sqlite' });
        expect(partialUnique.errors().some((entry) => /not PRIMARY KEY or unconditional UNIQUE/.test(entry.message))).toBe(true);
        expect(partialUnique.rowsOf('fk_child_partial')).toEqual([]);

        const uniqueIndex = exec(`
            PRAGMA foreign_keys = ON;
            CREATE TABLE fk_parent_unique (id INT PRIMARY KEY, code TEXT);
            CREATE UNIQUE INDEX fk_parent_unique_code ON fk_parent_unique(code);
            CREATE TABLE fk_child_unique (
                id INT PRIMARY KEY,
                parent_code TEXT REFERENCES fk_parent_unique(code)
            );
            INSERT INTO fk_parent_unique VALUES (1, 'stable');
            INSERT INTO fk_child_unique VALUES (1, 'stable');
        `, { dialect: 'sqlite' });
        expect(uniqueIndex.errors()).toEqual([]);
        expect(uniqueIndex.rowsOf('fk_child_unique')).toEqual([{ id: 1, parent_code: 'stable' }]);

        const inlineUnique = exec(`
            PRAGMA foreign_keys = ON;
            CREATE TABLE fk_parent_inline_unique (id INT PRIMARY KEY, code TEXT UNIQUE);
            CREATE TABLE fk_child_inline_unique (
                id INT PRIMARY KEY,
                parent_code TEXT REFERENCES fk_parent_inline_unique(code)
            );
            INSERT INTO fk_parent_inline_unique VALUES (1, 'inline');
            INSERT INTO fk_child_inline_unique VALUES (1, 'inline');
        `, { dialect: 'sqlite' });
        expect(inlineUnique.errors()).toEqual([]);
        expect(inlineUnique.rowsOf('fk_child_inline_unique')).toEqual([{ id: 1, parent_code: 'inline' }]);

        const compositeUnique = exec(`
            PRAGMA foreign_keys = ON;
            CREATE TABLE fk_parent_composite_unique (
                tenant_id INT,
                code TEXT,
                CONSTRAINT uq_tenant_code UNIQUE (tenant_id, code)
            );
            CREATE TABLE fk_child_composite_unique (
                id INT PRIMARY KEY,
                tenant_id INT,
                parent_code TEXT,
                FOREIGN KEY (tenant_id, parent_code)
                    REFERENCES fk_parent_composite_unique(tenant_id, code)
            );
            INSERT INTO fk_parent_composite_unique VALUES (1, 'alpha');
            INSERT INTO fk_child_composite_unique VALUES (1, 1, 'alpha');
        `, { dialect: 'sqlite' });
        expect(compositeUnique.errors()).toEqual([]);
        expect(compositeUnique.rowsOf('fk_child_composite_unique')).toEqual([{ id: 1, tenant_id: 1, parent_code: 'alpha' }]);
    });

    it('UPDATE rejects a PK/UQ collision without changing the row', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, name TEXT);
            INSERT INTO t VALUES (1, 'a'), (2, 'b');
            UPDATE t SET id = 1 WHERE id = 2;
        `);
        const dup = r.errors().filter((w) => /primary key/i.test(w.message));
        expect(dup.length).toBeGreaterThan(0);
        expect(r.rowsOf('t')).toEqual([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
    });

    it('rejects an orphan foreign-key INSERT', () => {
        const r = exec(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (id INT, pid INT REFERENCES parent(id));
            INSERT INTO child VALUES (1, 999);
        `);
        const fk = r.errors().filter((w) => /foreign key/i.test(w.message));
        expect(fk).toHaveLength(1);
        expect(r.rowsOf('child')).toHaveLength(0);
    });

    it('rejects a CHECK violation', () => {
        const r = exec(`
            CREATE TABLE t (age INT CHECK (age >= 0));
            INSERT INTO t VALUES (-5);
        `);
        const chk = r.errors().filter((w) => /check/i.test(w.message));
        expect(chk).toHaveLength(1);
        expect(r.rowsOf('t')).toHaveLength(0);
    });

    it('rejects an invalid ENUM value', () => {
        const r = exec(`
            CREATE TABLE t (kind ENUM('a','b','c'));
            INSERT INTO t VALUES ('z');
        `);
        const enumError = r.errors().filter((w) => /enum/i.test(w.message));
        expect(enumError).toHaveLength(1);
        expect(r.rowsOf('t')).toHaveLength(0);
    });

    it('enforces named table CHECK constraints while allowing NULL (SQL UNKNOWN)', () => {
        const r = exec(`
            CREATE TABLE inventory (
                id INTEGER PRIMARY KEY,
                qty INTEGER,
                limit_qty INTEGER,
                CONSTRAINT qty_in_range CHECK (qty >= 0 AND qty <= limit_qty)
            );
            INSERT INTO inventory VALUES (1, 2, 4), (2, NULL, 4);
            INSERT INTO inventory VALUES (3, 5, 4);
        `, { dialect: 'sqlite' });

        expect(r.errors().filter((entry) => /qty_in_range|CHECK/.test(entry.message))).toHaveLength(1);
        expect(r.rowsOf('inventory')).toEqual([
            { id: 1, qty: 2, limit_qty: 4 },
            { id: 2, qty: null, limit_qty: 4 },
        ]);
    });

    it('rejects RESTRICT deletes and leaves both tables unchanged', () => {
        const r = exec(`
            PRAGMA foreign_keys = ON;
            CREATE TABLE parent (id INTEGER PRIMARY KEY);
            CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) ON DELETE RESTRICT);
            INSERT INTO parent VALUES (1);
            INSERT INTO child VALUES (10, 1);
            DELETE FROM parent WHERE id = 1;
        `, { dialect: 'sqlite' });

        expect(r.errors().some((entry) => /prevents deleting.*RESTRICT/.test(entry.message))).toBe(true);
        expect(r.rowsOf('parent')).toEqual([{ id: 1 }]);
        expect(r.rowsOf('child')).toEqual([{ id: 10, parent_id: 1 }]);
    });

    it('applies SET NULL and SET DEFAULT referential actions atomically', () => {
        const r = exec(`
            PRAGMA foreign_keys = ON;
            CREATE TABLE parent (id INTEGER PRIMARY KEY);
            CREATE TABLE nullable_child (
                id INTEGER PRIMARY KEY,
                parent_id INTEGER REFERENCES parent(id) ON DELETE SET NULL
            );
            CREATE TABLE default_child (
                id INTEGER PRIMARY KEY,
                parent_id INTEGER DEFAULT 0 REFERENCES parent(id) ON DELETE SET DEFAULT
            );
            INSERT INTO parent VALUES (0), (1);
            INSERT INTO nullable_child VALUES (10, 1);
            INSERT INTO default_child VALUES (20, 1);
            DELETE FROM parent WHERE id = 1;
        `, { dialect: 'sqlite' });

        expect(r.errors()).toEqual([]);
        expect(r.rowsOf('parent')).toEqual([{ id: 0 }]);
        expect(r.rowsOf('nullable_child')).toEqual([{ id: 10, parent_id: null }]);
        expect(r.rowsOf('default_child')).toEqual([{ id: 20, parent_id: 0 }]);
    });

    it('rejects SET NULL when the child key is NOT NULL and rolls back the delete', () => {
        const r = exec(`
            PRAGMA foreign_keys = ON;
            CREATE TABLE parent (id INTEGER PRIMARY KEY);
            CREATE TABLE child (
                id INTEGER PRIMARY KEY,
                parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE SET NULL
            );
            INSERT INTO parent VALUES (1);
            INSERT INTO child VALUES (10, 1);
            DELETE FROM parent WHERE id = 1;
        `, { dialect: 'sqlite' });

        expect(r.errors().some((entry) => /NOT NULL.*parent_id/.test(entry.message))).toBe(true);
        expect(r.rowsOf('parent')).toEqual([{ id: 1 }]);
        expect(r.rowsOf('child')).toEqual([{ id: 10, parent_id: 1 }]);
    });

    it('rejects SET DEFAULT when the default would still reference the deleted parent', () => {
        const r = exec(`
            PRAGMA foreign_keys = ON;
            CREATE TABLE parent (id INTEGER PRIMARY KEY);
            CREATE TABLE child (
                id INTEGER PRIMARY KEY,
                parent_id INTEGER DEFAULT 1 REFERENCES parent(id) ON DELETE SET DEFAULT
            );
            INSERT INTO parent VALUES (1);
            INSERT INTO child VALUES (10, 1);
            DELETE FROM parent WHERE id = 1;
        `, { dialect: 'sqlite' });

        expect(r.errors().some((entry) => /FOREIGN KEY/.test(entry.message))).toBe(true);
        expect(r.rowsOf('parent')).toEqual([{ id: 1 }]);
        expect(r.rowsOf('child')).toEqual([{ id: 10, parent_id: 1 }]);
    });

    it('applies recursive ON UPDATE CASCADE as one atomic mutation', () => {
        const r = exec(`
            PRAGMA foreign_keys = ON;
            CREATE TABLE root (id INTEGER PRIMARY KEY);
            CREATE TABLE middle (
                id INTEGER PRIMARY KEY REFERENCES root(id) ON UPDATE CASCADE
            );
            CREATE TABLE leaf (
                id INTEGER PRIMARY KEY REFERENCES middle(id) ON UPDATE CASCADE
            );
            INSERT INTO root VALUES (1);
            INSERT INTO middle VALUES (1);
            INSERT INTO leaf VALUES (1);
            UPDATE root SET id = 2 WHERE id = 1;
        `, { dialect: 'sqlite' });

        expect(r.errors()).toEqual([]);
        expect(r.rowsOf('root')).toEqual([{ id: 2 }]);
        expect(r.rowsOf('middle')).toEqual([{ id: 2 }]);
        expect(r.rowsOf('leaf')).toEqual([{ id: 2 }]);
    });

    it('rejects an ON UPDATE RESTRICT parent-key change without partial mutation', () => {
        const r = exec(`
            PRAGMA foreign_keys = ON;
            CREATE TABLE parent (id INTEGER PRIMARY KEY);
            CREATE TABLE child (
                id INTEGER PRIMARY KEY,
                parent_id INTEGER REFERENCES parent(id) ON UPDATE RESTRICT
            );
            INSERT INTO parent VALUES (1);
            INSERT INTO child VALUES (10, 1);
            UPDATE parent SET id = 2 WHERE id = 1;
        `, { dialect: 'sqlite' });

        expect(r.errors().some((entry) => /prevents updating.*RESTRICT/.test(entry.message))).toBe(true);
        expect(r.rowsOf('parent')).toEqual([{ id: 1 }]);
        expect(r.rowsOf('child')).toEqual([{ id: 10, parent_id: 1 }]);
    });
});

// ════════════════════════════════════════════════════════════════════════
// INSERT with subquery in VALUES
// ════════════════════════════════════════════════════════════════════════

describe('INSERT with subquery in VALUES', () => {
    it('(SELECT ...) scalar subquery resolves to first row/column', () => {
        const r = exec(`
            CREATE TABLE apps (id INT PRIMARY KEY, status TEXT);
            INSERT INTO apps VALUES (10, 'Approved'), (20, 'Pending'), (30, 'Approved');

            CREATE TABLE payments (app_id INT, amount NUMERIC);
            INSERT INTO payments (app_id, amount) VALUES (
                (SELECT id FROM apps WHERE status = 'Approved' LIMIT 1),
                120
            );
        `);
        const rows = r.rowsOf('payments');
        expect(rows).toHaveLength(1);
        expect(rows[0].app_id).toBe(10);
        expect(rows[0].amount).toBe(120);
    });

    it('multiple tuples each with their own subquery', () => {
        const r = exec(`
            CREATE TABLE apps (id INT PRIMARY KEY, status TEXT);
            INSERT INTO apps VALUES (10, 'Approved'), (20, 'Pending'), (30, 'Rejected');

            CREATE TABLE payments (app_id INT, amount NUMERIC);
            INSERT INTO payments (app_id, amount) VALUES
            (
                (SELECT id FROM apps WHERE status = 'Approved' LIMIT 1),
                100
            ),
            (
                (SELECT id FROM apps WHERE status = 'Pending' LIMIT 1),
                200
            );
        `);
        const rows = r.rowsOf('payments');
        expect(rows).toHaveLength(2);
        expect(rows[0].app_id).toBe(10);
        expect(rows[0].amount).toBe(100);
        expect(rows[1].app_id).toBe(20);
        expect(rows[1].amount).toBe(200);
    });

    it('subquery returning no rows resolves to NULL', () => {
        const r = exec(`
            CREATE TABLE apps (id INT PRIMARY KEY, status TEXT);
            INSERT INTO apps VALUES (10, 'Approved');

            CREATE TABLE payments (app_id INT, amount NUMERIC);
            INSERT INTO payments (app_id, amount) VALUES (
                (SELECT id FROM apps WHERE status = 'NonExistent' LIMIT 1),
                999
            );
        `);
        const rows = r.rowsOf('payments');
        expect(rows).toHaveLength(1);
        expect(rows[0].app_id).toBe(null);
        expect(rows[0].amount).toBe(999);
    });

    it('mixed literal and subquery values in same tuple', () => {
        const r = exec(`
            CREATE TABLE lookup (code TEXT PRIMARY KEY, val INT);
            INSERT INTO lookup VALUES ('tax', 15), ('fee', 5);

            CREATE TABLE orders (id INT, tax_rate INT, fee_rate INT, note TEXT);
            INSERT INTO orders VALUES (
                1,
                (SELECT val FROM lookup WHERE code = 'tax'),
                (SELECT val FROM lookup WHERE code = 'fee'),
                'test order'
            );
        `);
        const row = r.rowsOf('orders')[0];
        expect(row.id).toBe(1);
        expect(row.tax_rate).toBe(15);
        expect(row.fee_rate).toBe(5);
        expect(row.note).toBe('test order');
    });

    it('subquery with schema-qualified table name — exact user scenario', () => {
        const r = exec(`
            CREATE TABLE gov.Applications (ApplicationID INT PRIMARY KEY, Status TEXT);
            INSERT INTO gov.Applications VALUES (1, 'Approved'), (2, 'Pending');

            CREATE TABLE gov.Payments (ApplicationID INT, Amount NUMERIC);
            INSERT INTO gov.Payments (ApplicationID, Amount) VALUES
            (
                (SELECT ApplicationID FROM gov.Applications WHERE Status = 'Approved' LIMIT 1),
                120
            ),
            (
                (SELECT ApplicationID FROM gov.Applications WHERE Status = 'Pending' LIMIT 1),
                450
            );
        `);
        const rows = r.rowsOf('Payments');
        expect(rows).toHaveLength(2);
        expect(rows[0].ApplicationID).toBe(1);
        expect(rows[0].Amount).toBe(120);
        expect(rows[1].ApplicationID).toBe(2);
        expect(rows[1].Amount).toBe(450);
    });
});

// ════════════════════════════════════════════════════════════════════════
// GENERATED ALWAYS AS (...) STORED — computed column evaluation
// ════════════════════════════════════════════════════════════════════════

describe('GENERATED ALWAYS AS (...) STORED', () => {
    it('simple multiplication: Income * TaxRate', () => {
        const r = exec(`
            CREATE TABLE tax (
                id INT PRIMARY KEY,
                Income NUMERIC,
                TaxRate NUMERIC,
                TaxAmount NUMERIC GENERATED ALWAYS AS (Income * TaxRate) STORED
            );
            INSERT INTO tax (id, Income, TaxRate) VALUES (1, 120000, 0.15);
            INSERT INTO tax (id, Income, TaxRate) VALUES (2, 90000, 0.12);
        `);
        const rows = r.rowsOf('tax');
        expect(rows).toHaveLength(2);
        expect(rows[0].TaxAmount).toBe(18000);
        expect(rows[1].TaxAmount).toBe(10800);
    });

    it('addition and subtraction: Price - Discount + Tax', () => {
        const r = exec(`
            CREATE TABLE orders (
                id INT PRIMARY KEY,
                Price NUMERIC,
                Discount NUMERIC,
                Tax NUMERIC,
                Total NUMERIC GENERATED ALWAYS AS (Price - Discount + Tax) STORED
            );
            INSERT INTO orders (id, Price, Discount, Tax) VALUES (1, 100, 10, 5);
        `);
        expect(r.rowsOf('orders')[0].Total).toBe(95);
    });

    it('NULL propagation: NULL input produces NULL', () => {
        const r = exec(`
            CREATE TABLE calc (
                id INT PRIMARY KEY,
                a NUMERIC,
                b NUMERIC,
                product NUMERIC GENERATED ALWAYS AS (a * b) STORED
            );
            INSERT INTO calc (id, a, b) VALUES (1, 100, NULL);
        `);
        expect(r.rowsOf('calc')[0].product).toBe(null);
    });

    it('complex expression: (qty * price) * (1 - discount_pct)', () => {
        const r = exec(`
            CREATE TABLE line_items (
                id INT PRIMARY KEY,
                qty INT,
                price NUMERIC,
                discount_pct NUMERIC,
                net_total NUMERIC GENERATED ALWAYS AS (qty * price * (1 - discount_pct)) STORED
            );
            INSERT INTO line_items (id, qty, price, discount_pct) VALUES (1, 5, 200, 0.10);
        `);
        expect(r.rowsOf('line_items')[0].net_total).toBe(900);
    });

    it('generated column stays in sync after UPDATE', () => {
        const r = exec(`
            CREATE TABLE products (
                id INT PRIMARY KEY,
                base_price NUMERIC,
                markup NUMERIC,
                final_price NUMERIC GENERATED ALWAYS AS (base_price * markup) STORED
            );
            INSERT INTO products (id, base_price, markup) VALUES (1, 100, 1.5);
            UPDATE products SET base_price = 200 WHERE id = 1;
        `);
        const row = r.rowsOf('products')[0];
        expect(row.base_price).toBe(200);
        expect(row.final_price).toBe(300); // 200 * 1.5
    });

    it('exact government scenario: TaxRecords with partitioned-style table', () => {
        const r = exec(`
            CREATE TABLE Citizens (
                CitizenID INT PRIMARY KEY,
                NationalID VARCHAR(20) UNIQUE NOT NULL,
                FullName VARCHAR(150) NOT NULL
            );
            INSERT INTO Citizens VALUES (1, 'SG123456A', 'John Tan');
            INSERT INTO Citizens VALUES (2, 'SG654321B', 'Alice Lim');

            CREATE TABLE TaxRecords (
                TaxID INT PRIMARY KEY,
                CitizenID INT REFERENCES Citizens(CitizenID),
                Income NUMERIC,
                TaxRate NUMERIC CHECK (TaxRate >= 0),
                TaxAmount NUMERIC GENERATED ALWAYS AS (Income * TaxRate) STORED,
                TaxYear INT NOT NULL
            );
            INSERT INTO TaxRecords (TaxID, CitizenID, Income, TaxRate, TaxYear) VALUES (1, 1, 120000, 0.15, 2024);
            INSERT INTO TaxRecords (TaxID, CitizenID, Income, TaxRate, TaxYear) VALUES (2, 1, 135000, 0.18, 2025);
            INSERT INTO TaxRecords (TaxID, CitizenID, Income, TaxRate, TaxYear) VALUES (3, 2, 90000, 0.12, 2024);
        `);
        const rows = r.rowsOf('TaxRecords');
        expect(rows).toHaveLength(3);
        expect(rows[0].TaxAmount).toBe(18000);   // 120000 * 0.15
        expect(rows[1].TaxAmount).toBe(24300);   // 135000 * 0.18
        expect(rows[2].TaxAmount).toBe(10800);   // 90000 * 0.12
    });
});
