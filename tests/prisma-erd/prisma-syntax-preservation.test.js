import { describe, expect, it } from 'vitest';
import { convertPrismaToErdSchema } from '@/features/prisma-erd/lib/prismaToSql.js';

function stripSourceLocations(value) {
    if (Array.isArray(value)) return value.map(stripSourceLocations);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.entries(value)
            .filter(([key]) => !['line', 'fromLine', 'toLine'].includes(key))
            .map(([key, item]) => [key, stripSourceLocations(item)]),
    );
}

function schemaShape(source) {
    const result = convertPrismaToErdSchema(source);
    return {
        diagnostics: result.diagnostics,
        tables: result.schema.tables.map((table) => ({
            name: table.name,
            columns: table.columns.map((column) => ({
                name: column.name,
                type: column.type,
                constraints: column.constraints,
                extras: column.extras,
                pk: !!column.pk,
                fk: !!column.fk,
            })),
            relationFields: table.prisma.relationFields.map(({ attributes: _attributes, ...field }) => stripSourceLocations(field)),
            indexes: table.prisma.indexes.map(({ raw: _raw, ...index }) => index),
        })),
        relations: stripSourceLocations(result.schema.relations),
        enums: stripSourceLocations(result.schema.enums),
        composites: stripSourceLocations(result.schema.composites),
        stats: result.stats,
    };
}

describe('Prisma syntax preservation', () => {
    it('produces the same ERD for compact and formatter-expanded syntax', () => {
        const compact = `
            enum Role {
              USER
              ADMIN @map("administrator")
            }

            model User {
              id String @id @default(uuid()) @map("user_id") @db.Uuid
              role Role @default(USER)
              posts Post[] @relation("WrittenPosts")
              @@index([role], map: "users_role_idx")
              @@map("users")
            }

            model Post {
              id String @id @default(cuid())
              authorId String @map("author_id") @db.Uuid
              author User @relation("WrittenPosts", fields: [authorId], references: [id], onDelete: Cascade, map: "posts_author_fkey")
              @@map("posts")
            }
        `;
        const expanded = `
            enum Role {
              USER
              ADMIN
                    @map("administrator")
            }

            model User {
              id String
                        @id
                        @default(
                          uuid()
                        )
                        @map("user_id")
                        @db.Uuid
              role  Role   @default(USER)
              posts Post[]
                           @relation("WrittenPosts")

              @@index(
                [role],
                map: "users_role_idx"
              )
              @@map("users")
            }

            model Post {
              id       String @id @default(cuid())
              authorId String @map("author_id") @db.Uuid
              author   User
                              @relation(
                                "WrittenPosts",
                                fields: [authorId],
                                references: [id],
                                onDelete: Cascade,
                                map: "posts_author_fkey"
                              )

              @@map("posts")
            }
        `;

        expect(schemaShape(expanded)).toEqual(schemaShape(compact));
    });

    it('preserves all scalar, enum, composite, list, optional, and unsupported field types', () => {
        const result = convertPrismaToErdSchema(`
            enum State {
              READY
            }

            type Metadata {
              label String
            }

            model TypeGallery {
              id          Int                    @id
              stringValue String
              booleanVal  Boolean
              intValue    Int
              bigIntValue BigInt
              floatValue  Float
              decimalVal  Decimal
              dateValue   DateTime
              jsonValue   Json
              bytesValue  Bytes
              enumValue   State
              composite   Metadata?
              stringList  String[]
              unsupported Unsupported("geography(Point,4326)")?
            }
        `);

        expect(result.diagnostics).toEqual([]);
        expect(result.schema.tables[0].columns.map((column) => [column.name, column.type])).toEqual([
            ['id', 'Int'],
            ['stringValue', 'String'],
            ['booleanVal', 'Boolean'],
            ['intValue', 'Int'],
            ['bigIntValue', 'BigInt'],
            ['floatValue', 'Float'],
            ['decimalVal', 'Decimal'],
            ['dateValue', 'DateTime'],
            ['jsonValue', 'Json'],
            ['bytesValue', 'Bytes'],
            ['enumValue', 'State'],
            ['composite', 'Metadata?'],
            ['stringList', 'String[]'],
            ['unsupported', 'Unsupported("geography(Point,4326)")?'],
        ]);
    });

    it.each([
        ['required many-to-one', 'Int', '', 'n'],
        ['optional many-to-one', 'Int?', '?', '0..n'],
        ['required one-to-one', 'Int', ' @unique', '1'],
        ['optional one-to-one', 'Int?', '? @unique', '0..1'],
    ])('retains %s cardinality', (_label, scalarType, relationOptional, expectedCardinality) => {
        const result = convertPrismaToErdSchema(`
            model Parent {
              id       Int     @id
              children Child[]
            }

            model Child {
              id       Int     @id
              parentId ${scalarType}${relationOptional.includes('@unique') ? ' @unique' : ''}
              parent   Parent${relationOptional.startsWith('?') ? '?' : ''} @relation(fields: [parentId], references: [id])
            }
        `);

        expect(result.diagnostics).toEqual([]);
        expect(result.schema.relations).toEqual([
            expect.objectContaining({
                from: { table: 'Child', column: 'parentId' },
                to: { table: 'Parent', column: 'id' },
                fromCard: expectedCardinality,
                toCard: '1',
            }),
        ]);
    });

    it.each(['Cascade', 'Restrict', 'NoAction', 'SetNull', 'SetDefault'])('retains the %s referential action', (action) => {
        const optional = action === 'SetNull';
        const result = convertPrismaToErdSchema(`
            model Parent {
              id       Int     @id
              children Child[]
            }

            model Child {
              id       Int     @id
              parentId Int${optional ? '?' : ''}
              parent   Parent${optional ? '?' : ''} @relation(fields: [parentId], references: [id], onDelete: ${action}, onUpdate: ${action})
            }
        `);

        expect(result.diagnostics).toEqual([]);
        expect(result.schema.relations[0].actions).toEqual({
            onDelete: action,
            onUpdate: action,
        });
    });

    it('preserves field attributes, relation attributes, block attributes, and enum mappings as metadata', () => {
        const result = convertPrismaToErdSchema(`
            enum Status {
              ACTIVE
                     @map(name: "active_status")

              @@map(name: "status_type")
            }

            model Account {
              id       String  @id @default(uuid()) @map(name: "account_id") @db.Uuid
              ownerId  String  @map("owner_id") @db.Uuid
              owner    User    @relation(name: "AccountOwner", fields: [ownerId], references: [id], map: "account_owner_fkey")
              status   Status  @default(ACTIVE)

              @@index([ownerId], map: "account_owner_idx")
              @@map(name: "accounts")
              @@schema(name: "identity")
            }

            model User {
              id       String    @id @db.Uuid
              accounts Account[] @relation("AccountOwner")

              @@schema("identity")
            }
        `);

        expect(result.diagnostics).toEqual([]);
        const account = result.schema.tables.find((table) => table.name === 'Account');
        const id = account.columns.find((column) => column.name === 'id');

        expect(id.prisma.attributes).toBe('@id @default(uuid()) @map(name: "account_id") @db.Uuid');
        expect(account.prisma.relationFields[0].attributes).toContain('@relation(name: "AccountOwner"');
        expect(account.prisma.blockAttributes.map((attribute) => attribute.text)).toEqual([
            '@@index([ownerId], map: "account_owner_idx")',
            '@@map(name: "accounts")',
            '@@schema(name: "identity")',
        ]);
        expect(result.schema.enums[0].prisma).toEqual(
            expect.objectContaining({
                dbName: 'status_type',
                values: [{ name: 'ACTIVE', dbName: 'active_status' }],
            }),
        );
    });

    it('supports two distinct implicit many-to-many relations between the same models', () => {
        const result = convertPrismaToErdSchema(`
            model User {
              id        Int    @id
              upvotes   Post[] @relation("PostUpvotes")
              bookmarks Post[] @relation("PostBookmarks")
            }

            model Post {
              id           Int    @id
              upvotedBy    User[] @relation("PostUpvotes")
              bookmarkedBy User[] @relation("PostBookmarks")
            }
        `);

        expect(result.diagnostics).toEqual([]);
        expect(result.stats.relationCount).toBe(2);
        expect(result.schema.relations.map((relation) => relation.prisma.relationName).sort()).toEqual(['PostBookmarks', 'PostUpvotes']);
    });

    it('supports explicit self-relations without adding a duplicate virtual edge', () => {
        const result = convertPrismaToErdSchema(`
            model Category {
              id       Int        @id
              parentId Int?
              parent   Category?  @relation("CategoryTree", fields: [parentId], references: [id], onDelete: SetNull)
              children Category[] @relation("CategoryTree")
            }
        `);

        expect(result.diagnostics).toEqual([]);
        expect(result.schema.relations).toEqual([
            expect.objectContaining({
                from: { table: 'Category', column: 'parentId' },
                to: { table: 'Category', column: 'id' },
                actions: { onDelete: 'SetNull' },
                prisma: expect.objectContaining({
                    kind: 'explicit',
                    relationName: 'CategoryTree',
                }),
            }),
        ]);
    });

    it('keeps line locations stable after comments and multiline attributes', () => {
        const result = convertPrismaToErdSchema(`// line 1
model User {
  // line 3
  id String
            @id
            @default(uuid())
  email String
}

model Post {
  id Int @id
  broken
}`);

        expect(result.schema.tables.find((table) => table.name === 'User').columns.find((column) => column.name === 'id')?.prisma.line).toBe(4);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'error',
                    message: expect.stringContaining('invalid field declaration'),
                    line: 12,
                }),
            ]),
        );
    });
});
