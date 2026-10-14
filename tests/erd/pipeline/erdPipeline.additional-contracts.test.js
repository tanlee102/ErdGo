/** Protects additional end-to-end SQL parser-to-renderer contracts. */
import { describe, expect, it } from 'vitest';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

const VALID_CARDS = new Set(['1', 'n', '1+', '0..1', '0..n']);

function assertRendererReady(schema) {
    expect(Array.isArray(schema.tables)).toBe(true);
    expect(Array.isArray(schema.relations)).toBe(true);
    expect(Array.isArray(schema.enums)).toBe(true);
    expect(Array.isArray(schema.composites)).toBe(true);
    expect(Array.isArray(schema._parseErrors)).toBe(true);

    const tableColumns = new Map();
    for (const table of schema.tables) {
        expect(typeof table.name).toBe('string');
        expect(table.name.length).toBeGreaterThan(0);
        expect(Array.isArray(table.columns)).toBe(true);
        tableColumns.set(table.name, new Set(table.columns.map((column) => column.name)));

        for (const column of table.columns) {
            expect(typeof column.name).toBe('string');
            expect(typeof column.type).toBe('string');
            expect(Array.isArray(column.constraints)).toBe(true);
            expect(Array.isArray(column.extras)).toBe(true);
            expect(new Set(column.constraints).size).toBe(column.constraints.length);
            for (const badge of column.constraints) expect(typeof badge).toBe('string');
            for (const extra of column.extras) expect(typeof extra).toBe('string');
        }
    }

    for (const relation of schema.relations) {
        expect(tableColumns.get(relation.from.table)?.has(relation.from.column), `${relation.from.table}.${relation.from.column}`).toBe(true);
        expect(tableColumns.get(relation.to.table)?.has(relation.to.column), `${relation.to.table}.${relation.to.column}`).toBe(true);
        expect(VALID_CARDS.has(relation.fromCard)).toBe(true);
        expect(VALID_CARDS.has(relation.toCard)).toBe(true);
    }
}

describe('ERD pipeline additional contracts', () => {
    it('produces renderer-ready schema for mixed constraints, indexes, enums, composites, and relations', () => {
        const schema = sqlToErdSchema(`
            CREATE TYPE app.ticket_state AS ENUM ('open', 'closed');
            CREATE TYPE app.money AS (amount NUMERIC(12,2), currency CHAR(3));
            CREATE TABLE app.accounts (
                id BIGSERIAL PRIMARY KEY,
                email TEXT NOT NULL UNIQUE
            );
            CREATE TABLE app.tickets (
                id BIGSERIAL PRIMARY KEY,
                account_id BIGINT NOT NULL REFERENCES app.accounts(id),
                state app.ticket_state NOT NULL DEFAULT 'open',
                total app.money,
                title TEXT NOT NULL CHECK (length(title) > 2)
            );
            CREATE INDEX idx_tickets_account_state ON app.tickets (account_id, state);
        `);

        expect(schema._parseErrors).toEqual([]);
        assertRendererReady(schema);
        expect(schema.enums[0].name).toBe('ticket_state');
        expect(schema.composites[0].name).toBe('money');
        expect(schema.relations).toHaveLength(1);
    });

    it('is deterministic and JSON-serializable across repeated SQL-to-ERD runs', () => {
        const sql = `
            CREATE TABLE users (id INT PRIMARY KEY, email TEXT UNIQUE);
            CREATE TABLE sessions (
                id INT PRIMARY KEY,
                user_id INT NOT NULL REFERENCES users(id),
                token TEXT NOT NULL UNIQUE
            );
            CREATE INDEX idx_sessions_user ON sessions (user_id);
        `;
        const first = sqlToErdSchema(sql);
        const second = sqlToErdSchema(sql);

        expect(JSON.parse(JSON.stringify(first))).toEqual(first);
        expect(second).toEqual(first);
    });

    it('keeps many-to-many junction tables renderable with composite PK and two outgoing relations', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE students (id INT PRIMARY KEY, email TEXT UNIQUE NOT NULL);
            CREATE TABLE courses (id INT PRIMARY KEY, code TEXT UNIQUE NOT NULL);
            CREATE TABLE enrollments (
                student_id INT NOT NULL REFERENCES students(id),
                course_id INT NOT NULL REFERENCES courses(id),
                enrolled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (student_id, course_id)
            );
        `);

        const enrollments = schema.tables.find((table) => table.name === 'enrollments');
        const studentId = enrollments.columns.find((column) => column.name === 'student_id');
        const courseId = enrollments.columns.find((column) => column.name === 'course_id');

        expect(studentId).toMatchObject({ pk: true, fk: true, compositePk: true });
        expect(courseId).toMatchObject({ pk: true, fk: true, compositePk: true });
        expect(schema.relations.map((relation) => `${relation.from.column}->${relation.to.table}.${relation.to.column}`).sort()).toEqual([
            'course_id->courses.id',
            'student_id->students.id',
        ]);
        assertRendererReady(schema);
    });

    it('preserves self-referencing and cyclic relations without invalid endpoints', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE employees (
                id INT PRIMARY KEY,
                manager_id INT REFERENCES employees(id),
                department_id INT
            );
            CREATE TABLE departments (
                id INT PRIMARY KEY,
                lead_employee_id INT REFERENCES employees(id)
            );
            ALTER TABLE employees
                ADD CONSTRAINT fk_employees_department
                FOREIGN KEY (department_id) REFERENCES departments(id);
        `);

        expect(schema.relations.map((relation) => `${relation.from.table}.${relation.from.column}->${relation.to.table}.${relation.to.column}`).sort()).toEqual([
            'departments.lead_employee_id->employees.id',
            'employees.department_id->departments.id',
            'employees.manager_id->employees.id',
        ]);
        assertRendererReady(schema);
    });

    it('reports parser and validator diagnostics without breaking the renderer-ready schema shape', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE ok_table (id INT PRIMARY KEY);
            CREATE TABLE broken_ref (
                id INT PRIMARY KEY,
                ok_id INT REFERENCES ok_table(id),
                bad_id INT REFERENCES missing_table(id)
            );
            CREATE TABLE broken_string (name TEXT DEFAULT 'unterminated);
        `);

        expect(schema.tables.map((table) => table.name)).toContain('ok_table');
        expect(schema.relations.map((relation) => `${relation.from.table}.${relation.from.column}`)).toEqual(['broken_ref.ok_id']);
        expect(schema._parseErrors.length).toBeGreaterThanOrEqual(2);
        expect(schema._parseErrors.map((error) => error.severity)).toContain('warning');
        expect(schema._parseErrors.map((error) => error.severity)).toContain('error');
        assertRendererReady(schema);
    });

    it('keeps semantic-resolution upgrades renderer-ready end to end', () => {
        const schema = sqlToErdSchema(`
            CREATE TYPE app.review_state AS ENUM ('new', 'approved');
            CREATE TYPE audit.review_state AS ENUM ('queued', 'archived');
            CREATE TABLE "tenant.users" (
                "id.part" INT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE
            );
            CREATE TABLE app.accounts (
                tenant_id INT NOT NULL,
                account_no TEXT NOT NULL,
                state app.review_state,
                PRIMARY KEY (tenant_id, account_no)
            );
            CREATE TABLE app.contacts (
                tenant_id INT NOT NULL,
                account_no TEXT NOT NULL,
                email TEXT NOT NULL,
                audit_state audit.review_state,
                UNIQUE (tenant_id, account_no),
                FOREIGN KEY (tenant_id, account_no) REFERENCES app.accounts
            );
            ALTER TABLE app.contacts
                ADD COLUMN reviewer_email TEXT REFERENCES "tenant.users"(email) ON DELETE SET NULL;
        `);

        expect(schema._parseErrors).toEqual([]);
        assertRendererReady(schema);
        expect(schema.enums.map((entry) => entry.name)).toEqual(['app.review_state', 'audit.review_state']);
        expect(schema.tables.map((table) => table.name)).toEqual(['"tenant.users"', 'app.accounts', 'app.contacts']);
        expect(schema.tables[1].columns.find((column) => column.name === 'state').type).toBe('app.review_state');
        expect(schema.tables[2].columns.find((column) => column.name === 'audit_state').type).toBe('audit.review_state');
        expect(schema.relations.map((relation) => `${relation.from.table}.${relation.from.column}->${relation.to.table}.${relation.to.column}`)).toEqual([
            'app.contacts.tenant_id->app.accounts.tenant_id',
            'app.contacts.account_no->app.accounts.account_no',
            'app.contacts.reviewer_email->"tenant.users".email',
        ]);
        expect(schema.relations[2].actions).toEqual({ onDelete: 'SET NULL' });
        expect(schema.relations[0]).toMatchObject({
            composite: true,
            fromCard: '0..1',
            fromColumns: ['tenant_id', 'account_no'],
            toColumns: ['tenant_id', 'account_no'],
        });
        expect(schema.relations[0].relationGroup).toBe(schema.relations[1].relationGroup);
    });
});
