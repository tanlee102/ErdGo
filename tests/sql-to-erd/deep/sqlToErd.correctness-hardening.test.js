/** Hardens SQL-to-ERD output against known correctness failure modes. */
import { describe, expect, it } from 'vitest';
import { parseAST } from '@/lib/parse-ast/parseAst.js';
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

describe('sqlToErdSchema correctness hardening', () => {
    it.each(['sqlite', 'postgres'])('%s does not reduce a mixed expression unique index to a unique subset', (dialect) => {
        const sql = 'CREATE TABLE p(id INTEGER, label TEXT); CREATE UNIQUE INDEX mixed_key ON p(id, lower(label)); CREATE TABLE c(parent_id INTEGER REFERENCES p(id));';
        const parsed = parseAST(sql, { dialect });
        expect(parsed.ast.indexes[0]).toMatchObject({ columns: ['id'], expressions: ['lower(label)'], unique: true });
        const schema = sqlToErdSchema(sql, { dialect });
        expect(column(schema, 'p', 'id').constraints).not.toContain('UQ');
        expect(column(schema, 'p', 'id').constraints).toContain('IDX');
        expect(column(schema, 'p', 'id').compositeIdx).toBe(true);
        expect(schema.relations).toEqual([]);
        expect(column(schema, 'c', 'parent_id').fk).not.toBe(true);
        expect(schema._parseErrors).toContainEqual(expect.objectContaining({ kind: 'relation_dropped_non_unique_target' }));
        // An independent complete key remains valid; the expression index must
        // neither invent nor erase guarantees supplied by another constraint.
        const keyed = sqlToErdSchema(sql.replace('id INTEGER,', 'id INTEGER UNIQUE,'), { dialect });
        expect(keyed.relations).toHaveLength(1);
        const dropped = sqlToErdSchema(sql + ' DROP INDEX mixed_key;', { dialect });
        expect(column(dropped, 'p', 'id').constraints).not.toContain('IDX');
    });

    it('resolves omitted REFERENCES column lists to the referenced primary key instead of id', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE countries (
                code TEXT PRIMARY KEY,
                name TEXT NOT NULL
            );
            CREATE TABLE users (
                id INT PRIMARY KEY,
                country_code TEXT REFERENCES countries
            );
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.relations.map(relationKey)).toEqual(['users.country_code->countries.code']);
    });

    it('resolves omitted composite FK target lists to the referenced composite primary key', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE accounts (
                tenant_id INT NOT NULL,
                account_no TEXT NOT NULL,
                PRIMARY KEY (tenant_id, account_no)
            );
            CREATE TABLE contacts (
                tenant_id INT NOT NULL,
                account_no TEXT NOT NULL,
                email TEXT NOT NULL,
                FOREIGN KEY (tenant_id, account_no) REFERENCES accounts
            );
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.relations.map(relationKey)).toEqual([
            'contacts.tenant_id->accounts.tenant_id',
            'contacts.account_no->accounts.account_no',
        ]);
        expect(schema.relations[0]).toMatchObject({
            fromColumns: ['tenant_id', 'account_no'],
            toColumns: ['tenant_id', 'account_no'],
            composite: true,
        });
        expect(schema.relations[0].relationGroup).toBe(schema.relations[1].relationGroup);
    });

    it('resolves omitted ALTER TABLE FK target lists through the referenced primary key', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE countries (
                code TEXT PRIMARY KEY
            );
            CREATE TABLE users (
                id INT PRIMARY KEY,
                country_code TEXT
            );
            ALTER TABLE users
                ADD CONSTRAINT fk_users_country
                FOREIGN KEY (country_code) REFERENCES countries;
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.relations.map(relationKey)).toEqual(['fk_users_country:users.country_code->countries.code']);
    });

    it('resolves omitted composite ALTER TABLE FK target lists through the referenced composite primary key', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE accounts (
                tenant_id INT NOT NULL,
                account_no TEXT NOT NULL,
                PRIMARY KEY (tenant_id, account_no)
            );
            CREATE TABLE contacts (
                tenant_id INT NOT NULL,
                account_no TEXT NOT NULL
            );
            ALTER TABLE contacts
                ADD CONSTRAINT fk_contacts_accounts
                FOREIGN KEY (tenant_id, account_no) REFERENCES accounts;
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.relations.map(relationKey)).toEqual([
            'fk_contacts_accounts:contacts.tenant_id->accounts.tenant_id',
            'fk_contacts_accounts:contacts.account_no->accounts.account_no',
        ]);
        expect(schema.relations[0].relationGroup).toBe(schema.relations[1].relationGroup);
    });

    it('keeps same-leaf tables in different schemas distinct when both appear in one ERD', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE s1.users (id INT PRIMARY KEY);
            CREATE TABLE s2.users (id INT PRIMARY KEY);
            CREATE TABLE posts (
                id INT PRIMARY KEY,
                user_id INT REFERENCES s2.users(id)
            );
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.tables.map((entry) => entry.name)).toEqual(['s1.users', 's2.users', 'public.posts']);
        expect(schema.relations.map(relationKey)).toEqual(['public.posts.user_id->s2.users.id']);
    });

    it('hides a common explicit schema prefix when every table is in that schema', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE operations.transporteurs (id INT PRIMARY KEY);
            CREATE TABLE operations.blabla (
                id INT PRIMARY KEY,
                transporteur_id INT REFERENCES operations.transporteurs(id)
            );
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.tables.map((entry) => entry.name)).toEqual(['transporteurs', 'blabla']);
        expect(schema.relations.map(relationKey)).toEqual(['blabla.transporteur_id->transporteurs.id']);
    });

    it('qualifies every table in mixed schema context and treats bare tables as public', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE public.a (id INT PRIMARY KEY);
            CREATE TABLE custom.b (
                id INT PRIMARY KEY,
                a_id INT REFERENCES public.a(id)
            );
            CREATE TABLE blabla (
                id INT PRIMARY KEY,
                b_id INT REFERENCES custom.b(id)
            );
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.tables.map((entry) => entry.name)).toEqual(['public.a', 'custom.b', 'public.blabla']);
        expect(schema.relations.map(relationKey)).toEqual([
            'custom.b.a_id->public.a.id',
            'public.blabla.b_id->custom.b.id',
        ]);
    });

    it('does not guess an ambiguous unqualified reference when schemas share a leaf name', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE s1.users (id INT PRIMARY KEY);
            CREATE TABLE s2.users (id INT PRIMARY KEY);
            CREATE TABLE posts (
                user_id INT REFERENCES users(id)
            );
        `);

        expect(schema.relations).toEqual([]);
        expect(schema._parseErrors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'relation_dropped_unknown_table',
                    severity: 'warning',
                    message: expect.stringContaining("references table 'users'"),
                }),
            ]),
        );
    });

    it('does not resolve a qualified FK to a different schema just because the leaf name matches', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE s1.users (id INT PRIMARY KEY);
            CREATE TABLE posts (
                user_id INT REFERENCES s2.users(id)
            );
        `);

        expect(schema.relations).toEqual([]);
        expect(schema._parseErrors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'relation_dropped_unknown_table',
                    severity: 'warning',
                    message: expect.stringContaining("references table 's2.users'"),
                }),
            ]),
        );
    });

    it('does not treat dots inside a quoted identifier as schema separators', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE "tenant.users" (
                "id.part" INT PRIMARY KEY
            );
            CREATE TABLE audit (
                subject_id INT REFERENCES "tenant.users"("id.part")
            );
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.tables.map((entry) => entry.name)).toEqual(['"tenant.users"', 'audit']);
        expect(schema.relations.map(relationKey)).toEqual(['audit.subject_id->"tenant.users".id.part']);
    });

    it('keeps explicit schema labels visible beside quoted dotted table names', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE "tenant.users" (
                id INT PRIMARY KEY
            );
            CREATE TABLE app.audit (
                id INT PRIMARY KEY,
                subject_id INT REFERENCES "tenant.users"(id)
            );
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.tables.map((entry) => entry.name)).toEqual(['"tenant.users"', 'app.audit']);
        expect(schema.relations.map(relationKey)).toEqual(['app.audit.subject_id->"tenant.users".id']);
    });

    it('quotes literal dotted table names when they collide with schema-qualified display names', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE "tenant.users" (
                id INT PRIMARY KEY
            );
            CREATE TABLE tenant.users (
                id INT PRIMARY KEY
            );
            CREATE TABLE tenant.sessions (
                id INT PRIMARY KEY,
                user_id INT REFERENCES tenant.users(id),
                literal_user_id INT REFERENCES "tenant.users"(id)
            );
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.tables.map((entry) => entry.name)).toEqual(['"tenant.users"', 'tenant.users', 'tenant.sessions']);
        expect(schema.relations.map(relationKey)).toEqual([
            'tenant.sessions.user_id->tenant.users.id',
            'tenant.sessions.literal_user_id->"tenant.users".id',
        ]);
    });

    it('does not resolve an unquoted schema-qualified FK to a quoted dotted table', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE "tenant.users" (
                id INT PRIMARY KEY
            );
            CREATE TABLE audit (
                subject_id INT REFERENCES tenant.users(id)
            );
        `);

        expect(schema.tables.map((entry) => entry.name)).toEqual(['"tenant.users"', 'audit']);
        expect(schema.relations).toEqual([]);
        expect(schema._parseErrors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'relation_dropped_unknown_table',
                    severity: 'warning',
                    message: expect.stringContaining("references table 'tenant.users'"),
                }),
            ]),
        );
    });

    it('does not resolve a quoted dotted FK to an unquoted schema-qualified table', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE tenant.users (
                id INT PRIMARY KEY
            );
            CREATE TABLE tenant.audit (
                subject_id INT REFERENCES "tenant.users"(id)
            );
        `);

        expect(schema.tables.map((entry) => entry.name)).toEqual(['users', 'audit']);
        expect(schema.relations).toEqual([]);
        expect(schema._parseErrors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'relation_dropped_unknown_table',
                    severity: 'warning',
                    message: expect.stringContaining("references table 'tenant.users'"),
                }),
            ]),
        );
    });

    it('keeps ALTER TABLE replay scoped between quoted dotted and schema-qualified table names', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE "tenant.users" (
                id INT PRIMARY KEY
            );
            CREATE TABLE tenant.users (
                id INT PRIMARY KEY
            );
            ALTER TABLE "tenant.users" ADD COLUMN literal_note TEXT;
            ALTER TABLE tenant.users ADD COLUMN schema_note TEXT;
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.tables.map((entry) => entry.name)).toEqual(['"tenant.users"', 'tenant.users']);
        expect(column(schema, '"tenant.users"', 'literal_note')).toMatchObject({ name: 'literal_note', type: 'TEXT' });
        expect(column(schema, '"tenant.users"', 'schema_note')).toBeUndefined();
        expect(column(schema, 'tenant.users', 'schema_note')).toMatchObject({ name: 'schema_note', type: 'TEXT' });
        expect(column(schema, 'tenant.users', 'literal_note')).toBeUndefined();
    });

    it('keeps schema identity through rename, mixed display names, index replay, and FK validation', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE app.users (
                id INT PRIMARY KEY,
                email TEXT
            );
            ALTER TABLE app.users RENAME TO accounts;
            CREATE UNIQUE INDEX accounts_email_uq ON app.accounts(email);
            CREATE TABLE audit.events (
                id INT PRIMARY KEY,
                actor_email TEXT REFERENCES app.accounts(email)
            );
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.tables.map((entry) => entry.name)).toEqual(['app.accounts', 'audit.events']);
        expect(column(schema, 'app.accounts', 'email').constraints).toContain('UQ');
        expect(schema.relations.map(relationKey)).toEqual(['audit.events.actor_email->app.accounts.email']);
    });

    it('renames quoted dotted tables without colliding with schema-qualified tables of the same display text', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE "tenant.users" (
                id INT PRIMARY KEY
            );
            ALTER TABLE "tenant.users" RENAME TO "tenant.accounts";
            CREATE TABLE tenant.accounts (
                id INT PRIMARY KEY
            );
            CREATE TABLE audit.events (
                id INT PRIMARY KEY,
                literal_account_id INT REFERENCES "tenant.accounts"(id),
                schema_account_id INT REFERENCES tenant.accounts(id)
            );
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.tables.map((entry) => entry.name)).toEqual(['"tenant.accounts"', 'tenant.accounts', 'audit.events']);
        expect(schema.relations.map(relationKey)).toEqual([
            'audit.events.literal_account_id->"tenant.accounts".id',
            'audit.events.schema_account_id->tenant.accounts.id',
        ]);
    });

    it('applies ALTER TABLE ADD COLUMN definitions that affect the ERD', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE users (id INT PRIMARY KEY);
            CREATE TABLE projects (id INT PRIMARY KEY);
            ALTER TABLE projects
                ADD COLUMN owner_id INT NOT NULL REFERENCES users(id);
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(column(schema, 'projects', 'owner_id')).toMatchObject({
            name: 'owner_id',
            type: 'INT',
            fk: true,
            constraints: ['NN'],
        });
        expect(schema.relations.map(relationKey)).toEqual(['projects.owner_id->users.id']);
    });

    it('applies ALTER TABLE ADD COLUMN uniqueness and checks when they affect the ERD', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE projects (id INT PRIMARY KEY);
            ALTER TABLE projects ADD COLUMN slug TEXT UNIQUE NOT NULL CHECK (slug <> 'x-y');
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(column(schema, 'projects', 'slug')).toMatchObject({
            name: 'slug',
            type: 'TEXT',
            constraints: ['UQ', 'NN'],
            extras: ["CHECK (slug <> 'x-y')"],
        });
    });

    it('materializes plain ALTER TABLE ADD COLUMN definitions for migration-style DDL', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE projects (id INT PRIMARY KEY);
            ALTER TABLE projects ADD COLUMN transient_note TEXT;
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(table(schema, 'projects').columns.map((entry) => entry.name)).toEqual(['id', 'transient_note']);
        expect(column(schema, 'projects', 'transient_note')).toMatchObject({
            name: 'transient_note',
            type: 'TEXT',
            constraints: [],
        });
    });

    it('accepts MySQL inline UNIQUE INDEX definitions as unique indexes', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE users (
                id INT PRIMARY KEY,
                email VARCHAR(320) NOT NULL,
                UNIQUE INDEX ux_users_email (email)
            );
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(column(schema, 'users', 'email').constraints).toContain('UQ');
    });

    it('does not collapse different inline ENUM domains that share a column name', () => {
        const parsed = parseAST(`
            CREATE TABLE orders (
                status ENUM('new', 'paid') NOT NULL
            );
            CREATE TABLE tasks (
                status ENUM('todo', 'done') NOT NULL
            );
        `);
        const schema = sqlToErdSchema(`
            CREATE TABLE orders (
                status ENUM('new', 'paid') NOT NULL
            );
            CREATE TABLE tasks (
                status ENUM('todo', 'done') NOT NULL
            );
        `);

        expect(parsed.errors).toEqual([]);
        expect(parsed.ast.types.map((entry) => `${entry.name}:${entry.values.join('|')}`)).toEqual([
            'status_enum:new|paid',
            'tasks_status_enum:todo|done',
        ]);
        expect(schema.enums.map((entry) => `${entry.name}:${entry.values.join('|')}`)).toEqual([
            'status_enum:new|paid',
            'tasks_status_enum:todo|done',
        ]);
        expect(column(schema, 'orders', 'status').type).toBe('status_enum');
        expect(column(schema, 'tasks', 'status').type).toBe('tasks_status_enum');
    });

    it('does not collapse different inline SET domains that share a column name', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE teams (
                flags SET('billing', 'sso') NOT NULL
            );
            CREATE TABLE documents (
                flags SET('read', 'write') NOT NULL
            );
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.enums.map((entry) => `${entry.name}:${entry.values.join('|')}`)).toEqual([
            'flags_set:billing|sso',
            'documents_flags_set:read|write',
        ]);
        expect(column(schema, 'teams', 'flags').type).toBe('flags_set');
        expect(column(schema, 'documents', 'flags').type).toBe('documents_flags_set');
    });

    it('keeps same-leaf CREATE TYPE domains in different schemas distinct', () => {
        const schema = sqlToErdSchema(`
            CREATE TYPE s1.status AS ENUM ('draft', 'active');
            CREATE TYPE s2.status AS ENUM ('queued', 'done');
            CREATE TYPE s1.money AS (amount NUMERIC(12,2), currency CHAR(3));
            CREATE TYPE s2.money AS (cents BIGINT, currency CHAR(3));
            CREATE TABLE s1.items (
                state s1.status,
                price s1.money
            );
            CREATE TABLE s2.items (
                state s2.status,
                price s2.money
            );
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.enums.map((entry) => `${entry.name}:${entry.values.join('|')}`)).toEqual([
            's1.status:draft|active',
            's2.status:queued|done',
        ]);
        expect(schema.composites.map((entry) => `${entry.name}:${entry.fields.map((field) => field.name).join('|')}`)).toEqual([
            's1.money:amount|currency',
            's2.money:cents|currency',
        ]);
        expect(column(schema, 's1.items', 'state').type).toBe('s1.status');
        expect(column(schema, 's1.items', 'price').type).toBe('s1.money');
        expect(column(schema, 's2.items', 'state').type).toBe('s2.status');
        expect(column(schema, 's2.items', 'price').type).toBe('s2.money');
    });

    it('keeps unique schema-qualified CREATE TYPE names simple when there is no leaf collision', () => {
        const schema = sqlToErdSchema(`
            CREATE TYPE public.mood AS ENUM ('happy', 'sad');
            CREATE TABLE users (
                state public.mood,
                history public.mood[]
            );
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.enums).toEqual([{ name: 'mood', values: ['happy', 'sad'] }]);
        expect(column(schema, 'users', 'state').type).toBe('mood');
        expect(column(schema, 'users', 'history').type).toBe('mood[]');
    });

    it('keeps punctuation inside quoted expression literals untouched', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE events (
                created_key TEXT DEFAULT strftime('%Y-%m-%d','now'),
                slug TEXT CHECK (slug <> 'a-b.c')
            );
        `);

        expect(column(schema, 'events', 'created_key').extras).toContain("DEFAULT strftime('%Y-%m-%d', 'now')");
        expect(column(schema, 'events', 'slug').extras).toContain("CHECK (slug <> 'a-b.c')");
    });

    it('keeps punctuation inside quoted generated-column literals untouched', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE events (
                slug TEXT,
                slug_key TEXT GENERATED ALWAYS AS (replace(slug, 'a-b.c', 'x/y:z')) STORED
            );
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(column(schema, 'events', 'slug_key').extras).toContain("GENERATED ALWAYS AS (REPLACE(slug, 'a-b.c', 'x/y:z')) STORED");
    });

    it('computes composite FK cardinality from the whole source column set', () => {
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
                UNIQUE (tenant_id, account_no),
                FOREIGN KEY (tenant_id, account_no) REFERENCES accounts
            );
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.relations).toHaveLength(2);
        expect(schema.relations.map((relation) => relation.fromCard)).toEqual(['0..1', '0..1']);
        expect(schema.relations.map((relation) => relation.toCard)).toEqual(['1', '1']);
        expect(schema.relations[0]).toMatchObject({
            composite: true,
            fromColumns: ['tenant_id', 'account_no'],
            toColumns: ['tenant_id', 'account_no'],
        });
        expect(schema.relations[0].relationGroup).toBe(schema.relations[1].relationGroup);
    });

    it('keeps nullable composite unique FK sources optional as a group', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE accounts (
                tenant_id INT NOT NULL,
                account_no TEXT NOT NULL,
                PRIMARY KEY (tenant_id, account_no)
            );
            CREATE TABLE optional_aliases (
                tenant_id INT,
                account_no TEXT,
                UNIQUE (tenant_id, account_no),
                FOREIGN KEY (tenant_id, account_no) REFERENCES accounts
            );
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.relations.map((relation) => relation.fromCard)).toEqual(['0..1', '0..1']);
        expect(schema.relations.map((relation) => relation.toCard)).toEqual(['0..1', '0..1']);
    });

    it('canonicalizes composite relation metadata after case-insensitive validation', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE Parent (
                TenantID INT NOT NULL,
                AccountNo TEXT NOT NULL,
                PRIMARY KEY (TenantID, AccountNo)
            );
            CREATE TABLE Child (
                tenantid INT NOT NULL,
                accountno TEXT NOT NULL,
                UNIQUE (tenantid, accountno),
                FOREIGN KEY (tenantid, accountno) REFERENCES parent(tenantid, accountno)
            );
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.relations.map((relation) => relation.to.table)).toEqual(['Parent', 'Parent']);
        expect(schema.relations[0].toColumns).toEqual(['TenantID', 'AccountNo']);
        expect(schema.relations[1].toColumns).toEqual(['TenantID', 'AccountNo']);
        expect(schema.relations.map((relation) => relation.fromCard)).toEqual(['0..1', '0..1']);
        expect(schema.relations.map((relation) => relation.toCard)).toEqual(['1', '1']);
    });

    it('drops an invalid composite FK as a whole relationship group', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE accounts (
                tenant_id INT NOT NULL,
                account_no TEXT NOT NULL,
                PRIMARY KEY (tenant_id, account_no)
            );
            CREATE TABLE bad_contacts (
                tenant_id INT NOT NULL,
                account_no TEXT NOT NULL,
                FOREIGN KEY (tenant_id, account_no) REFERENCES accounts(tenant_id, missing_account_no)
            );
        `);

        expect(schema.relations).toEqual([]);
        expect(schema._parseErrors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'relation_dropped_unknown_column',
                    severity: 'warning',
                    message: expect.stringContaining('missing_account_no'),
                }),
            ]),
        );
    });

    it('drops explicit FK targets that are not primary or unique keys', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (
                id INT PRIMARY KEY,
                code TEXT
            );
            CREATE TABLE child (
                code TEXT REFERENCES parent(code)
            );
        `);

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

    it('allows explicit FK targets backed by a unique index', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (
                id INT PRIMARY KEY,
                code TEXT NOT NULL
            );
            CREATE TABLE child (
                code TEXT REFERENCES parent(code)
            );
            CREATE UNIQUE INDEX ux_parent_code ON parent(code);
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.relations.map(relationKey)).toEqual(['child.code->parent.code']);
    });

    it('renders filtered unique indexes as PUQ but does not accept them as global FK targets', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE users (
                id INT PRIMARY KEY,
                email TEXT NOT NULL,
                deleted_at TIMESTAMP
            );
            CREATE UNIQUE INDEX ux_users_active_email
                ON users(email)
                WHERE deleted_at IS NULL;
            CREATE TABLE login_events (
                email TEXT REFERENCES users(email)
            );
        `);

        const email = column(schema, 'users', 'email');
        expect(email.constraints).toContain('PUQ');
        expect(email.constraints).not.toContain('UQ');
        expect(email.extras).toContain('PARTIAL UNIQUE INDEX ux_users_active_email WHERE deleted_at IS NULL');
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

    it('marks composite filtered unique indexes without adding composite unique-key metadata', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE accounts (
                id INT PRIMARY KEY,
                tenant_id INT NOT NULL,
                email TEXT NOT NULL,
                deleted_at TIMESTAMP
            );
            CREATE UNIQUE INDEX ux_accounts_active_email
                ON accounts(tenant_id, email)
                WHERE deleted_at IS NULL;
            CREATE TABLE contacts (
                tenant_id INT NOT NULL,
                email TEXT NOT NULL,
                FOREIGN KEY (tenant_id, email) REFERENCES accounts(tenant_id, email)
            );
        `);

        const tenantId = column(schema, 'accounts', 'tenant_id');
        const email = column(schema, 'accounts', 'email');
        expect(tenantId.constraints).toContain('PUQ');
        expect(email.constraints).toContain('PUQ');
        expect(tenantId.compositePartialUq).toBe(true);
        expect(email.compositePartialUq).toBe(true);
        expect(schema.relations).toEqual([]);
        expect(schema._parseErrors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'relation_dropped_non_unique_target',
                    severity: 'warning',
                }),
            ]),
        );
    });

    it('allows explicit composite FK targets backed by a composite unique key', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE accounts (
                id INT PRIMARY KEY,
                tenant_id INT NOT NULL,
                account_no TEXT NOT NULL,
                UNIQUE (tenant_id, account_no)
            );
            CREATE TABLE contacts (
                tenant_id INT NOT NULL,
                account_no TEXT NOT NULL,
                FOREIGN KEY (tenant_id, account_no) REFERENCES accounts(tenant_id, account_no)
            );
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.relations.map(relationKey)).toEqual([
            'contacts.tenant_id->accounts.tenant_id',
            'contacts.account_no->accounts.account_no',
        ]);
        expect(schema.relations[0]).toMatchObject({
            composite: true,
            toColumns: ['tenant_id', 'account_no'],
        });
    });

    it('preserves inline, table-level, and ALTER TABLE foreign-key actions on ERD relations', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (
                id INT PRIMARY KEY,
                code TEXT UNIQUE
            );
            CREATE TABLE child_inline (
                parent_id INT REFERENCES parent(id)
                    ON DELETE SET NULL
                    ON UPDATE CASCADE
                    DEFERRABLE INITIALLY DEFERRED
            );
            CREATE TABLE child_table (
                code TEXT,
                CONSTRAINT fk_child_table_parent
                    FOREIGN KEY (code) REFERENCES parent(code)
                    MATCH FULL
                    ON DELETE NO ACTION
                    NOT DEFERRABLE
                    INITIALLY IMMEDIATE
            );
            CREATE TABLE child_alter (
                parent_id INT
            );
            ALTER TABLE child_alter
                ADD CONSTRAINT fk_child_alter_parent
                FOREIGN KEY (parent_id) REFERENCES parent(id)
                ON DELETE CASCADE
                ON UPDATE RESTRICT;
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.relations.map(relationKey)).toEqual([
            'child_inline.parent_id->parent.id',
            'fk_child_table_parent:child_table.code->parent.code',
            'fk_child_alter_parent:child_alter.parent_id->parent.id',
        ]);
        expect(schema.relations[0].actions).toEqual({
            onDelete: 'SET NULL',
            onUpdate: 'CASCADE',
            deferrable: true,
            initially: 'DEFERRED',
        });
        expect(schema.relations[1].actions).toEqual({
            match: 'FULL',
            onDelete: 'NO ACTION',
            deferrable: false,
            initially: 'IMMEDIATE',
        });
        expect(schema.relations[2].actions).toEqual({
            onDelete: 'CASCADE',
            onUpdate: 'RESTRICT',
        });
    });

    it('uses token-based column lists so quoted commas and dots stay inside identifiers', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (
                "a,b" INT,
                "c.d" INT,
                UNIQUE ("a,b", "c.d")
            );
            CREATE TABLE child (
                "a,b" INT,
                "c.d" INT,
                FOREIGN KEY ("a,b", "c.d") REFERENCES parent("a,b", "c.d")
            );
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(column(schema, 'parent', 'a,b').constraints).toContain('UQ');
        expect(column(schema, 'parent', 'c.d').constraints).toContain('UQ');
        expect(schema.relations.map(relationKey)).toEqual([
            'child.a,b->parent.a,b',
            'child.c.d->parent.c.d',
        ]);
        expect(schema.relations[0]).toMatchObject({
            composite: true,
            fromColumns: ['a,b', 'c.d'],
            toColumns: ['a,b', 'c.d'],
        });
        expect(schema.relations[0].relationGroup).toBe(schema.relations[1].relationGroup);
    });

    it('replays migration-style ALTER rename, drop, type, and not-null operations into the final ERD', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE users (
                id INT PRIMARY KEY,
                old_email TEXT,
                temp TEXT,
                code TEXT UNIQUE
            );
            CREATE TABLE posts (
                id INT PRIMARY KEY,
                user_code TEXT,
                CONSTRAINT fk_posts_user FOREIGN KEY (user_code) REFERENCES users(code)
            );
            ALTER TABLE users ADD COLUMN nickname TEXT;
            ALTER TABLE users RENAME COLUMN old_email TO email;
            ALTER TABLE users ALTER COLUMN email TYPE VARCHAR(320);
            ALTER TABLE users ALTER COLUMN email SET NOT NULL;
            ALTER TABLE users DROP COLUMN temp;
            ALTER TABLE posts DROP CONSTRAINT fk_posts_user;
            ALTER TABLE users RENAME TO app_users;
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.tables.map((entry) => entry.name).sort()).toEqual(['app_users', 'posts']);
        expect(table(schema, 'app_users').columns.map((entry) => entry.name)).toEqual(['id', 'email', 'code', 'nickname']);
        expect(column(schema, 'app_users', 'email')).toMatchObject({
            type: 'VARCHAR(320)',
        });
        expect(column(schema, 'app_users', 'email').constraints).toContain('NN');
        expect(column(schema, 'app_users', 'nickname')).toMatchObject({
            name: 'nickname',
            type: 'TEXT',
        });
        expect(schema.relations).toEqual([]);
    });

    it('rewrites existing FK endpoints when a referenced table and column are renamed', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE users (id INT PRIMARY KEY);
            CREATE TABLE posts (user_id INT REFERENCES users(id));
            ALTER TABLE users RENAME COLUMN id TO user_id;
            ALTER TABLE users RENAME TO accounts;
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(schema.tables.map((entry) => entry.name).sort()).toEqual(['accounts', 'posts']);
        expect(schema.relations.map(relationKey)).toEqual(['posts.user_id->accounts.user_id']);
        expect(column(schema, 'accounts', 'user_id').pk).toBe(true);
    });

    it('drops dependent relations when ALTER TABLE DROP COLUMN removes the referenced target column', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (
                id INT PRIMARY KEY,
                code TEXT UNIQUE
            );
            CREATE TABLE child (
                code TEXT REFERENCES parent(code)
            );
            ALTER TABLE parent DROP COLUMN code;
        `);

        expect(schema._parseErrors).toEqual([]);
        expect(table(schema, 'parent').columns.map((entry) => entry.name)).toEqual(['id']);
        expect(schema.relations).toEqual([]);
    });

    it('drops key metadata for ALTER TABLE DROP CONSTRAINT so invalid FK targets are warned', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE parent (
                id INT PRIMARY KEY,
                code TEXT,
                CONSTRAINT uq_parent_code UNIQUE (code)
            );
            CREATE TABLE child (
                code TEXT REFERENCES parent(code)
            );
            ALTER TABLE parent DROP CONSTRAINT uq_parent_code;
        `);

        expect(column(schema, 'parent', 'code').constraints).not.toContain('UQ');
        expect(schema.relations).toEqual([]);
        expect(schema._parseErrors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'relation_dropped_non_unique_target',
                    severity: 'warning',
                }),
            ]),
        );
    });
});
