/** Verifies Prisma-to-SQL compatibility output and provider selection. */
import { describe, expect, it } from 'vitest';
import { convertPrismaToSql, SAMPLE_PRISMA_SCHEMA } from '@/features/prisma-erd/lib/prismaToSql.js';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

describe('prismaToSql', () => {
    it('converts the sample Prisma schema into ERD-readable SQL', () => {
        expect(SAMPLE_PRISMA_SCHEMA).toMatch(/^\/\/ Replace this sample with your own Prisma schema\./);

        const result = convertPrismaToSql(SAMPLE_PRISMA_SCHEMA);
        const schema = sqlToErdSchema(result.sql);

        expect(result.sql).toContain(`CREATE TYPE "user_role" AS ENUM ('MEMBER', 'MANAGER', 'administrator')`);
        expect(result.sql).toContain('CREATE TABLE "users"');
        expect(result.sql).toContain('CONSTRAINT "tasks_project_fkey" FOREIGN KEY ("organization_id", "project_code") REFERENCES "projects" ("organization_id", "code")');
        expect(result.sql).toContain('FOREIGN KEY ("post_id") REFERENCES "posts" ("id")');
        expect(result.sql).toContain('CREATE INDEX "users_role_created_idx" ON "users" ("role", "created_at")');
        expect(schema.tables.map((table) => table.name)).toEqual(['users', 'organizations', 'memberships', 'projects', 'tasks', 'posts', 'comments']);
        expect(schema.relations.length).toBeGreaterThanOrEqual(7);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'warning',
                    message: expect.stringContaining('scalar list'),
                }),
                expect.objectContaining({
                    severity: 'warning',
                    message: expect.stringContaining('implicit many-to-many relation'),
                }),
            ]),
        );
    });

    it('preserves mapped model and field names', () => {
        const result = convertPrismaToSql(`
            model Account {
              id       Int    @id
              ownerId  Int    @map("owner_id")
              owner    User   @relation(fields: [ownerId], references: [id])

              @@map("accounts")
              @@index([ownerId], map: "accounts_owner_id_idx")
            }

            model User {
              id       Int       @id
              accounts Account[]

              @@map("users")
            }
        `);

        expect(result.sql).toContain('CREATE TABLE "accounts"');
        expect(result.sql).toContain('"owner_id" INTEGER NOT NULL');
        expect(result.sql).toContain('REFERENCES "users" ("id")');
        expect(result.sql).toContain('CREATE INDEX "accounts_owner_id_idx" ON "accounts" ("owner_id");');
        expect(sqlToErdSchema(result.sql).relations).toHaveLength(1);
    });

    it('renders composite primary keys and unique constraints', () => {
        const result = convertPrismaToSql(`
            model TeamMember {
              teamId Int
              userId Int
              role   String

              @@id([teamId, userId])
              @@unique([teamId, role], name: "team_role_unique")
            }
        `);

        expect(result.sql).toContain('PRIMARY KEY ("teamId", "userId")');
        expect(result.sql).toContain('CONSTRAINT "team_role_unique" UNIQUE ("teamId", "role")');

        const table = sqlToErdSchema(result.sql).tables[0];
        expect(table.columns.find((column) => column.name === 'teamId')?.pk).toBe(true);
        expect(table.columns.find((column) => column.name === 'role')?.constraints).toContain('UQ');
    });

    it('warns about implicit many-to-many relation lists without blocking output', () => {
        const result = convertPrismaToSql(`
            model Post {
              id   Int   @id
              tags Tag[]
            }

            model Tag {
              id    Int    @id
              posts Post[]
            }
        `);

        expect(result.sql).toContain('CREATE TABLE "Post"');
        expect(result.diagnostics.some((item) => item.message.includes('implicit many-to-many'))).toBe(true);
    });
});
