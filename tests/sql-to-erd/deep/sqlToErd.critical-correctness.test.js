/** Locks critical relation, identifier, and constraint conversion semantics. */
import { describe, expect, it } from 'vitest';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

function table(schema, name) {
    return schema.tables.find((entry) => entry.name === name);
}

function column(schema, tableName, columnName) {
    return table(schema, tableName)?.columns.find((entry) => entry.name === columnName);
}

function relationKey(relation) {
    const prefix = relation.fkName ? `${relation.fkName}:` : '';
    return `${prefix}${relation.from.table}.${relation.from.column}->${relation.to.table}.${relation.to.column}`;
}

describe('SQL-to-ERD critical correctness regressions', () => {
    it('requires exact composite unique-set matching before treating a composite FK source as one-to-one', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE accounts (
                tenant_id INT NOT NULL,
                account_no TEXT NOT NULL,
                PRIMARY KEY (tenant_id, account_no)
            );
            CREATE TABLE account_aliases (
                tenant_id INT NOT NULL,
                account_no TEXT NOT NULL,
                alias TEXT NOT NULL,
                UNIQUE (tenant_id, account_no, alias),
                FOREIGN KEY (tenant_id, account_no) REFERENCES accounts
            );
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.relations.map(relationKey)).toEqual([
            'account_aliases.tenant_id->accounts.tenant_id',
            'account_aliases.account_no->accounts.account_no',
        ]);
        expect(schema.relations.map((relation) => relation.fromCard)).toEqual(['0..n', '0..n']);
        expect(schema.relations.map((relation) => relation.toCard)).toEqual(['1', '1']);
        expect(schema.relations[0]).toMatchObject({
            composite: true,
            fromColumns: ['tenant_id', 'account_no'],
            toColumns: ['tenant_id', 'account_no'],
        });
        expect(schema.relations[0].relationGroup).toBe(schema.relations[1].relationGroup);
    });

    it('deduplicates restated foreign keys while merging the named ALTER action metadata', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (
                id INT PRIMARY KEY
            );
            CREATE TABLE child (
                parent_id INT REFERENCES parent(id)
            );
            ALTER TABLE child
                ADD CONSTRAINT fk_child_parent
                FOREIGN KEY (parent_id) REFERENCES parent(id)
                ON DELETE CASCADE
                ON UPDATE RESTRICT;
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.relations).toHaveLength(1);
        expect(schema.relations[0]).toMatchObject({
            fkName: 'fk_child_parent',
            from: { table: 'child', column: 'parent_id' },
            to: { table: 'parent', column: 'id' },
            actions: {
                onDelete: 'CASCADE',
                onUpdate: 'RESTRICT',
            },
        });
    });

    it('keeps unique-index metadata valid when the indexed column is renamed before later FK validation', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE users (
                id INT PRIMARY KEY,
                email TEXT NOT NULL
            );
            CREATE UNIQUE INDEX ux_users_email ON users(email);
            ALTER TABLE users RENAME COLUMN email TO contact_email;
            CREATE TABLE login_events (
                contact_email TEXT REFERENCES users(contact_email)
            );
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(column(schema, 'users', 'contact_email')).toMatchObject({
            name: 'contact_email',
            constraints: ['NN', 'UQ'],
        });
        expect(column(schema, 'users', 'email')).toBeUndefined();
        expect(schema.relations.map(relationKey)).toEqual(['login_events.contact_email->users.contact_email']);
    });

    it('rewrites source-side FK columns when the child column is renamed after the relation is declared', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE users (
                id INT PRIMARY KEY
            );
            CREATE TABLE posts (
                old_user_id INT REFERENCES users(id)
            );
            ALTER TABLE posts RENAME COLUMN old_user_id TO user_id;
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(table(schema, 'posts').columns.map((entry) => entry.name)).toEqual(['user_id']);
        expect(schema.relations.map(relationKey)).toEqual(['posts.user_id->users.id']);
    });

    it('removes relation metadata when a source FK column is dropped after being declared', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE users (
                id INT PRIMARY KEY
            );
            CREATE TABLE posts (
                user_id INT REFERENCES users(id),
                title TEXT
            );
            ALTER TABLE posts DROP COLUMN user_id;
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(table(schema, 'posts').columns.map((entry) => entry.name)).toEqual(['title']);
        expect(schema.relations).toEqual([]);
    });

    it('warns instead of guessing when an implicit FK points at a composite primary key with the wrong source column count', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE accounts (
                tenant_id INT NOT NULL,
                account_no TEXT NOT NULL,
                PRIMARY KEY (tenant_id, account_no)
            );
            CREATE TABLE contacts (
                account_no TEXT REFERENCES accounts
            );
        `);

        expect(schema.relations).toEqual([]);
        expect(schema._parseErrors).toEqual([
            expect.objectContaining({
                kind: 'relation_dropped_column_count_mismatch',
                severity: 'warning',
                message: expect.stringContaining("contacts(account_no)' references 'accounts(tenant_id, account_no)"),
                position: expect.objectContaining({
                    line: 8,
                    index: expect.any(Number),
                }),
            }),
        ]);
    });

    it('warns when an implicit FK target table has no primary key to infer', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent_lookup (
                code TEXT
            );
            CREATE TABLE child_rows (
                code TEXT REFERENCES parent_lookup
            );
        `);

        expect(schema.relations).toEqual([]);
        expect(schema._parseErrors).toEqual([
            expect.objectContaining({
                kind: 'relation_dropped_missing_target_columns',
                severity: 'warning',
                message: expect.stringContaining("references table 'parent_lookup' without specifying columns"),
            }),
        ]);
    });

    it('invalidates existing relations when a primary key is dropped after the FK was parsed', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (
                id INT PRIMARY KEY
            );
            CREATE TABLE child (
                parent_id INT REFERENCES parent(id)
            );
            ALTER TABLE parent DROP PRIMARY KEY;
        `);

        expect(column(schema, 'parent', 'id').constraints).not.toContain('PK');
        expect(schema.relations).toEqual([]);
        expect(schema._parseErrors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'relation_dropped_non_unique_target',
                    severity: 'warning',
                    message: expect.stringContaining('not a primary key or unique key'),
                }),
            ]),
        );
    });
});
