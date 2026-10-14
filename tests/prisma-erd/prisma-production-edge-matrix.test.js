/** Exercises production-oriented Prisma schema edge cases. */
import { describe, expect, it } from 'vitest';
import { convertPrismaToErdSchema } from '@/features/prisma-erd/lib/prismaToSql.js';

function diagnosticMessages(result) {
    return result.diagnostics.map((diagnostic) => diagnostic.message);
}

function tableNames(result) {
    return result.schema.tables.map((table) => table.name);
}

describe('Prisma production edge matrix', () => {
    it.each(['postgresql', 'mysql', 'sqlserver', 'sqlite'])('keeps a connected portable schema stable for %s', (provider) => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider = "${provider}"
            }

            model Workspace {
              tenantId Int
              slug     String
              members  Member[]

              @@id([tenantId, slug])
              @@map("workspaces")
            }

            model Member {
              id            Int       @id
              workspaceId   Int
              workspaceSlug String
              email         String
              workspace     Workspace @relation(
                fields: [workspaceId, workspaceSlug],
                references: [tenantId, slug],
                onDelete: Cascade,
                map: "member_workspace_fkey"
              )

              @@unique([workspaceId, email], map: "member_workspace_email_key")
              @@map("members")
            }
        `);

        expect(result.datasource).toEqual(expect.objectContaining({ provider }));
        expect(tableNames(result)).toEqual(['Workspace', 'Member']);
        expect(result.schema.relations).toHaveLength(2);
        expect(result.stats.relationCount).toBe(1);
        expect(result.schema.relations.every((relation) => relation.composite)).toBe(true);
        expect(result.schema.relations.every((relation) => relation.fkName === 'member_workspace_fkey')).toBe(true);
        expect(result.diagnostics).toEqual([]);
    });

    it.each([
        [
            'missing provider',
            'url = env("DATABASE_URL")',
            'is missing a provider',
        ],
        [
            'unquoted provider',
            'provider = postgresql',
            'provider must be a quoted Prisma connector name',
        ],
        [
            'duplicate provider',
            'provider = "postgresql"\nprovider = "mysql"',
            'defines provider more than once',
        ],
        [
            'invalid relation mode',
            'provider = "postgresql"\nrelationMode = "database"',
            'relationMode must be "foreignKeys" or "prisma"',
        ],
        [
            'invalid schemas array',
            'provider = "postgresql"\nschemas = ["public", audit]',
            'schemas must be an array of quoted schema names',
        ],
        [
            'invalid configuration entry',
            'provider = "postgresql"\nthis is not valid',
            'invalid configuration entry',
        ],
    ])('reports a %s without hiding valid models', (_label, datasourceBody, expectedMessage) => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              ${datasourceBody}
            }

            model Healthy {
              id Int @id
            }
        `);

        expect(tableNames(result)).toEqual(['Healthy']);
        expect(diagnosticMessages(result)).toEqual(expect.arrayContaining([expect.stringContaining(expectedMessage)]));
    });

    it('ignores malformed generator configuration while preserving datasource and models', () => {
        const result = convertPrismaToErdSchema(`
            generator client {
              provider = "prisma-client-js"
              broken = ["
            }

            datasource db {
              provider = "sqlite"
            }

            model User {
              id Int @id
            }
        `);

        expect(result.datasource).toEqual(expect.objectContaining({ provider: 'sqlite' }));
        expect(tableNames(result)).toEqual(['User']);
        expect(diagnosticMessages(result)).toEqual(expect.arrayContaining([expect.stringContaining('Unterminated string')]));
    });

    it('preserves mapped model, field, enum, and relation names containing escaped quotes', () => {
        const result = convertPrismaToErdSchema(`
            enum AccessRole {
              ADMIN @map("admin\\"role")

              @@map("access\\"roles")
            }

            model User {
              id       Int        @id @map("user\\"id")
              role     AccessRole
              posts    Post[]

              @@map("app\\"users")
            }

            model Post {
              id       Int  @id
              authorId Int
              author   User @relation(fields: [authorId], references: [id], map: "post\\"author_fkey")
            }
        `);

        const user = result.schema.tables.find((table) => table.name === 'User');
        expect(user.prisma.dbName).toBe('app"users');
        expect(user.columns.find((column) => column.name === 'id')?.prisma.dbName).toBe('user"id');
        expect(result.schema.enums[0].prisma.dbName).toBe('access"roles');
        expect(result.schema.enums[0].prisma.values[0].dbName).toBe('admin"role');
        expect(result.schema.relations[0].fkName).toBe('post"author_fkey');
        expect(result.diagnostics).toEqual([]);
    });

    it('keeps valid relations when a neighboring relation has broken syntax', () => {
        const result = convertPrismaToErdSchema(`
            model User {
              id       Int    @id
              posts    Post[]
              comments Comment[]
            }

            model Post {
              id       Int  @id
              authorId Int
              author   User @relation(fields: [authorId], references: [id])
            }

            model Comment {
              id       Int  @id
              authorId Int
              author   User @relation(fields: [authorId], references: [id]
            }

            model Category {
              id    Int    @id
              posts Post[]
            }

            model Categorization {
              postId     Int
              categoryId Int
              post       Post     @relation(fields: [postId], references: [id])
              category   Category @relation(fields: [categoryId], references: [id])

              @@id([postId, categoryId])
            }
        `);

        expect(tableNames(result)).toEqual(['User', 'Post', 'Comment', 'Category', 'Categorization']);
        expect(result.schema.relations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ from: { table: 'Post', column: 'authorId' }, to: { table: 'User', column: 'id' } }),
                expect.objectContaining({ from: { table: 'Categorization', column: 'postId' }, to: { table: 'Post', column: 'id' } }),
                expect.objectContaining({ from: { table: 'Categorization', column: 'categoryId' }, to: { table: 'Category', column: 'id' } }),
            ]),
        );
        expect(result.schema.relations.some((relation) => relation.from.table === 'Comment')).toBe(false);
        expect(diagnosticMessages(result)).toEqual(expect.arrayContaining([expect.stringContaining('unbalanced field or attribute delimiters')]));
    });

    it('reports several relation mistakes independently and still draws recoverable edges', () => {
        const result = convertPrismaToErdSchema(`
            model Parent {
              id        Int    @id
              code      String
              external  String @unique
              children  Child[]
              typed     TypedChild[]
              invalid   InvalidActionChild[]
            }

            model Child {
              id         Int    @id
              parentCode String
              parent     Parent @relation(fields: [parentCode], references: [code])
            }

            model TypedChild {
              id       Int    @id
              parentId String
              parent   Parent @relation(fields: [parentId], references: [id])
            }

            model InvalidActionChild {
              id       Int    @id
              parentId Int
              parent   Parent @relation(fields: [parentId], references: [id], onDelete: Explode)
            }
        `);

        expect(tableNames(result)).toEqual(['Parent', 'Child', 'TypedChild', 'InvalidActionChild']);
        expect(result.schema.relations).toHaveLength(3);
        expect(diagnosticMessages(result)).toEqual(
            expect.arrayContaining([
                expect.stringContaining('must reference a unique field set'),
                expect.stringContaining('incompatible field types String and Int'),
                expect.stringContaining('unsupported onDelete action Explode'),
            ]),
        );
    });

    it('preserves one-to-one and one-to-many cardinality from relation scalar uniqueness and nullability', () => {
        const result = convertPrismaToErdSchema(`
            model User {
              id       Int      @id
              profile  Profile?
              posts    Post[]
            }

            model Profile {
              id     Int  @id
              userId Int  @unique
              user   User @relation(fields: [userId], references: [id])
            }

            model Post {
              id       Int   @id
              authorId Int?
              author   User? @relation(fields: [authorId], references: [id])
            }
        `);

        expect(result.schema.relations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ from: { table: 'Profile', column: 'userId' }, fromCard: '1', toCard: '1' }),
                expect.objectContaining({ from: { table: 'Post', column: 'authorId' }, fromCard: '0..n', toCard: '1' }),
            ]),
        );
        expect(result.diagnostics).toEqual([]);
    });

    it.each([
        ['postgresql', 'tags String[]', null],
        ['mysql', 'tags String[]', 'does not support scalar lists'],
        ['sqlserver', 'payload Json', 'does not support Prisma Json fields'],
        ['sqlite', 'name String @db.Text', 'does not support Prisma native type attributes'],
    ])('applies %s field compatibility diagnostics without dropping the model', (provider, field, expectedMessage) => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider = "${provider}"
            }

            model Portable {
              id Int @id
              ${field}
            }
        `);

        expect(tableNames(result)).toEqual(['Portable']);
        expect(result.schema.tables[0].columns).toHaveLength(2);
        if (expectedMessage) {
            expect(diagnosticMessages(result)).toEqual(expect.arrayContaining([expect.stringContaining(expectedMessage)]));
        } else {
            expect(result.diagnostics).toEqual([]);
        }
    });

    it('handles datasource URLs containing braces and comment markers without corrupting later blocks', () => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider = "postgresql"
              url      = "postgresql://user:pass@localhost/db?options={safe}//still-string"
            }

            model Account {
              id Int @id
            }
        `);

        expect(result.datasource).toEqual(expect.objectContaining({ provider: 'postgresql' }));
        expect(tableNames(result)).toEqual(['Account']);
        expect(result.diagnostics).toEqual([]);
    });

    it('recovers a large connected schema with one damaged model in the middle', () => {
        const models = Array.from({ length: 60 }, (_, index) => {
            const previousField =
                index === 0
                    ? ''
                    : `
                      previousId Int?
                      previous   Model${index - 1}? @relation(fields: [previousId], references: [id], onDelete: SetNull)
                    `;
            const nextField = index === 59 ? '' : `next Model${index + 1}[]`;
            const damagedField = index === 30 ? 'broken String @default("unfinished"' : '';
            return `
                model Model${index} {
                  id Int @id
                  ${previousField}
                  ${nextField}
                  ${damagedField}
                }
            `;
        }).join('\n');

        const result = convertPrismaToErdSchema(models);

        expect(result.schema.tables).toHaveLength(60);
        expect(result.schema.relations).toHaveLength(59);
        expect(result.stats.relationCount).toBe(59);
        expect(result.schema.tables.find((table) => table.name === 'Model30')?.columns.map((column) => column.name)).toEqual(['id', 'previousId', 'broken']);
        expect(result.schema.tables.find((table) => table.name === 'Model31')?.columns.map((column) => column.name)).toEqual(['id', 'previousId']);
        expect(diagnosticMessages(result)).toEqual(expect.arrayContaining([expect.stringContaining('unbalanced field or attribute delimiters')]));
    });
});
