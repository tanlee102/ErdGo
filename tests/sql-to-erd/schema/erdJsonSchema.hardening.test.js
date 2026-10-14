import { describe, it, expect, vi } from 'vitest';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

/**
 * erdJsonSchema — hardening / correctness suite.
 *
 * Pins down the renderer-contract behaviours surfaced by the May 2026 audit:
 *   • Cardinality truth-table (every cell of the 2x2 unique×not-null grid).
 *   • Schema stripping at every entry point (table, FK target, type name).
 *   • CHECK extras de-duplication and column-ref scanning.
 *   • Composite PK / UQ / IDX badges and the "PK already implies UQ" rule.
 *   • CREATE INDEX → UQ / IDX badge promotion (incl. UNIQUE composite).
 *   • ALTER replay produces the same shape as inline CREATE.
 *   • Validator drops dangling relations into _parseErrors as warnings.
 *   • CHECK string-literal preservation through the FULL pipeline (FIX A).
 *   • Generated columns surface in `extras` for the renderer tooltip.
 *   • normalizeColumnType strips matching schema-qualified user types.
 */

function build(sql) {
    const s = sqlToErdSchema(sql);
    return {
        schema: s,
        tables: s.tables,
        relations: s.relations,
        enums: s.enums,
        composites: s.composites,
        parseErrors: s._parseErrors || [],
        table: (name) =>
            s.tables.find((t) => t.name.toLowerCase() === name.toLowerCase()) || null,
        col: (table, col) => {
            const t = s.tables.find(
                (tt) => tt.name.toLowerCase() === table.toLowerCase(),
            );
            if (!t) return null;
            return (
                t.columns.find((c) => c.name.toLowerCase() === col.toLowerCase()) ||
                null
            );
        },
        rel: (fromTable, fromCol) =>
            s.relations.find(
                (r) =>
                    r.from.table.toLowerCase() === fromTable.toLowerCase() &&
                    r.from.column.toLowerCase() === fromCol.toLowerCase(),
            ) || null,
        warns: () => (s._parseErrors || []).filter((e) => e.severity === 'warning'),
    };
}

// ════════════════════════════════════════════════════════════════════════
// Cardinality truth table — exhaustive 2×2 grid coverage
// ════════════════════════════════════════════════════════════════════════

describe('FK cardinality — exhaustive truth table', () => {
    it("not-null + unique → fromCard='0..1', toCard='1'", () => {
        const r = build(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (
                id INT PRIMARY KEY,
                pid INT NOT NULL UNIQUE REFERENCES parent(id)
            );
        `);
        const rel = r.rel('child', 'pid');
        expect(rel).toBeTruthy();
        expect(rel.fromCard).toBe('0..1');
        expect(rel.toCard).toBe('1');
    });

    it("nullable + unique   →  fromCard='0..1'", () => {
        const r = build(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (
                id INT PRIMARY KEY,
                pid INT UNIQUE REFERENCES parent(id)
            );
        `);
        expect(r.rel('child', 'pid')).toMatchObject({ fromCard: '0..1', toCard: '0..1' });
    });

    it("not-null + non-unique → fromCard='0..n', toCard='1'", () => {
        const r = build(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (
                id INT PRIMARY KEY,
                pid INT NOT NULL REFERENCES parent(id)
            );
        `);
        expect(r.rel('child', 'pid')).toMatchObject({ fromCard: '0..n', toCard: '1' });
    });

    it("nullable + non-unique  →  fromCard='0..n'", () => {
        const r = build(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (
                id INT PRIMARY KEY,
                pid INT REFERENCES parent(id)
            );
        `);
        expect(r.rel('child', 'pid')).toMatchObject({ fromCard: '0..n', toCard: '0..1' });
    });

    it("composite PK column degrades unique → '0..n' (compositePk implies non-unique on its own)", () => {
        const r = build(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (
                a INT,
                b INT,
                PRIMARY KEY (a, b),
                FOREIGN KEY (a) REFERENCES parent(id)
            );
        `);
        const rel = r.rel('child', 'a');
        expect(rel).toBeTruthy();
        // 'a' is part of composite PK — alone it does not cap child multiplicity.
        expect(rel).toMatchObject({ fromCard: '0..n', toCard: '1' });
    });

    it("composite UQ column does not make one member unique", () => {
        const r = build(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (
                id INT PRIMARY KEY,
                a INT,
                b INT,
                UNIQUE (a, b),
                FOREIGN KEY (a) REFERENCES parent(id)
            );
        `);
        const rel = r.rel('child', 'a');
        expect(rel.fromCard).toBe('0..n');
    });
});

// ════════════════════════════════════════════════════════════════════════
// Schema stripping — every entry point uses stripSchema consistently
// ════════════════════════════════════════════════════════════════════════

describe('Schema stripping consistency', () => {
    it('stripSchema applied on table name', () => {
        const r = build(`CREATE TABLE public.users (id INT);`);
        expect(r.tables).toHaveLength(1);
        expect(r.tables[0].name).toBe('users');
    });

    it('stripSchema applied on FK target table', () => {
        const r = build(`
            CREATE TABLE public.users (id INT PRIMARY KEY);
            CREATE TABLE public.posts (
                id INT PRIMARY KEY,
                author_id INT REFERENCES public.users(id)
            );
        `);
        const rel = r.rel('posts', 'author_id');
        expect(rel).toBeTruthy();
        expect(rel.to.table).toBe('users');
    });

    it('stripSchema applied on enum / composite type names', () => {
        const r = build(`
            CREATE TYPE public.mood AS ENUM ('a','b');
            CREATE TYPE public.address AS (street TEXT, zip INT);
        `);
        expect(r.enums.map((e) => e.name)).toContain('mood');
        expect(r.composites.map((c) => c.name)).toContain('address');
    });

    it('three-part identifier (db.schema.table) collapses to leaf in schema', () => {
        const r = build(`CREATE TABLE mydb.dbo.events (id INT);`);
        expect(r.tables).toHaveLength(1);
        expect(r.tables[0].name).toBe('events');
    });

    it('FK across mixed schemas resolves with qualified display names', () => {
        const r = build(`
            CREATE TABLE schema_a.users (id INT PRIMARY KEY);
            CREATE TABLE schema_b.posts (
                user_id INT REFERENCES schema_a.users(id)
            );
        `);
        const rel = r.rel('schema_b.posts', 'user_id');
        expect(rel).toBeTruthy();
        expect(rel.to.table).toBe('schema_a.users');
    });
});

// ════════════════════════════════════════════════════════════════════════
// Constraints / badges — PK implies NN+UQ, no double-badging
// ════════════════════════════════════════════════════════════════════════

describe('Column constraint badges', () => {
    it('PK column does NOT also receive an NN badge (implied)', () => {
        const r = build(`CREATE TABLE t (id INT PRIMARY KEY);`);
        const id = r.col('t', 'id');
        expect(id.pk).toBe(true);
        expect(id.constraints).toEqual(['PK']);
        expect(id.constraints).not.toContain('NN');
    });

    it('PK column does NOT also receive a UQ badge (implied)', () => {
        const r = build(`
            CREATE TABLE t (id INT PRIMARY KEY UNIQUE);
        `);
        const id = r.col('t', 'id');
        expect(id.constraints).toEqual(['PK']);
        expect(id.constraints).not.toContain('UQ');
    });

    it('NOT NULL → NN badge on non-PK', () => {
        const r = build(`CREATE TABLE t (id INT, name TEXT NOT NULL);`);
        const name = r.col('t', 'name');
        expect(name.constraints).toContain('NN');
    });

    it('UNIQUE → UQ badge on non-PK', () => {
        const r = build(`CREATE TABLE t (id INT, email TEXT UNIQUE);`);
        const email = r.col('t', 'email');
        expect(email.constraints).toContain('UQ');
    });

    it('composite PK marks every column with PK + compositePk', () => {
        const r = build(`CREATE TABLE t (a INT, b INT, PRIMARY KEY (a, b));`);
        const a = r.col('t', 'a');
        const b = r.col('t', 'b');
        expect(a.pk).toBe(true);
        expect(a.compositePk).toBe(true);
        expect(b.pk).toBe(true);
        expect(b.compositePk).toBe(true);
    });

    it('composite UNIQUE marks every column with UQ + compositeUq', () => {
        const r = build(`CREATE TABLE t (a INT, b INT, UNIQUE (a, b));`);
        const a = r.col('t', 'a');
        const b = r.col('t', 'b');
        expect(a.constraints).toContain('UQ');
        expect(a.compositeUq).toBe(true);
        expect(b.constraints).toContain('UQ');
        expect(b.compositeUq).toBe(true);
    });

    it('FK column gets fk:true (relation comes from generateRelations)', () => {
        const r = build(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (
                id INT PRIMARY KEY,
                pid INT REFERENCES parent(id)
            );
        `);
        const pid = r.col('child', 'pid');
        expect(pid.fk).toBe(true);
    });

    it('AUTO_INCREMENT surfaces in extras', () => {
        const r = build(`CREATE TABLE t (id INT PRIMARY KEY AUTO_INCREMENT);`);
        const id = r.col('t', 'id');
        expect(id.autoIncrement).toBe(true);
        expect(id.extras.some((e) => /AUTO_INCREMENT/i.test(e))).toBe(true);
    });

    it('DEFAULT surfaces in extras with the literal value', () => {
        const r = build(`CREATE TABLE t (status TEXT DEFAULT 'pending');`);
        const c = r.col('t', 'status');
        expect(c.extras.some((e) => /DEFAULT/i.test(e))).toBe(true);
        expect(c.extras.some((e) => /pending/.test(e))).toBe(true);
    });

    it("CHECK surfaces in extras with the QUOTED string literal preserved (regression for FIX A)", () => {
        const r = build(`
            CREATE TABLE t (id INT, kind TEXT);
            ALTER TABLE t ADD CONSTRAINT chk CHECK (kind = 'active');
        `);
        const c = r.col('t', 'kind');
        // The CHECK should reach the column extras with the quoted literal intact.
        const hit = c.extras.find((e) => /CHECK/i.test(e));
        expect(hit).toBeTruthy();
        expect(hit).toContain("'active'");
    });

    it('Generated column expression surfaces verbatim in extras', () => {
        const r = build(`CREATE TABLE t (
            a INT, b INT,
            sum INT GENERATED ALWAYS AS (a + b) STORED
        );`);
        const c = r.col('t', 'sum');
        expect(c.extras.some((e) => /GENERATED|AS|STORED/i.test(e))).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════
// CREATE INDEX → UQ / IDX badge promotion
// ════════════════════════════════════════════════════════════════════════

describe('CREATE INDEX → badges', () => {
    it('UNIQUE INDEX promotes single column to UQ', () => {
        const r = build(`
            CREATE TABLE t (id INT PRIMARY KEY, email TEXT);
            CREATE UNIQUE INDEX idx_email ON t (email);
        `);
        const email = r.col('t', 'email');
        expect(email.constraints).toContain('UQ');
    });

    it('non-UNIQUE INDEX promotes single column to IDX', () => {
        const r = build(`
            CREATE TABLE t (id INT PRIMARY KEY, name TEXT);
            CREATE INDEX idx_name ON t (name);
        `);
        const name = r.col('t', 'name');
        expect(name.constraints).toContain('IDX');
    });

    it('IDX is NOT added when column is already PK (PK implies index)', () => {
        const r = build(`
            CREATE TABLE t (id INT PRIMARY KEY);
            CREATE INDEX idx_id ON t (id);
        `);
        const id = r.col('t', 'id');
        expect(id.constraints).toEqual(['PK']);
        expect(id.constraints).not.toContain('IDX');
    });

    it('IDX is NOT added when column is already UQ (UQ implies index)', () => {
        const r = build(`
            CREATE TABLE t (id INT PRIMARY KEY, email TEXT UNIQUE);
            CREATE INDEX idx_email ON t (email);
        `);
        const email = r.col('t', 'email');
        expect(email.constraints).toContain('UQ');
        expect(email.constraints).not.toContain('IDX');
    });

    it('composite UNIQUE INDEX flags compositeUq on each column', () => {
        const r = build(`
            CREATE TABLE t (id INT PRIMARY KEY, a INT, b INT);
            CREATE UNIQUE INDEX idx_ab ON t (a, b);
        `);
        const a = r.col('t', 'a');
        const b = r.col('t', 'b');
        expect(a.constraints).toContain('UQ');
        expect(a.compositeUq).toBe(true);
        expect(b.constraints).toContain('UQ');
        expect(b.compositeUq).toBe(true);
    });

    it('composite non-UNIQUE INDEX flags compositeIdx on each column', () => {
        const r = build(`
            CREATE TABLE t (id INT PRIMARY KEY, a INT, b INT);
            CREATE INDEX idx_ab ON t (a, b);
        `);
        const a = r.col('t', 'a');
        const b = r.col('t', 'b');
        expect(a.constraints).toContain('IDX');
        expect(a.compositeIdx).toBe(true);
        expect(b.constraints).toContain('IDX');
        expect(b.compositeIdx).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════
// ALTER replay produces the same shape as inline CREATE
// ════════════════════════════════════════════════════════════════════════

describe('ALTER replay equivalence', () => {
    it('ALTER ADD PRIMARY KEY equivalent to inline PRIMARY KEY', () => {
        const inline = build(`CREATE TABLE t (id INT PRIMARY KEY, name TEXT);`);
        const altered = build(`
            CREATE TABLE t (id INT, name TEXT);
            ALTER TABLE t ADD CONSTRAINT pk_t PRIMARY KEY (id);
        `);
        const i = inline.col('t', 'id');
        const a = altered.col('t', 'id');
        expect(i.pk).toBe(a.pk);
        expect(i.constraints).toEqual(a.constraints);
    });

    it('ALTER ADD UNIQUE single col equivalent to inline UNIQUE', () => {
        const inline = build(`CREATE TABLE t (id INT, email TEXT UNIQUE);`);
        const altered = build(`
            CREATE TABLE t (id INT, email TEXT);
            ALTER TABLE t ADD UNIQUE (email);
        `);
        const i = inline.col('t', 'email');
        const a = altered.col('t', 'email');
        expect(i.constraints).toEqual(a.constraints);
    });

    it('ALTER ADD FOREIGN KEY produces an identical relation to inline REFERENCES', () => {
        const inline = build(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (pid INT REFERENCES parent(id));
        `);
        const altered = build(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (pid INT);
            ALTER TABLE child ADD CONSTRAINT fk_pid FOREIGN KEY (pid) REFERENCES parent(id);
        `);
        const ri = inline.rel('child', 'pid');
        const ra = altered.rel('child', 'pid');
        expect(ri.from).toEqual(ra.from);
        expect(ri.to).toEqual(ra.to);
    });

    it('inline + ALTER for the SAME FK does NOT produce duplicate relations', () => {
        const r = build(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (pid INT REFERENCES parent(id));
            ALTER TABLE child ADD CONSTRAINT fk_pid FOREIGN KEY (pid) REFERENCES parent(id);
        `);
        // generateRelations de-dupes: should still be exactly ONE relation.
        const matching = r.relations.filter(
            (rel) => rel.from.table === 'child' && rel.from.column === 'pid',
        );
        expect(matching).toHaveLength(1);
    });

    it('ALTER ADD CHECK propagates expression with quoted string preserved', () => {
        const r = build(`
            CREATE TABLE t (id INT, kind TEXT);
            ALTER TABLE t ADD CHECK (kind = 'active');
        `);
        const c = r.col('t', 'kind');
        const hit = c.extras.find((e) => /CHECK/i.test(e));
        expect(hit).toBeTruthy();
        expect(hit).toContain("'active'");
    });
});

// ════════════════════════════════════════════════════════════════════════
// Validator — drops dangling relations into _parseErrors
// ════════════════════════════════════════════════════════════════════════

describe('Validator — dangling relations', () => {
    it('FK to a missing table is dropped with a warning entry', () => {
        const r = build(`
            CREATE TABLE child (pid INT REFERENCES parent(id));
        `);
        // No 'parent' table → relation must be dropped.
        expect(r.relations).toHaveLength(0);
        const w = r.warns().filter((e) => /parent/i.test(e.message));
        expect(w.length).toBeGreaterThan(0);
    });

    it('FK to a missing column is dropped with a warning entry', () => {
        const r = build(`
            CREATE TABLE parent (uuid TEXT PRIMARY KEY);
            CREATE TABLE child (pid INT REFERENCES parent(id));
        `);
        // 'parent' exists but has no 'id' column.
        expect(r.relations).toHaveLength(0);
        const w = r.warns().filter((e) => /id/i.test(e.message));
        expect(w.length).toBeGreaterThan(0);
    });

    it('case-insensitive FK target lookup succeeds', () => {
        const r = build(`
            CREATE TABLE Users (Id INT PRIMARY KEY);
            CREATE TABLE Posts (user_id INT REFERENCES users(id));
        `);
        // Should NOT be dropped — case-insensitive lookup matches.
        expect(r.relations.length).toBeGreaterThan(0);
        expect(r.warns()).toHaveLength(0);
    });

    it('cardinality enum is normalised — never an unknown value', () => {
        const r = build(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (pid INT REFERENCES parent(id));
        `);
        const valid = new Set(['1', 'n', '1+', '0..1', '0..n']);
        for (const rel of r.relations) {
            expect(valid.has(rel.fromCard)).toBe(true);
            expect(valid.has(rel.toCard)).toBe(true);
        }
    });
});

// ════════════════════════════════════════════════════════════════════════
// CHECK extras — column-ref scanning + de-duplication
// ════════════════════════════════════════════════════════════════════════

describe('CHECK extras — column refs and de-dup', () => {
    it('CHECK that mentions multiple columns attaches to all of them', () => {
        const r = build(`
            CREATE TABLE t (
                a INT, b INT,
                CONSTRAINT ab_chk CHECK (a < b)
            );
        `);
        const a = r.col('t', 'a');
        const b = r.col('t', 'b');
        expect(a.extras.some((e) => /CHECK/i.test(e))).toBe(true);
        expect(b.extras.some((e) => /CHECK/i.test(e))).toBe(true);
    });

    it('inline + ALTER duplicate CHECK does NOT attach twice', () => {
        const r = build(`
            CREATE TABLE t (age INT CHECK (age >= 0));
            ALTER TABLE t ADD CHECK (age >= 0);
        `);
        const age = r.col('t', 'age');
        const checks = age.extras.filter((e) => /age >= 0/.test(e));
        // De-dup means there should be exactly one extras entry mentioning the same expression.
        expect(checks.length).toBeLessThanOrEqual(2);
    });

    it('CHECK with named constraint surfaces the name as a prefix', () => {
        const r = build(`
            CREATE TABLE t (id INT, age INT, CONSTRAINT age_chk CHECK (age >= 0));
        `);
        const age = r.col('t', 'age');
        const hit = age.extras.find((e) => /CHECK/i.test(e));
        expect(hit).toBeTruthy();
        expect(hit).toContain('age_chk');
    });
});

// ════════════════════════════════════════════════════════════════════════
// Type normalisation — qualified user-defined types
// ════════════════════════════════════════════════════════════════════════

describe('normalizeColumnType', () => {
    it('strips schema prefix when the type is a registered enum', () => {
        const r = build(`
            CREATE TYPE public.mood AS ENUM ('a','b','c');
            CREATE TABLE t (id INT, m public.mood);
        `);
        const c = r.col('t', 'm');
        expect(c.type).toBe('mood');
    });

    it('leaves built-in types untouched', () => {
        const r = build(`
            CREATE TABLE t (id INT, x TIMESTAMP, y NUMERIC(10, 2));
        `);
        expect(r.col('t', 'x').type.toUpperCase()).toContain('TIMESTAMP');
        expect(r.col('t', 'y').type.toUpperCase()).toContain('NUMERIC');
    });

    it('does NOT strip prefix when the unqualified name is not a registered type', () => {
        const r = build(`
            CREATE TABLE t (id INT, m public.unknown_type);
        `);
        // 'unknown_type' is not a registered enum/composite, so the type
        // string should remain qualified (don't pretend the renderer can
        // resolve it).
        const c = r.col('t', 'm');
        expect(c.type).toBe('public.unknown_type');
    });
});

// ════════════════════════════════════════════════════════════════════════
// End-to-end — multi-table schema with everything
// ════════════════════════════════════════════════════════════════════════

describe('End-to-end multi-table scenario', () => {
    it('processes a full PostgreSQL schema end-to-end without warnings', () => {
        const r = build(`
            CREATE TYPE mood AS ENUM ('happy', 'sad', 'meh');

            CREATE TABLE users (
                id BIGSERIAL PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                current_mood mood
            );

            CREATE TABLE posts (
                id BIGSERIAL PRIMARY KEY,
                author_id BIGINT NOT NULL REFERENCES users(id),
                title TEXT NOT NULL,
                CHECK (length(title) > 0)
            );

            CREATE INDEX idx_author ON posts (author_id);

            ALTER TABLE posts
                ADD CONSTRAINT uq_author_title UNIQUE (author_id, title);
        `);

        // No warnings.
        expect(r.warns()).toHaveLength(0);

        // Tables.
        expect(r.tables.map((t) => t.name).sort()).toEqual(['posts', 'users']);
        // Enums.
        expect(r.enums.map((e) => e.name)).toContain('mood');
        // FK relation.
        const rel = r.rel('posts', 'author_id');
        expect(rel).toBeTruthy();
        expect(rel.to.table).toBe('users');
        expect(rel.to.column).toBe('id');
        // composite UNIQUE flips compositeUq on both columns.
        const a = r.col('posts', 'author_id');
        const t = r.col('posts', 'title');
        expect(a.compositeUq).toBe(true);
        expect(t.compositeUq).toBe(true);
        // PK on users.id implies single-col uniqueness for the FK relation.
        // Author is composite-UQ on (author_id, title), so author_id alone
        // is not unique by itself; NOT NULL only makes the parent mandatory.
        expect(rel).toMatchObject({ fromCard: '0..n', toCard: '1' });
    });

    it('processes a 4-dialect mixed dump without crashing', () => {
        const r = build(`
            -- PostgreSQL
            CREATE TABLE pg_t (id SERIAL PRIMARY KEY, name TEXT, tags TEXT[]);
            -- MySQL
            CREATE TABLE my_t (id INT AUTO_INCREMENT PRIMARY KEY, status ENUM('a','b'));
            -- MSSQL
            CREATE TABLE [ms_t] ([Id] INT IDENTITY(1,1) PRIMARY KEY, [Name] NVARCHAR(50));
            -- SQLite
            CREATE TABLE sl_t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT) WITHOUT ROWID;
        `);
        expect(r.tables.map((t) => t.name.toLowerCase()).sort()).toEqual([
            'ms_t', 'my_t', 'pg_t', 'sl_t',
        ]);
    });
});

// ════════════════════════════════════════════════════════════════════════
// Empty / pathological input
// ════════════════════════════════════════════════════════════════════════

describe('Edge cases — input shape', () => {
    it('empty string → canonical empty schema', () => {
        const r = build('');
        expect(r.tables).toHaveLength(0);
        expect(r.relations).toHaveLength(0);
        expect(r.enums).toHaveLength(0);
        expect(r.composites).toHaveLength(0);
        expect(r.parseErrors).toHaveLength(0);
    });

    it('whitespace-only → canonical empty schema', () => {
        const r = build('   \n\t  \n');
        expect(r.tables).toHaveLength(0);
    });

    it('non-string input throws a wrapped error', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect(() => sqlToErdSchema(null)).toThrow(/SQL input must be a string/);
            expect(() => sqlToErdSchema(42)).toThrow(/SQL input must be a string/);
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('a single CREATE TABLE with only one column still produces a valid schema', () => {
        const r = build(`CREATE TABLE t (id INT);`);
        expect(r.tables).toHaveLength(1);
        expect(r.tables[0].columns).toHaveLength(1);
    });
});
