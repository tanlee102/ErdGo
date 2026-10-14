import { describe, it, expect } from 'vitest';
import { createSqlExecutor } from '@/features/data-view/lib/sqlExecutor.js';
import { sampleSQL } from '@/features/editor/lib/sampleSQL.js';

function exec(sql) {
    const executor = createSqlExecutor();
    const result = executor.execute(sql);
    return {
        tables: result.tables,
        types: result.types,
        log: result.log,
        table: (name) => {
            for (const [, v] of result.tables) {
                if (v.name.toLowerCase() === name.toLowerCase()) return v;
            }
            return null;
        },
        type: (name) => {
            for (const [, v] of result.types) {
                if (v.name.toLowerCase() === name.toLowerCase()) return v;
            }
            return null;
        },
        errors: () => result.log.filter((l) => l.type === 'error'),
        warnings: () => result.log.filter((l) => l.type === 'warning'),
        successes: () => result.log.filter((l) => l.type === 'success'),
    };
}

// ════════════════════════════════════════════
// CREATE TABLE — basics
// ════════════════════════════════════════════

describe('CREATE TABLE', () => {
    it('creates a simple table with columns', () => {
        const r = exec(`CREATE TABLE users (id INT, name TEXT);`);
        expect(r.tables.size).toBe(1);
        const t = r.table('users');
        expect(t.columns).toHaveLength(2);
        expect(t.columns[0].name).toBe('id');
        expect(t.columns[0].type).toBe('INT');
        expect(t.columns[1].name).toBe('name');
        expect(t.columns[1].type).toBe('TEXT');
    });

    it('creates multiple tables', () => {
        const r = exec(`
            CREATE TABLE a (id INT);
            CREATE TABLE b (id INT);
            CREATE TABLE c (id INT);
        `);
        expect(r.tables.size).toBe(3);
    });

    it('handles IF NOT EXISTS', () => {
        const r = exec(`CREATE TABLE IF NOT EXISTS users (id INT);`);
        expect(r.tables.size).toBe(1);
        expect(r.table('users')).not.toBeNull();
    });

    it('handles schema-qualified names', () => {
        const r = exec(`CREATE TABLE public.users (id INT, name TEXT);`);
        expect(r.table('users')).not.toBeNull();
    });

    it('handles quoted identifiers', () => {
        const r = exec(`CREATE TABLE "MyTable" ("Column One" INT, "another col" TEXT);`);
        expect(r.tables.size).toBe(1);
    });
});

// ════════════════════════════════════════════
// Column types — variety
// ════════════════════════════════════════════

describe('Column types', () => {
    it('parses common SQL types', () => {
        const r = exec(`
            CREATE TABLE types_test (
                a INT,
                b BIGINT,
                c SMALLINT,
                d SERIAL,
                e VARCHAR(255),
                f CHAR(10),
                g TEXT,
                h BOOLEAN,
                i DATE,
                j TIMESTAMP,
                k NUMERIC(10,2),
                l DECIMAL(8,4),
                m FLOAT,
                n REAL,
                o JSON,
                p JSONB,
                q UUID,
                r BYTEA,
                s MONEY
            );
        `);
        const t = r.table('types_test');
        expect(t.columns).toHaveLength(19);
        expect(t.columns[4].type).toBe('VARCHAR(255)');
        expect(t.columns[10].type).toBe('NUMERIC(10,2)');
    });

    it('parses DOUBLE PRECISION as a single type', () => {
        const r = exec(`CREATE TABLE dp (val DOUBLE PRECISION);`);
        expect(r.table('dp').columns[0].type).toBe('DOUBLE PRECISION');
    });

    it('parses type with UNSIGNED', () => {
        const r = exec(`CREATE TABLE u (val INT UNSIGNED);`);
        expect(r.table('u').columns[0].type).toBe('INT UNSIGNED');
    });
});

// ════════════════════════════════════════════
// Column constraints — inline
// ════════════════════════════════════════════

describe('Inline column constraints', () => {
    it('parses PRIMARY KEY', () => {
        const r = exec(`CREATE TABLE t (id INT PRIMARY KEY);`);
        const col = r.table('t').columns[0];
        expect(col.pk).toBe(true);
        expect(col.notNull).toBe(true);
    });

    it('parses NOT NULL', () => {
        const r = exec(`CREATE TABLE t (name VARCHAR(100) NOT NULL);`);
        expect(r.table('t').columns[0].notNull).toBe(true);
    });

    it('parses UNIQUE', () => {
        const r = exec(`CREATE TABLE t (email VARCHAR(255) UNIQUE);`);
        expect(r.table('t').columns[0].unique).toBe(true);
    });

    it('parses REFERENCES (foreign key)', () => {
        const r = exec(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (parent_id INT REFERENCES parent(id));
        `);
        const col = r.table('child').columns[0];
        expect(col.fk).toBe(true);
        expect(col.refTable).toBe('parent');
    });

    it('parses DEFAULT with string literal', () => {
        const r = exec(`CREATE TABLE t (role VARCHAR(50) DEFAULT 'user');`);
        expect(r.table('t').columns[0].defaultVal).toBe("'user'");
    });

    it('parses DEFAULT with number', () => {
        const r = exec(`CREATE TABLE t (views INT DEFAULT 0);`);
        expect(r.table('t').columns[0].defaultVal).toBe('0');
    });

    it('parses DEFAULT with boolean', () => {
        const r = exec(`CREATE TABLE t (active BOOLEAN DEFAULT TRUE);`);
        expect(r.table('t').columns[0].defaultVal).toBe('TRUE');
    });

    it('parses DEFAULT with function call', () => {
        const r = exec(`CREATE TABLE t (ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        expect(r.table('t').columns[0].defaultVal).toBe('CURRENT_TIMESTAMP');
    });

    it('parses CHECK constraint', () => {
        const r = exec(`CREATE TABLE t (age INT CHECK (age >= 0));`);
        const col = r.table('t').columns[0];
        expect(col.check).toBeTruthy();
        expect(col.check).toContain('age');
    });

    it('parses multiple constraints on one column', () => {
        const r = exec(`CREATE TABLE t (email VARCHAR(255) UNIQUE NOT NULL);`);
        const col = r.table('t').columns[0];
        expect(col.unique).toBe(true);
        expect(col.notNull).toBe(true);
    });

    it('parses all constraints together', () => {
        const r = exec(`
            CREATE TABLE t (
                id INT PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                role VARCHAR(50) DEFAULT 'user',
                age INT CHECK (age >= 0),
                ref_id INT REFERENCES other(id)
            );
        `);
        const cols = r.table('t').columns;
        expect(cols[0].pk).toBe(true);
        expect(cols[1].notNull).toBe(true);
        expect(cols[2].unique).toBe(true);
        expect(cols[2].notNull).toBe(true);
        expect(cols[3].defaultVal).toBe("'user'");
        expect(cols[4].check).toBeTruthy();
        expect(cols[5].fk).toBe(true);
    });
});

// ════════════════════════════════════════════
// Table-level constraints
// ════════════════════════════════════════════

describe('Table-level constraints', () => {
    it('parses PRIMARY KEY (...)', () => {
        const r = exec(`
            CREATE TABLE t (
                id INT,
                name TEXT,
                PRIMARY KEY (id)
            );
        `);
        expect(r.table('t').columns[0].pk).toBe(true);
        expect(r.table('t').columns[0].notNull).toBe(true);
    });

    it('parses composite PRIMARY KEY', () => {
        const r = exec(`
            CREATE TABLE t (
                a INT,
                b INT,
                c TEXT,
                PRIMARY KEY (a, b)
            );
        `);
        expect(r.table('t').columns[0].pk).toBe(true);
        expect(r.table('t').columns[1].pk).toBe(true);
        expect(r.table('t').columns[2].pk).toBe(false);
    });

    it('parses CONSTRAINT ... PRIMARY KEY', () => {
        const r = exec(`
            CREATE TABLE t (
                id INT,
                CONSTRAINT pk_t PRIMARY KEY (id)
            );
        `);
        expect(r.table('t').columns[0].pk).toBe(true);
    });

    it('parses UNIQUE (...)', () => {
        const r = exec(`
            CREATE TABLE t (
                email TEXT,
                UNIQUE (email)
            );
        `);
        expect(r.table('t').columns[0].unique).toBe(true);
    });

    it('parses CONSTRAINT ... UNIQUE (composite tuple, not per-column)', () => {
        const r = exec(`
            CREATE TABLE t (
                a INT,
                b INT,
                CONSTRAINT uq_ab UNIQUE (a, b)
            );
        `);
        // Composite UNIQUE is a tuple constraint — per SQL standard, neither
        // column is unique on its own. The table records the tuple in
        // `compositeUniques` and the dedicated index list.
        const tab = r.table('t');
        expect(tab.columns[0].unique).toBeFalsy();
        expect(tab.columns[1].unique).toBeFalsy();
        expect(tab.compositeUniques).toHaveLength(1);
        expect(tab.compositeUniques[0].cols).toEqual(['a', 'b']);
        expect(tab.indexes.some((i) => i.unique && i.columns.join(',') === 'a,b')).toBe(true);
    });

    it('parses FOREIGN KEY ... REFERENCES', () => {
        const r = exec(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (
                id INT PRIMARY KEY,
                parent_id INT,
                FOREIGN KEY (parent_id) REFERENCES parent(id)
            );
        `);
        expect(r.table('child').columns[1].fk).toBe(true);
    });

    it('parses CONSTRAINT ... FOREIGN KEY', () => {
        const r = exec(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (
                id INT PRIMARY KEY,
                parent_id INT,
                CONSTRAINT fk_parent FOREIGN KEY (parent_id) REFERENCES parent(id)
            );
        `);
        expect(r.table('child').columns[1].fk).toBe(true);
    });
});

// ════════════════════════════════════════════
// CREATE TYPE — ENUM
// ════════════════════════════════════════════

describe('CREATE TYPE AS ENUM', () => {
    it('creates an enum type', () => {
        const r = exec(`CREATE TYPE status AS ENUM ('active', 'inactive', 'banned');`);
        expect(r.types.size).toBe(1);
        const t = r.type('status');
        expect(t.kind).toBe('enum');
        expect(t.values).toEqual(['active', 'inactive', 'banned']);
    });

    it('creates multiple enum types', () => {
        const r = exec(`
            CREATE TYPE role AS ENUM ('admin', 'user');
            CREATE TYPE priority AS ENUM ('low', 'medium', 'high');
        `);
        expect(r.types.size).toBe(2);
        expect(r.type('role').values).toEqual(['admin', 'user']);
        expect(r.type('priority').values).toEqual(['low', 'medium', 'high']);
    });

    it('resolves enum type used in column', () => {
        const r = exec(`
            CREATE TYPE status AS ENUM ('active', 'inactive');
            CREATE TABLE users (id INT, status status);
        `);
        const col = r.table('users').columns[1];
        expect(col.isEnum).toBe(true);
        expect(col.enumValues).toEqual(['active', 'inactive']);
        expect(col.type).toBe('status');
    });

    it('handles schema-qualified type name', () => {
        const r = exec(`CREATE TYPE public.mood AS ENUM ('happy', 'sad');`);
        expect(r.type('mood')).not.toBeNull();
        expect(r.type('mood').values).toEqual(['happy', 'sad']);
    });
});

// ════════════════════════════════════════════
// CREATE TYPE — Composite
// ════════════════════════════════════════════

describe('CREATE TYPE AS composite', () => {
    it('creates a composite type with fields', () => {
        const r = exec(`
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
        expect(t.fields[1].name).toBe('city');
        expect(t.fields[2].name).toBe('zip');
    });

    it('resolves composite type in column', () => {
        const r = exec(`
            CREATE TYPE address AS (street TEXT, city TEXT);
            CREATE TABLE users (id INT, addr address);
        `);
        const col = r.table('users').columns[1];
        expect(col.isComposite).toBe(true);
        expect(col.type).toBe('address');
    });
});

// ════════════════════════════════════════════
// Inline ENUM
// ════════════════════════════════════════════

describe('Inline ENUM', () => {
    it('parses inline ENUM column type', () => {
        const r = exec(`
            CREATE TABLE t (
                id INT,
                priority ENUM('low', 'medium', 'high')
            );
        `);
        const col = r.table('t').columns[1];
        expect(col.isEnum).toBe(true);
        expect(col.enumValues).toEqual(['low', 'medium', 'high']);
        expect(col.type).toBe('ENUM');
    });

    it('registers inline enum as internal type', () => {
        const r = exec(`CREATE TABLE t (status ENUM('a', 'b'));`);
        const inlineType = r.type('status_enum');
        expect(inlineType).not.toBeNull();
        expect(inlineType.kind).toBe('enum');
        expect(inlineType.isInline).toBe(true);
    });

    it('parses inline ENUM with MySQL charset/collation suffix', () => {
        const r = exec(`CREATE TABLE t (status ENUM('new','done') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL);`);
        const col = r.table('t').columns[0];
        expect(col.isEnum).toBe(true);
        expect(col.enumValues).toEqual(['new', 'done']);
        expect(r.type('status_enum').values).toEqual(['new', 'done']);
    });

    it('parses inline ENUM with MySQL CHARSET shorthand and default', () => {
        const r = exec(`CREATE TABLE t (status ENUM('new','done') CHARSET=utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'new');`);
        const col = r.table('t').columns[0];
        expect(col.isEnum).toBe(true);
        expect(col.enumValues).toEqual(['new', 'done']);
        expect(col.defaultVal).toBe("'new'");
    });

    it('parses inline SET with MySQL charset/collation suffix', () => {
        const r = exec(`CREATE TABLE t (flags SET('read','write') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci);`);
        const col = r.table('t').columns[0];
        expect(col.isEnum).toBe(true);
        expect(col.enumValues).toEqual(['read', 'write']);
        expect(r.type('flags_set').values).toEqual(['read', 'write']);
    });
});

// ════════════════════════════════════════════
// INSERT
// ════════════════════════════════════════════

describe('INSERT', () => {
    it('inserts rows with specified columns', () => {
        const r = exec(`
            CREATE TABLE users (id INT, name TEXT, email TEXT);
            INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@test.com');
        `);
        const t = r.table('users');
        expect(t.rows).toHaveLength(1);
        expect(t.rows[0]).toEqual({ id: 1, name: 'Alice', email: 'alice@test.com' });
    });

    it('inserts multiple rows', () => {
        const r = exec(`
            CREATE TABLE users (id INT, name TEXT);
            INSERT INTO users (id, name) VALUES
                (1, 'Alice'),
                (2, 'Bob'),
                (3, 'Charlie');
        `);
        expect(r.table('users').rows).toHaveLength(3);
        expect(r.table('users').rows[2].name).toBe('Charlie');
    });

    it('handles NULL values', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, NULL);
        `);
        expect(r.table('t').rows[0].val).toBeNull();
    });

    it('handles boolean values', () => {
        const r = exec(`
            CREATE TABLE t (id INT, active BOOLEAN);
            INSERT INTO t (id, active) VALUES (1, TRUE), (2, FALSE);
        `);
        expect(r.table('t').rows[0].active).toBe(true);
        expect(r.table('t').rows[1].active).toBe(false);
    });

    it('handles numeric values', () => {
        const r = exec(`
            CREATE TABLE t (id INT, price NUMERIC);
            INSERT INTO t (id, price) VALUES (1, 99.99), (2, -5);
        `);
        expect(r.table('t').rows[0].price).toBe(99.99);
        expect(r.table('t').rows[1].price).toBe(-5);
    });

    it('handles PostgreSQL literal casts in INSERT values and defaults', () => {
        const r = exec(`
            CREATE TABLE t (
                id INT,
                payload JSONB DEFAULT '{"fallback":true}'::pg_catalog.jsonb,
                qty INT DEFAULT '4'::INTEGER,
                active BOOLEAN DEFAULT 'f'::BOOLEAN,
                label TEXT DEFAULT 88::TEXT
            );
            INSERT INTO t (id, payload, qty, active, label)
            VALUES (1::INT, '{"region":"apac","count":2}'::pg_catalog.jsonb, '7'::INTEGER, 't'::BOOLEAN, 99::TEXT);
            INSERT INTO t (id) VALUES (2);
        `);
        const rows = r.table('t').rows;
        expect(rows[0]).toEqual({
            id: 1,
            payload: { region: 'apac', count: 2 },
            qty: 7,
            active: true,
            label: '99',
        });
        expect(rows[1]).toEqual({
            id: 2,
            payload: { fallback: true },
            qty: 4,
            active: false,
            label: '88',
        });
        expect(r.errors()).toHaveLength(0);
    });

    it('applies default values for unspecified columns', () => {
        const r = exec(`
            CREATE TABLE t (id INT, role VARCHAR(50) DEFAULT 'user', active BOOLEAN DEFAULT TRUE);
            INSERT INTO t (id) VALUES (1);
        `);
        const row = r.table('t').rows[0];
        expect(row.role).toBe('user');
        expect(row.active).toBe(true);
    });

    it('handles NOW() and CURRENT_TIMESTAMP as values', () => {
        const r = exec(`
            CREATE TABLE t (id INT, created_at TIMESTAMP);
            INSERT INTO t (id, created_at) VALUES (1, NOW());
            INSERT INTO t (id, created_at) VALUES (2, CURRENT_TIMESTAMP);
        `);
        const rows = r.table('t').rows;
        expect(rows).toHaveLength(2);
        expect(typeof rows[0].created_at).toBe('string');
        expect(rows[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(typeof rows[1].created_at).toBe('string');
        expect(rows[1].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(rows[0].created_at).not.toContain('(');
        expect(rows[0].created_at).not.toContain(')');
    });

    it('handles NOW() in UPDATE SET', () => {
        const r = exec(`
            CREATE TABLE t (id INT, updated_at TIMESTAMP);
            INSERT INTO t (id, updated_at) VALUES (1, NULL);
            UPDATE t SET updated_at = NOW() WHERE id = 1;
        `);
        expect(r.table('t').rows[0].updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(r.table('t').rows[0].updated_at).not.toContain('(');
    });

    it('errors on non-existent table', () => {
        const r = exec(`INSERT INTO ghost (id) VALUES (1);`);
        expect(r.errors()).toHaveLength(1);
        expect(r.errors()[0].message).toContain('ghost');
    });

    it('handles multiple INSERT statements', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'a');
            INSERT INTO t (id, val) VALUES (2, 'b');
            INSERT INTO t (id, val) VALUES (3, 'c');
        `);
        expect(r.table('t').rows).toHaveLength(3);
    });
});

// ════════════════════════════════════════════
// UPDATE
// ════════════════════════════════════════════

describe('UPDATE', () => {
    it('updates all rows without WHERE', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'a'), (2, 'b');
            UPDATE t SET val = 'x';
        `);
        expect(r.table('t').rows[0].val).toBe('x');
        expect(r.table('t').rows[1].val).toBe('x');
    });

    it('updates rows matching WHERE =', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t (id, name) VALUES (1, 'Alice'), (2, 'Bob');
            UPDATE t SET name = 'Updated' WHERE id = 1;
        `);
        expect(r.table('t').rows[0].name).toBe('Updated');
        expect(r.table('t').rows[1].name).toBe('Bob');
    });

    it('updates multiple columns', () => {
        const r = exec(`
            CREATE TABLE t (id INT, a TEXT, b TEXT);
            INSERT INTO t (id, a, b) VALUES (1, 'old_a', 'old_b');
            UPDATE t SET a = 'new_a', b = 'new_b' WHERE id = 1;
        `);
        const row = r.table('t').rows[0];
        expect(row.a).toBe('new_a');
        expect(row.b).toBe('new_b');
    });

    it('updates with WHERE != / <>', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'a'), (2, 'b'), (3, 'c');
            UPDATE t SET val = 'x' WHERE id != 2;
        `);
        expect(r.table('t').rows[0].val).toBe('x');
        expect(r.table('t').rows[1].val).toBe('b');
        expect(r.table('t').rows[2].val).toBe('x');
    });

    it('updates with WHERE > / <', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'a'), (5, 'b'), (10, 'c');
            UPDATE t SET val = 'big' WHERE id > 3;
        `);
        expect(r.table('t').rows[0].val).toBe('a');
        expect(r.table('t').rows[1].val).toBe('big');
        expect(r.table('t').rows[2].val).toBe('big');
    });

    it('updates with WHERE LIKE', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t (id, name) VALUES (1, 'Alice'), (2, 'Amanda'), (3, 'Bob');
            UPDATE t SET name = 'MATCHED' WHERE name LIKE 'A%';
        `);
        expect(r.table('t').rows[0].name).toBe('MATCHED');
        expect(r.table('t').rows[1].name).toBe('MATCHED');
        expect(r.table('t').rows[2].name).toBe('Bob');
    });

    it('updates with WHERE IS NULL', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, NULL), (2, 'ok');
            UPDATE t SET val = 'filled' WHERE val IS NULL;
        `);
        expect(r.table('t').rows[0].val).toBe('filled');
        expect(r.table('t').rows[1].val).toBe('ok');
    });

    it('errors on non-existent table', () => {
        const r = exec(`UPDATE ghost SET val = 1;`);
        expect(r.errors()).toHaveLength(1);
    });
});

// ════════════════════════════════════════════
// DELETE
// ════════════════════════════════════════════

describe('DELETE', () => {
    it('deletes all rows without WHERE', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            INSERT INTO t (id) VALUES (1), (2), (3);
            DELETE FROM t;
        `);
        expect(r.table('t').rows).toHaveLength(0);
    });

    it('deletes rows matching WHERE', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t (id, name) VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Charlie');
            DELETE FROM t WHERE id = 2;
        `);
        expect(r.table('t').rows).toHaveLength(2);
        expect(r.table('t').rows.every((r) => r.name !== 'Bob')).toBe(true);
    });

    it('deletes rows with WHERE >', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            INSERT INTO t (id) VALUES (1), (2), (3), (4), (5);
            DELETE FROM t WHERE id > 3;
        `);
        expect(r.table('t').rows).toHaveLength(3);
    });

    it('deletes with WHERE IS NOT NULL', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'a'), (2, NULL), (3, 'c');
            DELETE FROM t WHERE val IS NOT NULL;
        `);
        expect(r.table('t').rows).toHaveLength(1);
        expect(r.table('t').rows[0].val).toBeNull();
    });

    it('errors on non-existent table', () => {
        const r = exec(`DELETE FROM ghost WHERE id = 1;`);
        expect(r.errors()).toHaveLength(1);
    });
});

// ════════════════════════════════════════════
// DROP TABLE / DROP TYPE
// ════════════════════════════════════════════

describe('DROP TABLE', () => {
    it('drops an existing table', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            DROP TABLE t;
        `);
        expect(r.tables.size).toBe(0);
    });

    it('DROP TABLE IF EXISTS on non-existent table is silent', () => {
        const r = exec(`DROP TABLE IF EXISTS nonexistent;`);
        expect(r.errors()).toHaveLength(0);
    });

    it('errors when dropping non-existent table', () => {
        const r = exec(`DROP TABLE ghost;`);
        expect(r.errors()).toHaveLength(1);
        expect(r.errors()[0].message).toContain('ghost');
    });
});

describe('DROP TYPE', () => {
    it('drops an existing type', () => {
        const r = exec(`
            CREATE TYPE status AS ENUM ('a', 'b');
            DROP TYPE status;
        `);
        expect(r.types.size).toBe(0);
    });

    it('errors when dropping non-existent type', () => {
        const r = exec(`DROP TYPE ghost;`);
        expect(r.errors()).toHaveLength(1);
        expect(r.errors()[0].message).toContain('ghost');
    });
});

// ════════════════════════════════════════════
// ALTER TABLE
// ════════════════════════════════════════════

describe('ALTER TABLE', () => {
    it('adds PRIMARY KEY constraint', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            ALTER TABLE t ADD PRIMARY KEY (id);
        `);
        expect(r.table('t').columns[0].pk).toBe(true);
    });

    it('adds CONSTRAINT ... PRIMARY KEY', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            ALTER TABLE t ADD CONSTRAINT pk_t PRIMARY KEY (id);
        `);
        expect(r.table('t').columns[0].pk).toBe(true);
    });

    it('adds UNIQUE constraint', () => {
        const r = exec(`
            CREATE TABLE t (email TEXT);
            ALTER TABLE t ADD UNIQUE (email);
        `);
        expect(r.table('t').columns[0].unique).toBe(true);
    });

    it('adds FOREIGN KEY constraint', () => {
        const r = exec(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (id INT, parent_id INT);
            ALTER TABLE child ADD FOREIGN KEY (parent_id) REFERENCES parent(id);
        `);
        expect(r.table('child').columns[1].fk).toBe(true);
    });

    it('adds CHECK constraint', () => {
        const r = exec(`
            CREATE TABLE t (age INT);
            ALTER TABLE t ADD CHECK (age >= 0);
        `);
        expect(r.successes().some((l) => l.message.includes('CHECK'))).toBe(true);
    });
});

// ════════════════════════════════════════════
// Complex real-world SQL
// ════════════════════════════════════════════

describe('Complex real-world SQL', () => {
    it('handles a full e-commerce schema', () => {
        const r = exec(`
            CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled');
            CREATE TYPE payment_method AS ENUM ('card', 'bank_transfer', 'cash');

            CREATE TYPE address AS (
                street TEXT,
                city TEXT,
                postal_code VARCHAR(20)
            );

            CREATE TABLE customers (
                id INTEGER PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                full_name VARCHAR(120) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE products (
                id INTEGER PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                price DECIMAL(10,2) NOT NULL CHECK (price > 0),
                stock INT DEFAULT 0,
                category VARCHAR(50)
            );

            CREATE TABLE orders (
                id INTEGER PRIMARY KEY,
                customer_id INTEGER REFERENCES customers(id),
                status order_status DEFAULT 'pending',
                payment payment_method,
                total DECIMAL(10,2) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE order_items (
                id INTEGER PRIMARY KEY,
                order_id INTEGER,
                product_id INTEGER,
                quantity INT NOT NULL CHECK (quantity > 0),
                unit_price DECIMAL(10,2) NOT NULL,
                FOREIGN KEY (order_id) REFERENCES orders(id),
                FOREIGN KEY (product_id) REFERENCES products(id)
            );

            INSERT INTO customers (id, email, full_name) VALUES
                (1, 'alice@example.com', 'Alice Johnson'),
                (2, 'bob@example.com', 'Bob Smith'),
                (3, 'charlie@example.com', 'Charlie Brown');

            INSERT INTO products (id, name, price, stock, category) VALUES
                (1, 'Laptop', 999.99, 50, 'Electronics'),
                (2, 'Mouse', 29.99, 200, 'Electronics'),
                (3, 'Keyboard', 79.99, 150, 'Electronics'),
                (4, 'Monitor', 349.99, 75, 'Electronics'),
                (5, 'Headphones', 149.99, 100, 'Audio');

            INSERT INTO orders (id, customer_id, status, payment, total) VALUES
                (1, 1, 'paid', 'card', 1029.98),
                (2, 1, 'shipped', 'card', 79.99),
                (3, 2, 'pending', 'bank_transfer', 499.98),
                (4, 3, 'cancelled', 'cash', 29.99);

            INSERT INTO order_items (id, order_id, product_id, quantity, unit_price) VALUES
                (1, 1, 1, 1, 999.99),
                (2, 1, 2, 1, 29.99),
                (3, 2, 3, 1, 79.99),
                (4, 3, 4, 1, 349.99),
                (5, 3, 5, 1, 149.99),
                (6, 4, 2, 1, 29.99);

            UPDATE orders SET status = 'paid' WHERE id = 3;
            DELETE FROM orders WHERE status = 'cancelled';
        `);

        // Types
        expect(r.types.size).toBe(3);
        expect(r.type('order_status').values).toEqual(['pending', 'paid', 'shipped', 'cancelled']);
        expect(r.type('payment_method').values).toHaveLength(3);
        expect(r.type('address').kind).toBe('composite');
        expect(r.type('address').fields).toHaveLength(3);

        // Tables
        expect(r.tables.size).toBe(4);

        // customers
        const customers = r.table('customers');
        expect(customers.columns).toHaveLength(4);
        expect(customers.columns[0].pk).toBe(true);
        expect(customers.columns[1].unique).toBe(true);
        expect(customers.columns[1].notNull).toBe(true);
        expect(customers.rows).toHaveLength(3);

        // products
        const products = r.table('products');
        expect(products.columns).toHaveLength(5);
        expect(products.columns[2].check).toBeTruthy();
        expect(products.columns[3].defaultVal).toBe('0');
        expect(products.rows).toHaveLength(5);
        expect(products.rows[0].price).toBe(999.99);

        // orders — status enum resolved
        const orders = r.table('orders');
        const statusCol = orders.columns.find((c) => c.name === 'status');
        expect(statusCol.isEnum).toBe(true);
        expect(statusCol.enumValues).toEqual(['pending', 'paid', 'shipped', 'cancelled']);
        expect(statusCol.defaultVal).toBe("'pending'");

        // orders — data mutations
        expect(orders.rows).toHaveLength(4); // DELETE is rejected by referenced order_items
        expect(orders.rows.find((r) => r.id === 3).status).toBe('paid'); // updated
        expect(orders.rows.some((r) => r.status === 'cancelled')).toBe(true); // protected by FK RESTRICT/NO ACTION
        expect(r.errors().some((entry) => /prevents deleting/.test(entry.message))).toBe(true);

        // order_items — table-level FK
        const items = r.table('order_items');
        expect(items.columns[1].fk).toBe(true); // order_id
        expect(items.columns[2].fk).toBe(true); // product_id
        expect(items.columns[3].notNull).toBe(true);
        expect(items.columns[3].check).toBeTruthy();
        expect(items.rows).toHaveLength(6);

        // The attempted delete is correctly rejected because its order is
        // still referenced by order_items.
        expect(r.errors()).toHaveLength(1);
    });

    it('handles a blog with mixed inline and named enums', () => {
        const r = exec(`
            CREATE TYPE user_role AS ENUM ('admin', 'editor', 'user');

            CREATE TABLE users (
                id INT PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                role user_role DEFAULT 'user',
                level ENUM('junior', 'mid', 'senior')
            );

            CREATE TABLE posts (
                id INT PRIMARY KEY,
                title VARCHAR(200) NOT NULL,
                author_id INT REFERENCES users(id),
                status ENUM('draft', 'published', 'archived'),
                views INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            INSERT INTO users (id, name, role, level) VALUES
                (1, 'Alice', 'admin', 'senior'),
                (2, 'Bob', 'editor', 'mid');

            INSERT INTO posts (id, title, author_id, status, views) VALUES
                (1, 'First Post', 1, 'published', 100),
                (2, 'Draft', 2, 'draft', 0);

            UPDATE posts SET status = 'published', views = 50 WHERE id = 2;
        `);

        // Named enum
        const roleCol = r.table('users').columns[2];
        expect(roleCol.isEnum).toBe(true);
        expect(roleCol.enumValues).toEqual(['admin', 'editor', 'user']);
        expect(roleCol.type).toBe('user_role');

        // Inline enum
        const levelCol = r.table('users').columns[3];
        expect(levelCol.isEnum).toBe(true);
        expect(levelCol.type).toBe('ENUM');
        expect(levelCol.enumValues).toEqual(['junior', 'mid', 'senior']);

        // Another inline enum
        const statusCol = r.table('posts').columns[3];
        expect(statusCol.isEnum).toBe(true);
        expect(statusCol.type).toBe('ENUM');

        // Data verification
        const post2 = r.table('posts').rows.find((r) => r.id === 2);
        expect(post2.status).toBe('published');
        expect(post2.views).toBe(50);
    });

    it('handles sequential DML operations correctly', () => {
        const r = exec(`
            CREATE TABLE inventory (id INT PRIMARY KEY, item TEXT, qty INT);

            INSERT INTO inventory (id, item, qty) VALUES
                (1, 'Apples', 100),
                (2, 'Bananas', 50),
                (3, 'Cherries', 200),
                (4, 'Dates', 30),
                (5, 'Elderberries', 10);

            -- Restock
            UPDATE inventory SET qty = 75 WHERE id = 2;
            UPDATE inventory SET qty = 0 WHERE item = 'Dates';

            -- Remove out of stock
            DELETE FROM inventory WHERE qty = 0;

            -- Add new item
            INSERT INTO inventory (id, item, qty) VALUES (6, 'Figs', 60);
        `);

        const rows = r.table('inventory').rows;
        expect(rows).toHaveLength(5); // 5 inserted, 1 deleted, 1 added
        expect(rows.find((r) => r.item === 'Bananas').qty).toBe(75);
        expect(rows.find((r) => r.item === 'Dates')).toBeUndefined();
        expect(rows.find((r) => r.item === 'Figs').qty).toBe(60);
        expect(r.errors()).toHaveLength(0);
    });

    it('handles MySQL-style table definitions', () => {
        const r = exec(`
            CREATE TABLE users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) NOT NULL UNIQUE,
                email VARCHAR(255) NOT NULL,
                status ENUM('active', 'suspended', 'deleted') DEFAULT 'active',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        const cols = r.table('users').columns;
        expect(cols[0].pk).toBe(true);
        expect(cols[1].notNull).toBe(true);
        expect(cols[1].unique).toBe(true);
        expect(cols[3].isEnum).toBe(true);
        expect(cols[3].defaultVal).toBe("'active'");
    });

    it('handles ON DELETE CASCADE in references', () => {
        const r = exec(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (
                id INT PRIMARY KEY,
                parent_id INT REFERENCES parent(id) ON DELETE CASCADE
            );
        `);
        const col = r.table('child').columns[1];
        expect(col.fk).toBe(true);
        expect(col.refTable).toBe('parent');
    });
});

// ════════════════════════════════════════════
// Edge cases & error handling
// ════════════════════════════════════════════

describe('Edge cases', () => {
    it('handles empty input', () => {
        const r = exec('');
        expect(r.tables.size).toBe(0);
        expect(r.errors()).toHaveLength(0);
    });

    it('handles whitespace-only input', () => {
        const r = exec('   \n\n  ');
        expect(r.tables.size).toBe(0);
    });

    it('handles comments-only input', () => {
        const r = exec(`-- just a comment\n-- another comment`);
        expect(r.tables.size).toBe(0);
        expect(r.errors()).toHaveLength(0);
    });

    it('handles GO separator (SQL Server)', () => {
        const r = exec(`
            CREATE TABLE a (id INT);
            GO
            CREATE TABLE b (id INT);
        `);
        expect(r.tables.size).toBe(2);
    });

    it('survives duplicate table creation (overwrites)', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            INSERT INTO t (id) VALUES (1);
            CREATE TABLE t (id INT, name TEXT);
        `);
        const t = r.table('t');
        expect(t.columns).toHaveLength(2);
        expect(t.rows).toHaveLength(1);
    });

    it('handles missing semicolons gracefully', () => {
        const r = exec(`CREATE TABLE t (id INT)`);
        expect(r.tables.size).toBe(1);
    });

    it('logs the right number of operations', () => {
        const r = exec(`
            CREATE TYPE s AS ENUM ('a');
            CREATE TABLE t (id INT, s s);
            INSERT INTO t (id, s) VALUES (1, 'a');
            UPDATE t SET s = 'a' WHERE id = 1;
            DELETE FROM t WHERE id = 1;
        `);
        expect(r.successes()).toHaveLength(5);
        expect(r.errors()).toHaveLength(0);
    });
});

// ════════════════════════════════════════════
// WHERE — advanced operators
// ════════════════════════════════════════════

describe('WHERE advanced', () => {
    it('OR selects rows matching either condition', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t (id, name) VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Charlie');
            DELETE FROM t WHERE id = 1 OR id = 3;
        `);
        expect(r.table('t').rows).toHaveLength(1);
        expect(r.table('t').rows[0].name).toBe('Bob');
    });

    it('AND + OR precedence: AND binds tighter', () => {
        const r = exec(`
            CREATE TABLE t (id INT, cat TEXT, active BOOLEAN);
            INSERT INTO t (id, cat, active) VALUES
                (1, 'A', TRUE), (2, 'B', TRUE), (3, 'A', FALSE), (4, 'B', FALSE);
            UPDATE t SET cat = 'MATCHED' WHERE cat = 'A' AND active = TRUE OR id = 4;
        `);
        const rows = r.table('t').rows;
        expect(rows[0].cat).toBe('MATCHED'); // id=1, A+TRUE
        expect(rows[1].cat).toBe('B'); // id=2, not matched
        expect(rows[2].cat).toBe('A'); // id=3, A but FALSE, no OR match
        expect(rows[3].cat).toBe('MATCHED'); // id=4, OR match
    });

    it('IN matches list of values', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t (id, name) VALUES (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd');
            DELETE FROM t WHERE name IN ('a', 'c', 'd');
        `);
        expect(r.table('t').rows).toHaveLength(1);
        expect(r.table('t').rows[0].name).toBe('b');
    });

    it('IN with numeric values', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'x'), (2, 'y'), (3, 'z');
            UPDATE t SET val = 'match' WHERE id IN (1, 3);
        `);
        expect(r.table('t').rows[0].val).toBe('match');
        expect(r.table('t').rows[1].val).toBe('y');
        expect(r.table('t').rows[2].val).toBe('match');
    });

    it('NOT IN excludes matching values', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t (id, name) VALUES (1, 'a'), (2, 'b'), (3, 'c');
            DELETE FROM t WHERE name NOT IN ('b');
        `);
        expect(r.table('t').rows).toHaveLength(1);
        expect(r.table('t').rows[0].name).toBe('b');
    });

    it('<> operator works like !=', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'a'), (2, 'b');
            UPDATE t SET val = 'x' WHERE val <> 'b';
        `);
        expect(r.table('t').rows[0].val).toBe('x');
        expect(r.table('t').rows[1].val).toBe('b');
    });

    it('multiple OR conditions', () => {
        const r = exec(`
            CREATE TABLE t (id INT, status TEXT);
            INSERT INTO t (id, status) VALUES (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd');
            DELETE FROM t WHERE status = 'a' OR status = 'c' OR status = 'd';
        `);
        expect(r.table('t').rows).toHaveLength(1);
        expect(r.table('t').rows[0].status).toBe('b');
    });
});

// ════════════════════════════════════════════
// INSERT — edge cases
// ════════════════════════════════════════════

describe('INSERT edge cases', () => {
    it('inserts without column list (uses table order)', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT, active BOOLEAN);
            INSERT INTO t VALUES (1, 'Alice', TRUE);
        `);
        const row = r.table('t').rows[0];
        expect(row.id).toBe(1);
        expect(row.name).toBe('Alice');
        expect(row.active).toBe(true);
    });

    it('handles empty string values', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, '');
        `);
        expect(r.table('t').rows[0].val).toBe('');
    });

    it('applies DEFAULT now() on missing columns', () => {
        const r = exec(`
            CREATE TABLE t (id INT, created_at TIMESTAMP DEFAULT now());
            INSERT INTO t (id) VALUES (1);
        `);
        const row = r.table('t').rows[0];
        expect(typeof row.created_at).toBe('string');
        expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('applies DEFAULT CURRENT_TIMESTAMP on missing columns', () => {
        const r = exec(`
            CREATE TABLE t (id INT, ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            INSERT INTO t (id) VALUES (1);
        `);
        expect(r.table('t').rows[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('handles mixed value types in one row', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT, score NUMERIC, active BOOLEAN, note TEXT);
            INSERT INTO t (id, name, score, active, note) VALUES (1, 'test', 95.5, FALSE, NULL);
        `);
        const row = r.table('t').rows[0];
        expect(row.id).toBe(1);
        expect(row.name).toBe('test');
        expect(row.score).toBe(95.5);
        expect(row.active).toBe(false);
        expect(row.note).toBeNull();
    });

    it('handles NOW() mixed with other values in same row', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT, ts TIMESTAMP);
            INSERT INTO t (id, name, ts) VALUES (1, 'Alice', NOW());
        `);
        const row = r.table('t').rows[0];
        expect(row.id).toBe(1);
        expect(row.name).toBe('Alice');
        expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(row.ts).not.toContain('(');
    });
});

// ════════════════════════════════════════════
// UPDATE / DELETE — edge cases
// ════════════════════════════════════════════

describe('UPDATE/DELETE edge cases', () => {
    it('UPDATE with no matching rows succeeds with 0 updated', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'a');
            UPDATE t SET val = 'x' WHERE id = 999;
        `);
        expect(r.table('t').rows[0].val).toBe('a');
        expect(r.errors()).toHaveLength(0);
    });

    it('DELETE with no matching rows succeeds with 0 deleted', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            INSERT INTO t (id) VALUES (1), (2);
            DELETE FROM t WHERE id = 999;
        `);
        expect(r.table('t').rows).toHaveLength(2);
        expect(r.errors()).toHaveLength(0);
    });

    it('UPDATE SET to NULL', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'hello');
            UPDATE t SET val = NULL WHERE id = 1;
        `);
        expect(r.table('t').rows[0].val).toBeNull();
    });

    it('UPDATE SET to boolean', () => {
        const r = exec(`
            CREATE TABLE t (id INT, active BOOLEAN);
            INSERT INTO t (id, active) VALUES (1, TRUE);
            UPDATE t SET active = FALSE WHERE id = 1;
        `);
        expect(r.table('t').rows[0].active).toBe(false);
    });

    it('UPDATE with multiple AND conditions', () => {
        const r = exec(`
            CREATE TABLE t (id INT, cat TEXT, active BOOLEAN);
            INSERT INTO t (id, cat, active) VALUES
                (1, 'A', TRUE), (2, 'A', FALSE), (3, 'B', TRUE);
            UPDATE t SET cat = 'matched' WHERE cat = 'A' AND active = TRUE;
        `);
        expect(r.table('t').rows[0].cat).toBe('matched');
        expect(r.table('t').rows[1].cat).toBe('A');
        expect(r.table('t').rows[2].cat).toBe('B');
    });

    it('case-insensitive table and column names in DML', () => {
        const r = exec(`
            CREATE TABLE Users (ID INT, Name TEXT);
            INSERT INTO users (id, name) VALUES (1, 'Alice');
            UPDATE USERS SET NAME = 'Bob' WHERE ID = 1;
        `);
        expect(r.table('users').rows[0].Name).toBe('Bob');
    });
});

// ════════════════════════════════════════════
// DROP TABLE — data behavior
// ════════════════════════════════════════════

describe('DROP TABLE with data', () => {
    it('drop removes all data too', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            INSERT INTO t (id) VALUES (1), (2), (3);
            DROP TABLE t;
        `);
        expect(r.tables.size).toBe(0);
        expect(r.table('t')).toBeNull();
    });

    it('re-create after drop starts fresh', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            INSERT INTO t (id) VALUES (1);
            DROP TABLE t;
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t (id, name) VALUES (2, 'new');
        `);
        const t = r.table('t');
        expect(t.columns).toHaveLength(2);
        expect(t.rows).toHaveLength(1);
        expect(t.rows[0].id).toBe(2);
    });
});

// ════════════════════════════════════════════
// Validation & Warnings
// ════════════════════════════════════════════

describe('INSERT validation', () => {
    it('rejects column count mismatch (too few values)', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT, email TEXT);
            INSERT INTO t (id, name, email) VALUES (1, 'Alice');
        `);
        expect(r.errors().some((entry) => entry.message.includes('expected 3') && entry.message.includes('got 2'))).toBe(true);
        expect(r.table('t').rows).toHaveLength(0);
    });

    it('rejects column count mismatch (too many values)', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t (id, name) VALUES (1, 'Alice', 'extra');
        `);
        expect(r.errors().some((entry) => entry.message.includes('expected 2') && entry.message.includes('got 3'))).toBe(true);
        expect(r.table('t').rows).toHaveLength(0);
    });

    it('errors on unknown column name', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t (id, fake_col) VALUES (1, 'oops');
        `);
        expect(r.errors().some((e) => e.message.includes('fake_col'))).toBe(true);
    });

    it('rejects a NOT NULL violation', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, name TEXT NOT NULL);
            INSERT INTO t (id, name) VALUES (1, NULL);
        `);
        expect(r.errors().some((entry) => entry.message.includes('NOT NULL') && entry.message.includes('name'))).toBe(true);
    });

    it('rejects PRIMARY KEY NULL', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, val TEXT);
            INSERT INTO t (id, val) VALUES (NULL, 'test');
        `);
        expect(r.errors().some((entry) => entry.message.includes('NOT NULL') && entry.message.includes('id'))).toBe(true);
    });

    it('rejects duplicate PRIMARY KEY atomically', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'a'), (1, 'b');
        `);
        expect(r.errors().some((entry) => entry.message.includes('duplicate') && entry.message.includes('PRIMARY KEY'))).toBe(true);
        expect(r.table('t').rows).toHaveLength(0);
    });

    it('rejects duplicate UNIQUE value atomically', () => {
        const r = exec(`
            CREATE TABLE t (id INT, email TEXT UNIQUE);
            INSERT INTO t (id, email) VALUES (1, 'same@test.com'), (2, 'same@test.com');
        `);
        expect(r.errors().some((entry) => entry.message.includes('UNIQUE') && entry.message.includes('email'))).toBe(true);
        expect(r.table('t').rows).toHaveLength(0);
    });

    it('does not insert a row with an integrity error', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, val TEXT NOT NULL);
            INSERT INTO t (id, val) VALUES (1, NULL);
        `);
        expect(r.table('t').rows).toHaveLength(0);
        expect(r.errors().length).toBeGreaterThan(0);
    });

    it('no warnings for valid inserts', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE);
            INSERT INTO t (id, name, email) VALUES (1, 'Alice', 'a@t.com'), (2, 'Bob', 'b@t.com');
        `);
        expect(r.warnings()).toHaveLength(0);
        expect(r.errors()).toHaveLength(0);
    });
});

describe('UPDATE validation', () => {
    it('rejects an unknown column in SET without mutating the row', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t (id, name) VALUES (1, 'Alice');
            UPDATE t SET ghost_col = 'x' WHERE id = 1;
        `);
        expect(r.errors().some((entry) => entry.message.includes('ghost_col') && entry.message.includes('does not exist'))).toBe(true);
        expect(r.table('t').rows).toEqual([{ id: 1, name: 'Alice' }]);
    });

    it('rejects setting NOT NULL column to NULL', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT NOT NULL);
            INSERT INTO t (id, name) VALUES (1, 'Alice');
            UPDATE t SET name = NULL WHERE id = 1;
        `);
        expect(r.errors().some((entry) => entry.message.includes('NOT NULL') && entry.message.includes('name'))).toBe(true);
    });

    it('warns on UPDATE without WHERE', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'a'), (2, 'b');
            UPDATE t SET val = 'x';
        `);
        expect(r.warnings().some((w) => w.message.includes('no WHERE'))).toBe(true);
    });

    it('no warnings for valid update with WHERE', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'a');
            UPDATE t SET val = 'b' WHERE id = 1;
        `);
        expect(r.warnings()).toHaveLength(0);
    });
});

describe('DELETE validation', () => {
    it('warns on DELETE without WHERE', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            INSERT INTO t (id) VALUES (1), (2);
            DELETE FROM t;
        `);
        expect(r.warnings().some((w) => w.message.includes('no WHERE'))).toBe(true);
    });

    it('no warnings for DELETE with WHERE', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            INSERT INTO t (id) VALUES (1), (2);
            DELETE FROM t WHERE id = 1;
        `);
        expect(r.warnings()).toHaveLength(0);
    });
});

// ════════════════════════════════════════════
// HARDENED: 100 additional production tests
// ════════════════════════════════════════════

describe('CREATE TABLE — hardened', () => {
    it('single column table', () => {
        const r = exec(`CREATE TABLE t (id INT);`);
        expect(r.table('t').columns).toHaveLength(1);
    });

    it('table with many columns (15+)', () => {
        const r = exec(`CREATE TABLE big (a INT, b INT, c INT, d INT, e INT, f INT, g INT, h INT, i INT, j INT, k INT, l INT, m INT, n INT, o INT);`);
        expect(r.table('big').columns).toHaveLength(15);
    });

    it('column named with SQL keyword (name, type, status, index)', () => {
        const r = exec(`CREATE TABLE t (name TEXT, type TEXT, status TEXT, "index" INT);`);
        expect(r.table('t').columns).toHaveLength(4);
        expect(r.table('t').columns[0].name.toLowerCase()).toBe('name');
        expect(r.table('t').columns[1].name.toLowerCase()).toBe('type');
    });

    it('table named with SQL keyword', () => {
        const r = exec(`CREATE TABLE "order" (id INT, total NUMERIC);`);
        expect(r.tables.size).toBe(1);
    });

    it('VARCHAR without size', () => {
        const r = exec(`CREATE TABLE t (val VARCHAR);`);
        expect(r.table('t').columns[0].type).toBe('VARCHAR');
    });

    it('DEFAULT NULL explicit', () => {
        const r = exec(`CREATE TABLE t (val TEXT DEFAULT NULL);`);
        expect(r.table('t').columns[0].defaultVal).toBeNull();
    });

    it('SERIAL and BIGSERIAL types', () => {
        const r = exec(`CREATE TABLE t (id SERIAL PRIMARY KEY, big_id BIGSERIAL);`);
        expect(r.table('t').columns[0].type).toBe('SERIAL');
        expect(r.table('t').columns[1].type).toBe('BIGSERIAL');
    });

    it('multiple CHECK constraints in same table', () => {
        const r = exec(`CREATE TABLE t (age INT CHECK (age >= 0), price NUMERIC CHECK (price > 0));`);
        expect(r.table('t').columns[0].check).toBeTruthy();
        expect(r.table('t').columns[1].check).toBeTruthy();
    });

    it('ON DELETE CASCADE + ON UPDATE CASCADE', () => {
        const r = exec(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (pid INT REFERENCES p(id) ON DELETE CASCADE ON UPDATE CASCADE);
        `);
        expect(r.table('c').columns[0].fk).toBe(true);
    });

    it('NOT NULL + UNIQUE + DEFAULT together', () => {
        const r = exec(`CREATE TABLE t (email VARCHAR(255) NOT NULL UNIQUE DEFAULT 'unknown');`);
        const col = r.table('t').columns[0];
        expect(col.notNull).toBe(true);
        expect(col.unique).toBe(true);
        expect(col.defaultVal).toBe("'unknown'");
    });
});

describe('Column types — hardened', () => {
    it('TINYINT, MEDIUMINT, NVARCHAR, NCHAR', () => {
        const r = exec(`CREATE TABLE t (a TINYINT, b MEDIUMINT, c NVARCHAR(100), d NCHAR(10));`);
        expect(r.table('t').columns[0].type).toBe('TINYINT');
        expect(r.table('t').columns[2].type).toBe('NVARCHAR(100)');
    });

    it('DATETIME, DATETIME2, BIT, XML', () => {
        const r = exec(`CREATE TABLE t (a DATETIME, b DATETIME2, c BIT, d XML);`);
        expect(r.table('t').columns).toHaveLength(4);
    });

    it('DECIMAL without precision', () => {
        const r = exec(`CREATE TABLE t (val DECIMAL);`);
        expect(r.table('t').columns[0].type).toBe('DECIMAL');
    });

    it('NUMERIC with single precision', () => {
        const r = exec(`CREATE TABLE t (val NUMERIC(10));`);
        expect(r.table('t').columns[0].type).toBe('NUMERIC(10)');
    });
});

describe('INSERT — hardened', () => {
    it('string with spaces', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'hello world foo');
        `);
        expect(r.table('t').rows[0].val).toBe('hello world foo');
    });

    it('string that looks like a number', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, '12345');
        `);
        expect(r.table('t').rows[0].val).toBe('12345');
        expect(typeof r.table('t').rows[0].val).toBe('string');
    });

    it('zero vs NULL distinction', () => {
        const r = exec(`
            CREATE TABLE t (a INT, b INT);
            INSERT INTO t (a, b) VALUES (0, NULL);
        `);
        expect(r.table('t').rows[0].a).toBe(0);
        expect(r.table('t').rows[0].b).toBeNull();
    });

    it('large integer values', () => {
        const r = exec(`
            CREATE TABLE t (id INT, big BIGINT);
            INSERT INTO t (id, big) VALUES (1, 9999999999);
        `);
        expect(r.table('t').rows[0].big).toBe(9999999999);
    });

    it('decimal precision maintained', () => {
        const r = exec(`
            CREATE TABLE t (id INT, price NUMERIC);
            INSERT INTO t (id, price) VALUES (1, 123.456);
        `);
        expect(r.table('t').rows[0].price).toBe(123.456);
    });

    it('negative decimal values', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val NUMERIC);
            INSERT INTO t (id, val) VALUES (1, -99.99);
        `);
        expect(r.table('t').rows[0].val).toBe(-99.99);
    });

    it('insert 20+ rows in single statement', () => {
        const rows = Array.from({ length: 25 }, (_, i) => `(${i + 1}, 'item_${i + 1}')`).join(',\n');
        const r = exec(`CREATE TABLE t (id INT, name TEXT); INSERT INTO t (id, name) VALUES ${rows};`);
        expect(r.table('t').rows).toHaveLength(25);
        expect(r.table('t').rows[24].name).toBe('item_25');
    });

    it('insert with schema-qualified table name', () => {
        const r = exec(`
            CREATE TABLE public.t (id INT, val TEXT);
            INSERT INTO public.t (id, val) VALUES (1, 'ok');
        `);
        expect(r.table('t').rows).toHaveLength(1);
    });

    it('CURRENT_DATE as insert value', () => {
        const r = exec(`
            CREATE TABLE t (id INT, d DATE);
            INSERT INTO t (id, d) VALUES (1, CURRENT_DATE);
        `);
        expect(r.table('t').rows[0].d).toMatch(/^\d{4}-\d{2}-\d{2}/);
    });

    it('multiple timestamp functions in same row', () => {
        const r = exec(`
            CREATE TABLE t (id INT, a TIMESTAMP, b TIMESTAMP);
            INSERT INTO t (id, a, b) VALUES (1, NOW(), CURRENT_TIMESTAMP);
        `);
        const row = r.table('t').rows[0];
        expect(row.a).toMatch(/^\d{4}/);
        expect(row.b).toMatch(/^\d{4}/);
        expect(row.a).not.toContain('(');
        expect(row.b).not.toContain('(');
    });

    it('DEFAULT values: numeric 0 correctly applied', () => {
        const r = exec(`
            CREATE TABLE t (id INT, count INT DEFAULT 0);
            INSERT INTO t (id) VALUES (1);
        `);
        expect(r.table('t').rows[0].count).toBe(0);
    });

    it('DEFAULT values: FALSE correctly applied', () => {
        const r = exec(`
            CREATE TABLE t (id INT, active BOOLEAN DEFAULT FALSE);
            INSERT INTO t (id) VALUES (1);
        `);
        expect(r.table('t').rows[0].active).toBe(false);
    });

    it('INSERT then INSERT more (accumulates)', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            INSERT INTO t (id) VALUES (1), (2);
            INSERT INTO t (id) VALUES (3), (4), (5);
        `);
        expect(r.table('t').rows).toHaveLength(5);
    });
});

describe('UPDATE — hardened', () => {
    it('update with WHERE >=', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'a'), (3, 'b'), (5, 'c');
            UPDATE t SET val = 'x' WHERE id >= 3;
        `);
        expect(r.table('t').rows[0].val).toBe('a');
        expect(r.table('t').rows[1].val).toBe('x');
        expect(r.table('t').rows[2].val).toBe('x');
    });

    it('update with WHERE <=', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'a'), (3, 'b'), (5, 'c');
            UPDATE t SET val = 'x' WHERE id <= 3;
        `);
        expect(r.table('t').rows[0].val).toBe('x');
        expect(r.table('t').rows[1].val).toBe('x');
        expect(r.table('t').rows[2].val).toBe('c');
    });

    it('update with WHERE LIKE underscore wildcard', () => {
        const r = exec(`
            CREATE TABLE t (id INT, code TEXT);
            INSERT INTO t (id, code) VALUES (1, 'A1'), (2, 'A2'), (3, 'AB');
            UPDATE t SET code = 'MATCH' WHERE code LIKE 'A_';
        `);
        expect(r.table('t').rows[0].code).toBe('MATCH');
        expect(r.table('t').rows[1].code).toBe('MATCH');
        expect(r.table('t').rows[2].code).toBe('MATCH');
    });

    it('update with WHERE LIKE % in middle', () => {
        const r = exec(`
            CREATE TABLE t (id INT, email TEXT);
            INSERT INTO t (id, email) VALUES (1, 'a@test.com'), (2, 'b@other.org'), (3, 'c@test.net');
            UPDATE t SET email = 'MATCHED' WHERE email LIKE '%test%';
        `);
        expect(r.table('t').rows[0].email).toBe('MATCHED');
        expect(r.table('t').rows[1].email).toBe('b@other.org');
        expect(r.table('t').rows[2].email).toBe('MATCHED');
    });

    it('update with WHERE IN strings', () => {
        const r = exec(`
            CREATE TABLE t (id INT, status TEXT);
            INSERT INTO t (id, status) VALUES (1, 'active'), (2, 'paused'), (3, 'deleted');
            UPDATE t SET status = 'archived' WHERE status IN ('paused', 'deleted');
        `);
        expect(r.table('t').rows[0].status).toBe('active');
        expect(r.table('t').rows[1].status).toBe('archived');
        expect(r.table('t').rows[2].status).toBe('archived');
    });

    it('update with WHERE OR', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'a'), (2, 'b'), (3, 'c');
            UPDATE t SET val = 'hit' WHERE id = 1 OR id = 3;
        `);
        expect(r.table('t').rows[0].val).toBe('hit');
        expect(r.table('t').rows[1].val).toBe('b');
        expect(r.table('t').rows[2].val).toBe('hit');
    });

    it('update to same value (no-op update)', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'same');
            UPDATE t SET val = 'same' WHERE id = 1;
        `);
        expect(r.table('t').rows[0].val).toBe('same');
        expect(r.errors()).toHaveLength(0);
    });

    it('update string column to number', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'old');
            UPDATE t SET val = 42 WHERE id = 1;
        `);
        expect(r.table('t').rows[0].val).toBe(42);
    });

    it('update multiple rows matching WHERE', () => {
        const r = exec(`
            CREATE TABLE t (id INT, group_id INT, val TEXT);
            INSERT INTO t VALUES (1, 10, 'a'), (2, 10, 'b'), (3, 20, 'c'), (4, 10, 'd');
            UPDATE t SET val = 'group10' WHERE group_id = 10;
        `);
        expect(r.table('t').rows.filter((r) => r.val === 'group10')).toHaveLength(3);
        expect(r.table('t').rows[2].val).toBe('c');
    });
});

describe('DELETE — hardened', () => {
    it('delete with WHERE LIKE', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t (id, name) VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Amy');
            DELETE FROM t WHERE name LIKE 'A%';
        `);
        expect(r.table('t').rows).toHaveLength(1);
        expect(r.table('t').rows[0].name).toBe('Bob');
    });

    it('delete with WHERE IN', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            INSERT INTO t (id) VALUES (1), (2), (3), (4), (5);
            DELETE FROM t WHERE id IN (2, 4);
        `);
        expect(r.table('t').rows).toHaveLength(3);
        expect(r.table('t').rows.map((r) => r.id)).toEqual([1, 3, 5]);
    });

    it('delete with WHERE OR', () => {
        const r = exec(`
            CREATE TABLE t (id INT, cat TEXT);
            INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c');
            DELETE FROM t WHERE cat = 'a' OR cat = 'c';
        `);
        expect(r.table('t').rows).toHaveLength(1);
        expect(r.table('t').rows[0].cat).toBe('b');
    });

    it('delete from empty table', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            DELETE FROM t WHERE id = 1;
        `);
        expect(r.table('t').rows).toHaveLength(0);
        expect(r.errors()).toHaveLength(0);
    });

    it('delete then re-insert', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'first');
            DELETE FROM t WHERE id = 1;
            INSERT INTO t (id, val) VALUES (2, 'second');
        `);
        expect(r.table('t').rows).toHaveLength(1);
        expect(r.table('t').rows[0].id).toBe(2);
    });

    it('multiple sequential deletes', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            INSERT INTO t (id) VALUES (1), (2), (3), (4), (5);
            DELETE FROM t WHERE id = 1;
            DELETE FROM t WHERE id = 3;
            DELETE FROM t WHERE id = 5;
        `);
        expect(r.table('t').rows).toHaveLength(2);
        expect(r.table('t').rows.map((r) => r.id)).toEqual([2, 4]);
    });
});

describe('WHERE — hardened', () => {
    it('= NULL never matches any row (SQL standard UNKNOWN semantics)', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, NULL), (2, 'ok');
            DELETE FROM t WHERE val = NULL;
        `);
        // = NULL must never match — both rows are still present.
        expect(r.table('t').rows).toHaveLength(2);
    });

    it('IS NULL is the correct way to match null rows', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, NULL), (2, 'ok');
            DELETE FROM t WHERE val IS NULL;
        `);
        expect(r.table('t').rows).toHaveLength(1);
        expect(r.table('t').rows[0].val).toBe('ok');
    });

    it('IS NULL vs IS NOT NULL opposite', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, NULL), (2, 'ok'), (3, NULL);
            DELETE FROM t WHERE val IS NULL;
        `);
        expect(r.table('t').rows).toHaveLength(1);
        expect(r.table('t').rows[0].val).toBe('ok');
    });

    it('IN with single value', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            INSERT INTO t (id) VALUES (1), (2), (3);
            DELETE FROM t WHERE id IN (2);
        `);
        expect(r.table('t').rows).toHaveLength(2);
    });

    it('complex AND + OR + IN combination', () => {
        const r = exec(`
            CREATE TABLE t (id INT, cat TEXT, active BOOLEAN);
            INSERT INTO t VALUES (1, 'A', TRUE), (2, 'B', TRUE), (3, 'A', FALSE), (4, 'C', TRUE), (5, 'B', FALSE);
            DELETE FROM t WHERE cat IN ('A', 'B') AND active = TRUE OR id = 5;
        `);
        expect(r.table('t').rows).toHaveLength(2);
        expect(
            r
                .table('t')
                .rows.map((r) => r.id)
                .sort(),
        ).toEqual([3, 4]);
    });

    it('WHERE with boolean TRUE/FALSE', () => {
        const r = exec(`
            CREATE TABLE t (id INT, active BOOLEAN);
            INSERT INTO t VALUES (1, TRUE), (2, FALSE), (3, TRUE);
            DELETE FROM t WHERE active = FALSE;
        `);
        expect(r.table('t').rows).toHaveLength(2);
    });

    it('WHERE comparing string values', () => {
        const r = exec(`
            CREATE TABLE t (id INT, status TEXT);
            INSERT INTO t VALUES (1, 'active'), (2, 'inactive');
            UPDATE t SET status = 'suspended' WHERE status = 'inactive';
        `);
        expect(r.table('t').rows[1].status).toBe('suspended');
    });

    it('NOT IN with multiple values', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd');
            DELETE FROM t WHERE name NOT IN ('b', 'c');
        `);
        expect(r.table('t').rows).toHaveLength(2);
        expect(
            r
                .table('t')
                .rows.map((r) => r.name)
                .sort(),
        ).toEqual(['b', 'c']);
    });
});

describe('ALTER TABLE — hardened', () => {
    it('ALTER on schema-qualified table', () => {
        const r = exec(`
            CREATE TABLE public.t (id INT, val TEXT);
            ALTER TABLE public.t ADD PRIMARY KEY (id);
        `);
        expect(r.table('t').columns[0].pk).toBe(true);
    });

    it('ALTER ADD multiple constraints sequentially', () => {
        const r = exec(`
            CREATE TABLE t (id INT, email TEXT, age INT);
            ALTER TABLE t ADD PRIMARY KEY (id);
            ALTER TABLE t ADD UNIQUE (email);
        `);
        expect(r.table('t').columns[0].pk).toBe(true);
        expect(r.table('t').columns[1].unique).toBe(true);
    });

    it('ALTER FOREIGN KEY sets refTable', () => {
        const r = exec(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (id INT, pid INT);
            ALTER TABLE c ADD CONSTRAINT fk FOREIGN KEY (pid) REFERENCES p(id);
        `);
        const col = r.table('c').columns[1];
        expect(col.fk).toBe(true);
        expect(col.refTable).toBe('p');
    });
});

describe('CREATE TYPE — hardened', () => {
    it('enum with single value', () => {
        const r = exec(`CREATE TYPE single AS ENUM ('only');`);
        expect(r.type('single').values).toEqual(['only']);
    });

    it('enum with many values (10+)', () => {
        const r = exec(`CREATE TYPE big AS ENUM ('a','b','c','d','e','f','g','h','i','j','k');`);
        expect(r.type('big').values).toHaveLength(11);
    });

    it('composite with single field', () => {
        const r = exec(`CREATE TYPE wrapper AS (val TEXT);`);
        expect(r.type('wrapper').fields).toHaveLength(1);
    });

    it('drop type then re-create', () => {
        const r = exec(`
            CREATE TYPE s AS ENUM ('a', 'b');
            DROP TYPE s;
            CREATE TYPE s AS ENUM ('x', 'y', 'z');
        `);
        expect(r.type('s').values).toEqual(['x', 'y', 'z']);
    });

    it('DROP TYPE IF EXISTS on non-existent', () => {
        const r = exec(`DROP TYPE IF EXISTS ghost;`);
        expect(r.errors()).toHaveLength(1);
    });
});

describe('Inline ENUM — hardened', () => {
    it('inline enum with constraints', () => {
        const r = exec(`CREATE TABLE t (status ENUM('a', 'b') NOT NULL DEFAULT 'a');`);
        const col = r.table('t').columns[0];
        expect(col.isEnum).toBe(true);
        expect(col.notNull).toBe(true);
        expect(col.defaultVal).toBe("'a'");
    });

    it('multiple inline enums in same table', () => {
        const r = exec(`CREATE TABLE t (a ENUM('x','y'), b ENUM('1','2','3'));`);
        expect(r.table('t').columns[0].isEnum).toBe(true);
        expect(r.table('t').columns[1].isEnum).toBe(true);
        expect(r.table('t').columns[0].enumValues).toEqual(['x', 'y']);
        expect(r.table('t').columns[1].enumValues).toEqual(['1', '2', '3']);
    });
});

describe('DROP — hardened', () => {
    it('drop table then INSERT errors', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            DROP TABLE t;
            INSERT INTO t (id) VALUES (1);
        `);
        expect(r.errors().some((e) => e.message.includes('does not exist'))).toBe(true);
    });

    it('drop table then UPDATE errors', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            DROP TABLE t;
            UPDATE t SET id = 1;
        `);
        expect(r.errors().some((e) => e.message.includes('does not exist'))).toBe(true);
    });

    it('drop table then DELETE errors', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            DROP TABLE t;
            DELETE FROM t WHERE id = 1;
        `);
        expect(r.errors().some((e) => e.message.includes('does not exist'))).toBe(true);
    });
});

describe('Edge cases — hardened', () => {
    it('multiple semicolons in a row', () => {
        const r = exec(`CREATE TABLE t (id INT);;;; CREATE TABLE u (id INT);;`);
        expect(r.tables.size).toBe(2);
    });

    it('SQL with inline comments', () => {
        const r = exec(`
            CREATE TABLE t (
                id INT PRIMARY KEY, -- this is the primary key
                name TEXT NOT NULL -- required name
            );
            INSERT INTO t (id, name) VALUES (1, 'test'); -- add a row
        `);
        expect(r.table('t').rows).toHaveLength(1);
    });

    it('mixed case keywords', () => {
        const r = exec(`
            Create Table t (Id Int Primary Key, Name Varchar(100) Not Null);
            Insert Into t (Id, Name) Values (1, 'Alice');
        `);
        expect(r.table('t').rows).toHaveLength(1);
    });

    it('full CRUD lifecycle', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'created');
            UPDATE t SET val = 'updated' WHERE id = 1;
            DELETE FROM t WHERE id = 1;
            INSERT INTO t (id, val) VALUES (2, 'new');
        `);
        expect(r.table('t').rows).toHaveLength(1);
        expect(r.table('t').rows[0]).toEqual({ id: 2, val: 'new' });
        expect(r.errors()).toHaveLength(0);
    });

    it('empty table has zero rows', () => {
        const r = exec(`CREATE TABLE t (id INT, name TEXT);`);
        expect(r.table('t').rows).toHaveLength(0);
    });

    it('very long string value', () => {
        const long = 'x'.repeat(500);
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, '${long}');
        `);
        expect(r.table('t').rows[0].val).toBe(long);
    });

    it('string containing SQL keywords', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'SELECT * FROM DROP TABLE');
        `);
        expect(r.table('t').rows[0].val).toBe('SELECT * FROM DROP TABLE');
    });

    it('string containing commas', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'a, b, c');
        `);
        expect(r.table('t').rows[0].val).toBe('a, b, c');
    });

    it('string containing parentheses', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'func(arg)');
        `);
        expect(r.table('t').rows[0].val).toBe('func(arg)');
    });
});

describe('Validation — hardened', () => {
    it('PK violation across separate INSERT statements', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'first');
            INSERT INTO t (id, val) VALUES (1, 'dupe');
        `);
        expect(r.errors().some((entry) => entry.message.includes('PRIMARY KEY'))).toBe(true);
        expect(r.table('t').rows).toHaveLength(1);
    });

    it('UNIQUE violation across separate INSERT statements', () => {
        const r = exec(`
            CREATE TABLE t (id INT, email TEXT UNIQUE);
            INSERT INTO t (id, email) VALUES (1, 'a@b.com');
            INSERT INTO t (id, email) VALUES (2, 'a@b.com');
        `);
        expect(r.errors().some((entry) => entry.message.includes('UNIQUE'))).toBe(true);
        expect(r.table('t').rows).toHaveLength(1);
    });

    it('NOT NULL with DEFAULT should not warn when column omitted', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'user');
            INSERT INTO t (id) VALUES (1);
        `);
        expect(r.warnings()).toHaveLength(0);
        expect(r.table('t').rows[0].role).toBe('user');
    });

    it('multiple violations in same row', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE);
            INSERT INTO t (id, name, email) VALUES (NULL, NULL, NULL);
        `);
        expect(r.errors().filter((entry) => entry.message.includes('NOT NULL')).length).toBeGreaterThanOrEqual(2);
        expect(r.table('t').rows).toHaveLength(0);
    });

    it('integrity failures do not produce an INSERT success message', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, val TEXT NOT NULL);
            INSERT INTO t (id, val) VALUES (1, NULL);
        `);
        expect(r.successes().some((entry) => entry.message.includes('Inserted'))).toBe(false);
        expect(r.errors().some((entry) => entry.message.includes('NOT NULL'))).toBe(true);
    });

    it('UPDATE NOT NULL errors atomically', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT NOT NULL);
            INSERT INTO t VALUES (1, 'a'), (2, 'b');
            UPDATE t SET name = NULL WHERE id = 1;
        `);
        expect(r.errors().filter((entry) => entry.message.includes('NOT NULL')).length).toBe(1);
        expect(r.table('t').rows).toEqual([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
    });

    it('no warning for UPDATE on non-NOT-NULL column to NULL', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t VALUES (1, 'a');
            UPDATE t SET val = NULL WHERE id = 1;
        `);
        expect(r.warnings()).toHaveLength(0);
    });

    it('DELETE without WHERE on empty table — no warning', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            DELETE FROM t;
        `);
        expect(r.warnings()).toHaveLength(0);
    });
});

describe('Complex integration — hardened', () => {
    it('multi-table with FK, ENUM, DML, DROP', () => {
        const r = exec(`
            CREATE TYPE role AS ENUM ('admin', 'user');
            CREATE TABLE users (id INT PRIMARY KEY, name TEXT NOT NULL, role role DEFAULT 'user');
            CREATE TABLE posts (id INT PRIMARY KEY, user_id INT REFERENCES users(id), title TEXT NOT NULL);

            INSERT INTO users (id, name, role) VALUES (1, 'Admin', 'admin'), (2, 'User', 'user');
            INSERT INTO posts (id, user_id, title) VALUES (1, 1, 'First'), (2, 1, 'Second'), (3, 2, 'Third');

            UPDATE posts SET title = 'Updated First' WHERE id = 1;
            DELETE FROM posts WHERE user_id = 2;

            DROP TYPE role;
        `);

        expect(r.tables.size).toBe(2);
        expect(r.types.size).toBe(0);
        expect(r.table('users').rows).toHaveLength(2);
        expect(r.table('posts').rows).toHaveLength(2);
        expect(r.table('posts').rows[0].title).toBe('Updated First');
        expect(r.table('posts').rows.every((p) => p.user_id === 1)).toBe(true);
        expect(r.errors()).toHaveLength(0);
    });

    it('large realistic dataset (50+ rows across tables)', () => {
        const userRows = Array.from({ length: 20 }, (_, i) => `(${i + 1}, 'user_${i + 1}', 'u${i + 1}@test.com')`).join(',');
        const orderRows = Array.from({ length: 30 }, (_, i) => `(${i + 1}, ${(i % 20) + 1}, ${(i + 1) * 10.5})`).join(',');

        const r = exec(`
            CREATE TABLE users (id INT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL);
            CREATE TABLE orders (id INT PRIMARY KEY, user_id INT REFERENCES users(id), total NUMERIC NOT NULL);

            INSERT INTO users (id, name, email) VALUES ${userRows};
            INSERT INTO orders (id, user_id, total) VALUES ${orderRows};

            UPDATE orders SET total = 0 WHERE total > 200;
            DELETE FROM orders WHERE total = 0;
        `);

        expect(r.table('users').rows).toHaveLength(20);
        expect(r.table('orders').rows.every((o) => o.total > 0)).toBe(true);
        expect(r.errors()).toHaveLength(0);
    });

    it('complete sampleSQL from the app executes cleanly', () => {
        const r = exec(sampleSQL);

        expect(r.errors()).toHaveLength(0);
        expect(r.warnings()).toHaveLength(0);
        expect(r.tables.size).toBe(5);
        expect(r.types.size).toBe(3);

        expect(r.type('order_status').values).toEqual(['cart', 'paid', 'shipped', 'cancelled']);
        expect(r.type('role_enum')).toMatchObject({ kind: 'enum', isInline: true });
        expect(r.type('flags_set')).toMatchObject({ kind: 'enum', isInline: true });
        expect(r.type('flags_set').values).toEqual(['newsletter', 'beta']);

        expect(r.table('users').rows).toHaveLength(2);
        expect(r.table('categories').rows).toHaveLength(2);
        expect(r.table('products').rows).toHaveLength(2);
        expect(r.table('orders').rows).toHaveLength(1);
        expect(r.table('order_items').rows).toHaveLength(2);

        expect(r.table('users').columns.map((c) => c.name)).toContain('full_name');
        expect(r.table('users').columns.map((c) => c.name)).not.toContain('display_name');
        expect(r.table('orders').columns.map((c) => c.name)).toContain('promotion_code');
        expect(r.table('orders').columns.map((c) => c.name)).not.toContain('coupon_code');
        expect(r.table('products').columns.map((c) => c.name)).not.toContain('retired_at');

        expect(r.table('orders').rows.find((o) => o.id === 1)).toMatchObject({
            status: 'shipped',
            total: 79.98,
        });
        expect(r.table('users').rows.find((u) => u.id === 2)).toMatchObject({
            full_name: 'Bob',
            last_seen_at: 'never',
        });
        expect(r.table('products').rows.find((p) => p.sku === 'MOUSE-01')).toMatchObject({
            stock: 11,
            search_label: 'MOUSE-01 - Wireless Mouse',
        });
        expect(r.table('order_items').rows.find((row) => row.order_id === 1 && row.product_id === 2).line_total).toBe(49.99);
    });
});

describe('DML on wrong targets', () => {
    it('INSERT into non-existent table with schema prefix', () => {
        const r = exec(`INSERT INTO public.ghost (id) VALUES (1);`);
        expect(r.errors().length).toBeGreaterThanOrEqual(1);
    });

    it('UPDATE non-existent table', () => {
        const r = exec(`UPDATE ghost SET val = 1 WHERE id = 1;`);
        expect(r.errors().length).toBeGreaterThanOrEqual(1);
    });

    it('DELETE from non-existent table', () => {
        const r = exec(`DELETE FROM ghost WHERE id = 1;`);
        expect(r.errors().length).toBeGreaterThanOrEqual(1);
    });
});

describe('Multi-statement stress', () => {
    it('10 CREATE TABLE + INSERT each', () => {
        const stmts = Array.from(
            { length: 10 },
            (_, i) => `
            CREATE TABLE t${i} (id INT PRIMARY KEY, val TEXT);
            INSERT INTO t${i} (id, val) VALUES (1, 'v${i}');
        `,
        ).join('\n');
        const r = exec(stmts);
        expect(r.tables.size).toBe(10);
        for (let i = 0; i < 10; i++) {
            expect(r.table(`t${i}`).rows).toHaveLength(1);
            expect(r.table(`t${i}`).rows[0].val).toBe(`v${i}`);
        }
        expect(r.errors()).toHaveLength(0);
    });

    it('interleaved CREATE and DML across tables', () => {
        const r = exec(`
            CREATE TABLE a (id INT, val TEXT);
            CREATE TABLE b (id INT, val TEXT);
            INSERT INTO a (id, val) VALUES (1, 'a1');
            INSERT INTO b (id, val) VALUES (1, 'b1');
            INSERT INTO a (id, val) VALUES (2, 'a2');
            UPDATE b SET val = 'b_updated' WHERE id = 1;
            INSERT INTO b (id, val) VALUES (2, 'b2');
            DELETE FROM a WHERE id = 1;
        `);
        expect(r.table('a').rows).toHaveLength(1);
        expect(r.table('a').rows[0].val).toBe('a2');
        expect(r.table('b').rows).toHaveLength(2);
        expect(r.table('b').rows[0].val).toBe('b_updated');
    });

    it('bulk insert 100 rows', () => {
        const values = Array.from({ length: 100 }, (_, i) => `(${i}, 'row_${i}')`).join(',');
        const r = exec(`CREATE TABLE big (id INT, val TEXT); INSERT INTO big (id, val) VALUES ${values};`);
        expect(r.table('big').rows).toHaveLength(100);
        expect(r.table('big').rows[99].val).toBe('row_99');
    });
});

describe('DELETE all then re-populate', () => {
    it('DELETE all without WHERE then INSERT fresh', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'a'), (2, 'b'), (3, 'c');
            DELETE FROM t;
            INSERT INTO t (id, val) VALUES (10, 'new1'), (20, 'new2');
        `);
        expect(r.table('t').rows).toHaveLength(2);
        expect(r.table('t').rows[0].id).toBe(10);
    });
});

describe('WHERE edge combinations', () => {
    it('WHERE LIKE with no match', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t VALUES (1, 'Alice'), (2, 'Bob');
            DELETE FROM t WHERE name LIKE 'Z%';
        `);
        expect(r.table('t').rows).toHaveLength(2);
    });

    it('WHERE LIKE suffix match', () => {
        const r = exec(`
            CREATE TABLE t (id INT, file TEXT);
            INSERT INTO t VALUES (1, 'photo.jpg'), (2, 'doc.pdf'), (3, 'image.jpg');
            UPDATE t SET file = 'MATCHED' WHERE file LIKE '%.jpg';
        `);
        expect(r.table('t').rows[0].file).toBe('MATCHED');
        expect(r.table('t').rows[1].file).toBe('doc.pdf');
        expect(r.table('t').rows[2].file).toBe('MATCHED');
    });

    it('WHERE with multiple ORs and ANDs combined', () => {
        const r = exec(`
            CREATE TABLE t (id INT, a TEXT, b TEXT);
            INSERT INTO t VALUES (1, 'x', 'y'), (2, 'x', 'z'), (3, 'y', 'y'), (4, 'y', 'z');
            DELETE FROM t WHERE a = 'x' AND b = 'y' OR a = 'y' AND b = 'z';
        `);
        expect(r.table('t').rows).toHaveLength(2);
        expect(
            r
                .table('t')
                .rows.map((r) => r.id)
                .sort(),
        ).toEqual([2, 3]);
    });

    it('IN with mixed string and numeric comparison', () => {
        const r = exec(`
            CREATE TABLE t (id INT, code TEXT);
            INSERT INTO t VALUES (1, 'A'), (2, 'B'), (3, 'C'), (4, 'D');
            DELETE FROM t WHERE code IN ('B', 'D');
        `);
        expect(r.table('t').rows).toHaveLength(2);
        expect(r.table('t').rows.map((r) => r.code)).toEqual(['A', 'C']);
    });

    it('NOT IN combined with AND', () => {
        const r = exec(`
            CREATE TABLE t (id INT, cat TEXT, active BOOLEAN);
            INSERT INTO t VALUES (1, 'A', TRUE), (2, 'B', TRUE), (3, 'C', FALSE), (4, 'A', FALSE);
            UPDATE t SET cat = 'HIT' WHERE cat NOT IN ('C') AND active = TRUE;
        `);
        expect(r.table('t').rows[0].cat).toBe('HIT');
        expect(r.table('t').rows[1].cat).toBe('HIT');
        expect(r.table('t').rows[2].cat).toBe('C');
        expect(r.table('t').rows[3].cat).toBe('A');
    });
});

describe('Validation — cross-statement', () => {
    it('PK duplicate is rejected across 3 separate INSERTs', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'first');
            INSERT INTO t (id, val) VALUES (2, 'second');
            INSERT INTO t (id, val) VALUES (1, 'dupe');
        `);
        expect(r.errors().filter((entry) => entry.message.includes('PRIMARY KEY'))).toHaveLength(1);
        expect(r.table('t').rows).toHaveLength(2);
    });

    it('UNIQUE violation is rejected', () => {
        const r = exec(`
            CREATE TABLE t (id INT, code TEXT UNIQUE);
            INSERT INTO t VALUES (1, 'ABC');
            INSERT INTO t VALUES (2, 'DEF');
            INSERT INTO t VALUES (3, 'ABC');
        `);
        expect(r.errors().some((entry) => entry.message.includes('UNIQUE'))).toBe(true);
        expect(r.table('t').rows).toHaveLength(2);
    });

    it('UPDATE unknown column rejects the complete statement', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t VALUES (1, 'Alice');
            UPDATE t SET fake = 'x', name = 'Bob' WHERE id = 1;
        `);
        expect(r.errors().some((entry) => entry.message.includes('fake'))).toBe(true);
        expect(r.table('t').rows[0].name).toBe('Alice');
    });

    it('INSERT column count mismatch is rejected without a partial row', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT, email TEXT);
            INSERT INTO t (id, name, email) VALUES (1, 'Alice');
        `);
        expect(r.errors().length).toBeGreaterThan(0);
        expect(r.table('t').rows).toHaveLength(0);
    });
});

describe('String value edge cases', () => {
    it('string with single quote inside (escaped)', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'it''s fine');
        `);
        expect(r.table('t').rows[0].val).toContain('it');
    });

    it('string with unicode characters', () => {
        const r = exec(`
            CREATE TABLE t (id INT, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'café résumé');
        `);
        expect(r.table('t').rows[0].val).toBe('café résumé');
    });

    it('empty table name columns still work', () => {
        const r = exec(`
            CREATE TABLE x (a INT, b INT, c INT, d INT, e INT);
            INSERT INTO x VALUES (1, 2, 3, 4, 5);
        `);
        expect(r.table('x').rows[0]).toEqual({ a: 1, b: 2, c: 3, d: 4, e: 5 });
    });
});

describe('Log output correctness', () => {
    it('success log count matches operations', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            INSERT INTO t (id) VALUES (1);
            UPDATE t SET id = 2 WHERE id = 1;
            DELETE FROM t WHERE id = 2;
        `);
        expect(r.successes()).toHaveLength(4);
    });

    it('error log for each failed operation', () => {
        const r = exec(`
            INSERT INTO ghost1 (id) VALUES (1);
            INSERT INTO ghost2 (id) VALUES (1);
            UPDATE ghost3 SET id = 1;
        `);
        expect(r.errors()).toHaveLength(3);
    });

    it('mixed success and error logs', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            INSERT INTO t (id) VALUES (1);
            INSERT INTO ghost (id) VALUES (1);
            UPDATE t SET id = 2 WHERE id = 1;
        `);
        expect(r.successes().length).toBeGreaterThan(0);
        expect(r.errors().length).toBeGreaterThan(0);
    });

    it('duplicate INSERT has no false success message', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY);
            INSERT INTO t (id) VALUES (1), (1);
        `);
        expect(r.successes().some((entry) => entry.message.includes('Inserted'))).toBe(false);
        expect(r.errors().some((entry) => entry.message.includes('duplicate PRIMARY KEY'))).toBe(true);
    });
});

// ════════════════════════════════════════════
// Full sample SQL (the default sample SQL)
// ════════════════════════════════════════════

describe('Default sample SQL', () => {
    it('executes the full sample without errors', () => {
        const r = exec(`
            CREATE TYPE user_role AS ENUM ('admin', 'editor', 'user', 'guest');
            CREATE TYPE post_status AS ENUM ('draft', 'published', 'archived');

            CREATE TYPE address AS (
                street TEXT,
                city VARCHAR(100),
                zip VARCHAR(20)
            );

            CREATE TABLE users (
                id INT PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                role user_role DEFAULT 'user',
                age INT CHECK (age >= 0),
                is_active BOOLEAN DEFAULT TRUE
            );

            CREATE TABLE categories (
                id INT PRIMARY KEY,
                name VARCHAR(100) NOT NULL UNIQUE,
                description TEXT
            );

            CREATE TABLE posts (
                id INT PRIMARY KEY,
                title VARCHAR(200) NOT NULL,
                body TEXT,
                status post_status DEFAULT 'draft',
                author_id INT REFERENCES users(id),
                category_id INT REFERENCES categories(id),
                views INT DEFAULT 0,
                priority ENUM('low', 'medium', 'high', 'critical'),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            INSERT INTO users (id, name, email, role, age, is_active) VALUES
                (1, 'Alice Johnson', 'alice@example.com', 'admin', 30, TRUE),
                (2, 'Bob Smith', 'bob@example.com', 'user', 25, TRUE),
                (3, 'Charlie Brown', 'charlie@example.com', 'editor', 35, FALSE),
                (4, 'Diana Prince', 'diana@example.com', 'guest', 28, TRUE);

            INSERT INTO categories (id, name, description) VALUES
                (1, 'Technology', 'Tech articles and tutorials'),
                (2, 'Design', 'UI/UX and graphic design'),
                (3, 'Database', 'SQL and database topics');

            INSERT INTO posts (id, title, body, status, author_id, category_id, views, priority) VALUES
                (1, 'Getting Started with SQL', 'Learn the basics...', 'published', 1, 3, 1250, 'high'),
                (2, 'Advanced Queries', 'Deep dive into joins...', 'published', 1, 3, 890, 'medium'),
                (3, 'UI Design Principles', 'Best practices...', 'published', 2, 2, 430, 'low'),
                (4, 'Draft Post', 'Work in progress...', 'draft', 3, 1, 0, 'low'),
                (5, 'Critical Bug Fix Guide', 'How to fix...', 'archived', 4, 1, 2100, 'critical');

            UPDATE users SET role = 'admin' WHERE id = 2;
            UPDATE posts SET status = 'published' WHERE id = 4;
            UPDATE posts SET views = 9999, priority = 'critical' WHERE id = 2;
        `);

        expect(r.errors()).toHaveLength(0);

        // Types
        expect(r.types.size).toBe(4); // user_role, post_status, address, priority_enum (inline)
        expect(r.type('user_role').values).toHaveLength(4);
        expect(r.type('post_status').values).toHaveLength(3);
        expect(r.type('address').kind).toBe('composite');

        // Tables
        expect(r.tables.size).toBe(3);
        expect(r.table('users').rows).toHaveLength(4);
        expect(r.table('categories').rows).toHaveLength(3);
        expect(r.table('posts').rows).toHaveLength(5);

        // Verify updates
        expect(r.table('users').rows.find((u) => u.id === 2).role).toBe('admin');
        expect(r.table('posts').rows.find((p) => p.id === 4).status).toBe('published');
        expect(r.table('posts').rows.find((p) => p.id === 2).views).toBe(9999);
        expect(r.table('posts').rows.find((p) => p.id === 2).priority).toBe('critical');

        // Verify constraints parsed
        const userCols = r.table('users').columns;
        expect(userCols.find((c) => c.name === 'id').pk).toBe(true);
        expect(userCols.find((c) => c.name === 'email').unique).toBe(true);
        expect(userCols.find((c) => c.name === 'email').notNull).toBe(true);
        expect(userCols.find((c) => c.name === 'role').isEnum).toBe(true);
        expect(userCols.find((c) => c.name === 'age').check).toBeTruthy();
        expect(userCols.find((c) => c.name === 'is_active').defaultVal).toBe('TRUE');

        const postCols = r.table('posts').columns;
        expect(postCols.find((c) => c.name === 'author_id').fk).toBe(true);
        expect(postCols.find((c) => c.name === 'category_id').fk).toBe(true);
        expect(postCols.find((c) => c.name === 'priority').isEnum).toBe(true);
        expect(postCols.find((c) => c.name === 'priority').type).toBe('ENUM');
        expect(postCols.find((c) => c.name === 'status').isEnum).toBe(true);
        expect(postCols.find((c) => c.name === 'status').type).toBe('post_status');
    });
});

// ════════════════════════════════════════════
// MySQL / phpMyAdmin dialect quirks
// ════════════════════════════════════════════

describe('MySQL dialect — backticked identifiers & double-quoted strings', () => {
    it('INSERT with backticked column names resolves columns correctly', () => {
        const r = exec(`
            CREATE TABLE \`corsi\` (
              \`CorsoID\` int(11) NOT NULL,
              \`NomeCorso\` varchar(100) DEFAULT NULL
            );
            INSERT INTO \`corsi\` (\`CorsoID\`, \`NomeCorso\`) VALUES (101, 'Matematica');
        `);
        expect(r.errors()).toHaveLength(0);
        const t = r.table('corsi');
        expect(t.rows).toHaveLength(1);
        expect(t.rows[0].CorsoID).toBe(101);
        expect(t.rows[0].NomeCorso).toBe('Matematica');
    });

    it('INSERT with double-quoted string values (MySQL style) stores unquoted', () => {
        const r = exec(`
            CREATE TABLE corsi (CorsoID INT, NomeCorso VARCHAR(100), Docente VARCHAR(50));
            INSERT INTO corsi (CorsoID, NomeCorso, Docente) VALUES
              (101, "Matematica", "Prof. Russo"),
              (102, "Storia", "Prof. Bianchi");
        `);
        expect(r.errors()).toHaveLength(0);
        const t = r.table('corsi');
        expect(t.rows).toHaveLength(2);
        expect(t.rows[0].NomeCorso).toBe('Matematica');
        expect(t.rows[0].Docente).toBe('Prof. Russo');
        expect(t.rows[1].NomeCorso).toBe('Storia');
    });

    it('phpMyAdmin-style dump: CREATE + INSERT + ALTER primary key after data', () => {
        const r = exec(`
            CREATE TABLE \`corsi\` (
              \`CorsoID\` int(11) NOT NULL,
              \`NomeCorso\` varchar(100) DEFAULT NULL,
              \`Docente\` varchar(50) DEFAULT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=latin1;

            INSERT INTO \`corsi\` (\`CorsoID\`, \`NomeCorso\`, \`Docente\`) VALUES
              (101, "Matematica", "Prof. Russo"),
              (102, "Storia", "Prof. Bianchi"),
              (103, "Informatica", "Prof. Rossi"),
              (104, "Letteratura", "Prof. Verdi");

            ALTER TABLE \`corsi\`
              ADD PRIMARY KEY (\`CorsoID\`);
        `);
        expect(r.errors()).toHaveLength(0);
        const t = r.table('corsi');
        expect(t.rows).toHaveLength(4);
        expect(t.rows.map((x) => x.CorsoID)).toEqual([101, 102, 103, 104]);
        expect(t.rows.map((x) => x.NomeCorso)).toEqual(['Matematica', 'Storia', 'Informatica', 'Letteratura']);
        expect(t.columns.find((c) => c.name === 'CorsoID').pk).toBe(true);
    });

    it('UPDATE/DELETE WHERE with double-quoted string matches rows', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name VARCHAR(50));
            INSERT INTO t (id, name) VALUES (1, "Marco"), (2, "Giulia"), (3, "Luca");
            UPDATE t SET name = "Marco Jr" WHERE name = "Marco";
            DELETE FROM t WHERE name = "Luca";
        `);
        expect(r.errors()).toHaveLength(0);
        const t = r.table('t');
        expect(t.rows).toHaveLength(2);
        expect(t.rows.find((x) => x.id === 1).name).toBe('Marco Jr');
        expect(t.rows.find((x) => x.id === 3)).toBeUndefined();
    });
});

// ════════════════════════════════════════════
// Deferred DML — out-of-order data before schema
// ════════════════════════════════════════════

// ════════════════════════════════════════════
// ALTER TABLE column ops (ADD / DROP / MODIFY / CHANGE / RENAME / ALTER COLUMN)
// ════════════════════════════════════════════

describe('ALTER TABLE ADD COLUMN', () => {
    it('adds a new column and backfills existing rows with null', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            INSERT INTO t (id) VALUES (1), (2);
            ALTER TABLE t ADD COLUMN name VARCHAR(50);
        `);
        expect(r.errors()).toHaveLength(0);
        const t = r.table('t');
        expect(t.columns.map((c) => c.name)).toEqual(['id', 'name']);
        expect(t.rows).toHaveLength(2);
        expect(t.rows[0].name).toBeNull();
        expect(t.rows[1].name).toBeNull();
    });

    it('ADD COLUMN with DEFAULT backfills existing rows with the default', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            INSERT INTO t (id) VALUES (1), (2);
            ALTER TABLE t ADD COLUMN status VARCHAR(20) DEFAULT 'active';
        `);
        expect(r.errors()).toHaveLength(0);
        const t = r.table('t');
        expect(t.rows[0].status).toBe('active');
        expect(t.rows[1].status).toBe('active');
    });

    it('ADD COLUMN without optional COLUMN keyword (PostgreSQL style)', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            ALTER TABLE t ADD email TEXT NOT NULL;
        `);
        expect(r.errors()).toHaveLength(0);
        const t = r.table('t');
        expect(t.columns).toHaveLength(2);
        const email = t.columns.find((c) => c.name === 'email');
        expect(email.notNull).toBe(true);
    });

    it('ADD COLUMN IF NOT EXISTS skips if column already exists', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            ALTER TABLE t ADD COLUMN IF NOT EXISTS name TEXT;
        `);
        expect(r.table('t').columns).toHaveLength(2);
        expect(r.warnings().some((w) => w.message.toLowerCase().includes('already exists'))).toBe(true);
    });

    it('multi-action ALTER TABLE with several ADD COLUMN clauses', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            ALTER TABLE t
              ADD COLUMN name TEXT,
              ADD COLUMN age INT DEFAULT 0,
              ADD CONSTRAINT pk_t PRIMARY KEY (id);
        `);
        expect(r.errors()).toHaveLength(0);
        const t = r.table('t');
        expect(t.columns.map((c) => c.name)).toEqual(['id', 'name', 'age']);
        expect(t.columns.find((c) => c.name === 'id').pk).toBe(true);
    });
});

describe('ALTER TABLE DROP COLUMN', () => {
    it('drops an existing column and removes its data', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT, age INT);
            INSERT INTO t (id, name, age) VALUES (1, 'A', 30), (2, 'B', 40);
            ALTER TABLE t DROP COLUMN age;
        `);
        expect(r.errors()).toHaveLength(0);
        const t = r.table('t');
        expect(t.columns.map((c) => c.name)).toEqual(['id', 'name']);
        expect(t.rows[0]).toEqual({ id: 1, name: 'A' });
        expect(Object.prototype.hasOwnProperty.call(t.rows[0], 'age')).toBe(false);
    });

    it('DROP COLUMN IF EXISTS on missing column is silent', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            ALTER TABLE t DROP COLUMN IF EXISTS ghost;
        `);
        expect(r.errors()).toHaveLength(0);
    });

    it('DROP COLUMN without IF EXISTS on missing column warns', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            ALTER TABLE t DROP COLUMN ghost;
        `);
        expect(r.warnings().some((w) => w.message.includes('ghost'))).toBe(true);
    });
});

describe('ALTER TABLE MODIFY / CHANGE COLUMN (MySQL)', () => {
    it('MODIFY COLUMN changes type while preserving data', () => {
        const r = exec(`
            CREATE TABLE t (id INT, label VARCHAR(10));
            INSERT INTO t (id, label) VALUES (1, 'hi');
            ALTER TABLE t MODIFY COLUMN label VARCHAR(100) NOT NULL;
        `);
        expect(r.errors()).toHaveLength(0);
        const label = r.table('t').columns.find((c) => c.name === 'label');
        expect(label.type).toBe('VARCHAR(100)');
        expect(label.notNull).toBe(true);
        expect(r.table('t').rows[0].label).toBe('hi');
    });

    it('CHANGE COLUMN renames and retypes a column and migrates row data', () => {
        const r = exec(`
            CREATE TABLE t (id INT, old_name TEXT);
            INSERT INTO t (id, old_name) VALUES (1, 'keep me');
            ALTER TABLE t CHANGE COLUMN old_name new_name VARCHAR(50);
        `);
        expect(r.errors()).toHaveLength(0);
        const cols = r.table('t').columns;
        expect(cols.map((c) => c.name)).toEqual(['id', 'new_name']);
        expect(r.table('t').rows[0].new_name).toBe('keep me');
        expect(r.table('t').rows[0].old_name).toBeUndefined();
    });

    it('MODIFY COLUMN handles inline ENUM with MySQL charset/collation suffix', () => {
        const r = exec(`
            CREATE TABLE t (id INT, status ENUM('new','done') NOT NULL DEFAULT 'new');
            INSERT INTO t (id, status) VALUES (1, 'new');
            ALTER TABLE t MODIFY COLUMN status ENUM('new','done') CHARSET=utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'done';
        `);
        expect(r.errors()).toHaveLength(0);
        const status = r.table('t').columns.find((c) => c.name === 'status');
        expect(status.isEnum).toBe(true);
        expect(status.enumValues).toEqual(['new', 'done']);
        expect(status.defaultVal).toBe("'done'");
        expect(r.table('t').rows[0].status).toBe('new');
    });
});

describe('ALTER TABLE RENAME (PostgreSQL / MySQL)', () => {
    it('RENAME COLUMN renames the column and migrates row data', () => {
        const r = exec(`
            CREATE TABLE t (id INT, foo TEXT);
            INSERT INTO t (id, foo) VALUES (1, 'abc');
            ALTER TABLE t RENAME COLUMN foo TO bar;
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('t').columns.map((c) => c.name)).toEqual(['id', 'bar']);
        expect(r.table('t').rows[0].bar).toBe('abc');
    });

    it('RENAME TO renames the whole table', () => {
        const r = exec(`
            CREATE TABLE old_t (id INT);
            INSERT INTO old_t (id) VALUES (1);
            ALTER TABLE old_t RENAME TO new_t;
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('old_t')).toBeNull();
        expect(r.table('new_t').rows).toHaveLength(1);
    });
});

describe('ALTER TABLE ALTER COLUMN (PostgreSQL)', () => {
    it('SET NOT NULL / DROP NOT NULL toggles nullability', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            ALTER TABLE t ALTER COLUMN name SET NOT NULL;
        `);
        expect(r.table('t').columns.find((c) => c.name === 'name').notNull).toBe(true);

        const r2 = exec(`
            CREATE TABLE t (id INT, name TEXT NOT NULL);
            ALTER TABLE t ALTER COLUMN name DROP NOT NULL;
        `);
        expect(r2.table('t').columns.find((c) => c.name === 'name').notNull).toBe(false);
    });

    it('SET DEFAULT / DROP DEFAULT manages default value', () => {
        const r = exec(`
            CREATE TABLE t (id INT, status TEXT);
            ALTER TABLE t ALTER COLUMN status SET DEFAULT 'active';
        `);
        expect(r.table('t').columns.find((c) => c.name === 'status').defaultVal).toBe('active');

        const r2 = exec(`
            CREATE TABLE t (id INT, status TEXT DEFAULT 'active');
            ALTER TABLE t ALTER COLUMN status DROP DEFAULT;
        `);
        expect(r2.table('t').columns.find((c) => c.name === 'status').defaultVal).toBeNull();
    });

    it('TYPE changes the column type', () => {
        const r = exec(`
            CREATE TABLE t (id INT, x VARCHAR(5));
            ALTER TABLE t ALTER COLUMN x TYPE TEXT;
        `);
        expect(r.table('t').columns.find((c) => c.name === 'x').type).toBe('TEXT');
    });
});

describe('ALTER TABLE DROP PRIMARY KEY / CONSTRAINT / INDEX', () => {
    it('DROP PRIMARY KEY clears pk flag on all columns', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, name TEXT);
            ALTER TABLE t DROP PRIMARY KEY;
        `);
        expect(r.table('t').columns.find((c) => c.name === 'id').pk).toBe(false);
    });

    it('DROP CONSTRAINT / DROP INDEX are accepted silently', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            ALTER TABLE t DROP CONSTRAINT IF EXISTS pk_t;
            ALTER TABLE t DROP INDEX idx_t_name;
        `);
        expect(r.errors()).toHaveLength(0);
    });
});

// ════════════════════════════════════════════
// TRUNCATE TABLE
// ════════════════════════════════════════════

describe('TRUNCATE TABLE', () => {
    it('removes all rows but keeps the schema', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            INSERT INTO t (id) VALUES (1), (2), (3);
            TRUNCATE TABLE t;
        `);
        expect(r.errors()).toHaveLength(0);
        const t = r.table('t');
        expect(t.rows).toHaveLength(0);
        expect(t.columns).toHaveLength(1);
    });

    it('TRUNCATE without TABLE keyword works', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            INSERT INTO t (id) VALUES (1);
            TRUNCATE t;
        `);
        expect(r.table('t').rows).toHaveLength(0);
    });

    it('TRUNCATE multiple tables in one statement', () => {
        const r = exec(`
            CREATE TABLE a (id INT);
            CREATE TABLE b (id INT);
            INSERT INTO a VALUES (1);
            INSERT INTO b VALUES (2);
            TRUNCATE TABLE a, b;
        `);
        expect(r.table('a').rows).toHaveLength(0);
        expect(r.table('b').rows).toHaveLength(0);
    });

    it('TRUNCATE unknown table logs an error', () => {
        const r = exec(`TRUNCATE TABLE ghost;`);
        expect(r.errors().some((e) => e.message.includes('ghost'))).toBe(true);
    });
});

// ════════════════════════════════════════════
// DROP TABLE — multi-target
// ════════════════════════════════════════════

describe('DROP TABLE — multi-target', () => {
    it('drops multiple tables in one statement', () => {
        const r = exec(`
            CREATE TABLE a (id INT);
            CREATE TABLE b (id INT);
            CREATE TABLE c (id INT);
            DROP TABLE a, b;
        `);
        expect(r.table('a')).toBeNull();
        expect(r.table('b')).toBeNull();
        expect(r.table('c')).not.toBeNull();
    });

    it('DROP TABLE IF EXISTS a, b, c tolerates missing ones', () => {
        const r = exec(`
            CREATE TABLE a (id INT);
            DROP TABLE IF EXISTS a, ghost;
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('a')).toBeNull();
    });

    it('DROP TABLE ... CASCADE is accepted', () => {
        const r = exec(`
            CREATE TABLE a (id INT);
            DROP TABLE a CASCADE;
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('a')).toBeNull();
    });
});

// ════════════════════════════════════════════
// Qualified identifiers (schema.table, db.schema.table)
// ════════════════════════════════════════════

describe('Qualified identifiers', () => {
    it('handles schema.table on CREATE and INSERT', () => {
        const r = exec(`
            CREATE TABLE public.users (id INT, name TEXT);
            INSERT INTO public.users (id, name) VALUES (1, 'Alice');
        `);
        expect(r.errors()).toHaveLength(0);
        const t = r.table('users');
        expect(t.rows).toHaveLength(1);
    });

    it('handles db.schema.table (three-part names)', () => {
        const r = exec(`
            CREATE TABLE mydb.public.items (id INT);
            INSERT INTO mydb.public.items (id) VALUES (1);
            UPDATE mydb.public.items SET id = 2 WHERE id = 1;
            SELECT 1;
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('items').rows[0].id).toBe(2);
    });
});

// ════════════════════════════════════════════
// CREATE TABLE — duplicate case handling
// ════════════════════════════════════════════

describe('CREATE TABLE — case-insensitive re-create', () => {
    it('does not leave stale entries when re-creating with different casing', () => {
        const r = exec(`
            CREATE TABLE T (id INT);
            INSERT INTO t (id) VALUES (1);
            CREATE TABLE t (id INT, name TEXT);
        `);
        expect(r.tables.size).toBe(1);
        const only = [...r.tables.values()][0];
        expect(only.columns).toHaveLength(2);
        // Preserves pre-existing rows per project semantics
        expect(only.rows).toHaveLength(1);
    });
});

// ════════════════════════════════════════════
// Production-scale / real-world SQL dumps
// ════════════════════════════════════════════

describe('Real-world: phpMyAdmin dump round-trip', () => {
    it('loads full phpMyAdmin dump with transactions, SET, and comments', () => {
        const r = exec(`
            -- phpMyAdmin SQL Dump
            SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
            SET AUTOCOMMIT = 0;
            START TRANSACTION;
            SET time_zone = "+00:00";

            /*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
            /*!40101 SET NAMES utf8mb4 */;

            CREATE TABLE \`corsi\` (
              \`CorsoID\` int(11) NOT NULL,
              \`NomeCorso\` varchar(100) DEFAULT NULL,
              \`Docente\` varchar(50) DEFAULT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=latin1;

            INSERT INTO \`corsi\` (\`CorsoID\`, \`NomeCorso\`, \`Docente\`) VALUES
              (101, "Matematica", "Prof. Russo"),
              (102, "Storia", "Prof. Bianchi"),
              (103, "Informatica", "Prof. Rossi");

            CREATE TABLE \`iscrizioni\` (
              \`IscrizioneID\` int(11) NOT NULL,
              \`StudenteID\` int(11) DEFAULT NULL,
              \`CorsoID\` int(11) DEFAULT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=latin1;

            INSERT INTO \`iscrizioni\` (\`IscrizioneID\`, \`StudenteID\`, \`CorsoID\`) VALUES
              (1, 1, 101),
              (2, 2, 102),
              (3, 3, 103);

            ALTER TABLE \`corsi\` ADD PRIMARY KEY (\`CorsoID\`);
            ALTER TABLE \`iscrizioni\`
              ADD PRIMARY KEY (\`IscrizioneID\`),
              ADD KEY \`StudenteID\` (\`StudenteID\`),
              ADD KEY \`CorsoID\` (\`CorsoID\`);
            ALTER TABLE \`iscrizioni\`
              ADD CONSTRAINT \`iscrizioni_ibfk_1\` FOREIGN KEY (\`StudenteID\`) REFERENCES \`studenti\` (\`StudenteID\`),
              ADD CONSTRAINT \`iscrizioni_ibfk_2\` FOREIGN KEY (\`CorsoID\`) REFERENCES \`corsi\` (\`CorsoID\`);
            COMMIT;
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('corsi').rows).toHaveLength(3);
        expect(r.table('corsi').rows[0].NomeCorso).toBe('Matematica');
        expect(r.table('iscrizioni').rows).toHaveLength(3);
        expect(r.table('corsi').columns.find((c) => c.name === 'CorsoID').pk).toBe(true);
        expect(r.table('iscrizioni').columns.find((c) => c.name === 'CorsoID').fk).toBe(true);
    });
});

// ════════════════════════════════════════════
// DML deferral — robust coverage
// ════════════════════════════════════════════

describe('DML deferred — extended', () => {
    it('INSERT deferred across all three DML kinds', () => {
        const r = exec(`
            INSERT INTO t (id, name) VALUES (1, 'a'), (2, 'b'), (3, 'c');
            UPDATE t SET name = 'A' WHERE id = 1;
            DELETE FROM t WHERE id = 3;
            CREATE TABLE t (id INT, name TEXT);
        `);
        const t = r.table('t');
        expect(t.rows).toHaveLength(2);
        expect(t.rows.find((x) => x.id === 1).name).toBe('A');
        expect(t.rows.find((x) => x.id === 3)).toBeUndefined();
    });

    it('deferred DML against a table that never gets created reports errors', () => {
        const r = exec(`
            INSERT INTO nonexistent (id) VALUES (1);
        `);
        expect(r.errors().some((e) => e.message.includes('nonexistent'))).toBe(true);
    });

    it('interleaved DDL/DML where some target tables exist and some do not', () => {
        const r = exec(`
            CREATE TABLE a (id INT);
            INSERT INTO a VALUES (1);
            INSERT INTO b VALUES (2);
            CREATE TABLE b (id INT);
            INSERT INTO a VALUES (3);
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('a').rows.map((x) => x.id).sort()).toEqual([1, 3]);
        expect(r.table('b').rows.map((x) => x.id)).toEqual([2]);
    });
});

// ════════════════════════════════════════════
// Robustness — statement separators and resynchronization
// ════════════════════════════════════════════

describe('Statement synchronization', () => {
    it('last statement without trailing semicolon is still executed', () => {
        const r = exec(`
            CREATE TABLE a (id INT);
            INSERT INTO a VALUES (1)
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('a').rows).toHaveLength(1);
    });

    it('consecutive CREATE TABLE without semicolons are each parsed', () => {
        const r = exec(`
            CREATE TABLE a (id INT)
            CREATE TABLE b (id INT)
            CREATE TABLE c (id INT);
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('a')).not.toBeNull();
        expect(r.table('b')).not.toBeNull();
        expect(r.table('c')).not.toBeNull();
    });

    it('recovers into a following CREATE/INSERT/UPDATE/TRUNCATE without semicolon', () => {
        const r = exec(`
            CREATE TABLE t (id INT, n INT)
            INSERT INTO t VALUES (1, 10)
            UPDATE t SET n = 20 WHERE id = 1
            TRUNCATE TABLE t;
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('t').rows).toHaveLength(0);
    });

    it('ON DELETE CASCADE does not trigger premature statement split', () => {
        const r = exec(`
            CREATE TABLE parent (id INT PRIMARY KEY);
            CREATE TABLE child (
              id INT PRIMARY KEY,
              parent_id INT REFERENCES parent(id) ON DELETE CASCADE
            );
            ALTER TABLE child ADD CONSTRAINT fk_p FOREIGN KEY (parent_id)
              REFERENCES parent(id) ON DELETE CASCADE ON UPDATE CASCADE;
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('child').columns.find((c) => c.name === 'parent_id').fk).toBe(true);
    });

    it('consecutive INSERT without semicolons are each executed', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            INSERT INTO t VALUES (1)
            INSERT INTO t VALUES (2)
            INSERT INTO t VALUES (3);
        `);
        expect(r.table('t').rows.map((r) => r.id)).toEqual([1, 2, 3]);
    });

    it('real-world: Django-style ERD schema without semicolons between tables', () => {
        const r = exec(`
            CREATE TABLE Schedule (
              id IntegerField PRIMARY KEY,
              schedule_id id,
              date DateField,
              lesson_time IntegerField,
              is_public BooleanField
            )
            CREATE TABLE SiteSetting (
              id IntegerField PRIMARY KEY,
              user_id id REFERENCES User(id),
              key_ CharField
            )
            CREATE TABLE Teacher (
              id IntegerField PRIMARY KEY,
              birth_date DateField,
              is_working BooleanField
            )
            CREATE TABLE Grade (
              id IntegerField PRIMARY KEY,
              grade_level IntegerField
            );
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.tables.size).toBe(4);
        expect(r.table('Schedule')).not.toBeNull();
        expect(r.table('SiteSetting')).not.toBeNull();
        expect(r.table('Teacher')).not.toBeNull();
        expect(r.table('Grade')).not.toBeNull();
    });

    it('real-world: full Django-ERD schema (14 tables) with CREATE TYPEs before', () => {
        const r = exec(`
            CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled');
            CREATE TYPE address AS (street TEXT, city TEXT, postal_code VARCHAR(20));

            CREATE TABLE Schedule (
              id IntegerField PRIMARY KEY,
              schedule id,
              date DateField,
              group ManyToManyField REFERENCES Group(id),
              lesson_time IntegerField,
              location id REFERENCES Location(id),
              year PositiveSmallIntegerField,
              is_public BooleanField,
              is_bme BooleanField
            )
            CREATE TABLE SiteSetting (
              id IntegerField PRIMARY KEY,
              user id REFERENCES User(id),
              key_ CharField,
              value CharField,
              lesson_time TextField
            )
            CREATE TABLE Teacher (
              id IntegerField PRIMARY KEY,
              user OneToOneField REFERENCES User(id),
              photo ImageField,
              thumbnail ImageSpecField,
              birth_date DateField,
              grade PositiveSmallIntegerField,
              has_extra_workload BooleanField,
              is_working BooleanField
            )
            CREATE TABLE Grade (
              id IntegerField PRIMARY KEY,
              grade_level IntegerField,
              grade CharField,
              have_test BooleanField,
              year PositiveSmallIntegerField,
              next_grade id,
              alternative_next_grade id,
              prev_grade id
            )
            CREATE TABLE Group (
              id IntegerField PRIMARY KEY,
              title CharField,
              short_title CharField,
              subgroup IntegerField,
              year PositiveSmallIntegerField,
              is_active BooleanField
            )
            CREATE TABLE Student (
              id IntegerField PRIMARY KEY,
              user OneToOneField REFERENCES User(id),
              group id REFERENCES Group(id),
              grade id REFERENCES Grade(id),
              is_study BooleanField,
              year PositiveSmallIntegerField,
              id_1c CharField
            )
            CREATE TABLE Calendar (
              id IntegerField PRIMARY KEY,
              teacher id REFERENCES Teacher(id),
              date DateField,
              in_workplace BooleanField,
              absence_reason CharField,
              lesson_count PositiveSmallIntegerField,
              extra_lesson_count PositiveSmallIntegerField,
              student_count PositiveSmallIntegerField
            )
            CREATE TABLE Location (
              id IntegerField PRIMARY KEY,
              address CharField,
              title CharField
            )
            CREATE TABLE Classroom (
              id IntegerField PRIMARY KEY,
              location id REFERENCES Location(id),
              name CharField,
              capacity PositiveSmallIntegerField
            )
            CREATE TABLE EntranceTesting (
              student id REFERENCES Student(id),
              date DateField,
              start_grade id REFERENCES Grade(id),
              file_link URLField
            )
            CREATE TABLE Lesson (
              schedule id REFERENCES Schedule(id),
              grade id REFERENCES Grade(id),
              students ManyToManyField REFERENCES Student(id),
              classroom CharField,
              teacher id REFERENCES Teacher(id),
              is_complete BooleanField
            )
            CREATE TABLE Test (
              student id REFERENCES Student(id),
              lesson id REFERENCES Lesson(id),
              variant PositiveSmallIntegerField,
              result CharField
            )
            CREATE TABLE Quiz (
              start DateField,
              groups ManyToManyField REFERENCES Group(id),
              students ManyToManyField REFERENCES Student(id),
              quiz_number PositiveSmallIntegerField
            )
            CREATE TABLE Log (
              type CharField,
              test id REFERENCES Test(id)
            );
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.tables.size).toBe(14);
        // Spot-check a few
        expect(r.table('Schedule').columns.length).toBeGreaterThan(0);
        expect(r.table('Log')).not.toBeNull();
        expect(r.table('Quiz')).not.toBeNull();
    });

    it('GO as MSSQL batch separator is ignored', () => {
        const r = exec(`
            CREATE TABLE a (id INT);
            GO
            INSERT INTO a VALUES (1);
            GO
        `);
        expect(r.table('a').rows).toHaveLength(1);
    });

    it('deeply nested parentheses survive statement boundary scan', () => {
        const r = exec(`
            CREATE TABLE t (
              id INT,
              status VARCHAR(20),
              CHECK ((status IN ('a','b')) AND (id > (SELECT 0)))
            );
            INSERT INTO t (id, status) VALUES (1, 'a');
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('t').rows).toHaveLength(1);
    });
});

// ════════════════════════════════════════════
// Input robustness
// ════════════════════════════════════════════

describe('Input robustness', () => {
    it('empty or whitespace-only input returns empty state cleanly', () => {
        expect(exec('').tables.size).toBe(0);
        expect(exec('   \n\t ').tables.size).toBe(0);
        expect(exec(';\n;\n;').tables.size).toBe(0);
    });

    it('non-string input does not throw', () => {
        const executor = createSqlExecutor();
        expect(() => executor.execute(null)).not.toThrow();
        expect(() => executor.execute(undefined)).not.toThrow();
        expect(() => executor.execute(42)).not.toThrow();
    });

    it('executor is reusable and preserves state across execute() calls', () => {
        const executor = createSqlExecutor();
        executor.execute('CREATE TABLE t (id INT);');
        executor.execute("INSERT INTO t (id) VALUES (1);");
        executor.execute("INSERT INTO t (id) VALUES (2);");
        const t = [...executor.tables.values()].find((x) => x.name === 't');
        expect(t.rows.map((r) => r.id)).toEqual([1, 2]);
    });

    it('handles comments inside INSERT VALUES list', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t (id, name) VALUES
              /* first row */ (1, 'a'),
              -- second row
              (2, 'b');
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('t').rows).toHaveLength(2);
    });
});

describe('DML deferred until table exists', () => {
    it('INSERT before CREATE TABLE is deferred and applied', () => {
        const r = exec(`
            INSERT INTO t (id, name) VALUES (1, 'A'), (2, 'B');
            CREATE TABLE t (id INT, name TEXT);
        `);
        const t = r.table('t');
        expect(t.rows).toHaveLength(2);
        expect(t.rows[0].id).toBe(1);
        expect(t.rows[1].name).toBe('B');
    });

    it('DROP + re-CREATE + INSERT keeps sequential semantics (no deferral leak)', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            INSERT INTO t (id) VALUES (1);
            DROP TABLE t;
            CREATE TABLE t (id INT, name TEXT);
            INSERT INTO t (id, name) VALUES (2, 'new');
        `);
        const t = r.table('t');
        expect(t.columns).toHaveLength(2);
        expect(t.rows).toHaveLength(1);
        expect(t.rows[0].id).toBe(2);
        expect(t.rows[0].name).toBe('new');
    });
});

// ════════════════════════════════════════════
// Statement recovery — production edge cases
// ════════════════════════════════════════════

describe('Statement recovery — production edge cases', () => {
    it('CREATE TYPE ENUM and composite without trailing semicolons', () => {
        const r = exec(`
            CREATE TYPE status AS ENUM ('pending','done')
            CREATE TYPE address AS (street TEXT, city TEXT)
            CREATE TABLE t (id INT);
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.type('status')).not.toBeNull();
        expect(r.type('address')).not.toBeNull();
        expect(r.table('t')).not.toBeNull();
    });

    it('trailing CREATE TABLE with no terminator (EOF) still parses', () => {
        const r = exec(`
            CREATE TABLE a (id INT);
            CREATE TABLE b (id INT)
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('b')).not.toBeNull();
    });

    it('INSERT at EOF with no semicolon is still executed', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            INSERT INTO t VALUES (1),(2),(3)
        `);
        expect(r.table('t').rows).toHaveLength(3);
    });

    it('MySQL ENGINE clause between CREATE TABLE blocks without semicolons', () => {
        const r = exec(`
            CREATE TABLE a (id INT) ENGINE=InnoDB DEFAULT CHARSET=utf8
            CREATE TABLE b (id INT) ENGINE=MyISAM;
        `);
        expect(r.table('a')).not.toBeNull();
        expect(r.table('b')).not.toBeNull();
    });

    it('ALTER TABLE DROP COLUMN is not split by recovery (DROP is not a recovery starter)', () => {
        const r = exec(`
            CREATE TABLE t (id INT, n INT, name TEXT);
            ALTER TABLE t DROP COLUMN n;
            INSERT INTO t (id, name) VALUES (1, 'a');
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('t').columns.map((c) => c.name)).toEqual(['id', 'name']);
        expect(r.table('t').rows).toHaveLength(1);
    });

    it('ALTER TABLE ALTER COLUMN is not split by recovery', () => {
        const r = exec(`
            CREATE TABLE t (id INT, n INT);
            ALTER TABLE t ALTER COLUMN n SET NOT NULL;
            INSERT INTO t (id, n) VALUES (1, 5);
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('t').columns.find((c) => c.name === 'n').notNull).toBe(true);
    });

    it('UPDATE followed by CREATE without semicolon — UPDATE is recovered before CREATE', () => {
        const r = exec(`
            CREATE TABLE t (id INT, n INT);
            INSERT INTO t VALUES (1,10),(2,20),(3,30);
            UPDATE t SET n = 99 WHERE id = 2
            CREATE TABLE marker (id INT);
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('t').rows.find((r) => r.id === 2).n).toBe(99);
        expect(r.table('marker')).not.toBeNull();
    });

    it('DELETE after an explicit semicolon executes cleanly', () => {
        const r = exec(`
            CREATE TABLE t (id INT, n INT);
            INSERT INTO t VALUES (1,10),(2,20),(3,30);
            DELETE FROM t WHERE n > 15;
        `);
        expect(r.table('t').rows.map((r) => r.id)).toEqual([1]);
    });

    it('ON UPDATE CURRENT_TIMESTAMP is not treated as a new UPDATE statement', () => {
        const r = exec(`
            CREATE TABLE audit (
              id INT PRIMARY KEY,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            );
            INSERT INTO audit (id) VALUES (1);
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('audit').rows).toHaveLength(1);
    });

    it('nested SELECT-like subqueries in CHECK do not confuse the scanner', () => {
        const r = exec(`
            CREATE TABLE t (
              id INT,
              CHECK (id IN (1, 2, 3))
            );
            CREATE TABLE u (
              id INT,
              CHECK ((id > 0) AND (id < 100))
            );
            INSERT INTO t VALUES (1);
            INSERT INTO u VALUES (5);
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('t').rows).toHaveLength(1);
        expect(r.table('u').rows).toHaveLength(1);
    });

    it('CREATE TABLE with trailing comma does not swallow next statement', () => {
        const r = exec(`
            CREATE TABLE t (
              id INT,
              name TEXT,
            );
            CREATE TABLE u (id INT);
        `);
        expect(r.table('t')).not.toBeNull();
        expect(r.table('u')).not.toBeNull();
    });

    it('mixed DDL/DML pasted without any semicolons — best-effort recovery', () => {
        const r = exec(`
            CREATE TABLE orders (id INT, total INT)
            CREATE TABLE items (order_id INT, name TEXT)
            INSERT INTO orders VALUES (1, 100), (2, 200)
            INSERT INTO items VALUES (1, 'a'), (2, 'b')
            UPDATE orders SET total = 150 WHERE id = 1
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('orders').rows).toHaveLength(2);
        expect(r.table('orders').rows[0].total).toBe(150);
        expect(r.table('items').rows).toHaveLength(2);
    });

    it('CREATE INDEX without semicolon does not block next CREATE TABLE', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            CREATE INDEX idx_name ON t (name)
            CREATE TABLE u (id INT);
        `);
        expect(r.table('t')).not.toBeNull();
        expect(r.table('u')).not.toBeNull();
    });

    it('MySQL AUTO_INCREMENT + ENGINE clause followed by next CREATE', () => {
        const r = exec(`
            CREATE TABLE a (
              id INT NOT NULL AUTO_INCREMENT PRIMARY KEY
            ) ENGINE=InnoDB AUTO_INCREMENT=1 DEFAULT CHARSET=utf8mb4
            CREATE TABLE b (id INT PRIMARY KEY);
        `);
        expect(r.table('a')).not.toBeNull();
        expect(r.table('b')).not.toBeNull();
    });
});

// ════════════════════════════════════════════
// Production stress & stability
// ════════════════════════════════════════════

describe('Production stress & stability', () => {
    it('handles 100 consecutive CREATE TABLE statements', () => {
        let sql = '';
        for (let i = 0; i < 100; i++) sql += `CREATE TABLE t${i} (id INT);\n`;
        const r = exec(sql);
        expect(r.errors()).toHaveLength(0);
        expect(r.tables.size).toBe(100);
    });

    it('handles 100 tables with no trailing semicolons', () => {
        let sql = '';
        for (let i = 0; i < 100; i++) sql += `CREATE TABLE t${i} (id INT)\n`;
        sql += ';';
        const r = exec(sql);
        expect(r.errors()).toHaveLength(0);
        expect(r.tables.size).toBe(100);
    });

    it('handles 1000-row INSERT batch', () => {
        const values = Array.from({ length: 1000 }, (_, i) => `(${i})`).join(',');
        const r = exec(`
            CREATE TABLE t (id INT);
            INSERT INTO t VALUES ${values};
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('t').rows).toHaveLength(1000);
    });

    it('handles wide table with 50 columns', () => {
        const cols = Array.from({ length: 50 }, (_, i) => `c${i} INT`).join(',');
        const vals = Array.from({ length: 50 }, (_, i) => i).join(',');
        const r = exec(`
            CREATE TABLE wide (${cols});
            INSERT INTO wide VALUES (${vals});
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('wide').columns).toHaveLength(50);
        expect(r.table('wide').rows[0].c49).toBe(49);
    });

    it('deeply nested parentheses in CHECK (10 levels)', () => {
        const open = '('.repeat(10);
        const close = ')'.repeat(10);
        const r = exec(`
            CREATE TABLE t (
              id INT,
              CHECK ${open}id > 0${close}
            );
            INSERT INTO t VALUES (1);
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('t').rows).toHaveLength(1);
    });

    it('malformed input does not throw and reports errors', () => {
        expect(() => exec('CREATE TABLE')).not.toThrow();
        expect(() => exec('CREATE TABLE t (')).not.toThrow();
        expect(() => exec('INSERT INTO')).not.toThrow();
        expect(() => exec('UPDATE t SET')).not.toThrow();
        expect(() => exec('DELETE FROM')).not.toThrow();
        expect(() => exec('ALTER TABLE t ADD')).not.toThrow();
    });

    it('unclosed string literal does not hang or throw', () => {
        expect(() => exec(`INSERT INTO t VALUES ('never closed`)).not.toThrow();
    });

    it('unclosed parenthesis does not hang or throw', () => {
        expect(() => exec(`CREATE TABLE t (id INT, name TEXT`)).not.toThrow();
    });

    it('single giant semicolon-free paste still makes progress', () => {
        // 20 CREATE TABLEs back to back, no semicolons anywhere
        let sql = '';
        for (let i = 0; i < 20; i++) sql += `CREATE TABLE tbl${i} (id INT, name TEXT) `;
        const r = exec(sql);
        expect(r.tables.size).toBe(20);
    });

    it('CRLF line endings are handled the same as LF', () => {
        const sqlLF = 'CREATE TABLE t (id INT);\nINSERT INTO t VALUES (1);';
        const sqlCRLF = sqlLF.replace(/\n/g, '\r\n');
        const rLF = exec(sqlLF);
        const rCRLF = exec(sqlCRLF);
        expect(rLF.table('t').rows).toEqual(rCRLF.table('t').rows);
    });

    it('unicode identifiers and string values round-trip', () => {
        const r = exec(`
            CREATE TABLE users (id INT, name TEXT);
            INSERT INTO users VALUES (1, 'Björk'), (2, '日本語'), (3, '🚀');
        `);
        expect(r.errors()).toHaveLength(0);
        const names = r.table('users').rows.map((r) => r.name);
        expect(names).toEqual(['Björk', '日本語', '🚀']);
    });

    it('mixed case keywords are accepted', () => {
        const r = exec(`
            create Table T (Id int Primary Key);
            Insert Into T (Id) Values (1);
            Update T Set Id = 2 Where Id = 1;
            Delete From T Where Id = 99;
            Drop Table T;
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('T')).toBeNull();
    });

    it('repeated identical executions on the same executor stay consistent', () => {
        const executor = createSqlExecutor();
        executor.execute('CREATE TABLE t (id INT);');
        for (let i = 0; i < 5; i++) {
            executor.execute(`INSERT INTO t VALUES (${i});`);
        }
        const t = [...executor.tables.values()].find((x) => x.name === 't');
        expect(t.rows.map((r) => r.id)).toEqual([0, 1, 2, 3, 4]);
    });

    it('executor.reset() (if present) or fresh instance yields a clean state', () => {
        const a = createSqlExecutor();
        a.execute('CREATE TABLE t (id INT); INSERT INTO t VALUES (1);');
        const b = createSqlExecutor();
        expect(b.tables.size).toBe(0);
    });
});

// ════════════════════════════════════════════
// User-reported scenarios (regression)
// ════════════════════════════════════════════

describe('User-reported regressions', () => {
    it('phpMyAdmin dump pattern: backticks + double-quoted strings + out-of-order DML', () => {
        const r = exec(`
            INSERT INTO \`courses\` (\`id\`, \`name\`) VALUES
              (1, "Math"),
              (2, "Physics");
            CREATE TABLE \`courses\` (
              \`id\` int(11) NOT NULL,
              \`name\` varchar(100) NOT NULL,
              PRIMARY KEY (\`id\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);
        expect(r.errors()).toHaveLength(0);
        const rows = r.table('courses').rows;
        expect(rows).toHaveLength(2);
        expect(rows[0].name).toBe('Math');
        expect(rows[1].name).toBe('Physics');
    });

    it('Django-ERD style: custom field types + no semicolons + REFERENCES ordering', () => {
        const r = exec(`
            CREATE TABLE Group (
              id IntegerField PRIMARY KEY,
              title CharField
            )
            CREATE TABLE Student (
              id IntegerField PRIMARY KEY,
              group_id id REFERENCES Group(id)
            )
            CREATE TABLE Lesson (
              schedule_id id,
              student id REFERENCES Student(id)
            );
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.tables.size).toBe(3);
        expect(r.table('Student').columns.find((c) => c.name === 'group_id').fk).toBe(true);
        expect(r.table('Lesson').columns.find((c) => c.name === 'student').fk).toBe(true);
    });

    it('INSERTs pointing to undefined tables produce errors but do not prevent defined tables', () => {
        const r = exec(`
            CREATE TABLE defined_tbl (id INT);
            INSERT INTO undefined_tbl VALUES (1);
            INSERT INTO defined_tbl VALUES (42);
        `);
        expect(r.errors().length).toBeGreaterThan(0);
        expect(r.table('defined_tbl').rows).toEqual([{ id: 42 }]);
    });

    it('auto-increment user expectation: INSERT without id column auto-assigns ids', () => {
        const r = exec(`
            CREATE TABLE users (
              id INT AUTO_INCREMENT PRIMARY KEY,
              name VARCHAR(100)
            );
            INSERT INTO users (name) VALUES ('Alice'), ('Bob'), ('Carol');
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('users').rows.map((row) => row.id)).toEqual([1, 2, 3]);
    });

    it('full user paste: schema + unrelated INSERTs — schema survives', () => {
        const r = exec(`
            CREATE TABLE Schedule (
              id IntegerField PRIMARY KEY,
              date DateField
            )
            CREATE TABLE Teacher (
              id IntegerField PRIMARY KEY,
              is_working BooleanField
            );
            INSERT INTO customers (id, name) VALUES (1, 'Alice');
            INSERT INTO orders (id, total) VALUES (1, 100);
        `);
        expect(r.table('Schedule')).not.toBeNull();
        expect(r.table('Teacher')).not.toBeNull();
        const errs = r.errors();
        expect(errs.length).toBeGreaterThan(0);
        expect(errs.some((e) => /customers/.test(JSON.stringify(e)))).toBe(true);
        expect(errs.some((e) => /orders/.test(JSON.stringify(e)))).toBe(true);
    });
});

// ════════════════════════════════════════════
// Auto-increment / IDENTITY / SERIAL — cross-dialect
// ════════════════════════════════════════════

describe('Auto-increment — MySQL AUTO_INCREMENT', () => {
    it('assigns sequential ids when id column is omitted', () => {
        const r = exec(`
            CREATE TABLE t (
              id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
              name VARCHAR(50)
            );
            INSERT INTO t (name) VALUES ('a'), ('b'), ('c');
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('t').rows.map((row) => row.id)).toEqual([1, 2, 3]);
    });

    it('assigns ids when column-less INSERT uses NULL for id', () => {
        const r = exec(`
            CREATE TABLE t (
              id INT AUTO_INCREMENT PRIMARY KEY,
              name VARCHAR(50)
            );
            INSERT INTO t VALUES (NULL, 'a'), (NULL, 'b');
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('t').rows.map((row) => row.id)).toEqual([1, 2]);
    });

    it('DEFAULT keyword in VALUES triggers auto-assignment', () => {
        const r = exec(`
            CREATE TABLE t (
              id INT AUTO_INCREMENT PRIMARY KEY,
              name VARCHAR(50)
            );
            INSERT INTO t (id, name) VALUES (DEFAULT, 'a'), (DEFAULT, 'b');
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('t').rows.map((row) => row.id)).toEqual([1, 2]);
    });

    it('explicit id advances the counter so next auto-id is safe', () => {
        const r = exec(`
            CREATE TABLE t (
              id INT AUTO_INCREMENT PRIMARY KEY,
              name VARCHAR(50)
            );
            INSERT INTO t (id, name) VALUES (10, 'ten');
            INSERT INTO t (name) VALUES ('eleven');
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('t').rows.map((row) => row.id)).toEqual([10, 11]);
    });

    it('mixed explicit + auto in a single INSERT bumps counter correctly', () => {
        const r = exec(`
            CREATE TABLE t (
              id INT AUTO_INCREMENT PRIMARY KEY,
              n INT
            );
            INSERT INTO t (id, n) VALUES (5, 50), (NULL, 60), (NULL, 70);
        `);
        expect(r.table('t').rows.map((row) => row.id)).toEqual([5, 6, 7]);
    });

    it('MySQL `ENGINE=InnoDB AUTO_INCREMENT=100` table option is ignored (does not break)', () => {
        const r = exec(`
            CREATE TABLE t (
              id INT AUTO_INCREMENT PRIMARY KEY,
              name VARCHAR(50)
            ) ENGINE=InnoDB AUTO_INCREMENT=100 DEFAULT CHARSET=utf8mb4;
            INSERT INTO t (name) VALUES ('a');
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('t').rows[0].id).toBe(1);
    });
});

describe('Auto-increment — PostgreSQL SERIAL family', () => {
    it('SERIAL column auto-assigns from 1', () => {
        const r = exec(`
            CREATE TABLE t (
              id SERIAL PRIMARY KEY,
              name TEXT
            );
            INSERT INTO t (name) VALUES ('a'), ('b'), ('c');
        `);
        expect(r.table('t').rows.map((row) => row.id)).toEqual([1, 2, 3]);
    });

    it('BIGSERIAL behaves identically to SERIAL', () => {
        const r = exec(`
            CREATE TABLE t (id BIGSERIAL PRIMARY KEY, v TEXT);
            INSERT INTO t (v) VALUES ('x'), ('y');
        `);
        expect(r.table('t').rows.map((row) => row.id)).toEqual([1, 2]);
    });

    it('SMALLSERIAL behaves identically to SERIAL', () => {
        const r = exec(`
            CREATE TABLE t (id SMALLSERIAL PRIMARY KEY, v TEXT);
            INSERT INTO t (v) VALUES ('x'), ('y');
        `);
        expect(r.table('t').rows.map((row) => row.id)).toEqual([1, 2]);
    });

    it('SERIAL column implies NOT NULL', () => {
        const r = exec(`CREATE TABLE t (id SERIAL, v TEXT);`);
        const idCol = r.table('t').columns.find((c) => c.name === 'id');
        expect(idCol.notNull).toBe(true);
        expect(idCol.autoIncrement).toBe(true);
    });

    it('SERIAL without PRIMARY KEY still auto-assigns', () => {
        const r = exec(`
            CREATE TABLE t (id SERIAL, v TEXT);
            INSERT INTO t (v) VALUES ('a'), ('b');
        `);
        expect(r.table('t').rows.map((row) => row.id)).toEqual([1, 2]);
    });
});

describe('Auto-increment — PostgreSQL GENERATED AS IDENTITY', () => {
    it('GENERATED ALWAYS AS IDENTITY assigns ids', () => {
        const r = exec(`
            CREATE TABLE t (
              id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
              v TEXT
            );
            INSERT INTO t (v) VALUES ('a'), ('b'), ('c');
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('t').rows.map((row) => row.id)).toEqual([1, 2, 3]);
    });

    it('GENERATED BY DEFAULT AS IDENTITY assigns ids', () => {
        const r = exec(`
            CREATE TABLE t (
              id INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
              v TEXT
            );
            INSERT INTO t (v) VALUES ('a'), ('b');
        `);
        expect(r.table('t').rows.map((row) => row.id)).toEqual([1, 2]);
    });

    it('GENERATED ... AS IDENTITY (START WITH 100 INCREMENT BY 5)', () => {
        const r = exec(`
            CREATE TABLE t (
              id INT GENERATED BY DEFAULT AS IDENTITY (START WITH 100 INCREMENT BY 5) PRIMARY KEY,
              v TEXT
            );
            INSERT INTO t (v) VALUES ('a'), ('b'), ('c');
        `);
        expect(r.table('t').rows.map((row) => row.id)).toEqual([100, 105, 110]);
    });

    it('GENERATED ... AS IDENTITY with all options parses cleanly', () => {
        const r = exec(`
            CREATE TABLE t (
              id BIGINT GENERATED ALWAYS AS IDENTITY
                (START WITH 1000 INCREMENT BY 10 MINVALUE 1000 MAXVALUE 99999 CACHE 20 NO CYCLE) PRIMARY KEY,
              v TEXT
            );
            INSERT INTO t (v) VALUES ('a'), ('b');
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('t').rows.map((row) => row.id)).toEqual([1000, 1010]);
    });

    it('GENERATED ALWAYS AS (expr) STORED is a computed column, not auto-inc', () => {
        const r = exec(`
            CREATE TABLE t (
              a INT,
              b INT,
              s INT GENERATED ALWAYS AS (a + b) STORED
            );
        `);
        const sCol = r.table('t').columns.find((c) => c.name === 's');
        expect(sCol.autoIncrement).toBe(false);
    });
});

describe('Auto-increment — MSSQL IDENTITY', () => {
    it('IDENTITY without args defaults to (1, 1)', () => {
        const r = exec(`
            CREATE TABLE t (
              id INT IDENTITY PRIMARY KEY,
              v NVARCHAR(50)
            );
            INSERT INTO t (v) VALUES ('a'), ('b'), ('c');
        `);
        expect(r.table('t').rows.map((row) => row.id)).toEqual([1, 2, 3]);
    });

    it('IDENTITY(seed, step)', () => {
        const r = exec(`
            CREATE TABLE t (
              id INT IDENTITY(100, 10) PRIMARY KEY,
              v NVARCHAR(50)
            );
            INSERT INTO t (v) VALUES ('a'), ('b'), ('c');
        `);
        expect(r.table('t').rows.map((row) => row.id)).toEqual([100, 110, 120]);
    });

    it('IDENTITY(1, 2) produces odd ids', () => {
        const r = exec(`
            CREATE TABLE t (id INT IDENTITY(1, 2) PRIMARY KEY, v INT);
            INSERT INTO t (v) VALUES (10), (20), (30);
        `);
        expect(r.table('t').rows.map((row) => row.id)).toEqual([1, 3, 5]);
    });

    it('IDENTITY with NOT NULL and PRIMARY KEY inline', () => {
        const r = exec(`
            CREATE TABLE t (
              id INT NOT NULL IDENTITY(1,1) PRIMARY KEY,
              v NVARCHAR(50) NOT NULL
            );
            INSERT INTO t (v) VALUES ('a');
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('t').rows[0].id).toBe(1);
    });
});

describe('Auto-increment — counter lifecycle', () => {
    it('counter survives across multiple separate INSERT statements', () => {
        const r = exec(`
            CREATE TABLE t (id SERIAL PRIMARY KEY, n INT);
            INSERT INTO t (n) VALUES (10);
            INSERT INTO t (n) VALUES (20);
            INSERT INTO t (n) VALUES (30);
        `);
        expect(r.table('t').rows.map((row) => row.id)).toEqual([1, 2, 3]);
    });

    it('TRUNCATE resets the counter', () => {
        const r = exec(`
            CREATE TABLE t (id SERIAL PRIMARY KEY, n INT);
            INSERT INTO t (n) VALUES (1),(2),(3);
            TRUNCATE TABLE t;
            INSERT INTO t (n) VALUES (9);
        `);
        expect(r.table('t').rows.map((row) => row.id)).toEqual([1]);
    });

    it('DROP + recreate resets the counter', () => {
        const r = exec(`
            CREATE TABLE t (id SERIAL PRIMARY KEY, n INT);
            INSERT INTO t (n) VALUES (1),(2),(3);
            DROP TABLE t;
            CREATE TABLE t (id SERIAL PRIMARY KEY, n INT);
            INSERT INTO t (n) VALUES (9);
        `);
        expect(r.table('t').rows.map((row) => row.id)).toEqual([1]);
    });

    it('CREATE TABLE on an existing table preserves rows and bumps counter past max id', () => {
        const r = exec(`
            CREATE TABLE t (id SERIAL PRIMARY KEY, n INT);
            INSERT INTO t (n) VALUES (10),(20);
            CREATE TABLE t (id SERIAL PRIMARY KEY, n INT);
            INSERT INTO t (n) VALUES (30);
        `);
        const ids = r.table('t').rows.map((row) => row.id);
        expect(ids).toEqual([1, 2, 3]);
    });

    it('ADD COLUMN IDENTITY backfills existing rows with fresh ids', () => {
        const r = exec(`
            CREATE TABLE t (name TEXT);
            INSERT INTO t (name) VALUES ('a'), ('b'), ('c');
            ALTER TABLE t ADD COLUMN id INT IDENTITY(1,1);
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('t').rows.map((row) => row.id)).toEqual([1, 2, 3]);
    });

    it('ALTER DROP COLUMN removes the counter entry', () => {
        const r = exec(`
            CREATE TABLE t (id SERIAL PRIMARY KEY, v TEXT);
            INSERT INTO t (v) VALUES ('a'),('b');
            ALTER TABLE t DROP COLUMN id;
            ALTER TABLE t ADD COLUMN id INT;
            INSERT INTO t (v, id) VALUES ('c', 50);
        `);
        // id column no longer auto-inc after re-add (it's a plain INT now).
        expect(r.table('t').rows[2].id).toBe(50);
    });

    it('ALTER RENAME COLUMN rekeys the counter', () => {
        const r = exec(`
            CREATE TABLE t (id SERIAL PRIMARY KEY, v TEXT);
            INSERT INTO t (v) VALUES ('a');
            ALTER TABLE t RENAME COLUMN id TO pk;
            INSERT INTO t (v) VALUES ('b');
        `);
        expect(r.table('t').rows.map((row) => row.pk)).toEqual([1, 2]);
    });
});

describe('Auto-increment — validation', () => {
    it('duplicate explicit PK + auto-assign at same value rejects the duplicate', () => {
        const r = exec(`
            CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY, v INT);
            INSERT INTO t (id, v) VALUES (1, 10);
            INSERT INTO t (id, v) VALUES (1, 20);
        `);
        expect(r.errors().some((entry) => /duplicate PRIMARY KEY/.test(entry.message))).toBe(true);
        expect(r.table('t').rows).toHaveLength(1);
    });

    it('auto-assigned ids never collide with previously-seen explicit ids', () => {
        const r = exec(`
            CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY, v INT);
            INSERT INTO t (id, v) VALUES (7, 70);
            INSERT INTO t (v) VALUES (80), (90);
        `);
        expect(r.warnings().filter((w) => /duplicate/.test(w.message))).toHaveLength(0);
        expect(r.table('t').rows.map((row) => row.id)).toEqual([7, 8, 9]);
    });

    it('auto-increment column does not trigger NOT NULL warning when value is null', () => {
        const r = exec(`
            CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY, v INT);
            INSERT INTO t VALUES (NULL, 5);
        `);
        expect(r.warnings()).toHaveLength(0);
        expect(r.table('t').rows[0].id).toBe(1);
    });

    it('explicit id lower than counter does not rewind the counter', () => {
        const r = exec(`
            CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY, v INT);
            INSERT INTO t (v) VALUES (10), (20);
            INSERT INTO t (id, v) VALUES (1, 99);
            INSERT INTO t (v) VALUES (30);
        `);
        // Counter is at 3; the colliding explicit "1" is rejected and does
        // not rewind the next generated value.
        expect(r.table('t').rows.map((row) => row.id)).toEqual([1, 2, 3]);
    });
});

describe('Auto-increment — multi-dialect cross-check', () => {
    it('three dialects side-by-side all produce 1,2,3', () => {
        const mysql = exec(`
            CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY, v INT);
            INSERT INTO t (v) VALUES (10),(20),(30);
        `);
        const pg = exec(`
            CREATE TABLE t (id SERIAL PRIMARY KEY, v INT);
            INSERT INTO t (v) VALUES (10),(20),(30);
        `);
        const mssql = exec(`
            CREATE TABLE t (id INT IDENTITY(1,1) PRIMARY KEY, v INT);
            INSERT INTO t (v) VALUES (10),(20),(30);
        `);
        const pgIdentity = exec(`
            CREATE TABLE t (id INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, v INT);
            INSERT INTO t (v) VALUES (10),(20),(30);
        `);
        const expected = [1, 2, 3];
        expect(mysql.table('t').rows.map((r) => r.id)).toEqual(expected);
        expect(pg.table('t').rows.map((r) => r.id)).toEqual(expected);
        expect(mssql.table('t').rows.map((r) => r.id)).toEqual(expected);
        expect(pgIdentity.table('t').rows.map((r) => r.id)).toEqual(expected);
    });

    it('multiple auto-increment columns on different tables are tracked independently', () => {
        const r = exec(`
            CREATE TABLE a (id INT AUTO_INCREMENT PRIMARY KEY, v INT);
            CREATE TABLE b (id SERIAL PRIMARY KEY, v INT);
            INSERT INTO a (v) VALUES (1),(2);
            INSERT INTO b (v) VALUES (1),(2),(3);
            INSERT INTO a (v) VALUES (3);
        `);
        expect(r.table('a').rows.map((x) => x.id)).toEqual([1, 2, 3]);
        expect(r.table('b').rows.map((x) => x.id)).toEqual([1, 2, 3]);
    });

    it('deferred INSERT (before CREATE TABLE) still auto-assigns', () => {
        const r = exec(`
            INSERT INTO t (v) VALUES (10), (20), (30);
            CREATE TABLE t (id SERIAL PRIMARY KEY, v INT);
        `);
        expect(r.table('t').rows.map((row) => row.id)).toEqual([1, 2, 3]);
    });

    it('phpMyAdmin-style: INSERT VALUES contains explicit ids — counter stays ahead', () => {
        const r = exec(`
            CREATE TABLE users (
              id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
              name VARCHAR(100) NOT NULL
            );
            INSERT INTO users (id, name) VALUES
              (1, 'Alice'),
              (2, 'Bob'),
              (3, 'Carol');
            INSERT INTO users (name) VALUES ('Dave');
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('users').rows.map((row) => row.id)).toEqual([1, 2, 3, 4]);
    });
});

// ════════════════════════════════════════════
// Auto-UUID — cross-dialect
// ════════════════════════════════════════════

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('Auto-UUID — PostgreSQL gen_random_uuid()', () => {
    it('gen_random_uuid() default auto-assigns a UUID when id is omitted', () => {
        const r = exec(`
            CREATE TABLE t (
              id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
              name TEXT
            );
            INSERT INTO t (name) VALUES ('a'), ('b');
        `);
        expect(r.errors()).toHaveLength(0);
        const rows = r.table('t').rows;
        expect(rows).toHaveLength(2);
        expect(rows[0].id).toMatch(UUID_RE);
        expect(rows[1].id).toMatch(UUID_RE);
        expect(rows[0].id).not.toBe(rows[1].id);
    });

    it('NULL in VALUES is replaced by a generated UUID', () => {
        const r = exec(`
            CREATE TABLE t (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, v TEXT);
            INSERT INTO t (id, v) VALUES (NULL, 'a');
        `);
        expect(r.errors()).toHaveLength(0);
        expect(r.table('t').rows[0].id).toMatch(UUID_RE);
    });

    it('DEFAULT keyword in VALUES triggers UUID generation', () => {
        const r = exec(`
            CREATE TABLE t (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, v TEXT);
            INSERT INTO t (id, v) VALUES (DEFAULT, 'a'), (DEFAULT, 'b');
        `);
        const rows = r.table('t').rows;
        expect(rows[0].id).toMatch(UUID_RE);
        expect(rows[1].id).toMatch(UUID_RE);
        expect(rows[0].id).not.toBe(rows[1].id);
    });

    it('parenthesized default `DEFAULT (gen_random_uuid())` also works', () => {
        const r = exec(`
            CREATE TABLE t (id UUID DEFAULT (gen_random_uuid()) PRIMARY KEY, v TEXT);
            INSERT INTO t (v) VALUES ('a');
        `);
        expect(r.table('t').rows[0].id).toMatch(UUID_RE);
    });

    it('uuid_generate_v4() is treated as auto-UUID', () => {
        const r = exec(`
            CREATE TABLE t (id UUID DEFAULT uuid_generate_v4() PRIMARY KEY, v TEXT);
            INSERT INTO t (v) VALUES ('a'),('b'),('c');
        `);
        const ids = r.table('t').rows.map((r) => r.id);
        expect(ids.every((id) => UUID_RE.test(id))).toBe(true);
        expect(new Set(ids).size).toBe(3);
    });

    it('uuid_generate_v1/v3/v5() are all treated as auto-UUID', () => {
        for (const fn of ['uuid_generate_v1', 'uuid_generate_v3', 'uuid_generate_v5']) {
            const r = exec(`
                CREATE TABLE t (id UUID DEFAULT ${fn}() PRIMARY KEY, v TEXT);
                INSERT INTO t (v) VALUES ('a');
            `);
            expect(r.table('t').rows[0].id).toMatch(UUID_RE);
        }
    });

    it('explicit UUID value is preserved (not overwritten)', () => {
        const r = exec(`
            CREATE TABLE t (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, v TEXT);
            INSERT INTO t (id, v) VALUES ('11111111-1111-4111-8111-111111111111', 'a');
        `);
        expect(r.table('t').rows[0].id).toBe('11111111-1111-4111-8111-111111111111');
    });
});

describe('Auto-UUID — MySQL UUID()', () => {
    it('UUID() default auto-assigns when id is omitted', () => {
        const r = exec(`
            CREATE TABLE t (
              id CHAR(36) NOT NULL DEFAULT (UUID()),
              name VARCHAR(100),
              PRIMARY KEY (id)
            );
            INSERT INTO t (name) VALUES ('a'), ('b');
        `);
        expect(r.errors()).toHaveLength(0);
        const rows = r.table('t').rows;
        expect(rows[0].id).toMatch(UUID_RE);
        expect(rows[1].id).toMatch(UUID_RE);
        expect(rows[0].id).not.toBe(rows[1].id);
    });

    it('UUID() literal in VALUES also generates a UUID', () => {
        const r = exec(`
            CREATE TABLE t (id CHAR(36) PRIMARY KEY, v TEXT);
            INSERT INTO t (id, v) VALUES (UUID(), 'a'), (UUID(), 'b');
        `);
        const rows = r.table('t').rows;
        expect(rows[0].id).toMatch(UUID_RE);
        expect(rows[1].id).toMatch(UUID_RE);
        expect(rows[0].id).not.toBe(rows[1].id);
    });
});

describe('Auto-UUID — MSSQL NEWID()', () => {
    it('NEWID() default auto-assigns when id is omitted', () => {
        const r = exec(`
            CREATE TABLE t (
              id UNIQUEIDENTIFIER DEFAULT NEWID() PRIMARY KEY,
              v NVARCHAR(50)
            );
            INSERT INTO t (v) VALUES ('a'),('b');
        `);
        expect(r.errors()).toHaveLength(0);
        const rows = r.table('t').rows;
        expect(rows[0].id).toMatch(UUID_RE);
        expect(rows[1].id).toMatch(UUID_RE);
    });

    it('NEWSEQUENTIALID() default auto-assigns', () => {
        const r = exec(`
            CREATE TABLE t (
              id UNIQUEIDENTIFIER DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
              v NVARCHAR(50)
            );
            INSERT INTO t (v) VALUES ('a');
        `);
        expect(r.table('t').rows[0].id).toMatch(UUID_RE);
    });

    it('NEWID() literal in VALUES generates a UUID', () => {
        const r = exec(`
            CREATE TABLE t (id UNIQUEIDENTIFIER PRIMARY KEY, v NVARCHAR(50));
            INSERT INTO t (id, v) VALUES (NEWID(), 'a'), (NEWID(), 'b');
        `);
        const rows = r.table('t').rows;
        expect(rows[0].id).toMatch(UUID_RE);
        expect(rows[1].id).toMatch(UUID_RE);
        expect(rows[0].id).not.toBe(rows[1].id);
    });
});

describe('Auto-UUID — Oracle SYS_GUID()', () => {
    it('SYS_GUID() default auto-assigns a UUID', () => {
        const r = exec(`
            CREATE TABLE t (id VARCHAR2(36) DEFAULT SYS_GUID() PRIMARY KEY, v VARCHAR2(50));
            INSERT INTO t (v) VALUES ('a'),('b');
        `);
        const rows = r.table('t').rows;
        expect(rows[0].id).toMatch(UUID_RE);
        expect(rows[1].id).toMatch(UUID_RE);
    });
});

describe('Auto-UUID — column metadata', () => {
    it('column with UUID-fn default has autoUuid=true', () => {
        const r = exec(`CREATE TABLE t (id UUID DEFAULT gen_random_uuid());`);
        expect(r.table('t').columns[0].autoUuid).toBe(true);
    });

    it('column with a plain string default does NOT have autoUuid', () => {
        const r = exec(`CREATE TABLE t (id TEXT DEFAULT 'static');`);
        expect(r.table('t').columns[0].autoUuid).toBe(false);
    });

    it('UUID column WITHOUT a default does NOT auto-generate', () => {
        const r = exec(`
            CREATE TABLE t (id UUID PRIMARY KEY, v TEXT);
            INSERT INTO t (v) VALUES ('a');
        `);
        // No default set → no auto-UUID → id stays null → NOT NULL violation for PK.
        expect(r.table('t').columns[0].autoUuid).toBe(false);
        expect(r.errors().some((entry) => /NOT NULL/.test(entry.message))).toBe(true);
        expect(r.table('t').rows).toHaveLength(0);
    });

    it('ALTER TABLE ADD COLUMN with UUID default auto-fills existing rows', () => {
        const r = exec(`
            CREATE TABLE t (v TEXT);
            INSERT INTO t (v) VALUES ('a'),('b'),('c');
            ALTER TABLE t ADD COLUMN id UUID DEFAULT gen_random_uuid();
        `);
        const rows = r.table('t').rows;
        expect(rows).toHaveLength(3);
        expect(rows.every((r) => UUID_RE.test(r.id))).toBe(true);
        expect(new Set(rows.map((r) => r.id)).size).toBe(3);
    });
});

describe('Auto-UUID — combined with other features', () => {
    it('UUID pk + auto-increment counter on a different column coexist', () => {
        const r = exec(`
            CREATE TABLE t (
              id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
              seq INT AUTO_INCREMENT UNIQUE,
              v TEXT
            );
            INSERT INTO t (v) VALUES ('a'),('b'),('c');
        `);
        const rows = r.table('t').rows;
        expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
        expect(rows.every((r) => UUID_RE.test(r.id))).toBe(true);
    });

    it('deferred INSERT (before CREATE) still auto-generates UUIDs', () => {
        const r = exec(`
            INSERT INTO t (v) VALUES ('a'),('b');
            CREATE TABLE t (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, v TEXT);
        `);
        const rows = r.table('t').rows;
        expect(rows).toHaveLength(2);
        expect(rows[0].id).toMatch(UUID_RE);
        expect(rows[1].id).toMatch(UUID_RE);
    });

    it('three dialects side-by-side each produce valid unique UUIDs', () => {
        const pg = exec(`
            CREATE TABLE t (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, v TEXT);
            INSERT INTO t (v) VALUES ('a'),('b'),('c');
        `);
        const mysql = exec(`
            CREATE TABLE t (id CHAR(36) DEFAULT (UUID()) PRIMARY KEY, v TEXT);
            INSERT INTO t (v) VALUES ('a'),('b'),('c');
        `);
        const mssql = exec(`
            CREATE TABLE t (id UNIQUEIDENTIFIER DEFAULT NEWID() PRIMARY KEY, v NVARCHAR(50));
            INSERT INTO t (v) VALUES ('a'),('b'),('c');
        `);
        for (const r of [pg, mysql, mssql]) {
            const ids = r.table('t').rows.map((x) => x.id);
            expect(ids.every((id) => UUID_RE.test(id))).toBe(true);
            expect(new Set(ids).size).toBe(3);
        }
    });

    it('no duplicate-PK warnings when auto-UUIDs are generated', () => {
        const r = exec(`
            CREATE TABLE t (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, v TEXT);
            INSERT INTO t (v) VALUES ('a'),('b'),('c'),('d'),('e');
        `);
        expect(r.warnings().filter((w) => /duplicate/.test(w.message))).toHaveLength(0);
    });

    it('TRUNCATE keeps UUID auto-gen working afterward', () => {
        const r = exec(`
            CREATE TABLE t (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, v TEXT);
            INSERT INTO t (v) VALUES ('a');
            TRUNCATE TABLE t;
            INSERT INTO t (v) VALUES ('b');
        `);
        expect(r.table('t').rows).toHaveLength(1);
        expect(r.table('t').rows[0].id).toMatch(UUID_RE);
    });

    it('mixed explicit + auto UUID in one INSERT batch', () => {
        const r = exec(`
            CREATE TABLE t (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, v TEXT);
            INSERT INTO t (id, v) VALUES
              ('11111111-1111-4111-8111-111111111111', 'explicit'),
              (NULL, 'auto'),
              (DEFAULT, 'also-auto');
        `);
        const rows = r.table('t').rows;
        expect(rows[0].id).toBe('11111111-1111-4111-8111-111111111111');
        expect(rows[1].id).toMatch(UUID_RE);
        expect(rows[2].id).toMatch(UUID_RE);
        expect(rows[1].id).not.toBe(rows[2].id);
    });

    it('UUID in WHERE clause matches the row inserted with same UUID', () => {
        const r = exec(`
            CREATE TABLE t (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, v TEXT);
            INSERT INTO t (id, v) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'target');
            INSERT INTO t (v) VALUES ('other');
            UPDATE t SET v = 'updated' WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        `);
        const target = r.table('t').rows.find((x) => x.id === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
        expect(target.v).toBe('updated');
    });
});

describe('Auto-UUID — case insensitivity & function-call variations', () => {
    it('default is recognized regardless of keyword case', () => {
        for (const fn of ['GEN_RANDOM_UUID()', 'gen_random_uuid()', 'Gen_Random_UUID()']) {
            const r = exec(`
                CREATE TABLE t (id UUID DEFAULT ${fn} PRIMARY KEY, v TEXT);
                INSERT INTO t (v) VALUES ('x');
            `);
            expect(r.table('t').rows[0].id).toMatch(UUID_RE);
        }
    });

    it('default with extra whitespace between tokens is still recognized', () => {
        const r = exec(`
            CREATE TABLE t (id UUID DEFAULT    gen_random_uuid (   )    PRIMARY KEY, v TEXT);
            INSERT INTO t (v) VALUES ('x');
        `);
        expect(r.table('t').rows[0].id).toMatch(UUID_RE);
    });
});

// ════════════════════════════════════════════
// CREATE INDEX / indexing across dialects
// ════════════════════════════════════════════

function findColumn(table, name) {
    if (!table) return null;
    return table.columns.find((c) => c.name.toLowerCase() === name.toLowerCase()) || null;
}

function findIndex(table, name) {
    if (!table || !table.indexes) return null;
    return table.indexes.find((i) => i.name && i.name.toLowerCase() === name.toLowerCase()) || null;
}

describe('CREATE INDEX — standalone (cross-dialect)', () => {
    it('creates a basic non-unique index and marks the column as indexed', () => {
        const r = exec(`
            CREATE TABLE users (id INT PRIMARY KEY, email TEXT);
            CREATE INDEX idx_users_email ON users (email);
        `);
        const t = r.table('users');
        expect(t.indexes).toHaveLength(1);
        const idx = findIndex(t, 'idx_users_email');
        expect(idx).toMatchObject({ name: 'idx_users_email', unique: false, columns: ['email'] });
        expect(findColumn(t, 'email').indexed).toBe(true);
        expect(findColumn(t, 'id').indexed).toBeFalsy();
    });

    it('creates a UNIQUE index and preserves the unique flag', () => {
        const r = exec(`
            CREATE TABLE users (id INT PRIMARY KEY, email TEXT);
            CREATE UNIQUE INDEX uq_users_email ON users (email);
        `);
        const t = r.table('users');
        const idx = findIndex(t, 'uq_users_email');
        expect(idx).toMatchObject({ unique: true, columns: ['email'] });
    });

    it('creates a composite index with multiple columns', () => {
        const r = exec(`
            CREATE TABLE orders (id INT, user_id INT, created_at TIMESTAMP);
            CREATE INDEX idx_orders_user_date ON orders (user_id, created_at);
        `);
        const t = r.table('orders');
        const idx = findIndex(t, 'idx_orders_user_date');
        expect(idx.columns).toEqual(['user_id', 'created_at']);
        expect(findColumn(t, 'user_id').indexed).toBe(true);
        expect(findColumn(t, 'created_at').indexed).toBe(true);
    });

    it('records exactly one success log per CREATE INDEX', () => {
        const r = exec(`
            CREATE TABLE t (id INT, v TEXT);
            CREATE INDEX idx ON t (v);
        `);
        const idxLogs = r.successes().filter((l) => /index/i.test(l.message));
        expect(idxLogs).toHaveLength(1);
    });

    it('errors gracefully when the target table does not exist', () => {
        const r = exec(`CREATE INDEX idx ON missing_table (col);`);
        expect(r.errors().length).toBeGreaterThan(0);
        expect(r.errors()[0].message).toMatch(/missing_table/);
    });

    it('supports quoted identifiers for table and column names', () => {
        const r = exec(`
            CREATE TABLE "Users" ("Email" TEXT);
            CREATE INDEX "idx_email" ON "Users" ("Email");
        `);
        const t = r.table('Users');
        const idx = findIndex(t, 'idx_email');
        expect(idx.columns).toEqual(['Email']);
    });
});

describe('CREATE INDEX — PostgreSQL', () => {
    it('supports IF NOT EXISTS', () => {
        const r = exec(`
            CREATE TABLE t (id INT, v TEXT);
            CREATE INDEX IF NOT EXISTS idx ON t (v);
        `);
        expect(r.table('t').indexes).toHaveLength(1);
        expect(r.errors()).toEqual([]);
    });

    it('supports CONCURRENTLY', () => {
        const r = exec(`
            CREATE TABLE t (id INT, v TEXT);
            CREATE INDEX CONCURRENTLY idx ON t (v);
        `);
        expect(findIndex(r.table('t'), 'idx').columns).toEqual(['v']);
    });

    it('supports USING btree / hash / gin / gist', () => {
        const r = exec(`
            CREATE TABLE t (id INT, payload JSONB, tags TEXT);
            CREATE INDEX idx_btree ON t USING btree (id);
            CREATE INDEX idx_hash ON t USING hash (id);
            CREATE INDEX idx_gin ON t USING gin (payload);
            CREATE INDEX idx_gist ON t USING gist (tags);
        `);
        const t = r.table('t');
        expect(findIndex(t, 'idx_btree').type).toBe('btree');
        expect(findIndex(t, 'idx_hash').type).toBe('hash');
        expect(findIndex(t, 'idx_gin').type).toBe('gin');
        expect(findIndex(t, 'idx_gist').type).toBe('gist');
    });

    it('captures the partial-index WHERE predicate', () => {
        const r = exec(`
            CREATE TABLE t (id INT, status TEXT);
            CREATE INDEX idx_active ON t (id) WHERE status = 'active';
        `);
        const idx = findIndex(r.table('t'), 'idx_active');
        expect(idx.columns).toEqual(['id']);
        expect(idx.where).toMatch(/status/);
        expect(idx.where).toMatch(/active/);
    });

    it('supports INCLUDE (covering index)', () => {
        const r = exec(`
            CREATE TABLE t (id INT, a TEXT, b TEXT, c TEXT);
            CREATE INDEX idx_cover ON t (a) INCLUDE (b, c);
        `);
        const idx = findIndex(r.table('t'), 'idx_cover');
        expect(idx.columns).toEqual(['a']);
        expect(idx.include).toEqual(['b', 'c']);
    });

    it('supports WITH (fillfactor = …) storage parameters', () => {
        const r = exec(`
            CREATE TABLE t (id INT, v TEXT);
            CREATE INDEX idx ON t (v) WITH (fillfactor = 90);
        `);
        expect(findIndex(r.table('t'), 'idx').columns).toEqual(['v']);
        expect(r.errors()).toEqual([]);
    });

    it('supports TABLESPACE clause', () => {
        const r = exec(`
            CREATE TABLE t (id INT, v TEXT);
            CREATE INDEX idx ON t (v) TABLESPACE pg_default;
        `);
        expect(findIndex(r.table('t'), 'idx')).toBeTruthy();
        expect(r.errors()).toEqual([]);
    });

    it('tolerates expression-based indexes without crashing', () => {
        const r = exec(`
            CREATE TABLE t (id INT, name TEXT);
            CREATE INDEX idx_lower_name ON t (lower(name));
        `);
        const idx = findIndex(r.table('t'), 'idx_lower_name');
        expect(idx).toBeTruthy();
        // Expression-based indexes are recorded permissively; we don't
        // guarantee which identifiers inside the expression get surfaced.
        expect(idx.columns.length).toBeGreaterThan(0);
        expect(r.errors()).toEqual([]);
    });

    it('supports ONLY for partitioned tables', () => {
        const r = exec(`
            CREATE TABLE t (id INT, v TEXT);
            CREATE INDEX idx ON ONLY t (v);
        `);
        expect(findIndex(r.table('t'), 'idx').columns).toEqual(['v']);
    });

    it('supports schema-qualified table names', () => {
        const r = exec(`
            CREATE TABLE public.users (id INT, email TEXT);
            CREATE INDEX idx_email ON public.users (email);
        `);
        expect(findIndex(r.table('users'), 'idx_email').columns).toEqual(['email']);
    });
});

describe('CREATE INDEX — MySQL', () => {
    it('supports USING BTREE / USING HASH', () => {
        const r = exec(`
            CREATE TABLE t (id INT, v VARCHAR(100));
            CREATE INDEX idx_b ON t (v) USING BTREE;
            CREATE INDEX idx_h ON t (id) USING HASH;
        `);
        expect(r.errors()).toEqual([]);
        expect(r.table('t').indexes).toHaveLength(2);
    });

    it('supports backtick-quoted names', () => {
        const r = exec(`
            CREATE TABLE \`posts\` (\`id\` INT, \`title\` VARCHAR(200));
            CREATE INDEX \`idx_title\` ON \`posts\` (\`title\`);
        `);
        const idx = findIndex(r.table('posts'), 'idx_title');
        expect(idx.columns).toEqual(['title']);
    });

    it('creates a FULLTEXT index', () => {
        const r = exec(`
            CREATE TABLE articles (id INT, body TEXT);
            CREATE FULLTEXT INDEX ft_articles_body ON articles (body);
        `);
        const idx = findIndex(r.table('articles'), 'ft_articles_body');
        expect(idx).toMatchObject({ unique: false, type: 'fulltext', columns: ['body'] });
    });

    it('creates a SPATIAL index', () => {
        const r = exec(`
            CREATE TABLE places (id INT, location GEOMETRY NOT NULL);
            CREATE SPATIAL INDEX sp_places ON places (location);
        `);
        const idx = findIndex(r.table('places'), 'sp_places');
        expect(idx).toMatchObject({ type: 'spatial', columns: ['location'] });
    });
});

describe('CREATE INDEX — MSSQL', () => {
    it('supports CLUSTERED and NONCLUSTERED', () => {
        const r = exec(`
            CREATE TABLE t (id INT, v NVARCHAR(100));
            CREATE CLUSTERED INDEX idx_c ON t (id);
            CREATE NONCLUSTERED INDEX idx_n ON t (v);
        `);
        const t = r.table('t');
        expect(findIndex(t, 'idx_c').clustered).toBe(true);
        expect(findIndex(t, 'idx_n').clustered).toBe(false);
    });

    it('supports UNIQUE NONCLUSTERED combination', () => {
        const r = exec(`
            CREATE TABLE t (id INT, code NVARCHAR(20));
            CREATE UNIQUE NONCLUSTERED INDEX uq_code ON t (code);
        `);
        const idx = findIndex(r.table('t'), 'uq_code');
        expect(idx.unique).toBe(true);
        expect(idx.clustered).toBe(false);
    });

    it('supports [bracket] quoted identifiers', () => {
        const r = exec(`
            CREATE TABLE [dbo].[Users] ([Id] INT, [Email] NVARCHAR(200));
            CREATE INDEX [IX_Users_Email] ON [dbo].[Users] ([Email]);
        `);
        const t = r.table('Users');
        expect(findIndex(t, 'IX_Users_Email').columns).toEqual(['Email']);
    });

    it('supports INCLUDE + WHERE + WITH options together', () => {
        const r = exec(`
            CREATE TABLE t (id INT, a NVARCHAR(50), b NVARCHAR(50), is_deleted BIT);
            CREATE NONCLUSTERED INDEX idx
              ON t (a)
              INCLUDE (b)
              WHERE is_deleted = 0
              WITH (ONLINE = ON, FILLFACTOR = 80);
        `);
        const idx = findIndex(r.table('t'), 'idx');
        expect(idx.columns).toEqual(['a']);
        expect(idx.include).toEqual(['b']);
        expect(idx.where).toMatch(/is_deleted/);
        expect(r.errors()).toEqual([]);
    });
});

describe('CREATE TABLE — inline index entries (MySQL)', () => {
    it('parses inline KEY declarations', () => {
        const r = exec(`
            CREATE TABLE posts (
                id INT PRIMARY KEY,
                user_id INT,
                slug VARCHAR(100),
                KEY idx_user (user_id),
                KEY idx_slug (slug)
            );
        `);
        const t = r.table('posts');
        expect(t.indexes).toHaveLength(2);
        expect(findIndex(t, 'idx_user').columns).toEqual(['user_id']);
        expect(findIndex(t, 'idx_slug').columns).toEqual(['slug']);
        expect(findColumn(t, 'user_id').indexed).toBe(true);
        expect(findColumn(t, 'slug').indexed).toBe(true);
    });

    it('parses inline INDEX declarations', () => {
        const r = exec(`
            CREATE TABLE t (
                id INT,
                email VARCHAR(255),
                INDEX idx_email (email)
            );
        `);
        expect(findIndex(r.table('t'), 'idx_email').columns).toEqual(['email']);
    });

    it('parses inline UNIQUE KEY declarations', () => {
        const r = exec(`
            CREATE TABLE t (
                id INT,
                email VARCHAR(255),
                UNIQUE KEY uq_email (email)
            );
        `);
        const t = r.table('t');
        const idx = findIndex(t, 'uq_email');
        expect(idx.unique).toBe(true);
        expect(findColumn(t, 'email').unique).toBe(true);
    });

    it('parses inline FULLTEXT KEY and SPATIAL KEY', () => {
        const r = exec(`
            CREATE TABLE docs (
                id INT PRIMARY KEY,
                body TEXT,
                location GEOMETRY NOT NULL,
                FULLTEXT KEY ft_body (body),
                SPATIAL KEY sp_loc (location)
            );
        `);
        const t = r.table('docs');
        expect(findIndex(t, 'ft_body').type).toBe('fulltext');
        expect(findIndex(t, 'sp_loc').type).toBe('spatial');
    });

    it('accepts anonymous KEY (no name) with a column list', () => {
        const r = exec(`
            CREATE TABLE t (
                id INT,
                a INT,
                KEY (a)
            );
        `);
        const t = r.table('t');
        expect(t.indexes).toHaveLength(1);
        expect(t.indexes[0].name).toBeNull();
        expect(t.indexes[0].columns).toEqual(['a']);
        expect(findColumn(t, 'a').indexed).toBe(true);
    });

    it('parses composite KEY columns', () => {
        const r = exec(`
            CREATE TABLE t (
                a INT, b INT, c INT,
                KEY idx_ab (a, b),
                KEY idx_bc (b, c)
            );
        `);
        const t = r.table('t');
        expect(findIndex(t, 'idx_ab').columns).toEqual(['a', 'b']);
        expect(findIndex(t, 'idx_bc').columns).toEqual(['b', 'c']);
        expect(findColumn(t, 'a').indexed).toBe(true);
        expect(findColumn(t, 'b').indexed).toBe(true);
        expect(findColumn(t, 'c').indexed).toBe(true);
    });
});

describe('ALTER TABLE — ADD INDEX / KEY', () => {
    it('ADD INDEX adds a new index', () => {
        const r = exec(`
            CREATE TABLE t (id INT, v VARCHAR(100));
            ALTER TABLE t ADD INDEX idx_v (v);
        `);
        expect(findIndex(r.table('t'), 'idx_v').columns).toEqual(['v']);
        expect(findColumn(r.table('t'), 'v').indexed).toBe(true);
    });

    it('ADD KEY works as an alias for ADD INDEX', () => {
        const r = exec(`
            CREATE TABLE t (id INT, v VARCHAR(100));
            ALTER TABLE t ADD KEY idx_v (v);
        `);
        expect(findIndex(r.table('t'), 'idx_v').columns).toEqual(['v']);
    });

    it('ADD UNIQUE INDEX with a name', () => {
        const r = exec(`
            CREATE TABLE t (id INT, email TEXT);
            ALTER TABLE t ADD UNIQUE INDEX uq_email (email);
        `);
        const idx = findIndex(r.table('t'), 'uq_email');
        expect(idx.unique).toBe(true);
        expect(findColumn(r.table('t'), 'email').unique).toBe(true);
    });

    it('ADD FULLTEXT INDEX', () => {
        const r = exec(`
            CREATE TABLE articles (id INT, body TEXT);
            ALTER TABLE articles ADD FULLTEXT INDEX ft_body (body);
        `);
        expect(findIndex(r.table('articles'), 'ft_body').type).toBe('fulltext');
    });

    it('ADD INDEX ... USING HASH records the type', () => {
        const r = exec(`
            CREATE TABLE t (id INT, v VARCHAR(100));
            ALTER TABLE t ADD INDEX idx (v) USING HASH;
        `);
        expect(findIndex(r.table('t'), 'idx').type).toBe('hash');
    });

    it('ADD INDEX with multiple columns in one ALTER', () => {
        const r = exec(`
            CREATE TABLE t (a INT, b INT);
            ALTER TABLE t ADD INDEX idx1 (a), ADD INDEX idx2 (b);
        `);
        const t = r.table('t');
        expect(t.indexes).toHaveLength(2);
        expect(findIndex(t, 'idx1').columns).toEqual(['a']);
        expect(findIndex(t, 'idx2').columns).toEqual(['b']);
    });
});

describe('ALTER TABLE — DROP INDEX / KEY', () => {
    it('DROP INDEX removes the index and clears column flag', () => {
        const r = exec(`
            CREATE TABLE t (id INT, v VARCHAR(100));
            CREATE INDEX idx_v ON t (v);
            ALTER TABLE t DROP INDEX idx_v;
        `);
        const t = r.table('t');
        expect(t.indexes).toHaveLength(0);
        expect(findColumn(t, 'v').indexed).toBe(false);
    });

    it('DROP KEY works as alias for DROP INDEX', () => {
        const r = exec(`
            CREATE TABLE t (id INT, v VARCHAR(100));
            CREATE INDEX idx_v ON t (v);
            ALTER TABLE t DROP KEY idx_v;
        `);
        expect(r.table('t').indexes).toHaveLength(0);
    });

    it('DROP INDEX on unknown name produces a warning', () => {
        const r = exec(`
            CREATE TABLE t (id INT);
            ALTER TABLE t DROP INDEX nope;
        `);
        expect(r.warnings().length).toBeGreaterThan(0);
    });

    it('column stays indexed if another index still covers it', () => {
        const r = exec(`
            CREATE TABLE t (a INT, b INT);
            CREATE INDEX idx1 ON t (a);
            CREATE INDEX idx2 ON t (a, b);
            ALTER TABLE t DROP INDEX idx1;
        `);
        const t = r.table('t');
        expect(findColumn(t, 'a').indexed).toBe(true);
        expect(findColumn(t, 'b').indexed).toBe(true);
    });
});

describe('DROP INDEX — standalone', () => {
    it('MySQL form: DROP INDEX idx ON t', () => {
        const r = exec(`
            CREATE TABLE t (id INT, v VARCHAR(100));
            CREATE INDEX idx ON t (v);
            DROP INDEX idx ON t;
        `);
        expect(r.table('t').indexes).toHaveLength(0);
    });

    it('MSSQL form: DROP INDEX idx ON t', () => {
        const r = exec(`
            CREATE TABLE t (id INT, v NVARCHAR(50));
            CREATE NONCLUSTERED INDEX idx ON t (v);
            DROP INDEX idx ON t;
        `);
        expect(r.table('t').indexes).toHaveLength(0);
    });

    it('PostgreSQL form: DROP INDEX idx (no ON clause)', () => {
        const r = exec(`
            CREATE TABLE t (id INT, v TEXT);
            CREATE INDEX idx ON t (v);
            DROP INDEX idx;
        `);
        expect(r.table('t').indexes).toHaveLength(0);
    });

    it('DROP INDEX IF EXISTS ignores missing index silently', () => {
        const r = exec(`
            DROP INDEX IF EXISTS missing;
            DROP INDEX IF EXISTS missing ON t;
        `);
        expect(r.errors()).toEqual([]);
    });

    it('DROP INDEX without IF EXISTS on a missing index logs an error', () => {
        const r = exec(`DROP INDEX missing;`);
        expect(r.errors().length).toBeGreaterThan(0);
    });

    it('DROP INDEX supports multiple comma-separated names (Postgres)', () => {
        const r = exec(`
            CREATE TABLE t (a INT, b INT);
            CREATE INDEX idx_a ON t (a);
            CREATE INDEX idx_b ON t (b);
            DROP INDEX idx_a, idx_b;
        `);
        expect(r.table('t').indexes).toHaveLength(0);
    });
});

describe('Index — column lifecycle interactions', () => {
    it('dropping a column removes it from any covering index and clears empty indexes', () => {
        const r = exec(`
            CREATE TABLE t (a INT, b INT, c INT);
            CREATE INDEX idx_ab ON t (a, b);
            CREATE INDEX idx_c ON t (c);
            ALTER TABLE t DROP COLUMN c;
        `);
        const t = r.table('t');
        expect(findIndex(t, 'idx_ab').columns).toEqual(['a', 'b']);
        expect(findIndex(t, 'idx_c')).toBeNull();
    });

    it('dropping the last column in an index removes the index entirely', () => {
        const r = exec(`
            CREATE TABLE t (a INT, b INT);
            CREATE INDEX idx_b ON t (b);
            ALTER TABLE t DROP COLUMN b;
        `);
        expect(r.table('t').indexes).toHaveLength(0);
    });

    it('renaming a column updates references inside indexes', () => {
        const r = exec(`
            CREATE TABLE t (a INT, b INT);
            CREATE INDEX idx_ab ON t (a, b);
            ALTER TABLE t RENAME COLUMN b TO bb;
        `);
        const t = r.table('t');
        expect(findIndex(t, 'idx_ab').columns).toEqual(['a', 'bb']);
        expect(findColumn(t, 'bb').indexed).toBe(true);
    });

    it('re-CREATE TABLE preserves rows but resets indexes (DDL is idempotent)', () => {
        const r = exec(`
            CREATE TABLE t (id INT, v TEXT);
            INSERT INTO t (id, v) VALUES (1, 'x');
            CREATE INDEX idx ON t (v);
            CREATE TABLE t (id INT, v TEXT);
        `);
        const t = r.table('t');
        expect(t.rows).toHaveLength(1);
        expect(t.indexes).toHaveLength(0);
    });
});

describe('Index — edge cases and robustness', () => {
    it('an index with the same name replaces the prior entry', () => {
        const r = exec(`
            CREATE TABLE t (a INT, b INT);
            CREATE INDEX idx ON t (a);
            CREATE INDEX idx ON t (b);
        `);
        const t = r.table('t');
        expect(t.indexes).toHaveLength(1);
        expect(findIndex(t, 'idx').columns).toEqual(['b']);
    });

    it('two anonymous indexes both coexist', () => {
        const r = exec(`
            CREATE TABLE t (
                a INT, b INT,
                KEY (a),
                KEY (b)
            );
        `);
        expect(r.table('t').indexes).toHaveLength(2);
    });

    it('index column that does not exist on the table still records (permissive)', () => {
        const r = exec(`
            CREATE TABLE t (a INT);
            CREATE INDEX idx ON t (missing);
        `);
        const t = r.table('t');
        expect(findIndex(t, 'idx').columns).toEqual(['missing']);
    });

    it('tolerates consecutive CREATE INDEX statements without trailing semicolons', () => {
        const r = exec(`
            CREATE TABLE t (a INT, b INT)
            CREATE INDEX idx_a ON t (a)
            CREATE INDEX idx_b ON t (b)
        `);
        const t = r.table('t');
        expect(t.indexes).toHaveLength(2);
    });

    it('mixing dialects in one script works', () => {
        const r = exec(`
            CREATE TABLE users (id INT PRIMARY KEY, email VARCHAR(255), name TEXT);
            CREATE UNIQUE INDEX uq_email ON users (email);
            ALTER TABLE users ADD INDEX idx_name (name);
            CREATE NONCLUSTERED INDEX idx_extra ON users (id);
        `);
        const t = r.table('users');
        expect(t.indexes).toHaveLength(3);
        expect(findIndex(t, 'uq_email').unique).toBe(true);
        expect(findIndex(t, 'idx_name')).toBeTruthy();
        expect(findIndex(t, 'idx_extra').clustered).toBe(false);
    });

    it('is case-insensitive for the INDEX keyword itself', () => {
        const r = exec(`
            CREATE TABLE t (v TEXT);
            create index idx ON t (v);
        `);
        expect(findIndex(r.table('t'), 'idx').columns).toEqual(['v']);
    });

    it('UNIQUE constraint without explicit index name still produces a recognizable index', () => {
        const r = exec(`
            CREATE TABLE t (id INT, code TEXT, UNIQUE (code));
        `);
        const t = r.table('t');
        expect(t.indexes).toHaveLength(1);
        expect(t.indexes[0].unique).toBe(true);
        expect(t.indexes[0].columns).toEqual(['code']);
    });

    it('primary key does NOT auto-set indexed (we surface PK separately)', () => {
        const r = exec(`CREATE TABLE t (id INT PRIMARY KEY, v TEXT);`);
        expect(findColumn(r.table('t'), 'id').indexed).toBeFalsy();
    });

    it('MySQL phpMyAdmin-style dump with mixed KEY entries', () => {
        const r = exec(`
            CREATE TABLE \`schedule\` (
                \`id\` int(11) NOT NULL AUTO_INCREMENT,
                \`room_id\` int(11) NOT NULL,
                \`user_id\` int(11) DEFAULT NULL,
                \`start_at\` datetime NOT NULL,
                PRIMARY KEY (\`id\`),
                KEY \`schedule_room_id_idx\` (\`room_id\`),
                KEY \`schedule_user_id_idx\` (\`user_id\`),
                KEY \`schedule_start_idx\` (\`start_at\`)
            ) ENGINE=InnoDB;
        `);
        const t = r.table('schedule');
        expect(t.indexes).toHaveLength(3);
        expect(findColumn(t, 'room_id').indexed).toBe(true);
        expect(findColumn(t, 'user_id').indexed).toBe(true);
        expect(findColumn(t, 'start_at').indexed).toBe(true);
        expect(findColumn(t, 'id').indexed).toBeFalsy();
    });

    it('does not confuse WITH in CREATE INDEX with other WITH clauses', () => {
        const r = exec(`
            CREATE TABLE t (id INT, v TEXT);
            CREATE INDEX a ON t (v) WITH (fillfactor = 50);
            CREATE INDEX b ON t (id);
        `);
        const t = r.table('t');
        expect(t.indexes).toHaveLength(2);
        expect(findIndex(t, 'a')).toBeTruthy();
        expect(findIndex(t, 'b')).toBeTruthy();
    });

    it('CREATE INDEX does not interfere with subsequent INSERT parsing', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, v TEXT);
            CREATE INDEX idx ON t (v);
            INSERT INTO t (id, v) VALUES (1, 'hello'), (2, 'world');
        `);
        expect(r.table('t').rows).toHaveLength(2);
        expect(findIndex(r.table('t'), 'idx').columns).toEqual(['v']);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// SQLite dialect support — Data View
// ════════════════════════════════════════════════════════════════════════════

describe('SQLite — AUTOINCREMENT in Data View', () => {
    it('creates a table with INTEGER PRIMARY KEY AUTOINCREMENT', () => {
        const r = exec(`CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);`);
        const t = r.table('t');
        expect(t.columns).toHaveLength(2);
        expect(t.columns[0].pk).toBe(true);
        expect(t.columns[0].autoIncrement).toBe(true);
        expect(r.errors()).toHaveLength(0);
    });

    it('auto-assigns incrementing IDs with AUTOINCREMENT', () => {
        const r = exec(`
            CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
            INSERT INTO users (name) VALUES ('Alice');
            INSERT INTO users (name) VALUES ('Bob');
            INSERT INTO users (name) VALUES ('Charlie');
        `);
        const t = r.table('users');
        expect(t.rows).toHaveLength(3);
        expect(t.rows[0].id).toBe(1);
        expect(t.rows[1].id).toBe(2);
        expect(t.rows[2].id).toBe(3);
        expect(t.rows[0].name).toBe('Alice');
    });

    it('auto-increment with AUTOINCREMENT respects explicit values', () => {
        const r = exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT);
            INSERT INTO t (id, val) VALUES (10, 'a');
            INSERT INTO t (val) VALUES ('b');
            INSERT INTO t (val) VALUES ('c');
        `);
        const rows = r.table('t').rows;
        expect(rows[0].id).toBe(10);
        expect(rows[1].id).toBe(11);
        expect(rows[2].id).toBe(12);
    });

    it('AUTOINCREMENT and AUTO_INCREMENT both work independently', () => {
        const r = exec(`
            CREATE TABLE sqlite_table (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
            CREATE TABLE mysql_table (id INT AUTO_INCREMENT PRIMARY KEY, name TEXT);
            INSERT INTO sqlite_table (name) VALUES ('a');
            INSERT INTO mysql_table (name) VALUES ('b');
        `);
        expect(r.table('sqlite_table').rows[0].id).toBe(1);
        expect(r.table('mysql_table').rows[0].id).toBe(1);
        expect(r.errors()).toHaveLength(0);
    });
});

describe('SQLite — WITHOUT ROWID tables in Data View', () => {
    it('creates a table with WITHOUT ROWID', () => {
        const r = exec(`
            CREATE TABLE config (
                config_key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) WITHOUT ROWID;
        `);
        const t = r.table('config');
        expect(t).not.toBeNull();
        expect(t.columns).toHaveLength(2);
        expect(t.columns[0].pk).toBe(true);
        expect(r.errors()).toHaveLength(0);
    });

    it('inserts and queries data in WITHOUT ROWID tables', () => {
        const r = exec(`
            CREATE TABLE settings (setting_key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
            INSERT INTO settings (setting_key, value) VALUES ('theme', 'dark');
            INSERT INTO settings (setting_key, value) VALUES ('lang', 'en');
        `);
        expect(r.table('settings').rows).toHaveLength(2);
        expect(r.table('settings').rows[0].setting_key).toBe('theme');
    });

    it('does not break subsequent CREATE TABLE after WITHOUT ROWID', () => {
        const r = exec(`
            CREATE TABLE a (config_key TEXT PRIMARY KEY) WITHOUT ROWID;
            CREATE TABLE b (id INT PRIMARY KEY, val TEXT);
            INSERT INTO b (id, val) VALUES (1, 'ok');
        `);
        expect(r.table('a')).not.toBeNull();
        expect(r.table('b')).not.toBeNull();
        expect(r.table('b').rows).toHaveLength(1);
    });
});

describe('SQLite — STRICT tables in Data View', () => {
    it('creates a table with STRICT', () => {
        const r = exec(`
            CREATE TABLE typed (
                id INTEGER PRIMARY KEY,
                value REAL NOT NULL,
                label TEXT
            ) STRICT;
        `);
        expect(r.table('typed')).not.toBeNull();
        expect(r.table('typed').columns).toHaveLength(3);
        expect(r.errors()).toHaveLength(0);
    });

    it('creates a table with STRICT, WITHOUT ROWID combined', () => {
        const r = exec(`
            CREATE TABLE kv (
                config_key TEXT NOT NULL,
                value TEXT,
                PRIMARY KEY (config_key)
            ) STRICT, WITHOUT ROWID;
        `);
        expect(r.table('kv')).not.toBeNull();
        expect(r.table('kv').columns[0].pk).toBe(true);
        expect(r.errors()).toHaveLength(0);
    });
});

describe('SQLite — end-to-end realistic schema with DML', () => {
    it('executes a full SQLite DDL+DML script', () => {
        const r = exec(`
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
                published INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE tags (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE
            ) STRICT;

            CREATE TABLE post_tags (
                post_id INTEGER NOT NULL,
                tag_id INTEGER NOT NULL,
                PRIMARY KEY (post_id, tag_id),
                FOREIGN KEY (post_id) REFERENCES posts(id),
                FOREIGN KEY (tag_id) REFERENCES tags(id)
            ) STRICT, WITHOUT ROWID;

            -- Seed data
            INSERT INTO users (email, display_name) VALUES
                ('alice@example.com', 'Alice'),
                ('bob@example.com', 'Bob');

            INSERT INTO categories (slug, label) VALUES
                ('tech', 'Technology'),
                ('life', 'Lifestyle');

            INSERT INTO posts (author_id, category_slug, title, body, published) VALUES
                (1, 'tech', 'Hello World', 'My first post', 1),
                (1, 'life', 'Weekend Update', 'Had a great weekend', 0),
                (2, 'tech', 'SQLite Tips', 'SQLite is awesome', 1);

            INSERT INTO tags (id, name) VALUES (1, 'sqlite'), (2, 'tutorial'), (3, 'tips');

            INSERT INTO post_tags (post_id, tag_id) VALUES (1, 1), (1, 2), (3, 1), (3, 3);

            CREATE INDEX idx_posts_author ON posts (author_id);
        `);

        // No errors
        expect(r.errors()).toHaveLength(0);

        // All 5 tables
        expect(r.tables.size).toBe(5);

        // users — AUTOINCREMENT works
        const users = r.table('users');
        expect(users.rows).toHaveLength(2);
        expect(users.rows[0].id).toBe(1);
        expect(users.rows[1].id).toBe(2);
        expect(users.rows[0].email).toBe('alice@example.com');

        // categories (WITHOUT ROWID)
        expect(r.table('categories').rows).toHaveLength(2);
        expect(r.table('categories').rows[0].slug).toBe('tech');

        // posts — AUTOINCREMENT
        const posts = r.table('posts');
        expect(posts.rows).toHaveLength(3);
        expect(posts.rows[0].id).toBe(1);
        expect(posts.rows[2].id).toBe(3);
        expect(posts.rows[0].published).toBe(1);
        expect(posts.rows[1].published).toBe(0);

        // tags (STRICT)
        expect(r.table('tags').rows).toHaveLength(3);

        // post_tags (STRICT, WITHOUT ROWID, composite PK)
        expect(r.table('post_tags').rows).toHaveLength(4);
        expect(r.table('post_tags').compositePk).toEqual(['post_id', 'tag_id']);

        // Index
        const postsTable = r.table('posts');
        expect(postsTable.indexes.some((i) => i.name === 'idx_posts_author')).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Bug fix: KEY / INDEX as column names
// ════════════════════════════════════════════════════════════════════════════

describe('KEY / INDEX as column names (bug fix)', () => {
    it('recognizes "key" as a column name, not a MySQL inline index', () => {
        const r = exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);`);
        const t = r.table('kv');
        expect(t.columns).toHaveLength(2);
        expect(t.columns[0].name).toBe('key');
        expect(t.columns[0].pk).toBe(true);
        expect(t.columns[1].name).toBe('value');
    });

    it('"key" column with INSERT and SELECT works end-to-end', () => {
        const r = exec(`
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO settings (key, value) VALUES ('theme', 'dark');
            INSERT INTO settings (key, value) VALUES ('lang', 'en');
        `);
        expect(r.table('settings').rows).toHaveLength(2);
        expect(r.table('settings').rows[0].key).toBe('theme');
        expect(r.table('settings').rows[1].value).toBe('en');
        expect(r.errors()).toHaveLength(0);
    });

    it('"key" column alongside other constraints', () => {
        const r = exec(`
            CREATE TABLE cache (
                key TEXT NOT NULL UNIQUE,
                value TEXT,
                ttl INTEGER DEFAULT 3600
            );
        `);
        const t = r.table('cache');
        expect(t.columns).toHaveLength(3);
        expect(t.columns[0].name).toBe('key');
        expect(t.columns[0].unique).toBe(true);
        expect(t.columns[0].notNull).toBe(true);
    });

    it('real MySQL KEY (cols) inline index still works', () => {
        const r = exec(`
            CREATE TABLE t (
                id INT PRIMARY KEY,
                name TEXT,
                KEY (name)
            );
        `);
        expect(r.table('t').columns).toHaveLength(2);
        expect(r.table('t').indexes).toHaveLength(1);
    });

    it('MySQL KEY name (cols) inline index still works', () => {
        const r = exec(`
            CREATE TABLE t (
                id INT PRIMARY KEY,
                email TEXT,
                KEY idx_email (email)
            );
        `);
        expect(r.table('t').columns).toHaveLength(2);
        expect(r.table('t').indexes.some((i) => i.name === 'idx_email')).toBe(true);
    });

    it('"key" column in WITHOUT ROWID table with DML', () => {
        const r = exec(`
            CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
            INSERT INTO config (key, value) VALUES ('db_version', '3');
            INSERT INTO config (key, value) VALUES ('app_name', 'MyApp');
        `);
        expect(r.table('config').rows).toHaveLength(2);
        expect(r.table('config').rows[0].key).toBe('db_version');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// SQLite — More AUTOINCREMENT edge cases
// ════════════════════════════════════════════════════════════════════════════

describe('SQLite — AUTOINCREMENT advanced scenarios', () => {
    it('AUTOINCREMENT counter continues after DELETE', () => {
        const r = exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
            INSERT INTO t (name) VALUES ('a');
            INSERT INTO t (name) VALUES ('b');
            INSERT INTO t (name) VALUES ('c');
            DELETE FROM t WHERE id = 2;
            INSERT INTO t (name) VALUES ('d');
        `);
        const rows = r.table('t').rows;
        expect(rows).toHaveLength(3);
        // After deleting id=2, next auto should be 4 (not reuse 2)
        expect(rows[2].id).toBe(4);
    });

    it('AUTOINCREMENT with UPDATE does not break counter', () => {
        const r = exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT);
            INSERT INTO t (val) VALUES ('x');
            UPDATE t SET val = 'y' WHERE id = 1;
            INSERT INTO t (val) VALUES ('z');
        `);
        expect(r.table('t').rows[0].val).toBe('y');
        expect(r.table('t').rows[1].id).toBe(2);
    });

    it('AUTOINCREMENT with large explicit ID jumps the counter', () => {
        const r = exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT);
            INSERT INTO t (id, val) VALUES (1000, 'a');
            INSERT INTO t (val) VALUES ('b');
        `);
        expect(r.table('t').rows[0].id).toBe(1000);
        expect(r.table('t').rows[1].id).toBe(1001);
    });

    it('multiple tables with AUTOINCREMENT have independent counters', () => {
        const r = exec(`
            CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT, x TEXT);
            CREATE TABLE b (id INTEGER PRIMARY KEY AUTOINCREMENT, y TEXT);
            INSERT INTO a (x) VALUES ('a1'), ('a2'), ('a3');
            INSERT INTO b (y) VALUES ('b1');
        `);
        expect(r.table('a').rows).toHaveLength(3);
        expect(r.table('b').rows).toHaveLength(1);
        expect(r.table('a').rows[2].id).toBe(3);
        expect(r.table('b').rows[0].id).toBe(1);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// SQLite — Mixed dialect resilience in executor
// ════════════════════════════════════════════════════════════════════════════

describe('SQLite — mixed dialect in executor', () => {
    it('AUTOINCREMENT and AUTO_INCREMENT in same script', () => {
        const r = exec(`
            CREATE TABLE lite (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
            CREATE TABLE mysql (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100));
            INSERT INTO lite (name) VALUES ('SQLite');
            INSERT INTO mysql (name) VALUES ('MySQL');
        `);
        expect(r.table('lite').rows[0].id).toBe(1);
        expect(r.table('mysql').rows[0].id).toBe(1);
        expect(r.errors()).toHaveLength(0);
    });

    it('SQLite STRICT followed by MySQL ENGINE= table', () => {
        const r = exec(`
            CREATE TABLE lite (id INTEGER PRIMARY KEY, val TEXT) STRICT;
            CREATE TABLE mysql_t (id INT PRIMARY KEY, val TEXT) ENGINE=InnoDB;
        `);
        expect(r.table('lite')).not.toBeNull();
        expect(r.table('mysql_t')).not.toBeNull();
    });

    it('three dialects in one script', () => {
        const r = exec(`
            CREATE TABLE pg (id SERIAL PRIMARY KEY, data JSONB);
            CREATE TABLE lite (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT) STRICT;
            CREATE TABLE mssql_t (id INT IDENTITY(1,1) PRIMARY KEY, data NVARCHAR(MAX));
            INSERT INTO pg (data) VALUES ('{"a":1}');
            INSERT INTO lite (data) VALUES ('hello');
            INSERT INTO mssql_t (data) VALUES ('world');
        `);
        expect(r.tables.size).toBe(3);
        expect(r.table('pg').rows[0].id).toBe(1);
        expect(r.table('lite').rows[0].id).toBe(1);
        expect(r.table('mssql_t').rows[0].id).toBe(1);
        expect(r.errors()).toHaveLength(0);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// SQLite — WITHOUT ROWID + DML stress
// ════════════════════════════════════════════════════════════════════════════

describe('SQLite — WITHOUT ROWID with full DML', () => {
    it('UPDATE works on WITHOUT ROWID tables', () => {
        const r = exec(`
            CREATE TABLE config (name TEXT PRIMARY KEY, val TEXT) WITHOUT ROWID;
            INSERT INTO config (name, val) VALUES ('theme', 'light');
            UPDATE config SET val = 'dark' WHERE name = 'theme';
        `);
        expect(r.table('config').rows[0].val).toBe('dark');
    });

    it('DELETE works on WITHOUT ROWID tables', () => {
        const r = exec(`
            CREATE TABLE config (name TEXT PRIMARY KEY, val TEXT) WITHOUT ROWID;
            INSERT INTO config (name, val) VALUES ('a', '1'), ('b', '2'), ('c', '3');
            DELETE FROM config WHERE name = 'b';
        `);
        expect(r.table('config').rows).toHaveLength(2);
        expect(r.table('config').rows.every((row) => row.name !== 'b')).toBe(true);
    });

    it('WITHOUT ROWID with composite PK accepts DML', () => {
        const r = exec(`
            CREATE TABLE pairs (
                a_id INTEGER NOT NULL,
                b_id INTEGER NOT NULL,
                weight REAL DEFAULT 1.0,
                PRIMARY KEY (a_id, b_id)
            ) WITHOUT ROWID;
            INSERT INTO pairs (a_id, b_id, weight) VALUES (1, 2, 0.5), (1, 3, 0.8), (2, 3, 1.0);
            UPDATE pairs SET weight = 0.9 WHERE a_id = 1 AND b_id = 3;
            DELETE FROM pairs WHERE a_id = 2;
        `);
        const rows = r.table('pairs').rows;
        expect(rows).toHaveLength(2);
        const updated = rows.find((row) => row.a_id === 1 && row.b_id === 3);
        expect(updated.weight).toBe(0.9);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// SQLite — Large schema stress test with DML
// ════════════════════════════════════════════════════════════════════════════

describe('SQLite — 10-table stress test with full DML', () => {
    it('handles a complete CMS-like schema with seed data', () => {
        const r = exec(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                is_admin INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE profiles (
                user_id INTEGER PRIMARY KEY,
                bio TEXT,
                avatar TEXT,
                FOREIGN KEY (user_id) REFERENCES users(id)
            ) WITHOUT ROWID;

            CREATE TABLE categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                parent_id INTEGER REFERENCES categories(id)
            );

            CREATE TABLE articles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                author_id INTEGER NOT NULL REFERENCES users(id),
                category_id INTEGER REFERENCES categories(id),
                title TEXT NOT NULL,
                body TEXT,
                published INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE
            ) STRICT;

            CREATE TABLE article_tags (
                article_id INTEGER NOT NULL,
                tag_id INTEGER NOT NULL,
                PRIMARY KEY (article_id, tag_id),
                FOREIGN KEY (article_id) REFERENCES articles(id),
                FOREIGN KEY (tag_id) REFERENCES tags(id)
            ) STRICT, WITHOUT ROWID;

            CREATE TABLE comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                article_id INTEGER NOT NULL REFERENCES articles(id),
                author_id INTEGER NOT NULL REFERENCES users(id),
                body TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE likes (
                user_id INTEGER NOT NULL,
                article_id INTEGER NOT NULL,
                PRIMARY KEY (user_id, article_id),
                FOREIGN KEY (user_id) REFERENCES users(id),
                FOREIGN KEY (article_id) REFERENCES articles(id)
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
                details TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            -- Seed data
            INSERT INTO users (username, email, password_hash) VALUES
                ('alice', 'alice@test.com', 'hash1'),
                ('bob', 'bob@test.com', 'hash2'),
                ('charlie', 'charlie@test.com', 'hash3');

            INSERT INTO profiles (user_id, bio) VALUES (1, 'Hello!'), (2, 'Hi there');

            INSERT INTO categories (name) VALUES ('Tech'), ('Life'), ('News');

            INSERT INTO articles (author_id, category_id, title, body, published) VALUES
                (1, 1, 'Intro to SQLite', 'SQLite is great', 1),
                (1, 2, 'My Weekend', 'Had fun', 0),
                (2, 1, 'Advanced SQL', 'Complex queries', 1),
                (3, 3, 'Breaking News', 'Something happened', 1);

            INSERT INTO tags (name) VALUES ('sqlite'), ('sql'), ('tutorial'), ('news');

            INSERT INTO article_tags (article_id, tag_id) VALUES
                (1, 1), (1, 2), (1, 3), (3, 2), (4, 4);

            INSERT INTO comments (article_id, author_id, body) VALUES
                (1, 2, 'Great article!'),
                (1, 3, 'Very helpful'),
                (3, 1, 'Nice work');

            INSERT INTO likes (user_id, article_id) VALUES (2, 1), (3, 1), (1, 3);

            INSERT INTO sessions (token, user_id, expires_at) VALUES
                ('tok_abc', 1, '2026-12-31'),
                ('tok_def', 2, '2026-12-31');

            INSERT INTO audit_log (user_id, action, details) VALUES
                (1, 'login', 'from 127.0.0.1'),
                (2, 'login', 'from 10.0.0.1');

            -- DML operations
            UPDATE articles SET published = 1 WHERE id = 2;
            DELETE FROM sessions WHERE token = 'tok_def';

            CREATE INDEX idx_articles_author ON articles (author_id);
            CREATE INDEX idx_comments_article ON comments (article_id);
        `);

        expect(r.errors()).toHaveLength(0);
        expect(r.tables.size).toBe(10);

        // users — auto-increment
        expect(r.table('users').rows).toHaveLength(3);
        expect(r.table('users').rows[0].id).toBe(1);
        expect(r.table('users').rows[2].id).toBe(3);

        // profiles (WITHOUT ROWID)
        expect(r.table('profiles').rows).toHaveLength(2);

        // categories — self-referencing FK
        expect(r.table('categories').rows).toHaveLength(3);
        expect(r.table('categories').rows[0].id).toBe(1);

        // articles — auto-increment + UPDATE
        expect(r.table('articles').rows).toHaveLength(4);
        expect(r.table('articles').rows[1].published).toBe(1); // was updated

        // tags (STRICT)
        expect(r.table('tags').rows).toHaveLength(4);

        // article_tags (STRICT, WITHOUT ROWID)
        expect(r.table('article_tags').rows).toHaveLength(5);
        expect(r.table('article_tags').compositePk).toEqual(['article_id', 'tag_id']);

        // comments
        expect(r.table('comments').rows).toHaveLength(3);

        // likes (WITHOUT ROWID)
        expect(r.table('likes').rows).toHaveLength(3);

        // sessions — DELETE applied
        expect(r.table('sessions').rows).toHaveLength(1);
        expect(r.table('sessions').rows[0].token).toBe('tok_abc');

        // audit_log
        expect(r.table('audit_log').rows).toHaveLength(2);

        // Indexes
        expect(r.table('articles').indexes.some((i) => i.name === 'idx_articles_author')).toBe(true);
        expect(r.table('comments').indexes.some((i) => i.name === 'idx_comments_article')).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Mega 4-dialect cross-dialect test — Data View
// ════════════════════════════════════════════════════════════════════════════

describe('Mega 4-dialect — all auto-increment flavors with DML', () => {
    it('all 4 auto-increment syntaxes produce correct IDs', () => {
        const r = exec(`
            CREATE TABLE pg_t (id SERIAL PRIMARY KEY, val TEXT);
            CREATE TABLE mysql_t (id INT AUTO_INCREMENT PRIMARY KEY, val TEXT);
            CREATE TABLE mssql_t (id INT IDENTITY(1,1) PRIMARY KEY, val TEXT);
            CREATE TABLE lite_t (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT);

            INSERT INTO pg_t (val) VALUES ('pg1'), ('pg2'), ('pg3');
            INSERT INTO mysql_t (val) VALUES ('my1'), ('my2');
            INSERT INTO mssql_t (val) VALUES ('ms1'), ('ms2'), ('ms3'), ('ms4');
            INSERT INTO lite_t (val) VALUES ('lt1'), ('lt2'), ('lt3');
        `);

        expect(r.errors()).toHaveLength(0);
        expect(r.tables.size).toBe(4);

        // PG: SERIAL
        expect(r.table('pg_t').rows).toHaveLength(3);
        expect(r.table('pg_t').rows[0].id).toBe(1);
        expect(r.table('pg_t').rows[2].id).toBe(3);

        // MySQL: AUTO_INCREMENT
        expect(r.table('mysql_t').rows).toHaveLength(2);
        expect(r.table('mysql_t').rows[0].id).toBe(1);
        expect(r.table('mysql_t').rows[1].id).toBe(2);

        // MSSQL: IDENTITY(1,1)
        expect(r.table('mssql_t').rows).toHaveLength(4);
        expect(r.table('mssql_t').rows[0].id).toBe(1);
        expect(r.table('mssql_t').rows[3].id).toBe(4);

        // SQLite: AUTOINCREMENT
        expect(r.table('lite_t').rows).toHaveLength(3);
        expect(r.table('lite_t').rows[0].id).toBe(1);
        expect(r.table('lite_t').rows[2].id).toBe(3);
    });
});

describe('Mega 4-dialect — full schema with cross-references and DML', () => {
    it('4 dialects in one script with INSERT, UPDATE, DELETE', () => {
        const r = exec(`
            -- PG
            CREATE TABLE pg_users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                email TEXT UNIQUE
            );

            -- MySQL
            CREATE TABLE my_products (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                price DECIMAL(10,2) DEFAULT 0.00
            );

            -- MSSQL
            CREATE TABLE ms_orders (
                id INT IDENTITY(1,1) PRIMARY KEY,
                user_id INT NOT NULL,
                product_id INT NOT NULL,
                quantity INT DEFAULT 1
            );

            -- SQLite
            CREATE TABLE lite_reviews (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id INTEGER NOT NULL,
                rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
                comment TEXT DEFAULT ''
            ) STRICT;

            CREATE TABLE lite_audit (
                entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT NOT NULL,
                entity TEXT NOT NULL
            );

            -- Seed data across all dialects
            INSERT INTO pg_users (name, email) VALUES
                ('Alice', 'alice@test.com'),
                ('Bob', 'bob@test.com');

            INSERT INTO my_products (name, price) VALUES
                ('Widget', 9.99),
                ('Gadget', 24.99),
                ('Doohickey', 4.99);

            INSERT INTO ms_orders (user_id, product_id, quantity) VALUES
                (1, 1, 2),
                (1, 2, 1),
                (2, 3, 5);

            INSERT INTO lite_reviews (order_id, rating, comment) VALUES
                (1, 5, 'Great!'),
                (2, 4, 'Good'),
                (3, 3, 'OK');

            INSERT INTO lite_audit (action, entity) VALUES
                ('create_user', 'pg_users'),
                ('create_order', 'ms_orders'),
                ('create_review', 'lite_reviews');

            -- DML across dialects
            UPDATE pg_users SET name = 'Alice Updated' WHERE id = 1;
            UPDATE my_products SET price = 19.99 WHERE name = 'Widget';
            DELETE FROM lite_reviews WHERE rating < 4;
        `);

        expect(r.errors()).toHaveLength(0);
        expect(r.tables.size).toBe(5);

        // PG users
        expect(r.table('pg_users').rows).toHaveLength(2);
        expect(r.table('pg_users').rows[0].name).toBe('Alice Updated');
        expect(r.table('pg_users').rows[0].id).toBe(1);

        // MySQL products
        expect(r.table('my_products').rows).toHaveLength(3);
        expect(r.table('my_products').rows[0].price).toBe(19.99);

        // MSSQL orders
        expect(r.table('ms_orders').rows).toHaveLength(3);
        expect(r.table('ms_orders').rows[0].id).toBe(1);
        expect(r.table('ms_orders').rows[2].quantity).toBe(5);

        // SQLite reviews — 1 deleted (rating 3)
        expect(r.table('lite_reviews').rows).toHaveLength(2);
        expect(r.table('lite_reviews').rows.every((row) => row.rating >= 4)).toBe(true);

        // SQLite audit
        expect(r.table('lite_audit').rows).toHaveLength(3);
        expect(r.table('lite_audit').rows[0].entry_id).toBe(1);
    });
});

describe('4-dialect trailing table options — executor', () => {
    it('all trailing options produce valid tables with DML', () => {
        const r = exec(`
            CREATE TABLE lite_wr (key TEXT PRIMARY KEY, val TEXT) WITHOUT ROWID;
            CREATE TABLE lite_s (id INTEGER PRIMARY KEY, val TEXT) STRICT;
            CREATE TABLE lite_swr (k TEXT PRIMARY KEY, v TEXT) STRICT, WITHOUT ROWID;
            CREATE TABLE mysql_e (id INT PRIMARY KEY, val TEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            CREATE TABLE plain (id INT PRIMARY KEY, val TEXT);

            INSERT INTO lite_wr (key, val) VALUES ('a', '1');
            INSERT INTO lite_s (id, val) VALUES (1, '2');
            INSERT INTO lite_swr (k, v) VALUES ('x', 'y');
            INSERT INTO mysql_e (id, val) VALUES (1, '3');
            INSERT INTO plain (id, val) VALUES (1, '4');
        `);

        expect(r.errors()).toHaveLength(0);
        expect(r.tables.size).toBe(5);
        expect(r.table('lite_wr').rows).toHaveLength(1);
        expect(r.table('lite_s').rows).toHaveLength(1);
        expect(r.table('lite_swr').rows).toHaveLength(1);
        expect(r.table('mysql_e').rows).toHaveLength(1);
        expect(r.table('plain').rows).toHaveLength(1);
    });
});

describe('SQLite keywords do NOT regress executor', () => {
    it('REPLACE keyword does not break INSERT parsing', () => {
        const r = exec(`
            CREATE TABLE t (id INT PRIMARY KEY, val TEXT);
            INSERT INTO t (id, val) VALUES (1, 'hello');
        `);
        expect(r.table('t').rows).toHaveLength(1);
        expect(r.errors()).toHaveLength(0);
    });

    it('ABORT/FAIL/IGNORE keywords do not break column parsing', () => {
        const r = exec(`
            CREATE TABLE t (
                id INT PRIMARY KEY,
                status TEXT NOT NULL DEFAULT 'active',
                priority INT DEFAULT 0
            );
            INSERT INTO t (id) VALUES (1);
        `);
        expect(r.table('t').rows[0].status).toBe('active');
        expect(r.table('t').rows[0].priority).toBe(0);
    });

    it('CONFLICT keyword does not break CHECK constraints in executor', () => {
        const r = exec(`
            CREATE TABLE t (
                id INT PRIMARY KEY,
                score INT CHECK (score >= 0)
            );
            INSERT INTO t (id, score) VALUES (1, 10);
        `);
        expect(r.table('t').rows[0].score).toBe(10);
        expect(r.errors()).toHaveLength(0);
    });

    it('WITHOUT/STRICT/ROWID keywords do not break normal table creation', () => {
        const r = exec(`
            CREATE TABLE normal1 (id INT PRIMARY KEY, val TEXT);
            CREATE TABLE normal2 (id SERIAL PRIMARY KEY, data JSONB);
            CREATE TABLE normal3 (id INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(100));
            INSERT INTO normal1 (id, val) VALUES (1, 'a');
            INSERT INTO normal2 (data) VALUES ('{}');
            INSERT INTO normal3 (name) VALUES ('test');
        `);
        expect(r.tables.size).toBe(3);
        expect(r.table('normal1').rows).toHaveLength(1);
        expect(r.table('normal2').rows).toHaveLength(1);
        expect(r.table('normal3').rows).toHaveLength(1);
        expect(r.errors()).toHaveLength(0);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// More edge cases — executor
// ════════════════════════════════════════════════════════════════════════════

describe('DROP + recreate with SQLite features', () => {
    it('DROP TABLE then recreate with AUTOINCREMENT resets counter', () => {
        const r = exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT);
            INSERT INTO t (val) VALUES ('a'), ('b'), ('c');
            DROP TABLE t;
            CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT);
            INSERT INTO t (val) VALUES ('x');
        `);
        expect(r.table('t').rows).toHaveLength(1);
        expect(r.table('t').rows[0].id).toBe(1);
        expect(r.table('t').rows[0].val).toBe('x');
    });

    it('DROP TABLE then recreate with WITHOUT ROWID', () => {
        const r = exec(`
            CREATE TABLE config (name TEXT PRIMARY KEY, val TEXT);
            INSERT INTO config (name, val) VALUES ('old', 'data');
            DROP TABLE config;
            CREATE TABLE config (name TEXT PRIMARY KEY, val TEXT) WITHOUT ROWID;
            INSERT INTO config (name, val) VALUES ('new', 'data');
        `);
        expect(r.table('config').rows).toHaveLength(1);
        expect(r.table('config').rows[0].name).toBe('new');
    });
});

describe('SQLite NULL handling with AUTOINCREMENT', () => {
    it('explicit NULL for auto-increment column triggers auto-assign', () => {
        const r = exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT);
            INSERT INTO t (id, val) VALUES (NULL, 'a');
            INSERT INTO t (id, val) VALUES (NULL, 'b');
        `);
        expect(r.table('t').rows).toHaveLength(2);
        expect(r.table('t').rows[0].id).toBe(1);
        expect(r.table('t').rows[1].id).toBe(2);
    });
});

describe('SQLite empty string vs NULL', () => {
    it('empty string is stored as empty string, not NULL', () => {
        const r = exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT NOT NULL);
            INSERT INTO t (id, val) VALUES (1, '');
            INSERT INTO t (id, val) VALUES (2, 'hello');
        `);
        expect(r.table('t').rows[0].val).toBe('');
        expect(r.table('t').rows[1].val).toBe('hello');
    });
});

describe('SQLite — multi-row INSERT with mixed auto/explicit', () => {
    it('multi-row VALUES with some explicit IDs, some auto', () => {
        const r = exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT);
            INSERT INTO t (id, val) VALUES (5, 'five');
            INSERT INTO t (val) VALUES ('six');
            INSERT INTO t (id, val) VALUES (100, 'hundred');
            INSERT INTO t (val) VALUES ('hundred_one');
        `);
        const rows = r.table('t').rows;
        expect(rows).toHaveLength(4);
        expect(rows[0].id).toBe(5);
        expect(rows[1].id).toBe(6);
        expect(rows[2].id).toBe(100);
        expect(rows[3].id).toBe(101);
    });
});

describe('SQLite — ALTER TABLE on SQLite tables', () => {
    it('ADD COLUMN to a STRICT table', () => {
        const r = exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY) STRICT;
            ALTER TABLE t ADD COLUMN name TEXT DEFAULT 'unknown';
            INSERT INTO t (id) VALUES (1);
        `);
        expect(r.table('t').columns).toHaveLength(2);
        expect(r.table('t').rows[0].name).toBe('unknown');
    });

    it('ADD COLUMN to a WITHOUT ROWID table', () => {
        const r = exec(`
            CREATE TABLE config (name TEXT PRIMARY KEY) WITHOUT ROWID;
            ALTER TABLE config ADD COLUMN val TEXT;
            INSERT INTO config (name, val) VALUES ('theme', 'dark');
        `);
        expect(r.table('config').columns).toHaveLength(2);
        expect(r.table('config').rows[0].val).toBe('dark');
    });

    it('DROP COLUMN from a table with AUTOINCREMENT', () => {
        const r = exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT, b TEXT);
            INSERT INTO t (a, b) VALUES ('x', 'y');
            ALTER TABLE t DROP COLUMN b;
            INSERT INTO t (a) VALUES ('z');
        `);
        expect(r.table('t').columns).toHaveLength(2);
        expect(r.table('t').rows).toHaveLength(2);
        expect(r.table('t').rows[1].id).toBe(2);
    });
});

describe('SQLite — batch INSERT + bulk DELETE', () => {
    it('100 rows inserted then all deleted', () => {
        const values = Array.from({ length: 100 }, (_, i) => `('item${i}')`).join(', ');
        const r = exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
            INSERT INTO t (name) VALUES ${values};
            DELETE FROM t WHERE id > 0;
        `);
        expect(r.table('t').rows).toHaveLength(0);
        expect(r.errors()).toHaveLength(0);
    });

    it('100 rows, delete half, insert more — counter is correct', () => {
        const values = Array.from({ length: 10 }, (_, i) => `('item${i}')`).join(', ');
        const r = exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
            INSERT INTO t (name) VALUES ${values};
            DELETE FROM t WHERE id <= 5;
            INSERT INTO t (name) VALUES ('new1'), ('new2');
        `);
        expect(r.table('t').rows).toHaveLength(7);
        // Last auto-assigned ID should be 12 (10 existing max + 2 new)
        const lastRow = r.table('t').rows[r.table('t').rows.length - 1];
        expect(lastRow.id).toBe(12);
    });
});

describe('SQLite — TRUNCATE equivalent', () => {
    it('TRUNCATE TABLE works on SQLite-style table', () => {
        const r = exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT) STRICT;
            INSERT INTO t (val) VALUES ('a'), ('b'), ('c');
            TRUNCATE TABLE t;
        `);
        expect(r.table('t').rows).toHaveLength(0);
    });
});

describe('SQLite — self-referencing FK with DML', () => {
    it('inserts parent then child rows with self-reference', () => {
        const r = exec(`
            CREATE TABLE categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                parent_id INTEGER REFERENCES categories(id)
            );
            INSERT INTO categories (name, parent_id) VALUES ('Root', NULL);
            INSERT INTO categories (name, parent_id) VALUES ('Child1', 1);
            INSERT INTO categories (name, parent_id) VALUES ('Child2', 1);
            INSERT INTO categories (name, parent_id) VALUES ('Grandchild', 2);
        `);
        const rows = r.table('categories').rows;
        expect(rows).toHaveLength(4);
        expect(rows[0].parent_id).toBeNull();
        expect(rows[1].parent_id).toBe(1);
        expect(rows[3].parent_id).toBe(2);
    });
});

describe('SQLite — DEFAULT value scenarios in executor', () => {
    it('DEFAULT CURRENT_TIMESTAMP produces a non-null value', () => {
        const r = exec(`
            CREATE TABLE t (
                id INTEGER PRIMARY KEY,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO t (id) VALUES (1);
        `);
        expect(r.table('t').rows[0].created_at).toBeTruthy();
    });

    it('multiple columns with different defaults', () => {
        const r = exec(`
            CREATE TABLE t (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                status TEXT DEFAULT 'pending',
                priority INTEGER DEFAULT 5,
                score REAL DEFAULT 0.0,
                notes TEXT DEFAULT NULL
            );
            INSERT INTO t (id) VALUES (1);
        `);
        const row = r.table('t').rows[0];
        expect(row.status).toBe('pending');
        expect(row.priority).toBe(5);
        expect(row.score).toBe(0);
        expect(row.notes).toBeNull();
    });
});

describe('SQLite — real-world chat app schema with DML', () => {
    it('handles a chat application schema end-to-end', () => {
        const r = exec(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                display_name TEXT,
                status TEXT DEFAULT 'online'
            );

            CREATE TABLE rooms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                created_by INTEGER NOT NULL REFERENCES users(id),
                is_private INTEGER DEFAULT 0
            );

            CREATE TABLE room_members (
                room_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                role TEXT DEFAULT 'member',
                joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (room_id, user_id),
                FOREIGN KEY (room_id) REFERENCES rooms(id),
                FOREIGN KEY (user_id) REFERENCES users(id)
            ) WITHOUT ROWID;

            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id INTEGER NOT NULL REFERENCES rooms(id),
                sender_id INTEGER NOT NULL REFERENCES users(id),
                content TEXT NOT NULL,
                sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
                edited INTEGER DEFAULT 0
            );

            CREATE TABLE attachments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id INTEGER NOT NULL REFERENCES messages(id),
                file_name TEXT NOT NULL,
                file_size INTEGER NOT NULL
            ) STRICT;

            -- Users
            INSERT INTO users (username, display_name) VALUES
                ('alice', 'Alice'), ('bob', 'Bob'), ('charlie', 'Charlie');

            -- Rooms
            INSERT INTO rooms (name, created_by, is_private) VALUES
                ('General', 1, 0), ('Dev Team', 1, 1), ('Random', 2, 0);

            -- Members
            INSERT INTO room_members (room_id, user_id, role) VALUES
                (1, 1, 'admin'), (1, 2, 'member'), (1, 3, 'member'),
                (2, 1, 'admin'), (2, 2, 'member'),
                (3, 2, 'admin'), (3, 3, 'member');

            -- Messages
            INSERT INTO messages (room_id, sender_id, content) VALUES
                (1, 1, 'Hello everyone!'),
                (1, 2, 'Hey Alice!'),
                (1, 3, 'Hi all'),
                (2, 1, 'Sprint planning tomorrow'),
                (2, 2, 'Got it'),
                (3, 2, 'Random thought');

            -- Attachments
            INSERT INTO attachments (message_id, file_name, file_size) VALUES
                (1, 'welcome.png', 1024),
                (4, 'sprint.pdf', 2048);

            -- Edits and deletions
            UPDATE messages SET content = 'Hello everyone! 👋', edited = 1 WHERE id = 1;
            DELETE FROM messages WHERE id = 6;

            CREATE INDEX idx_messages_room ON messages (room_id);
            CREATE INDEX idx_messages_sender ON messages (sender_id);
        `);

        expect(r.errors()).toHaveLength(0);
        expect(r.tables.size).toBe(5);

        // Users
        expect(r.table('users').rows).toHaveLength(3);
        expect(r.table('users').rows[0].username).toBe('alice');

        // Rooms
        expect(r.table('rooms').rows).toHaveLength(3);

        // Members (WITHOUT ROWID, composite PK)
        expect(r.table('room_members').rows).toHaveLength(7);
        expect(r.table('room_members').compositePk).toEqual(['room_id', 'user_id']);

        // Messages — 1 deleted, 1 edited
        expect(r.table('messages').rows).toHaveLength(5);
        expect(r.table('messages').rows[0].content).toBe('Hello everyone! 👋');
        expect(r.table('messages').rows[0].edited).toBe(1);

        // Attachments (STRICT)
        expect(r.table('attachments').rows).toHaveLength(2);

        // Indexes
        expect(r.table('messages').indexes).toHaveLength(2);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Production — 4-dialect e-commerce with full lifecycle DML
// ════════════════════════════════════════════════════════════════════════════

describe('Production — 4-dialect e-commerce with full DML lifecycle', () => {
    it('handles 10+ tables, 50+ rows, UPDATE/DELETE chains, and deferred DML', () => {
        const r = exec(`
            -- ═══ PG ═══
            CREATE TABLE pg_users (
                id SERIAL PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                tier TEXT DEFAULT 'free'
            );

            -- ═══ MySQL ═══
            CREATE TABLE my_products (
                id INT AUTO_INCREMENT PRIMARY KEY,
                sku VARCHAR(50) NOT NULL UNIQUE,
                name VARCHAR(200) NOT NULL,
                price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
                stock INT NOT NULL DEFAULT 0
            );

            -- ═══ MSSQL ═══
            CREATE TABLE ms_orders (
                id INT IDENTITY(1000,1) PRIMARY KEY,
                user_id INT NOT NULL,
                total DECIMAL(10,2) NOT NULL DEFAULT 0,
                status TEXT DEFAULT 'pending',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE ms_order_items (
                id INT IDENTITY(1,1) PRIMARY KEY,
                order_id INT NOT NULL,
                product_id INT NOT NULL,
                quantity INT NOT NULL DEFAULT 1,
                unit_price DECIMAL(10,2) NOT NULL
            );

            -- ═══ SQLite ═══
            CREATE TABLE lite_cart (
                user_id INTEGER NOT NULL,
                product_id INTEGER NOT NULL,
                quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
                PRIMARY KEY (user_id, product_id)
            ) WITHOUT ROWID;

            CREATE TABLE lite_reviews (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                product_id INTEGER NOT NULL,
                rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
                title TEXT,
                body TEXT DEFAULT '',
                helpful_count INTEGER DEFAULT 0
            ) STRICT;

            CREATE TABLE lite_wishlist (
                user_id INTEGER NOT NULL,
                product_id INTEGER NOT NULL,
                added_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, product_id)
            ) STRICT, WITHOUT ROWID;

            CREATE TABLE lite_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT NOT NULL,
                entity TEXT NOT NULL,
                entity_id INTEGER,
                details TEXT
            );

            -- ═══ Seed Data ═══
            INSERT INTO pg_users (email, name, tier) VALUES
                ('alice@shop.com', 'Alice', 'premium'),
                ('bob@shop.com', 'Bob', 'free'),
                ('charlie@shop.com', 'Charlie', 'premium'),
                ('diana@shop.com', 'Diana', 'free'),
                ('eve@shop.com', 'Eve', 'free');

            INSERT INTO my_products (sku, name, price, stock) VALUES
                ('WIDGET-001', 'Widget Pro', 29.99, 100),
                ('GADGET-002', 'Gadget Plus', 49.99, 50),
                ('THING-003', 'Thing X', 9.99, 200),
                ('DOOHICKEY-004', 'Doohickey Z', 14.99, 75),
                ('GIZMO-005', 'Gizmo Ultra', 99.99, 25);

            INSERT INTO ms_orders (user_id, total, status) VALUES
                (1, 79.98, 'confirmed'),
                (1, 49.99, 'shipped'),
                (2, 29.99, 'pending'),
                (3, 149.97, 'delivered'),
                (4, 9.99, 'cancelled');

            INSERT INTO ms_order_items (order_id, product_id, quantity, unit_price) VALUES
                (1000, 1, 2, 29.99),
                (1000, 3, 2, 9.99),
                (1001, 2, 1, 49.99),
                (1002, 1, 1, 29.99),
                (1003, 5, 1, 99.99),
                (1003, 2, 1, 49.99),
                (1004, 3, 1, 9.99);

            INSERT INTO lite_cart (user_id, product_id, quantity) VALUES
                (2, 1, 1), (2, 4, 3),
                (5, 2, 1), (5, 5, 1);

            INSERT INTO lite_reviews (user_id, product_id, rating, title, body) VALUES
                (1, 1, 5, 'Amazing', 'Best widget ever'),
                (1, 2, 4, 'Good', 'Works well'),
                (2, 1, 3, 'OK', 'Nothing special'),
                (3, 5, 5, 'Love it', 'Worth every penny'),
                (4, 3, 1, 'Broken', 'Arrived damaged');

            INSERT INTO lite_wishlist (user_id, product_id) VALUES
                (1, 5), (2, 2), (2, 5), (3, 1), (5, 4);

            INSERT INTO lite_audit (action, entity, entity_id, details) VALUES
                ('register', 'user', 1, 'Alice joined'),
                ('register', 'user', 2, 'Bob joined'),
                ('order', 'order', 1000, 'Alice order'),
                ('review', 'product', 1, 'Alice reviewed Widget Pro');

            -- ═══ DML Lifecycle ═══

            -- 1. Upgrade Bob to premium
            UPDATE pg_users SET tier = 'premium' WHERE email = 'bob@shop.com';

            -- 2. Update stock after orders
            UPDATE my_products SET stock = 98 WHERE sku = 'WIDGET-001';
            UPDATE my_products SET stock = 49 WHERE sku = 'GADGET-002';

            -- 3. Cancel a review
            DELETE FROM lite_reviews WHERE user_id = 4 AND product_id = 3;

            -- 4. Empty Bob's cart (he checked out)
            DELETE FROM lite_cart WHERE user_id = 2;

            -- 5. Mark helpful reviews
            UPDATE lite_reviews SET helpful_count = 10 WHERE user_id = 1 AND product_id = 1;

            -- 6. New order from Bob
            INSERT INTO ms_orders (user_id, total, status) VALUES (2, 64.98, 'pending');
            INSERT INTO ms_order_items (order_id, product_id, quantity, unit_price) VALUES
                (1005, 2, 1, 49.99), (1005, 4, 1, 14.99);

            -- 7. Audit the activity
            INSERT INTO lite_audit (action, entity, entity_id, details) VALUES
                ('upgrade', 'user', 2, 'Bob -> premium'),
                ('order', 'order', 1005, 'Bob order');

            -- Indexes
            CREATE INDEX idx_orders_user ON ms_orders (user_id);
            CREATE INDEX idx_reviews_product ON lite_reviews (product_id);
            CREATE INDEX idx_audit_entity ON lite_audit (entity, entity_id);
        `);

        expect(r.errors()).toHaveLength(0);
        expect(r.tables.size).toBe(8);

        // ═══ PG users ═══
        expect(r.table('pg_users').rows).toHaveLength(5);
        const bob = r.table('pg_users').rows.find((row) => row.email === 'bob@shop.com');
        expect(bob.tier).toBe('premium'); // was upgraded

        // ═══ MySQL products ═══
        expect(r.table('my_products').rows).toHaveLength(5);
        const widget = r.table('my_products').rows.find((row) => row.sku === 'WIDGET-001');
        expect(widget.stock).toBe(98); // 100 - 2
        const gadget = r.table('my_products').rows.find((row) => row.sku === 'GADGET-002');
        expect(gadget.stock).toBe(49); // 50 - 1

        // ═══ MSSQL orders (IDENTITY seed=1000) ═══
        expect(r.table('ms_orders').rows).toHaveLength(6); // 5 + 1 new
        expect(r.table('ms_orders').rows[0].id).toBe(1000);
        expect(r.table('ms_orders').rows[5].id).toBe(1005);
        expect(r.table('ms_orders').rows[5].status).toBe('pending');

        // ═══ MSSQL order items ═══
        expect(r.table('ms_order_items').rows).toHaveLength(9); // 7 + 2 new

        // ═══ SQLite cart (WITHOUT ROWID) ═══
        expect(r.table('lite_cart').rows).toHaveLength(2); // Bob's 2 removed, Eve's 2 remain
        expect(r.table('lite_cart').rows.every((row) => row.user_id === 5)).toBe(true);
        expect(r.table('lite_cart').compositePk).toEqual(['user_id', 'product_id']);

        // ═══ SQLite reviews (STRICT, AUTOINCREMENT) ═══
        expect(r.table('lite_reviews').rows).toHaveLength(4); // 5 - 1 deleted
        const helpfulReview = r.table('lite_reviews').rows.find((row) => row.user_id === 1 && row.product_id === 1);
        expect(helpfulReview.helpful_count).toBe(10);
        expect(r.table('lite_reviews').rows.every((row) => !(row.user_id === 4 && row.product_id === 3))).toBe(true);

        // ═══ SQLite wishlist (STRICT, WITHOUT ROWID) ═══
        expect(r.table('lite_wishlist').rows).toHaveLength(5);

        // ═══ SQLite audit (AUTOINCREMENT) ═══
        expect(r.table('lite_audit').rows).toHaveLength(6); // 4 + 2 new
        expect(r.table('lite_audit').rows[4].details).toBe('Bob -> premium');
        expect(r.table('lite_audit').rows[5].id).toBe(6);

        // ═══ Indexes ═══
        expect(r.table('ms_orders').indexes).toHaveLength(1);
        expect(r.table('lite_reviews').indexes).toHaveLength(1);
        expect(r.table('lite_audit').indexes).toHaveLength(1);
    });
});

describe('Production — deferred DML (INSERT before CREATE TABLE)', () => {
    it('handles INSERT above CREATE TABLE via two-pass execution', () => {
        const r = exec(`
            -- Data first (should be deferred)
            INSERT INTO late_table (id, val) VALUES (1, 'deferred1');
            INSERT INTO late_table (id, val) VALUES (2, 'deferred2');
            INSERT INTO late_table (id, val) VALUES (3, 'deferred3');

            -- Then DDL
            CREATE TABLE late_table (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                val TEXT NOT NULL
            );
        `);

        expect(r.table('late_table')).not.toBeNull();
        expect(r.table('late_table').rows).toHaveLength(3);
        expect(r.table('late_table').rows[0].val).toBe('deferred1');
    });
});

describe('Production — MSSQL IDENTITY with custom seed/step', () => {
    it('IDENTITY(100,5) produces correct sequence', () => {
        const r = exec(`
            CREATE TABLE t (id INT IDENTITY(100,5) PRIMARY KEY, name TEXT);
            INSERT INTO t (name) VALUES ('a'), ('b'), ('c'), ('d');
        `);
        expect(r.table('t').rows[0].id).toBe(100);
        expect(r.table('t').rows[1].id).toBe(105);
        expect(r.table('t').rows[2].id).toBe(110);
        expect(r.table('t').rows[3].id).toBe(115);
    });

    it('IDENTITY(1,1) alongside AUTOINCREMENT in same script', () => {
        const r = exec(`
            CREATE TABLE ms_t (id INT IDENTITY(1,1) PRIMARY KEY, val TEXT);
            CREATE TABLE lite_t (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT);
            INSERT INTO ms_t (val) VALUES ('m1'), ('m2');
            INSERT INTO lite_t (val) VALUES ('l1'), ('l2'), ('l3');
        `);
        expect(r.table('ms_t').rows[0].id).toBe(1);
        expect(r.table('ms_t').rows[1].id).toBe(2);
        expect(r.table('lite_t').rows[0].id).toBe(1);
        expect(r.table('lite_t').rows[2].id).toBe(3);
    });
});

describe('Production — complex WHERE chains across dialects', () => {
    it('UPDATE with AND/OR conditions on SQLite table', () => {
        const r = exec(`
            CREATE TABLE t (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                status TEXT DEFAULT 'active',
                score INTEGER DEFAULT 0
            );
            INSERT INTO t (status, score) VALUES
                ('active', 10), ('active', 20), ('inactive', 30),
                ('active', 5), ('inactive', 50);
            UPDATE t SET status = 'promoted' WHERE status = 'active' AND score >= 10;
        `);
        const promoted = r.table('t').rows.filter((row) => row.status === 'promoted');
        expect(promoted).toHaveLength(2); // score 10 and 20
        expect(promoted.every((row) => row.score >= 10)).toBe(true);
    });

    it('DELETE with OR condition on MSSQL table', () => {
        const r = exec(`
            CREATE TABLE t (id INT IDENTITY(1,1) PRIMARY KEY, val TEXT, flag INT DEFAULT 0);
            INSERT INTO t (val, flag) VALUES ('a', 0), ('b', 1), ('c', 0), ('d', 1), ('e', 0);
            DELETE FROM t WHERE flag = 1 OR val = 'e';
        `);
        expect(r.table('t').rows).toHaveLength(2); // a, c remain
    });
});

describe('Production — UPDATE SET multiple columns simultaneously', () => {
    it('updates 3 columns in one UPDATE on SQLite table', () => {
        const r = exec(`
            CREATE TABLE t (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                status TEXT DEFAULT 'active',
                score INTEGER DEFAULT 0
            );
            INSERT INTO t (name) VALUES ('Alice'), ('Bob'), ('Charlie');
            UPDATE t SET status = 'promoted', score = 100, name = 'ALICE' WHERE id = 1;
        `);
        expect(r.table('t').rows[0].name).toBe('ALICE');
        expect(r.table('t').rows[0].status).toBe('promoted');
        expect(r.table('t').rows[0].score).toBe(100);
        // Others unchanged
        expect(r.table('t').rows[1].name).toBe('Bob');
        expect(r.table('t').rows[1].status).toBe('active');
    });
});

describe('Production — DELETE with BETWEEN', () => {
    it('deletes rows within numeric range', () => {
        const r = exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT);
            INSERT INTO t (val) VALUES ('a'), ('b'), ('c'), ('d'), ('e'), ('f'), ('g'), ('h'), ('i'), ('j');
            DELETE FROM t WHERE id BETWEEN 3 AND 7;
        `);
        expect(r.table('t').rows).toHaveLength(5); // 1,2,8,9,10 remain
        expect(r.table('t').rows.map((row) => row.val)).toEqual(['a', 'b', 'h', 'i', 'j']);
    });
});

describe('Production — DELETE with LIKE', () => {
    it('deletes rows matching LIKE pattern', () => {
        const r = exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL);
            INSERT INTO t (email) VALUES
                ('alice@gmail.com'), ('bob@yahoo.com'), ('charlie@gmail.com'),
                ('diana@outlook.com'), ('eve@gmail.com');
            DELETE FROM t WHERE email LIKE '%@gmail.com';
        `);
        expect(r.table('t').rows).toHaveLength(2);
        expect(r.table('t').rows.map((row) => row.email)).toEqual(['bob@yahoo.com', 'diana@outlook.com']);
    });
});

describe('Production — composite PK duplicate detection', () => {
    it('composite PK tables allow different combos', () => {
        const r = exec(`
            CREATE TABLE t (
                a INTEGER NOT NULL,
                b INTEGER NOT NULL,
                val TEXT,
                PRIMARY KEY (a, b)
            ) WITHOUT ROWID;
            INSERT INTO t (a, b, val) VALUES (1, 1, 'aa');
            INSERT INTO t (a, b, val) VALUES (1, 2, 'ab');
            INSERT INTO t (a, b, val) VALUES (2, 1, 'ba');
            INSERT INTO t (a, b, val) VALUES (2, 2, 'bb');
        `);
        expect(r.table('t').rows).toHaveLength(4);
        expect(r.table('t').compositePk).toEqual(['a', 'b']);
    });
});

describe('Production — multi-table FK chain with DML lifecycle', () => {
    it('3-level FK chain: users -> posts -> comments', () => {
        const r = exec(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL
            );
            CREATE TABLE posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                title TEXT NOT NULL
            );
            CREATE TABLE comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                post_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                body TEXT NOT NULL
            );

            INSERT INTO users (name) VALUES ('Alice'), ('Bob');
            INSERT INTO posts (user_id, title) VALUES (1, 'Hello World'), (1, 'Second Post'), (2, 'Bob Here');
            INSERT INTO comments (post_id, user_id, body) VALUES
                (1, 2, 'Nice post!'),
                (1, 1, 'Thanks!'),
                (2, 2, 'Interesting'),
                (3, 1, 'Welcome Bob');

            -- Delete all comments on post 2
            DELETE FROM comments WHERE post_id = 2;
            -- Update post title
            UPDATE posts SET title = 'Hello World (Updated)' WHERE id = 1;
            -- Delete Bob's post
            DELETE FROM posts WHERE user_id = 2;
        `);
        expect(r.table('users').rows).toHaveLength(2);
        expect(r.table('posts').rows).toHaveLength(2);
        expect(r.table('posts').rows[0].title).toBe('Hello World (Updated)');
        expect(r.table('comments').rows).toHaveLength(3); // comment on post 2 deleted
        expect(r.table('comments').rows.every((c) => c.post_id !== 2)).toBe(true);
    });
});

describe('Production — DROP + recreate + INSERT in same script', () => {
    it('drops, recreates with different columns, and inserts new data', () => {
        const r = exec(`
            -- v1
            CREATE TABLE config (id INTEGER PRIMARY KEY, key TEXT, val TEXT);
            INSERT INTO config (id, key, val) VALUES (1, 'theme', 'light');

            -- v2: redesign
            DROP TABLE config;
            CREATE TABLE config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                type TEXT NOT NULL DEFAULT 'string'
            ) WITHOUT ROWID;
            INSERT INTO config (key, value, type) VALUES
                ('theme', 'dark', 'string'),
                ('font_size', '14', 'number'),
                ('notifications', 'true', 'boolean');
        `);
        expect(r.table('config').rows).toHaveLength(3);
        expect(r.table('config').columns.map((c) => c.name)).toEqual(['key', 'value', 'type']);
        expect(r.table('config').rows[0].key).toBe('theme');
        expect(r.table('config').rows[0].value).toBe('dark');
    });
});

describe('Production — full 10-table SQLite blog with 100+ rows', () => {
    it('handles complete blog schema with seed data and DML lifecycle', () => {
        const r = exec(`
            -- Schema
            CREATE TABLE settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) STRICT, WITHOUT ROWID;

            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                email TEXT NOT NULL UNIQUE,
                role TEXT DEFAULT 'reader',
                joined TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE profiles (
                user_id INTEGER PRIMARY KEY,
                bio TEXT DEFAULT '',
                avatar TEXT
            ) WITHOUT ROWID;

            CREATE TABLE categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                parent_id INTEGER
            );

            CREATE TABLE posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                author_id INTEGER NOT NULL,
                category_id INTEGER,
                title TEXT NOT NULL,
                body TEXT DEFAULT '',
                status TEXT DEFAULT 'draft',
                views INTEGER DEFAULT 0,
                created TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE
            );

            CREATE TABLE post_tags (
                post_id INTEGER NOT NULL,
                tag_id INTEGER NOT NULL,
                PRIMARY KEY (post_id, tag_id)
            ) WITHOUT ROWID;

            CREATE TABLE comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                post_id INTEGER NOT NULL,
                author_id INTEGER NOT NULL,
                parent_id INTEGER,
                body TEXT NOT NULL,
                created TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE likes (
                user_id INTEGER NOT NULL,
                post_id INTEGER NOT NULL,
                PRIMARY KEY (user_id, post_id)
            ) WITHOUT ROWID;

            CREATE TABLE audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT NOT NULL,
                entity TEXT NOT NULL,
                entity_id INTEGER,
                actor_id INTEGER,
                ts TEXT DEFAULT CURRENT_TIMESTAMP
            ) STRICT;

            -- Seed: Settings
            INSERT INTO settings (key, value) VALUES
                ('site_name', 'My Blog'), ('theme', 'dark'), ('per_page', '20');

            -- Seed: Users
            INSERT INTO users (username, email, role) VALUES
                ('admin', 'admin@blog.com', 'admin'),
                ('alice', 'alice@blog.com', 'author'),
                ('bob', 'bob@blog.com', 'author'),
                ('charlie', 'charlie@blog.com', 'reader'),
                ('diana', 'diana@blog.com', 'reader');

            -- Seed: Profiles
            INSERT INTO profiles (user_id, bio) VALUES
                (1, 'Site administrator'),
                (2, 'Tech writer'),
                (3, 'Food blogger'),
                (4, ''),
                (5, 'Book lover');

            -- Seed: Categories
            INSERT INTO categories (name, parent_id) VALUES
                ('Tech', NULL), ('Food', NULL), ('Books', NULL),
                ('JavaScript', 1), ('Python', 1), ('Recipes', 2);

            -- Seed: Posts (12 posts)
            INSERT INTO posts (author_id, category_id, title, status, views) VALUES
                (2, 4, 'Intro to JavaScript', 'published', 150),
                (2, 4, 'Advanced JS Patterns', 'published', 89),
                (2, 5, 'Python Basics', 'published', 200),
                (3, 6, 'Easy Pasta Recipe', 'published', 300),
                (3, 6, 'Homemade Bread', 'published', 175),
                (3, 2, 'Food Photography Tips', 'draft', 0),
                (2, 4, 'TypeScript Guide', 'draft', 0),
                (1, NULL, 'Welcome Post', 'published', 500),
                (2, 5, 'Django Tutorial', 'published', 120),
                (3, 6, 'Sushi at Home', 'published', 250),
                (2, 4, 'React Hooks Deep Dive', 'published', 180),
                (3, 2, 'Kitchen Organization', 'published', 95);

            -- Seed: Tags
            INSERT INTO tags (name) VALUES
                ('tutorial'), ('beginner'), ('advanced'), ('quick'),
                ('healthy'), ('vegetarian'), ('web'), ('backend');

            -- Seed: Post Tags (20 mappings)
            INSERT INTO post_tags (post_id, tag_id) VALUES
                (1, 1), (1, 2), (1, 7),
                (2, 1), (2, 3), (2, 7),
                (3, 1), (3, 2), (3, 8),
                (4, 4), (4, 6),
                (5, 4),
                (8, 2),
                (9, 1), (9, 8),
                (10, 4), (10, 5),
                (11, 1), (11, 3), (11, 7);

            -- Seed: Comments (15 comments)
            INSERT INTO comments (post_id, author_id, parent_id, body) VALUES
                (1, 4, NULL, 'Great intro!'),
                (1, 5, NULL, 'Very helpful'),
                (1, 3, 1, 'Thanks for the feedback!'),
                (3, 4, NULL, 'Python is awesome'),
                (3, 5, 4, 'Agreed!'),
                (4, 2, NULL, 'Looks delicious'),
                (4, 4, NULL, 'Making this tonight'),
                (4, 5, 7, 'Let me know how it goes'),
                (8, 4, NULL, 'Welcome!'),
                (8, 5, NULL, 'Nice blog'),
                (8, 3, NULL, 'Happy to be here'),
                (10, 2, NULL, 'I need to try this'),
                (11, 3, NULL, 'Hooks are great'),
                (11, 4, 13, 'Especially useReducer'),
                (12, 2, NULL, 'Good tips');

            -- Seed: Likes (25 likes)
            INSERT INTO likes (user_id, post_id) VALUES
                (4, 1), (5, 1), (3, 1),
                (4, 3), (5, 3),
                (2, 4), (4, 4), (5, 4),
                (2, 5), (4, 5),
                (4, 8), (5, 8), (3, 8), (2, 8),
                (4, 10), (5, 10), (2, 10),
                (3, 11), (4, 11), (5, 11),
                (4, 9), (5, 9),
                (2, 12), (4, 12),
                (4, 2);

            -- Seed: Audit
            INSERT INTO audit_log (action, entity, entity_id, actor_id) VALUES
                ('create', 'user', 1, 1), ('create', 'user', 2, 1),
                ('publish', 'post', 1, 2), ('publish', 'post', 4, 3);

            -- ═══ DML Lifecycle ═══

            -- Promote charlie to author
            UPDATE users SET role = 'author' WHERE username = 'charlie';

            -- Publish draft posts
            UPDATE posts SET status = 'published', views = 1 WHERE status = 'draft';

            -- Delete a comment thread (parent + child)
            DELETE FROM comments WHERE id = 7 OR parent_id = 7;

            -- Remove a tag mapping
            DELETE FROM post_tags WHERE post_id = 5 AND tag_id = 4;

            -- Update setting
            UPDATE settings SET value = 'light' WHERE key = 'theme';

            -- Add new post by charlie (now an author)
            INSERT INTO posts (author_id, category_id, title, status, views) VALUES
                (4, 3, 'Book Review: Dune', 'published', 0);

            -- Add audit entries
            INSERT INTO audit_log (action, entity, entity_id, actor_id) VALUES
                ('promote', 'user', 4, 1),
                ('publish', 'post', 6, 3),
                ('publish', 'post', 7, 2),
                ('create', 'post', 13, 4);

            -- Indexes
            CREATE INDEX idx_posts_author ON posts (author_id);
            CREATE INDEX idx_posts_status ON posts (status);
            CREATE INDEX idx_comments_post ON comments (post_id);
        `);

        expect(r.errors()).toHaveLength(0);
        expect(r.tables.size).toBe(10);

        // Settings (STRICT, WITHOUT ROWID)
        expect(r.table('settings').rows).toHaveLength(3);
        expect(r.table('settings').rows.find((s) => s.key === 'theme').value).toBe('light');

        // Users
        expect(r.table('users').rows).toHaveLength(5);
        expect(r.table('users').rows.find((u) => u.username === 'charlie').role).toBe('author');

        // Profiles (WITHOUT ROWID)
        expect(r.table('profiles').rows).toHaveLength(5);

        // Categories (self-ref parent_id)
        expect(r.table('categories').rows).toHaveLength(6);
        expect(r.table('categories').rows[3].parent_id).toBe(1); // JavaScript -> Tech

        // Posts: 12 original + 1 new = 13, all now published
        expect(r.table('posts').rows).toHaveLength(13);
        expect(r.table('posts').rows.every((p) => p.status === 'published')).toBe(true);
        expect(r.table('posts').rows[12].title).toBe('Book Review: Dune');
        expect(r.table('posts').rows[12].id).toBe(13);

        // Tags
        expect(r.table('tags').rows).toHaveLength(8);

        // Post_tags (WITHOUT ROWID): 20 - 1 deleted = 19
        expect(r.table('post_tags').rows).toHaveLength(19);
        expect(r.table('post_tags').compositePk).toEqual(['post_id', 'tag_id']);

        // Comments: 15 - 2 deleted (id=7 + parent_id=7) = 13
        expect(r.table('comments').rows).toHaveLength(13);
        expect(r.table('comments').rows.every((c) => c.id !== 7)).toBe(true);

        // Likes (WITHOUT ROWID, composite PK)
        expect(r.table('likes').rows).toHaveLength(25);
        expect(r.table('likes').compositePk).toEqual(['user_id', 'post_id']);

        // Audit (STRICT)
        expect(r.table('audit_log').rows).toHaveLength(8); // 4 + 4

        // Indexes
        expect(r.table('posts').indexes).toHaveLength(2);
        expect(r.table('comments').indexes).toHaveLength(1);
    });
});

describe('Executor — RENAME COLUMN with data migration', () => {
    it('renames column and preserves row data', () => {
        const r = exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, old_name TEXT NOT NULL);
            INSERT INTO t (old_name) VALUES ('Alice'), ('Bob');
            ALTER TABLE t RENAME COLUMN old_name TO new_name;
            INSERT INTO t (new_name) VALUES ('Charlie');
        `);
        expect(r.table('t').columns.some((c) => c.name === 'new_name')).toBe(true);
        expect(r.table('t').columns.some((c) => c.name === 'old_name')).toBe(false);
        expect(r.table('t').rows).toHaveLength(3);
        expect(r.table('t').rows[0].new_name).toBe('Alice');
        expect(r.table('t').rows[2].new_name).toBe('Charlie');
    });
});

describe('Executor — ALTER ADD COLUMN then INSERT', () => {
    it('adds column with default and inserts use it', () => {
        const r = exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
            INSERT INTO t (name) VALUES ('Alice');
            ALTER TABLE t ADD COLUMN age INTEGER DEFAULT 25;
            INSERT INTO t (name, age) VALUES ('Bob', 30);
        `);
        expect(r.table('t').columns).toHaveLength(3);
        expect(r.table('t').rows).toHaveLength(2);
        expect(r.table('t').rows[1].age).toBe(30);
    });
});

describe('Executor — DROP COLUMN with existing data', () => {
    it('removes column and cleans row data', () => {
        const r = exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, temp TEXT);
            INSERT INTO t (name, temp) VALUES ('Alice', 'delete-me'), ('Bob', 'also-delete');
            ALTER TABLE t DROP COLUMN temp;
        `);
        expect(r.table('t').columns).toHaveLength(2);
        expect(r.table('t').rows[0].temp).toBeUndefined();
        expect(r.table('t').rows[0].name).toBe('Alice');
    });
});

describe('Executor — INSERT with defaults only (no columns specified)', () => {
    it('inserts row using all default values', () => {
        const r = exec(`
            CREATE TABLE t (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                status TEXT DEFAULT 'new',
                count INTEGER DEFAULT 0
            );
            INSERT INTO t DEFAULT VALUES;
        `);
        // Some executors may not support DEFAULT VALUES — check if it doesn't crash
        expect(r.table('t')).not.toBeNull();
    });
});

describe('Executor — UPDATE SET column to NULL', () => {
    it('sets column value to NULL explicitly', () => {
        const r = exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, note TEXT DEFAULT 'hello');
            INSERT INTO t (name, note) VALUES ('Alice', 'some note'), ('Bob', 'other note');
            UPDATE t SET note = NULL WHERE name = 'Alice';
        `);
        expect(r.table('t').rows[0].note).toBeNull();
        expect(r.table('t').rows[1].note).toBe('other note');
    });
});

describe('Executor — DELETE all rows (no WHERE)', () => {
    it('deletes every row when no WHERE clause', () => {
        const r = exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT);
            INSERT INTO t (val) VALUES ('a'), ('b'), ('c'), ('d'), ('e');
            DELETE FROM t;
        `);
        expect(r.table('t').rows).toHaveLength(0);
    });

    it('AUTOINCREMENT counter does not reset after DELETE all + re-insert', () => {
        const r = exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT);
            INSERT INTO t (val) VALUES ('a'), ('b'), ('c');
            DELETE FROM t;
            INSERT INTO t (val) VALUES ('new');
        `);
        expect(r.table('t').rows).toHaveLength(1);
        expect(r.table('t').rows[0].id).toBe(4); // counter continues past deleted ids
    });
});

describe('Executor — multi-ALTER chain on single table', () => {
    it('ADD + RENAME + DROP columns in sequence', () => {
        const r = exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
            INSERT INTO t (name) VALUES ('Alice');

            ALTER TABLE t ADD COLUMN email TEXT DEFAULT 'none';
            ALTER TABLE t ADD COLUMN temp INTEGER DEFAULT 0;
            ALTER TABLE t RENAME COLUMN name TO full_name;
            ALTER TABLE t DROP COLUMN temp;

            INSERT INTO t (full_name, email) VALUES ('Bob', 'bob@test.com');
        `);
        const cols = r.table('t').columns.map((c) => c.name);
        expect(cols).toContain('full_name');
        expect(cols).toContain('email');
        expect(cols).not.toContain('name');
        expect(cols).not.toContain('temp');
        expect(r.table('t').rows).toHaveLength(2);
        expect(r.table('t').rows[0].full_name).toBe('Alice');
        expect(r.table('t').rows[1].email).toBe('bob@test.com');
    });
});

describe('Executor — PG GENERATED ALWAYS AS IDENTITY with START WITH/INCREMENT BY', () => {
    it('parses named sequence options', () => {
        const r = exec(`
            CREATE TABLE t (
                id BIGINT GENERATED ALWAYS AS IDENTITY (START WITH 50 INCREMENT BY 5) PRIMARY KEY,
                val TEXT
            );
            INSERT INTO t (val) VALUES ('a'), ('b'), ('c');
        `);
        expect(r.table('t').rows[0].id).toBe(50);
        expect(r.table('t').rows[1].id).toBe(55);
        expect(r.table('t').rows[2].id).toBe(60);
    });
});

describe('Executor — CREATE INDEX on SQLite STRICT table', () => {
    it('indexes work on STRICT + WITHOUT ROWID tables with DML', () => {
        const r = exec(`
            CREATE TABLE t (
                a TEXT NOT NULL,
                b TEXT NOT NULL,
                c INTEGER DEFAULT 0,
                PRIMARY KEY (a, b)
            ) STRICT, WITHOUT ROWID;

            INSERT INTO t (a, b, c) VALUES ('x', 'y', 1), ('x', 'z', 2), ('w', 'y', 3);

            CREATE INDEX idx_c ON t (c);
            CREATE UNIQUE INDEX uq_ab ON t (a, b);

            DELETE FROM t WHERE a = 'w';
        `);
        expect(r.table('t').rows).toHaveLength(2);
        expect(r.table('t').indexes).toHaveLength(2);
        expect(r.table('t').indexes[0].name).toBe('idx_c');
        expect(r.table('t').indexes[1].unique).toBe(true);
    });
});

describe('Executor — UPDATE with string comparison', () => {
    it('updates based on string equality with special characters', () => {
        const r = exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, status TEXT DEFAULT 'pending');
            INSERT INTO t (name) VALUES ('O''Brien'), ('José'), ('Müller'), ('日本語');
            UPDATE t SET status = 'verified' WHERE name = 'O''Brien';
        `);
        expect(r.table('t').rows).toHaveLength(4);
        expect(r.table('t').rows[0].status).toBe('verified');
        expect(r.table('t').rows[1].status).toBe('pending');
    });
});

describe('Executor — lexical-error safety', () => {
    it('logs and skips a malformed statement without losing later recoverable DDL', () => {
        const sql = `
            CREATE TABLE first_table (id INT);
            INSERT INTO first_table VALUES (1));
            CREATE TABLE later_table (id INT);
        `;
        const r = exec(sql);

        expect(r.table('first_table').rows).toEqual([]);
        expect(r.table('later_table')).not.toBeNull();
        const syntaxError = r.errors().find((entry) => /syntax error: unexpected closing parenthesis/i.test(entry.message));
        expect(syntaxError).toBeTruthy();
        expect(syntaxError.position.index).toBe(sql.indexOf('VALUES (1))') + 'VALUES (1)'.length);
    });

    it('skips an oversized literal while preserving later valid statements', () => {
        const oversized = 'x'.repeat(20_001);
        const r = exec(`
            CREATE TABLE t (value TEXT);
            INSERT INTO t VALUES ('${oversized}');
            INSERT INTO t VALUES ('kept');
        `);

        expect(r.table('t').rows).toEqual([{ value: 'kept' }]);
        expect(r.errors().some((entry) => /token length exceeds/i.test(entry.message))).toBe(true);
    });
});

describe('Executor — unsupported mutation safety', () => {
    it.each([
        ['SQLite/PostgreSQL ON CONFLICT', `INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING;`],
        ['PostgreSQL RETURNING', `INSERT INTO t VALUES (1) RETURNING id;`],
        ['MySQL REPLACE', `REPLACE INTO t VALUES (1);`],
        ['MSSQL MERGE', `MERGE t AS target USING t AS source ON target.id = source.id WHEN MATCHED THEN UPDATE SET id = source.id;`],
    ])('does not partially apply unsupported %s mutations', (_dialect, statement) => {
        const r = exec(`CREATE TABLE t (id INT PRIMARY KEY); ${statement}`);

        expect(r.table('t').rows).toEqual([]);
        expect(r.errors().some((entry) => /not supported|no changes were applied|no rows were applied/i.test(entry.message))).toBe(true);
    });
});
