/** Relation/key integrity cases checked against Prisma's v7 schema validator. */
import { describe, expect, it } from 'vitest';
import { convertPrismaToErdSchema, convertPrismaToSql } from '@/features/prisma-erd/lib/prismaToSql';
import { getPrismaDiagnosticHint } from '@/features/prisma-erd/lib/prismaDiagnostics';

const postgres = body => `datasource db {\n provider = "postgresql"\n}\n${body}`;
const messages = result => result.diagnostics.map(item => item.message).join('\n');
const column = (result, table, field) => result.schema.tables.find(item => item.name === table).columns.find(item => item.name === field);

describe('Prisma relation and key integrity', () => {
    it.each(['posts:first', 'fields: [id], references: [id]'])('preserves the literal relation name %s', name => {
        const source = postgres(`model User {
            id Int @id
            first Post[] @relation("${name}")
            second Post[] @relation("Other")
        }
        model Post {
            id Int @id
            first User[] @relation("${name}")
            second User[] @relation("Other")
        }`);
        const result = convertPrismaToErdSchema(source);
        expect(result.schema.relations).toHaveLength(2);
        expect(result.schema.relations.map(relation => relation.prisma.relationName)).toContain(name);
        expect(result.diagnostics).toEqual([]);
        expect(convertPrismaToSql(source).sql).not.toContain('FOREIGN KEY');
    });

    it('reads named index fields without interpreting brackets inside its name', () => {
        const result = convertPrismaToErdSchema(postgres(`model Item {
            id Int @id
            code String
            @@unique(name: "code[notAField]", fields: [code])
        }`));
        expect(column(result, 'Item', 'code').constraints).toContain('UQ');
        expect(result.diagnostics).toEqual([]);
    });

    it('does not interpret connector options inside a quoted index name', () => {
        const result = convertPrismaToErdSchema(`datasource db {
            provider = "mysql"
        }
        model Item {
            id Int @id
            code String
            @@index([code], map: "type: Gin, ops: raw, where: [id], clustered: true")
        }`);
        expect(result.diagnostics).toEqual([]);
        expect(column(result, 'Item', 'code').constraints).toContain('IDX');
    });

    it('keeps Prisma field identities case-sensitive, including foreign-key targets', () => {
        const result = convertPrismaToErdSchema(postgres(`model Parent {
            id Int @id
            code Int @unique
            Code Int
            children Child[]
        }
        model Child {
            id Int @id
            parentCode Int
            parent Parent @relation(fields: [parentCode], references: [Code])
        }`));
        expect(messages(result)).toContain('must reference a unique field set');
        expect(messages(result)).not.toContain('maps multiple fields');
        expect(column(result, 'Parent', 'Code').constraints).not.toContain('UQ');
    });

    it.each(['@@id([code, missing])', '@@unique([code, missing])', '@@unique([code, code])'])('never shortens the invalid key %s into a valid reference', key => {
        const source = postgres(`model Parent {
            ${key.startsWith('@@id') ? '' : 'id Int @id'}
            code Int
            children Child[]
            ${key}
        }
        model Child {
            id Int @id
            parentCode Int
            parent Parent @relation(fields: [parentCode], references: [code])
        }`);
        const result = convertPrismaToErdSchema(source);
        expect(messages(result)).toContain('must reference a unique field set');
        expect(column(result, 'Parent', 'code').pk).not.toBe(true);
        expect(column(result, 'Parent', 'code').constraints).not.toContain('UQ');
        expect(convertPrismaToSql(source).sql).not.toMatch(/(?:PRIMARY KEY|UNIQUE) \("code"(?:, "code")?\)/);
    });

    it('diagnoses a required relation backed by an optional foreign-key scalar', () => {
        const result = convertPrismaToErdSchema(postgres(`model Parent {
            id Int @id
            children Child[]
        }
        model Child {
            id Int @id
            parentId Int?
            parent Parent @relation(fields: [parentId], references: [id])
        }`));
        expect(result.schema.relations).toHaveLength(1);
        expect(messages(result)).toContain('must be optional');
        expect(result.diagnostics.some(item => getPrismaDiagnosticHint(item)?.includes('nullable'))).toBe(true);
    });

    it('accepts an optional relation with required foreign-key scalars, as Prisma does', () => {
        const result = convertPrismaToErdSchema(postgres(`model Parent {
            id Int @id
            children Child[]
        }
        model Child {
            id Int @id
            parentId Int
            parent Parent? @relation(fields: [parentId], references: [id])
        }`));
        expect(result.schema.relations).toHaveLength(1);
        expect(result.diagnostics).toEqual([]);
    });

    it('diagnoses missing one-to-one uniqueness and a required inverse relation independently', () => {
        const result = convertPrismaToErdSchema(postgres(`model Parent {
            id Int @id
            child Child
        }
        model Child {
            id Int @id
            parentId Int
            parent Parent @relation(fields: [parentId], references: [id])
        }`));
        expect(result.schema.relations).toHaveLength(1);
        expect(messages(result)).toContain('one-to-one relation requires');
        expect(messages(result)).toContain('without foreign-key scalars must be optional');
    });

    it('diagnoses two owners of the same relational relation while retaining repairable edges', () => {
        const result = convertPrismaToErdSchema(postgres(`model Parent {
            id Int @id
            childId Int? @unique
            child Child? @relation("Pair", fields: [childId], references: [id])
        }
        model Child {
            id Int @id
            parentId Int? @unique
            parent Parent? @relation("Pair", fields: [parentId], references: [id])
        }`));
        expect(result.schema.relations).toHaveLength(2);
        expect(messages(result)).toContain('both own');
    });

    it('does not invent a many-to-many edge with unsupported referential actions', () => {
        const result = convertPrismaToErdSchema(postgres(`model Parent {
            id Int @id
            children Child[] @relation("Pair", onDelete: Cascade)
        }
        model Child {
            id Int @id
            parents Parent[] @relation("Pair")
        }`));
        expect(result.schema.relations).toEqual([]);
        expect(messages(result)).toContain('implicit many-to-many relations cannot define');
    });

    it('does not create duplicate composite edges from repeated relation scalar fields', () => {
        const result = convertPrismaToErdSchema(postgres(`model Parent {
            id Int @id
            children Child[]
        }
        model Child {
            id Int @id
            parentId Int
            parent Parent @relation(fields: [parentId, parentId], references: [id, id])
        }`));
        expect(result.schema.relations).toEqual([]);
        expect(messages(result)).toContain('repeats a field');
    });

    it('accepts differing varchar lengths without a false native-type incompatibility', () => {
        const result = convertPrismaToErdSchema(postgres(`model Parent {
            id String @id @db.VarChar(36)
            children Child[]
        }
        model Child {
            id Int @id
            parentId String @db.VarChar(64)
            parent Parent @relation(fields: [parentId], references: [id])
        }`));
        expect(result.schema.relations).toHaveLength(1);
        expect(result.diagnostics).toEqual([]);
    });

    it('shows partial unique badges and never exports their predicates as global uniqueness', () => {
        const source = postgres(`model Item {
            id Int @id
            code String @unique(where: { active: true })
            tenant Int
            active Boolean
            @@unique([tenant, code], where: { active: true })
            @@index([tenant], where: { active: true })
        }`);
        const result = convertPrismaToErdSchema(source);
        expect(column(result, 'Item', 'code').constraints).toContain('PUQ');
        expect(column(result, 'Item', 'code').constraints).not.toContain('UQ');
        expect(column(result, 'Item', 'tenant').compositePartialUq).toBe(true);
        const sql = convertPrismaToSql(source);
        expect(sql.sql).not.toContain('UNIQUE');
        expect(sql.sql).not.toContain('CREATE INDEX');
        expect(messages(sql)).toContain('partial');
        expect(messages(sql)).toContain('omitted from SQL');
    });
});
