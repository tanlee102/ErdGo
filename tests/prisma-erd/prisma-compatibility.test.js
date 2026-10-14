import { describe, expect, it } from 'vitest';
import { convertPrismaToErdSchema } from '@/features/prisma-erd/lib/prismaToSql.js';

function expectValidSchema(source, expectedTables) {
    const result = convertPrismaToErdSchema(source);
    expect(result.schema.tables.map((table) => table.name)).toEqual(expectedTables);
    expect(result.diagnostics).toEqual([]);
    return result;
}

describe('Prisma paste compatibility corpus', () => {
    it('preserves formatter-style multiline field attributes and relation arguments', () => {
        const result = expectValidSchema(
            `
                datasource main {
                  provider = "postgresql"
                  url      = env("DATABASE_URL")
                }

                model User {
                  id    String
                              @id
                              @default(uuid(7))
                              @map(name: "user_id")
                              @main.Uuid
                  email String
                              @unique(map: "users_email_key")
                              @main.VarChar(320)
                  posts Post[] @relation("WrittenPosts")

                  @@map(name: "users")
                }

                model Post {
                  id       String @id @default(cuid(2))
                  authorId String @map("author_id") @main.Uuid
                  author   User
                                 @relation(
                                   name: "WrittenPosts",
                                   fields: [authorId],
                                   references: [id],
                                   onDelete: Cascade,
                                   map: "posts_author_fkey"
                                 )

                  @@map("posts")
                }
            `,
            ['User', 'Post'],
        );

        const user = result.schema.tables[0];
        const id = user.columns.find((column) => column.name === 'id');
        const email = user.columns.find((column) => column.name === 'email');

        expect(user.prisma.dbName).toBe('users');
        expect(id.prisma.dbName).toBe('user_id');
        expect(id.extras).toEqual(expect.arrayContaining(['Default: uuid(7)', 'Native: @main.Uuid', '@map("user_id")', '@@map("users")']));
        expect(email.constraints).toEqual(expect.arrayContaining(['UQ', 'NN']));
        expect(email.extras).toContain('Native: @main.VarChar(320)');
        expect(result.schema.relations).toEqual([
            expect.objectContaining({
                from: { table: 'Post', column: 'authorId' },
                to: { table: 'User', column: 'id' },
                fkName: 'posts_author_fkey',
                actions: { onDelete: 'Cascade' },
                prisma: expect.objectContaining({ relationName: 'WrittenPosts' }),
            }),
        ]);
    });

    it('accepts modern PostgreSQL indexes, schemas, native types, and partial predicates', () => {
        const result = expectValidSchema(
            `
                generator client {
                  provider        = "prisma-client"
                  output          = "./generated"
                  previewFeatures = ["partialIndexes"]
                }

                datasource postgres {
                  provider   = "postgresql"
                  schemas    = ["auth", "public"]
                  extensions = [pg_trgm]
                }

                enum LoginState {
                  ACTIVE
                  LOCKED

                  @@schema("auth")
                }

                model Login {
                  id        String     @id @default(uuid()) @postgres.Uuid
                  email     String     @postgres.Citext
                  state     LoginState @default(ACTIVE)
                  network   String?    @postgres.Inet
                  metadata  Json       @default("{}") @postgres.JsonB
                  deletedAt DateTime?  @postgres.Timestamptz(6)

                  @@unique([email], where: { deletedAt: null }, map: "login_email_live_key")
                  @@index([network(ops: InetOps)], type: Gist, map: "login_network_idx")
                  @@index([metadata(ops: JsonbPathOps)], type: Gin)
                  @@schema("auth")
                }
            `,
            ['Login'],
        );

        const login = result.schema.tables[0];
        expect(login.prisma.schemaName).toBe('auth');
        expect(login.prisma.indexes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'unique', fields: ['email'], name: 'login_email_live_key', raw: expect.stringContaining('where: { deletedAt: null }') }),
                expect.objectContaining({ kind: 'index', fields: ['network'], name: 'login_network_idx', raw: expect.stringContaining('InetOps') }),
                expect.objectContaining({ kind: 'index', fields: ['metadata'], raw: expect.stringContaining('JsonbPathOps') }),
            ]),
        );
        expect(login.columns.find((column) => column.name === 'email')?.constraints).toContain('PUQ');
        expect(login.columns.find((column) => column.name === 'network')?.extras).toContain('Native: @postgres.Inet');
        expect(result.schema.enums[0].prisma.schemaName).toBe('auth');
    });

    it('accepts MySQL length options, unsigned native types, and full-text indexes', () => {
        const result = expectValidSchema(
            `
                datasource mysql {
                  provider = "mysql"
                  url      = env("DATABASE_URL")
                }

                model Article {
                  id          BigInt    @id @default(autoincrement()) @mysql.UnsignedBigInt
                  slug        String    @unique(length: 191) @mysql.VarChar(255)
                  title       String    @mysql.VarChar(300)
                  body        String    @mysql.LongText
                  published   Boolean   @default(false) @mysql.TinyInt(1)
                  publishedAt DateTime? @mysql.DateTime(6)
                  payload     Bytes?    @mysql.MediumBlob

                  @@fulltext([title, body], map: "article_search_idx")
                  @@index([slug(length: 100), publishedAt(sort: Desc)], map: "article_slug_date_idx")
                }
            `,
            ['Article'],
        );

        const article = result.schema.tables[0];
        expect(article.columns.find((column) => column.name === 'id')?.extras).toContain('Native: @mysql.UnsignedBigInt');
        expect(article.columns.find((column) => column.name === 'body')?.constraints).toContain('IDX');
        expect(article.columns.find((column) => column.name === 'publishedAt')?.extras).toContain('Native: @mysql.DateTime(6)');
        expect(article.prisma.indexes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'fulltext', fields: ['title', 'body'] }),
                expect.objectContaining({ kind: 'index', fields: ['slug', 'publishedAt'], raw: expect.stringContaining('length: 100') }),
            ]),
        );
    });

    it('accepts SQL Server clustered options and connector-specific native types', () => {
        const result = expectValidSchema(
            `
                datasource sqlserver {
                  provider = "sqlserver"
                  url      = env("DATABASE_URL")
                }

                model Invoice {
                  id        Int      @id(map: "invoice_pkey", clustered: false)
                  code      String   @unique(map: "invoice_code_key", clustered: false) @sqlserver.NVarChar(80)
                  total     Decimal  @sqlserver.Money
                  issuedAt  DateTime @sqlserver.DateTime2
                  signature Bytes?   @sqlserver.VarBinary(Max)

                  @@index([issuedAt(sort: Desc)], clustered: false, map: "invoice_issued_idx")
                }
            `,
            ['Invoice'],
        );

        const invoice = result.schema.tables[0];
        expect(invoice.columns.find((column) => column.name === 'code')?.extras).toContain('Native: @sqlserver.NVarChar(80)');
        expect(invoice.columns.find((column) => column.name === 'total')?.extras).toContain('Native: @sqlserver.Money');
        expect(invoice.prisma.indexes[0]).toEqual(expect.objectContaining({ fields: ['issuedAt'], name: 'invoice_issued_idx', raw: expect.stringContaining('clustered: false') }));
    });

    it('accepts CockroachDB sequences, scalar lists, and mapped schemas', () => {
        const result = expectValidSchema(
            `
                datasource crdb {
                  provider = "cockroachdb"
                  schemas  = ["app"]
                }

                model Metric {
                  id         BigInt   @id @default(sequence()) @crdb.Int8
                  externalId String   @default(uuid()) @map("external_id") @crdb.Uuid
                  labels     String[] @default([])
                  value      Decimal  @crdb.Decimal(30, 10)
                  capturedAt DateTime @default(now()) @map("captured_at") @crdb.Timestamptz(6)

                  @@index([capturedAt(sort: Desc)])
                  @@schema(name: "app")
                }
            `,
            ['Metric'],
        );

        const metric = result.schema.tables[0];
        expect(metric.prisma.schemaName).toBe('app');
        expect(metric.columns.find((column) => column.name === 'labels')?.extras).toEqual(expect.arrayContaining(['Default: []', 'Scalar list']));
        expect(metric.columns.find((column) => column.name === 'value')?.extras).toContain('Native: @crdb.Decimal(30,10)');
    });

    it('accepts SQLite relations and all referential actions without native type assumptions', () => {
        const result = expectValidSchema(
            `
                datasource sqlite {
                  provider = "sqlite"
                  url      = "file:./dev.db"
                }

                model Parent {
                  id       Int     @id @default(autoincrement())
                  children Child[]
                }

                model Child {
                  id       Int    @id @default(autoincrement())
                  parentId Int?
                  parent   Parent? @relation(fields: [parentId], references: [id], onDelete: SetNull, onUpdate: Cascade)
                }
            `,
            ['Parent', 'Child'],
        );

        expect(result.schema.relations).toEqual([
            expect.objectContaining({
                from: { table: 'Child', column: 'parentId' },
                to: { table: 'Parent', column: 'id' },
                fromCard: '0..n',
                actions: { onDelete: 'SetNull', onUpdate: 'Cascade' },
            }),
        ]);
    });

    it('accepts MongoDB composite attributes, nested paths, and explicit many-to-many ID arrays', () => {
        const result = expectValidSchema(
            `
                datasource mongo {
                  provider = "mongodb"
                  url      = env("DATABASE_URL")
                }

                type City {
                  name String @map(name: "city_name")
                }

                type Address {
                  city City
                  zip  String @default("unknown") @map("postal_code")
                }

                model User {
                  id          String     @id @default(auto()) @map("_id") @mongo.ObjectId
                  email       String     @unique
                  address     Address
                  categoryIDs String[]   @mongo.ObjectId
                  categories  Category[] @relation(fields: [categoryIDs], references: [id])

                  @@unique([email, address.city.name])
                  @@index([address.city.name])
                }

                model Category {
                  id      String   @id @default(auto()) @map("_id") @mongo.ObjectId
                  userIDs String[] @mongo.ObjectId
                  users   User[]   @relation(fields: [userIDs], references: [id])
                }
            `,
            ['User', 'Category'],
        );

        const user = result.schema.tables.find((table) => table.name === 'User');
        const address = user.columns.find((column) => column.name === 'address');
        const zip = result.schema.composites.find((type) => type.name === 'Address').fields.find((field) => field.name === 'zip');

        expect(address.constraints).toContain('UQ');
        expect(address.compositeUq).toBe(true);
        expect(user.prisma.indexes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'unique', fields: ['email', 'address.city.name'] }),
                expect.objectContaining({ kind: 'index', fields: ['address.city.name'] }),
            ]),
        );
        expect(zip.prisma).toEqual(
            expect.objectContaining({
                dbName: 'postal_code',
                attributes: '@default("unknown") @map("postal_code")',
            }),
        );
        expect(result.schema.relations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ from: { table: 'User', column: 'categoryIDs' }, to: { table: 'Category', column: 'id' } }),
                expect.objectContaining({ from: { table: 'Category', column: 'userIDs' }, to: { table: 'User', column: 'id' } }),
            ]),
        );
    });

    it('preserves every current scalar default form without merging neighboring fields', () => {
        const result = expectValidSchema(
            `
                enum Role {
                  USER
                  ADMIN
                }

                model Defaults {
                  id        String   @id @default(uuid(7))
                  cuidValue String   @default(cuid(2))
                  uuidValue String   @default(uuid(4))
                  ulidValue String   @default(ulid())
                  nanoValue String   @default(nanoid())
                  generated String   @default(dbgenerated("lower(hex(randomblob(16)))"))
                  count     Int      @default(42)
                  ratio     Float    @default(-1.25)
                  enabled   Boolean  @default(true)
                  tags      String[] @default(["alpha", "beta"])
                  roles     Role[]   @default([USER, ADMIN])
                  data      Json     @default("{\\"ok\\":true}")
                  createdAt DateTime @default(now())
                }
            `,
            ['Defaults'],
        );

        const defaults = new Map(result.schema.tables[0].columns.map((column) => [column.name, column]));
        expect(defaults.get('id').extras).toContain('Default: uuid(7)');
        expect(defaults.get('generated').extras).toContain('Default: dbgenerated("lower(hex(randomblob(16)))")');
        expect(defaults.get('ratio').extras).toContain('Default: -1.25');
        expect(defaults.get('tags').extras).toEqual(expect.arrayContaining(['Default: ["alpha", "beta"]', 'Scalar list']));
        expect(defaults.get('roles').extras).toEqual(expect.arrayContaining(['Default: [USER, ADMIN]', 'Scalar list']));
        expect(defaults.get('data').extras).toContain('Default: "{\\"ok\\":true}"');
        expect(defaults.size).toBe(13);
    });

    it('keeps parallel named relations distinct in positional and named forms', () => {
        const result = expectValidSchema(
            `
                model User {
                  id        Int    @id
                  authored  Post[] @relation("AuthoredPosts")
                  reviewed  Post[] @relation(name: "ReviewedPosts")
                }

                model Post {
                  id         Int  @id
                  authorId   Int
                  reviewerId Int?
                  author     User @relation("AuthoredPosts", fields: [authorId], references: [id])
                  reviewer   User? @relation(name: "ReviewedPosts", fields: [reviewerId], references: [id])
                }
            `,
            ['User', 'Post'],
        );

        expect(result.schema.relations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ from: { table: 'Post', column: 'authorId' }, fkName: 'AuthoredPosts' }),
                expect.objectContaining({ from: { table: 'Post', column: 'reviewerId' }, fkName: 'ReviewedPosts' }),
            ]),
        );
        expect(result.stats.relationCount).toBe(2);
    });

    it('keeps composite keys, named fields arguments, sort options, and mapped constraints', () => {
        const result = expectValidSchema(
            `
                model TenantUser {
                  tenantId String
                  userId   String
                  email    String

                  @@id(name: "tenantUserId", fields: [tenantId, userId], map: "tenant_user_pkey")
                  @@unique(name: "tenantEmail", fields: [tenantId, email(sort: Desc)], map: "tenant_email_key")
                }
            `,
            ['TenantUser'],
        );

        const table = result.schema.tables[0];
        expect(table.columns.find((column) => column.name === 'tenantId')).toEqual(expect.objectContaining({ pk: true, compositePk: true }));
        expect(table.columns.find((column) => column.name === 'email')).toEqual(
            expect.objectContaining({
                compositeUq: true,
                constraints: expect.arrayContaining(['UQ', 'NN']),
            }),
        );
        expect(table.prisma.indexes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'id', fields: ['tenantId', 'userId'], name: 'tenant_user_pkey' }),
                expect.objectContaining({ kind: 'unique', fields: ['tenantId', 'email'], name: 'tenant_email_key', raw: expect.stringContaining('email(sort: Desc)') }),
            ]),
        );
    });

    it('handles CRLF, documentation comments, URLs, braces, and comment markers inside strings', () => {
        const source = `
            /// A documented model.
            model Endpoint {
              id      Int    @id
              url     String @default("https://example.com/a//b")
              pattern String @default("/* literal */ { still text }")
            }
        `.replace(/\n/g, '\r\n');

        const result = expectValidSchema(source, ['Endpoint']);
        expect(result.schema.tables[0].columns.find((column) => column.name === 'url')?.extras).toContain('Default: "https://example.com/a//b"');
        expect(result.schema.tables[0].columns.find((column) => column.name === 'pattern')?.extras).toContain('Default: "/* literal */ { still text }"');
    });

    it('parses a large connected schema without losing tables, fields, indexes, or relations', () => {
        const modelCount = 120;
        const source = Array.from({ length: modelCount }, (_, index) => {
            const previous =
                index > 0
                    ? `
                  previousId Int?
                  previous   Model${index - 1}? @relation(fields: [previousId], references: [id], onDelete: SetNull)`
                    : '';
            const next = index < modelCount - 1 ? `\n                  next       Model${index + 1}[]` : '';

            return `
                model Model${index} {
                  id     Int      @id @default(autoincrement())
                  code   String   @unique
                  labels String[] @default([])${previous}${next}

                  @@index([code], map: "model_${index}_code_idx")
                }
            `;
        }).join('\n');

        const result = convertPrismaToErdSchema(source);

        expect(result.diagnostics).toEqual([]);
        expect(result.schema.tables).toHaveLength(modelCount);
        expect(result.stats).toEqual(
            expect.objectContaining({
                modelCount,
                relationCount: modelCount - 1,
            }),
        );
        expect(result.schema.tables.every((table) => table.columns.length === 4 || table.columns.length === 3)).toBe(true);
        expect(result.schema.tables.every((table) => table.prisma.indexes.some((index) => index.fields.includes('code')))).toBe(true);
        expect(result.schema.relations.every((relation) => relation.actions?.onDelete === 'SetNull')).toBe(true);
    });
});

describe('Prisma paste recovery and diagnostics', () => {
    it('retains later fields and models while an earlier attribute is unfinished', () => {
        const result = convertPrismaToErdSchema(`
            model Draft {
              id    String @id @default(cuid(
              name  String
              email String @unique
            }

            model Stable {
              id Int @id
            }
        `);

        expect(result.schema.tables.map((table) => table.name)).toEqual(['Draft', 'Stable']);
        expect(result.schema.tables[0].columns.map((column) => column.name)).toEqual(['id', 'name', 'email']);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'error',
                    message: expect.stringContaining('unbalanced field or attribute delimiters'),
                }),
            ]),
        );
    });

    it('does not draw relations that point at missing scalar fields', () => {
        const result = convertPrismaToErdSchema(`
            model User {
              id    Int    @id
              posts Post[]
            }

            model Post {
              id     Int  @id
              author User @relation(fields: [missingAuthorId], references: [id])
            }
        `);

        expect(result.schema.tables.map((table) => table.name)).toEqual(['User', 'Post']);
        expect(result.schema.relations).toEqual([]);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'warning',
                    message: expect.stringContaining('missingAuthorId'),
                }),
            ]),
        );
    });

    it('does not fabricate an edge between mismatched named relations', () => {
        const result = convertPrismaToErdSchema(`
            model User {
              id        Int    @id
              favorites Post[] @relation("Favorites")
            }

            model Post {
              id       Int    @id
              watchers User[] @relation("Watchers")
            }
        `);

        expect(result.schema.relations).toEqual([]);
        expect(result.diagnostics.filter((item) => item.message.includes('without fields/references metadata'))).toHaveLength(2);
    });

    it.each([
        ['unterminated string', 'model Broken { id String @default("oops) }', 'Unterminated string'],
        ['unterminated block comment', '/* never closed\nmodel Hidden { id Int @id }', 'Unterminated block comment'],
    ])('reports an %s with a precise lexical diagnostic', (_label, source, expectedMessage) => {
        const result = convertPrismaToErdSchema(source);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'error',
                    message: expect.stringContaining(expectedMessage),
                    line: 1,
                }),
            ]),
        );
    });
});
