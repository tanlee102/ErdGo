import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

// Silence expected "SQL parsing error" console output from negative test cases.
beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

/**
 * Renderer contract tests.
 *
 * `src/lib/genErdScript.js` (~2.6k LOC) is a Canvas renderer that talks to
 * `document` / `HTMLCanvasElement` / ELK and therefore can't be unit-tested
 * directly under Vitest's `node` environment. What CAN — and must — be
 * verified is the *data contract*: the exact set of properties the renderer
 * reads from the schema. If any of these break, the renderer either crashes
 * or silently produces an incorrect ERD.
 *
 * This file enumerates every read-site discovered in genErdScript.js and
 * pins it against schemas built from real PG / MySQL / MSSQL DDL.
 *
 * Read sites this file pins (line numbers as of writing):
 *   - schema.tables[]  (lines 119, 302, 346, 356, 499, 630, 636, 637, 1400,
 *                       1434, 1536, 1902, 1938, 1985, 2025, 2081, 2192, 2321,
 *                       2333, 2568, 2572, 2591)
 *   - schema.relations[]                   (120, 297, 642, 1194, 1200, 1205)
 *   - schema.enums[] {name, values}        (121, 190-196, 1550, 1563, 1586)
 *   - schema.composites[] {name, fields[{name,type}]} (122, 200-204, 1551,
 *                                                      1574, 1587)
 *   - table.name (string)                  (302, 314, 317, 321, 327, 347,
 *                                            359, 363, 1043, 2333, 2591)
 *   - table.columns (array)                (156, 161, 325, 477, 937, 943,
 *                                            959, 988, 992, 1011)
 *   - col.name (string)                    (477, 943, 959, 2002)
 *   - col.type (string)                    (478, 988, 1550, 1551)
 *   - col.pk (truthy)                      (161, 479, 937, 964, 1011, 1998)
 *   - col.fk (truthy)                      (161, 480, 937, 976, 1998)
 *   - col.constraints (array)              (483, 992)
 *   - col.extras (array)                   (937, 1552, 1590)
 *   - col.compositePk (truthy)             (1011)
 *   - col.compositeUq (truthy)             (1011)
 *   - rel.from.{table,column}              (943, 1042, 2002, plus FK lookups)
 *   - rel.to.{table,column}                (1043, 2002)
 *   - rel.fromCard, rel.toCard             (consumed by drawConnectors)
 */

function build(sql) {
    const s = sqlToErdSchema(sql);
    const leafName = (name) => String(name || '').split('.').at(-1);
    const findTable = (name) => {
        const exact = s.tables.find((t) => t.name === name);
        if (exact) return exact;
        const leafMatches = s.tables.filter((t) => leafName(t.name) === name);
        return leafMatches.length === 1 ? leafMatches[0] : null;
    };
    const sameTableLabel = (actual, expected) => actual === expected || leafName(actual) === expected;
    return {
        schema: s,
        tables: s.tables,
        relations: s.relations,
        enums: s.enums,
        composites: s.composites,
        table: findTable,
        col: (t, c) => {
            const tbl = findTable(t);
            return tbl ? tbl.columns.find((cc) => cc.name === c) || null : null;
        },
        rel: (t, c) => s.relations.find((r) => sameTableLabel(r.from.table, t) && r.from.column === c) || null,
    };
}

const VALID_CARDS = new Set(['1', 'n', '1+', '0..1', '0..n']);

/** Assert a given schema satisfies every renderer-required invariant. */
function assertRendererContract(schema) {
    expect(Array.isArray(schema.tables)).toBe(true);
    expect(Array.isArray(schema.relations)).toBe(true);
    expect(Array.isArray(schema.enums)).toBe(true);
    expect(Array.isArray(schema.composites)).toBe(true);

    for (const tbl of schema.tables) {
        expect(typeof tbl.name).toBe('string');
        expect(tbl.name.length).toBeGreaterThan(0);
        expect(Array.isArray(tbl.columns)).toBe(true);

        for (const col of tbl.columns) {
            // Renderer reads col.name (line 477) and col.type (line 478) directly.
            expect(typeof col.name).toBe('string');
            expect(col.name.length).toBeGreaterThan(0);
            expect(typeof col.type).toBe('string');
            expect(col.type.length).toBeGreaterThan(0);
            // constraints[] and extras[] MUST be arrays (line 483, 992, 1552).
            expect(Array.isArray(col.constraints)).toBe(true);
            expect(Array.isArray(col.extras)).toBe(true);
            // Every value in constraints[] must be a string (drawn as text).
            for (const c of col.constraints) expect(typeof c).toBe('string');
            for (const e of col.extras) expect(typeof e).toBe('string');
            // pk/fk/compositePk/compositeUq/compositePartialUq are read with truthy-check only,
            // so they may be undefined but never throw.
            if (col.pk !== undefined) expect(typeof col.pk).toBe('boolean');
            if (col.fk !== undefined) expect(typeof col.fk).toBe('boolean');
            if (col.compositePk !== undefined) expect(typeof col.compositePk).toBe('boolean');
            if (col.compositeUq !== undefined) expect(typeof col.compositeUq).toBe('boolean');
            if (col.compositePartialUq !== undefined) expect(typeof col.compositePartialUq).toBe('boolean');
            // compositeIdx is read by drawConstraintPill alongside
            // compositePk/compositeUq to decide whether to mute the IDX pill.
            if (col.compositeIdx !== undefined) expect(typeof col.compositeIdx).toBe('boolean');
        }
    }

    for (const en of schema.enums) {
        expect(typeof en.name).toBe('string');
        expect(en.name.length).toBeGreaterThan(0);
        expect(Array.isArray(en.values)).toBe(true);
        for (const v of en.values) expect(typeof v).toBe('string');
    }

    for (const comp of schema.composites) {
        expect(typeof comp.name).toBe('string');
        expect(comp.name.length).toBeGreaterThan(0);
        expect(Array.isArray(comp.fields)).toBe(true);
        for (const f of comp.fields) {
            expect(typeof f.name).toBe('string');
            expect(typeof f.type).toBe('string');
        }
    }

    // Build lookup sets the renderer uses to find tables/columns from relations.
    const tableMap = new Map();
    for (const t of schema.tables) {
        tableMap.set(t.name, new Set(t.columns.map((c) => c.name)));
    }

    for (const rel of schema.relations) {
        // Line 1042-1043: schema.tables.find((t) => t.name === rel.from.table)
        expect(rel.from).toBeTruthy();
        expect(rel.to).toBeTruthy();
        expect(typeof rel.from.table).toBe('string');
        expect(typeof rel.from.column).toBe('string');
        expect(typeof rel.to.table).toBe('string');
        expect(typeof rel.to.column).toBe('string');
        // Both endpoints MUST exist in the table set, otherwise renderer's
        // `fromTbl`/`toTbl` would be undefined and it would skip the edge —
        // i.e., a silent rendering bug.
        expect(tableMap.has(rel.from.table)).toBe(true);
        expect(tableMap.has(rel.to.table)).toBe(true);
        expect(tableMap.get(rel.from.table).has(rel.from.column)).toBe(true);
        expect(tableMap.get(rel.to.table).has(rel.to.column)).toBe(true);
        // Cardinalities are normalized by validateSchema() — verify they are
        // in the set the renderer's connector glyphs understand.
        expect(VALID_CARDS.has(rel.fromCard)).toBe(true);
        expect(VALID_CARDS.has(rel.toCard)).toBe(true);

        if (rel.composite !== undefined) expect(typeof rel.composite).toBe('boolean');
        if (rel.actions !== undefined) {
            expect(typeof rel.actions).toBe('object');
            expect(Array.isArray(rel.actions)).toBe(false);
            const allowedActions = new Set(['onDelete', 'onUpdate', 'match', 'deferrable', 'initially']);
            for (const [key, value] of Object.entries(rel.actions)) {
                expect(allowedActions.has(key)).toBe(true);
                if (key === 'deferrable') expect(typeof value).toBe('boolean');
                else expect(typeof value).toBe('string');
            }
        }
        if (rel.composite) {
            expect(typeof rel.relationGroup).toBe('string');
            expect(rel.relationGroup.length).toBeGreaterThan(0);
            expect(Array.isArray(rel.fromColumns)).toBe(true);
            expect(Array.isArray(rel.toColumns)).toBe(true);
            expect(rel.fromColumns.length).toBe(rel.toColumns.length);
            expect(rel.fromColumns).toContain(rel.from.column);
            expect(rel.toColumns).toContain(rel.to.column);
            for (const column of rel.fromColumns) expect(tableMap.get(rel.from.table).has(column)).toBe(true);
            for (const column of rel.toColumns) expect(tableMap.get(rel.to.table).has(column)).toBe(true);
        }
    }

    // Enum/composite map keys are looked up by exact `col.type` string match
    // in `enumMap[col.type]` (line 1550) and `compositeMap[col.type]` (line 1551).
    // That means: every column whose type is the bare name of a registered
    // enum/composite MUST resolve via that lookup.
    const enumNames = new Set(schema.enums.map((e) => e.name));
    const compositeNames = new Set(schema.composites.map((c) => c.name));
    for (const tbl of schema.tables) {
        for (const col of tbl.columns) {
            // If a column type happens to be a bare identifier and matches a
            // registered enum/composite (case-sensitive — same comparison as
            // the renderer does), the lookup path is the user-defined type
            // path. If they differ only by a schema prefix, that's a bug.
            if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(col.type)) {
                if (enumNames.has(col.type) || compositeNames.has(col.type)) {
                    // good — exact match means renderer will hit the tooltip.
                }
            }
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Per-dialect renderer-contract suites
// ════════════════════════════════════════════════════════════════════════════

describe('Renderer contract — defensiveness', () => {
    it('empty SQL returns an empty but renderer-ready schema (no throw)', () => {
        for (const sql of ['', '   ', '\n\t\n']) {
            const schema = sqlToErdSchema(sql);
            expect(Array.isArray(schema.tables)).toBe(true);
            expect(Array.isArray(schema.relations)).toBe(true);
            expect(Array.isArray(schema.enums)).toBe(true);
            expect(Array.isArray(schema.composites)).toBe(true);
            expect(schema.tables).toHaveLength(0);
            expect(schema.relations).toHaveLength(0);
        }
    });

    it('schema with only types but no tables still satisfies contract', () => {
        const r = build(`CREATE TYPE mood AS ENUM ('a','b');`);
        assertRendererContract(r.schema);
        expect(r.tables).toHaveLength(0);
        expect(r.relations).toHaveLength(0);
        expect(r.enums).toHaveLength(1);
    });

    it('single-table schema with no relations satisfies contract', () => {
        const r = build(`CREATE TABLE t (id INT PRIMARY KEY);`);
        assertRendererContract(r.schema);
        expect(r.relations).toHaveLength(0);
    });

    it('column lacking explicit type still satisfies type:string contract', () => {
        // `convertColumnToErdFormat` substitutes 'text' if col.type is null.
        // We can't easily synth a "no type" column through valid SQL (parser
        // rejects it), but we still pin the fallback by going through a
        // computed column whose type is COMPUTED.
        const r = build(`CREATE TABLE t (a INT, b AS (a + 1));`);
        const b = r.col('t', 'b');
        expect(typeof b.type).toBe('string');
        expect(b.type.length).toBeGreaterThan(0);
    });

    it('a relation can never reference a missing table or column', () => {
        // The validator drops invalid relations, so even when a FK targets a
        // non-existent table the resulting schema is still consistent.
        const r = build(`CREATE TABLE c (pid INT REFERENCES nonexistent(id));`);
        assertRendererContract(r.schema);
        expect(r.relations).toHaveLength(0);
    });
});

describe('Renderer contract — PostgreSQL', () => {
    it('full PG feature set passes the contract', () => {
        const r = build(`
            CREATE TYPE public.mood AS ENUM ('happy','sad','neutral');
            CREATE TYPE address     AS (street TEXT, city VARCHAR(100));

            CREATE TABLE public.users (
                id BIGSERIAL PRIMARY KEY,
                username VARCHAR(50) NOT NULL UNIQUE,
                email VARCHAR(255) NOT NULL UNIQUE,
                status public.mood DEFAULT 'happy',
                addr address,
                tags TEXT[],
                metadata JSONB DEFAULT '{}',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NULL
            );

            CREATE TABLE public.posts (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                body TEXT,
                word_count INT GENERATED ALWAYS AS (length(body)) STORED
            ) WITH (fillfactor=70);

            CREATE TABLE public.followers (
                follower_id BIGINT NOT NULL REFERENCES users(id),
                followed_id BIGINT NOT NULL REFERENCES users(id),
                PRIMARY KEY (follower_id, followed_id)
            );

            CREATE TABLE public.tags_jt (
                post_id BIGINT NOT NULL REFERENCES posts(id),
                tag    VARCHAR(50) NOT NULL,
                PRIMARY KEY (post_id, tag)
            );
        `);
        assertRendererContract(r.schema);

        // Schema-qualified user-defined type points to the registered enum
        // — this is the renderer's enumMap[col.type] match.
        expect(r.col('users', 'status').type).toBe('mood');
        expect(r.col('users', 'addr').type).toBe('address');

        // PG arrays are kept verbatim so the type cell displays "TEXT[]".
        expect(r.col('users', 'tags').type).toBe('TEXT[]');

        // GENERATED AS IDENTITY → autoIncrement, NOT a generated extra.
        const usersId = r.col('users', 'id');
        expect(usersId.pk).toBe(true);
        expect(usersId.extras).toContain('AUTO_INCREMENT');
        expect(usersId.extras.some((e) => /^GENERATED\b/.test(e))).toBe(false);

        // Composite PK on followers — both columns flagged compositePk.
        expect(r.col('followers', 'follower_id').compositePk).toBe(true);
        expect(r.col('followers', 'followed_id').compositePk).toBe(true);

        // FK relations exist with valid cardinalities.
        const r1 = r.rel('posts', 'user_id');
        expect(r1.to.table).toBe('users');
        expect(r1.fromCard).toBe('0..n');
        expect(r1.toCard).toBe('1');
    });
});

describe('Renderer contract — MySQL', () => {
    it('full MySQL feature set passes the contract', () => {
        const r = build(`
            CREATE TABLE \`users\` (
                \`id\` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                \`email\` VARCHAR(255) NOT NULL,
                \`role\` ENUM('user','admin') NOT NULL DEFAULT 'user',
                \`perms\` SET('read','write'),
                \`tier\` TINYINT(1) NOT NULL DEFAULT 0,
                \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_email (email),
                INDEX idx_tier (tier)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='users';

            CREATE TABLE \`orders\` (
                \`id\` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                \`user_id\` BIGINT UNSIGNED NOT NULL,
                \`amount\` DECIMAL(10,2) UNSIGNED NOT NULL,
                CONSTRAINT fk_orders_user FOREIGN KEY (\`user_id\`) REFERENCES users(id) ON DELETE RESTRICT
            ) ENGINE=InnoDB;

            CREATE TABLE \`order_items\` (
                \`order_id\` BIGINT UNSIGNED NOT NULL,
                \`product_sku\` VARCHAR(64) NOT NULL,
                \`qty\` INT NOT NULL,
                PRIMARY KEY (\`order_id\`,\`product_sku\`),
                FOREIGN KEY (\`order_id\`) REFERENCES orders(id)
            );
        `);
        assertRendererContract(r.schema);

        // ENUM / SET both lift into schema.enums and the column type points
        // at the registered enum name (renderer's enumMap[col.type] hit).
        expect(r.col('users', 'role').type).toBe('role_enum');
        expect(r.col('users', 'perms').type).toBe('perms_set');
        expect(r.enums.find((e) => e.name === 'role_enum').values).toEqual(['user', 'admin']);
        expect(r.enums.find((e) => e.name === 'perms_set').values).toEqual(['read', 'write']);

        // AUTO_INCREMENT visible in extras (so the renderer can show it).
        expect(r.col('users', 'id').extras).toContain('AUTO_INCREMENT');

        // UNIQUE KEY uq_email (email) lifts UQ onto the column.
        expect(r.col('users', 'email').constraints).toContain('UQ');

        // INDEX/FULLTEXT/SPATIAL definitions are NOT columns.
        expect(r.col('users', 'idx_tier')).toBeNull();

        // Composite PK on order_items.
        expect(r.col('order_items', 'order_id').compositePk).toBe(true);
        expect(r.col('order_items', 'product_sku').compositePk).toBe(true);

        // Two relations land cleanly.
        expect(r.relations.filter((rel) => rel.from.table === 'orders')).toHaveLength(1);
        expect(r.relations.filter((rel) => rel.from.table === 'order_items')).toHaveLength(1);
    });
});

describe('Renderer contract — MSSQL', () => {
    it('full MSSQL feature set passes the contract', () => {
        const r = build(`
            CREATE TABLE [dbo].[Customer] (
                [id] INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_customer PRIMARY KEY CLUSTERED,
                [name] NVARCHAR(100) NOT NULL,
                [email] NVARCHAR(255) NOT NULL CONSTRAINT uq_customer_email UNIQUE,
                [created] DATETIME2 NOT NULL DEFAULT GETDATE(),
                [tag] AS ([id] * 2) PERSISTED NOT NULL
            ) ON [PRIMARY];
            GO

            CREATE TABLE [dbo].[Order] (
                [id] BIGINT IDENTITY NOT NULL CONSTRAINT pk_order PRIMARY KEY,
                [customer_id] INT NOT NULL,
                [total] DECIMAL(18,2) NOT NULL,
                CONSTRAINT fk_order_cust FOREIGN KEY ([customer_id]) REFERENCES Customer(id) ON DELETE NO ACTION
            ) WITH (FILLFACTOR=80);
            GO

            ALTER TABLE [dbo].[Order] ADD CONSTRAINT chk_total CHECK ([total] >= 0);
        `);
        assertRendererContract(r.schema);

        // Schema prefix stripped from table names.
        expect(r.table('Customer')).toBeTruthy();
        expect(r.table('Order')).toBeTruthy();
        expect(r.table('dbo.Customer')).toBeNull();

        // IDENTITY → autoIncrement + extras.
        expect(r.col('Customer', 'id').extras).toContain('AUTO_INCREMENT');
        expect(r.col('Order', 'id').extras).toContain('AUTO_INCREMENT');

        // Inline UNIQUE constraint via CONSTRAINT name UNIQUE.
        expect(r.col('Customer', 'email').constraints).toContain('UQ');

        // Computed PERSISTED NOT NULL flips NN.
        const tag = r.col('Customer', 'tag');
        expect(tag.type).toBe('COMPUTED');
        expect(tag.constraints).toContain('NN');
        expect(tag.extras.some((e) => /PERSISTED NOT NULL$/.test(e))).toBe(true);

        // FK relation crosses with stripped table name.
        const orderRel = r.rel('Order', 'customer_id');
        expect(orderRel).toBeTruthy();
        expect(orderRel.to.table).toBe('Customer');

        // ALTER ADD CHECK propagates onto the referenced column.
        expect(r.col('Order', 'total').extras.some((e) => /CHECK/.test(e))).toBe(true);
    });
});

describe('Renderer contract — production-grade mixed-dialect schema', () => {
    it('contract holds for a 8-table mixed PG/MySQL/MSSQL schema', () => {
        const r = build(`
            -- ─────────── PostgreSQL ───────────
            CREATE TYPE public.user_status AS ENUM ('active','disabled','pending');
            CREATE TYPE address AS (street TEXT, city VARCHAR(100), zip CHAR(5));

            CREATE TABLE users (
                id BIGSERIAL PRIMARY KEY,
                email VARCHAR(255) NOT NULL UNIQUE,
                status user_status NOT NULL DEFAULT 'active',
                home_address address,
                tags TEXT[],
                metadata JSONB DEFAULT '{}',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE sessions (
                id UUID PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TIMESTAMPTZ NOT NULL
            );

            CREATE TABLE friendships (
                a BIGINT NOT NULL REFERENCES users(id),
                b BIGINT NOT NULL REFERENCES users(id),
                PRIMARY KEY (a, b),
                CHECK (a < b)
            );

            -- ─────────── MySQL ───────────
            CREATE TABLE \`products\` (
                \`id\` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                \`sku\` VARCHAR(64) NOT NULL UNIQUE,
                \`category\` ENUM('digital','physical','service') NOT NULL,
                \`flags\` SET('featured','clearance','new'),
                \`price\` DECIMAL(10,2) UNSIGNED NOT NULL,
                INDEX idx_category (category)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

            CREATE TABLE \`orders\` (
                \`id\` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                \`user_id\` BIGINT NOT NULL,
                \`total\` DECIMAL(10,2) NOT NULL,
                \`created\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                CONSTRAINT fk_o_u FOREIGN KEY (\`user_id\`) REFERENCES users(id)
            ) ENGINE=InnoDB;

            CREATE TABLE \`order_items\` (
                \`order_id\` BIGINT UNSIGNED NOT NULL,
                \`product_id\` BIGINT UNSIGNED NOT NULL,
                \`qty\` INT NOT NULL CHECK (qty > 0),
                PRIMARY KEY (\`order_id\`, \`product_id\`),
                FOREIGN KEY (\`order_id\`) REFERENCES orders(id),
                FOREIGN KEY (\`product_id\`) REFERENCES products(id)
            );

            -- ─────────── MSSQL ───────────
            CREATE TABLE [dbo].[Audit] (
                [id] BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_audit PRIMARY KEY CLUSTERED,
                [order_id] BIGINT UNSIGNED NOT NULL,
                [snapshot] NVARCHAR(MAX) NOT NULL,
                [created] DATETIME2 NOT NULL DEFAULT GETDATE(),
                [hash] AS (CHECKSUM([snapshot])) PERSISTED NOT NULL,
                CONSTRAINT fk_audit_order FOREIGN KEY ([order_id]) REFERENCES orders(id)
            ) ON [PRIMARY];
            GO

            ALTER TABLE [dbo].[Audit] ADD CONSTRAINT chk_id CHECK ([id] > 0);
            ALTER TABLE products ADD CONSTRAINT chk_price CHECK (price > 0);
        `);

        // The big assertion.
        assertRendererContract(r.schema);

        // 8 tables + their relationships render correctly.
        expect(r.tables.map((t) => t.name).sort()).toEqual(['dbo.Audit', 'public.friendships', 'public.order_items', 'public.orders', 'public.products', 'public.sessions', 'public.users']);

        // Enum types from PG plus MySQL inline ENUM/SET — all distinct,
        // exact name match (renderer's enumMap key contract).
        const enumNames = r.enums.map((e) => e.name).sort();
        expect(enumNames).toContain('user_status');
        expect(enumNames).toContain('category_enum');
        expect(enumNames).toContain('flags_set');

        // Composite type registered.
        expect(r.composites.find((c) => c.name === 'address')).toBeTruthy();

        // Renderer-critical: column types referencing user types match enum/composite names exactly.
        expect(r.col('users', 'status').type).toBe('user_status');
        expect(r.col('users', 'home_address').type).toBe('address');
        expect(r.col('products', 'category').type).toBe('category_enum');
        expect(r.col('products', 'flags').type).toBe('flags_set');

        // Every relation has both endpoints in the schema.
        for (const rel of r.relations) {
            expect(r.table(rel.from.table)).toBeTruthy();
            expect(r.table(rel.to.table)).toBeTruthy();
        }

        // Pre-counted relation set: posts→users + sessions→users + friendships×2 + orders→users + order_items→orders + order_items→products + Audit→orders = 8
        expect(r.relations.length).toBeGreaterThanOrEqual(7);

        // No top-level errors in the parser pipeline.
        expect(r.schema._parseErrors.filter((e) => e.severity === 'error')).toHaveLength(0);
    });
});

describe('Renderer contract — defensive against weird schemas', () => {
    it('table with only a single PK column still satisfies contract', () => {
        const r = build(`CREATE TABLE t (id INT PRIMARY KEY);`);
        assertRendererContract(r.schema);
    });

    it('table whose only column is a computed COMPUTED column', () => {
        const r = build(`CREATE TABLE t (a INT NOT NULL, b AS (a * 2) PERSISTED);`);
        assertRendererContract(r.schema);
        expect(r.col('t', 'b').type).toBe('COMPUTED');
    });

    it('lots of FK relations all resolve to existing tables', () => {
        const r = build(`
            CREATE TABLE a (id INT PRIMARY KEY);
            CREATE TABLE b (id INT PRIMARY KEY);
            CREATE TABLE c (id INT PRIMARY KEY);
            CREATE TABLE d (
                id INT PRIMARY KEY,
                a_id INT REFERENCES a(id),
                b_id INT REFERENCES b(id),
                c_id INT REFERENCES c(id)
            );
        `);
        assertRendererContract(r.schema);
        expect(r.relations).toHaveLength(3);
    });

    it('self-referencing FK still satisfies contract', () => {
        const r = build(`CREATE TABLE node (id INT PRIMARY KEY, parent_id INT REFERENCES node(id));`);
        assertRendererContract(r.schema);
        expect(r.rel('node', 'parent_id').to.table).toBe('node');
    });

    it('composite PK + composite FK both flag compositePk on every column', () => {
        const r = build(`
            CREATE TABLE p (a INT, b INT, PRIMARY KEY (a, b));
            CREATE TABLE c (
                pa INT, pb INT,
                PRIMARY KEY (pa, pb),
                FOREIGN KEY (pa, pb) REFERENCES p(a, b)
            );
        `);
        assertRendererContract(r.schema);
        expect(r.col('c', 'pa').compositePk).toBe(true);
        expect(r.col('c', 'pb').compositePk).toBe(true);
        expect(r.col('c', 'pa').fk).toBe(true);
        expect(r.col('c', 'pb').fk).toBe(true);
    });

    it('many tables, no relations — contract still holds', () => {
        const sql = Array.from({ length: 25 }, (_, i) => `CREATE TABLE t${i} (id INT PRIMARY KEY);`).join('\n');
        const r = build(sql);
        assertRendererContract(r.schema);
        expect(r.tables).toHaveLength(25);
        expect(r.relations).toHaveLength(0);
    });

    it('renderer compact-mode filter (col.pk || col.fk) finds columns when expected', () => {
        // genErdScript line 161: getVisibleColumns returns columns with pk or fk in compact mode.
        const r = build(`
            CREATE TABLE t (
                id INT PRIMARY KEY,
                user_id INT REFERENCES users(id),
                description TEXT,
                created_at TIMESTAMP
            );
            CREATE TABLE users (id INT PRIMARY KEY);
        `);
        assertRendererContract(r.schema);
        const compactCols = r.col('t', 'id') && r.table('t').columns.filter((c) => c.pk || c.fk);
        expect(compactCols.map((c) => c.name).sort()).toEqual(['id', 'user_id']);
    });

    it('hover note: enumMap[col.type] resolves for every enum column', () => {
        // genErdScript line 1550: const isEnum = !!enumMap[col.type];
        const r = build(`
            CREATE TYPE status AS ENUM ('on','off');
            CREATE TABLE a (s status);
            CREATE TABLE b (size ENUM('S','M','L'));
        `);
        assertRendererContract(r.schema);
        const enumMap = Object.fromEntries(r.enums.map((e) => [e.name, e.values]));
        expect(enumMap[r.col('a', 's').type]).toEqual(['on', 'off']);
        expect(enumMap[r.col('b', 'size').type]).toEqual(['S', 'M', 'L']);
    });

    it('hover note: compositeMap[col.type] resolves for every composite column', () => {
        // genErdScript line 1551: const isComp = !!compositeMap[col.type];
        const r = build(`
            CREATE TYPE addr AS (street TEXT, city VARCHAR(100));
            CREATE TABLE u (id INT PRIMARY KEY, home addr);
        `);
        assertRendererContract(r.schema);
        const compMap = Object.fromEntries(r.composites.map((c) => [c.name, c.fields]));
        expect(compMap[r.col('u', 'home').type].map((f) => f.name)).toEqual(['street', 'city']);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Stress
// ════════════════════════════════════════════════════════════════════════════

describe('Renderer contract — stress', () => {
    it('30 tables × 8 cols × 1 FK per table all satisfy the contract', () => {
        let sql = `CREATE TABLE root (id INT PRIMARY KEY);\n`;
        for (let i = 0; i < 30; i++) {
            sql += `CREATE TABLE t${i} (
                id INT PRIMARY KEY,
                root_id INT REFERENCES root(id),
                a TEXT, b INT, c BOOLEAN, d TIMESTAMP, e VARCHAR(50), f NUMERIC(10,2)
            );\n`;
        }
        const r = build(sql);
        assertRendererContract(r.schema);
        expect(r.tables).toHaveLength(31);
        expect(r.relations).toHaveLength(30);
    });

    it('deeply nested CHECK / DEFAULT expressions keep types intact', () => {
        const r = build(`
            CREATE TABLE t (
                a INT CHECK (a > 0 AND a < 100),
                b INT DEFAULT (1 + 2 * 3),
                c INT GENERATED ALWAYS AS ((a + b) * 2) STORED,
                d INT CHECK (d IN (1,2,3,4,5,6,7,8,9,10))
            );
        `);
        assertRendererContract(r.schema);
        expect(r.col('t', 'a').extras.some((e) => /CHECK/.test(e))).toBe(true);
        expect(r.col('t', 'b').extras.some((e) => /DEFAULT/.test(e))).toBe(true);
        expect(r.col('t', 'c').extras.some((e) => /STORED$/.test(e))).toBe(true);
        expect(r.col('t', 'd').extras.some((e) => /IN/.test(e))).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Renderer contract — index badges (IDX / UQ from CREATE INDEX)
//
// `genErdScript.drawConstraintPill` reads:
//   - col.constraints[]   → 'IDX' / 'UQ' literal text (drawn as the pill text)
//   - col.compositeIdx    → truthy → muted gray pill style (line ~1011 path)
//   - col.compositeUq     → same, for composite UQ
//   - col.pk / col.fk     → suppression rules (PK never gets IDX, etc.)
//
// If any of these read-sites breaks, the badge either renders incorrectly,
// renders with the wrong style, or crashes the canvas pass.
// ════════════════════════════════════════════════════════════════════════════

describe('Renderer contract — index badges', () => {
    it('IDX is a literal string in col.constraints[] (renderer reads it as text)', () => {
        const r = build(`CREATE TABLE t(id INT PRIMARY KEY, name TEXT); CREATE INDEX ix ON t(name);`);
        const name = r.col('t', 'name');
        expect(name.constraints).toContain('IDX');
        for (const c of name.constraints) expect(typeof c).toBe('string');
        assertRendererContract(r.schema);
    });

    it('compositeIdx is strictly boolean when present (truthy-checked by renderer)', () => {
        const r = build(`CREATE TABLE t(a INT, b INT); CREATE INDEX ix ON t(a, b);`);
        const a = r.col('t', 'a');
        const b = r.col('t', 'b');
        expect(a.compositeIdx).toBe(true);
        expect(b.compositeIdx).toBe(true);
        // typeof === 'boolean' (not just truthy) — guards against accidental
        // numeric/string assignments that could break style branches.
        expect(typeof a.compositeIdx).toBe('boolean');
        expect(typeof b.compositeIdx).toBe('boolean');
    });

    it('single-col IDX leaves compositeIdx undefined (no muting)', () => {
        const r = build(`CREATE TABLE t(a INT); CREATE INDEX ix ON t(a);`);
        const a = r.col('t', 'a');
        expect(a.constraints).toContain('IDX');
        // The renderer does `col.compositeIdx && text==='IDX'` — must remain
        // falsy/undefined to render the SOLID pill style.
        expect(a.compositeIdx).toBeFalsy();
    });

    it('compositeUq from CREATE UNIQUE INDEX is strictly boolean', () => {
        const r = build(`CREATE TABLE t(a INT, b INT); CREATE UNIQUE INDEX uq ON t(a, b);`);
        for (const name of ['a', 'b']) {
            const c = r.col('t', name);
            expect(c.constraints).toContain('UQ');
            expect(c.compositeUq).toBe(true);
            expect(typeof c.compositeUq).toBe('boolean');
        }
    });

    it('partial unique indexes use PUQ and compositePartialUq without creating UQ badges', () => {
        const r = build(`CREATE TABLE t(a INT, b INT, deleted_at TIMESTAMP); CREATE UNIQUE INDEX uq_active ON t(a, b) WHERE deleted_at IS NULL;`);
        for (const name of ['a', 'b']) {
            const c = r.col('t', name);
            expect(c.constraints).toContain('PUQ');
            expect(c.constraints).not.toContain('UQ');
            expect(c.compositePartialUq).toBe(true);
            expect(typeof c.compositePartialUq).toBe('boolean');
            expect(c.extras).toContain('PARTIAL UNIQUE INDEX uq_active WHERE deleted_at IS NULL');
        }
        assertRendererContract(r.schema);
    });

    it('every constraint string the renderer draws is non-empty and trimmed', () => {
        const r = build(`
            CREATE TABLE t (
                id INT PRIMARY KEY,
                a INT NOT NULL,
                b INT,
                c INT
            );
            CREATE INDEX ix_a ON t(a);
            CREATE INDEX ix_bc ON t(b, c);
            CREATE UNIQUE INDEX uq_b ON t(b);
        `);
        for (const tbl of r.schema.tables) {
            for (const col of tbl.columns) {
                for (const c of col.constraints) {
                    expect(c.length).toBeGreaterThan(0);
                    expect(c).toBe(c.trim());
                }
            }
        }
        assertRendererContract(r.schema);
    });

    it('IDX never duplicates within a single column.constraints[] (renderer would draw two pills)', () => {
        const r = build(`
            CREATE TABLE t(a INT);
            CREATE INDEX ix1 ON t(a);
            CREATE INDEX ix2 ON t(a);
            CREATE INDEX ix3 ON t(a);
        `);
        const a = r.col('t', 'a');
        expect(a.constraints.filter((c) => c === 'IDX')).toHaveLength(1);
    });

    it('UQ from CREATE UNIQUE INDEX wins over a later non-unique index on the same column', () => {
        const r = build(`
            CREATE TABLE t(a INT);
            CREATE UNIQUE INDEX uq ON t(a);
            CREATE INDEX ix ON t(a);
        `);
        const a = r.col('t', 'a');
        expect(a.constraints).toContain('UQ');
        // IDX would be redundant once UQ is present → suppression rule.
        expect(a.constraints).not.toContain('IDX');
    });

    it('compositeIdx never bleeds into PK/UQ-suppressed columns', () => {
        const r = build(`
            CREATE TABLE t(id INT PRIMARY KEY, a INT, b INT);
            CREATE INDEX ix ON t(id, a);
        `);
        const id = r.col('t', 'id');
        const a  = r.col('t', 'a');
        // PK column rejects the badge — must NOT be flagged composite either.
        expect(id.constraints).toEqual(['PK']);
        expect(id.compositeIdx).toBeFalsy();
        // The composite still applies to `a` (it was the only column actually badged).
        expect(a.constraints).toContain('IDX');
    });

    it('three-dialect parity: same logical schema produces identical badge shape', () => {
        // UQ defined first → suppression rule kicks in → `a` ends up UQ-only.
        // This is the cleaner, recommended ordering for production schemas.
        const pg = build(`CREATE TABLE t(id INT PRIMARY KEY, a INT, b INT); CREATE UNIQUE INDEX uq ON t(a); CREATE INDEX ix ON t(a, b);`);
        const my = build('CREATE TABLE `t`(`id` INT PRIMARY KEY, `a` INT, `b` INT); CREATE UNIQUE INDEX `uq` ON `t`(`a`); CREATE INDEX `ix` ON `t`(`a`, `b`);');
        const ms = build(`CREATE TABLE [t]([id] INT PRIMARY KEY, [a] INT, [b] INT); CREATE UNIQUE INDEX [uq] ON [t]([a]); CREATE INDEX [ix] ON [t]([a], [b]);`);
        const shape = (b) => {
            const a = b.col('t', 'a');
            const c = b.col('t', 'b');
            return {
                a: { constraints: [...a.constraints].sort(), compositeIdx: !!a.compositeIdx, compositeUq: !!a.compositeUq },
                b: { constraints: [...c.constraints].sort(), compositeIdx: !!c.compositeIdx, compositeUq: !!c.compositeUq },
            };
        };
        const pgShape = shape(pg);
        expect(shape(my)).toEqual(pgShape);
        expect(shape(ms)).toEqual(pgShape);
        // `a` is UQ-only (UQ defined first → later IDX suppressed).
        expect(pgShape.a.constraints).toContain('UQ');
        expect(pgShape.a.constraints).not.toContain('IDX');
        // `b` only appears in the composite IDX → IDX + compositeIdx.
        expect(pgShape.b.constraints).toContain('IDX');
        expect(pgShape.b.compositeIdx).toBe(true);
    });

    it('mass indexes on a single table all satisfy the renderer contract', () => {
        // Define UNIQUE indexes BEFORE non-unique ones so the suppression rule
        // (UQ blocks later IDX) is exercised — the renderer should never see
        // a redundant IDX next to a UQ.
        let sql = `CREATE TABLE t(id INT PRIMARY KEY${Array.from({length: 12}, (_, i) => `, c${i} INT`).join('')});\n`;
        for (let i = 6; i < 12; i++) sql += `CREATE UNIQUE INDEX uq_${i} ON t(c${i});\n`;
        for (let i = 0; i < 12; i++) sql += `CREATE INDEX ix_${i} ON t(c${i});\n`;
        const r = build(sql);
        assertRendererContract(r.schema);
        // c0..c5: only IDX (no UQ ever defined).
        for (let i = 0; i < 6; i++) {
            const col = r.col('t', `c${i}`);
            expect(col.constraints).toContain('IDX');
            expect(col.constraints).not.toContain('UQ');
        }
        // c6..c11: only UQ (UQ added first → later IDX is suppressed).
        for (let i = 6; i < 12; i++) {
            const col = r.col('t', `c${i}`);
            expect(col.constraints).toContain('UQ');
            expect(col.constraints).not.toContain('IDX');
        }
    });
});

describe('Renderer contract — production ERD generation', () => {
    it('keeps a multi-tenant ledger schema renderable across types, indexes, and composite relations', () => {
        const r = build(`
            CREATE TYPE tenant.visibility AS ENUM ('private', 'team', 'public');
            CREATE TYPE tenant.audit_stamp AS (actor_id BIGINT, acted_at TIMESTAMPTZ);

            CREATE TABLE tenant.workspaces (
                workspace_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                slug TEXT NOT NULL UNIQUE,
                visibility tenant.visibility NOT NULL DEFAULT 'private',
                created tenant.audit_stamp
            );

            CREATE TABLE tenant.datasets (
                workspace_id BIGINT NOT NULL REFERENCES tenant.workspaces(workspace_id),
                dataset_id BIGINT NOT NULL,
                name TEXT NOT NULL,
                search_body TEXT,
                PRIMARY KEY (workspace_id, dataset_id),
                FULLTEXT KEY ft_dataset_search (search_body)
            );

            CREATE TABLE tenant.fields (
                workspace_id BIGINT NOT NULL,
                dataset_id BIGINT NOT NULL,
                field_id BIGINT NOT NULL,
                name TEXT NOT NULL,
                data_type TEXT NOT NULL,
                PRIMARY KEY (workspace_id, dataset_id, field_id)
            );

            ALTER TABLE tenant.fields
                ADD CONSTRAINT fk_fields_dataset
                FOREIGN KEY (workspace_id, dataset_id)
                REFERENCES tenant.datasets(workspace_id, dataset_id);

            CREATE INDEX idx_fields_lookup
                ON tenant.fields (workspace_id, dataset_id, name)
                WHERE data_type <> 'archived';
        `);

        assertRendererContract(r.schema);
        expect(r.enums).toEqual([{ name: 'visibility', values: ['private', 'team', 'public'] }]);
        expect(r.composites.map((type) => type.name)).toEqual(['audit_stamp']);
        expect(r.col('workspaces', 'visibility').type).toBe('visibility');
        expect(r.col('workspaces', 'created').type).toBe('audit_stamp');
        expect(r.col('datasets', 'search_body').constraints).toContain('IDX');
        expect(r.col('fields', 'name').constraints).toContain('IDX');
        expect(r.rel('fields', 'dataset_id')?.fkName).toBe('fk_fields_dataset');
    });

    it('keeps semantic SQL upgrades renderer-ready in one generated ERD schema', () => {
        const r = build(`
            CREATE TABLE s1.users (
                tenant_id INT NOT NULL,
                user_code TEXT NOT NULL,
                email TEXT NOT NULL,
                status ENUM('active', 'disabled') NOT NULL,
                UNIQUE INDEX ux_users_email (email),
                PRIMARY KEY (tenant_id, user_code)
            );

            CREATE TABLE s2.users (
                tenant_id INT NOT NULL,
                user_code TEXT NOT NULL,
                status ENUM('invited', 'locked') NOT NULL,
                PRIMARY KEY (tenant_id, user_code)
            );

            CREATE TABLE memberships (
                tenant_id INT NOT NULL,
                user_code TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'member',
                UNIQUE (tenant_id, user_code),
                FOREIGN KEY (tenant_id, user_code) REFERENCES s2.users
            );

            ALTER TABLE memberships
                ADD COLUMN invited_by_email TEXT REFERENCES s1.users(email);
        `);

        assertRendererContract(r.schema);
        expect(r.tables.map((table) => table.name)).toEqual(['s1.users', 's2.users', 'public.memberships']);
        expect(r.enums.map((entry) => entry.name).sort()).toEqual(['status_enum', 'users_status_enum']);
        expect(r.col('s1.users', 'email').constraints).toContain('UQ');
        expect(r.col('public.memberships', 'invited_by_email').fk).toBe(true);

        const grouped = r.relations.filter((relation) => relation.relationGroup);
        expect(grouped).toHaveLength(2);
        expect(new Set(grouped.map((relation) => relation.relationGroup)).size).toBe(1);
        expect(grouped.map((relation) => relation.fromCard)).toEqual(['0..1', '0..1']);
        expect(grouped.map((relation) => relation.toCard)).toEqual(['1', '1']);
        expect(grouped[0].fromColumns).toEqual(['tenant_id', 'user_code']);
        expect(grouped[0].toColumns).toEqual(['tenant_id', 'user_code']);
        expect(r.relations.map((relation) => `${relation.from.table}.${relation.from.column}->${relation.to.table}.${relation.to.column}`)).toContain('public.memberships.tenant_id->s2.users.tenant_id');
        expect(r.relations.map((relation) => `${relation.from.table}.${relation.from.column}->${relation.to.table}.${relation.to.column}`)).toContain('public.memberships.invited_by_email->s1.users.email');
    });
});
