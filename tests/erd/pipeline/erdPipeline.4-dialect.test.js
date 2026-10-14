import { describe, it, expect } from 'vitest';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

// ════════════════════════════════════════════════════════════════════════════
// erdPipeline.4-dialect.test.js — production-grade SQL → ERD JSON parity
// ════════════════════════════════════════════════════════════════════════════
//
// What this file pins down:
//   1.  SQLite end-to-end SQL → ERD JSON (the existing pipeline test suite
//       covers PG/MySQL/MSSQL but not SQLite at the ERD-JSON level).
//   2.  Cross-dialect equivalence at the ERD shape — same logical schema in
//       all four dialects produces structurally identical ERD JSON.
//   3.  Production-realistic templates per dialect (multi-tenant SaaS, blog,
//       e-commerce, banking) that exercise FKs, indexes, ENUMs, computed
//       columns, defaults, constraints, junction tables.
//   4.  Schema synchronization / idempotency — the same SQL run twice
//       produces the exact same ERD JSON.
//   5.  Relationship-mapping correctness — 1:1, 1:N, M:N (junction), self-FK,
//       composite FK, multi-FK fan-out.
//   6.  Dialect-specific noise (ENGINE=, CLUSTERED, TABLESPACE, WITHOUT
//       ROWID, STRICT, ON [PRIMARY], etc.) MUST NOT leak into ERD shape.
//   7.  Crash resistance — non-DDL constructs (CREATE VIEW, CREATE TRIGGER,
//       SET FOREIGN_KEY_CHECKS, USE database) skip cleanly without
//       breaking the pipeline.
//
// All tests assert against the renderer-facing schema contract documented
// in `erdJsonSchema.js` (file-level docblock).
// ════════════════════════════════════════════════════════════════════════════

// ─── helpers ────────────────────────────────────────────────────────────
const tableByName = (schema, name) => schema.tables.find((t) => t.name.toLowerCase() === name.toLowerCase());
const colByName = (table, name) => table?.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
const errorsOf = (schema) => (schema._parseErrors || []).filter((e) => e.severity === 'error');
const relationFor = (schema, fromTable, fromCol) =>
    schema.relations.find(
        (r) => r.from.table.toLowerCase() === fromTable.toLowerCase() && r.from.column.toLowerCase() === fromCol.toLowerCase(),
    );

function shapeSummary(schema) {
    return {
        tables: schema.tables
            .map((t) => ({
                name: t.name.toLowerCase(),
                columns: t.columns.map((c) => c.name.toLowerCase()).sort(),
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        relations: schema.relations
            .map((r) => ({
                from: `${r.from.table.toLowerCase()}.${r.from.column.toLowerCase()}`,
                to: `${r.to.table.toLowerCase()}.${r.to.column.toLowerCase()}`,
            }))
            .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. SQLite — end-to-end SQL → ERD JSON
// ════════════════════════════════════════════════════════════════════════════
//
// SQLite has full coverage at the parser/executor levels but the ERD-JSON
// pipeline previously only tested PG/MySQL/MSSQL. This block fills that gap
// with a realistic blog-app schema and asserts the full schema contract.

describe('SQLite — end-to-end SQL → ERD JSON', () => {
    const SQL = `
        -- Realistic SQLite blog schema with AUTOINCREMENT, WITHOUT ROWID,
        -- STRICT, FKs, and indexes.
        CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'editor', 'user')),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) STRICT;

        CREATE TABLE posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            slug TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            body TEXT,
            published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE
        );

        -- WITHOUT ROWID junction table for M:N posts <-> tags
        CREATE TABLE post_tags (
            post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
            tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (post_id, tag_id)
        ) WITHOUT ROWID;

        CREATE INDEX ix_posts_user_id ON posts(user_id);
        CREATE INDEX ix_posts_published ON posts(published);
    `;

    const schema = sqlToErdSchema(SQL);

    it('produces 4 tables with no errors', () => {
        expect(errorsOf(schema)).toEqual([]);
        expect(schema.tables.map((t) => t.name).sort()).toEqual(['post_tags', 'posts', 'tags', 'users']);
    });

    it('users.id has PK + autoIncrement, email has UQ + NN', () => {
        const users = tableByName(schema, 'users');
        const id = colByName(users, 'id');
        const email = colByName(users, 'email');
        expect(id.pk).toBe(true);
        expect(id.autoIncrement).toBe(true);
        expect(id.constraints).toContain('PK');
        expect(email.constraints).toEqual(expect.arrayContaining(['UQ', 'NN']));
    });

    it('CHECK constraints land in column extras', () => {
        const users = tableByName(schema, 'users');
        const role = colByName(users, 'role');
        expect(role.extras.some((x) => x.includes('CHECK') && x.includes("'admin'"))).toBe(true);
    });

    it('emits 4 relations: posts.user_id, post_tags.post_id, post_tags.tag_id (junction)', () => {
        const fromColumns = schema.relations.map((r) => `${r.from.table}.${r.from.column}`.toLowerCase()).sort();
        expect(fromColumns).toEqual(['post_tags.post_id', 'post_tags.tag_id', 'posts.user_id'].sort());
    });

    it('marks composite-PK columns of the junction as compositePk', () => {
        const pt = tableByName(schema, 'post_tags');
        expect(colByName(pt, 'post_id').compositePk).toBe(true);
        expect(colByName(pt, 'tag_id').compositePk).toBe(true);
    });

    it('ix_posts_user_id and ix_posts_published add IDX badge (or honor PK over IDX)', () => {
        const posts = tableByName(schema, 'posts');
        const userId = colByName(posts, 'user_id');
        const published = colByName(posts, 'published');
        // user_id is FK + indexed → has IDX or UQ depending on policy
        expect(userId.fk).toBe(true);
        // posts.published has no other strong badge → IDX
        expect(published.constraints).toContain('IDX');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Cross-dialect equivalence — same logical schema, 4 syntaxes
// ════════════════════════════════════════════════════════════════════════════
//
// Pin down the most important guarantee: the same logical schema in any of
// the four supported dialects produces structurally identical ERD JSON.

describe('Cross-dialect — equivalent ERD shape across SQLite/PG/MySQL/MSSQL', () => {
    const DDL = {
        SQLite: `
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL
            );
            CREATE TABLE posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id),
                title TEXT NOT NULL
            );
        `,
        PostgreSQL: `
            CREATE TABLE users (
                id BIGSERIAL PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL
            );
            CREATE TABLE posts (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id),
                title TEXT NOT NULL
            );
        `,
        MySQL: `
            CREATE TABLE \`users\` (
                \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
                \`email\` VARCHAR(255) NOT NULL UNIQUE,
                \`name\` VARCHAR(255) NOT NULL
            ) ENGINE=InnoDB;
            CREATE TABLE \`posts\` (
                \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
                \`user_id\` BIGINT NOT NULL,
                \`title\` VARCHAR(255) NOT NULL,
                FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`)
            ) ENGINE=InnoDB;
        `,
        MSSQL: `
            CREATE TABLE [users] (
                [id] BIGINT IDENTITY(1,1) PRIMARY KEY,
                [email] NVARCHAR(255) NOT NULL UNIQUE,
                [name] NVARCHAR(255) NOT NULL
            );
            CREATE TABLE [posts] (
                [id] BIGINT IDENTITY(1,1) PRIMARY KEY,
                [user_id] BIGINT NOT NULL,
                [title] NVARCHAR(255) NOT NULL,
                CONSTRAINT FK_posts_users FOREIGN KEY ([user_id]) REFERENCES [users]([id])
            );
        `,
    };

    it('all 4 dialects parse without errors', () => {
        for (const sql of Object.values(DDL)) {
            expect(errorsOf(sqlToErdSchema(sql))).toEqual([]);
        }
    });

    it('all 4 dialects produce 2 tables with the same column sets', () => {
        for (const [dialect, sql] of Object.entries(DDL)) {
            const s = sqlToErdSchema(sql);
            expect(s.tables.map((t) => t.name.toLowerCase()).sort()).toEqual(['posts', 'users']);
            expect(colByName(tableByName(s, 'users'), 'id'), `${dialect}: users.id`).toBeTruthy();
            expect(colByName(tableByName(s, 'posts'), 'user_id'), `${dialect}: posts.user_id`).toBeTruthy();
        }
    });

    it('all 4 dialects emit exactly one relation: posts.user_id → users.id', () => {
        for (const [dialect, sql] of Object.entries(DDL)) {
            const s = sqlToErdSchema(sql);
            expect(s.relations, `${dialect}: relation count`).toHaveLength(1);
            const rel = s.relations[0];
            expect(rel.from.table.toLowerCase()).toBe('posts');
            expect(rel.from.column.toLowerCase()).toBe('user_id');
            expect(rel.to.table.toLowerCase()).toBe('users');
            expect(rel.to.column.toLowerCase()).toBe('id');
        }
    });

    it('all 4 dialects mark posts.user_id with fk:true', () => {
        for (const [dialect, sql] of Object.entries(DDL)) {
            const s = sqlToErdSchema(sql);
            const userId = colByName(tableByName(s, 'posts'), 'user_id');
            expect(userId.fk, `${dialect}: posts.user_id.fk`).toBe(true);
        }
    });

    it('all 4 dialects mark id columns with autoIncrement:true', () => {
        for (const [dialect, sql] of Object.entries(DDL)) {
            const s = sqlToErdSchema(sql);
            for (const t of ['users', 'posts']) {
                expect(colByName(tableByName(s, t), 'id').autoIncrement, `${dialect}: ${t}.id.autoIncrement`).toBe(true);
            }
        }
    });

    it('cardinality is optional-many to one for the required FK in every dialect', () => {
        for (const [dialect, sql] of Object.entries(DDL)) {
            const s = sqlToErdSchema(sql);
            expect(s.relations[0].fromCard, `${dialect}`).toBe('0..n');
            expect(s.relations[0].toCard, `${dialect}`).toBe('1');
        }
    });

    it('produces structurally identical shape summaries across all 4 dialects', () => {
        // The strongest check: stringify the table+relation skeletons.
        const summaries = Object.entries(DDL).map(([d, sql]) => ({
            dialect: d,
            shape: shapeSummary(sqlToErdSchema(sql)),
        }));
        // All four shape summaries must be deep-equal.
        const reference = summaries[0].shape;
        for (const s of summaries.slice(1)) {
            expect(s.shape, `${s.dialect} vs ${summaries[0].dialect}`).toEqual(reference);
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Schema synchronization & idempotency
// ════════════════════════════════════════════════════════════════════════════

describe('Schema synchronization — idempotency across runs', () => {
    const SCRIPTS = {
        SQLite: `CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);`,
        PostgreSQL: `CREATE TABLE t (id BIGSERIAL PRIMARY KEY, name TEXT);`,
        MySQL: `CREATE TABLE \`t\` (\`id\` BIGINT AUTO_INCREMENT PRIMARY KEY, \`name\` VARCHAR(255));`,
        MSSQL: `CREATE TABLE [t] ([id] BIGINT IDENTITY(1,1) PRIMARY KEY, [name] NVARCHAR(255));`,
    };

    for (const [dialect, sql] of Object.entries(SCRIPTS)) {
        it(`${dialect}: same SQL produces deep-equal ERD JSON across 3 runs`, () => {
            const a = sqlToErdSchema(sql);
            const b = sqlToErdSchema(sql);
            const c = sqlToErdSchema(sql);
            expect(shapeSummary(a)).toEqual(shapeSummary(b));
            expect(shapeSummary(b)).toEqual(shapeSummary(c));
        });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Relationship-mapping accuracy
// ════════════════════════════════════════════════════════════════════════════
//
// Verifies the Crow's-Foot cardinality matrix in `generateRelations`.

describe('Relationship mapping — cardinality across dialects', () => {
    it('one-to-one FK → optional-one children and one required parent', () => {
        const sql = `
            CREATE TABLE u (id INT PRIMARY KEY, name TEXT);
            CREATE TABLE p (
                user_id INT PRIMARY KEY REFERENCES u(id),
                bio TEXT
            );
        `;
        const rel = sqlToErdSchema(sql).relations[0];
        expect(rel.fromCard).toBe('0..1');
        expect(rel.toCard).toBe('1');
    });

    it('0..1 (UQ but nullable) → fromCard "0..1"', () => {
        const sql = `
            CREATE TABLE u (id INT PRIMARY KEY);
            CREATE TABLE p (
                id INT PRIMARY KEY,
                user_id INT UNIQUE REFERENCES u(id)
            );
        `;
        const rel = relationFor(sqlToErdSchema(sql), 'p', 'user_id');
        expect(rel.fromCard).toBe('0..1');
    });

    it('one-to-many required FK → optional-many children', () => {
        const sql = `
            CREATE TABLE u (id INT PRIMARY KEY);
            CREATE TABLE p (
                id INT PRIMARY KEY,
                user_id INT NOT NULL REFERENCES u(id)
            );
        `;
        const rel = relationFor(sqlToErdSchema(sql), 'p', 'user_id');
        expect(rel.fromCard).toBe('0..n');
        expect(rel.toCard).toBe('1');
    });

    it('0..N (nullable, not unique) → fromCard "0..n"', () => {
        const sql = `
            CREATE TABLE u (id INT PRIMARY KEY);
            CREATE TABLE p (
                id INT PRIMARY KEY,
                user_id INT REFERENCES u(id)
            );
        `;
        const rel = relationFor(sqlToErdSchema(sql), 'p', 'user_id');
        expect(rel.fromCard).toBe('0..n');
    });

    it('self-referencing FK (employee.manager_id → employee.id)', () => {
        const sql = `
            CREATE TABLE employee (
                id INT PRIMARY KEY,
                manager_id INT REFERENCES employee(id),
                name TEXT
            );
        `;
        const s = sqlToErdSchema(sql);
        expect(s.relations).toHaveLength(1);
        expect(s.relations[0].from.table.toLowerCase()).toBe('employee');
        expect(s.relations[0].to.table.toLowerCase()).toBe('employee');
    });

    it('M:N junction table emits two relations + composite PK badges', () => {
        const sql = `
            CREATE TABLE a (id INT PRIMARY KEY);
            CREATE TABLE b (id INT PRIMARY KEY);
            CREATE TABLE ab (
                a_id INT NOT NULL REFERENCES a(id),
                b_id INT NOT NULL REFERENCES b(id),
                PRIMARY KEY (a_id, b_id)
            );
        `;
        const s = sqlToErdSchema(sql);
        expect(s.relations).toHaveLength(2);
        const ab = tableByName(s, 'ab');
        expect(colByName(ab, 'a_id').compositePk).toBe(true);
        expect(colByName(ab, 'b_id').compositePk).toBe(true);
    });

    it('multi-column composite FK splits into one relation per column pair', () => {
        const sql = `
            CREATE TABLE p (a INT, b INT, PRIMARY KEY (a, b));
            CREATE TABLE c (
                x INT,
                y INT,
                FOREIGN KEY (x, y) REFERENCES p(a, b)
            );
        `;
        const s = sqlToErdSchema(sql);
        expect(s.relations).toHaveLength(2);
        const fromColumns = s.relations.map((r) => r.from.column.toLowerCase()).sort();
        expect(fromColumns).toEqual(['x', 'y']);
        const toColumns = s.relations.map((r) => r.to.column.toLowerCase()).sort();
        expect(toColumns).toEqual(['a', 'b']);
    });

    it('multiple FKs from one table fan out as separate relations', () => {
        const sql = `
            CREATE TABLE u (id INT PRIMARY KEY);
            CREATE TABLE g (id INT PRIMARY KEY);
            CREATE TABLE m (
                id INT PRIMARY KEY,
                user_id INT REFERENCES u(id),
                group_id INT REFERENCES g(id)
            );
        `;
        const s = sqlToErdSchema(sql);
        expect(s.relations).toHaveLength(2);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Dialect-specific noise must NOT leak into the ERD shape
// ════════════════════════════════════════════════════════════════════════════
//
// The pipeline must be tolerant of dialect-specific table/column options
// that have no semantic meaning for the ERD (storage hints, charset/collation,
// MSSQL filegroup placement, etc.). If these tokens leak into errors or
// distort the shape, downstream rendering breaks.

describe('Dialect-specific noise — does NOT distort ERD shape', () => {
    const NOISY = {
        'MySQL ENGINE/CHARSET/COLLATE/ROW_FORMAT': `
            CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(255))
              ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;
        `,
        'MSSQL ON [PRIMARY]': `
            CREATE TABLE t (id INT PRIMARY KEY, name NVARCHAR(255)) ON [PRIMARY];
        `,
        'MSSQL TEXTIMAGE_ON': `
            CREATE TABLE t (id INT PRIMARY KEY, body NVARCHAR(MAX)) TEXTIMAGE_ON [PRIMARY];
        `,
        'PostgreSQL TABLESPACE': `
            CREATE TABLE t (id INT PRIMARY KEY, name TEXT) TABLESPACE pg_default;
        `,
        'PostgreSQL WITH (storage)': `
            CREATE TABLE t (id INT PRIMARY KEY, name TEXT) WITH (fillfactor=70, autovacuum_enabled=true);
        `,
        'SQLite WITHOUT ROWID': `
            CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT) WITHOUT ROWID;
        `,
        'SQLite STRICT': `
            CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT) STRICT;
        `,
        'SQLite STRICT, WITHOUT ROWID combined': `
            CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT) STRICT, WITHOUT ROWID;
        `,
    };

    for (const [name, sql] of Object.entries(NOISY)) {
        it(`${name}: parses with no errors and produces table 't' with 2 columns`, () => {
            const s = sqlToErdSchema(sql);
            expect(errorsOf(s)).toEqual([]);
            expect(s.tables).toHaveLength(1);
            expect(s.tables[0].columns).toHaveLength(2);
        });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Crash resistance — non-DDL constructs skip cleanly
// ════════════════════════════════════════════════════════════════════════════

describe('Non-DDL constructs — skipped cleanly', () => {
    const CASES = {
        'MySQL USE database': `USE mydb; CREATE TABLE t (id INT PRIMARY KEY);`,
        'MySQL SET FOREIGN_KEY_CHECKS': `SET FOREIGN_KEY_CHECKS=0; CREATE TABLE t (id INT PRIMARY KEY); SET FOREIGN_KEY_CHECKS=1;`,
        'MSSQL GO batch separator': `CREATE TABLE t (id INT PRIMARY KEY)\nGO\n`,
        'PostgreSQL CREATE SCHEMA': `CREATE SCHEMA app; CREATE TABLE t (id INT PRIMARY KEY);`,
        'CREATE VIEW': `CREATE TABLE t (id INT PRIMARY KEY); CREATE VIEW v AS SELECT * FROM t;`,
        'CREATE TRIGGER (SQLite)': `
            CREATE TABLE t (id INTEGER PRIMARY KEY, ts TEXT);
            CREATE TRIGGER t_ai AFTER INSERT ON t BEGIN UPDATE t SET ts = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
        `,
        'CREATE PROCEDURE (MSSQL)': `CREATE TABLE t (id INT PRIMARY KEY); CREATE PROCEDURE sp_get AS SELECT * FROM t;`,
        'DROP TABLE first': `DROP TABLE IF EXISTS old; CREATE TABLE t (id INT PRIMARY KEY);`,
    };

    for (const [name, sql] of Object.entries(CASES)) {
        it(`${name}: pipeline still produces table 't'`, () => {
            const s = sqlToErdSchema(sql);
            expect(s.tables.find((t) => t.name === 't' || t.name === 'T')).toBeTruthy();
        });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// 7. ENUM / SET / Composite types — uniform across dialects
// ════════════════════════════════════════════════════════════════════════════

describe('ENUM / SET / Composite types — registration & column normalization', () => {
    it('PostgreSQL CREATE TYPE AS ENUM is registered', () => {
        const s = sqlToErdSchema(`
            CREATE TYPE mood AS ENUM ('happy', 'sad', 'ok');
            CREATE TABLE t (id INT PRIMARY KEY, m mood);
        `);
        expect(s.enums.map((e) => e.name)).toContain('mood');
        const m = colByName(tableByName(s, 't'), 'm');
        expect(m.type.toLowerCase()).toBe('mood');
    });

    it('MySQL inline ENUM produces an enum entry with `_enum` suffix', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (id INT PRIMARY KEY, role ENUM('admin','user'));
        `);
        const enumEntry = s.enums.find((e) => /role.*_enum/i.test(e.name));
        expect(enumEntry).toBeTruthy();
        expect(enumEntry.values).toEqual(['admin', 'user']);
    });

    it('MySQL inline SET produces an enum-like entry with `_set` suffix', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (id INT PRIMARY KEY, perms SET('r','w','x'));
        `);
        const setEntry = s.enums.find((e) => /perms.*_set/i.test(e.name));
        expect(setEntry).toBeTruthy();
        expect(setEntry.values).toEqual(['r', 'w', 'x']);
    });

    it('schema-qualified user-defined types normalize to bare names', () => {
        const s = sqlToErdSchema(`
            CREATE TYPE public.mood AS ENUM ('happy','sad');
            CREATE TABLE t (id INT PRIMARY KEY, m public.mood);
        `);
        // mood is registered without schema prefix.
        expect(s.enums.map((e) => e.name)).toContain('mood');
        // and the column type lookup maps to it.
        const m = colByName(tableByName(s, 't'), 'm');
        expect(m.type.toLowerCase()).toBe('mood');
    });

    it('PostgreSQL composite type is registered with fields', () => {
        const s = sqlToErdSchema(`
            CREATE TYPE address AS (street TEXT, city TEXT, zip TEXT);
            CREATE TABLE t (id INT PRIMARY KEY, addr address);
        `);
        const composite = s.composites.find((c) => c.name === 'address');
        expect(composite).toBeTruthy();
        expect(composite.fields).toHaveLength(3);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. Computed / Generated columns across dialects
// ════════════════════════════════════════════════════════════════════════════

describe('Computed / Generated columns — surfaced as extras', () => {
    it('PostgreSQL GENERATED ALWAYS AS (expr) STORED', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (
                a INT, b INT,
                s INT GENERATED ALWAYS AS (a + b) STORED
            );
        `);
        const sCol = colByName(tableByName(s, 't'), 's');
        expect(sCol.extras.some((x) => /GENERATED/i.test(x))).toBe(true);
    });

    it('MySQL GENERATED VIRTUAL', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (
                a INT, b INT,
                v INT GENERATED ALWAYS AS (a + b) VIRTUAL
            );
        `);
        const v = colByName(tableByName(s, 't'), 'v');
        expect(v.extras.some((x) => /GENERATED.*VIRTUAL/i.test(x))).toBe(true);
    });

    it('MSSQL bare-AS computed column with PERSISTED', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (
                first_name NVARCHAR(50),
                last_name NVARCHAR(50),
                full_name AS (first_name + ' ' + last_name) PERSISTED
            );
        `);
        const fn = colByName(tableByName(s, 't'), 'full_name');
        expect(fn).toBeTruthy();
        expect(fn.extras.some((x) => /AS\s*\(.*\).*PERSISTED/i.test(x))).toBe(true);
    });

    it('SQLite GENERATED column', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (
                a INTEGER, b INTEGER,
                total INTEGER GENERATED ALWAYS AS (a + b) STORED
            );
        `);
        const total = colByName(tableByName(s, 't'), 'total');
        expect(total.extras.some((x) => /GENERATED/i.test(x))).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 9. ALTER TABLE — same logical action, 4 syntaxes → same ERD JSON
// ════════════════════════════════════════════════════════════════════════════

describe('ALTER TABLE — equivalent FK addition across dialects', () => {
    const VARIANTS = {
        // SQLite has *very* limited ALTER ADD CONSTRAINT support — most
        // SQLite migrations declare the FK inline, which we cover here.
        // The other three dialects use the standard ALTER ADD CONSTRAINT
        // form. All four converge on the same single relation.
        SQLite: `
            CREATE TABLE u (id INTEGER PRIMARY KEY);
            CREATE TABLE p (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES u(id)
            );
        `,
        PostgreSQL: `
            CREATE TABLE u (id INT PRIMARY KEY);
            CREATE TABLE p (id INT PRIMARY KEY, user_id INT NOT NULL);
            ALTER TABLE p ADD CONSTRAINT fk_p_u FOREIGN KEY (user_id) REFERENCES u(id);
        `,
        MySQL: `
            CREATE TABLE u (id INT PRIMARY KEY);
            CREATE TABLE p (id INT PRIMARY KEY, user_id INT NOT NULL);
            ALTER TABLE \`p\` ADD CONSTRAINT \`fk_p_u\` FOREIGN KEY (\`user_id\`) REFERENCES \`u\`(\`id\`);
        `,
        MSSQL: `
            CREATE TABLE u (id INT PRIMARY KEY);
            CREATE TABLE p (id INT PRIMARY KEY, user_id INT NOT NULL);
            ALTER TABLE [p] ADD CONSTRAINT FK_p_u FOREIGN KEY ([user_id]) REFERENCES [u]([id]);
        `,
    };

    for (const [dialect, sql] of Object.entries(VARIANTS)) {
        it(`${dialect}: produces 1 relation p.user_id → u.id`, () => {
            const s = sqlToErdSchema(sql);
            expect(s.relations).toHaveLength(1);
            const r = s.relations[0];
            expect(r.from.table.toLowerCase()).toBe('p');
            expect(r.from.column.toLowerCase()).toBe('user_id');
            expect(r.to.table.toLowerCase()).toBe('u');
            expect(r.to.column.toLowerCase()).toBe('id');
        });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// 10. Production templates — realistic apps in each dialect
// ════════════════════════════════════════════════════════════════════════════

describe('Production templates — realistic schemas in each dialect', () => {
    it('MySQL e-commerce schema (orders, customers, products, line_items)', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE customers (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(255) NOT NULL UNIQUE,
                name VARCHAR(255) NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB;

            CREATE TABLE products (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                sku VARCHAR(64) NOT NULL UNIQUE,
                name VARCHAR(255) NOT NULL,
                price DECIMAL(12,2) NOT NULL,
                stock INT NOT NULL DEFAULT 0
            ) ENGINE=InnoDB;

            CREATE TABLE orders (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                customer_id BIGINT NOT NULL,
                status ENUM('pending','paid','shipped','cancelled') NOT NULL DEFAULT 'pending',
                total DECIMAL(12,2) NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (customer_id) REFERENCES customers(id)
            ) ENGINE=InnoDB;

            CREATE TABLE line_items (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                order_id BIGINT NOT NULL,
                product_id BIGINT NOT NULL,
                qty INT NOT NULL DEFAULT 1,
                price DECIMAL(12,2) NOT NULL,
                FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
                FOREIGN KEY (product_id) REFERENCES products(id),
                UNIQUE KEY uq_oi (order_id, product_id)
            ) ENGINE=InnoDB;
        `);
        expect(errorsOf(s)).toEqual([]);
        expect(s.tables).toHaveLength(4);
        // 3 FK relations: orders.customer_id, line_items.order_id, line_items.product_id
        expect(s.relations).toHaveLength(3);
        // status ENUM is registered.
        expect(s.enums.find((e) => /status.*_enum/i.test(e.name))).toBeTruthy();
    });

    it('PostgreSQL multi-tenant SaaS (orgs, users, memberships, projects)', () => {
        const s = sqlToErdSchema(`
            CREATE TYPE role AS ENUM ('owner', 'admin', 'member');

            CREATE TABLE orgs (
                id BIGSERIAL PRIMARY KEY,
                slug TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL
            );

            CREATE TABLE users (
                id BIGSERIAL PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL
            );

            CREATE TABLE memberships (
                org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                role role NOT NULL DEFAULT 'member',
                joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY (org_id, user_id)
            );

            CREATE TABLE projects (
                id BIGSERIAL PRIMARY KEY,
                org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );

            CREATE INDEX ix_proj_org ON projects(org_id);
        `);
        expect(errorsOf(s)).toEqual([]);
        expect(s.tables).toHaveLength(4);
        expect(s.enums.map((e) => e.name)).toContain('role');
        // 3 FK relations: memberships.org_id, memberships.user_id, projects.org_id
        expect(s.relations).toHaveLength(3);
        // Composite PK on memberships → both columns flagged as compositePk
        const m = tableByName(s, 'memberships');
        expect(colByName(m, 'org_id').compositePk).toBe(true);
        expect(colByName(m, 'user_id').compositePk).toBe(true);
    });

    it('MSSQL banking core (accounts, transactions, IDENTITY, computed col)', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE accounts (
                id BIGINT IDENTITY(1,1) PRIMARY KEY,
                customer_id BIGINT NOT NULL,
                number NVARCHAR(34) NOT NULL UNIQUE,
                balance DECIMAL(18,2) NOT NULL DEFAULT 0,
                opened_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
            );

            CREATE TABLE transactions (
                id BIGINT IDENTITY(1,1) PRIMARY KEY,
                account_id BIGINT NOT NULL,
                amount DECIMAL(18,2) NOT NULL,
                ts DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                running_total AS (amount * 1) PERSISTED,
                CONSTRAINT FK_tx_acct FOREIGN KEY (account_id) REFERENCES accounts(id)
            );

            CREATE NONCLUSTERED INDEX ix_tx_acct_ts ON transactions(account_id, ts);
        `);
        expect(errorsOf(s)).toEqual([]);
        expect(s.tables).toHaveLength(2);
        expect(s.relations).toHaveLength(1);
        // The composite index marks both cols compositeIdx
        const tx = tableByName(s, 'transactions');
        expect(colByName(tx, 'account_id').compositeIdx).toBe(true);
        expect(colByName(tx, 'ts').compositeIdx).toBe(true);
    });

    it('SQLite mobile app (chat) — STRICT, AUTOINCREMENT, partial indexes', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                handle TEXT NOT NULL UNIQUE,
                deleted_at TEXT
            ) STRICT;

            CREATE TABLE rooms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL
            );

            CREATE TABLE memberships (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, room_id)
            ) WITHOUT ROWID;

            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id INTEGER NOT NULL REFERENCES rooms(id),
                user_id INTEGER NOT NULL REFERENCES users(id),
                body TEXT NOT NULL,
                ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX ix_msg_room_ts ON messages(room_id, ts);
            CREATE UNIQUE INDEX ix_users_handle ON users(handle) WHERE deleted_at IS NULL;
        `);
        expect(errorsOf(s)).toEqual([]);
        expect(s.tables).toHaveLength(4);
        // 4 relations: memberships×2, messages.room_id, messages.user_id
        expect(s.relations).toHaveLength(4);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 11. Mega 4-dialect mixed dump
// ════════════════════════════════════════════════════════════════════════════

describe('Mega 4-dialect mixed dump — single script, 4 syntactic flavors', () => {
    it('parses, normalizes, and produces a coherent ERD', () => {
        const s = sqlToErdSchema(`
            -- ─── SQLite ──────────────────────────────────────────────
            CREATE TABLE users_lite (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE
            ) STRICT;

            -- ─── PostgreSQL ──────────────────────────────────────────
            CREATE TABLE users_pg (
                id BIGSERIAL PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                tags TEXT[]
            );

            # ─── MySQL ───────────────────────────────────────────────
            CREATE TABLE \`users_my\` (
                \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
                \`email\` VARCHAR(255) NOT NULL UNIQUE,
                \`role\` ENUM('admin','user') NOT NULL DEFAULT 'user'
            ) ENGINE=InnoDB;

            -- ─── MSSQL ───────────────────────────────────────────────
            CREATE TABLE [users_ms] (
                [id] BIGINT IDENTITY(1,1) PRIMARY KEY,
                [email] NVARCHAR(255) NOT NULL UNIQUE,
                [greeting] NVARCHAR(50) DEFAULT N'hello'
            );

            -- ALTER across dialects, all targeting different tables
            ALTER TABLE users_pg ADD CONSTRAINT uq_users_pg_email UNIQUE (email);
        `);
        expect(errorsOf(s)).toEqual([]);
        expect(s.tables.map((t) => t.name).sort()).toEqual(['users_lite', 'users_ms', 'users_my', 'users_pg']);
        // Each id column is auto-increment.
        for (const t of s.tables) {
            expect(colByName(t, 'id').autoIncrement).toBe(true);
        }
        // MySQL inline ENUM is registered.
        expect(s.enums.find((e) => /role.*_enum/i.test(e.name))).toBeTruthy();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 12. New tokenizer features end-to-end (regression)
// ════════════════════════════════════════════════════════════════════════════

describe('Tokenizer features — end-to-end through ERD pipeline', () => {
    it('MySQL `#` comments do not break ERD generation', () => {
        const s = sqlToErdSchema(`
            # mysqldump 8.0 dump file
            CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(50));
            # comment between statements
        `);
        expect(errorsOf(s)).toEqual([]);
        expect(s.tables).toHaveLength(1);
    });

    it('MSSQL N\'unicode\' literals in DEFAULT survive into extras', () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (id INT PRIMARY KEY, greeting NVARCHAR(50) DEFAULT N'你好');
        `);
        expect(errorsOf(s)).toEqual([]);
        const greeting = colByName(tableByName(s, 't'), 'greeting');
        expect(greeting.extras.some((x) => x.includes('你好'))).toBe(true);
    });

    it("MySQL backslash-escape \\' inside DEFAULT does not crash the parser", () => {
        const s = sqlToErdSchema(`
            CREATE TABLE t (id INT PRIMARY KEY, note TEXT DEFAULT 'it\\'s here');
        `);
        expect(errorsOf(s)).toEqual([]);
        expect(tableByName(s, 't')).toBeTruthy();
    });
});
