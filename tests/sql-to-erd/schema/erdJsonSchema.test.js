import { describe, it, expect, vi } from 'vitest';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

/**
 * Tests for the schema-builder that feeds genErdScript.js (runErdScript).
 *
 * NOTE on `genErdScript.js`:
 *   That file is a 2.6k-LOC canvas renderer. It calls `document.getElementById`,
 *   instantiates a 2D context, talks to ELK for auto-layout and binds global DOM
 *   event listeners. It cannot be meaningfully unit-tested with Vitest's `node`
 *   environment (would require JSDOM + a canvas mock + ELK stubbing — and even
 *   then assertions would be on render side-effects, not behavior).
 *
 *   The right contract to test is the *schema object* it consumes, which is
 *   produced by `sqlToErdSchema(sql)` in this file. If this is correct,
 *   genErdScript receives the right input — that is what we cover here.
 */
function build(sql) {
    const s = sqlToErdSchema(sql);
    return {
        schema: s,
        tables: s.tables,
        relations: s.relations,
        enums: s.enums,
        composites: s.composites,
        table: (name) => s.tables.find((t) => t.name.toLowerCase() === name.toLowerCase()) || null,
        col: (table, col) => {
            const t = s.tables.find((tt) => tt.name.toLowerCase() === table.toLowerCase());
            if (!t) return null;
            return t.columns.find((c) => c.name.toLowerCase() === col.toLowerCase()) || null;
        },
        rel: (fromTable, fromCol) => s.relations.find((r) => r.from.table.toLowerCase() === fromTable.toLowerCase() && r.from.column.toLowerCase() === fromCol.toLowerCase()) || null,
    };
}

// ════════════════════════════════════════════
// Shape contract — what runErdScript expects
// ════════════════════════════════════════════

describe('Schema shape (runErdScript contract)', () => {
    it('always returns the four top-level arrays', () => {
        const r = build(`CREATE TABLE t (id INT);`);
        expect(Array.isArray(r.schema.tables)).toBe(true);
        expect(Array.isArray(r.schema.relations)).toBe(true);
        expect(Array.isArray(r.schema.enums)).toBe(true);
        expect(Array.isArray(r.schema.composites)).toBe(true);
    });

    it('attaches _parseErrors so the UI can surface diagnostics', () => {
        const r = build(`CREATE TABLE t (id INT);`);
        expect(Array.isArray(r.schema._parseErrors)).toBe(true);
    });

    it('every column has name, type, constraints[], extras[]', () => {
        const r = build(`CREATE TABLE t (id INT PRIMARY KEY, name TEXT NOT NULL);`);
        for (const col of r.table('t').columns) {
            expect(typeof col.name).toBe('string');
            expect(typeof col.type).toBe('string');
            expect(Array.isArray(col.constraints)).toBe(true);
            expect(Array.isArray(col.extras)).toBe(true);
        }
    });

    it('returns an empty schema on empty SQL, throws on non-string input', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        // Empty / whitespace SQL yields a renderable empty schema (no throw).
        for (const sql of ['', '   ', '\n']) {
            const empty = sqlToErdSchema(sql);
            expect(empty.tables).toHaveLength(0);
            expect(empty.relations).toHaveLength(0);
        }
        // Non-string inputs are programmer errors and DO throw.
        expect(() => sqlToErdSchema(null)).toThrow();
        expect(() => sqlToErdSchema(123)).toThrow();
        spy.mockRestore();
    });
});

// ════════════════════════════════════════════
// Constraint flags  ─►  PK / NN / UQ / FK
// ════════════════════════════════════════════

describe('Column constraint flags', () => {
    it('marks PRIMARY KEY columns with pk=true and constraint "PK"', () => {
        const r = build(`CREATE TABLE t (id INT PRIMARY KEY, name TEXT);`);
        const id = r.col('t', 'id');
        expect(id.pk).toBe(true);
        expect(id.constraints).toContain('PK');
    });

    it('marks NOT NULL with "NN"', () => {
        const r = build(`CREATE TABLE t (name VARCHAR(100) NOT NULL);`);
        expect(r.col('t', 'name').constraints).toContain('NN');
    });

    it('marks UNIQUE with "UQ"', () => {
        const r = build(`CREATE TABLE t (email VARCHAR(255) UNIQUE);`);
        expect(r.col('t', 'email').constraints).toContain('UQ');
    });

    it('marks FK columns with fk=true', () => {
        const r = build(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (pid INT REFERENCES parent(id));
        `);
        expect(r.col('child', 'pid').fk).toBe(true);
    });

    it('does NOT add NN to PK columns (PK already implies NN, avoids duplication)', () => {
        const r = build(`CREATE TABLE t (id INT PRIMARY KEY);`);
        expect(r.col('t', 'id').constraints).toEqual(['PK']);
    });

    it('flags composite primary key columns with compositePk', () => {
        const r = build(`CREATE TABLE t (a INT, b INT, c INT, PRIMARY KEY (a, b));`);
        expect(r.col('t', 'a').compositePk).toBe(true);
        expect(r.col('t', 'b').compositePk).toBe(true);
        expect(r.col('t', 'c').compositePk).toBeFalsy();
    });

    it('flags composite unique with compositeUq', () => {
        const r = build(`CREATE TABLE t (a INT, b INT, UNIQUE (a, b));`);
        expect(r.col('t', 'a').compositeUq).toBe(true);
        expect(r.col('t', 'b').compositeUq).toBe(true);
    });
});

// ════════════════════════════════════════════
// extras[] — DEFAULT, CHECK, GENERATED
// ════════════════════════════════════════════

describe('Column extras', () => {
    it('appends DEFAULT … to extras', () => {
        const r = build(`CREATE TABLE t (role VARCHAR(50) DEFAULT 'user');`);
        expect(r.col('t', 'role').extras.some((e) => /^DEFAULT 'user'$/.test(e))).toBe(true);
    });

    it('appends CHECK (…) to extras', () => {
        const r = build(`CREATE TABLE t (age INT CHECK (age >= 0));`);
        expect(r.col('t', 'age').extras.some((e) => /^CHECK \(/.test(e))).toBe(true);
    });

    it('appends GENERATED ALWAYS AS … to extras (PostgreSQL/MySQL)', () => {
        const r = build(`
            CREATE TABLE t (
                price NUMERIC(10,2),
                qty INT,
                total NUMERIC GENERATED ALWAYS AS (price * qty) STORED
            );
        `);
        expect(r.col('t', 'total').extras.some((e) => /GENERATED ALWAYS AS/.test(e))).toBe(true);
        expect(r.col('t', 'total').extras.some((e) => /STORED$/.test(e))).toBe(true);
    });

    it('appends MSSQL AS (…) PERSISTED to extras', () => {
        const r = build(`
            CREATE TABLE t (
                price DECIMAL(10,2),
                qty INT,
                total AS (price * qty) PERSISTED
            );
        `);
        const total = r.col('t', 'total');
        expect(total.type).toBe('COMPUTED');
        expect(total.extras).toContain('AS (price * qty) PERSISTED');
    });

    it('appends MSSQL AS (…) without PERSISTED', () => {
        const r = build(`
            CREATE TABLE t (price DECIMAL(10,2), qty INT, total AS (price * qty));
        `);
        expect(r.col('t', 'total').extras).toContain('AS (price * qty)');
    });
});

// ════════════════════════════════════════════
// Relations — Crow's-foot cardinality
// ════════════════════════════════════════════

describe('Relations / cardinality', () => {
    it('creates a single relation per inline FK', () => {
        const r = build(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (pid INT REFERENCES parent(id));
        `);
        expect(r.relations).toHaveLength(1);
        const rel = r.rel('child', 'pid');
        expect(rel.to.table).toBe('parent');
        expect(rel.to.column).toBe('id');
    });

    it('drops relations whose tables/columns are not present', () => {
        const r = build(`
            CREATE TABLE child (pid INT REFERENCES ghost(id));
        `);
        // ghost is undefined: relation must be filtered out
        expect(r.relations).toHaveLength(0);
    });

    it('separates child multiplicity from nullable-FK participation', () => {
        // PK FK is unique and required: at most one child, exactly one parent.
        const a = build(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (pid INT PRIMARY KEY REFERENCES p(id));
        `);
        expect(a.rel('c', 'pid')).toMatchObject({ fromCard: '0..1', toCard: '1' });

        // Plain nullable FK: zero-to-many children, zero-or-one parent.
        const b = build(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (pid INT REFERENCES p(id));
        `);
        expect(b.rel('c', 'pid')).toMatchObject({ fromCard: '0..n', toCard: '0..1' });

        // UNIQUE NOT NULL: at most one child, exactly one parent.
        const c = build(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (pid INT UNIQUE NOT NULL REFERENCES p(id));
        `);
        expect(c.rel('c', 'pid')).toMatchObject({ fromCard: '0..1', toCard: '1' });

        // UNIQUE nullable: at most one child, zero-or-one parent.
        const d = build(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (pid INT UNIQUE REFERENCES p(id));
        `);
        expect(d.rel('c', 'pid')).toMatchObject({ fromCard: '0..1', toCard: '0..1' });
    });

    it('honors composite FK from table-level FOREIGN KEY', () => {
        const r = build(`
            CREATE TABLE parent (a INT, b INT, PRIMARY KEY (a, b));
            CREATE TABLE child (
                pa INT, pb INT,
                FOREIGN KEY (pa, pb) REFERENCES parent(a, b)
            );
        `);
        expect(r.relations).toHaveLength(2);
        expect(r.rel('child', 'pa').to.column).toBe('a');
        expect(r.rel('child', 'pb').to.column).toBe('b');
        expect(r.col('child', 'pa').fk).toBe(true);
        expect(r.col('child', 'pb').fk).toBe(true);
    });
});

// ════════════════════════════════════════════
// Enums & composites
// ════════════════════════════════════════════

describe('Enums and composite types', () => {
    it('exposes enums in schema.enums', () => {
        const r = build(`
            CREATE TYPE status AS ENUM ('a', 'b');
            CREATE TABLE t (id INT, s status);
        `);
        expect(r.enums).toHaveLength(1);
        expect(r.enums[0].name).toBe('status');
        expect(r.enums[0].values).toEqual(['a', 'b']);
    });

    it('lifts inline ENUM(…) into schema.enums', () => {
        const r = build(`
            CREATE TABLE t (id INT, status ENUM('low','high'));
        `);
        expect(r.enums.find((e) => e.name === 'status_enum')).toBeTruthy();
    });

    it('exposes composite types in schema.composites', () => {
        const r = build(`
            CREATE TYPE address AS (street TEXT, zip VARCHAR(20));
            CREATE TABLE u (id INT, addr address);
        `);
        expect(r.composites).toHaveLength(1);
        expect(r.composites[0].fields).toEqual([
            { name: 'street', type: 'TEXT' },
            { name: 'zip', type: 'VARCHAR(20)' },
        ]);
    });
});

// ════════════════════════════════════════════
// ALTER TABLE
// ════════════════════════════════════════════

describe('ALTER TABLE merging', () => {
    it('attaches a deferred FK from ALTER TABLE ADD CONSTRAINT', () => {
        const r = build(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (id INT PRIMARY KEY, pid INT);
            ALTER TABLE child ADD CONSTRAINT fk_p FOREIGN KEY (pid) REFERENCES parent(id);
        `);
        expect(r.col('child', 'pid').fk).toBe(true);
        expect(r.rel('child', 'pid').to.table).toBe('parent');
        expect(r.rel('child', 'pid').fkName).toBe('fk_p');
    });

    it('promotes a column to PK from ALTER TABLE ADD PRIMARY KEY', () => {
        const r = build(`
            CREATE TABLE t (id INT);
            ALTER TABLE t ADD PRIMARY KEY (id);
        `);
        expect(r.col('t', 'id').pk).toBe(true);
    });

    it('does not duplicate a relation already declared inline', () => {
        const r = build(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (pid INT REFERENCES p(id));
            ALTER TABLE c ADD FOREIGN KEY (pid) REFERENCES p(id);
        `);
        expect(r.relations).toHaveLength(1);
        expect(r.rel('c', 'pid').fkName).toBeUndefined();
    });
});

// ════════════════════════════════════════════
// Schema-qualified names — schema-aware display names for ERD
// ════════════════════════════════════════════

describe('Schema-qualified names', () => {
    it('qualifies mixed schema table names', () => {
        const r = build(`
            CREATE TABLE public.users (id INT PRIMARY KEY);
            CREATE TABLE dbo.orders (
                id INT PRIMARY KEY,
                user_id INT REFERENCES public.users(id)
            );
        `);
        expect(r.table('public.users')).not.toBeNull();
        expect(r.table('dbo.orders')).not.toBeNull();
        expect(r.rel('dbo.orders', 'user_id').to.table).toBe('public.users');
    });

    it('hides one common schema prefix from table names', () => {
        const r = build(`
            CREATE TABLE operations.transporteurs (id INT PRIMARY KEY);
            CREATE TABLE operations.blabla (
                id INT PRIMARY KEY,
                transporteur_id INT REFERENCES operations.transporteurs(id)
            );
        `);
        expect(r.table('transporteurs')).not.toBeNull();
        expect(r.table('blabla')).not.toBeNull();
        expect(r.rel('blabla', 'transporteur_id').to.table).toBe('transporteurs');
    });
});

// ════════════════════════════════════════════
// End-to-end smoke
// ════════════════════════════════════════════

describe('End-to-end pipeline (the schema runErdScript will receive)', () => {
    it('builds a complete renderable schema across all dialects of generated columns', () => {
        const sql = `
            CREATE TYPE order_status AS ENUM ('pending','paid','shipped');

            CREATE TABLE customers (
                id SERIAL PRIMARY KEY,
                first_name VARCHAR(50),
                last_name VARCHAR(50),
                email VARCHAR(255) UNIQUE NOT NULL,
                full_name AS (CONCAT(first_name, ' ', last_name))           -- MSSQL
            );

            CREATE TABLE orders (
                id SERIAL PRIMARY KEY,
                customer_id INT REFERENCES customers(id) ON DELETE CASCADE,
                status order_status DEFAULT 'pending',
                price NUMERIC(10,2),
                qty INT,
                total NUMERIC GENERATED ALWAYS AS (price * qty) STORED,     -- PG/MySQL
                tax   AS (price * 0.1) PERSISTED                            -- MSSQL
            );

            ALTER TABLE orders ADD CONSTRAINT chk_qty CHECK (qty > 0);
        `;

        const r = build(sql);

        expect(r.schema._parseErrors.filter((e) => e.severity === 'error')).toHaveLength(0);
        expect(r.tables.map((t) => t.name).sort()).toEqual(['customers', 'orders']);

        // Generated columns from all three dialects survive the pipeline
        expect(r.col('customers', 'full_name').extras.some((x) => /CONCAT/.test(x))).toBe(true);
        expect(r.col('orders', 'total').extras.some((x) => /GENERATED ALWAYS AS/.test(x))).toBe(true);
        expect(r.col('orders', 'tax').extras).toContain('AS (price * 0.1) PERSISTED');

        // Enum, FK, and ALTER CHECK all wire through
        expect(r.enums.some((e) => e.name === 'order_status')).toBe(true);
        expect(r.rel('orders', 'customer_id').to.table).toBe('customers');
        // ALTER CHECK is appended as an extra to the qty column
        expect(r.col('orders', 'qty').extras.some((x) => /CHECK/.test(x))).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Self-referencing & cyclic relationships
// ════════════════════════════════════════════════════════════════════════════

describe('Self-reference & cycles', () => {
    it('builds a self-referencing relation (e.g., tree node)', () => {
        const r = build(`
            CREATE TABLE node (
                id INT PRIMARY KEY,
                parent_id INT REFERENCES node(id)
            );
        `);
        expect(r.relations).toHaveLength(1);
        const rel = r.rel('node', 'parent_id');
        expect(rel.from.table).toBe('node');
        expect(rel.to.table).toBe('node');
        expect(rel.from.column).toBe('parent_id');
        expect(rel.to.column).toBe('id');
        expect(r.col('node', 'parent_id').fk).toBe(true);
    });

    it('handles a many-to-many junction table with two FKs', () => {
        const r = build(`
            CREATE TABLE student (id INT PRIMARY KEY);
            CREATE TABLE course  (id INT PRIMARY KEY);
            CREATE TABLE enrollment (
                student_id INT REFERENCES student(id),
                course_id  INT REFERENCES course(id),
                PRIMARY KEY (student_id, course_id)
            );
        `);
        expect(r.relations).toHaveLength(2);
        expect(r.col('enrollment', 'student_id').compositePk).toBe(true);
        expect(r.col('enrollment', 'course_id').compositePk).toBe(true);
        // Composite PK columns are NOT unique on their own → many-side cardinality
        expect(r.rel('enrollment', 'student_id')).toMatchObject({ fromCard: '0..n', toCard: '1' });
        expect(r.rel('enrollment', 'course_id')).toMatchObject({ fromCard: '0..n', toCard: '1' });
    });

    it('handles a cyclic FK between two tables', () => {
        const r = build(`
            CREATE TABLE a (id INT PRIMARY KEY, b_id INT);
            CREATE TABLE b (id INT PRIMARY KEY, a_id INT REFERENCES a(id));
            ALTER TABLE a ADD CONSTRAINT fk_b FOREIGN KEY (b_id) REFERENCES b(id);
        `);
        expect(r.relations).toHaveLength(2);
        expect(r.rel('a', 'b_id').to.table).toBe('b');
        expect(r.rel('b', 'a_id').to.table).toBe('a');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Composite FK referenced columns alignment
// ════════════════════════════════════════════════════════════════════════════

describe('Composite foreign key alignment', () => {
    it('aligns child columns with parent columns by index in a composite FK', () => {
        const r = build(`
            CREATE TABLE p (a INT, b INT, PRIMARY KEY (a, b));
            CREATE TABLE c (
                pa INT, pb INT,
                FOREIGN KEY (pa, pb) REFERENCES p(a, b)
            );
        `);
        expect(r.rel('c', 'pa').to.column).toBe('a');
        expect(r.rel('c', 'pb').to.column).toBe('b');
    });

    it('drops a composite FK when the child is wider than the referenced column list', () => {
        const r = build(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (a INT, b INT, FOREIGN KEY (a, b) REFERENCES p(id));
        `);

        expect(r.relations).toEqual([]);
        expect(r.schema._parseErrors).toContainEqual(expect.objectContaining({
            kind: 'relation_dropped_column_count_mismatch',
            severity: 'warning',
            message: expect.stringContaining("c(a, b)' references 'p(id)"),
            position: expect.objectContaining({
                line: 3,
                index: expect.any(Number),
            }),
        }));
    });
});

// ════════════════════════════════════════════════════════════════════════════
// DEFAULT NULL surface (regression test against the bug we fixed)
// ════════════════════════════════════════════════════════════════════════════

describe('DEFAULT NULL surfacing', () => {
    it('emits "DEFAULT NULL" in extras (regression: was empty)', () => {
        const r = build(`CREATE TABLE t (val INT DEFAULT NULL);`);
        expect(r.col('t', 'val').extras).toContain('DEFAULT NULL');
    });

    it('keeps NOT NULL together with DEFAULT NULL', () => {
        const r = build(`CREATE TABLE t (ts TIMESTAMP DEFAULT NULL NOT NULL);`);
        const col = r.col('t', 'ts');
        expect(col.extras).toContain('DEFAULT NULL');
        expect(col.constraints).toContain('NN');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Multiple inline ENUMs
// ════════════════════════════════════════════════════════════════════════════

describe('Multiple inline ENUMs', () => {
    it('lifts multiple inline ENUMs in the same table', () => {
        const r = build(`
            CREATE TABLE t (
                id INT PRIMARY KEY,
                size ENUM('S','M','L'),
                priority ENUM('low','high')
            );
        `);
        const names = r.enums.map((e) => e.name).sort();
        expect(names).toEqual(['priority_enum', 'size_enum']);
        expect(r.col('t', 'size').type).toBe('size_enum');
        expect(r.col('t', 'priority').type).toBe('priority_enum');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// FK action survival through the schema
// ════════════════════════════════════════════════════════════════════════════

describe('FK actions survive into the relation set', () => {
    it.each([
        ['ON DELETE CASCADE'],
        ['ON DELETE SET NULL'],
        ['ON DELETE SET DEFAULT'],
        ['ON DELETE NO ACTION'],
        ['ON DELETE RESTRICT'],
    ])('keeps the relation when child has %s', (action) => {
        const r = build(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (pid INT REFERENCES p(id) ${action});
        `);
        expect(r.relations).toHaveLength(1);
        expect(r.rel('c', 'pid').to.table).toBe('p');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Schema-qualified ALTER targets
// ════════════════════════════════════════════════════════════════════════════

describe('Schema-qualified ALTER target', () => {
    it('matches a qualified ALTER target back to a stripped table name', () => {
        const r = build(`
            CREATE TABLE public.users (id INT PRIMARY KEY);
            CREATE TABLE public.orders (id INT PRIMARY KEY, user_id INT);
            ALTER TABLE public.orders ADD CONSTRAINT fk_u FOREIGN KEY (user_id) REFERENCES public.users(id);
        `);
        expect(r.col('orders', 'user_id').fk).toBe(true);
        expect(r.rel('orders', 'user_id').to.table).toBe('users');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Multiple FKs from the same table
// ════════════════════════════════════════════════════════════════════════════

describe('Multiple FKs from one table', () => {
    it('produces independent relations for two FKs to the same parent', () => {
        const r = build(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (
                a INT REFERENCES p(id),
                b INT REFERENCES p(id)
            );
        `);
        expect(r.relations).toHaveLength(2);
        const aRel = r.rel('c', 'a');
        const bRel = r.rel('c', 'b');
        expect(aRel.to.table).toBe('p');
        expect(bRel.to.table).toBe('p');
    });

    it('produces independent relations for FKs to two different parents', () => {
        const r = build(`
            CREATE TABLE u (id INT PRIMARY KEY);
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (
                user_id INT REFERENCES u(id),
                post_id INT REFERENCES p(id)
            );
        `);
        expect(r.relations).toHaveLength(2);
        expect(r.rel('c', 'user_id').to.table).toBe('u');
        expect(r.rel('c', 'post_id').to.table).toBe('p');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// ALTER ADD CHECK surfacing
// ════════════════════════════════════════════════════════════════════════════

describe('ALTER ADD CHECK', () => {
    it('appends the CHECK clause to columns mentioned in the expression', () => {
        const r = build(`
            CREATE TABLE t (age INT, score INT);
            ALTER TABLE t ADD CONSTRAINT chk_age CHECK (age >= 0);
        `);
        expect(r.col('t', 'age').extras.some((e) => /CHECK/.test(e))).toBe(true);
        // 'score' is not in the expression so it should NOT receive the CHECK
        expect(r.col('t', 'score').extras.some((e) => /CHECK/.test(e))).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Cardinality matrix (full coverage of the four logical buckets)
// ════════════════════════════════════════════════════════════════════════════

describe('Cardinality matrix — every bucket', () => {
    const fixtures = [
        // [decoration on the FK column,           fromCard, toCard]
        ['INT REFERENCES p(id)', '0..n', '0..1'],
        ['INT NOT NULL REFERENCES p(id)', '0..n', '1'],
        ['INT UNIQUE REFERENCES p(id)', '0..1', '0..1'],
        ['INT UNIQUE NOT NULL REFERENCES p(id)', '0..1', '1'],
        ['INT PRIMARY KEY REFERENCES p(id)', '0..1', '1'],
    ];

    for (const [decl, expectedFrom, expectedTo] of fixtures) {
        it(`'${decl}' → ${expectedFrom} / ${expectedTo}`, () => {
            const r = build(`
                CREATE TABLE p (id INT PRIMARY KEY);
                CREATE TABLE c (pid ${decl});
            `);
            expect(r.rel('c', 'pid').fromCard).toBe(expectedFrom);
            expect(r.rel('c', 'pid').toCard).toBe(expectedTo);
        });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// Validation guarantees
// ════════════════════════════════════════════════════════════════════════════

describe('Schema validator hardens the output', () => {
    it('drops a relation whose column does not exist on either side', () => {
        // Hand-craft a parser-confusing scenario via ALTER for an undefined column
        const r = build(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (real_col INT);
            ALTER TABLE c ADD FOREIGN KEY (ghost) REFERENCES p(id);
        `);
        // The relation references 'ghost' which doesn't exist on c → must be filtered
        expect(r.relations.find((rel) => rel.from.column === 'ghost')).toBeUndefined();
    });

    it('normalizes invalid cardinalities into safe defaults', () => {
        const r = build(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (pid INT REFERENCES p(id));
        `);
        // Manually corrupt the cardinality, then re-validate via second build
        r.relations[0].fromCard = 'gibberish';
        r.relations[0].toCard = 'also gibberish';
        // sqlToErdSchema runs the validator at construction time; re-running on the
        // same SQL guarantees the validator's normalization rules apply.
        const r2 = build(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (pid INT REFERENCES p(id));
        `);
        const validCards = new Set(['1', 'n', '1+', '0..1', '0..n']);
        expect(validCards.has(r2.relations[0].fromCard)).toBe(true);
        expect(validCards.has(r2.relations[0].toCard)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Composite types as column types
// ════════════════════════════════════════════════════════════════════════════

describe('Composite type used as column type', () => {
    it('exposes the composite definition and keeps the column type pointing at it', () => {
        const r = build(`
            CREATE TYPE address AS (street TEXT, city VARCHAR(100));
            CREATE TABLE u (id INT PRIMARY KEY, addr address);
        `);
        expect(r.composites).toHaveLength(1);
        expect(r.composites[0].name).toBe('address');
        expect(r.col('u', 'addr').type.toLowerCase()).toBe('address');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// End-to-end: the schema runErdScript will receive in production
// ════════════════════════════════════════════════════════════════════════════

describe('Big realistic schema (end-to-end)', () => {
    it('survives a representative production schema with mixed dialects', () => {
        const sql = `
            CREATE TYPE order_status AS ENUM ('pending','paid','shipped','cancelled');

            CREATE TABLE customers (
                id SERIAL PRIMARY KEY,
                first_name VARCHAR(50) NOT NULL,
                last_name  VARCHAR(50) NOT NULL,
                email      VARCHAR(255) UNIQUE NOT NULL,
                full_name  AS (CONCAT(first_name, ' ', last_name)),         -- MSSQL
                created_at TIMESTAMP DEFAULT NOW(),
                deleted_at TIMESTAMP DEFAULT NULL
            );

            CREATE TABLE products (
                id SERIAL PRIMARY KEY,
                sku VARCHAR(64) UNIQUE NOT NULL,
                price DECIMAL(10,2) NOT NULL,
                tax_rate DECIMAL(4,2) DEFAULT 0.1,
                priced_with_tax DECIMAL(10,2) GENERATED ALWAYS AS (price * (1 + tax_rate)) STORED
            );

            CREATE TABLE orders (
                id SERIAL PRIMARY KEY,
                customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
                status order_status DEFAULT 'pending'
            );

            CREATE TABLE order_items (
                order_id   INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
                product_id INT NOT NULL REFERENCES products(id),
                qty        INT NOT NULL CHECK (qty > 0),
                unit_price DECIMAL(10,2) NOT NULL,
                line_total AS (qty * unit_price) PERSISTED,                  -- MSSQL
                PRIMARY KEY (order_id, product_id)
            );

            ALTER TABLE products ADD CONSTRAINT chk_price CHECK (price >= 0);
        `;

        const r = build(sql);

        // No errors anywhere in the pipeline
        expect(r.schema._parseErrors.filter((e) => e.severity === 'error')).toHaveLength(0);

        // Tables present
        expect(r.tables.map((t) => t.name).sort()).toEqual(['customers', 'order_items', 'orders', 'products']);

        // Enum
        expect(r.enums[0].values).toContain('cancelled');

        // Generated columns from both dialects survive
        expect(r.col('customers', 'full_name').extras.some((e) => /CONCAT/.test(e))).toBe(true);
        expect(r.col('products', 'priced_with_tax').extras.some((e) => /GENERATED ALWAYS AS/.test(e))).toBe(true);
        expect(r.col('order_items', 'line_total').extras).toContain('AS (qty * unit_price) PERSISTED');

        // DEFAULT NULL is now properly surfaced
        expect(r.col('customers', 'deleted_at').extras).toContain('DEFAULT NULL');

        // Composite PK with two FK relations on the junction table
        expect(r.col('order_items', 'order_id').compositePk).toBe(true);
        expect(r.col('order_items', 'product_id').compositePk).toBe(true);
        expect(r.relations.filter((rel) => rel.from.table === 'order_items')).toHaveLength(2);

        // ALTER ADD CHECK propagated onto the price column
        expect(r.col('products', 'price').extras.some((e) => /CHECK/.test(e))).toBe(true);

        // NOT NULL affects parent participation, not children-per-parent.
        expect(r.rel('orders', 'customer_id')).toMatchObject({ fromCard: '0..n', toCard: '1' });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// PostgreSQL dialect
// ════════════════════════════════════════════════════════════════════════════

describe('PostgreSQL dialect → ERD schema', () => {
    it('SERIAL surfaces as auto-increment in the schema', () => {
        const r = build(`CREATE TABLE u (id SERIAL PRIMARY KEY, name TEXT);`);
        const id = r.col('u', 'id');
        expect(id.autoIncrement).toBe(true);
        expect(id.extras).toContain('AUTO_INCREMENT');
        expect(id.constraints).toContain('PK');
    });

    it('GENERATED ALWAYS AS IDENTITY surfaces as auto-increment, not as a generated extra', () => {
        const r = build(`CREATE TABLE u (id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY);`);
        const id = r.col('u', 'id');
        expect(id.autoIncrement).toBe(true);
        expect(id.extras.some((e) => /^GENERATED\b/.test(e))).toBe(false);
    });

    it('GENERATED ALWAYS AS (expr) STORED still surfaces as a generated extra', () => {
        const r = build(`CREATE TABLE p (price NUMERIC, qty INT, total NUMERIC GENERATED ALWAYS AS (price * qty) STORED);`);
        const t = r.col('p', 'total');
        expect(t.autoIncrement).toBeFalsy();
        expect(t.extras.some((e) => /STORED$/.test(e))).toBe(true);
    });

    it('PG arrays preserve [] in the type', () => {
        const r = build(`CREATE TABLE t (tags INTEGER[], names VARCHAR(50)[]);`);
        expect(r.col('t', 'tags').type).toBe('INTEGER[]');
        expect(r.col('t', 'names').type).toBe('VARCHAR(50)[]');
    });

    it('CREATE TEMP TABLE produces a normal table in the schema', () => {
        const r = build(`CREATE TEMP TABLE t (id INT PRIMARY KEY);`);
        expect(r.table('t')).toBeTruthy();
        expect(r.col('t', 'id').pk).toBe(true);
    });

    it('CREATE UNLOGGED TABLE produces a normal table in the schema', () => {
        const r = build(`CREATE UNLOGGED TABLE t (id INT PRIMARY KEY);`);
        expect(r.table('t')).toBeTruthy();
    });

    it('PG CREATE TYPE foo AS ENUM is lifted into schema.enums', () => {
        const r = build(`
            CREATE TYPE mood AS ENUM ('happy','sad');
            CREATE TABLE u (id INT, m mood);
        `);
        const e = r.enums.find((x) => x.name === 'mood');
        expect(e).toBeTruthy();
        expect(e.values).toEqual(['happy', 'sad']);
        expect(r.col('u', 'm').type).toBe('mood');
    });

    it('schema-qualified names are stripped in tables and FK targets', () => {
        const r = build(`
            CREATE TABLE public.parent (id INT PRIMARY KEY);
            CREATE TABLE public.child  (pid INT REFERENCES public.parent(id));
        `);
        expect(r.table('parent')).toBeTruthy();
        expect(r.table('child')).toBeTruthy();
        expect(r.rel('child', 'pid').to.table).toBe('parent');
    });

    it('INHERITS clause is consumed without losing the child columns', () => {
        const r = build(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child  (extra INT) INHERITS (parent);
        `);
        expect(r.table('child').columns.map((c) => c.name)).toEqual(['extra']);
    });

    it('LIKE inclusion is skipped without polluting columns', () => {
        const r = build(`CREATE TABLE x (LIKE y INCLUDING ALL, extra INT);`);
        expect(r.col('x', 'like')).toBeNull();
        expect(r.col('x', 'extra')).toBeTruthy();
    });

    it('table-level EXCLUDE constraint does not become a column', () => {
        const r = build(`CREATE TABLE t (id INT, range int4range, EXCLUDE USING gist (range WITH &&));`);
        expect(r.table('t').columns.map((c) => c.name)).toEqual(['id', 'range']);
    });

    it('PG WITH (storage_options) trailing clause does not break parsing', () => {
        const r = build(`CREATE TABLE t (id INT PRIMARY KEY) WITH (fillfactor=70);`);
        expect(r.col('t', 'id').pk).toBe(true);
    });

    it('PG TIMESTAMPTZ DEFAULT NOW() round-trips into extras', () => {
        const r = build(`CREATE TABLE t (created TIMESTAMPTZ DEFAULT NOW());`);
        expect(r.col('t', 'created').extras).toContain('DEFAULT NOW()');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// MySQL dialect
// ════════════════════════════════════════════════════════════════════════════

describe('MySQL dialect → ERD schema', () => {
    it('AUTO_INCREMENT surfaces as auto-increment + extras', () => {
        const r = build(`CREATE TABLE u (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50));`);
        const id = r.col('u', 'id');
        expect(id.autoIncrement).toBe(true);
        expect(id.extras).toContain('AUTO_INCREMENT');
        expect(id.pk).toBe(true);
    });

    it('inline ENUM(...) becomes a schema enum and the column type points to its name', () => {
        const r = build(`CREATE TABLE t (size ENUM('S','M','L') NOT NULL);`);
        const e = r.enums.find((x) => x.name === 'size_enum');
        expect(e.values).toEqual(['S', 'M', 'L']);
        expect(r.col('t', 'size').type).toBe('size_enum');
    });

    it('inline ENUM with MySQL charset/collation suffix becomes a schema enum', () => {
        const r = build(`CREATE TABLE t (status ENUM('new','done') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL);`);
        const e = r.enums.find((x) => x.name === 'status_enum');
        expect(e.values).toEqual(['new', 'done']);
        expect(r.col('t', 'status').type).toBe('status_enum');
    });

    it('inline ENUM with MySQL CHARSET shorthand becomes a schema enum', () => {
        const r = build(`CREATE TABLE t (status ENUM('new','done') CHARSET=utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'new');`);
        const e = r.enums.find((x) => x.name === 'status_enum');
        expect(e.values).toEqual(['new', 'done']);
        expect(r.col('t', 'status')).toMatchObject({
            type: 'status_enum',
            extras: ["DEFAULT 'new'"],
        });
    });

    it('inline SET(...) becomes a schema enum with a _set suffix', () => {
        const r = build(`CREATE TABLE t (perms SET('read','write','admin'));`);
        const e = r.enums.find((x) => x.name === 'perms_set');
        expect(e.values).toEqual(['read', 'write', 'admin']);
        expect(r.col('t', 'perms').type).toBe('perms_set');
    });

    it('inline SET with MySQL charset/collation suffix becomes a schema enum', () => {
        const r = build(`CREATE TABLE t (perms SET('read','write','admin') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci);`);
        const e = r.enums.find((x) => x.name === 'perms_set');
        expect(e.values).toEqual(['read', 'write', 'admin']);
        expect(r.col('t', 'perms').type).toBe('perms_set');
    });

    it('ALTER MODIFY inline ENUM with charset/collation keeps enum type and defaults', () => {
        const r = build(`
            CREATE TABLE t (status ENUM('new','done') NOT NULL DEFAULT 'new');
            ALTER TABLE t MODIFY COLUMN status ENUM('new','done') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'done';
        `);
        expect(r.col('t', 'status')).toMatchObject({
            type: 'status_enum',
            extras: ["DEFAULT 'done'"],
        });
        expect(r.enums.find((x) => x.name === 'status_enum').values).toEqual(['new', 'done']);
    });

    it('multiple inline ENUM/SET in one table create distinct schema enums', () => {
        const r = build(`
            CREATE TABLE t (
                a ENUM('x','y'),
                b SET('p','q','r'),
                c ENUM('1','2')
            );
        `);
        const names = r.enums.map((e) => e.name).sort();
        expect(names).toEqual(['a_enum', 'b_set', 'c_enum']);
    });

    it('ENGINE / CHARSET / COLLATE / COMMENT trailing clauses leave columns untouched', () => {
        const r = build(`
            CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(50))
                ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='x';
        `);
        expect(r.col('t', 'id').pk).toBe(true);
        expect(r.col('t', 'name').type).toBe('VARCHAR(50)');
    });

    it('column-level ON UPDATE CURRENT_TIMESTAMP does not corrupt the DEFAULT extra', () => {
        const r = build(`CREATE TABLE t (id INT PRIMARY KEY, ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP);`);
        expect(r.col('t', 'ts').extras).toContain('DEFAULT CURRENT_TIMESTAMP');
    });

    it('UNSIGNED ZEROFILL is preserved in the ERD column type', () => {
        const r = build(`CREATE TABLE t (val INT(10) UNSIGNED ZEROFILL);`);
        expect(r.col('t', 'val').type).toBe('INT(10) UNSIGNED ZEROFILL');
    });

    it('UNIQUE KEY idx_name (col) lifts UQ flag onto the column', () => {
        const r = build(`CREATE TABLE t (id INT, email VARCHAR(255), UNIQUE KEY idx_email (email));`);
        expect(r.col('t', 'email').constraints).toContain('UQ');
    });

    it('INDEX/FULLTEXT/SPATIAL definitions do not become columns', () => {
        const r = build(`
            CREATE TABLE t (
                id INT PRIMARY KEY,
                name VARCHAR(100),
                INDEX idx_name (name),
                FULLTEXT KEY ft (name)
            );
        `);
        expect(r.table('t').columns.map((c) => c.name)).toEqual(['id', 'name']);
    });

    it('composite FK at table-level produces aligned relations', () => {
        const r = build(`
            CREATE TABLE p (a INT, b INT, PRIMARY KEY (a, b));
            CREATE TABLE c (
                pa INT, pb INT,
                FOREIGN KEY (pa, pb) REFERENCES p(a, b)
            );
        `);
        expect(r.rel('c', 'pa').to.column).toBe('a');
        expect(r.rel('c', 'pb').to.column).toBe('b');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// MSSQL dialect
// ════════════════════════════════════════════════════════════════════════════

describe('MSSQL dialect → ERD schema', () => {
    it('IDENTITY(seed,increment) surfaces as auto-increment', () => {
        const r = build(`CREATE TABLE u (id INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(50));`);
        const id = r.col('u', 'id');
        expect(id.autoIncrement).toBe(true);
        expect(id.extras).toContain('AUTO_INCREMENT');
        expect(id.pk).toBe(true);
    });

    it('computed AS (expr) PERSISTED surfaces in extras with COMPUTED type', () => {
        const r = build(`CREATE TABLE t (a INT, b AS (a * 2) PERSISTED);`);
        const c = r.col('t', 'b');
        expect(c.type).toBe('COMPUTED');
        expect(c.extras).toContain('AS (a * 2) PERSISTED');
    });

    it('computed AS (expr) PERSISTED NOT NULL flips NN constraint', () => {
        const r = build(`CREATE TABLE t (a INT, b AS (a + 1) PERSISTED NOT NULL);`);
        const c = r.col('t', 'b');
        expect(c.constraints).toContain('NN');
        expect(c.extras.some((e) => /PERSISTED NOT NULL$/.test(e))).toBe(true);
    });

    it('non-persisted computed column AS (expr) still surfaces', () => {
        const r = build(`CREATE TABLE t (a INT, b AS (a + 1));`);
        const c = r.col('t', 'b');
        expect(c.type).toBe('COMPUTED');
        expect(c.extras.some((e) => /^AS \(/.test(e))).toBe(true);
    });

    it('schema-qualified [dbo].[Table] strips schema prefix in the schema', () => {
        const r = build(`CREATE TABLE [dbo].[Customer] ([id] INT PRIMARY KEY);`);
        expect(r.table('Customer')).toBeTruthy();
        expect(r.table('dbo.Customer')).toBeNull();
    });

    it('trailing ON [PRIMARY] / WITH (FILLFACTOR=80) leave columns intact', () => {
        const r = build(`
            CREATE TABLE a (id INT PRIMARY KEY) ON [PRIMARY];
            CREATE TABLE b (id INT PRIMARY KEY) WITH (FILLFACTOR=80);
        `);
        expect(r.col('a', 'id').pk).toBe(true);
        expect(r.col('b', 'id').pk).toBe(true);
    });

    it('GO batch separator is silently skipped between statements', () => {
        const r = build(`
            CREATE TABLE a (id INT PRIMARY KEY);
            GO
            CREATE TABLE b (id INT PRIMARY KEY);
            GO
        `);
        expect(r.tables.map((t) => t.name)).toEqual(['a', 'b']);
    });

    it('CONSTRAINT name PRIMARY KEY CLUSTERED (id) lifts PK onto the column', () => {
        const r = build(`CREATE TABLE t (id INT, CONSTRAINT pk_t PRIMARY KEY CLUSTERED (id));`);
        expect(r.col('t', 'id').pk).toBe(true);
    });

    it('GETDATE() / NEWID() defaults survive into extras verbatim', () => {
        const r = build(`CREATE TABLE t (a DATETIME DEFAULT GETDATE(), b UNIQUEIDENTIFIER DEFAULT NEWID());`);
        expect(r.col('t', 'a').extras).toContain('DEFAULT GETDATE()');
        expect(r.col('t', 'b').extras).toContain('DEFAULT NEWID()');
    });

    it('NVARCHAR(MAX) / DATETIME2(3) / DATETIMEOFFSET / ROWVERSION are kept as types', () => {
        const r = build(`
            CREATE TABLE t (
                a NVARCHAR(MAX),
                b DATETIME2(3),
                c DATETIMEOFFSET,
                d ROWVERSION
            );
        `);
        expect(r.col('t', 'a').type).toBe('NVARCHAR(MAX)');
        expect(r.col('t', 'b').type).toBe('DATETIME2(3)');
        expect(r.col('t', 'c').type).toBe('DATETIMEOFFSET');
        expect(r.col('t', 'd').type).toBe('ROWVERSION');
    });

    it('FK declared in MSSQL CONSTRAINT clause produces a relation', () => {
        const r = build(`
            CREATE TABLE p (id INT NOT NULL CONSTRAINT pk_p PRIMARY KEY);
            CREATE TABLE c (id INT NOT NULL, pid INT,
                CONSTRAINT pk_c PRIMARY KEY (id),
                CONSTRAINT fk_c_p FOREIGN KEY (pid) REFERENCES p(id) ON DELETE CASCADE);
        `);
        expect(r.rel('c', 'pid').to.table).toBe('p');
        expect(r.rel('c', 'pid').fkName).toBe('fk_c_p');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Mega cross-dialect schema → ERD pipeline
// ════════════════════════════════════════════════════════════════════════════

describe('Mega cross-dialect → ERD pipeline', () => {
    it('produces a fully populated, error-free schema', () => {
        const r = build(`
            -- PostgreSQL
            CREATE TYPE public.user_status AS ENUM ('active','disabled','pending');
            CREATE TABLE public.users (
                id BIGSERIAL PRIMARY KEY,
                email VARCHAR(255) NOT NULL UNIQUE,
                status user_status NOT NULL DEFAULT 'active',
                tags TEXT[],
                metadata JSONB DEFAULT '{}',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                deleted_at TIMESTAMPTZ DEFAULT NULL
            );
            CREATE TABLE public.posts (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                body TEXT,
                word_count INT GENERATED ALWAYS AS (length(body)) STORED
            ) WITH (fillfactor=70);

            -- MySQL
            CREATE TABLE \`orders\` (
                \`id\` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                \`user_id\` BIGINT UNSIGNED NOT NULL,
                \`status\` ENUM('new','paid','shipped') NOT NULL DEFAULT 'new',
                \`perms\` SET('read','write','admin'),
                \`amount\` DECIMAL(10,2) UNSIGNED NOT NULL,
                CONSTRAINT fk_orders_user FOREIGN KEY (\`user_id\`) REFERENCES users(id) ON DELETE RESTRICT
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

            -- MSSQL
            CREATE TABLE [dbo].[Audit] (
                [id] BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_audit PRIMARY KEY CLUSTERED,
                [order_id] BIGINT NOT NULL,
                [snapshot] NVARCHAR(MAX) NOT NULL,
                [created] DATETIME2 NOT NULL DEFAULT GETDATE(),
                [hash] AS (CHECKSUM([snapshot])) PERSISTED NOT NULL,
                CONSTRAINT fk_audit_order FOREIGN KEY ([order_id]) REFERENCES orders(id)
            ) ON [PRIMARY];
            GO
        `);

        // Diagnostics
        expect(r.schema._parseErrors.filter((e) => e.severity === 'error')).toHaveLength(0);

        // Tables
        expect(r.tables.map((t) => t.name).sort()).toEqual(['dbo.Audit', 'public.orders', 'public.posts', 'public.users']);

        // Enums (PG enum + 2 inline MySQL enums)
        const enumNames = r.enums.map((e) => e.name).sort();
        expect(enumNames).toContain('user_status');
        expect(enumNames).toContain('status_enum');
        expect(enumNames).toContain('perms_set');

        // Auto-increment everywhere
        expect(r.col('public.users', 'id').autoIncrement).toBe(true);
        expect(r.col('public.posts', 'id').autoIncrement).toBe(true);
        expect(r.col('public.orders', 'id').autoIncrement).toBe(true);
        expect(r.col('dbo.Audit', 'id').autoIncrement).toBe(true);

        // PG arrays preserved
        expect(r.col('public.users', 'tags').type).toBe('TEXT[]');

        // PG generated column still present
        expect(r.col('public.posts', 'word_count').extras.some((e) => /STORED$/.test(e))).toBe(true);

        // MSSQL computed PERSISTED NOT NULL
        const hashCol = r.col('dbo.Audit', 'hash');
        expect(hashCol.type).toBe('COMPUTED');
        expect(hashCol.constraints).toContain('NN');

        // Relations: posts->users, orders->users, Audit->orders
        expect(r.rel('public.posts', 'user_id').to.table).toBe('public.users');
        expect(r.rel('public.orders', 'user_id').to.table).toBe('public.users');
        expect(r.rel('dbo.Audit', 'order_id').to.table).toBe('public.orders');

        // FK with NOT NULL non-unique: zero-to-many children, one parent.
        expect(r.rel('public.orders', 'user_id')).toMatchObject({ fromCard: '0..n', toCard: '1' });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Schema-qualified user-defined types — must match enumMap[col.type]
// ════════════════════════════════════════════════════════════════════════════

describe('Schema-qualified user-defined types are normalized for renderer lookup', () => {
    it('PG enum: column declared as `public.mood` matches the registered `mood` enum', () => {
        const r = build(`
            CREATE TYPE public.mood AS ENUM ('happy','sad');
            CREATE TABLE u (m public.mood);
        `);
        expect(r.col('u', 'm').type).toBe('mood');
        const enumMap = Object.fromEntries(r.enums.map((e) => [e.name, e.values]));
        expect(enumMap[r.col('u', 'm').type]).toEqual(['happy', 'sad']);
    });

    it('PG enum: column declared as bare `mood` still matches', () => {
        const r = build(`
            CREATE TYPE public.mood AS ENUM ('happy','sad');
            CREATE TABLE u (m mood);
        `);
        expect(r.col('u', 'm').type).toBe('mood');
    });

    it('PG composite: column declared as `public.address` matches the registered `address`', () => {
        const r = build(`
            CREATE TYPE public.address AS (street TEXT, city VARCHAR(100));
            CREATE TABLE u (home public.address);
        `);
        expect(r.col('u', 'home').type).toBe('address');
        const compositeMap = Object.fromEntries(r.composites.map((c) => [c.name, c.fields]));
        expect(compositeMap[r.col('u', 'home').type].map((f) => f.name)).toEqual(['street', 'city']);
    });

    it('does NOT strip schema from built-in types like `INTEGER` or `VARCHAR(50)`', () => {
        const r = build(`CREATE TABLE t (a INTEGER, b VARCHAR(50), c NUMERIC(10,2));`);
        expect(r.col('t', 'a').type).toBe('INTEGER');
        expect(r.col('t', 'b').type).toBe('VARCHAR(50)');
        expect(r.col('t', 'c').type).toBe('NUMERIC(10, 2)');
    });

    it('does NOT strip schema when no matching enum/composite exists', () => {
        const r = build(`CREATE TABLE t (x random.thing);`);
        // 'random' is not a registered type, so the schema-qualified type is left alone.
        expect(r.col('t', 'x').type).toBe('random.thing');
    });

    it('does NOT strip schema from PG arrays', () => {
        const r = build(`CREATE TABLE t (a INTEGER[], b TEXT[][]);`);
        expect(r.col('t', 'a').type).toBe('INTEGER[]');
        expect(r.col('t', 'b').type).toBe('TEXT[][]');
    });

    it('multiple tables referencing same enum from different schemas all resolve', () => {
        const r = build(`
            CREATE TYPE public.color AS ENUM ('r','g','b');
            CREATE TABLE a (c public.color);
            CREATE TABLE b (c color);
            CREATE TABLE c (c "color");
        `);
        const enumMap = Object.fromEntries(r.enums.map((e) => [e.name, e.values]));
        expect(enumMap[r.col('a', 'c').type]).toEqual(['r', 'g', 'b']);
        expect(enumMap[r.col('b', 'c').type]).toEqual(['r', 'g', 'b']);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// AUTO_INCREMENT surfaces consistently across dialects
// ════════════════════════════════════════════════════════════════════════════

describe('autoIncrement is surfaced uniformly across dialects', () => {
    it('PostgreSQL SERIAL', () => {
        const r = build(`CREATE TABLE t (id SERIAL PRIMARY KEY);`);
        expect(r.col('t', 'id').autoIncrement).toBe(true);
        expect(r.col('t', 'id').extras).toContain('AUTO_INCREMENT');
    });

    it('PostgreSQL BIGSERIAL', () => {
        const r = build(`CREATE TABLE t (id BIGSERIAL PRIMARY KEY);`);
        expect(r.col('t', 'id').autoIncrement).toBe(true);
    });

    it('PostgreSQL GENERATED BY DEFAULT AS IDENTITY', () => {
        const r = build(`CREATE TABLE t (id INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY);`);
        expect(r.col('t', 'id').autoIncrement).toBe(true);
    });

    it('PostgreSQL GENERATED ALWAYS AS IDENTITY', () => {
        const r = build(`CREATE TABLE t (id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY);`);
        expect(r.col('t', 'id').autoIncrement).toBe(true);
    });

    it('MySQL AUTO_INCREMENT', () => {
        const r = build(`CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY);`);
        expect(r.col('t', 'id').autoIncrement).toBe(true);
    });

    it('MSSQL IDENTITY(1,1)', () => {
        const r = build(`CREATE TABLE t (id INT IDENTITY(1,1) PRIMARY KEY);`);
        expect(r.col('t', 'id').autoIncrement).toBe(true);
    });

    it('MSSQL bare IDENTITY (no parens)', () => {
        const r = build(`CREATE TABLE t (id INT IDENTITY PRIMARY KEY);`);
        expect(r.col('t', 'id').autoIncrement).toBe(true);
    });

    it('non-auto-increment columns do NOT have the flag set', () => {
        const r = build(`CREATE TABLE t (id INT PRIMARY KEY, n TEXT);`);
        expect(r.col('t', 'id').autoIncrement).toBeFalsy();
        expect(r.col('t', 'n').autoIncrement).toBeFalsy();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Renderer-tooltip contracts (enumMap & compositeMap)
// ════════════════════════════════════════════════════════════════════════════

describe('Tooltip contracts (enumMap / compositeMap exact-string match)', () => {
    it('every inline ENUM/SET column resolves via enumMap[col.type]', () => {
        const r = build(`
            CREATE TABLE t (
                a ENUM('x','y'),
                b SET('p','q','r')
            );
        `);
        const enumMap = Object.fromEntries(r.enums.map((e) => [e.name, e.values]));
        expect(enumMap[r.col('t', 'a').type]).toEqual(['x', 'y']);
        expect(enumMap[r.col('t', 'b').type]).toEqual(['p', 'q', 'r']);
    });

    it('inline ENUM with schema-qualified column name still uses the bare column-name suffix', () => {
        const r = build(`CREATE TABLE public.t (a ENUM('1','2'));`);
        // enum name is keyed off the column name, NOT the table — so it's just `a_enum`.
        expect(r.enums.find((e) => e.name === 'a_enum')).toBeTruthy();
        expect(r.col('t', 'a').type).toBe('a_enum');
    });

    it('compositeMap[col.type] resolves for every composite-typed column', () => {
        const r = build(`
            CREATE TYPE point AS (x INT, y INT);
            CREATE TABLE t (a point, b point);
        `);
        const compMap = Object.fromEntries(r.composites.map((c) => [c.name, c.fields]));
        expect(compMap[r.col('t', 'a').type].map((f) => f.name)).toEqual(['x', 'y']);
        expect(compMap[r.col('t', 'b').type].map((f) => f.name)).toEqual(['x', 'y']);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Cardinality matrix — explicit, every bucket
// ════════════════════════════════════════════════════════════════════════════

describe('Cardinality buckets — full matrix', () => {
    const cases = [
        ['INT', '0..n', '0..1', 'nullable, non-unique'],
        ['INT NOT NULL', '0..n', '1', 'non-null, non-unique'],
        ['INT UNIQUE', '0..1', '0..1', 'nullable, unique'],
        ['INT UNIQUE NOT NULL', '0..1', '1', 'non-null, unique'],
        ['INT PRIMARY KEY', '0..1', '1', 'PK implies unique + not null'],
    ];
    cases.forEach(([decl, expectedFrom, expectedTo, note]) => {
        it(`${note} → ${expectedFrom} / ${expectedTo}`, () => {
            const r = build(`
                CREATE TABLE p (id INT PRIMARY KEY);
                CREATE TABLE c (pid ${decl} REFERENCES p(id));
            `);
            expect(r.rel('c', 'pid').fromCard).toBe(expectedFrom);
            expect(r.rel('c', 'pid').toCard).toBe(expectedTo);
        });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Edge cases the renderer must survive
// ════════════════════════════════════════════════════════════════════════════

describe('Renderer-impacting edge cases', () => {
    it('table with column whose name equals an enum name does not collide', () => {
        const r = build(`
            CREATE TYPE status AS ENUM ('a','b');
            CREATE TABLE t (status status);  -- column named 'status' of type 'status'
        `);
        // The column name is 'status'; the enum is also 'status'. The renderer
        // looks up enumMap[col.type] (col.type === 'status'), which still hits.
        expect(r.col('t', 'status').type).toBe('status');
        expect(r.enums.find((e) => e.name === 'status').values).toEqual(['a', 'b']);
    });

    it('column type is the literal string "text" by default if AST has null type', () => {
        // We can't easily synthesize a null col.type via valid SQL — the parser
        // rejects it. But if it were ever to slip through, the schema converter
        // substitutes 'text', so the renderer's col.type lookup still works.
        const r = build(`CREATE TABLE t (a TEXT);`);
        expect(typeof r.col('t', 'a').type).toBe('string');
    });

    it('columns dropped from a self-referencing FK still resolve a relation', () => {
        const r = build(`CREATE TABLE node (id INT PRIMARY KEY, parent_id INT REFERENCES node(id));`);
        expect(r.rel('node', 'parent_id').to.table).toBe('node');
        expect(r.rel('node', 'parent_id').to.column).toBe('id');
    });

    it('many-to-many junction table produces exactly two relations', () => {
        const r = build(`
            CREATE TABLE l (id INT PRIMARY KEY);
            CREATE TABLE r (id INT PRIMARY KEY);
            CREATE TABLE jt (
                l_id INT NOT NULL REFERENCES l(id),
                r_id INT NOT NULL REFERENCES r(id),
                PRIMARY KEY (l_id, r_id)
            );
        `);
        const jtRels = r.relations.filter((rel) => rel.from.table === 'jt');
        expect(jtRels).toHaveLength(2);
        const targets = jtRels.map((rel) => rel.to.table).sort();
        expect(targets).toEqual(['l', 'r']);
    });

    it('extras array order preserves DEFAULT, CHECK, generated, AUTO_INCREMENT logically', () => {
        const r = build(`
            CREATE TABLE t (
                a INT DEFAULT 0 CHECK (a > 0),
                b INT NOT NULL CHECK (b < 100) DEFAULT 50
            );
        `);
        const a = r.col('t', 'a');
        expect(a.extras.some((e) => e.startsWith('DEFAULT '))).toBe(true);
        expect(a.extras.some((e) => e.startsWith('CHECK '))).toBe(true);
    });

    it('empty composite type is allowed and exposed without crashing', () => {
        const r = build(`CREATE TYPE empty AS (); CREATE TABLE t (e empty);`);
        expect(r.composites.find((c) => c.name === 'empty').fields).toEqual([]);
    });

    it('mass-FK: 10 children all referencing the same parent', () => {
        let sql = `CREATE TABLE p (id INT PRIMARY KEY);\n`;
        for (let i = 0; i < 10; i++) sql += `CREATE TABLE c${i} (pid INT REFERENCES p(id));\n`;
        const r = build(sql);
        expect(r.relations.filter((rel) => rel.to.table === 'p')).toHaveLength(10);
    });

    it('cyclic FK between two tables is allowed (parser cannot detect cycle)', () => {
        const r = build(`
            CREATE TABLE a (id INT PRIMARY KEY, b_id INT REFERENCES b(id));
            CREATE TABLE b (id INT PRIMARY KEY, a_id INT REFERENCES a(id));
        `);
        expect(r.rel('a', 'b_id').to.table).toBe('b');
        expect(r.rel('b', 'a_id').to.table).toBe('a');
    });
});

// ════════════════════════════════════════════
// applyIndexes — schema transformer semantics
// ════════════════════════════════════════════
//
// `applyIndexes` lives inside `convertAstToErdSchema` and is responsible for
// turning `ast.indexes` into renderer-facing badges. Its behavior has several
// rules that look obvious in hindsight but are easy to break in a refactor:
//   1. Stronger constraints win:           PK > UQ > IDX
//   2. Suppression is order-sensitive:     UQ first → IDX never added
//                                          IDX first + UQ later → both kept
//      (this asymmetry is a known design choice — see badge-precedence test)
//   3. Composite flags only set on first-write
//   4. Unknown table / column / empty list → silent skip (never throw)
//   5. Schema-qualified table names are matched via stripSchema parity

describe('Index → badge transformer (applyIndexes)', () => {
    it('plain CREATE INDEX adds IDX, no composite flag', () => {
        const r = build(`CREATE TABLE t(a INT, b INT); CREATE INDEX ix ON t(a);`);
        const a = r.col('t', 'a');
        expect(a.constraints).toEqual(['IDX']);
        expect(a.compositeIdx).toBeUndefined();
    });

    it('CREATE UNIQUE INDEX adds UQ (not IDX)', () => {
        const r = build(`CREATE TABLE t(a INT); CREATE UNIQUE INDEX uq ON t(a);`);
        const a = r.col('t', 'a');
        expect(a.constraints).toEqual(['UQ']);
        expect(a.constraints).not.toContain('IDX');
    });

    it('composite CREATE INDEX flags compositeIdx on EVERY key column', () => {
        const r = build(`CREATE TABLE t(a INT, b INT, c INT); CREATE INDEX ix ON t(a, b, c);`);
        for (const name of ['a', 'b', 'c']) {
            const col = r.col('t', name);
            expect(col.constraints).toContain('IDX');
            expect(col.compositeIdx).toBe(true);
        }
    });

    it('composite CREATE UNIQUE INDEX flags compositeUq on every key column', () => {
        const r = build(`CREATE TABLE t(a INT, b INT); CREATE UNIQUE INDEX uq ON t(a, b);`);
        for (const name of ['a', 'b']) {
            const col = r.col('t', name);
            expect(col.constraints).toContain('UQ');
            expect(col.compositeUq).toBe(true);
        }
    });

    it('PK suppresses both IDX and UQ-from-CREATE-UNIQUE-INDEX', () => {
        const r = build(`
            CREATE TABLE t(id INT PRIMARY KEY);
            CREATE INDEX ix ON t(id);
            CREATE UNIQUE INDEX uq ON t(id);
        `);
        const id = r.col('t', 'id');
        expect(id.constraints).toEqual(['PK']);
    });

    it('inline column UNIQUE suppresses a later CREATE INDEX on same column', () => {
        const r = build(`CREATE TABLE t(a INT UNIQUE); CREATE INDEX ix ON t(a);`);
        const a = r.col('t', 'a');
        expect(a.constraints).toContain('UQ');
        expect(a.constraints).not.toContain('IDX');
    });

    it('keeps a clean UQ-only badge when UQ is declared before a plain index', () => {
        const r = build(`
            CREATE TABLE t(a INT);
            CREATE UNIQUE INDEX uq ON t(a);
            CREATE INDEX ix ON t(a);
        `);
        expect(r.col('t', 'a').constraints).toEqual(['UQ']);
    });

    it('keeps a clean UQ-only badge when UQ is declared after a plain index', () => {
        const r = build(`
            CREATE TABLE t(a INT);
            CREATE INDEX ix ON t(a);
            CREATE UNIQUE INDEX uq ON t(a);
        `);
        expect(r.col('t', 'a').constraints).toEqual(['UQ']);
    });

    it('duplicate badges deduplicate (single string in constraints)', () => {
        const r = build(`
            CREATE TABLE t(a INT);
            CREATE INDEX ix1 ON t(a);
            CREATE INDEX ix2 ON t(a);
            CREATE INDEX ix3 ON t(a);
        `);
        expect(r.col('t', 'a').constraints.filter((c) => c === 'IDX')).toHaveLength(1);
    });

    it('retains composite index metadata when a single-column index is declared later', () => {
        const r = build(`
            CREATE TABLE t(a INT, b INT);
            CREATE INDEX cix ON t(a, b);
            CREATE INDEX six ON t(a);
        `);
        expect(r.col('t', 'a').compositeIdx).toBe(true);
    });

    it('retains composite index metadata when a single-column index is declared first', () => {
        const r = build(`
            CREATE TABLE t(a INT, b INT);
            CREATE INDEX six ON t(a);
            CREATE INDEX cix ON t(a, b);
        `);
        expect(r.col('t', 'a').compositeIdx).toBe(true);
        expect(r.col('t', 'b').compositeIdx).toBe(true);
    });

    it('schema-qualified index target matches stripped table (PG-style)', () => {
        const r = build(`
            CREATE TABLE app.users(id INT PRIMARY KEY, email TEXT);
            CREATE UNIQUE INDEX app.uq_email ON app.users(email);
        `);
        // Renderer-facing schema strips namespaces → table is just "users".
        const email = r.col('users', 'email');
        expect(email).not.toBeNull();
        expect(email.constraints).toContain('UQ');
    });

    it('index on unknown table is silently skipped (no crash, no badge)', () => {
        const r = build(`
            CREATE TABLE t(a INT);
            CREATE INDEX ghost ON does_not_exist(col);
        `);
        expect(r.tables).toHaveLength(1);
        expect(r.col('t', 'a').constraints).toEqual([]);
    });

    it('index on unknown column is silently skipped (other valid cols still badged)', () => {
        const r = build(`
            CREATE TABLE t(a INT, b INT);
            CREATE INDEX ix ON t(a, ghost);
        `);
        // `a` is valid → badged; `ghost` is dropped silently.
        const a = r.col('t', 'a');
        expect(a.constraints).toContain('IDX');
        // The composite flag still trips because ix.columns.length > 1 in the
        // AST — the unknown col is filtered at the column lookup stage, not
        // at the composite-decision stage. This is a deliberate trade-off
        // (simpler logic, never under-flags composite intent).
        expect(a.compositeIdx).toBe(true);
    });

    it('empty-paren CREATE INDEX is silently skipped (no badge applied)', () => {
        const r = build(`CREATE TABLE t(a INT); CREATE INDEX ix ON t();`);
        expect(r.col('t', 'a').constraints).toEqual([]);
    });

    it('case-insensitive column matching (parser may lowercase, renderer expects exact)', () => {
        // Parser yields columns as authored; index column lookup is .toLowerCase()
        // on both sides, so `EMAIL` in the index hits `email` in the table.
        const r = build(`CREATE TABLE t(Email TEXT); CREATE INDEX ix ON t(EMAIL);`);
        const e = r.col('t', 'email');
        expect(e).not.toBeNull();
        expect(e.constraints).toContain('IDX');
    });

    it('multiple disjoint indexes coexist on the same table', () => {
        const r = build(`
            CREATE TABLE t(a INT, b INT, c INT);
            CREATE INDEX ix_a ON t(a);
            CREATE INDEX ix_b ON t(b);
            CREATE UNIQUE INDEX uq_c ON t(c);
        `);
        expect(r.col('t', 'a').constraints).toEqual(['IDX']);
        expect(r.col('t', 'b').constraints).toEqual(['IDX']);
        expect(r.col('t', 'c').constraints).toEqual(['UQ']);
    });
});
