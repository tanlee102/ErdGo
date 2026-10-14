/** Protects additional renderer-shape and dialect-conversion contracts. */
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

describe('SQL-to-ERD additional contracts', () => {
    it('applies ALTER-added constraints into renderer-facing columns and relations', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent_accounts (
                tenant_id INT,
                account_code TEXT,
                name TEXT
            );
            CREATE TABLE child_contacts (
                tenant_id INT,
                account_code TEXT,
                contact_kind TEXT,
                note TEXT
            );
            ALTER TABLE parent_accounts
                ADD CONSTRAINT pk_parent_accounts PRIMARY KEY (tenant_id, account_code);
            ALTER TABLE child_contacts
                ADD CONSTRAINT fk_child_contacts_parent
                FOREIGN KEY (tenant_id, account_code)
                REFERENCES parent_accounts (tenant_id, account_code);
            ALTER TABLE child_contacts
                ADD CONSTRAINT uq_child_contacts_kind UNIQUE (tenant_id, contact_kind);
            ALTER TABLE child_contacts
                ADD CONSTRAINT chk_child_contacts_kind CHECK (contact_kind IN ('billing', 'technical'));
            CREATE INDEX idx_child_contacts_note ON child_contacts (note);
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(column(schema, 'parent_accounts', 'tenant_id')).toMatchObject({
            pk: true,
            compositePk: true,
            constraints: ['PK'],
        });
        expect(column(schema, 'child_contacts', 'tenant_id')).toMatchObject({
            fk: true,
            compositeUq: true,
        });
        expect(column(schema, 'child_contacts', 'contact_kind').constraints).toContain('UQ');
        expect(column(schema, 'child_contacts', 'contact_kind').extras).toEqual([
            "chk_child_contacts_kind: CHECK (contact_kind IN ( 'billing' , 'technical' ))",
        ]);
        expect(column(schema, 'child_contacts', 'note').constraints).toContain('IDX');
        expect(schema.relations.map(relationKey)).toEqual([
            'fk_child_contacts_parent:child_contacts.tenant_id->parent_accounts.tenant_id',
            'fk_child_contacts_parent:child_contacts.account_code->parent_accounts.account_code',
        ]);
    });

    it('derives all relation cardinality buckets from FK source uniqueness and nullability', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE users (id INT PRIMARY KEY);
            CREATE TABLE profiles (
                id INT PRIMARY KEY,
                user_id INT NOT NULL UNIQUE REFERENCES users(id)
            );
            CREATE TABLE invitations (
                id INT PRIMARY KEY,
                user_id INT UNIQUE REFERENCES users(id)
            );
            CREATE TABLE posts (
                id INT PRIMARY KEY,
                user_id INT NOT NULL REFERENCES users(id)
            );
            CREATE TABLE drafts (
                id INT PRIMARY KEY,
                user_id INT REFERENCES users(id)
            );
        `);

        const cards = Object.fromEntries(schema.relations.map((relation) => [relation.from.table, [relation.fromCard, relation.toCard]]));

        expect(cards).toEqual({
            profiles: ['0..1', '1'],
            invitations: ['0..1', '0..1'],
            posts: ['0..n', '1'],
            drafts: ['0..n', '0..1'],
        });
    });

    it('deduplicates duplicate inline and ALTER foreign keys while preserving the named FK', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE users (id INT PRIMARY KEY);
            CREATE TABLE posts (
                id INT PRIMARY KEY,
                user_id INT REFERENCES users(id)
            );
            ALTER TABLE posts
                ADD CONSTRAINT fk_posts_user
                FOREIGN KEY (user_id) REFERENCES users(id);
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.relations).toHaveLength(1);
        expect(schema.relations[0]).toMatchObject({
            fkName: 'fk_posts_user',
            from: { table: 'posts', column: 'user_id' },
            to: { table: 'users', column: 'id' },
        });
    });

    it('normalizes schema-qualified user-defined types for renderer enum/composite lookup', () => {
        const schema = sqlToErdSchema(`
            CREATE TYPE crm.address AS (street TEXT, city TEXT);
            CREATE TYPE crm.lead_state AS ENUM ('new', 'qualified', 'lost');
            CREATE TABLE crm.leads (
                id BIGSERIAL PRIMARY KEY,
                state crm.lead_state NOT NULL DEFAULT 'new',
                ship_to crm.address
            );
        `);

        expect(schema.enums).toEqual([{ name: 'lead_state', values: ['new', 'qualified', 'lost'] }]);
        expect(schema.composites).toEqual([
            {
                name: 'address',
                fields: [
                    { name: 'street', type: 'TEXT' },
                    { name: 'city', type: 'TEXT' },
                ],
            },
        ]);
        expect(table(schema, 'leads').columns.map((entry) => [entry.name, entry.type])).toEqual([
            ['id', 'BIGSERIAL'],
            ['state', 'lead_state'],
            ['ship_to', 'address'],
        ]);
    });

    it('validates and drops dangling foreign keys while keeping valid same-script relations', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE users (id INT PRIMARY KEY);
            CREATE TABLE posts (
                id INT PRIMARY KEY,
                user_id INT REFERENCES users(id),
                missing_id INT REFERENCES missing_users(id)
            );
        `);

        expect(schema.relations.map(relationKey)).toEqual(['posts.user_id->users.id']);
        expect(schema._parseErrors).toHaveLength(2);
        expect(schema._parseErrors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'warning',
                    message: expect.stringContaining("Column 'missing_id' references table 'missing_users'"),
                }),
                expect.objectContaining({
                    severity: 'warning',
                    kind: 'relation_dropped_unknown_table',
                    message: expect.stringContaining('posts.missing_id'),
                }),
            ]),
        );
    });

    it('materializes ALTER ADD COLUMN in the ERD bridge and still applies later constraints to existing columns', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE projects (
                id INT PRIMARY KEY,
                owner_id INT
            );
            CREATE TABLE users (id INT PRIMARY KEY);
            ALTER TABLE projects ADD COLUMN transient_note TEXT;
            ALTER TABLE projects
                ADD CONSTRAINT fk_projects_owner
                FOREIGN KEY (owner_id) REFERENCES users(id);
        `);

        expect(table(schema, 'projects').columns.map((entry) => entry.name)).toEqual(['id', 'owner_id', 'transient_note']);
        expect(column(schema, 'projects', 'transient_note')).toMatchObject({
            name: 'transient_note',
            type: 'TEXT',
        });
        expect(column(schema, 'projects', 'owner_id').fk).toBe(true);
        expect(schema.relations.map(relationKey)).toEqual(['fk_projects_owner:projects.owner_id->users.id']);
    });
});
