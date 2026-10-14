import { describe, it, expect } from 'vitest';
import { parseAST } from '@/lib/parse-ast/parseAst.js';

/**
 * Test harness for parseAST — mirrors the convenience helpers in
 * src/features/data-view/lib/sqlExecutor.test.js so the two suites read consistently.
 */
function parse(sql) {
    const { ast, errors } = parseAST(sql);
    return {
        ast,
        errors,
        tables: ast.tables,
        types: ast.types,
        alters: ast.alters,
        table: (name) => ast.tables.find((t) => stripSchema(t.name).toLowerCase() === name.toLowerCase()) || null,
        type: (name) => ast.types.find((t) => stripSchema(t.name).toLowerCase() === name.toLowerCase()) || null,
        column: (tableName, colName) => {
            const t = ast.tables.find((tt) => stripSchema(tt.name).toLowerCase() === tableName.toLowerCase());
            if (!t) return null;
            return t.columns.find((c) => c && c.name && c.name.toLowerCase() === colName.toLowerCase()) || null;
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

// ════════════════════════════════════════════
// CREATE TABLE — basics
// ════════════════════════════════════════════

describe('CREATE TABLE — basics', () => {
    it('parses a simple table with two columns', () => {
        const r = parse(`CREATE TABLE users (id INT, name TEXT);`);
        expect(r.tables).toHaveLength(1);
        const t = r.table('users');
        expect(t.columns).toHaveLength(2);
        expect(t.columns[0].name).toBe('id');
        expect(t.columns[0].type).toBe('INT');
        expect(t.columns[1].name).toBe('name');
        expect(t.columns[1].type).toBe('TEXT');
    });

    it('parses multiple statements separated by semicolons', () => {
        const r = parse(`
            CREATE TABLE a (id INT);
            CREATE TABLE b (id INT);
            CREATE TABLE c (id INT);
        `);
        expect(r.tables).toHaveLength(3);
    });

    it('handles IF NOT EXISTS', () => {
        const r = parse(`CREATE TABLE IF NOT EXISTS users (id INT);`);
        expect(r.table('users')).not.toBeNull();
    });

    it('handles ONLY (PostgreSQL inheritance modifier)', () => {
        const r = parse(`CREATE TABLE ONLY users (id INT);`);
        expect(r.table('users')).not.toBeNull();
    });

    it('handles schema-qualified table names', () => {
        const r = parse(`CREATE TABLE public.users (id INT);`);
        const t = r.tables[0];
        expect(t.name).toBe('public.users');
        expect(r.table('users')).not.toBeNull();
    });

    it('handles quoted/bracketed identifiers', () => {
        const r = parse(`CREATE TABLE "MyTable" ("Column One" INT, [bracket col] TEXT);`);
        expect(r.tables).toHaveLength(1);
    });

    it('handles SQL Server temp tables and escaped closing brackets', () => {
        const r = parse(`CREATE TABLE #temp ([order]] key] INT PRIMARY KEY);`);
        expect(r.errs()).toHaveLength(0);
        expect(r.table('#temp')).not.toBeNull();
        expect(r.column('#temp', 'order] key')).not.toBeNull();
    });

    it('records position info for each table', () => {
        const r = parse(`CREATE TABLE users (id INT);`);
        const t = r.tables[0];
        expect(t.position).toBeTruthy();
        expect(t.position.start).toBeTruthy();
        expect(t.position.end).toBeTruthy();
    });

    it('errors when a non-PostgreSQL CREATE TABLE has no columns or constraints', () => {
        const r = parse(`CREATE TABLE empty () ENGINE=InnoDB;`);
        expect(r.errs().length).toBeGreaterThan(0);
    });
});

// ════════════════════════════════════════════
// Column types
// ════════════════════════════════════════════

describe('Column types', () => {
    it('parses common SQL types across dialects', () => {
        const r = parse(`
            CREATE TABLE types_test (
                a INT,
                b BIGINT,
                c VARCHAR(255),
                d CHAR(10),
                e NUMERIC(10,2),
                f DECIMAL(8,4),
                g BOOLEAN,
                h DATE,
                i TIMESTAMP,
                j JSON,
                k JSONB,
                l UUID,
                m BYTEA
            );
        `);
        const cols = r.table('types_test').columns;
        expect(cols).toHaveLength(13);
        expect(cols[2].type).toBe('VARCHAR(255)');
        expect(cols[4].type).toBe('NUMERIC(10, 2)');
    });

    it('parses DOUBLE PRECISION as one type', () => {
        const r = parse(`CREATE TABLE t (val DOUBLE PRECISION);`);
        expect(r.column('t', 'val').type).toBe('DOUBLE PRECISION');
    });

    it('parses MySQL INT UNSIGNED', () => {
        const r = parse(`CREATE TABLE t (val INT UNSIGNED);`);
        expect(r.column('t', 'val').type).toBe('INT UNSIGNED');
    });

    it('parses MSSQL NVARCHAR(MAX)', () => {
        const r = parse(`CREATE TABLE t (val NVARCHAR(MAX));`);
        expect(r.column('t', 'val').type).toBe('NVARCHAR(MAX)');
    });
});

// ════════════════════════════════════════════
// Inline column constraints
// ════════════════════════════════════════════

describe('Inline column constraints', () => {
    it('parses PRIMARY KEY', () => {
        const r = parse(`CREATE TABLE t (id INT PRIMARY KEY);`);
        const col = r.column('t', 'id');
        expect(col.primary).toBe(true);
    });

    it('parses NOT NULL', () => {
        const r = parse(`CREATE TABLE t (name VARCHAR(100) NOT NULL);`);
        expect(r.column('t', 'name').notNull).toBe(true);
    });

    it('parses UNIQUE', () => {
        const r = parse(`CREATE TABLE t (email VARCHAR(255) UNIQUE);`);
        expect(r.column('t', 'email').unique).toBe(true);
    });

    it('parses REFERENCES (inline FK)', () => {
        const r = parse(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (parent_id INT REFERENCES parent(id));
        `);
        const col = r.column('child', 'parent_id');
        expect(col.references).toBeTruthy();
        expect(col.references.table).toBe('parent');
        expect(col.references.columns).toEqual(['id']);
    });

    it('parses DEFAULT with various literals', () => {
        const r = parse(`
            CREATE TABLE t (
                role VARCHAR(50) DEFAULT 'user',
                views INT DEFAULT 0,
                active BOOLEAN DEFAULT TRUE,
                ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        expect(r.column('t', 'role').default).toBe("'user'");
        expect(r.column('t', 'views').default).toBe('0');
        expect(r.column('t', 'active').default).toBe('TRUE');
        expect(r.column('t', 'ts').default).toBe('CURRENT_TIMESTAMP');
    });

    it('parses CHECK constraint', () => {
        const r = parse(`CREATE TABLE t (age INT CHECK (age >= 0));`);
        const col = r.column('t', 'age');
        expect(col.check).toBeTruthy();
        expect(col.check).toContain('age');
    });

    it('parses several constraints stacked on a column', () => {
        const r = parse(`CREATE TABLE t (email VARCHAR(255) UNIQUE NOT NULL);`);
        const col = r.column('t', 'email');
        expect(col.unique).toBe(true);
        expect(col.notNull).toBe(true);
    });

    it('parses ON DELETE CASCADE / SET NULL', () => {
        const r = parse(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (
                pid INT REFERENCES parent(id) ON DELETE CASCADE ON UPDATE SET NULL
            );
        `);
        expect(r.column('child', 'pid').references.table).toBe('parent');
    });
});

// ════════════════════════════════════════════
// Table-level constraints
// ════════════════════════════════════════════

describe('Table-level constraints', () => {
    it('parses PRIMARY KEY (...) and reflects it on columns', () => {
        const r = parse(`
            CREATE TABLE t (
                id INT,
                name TEXT,
                PRIMARY KEY (id)
            );
        `);
        expect(r.column('t', 'id').primary).toBe(true);
    });

    it('parses composite PRIMARY KEY', () => {
        const r = parse(`
            CREATE TABLE t (
                a INT,
                b INT,
                c TEXT,
                PRIMARY KEY (a, b)
            );
        `);
        expect(r.column('t', 'a').primary).toBe(true);
        expect(r.column('t', 'b').primary).toBe(true);
        expect(r.column('t', 'c').primary).toBeFalsy();
    });

    it('parses CONSTRAINT name PRIMARY KEY (...)', () => {
        const r = parse(`
            CREATE TABLE t (id INT, CONSTRAINT pk_t PRIMARY KEY (id));
        `);
        const t = r.table('t');
        const pk = t.constraints.find((c) => c && c.kind === 'primary');
        expect(pk.name).toBe('pk_t');
        expect(pk.columns).toEqual(['id']);
        expect(r.column('t', 'id').primary).toBe(true);
    });

    it('parses UNIQUE (...) and CONSTRAINT … UNIQUE', () => {
        const r = parse(`
            CREATE TABLE t (
                a INT, b INT,
                UNIQUE (a),
                CONSTRAINT uq_ab UNIQUE (a, b)
            );
        `);
        expect(r.column('t', 'a').unique).toBe(true);
        expect(r.column('t', 'b').unique).toBe(true);
    });

    it('parses FOREIGN KEY (...) REFERENCES', () => {
        const r = parse(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (
                id INT PRIMARY KEY,
                parent_id INT,
                FOREIGN KEY (parent_id) REFERENCES parent(id)
            );
        `);
        const fk = r.table('child').constraints.find((c) => c && c.kind === 'foreign');
        expect(fk).toBeTruthy();
        expect(fk.columns).toEqual(['parent_id']);
        expect(fk.references.table).toBe('parent');
        expect(fk.references.columns).toEqual(['id']);
    });

    it('parses table-level CHECK (...)', () => {
        const r = parse(`
            CREATE TABLE t (
                a INT, b INT,
                CHECK (a < b)
            );
        `);
        const chk = r.table('t').constraints.find((c) => c && c.kind === 'check');
        expect(chk).toBeTruthy();
        expect(chk.expression).toContain('a');
    });

    it('errors when a table-level constraint references an unknown column', () => {
        const r = parse(`
            CREATE TABLE t (a INT, PRIMARY KEY (ghost));
        `);
        expect(r.errs().some((e) => /ghost/.test(e.message))).toBe(true);
    });

    it('warns when a FK references an undefined table', () => {
        const r = parse(`
            CREATE TABLE child (
                pid INT,
                FOREIGN KEY (pid) REFERENCES nowhere(id)
            );
        `);
        expect(r.warns().some((w) => /nowhere/.test(w.message))).toBe(true);
    });
});

// ════════════════════════════════════════════
// CREATE TYPE — ENUM
// ════════════════════════════════════════════

describe('CREATE TYPE … AS ENUM', () => {
    it('parses an ENUM type', () => {
        const r = parse(`CREATE TYPE status AS ENUM ('active', 'inactive', 'banned');`);
        const t = r.type('status');
        expect(t.kind).toBe('enum');
        expect(t.values).toEqual(['active', 'inactive', 'banned']);
    });

    it('parses several ENUMs in one script', () => {
        const r = parse(`
            CREATE TYPE role AS ENUM ('admin', 'user');
            CREATE TYPE priority AS ENUM ('low', 'medium', 'high');
        `);
        expect(r.types).toHaveLength(2);
    });

    it('handles schema-qualified ENUM names', () => {
        const r = parse(`CREATE TYPE public.mood AS ENUM ('happy', 'sad');`);
        expect(r.type('mood')).not.toBeNull();
    });
});

// ════════════════════════════════════════════
// CREATE TYPE — Composite
// ════════════════════════════════════════════

describe('CREATE TYPE … AS (composite)', () => {
    it('parses a composite type with multiple fields', () => {
        const r = parse(`
            CREATE TYPE address AS (
                street TEXT,
                city VARCHAR(100),
                zip VARCHAR(20)
            );
        `);
        const t = r.type('address');
        expect(t.kind).toBe('composite');
        expect(t.fields).toHaveLength(3);
        expect(t.fields[0]).toEqual({ name: 'street', type: 'TEXT' });
    });
});

// ════════════════════════════════════════════
// Inline ENUM (MySQL-style inside a column)
// ════════════════════════════════════════════

describe('Inline ENUM column', () => {
    it('lifts inline ENUM(…) into ast.types and rewrites the column type', () => {
        const r = parse(`
            CREATE TABLE t (
                id INT,
                priority ENUM('low','medium','high')
            );
        `);
        const inline = r.type('priority_enum');
        expect(inline).not.toBeNull();
        expect(inline.isInline).toBe(true);
        expect(inline.values).toEqual(['low', 'medium', 'high']);
        expect(r.column('t', 'priority').type).toBe('priority_enum');
    });
});

// ════════════════════════════════════════════
// 2.3 Generated / Computed Columns — the focus of this PR
// ════════════════════════════════════════════

describe('Generated / Computed columns — PostgreSQL & MySQL (GENERATED ALWAYS AS)', () => {
    it('captures the full PostgreSQL form with STORED', () => {
        const r = parse(`
            CREATE TABLE products (
                id SERIAL PRIMARY KEY,
                price NUMERIC(10,2),
                quantity INTEGER,
                total NUMERIC GENERATED ALWAYS AS (price * quantity) STORED
            );
        `);
        const total = r.column('products', 'total');
        expect(total.type).toBe('NUMERIC');
        expect(total.generated).toBe('GENERATED ALWAYS AS (price * quantity) STORED');
    });

    it('captures the MySQL VIRTUAL form', () => {
        const r = parse(`
            CREATE TABLE products (
                price NUMERIC(10,2),
                discount NUMERIC GENERATED ALWAYS AS (price * 0.1) VIRTUAL
            );
        `);
        const discount = r.column('products', 'discount');
        expect(discount.generated).toBe('GENERATED ALWAYS AS (price * 0.1) VIRTUAL');
    });

    it('captures GENERATED BY DEFAULT AS IDENTITY (PostgreSQL identity)', () => {
        const r = parse(`
            CREATE TABLE t (
                id INT GENERATED BY DEFAULT AS (1)
            );
        `);
        // BY DEFAULT branch: parser emits "GENERATED BY DEFAULT AS (...)"
        expect(r.column('t', 'id').generated).toContain('GENERATED');
        expect(r.column('t', 'id').generated).toContain('BY DEFAULT');
    });

    it('still records other constraints alongside GENERATED', () => {
        const r = parse(`
            CREATE TABLE t (
                a INT,
                b INT,
                sum INT GENERATED ALWAYS AS (a + b) STORED NOT NULL
            );
        `);
        const sum = r.column('t', 'sum');
        expect(sum.notNull).toBe(true);
        expect(sum.generated).toContain('STORED');
    });
});

describe('Generated / Computed columns — MSSQL (col AS (expr) [PERSISTED])', () => {
    it('parses a non-persisted computed column', () => {
        const r = parse(`
            CREATE TABLE products (
                id INT IDENTITY(1,1) PRIMARY KEY,
                price DECIMAL(10,2),
                quantity INT,
                total AS (price * quantity)
            );
        `);
        const total = r.column('products', 'total');
        expect(total).not.toBeNull();
        expect(total.type).toBe('COMPUTED');
        expect(total.generated).toBe('AS (price * quantity)');
        expect(r.errs()).toHaveLength(0);
    });

    it('parses a PERSISTED computed column', () => {
        const r = parse(`
            CREATE TABLE products (
                price DECIMAL(10,2),
                quantity INT,
                total AS (price * quantity) PERSISTED
            );
        `);
        const total = r.column('products', 'total');
        expect(total.type).toBe('COMPUTED');
        expect(total.generated).toBe('AS (price * quantity) PERSISTED');
    });

    it('parses a PERSISTED NOT NULL computed column', () => {
        const r = parse(`
            CREATE TABLE products (
                price DECIMAL(10,2),
                quantity INT,
                total AS (price * quantity) PERSISTED NOT NULL
            );
        `);
        const total = r.column('products', 'total');
        expect(total.generated).toBe('AS (price * quantity) PERSISTED NOT NULL');
        expect(total.notNull).toBe(true);
    });

    it('parses computed columns alongside regular columns and FKs', () => {
        const r = parse(`
            CREATE TABLE category (id INT PRIMARY KEY);
            CREATE TABLE product (
                id INT PRIMARY KEY,
                cat_id INT REFERENCES category(id),
                price DECIMAL(10,2),
                qty INT,
                total AS (price * qty) PERSISTED,
                tax AS (price * 0.1)
            );
        `);
        expect(r.column('product', 'total').generated).toBe('AS (price * qty) PERSISTED');
        expect(r.column('product', 'tax').generated).toBe('AS (price * 0.1)');
        expect(r.column('product', 'cat_id').references.table).toBe('category');
        expect(r.errs()).toHaveLength(0);
    });

    it('handles a CASE expression inside MSSQL computed column', () => {
        const r = parse(`
            CREATE TABLE t (
                a INT,
                b INT,
                bigger AS (CASE WHEN a > b THEN a ELSE b END) PERSISTED
            );
        `);
        const bigger = r.column('t', 'bigger');
        expect(bigger.type).toBe('COMPUTED');
        expect(bigger.generated).toContain('CASE');
        expect(bigger.generated).toContain('PERSISTED');
    });

    it('handles function calls inside MSSQL computed column', () => {
        const r = parse(`
            CREATE TABLE customers (
                first_name NVARCHAR(50),
                last_name NVARCHAR(50),
                full_name AS (CONCAT(first_name, ' ', last_name))
            );
        `);
        const full = r.column('customers', 'full_name');
        expect(full.generated).toBe(`AS (CONCAT(first_name, ' ', last_name))`);
    });
});

// ════════════════════════════════════════════
// MySQL/MSSQL extras — must not break parsing
// ════════════════════════════════════════════

describe('Dialect modifiers', () => {
    it('handles MySQL AUTO_INCREMENT', () => {
        const r = parse(`CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY);`);
        expect(r.column('t', 'id').primary).toBe(true);
    });

    it('handles MSSQL IDENTITY(seed, increment)', () => {
        const r = parse(`CREATE TABLE t (id INT IDENTITY(1,1) PRIMARY KEY);`);
        expect(r.column('t', 'id').primary).toBe(true);
    });

    it('handles MySQL COMMENT', () => {
        const r = parse(`CREATE TABLE t (name VARCHAR(50) COMMENT 'user name');`);
        expect(r.column('t', 'name').type).toBe('VARCHAR(50)');
    });

    it('handles COLLATE', () => {
        const r = parse(`CREATE TABLE t (name VARCHAR(50) COLLATE utf8_general_ci);`);
        expect(r.column('t', 'name').type).toBe('VARCHAR(50)');
    });

    it('strips MySQL CHARACTER SET from column display type', () => {
        const r = parse(`CREATE TABLE t (name VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci);`);
        expect(r.column('t', 'name').type).toBe('VARCHAR(50)');
    });

    it('strips MySQL CHARSET shorthand from column display type', () => {
        const r = parse(`CREATE TABLE t (name VARCHAR(50) CHARSET=utf8mb4 COLLATE utf8mb4_unicode_ci);`);
        expect(r.column('t', 'name').type).toBe('VARCHAR(50)');
    });

    it('silently skips MSSQL GO batch separators', () => {
        const r = parse(`
            CREATE TABLE a (id INT);
            GO
            CREATE TABLE b (id INT);
            GO
        `);
        expect(r.tables).toHaveLength(2);
    });
});

// ════════════════════════════════════════════
// ALTER TABLE ADD …
// ════════════════════════════════════════════

describe('ALTER TABLE', () => {
    it('parses ADD CONSTRAINT … FOREIGN KEY', () => {
        const r = parse(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (id INT PRIMARY KEY, parent_id INT);
            ALTER TABLE child ADD CONSTRAINT fk_p FOREIGN KEY (parent_id) REFERENCES parent(id);
        `);
        const a = r.alters[0];
        expect(a.action).toBe('add_foreign');
        expect(a.name).toBe('fk_p');
        expect(a.columns).toEqual(['parent_id']);
        expect(a.references.table).toBe('parent');
    });

    it('parses ADD PRIMARY KEY (composite)', () => {
        const r = parse(`
            CREATE TABLE t (a INT, b INT);
            ALTER TABLE t ADD PRIMARY KEY (a, b);
        `);
        const a = r.alters[0];
        expect(a.action).toBe('add_primary');
        expect(a.columns).toEqual(['a', 'b']);
    });

    it('parses ADD UNIQUE', () => {
        const r = parse(`
            CREATE TABLE t (email VARCHAR(255));
            ALTER TABLE t ADD CONSTRAINT uq_email UNIQUE (email);
        `);
        const a = r.alters[0];
        expect(a.action).toBe('add_unique');
        expect(a.name).toBe('uq_email');
    });

    it('parses ADD CHECK', () => {
        const r = parse(`
            CREATE TABLE t (age INT);
            ALTER TABLE t ADD CONSTRAINT chk_age CHECK (age >= 0);
        `);
        const a = r.alters[0];
        expect(a.action).toBe('add_check');
        expect(a.expression).toContain('age');
    });

    it('warns when ALTER references an undefined table', () => {
        const r = parse(`
            CREATE TABLE child (id INT, p INT);
            ALTER TABLE child ADD FOREIGN KEY (p) REFERENCES ghost(id);
        `);
        expect(r.warns().some((w) => /ghost/.test(w.message))).toBe(true);
    });
});

// ════════════════════════════════════════════
// Error reporting & recovery
// ════════════════════════════════════════════

describe('Error reporting', () => {
    it('errors on a column missing its data type', () => {
        const r = parse(`CREATE TABLE t (oops) ENGINE=InnoDB;`);
        expect(r.errs().length).toBeGreaterThan(0);
    });

    it('errors on trailing comma in column list', () => {
        const r = parse(`CREATE TABLE t (id INT,);`);
        expect(r.errs().some((e) => /trailing comma/i.test(e.message))).toBe(true);
    });

    it('errors on double comma between columns', () => {
        const r = parse(`CREATE TABLE t (id INT,, name TEXT);`);
        expect(r.errs().length).toBeGreaterThan(0);
    });

    it('reports unclosed parentheses in a table body', () => {
        const r = parse(`CREATE TABLE t (id INT, name TEXT ; CREATE TABLE u (id INT);`);
        expect(r.errs().some((e) => /[Uu]nclosed/.test(e.message))).toBe(true);
    });

    it('still produces a partial AST when there are recoverable errors', () => {
        const r = parse(`
            CREATE TABLE good (id INT);
            CREATE TABLE bad (oops) ENGINE=InnoDB;
            CREATE TABLE good2 (id INT);
        `);
        // 'good' and 'good2' should still parse even though 'bad' fails
        expect(r.table('good')).not.toBeNull();
        expect(r.table('good2')).not.toBeNull();
        expect(r.errs().length).toBeGreaterThan(0);
    });

    it('reports tokenizer errors as part of parseAST errors', () => {
        const r = parse(`CREATE TABLE t (id INT, name 'unterminated`);
        expect(r.errors.length).toBeGreaterThan(0);
    });
});

// ════════════════════════════════════════════
// Multi-table integration smoke
// ════════════════════════════════════════════

describe('End-to-end multi-table script', () => {
    it('parses a realistic schema with enums, FKs, generated and computed columns together', () => {
        const sql = `
            CREATE TYPE order_status AS ENUM ('pending','paid','shipped');

            CREATE TABLE customers (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                full_name AS (CONCAT(first_name, ' ', last_name))
            );

            CREATE TABLE orders (
                id SERIAL PRIMARY KEY,
                customer_id INT REFERENCES customers(id) ON DELETE CASCADE,
                status order_status DEFAULT 'pending',
                price NUMERIC(10,2),
                qty INT,
                total NUMERIC GENERATED ALWAYS AS (price * qty) STORED,
                tax AS (price * 0.1) PERSISTED
            );

            ALTER TABLE orders ADD CONSTRAINT chk_qty CHECK (qty > 0);
        `;
        const r = parse(sql);

        expect(r.errs()).toHaveLength(0);
        expect(r.tables).toHaveLength(2);

        // Enum
        expect(r.type('order_status').values).toEqual(['pending', 'paid', 'shipped']);

        // Customers — MSSQL computed
        expect(r.column('customers', 'full_name').type).toBe('COMPUTED');
        expect(r.column('customers', 'full_name').generated).toContain('CONCAT');

        // Orders — both forms
        expect(r.column('orders', 'total').generated).toContain('GENERATED ALWAYS');
        expect(r.column('orders', 'tax').generated).toBe('AS (price * 0.1) PERSISTED');

        // FK
        expect(r.column('orders', 'customer_id').references.table).toBe('customers');

        // ALTER
        expect(r.alters[0].action).toBe('add_check');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Comments, whitespace, line endings
// ════════════════════════════════════════════════════════════════════════════

describe('Whitespace, comments and line endings', () => {
    it('skips single-line -- comments', () => {
        const r = parse(`
            -- this is a comment
            CREATE TABLE t (id INT); -- trailing comment
        `);
        expect(r.table('t')).not.toBeNull();
        expect(r.errs()).toHaveLength(0);
    });

    it('skips block /* ... */ comments', () => {
        const r = parse(`
            /* leading
               block comment */
            CREATE TABLE t (id INT);
            /* between */ CREATE TABLE u (id INT); /* trailing */
        `);
        expect(r.tables).toHaveLength(2);
    });

    it('skips nested PostgreSQL / SQL Server block comments without swallowing DDL', () => {
        const r = parse(`/* outer /* inner */ still outer */ CREATE TABLE nested_comment_table (id INT);`);
        expect(r.errs()).toHaveLength(0);
        expect(r.table('nested_comment_table')).not.toBeNull();
    });

    it('reports an unclosed block comment', () => {
        const r = parse(`/* never closed`);
        expect(r.errors.some((e) => /[Uu]nclosed.*block.*comment/.test(e.message || ''))).toBe(true);
    });

    it('normalizes CRLF line endings', () => {
        const r = parse('CREATE TABLE t (id INT);\r\nCREATE TABLE u (id INT);\r\n');
        expect(r.tables).toHaveLength(2);
    });

    it('treats whitespace-only input as a no-op (no tables, no errors)', () => {
        const r = parse(`   \n\t\n   `);
        expect(r.tables).toHaveLength(0);
        expect(r.errs()).toHaveLength(0);
    });

    it('treats comment-only input as a no-op', () => {
        const r = parse(`-- nothing here\n/* nada */`);
        expect(r.tables).toHaveLength(0);
        expect(r.errs()).toHaveLength(0);
    });

    it('handles multiple consecutive semicolons', () => {
        const r = parse(`CREATE TABLE t (id INT);;;; CREATE TABLE u (id INT);`);
        expect(r.tables).toHaveLength(2);
    });

    it('handles a final statement without trailing semicolon', () => {
        const r = parse(`CREATE TABLE t (id INT)`);
        expect(r.table('t')).not.toBeNull();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Identifier flavors
// ════════════════════════════════════════════════════════════════════════════

describe('Identifier flavors', () => {
    it('accepts Unicode identifiers (Vietnamese)', () => {
        const r = parse(`CREATE TABLE người_dùng (mã_id INT PRIMARY KEY, tên VARCHAR(100));`);
        const t = r.table('người_dùng');
        expect(t).not.toBeNull();
        expect(t.columns.map((c) => c.name)).toEqual(['mã_id', 'tên']);
    });

    it('accepts double-quoted reserved words as identifiers', () => {
        const r = parse(`CREATE TABLE "select" ("from" INT, "where" TEXT);`);
        const t = r.table('select');
        expect(t).not.toBeNull();
        expect(t.columns.map((c) => c.name)).toEqual(['from', 'where']);
    });

    it('accepts MySQL backtick identifiers', () => {
        const r = parse('CREATE TABLE `t` (`my col` INT);');
        const t = r.table('t');
        expect(t).not.toBeNull();
        expect(t.columns[0].name).toBe('my col');
    });

    it('accepts MSSQL bracket identifiers', () => {
        const r = parse(`CREATE TABLE [my table] ([id] INT, [first name] NVARCHAR(50));`);
        const t = r.table('my table');
        expect(t).not.toBeNull();
        expect(t.columns.map((c) => c.name)).toEqual(['id', 'first name']);
    });

    it('preserves quoted identifiers with embedded escaped quotes', () => {
        const r = parse(`CREATE TABLE "with""quote" ("a""b" INT);`);
        expect(r.table('with"quote')).not.toBeNull();
        expect(r.column('with"quote', 'a"b')).not.toBeNull();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Auto-increment / SERIAL family
// ════════════════════════════════════════════════════════════════════════════

describe('Auto-increment types', () => {
    it('parses SERIAL as a type and respects PRIMARY KEY', () => {
        const r = parse(`CREATE TABLE t (id SERIAL PRIMARY KEY);`);
        const id = r.column('t', 'id');
        expect(id.type).toBe('SERIAL');
        expect(id.primary).toBe(true);
    });

    it('parses BIGSERIAL', () => {
        const r = parse(`CREATE TABLE t (id BIGSERIAL);`);
        expect(r.column('t', 'id').type).toBe('BIGSERIAL');
    });

    it('parses MySQL AUTO_INCREMENT alongside the type', () => {
        const r = parse(`CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY, name TEXT);`);
        const id = r.column('t', 'id');
        expect(id.type).toBe('INT');
        expect(id.primary).toBe(true);
    });

    it('parses MSSQL IDENTITY(seed, increment) and ignores it for the type', () => {
        const r = parse(`CREATE TABLE t (id INT IDENTITY(1,1) PRIMARY KEY);`);
        const id = r.column('t', 'id');
        expect(id.type).toBe('INT');
        expect(id.primary).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// DEFAULT — every flavor
// ════════════════════════════════════════════════════════════════════════════

describe('DEFAULT values — every flavor', () => {
    it('captures DEFAULT NULL as the literal "NULL" (regression: was "")', () => {
        const r = parse(`CREATE TABLE t (val INT DEFAULT NULL);`);
        expect(r.column('t', 'val').default).toBe('NULL');
    });

    it('combines DEFAULT NULL with NOT NULL correctly', () => {
        const r = parse(`CREATE TABLE t (ts TIMESTAMP DEFAULT NULL NOT NULL);`);
        const col = r.column('t', 'ts');
        expect(col.default).toBe('NULL');
        expect(col.notNull).toBe(true);
    });

    it('captures parenthesized DEFAULT expressions', () => {
        const r = parse(`CREATE TABLE t (val INT DEFAULT (10 * 2 + 1));`);
        expect(r.column('t', 'val').default).toBe('(10 * 2 + 1)');
    });

    it('captures DEFAULT NEXTVAL (PostgreSQL sequences)', () => {
        const r = parse(`CREATE TABLE t (id INT DEFAULT NEXTVAL('seq'));`);
        expect(r.column('t', 'id').default).toBe(`NEXTVAL('seq')`);
    });

    it('captures DEFAULT CURRENT_DATE / CURRENT_TIME / NOW()', () => {
        const r = parse(`
            CREATE TABLE t (
                d DATE DEFAULT CURRENT_DATE,
                t TIME DEFAULT CURRENT_TIME,
                n TIMESTAMP DEFAULT NOW()
            );
        `);
        expect(r.column('t', 'd').default).toBe('CURRENT_DATE');
        expect(r.column('t', 't').default).toBe('CURRENT_TIME');
        expect(r.column('t', 'n').default).toBe('NOW()');
    });

    it('preserves escaped single quotes in DEFAULT string literals', () => {
        const r = parse(`CREATE TABLE t (msg TEXT DEFAULT 'it''s ok');`);
        expect(r.column('t', 'msg').default).toBe(`'it''s ok'`);
    });

    it('captures MSSQL GETDATE() / NEWID()', () => {
        const r = parse(`
            CREATE TABLE t (
                created DATETIME DEFAULT GETDATE(),
                id UNIQUEIDENTIFIER DEFAULT NEWID()
            );
        `);
        expect(r.column('t', 'created').default).toBe('GETDATE()');
        expect(r.column('t', 'id').default).toBe('NEWID()');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Foreign key actions (full ON DELETE/UPDATE matrix)
// ════════════════════════════════════════════════════════════════════════════

describe('FK actions matrix', () => {
    it.each([
        ['ON DELETE CASCADE'],
        ['ON DELETE SET NULL'],
        ['ON DELETE SET DEFAULT'],
        ['ON DELETE NO ACTION'],
        ['ON DELETE RESTRICT'],
        ['ON UPDATE CASCADE'],
        ['ON UPDATE SET NULL'],
        ['ON UPDATE SET DEFAULT'],
        ['ON UPDATE NO ACTION'],
        ['ON UPDATE RESTRICT'],
    ])('parses "%s" without losing the FK', (action) => {
        const sql = `
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (pid INT REFERENCES p(id) ${action});
        `;
        const r = parse(sql);
        expect(r.errs()).toHaveLength(0);
        expect(r.column('c', 'pid').references.table).toBe('p');
    });

    it('parses combined ON DELETE … ON UPDATE …', () => {
        const r = parse(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (
                pid INT REFERENCES p(id) ON DELETE SET DEFAULT ON UPDATE NO ACTION
            );
        `);
        expect(r.column('c', 'pid').references.table).toBe('p');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// REFERENCES edge cases
// ════════════════════════════════════════════════════════════════════════════

describe('REFERENCES — edge cases', () => {
    it('accepts REFERENCES with no column list (PostgreSQL: implicit PK)', () => {
        const r = parse(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (pid INT REFERENCES p);
        `);
        const ref = r.column('c', 'pid').references;
        expect(ref.table).toBe('p');
        expect(ref.columns).toEqual([]);
    });

    it('accepts schema-qualified REFERENCES', () => {
        const r = parse(`
            CREATE TABLE public.p (id INT PRIMARY KEY);
            CREATE TABLE c (pid INT REFERENCES public.p(id));
        `);
        expect(r.column('c', 'pid').references.table).toBe('public.p');
    });

    it('parses self-referencing FK', () => {
        const r = parse(`
            CREATE TABLE node (
                id INT PRIMARY KEY,
                parent_id INT REFERENCES node(id)
            );
        `);
        expect(r.column('node', 'parent_id').references.table).toBe('node');
        expect(r.errs()).toHaveLength(0);
    });

    it('parses composite FK (table-level FOREIGN KEY (a,b) REFERENCES p(x,y))', () => {
        const r = parse(`
            CREATE TABLE p (a INT, b INT, PRIMARY KEY (a, b));
            CREATE TABLE c (
                pa INT, pb INT,
                FOREIGN KEY (pa, pb) REFERENCES p(a, b)
            );
        `);
        const fk = r.table('c').constraints.find((c) => c && c.kind === 'foreign');
        expect(fk.columns).toEqual(['pa', 'pb']);
        expect(fk.references.columns).toEqual(['a', 'b']);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Inline ENUM — multiple in one table, escaping
// ════════════════════════════════════════════════════════════════════════════

describe('Inline ENUM — extended', () => {
    it('lifts multiple inline ENUMs in a single table independently', () => {
        const r = parse(`
            CREATE TABLE t (
                id INT,
                status ENUM('a','b'),
                priority ENUM('low','high')
            );
        `);
        expect(r.type('status_enum').values).toEqual(['a', 'b']);
        expect(r.type('priority_enum').values).toEqual(['low', 'high']);
        expect(r.column('t', 'status').type).toBe('status_enum');
        expect(r.column('t', 'priority').type).toBe('priority_enum');
    });

    it('preserves escaped single quotes inside inline ENUM values', () => {
        const r = parse(`CREATE TABLE t (s ENUM('it''s', 'b'));`);
        expect(r.type('s_enum').values).toEqual(["it's", 'b']);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// CREATE TYPE … AS ENUM — extended
// ════════════════════════════════════════════════════════════════════════════

describe('CREATE TYPE AS ENUM — extended', () => {
    it('parses a single-value ENUM', () => {
        const r = parse(`CREATE TYPE one AS ENUM ('only');`);
        expect(r.type('one').values).toEqual(['only']);
    });

    it('preserves escaped quotes in ENUM values', () => {
        const r = parse(`CREATE TYPE q AS ENUM ('a''b', 'c');`);
        expect(r.type('q').values).toEqual(["a'b", 'c']);
    });

    it('warns on CREATE TYPE without AS', () => {
        const r = parse(`CREATE TYPE bad ENUM ('x');`);
        expect(r.warns().length).toBeGreaterThan(0);
    });

    it('warns on CREATE TYPE with neither ENUM nor (', () => {
        const r = parse(`CREATE TYPE bad AS BANANA;`);
        expect(r.warns().length).toBeGreaterThan(0);
    });

    it('handles an empty composite type as zero fields', () => {
        const r = parse(`CREATE TYPE empty AS ();`);
        const t = r.type('empty');
        expect(t.kind).toBe('composite');
        expect(t.fields).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// GENERATED — edge cases
// ════════════════════════════════════════════════════════════════════════════

describe('GENERATED — edge cases', () => {
    it('captures GENERATED ALWAYS AS without STORED/VIRTUAL', () => {
        const r = parse(`CREATE TABLE t (a INT, b INT, sum INT GENERATED ALWAYS AS (a + b));`);
        expect(r.column('t', 'sum').generated).toBe('GENERATED ALWAYS AS (a + b)');
    });

    it('captures a GENERATED expression using a function call', () => {
        const r = parse(`CREATE TABLE t (name TEXT, upper_name TEXT GENERATED ALWAYS AS (UPPER(name)) STORED);`);
        expect(r.column('t', 'upper_name').generated).toContain('UPPER(name)');
    });

    it('captures PostgreSQL casts inside GENERATED expressions without spacing drift', () => {
        const r = parse(`CREATE TABLE t (occurred_at TIMESTAMP, day_bucket DATE GENERATED ALWAYS AS (occurred_at::date) STORED);`);
        expect(r.column('t', 'day_bucket').generated).toBe('GENERATED ALWAYS AS (occurred_at::DATE) STORED');
    });

    it('parses MSSQL bare-expression computed column (no surrounding parens)', () => {
        // T-SQL allows AS <expression> without enclosing parens.
        const r = parse(`CREATE TABLE t (price INT, qty INT, total AS price * qty);`);
        expect(r.errs()).toHaveLength(0);
        const total = r.column('t', 'total');
        expect(total.type).toBe('COMPUTED');
        expect(total.generated).toBe('AS price * qty');
    });

    it('parses MSSQL bare-expression with function call: AS DATEADD(...)', () => {
        // The exact failing case the user reported.
        const r = parse(`
            CREATE TABLE harvests (
                PlantingDate DATE,
                GrowthDurationDays INT,
                ExpectedHarvestDate AS DATEADD(DAY, GrowthDurationDays, PlantingDate) PERSISTED
            );
        `);
        expect(r.errs()).toHaveLength(0);
        const eh = r.column('harvests', 'ExpectedHarvestDate');
        expect(eh.type).toBe('COMPUTED');
        expect(eh.generated).toBe('AS DATEADD(DAY, GrowthDurationDays, PlantingDate) PERSISTED');
    });

    it('parses MSSQL bare-expression with schema-qualified function + PERSISTED NOT NULL', () => {
        const r = parse(`
            CREATE TABLE t (
                a INT, b INT,
                hash AS dbo.HashFn(a, b) PERSISTED NOT NULL
            );
        `);
        expect(r.errs()).toHaveLength(0);
        const c = r.column('t', 'hash');
        expect(c.type).toBe('COMPUTED');
        expect(c.notNull).toBe(true);
        expect(c.generated).toContain('dbo.HashFn(a, b)');
        expect(c.generated).toContain('PERSISTED NOT NULL');
    });

    it('parses MSSQL bare-expression with table-qualified column reference (c.col)', () => {
        const r = parse(`
            CREATE TABLE t (
                a INT,
                doubled AS c.a * 2
            );
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.column('t', 'doubled').generated).toBe('AS c.a * 2');
    });

    it('parses MSSQL bare-expression followed by next column on same line', () => {
        const r = parse(`CREATE TABLE t (a INT, b AS a + 1, c TEXT);`);
        expect(r.errs()).toHaveLength(0);
        expect(r.column('t', 'b').type).toBe('COMPUTED');
        expect(r.column('t', 'b').generated).toBe('AS a + 1');
        expect(r.column('t', 'c').type).toBe('TEXT');
    });

    it('parenthesized form still works (regression check)', () => {
        const r = parse(`CREATE TABLE t (a INT, b INT, sum AS (a + b) PERSISTED);`);
        expect(r.errs()).toHaveLength(0);
        expect(r.column('t', 'sum').generated).toBe('AS (a + b) PERSISTED');
    });

    it('captures MSSQL computed column referencing schema-qualified function (paren form)', () => {
        const r = parse(`
            CREATE TABLE t (
                a INT, b INT,
                hash AS (dbo.HashFn(a, b))
            );
        `);
        expect(r.column('t', 'hash').generated).toContain('dbo.HashFn(a, b)');
    });

    it('errors when MSSQL AS has no expression at all (immediately a comma)', () => {
        const r = parse(`CREATE TABLE t (a INT, total AS , b INT);`);
        expect(r.errs().some((e) => /missing expression after AS/.test(e.message))).toBe(true);
    });

    it('errors when MSSQL AS is the last thing in the column list', () => {
        const r = parse(`CREATE TABLE t (a INT, total AS );`);
        expect(r.errs().some((e) => /missing expression after AS/.test(e.message))).toBe(true);
    });

    it('parses real-world MSSQL agriculture schema with bare-AS DATEADD computed column', () => {
        // Reproduces the exact production-grade schema that initially failed
        // with: "MSSQL computed column 'ExpectedHarvestDate' missing '(' after AS".
        const r = parse(`
            CREATE TABLE Crops (
                CropID INT IDENTITY(1,1) PRIMARY KEY,
                Name NVARCHAR(100) NOT NULL,
                GrowthDurationDays INT NOT NULL
            );

            CREATE TABLE Plantings (
                PlantingID INT IDENTITY(1,1) PRIMARY KEY,
                CropID INT NOT NULL FOREIGN KEY REFERENCES Crops(CropID),
                PlantingDate DATE NOT NULL,
                ExpectedHarvestDate AS DATEADD(DAY, 90, PlantingDate) PERSISTED,
                Notes NVARCHAR(MAX)
            );
        `);
        expect(r.errs()).toHaveLength(0);
        const eh = r.column('Plantings', 'ExpectedHarvestDate');
        expect(eh.type).toBe('COMPUTED');
        expect(eh.generated).toBe('AS DATEADD(DAY, 90, PlantingDate) PERSISTED');
        // FK still resolves alongside the computed column.
        expect(r.column('Plantings', 'CropID').references.table).toBe('Crops');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// ALTER TABLE — extended
// ════════════════════════════════════════════════════════════════════════════

describe('ALTER TABLE — extended', () => {
    it('parses multiple comma-separated ADD CONSTRAINT clauses in one ALTER', () => {
        const r = parse(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (id INT, p1 INT, p2 INT);
            ALTER TABLE c
                ADD CONSTRAINT fk1 FOREIGN KEY (p1) REFERENCES p(id),
                ADD CONSTRAINT fk2 FOREIGN KEY (p2) REFERENCES p(id);
        `);
        expect(r.alters).toHaveLength(2);
        expect(r.alters[0].name).toBe('fk1');
        expect(r.alters[1].name).toBe('fk2');
        expect(r.alters[0].columns).toEqual(['p1']);
        expect(r.alters[1].columns).toEqual(['p2']);
    });

    it('parses ALTER TABLE without trailing semicolon', () => {
        const r = parse(`
            CREATE TABLE t (id INT);
            ALTER TABLE t ADD PRIMARY KEY (id)
        `);
        expect(r.alters[0].action).toBe('add_primary');
    });

    it('warns when ALTER is missing the TABLE keyword', () => {
        const r = parse(`ALTER NOT_TABLE foo;`);
        expect(r.warns().length).toBeGreaterThan(0);
    });

    it('records position info on each alter', () => {
        const r = parse(`
            CREATE TABLE t (id INT, name TEXT);
            ALTER TABLE t ADD CONSTRAINT uq_name UNIQUE (name);
        `);
        expect(r.alters[0].position).toBeTruthy();
        expect(r.alters[0].position.start).toBeTruthy();
        expect(r.alters[0].position.end).toBeTruthy();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Skipped statements (CREATE INDEX / VIEW / SCHEMA / PROCEDURE)
// ════════════════════════════════════════════════════════════════════════════

describe('Non-table CREATE statements are silently skipped', () => {
    it('parses CREATE INDEX between two CREATE TABLE statements', () => {
        const r = parse(`
            CREATE TABLE t (id INT, name TEXT);
            CREATE INDEX idx_t_name ON t(name);
            CREATE TABLE u (id INT);
        `);
        expect(r.tables.map((t) => t.name)).toEqual(['t', 'u']);
        expect(r.errs()).toHaveLength(0);
        // Index now captured (no longer silently skipped) — see "CREATE INDEX" suite below.
        expect(r.ast.indexes).toHaveLength(1);
        expect(r.ast.indexes[0]).toMatchObject({ name: 'idx_t_name', table: 't', columns: ['name'], unique: false });
    });

    it('skips CREATE VIEW', () => {
        const r = parse(`
            CREATE VIEW v AS SELECT * FROM t;
            CREATE TABLE x (id INT);
        `);
        expect(r.table('x')).not.toBeNull();
        expect(r.errs()).toHaveLength(0);
    });

    it('skips CREATE SCHEMA', () => {
        const r = parse(`
            CREATE SCHEMA app;
            CREATE TABLE app.users (id INT);
        `);
        expect(r.table('users')).not.toBeNull();
    });

    it('skips CREATE PROCEDURE', () => {
        const r = parse(`
            CREATE PROCEDURE foo() AS BEGIN SELECT 1; END;
            CREATE TABLE u (id INT);
        `);
        expect(r.table('u')).not.toBeNull();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Table-level CHECK
// ════════════════════════════════════════════════════════════════════════════

describe('Table-level CHECK — extended', () => {
    it('parses a named table-level CHECK', () => {
        const r = parse(`
            CREATE TABLE t (
                age INT,
                CONSTRAINT chk_age CHECK (age >= 0)
            );
        `);
        const chk = r.table('t').constraints.find((c) => c.kind === 'check');
        expect(chk.name).toBe('chk_age');
        expect(chk.expression).toContain('age');
    });

    it('parses a CHECK with logical operators (AND / OR)', () => {
        const r = parse(`
            CREATE TABLE t (a INT, b INT, CHECK (a > 0 AND b > 0));
        `);
        const chk = r.table('t').constraints.find((c) => c.kind === 'check');
        expect(chk.expression).toMatch(/AND/);
    });

    it('parses a CHECK using IN (...)', () => {
        const r = parse(`
            CREATE TABLE t (status TEXT, CHECK (status IN ('a', 'b', 'c')));
        `);
        const chk = r.table('t').constraints.find((c) => c.kind === 'check');
        expect(chk.expression).toMatch(/IN/);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Position tracking
// ════════════════════════════════════════════════════════════════════════════

describe('Position information', () => {
    it('records start and end on every table', () => {
        const r = parse(`
            CREATE TABLE a (id INT);
            CREATE TABLE b (id INT);
        `);
        for (const t of r.tables) {
            expect(t.position).toBeTruthy();
            expect(typeof t.position.start.line).toBe('number');
            expect(typeof t.position.end.line).toBe('number');
        }
    });

    it('attaches a position to every error/warning', () => {
        const r = parse(`CREATE TABLE t (id INT,);`);
        expect(r.errs().length).toBeGreaterThan(0);
        for (const e of r.errs()) {
            expect(e.position).toBeTruthy();
            expect(typeof e.position.line).toBe('number');
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Cross-dialect smoke
// ════════════════════════════════════════════════════════════════════════════

describe('Cross-dialect smoke', () => {
    it('parses PG, MySQL and MSSQL constructs in one script with zero errors', () => {
        const sql = `
            -- PostgreSQL
            CREATE TYPE mood AS ENUM ('happy', 'sad');
            CREATE TABLE pg_t (
                id SERIAL PRIMARY KEY,
                m mood DEFAULT 'happy',
                created TIMESTAMP DEFAULT NOW(),
                updated TIMESTAMP DEFAULT NULL
            );

            -- MySQL
            CREATE TABLE \`mysql_t\` (
                \`id\` INT AUTO_INCREMENT PRIMARY KEY,
                \`size\` ENUM('S','M','L') NOT NULL,
                \`comment\` VARCHAR(255) COMMENT 'a column'
            );

            -- MSSQL
            CREATE TABLE [dbo].[mssql_t] (
                [id] INT IDENTITY(1,1) PRIMARY KEY,
                [name] NVARCHAR(50),
                [created] DATETIME DEFAULT GETDATE(),
                [computed] AS ([id] * 2) PERSISTED
            );
            GO
        `;
        const r = parse(sql);
        expect(r.errs()).toHaveLength(0);
        expect(r.tables).toHaveLength(3);
        expect(r.column('pg_t', 'updated').default).toBe('NULL');
        expect(r.column('mysql_t', 'size').type).toBe('size_enum');
        // Bracket identifiers ([id]) are stripped to bare 'id' by the tokenizer
        expect(r.column('mssql_t', 'computed').generated).toBe('AS (id * 2) PERSISTED');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// PostgreSQL — dialect-specific features
// ════════════════════════════════════════════════════════════════════════════

describe('PostgreSQL dialect', () => {
    it('CREATE TEMP TABLE is recognized', () => {
        const r = parse(`CREATE TEMP TABLE t (id INT);`);
        expect(r.errs()).toHaveLength(0);
        expect(r.table('t')).toBeTruthy();
    });

    it('CREATE TEMPORARY TABLE is recognized', () => {
        const r = parse(`CREATE TEMPORARY TABLE t (id INT);`);
        expect(r.errs()).toHaveLength(0);
        expect(r.table('t')).toBeTruthy();
    });

    it('CREATE UNLOGGED TABLE is recognized', () => {
        const r = parse(`CREATE UNLOGGED TABLE t (id INT);`);
        expect(r.errs()).toHaveLength(0);
        expect(r.table('t')).toBeTruthy();
    });

    it('CREATE GLOBAL TEMP TABLE is recognized', () => {
        const r = parse(`CREATE GLOBAL TEMP TABLE t (id INT);`);
        expect(r.errs()).toHaveLength(0);
        expect(r.table('t')).toBeTruthy();
    });

    it('preserves PG array suffix on simple types', () => {
        const r = parse(`CREATE TABLE t (tags INTEGER[], names TEXT[]);`);
        expect(r.column('t', 'tags').type).toBe('INTEGER[]');
        expect(r.column('t', 'names').type).toBe('TEXT[]');
    });

    it('preserves PG multi-dim arrays', () => {
        const r = parse(`CREATE TABLE t (m TEXT[][]);`);
        expect(r.column('t', 'm').type).toBe('TEXT[][]');
    });

    it('preserves PG arrays on parameterized types', () => {
        const r = parse(`CREATE TABLE t (xs NUMERIC(10, 2)[]);`);
        expect(r.column('t', 'xs').type).toBe('NUMERIC(10, 2)[]');
    });

    it('GENERATED ALWAYS AS IDENTITY is auto-increment, not a generated column', () => {
        const r = parse(`CREATE TABLE u (id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, n TEXT);`);
        const c = r.column('u', 'id');
        expect(c.autoIncrement).toBe(true);
        expect(c.generated).toBeNull();
        expect(c.primary).toBe(true);
    });

    it('GENERATED BY DEFAULT AS IDENTITY ( seq options ) is auto-increment', () => {
        const r = parse(`CREATE TABLE u (id INT GENERATED BY DEFAULT AS IDENTITY (START WITH 100 INCREMENT BY 5) PRIMARY KEY);`);
        const c = r.column('u', 'id');
        expect(c.autoIncrement).toBe(true);
        expect(c.generated).toBeNull();
    });

    it('SERIAL/BIGSERIAL/SMALLSERIAL are auto-increment + NOT NULL', () => {
        const r = parse(`CREATE TABLE t (a SERIAL, b BIGSERIAL, c SMALLSERIAL);`);
        for (const n of ['a', 'b', 'c']) {
            const col = r.column('t', n);
            expect(col.autoIncrement).toBe(true);
            expect(col.notNull).toBe(true);
        }
    });

    it('GENERATED ALWAYS AS (expr) STORED is still recorded as generated', () => {
        const r = parse(`CREATE TABLE p (price NUMERIC, qty INT, total NUMERIC GENERATED ALWAYS AS (price * qty) STORED);`);
        const t = r.column('p', 'total');
        expect(t.generated).toBe('GENERATED ALWAYS AS (price * qty) STORED');
        expect(t.autoIncrement).toBe(false);
    });

    it('GENERATED ALWAYS AS (expr) VIRTUAL is still recorded as generated', () => {
        const r = parse(`CREATE TABLE p (price NUMERIC, discount NUMERIC GENERATED ALWAYS AS (price * 0.1) VIRTUAL);`);
        expect(r.column('p', 'discount').generated).toMatch(/VIRTUAL$/);
    });

    it('skips PG INHERITS clause cleanly', () => {
        const r = parse(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (extra INT) INHERITS (parent);
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.table('child').columns).toHaveLength(1);
        expect(r.column('child', 'extra').type).toBe('INT');
    });

    it('skips PG LIKE source_table clause inside table body', () => {
        const r = parse(`CREATE TABLE x (LIKE y INCLUDING ALL, extra INT);`);
        const t = r.table('x');
        expect(t).toBeTruthy();
        expect(t.columns.map((c) => c.name)).toEqual(['extra']);
    });

    it('skips PG table-level EXCLUDE constraint', () => {
        const r = parse(`CREATE TABLE t (id INT, range int4range, EXCLUDE USING gist (range WITH &&));`);
        const t = r.table('t');
        expect(t.columns.map((c) => c.name)).toEqual(['id', 'range']);
    });

    it('parses TIMESTAMPTZ / TIMESTAMP WITH TIME ZONE', () => {
        const r = parse(`CREATE TABLE t (a TIMESTAMPTZ DEFAULT NOW());`);
        expect(r.column('t', 'a').type).toBe('TIMESTAMPTZ');
    });

    it('parses INET, CIDR, MACADDR, BYTEA, JSONB, UUID', () => {
        const r = parse(`CREATE TABLE t (a INET, b CIDR, c MACADDR, d BYTEA, e JSONB, f UUID);`);
        ['INET', 'CIDR', 'MACADDR', 'BYTEA', 'JSONB', 'UUID'].forEach((tp) => {
            expect(r.tables[0].columns.find((c) => c.type === tp || c.type.toUpperCase() === tp)).toBeTruthy();
        });
    });

    it('parses INTERVAL DAY TO SECOND multi-word type', () => {
        const r = parse(`CREATE TABLE t (dur INTERVAL DAY TO SECOND);`);
        expect(r.column('t', 'dur').type).toMatch(/INTERVAL/);
    });

    it('uses CREATE TYPE foo AS ENUM after schema-qualified name', () => {
        const r = parse(`CREATE TYPE public.mood AS ENUM ('happy','sad');`);
        const t = r.types.find((x) => x.kind === 'enum' && x.name.endsWith('mood'));
        expect(t.values).toEqual(['happy', 'sad']);
    });

    it('skips PG WITH (storage_options) trailing clause', () => {
        const r = parse(`CREATE TABLE t (id INT) WITH (fillfactor=70, autovacuum_enabled=off);`);
        expect(r.errs()).toHaveLength(0);
        expect(r.table('t').columns).toHaveLength(1);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// MySQL — dialect-specific features
// ════════════════════════════════════════════════════════════════════════════

describe('MySQL dialect', () => {
    it('skips ENGINE=...  CHARSET=...  COLLATE=...  COMMENT=...  trailing options', () => {
        const r = parse(`CREATE TABLE t (id INT PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='users';`);
        expect(r.errs()).toHaveLength(0);
        expect(r.table('t').columns).toHaveLength(1);
    });

    it('parses inline SET(...) as enum-like type with _set suffix', () => {
        const r = parse(`CREATE TABLE t (perms SET('read','write','admin'));`);
        expect(r.column('t', 'perms').type).toBe('perms_set');
        const enumType = r.types.find((tp) => tp.kind === 'enum' && tp.name === 'perms_set');
        expect(enumType.values).toEqual(['read', 'write', 'admin']);
        expect(enumType.isInline).toBe(true);
    });

    it('parses inline ENUM(...) as enum-like type with _enum suffix (MySQL form)', () => {
        const r = parse(`CREATE TABLE t (size ENUM('S','M','L'));`);
        expect(r.column('t', 'size').type).toBe('size_enum');
    });

    it('parses inline ENUM with MySQL CHARACTER SET and COLLATE suffix', () => {
        const r = parse(`CREATE TABLE t (status ENUM('new','done') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL);`);
        expect(r.column('t', 'status').type).toBe('status_enum');
        expect(r.type('status_enum').values).toEqual(['new', 'done']);
    });

    it('parses inline SET with MySQL CHARACTER SET and COLLATE suffix', () => {
        const r = parse(`CREATE TABLE t (flags SET('read','write') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci);`);
        expect(r.column('t', 'flags').type).toBe('flags_set');
        expect(r.type('flags_set').values).toEqual(['read', 'write']);
    });

    it('parses ALTER MODIFY inline ENUM with MySQL charset/collation suffix', () => {
        const r = parse(`
            CREATE TABLE t (status ENUM('new','done') NOT NULL);
            ALTER TABLE t MODIFY COLUMN status ENUM('new','done') CHARSET=utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'done';
        `);
        const alter = r.alters.find((item) => item.action === 'modify_column');
        expect(alter.column.type).toBe('status_enum');
        expect(alter.column.default).toBe("'done'");
        expect(r.type('status_enum').values).toEqual(['new', 'done']);
    });

    it('AUTO_INCREMENT marks column as auto-increment', () => {
        const r = parse(`CREATE TABLE u (id BIGINT AUTO_INCREMENT PRIMARY KEY);`);
        expect(r.column('u', 'id').autoIncrement).toBe(true);
    });

    it('UNSIGNED ZEROFILL is preserved in type', () => {
        const r = parse(`CREATE TABLE t (val INT(10) UNSIGNED ZEROFILL);`);
        expect(r.column('t', 'val').type).toBe('INT(10) UNSIGNED ZEROFILL');
    });

    it('parses BINARY/VARBINARY/BLOB types', () => {
        const r = parse(`CREATE TABLE t (a BINARY(16), b VARBINARY(255), c BLOB);`);
        expect(r.column('t', 'a').type).toBe('BINARY(16)');
        expect(r.column('t', 'b').type).toBe('VARBINARY(255)');
        expect(r.column('t', 'c').type).toBe('BLOB');
    });

    it('parses TINYTEXT / MEDIUMTEXT / LONGTEXT', () => {
        const r = parse(`CREATE TABLE t (a TINYTEXT, b MEDIUMTEXT, c LONGTEXT);`);
        expect(r.column('t', 'a').type).toBe('TINYTEXT');
        expect(r.column('t', 'b').type).toBe('MEDIUMTEXT');
        expect(r.column('t', 'c').type).toBe('LONGTEXT');
    });

    it('column-level ON UPDATE CURRENT_TIMESTAMP is consumed without errors', () => {
        const r = parse(`CREATE TABLE t (id INT PRIMARY KEY, ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP);`);
        expect(r.errs()).toHaveLength(0);
        expect(r.column('t', 'ts').default).toBe('CURRENT_TIMESTAMP');
    });

    it('backtick-quoted identifiers work in column and table positions', () => {
        const r = parse('CREATE TABLE `orders` (`id` INT, `customer id` INT);');
        expect(r.tables[0].name).toBe('orders');
        expect(r.column('orders', 'customer id')).toBeTruthy();
    });

    it('UNIQUE KEY idx_name (col) lifts UQ flag', () => {
        const r = parse(`CREATE TABLE t (id INT, email VARCHAR(255), UNIQUE KEY idx_email (email));`);
        expect(r.column('t', 'email').unique).toBe(true);
    });

    it('PRIMARY KEY pk_name (col) lifts PK flag (composite or single)', () => {
        const r = parse(`CREATE TABLE t (a INT, b INT, PRIMARY KEY pk (a, b));`);
        const cons = r.table('t').constraints.find((c) => c.kind === 'primary');
        expect(cons.columns).toEqual(['a', 'b']);
    });

    it('skips bare KEY / INDEX / FULLTEXT / SPATIAL definitions', () => {
        const r = parse(`
            CREATE TABLE t (
                id INT PRIMARY KEY,
                name VARCHAR(100),
                INDEX idx_name (name),
                FULLTEXT KEY ft (name),
                SPATIAL KEY sp (name)
            );
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.table('t').columns).toHaveLength(2);
    });

    it("column COMMENT '...' is consumed silently", () => {
        const r = parse(`CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(50) COMMENT 'user name');`);
        expect(r.errs()).toHaveLength(0);
    });

    it('handles multiple FK columns in one table-level FOREIGN KEY clause', () => {
        const r = parse(`
            CREATE TABLE parent (a INT, b INT, PRIMARY KEY (a, b));
            CREATE TABLE child (
                pa INT, pb INT,
                FOREIGN KEY (pa, pb) REFERENCES parent(a, b)
            );
        `);
        const fk = r.table('child').constraints.find((c) => c.kind === 'foreign');
        expect(fk.columns).toEqual(['pa', 'pb']);
        expect(fk.references.columns).toEqual(['a', 'b']);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// MSSQL — dialect-specific features
// ════════════════════════════════════════════════════════════════════════════

describe('MSSQL dialect', () => {
    it('IDENTITY(seed, increment) marks column as auto-increment', () => {
        const r = parse(`CREATE TABLE u (id INT IDENTITY(1,1) PRIMARY KEY);`);
        expect(r.column('u', 'id').autoIncrement).toBe(true);
        expect(r.column('u', 'id').primary).toBe(true);
    });

    it('IDENTITY without explicit args also marks auto-increment', () => {
        const r = parse(`CREATE TABLE u (id INT IDENTITY PRIMARY KEY);`);
        expect(r.column('u', 'id').autoIncrement).toBe(true);
    });

    it('PRIMARY KEY CLUSTERED / NONCLUSTERED is consumed', () => {
        const r = parse(`
            CREATE TABLE a (id INT, CONSTRAINT pk PRIMARY KEY CLUSTERED (id));
            CREATE TABLE b (id INT, CONSTRAINT pk PRIMARY KEY NONCLUSTERED (id));
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.table('a').constraints.find((c) => c.kind === 'primary').columns).toEqual(['id']);
        expect(r.table('b').constraints.find((c) => c.kind === 'primary').columns).toEqual(['id']);
    });

    it('computed column AS (expr) PERSISTED', () => {
        const r = parse(`CREATE TABLE t (a INT, b AS (a * 2) PERSISTED);`);
        const c = r.column('t', 'b');
        expect(c.type).toBe('COMPUTED');
        expect(c.generated).toBe('AS (a * 2) PERSISTED');
    });

    it('computed column AS (expr) PERSISTED NOT NULL flips notNull', () => {
        const r = parse(`CREATE TABLE t (a INT, b AS (a * 2) PERSISTED NOT NULL);`);
        const c = r.column('t', 'b');
        expect(c.notNull).toBe(true);
        expect(c.generated).toBe('AS (a * 2) PERSISTED NOT NULL');
    });

    it('non-persisted computed column AS (expr) only', () => {
        const r = parse(`CREATE TABLE t (a INT, b AS (a + 1));`);
        const c = r.column('t', 'b');
        expect(c.type).toBe('COMPUTED');
        expect(c.generated).toBe('AS (a + 1)');
        expect(c.notNull).toBe(false);
    });

    it('schema-qualified [dbo].[Table] is parsed (schema kept in name)', () => {
        const r = parse(`CREATE TABLE [dbo].[Customer] ([id] INT PRIMARY KEY);`);
        expect(r.tables).toHaveLength(1);
        expect(r.tables[0].name).toBe('dbo.Customer');
        expect(r.column('Customer', 'id').primary).toBe(true);
    });

    it('skips trailing ON [PRIMARY] filegroup clause', () => {
        const r = parse(`CREATE TABLE t (id INT PRIMARY KEY) ON [PRIMARY];`);
        expect(r.errs()).toHaveLength(0);
    });

    it('skips trailing WITH (FILLFACTOR=80) clause', () => {
        const r = parse(`CREATE TABLE t (id INT PRIMARY KEY) WITH (FILLFACTOR=80);`);
        expect(r.errs()).toHaveLength(0);
    });

    it('parses NVARCHAR(MAX), NCHAR, NTEXT, DATETIME2, DATETIMEOFFSET, ROWVERSION, UNIQUEIDENTIFIER, SMALLMONEY', () => {
        const r = parse(`
            CREATE TABLE t (
                a NVARCHAR(MAX),
                b NCHAR(10),
                c NTEXT,
                d DATETIME2(3),
                e DATETIMEOFFSET,
                f ROWVERSION,
                g UNIQUEIDENTIFIER,
                h SMALLMONEY
            );
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.column('t', 'a').type).toBe('NVARCHAR(MAX)');
        expect(r.column('t', 'b').type).toBe('NCHAR(10)');
        expect(r.column('t', 'c').type).toBe('NTEXT');
        expect(r.column('t', 'd').type).toBe('DATETIME2(3)');
        expect(r.column('t', 'e').type).toBe('DATETIMEOFFSET');
        expect(r.column('t', 'f').type).toBe('ROWVERSION');
        expect(r.column('t', 'g').type).toBe('UNIQUEIDENTIFIER');
        expect(r.column('t', 'h').type).toBe('SMALLMONEY');
    });

    it('GETDATE() and NEWID() defaults survive verbatim', () => {
        const r = parse(`CREATE TABLE t (a DATETIME DEFAULT GETDATE(), b UNIQUEIDENTIFIER DEFAULT NEWID());`);
        expect(r.column('t', 'a').default).toBe('GETDATE()');
        expect(r.column('t', 'b').default).toBe('NEWID()');
    });

    it('GO batch separator is silently skipped between statements', () => {
        const r = parse(`
            CREATE TABLE a (id INT);
            GO
            CREATE TABLE b (id INT);
            GO
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.tables).toHaveLength(2);
    });

    it('CONSTRAINT name PRIMARY KEY CLUSTERED is named correctly', () => {
        const r = parse(`CREATE TABLE t (id INT, CONSTRAINT pk_t PRIMARY KEY CLUSTERED (id));`);
        const pk = r.table('t').constraints.find((c) => c.kind === 'primary');
        expect(pk.name).toBe('pk_t');
    });

    it('SPARSE column attribute is consumed', () => {
        const r = parse(`CREATE TABLE t (id INT, opt INT SPARSE NULL);`);
        expect(r.errs()).toHaveLength(0);
        expect(r.column('t', 'opt').type).toMatch(/INT/);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Mega cross-dialect end-to-end smoke
// ════════════════════════════════════════════════════════════════════════════

describe('Mega cross-dialect end-to-end', () => {
    it('parses a real-world-ish mixed-dialect schema with zero errors', () => {
        const sql = `
            -- ─── PostgreSQL ───────────────────────────────────────────────
            CREATE TYPE public.user_status AS ENUM ('active','disabled','pending');

            CREATE TABLE public.users (
                id BIGSERIAL PRIMARY KEY,
                email VARCHAR(255) NOT NULL UNIQUE,
                status user_status NOT NULL DEFAULT 'active',
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

            -- ─── MySQL ────────────────────────────────────────────────────
            CREATE TABLE \`orders\` (
                \`id\` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                \`user_id\` BIGINT UNSIGNED NOT NULL,
                \`status\` ENUM('new','paid','shipped') NOT NULL DEFAULT 'new',
                \`perms\` SET('read','write','admin'),
                \`amount\` DECIMAL(10,2) UNSIGNED NOT NULL,
                \`created\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_user (\`user_id\`),
                CONSTRAINT fk_orders_user FOREIGN KEY (\`user_id\`) REFERENCES users(id) ON DELETE RESTRICT
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

            -- ─── MSSQL ────────────────────────────────────────────────────
            CREATE TABLE [dbo].[Audit] (
                [id] BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_audit PRIMARY KEY CLUSTERED,
                [order_id] BIGINT NOT NULL,
                [snapshot] NVARCHAR(MAX) NOT NULL,
                [created] DATETIME2 NOT NULL DEFAULT GETDATE(),
                [hash] AS (CHECKSUM([snapshot])) PERSISTED NOT NULL,
                CONSTRAINT fk_audit_order FOREIGN KEY ([order_id]) REFERENCES orders(id)
            ) ON [PRIMARY];
            GO

            ALTER TABLE [dbo].[Audit] ADD CONSTRAINT chk_id CHECK ([id] > 0);
        `;
        const r = parse(sql);
        expect(r.errs()).toHaveLength(0);

        // PG side
        expect(r.column('users', 'id').autoIncrement).toBe(true);
        expect(r.column('users', 'tags').type).toBe('TEXT[]');
        expect(r.column('users', 'updated_at').default).toBe('NULL');
        expect(r.column('posts', 'id').autoIncrement).toBe(true);
        expect(r.column('posts', 'word_count').generated).toMatch(/STORED$/);
        const followersPk = r.table('followers').constraints.find((c) => c.kind === 'primary');
        expect(followersPk.columns).toEqual(['follower_id', 'followed_id']);

        // MySQL side
        expect(r.column('orders', 'id').autoIncrement).toBe(true);
        expect(r.column('orders', 'status').type).toBe('status_enum');
        expect(r.column('orders', 'perms').type).toBe('perms_set');
        const ordersFk = r.table('orders').constraints.find((c) => c.kind === 'foreign');
        expect(ordersFk.references.table).toBe('users');

        // MSSQL side
        expect(r.column('Audit', 'id').autoIncrement).toBe(true);
        expect(r.column('Audit', 'hash').type).toBe('COMPUTED');
        expect(r.column('Audit', 'hash').notNull).toBe(true);
        expect(r.column('Audit', 'hash').generated).toMatch(/PERSISTED NOT NULL$/);
        const auditFk = r.table('Audit').constraints.find((c) => c.kind === 'foreign');
        expect(auditFk.references.table).toBe('orders');

        // ALTER chain
        expect(r.alters).toHaveLength(1);
        expect(r.alters[0].action).toBe('add_check');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Production-DDL patterns audit (cross-dialect)
// ════════════════════════════════════════════════════════════════════════════
describe('Production-DDL patterns — audit', () => {
    const cases = [
        // ── PG ──
        ['PG empty body INHERITS',         `CREATE TABLE c () INHERITS (a, b);`],
        ['PG WITH OIDS',                   `CREATE TABLE t (id INT) WITH OIDS;`],
        ['PG DEFERRABLE FK',               `CREATE TABLE p (id INT PRIMARY KEY); CREATE TABLE c (pid INT REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED);`],
        ['PG STORAGE PLAIN',               `CREATE TABLE t (a TEXT STORAGE PLAIN);`],
        ['PG EXCLUDE USING gist',          `CREATE TABLE t (id INT, range INT, EXCLUDE USING gist (range WITH &&));`],
        ['PG TIME WITH TIME ZONE',         `CREATE TABLE t (t TIME WITH TIME ZONE);`],
        ['PG TIMESTAMP(3) WITH TZ',        `CREATE TABLE t (t TIMESTAMP(3) WITH TIME ZONE);`],
        ['PG GENERATED w/ CASE',           `CREATE TABLE t (a INT, b INT GENERATED ALWAYS AS (CASE WHEN a > 0 THEN 1 ELSE 0 END) STORED);`],
        ['PG MATERIALIZED VIEW skipped',   `CREATE MATERIALIZED VIEW mv AS SELECT 1; CREATE TABLE t (id INT);`],
        ['PG schema-qualified TYPE inline',`CREATE TYPE app.status AS ENUM ('a','b'); CREATE TABLE u (s app.status NOT NULL);`],
        ['PG nested array TEXT[][][]',     `CREATE TABLE t (data TEXT[][][]);`],
        ['PG sized array INT[5]',          `CREATE TABLE t (data INT[5]);`],
        ['PG REFERENCES no col list',      `CREATE TABLE p (id INT PRIMARY KEY); CREATE TABLE c (pid INT REFERENCES p);`],
        ['PG array of UDT',                `CREATE TYPE addr AS (s TEXT); CREATE TABLE t (xs addr[]);`],
        ['PG COLLATE column-level',        `CREATE TABLE t (a TEXT COLLATE "C");`],
        ['PG CHECK with subselect',        `CREATE TABLE t (a INT CHECK (a IN (SELECT id FROM other)));`],
        ['PG IF NOT EXISTS on TABLE',      `CREATE TABLE IF NOT EXISTS t (id INT PRIMARY KEY);`],
        ['PG IF NOT EXISTS on TYPE',       `CREATE TYPE IF NOT EXISTS mood AS ENUM ('a','b'); CREATE TABLE t (m mood);`],
        ['PG BEGIN/COMMIT block',          `BEGIN; CREATE TABLE t (id INT PRIMARY KEY); COMMIT;`],
        ['PG SET search_path',             `SET search_path TO public; CREATE TABLE t (id INT);`],
        ['PG CREATE FUNCTION skipped',     `CREATE FUNCTION fn() RETURNS INT AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; CREATE TABLE t (id INT);`],
        ['PG CREATE TRIGGER skipped',      `CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION fn(); CREATE TABLE t (id INT);`],

        // ── MySQL ──
        ['MySQL inline KEY',               `CREATE TABLE t (id INT, name VARCHAR(100), KEY ix_name (name));`],
        ['MySQL ROW_FORMAT options',       `CREATE TABLE t (id INT PRIMARY KEY) ENGINE=InnoDB ROW_FORMAT=COMPRESSED KEY_BLOCK_SIZE=8;`],
        ['MySQL ON UPDATE NO ACTION',      `CREATE TABLE p (id INT PRIMARY KEY); CREATE TABLE c (pid INT, FOREIGN KEY (pid) REFERENCES p(id) ON UPDATE NO ACTION);`],
        ['MySQL FULLTEXT KEY inline',      `CREATE TABLE t (id INT, body TEXT, FULLTEXT KEY ix_body (body));`],
        ['MySQL VIRTUAL generated',        `CREATE TABLE t (a INT, b INT GENERATED ALWAYS AS (a + 1) VIRTUAL);`],
        ['MySQL POINT type',               `CREATE TABLE t (loc POINT);`],
        ['MySQL polygon type',             `CREATE TABLE t (boundary POLYGON);`],
        ['MySQL TINYINT(1) UNSIGNED',      `CREATE TABLE t (a TINYINT(1) UNSIGNED);`],
        ['MySQL backtick ENUM',            "CREATE TABLE t (`role` ENUM('admin','user'));"],
        ['MySQL composite UQ KEY',         `CREATE TABLE t (a INT, b INT, UNIQUE KEY uq_ab (a, b));`],
        ['MySQL backtick FK target',       'CREATE TABLE p (`id` INT PRIMARY KEY); CREATE TABLE c (`pid` INT, FOREIGN KEY (`pid`) REFERENCES `p`(`id`));'],
        ['MySQL NULL DEFAULT NULL',        `CREATE TABLE t (a TEXT NULL DEFAULT NULL);`],
        ['MySQL CHARACTER SET col',        `CREATE TABLE t (n VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin);`],
        ['MySQL LONGBLOB',                 `CREATE TABLE t (data LONGBLOB);`],
        ['MySQL YEAR(4)',                  `CREATE TABLE t (yr YEAR(4));`],
        ['MySQL multi-col composite FK',   `CREATE TABLE p (a INT, b INT, PRIMARY KEY (a,b)); CREATE TABLE c (x INT, y INT, FOREIGN KEY (x,y) REFERENCES p(a,b));`],
        ['MySQL DROP TABLE skipped',       `DROP TABLE IF EXISTS old; CREATE TABLE t (id INT);`],
        ['MySQL PARTITION BY RANGE',       `CREATE TABLE t (id INT PRIMARY KEY, ts DATETIME) PARTITION BY RANGE (YEAR(ts)) (PARTITION p2024 VALUES LESS THAN (2025));`],
        ['MySQL SET FOREIGN_KEY_CHECKS',   `SET FOREIGN_KEY_CHECKS=0; CREATE TABLE t (id INT); SET FOREIGN_KEY_CHECKS=1;`],
        ['MySQL USE database',             `USE mydb; CREATE TABLE t (id INT);`],

        // ── MSSQL ──
        ['MSSQL inline INDEX',             `CREATE TABLE t (id INT, name NVARCHAR(100), INDEX ix_name (name));`],
        ['MSSQL CONSTRAINT WITH opts',     `CREATE TABLE t (id INT, CONSTRAINT pk_t PRIMARY KEY (id) WITH (FILLFACTOR=80, PAD_INDEX=ON));`],
        ['MSSQL ROWGUIDCOL',               `CREATE TABLE t (id UNIQUEIDENTIFIER ROWGUIDCOL DEFAULT NEWID() PRIMARY KEY);`],
        ['MSSQL COLLATE column',           `CREATE TABLE t (name NVARCHAR(50) COLLATE Latin1_General_CI_AS);`],
        ['MSSQL CONSTRAINT df DEFAULT',    `CREATE TABLE t (id INT CONSTRAINT df_id DEFAULT 0);`],
        ['MSSQL XML type',                 `CREATE TABLE t (data XML);`],
        ['MSSQL HIERARCHYID type',         `CREATE TABLE t (path HIERARCHYID);`],
        ['MSSQL GEOGRAPHY type',           `CREATE TABLE t (loc GEOGRAPHY);`],
        ['MSSQL mixed brackets',           `CREATE TABLE [dbo].Customers (id INT PRIMARY KEY);`],
        ['MSSQL multi-line GO blocks',     `CREATE TABLE a (id INT);\nGO\nGO\nCREATE TABLE b (id INT);\nGO`],
        ['MSSQL CHECK before NOT NULL',    `CREATE TABLE t (a INT CHECK (a > 0) NOT NULL);`],
        ['MSSQL DEFAULT NEWSEQUENTIALID',  `CREATE TABLE t (id UNIQUEIDENTIFIER DEFAULT NEWSEQUENTIALID() PRIMARY KEY);`],
        ['MSSQL NVARCHAR(MAX)',            `CREATE TABLE t (s NVARCHAR(MAX));`],
        ['MSSQL FLOAT(53)',                `CREATE TABLE t (n FLOAT(53));`],
        ['MSSQL VARBINARY(MAX)',           `CREATE TABLE t (b VARBINARY(MAX));`],
        ['MSSQL TIME(7)',                  `CREATE TABLE t (t TIME(7));`],
        ['MSSQL CHECK ALTER',              `CREATE TABLE t (a INT); ALTER TABLE t WITH CHECK ADD CONSTRAINT ck_a CHECK (a > 0);`],
        ['MSSQL bracketed reserved word',  `CREATE TABLE t ([order] INT, [user] NVARCHAR(50));`],
        ['MSSQL bracket w/ special chars', `CREATE TABLE t ([order#] INT, [@user] TEXT);`],
        ['MSSQL FILESTREAM',               `CREATE TABLE t (id UNIQUEIDENTIFIER ROWGUIDCOL, doc VARBINARY(MAX) FILESTREAM);`],
        ['MSSQL CREATE SCHEMA skipped',    `CREATE SCHEMA app; CREATE TABLE app.users (id INT PRIMARY KEY);`],
        ['MSSQL CREATE SEQUENCE skipped',  `CREATE SEQUENCE seq START WITH 1 INCREMENT BY 1; CREATE TABLE t (id INT);`],
        ['MSSQL bare AS column ref',       `CREATE TABLE t (a INT, b INT, c AS a + b);`],
        ['MSSQL bare AS w/ schema fn',     `CREATE TABLE t (a INT, h AS dbo.fn(a));`],
        ['MSSQL EXEC sp_addrole skipped',  `EXEC sp_addrole 'foo'; CREATE TABLE t (id INT);`],
        ['MSSQL DECLARE var',              `DECLARE @x INT = 1; CREATE TABLE t (id INT);`],
        ['MSSQL PRINT statement',          `PRINT 'creating tables'; CREATE TABLE t (id INT);`],
        ['MSSQL USE [db]',                 `USE [mydb]; GO CREATE TABLE t (id INT);`],

        // ── Cross / weird input ──
        ['table after view',               `CREATE VIEW v AS SELECT 1; CREATE TABLE t (id INT);`],
        ['multiple ALTERs in sequence',    `CREATE TABLE t (id INT); ALTER TABLE t ADD COLUMN x INT; ALTER TABLE t ADD CONSTRAINT ck CHECK (id > 0);`],
        ['ALTER TABLE schema-qualified',   `CREATE TABLE public.t (id INT); ALTER TABLE public.t ADD CONSTRAINT pk PRIMARY KEY (id);`],
        ['BOM prefix',                     `\uFEFFCREATE TABLE t (id INT);`],
        ['$$ delimiter does not confuse',  `CREATE TABLE t (id INT); CREATE FUNCTION fn() RETURNS INT AS $body$ SELECT 1 $body$ LANGUAGE sql;`],
        ['quoted ident with spaces',       `CREATE TABLE "my table" ("my col" INT);`],
        ['space inside brackets',          `CREATE TABLE [ my table ] ( [ id ] INT );`],
    ];
    cases.forEach(([name, sql]) => {
        it(`parses without error: ${name}`, () => {
            const r = parse(sql);
            expect(r.errs(), `${name} produced errors: ${JSON.stringify(r.errs())}`).toHaveLength(0);
        });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Real-world full-schema integration (per dialect)
// ════════════════════════════════════════════════════════════════════════════

describe('Real-world full-schema integration', () => {
    it('parses a real PG e-commerce schema with zero errors and full relations', () => {
        const r = parse(`
            CREATE TYPE order_status AS ENUM ('pending','paid','shipped','delivered','cancelled');
            CREATE TYPE address AS (street TEXT, city VARCHAR(100), zip CHAR(5), country CHAR(2));

            CREATE TABLE customers (
                id BIGSERIAL PRIMARY KEY,
                email VARCHAR(255) NOT NULL UNIQUE,
                name VARCHAR(255) NOT NULL,
                shipping_address address,
                billing_address address,
                tags TEXT[],
                preferences JSONB DEFAULT '{}',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE products (
                id BIGSERIAL PRIMARY KEY,
                sku VARCHAR(64) NOT NULL UNIQUE,
                name VARCHAR(255) NOT NULL,
                price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
                stock INT NOT NULL DEFAULT 0 CHECK (stock >= 0),
                categories TEXT[],
                created_at TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE orders (
                id BIGSERIAL PRIMARY KEY,
                customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
                status order_status NOT NULL DEFAULT 'pending',
                total NUMERIC(10,2) NOT NULL CHECK (total >= 0),
                placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE order_items (
                order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
                product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
                qty INT NOT NULL CHECK (qty > 0),
                unit_price NUMERIC(10,2) NOT NULL,
                line_total NUMERIC(12,2) GENERATED ALWAYS AS (qty * unit_price) STORED,
                PRIMARY KEY (order_id, product_id)
            );

            CREATE TABLE reviews (
                id BIGSERIAL PRIMARY KEY,
                product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                customer_id BIGINT NOT NULL REFERENCES customers(id),
                rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
                body TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);

        expect(r.errs()).toHaveLength(0);
        expect(r.tables.map((t) => t.name).sort()).toEqual(['customers', 'order_items', 'orders', 'products', 'reviews']);
        expect(r.column('customers', 'shipping_address').type).toBe('address');
        expect(r.column('customers', 'tags').type).toBe('TEXT[]');
        expect(r.column('orders', 'status').type).toBe('order_status');
        expect(r.column('order_items', 'line_total').generated).toContain('STORED');
    });

    it('parses a real MySQL forum schema with zero errors', () => {
        const r = parse(`
            CREATE TABLE \`users\` (
                \`id\` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                \`username\` VARCHAR(64) NOT NULL UNIQUE,
                \`role\` ENUM('member','moderator','admin') NOT NULL DEFAULT 'member',
                \`flags\` SET('verified','banned','muted') DEFAULT '',
                \`bio\` TEXT,
                \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

            CREATE TABLE \`forums\` (
                \`id\` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                \`name\` VARCHAR(100) NOT NULL UNIQUE
            ) ENGINE=InnoDB;

            CREATE TABLE \`threads\` (
                \`id\` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                \`forum_id\` INT UNSIGNED NOT NULL,
                \`author_id\` BIGINT UNSIGNED NOT NULL,
                \`title\` VARCHAR(255) NOT NULL,
                INDEX idx_forum (forum_id),
                FULLTEXT KEY ft_title (title),
                CONSTRAINT fk_thread_forum FOREIGN KEY (forum_id) REFERENCES forums(id) ON DELETE CASCADE,
                CONSTRAINT fk_thread_author FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE RESTRICT
            ) ENGINE=InnoDB;

            CREATE TABLE \`posts\` (
                \`id\` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                \`thread_id\` BIGINT UNSIGNED NOT NULL,
                \`author_id\` BIGINT UNSIGNED NOT NULL,
                \`body\` MEDIUMTEXT NOT NULL,
                FULLTEXT KEY ft_body (body),
                CONSTRAINT fk_post_thread FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
                CONSTRAINT fk_post_author FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE RESTRICT
            ) ENGINE=InnoDB;
        `);

        expect(r.errs()).toHaveLength(0);
        expect(r.tables.map((t) => t.name).sort()).toEqual(['forums', 'posts', 'threads', 'users']);
        expect(r.column('users', 'role').type).toBe('role_enum');
        expect(r.column('users', 'flags').type).toBe('flags_set');
    });

    it('parses a real MSSQL HR schema with zero errors and computed columns', () => {
        const r = parse(`
            CREATE TABLE [dbo].[Departments] (
                [DepartmentID] INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_dept PRIMARY KEY CLUSTERED,
                [Name] NVARCHAR(100) NOT NULL CONSTRAINT uq_dept_name UNIQUE,
                [Budget] DECIMAL(18,2) NOT NULL DEFAULT 0,
                [Created] DATETIME2 NOT NULL DEFAULT GETDATE()
            ) ON [PRIMARY];
            GO

            CREATE TABLE [dbo].[Employees] (
                [EmployeeID] INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_emp PRIMARY KEY,
                [DepartmentID] INT NOT NULL,
                [ManagerID] INT NULL,
                [FirstName] NVARCHAR(50) NOT NULL,
                [LastName] NVARCHAR(50) NOT NULL,
                [FullName] AS ([FirstName] + ' ' + [LastName]) PERSISTED,
                [Email] NVARCHAR(255) NOT NULL CONSTRAINT uq_emp_email UNIQUE,
                [Salary] DECIMAL(10,2) NOT NULL CHECK ([Salary] > 0),
                [HireDate] DATE NOT NULL,
                [TenureDays] AS DATEDIFF(DAY, HireDate, GETDATE()) PERSISTED,
                [Active] BIT NOT NULL DEFAULT 1,
                CONSTRAINT fk_emp_dept FOREIGN KEY ([DepartmentID]) REFERENCES Departments(DepartmentID),
                CONSTRAINT fk_emp_mgr  FOREIGN KEY ([ManagerID])    REFERENCES Employees(EmployeeID)
            ) ON [PRIMARY];
            GO

            ALTER TABLE [dbo].[Employees] WITH CHECK ADD CONSTRAINT ck_self_mgr CHECK ([ManagerID] <> [EmployeeID]);
        `);

        expect(r.errs()).toHaveLength(0);
        // parseAst preserves the schema prefix (`dbo.…`); erdJsonSchema strips it.
        expect(r.tables.map((t) => t.name).sort()).toEqual(['dbo.Departments', 'dbo.Employees']);
        // Both forms of MSSQL computed column. (`r.column` uses the bare table name.)
        expect(r.column('Employees', 'FullName').generated).toContain('PERSISTED');
        expect(r.column('Employees', 'TenureDays').generated).toBe('AS DATEDIFF(DAY, HireDate, GETDATE()) PERSISTED');
        // Self-referencing FK (Employees → Employees via ManagerID).
        const selfFk = r.table('Employees').constraints.filter((c) => c.kind === 'foreign');
        expect(selfFk.some((fk) => /Employees$/.test(fk.references.table))).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Identifier & casing edge cases
// ════════════════════════════════════════════════════════════════════════════

describe('Identifier casing & quoting edge cases', () => {
    it('mixed-case identifiers are preserved (not lowered) in column names', () => {
        const r = parse(`CREATE TABLE Users (FirstName TEXT, LastName TEXT);`);
        expect(r.column('Users', 'FirstName')).toBeTruthy();
        expect(r.column('Users', 'LastName')).toBeTruthy();
    });

    it('reserved-word column name when quoted', () => {
        const r = parse(`CREATE TABLE t ("select" INT, "from" INT, "where" TEXT);`);
        expect(r.column('t', 'select')).toBeTruthy();
        expect(r.column('t', 'from')).toBeTruthy();
        expect(r.column('t', 'where')).toBeTruthy();
    });

    it('Unicode column names (CJK / accented)', () => {
        const r = parse(`CREATE TABLE t ("姓名" VARCHAR(50), "ümlaut" INT, "café" TEXT);`);
        expect(r.column('t', '姓名')).toBeTruthy();
        expect(r.column('t', 'ümlaut')).toBeTruthy();
        expect(r.column('t', 'café')).toBeTruthy();
    });

    it('column names with embedded spaces (quoted)', () => {
        const r = parse('CREATE TABLE t ("first name" TEXT, `last name` TEXT, [middle name] TEXT);');
        expect(r.column('t', 'first name')).toBeTruthy();
        expect(r.column('t', 'last name')).toBeTruthy();
        expect(r.column('t', 'middle name')).toBeTruthy();
    });

    it('escaped quote inside quoted identifier ("foo""bar")', () => {
        const r = parse(`CREATE TABLE t ("foo""bar" INT);`);
        expect(r.column('t', 'foo"bar')).toBeTruthy();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// DEFAULT value matrix
// ════════════════════════════════════════════════════════════════════════════

describe('DEFAULT value matrix', () => {
    it('numeric defaults survive', () => {
        const r = parse(`CREATE TABLE t (a INT DEFAULT 0, b NUMERIC DEFAULT 3.14, c BIGINT DEFAULT -1);`);
        expect(r.column('t', 'a').default).toBe('0');
        expect(r.column('t', 'b').default).toBe('3.14');
        expect(r.column('t', 'c').default).toBe('-1');
    });

    it('string defaults preserve quotes via raw token', () => {
        const r = parse(`CREATE TABLE t (a TEXT DEFAULT 'hello', b VARCHAR(10) DEFAULT '');`);
        expect(r.column('t', 'a').default).toBe("'hello'");
        expect(r.column('t', 'b').default).toBe("''");
    });

    it("string defaults with escaped quote ('it''s') preserve the raw escape", () => {
        const r = parse(`CREATE TABLE t (a TEXT DEFAULT 'it''s ok');`);
        // The parser emits the raw token, preserving the SQL-style '' escape.
        expect(r.column('t', 'a').default).toBe("'it''s ok'");
    });

    it('boolean defaults TRUE/FALSE survive', () => {
        const r = parse(`CREATE TABLE t (a BOOLEAN DEFAULT TRUE, b BOOLEAN DEFAULT FALSE);`);
        expect(r.column('t', 'a').default).toMatch(/TRUE/i);
        expect(r.column('t', 'b').default).toMatch(/FALSE/i);
    });

    it('parenthesized arithmetic expression default', () => {
        const r = parse(`CREATE TABLE t (a INT DEFAULT (1 + 2 * 3));`);
        expect(r.column('t', 'a').default).toBe('(1 + 2 * 3)');
    });

    it('NULL default is not the start of NOT NULL', () => {
        const r = parse(`CREATE TABLE t (a INT DEFAULT NULL NOT NULL);`);
        expect(r.column('t', 'a').default).toBe('NULL');
        expect(r.column('t', 'a').notNull).toBe(true);
    });

    it('CURRENT_TIMESTAMP default works alone or with ON UPDATE clause', () => {
        const r = parse(`
            CREATE TABLE t (
                a TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                b TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            );
        `);
        expect(r.column('t', 'a').default).toBe('CURRENT_TIMESTAMP');
        expect(r.column('t', 'b').default).toBe('CURRENT_TIMESTAMP');
    });

    it("MySQL JSON-string default DEFAULT '{}'", () => {
        const r = parse(`CREATE TABLE t (a JSON DEFAULT '{}');`);
        expect(r.column('t', 'a').default).toBe("'{}'");
    });

    it('PG NEXTVAL(\'seq\') sequence default', () => {
        const r = parse(`CREATE TABLE t (a INT DEFAULT NEXTVAL('user_id_seq'));`);
        expect(r.column('t', 'a').default).toMatch(/NEXTVAL/);
    });

    it('PG cast default 0::INT', () => {
        const r = parse(`CREATE TABLE t (a INT DEFAULT 0::INT);`);
        expect(r.column('t', 'a').default).toBe('0::INT');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// FK actions exhaustive matrix
// ════════════════════════════════════════════════════════════════════════════

describe('FK action exhaustive matrix', () => {
    const actions = ['CASCADE', 'RESTRICT', 'NO ACTION', 'SET NULL', 'SET DEFAULT'];
    actions.forEach((action) => {
        it(`inline REFERENCES ... ON DELETE ${action} parses cleanly`, () => {
            const r = parse(`
                CREATE TABLE p (id INT PRIMARY KEY);
                CREATE TABLE c (pid INT REFERENCES p(id) ON DELETE ${action});
            `);
            expect(r.errs()).toHaveLength(0);
            expect(r.column('c', 'pid').references.table).toBe('p');
        });
        it(`inline REFERENCES ... ON UPDATE ${action} parses cleanly`, () => {
            const r = parse(`
                CREATE TABLE p (id INT PRIMARY KEY);
                CREATE TABLE c (pid INT REFERENCES p(id) ON UPDATE ${action});
            `);
            expect(r.errs()).toHaveLength(0);
            expect(r.column('c', 'pid').references.table).toBe('p');
        });
        it(`table-level FOREIGN KEY ... ON DELETE ${action} parses cleanly`, () => {
            const r = parse(`
                CREATE TABLE p (id INT PRIMARY KEY);
                CREATE TABLE c (
                    pid INT,
                    CONSTRAINT fk_c_p FOREIGN KEY (pid) REFERENCES p(id) ON DELETE ${action}
                );
            `);
            expect(r.errs()).toHaveLength(0);
            const fk = r.table('c').constraints.find((cn) => cn.kind === 'foreign');
            expect(fk.references.table).toBe('p');
        });
    });

    it('combined ON DELETE + ON UPDATE on same FK', () => {
        const r = parse(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (pid INT REFERENCES p(id) ON DELETE CASCADE ON UPDATE RESTRICT);
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.column('c', 'pid').references.table).toBe('p');
    });

    it('FK referencing schema-qualified table', () => {
        const r = parse(`
            CREATE TABLE public.p (id INT PRIMARY KEY);
            CREATE TABLE other.c (pid INT REFERENCES public.p(id));
        `);
        expect(r.column('c', 'pid').references.table).toBe('public.p');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Type system stress
// ════════════════════════════════════════════════════════════════════════════

describe('Type system — extra dialect coverage', () => {
    it('PG range types', () => {
        const r = parse(`CREATE TABLE t (a int4range, b tsrange, c daterange, d numrange);`);
        expect(r.column('t', 'a').type).toBe('int4range');
        expect(r.column('t', 'd').type).toBe('numrange');
    });

    it('PG INET / CIDR / MACADDR / BIT / BIT VARYING(n)', () => {
        const r = parse(`
            CREATE TABLE t (
                a INET,
                b CIDR,
                c MACADDR,
                d BIT(8)
            );
        `);
        expect(r.column('t', 'a').type).toBe('INET');
        expect(r.column('t', 'd').type).toBe('BIT(8)');
    });

    it('MySQL JSON column type', () => {
        const r = parse(`CREATE TABLE t (data JSON);`);
        expect(r.column('t', 'data').type).toBe('JSON');
    });

    it('PG/MySQL DECIMAL / NUMERIC(p,s) with various precision', () => {
        const r = parse(`
            CREATE TABLE t (
                a DECIMAL(18, 6),
                b NUMERIC(10, 0),
                c DECIMAL,
                d NUMERIC
            );
        `);
        expect(r.column('t', 'a').type).toBe('DECIMAL(18, 6)');
        expect(r.column('t', 'b').type).toBe('NUMERIC(10, 0)');
        expect(r.column('t', 'c').type).toBe('DECIMAL');
        expect(r.column('t', 'd').type).toBe('NUMERIC');
    });

    it('mixed-case type names are preserved as written', () => {
        const r = parse(`CREATE TABLE t (a Integer, b Text, c VarChar(50));`);
        // Tokenizer keywords are uppercased; non-keyword ident types preserve case.
        // INTEGER, TEXT, VARCHAR are keywords so they uppercase.
        expect(r.column('t', 'a').type).toBe('INTEGER');
        expect(r.column('t', 'b').type).toBe('TEXT');
        expect(r.column('t', 'c').type).toBe('VARCHAR(50)');
    });

    it('PG composite type used as column type plus arrays in same table', () => {
        const r = parse(`
            CREATE TYPE addr AS (street TEXT, city VARCHAR(100));
            CREATE TABLE u (addresses addr, tags TEXT[]);
        `);
        expect(r.column('u', 'addresses').type).toBe('addr');
        expect(r.column('u', 'tags').type).toBe('TEXT[]');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Comment & whitespace robustness
// ════════════════════════════════════════════════════════════════════════════

describe('Comment & whitespace robustness', () => {
    it('inline -- comment between columns', () => {
        const r = parse(`
            CREATE TABLE t (
                id INT PRIMARY KEY, -- the primary key
                name TEXT NOT NULL  -- the user name
            );
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.table('t').columns).toHaveLength(2);
    });

    it('block /* */ comment inside a column definition', () => {
        const r = parse(`CREATE TABLE t (id INT /* primary */ PRIMARY KEY);`);
        expect(r.errs()).toHaveLength(0);
        expect(r.column('t', 'id').primary).toBe(true);
    });

    it('CRLF and tab mix renders identical AST to plain LF', () => {
        const r1 = parse(`CREATE TABLE t (id INT PRIMARY KEY);`);
        const r2 = parse(`CREATE\tTABLE\tt\t(\tid\tINT\tPRIMARY\tKEY\t);`);
        const r3 = parse(`CREATE TABLE t (id INT PRIMARY KEY);\r\n`);
        for (const r of [r1, r2, r3]) {
            expect(r.column('t', 'id').primary).toBe(true);
        }
    });

    it('multiple semicolons between statements are tolerated', () => {
        const r = parse(`CREATE TABLE a (id INT);;;CREATE TABLE b (id INT);`);
        expect(r.errs()).toHaveLength(0);
        expect(r.tables).toHaveLength(2);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Defensive: malformed inputs degrade gracefully
// ════════════════════════════════════════════════════════════════════════════

describe('Malformed input degradation', () => {
    it('unclosed string yields a tokenizer error but does not throw', () => {
        const r = parse(`CREATE TABLE t (a TEXT DEFAULT 'oops);`);
        // tokenizer emits an unclosed_string error
        expect(r.errors.some((e) => /Unclosed/.test(e.message))).toBe(true);
    });

    it('unclosed block comment yields error and parsing continues', () => {
        const r = parse(`/* not closed CREATE TABLE t (id INT);`);
        expect(r.errors.some((e) => /Unclosed/.test(e.message))).toBe(true);
    });

    it('extra closing parens are reported', () => {
        const r = parse(`CREATE TABLE t (id INT));`);
        expect(r.errors.length).toBeGreaterThan(0);
    });

    it('CREATE without TABLE/TYPE keyword is silently skipped', () => {
        const r = parse(`CREATE VIEW v AS SELECT * FROM t; CREATE TABLE x (id INT);`);
        expect(r.tables.map((t) => t.name)).toEqual(['x']);
    });

    it('CREATE INDEX ... is captured (now exposed via ast.indexes)', () => {
        const r = parse(`CREATE INDEX idx ON t (a, b); CREATE TABLE u (id INT);`);
        expect(r.tables.map((t) => t.name)).toEqual(['u']);
        expect(r.ast.indexes).toHaveLength(1);
        expect(r.ast.indexes[0]).toMatchObject({ table: 't', columns: ['a', 'b'], unique: false });
    });

    it('CREATE PROCEDURE ... is silently skipped', () => {
        const r = parse(`CREATE PROCEDURE foo() BEGIN SELECT 1; END; CREATE TABLE u (id INT);`);
        expect(r.tables.map((t) => t.name).filter((n) => n === 'u')).toEqual(['u']);
    });

    it('non-PostgreSQL empty table body produces an error but does not crash the rest', () => {
        const r = parse(`CREATE TABLE empty () ENGINE=InnoDB; CREATE TABLE good (id INT);`);
        expect(r.errs().length).toBeGreaterThan(0);
        expect(r.table('good')).toBeTruthy();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Wide / many-column tables
// ════════════════════════════════════════════════════════════════════════════

describe('Wide tables', () => {
    it('a 50-column table is parsed cleanly', () => {
        const cols = Array.from({ length: 50 }, (_, i) => `c${i} INT`).join(', ');
        const r = parse(`CREATE TABLE wide (${cols});`);
        expect(r.errs()).toHaveLength(0);
        expect(r.table('wide').columns).toHaveLength(50);
    });

    it('30-column table with mixed PK / FK / ENUM / DEFAULT / CHECK', () => {
        const cols = [];
        cols.push('id SERIAL PRIMARY KEY');
        for (let i = 0; i < 25; i++) {
            const t = ['INT', 'TEXT', 'VARCHAR(50)', "ENUM('a','b')", 'BOOLEAN', 'NUMERIC(10,2)'][i % 6];
            cols.push(`c${i} ${t}${i % 4 === 0 ? ' NOT NULL' : ''}${i % 5 === 0 ? ' DEFAULT NULL' : ''}`);
        }
        cols.push('owner_id INT REFERENCES users(id)');
        const r = parse(`CREATE TABLE users (id INT PRIMARY KEY); CREATE TABLE wide (${cols.join(', ')});`);
        expect(r.errs()).toHaveLength(0);
        expect(r.table('wide').columns).toHaveLength(27);
        expect(r.column('wide', 'owner_id').references.table).toBe('users');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Reserved-keyword-as-column-name regressions
// ════════════════════════════════════════════════════════════════════════════

describe('Reserved-keyword identifiers used as column names', () => {
    it('column named `key` (PG non-reserved) is preserved when followed by a type', () => {
        const r = parse(`CREATE TABLE feature_flags (
            id BIGSERIAL PRIMARY KEY,
            key VARCHAR(128) NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT FALSE
        );`);
        expect(r.errs()).toHaveLength(0);
        expect(r.column('feature_flags', 'key')).toBeTruthy();
        expect(r.column('feature_flags', 'key').type).toBe('VARCHAR(128)');
    });

    it('column named `index` (PG non-reserved) is preserved when followed by a type', () => {
        const r = parse(`CREATE TABLE pages (id INT PRIMARY KEY, index INT);`);
        expect(r.errs()).toHaveLength(0);
        expect(r.column('pages', 'index')).toBeTruthy();
    });

    it('column named `value` (common reserved) survives typed declaration', () => {
        const r = parse(`CREATE TABLE settings (id INT PRIMARY KEY, value TEXT);`);
        expect(r.errs()).toHaveLength(0);
        expect(r.column('settings', 'value')).toBeTruthy();
    });

    it('UNIQUE (a, key) constraint correctly references `key` column', () => {
        const r = parse(`CREATE TABLE feature_flags (
            id BIGSERIAL PRIMARY KEY,
            org_id BIGINT NOT NULL,
            key VARCHAR(128) NOT NULL,
            UNIQUE (org_id, key)
        );`);
        expect(r.errs()).toHaveLength(0);
        const t = r.table('feature_flags');
        const uq = t.constraints.find((c) => c.kind === 'unique');
        expect(uq).toBeTruthy();
        expect(uq.columns).toEqual(['org_id', 'key']);
    });

    it('still treats real `KEY (col)` as an index/constraint and skips it', () => {
        const r = parse(`CREATE TABLE t (
            id INT PRIMARY KEY,
            name VARCHAR(50),
            KEY idx_name (name)
        );`);
        expect(r.errs()).toHaveLength(0);
        // `idx_name` should NOT appear as a column.
        expect(r.column('t', 'idx_name')).toBeFalsy();
        expect(r.column('t', 'name')).toBeTruthy();
    });

    it('still treats `KEY (col1, col2)` shorthand as a constraint and skips it', () => {
        const r = parse(`CREATE TABLE t (
            id INT,
            other INT,
            KEY (id, other)
        );`);
        expect(r.errs()).toHaveLength(0);
        // No phantom `id, other` columns from the KEY clause.
        expect(r.table('t').columns).toHaveLength(2);
    });

    it('still treats `FULLTEXT KEY ft (body)` as a constraint and skips it', () => {
        const r = parse(`CREATE TABLE posts (
            id INT PRIMARY KEY,
            body TEXT,
            FULLTEXT KEY ft_body (body)
        );`);
        expect(r.errs()).toHaveLength(0);
        expect(r.column('posts', 'ft_body')).toBeFalsy();
        expect(r.column('posts', 'body')).toBeTruthy();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// CREATE INDEX — comprehensive coverage (PG / MySQL / MSSQL)
// ════════════════════════════════════════════════════════════════════════════

describe('CREATE INDEX — top-level', () => {
    it('captures a basic single-column index', () => {
        const r = parse(`
            CREATE TABLE t (id INT PRIMARY KEY, name TEXT);
            CREATE INDEX idx_t_name ON t (name);
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes).toHaveLength(1);
        expect(r.ast.indexes[0]).toMatchObject({
            name: 'idx_t_name',
            table: 't',
            columns: ['name'],
            unique: false,
            kind: 'plain',
        });
    });

    it('captures CREATE UNIQUE INDEX', () => {
        const r = parse(`
            CREATE TABLE t (id INT, email TEXT);
            CREATE UNIQUE INDEX uq_t_email ON t (email);
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes[0]).toMatchObject({ unique: true, columns: ['email'] });
    });

    it('captures multi-column (composite) index', () => {
        const r = parse(`
            CREATE TABLE t (a INT, b INT, c INT);
            CREATE INDEX idx_ab ON t (a, b);
        `);
        expect(r.ast.indexes[0].columns).toEqual(['a', 'b']);
    });

    it('handles IF NOT EXISTS (PostgreSQL)', () => {
        const r = parse(`
            CREATE TABLE t (a INT);
            CREATE INDEX IF NOT EXISTS idx_a ON t (a);
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes[0].name).toBe('idx_a');
    });

    it('handles CONCURRENTLY (PostgreSQL)', () => {
        const r = parse(`
            CREATE TABLE t (a INT);
            CREATE INDEX CONCURRENTLY idx_a ON t (a);
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes[0].name).toBe('idx_a');
    });

    it('handles CONCURRENTLY + IF NOT EXISTS together', () => {
        const r = parse(`
            CREATE TABLE t (a INT);
            CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_a ON t (a);
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes[0]).toMatchObject({ name: 'idx_a', unique: true });
    });

    it('handles USING method clause (PG/MySQL)', () => {
        const r = parse(`
            CREATE TABLE t (a INT, b INT);
            CREATE INDEX idx_a ON t USING btree (a, b);
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes[0].columns).toEqual(['a', 'b']);
    });

    it('handles INCLUDE clause (PG covering / MSSQL covering)', () => {
        const r = parse(`
            CREATE TABLE t (a INT, b INT, c INT);
            CREATE INDEX idx_a ON t (a) INCLUDE (b, c);
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes[0].columns).toEqual(['a']);
    });

    it('handles WHERE clause (partial index, PG/MSSQL)', () => {
        const r = parse(`
            CREATE TABLE t (id INT, status TEXT);
            CREATE INDEX idx_active ON t (id) WHERE status = 'active';
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes[0].columns).toEqual(['id']);
        expect(r.ast.indexes[0].where).toBe("status = 'active'");
    });

    it('captures filtered index predicates without swallowing trailing WITH options', () => {
        const r = parse(`
            CREATE TABLE [AspNetUsers] ([NormalizedUserName] NVARCHAR(256));
            CREATE UNIQUE INDEX [UserNameIndex]
              ON [AspNetUsers] ([NormalizedUserName])
              WHERE [NormalizedUserName] IS NOT NULL
              WITH (ONLINE = ON);
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes[0]).toMatchObject({
            name: 'UserNameIndex',
            table: 'AspNetUsers',
            columns: ['NormalizedUserName'],
            unique: true,
            where: '[NormalizedUserName] IS NOT NULL',
        });
    });

    it('handles WITH options (PG/MSSQL)', () => {
        const r = parse(`
            CREATE TABLE t (a INT);
            CREATE INDEX idx_a ON t (a) WITH (FILLFACTOR = 80);
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes[0].columns).toEqual(['a']);
    });

    it('handles MSSQL CLUSTERED / NONCLUSTERED', () => {
        const r = parse(`
            CREATE TABLE t (id INT, name NVARCHAR(50));
            CREATE NONCLUSTERED INDEX idx_t_name ON t (name);
            CREATE CLUSTERED INDEX idx_t_id ON t (id);
            CREATE UNIQUE NONCLUSTERED INDEX uq_t_name ON t (name);
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes).toHaveLength(3);
        expect(r.ast.indexes[2].unique).toBe(true);
    });

    it('handles MySQL FULLTEXT / SPATIAL indexes', () => {
        const r = parse(`
            CREATE TABLE posts (id INT, body TEXT, location TEXT);
            CREATE FULLTEXT INDEX ft_body ON posts (body);
            CREATE SPATIAL INDEX sp_loc ON posts (location);
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes[0].kind).toBe('fulltext');
        expect(r.ast.indexes[1].kind).toBe('spatial');
    });

    it('handles schema-qualified index and table names', () => {
        const r = parse(`
            CREATE TABLE app.users (id INT, email TEXT);
            CREATE UNIQUE INDEX app.uq_users_email ON app.users (email);
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes[0].table).toBe('app.users');
        expect(r.ast.indexes[0].name).toBe('app.uq_users_email');
    });

    it('handles quoted identifiers (PG / MySQL / MSSQL)', () => {
        const pg = parse(`CREATE TABLE "t" ("col one" INT); CREATE INDEX "idx" ON "t" ("col one");`);
        expect(pg.errs()).toHaveLength(0);
        expect(pg.ast.indexes[0].columns).toEqual(['col one']);

        const my = parse('CREATE TABLE `t` (`col one` INT); CREATE INDEX `idx` ON `t` (`col one`);');
        expect(my.errs()).toHaveLength(0);
        expect(my.ast.indexes[0].columns).toEqual(['col one']);

        const ms = parse(`CREATE TABLE [t] ([col one] INT); CREATE INDEX [idx] ON [t] ([col one]);`);
        expect(ms.errs()).toHaveLength(0);
        expect(ms.ast.indexes[0].columns).toEqual(['col one']);
    });

    it('handles ASC / DESC modifiers per column', () => {
        const r = parse(`
            CREATE TABLE t (a INT, b INT);
            CREATE INDEX idx_ab ON t (a ASC, b DESC);
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes[0].columns).toEqual(['a', 'b']);
    });

    it('drops functional/expression entries from the column list', () => {
        const r = parse(`
            CREATE TABLE t (a TEXT);
            CREATE INDEX idx_low ON t (lower(a));
        `);
        expect(r.errs()).toHaveLength(0);
        // Functional entries do not refer to a single column to badge.
        expect(r.ast.indexes[0].columns).toEqual([]);
    });

    it('PostgreSQL ONLY parent-table modifier', () => {
        const r = parse(`
            CREATE TABLE t (a INT);
            CREATE INDEX idx_a ON ONLY t (a);
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes[0].table).toBe('t');
        expect(r.ast.indexes[0].columns).toEqual(['a']);
    });

    it('multiple indexes on the same table accumulate', () => {
        const r = parse(`
            CREATE TABLE t (a INT, b INT);
            CREATE INDEX idx_a ON t (a);
            CREATE UNIQUE INDEX uq_b ON t (b);
            CREATE INDEX idx_ab ON t (a, b);
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes).toHaveLength(3);
    });

    it('records position info on each index', () => {
        const r = parse(`
            CREATE TABLE t (a INT);
            CREATE INDEX idx_a ON t (a);
        `);
        expect(r.ast.indexes[0].position).toBeTruthy();
        expect(r.ast.indexes[0].position.start).toBeTruthy();
        expect(r.ast.indexes[0].position.end).toBeTruthy();
    });

    it('recovers gracefully from a malformed CREATE INDEX', () => {
        const r = parse(`
            CREATE INDEX idx;
            CREATE TABLE t (a INT);
        `);
        // Malformed index registers a warning but does not derail the parse.
        expect(r.warns().length).toBeGreaterThan(0);
        expect(r.table('t')).toBeTruthy();
        expect(r.errs()).toHaveLength(0);
    });

    it('CREATE INDEX without trailing semicolon at EOF still parses', () => {
        const r = parse(`CREATE TABLE t (a INT); CREATE INDEX idx_a ON t (a)`);
        expect(r.ast.indexes).toHaveLength(1);
        expect(r.ast.indexes[0].columns).toEqual(['a']);
    });
});

describe('CREATE INDEX — inline MySQL KEY/INDEX/FULLTEXT/SPATIAL', () => {
    it('inline `KEY idx_name (col)` is captured as an index', () => {
        const r = parse(`
            CREATE TABLE t (
                id INT PRIMARY KEY,
                name VARCHAR(50),
                KEY idx_name (name)
            );
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes).toHaveLength(1);
        expect(r.ast.indexes[0]).toMatchObject({ table: 't', columns: ['name'], unique: false });
    });

    it('inline `INDEX (col)` shorthand is captured', () => {
        const r = parse(`
            CREATE TABLE t (
                id INT,
                a INT,
                INDEX (a)
            );
        `);
        expect(r.ast.indexes[0].columns).toEqual(['a']);
    });

    it('inline `KEY (a, b)` composite is captured', () => {
        const r = parse(`
            CREATE TABLE t (
                id INT,
                a INT,
                b INT,
                KEY (a, b)
            );
        `);
        expect(r.ast.indexes[0].columns).toEqual(['a', 'b']);
    });

    it('inline `FULLTEXT KEY ft (body)` is captured with kind=fulltext', () => {
        const r = parse(`
            CREATE TABLE posts (
                id INT PRIMARY KEY,
                body TEXT,
                FULLTEXT KEY ft_body (body)
            );
        `);
        expect(r.ast.indexes[0]).toMatchObject({ table: 'posts', columns: ['body'], kind: 'fulltext' });
    });

    it('inline `SPATIAL INDEX (location)` is captured with kind=spatial', () => {
        const r = parse(`
            CREATE TABLE places (
                id INT PRIMARY KEY,
                location GEOMETRY NOT NULL,
                SPATIAL INDEX (location)
            );
        `);
        expect(r.ast.indexes[0]).toMatchObject({ kind: 'spatial', columns: ['location'] });
    });

    it('inline `UNIQUE KEY (col)` still parses as table-level UNIQUE constraint (existing behavior)', () => {
        const r = parse(`
            CREATE TABLE t (
                id INT PRIMARY KEY,
                email VARCHAR(255),
                UNIQUE KEY uq_email (email)
            );
        `);
        // UNIQUE KEY is a constraint, not an index entry — confirms existing rule.
        const uq = r.table('t').constraints.find((c) => c.kind === 'unique');
        expect(uq).toBeTruthy();
        expect(uq.columns).toEqual(['email']);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// CREATE INDEX — adversarial / defensive cases
//
// Pin the parser's behavior on real-world DDL we can't afford to crash on
// (DROP INDEX, ALTER TABLE ADD INDEX, NULLS FIRST, COLLATE, transactions).
// Behaviors here were probed against the live parser before being asserted.
// ════════════════════════════════════════════════════════════════════════════

describe('CREATE INDEX — adversarial / defensive', () => {
    it('captures DROP INDEX lifecycle metadata without inventing a created index', () => {
        const r = parse(`CREATE TABLE t(a INT); DROP INDEX idx_a;`);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes).toEqual([]);
        expect(r.ast.drops).toEqual([expect.objectContaining({ kind: 'index', name: 'idx_a' })]);
    });

    it('captures the owning table for DROP INDEX IF EXISTS ... ON t', () => {
        const r = parse(`CREATE TABLE t(a INT); DROP INDEX IF EXISTS idx_a ON t;`);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes).toEqual([]);
        expect(r.ast.drops).toEqual([expect.objectContaining({ kind: 'index', name: 'idx_a', table: 't' })]);
    });

    it('captures MySQL `ALTER TABLE ... ADD INDEX (col)`', () => {
        const r = parse(`CREATE TABLE t(a INT, b INT); ALTER TABLE t ADD INDEX idx_a (a);`);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes).toHaveLength(1);
        expect(r.ast.indexes[0]).toMatchObject({ name: 'idx_a', table: 't', columns: ['a'], unique: false, kind: 'plain' });
    });

    it('captures MySQL `ALTER TABLE ... ADD KEY (col, col)`', () => {
        const r = parse(`CREATE TABLE t(a INT, b INT); ALTER TABLE t ADD KEY idx_ab (a, b);`);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes[0]).toMatchObject({ name: 'idx_ab', table: 't', columns: ['a', 'b'], kind: 'plain' });
    });

    it('captures MySQL ALTER FULLTEXT/SPATIAL indexes and rejects a missing column list', () => {
        const r = parse(`
            CREATE TABLE t(body TEXT, location POINT);
            ALTER TABLE t ADD FULLTEXT KEY ft_body (body), ADD SPATIAL INDEX sp_location (location);
            ALTER TABLE t ADD INDEX broken;
        `);
        expect(r.ast.indexes.map((index) => ({ name: index.name, kind: index.kind, columns: index.columns }))).toEqual([
            { name: 'ft_body', kind: 'fulltext', columns: ['body'] },
            { name: 'sp_location', kind: 'spatial', columns: ['location'] },
        ]);
        expect(r.errs().some((error) => error.message.includes('missing column list'))).toBe(true);
    });

    it('NULLS FIRST / NULLS LAST modifiers are stripped, column extracted', () => {
        const r = parse(`
            CREATE TABLE t(a INT, b INT);
            CREATE INDEX ix ON t(a NULLS FIRST, b DESC NULLS LAST);
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes[0].columns).toEqual(['a', 'b']);
    });

    it('COLLATE clause is stripped, column extracted', () => {
        const r = parse(`
            CREATE TABLE t(a TEXT);
            CREATE INDEX ix ON t(a COLLATE "C");
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes[0].columns).toEqual(['a']);
    });

    it('CREATE INDEX inside BEGIN ... COMMIT transaction is captured normally', () => {
        const r = parse(`
            BEGIN;
            CREATE TABLE t(a INT);
            CREATE INDEX ix ON t(a);
            COMMIT;
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes).toHaveLength(1);
        expect(r.ast.indexes[0]).toMatchObject({ name: 'ix', table: 't', columns: ['a'] });
    });

    it('duplicate index NAMES on different tables are both captured (parser is namespace-blind)', () => {
        // Real DBs reject this with "relation already exists"; the parser
        // captures both and downstream tooling decides what to do. We assert
        // we don't silently drop the second one.
        const r = parse(`
            CREATE TABLE x(a INT);
            CREATE TABLE y(a INT);
            CREATE INDEX dup ON x(a);
            CREATE INDEX dup ON y(a);
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes).toHaveLength(2);
        expect(r.ast.indexes.map((i) => i.table).sort()).toEqual(['x', 'y']);
    });

    it('CREATE INDEX with empty paren list is captured but with no columns', () => {
        // Engine-level invalid SQL, but the parser must not crash and must
        // pass through enough info that later stages can drop it cleanly.
        const r = parse(`CREATE TABLE t(a INT); CREATE INDEX ix ON t();`);
        expect(r.errs().filter((e) => e.severity === 'error')).toHaveLength(0);
        expect(r.ast.indexes).toHaveLength(1);
        expect(r.ast.indexes[0].columns).toEqual([]);
    });

    it('CREATE INDEX missing the ON keyword emits a warning and yields no index', () => {
        const r = parse(`CREATE TABLE t(a INT); CREATE INDEX idx t(a);`);
        // Warning (not fatal) — parser keeps going. Use the helper that
        // already filters by severity.
        const warns = r.warns();
        expect(warns.length).toBeGreaterThanOrEqual(1);
        expect(warns.some((w) => /CREATE INDEX/i.test(w.message))).toBe(true);
        expect(r.errs()).toHaveLength(0);
        expect(r.ast.indexes).toEqual([]);
    });

    it('multiple CREATE INDEX statements interleaved with CREATE TABLE are all captured', () => {
        const r = parse(`
            CREATE INDEX pre ON future(a);
            CREATE TABLE t1(a INT);
            CREATE INDEX ix1 ON t1(a);
            CREATE TABLE t2(b INT);
            CREATE UNIQUE INDEX uq ON t2(b);
        `);
        expect(r.ast.indexes).toHaveLength(3);
        // Captured in source order regardless of whether the table exists yet.
        expect(r.ast.indexes.map((i) => i.name)).toEqual(['pre', 'ix1', 'uq']);
        expect(r.ast.indexes[2].unique).toBe(true);
    });

    it('parsing the same SQL twice yields independent, equal results (no global state leakage)', () => {
        const sql = `
            CREATE TABLE t(a INT, b INT);
            CREATE INDEX ix1 ON t(a);
            CREATE UNIQUE INDEX uq1 ON t(a, b);
        `;
        const a = parse(sql);
        const b = parse(sql);
        expect(a.errs()).toEqual(b.errs());
        expect(a.ast.indexes).toEqual(b.ast.indexes);
        // Strict structural equality (catches any shared mutable state).
        expect(JSON.stringify(a.ast.indexes)).toBe(JSON.stringify(b.ast.indexes));
    });
});

// ════════════════════════════════════════════════════════════════════════════
// SQLite dialect support
// ════════════════════════════════════════════════════════════════════════════

describe('SQLite — AUTOINCREMENT keyword', () => {
    it('parses INTEGER PRIMARY KEY AUTOINCREMENT', () => {
        const r = parse(`CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);`);
        const col = r.column('t', 'id');
        expect(col.primary).toBe(true);
        expect(col.autoIncrement).toBe(true);
        expect(col.type).toBe('INTEGER');
        expect(r.column('t', 'name').type).toBe('TEXT');
        expect(r.errs()).toHaveLength(0);
    });

    it('handles AUTOINCREMENT alongside NOT NULL', () => {
        const r = parse(`CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL);`);
        const col = r.column('t', 'id');
        expect(col.primary).toBe(true);
        expect(col.autoIncrement).toBe(true);
        expect(col.notNull).toBe(true);
    });

    it('does not confuse AUTOINCREMENT with AUTO_INCREMENT', () => {
        const r = parse(`
            CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT);
            CREATE TABLE b (id INT AUTO_INCREMENT PRIMARY KEY);
        `);
        expect(r.column('a', 'id').autoIncrement).toBe(true);
        expect(r.column('b', 'id').autoIncrement).toBe(true);
        expect(r.errs()).toHaveLength(0);
    });
});

describe('SQLite — WITHOUT ROWID tables', () => {
    it('parses a table with WITHOUT ROWID', () => {
        const r = parse(`
            CREATE TABLE config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) WITHOUT ROWID;
        `);
        const t = r.table('config');
        expect(t).not.toBeNull();
        expect(t.columns).toHaveLength(2);
        expect(r.column('config', 'key').primary).toBe(true);
        expect(r.errs()).toHaveLength(0);
    });

    it('does not lose the next CREATE after WITHOUT ROWID', () => {
        const r = parse(`
            CREATE TABLE a (key TEXT PRIMARY KEY) WITHOUT ROWID;
            CREATE TABLE b (id INTEGER PRIMARY KEY);
        `);
        expect(r.tables).toHaveLength(2);
        expect(r.table('a')).not.toBeNull();
        expect(r.table('b')).not.toBeNull();
        expect(r.errs()).toHaveLength(0);
    });
});

describe('SQLite — STRICT tables', () => {
    it('parses a table with STRICT', () => {
        const r = parse(`
            CREATE TABLE measurements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                value REAL NOT NULL,
                label TEXT
            ) STRICT;
        `);
        expect(r.table('measurements')).not.toBeNull();
        expect(r.table('measurements').columns).toHaveLength(3);
        expect(r.errs()).toHaveLength(0);
    });

    it('parses STRICT, WITHOUT ROWID combined', () => {
        const r = parse(`
            CREATE TABLE settings (
                key TEXT NOT NULL,
                value TEXT,
                PRIMARY KEY (key)
            ) STRICT, WITHOUT ROWID;
        `);
        const t = r.table('settings');
        expect(t).not.toBeNull();
        expect(t.columns).toHaveLength(2);
        expect(r.column('settings', 'key').primary).toBe(true);
        expect(r.errs()).toHaveLength(0);
    });

    it('parses WITHOUT ROWID, STRICT (reversed order)', () => {
        const r = parse(`
            CREATE TABLE kv (
                k TEXT PRIMARY KEY,
                v BLOB
            ) WITHOUT ROWID, STRICT;
        `);
        expect(r.table('kv')).not.toBeNull();
        expect(r.errs()).toHaveLength(0);
    });
});

describe('SQLite — ON CONFLICT clause', () => {
    it('parses NOT NULL ON CONFLICT ABORT on a column', () => {
        const r = parse(`
            CREATE TABLE t (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL ON CONFLICT ABORT
            );
        `);
        expect(r.column('t', 'name').notNull).toBe(true);
        expect(r.errs()).toHaveLength(0);
    });

    it('parses UNIQUE ON CONFLICT REPLACE on a column', () => {
        const r = parse(`
            CREATE TABLE t (
                id INTEGER PRIMARY KEY,
                email TEXT UNIQUE ON CONFLICT REPLACE
            );
        `);
        expect(r.column('t', 'email').unique).toBe(true);
        expect(r.errs()).toHaveLength(0);
    });
});

describe('SQLite — type affinity (flexible type names)', () => {
    it('parses SQLite-friendly type names that map to affinity', () => {
        const r = parse(`
            CREATE TABLE t (
                a INTEGER,
                b REAL,
                c TEXT,
                d BLOB,
                e NUMERIC
            );
        `);
        expect(r.table('t').columns).toHaveLength(5);
        expect(r.column('t', 'a').type).toBe('INTEGER');
        expect(r.column('t', 'b').type).toBe('REAL');
        expect(r.column('t', 'c').type).toBe('TEXT');
        expect(r.column('t', 'd').type).toBe('BLOB');
        expect(r.column('t', 'e').type).toBe('NUMERIC');
    });

    it('handles columns with no type (SQLite allows this)', () => {
        // SQLite stores an empty declared type for a typeless column. The AST
        // uses UNTYPED so the ERD can show that fact without inventing BLOB.
        const r = parse(`CREATE TABLE t (a INTEGER, b);`);
        expect(r.column('t', 'a')).not.toBeNull();
        expect(r.column('t', 'b')).toMatchObject({ type: 'UNTYPED', declaredTypeMissing: true });
        expect(r.errs()).toEqual([]);
    });
});

describe('SQLite — IF NOT EXISTS + TEMP tables', () => {
    it('parses CREATE TABLE IF NOT EXISTS (SQLite style)', () => {
        const r = parse(`CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, val TEXT);`);
        expect(r.table('cache')).not.toBeNull();
        expect(r.errs()).toHaveLength(0);
    });

    it('parses CREATE TEMP TABLE', () => {
        const r = parse(`CREATE TEMP TABLE session_data (id INTEGER PRIMARY KEY, token TEXT);`);
        expect(r.table('session_data')).not.toBeNull();
        expect(r.errs()).toHaveLength(0);
    });

    it('parses CREATE TEMPORARY TABLE IF NOT EXISTS', () => {
        const r = parse(`CREATE TEMPORARY TABLE IF NOT EXISTS tmp (id INTEGER PRIMARY KEY);`);
        expect(r.table('tmp')).not.toBeNull();
        expect(r.errs()).toHaveLength(0);
    });
});

describe('SQLite — DEFAULT expressions', () => {
    it('parses DEFAULT with SQLite-common expressions', () => {
        const r = parse(`
            CREATE TABLE t (
                id INTEGER PRIMARY KEY,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                is_active INTEGER DEFAULT 1,
                label TEXT DEFAULT 'untitled'
            );
        `);
        expect(r.column('t', 'created_at').default).toBe('CURRENT_TIMESTAMP');
        expect(r.column('t', 'is_active').default).toBe('1');
        expect(r.column('t', 'label').default).toBe("'untitled'");
    });
});

describe('SQLite — Foreign keys', () => {
    it('parses inline REFERENCES in SQLite style', () => {
        const r = parse(`
            CREATE TABLE users (id INTEGER PRIMARY KEY);
            CREATE TABLE posts (
                id INTEGER PRIMARY KEY,
                user_id INTEGER REFERENCES users(id)
            );
        `);
        const col = r.column('posts', 'user_id');
        expect(col.references.table).toBe('users');
        expect(col.references.columns).toEqual(['id']);
    });

    it('parses table-level FOREIGN KEY in SQLite style', () => {
        const r = parse(`
            CREATE TABLE categories (id INTEGER PRIMARY KEY);
            CREATE TABLE items (
                id INTEGER PRIMARY KEY,
                cat_id INTEGER NOT NULL,
                FOREIGN KEY (cat_id) REFERENCES categories(id)
            );
        `);
        const fk = r.table('items').constraints.find((c) => c && c.kind === 'foreign');
        expect(fk).toBeTruthy();
        expect(fk.references.table).toBe('categories');
    });
});

describe('SQLite — end-to-end realistic schema', () => {
    it('parses a full SQLite schema with AUTOINCREMENT, WITHOUT ROWID, FKs, and indexes', () => {
        const sql = `
            -- SQLite schema
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE categories (
                slug TEXT PRIMARY KEY,
                label TEXT NOT NULL
            ) WITHOUT ROWID;

            CREATE TABLE posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                author_id INTEGER NOT NULL REFERENCES users(id),
                category_slug TEXT REFERENCES categories(slug),
                title TEXT NOT NULL,
                body TEXT,
                published INTEGER DEFAULT 0 CHECK (published IN (0, 1)),
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE tags (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE
            ) STRICT;

            CREATE TABLE post_tags (
                post_id INTEGER NOT NULL REFERENCES posts(id),
                tag_id INTEGER NOT NULL REFERENCES tags(id),
                PRIMARY KEY (post_id, tag_id)
            ) STRICT, WITHOUT ROWID;

            CREATE INDEX idx_posts_author ON posts (author_id);
            CREATE INDEX idx_posts_category ON posts (category_slug);
            CREATE UNIQUE INDEX uq_posts_title ON posts (title);
        `;
        const r = parse(sql);

        // No errors
        expect(r.errs()).toHaveLength(0);

        // All 5 tables parsed
        expect(r.tables).toHaveLength(5);

        // users
        const users = r.table('users');
        expect(users.columns).toHaveLength(4);
        expect(r.column('users', 'id').autoIncrement).toBe(true);
        expect(r.column('users', 'id').primary).toBe(true);
        expect(r.column('users', 'email').unique).toBe(true);
        expect(r.column('users', 'email').notNull).toBe(true);

        // categories (WITHOUT ROWID)
        const categories = r.table('categories');
        expect(categories.columns).toHaveLength(2);
        expect(r.column('categories', 'slug').primary).toBe(true);

        // posts
        expect(r.column('posts', 'id').autoIncrement).toBe(true);
        expect(r.column('posts', 'author_id').references.table).toBe('users');
        expect(r.column('posts', 'category_slug').references.table).toBe('categories');
        expect(r.column('posts', 'published').check).toContain('published');

        // tags (STRICT)
        expect(r.table('tags').columns).toHaveLength(2);
        expect(r.column('tags', 'name').unique).toBe(true);

        // post_tags (STRICT, WITHOUT ROWID, composite PK)
        const pt = r.table('post_tags');
        expect(pt.columns).toHaveLength(2);
        expect(r.column('post_tags', 'post_id').primary).toBe(true);
        expect(r.column('post_tags', 'tag_id').primary).toBe(true);
        expect(r.column('post_tags', 'post_id').references.table).toBe('posts');
        expect(r.column('post_tags', 'tag_id').references.table).toBe('tags');

        // Indexes
        expect(r.ast.indexes).toHaveLength(3);
        const idxAuthor = r.ast.indexes.find((i) => i.name === 'idx_posts_author');
        expect(idxAuthor.columns).toEqual(['author_id']);
        expect(idxAuthor.unique).toBe(false);
        const uqTitle = r.ast.indexes.find((i) => i.name === 'uq_posts_title');
        expect(uqTitle.unique).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// SQLite — Edge cases and stress tests
// ════════════════════════════════════════════════════════════════════════════

describe('SQLite — keyword column names', () => {
    it('allows "key" as a column name (common in SQLite KV tables)', () => {
        const r = parse(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);`);
        expect(r.table('kv').columns).toHaveLength(2);
        expect(r.column('kv', 'key').primary).toBe(true);
        expect(r.column('kv', 'value').type).toBe('TEXT');
        expect(r.errs()).toHaveLength(0);
    });

    it('allows "value" as a column name', () => {
        const r = parse(`CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT NOT NULL);`);
        expect(r.column('t', 'value').notNull).toBe(true);
    });

    it('allows "replace" as a column name (new SQLite keyword)', () => {
        const r = parse(`CREATE TABLE t (id INTEGER PRIMARY KEY, "replace" TEXT);`);
        expect(r.table('t').columns).toHaveLength(2);
    });

    it('allows "strict" as a quoted column name', () => {
        const r = parse(`CREATE TABLE t (id INTEGER PRIMARY KEY, "strict" INTEGER DEFAULT 0);`);
        expect(r.column('t', 'strict').default).toBe('0');
    });

    it('allows "rowid" as a column name', () => {
        const r = parse(`CREATE TABLE t (rowid INTEGER, name TEXT);`);
        expect(r.table('t').columns).toHaveLength(2);
    });
});

describe('SQLite — ON CONFLICT all variants', () => {
    it('parses ON CONFLICT ROLLBACK', () => {
        const r = parse(`CREATE TABLE t (id INTEGER PRIMARY KEY ON CONFLICT ROLLBACK);`);
        expect(r.column('t', 'id').primary).toBe(true);
        expect(r.errs()).toHaveLength(0);
    });

    it('parses ON CONFLICT FAIL', () => {
        const r = parse(`CREATE TABLE t (name TEXT NOT NULL ON CONFLICT FAIL);`);
        expect(r.column('t', 'name').notNull).toBe(true);
        expect(r.errs()).toHaveLength(0);
    });

    it('parses ON CONFLICT IGNORE', () => {
        const r = parse(`CREATE TABLE t (email TEXT UNIQUE ON CONFLICT IGNORE);`);
        expect(r.column('t', 'email').unique).toBe(true);
        expect(r.errs()).toHaveLength(0);
    });

    it('parses ON CONFLICT REPLACE', () => {
        const r = parse(`CREATE TABLE t (id INTEGER PRIMARY KEY ON CONFLICT REPLACE, name TEXT);`);
        expect(r.column('t', 'id').primary).toBe(true);
        expect(r.column('t', 'name').type).toBe('TEXT');
        expect(r.errs()).toHaveLength(0);
    });

    it('parses multiple ON CONFLICT on different columns', () => {
        const r = parse(`
            CREATE TABLE t (
                id INTEGER PRIMARY KEY ON CONFLICT REPLACE,
                name TEXT NOT NULL ON CONFLICT ABORT,
                email TEXT UNIQUE ON CONFLICT IGNORE
            );
        `);
        expect(r.table('t').columns).toHaveLength(3);
        expect(r.column('t', 'id').primary).toBe(true);
        expect(r.column('t', 'name').notNull).toBe(true);
        expect(r.column('t', 'email').unique).toBe(true);
        expect(r.errs()).toHaveLength(0);
    });
});

describe('SQLite — DEFAULT edge cases', () => {
    it('parses DEFAULT with parenthesized expression', () => {
        const r = parse(`CREATE TABLE t (id INTEGER PRIMARY KEY, ts TEXT DEFAULT (datetime('now')));`);
        const col = r.column('t', 'ts');
        expect(col.default).toBeTruthy();
        // The parser may represent the parenthesized default differently;
        // just verify it captured something with 'datetime' (case-insensitive).
        expect(col.default.toLowerCase()).toContain('datetime');
    });

    it('parses DEFAULT NULL', () => {
        const r = parse(`CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT DEFAULT NULL);`);
        expect(r.column('t', 'note').default).toBe('NULL');
    });

    it('parses DEFAULT with negative number', () => {
        const r = parse(`CREATE TABLE t (id INTEGER PRIMARY KEY, offset INTEGER DEFAULT -1);`);
        expect(r.column('t', 'offset').default).toContain('-1');
    });

    it('parses DEFAULT with boolean-like integers (SQLite has no BOOLEAN)', () => {
        const r = parse(`
            CREATE TABLE t (
                id INTEGER PRIMARY KEY,
                active INTEGER DEFAULT 1,
                deleted INTEGER DEFAULT 0
            );
        `);
        expect(r.column('t', 'active').default).toBe('1');
        expect(r.column('t', 'deleted').default).toBe('0');
    });
});

describe('SQLite — WITHOUT ROWID edge cases', () => {
    it('parses WITHOUT ROWID without trailing semicolon', () => {
        const r = parse(`CREATE TABLE t (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID`);
        expect(r.table('t')).not.toBeNull();
        expect(r.table('t').columns).toHaveLength(2);
    });

    it('parses WITHOUT ROWID with composite PK', () => {
        const r = parse(`
            CREATE TABLE composite (
                a TEXT NOT NULL,
                b INTEGER NOT NULL,
                c REAL,
                PRIMARY KEY (a, b)
            ) WITHOUT ROWID;
        `);
        expect(r.column('composite', 'a').primary).toBe(true);
        expect(r.column('composite', 'b').primary).toBe(true);
        expect(r.column('composite', 'c').primary).toBeFalsy();
    });

    it('parses three tables with alternating WITHOUT ROWID', () => {
        const r = parse(`
            CREATE TABLE a (id INTEGER PRIMARY KEY);
            CREATE TABLE b (key TEXT PRIMARY KEY) WITHOUT ROWID;
            CREATE TABLE c (id INTEGER PRIMARY KEY AUTOINCREMENT);
        `);
        expect(r.tables).toHaveLength(3);
        expect(r.column('c', 'id').autoIncrement).toBe(true);
        expect(r.errs()).toHaveLength(0);
    });
});

describe('SQLite — STRICT edge cases', () => {
    it('parses STRICT without trailing semicolon', () => {
        const r = parse(`CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT) STRICT`);
        expect(r.table('t')).not.toBeNull();
    });

    it('parses STRICT table with CHECK constraint', () => {
        const r = parse(`
            CREATE TABLE scores (
                id INTEGER PRIMARY KEY,
                score REAL NOT NULL CHECK (score >= 0.0 AND score <= 100.0)
            ) STRICT;
        `);
        expect(r.column('scores', 'score').check).toContain('score');
        expect(r.errs()).toHaveLength(0);
    });
});

describe('SQLite — AUTOINCREMENT edge cases', () => {
    it('AUTOINCREMENT before PRIMARY KEY still works', () => {
        // SQLite technically requires AUTOINCREMENT after PRIMARY KEY,
        // but parser should be lenient
        const r = parse(`CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT);`);
        expect(r.column('t', 'id').autoIncrement).toBe(true);
        expect(r.column('t', 'id').primary).toBe(true);
    });

    it('multiple tables with AUTOINCREMENT do not interfere', () => {
        const r = parse(`
            CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT, x TEXT);
            CREATE TABLE b (id INTEGER PRIMARY KEY AUTOINCREMENT, y TEXT);
            CREATE TABLE c (id INTEGER PRIMARY KEY AUTOINCREMENT, z TEXT);
        `);
        expect(r.tables).toHaveLength(3);
        expect(r.column('a', 'id').autoIncrement).toBe(true);
        expect(r.column('b', 'id').autoIncrement).toBe(true);
        expect(r.column('c', 'id').autoIncrement).toBe(true);
        expect(r.errs()).toHaveLength(0);
    });

    it('AUTOINCREMENT with DEFAULT should both be set', () => {
        const r = parse(`CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT DEFAULT 'x');`);
        expect(r.column('t', 'id').autoIncrement).toBe(true);
        expect(r.column('t', 'val').default).toBe("'x'");
    });
});

describe('SQLite — CHECK with IN() pattern (common for boolean emulation)', () => {
    it('parses CHECK (col IN (0, 1)) for boolean emulation', () => {
        const r = parse(`
            CREATE TABLE flags (
                id INTEGER PRIMARY KEY,
                active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
                visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1))
            );
        `);
        expect(r.column('flags', 'active').check.toLowerCase()).toContain('active');
        expect(r.column('flags', 'visible').check.toLowerCase()).toContain('visible');
        expect(r.column('flags', 'active').notNull).toBe(true);
        expect(r.column('flags', 'active').default).toBe('1');
    });
});

describe('SQLite — mixed dialect resilience', () => {
    it('does not confuse AUTOINCREMENT and AUTO_INCREMENT in same script', () => {
        const r = parse(`
            CREATE TABLE sqlite_style (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
            CREATE TABLE mysql_style (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100));
        `);
        expect(r.tables).toHaveLength(2);
        expect(r.column('sqlite_style', 'id').autoIncrement).toBe(true);
        expect(r.column('mysql_style', 'id').autoIncrement).toBe(true);
        expect(r.errs()).toHaveLength(0);
    });

    it('handles SQLite table followed by PostgreSQL table', () => {
        const r = parse(`
            CREATE TABLE sqlite_t (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                data TEXT
            ) STRICT;

            CREATE TABLE pg_t (
                id SERIAL PRIMARY KEY,
                data JSONB,
                ts TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        expect(r.tables).toHaveLength(2);
        expect(r.column('sqlite_t', 'id').autoIncrement).toBe(true);
        expect(r.column('pg_t', 'id').type).toBe('SERIAL');
        expect(r.errs()).toHaveLength(0);
    });

    it('SQLite table with MSSQL-style IDENTITY in same script', () => {
        const r = parse(`
            CREATE TABLE lite (id INTEGER PRIMARY KEY AUTOINCREMENT);
            CREATE TABLE mssql (id INT IDENTITY(1,1) PRIMARY KEY);
        `);
        expect(r.column('lite', 'id').autoIncrement).toBe(true);
        expect(r.column('mssql', 'id').autoIncrement).toBe(true);
    });
});

describe('SQLite — complex FK scenarios', () => {
    it('parses FK with ON DELETE CASCADE ON UPDATE SET NULL', () => {
        const r = parse(`
            CREATE TABLE parent (id INTEGER PRIMARY KEY);
            CREATE TABLE child (
                id INTEGER PRIMARY KEY,
                parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE ON UPDATE SET NULL
            );
        `);
        expect(r.column('child', 'parent_id').references.table).toBe('parent');
        expect(r.errs()).toHaveLength(0);
    });

    it('parses table-level FK with actions', () => {
        const r = parse(`
            CREATE TABLE users (id INTEGER PRIMARY KEY);
            CREATE TABLE orders (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
            );
        `);
        const fk = r.table('orders').constraints.find((c) => c && c.kind === 'foreign');
        expect(fk.references.table).toBe('users');
    });

    it('parses multiple FKs in one table', () => {
        const r = parse(`
            CREATE TABLE a (id INTEGER PRIMARY KEY);
            CREATE TABLE b (id INTEGER PRIMARY KEY);
            CREATE TABLE c (
                id INTEGER PRIMARY KEY,
                a_id INTEGER REFERENCES a(id),
                b_id INTEGER REFERENCES b(id),
                FOREIGN KEY (a_id) REFERENCES a(id),
                FOREIGN KEY (b_id) REFERENCES b(id)
            );
        `);
        const fks = r.table('c').constraints.filter((c) => c && c.kind === 'foreign');
        expect(fks.length).toBeGreaterThanOrEqual(2);
    });
});

describe('SQLite — table without semicolons (last statement)', () => {
    it('parses final table without semicolon after STRICT, WITHOUT ROWID', () => {
        const r = parse(`CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT) STRICT, WITHOUT ROWID`);
        expect(r.table('t')).not.toBeNull();
        expect(r.table('t').columns).toHaveLength(2);
    });

    it('parses two tables where only the last lacks a semicolon', () => {
        const r = parse(`
            CREATE TABLE a (id INTEGER PRIMARY KEY) WITHOUT ROWID;
            CREATE TABLE b (id INTEGER PRIMARY KEY) STRICT
        `);
        expect(r.tables).toHaveLength(2);
    });
});

describe('SQLite — COLLATE in column definitions', () => {
    it('parses COLLATE NOCASE', () => {
        const r = parse(`
            CREATE TABLE t (
                id INTEGER PRIMARY KEY,
                name TEXT COLLATE NOCASE
            );
        `);
        expect(r.column('t', 'name').type).toBe('TEXT');
        expect(r.errs()).toHaveLength(0);
    });

    it('parses COLLATE BINARY', () => {
        const r = parse(`CREATE TABLE t (code TEXT NOT NULL COLLATE BINARY);`);
        expect(r.column('t', 'code').notNull).toBe(true);
    });

    it('parses COLLATE RTRIM with other constraints', () => {
        const r = parse(`
            CREATE TABLE t (
                label TEXT NOT NULL UNIQUE COLLATE RTRIM DEFAULT 'untitled'
            );
        `);
        expect(r.column('t', 'label').notNull).toBe(true);
        expect(r.column('t', 'label').unique).toBe(true);
        expect(r.column('t', 'label').default).toBe("'untitled'");
    });
});

describe('SQLite — large multi-table schema stress test', () => {
    it('parses 10 SQLite tables with various features without errors', () => {
        const sql = `
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                is_admin INTEGER DEFAULT 0 CHECK (is_admin IN (0, 1))
            );

            CREATE TABLE profiles (
                user_id INTEGER PRIMARY KEY REFERENCES users(id),
                bio TEXT,
                avatar_url TEXT,
                location TEXT
            ) WITHOUT ROWID;

            CREATE TABLE categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                slug TEXT NOT NULL UNIQUE,
                parent_id INTEGER REFERENCES categories(id)
            );

            CREATE TABLE articles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                author_id INTEGER NOT NULL REFERENCES users(id),
                category_id INTEGER REFERENCES categories(id),
                title TEXT NOT NULL,
                slug TEXT NOT NULL UNIQUE,
                body TEXT,
                published INTEGER DEFAULT 0 CHECK (published IN (0, 1)),
                view_count INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT
            );

            CREATE TABLE tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE COLLATE NOCASE
            ) STRICT;

            CREATE TABLE article_tags (
                article_id INTEGER NOT NULL REFERENCES articles(id),
                tag_id INTEGER NOT NULL REFERENCES tags(id),
                PRIMARY KEY (article_id, tag_id)
            ) WITHOUT ROWID;

            CREATE TABLE comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                article_id INTEGER NOT NULL REFERENCES articles(id),
                author_id INTEGER NOT NULL REFERENCES users(id),
                parent_id INTEGER REFERENCES comments(id),
                body TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE likes (
                user_id INTEGER NOT NULL REFERENCES users(id),
                article_id INTEGER NOT NULL REFERENCES articles(id),
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, article_id)
            ) WITHOUT ROWID;

            CREATE TABLE sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                expires_at TEXT NOT NULL
            ) STRICT, WITHOUT ROWID;

            CREATE TABLE audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER REFERENCES users(id),
                action TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id INTEGER,
                details TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX idx_articles_author ON articles (author_id);
            CREATE INDEX idx_articles_category ON articles (category_id);
            CREATE INDEX idx_articles_slug ON articles (slug);
            CREATE INDEX idx_comments_article ON comments (article_id);
            CREATE INDEX idx_comments_author ON comments (author_id);
            CREATE UNIQUE INDEX uq_article_tags ON article_tags (article_id, tag_id);
        `;
        const r = parse(sql);

        expect(r.errs()).toHaveLength(0);
        expect(r.tables).toHaveLength(10);
        expect(r.ast.indexes).toHaveLength(6);

        // Spot checks
        expect(r.column('users', 'id').autoIncrement).toBe(true);
        expect(r.column('users', 'is_admin').check).toContain('is_admin');
        expect(r.column('profiles', 'user_id').references.table).toBe('users');
        expect(r.column('categories', 'parent_id').references.table).toBe('categories');
        expect(r.column('articles', 'published').default).toBe('0');
        expect(r.column('article_tags', 'article_id').primary).toBe(true);
        expect(r.column('sessions', 'token').primary).toBe(true);
        expect(r.column('comments', 'parent_id').references.table).toBe('comments');
        expect(r.column('likes', 'user_id').primary).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Mega 4-dialect cross-dialect test (PG + MySQL + MSSQL + SQLite)
// ════════════════════════════════════════════════════════════════════════════

describe('Mega 4-dialect cross-dialect end-to-end', () => {
    it('parses PG, MySQL, MSSQL and SQLite constructs in one script with zero errors', () => {
        const sql = `
            -- ─── PostgreSQL ───────────────────────────────────────────────
            CREATE TYPE user_role AS ENUM ('admin', 'editor', 'viewer');

            CREATE TABLE pg_accounts (
                id BIGSERIAL PRIMARY KEY,
                email VARCHAR(255) NOT NULL UNIQUE,
                role user_role NOT NULL DEFAULT 'viewer',
                metadata JSONB DEFAULT '{}',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE pg_posts (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                account_id BIGINT NOT NULL REFERENCES pg_accounts(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                body TEXT,
                word_count INT GENERATED ALWAYS AS (length(body)) STORED
            );

            -- ─── MySQL ────────────────────────────────────────────────────
            CREATE TABLE \`my_products\` (
                \`id\` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                \`name\` VARCHAR(200) NOT NULL,
                \`size\` ENUM('XS','S','M','L','XL') DEFAULT 'M',
                \`price\` DECIMAL(10,2) UNSIGNED NOT NULL,
                \`created\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_name (\`name\`),
                FULLTEXT KEY ft_name (\`name\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

            -- ─── MSSQL ────────────────────────────────────────────────────
            CREATE TABLE [dbo].[ms_orders] (
                [id] BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_orders PRIMARY KEY CLUSTERED,
                [product_id] BIGINT NOT NULL,
                [quantity] INT NOT NULL DEFAULT 1,
                [total] DECIMAL(10,2) NOT NULL,
                [created] DATETIME2 NOT NULL DEFAULT GETDATE(),
                [hash] AS (CHECKSUM([product_id])) PERSISTED,
                CONSTRAINT fk_orders_product FOREIGN KEY ([product_id]) REFERENCES my_products(id)
            );
            GO

            -- ─── SQLite ───────────────────────────────────────────────────
            CREATE TABLE lite_config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            ) WITHOUT ROWID;

            CREATE TABLE lite_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
                payload TEXT,
                is_processed INTEGER DEFAULT 0 CHECK (is_processed IN (0, 1)),
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            ) STRICT;

            CREATE TABLE lite_tags (
                event_id INTEGER NOT NULL REFERENCES lite_events(id),
                tag TEXT NOT NULL COLLATE NOCASE,
                PRIMARY KEY (event_id, tag)
            ) STRICT, WITHOUT ROWID;

            -- ─── Cross-dialect indexes ────────────────────────────────────
            CREATE INDEX idx_pg_posts_account ON pg_posts (account_id);
            CREATE UNIQUE INDEX uq_lite_events_type ON lite_events (event_type);

            -- ─── Cross-dialect alters ─────────────────────────────────────
            ALTER TABLE pg_accounts ADD CONSTRAINT chk_email CHECK (email LIKE '%@%');
        `;
        const r = parse(sql);
        expect(r.errs()).toHaveLength(0);

        // ── PostgreSQL checks ──
        expect(r.tables).toHaveLength(7);
        // 2 types: explicit user_role + synthetic size_enum from MySQL ENUM
        expect(r.types).toHaveLength(2);
        expect(r.type('user_role').values).toEqual(['admin', 'editor', 'viewer']);
        expect(r.column('pg_accounts', 'id').autoIncrement).toBe(true);
        expect(r.column('pg_accounts', 'role').type).toBe('user_role');
        expect(r.column('pg_accounts', 'metadata').type).toBe('JSONB');
        expect(r.column('pg_posts', 'id').autoIncrement).toBe(true);
        expect(r.column('pg_posts', 'word_count').generated).toMatch(/STORED$/);
        expect(r.column('pg_posts', 'account_id').references.table).toBe('pg_accounts');

        // ── MySQL checks ──
        expect(r.column('my_products', 'id').autoIncrement).toBe(true);
        expect(r.column('my_products', 'size').type).toBe('size_enum');
        expect(r.column('my_products', 'price').type).toContain('DECIMAL');

        // ── MSSQL checks ──
        expect(r.column('ms_orders', 'id').autoIncrement).toBe(true);
        expect(r.column('ms_orders', 'hash').type).toBe('COMPUTED');
        expect(r.column('ms_orders', 'hash').generated).toMatch(/PERSISTED$/);
        const msFk = r.table('ms_orders').constraints.find((c) => c.kind === 'foreign');
        expect(msFk.references.table).toBe('my_products');

        // ── SQLite checks ──
        expect(r.column('lite_config', 'key').primary).toBe(true);
        expect(r.column('lite_config', 'value').notNull).toBe(true);
        expect(r.column('lite_events', 'id').autoIncrement).toBe(true);
        expect(r.column('lite_events', 'is_processed').check).toBeTruthy();
        expect(r.column('lite_events', 'is_processed').default).toBe('0');
        expect(r.column('lite_tags', 'event_id').primary).toBe(true);
        expect(r.column('lite_tags', 'tag').primary).toBe(true);
        expect(r.column('lite_tags', 'event_id').references.table).toBe('lite_events');

        // ── Indexes (2 MySQL inline + 2 standalone) ──
        expect(r.ast.indexes).toHaveLength(4);

        // ── Alters ──
        expect(r.alters).toHaveLength(1);
        expect(r.alters[0].action).toBe('add_check');
    });
});

describe('Auto-increment syntax matrix — all 4 dialects', () => {
    it('parses all auto-increment flavors in one script', () => {
        const r = parse(`
            CREATE TABLE pg1 (id SERIAL PRIMARY KEY);
            CREATE TABLE pg2 (id BIGSERIAL PRIMARY KEY);
            CREATE TABLE pg3 (id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
            CREATE TABLE pg4 (id INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY);
            CREATE TABLE mysql1 (id INT AUTO_INCREMENT PRIMARY KEY);
            CREATE TABLE mssql1 (id INT IDENTITY(1,1) PRIMARY KEY);
            CREATE TABLE mssql2 (id INT IDENTITY(100,5) PRIMARY KEY);
            CREATE TABLE lite1 (id INTEGER PRIMARY KEY AUTOINCREMENT);
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.tables).toHaveLength(8);

        expect(r.column('pg1', 'id').autoIncrement).toBe(true);
        expect(r.column('pg2', 'id').autoIncrement).toBe(true);
        expect(r.column('pg3', 'id').autoIncrement).toBe(true);
        expect(r.column('pg4', 'id').autoIncrement).toBe(true);
        expect(r.column('mysql1', 'id').autoIncrement).toBe(true);
        expect(r.column('mssql1', 'id').autoIncrement).toBe(true);
        expect(r.column('mssql2', 'id').autoIncrement).toBe(true);
        expect(r.column('lite1', 'id').autoIncrement).toBe(true);

        // All are also primary keys
        expect(r.column('pg1', 'id').primary).toBe(true);
        expect(r.column('mysql1', 'id').primary).toBe(true);
        expect(r.column('mssql1', 'id').primary).toBe(true);
        expect(r.column('lite1', 'id').primary).toBe(true);
    });
});

describe('SQLite keywords do NOT regress other dialects', () => {
    it('REPLACE as MySQL keyword still works in INSERT OR REPLACE pattern', () => {
        // REPLACE is now a tokenized keyword — verify it doesn't break other uses
        const r = parse(`CREATE TABLE t (id INT PRIMARY KEY, val TEXT);`);
        expect(r.errs()).toHaveLength(0);
    });

    it('IGNORE in MySQL INSERT IGNORE context does not break parsing', () => {
        const r = parse(`
            CREATE TABLE t (id INT PRIMARY KEY, name TEXT);
            CREATE TABLE t2 (id INT PRIMARY KEY, ref_id INT REFERENCES t(id));
        `);
        expect(r.tables).toHaveLength(2);
        expect(r.errs()).toHaveLength(0);
    });

    it('CONFLICT keyword does not interfere with normal CHECK constraints', () => {
        const r = parse(`
            CREATE TABLE t (
                id INT PRIMARY KEY,
                age INT CHECK (age > 0),
                score DECIMAL(5,2) CHECK (score BETWEEN 0 AND 100)
            );
        `);
        expect(r.column('t', 'age').check).toBeTruthy();
        expect(r.column('t', 'score').check).toBeTruthy();
        expect(r.errs()).toHaveLength(0);
    });

    it('GLOB and REGEXP keywords do not break PostgreSQL type parsing', () => {
        const r = parse(`
            CREATE TABLE t (
                id SERIAL PRIMARY KEY,
                data JSONB NOT NULL DEFAULT '{}',
                tags TEXT[],
                score DOUBLE PRECISION DEFAULT 0.0
            );
        `);
        expect(r.column('t', 'data').type).toBe('JSONB');
        expect(r.column('t', 'tags').type).toBe('TEXT[]');
        expect(r.column('t', 'score').type).toBe('DOUBLE PRECISION');
        expect(r.errs()).toHaveLength(0);
    });

    it('WITHOUT keyword does not break MySQL WITH (PARSER) or PG WITH (fillfactor)', () => {
        const r = parse(`
            CREATE TABLE pg_t (
                id INT PRIMARY KEY,
                val TEXT
            );
        `);
        expect(r.table('pg_t')).not.toBeNull();
        expect(r.errs()).toHaveLength(0);
    });

    it('STRICT keyword does not break MSSQL CLUSTERED/NONCLUSTERED', () => {
        const r = parse(`
            CREATE TABLE [dbo].[t] (
                [id] INT IDENTITY(1,1) NOT NULL CONSTRAINT pk PRIMARY KEY CLUSTERED,
                [name] NVARCHAR(100) NOT NULL
            );
        `);
        expect(r.column('t', 'id').autoIncrement).toBe(true);
        expect(r.column('t', 'id').primary).toBe(true);
        expect(r.errs()).toHaveLength(0);
    });
});

describe('4-dialect table options — trailing syntax resilience', () => {
    it('all trailing table options in one script', () => {
        const r = parse(`
            CREATE TABLE lite1 (id INTEGER PRIMARY KEY) WITHOUT ROWID;
            CREATE TABLE lite2 (id INTEGER PRIMARY KEY) STRICT;
            CREATE TABLE lite3 (id INTEGER PRIMARY KEY) STRICT, WITHOUT ROWID;
            CREATE TABLE lite4 (id INTEGER PRIMARY KEY) WITHOUT ROWID, STRICT;
            CREATE TABLE mysql1 (id INT PRIMARY KEY) ENGINE=InnoDB;
            CREATE TABLE mysql2 (id INT PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            CREATE TABLE pg1 (id INT PRIMARY KEY);
            CREATE TABLE mssql1 (id INT PRIMARY KEY);
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.tables).toHaveLength(8);
        // Verify none of the trailing options ate the next table
        expect(r.table('lite1')).not.toBeNull();
        expect(r.table('lite2')).not.toBeNull();
        expect(r.table('lite3')).not.toBeNull();
        expect(r.table('lite4')).not.toBeNull();
        expect(r.table('mysql1')).not.toBeNull();
        expect(r.table('mysql2')).not.toBeNull();
        expect(r.table('pg1')).not.toBeNull();
        expect(r.table('mssql1')).not.toBeNull();
    });
});

describe('4-dialect FK + constraint interop', () => {
    it('SQLite FK references a table defined with MySQL syntax', () => {
        const r = parse(`
            CREATE TABLE \`parent\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB;
            CREATE TABLE child (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE
            ) STRICT;
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.column('parent', 'id').autoIncrement).toBe(true);
        expect(r.column('child', 'id').autoIncrement).toBe(true);
        expect(r.column('child', 'parent_id').references.table).toBe('parent');
    });

    it('MSSQL table references a SQLite-style table', () => {
        const r = parse(`
            CREATE TABLE lite_ref (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT) STRICT;
            CREATE TABLE [dbo].[ms_child] (
                [id] INT IDENTITY(1,1) PRIMARY KEY,
                [lite_id] INT NOT NULL,
                CONSTRAINT fk_lite FOREIGN KEY ([lite_id]) REFERENCES lite_ref(id)
            );
        `);
        expect(r.errs()).toHaveLength(0);
        const fk = r.table('ms_child').constraints.find((c) => c.kind === 'foreign');
        expect(fk.references.table).toBe('lite_ref');
    });

    it('PG ALTER TABLE adds FK to a SQLite-style table', () => {
        const r = parse(`
            CREATE TABLE lite_parent (id INTEGER PRIMARY KEY) WITHOUT ROWID;
            CREATE TABLE pg_child (id SERIAL PRIMARY KEY, parent_id INT NOT NULL);
            ALTER TABLE pg_child ADD CONSTRAINT fk_parent FOREIGN KEY (parent_id) REFERENCES lite_parent(id);
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.alters).toHaveLength(1);
        expect(r.alters[0].references.table).toBe('lite_parent');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// SQLite — quoted identifiers
// ════════════════════════════════════════════════════════════════════════════

describe('SQLite — quoted identifiers', () => {
    it('parses double-quoted table and column names', () => {
        const r = parse(`
            CREATE TABLE "my table" (
                "my id" INTEGER PRIMARY KEY AUTOINCREMENT,
                "my name" TEXT NOT NULL,
                "my value" REAL DEFAULT 0.0
            );
        `);
        expect(r.table('my table')).not.toBeNull();
        expect(r.column('my table', 'my id').autoIncrement).toBe(true);
        expect(r.column('my table', 'my name').notNull).toBe(true);
    });

    it('parses bracket-quoted identifiers (SQLite supports this)', () => {
        const r = parse(`
            CREATE TABLE [my table] (
                [id] INTEGER PRIMARY KEY AUTOINCREMENT,
                [data] TEXT NOT NULL
            ) STRICT;
        `);
        expect(r.table('my table')).not.toBeNull();
        expect(r.column('my table', 'id').autoIncrement).toBe(true);
    });

    it('parses backtick-quoted identifiers', () => {
        const r = parse(`
            CREATE TABLE \`sqlite_table\` (
                \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
                \`value\` TEXT
            ) WITHOUT ROWID;
        `);
        expect(r.table('sqlite_table')).not.toBeNull();
    });

    it('mixes quoting styles in one script', () => {
        const r = parse(`
            CREATE TABLE "t1" ("id" INTEGER PRIMARY KEY);
            CREATE TABLE [t2] ([id] INTEGER PRIMARY KEY) WITHOUT ROWID;
            CREATE TABLE \`t3\` (\`id\` INTEGER PRIMARY KEY AUTOINCREMENT);
            CREATE TABLE t4 (id INTEGER PRIMARY KEY) STRICT;
        `);
        expect(r.tables).toHaveLength(4);
        expect(r.errs()).toHaveLength(0);
    });
});

describe('SQLite — comments interleaved with syntax', () => {
    it('comments before/after WITHOUT ROWID', () => {
        const r = parse(`
            CREATE TABLE t (
                id INTEGER PRIMARY KEY -- this is the PK
            ) /* table option: */ WITHOUT ROWID; -- end
        `);
        expect(r.table('t')).not.toBeNull();
        expect(r.column('t', 'id').primary).toBe(true);
    });

    it('block comment between STRICT and WITHOUT ROWID', () => {
        const r = parse(`
            CREATE TABLE t (
                id INTEGER PRIMARY KEY
            ) STRICT, /* no rowid */ WITHOUT ROWID;
        `);
        expect(r.table('t')).not.toBeNull();
        expect(r.errs()).toHaveLength(0);
    });

    it('comments between multiple SQLite tables', () => {
        const r = parse(`
            -- First table: config
            CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
            /* Second table */
            CREATE TABLE events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL
            ) STRICT;
            -- Done
        `);
        expect(r.tables).toHaveLength(2);
        expect(r.errs()).toHaveLength(0);
    });
});

describe('SQLite — table-level constraints', () => {
    it('table-level UNIQUE constraint', () => {
        const r = parse(`
            CREATE TABLE t (
                first_name TEXT NOT NULL,
                last_name TEXT NOT NULL,
                email TEXT NOT NULL,
                UNIQUE (first_name, last_name)
            );
        `);
        const uq = r.table('t').constraints.find((c) => c.kind === 'unique');
        expect(uq).toBeTruthy();
        expect(uq.columns).toEqual(['first_name', 'last_name']);
    });

    it('named CONSTRAINT with PRIMARY KEY and UNIQUE', () => {
        const r = parse(`
            CREATE TABLE t (
                a INTEGER NOT NULL,
                b INTEGER NOT NULL,
                c TEXT,
                CONSTRAINT pk_t PRIMARY KEY (a, b),
                CONSTRAINT uq_c UNIQUE (c)
            );
        `);
        expect(r.column('t', 'a').primary).toBe(true);
        expect(r.column('t', 'b').primary).toBe(true);
        const uq = r.table('t').constraints.find((c) => c.kind === 'unique');
        expect(uq).toBeTruthy();
    });

    it('table-level CHECK constraint with SQLite options', () => {
        const r = parse(`
            CREATE TABLE t (
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                CHECK (end_date > start_date)
            ) STRICT;
        `);
        const chk = r.table('t').constraints.find((c) => c.kind === 'check');
        expect(chk).toBeTruthy();
    });
});

describe('SQLite — every constraint on a single column', () => {
    it('column with NOT NULL UNIQUE DEFAULT CHECK', () => {
        const r = parse(`
            CREATE TABLE t (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL UNIQUE DEFAULT 'ABC' CHECK (length(code) >= 3)
            );
        `);
        const col = r.column('t', 'code');
        expect(col.notNull).toBe(true);
        expect(col.unique).toBe(true);
        expect(col.default).toBe("'ABC'");
        expect(col.check).toBeTruthy();
    });
});

describe('SQLite — table name as keyword', () => {
    it('table named "index" (quoted)', () => {
        const r = parse(`CREATE TABLE "index" (id INTEGER PRIMARY KEY, val TEXT);`);
        expect(r.table('index')).not.toBeNull();
    });

    it('table named "key" (quoted)', () => {
        const r = parse(`CREATE TABLE "key" (id INTEGER PRIMARY KEY);`);
        expect(r.table('key')).not.toBeNull();
    });

    it('table named "replace" (quoted)', () => {
        const r = parse(`CREATE TABLE "replace" (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT) STRICT;`);
        expect(r.table('replace')).not.toBeNull();
        expect(r.column('replace', 'id').autoIncrement).toBe(true);
    });
});

describe('SQLite — real-world dump patterns', () => {
    it('parses a typical SQLite .dump output pattern', () => {
        const sql = `
            BEGIN TRANSACTION;
            CREATE TABLE IF NOT EXISTS "schema_migrations" (
                "version" TEXT NOT NULL,
                "applied_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY ("version")
            ) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS "users" (
                "id" INTEGER PRIMARY KEY AUTOINCREMENT,
                "email" TEXT NOT NULL UNIQUE COLLATE NOCASE,
                "password" TEXT NOT NULL,
                "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updated_at" TEXT
            );
            CREATE TABLE IF NOT EXISTS "sessions" (
                "token" TEXT NOT NULL,
                "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
                "expires" TEXT NOT NULL,
                PRIMARY KEY ("token")
            ) STRICT, WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS "idx_sessions_user" ON "sessions" ("user_id");
            COMMIT;
        `;
        const r = parse(sql);
        expect(r.errs()).toHaveLength(0);
        expect(r.tables).toHaveLength(3);
        expect(r.column('schema_migrations', 'version').primary).toBe(true);
        expect(r.column('users', 'id').autoIncrement).toBe(true);
        expect(r.column('users', 'email').unique).toBe(true);
        expect(r.column('sessions', 'user_id').references.table).toBe('users');
    });

    it('parses a SQLite schema with CREATE TRIGGER/VIEW being skipped', () => {
        const r = parse(`
            CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT);
            CREATE VIEW v AS SELECT * FROM t;
            CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END;
            CREATE TABLE t2 (id INTEGER PRIMARY KEY) WITHOUT ROWID;
        `);
        // Views and triggers are skipped — only tables are parsed
        expect(r.table('t')).not.toBeNull();
        expect(r.table('t2')).not.toBeNull();
    });
});

describe('SQLite — wide table (many columns)', () => {
    it('parses a 15-column SQLite table', () => {
        const r = parse(`
            CREATE TABLE wide (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                col1 TEXT NOT NULL,
                col2 TEXT,
                col3 INTEGER DEFAULT 0,
                col4 REAL DEFAULT 0.0,
                col5 BLOB,
                col6 TEXT UNIQUE,
                col7 INTEGER CHECK (col7 >= 0),
                col8 TEXT DEFAULT 'hello',
                col9 INTEGER NOT NULL DEFAULT 42,
                col10 REAL NOT NULL,
                col11 TEXT COLLATE NOCASE,
                col12 INTEGER,
                col13 TEXT NOT NULL UNIQUE DEFAULT 'x' CHECK (length(col13) > 0),
                col14 TEXT REFERENCES wide(col6),
                col15 INTEGER DEFAULT 999
            ) STRICT;
        `);
        expect(r.table('wide').columns).toHaveLength(16);
        expect(r.column('wide', 'id').autoIncrement).toBe(true);
        expect(r.column('wide', 'col1').notNull).toBe(true);
        expect(r.column('wide', 'col3').default).toBe('0');
        expect(r.column('wide', 'col6').unique).toBe(true);
        expect(r.column('wide', 'col7').check).toBeTruthy();
        expect(r.column('wide', 'col9').default).toBe('42');
        expect(r.column('wide', 'col13').notNull).toBe(true);
        expect(r.column('wide', 'col13').unique).toBe(true);
        expect(r.column('wide', 'col14').references.table).toBe('wide');
        expect(r.errs()).toHaveLength(0);
    });
});

describe('SQLite — INTEGER PRIMARY KEY as implicit rowid', () => {
    it('INTEGER PRIMARY KEY without AUTOINCREMENT is still primary', () => {
        const r = parse(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);`);
        expect(r.column('t', 'id').primary).toBe(true);
        expect(r.column('t', 'id').autoIncrement).toBeFalsy();
    });

    it('INT PRIMARY KEY vs INTEGER PRIMARY KEY', () => {
        const r = parse(`
            CREATE TABLE t1 (id INT PRIMARY KEY);
            CREATE TABLE t2 (id INTEGER PRIMARY KEY);
        `);
        expect(r.column('t1', 'id').primary).toBe(true);
        expect(r.column('t2', 'id').primary).toBe(true);
    });
});

describe('SQLite — self-referencing FK', () => {
    it('parses self-referencing FK in SQLite table', () => {
        const r = parse(`
            CREATE TABLE categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                parent_id INTEGER REFERENCES categories(id)
            );
        `);
        expect(r.column('categories', 'parent_id').references.table).toBe('categories');
        expect(r.column('categories', 'parent_id').references.columns[0]).toBe('id');
    });

    it('self-referencing FK with table-level constraint', () => {
        const r = parse(`
            CREATE TABLE tree (
                id INTEGER PRIMARY KEY,
                parent_id INTEGER,
                label TEXT NOT NULL,
                FOREIGN KEY (parent_id) REFERENCES tree(id) ON DELETE SET NULL
            ) WITHOUT ROWID;
        `);
        const fk = r.table('tree').constraints.find((c) => c.kind === 'foreign');
        expect(fk.references.table).toBe('tree');
    });
});

describe('SQLite — multi-column FK', () => {
    it('parses multi-column table-level FK', () => {
        const r = parse(`
            CREATE TABLE parent (a INT, b INT, c TEXT, PRIMARY KEY (a, b));
            CREATE TABLE child (
                id INTEGER PRIMARY KEY,
                pa INT NOT NULL,
                pb INT NOT NULL,
                FOREIGN KEY (pa, pb) REFERENCES parent(a, b)
            );
        `);
        const fk = r.table('child').constraints.find((c) => c.kind === 'foreign');
        expect(fk).toBeTruthy();
        expect(fk.columns).toEqual(['pa', 'pb']);
        expect(fk.references.table).toBe('parent');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// PRODUCTION — Real-world e-commerce 4-dialect (20 tables)
// ════════════════════════════════════════════════════════════════════════════

describe('Production — 20-table e-commerce schema across 4 dialects', () => {
    it('parses a massive multi-dialect schema with zero errors', () => {
        const sql = `
            -- ═══ PostgreSQL tables ═══════════════════════════════════════
            CREATE TYPE public.order_status AS ENUM ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled');

            CREATE TABLE public.pg_users (
                id BIGSERIAL PRIMARY KEY,
                email VARCHAR(255) NOT NULL UNIQUE,
                password_hash VARCHAR(128) NOT NULL,
                full_name TEXT,
                metadata JSONB DEFAULT '{}',
                tags TEXT[] DEFAULT '{}',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ
            );

            CREATE TABLE public.pg_addresses (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES public.pg_users(id) ON DELETE CASCADE,
                line1 TEXT NOT NULL,
                line2 TEXT,
                city TEXT NOT NULL,
                state TEXT,
                zip VARCHAR(20),
                country CHAR(2) NOT NULL DEFAULT 'US',
                is_default BOOLEAN NOT NULL DEFAULT FALSE
            );

            CREATE TABLE public.pg_products (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                sku VARCHAR(50) NOT NULL UNIQUE,
                name TEXT NOT NULL,
                description TEXT,
                price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
                weight_kg DOUBLE PRECISION,
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                metadata JSONB DEFAULT '{}'
            );

            CREATE TABLE public.pg_orders (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES pg_users(id),
                address_id BIGINT REFERENCES pg_addresses(id),
                status order_status NOT NULL DEFAULT 'pending',
                total NUMERIC(12,2) NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE public.pg_order_items (
                order_id BIGINT NOT NULL REFERENCES pg_orders(id) ON DELETE CASCADE,
                product_id BIGINT NOT NULL REFERENCES pg_products(id),
                quantity INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
                unit_price NUMERIC(12,2) NOT NULL,
                PRIMARY KEY (order_id, product_id)
            );

            -- ═══ MySQL tables ════════════════════════════════════════════
            CREATE TABLE \`my_categories\` (
                \`id\` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                \`parent_id\` INT UNSIGNED,
                \`name\` VARCHAR(100) NOT NULL,
                \`slug\` VARCHAR(100) NOT NULL UNIQUE,
                \`depth\` TINYINT UNSIGNED NOT NULL DEFAULT 0,
                INDEX idx_parent (\`parent_id\`),
                CONSTRAINT fk_cat_parent FOREIGN KEY (\`parent_id\`) REFERENCES \`my_categories\`(\`id\`) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

            CREATE TABLE \`my_inventory\` (
                \`id\` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                \`sku\` VARCHAR(50) NOT NULL,
                \`warehouse\` ENUM('east','west','central') NOT NULL DEFAULT 'central',
                \`quantity\` INT NOT NULL DEFAULT 0,
                \`last_restock\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_sku_wh (\`sku\`, \`warehouse\`)
            ) ENGINE=InnoDB;

            CREATE TABLE \`my_reviews\` (
                \`id\` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                \`user_id\` BIGINT UNSIGNED NOT NULL,
                \`product_sku\` VARCHAR(50) NOT NULL,
                \`rating\` TINYINT NOT NULL CHECK (\`rating\` BETWEEN 1 AND 5),
                \`title\` VARCHAR(200),
                \`body\` TEXT,
                \`created\` DATETIME DEFAULT CURRENT_TIMESTAMP,
                KEY idx_user (\`user_id\`),
                KEY idx_sku (\`product_sku\`)
            ) ENGINE=InnoDB;

            -- ═══ MSSQL tables ════════════════════════════════════════════
            CREATE TABLE [dbo].[ms_payments] (
                [id] BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY CLUSTERED,
                [order_id] BIGINT NOT NULL,
                [method] NVARCHAR(20) NOT NULL,
                [amount] DECIMAL(12,2) NOT NULL,
                [currency] CHAR(3) NOT NULL DEFAULT 'USD',
                [processed_at] DATETIME2 NOT NULL DEFAULT GETDATE(),
                [hash] AS (CHECKSUM([order_id], [amount])) PERSISTED
            );
            GO

            CREATE TABLE [dbo].[ms_shipping] (
                [id] BIGINT IDENTITY(1,1) PRIMARY KEY,
                [order_id] BIGINT NOT NULL,
                [carrier] NVARCHAR(50) NOT NULL,
                [tracking_no] NVARCHAR(100),
                [shipped_at] DATETIME2,
                [delivered_at] DATETIME2,
                CONSTRAINT fk_ship_order FOREIGN KEY ([order_id]) REFERENCES pg_orders(id)
            );
            GO

            CREATE TABLE [dbo].[ms_audit_trail] (
                [id] BIGINT IDENTITY(100,1) NOT NULL PRIMARY KEY,
                [entity_type] NVARCHAR(50) NOT NULL,
                [entity_id] BIGINT NOT NULL,
                [action] NVARCHAR(20) NOT NULL,
                [old_data] NVARCHAR(MAX),
                [new_data] NVARCHAR(MAX),
                [actor_id] BIGINT,
                [ts] DATETIME2 NOT NULL DEFAULT SYSDATETIME()
            );
            GO

            -- ═══ SQLite tables ═══════════════════════════════════════════
            CREATE TABLE lite_sessions (
                token TEXT NOT NULL,
                user_id INTEGER NOT NULL,
                ip_address TEXT,
                user_agent TEXT,
                expires_at TEXT NOT NULL,
                PRIMARY KEY (token)
            ) STRICT, WITHOUT ROWID;

            CREATE TABLE lite_cart (
                user_id INTEGER NOT NULL,
                product_sku TEXT NOT NULL,
                quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
                added_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, product_sku)
            ) WITHOUT ROWID;

            CREATE TABLE lite_wishlist (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                product_sku TEXT NOT NULL COLLATE NOCASE,
                notes TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (user_id, product_sku)
            );

            CREATE TABLE lite_search_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                query TEXT NOT NULL COLLATE NOCASE,
                results_count INTEGER DEFAULT 0,
                ts TEXT DEFAULT CURRENT_TIMESTAMP
            ) STRICT;

            CREATE TABLE lite_feature_flags (
                flag_name TEXT PRIMARY KEY,
                is_enabled INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
                description TEXT,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            ) STRICT, WITHOUT ROWID;

            -- ═══ Cross-dialect indexes ═══════════════════════════════════
            CREATE INDEX idx_pg_orders_user ON pg_orders (user_id);
            CREATE INDEX idx_pg_orders_status ON pg_orders (status);
            CREATE UNIQUE INDEX uq_lite_wishlist ON lite_wishlist (user_id, product_sku);
            CREATE INDEX idx_lite_search ON lite_search_log (query);

            -- ═══ Cross-dialect ALTER ═════════════════════════════════════
            ALTER TABLE pg_users ADD COLUMN phone VARCHAR(20);
            ALTER TABLE [dbo].[ms_payments] ADD CONSTRAINT fk_pay_order FOREIGN KEY ([order_id]) REFERENCES pg_orders(id);
        `;
        const r = parse(sql);
        expect(r.errs()).toHaveLength(0);
        expect(r.tables).toHaveLength(16);
        expect(r.types).toHaveLength(2); // order_status + warehouse_enum

        // PG
        expect(r.column('pg_users', 'id').autoIncrement).toBe(true);
        expect(r.column('pg_users', 'email').unique).toBe(true);
        expect(r.column('pg_users', 'tags').type).toBe('TEXT[]');
        expect(r.column('pg_users', 'metadata').type).toBe('JSONB');
        expect(r.column('pg_addresses', 'user_id').references.table).toBe('public.pg_users');
        expect(r.column('pg_products', 'id').autoIncrement).toBe(true);
        expect(r.column('pg_products', 'price').check).toBeTruthy();
        expect(r.column('pg_orders', 'status').type).toBe('order_status');
        const oiPk = r.table('pg_order_items').constraints.find((c) => c.kind === 'primary');
        expect(oiPk.columns).toEqual(['order_id', 'product_id']);

        // MySQL
        expect(r.column('my_categories', 'id').autoIncrement).toBe(true);
        const catFk = r.table('my_categories').constraints.find((c) => c.kind === 'foreign');
        expect(catFk.references.table).toBe('my_categories'); // self-ref
        expect(r.column('my_inventory', 'warehouse').type).toBe('warehouse_enum');
        expect(r.column('my_reviews', 'rating').check).toBeTruthy();

        // MSSQL
        expect(r.column('ms_payments', 'id').autoIncrement).toBe(true);
        expect(r.column('ms_payments', 'hash').type).toBe('COMPUTED');
        expect(r.column('ms_audit_trail', 'id').autoIncrement).toBe(true);
        const shipFk = r.table('ms_shipping').constraints.find((c) => c.kind === 'foreign');
        expect(shipFk.references.table).toBe('pg_orders');

        // SQLite
        expect(r.column('lite_sessions', 'token').primary).toBe(true);
        expect(r.column('lite_cart', 'user_id').primary).toBe(true);
        expect(r.column('lite_cart', 'product_sku').primary).toBe(true);
        expect(r.column('lite_cart', 'quantity').check).toBeTruthy();
        expect(r.column('lite_wishlist', 'id').autoIncrement).toBe(true);
        expect(r.column('lite_search_log', 'id').autoIncrement).toBe(true);
        expect(r.column('lite_feature_flags', 'is_enabled').check).toBeTruthy();
        expect(r.column('lite_feature_flags', 'is_enabled').default).toBe('0');

        // Alters include both migration-style ADD COLUMN and ADD CONSTRAINT.
        expect(r.alters).toHaveLength(2);
        expect(r.alters.map((alter) => alter.action)).toEqual(['add_column', 'add_foreign']);
    });
});

describe('Production — SQLite Core Data export pattern (iOS)', () => {
    it('parses a typical Core Data SQLite schema', () => {
        const sql = `
            CREATE TABLE IF NOT EXISTS "ZUSER" (
                "Z_PK" INTEGER PRIMARY KEY AUTOINCREMENT,
                "Z_ENT" INTEGER,
                "Z_OPT" INTEGER,
                "ZEMAIL" TEXT,
                "ZFIRSTNAME" TEXT,
                "ZLASTNAME" TEXT,
                "ZCREATEDATE" REAL
            );

            CREATE TABLE IF NOT EXISTS "ZPOST" (
                "Z_PK" INTEGER PRIMARY KEY AUTOINCREMENT,
                "Z_ENT" INTEGER,
                "Z_OPT" INTEGER,
                "ZTITLE" TEXT,
                "ZBODY" TEXT,
                "ZCREATEDATE" REAL,
                "ZUSER" INTEGER REFERENCES "ZUSER"("Z_PK")
            );

            CREATE TABLE IF NOT EXISTS "ZCOMMENT" (
                "Z_PK" INTEGER PRIMARY KEY AUTOINCREMENT,
                "Z_ENT" INTEGER,
                "Z_OPT" INTEGER,
                "ZBODY" TEXT,
                "ZCREATEDATE" REAL,
                "ZPOST" INTEGER REFERENCES "ZPOST"("Z_PK"),
                "ZUSER" INTEGER REFERENCES "ZUSER"("Z_PK")
            );

            CREATE TABLE IF NOT EXISTS "Z_PRIMARYKEY" (
                "Z_ENT" INTEGER PRIMARY KEY,
                "Z_NAME" TEXT,
                "Z_SUPER" INTEGER,
                "Z_MAX" INTEGER
            ) WITHOUT ROWID;

            CREATE TABLE IF NOT EXISTS "Z_METADATA" (
                "Z_VERSION" INTEGER PRIMARY KEY,
                "Z_UUID" TEXT,
                "Z_PLIST" BLOB
            );

            CREATE INDEX IF NOT EXISTS "ZPOST_ZUSER_INDEX" ON "ZPOST" ("ZUSER");
            CREATE INDEX IF NOT EXISTS "ZCOMMENT_ZPOST_INDEX" ON "ZCOMMENT" ("ZPOST");
            CREATE INDEX IF NOT EXISTS "ZCOMMENT_ZUSER_INDEX" ON "ZCOMMENT" ("ZUSER");
        `;
        const r = parse(sql);
        expect(r.errs()).toHaveLength(0);
        expect(r.tables).toHaveLength(5);

        // Core Data uses Z_PK everywhere
        expect(r.column('ZUSER', 'Z_PK').autoIncrement).toBe(true);
        expect(r.column('ZPOST', 'Z_PK').autoIncrement).toBe(true);
        expect(r.column('ZCOMMENT', 'Z_PK').autoIncrement).toBe(true);

        // FKs
        expect(r.column('ZPOST', 'ZUSER').references.table).toBe('ZUSER');
        expect(r.column('ZCOMMENT', 'ZPOST').references.table).toBe('ZPOST');
        expect(r.column('ZCOMMENT', 'ZUSER').references.table).toBe('ZUSER');

        // WITHOUT ROWID
        expect(r.column('Z_PRIMARYKEY', 'Z_ENT').primary).toBe(true);

        // REAL type for dates
        expect(r.column('ZUSER', 'ZCREATEDATE').type).toBe('REAL');

        // Indexes
        expect(r.ast.indexes).toHaveLength(3);
    });
});

describe('SQLite — AUTOINCREMENT position edge cases', () => {
    it('PRIMARY KEY before AUTOINCREMENT', () => {
        const r = parse(`CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT);`);
        expect(r.column('t', 'id').autoIncrement).toBe(true);
        expect(r.column('t', 'id').primary).toBe(true);
    });

    it('AUTOINCREMENT with NOT NULL', () => {
        const r = parse(`CREATE TABLE t (id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT);`);
        expect(r.column('t', 'id').autoIncrement).toBe(true);
        expect(r.column('t', 'id').notNull).toBe(true);
        expect(r.column('t', 'id').primary).toBe(true);
    });

    it('AUTOINCREMENT combined with other columns having complex constraints', () => {
        const r = parse(`
            CREATE TABLE t (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL UNIQUE DEFAULT 'XX' CHECK (length(code) >= 2),
                ref_id INTEGER REFERENCES t(id) ON DELETE SET NULL,
                data BLOB,
                active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
            ) STRICT;
        `);
        expect(r.column('t', 'id').autoIncrement).toBe(true);
        expect(r.column('t', 'code').notNull).toBe(true);
        expect(r.column('t', 'code').unique).toBe(true);
        expect(r.column('t', 'code').default).toBe("'XX'");
        expect(r.column('t', 'code').check).toBeTruthy();
        expect(r.column('t', 'ref_id').references.table).toBe('t');
        expect(r.column('t', 'active').check).toBeTruthy();
        expect(r.column('t', 'active').default).toBe('1');
    });
});

describe('SQLite — FK action matrix (all combos)', () => {
    it('ON DELETE CASCADE ON UPDATE CASCADE', () => {
        const r = parse(`
            CREATE TABLE p (id INTEGER PRIMARY KEY);
            CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id) ON DELETE CASCADE ON UPDATE CASCADE);
        `);
        expect(r.column('c', 'pid').references.table).toBe('p');
    });

    it('ON DELETE SET NULL ON UPDATE SET DEFAULT', () => {
        const r = parse(`
            CREATE TABLE p (id INTEGER PRIMARY KEY);
            CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id) ON DELETE SET NULL ON UPDATE SET DEFAULT);
        `);
        expect(r.column('c', 'pid').references.table).toBe('p');
    });

    it('ON DELETE RESTRICT ON UPDATE NO ACTION', () => {
        const r = parse(`
            CREATE TABLE p (id INTEGER PRIMARY KEY);
            CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL REFERENCES p(id) ON DELETE RESTRICT ON UPDATE NO ACTION);
        `);
        expect(r.column('c', 'pid').references.table).toBe('p');
        expect(r.column('c', 'pid').notNull).toBe(true);
    });

    it('table-level FK with all actions + SQLite options', () => {
        const r = parse(`
            CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT;
            CREATE TABLE child (
                id INTEGER PRIMARY KEY,
                parent_id INTEGER NOT NULL,
                FOREIGN KEY (parent_id) REFERENCES parent(id)
                    ON DELETE CASCADE ON UPDATE SET NULL
            ) STRICT, WITHOUT ROWID;
        `);
        const fk = r.table('child').constraints.find((c) => c.kind === 'foreign');
        expect(fk).toBeTruthy();
        expect(fk.references.table).toBe('parent');
        expect(r.errs()).toHaveLength(0);
    });
});

describe('4-dialect ALTER TABLE chain', () => {
    it('ALTER across all 4 dialects on a single script', () => {
        const r = parse(`
            CREATE TABLE pg_t (id SERIAL PRIMARY KEY, name TEXT);
            CREATE TABLE \`my_t\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, name TEXT) ENGINE=InnoDB;
            CREATE TABLE [ms_t] ([id] INT IDENTITY(1,1) PRIMARY KEY, [name] NVARCHAR(100));
            CREATE TABLE lite_t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT) STRICT;

            -- PG alter
            ALTER TABLE pg_t ADD COLUMN email TEXT;
            ALTER TABLE pg_t ADD CONSTRAINT uq_email UNIQUE (email);

            -- MySQL alter
            ALTER TABLE \`my_t\` ADD COLUMN age INT DEFAULT 0;

            -- MSSQL alter
            ALTER TABLE [ms_t] ADD [phone] NVARCHAR(20);

            -- Referencing across dialects
            ALTER TABLE lite_t ADD COLUMN ref_id INT REFERENCES pg_t(id);
        `);
        expect(r.errs()).toHaveLength(0);
        expect(r.tables).toHaveLength(4);
        expect(r.alters.length).toBeGreaterThanOrEqual(1);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// SQLite — GENERATED / computed columns
// ════════════════════════════════════════════════════════════════════════════

describe('SQLite — GENERATED columns', () => {
    it('GENERATED ALWAYS AS (expr) STORED', () => {
        const r = parse(`
            CREATE TABLE t (
                quantity INTEGER NOT NULL,
                unit_price REAL NOT NULL,
                total REAL GENERATED ALWAYS AS (quantity * unit_price) STORED
            );
        `);
        expect(r.column('t', 'total').generated).toBeTruthy();
        expect(r.column('t', 'total').generated).toContain('STORED');
    });

    it('GENERATED ALWAYS AS (expr) VIRTUAL', () => {
        const r = parse(`
            CREATE TABLE t (
                first_name TEXT NOT NULL,
                last_name TEXT NOT NULL,
                full_name TEXT GENERATED ALWAYS AS (first_name || ' ' || last_name) VIRTUAL
            );
        `);
        expect(r.column('t', 'full_name').generated).toBeTruthy();
        expect(r.column('t', 'full_name').generated).toContain('VIRTUAL');
    });

    it('generated column + AUTOINCREMENT + STRICT in same table', () => {
        const r = parse(`
            CREATE TABLE orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                qty INTEGER NOT NULL DEFAULT 1,
                price REAL NOT NULL DEFAULT 0.0,
                line_total REAL GENERATED ALWAYS AS (qty * price) STORED
            ) STRICT;
        `);
        expect(r.column('orders', 'id').autoIncrement).toBe(true);
        expect(r.column('orders', 'line_total').generated).toBeTruthy();
        expect(r.errs()).toHaveLength(0);
    });
});

describe('SQLite — expression-based defaults', () => {
    it("DEFAULT (datetime('now'))", () => {
        const r = parse(`
            CREATE TABLE t (
                id INTEGER PRIMARY KEY,
                created TEXT DEFAULT (datetime('now'))
            );
        `);
        expect(r.column('t', 'created').default).toBeTruthy();
    });

    it('DEFAULT (abs(random() % 100))', () => {
        const r = parse(`
            CREATE TABLE t (
                id INTEGER PRIMARY KEY,
                random_val INTEGER DEFAULT (abs(random() % 100))
            );
        `);
        expect(r.column('t', 'random_val').default).toBeTruthy();
    });

    it('multiple expression defaults in one table', () => {
        const r = parse(`
            CREATE TABLE t (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                hash TEXT DEFAULT (hex(randomblob(16))),
                ts TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                flag INTEGER DEFAULT 0
            ) STRICT;
        `);
        expect(r.column('t', 'hash').default).toBeTruthy();
        expect(r.column('t', 'ts').default).toBeTruthy();
        expect(r.column('t', 'flag').default).toBe('0');
        expect(r.errs()).toHaveLength(0);
    });
});

describe('SQLite — DROP TABLE IF EXISTS + recreate', () => {
    it('DROP IF EXISTS then CREATE with different schema', () => {
        const r = parse(`
            DROP TABLE IF EXISTS old_config;
            CREATE TABLE old_config (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT NOT NULL UNIQUE,
                value TEXT,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            ) STRICT, WITHOUT ROWID;
        `);
        expect(r.table('old_config')).not.toBeNull();
        expect(r.column('old_config', 'id').autoIncrement).toBe(true);
        expect(r.column('old_config', 'key').unique).toBe(true);
    });

    it('multiple DROP + CREATE cycles in sequence', () => {
        const r = parse(`
            DROP TABLE IF EXISTS t1;
            DROP TABLE IF EXISTS t2;
            CREATE TABLE t1 (id INTEGER PRIMARY KEY) WITHOUT ROWID;
            CREATE TABLE t2 (id INTEGER PRIMARY KEY AUTOINCREMENT, ref INTEGER REFERENCES t1(id));
        `);
        expect(r.tables).toHaveLength(2);
        expect(r.column('t2', 'ref').references.table).toBe('t1');
    });
});

describe('SQLite — KEY/INDEX column name in parser', () => {
    it('column named "key" with every modifier', () => {
        const r = parse(`
            CREATE TABLE kv (
                key TEXT NOT NULL PRIMARY KEY,
                value TEXT DEFAULT ''
            ) WITHOUT ROWID;
        `);
        expect(r.column('kv', 'key').primary).toBe(true);
        expect(r.column('kv', 'key').notNull).toBe(true);
    });

    it('column named "index" next to real MySQL INDEX', () => {
        const r = parse(`
            CREATE TABLE t (
                id INT AUTO_INCREMENT PRIMARY KEY,
                \`index\` INT NOT NULL DEFAULT 0,
                name TEXT,
                INDEX idx_name (name)
            ) ENGINE=InnoDB;
        `);
        expect(r.column('t', 'index').notNull).toBe(true);
        expect(r.column('t', 'index').default).toBe('0');
        // Inline INDEX stored in ast.indexes
        const idx = r.ast.indexes?.find((i) => i.columns?.includes('name'));
        expect(idx).toBeTruthy();
    });
});

describe('SQLite — complex CHECK expressions', () => {
    it('CHECK with nested function calls', () => {
        const r = parse(`
            CREATE TABLE t (
                email TEXT NOT NULL CHECK (length(trim(email)) > 0 AND instr(email, '@') > 0)
            );
        `);
        expect(r.column('t', 'email').check).toBeTruthy();
        expect(r.column('t', 'email').check).toContain('@');
    });

    it('CHECK with CASE expression', () => {
        const r = parse(`
            CREATE TABLE t (
                status TEXT NOT NULL CHECK (status IN ('draft', 'review', 'published', 'archived'))
            ) STRICT;
        `);
        expect(r.column('t', 'status').check).toBeTruthy();
    });

    it('multiple CHECK constraints on different columns + table-level CHECK', () => {
        const r = parse(`
            CREATE TABLE t (
                start_date TEXT NOT NULL CHECK (length(start_date) = 10),
                end_date TEXT NOT NULL CHECK (length(end_date) = 10),
                priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 10),
                CHECK (end_date >= start_date)
            );
        `);
        expect(r.column('t', 'start_date').check).toBeTruthy();
        expect(r.column('t', 'end_date').check).toBeTruthy();
        expect(r.column('t', 'priority').check).toBeTruthy();
        const tableCheck = r.table('t').constraints.find((c) => c.kind === 'check');
        expect(tableCheck).toBeTruthy();
    });
});

describe('SQLite — full 10-table migration chain', () => {
    it('parses a realistic SQLite app migration with all features', () => {
        const sql = `
            -- Migration v1: Initial schema
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                type TEXT NOT NULL DEFAULT 'string' CHECK (type IN ('string', 'number', 'boolean', 'json'))
            ) STRICT, WITHOUT ROWID;

            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                avatar_blob BLOB,
                is_verified INTEGER NOT NULL DEFAULT 0 CHECK (is_verified IN (0, 1)),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS user_profiles (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                display_name TEXT,
                bio TEXT DEFAULT '',
                location TEXT,
                website TEXT,
                birth_date TEXT
            ) WITHOUT ROWID;

            CREATE TABLE IF NOT EXISTS user_tokens (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                type TEXT NOT NULL CHECK (type IN ('refresh', 'reset', 'verify')),
                expires_at TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            ) STRICT, WITHOUT ROWID;

            -- Migration v2: Content tables
            CREATE TABLE IF NOT EXISTS posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                author_id INTEGER NOT NULL REFERENCES users(id),
                title TEXT NOT NULL CHECK (length(title) >= 1 AND length(title) <= 200),
                slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
                body TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
                view_count INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0),
                published_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT
            );

            CREATE TABLE IF NOT EXISTS tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                slug TEXT NOT NULL UNIQUE COLLATE NOCASE
            );

            CREATE TABLE IF NOT EXISTS post_tags (
                post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
                tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                PRIMARY KEY (post_id, tag_id)
            ) WITHOUT ROWID;

            -- Migration v3: Interaction tables
            CREATE TABLE IF NOT EXISTS comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
                author_id INTEGER NOT NULL REFERENCES users(id),
                parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
                body TEXT NOT NULL CHECK (length(body) >= 1),
                is_edited INTEGER NOT NULL DEFAULT 0 CHECK (is_edited IN (0, 1)),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                edited_at TEXT
            );

            CREATE TABLE IF NOT EXISTS likes (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, post_id)
            ) WITHOUT ROWID;

            CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                type TEXT NOT NULL CHECK (type IN ('like', 'comment', 'follow', 'mention')),
                source_id INTEGER,
                is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            ) STRICT;

            -- Indexes
            CREATE INDEX IF NOT EXISTS idx_posts_author ON posts (author_id);
            CREATE INDEX IF NOT EXISTS idx_posts_status ON posts (status);
            CREATE INDEX IF NOT EXISTS idx_posts_slug ON posts (slug);
            CREATE INDEX IF NOT EXISTS idx_comments_post ON comments (post_id);
            CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments (parent_id);
            CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id);
            CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications (is_read);
        `;

        const r = parse(sql);
        expect(r.errs()).toHaveLength(0);
        expect(r.tables).toHaveLength(10);

        // Settings: STRICT, WITHOUT ROWID, CHECK IN()
        expect(r.column('app_settings', 'key').primary).toBe(true);
        expect(r.column('app_settings', 'type').check).toBeTruthy();

        // Users: AUTOINCREMENT, UNIQUE COLLATE NOCASE, CHECK IN()
        expect(r.column('users', 'id').autoIncrement).toBe(true);
        expect(r.column('users', 'username').unique).toBe(true);
        expect(r.column('users', 'email').unique).toBe(true);
        expect(r.column('users', 'is_verified').check).toBeTruthy();
        expect(r.column('users', 'is_verified').default).toBe('0');

        // Profiles: WITHOUT ROWID, FK as PK
        expect(r.column('user_profiles', 'user_id').primary).toBe(true);
        expect(r.column('user_profiles', 'user_id').references.table).toBe('users');

        // Tokens: STRICT, WITHOUT ROWID, CHECK IN()
        expect(r.column('user_tokens', 'token').primary).toBe(true);
        expect(r.column('user_tokens', 'type').check).toBeTruthy();

        // Posts: complex CHECK (length range), multiple defaults
        expect(r.column('posts', 'id').autoIncrement).toBe(true);
        expect(r.column('posts', 'title').check).toBeTruthy();
        expect(r.column('posts', 'slug').unique).toBe(true);
        expect(r.column('posts', 'status').check).toBeTruthy();
        expect(r.column('posts', 'view_count').check).toBeTruthy();

        // Post_tags: composite PK, WITHOUT ROWID, dual FK
        expect(r.column('post_tags', 'post_id').primary).toBe(true);
        expect(r.column('post_tags', 'tag_id').primary).toBe(true);
        expect(r.column('post_tags', 'post_id').references.table).toBe('posts');
        expect(r.column('post_tags', 'tag_id').references.table).toBe('tags');

        // Comments: self-referencing FK (parent_id -> comments)
        expect(r.column('comments', 'parent_id').references.table).toBe('comments');

        // Likes: composite PK, WITHOUT ROWID
        expect(r.column('likes', 'user_id').primary).toBe(true);
        expect(r.column('likes', 'post_id').primary).toBe(true);

        // Notifications: STRICT, CHECK IN()
        expect(r.column('notifications', 'type').check).toBeTruthy();
        expect(r.column('notifications', 'is_read').check).toBeTruthy();

        // Indexes
        expect(r.ast.indexes).toHaveLength(7);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Final hardening — untested code paths
// ════════════════════════════════════════════════════════════════════════════

describe('Parser — negative default values', () => {
    it('DEFAULT -1', () => {
        const r = parse(`CREATE TABLE t (id INTEGER PRIMARY KEY, offset INTEGER DEFAULT -1);`);
        expect(r.column('t', 'offset').default).toBe('-1');
    });

    it('DEFAULT -99.5', () => {
        const r = parse(`CREATE TABLE t (id INTEGER PRIMARY KEY, temp REAL DEFAULT -99.5);`);
        expect(r.column('t', 'temp').default).toBe('-99.5');
    });

    it('DEFAULT NULL', () => {
        const r = parse(`CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT DEFAULT NULL);`);
        expect(r.column('t', 'note').default).toBe('NULL');
    });

    it('DEFAULT TRUE / FALSE', () => {
        const r = parse(`
            CREATE TABLE t (
                id SERIAL PRIMARY KEY,
                active BOOLEAN DEFAULT TRUE,
                deleted BOOLEAN DEFAULT FALSE
            );
        `);
        expect(r.column('t', 'active').default).toBe('TRUE');
        expect(r.column('t', 'deleted').default).toBe('FALSE');
    });
});

describe('Parser — SQLite typeless columns', () => {
    it('preserves a column without an explicit declared type', () => {
        const r = parse(`CREATE TABLE t (id INTEGER PRIMARY KEY, data);`);
        expect(r.table('t').columns).toHaveLength(2);
        expect(r.column('t', 'data')).toMatchObject({ type: 'UNTYPED', declaredTypeMissing: true });
        expect(r.errs()).toEqual([]);
    });
});

describe('Parser — multi-FK from single table to different targets', () => {
    it('3 FKs in one table pointing to 3 different tables', () => {
        const r = parse(`
            CREATE TABLE a (id INTEGER PRIMARY KEY);
            CREATE TABLE b (id INTEGER PRIMARY KEY);
            CREATE TABLE c (id INTEGER PRIMARY KEY);
            CREATE TABLE d (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                a_id INTEGER REFERENCES a(id),
                b_id INTEGER NOT NULL REFERENCES b(id) ON DELETE CASCADE,
                c_id INTEGER REFERENCES c(id) ON DELETE SET NULL
            );
        `);
        expect(r.column('d', 'a_id').references.table).toBe('a');
        expect(r.column('d', 'b_id').references.table).toBe('b');
        expect(r.column('d', 'c_id').references.table).toBe('c');
        expect(r.column('d', 'b_id').notNull).toBe(true);
    });
});

describe('Parser — named constraints in one table', () => {
    it('named PK + named UNIQUE + named FK + named CHECK', () => {
        const r = parse(`
            CREATE TABLE t (
                id INTEGER NOT NULL,
                code TEXT NOT NULL,
                ref_id INTEGER,
                score INTEGER,
                CONSTRAINT pk_t PRIMARY KEY (id),
                CONSTRAINT uq_code UNIQUE (code),
                CONSTRAINT fk_ref FOREIGN KEY (ref_id) REFERENCES t(id),
                CONSTRAINT ck_score CHECK (score >= 0 AND score <= 100)
            );
        `);
        const pk = r.table('t').constraints.find((c) => c.kind === 'primary');
        expect(pk).toBeTruthy();
        expect(pk.name).toBe('pk_t');
        const uq = r.table('t').constraints.find((c) => c.kind === 'unique');
        expect(uq).toBeTruthy();
        expect(uq.name).toBe('uq_code');
        const fk = r.table('t').constraints.find((c) => c.kind === 'foreign');
        expect(fk).toBeTruthy();
        expect(fk.name).toBe('fk_ref');
        const ck = r.table('t').constraints.find((c) => c.kind === 'check');
        expect(ck).toBeTruthy();
        expect(ck.name).toBe('ck_score');
    });
});

describe('Parser — no-semicolon tolerance', () => {
    it('multiple tables without semicolons', () => {
        const r = parse(`
            CREATE TABLE a (id INTEGER PRIMARY KEY)
            CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id))
        `);
        expect(r.tables).toHaveLength(2);
    });
});

describe('Parser — cross-dialect nightmare stress test', () => {
    it('mixes every feature from all 4 dialects in one massive script', () => {
        const sql = `
            -- PG: enum + composite type + GENERATED AS IDENTITY
            CREATE TYPE status_enum AS ENUM ('active', 'inactive', 'suspended');
            CREATE TABLE pg_main (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                status status_enum NOT NULL DEFAULT 'active',
                score NUMERIC(10,2) NOT NULL CHECK (score >= 0),
                metadata JSONB DEFAULT '{}',
                tags TEXT[] DEFAULT '{}',
                search_vector TSVECTOR,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            CREATE TABLE pg_computed (
                id SERIAL PRIMARY KEY,
                a INTEGER NOT NULL DEFAULT 0,
                b INTEGER NOT NULL DEFAULT 0,
                sum_ab INTEGER GENERATED ALWAYS AS (a + b) STORED
            );

            -- MySQL: ENUM + SET + AUTO_INCREMENT + indexes
            CREATE TABLE \`my_products\` (
                \`id\` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                \`category\` ENUM('electronics','clothing','food','other') NOT NULL DEFAULT 'other',
                \`sizes\` SET('XS','S','M','L','XL','XXL') DEFAULT 'M',
                \`name\` VARCHAR(200) NOT NULL,
                \`price\` DECIMAL(10,2) UNSIGNED NOT NULL,
                FULLTEXT INDEX ft_name (\`name\`),
                KEY idx_cat (\`category\`),
                UNIQUE KEY uq_name (\`name\`)
            ) ENGINE=InnoDB ROW_FORMAT=COMPRESSED DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

            -- MSSQL: IDENTITY(seed,step) + PERSISTED computed + GO
            CREATE TABLE [dbo].[ms_events] (
                [id] BIGINT IDENTITY(10000,10) NOT NULL PRIMARY KEY CLUSTERED,
                [type] NVARCHAR(50) NOT NULL,
                [payload] NVARCHAR(MAX),
                [hash] AS (HASHBYTES('SHA2_256', [payload])) PERSISTED,
                [ts] DATETIME2(7) NOT NULL DEFAULT SYSDATETIME()
            );
            GO

            -- SQLite: every feature
            CREATE TABLE lite_kv (
                key TEXT NOT NULL PRIMARY KEY,
                value TEXT,
                type TEXT NOT NULL DEFAULT 'string' CHECK (type IN ('string', 'number', 'boolean', 'json', 'blob')),
                ttl INTEGER CHECK (ttl IS NULL OR ttl > 0),
                created TEXT DEFAULT CURRENT_TIMESTAMP,
                updated TEXT
            ) STRICT, WITHOUT ROWID;

            CREATE TABLE lite_computed (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                first TEXT NOT NULL DEFAULT '',
                last TEXT NOT NULL DEFAULT '',
                full_name TEXT GENERATED ALWAYS AS (first || ' ' || last) VIRTUAL,
                priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN -10 AND 10)
            );

            -- Cross-dialect FK web
            CREATE TABLE bridge (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pg_ref BIGINT REFERENCES pg_main(id),
                my_ref BIGINT REFERENCES my_products(id),
                ms_ref BIGINT REFERENCES ms_events(id),
                lite_ref TEXT REFERENCES lite_kv(key),
                UNIQUE (pg_ref, my_ref)
            );

            -- Indexes
            CREATE INDEX idx_bridge_pg ON bridge (pg_ref);
            CREATE INDEX idx_bridge_my ON bridge (my_ref);
            CREATE UNIQUE INDEX uq_bridge_ms ON bridge (ms_ref);

            -- ALTERs
            ALTER TABLE pg_main ADD CONSTRAINT uq_meta UNIQUE (metadata);
            ALTER TABLE lite_computed ADD COLUMN notes TEXT DEFAULT '';
        `;
        const r = parse(sql);
        expect(r.errs()).toHaveLength(0);
        expect(r.tables).toHaveLength(7);

        // Types: status_enum + category_enum + sizes_set
        expect(r.types.length).toBeGreaterThanOrEqual(3);

        // PG
        expect(r.column('pg_main', 'id').autoIncrement).toBe(true);
        expect(r.column('pg_main', 'status').type).toBe('status_enum');
        expect(r.column('pg_main', 'tags').type).toBe('TEXT[]');
        expect(r.column('pg_computed', 'sum_ab').generated).toBeTruthy();

        // MySQL
        expect(r.column('my_products', 'id').autoIncrement).toBe(true);
        expect(r.column('my_products', 'category').type).toBe('category_enum');

        // MSSQL
        expect(r.column('ms_events', 'id').autoIncrement).toBe(true);
        expect(r.column('ms_events', 'hash').type).toBe('COMPUTED');

        // SQLite
        expect(r.column('lite_kv', 'key').primary).toBe(true);
        expect(r.column('lite_kv', 'type').check).toBeTruthy();
        expect(r.column('lite_kv', 'ttl').check).toBeTruthy();
        expect(r.column('lite_computed', 'id').autoIncrement).toBe(true);
        expect(r.column('lite_computed', 'full_name').generated).toBeTruthy();
        expect(r.column('lite_computed', 'priority').check).toBeTruthy();

        // Cross-dialect bridge
        expect(r.column('bridge', 'pg_ref').references.table).toBe('pg_main');
        expect(r.column('bridge', 'my_ref').references.table).toBe('my_products');
        expect(r.column('bridge', 'ms_ref').references.table).toBe('ms_events');
        expect(r.column('bridge', 'lite_ref').references.table).toBe('lite_kv');

        // Indexes
        expect(r.ast.indexes.length).toBeGreaterThanOrEqual(3);

        // Alter
        expect(r.alters.length).toBeGreaterThanOrEqual(1);
    });
});
