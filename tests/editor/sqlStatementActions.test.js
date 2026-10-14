/** Protects statement-level editor actions and SQL source transformations. */
import { describe, expect, it } from 'vitest';
import { extractStatementsByType, isMovableStatementType } from '@/features/editor/lib/sqlStatementActions';

describe('SQL statement actions', () => {
    it('extracts INSERT statements with attached comments and semicolons inside quoted values', () => {
        const sql = [
            'CREATE TABLE users (id INT, note TEXT);',
            '',
            '-- seed users',
            "INSERT INTO users (id, note) VALUES (1, 'semi; inside');",
            '',
            '/* audit seed */',
            "INSERT INTO audit_logs (body) VALUES ($tag$semi; inside dollar quote$tag$);",
            '',
            "UPDATE users SET note = 'kept' WHERE id = 1;",
            '',
            'CREATE INDEX idx_users_id ON users (id);',
        ].join('\n');

        const result = extractStatementsByType(sql, 'INSERT INTO');

        expect(result).toMatchObject({ success: true, matchedCount: 2 });
        expect(result.extractedSql).toBe(
            [
                '-- seed users',
                "INSERT INTO users (id, note) VALUES (1, 'semi; inside');",
                '',
                '/* audit seed */',
                "INSERT INTO audit_logs (body) VALUES ($tag$semi; inside dollar quote$tag$);",
            ].join('\n'),
        );
        expect(result.remainingSql).toBe(["CREATE TABLE users (id INT, note TEXT);", '', "UPDATE users SET note = 'kept' WHERE id = 1;", '', 'CREATE INDEX idx_users_id ON users (id);'].join('\n'));
    });

    it('does not split a MySQL escaped quote string while moving INSERT statements', () => {
        const sql = ["CREATE TABLE messages (body TEXT);", "INSERT INTO messages (body) VALUES ('it\\'s; still one statement');"].join('\n');

        const result = extractStatementsByType(sql, 'INSERT');

        expect(result).toMatchObject({ success: true, matchedCount: 1 });
        expect(result.extractedSql).toBe("INSERT INTO messages (body) VALUES ('it\\'s; still one statement');");
        expect(result.remainingSql).toBe('CREATE TABLE messages (body TEXT);');
    });

    it('can move all DML statements while keeping schema statements in place', () => {
        const sql = [
            'CREATE TABLE users (id INT, name TEXT);',
            'INSERT INTO users (id, name) VALUES (1, \'Ada\');',
            "UPDATE users SET name = 'Ada Lovelace' WHERE id = 1;",
            'DELETE FROM users WHERE id = 2;',
            'CREATE INDEX idx_users_name ON users (name);',
        ].join('\n');

        const result = extractStatementsByType(sql, 'DML');

        expect(result).toMatchObject({ success: true, matchedCount: 3 });
        expect(result.extractedSql).toBe(
            ["INSERT INTO users (id, name) VALUES (1, 'Ada');", "UPDATE users SET name = 'Ada Lovelace' WHERE id = 1;", 'DELETE FROM users WHERE id = 2;'].join('\n\n'),
        );
        expect(result.remainingSql).toBe(['CREATE TABLE users (id INT, name TEXT);', 'CREATE INDEX idx_users_name ON users (name);'].join('\n'));
    });

    it('moves a matching final statement even when it has no trailing semicolon', () => {
        const sql = ['CREATE TABLE users (id INT);', 'INSERT INTO users (id) VALUES (1)'].join('\n');

        const result = extractStatementsByType(sql, 'INSERT');

        expect(result).toMatchObject({ success: true, matchedCount: 1 });
        expect(result.extractedSql).toBe('INSERT INTO users (id) VALUES (1)');
        expect(result.remainingSql).toBe('CREATE TABLE users (id INT);');
    });

    it('rejects unsupported statement families', () => {
        expect(isMovableStatementType('SELECT')).toBe(false);
        expect(extractStatementsByType('SELECT 1;', 'SELECT')).toMatchObject({
            success: false,
            matchedCount: 0,
            extractedSql: '',
            remainingSql: 'SELECT 1;',
        });
    });
});
