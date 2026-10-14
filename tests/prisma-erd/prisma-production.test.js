import { describe, expect, it } from 'vitest';
import { convertPrismaToErdSchema } from '@/features/prisma-erd/lib/prismaToSql.js';

describe('Prisma ERD production compatibility', () => {
    it('renders composite types and views without treating composites as unknown scalars', () => {
        const result = convertPrismaToErdSchema(`
            type Address {
              street String
              city   String
              zip    String?
            }

            model User {
              id      Int      @id
              address Address?
            }

            view UserSummary {
              id   Int
              city String
            }
        `);

        expect(result.schema.composites).toEqual([
            expect.objectContaining({
                name: 'Address',
                fields: [
                    { name: 'street', type: 'String' },
                    { name: 'city', type: 'String' },
                    { name: 'zip', type: 'String?' },
                ],
            }),
        ]);
        expect(result.schema.tables.find((table) => table.name === 'UserSummary')?.prisma.kind).toBe('view');
        expect(result.schema.tables.find((table) => table.name === 'UserSummary')?.columns[0].extras).toContain('Prisma view');
        expect(result.stats).toEqual(expect.objectContaining({ modelCount: 1, viewCount: 1, compositeCount: 1 }));
        expect(result.diagnostics.some((item) => item.message.includes('unknown scalar type Address'))).toBe(false);
    });

    it('diagnoses conflicting definitions, duplicate fields, and malformed fields', () => {
        const result = convertPrismaToErdSchema(`
            model User {
              id Int @id
              id String
              broken
            }

            enum User {
              ACTIVE
            }
        `);

        expect(result.schema.tables).toHaveLength(1);
        expect(result.schema.enums).toHaveLength(0);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ severity: 'error', message: expect.stringContaining('duplicate field id') }),
                expect.objectContaining({ severity: 'error', message: expect.stringContaining('invalid field declaration') }),
                expect.objectContaining({ severity: 'error', message: expect.stringContaining('conflicts with the model') }),
            ]),
        );
    });

    it('keeps valid models and recoverable fields available when a neighboring block is incomplete', () => {
        const result = convertPrismaToErdSchema(`
            model Valid {
              id Int @id
            }

            model Broken {
              id Int
        `);

        expect(result.schema.tables.map((table) => table.name)).toEqual(['Valid', 'Broken']);
        expect(result.schema.tables.find((table) => table.name === 'Broken')?.columns.map((column) => column.name)).toEqual(['id']);
        expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', message: expect.stringContaining('Missing closing brace') })]));
    });

    it('keeps table rows SQL-like while retaining Prisma relation metadata', () => {
        const result = convertPrismaToErdSchema(`
            model User {
              id      Int     @id
              profile Profile?
            }

            model Profile {
              id     Int   @id
              userId Int   @unique
              user   User  @relation(fields: [userId], references: [id])
            }
        `);

        const user = result.schema.tables.find((table) => table.name === 'User');
        const profile = result.schema.tables.find((table) => table.name === 'Profile');

        expect(user.columns.map((column) => column.name)).toEqual(['id']);
        expect(profile.columns.map((column) => column.name)).toEqual(['id', 'userId']);
        expect(profile.columns.find((column) => column.name === 'userId')?.fk).toBe(true);
        expect(profile.prisma.relationFields).toEqual([expect.objectContaining({ name: 'user', targetModel: 'User' })]);
    });

    it('pairs named implicit self-relations without matching a field to itself', () => {
        const result = convertPrismaToErdSchema(`
            model User {
              id        Int    @id
              followers User[] @relation(name: "UserFollows")
              following User[] @relation(name: "UserFollows")
            }
        `);

        expect(result.schema.relations).toEqual([
            expect.objectContaining({
                from: { table: 'User', column: 'id' },
                to: { table: 'User', column: 'id' },
                fkName: 'UserFollows',
                prisma: expect.objectContaining({
                    kind: 'implicit-many-to-many',
                    relationName: 'UserFollows',
                    fromRelationField: 'followers',
                    toRelationField: 'following',
                }),
            }),
        ]);
        expect(result.diagnostics).toHaveLength(0);
    });

    it('retains full-text, ordered index, and database schema metadata', () => {
        const result = convertPrismaToErdSchema(`
            enum Locale {
              EN
              FR

              @@schema("content")
            }

            model Article {
              id        Int       @id
              title     String
              body      String
              locale    Locale
              active    Boolean
              deletedAt DateTime?

              @@fulltext([title, body], map: "article_search_idx")
              @@index([locale, title(sort: Desc, length: 32)], type: Hash, map: "article_locale_idx")
              @@index(
                [title],
                where: { active: true, deletedAt: null },
                map: "article_live_idx"
              )
              @@schema("content")
            }
        `);

        const article = result.schema.tables[0];
        const title = article.columns.find((column) => column.name === 'title');
        const body = article.columns.find((column) => column.name === 'body');

        expect(article.prisma.schemaName).toBe('content');
        expect(article.prisma.indexes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'fulltext', fields: ['title', 'body'], name: 'article_search_idx', raw: expect.stringContaining('@@fulltext') }),
                expect.objectContaining({ kind: 'index', fields: ['locale', 'title'], name: 'article_locale_idx', raw: expect.stringContaining('sort: Desc') }),
                expect.objectContaining({ kind: 'index', fields: ['title'], name: 'article_live_idx', raw: expect.stringContaining('where: { active: true, deletedAt: null }') }),
            ]),
        );
        expect(article.prisma.annotations).toContain('@@schema("content")');
        expect(article.columns[0].extras).toContain('@@schema("content")');
        expect(title.constraints).toContain('IDX');
        expect(title.compositeIdx).toBe(true);
        expect(body.constraints).toContain('IDX');
        expect(result.schema.enums[0].prisma.schemaName).toBe('content');
        expect(result.diagnostics).toHaveLength(0);
    });

    it('handles nested defaults, strings containing delimiters, native types, and comments', () => {
        const result = convertPrismaToErdSchema(`
            /* braces and attributes in comments must be ignored: } @ignore */
            model Event {
              id        String   @id @default(cuid(2))
              token     String   @default(dbgenerated("concat('a,b', '-', now())"))
              payload   Json     @default("{\\"nested\\": {\\"ok\\": true}}")
              amount    Decimal  @db.Decimal(30, 12)
              vector    Unsupported("vector(1536)")?
              nativeVector Unsupported("vector")? @db.Unsupported("vector(1536)")
              updatedAt DateTime @updatedAt
            }
        `);

        const event = result.schema.tables[0];
        expect(event.columns.find((column) => column.name === 'token')?.extras).toContain(`Default: dbgenerated("concat('a,b', '-', now())")`);
        expect(event.columns.find((column) => column.name === 'payload')?.extras).toContain('Default: "{\\"nested\\": {\\"ok\\": true}}"');
        expect(event.columns.find((column) => column.name === 'amount')?.extras).toContain('Native: @db.Decimal(30,12)');
        expect(event.columns.find((column) => column.name === 'vector')?.type).toBe('Unsupported("vector(1536)")?');
        expect(event.columns.find((column) => column.name === 'nativeVector')?.extras).toContain('Native: @db.Unsupported("vector(1536)")');
        expect(event.columns.find((column) => column.name === 'updatedAt')?.extras).toContain('@updatedAt');
        expect(result.diagnostics).toHaveLength(0);
    });

    it('decodes escaped Prisma strings in mapped and relation names', () => {
        const result = convertPrismaToErdSchema(`
            model User {
              id       Int    @id @map("user\\u005Fid")
              posts    Post[] @relation("User\\u002Dposts")

              @@map("app\\\\users")
            }

            model Post {
              id       Int  @id
              authorId Int
              author   User @relation(name: "User\\u002Dposts", fields: [authorId], references: [id], map: "post\\u005Fauthor")
            }
        `);

        const user = result.schema.tables.find((table) => table.name === 'User');
        expect(user.prisma.dbName).toBe('app\\users');
        expect(user.columns.find((column) => column.name === 'id')?.prisma.dbName).toBe('user_id');
        expect(result.schema.relations).toEqual([
            expect.objectContaining({
                fkName: 'post_author',
                prisma: expect.objectContaining({ relationName: 'User-posts' }),
            }),
        ]);
        expect(result.diagnostics).toEqual([]);
    });

    it('omits ignored fields and models while preserving neighboring definitions', () => {
        const result = convertPrismaToErdSchema(`
            model Current {
              id       Int     @id
              oldValue String? @ignore
            }

            model Legacy {
              id Int @id

              @@ignore
            }
        `);

        expect(result.schema.tables.map((table) => table.name)).toEqual(['Current']);
        expect(result.schema.tables[0].columns.map((column) => column.name)).toEqual(['id']);
        expect(result.stats.modelCount).toBe(1);
        expect(result.diagnostics).toHaveLength(0);
    });

    it('reports incomplete composite relations without dropping valid tables', () => {
        const result = convertPrismaToErdSchema(`
            model Parent {
              tenantId Int
              code     String
              children Child[]

              @@id([tenantId, code])
            }

            model Child {
              id       Int    @id
              tenantId Int
              parent   Parent @relation(fields: [tenantId], references: [tenantId, code])
            }
        `);

        expect(result.schema.tables.map((table) => table.name)).toEqual(['Parent', 'Child']);
        expect(result.schema.relations).toHaveLength(0);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'warning',
                    message: expect.stringContaining('incomplete fields/references metadata'),
                }),
            ]),
        );
    });

    it('treats @relation fields as relations even when their target model is missing', () => {
        const result = convertPrismaToErdSchema(`
            model Audit {
              id        Int     @id
              missingId Int
              missing   Missing @relation(fields: [missingId], references: [id])
            }
        `);

        expect(result.schema.tables[0].columns.map((column) => column.name)).toEqual(['id', 'missingId']);
        expect(result.schema.tables[0].prisma.relationFields).toEqual([
            expect.objectContaining({
                name: 'missing',
                targetModel: 'Missing',
            }),
        ]);
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                severity: 'warning',
                message: expect.stringContaining('references unknown model Missing'),
            }),
        ]);
    });

    it('refuses to invent edges for ambiguous unnamed relations', () => {
        const result = convertPrismaToErdSchema(`
            model User {
              id       Int    @id
              authored Post[]
              edited   Post[]
            }

            model Post {
              id     Int  @id
              author User
              editor User
            }
        `);

        expect(result.schema.relations).toEqual([]);
        expect(result.diagnostics.filter((item) => item.message.includes('ambiguous relation'))).toHaveLength(4);
    });

    it('does not turn unannotated singular relation fields into a virtual ERD edge', () => {
        const result = convertPrismaToErdSchema(`
            model User {
              id      Int     @id
              profile Profile
            }

            model Profile {
              id   Int  @id
              user User
            }
        `);

        expect(result.schema.relations).toEqual([]);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'warning',
                    message: expect.stringContaining('only list-to-list relations can be implicit'),
                }),
            ]),
        );
    });

    it('does not render unsupported MongoDB implicit many-to-many relations', () => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider = "mongodb"
            }

            model User {
              id     String @id
              groups Group[]
            }

            model Group {
              id    String @id
              users User[]
            }
        `);

        expect(result.schema.relations).toEqual([]);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'warning',
                    message: expect.stringContaining('MongoDB does not support implicit many-to-many relations'),
                }),
            ]),
        );
    });

    it.each([
        [
            'a composite primary key',
            `
                model User {
                  tenantId Int
                  userId   Int
                  groups   Group[]

                  @@id([tenantId, userId])
                }

                model Group {
                  id    Int    @id
                  users User[]
                }
            `,
        ],
        [
            'a unique-only key',
            `
                model User {
                  email  String  @unique
                  groups Group[]
                }

                model Group {
                  id    Int    @id
                  users User[]
                }
            `,
        ],
        [
            'a single-field block primary key',
            `
                model User {
                  id     Int
                  groups Group[]

                  @@id([id])
                }

                model Group {
                  id    Int    @id
                  users User[]
                }
            `,
        ],
    ])('does not invent an implicit many-to-many edge when a model uses %s', (_case, models) => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider = "postgresql"
            }

            ${models}
        `);

        expect(result.schema.relations).toEqual([]);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'warning',
                    message: expect.stringContaining('both models must each define one scalar @id field'),
                }),
            ]),
        );
    });

    it('does not render relational scalar-list fields as foreign-key relations', () => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider = "postgresql"
            }

            model User {
              id       Int     @id
              groupIds Int[]
              groups   Group[] @relation(fields: [groupIds], references: [id])
            }

            model Group {
              id Int @id
            }
        `);

        expect(result.schema.relations).toEqual([]);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'warning',
                    message: expect.stringContaining('relational Prisma many-to-many relations need an implicit relation or an explicit join model'),
                }),
            ]),
        );
    });

    it('keeps valid MongoDB array relations but rejects invalid referential actions', () => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider = "mongodb"
            }

            model User {
              id       String  @id
              groupIds String[]
              groups   Group[] @relation(fields: [groupIds], references: [id], onDelete: Cascade)
            }

            model Group {
              id      String  @id
              userIds String[]
              users   User[]  @relation(fields: [userIds], references: [id])
            }
        `);

        expect(result.schema.relations).toEqual([
            expect.objectContaining({
                from: { table: 'Group', column: 'userIds' },
                to: { table: 'User', column: 'id' },
            }),
        ]);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'warning',
                    message: expect.stringContaining('MongoDB many-to-many relation and cannot define referential actions'),
                }),
            ]),
        );
    });

    it('requires an explicit name before pairing an implicit self many-to-many relation', () => {
        const result = convertPrismaToErdSchema(`
            model User {
              id        Int    @id
              followers User[]
              following User[]
            }
        `);

        expect(result.schema.relations).toEqual([]);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'warning',
                    message: expect.stringContaining('self relation and require the same explicit @relation'),
                }),
            ]),
        );
    });

    it('diagnoses invalid field types and non-attribute trailing content without losing healthy fields', () => {
        const result = convertPrismaToErdSchema(`
            model User {
              id      Int       @id
              broken String?[]  @default([])
              email   String    unique
              name    String
            }
        `);

        expect(result.schema.tables[0].columns.map((column) => column.name)).toEqual(['id', 'email', 'name']);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ severity: 'error', message: expect.stringContaining('invalid field type String?[]') }),
                expect.objectContaining({ severity: 'error', message: expect.stringContaining('unexpected content after the field type: unique') }),
            ]),
        );
    });

    it('validates explicit relation ownership, field types, and referenced uniqueness', () => {
        const result = convertPrismaToErdSchema(`
            model Parent {
              id       Int    @id
              code     String
              child    Child? @relation(fields: [], references: [])
            }

            model Child {
              id         Int    @id
              parentCode Int
              parent     Parent @relation(fields: [parentCode], references: [code])
            }
        `);

        expect(result.schema.relations).toHaveLength(1);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ message: expect.stringContaining('incomplete fields/references metadata') }),
                expect.objectContaining({ message: expect.stringContaining('incompatible field types Int and String') }),
                expect.objectContaining({ message: expect.stringContaining('must reference a unique field set') }),
            ]),
        );
    });
});
