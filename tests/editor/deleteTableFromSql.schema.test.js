/** Protects table deletion across qualified names, dependencies, and schema syntax. */
import { describe, expect, it, vi } from 'vitest';
import { deleteTableFromSql, getTableDeletionInfo } from '@/lib/deleteTableFromSql';

describe('deleteTableFromSql schema-aware table names', () => {
    it('resolves a public-qualified ERD label back to an unqualified CREATE TABLE', () => {
        const sql = [
            'CREATE TABLE users (id INT PRIMARY KEY);',
            'CREATE TABLE orders (',
            '  id INT PRIMARY KEY,',
            '  user_id INT REFERENCES users(id)',
            ');',
        ].join('\n');

        const info = getTableDeletionInfo(sql, 'public.users');
        const nextSql = deleteTableFromSql(sql, 'public.users', { preserveReferencingColumns: true });

        expect(info.items.map((item) => item.type)).toEqual(['table', 'foreign_key_columns']);
        expect(nextSql).not.toContain('CREATE TABLE users');
        expect(nextSql).toContain('CREATE TABLE orders');
        expect(nextSql).toContain('user_id INT');
        expect(nextSql).not.toContain('REFERENCES users');
    });

    it('uses same-schema display names to delete schema-qualified source tables', () => {
        const sql = [
            'CREATE TABLE operations.users (id INT PRIMARY KEY);',
            'CREATE TABLE operations.orders (',
            '  id INT PRIMARY KEY,',
            '  user_id INT REFERENCES operations.users(id)',
            ');',
        ].join('\n');

        const nextSql = deleteTableFromSql(sql, 'users', { preserveReferencingColumns: true });

        expect(nextSql).not.toContain('CREATE TABLE operations.users');
        expect(nextSql).toContain('CREATE TABLE operations.orders');
        expect(nextSql).toContain('user_id INT');
        expect(nextSql).not.toContain('REFERENCES operations.users');
    });

    it('keeps public and custom tables separate when display names are qualified', () => {
        const sql = [
            'CREATE TABLE users (id INT PRIMARY KEY);',
            'CREATE TABLE custom.users (id INT PRIMARY KEY);',
            'CREATE TABLE orders (',
            '  id INT PRIMARY KEY,',
            '  user_id INT REFERENCES users(id),',
            '  custom_user_id INT REFERENCES custom.users(id)',
            ');',
        ].join('\n');

        const nextSql = deleteTableFromSql(sql, 'public.users', { preserveReferencingColumns: true });

        expect(nextSql).not.toContain('CREATE TABLE users (id INT PRIMARY KEY);');
        expect(nextSql).toContain('CREATE TABLE custom.users');
        expect(nextSql).toContain('custom_user_id INT REFERENCES custom.users(id)');
        expect(nextSql).toContain('user_id INT');
        expect(nextSql).not.toContain('user_id INT REFERENCES users(id)');
    });

    it('cleans unique cross-tab references for an unqualified display name', () => {
        const sql = [
            'CREATE TABLE operations.orders (',
            '  id INT PRIMARY KEY,',
            '  user_id INT REFERENCES operations.users(id)',
            ');',
        ].join('\n');

        const info = getTableDeletionInfo(sql, 'users');
        const nextSql = deleteTableFromSql(sql, 'users', {
            removeReferencesWhenTargetMissing: true,
            preserveReferencingColumns: true,
        });

        expect(info.items.map((item) => item.type)).toEqual(['foreign_key_columns']);
        expect(nextSql).toContain('CREATE TABLE operations.orders');
        expect(nextSql).toContain('user_id INT');
        expect(nextSql).not.toContain('REFERENCES operations.users');
    });

    it('does not guess an unqualified cross-tab target when references are ambiguous', () => {
        const sql = [
            'CREATE TABLE audit.events (',
            '  id INT PRIMARY KEY,',
            '  actor_id INT REFERENCES operations.users(id),',
            '  reviewer_id INT REFERENCES custom.users(id)',
            ');',
        ].join('\n');

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let nextSql;
        try {
            nextSql = deleteTableFromSql(sql, 'users', {
                removeReferencesWhenTargetMissing: true,
                preserveReferencingColumns: true,
            });
        } finally {
            warn.mockRestore();
        }

        expect(nextSql).toBe(sql);
    });

    it('separates quoted dotted table labels from schema-qualified labels', () => {
        const sql = [
            'CREATE TABLE "tenant.users" (id INT PRIMARY KEY);',
            'CREATE TABLE tenant.users (id INT PRIMARY KEY);',
            'CREATE TABLE tenant.sessions (',
            '  id INT PRIMARY KEY,',
            '  user_id INT REFERENCES tenant.users(id),',
            '  literal_user_id INT REFERENCES "tenant.users"(id)',
            ');',
        ].join('\n');

        const nextSql = deleteTableFromSql(sql, '"tenant.users"', { preserveReferencingColumns: true });

        expect(nextSql).not.toContain('CREATE TABLE "tenant.users"');
        expect(nextSql).toContain('CREATE TABLE tenant.users');
        expect(nextSql).toContain('user_id INT REFERENCES tenant.users(id)');
        expect(nextSql).toContain('literal_user_id INT');
        expect(nextSql).not.toContain('literal_user_id INT REFERENCES "tenant.users"(id)');
    });

    it('deletes schema-qualified labels without touching quoted dotted literal tables', () => {
        const sql = [
            'CREATE TABLE "tenant.users" (id INT PRIMARY KEY);',
            'CREATE TABLE tenant.users (id INT PRIMARY KEY);',
            'CREATE TABLE tenant.sessions (',
            '  id INT PRIMARY KEY,',
            '  user_id INT REFERENCES tenant.users(id),',
            '  literal_user_id INT REFERENCES "tenant.users"(id)',
            ');',
        ].join('\n');

        const nextSql = deleteTableFromSql(sql, 'tenant.users', { preserveReferencingColumns: true });

        expect(nextSql).toContain('CREATE TABLE "tenant.users"');
        expect(nextSql).not.toContain('CREATE TABLE tenant.users (id INT PRIMARY KEY);');
        expect(nextSql).toContain('literal_user_id INT REFERENCES "tenant.users"(id)');
        expect(nextSql).toContain('user_id INT');
        expect(nextSql).not.toContain('user_id INT REFERENCES tenant.users(id)');
    });

    it('does not delete a three-part table when the target is public schema', () => {
        const sql = 'CREATE TABLE mydb.public.users (id INT PRIMARY KEY);';

        expect(deleteTableFromSql(sql, 'public.users')).toBe(sql);
        expect(getTableDeletionInfo(sql, 'public.users').items).toEqual([]);
    });

    it('cleans cross-tab references to a quoted dotted table label', () => {
        const sql = [
            'CREATE TABLE tenant.sessions (',
            '  id INT PRIMARY KEY,',
            '  literal_user_id INT REFERENCES "tenant.users"(id)',
            ');',
        ].join('\n');

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let nextSql;
        try {
            nextSql = deleteTableFromSql(sql, '"tenant.users"', {
                removeReferencesWhenTargetMissing: true,
                preserveReferencingColumns: true,
            });
        } finally {
            warn.mockRestore();
        }

        expect(nextSql).toContain('CREATE TABLE tenant.sessions');
        expect(nextSql).toContain('literal_user_id INT');
        expect(nextSql).not.toContain('REFERENCES "tenant.users"');
    });

    it('cleans cross-tab schema-qualified references without touching quoted dotted references', () => {
        const sql = [
            'CREATE TABLE tenant.sessions (',
            '  id INT PRIMARY KEY,',
            '  user_id INT REFERENCES tenant.users(id),',
            '  literal_user_id INT REFERENCES "tenant.users"(id)',
            ');',
        ].join('\n');

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let nextSql;
        try {
            nextSql = deleteTableFromSql(sql, 'tenant.users', {
                removeReferencesWhenTargetMissing: true,
                preserveReferencingColumns: true,
            });
        } finally {
            warn.mockRestore();
        }

        expect(nextSql).toContain('CREATE TABLE tenant.sessions');
        expect(nextSql).toContain('user_id INT');
        expect(nextSql).not.toContain('user_id INT REFERENCES tenant.users(id)');
        expect(nextSql).toContain('literal_user_id INT REFERENCES "tenant.users"(id)');
    });

    it('preserves a quoted dotted table name when regenerating that table', () => {
        const sql = [
            'CREATE TABLE tenant.users (id INT PRIMARY KEY);',
            'CREATE TABLE "tenant.sessions" (',
            '  id INT PRIMARY KEY,',
            '  user_id INT REFERENCES tenant.users(id)',
            ');',
        ].join('\n');

        const nextSql = deleteTableFromSql(sql, 'tenant.users', { preserveReferencingColumns: true });

        expect(nextSql).toContain('CREATE TABLE "tenant.sessions"');
        expect(nextSql).toContain('user_id INT');
        expect(nextSql).not.toContain('CREATE TABLE tenant.sessions');
        expect(nextSql).not.toContain('REFERENCES tenant.users');
    });

    it('preserves quoted dotted table-level FK targets while removing another table-level FK', () => {
        const sql = [
            'CREATE TABLE "tenant.users" (id INT PRIMARY KEY);',
            'CREATE TABLE tenant.users (id INT PRIMARY KEY);',
            'CREATE TABLE tenant.sessions (',
            '  id INT PRIMARY KEY,',
            '  user_id INT,',
            '  literal_user_id INT,',
            '  FOREIGN KEY (user_id) REFERENCES tenant.users(id),',
            '  FOREIGN KEY (literal_user_id) REFERENCES "tenant.users"(id)',
            ');',
        ].join('\n');

        const nextSql = deleteTableFromSql(sql, 'tenant.users', { preserveReferencingColumns: true });

        expect(nextSql).toContain('literal_user_id INT');
        expect(nextSql).toContain('FOREIGN KEY (literal_user_id)');
        expect(nextSql).toContain('REFERENCES "tenant.users"(id)');
        expect(nextSql).not.toContain('FOREIGN KEY (user_id)');
        expect(nextSql).not.toContain('REFERENCES tenant.users(id)');
    });
});
