import { describe, expect, it } from 'vitest';
import { detectSqlDialectProfile, getSqlDialectProfile, normalizeSqlDialect } from '@/lib/sqlDialectProfiles.js';
import { createSqlExecutor } from '@/features/data-view/lib/sqlExecutor.js';

function table(result, name) {
    return Array.from(result.tables.values()).find((entry) => entry.name.toLowerCase() === name.toLowerCase());
}

describe('SQL dialect profiles', () => {
    it('normalizes user-facing database aliases to stable profile ids', () => {
        expect(normalizeSqlDialect('PostgreSQL')).toBe('postgres');
        expect(normalizeSqlDialect('sql-server')).toBe('mssql');
        expect(normalizeSqlDialect('sqlite3')).toBe('sqlite');
        expect(normalizeSqlDialect('unknown-engine')).toBe('auto');
        expect(getSqlDialectProfile('mysql')).toMatchObject({
            id: 'mysql',
            identifierQuote: 'backtick',
            implicitIntegerPrimaryKey: false,
        });
        expect(detectSqlDialectProfile('CREATE TABLE t (id INTEGER PRIMARY KEY) STRICT;')).toMatchObject({
            profile: { id: 'sqlite' },
            confidence: 'high',
        });
        expect(detectSqlDialectProfile('CREATE TABLE t (id INTEGER PRIMARY KEY);')).toMatchObject({
            profile: { id: 'auto' },
            confidence: 'low',
        });
    });

    it('models SQLite INTEGER PRIMARY KEY rowid allocation and reuse only in the SQLite profile', () => {
        const sql = `
            CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT) STRICT;
            INSERT INTO items (label) VALUES ('first'), ('second');
            DELETE FROM items WHERE id = 2;
            INSERT INTO items (label) VALUES ('reused-rowid');
        `;

        const sqliteResult = createSqlExecutor({ dialect: 'sqlite' }).execute(sql);
        const sqliteItems = table(sqliteResult, 'items');
        expect(sqliteItems).toMatchObject({ dialect: 'sqlite', strict: true, withoutRowid: false });
        expect(sqliteItems.rows).toEqual([
            { id: 1, label: 'first' },
            { id: 2, label: 'reused-rowid' },
        ]);

        const postgresResult = createSqlExecutor({ dialect: 'postgres' }).execute(sql);
        // The SQLite-only declaration does not imply PostgreSQL identity
        // semantics; a PRIMARY KEY cannot receive NULL, so the statement is
        // rejected instead of previewing an impossible row.
        expect(postgresResult.log.some((entry) => entry.type === 'error' && /NOT NULL.*id/.test(entry.message))).toBe(true);
        expect(table(postgresResult, 'items').rows).toEqual([]);
    });

    it('does not synthesize a rowid for SQLite WITHOUT ROWID tables', () => {
        const result = createSqlExecutor({ dialect: 'sqlite' }).execute(`
            CREATE TABLE settings (id INTEGER PRIMARY KEY, value TEXT) WITHOUT ROWID;
            INSERT INTO settings (value) VALUES ('no implicit rowid');
        `);
        const settings = table(result, 'settings');
        expect(settings).toMatchObject({ dialect: 'sqlite', withoutRowid: true });
        expect(result.log.some((entry) => entry.type === 'error' && /NOT NULL.*id/.test(entry.message))).toBe(true);
        expect(settings.rows).toEqual([]);
    });

    it('uses a strong SQLite marker to select the profile automatically without guessing portable SQL', () => {
        const sqliteResult = createSqlExecutor().execute(`
            CREATE TABLE detected_items (id INTEGER PRIMARY KEY, label TEXT) STRICT;
            INSERT INTO detected_items (label) VALUES ('auto-detected');
        `);
        expect(table(sqliteResult, 'detected_items')).toMatchObject({ dialect: 'sqlite' });
        expect(table(sqliteResult, 'detected_items').rows).toEqual([{ id: 1, label: 'auto-detected' }]);

        const portableResult = createSqlExecutor().execute(`
            CREATE TABLE portable_items (id INTEGER PRIMARY KEY, label TEXT);
            INSERT INTO portable_items (label) VALUES ('neutral');
        `);
        expect(table(portableResult, 'portable_items')).toMatchObject({ dialect: 'auto' });
        expect(portableResult.log.some((entry) => entry.type === 'error' && /NOT NULL.*id/.test(entry.message))).toBe(true);
        expect(table(portableResult, 'portable_items').rows).toEqual([]);
    });

    it.each([
        ['PostgreSQL', 'CREATE TABLE records (id BIGSERIAL PRIMARY KEY);', 'postgres'],
        ['MySQL', 'CREATE TABLE `records` (id BIGINT AUTO_INCREMENT PRIMARY KEY);', 'mysql'],
        ['SQL Server', 'CREATE TABLE [records] (id INT IDENTITY(1, 1) PRIMARY KEY);', 'mssql'],
        ['SQLite', 'PRAGMA foreign_keys = ON; CREATE TABLE records (id INTEGER PRIMARY KEY) STRICT;', 'sqlite'],
    ])('detects %s only from a strong native marker', (_label, sql, expectedDialect) => {
        expect(detectSqlDialectProfile(sql)).toMatchObject({
            profile: { id: expectedDialect },
            confidence: 'high',
        });
    });

    it('ignores dialect-shaped comments and literals when auto-detecting', () => {
        expect(detectSqlDialectProfile(`
            -- AUTO_INCREMENT, IDENTITY(1,1), and STRICT are documentation here.
            CREATE TABLE notes (id INTEGER PRIMARY KEY, note TEXT DEFAULT 'PRAGMA foreign_keys = ON');
        `)).toMatchObject({ profile: { id: 'auto' }, confidence: 'low' });

        const result = createSqlExecutor().execute(`
            /* SQLite STRICT is discussed in this comment only. */
            CREATE TABLE notes (id INTEGER PRIMARY KEY, note TEXT DEFAULT 'AUTOINCREMENT');
            INSERT INTO notes (note) VALUES ('IDENTITY(1,1)');
        `);
        expect(table(result, 'notes')).toMatchObject({ dialect: 'auto' });
        expect(result.log.some((entry) => entry.type === 'error' && /NOT NULL.*id/.test(entry.message))).toBe(true);
        expect(table(result, 'notes').rows).toEqual([]);
    });

    it('falls back to neutral mode for genuinely mixed strong dialect markers', () => {
        expect(detectSqlDialectProfile(`
            CREATE TABLE \`mysql_records\` (id BIGINT AUTO_INCREMENT PRIMARY KEY);
            CREATE TABLE [sql_server_records] (id INT IDENTITY(1, 1) PRIMARY KEY);
        `)).toMatchObject({ profile: { id: 'auto' }, confidence: 'low' });
    });

    it('keeps an auto-detected profile across later statements that have no dialect marker', () => {
        const executor = createSqlExecutor();
        executor.execute('CREATE TABLE session_items (id INTEGER PRIMARY KEY, label TEXT) STRICT;');
        const result = executor.execute("INSERT INTO session_items (label) VALUES ('second execution');");
        expect(table(result, 'session_items')).toMatchObject({ dialect: 'sqlite' });
        expect(table(result, 'session_items').rows).toEqual([{ id: 1, label: 'second execution' }]);
    });

    it('stays neutral for malformed SQL and ignores nested-comment markers', () => {
        expect(detectSqlDialectProfile("CREATE TABLE broken (note TEXT DEFAULT 'AUTO_INCREMENT")).toMatchObject({
            profile: { id: 'auto' },
            confidence: 'low',
        });
        expect(detectSqlDialectProfile(`
            /* outer comment: /* AUTO_INCREMENT and IDENTITY(1,1) */ still comment */
            CREATE TABLE neutral (id INTEGER PRIMARY KEY);
        `)).toMatchObject({
            profile: { id: 'auto' },
            confidence: 'low',
        });
    });

    it('detects SQLite correctly from a BOM/CRLF export', () => {
        const result = createSqlExecutor().execute('\uFEFFPRAGMA foreign_keys = ON;\r\nCREATE TABLE windows_items (id INTEGER PRIMARY KEY, label TEXT) STRICT;\r\nINSERT INTO windows_items (label) VALUES (\'BOM-safe\');');
        expect(table(result, 'windows_items')).toMatchObject({ dialect: 'sqlite', strict: true });
        expect(table(result, 'windows_items').rows).toEqual([{ id: 1, label: 'BOM-safe' }]);
    });

    it.each([
        ['postgres', 'CREATE TABLE records (id BIGSERIAL PRIMARY KEY, label TEXT);', [1, 2]],
        ['mysql', 'CREATE TABLE records (id BIGINT AUTO_INCREMENT PRIMARY KEY, label TEXT);', [1, 2]],
        ['mssql', 'CREATE TABLE records (id BIGINT IDENTITY(7, 3) PRIMARY KEY, label TEXT);', [7, 10]],
        ['sqlite', 'CREATE TABLE records (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT);', [1, 2]],
    ])('%s profile preserves explicit identity syntax', (dialect, ddl, expectedIds) => {
        const result = createSqlExecutor({ dialect }).execute(`
            ${ddl}
            INSERT INTO records (label) VALUES ('one'), ('two');
        `);
        expect(result.log.filter((entry) => entry.type === 'error')).toEqual([]);
        expect(table(result, 'records').rows.map((row) => row.id)).toEqual(expectedIds);
    });
});
