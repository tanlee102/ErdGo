import { describe, it, expect } from 'vitest';
import { parseAST } from '@/lib/parse-ast/parseAst.js';

// ════════════════════════════════════════════════════════════════════
// Cross-dialect parity — parseAST (ERD pipeline)
// ════════════════════════════════════════════════════════════════════
// These tests pin down structural parity across the four supported
// SQL dialects: each "logical" schema (a users + posts FK schema, a
// SERIAL/AUTO_INCREMENT/IDENTITY/AUTOINCREMENT schema, …) is written
// in all four dialects and the produced AST must be SHAPE-compatible.
// "Shape-compatible" means: same tables, same columns, same PK/FK
// detection, same enum/composite registration. The exact `type` string
// is allowed to vary (BIGSERIAL vs BIGINT IDENTITY vs INT AUTO_INCREMENT)
// — only structural flags (pk / autoIncrement / notNull / fk) must
// agree. If any of these tests starts failing it means the four
// pipelines have drifted.
// ════════════════════════════════════════════════════════════════════

function parse(sql) {
    const r = parseAST(sql);
    return {
        ...r,
        table: (name) =>
            r.ast.tables.find((t) => stripSchema(t.name).toLowerCase() === name.toLowerCase()) || null,
        type: (name) =>
            r.ast.types.find((t) => stripSchema(t.name).toLowerCase() === name.toLowerCase()) || null,
        col: (table, col) => {
            const t = r.ast.tables.find((tt) => stripSchema(tt.name).toLowerCase() === table.toLowerCase());
            if (!t) return null;
            return t.columns.find((c) => c && c.name && c.name.toLowerCase() === col.toLowerCase()) || null;
        },
        errs: () => r.errors.filter((e) => e.severity === 'error'),
    };
}

function stripSchema(name) {
    if (!name) return name;
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.substring(dot + 1) : name;
}

// ════════════════════════════════════════════════════════════════════
// Identical schema across 4 dialects → structurally-equivalent AST
// ════════════════════════════════════════════════════════════════════
describe('Cross-dialect — equivalent users+posts schema', () => {
    const SCHEMAS = {
        SQLite: `
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE
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
                email TEXT NOT NULL UNIQUE
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
                \`email\` VARCHAR(255) NOT NULL UNIQUE
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
                [email] NVARCHAR(255) NOT NULL UNIQUE
            );
            CREATE TABLE [posts] (
                [id] BIGINT IDENTITY(1,1) PRIMARY KEY,
                [user_id] BIGINT NOT NULL,
                [title] NVARCHAR(255) NOT NULL,
                CONSTRAINT FK_posts_users FOREIGN KEY ([user_id]) REFERENCES [users]([id])
            );
        `,
    };

    for (const [dialect, sql] of Object.entries(SCHEMAS)) {
        it(`${dialect}: parses with zero errors`, () => {
            const r = parse(sql);
            expect(r.errs()).toEqual([]);
        });

        it(`${dialect}: produces 2 tables (users, posts)`, () => {
            const r = parse(sql);
            expect(r.table('users')).toBeTruthy();
            expect(r.table('posts')).toBeTruthy();
        });

        it(`${dialect}: users.id is auto-increment + PK`, () => {
            // parseAst preserves the user's stated constraints faithfully:
            // PRIMARY KEY does NOT auto-imply NOT NULL at parse time
            // (downstream consumers like the renderer apply that rule).
            // Only PostgreSQL SERIAL types stamp NOT NULL eagerly because
            // SERIAL is sugar for "INT NOT NULL DEFAULT nextval(...)".
            const r = parse(sql);
            const id = r.col('users', 'id');
            expect(id.primary).toBe(true);
            expect(id.autoIncrement).toBe(true);
        });

        it(`${dialect}: users.email is UNIQUE + NOT NULL`, () => {
            const r = parse(sql);
            const email = r.col('users', 'email');
            expect(email.unique).toBe(true);
            expect(email.notNull).toBe(true);
        });

        it(`${dialect}: posts.user_id has an FK to users`, () => {
            // FK can appear in three places:
            //   • column.references — inline form (PG / SQLite)
            //   • table.constraints — table-level FOREIGN KEY (...) (MySQL inline)
            //   • ast.alters       — out-of-line ADD CONSTRAINT (rare in CREATE)
            // Any of the three is acceptable parity.
            const r = parse(sql);
            const fkCol = r.col('posts', 'user_id');
            const inlineFk = !!fkCol?.references;
            const tableFk = r
                .table('posts')
                .constraints?.some((c) => c && c.kind === 'foreign' && c.references?.table?.toLowerCase().endsWith('users'));
            const alterFk = r.ast.alters?.some(
                (a) => a.action === 'add_foreign' && a.references?.table?.toLowerCase().endsWith('users'),
            );
            expect(inlineFk || tableFk || alterFk).toBe(true);
        });
    }
});

// ════════════════════════════════════════════════════════════════════
// Auto-increment surface — every flavor maps to autoIncrement: true
// ════════════════════════════════════════════════════════════════════
describe('Cross-dialect — auto-increment recognition', () => {
    const CASES = [
        ['SQLite AUTOINCREMENT', `CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT);`],
        ['PostgreSQL SERIAL', `CREATE TABLE t (id SERIAL PRIMARY KEY);`],
        ['PostgreSQL BIGSERIAL', `CREATE TABLE t (id BIGSERIAL PRIMARY KEY);`],
        ['PostgreSQL SMALLSERIAL', `CREATE TABLE t (id SMALLSERIAL PRIMARY KEY);`],
        ['PostgreSQL GENERATED ALWAYS AS IDENTITY', `CREATE TABLE t (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY);`],
        ['PostgreSQL GENERATED BY DEFAULT AS IDENTITY', `CREATE TABLE t (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY);`],
        ['MySQL AUTO_INCREMENT', `CREATE TABLE t (id BIGINT AUTO_INCREMENT PRIMARY KEY);`],
        ['MSSQL IDENTITY', `CREATE TABLE t (id BIGINT IDENTITY(1,1) PRIMARY KEY);`],
        ['MSSQL IDENTITY no args', `CREATE TABLE t (id BIGINT IDENTITY PRIMARY KEY);`],
    ];

    for (const [name, sql] of CASES) {
        it(`recognises ${name}`, () => {
            const r = parse(sql);
            expect(r.errs()).toEqual([]);
            expect(r.col('t', 'id').autoIncrement).toBe(true);
        });
    }
});

// ════════════════════════════════════════════════════════════════════
// Tokenizer-level parity — comments + strings inside DDL
// ════════════════════════════════════════════════════════════════════
describe('Cross-dialect — comment marker parity', () => {
    it('strips MySQL `#` comment alongside `--` and `/* */`', () => {
        const r = parse(`
            -- standard line
            /* block
               comment */
            # MySQL line
            CREATE TABLE t (id INT);
        `);
        expect(r.errs()).toEqual([]);
        expect(r.table('t')).toBeTruthy();
    });

    it('parses DEFAULT N\'unicode\' (MSSQL) without errors', () => {
        const r = parse(`CREATE TABLE t (greeting NVARCHAR(50) DEFAULT N'こんにちは');`);
        expect(r.errs()).toEqual([]);
        const c = r.col('t', 'greeting');
        // Default text retains the literal value (the `N` prefix is a
        // tokenizer hint, not part of the value).
        expect(c.default).toContain('こんにちは');
    });

    it('accepts `\\\'` MySQL-style escaped quote inside DEFAULT literal without errors', () => {
        // The parser keeps the DEFAULT expression as raw text for round-
        // tripping; the executor unescapes when actually evaluating the
        // literal. So we just verify "no error, default captured".
        const r = parse(`CREATE TABLE t (note TEXT DEFAULT 'it\\'s here');`);
        expect(r.errs()).toEqual([]);
        const c = r.col('t', 'note');
        expect(c.default).toBeTruthy();
    });
});

// ════════════════════════════════════════════════════════════════════
// Inline ENUM / SET surfaces — both must register as `types`
// ════════════════════════════════════════════════════════════════════
describe('Cross-dialect — inline ENUM / SET registration', () => {
    it('MySQL inline ENUM is registered as enum type', () => {
        const r = parse(`CREATE TABLE t (role ENUM('admin','user'));`);
        expect(r.errs()).toEqual([]);
        const enumType = r.ast.types.find((t) => t.kind === 'enum' && /role.*_enum/i.test(t.name));
        expect(enumType).toBeTruthy();
        expect(enumType.values).toEqual(['admin', 'user']);
    });

    it('MySQL inline SET is registered as enum-like type', () => {
        const r = parse(`CREATE TABLE t (perms SET('r','w','x'));`);
        expect(r.errs()).toEqual([]);
        const setType = r.ast.types.find((t) => t.kind === 'enum' && /perms.*_set/i.test(t.name));
        expect(setType).toBeTruthy();
        expect(setType.values).toEqual(['r', 'w', 'x']);
    });

    it('PostgreSQL standalone CREATE TYPE … AS ENUM is registered', () => {
        const r = parse(`
            CREATE TYPE color AS ENUM ('red','green','blue');
            CREATE TABLE t (c color);
        `);
        expect(r.errs()).toEqual([]);
        const enumType = r.type('color');
        expect(enumType).toBeTruthy();
        expect(enumType.values).toEqual(['red', 'green', 'blue']);
    });
});

// ════════════════════════════════════════════════════════════════════
// MSSQL bare-AS computed columns — modifier order is symmetric
// ════════════════════════════════════════════════════════════════════
// T-SQL accepts the trailing modifiers in either order:
//   <col> AS (<expr>) PERSISTED NOT NULL          (canonical)
//   <col> AS (<expr>) NOT NULL PERSISTED          (also legal)
// The earlier parser only handled the canonical ordering — the alternate
// order would leave NOT NULL outside the computed-column scope and pollute
// the next column entry. This block pins the symmetry.
describe('MSSQL — bare-AS computed column modifier order', () => {
    it('parses `AS (expr) PERSISTED NOT NULL`', () => {
        const r = parse(`
            CREATE TABLE t (
                a INT, b INT,
                s AS (a + b) PERSISTED NOT NULL
            );
        `);
        expect(r.errs()).toEqual([]);
        const s = r.col('t', 's');
        expect(s).toBeTruthy();
        expect(s.notNull).toBe(true);
        expect(s.generated).toMatch(/PERSISTED/);
        expect(s.generated).toMatch(/NOT\s+NULL/);
    });

    it('parses `AS (expr) NOT NULL PERSISTED` (alternate order)', () => {
        const r = parse(`
            CREATE TABLE t (
                a INT, b INT,
                s AS (a + b) NOT NULL PERSISTED
            );
        `);
        expect(r.errs()).toEqual([]);
        const s = r.col('t', 's');
        expect(s).toBeTruthy();
        expect(s.notNull).toBe(true);
        expect(s.generated).toMatch(/PERSISTED/);
        expect(s.generated).toMatch(/NOT\s+NULL/);
    });

    it('alternate order does NOT leak NOT NULL into the following column', () => {
        // Regression check: before the fix, NOT NULL in the alternate order
        // wasn't consumed by the computed-column scope, so it bled into the
        // next column entry, corrupting its definition.
        const r = parse(`
            CREATE TABLE t (
                a INT, b INT,
                s AS (a + b) NOT NULL PERSISTED,
                tag NVARCHAR(20)
            );
        `);
        expect(r.errs()).toEqual([]);
        // The tag column must still exist as a normal column with its
        // declared type — NOT NULL must NOT have leaked into it (its
        // declared shape has no NOT NULL).
        const tag = r.col('t', 'tag');
        expect(tag).toBeTruthy();
        expect(tag.type).toMatch(/NVARCHAR/i);
        expect(tag.notNull).toBe(false);
    });

    it('parses bare-AS form with alternate order: `AS expr NOT NULL PERSISTED`', () => {
        // Non-parenthesised expression form (also valid T-SQL).
        const r = parse(`
            CREATE TABLE t (
                qty_ordered INT,
                qty_shipped INT,
                qty_left AS qty_ordered - qty_shipped NOT NULL PERSISTED,
                sku NVARCHAR(20)
            );
        `);
        expect(r.errs()).toEqual([]);
        const left = r.col('t', 'qty_left');
        expect(left).toBeTruthy();
        expect(left.notNull).toBe(true);
        const sku = r.col('t', 'sku');
        expect(sku).toBeTruthy();
        expect(sku.notNull).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════════════
// CREATE INDEX parity across PG / MySQL / MSSQL / SQLite
// ════════════════════════════════════════════════════════════════════
describe('Cross-dialect — CREATE INDEX', () => {
    const CASES = [
        ['SQLite', `CREATE INDEX ix_users_email ON users (email);`],
        ['PostgreSQL', `CREATE INDEX ix_users_email ON users USING btree (email);`],
        ['PostgreSQL CONCURRENTLY', `CREATE UNIQUE INDEX CONCURRENTLY ix_users_email ON users (email);`],
        ['MySQL', `CREATE INDEX ix_users_email ON users (email) USING BTREE;`],
        ['MSSQL clustered', `CREATE CLUSTERED INDEX ix_users_email ON users (email);`],
        ['MSSQL nonclustered + INCLUDE', `CREATE NONCLUSTERED INDEX ix_users_email ON users (email) INCLUDE (created_at);`],
    ];

    for (const [name, sql] of CASES) {
        it(`parses ${name} CREATE INDEX without errors`, () => {
            const r = parse(`CREATE TABLE users (id INT, email TEXT, created_at TIMESTAMP); ${sql}`);
            expect(r.errs()).toEqual([]);
        });
    }
});

// ════════════════════════════════════════════════════════════════════
// Full mega-parity script — 4 logically-equivalent users tables, 1 file
// ════════════════════════════════════════════════════════════════════
describe('Cross-dialect — mega parity script', () => {
    it('parses a single script with four users-table flavors', () => {
        const r = parse(`
            -- SQLite
            CREATE TABLE users_lite (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE
            ) WITHOUT ROWID;

            -- PostgreSQL
            CREATE TABLE users_pg (
                id BIGSERIAL PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                tags TEXT[]
            );

            -- MySQL
            CREATE TABLE \`users_my\` (
                \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
                \`email\` VARCHAR(255) NOT NULL UNIQUE,
                \`role\` ENUM('admin','user') NOT NULL DEFAULT 'user'
            ) ENGINE=InnoDB;

            -- MSSQL
            CREATE TABLE [users_ms] (
                [id] BIGINT IDENTITY(1,1) PRIMARY KEY,
                [email] NVARCHAR(255) NOT NULL UNIQUE,
                [greeting] NVARCHAR(50) DEFAULT N'hello'
            );
        `);

        expect(r.errs()).toEqual([]);
        for (const t of ['users_lite', 'users_pg', 'users_my', 'users_ms']) {
            const tbl = r.table(t);
            expect(tbl).toBeTruthy();
            const id = r.col(t, 'id');
            expect(id.primary).toBe(true);
            expect(id.autoIncrement).toBe(true);
            const email = r.col(t, 'email');
            expect(email.unique).toBe(true);
            expect(email.notNull).toBe(true);
        }

        // MySQL inline ENUM should be registered.
        expect(r.ast.types.some((t) => t.kind === 'enum' && /role.*_enum/i.test(t.name))).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════
// Production dialect matrix — complex syntax per engine
// ════════════════════════════════════════════════════════════════════
describe('Cross-dialect — production dialect matrix', () => {
    it('SQLite: STRICT/WITHOUT ROWID, generated columns, composite FK, and partial indexes', () => {
        const r = parse(`
            CREATE TABLE "catalog" (
                tenant_id TEXT NOT NULL,
                sku TEXT NOT NULL,
                name TEXT COLLATE NOCASE NOT NULL,
                price REAL NOT NULL CHECK (price >= 0),
                price_bucket TEXT GENERATED ALWAYS AS (
                    CASE WHEN price >= 100 THEN 'premium' ELSE 'standard' END
                ) STORED,
                PRIMARY KEY (tenant_id, sku)
            ) STRICT, WITHOUT ROWID;

            CREATE TABLE "stock_moves" (
                move_id INTEGER PRIMARY KEY AUTOINCREMENT,
                tenant_id TEXT NOT NULL,
                sku TEXT NOT NULL,
                delta INTEGER NOT NULL CHECK (delta <> 0),
                reason TEXT DEFAULT 'manual',
                FOREIGN KEY (tenant_id, sku)
                    REFERENCES catalog(tenant_id, sku)
                    ON UPDATE CASCADE ON DELETE RESTRICT
            ) STRICT;

            CREATE INDEX idx_stock_moves_lookup
                ON stock_moves (tenant_id, sku, delta)
                WHERE delta <> 0;
        `);

        expect(r.errs()).toEqual([]);
        expect(r.table('catalog').columns.map((column) => column.name)).toEqual([
            'tenant_id',
            'sku',
            'name',
            'price',
            'price_bucket',
        ]);
        expect(r.col('catalog', 'price_bucket').generated).toMatch(/GENERATED ALWAYS AS/i);
        expect(r.col('stock_moves', 'move_id').autoIncrement).toBe(true);

        const fk = r.table('stock_moves').constraints.find((constraint) => constraint?.kind === 'foreign');
        expect(fk.columns).toEqual(['tenant_id', 'sku']);
        expect(fk.references).toMatchObject({
            table: 'catalog',
            columns: ['tenant_id', 'sku'],
            onDelete: 'RESTRICT',
            onUpdate: 'CASCADE',
        });

        expect(r.ast.indexes).toContainEqual(
            expect.objectContaining({
                name: 'idx_stock_moves_lookup',
                table: 'stock_moves',
                columns: ['tenant_id', 'sku', 'delta'],
            }),
        );
    });

    it('PostgreSQL: schema-qualified enum/composite types, identity, partition options, and expression indexes', () => {
        const r = parse(`
            CREATE TYPE warehouse.item_state AS ENUM ('draft', 'active', 'deleted');
            CREATE TYPE warehouse.dimensions AS (
                width NUMERIC(10, 2),
                height NUMERIC(10, 2),
                depth NUMERIC(10, 2)
            );

            CREATE TABLE warehouse.products (
                tenant_id BIGINT NOT NULL,
                product_id BIGINT GENERATED BY DEFAULT AS IDENTITY,
                sku TEXT NOT NULL,
                state warehouse.item_state NOT NULL DEFAULT 'draft',
                dims warehouse.dimensions,
                metadata JSONB NOT NULL DEFAULT jsonb_build_object('tags', '[]'),
                search_text TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', sku)) STORED,
                PRIMARY KEY (tenant_id, product_id),
                CONSTRAINT uq_products_sku UNIQUE (tenant_id, sku),
                CONSTRAINT chk_products_state CHECK (state <> 'deleted' OR metadata IS NOT NULL)
            ) PARTITION BY LIST (tenant_id);

            CREATE TABLE warehouse.product_events (
                tenant_id BIGINT NOT NULL,
                product_id BIGINT NOT NULL,
                event_no BIGINT NOT NULL,
                payload JSONB,
                CONSTRAINT fk_product_events_product
                    FOREIGN KEY (tenant_id, product_id)
                    REFERENCES warehouse.products(tenant_id, product_id)
                    DEFERRABLE INITIALLY DEFERRED,
                PRIMARY KEY (tenant_id, product_id, event_no)
            );

            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_state_sku
                ON ONLY warehouse.products USING gin ((metadata->'tags'), state, sku)
                INCLUDE (metadata)
                WHERE state <> 'deleted';
        `);

        expect(r.errs()).toEqual([]);
        expect(r.type('item_state').values).toEqual(['draft', 'active', 'deleted']);
        expect(r.type('dimensions').fields.map((field) => field.name)).toEqual(['width', 'height', 'depth']);
        expect(r.col('products', 'product_id').autoIncrement).toBe(true);
        expect(r.col('products', 'state').type).toBe('warehouse.item_state');
        expect(r.col('products', 'search_text').generated).toMatch(/to_tsvector/i);
        expect(r.table('product_events').constraints.find((constraint) => constraint?.name === 'fk_product_events_product').columns).toEqual([
            'tenant_id',
            'product_id',
        ]);
        expect(r.ast.indexes.find((index) => index.name === 'idx_products_state_sku').columns).toEqual(['state', 'sku']);
    });

    it('MySQL: inline ENUM/SET domains, generated stored columns, fulltext indexes, and composite keys', () => {
        const r = parse(`
            CREATE TABLE \`shops\` (
                \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                \`slug\` VARCHAR(80) NOT NULL,
                \`status\` ENUM('draft','open','closed') NOT NULL DEFAULT 'draft',
                \`features\` SET('pos','online','pickup') DEFAULT 'online',
                \`search_blob\` TEXT,
                PRIMARY KEY (\`id\`),
                UNIQUE KEY \`uk_shops_slug\` (\`slug\`),
                FULLTEXT KEY \`ft_shops_search\` (\`search_blob\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

            CREATE TABLE \`shop_products\` (
                \`shop_id\` BIGINT UNSIGNED NOT NULL,
                \`sku\` VARCHAR(64) NOT NULL,
                \`price\` DECIMAL(10, 2) NOT NULL,
                \`tax_rate\` DECIMAL(5, 4) NOT NULL DEFAULT 0.0000,
                \`gross_price\` DECIMAL(10, 2)
                    GENERATED ALWAYS AS (\`price\` + (\`price\` * \`tax_rate\`)) STORED,
                PRIMARY KEY (\`shop_id\`, \`sku\`),
                CONSTRAINT \`fk_products_shop\`
                    FOREIGN KEY (\`shop_id\`) REFERENCES \`shops\` (\`id\`) ON DELETE CASCADE,
                KEY \`idx_products_price\` (\`price\`, \`gross_price\`)
            ) ENGINE=InnoDB;
        `);

        expect(r.errs()).toEqual([]);
        expect(r.col('shops', 'id').autoIncrement).toBe(true);
        expect(r.col('shops', 'status').type).toBe('status_enum');
        expect(r.col('shops', 'features').type).toBe('features_set');
        expect(r.type('status_enum').values).toEqual(['draft', 'open', 'closed']);
        expect(r.type('features_set').values).toEqual(['pos', 'online', 'pickup']);
        expect(r.col('shop_products', 'gross_price').generated).toMatch(/GENERATED ALWAYS AS/i);
        expect(r.table('shop_products').constraints.find((constraint) => constraint?.name === 'fk_products_shop').references.table).toBe('shops');

        const indexNames = r.ast.indexes.map((index) => index.name).sort();
        expect(indexNames).toEqual(['ft_shops_search', 'idx_products_price']);
    });

    it('MSSQL: bracket schemas, identity seeds, persisted computed columns, filtered indexes, and GO batches', () => {
        const r = parse(`
            CREATE TABLE [sales].[Invoices] (
                [InvoiceID] BIGINT IDENTITY(100, 10) NOT NULL,
                [CustomerCode] NVARCHAR(40) NOT NULL,
                [Subtotal] DECIMAL(19, 4) NOT NULL,
                [Tax] DECIMAL(19, 4) NOT NULL DEFAULT 0,
                [Total] AS ([Subtotal] + [Tax]) PERSISTED NOT NULL,
                CONSTRAINT [PK_Invoices] PRIMARY KEY CLUSTERED ([InvoiceID]),
                CONSTRAINT [UQ_Invoices_Customer] UNIQUE NONCLUSTERED ([CustomerCode])
            );
            GO

            CREATE TABLE [sales].[InvoiceLines] (
                [InvoiceID] BIGINT NOT NULL,
                [LineNo] INT NOT NULL,
                [Sku] NVARCHAR(64) NOT NULL,
                [Qty] INT NOT NULL,
                [UnitPrice] DECIMAL(19, 4) NOT NULL,
                [LineTotal] AS [Qty] * [UnitPrice] PERSISTED,
                CONSTRAINT [PK_InvoiceLines] PRIMARY KEY NONCLUSTERED ([InvoiceID], [LineNo]),
                CONSTRAINT [FK_Lines_Invoice]
                    FOREIGN KEY ([InvoiceID]) REFERENCES [sales].[Invoices]([InvoiceID])
            );

            CREATE NONCLUSTERED INDEX [IX_Lines_Sku]
                ON [sales].[InvoiceLines] ([Sku], [InvoiceID])
                INCLUDE ([Qty], [UnitPrice])
                WHERE [Qty] > 0;
        `);

        expect(r.errs()).toEqual([]);
        expect(r.col('Invoices', 'InvoiceID').autoIncrement).toBe(true);
        expect(r.col('Invoices', 'Total').type).toBe('COMPUTED');
        expect(r.col('Invoices', 'Total').notNull).toBe(true);
        expect(r.col('InvoiceLines', 'LineTotal').generated).toMatch(/PERSISTED/);
        expect(r.table('InvoiceLines').constraints.find((constraint) => constraint?.name === 'FK_Lines_Invoice').references).toEqual({
            table: 'sales.Invoices',
            columns: ['InvoiceID'],
        });
        expect(r.ast.indexes.find((index) => index.name === 'IX_Lines_Sku').columns).toEqual(['Sku', 'InvoiceID']);
    });
});
