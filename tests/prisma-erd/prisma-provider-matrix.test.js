/** Verifies provider-specific Prisma types and native database annotations. */
import { describe, expect, it } from 'vitest';
import { convertPrismaToErdSchema } from '@/features/prisma-erd/lib/prismaToSql.js';

function expectProviderSchema(source, provider, tableNames) {
    const result = convertPrismaToErdSchema(source);

    expect(result.datasource).toEqual(expect.objectContaining({ provider }));
    expect(result.schema.prisma.datasource).toEqual(expect.objectContaining({ provider }));
    expect(result.schema.tables.map((table) => table.name)).toEqual(tableNames);
    expect(result.diagnostics).toEqual([]);
    return result;
}

function messages(result) {
    return result.diagnostics.map((item) => item.message);
}

describe('Prisma provider production matrix', () => {
    it('supports a connected PostgreSQL schema with arrays, JSONB, extensions, schemas, native types, and advanced indexes', () => {
        const result = expectProviderSchema(
            `
                datasource db {
                  provider   = "postgresql"
                  relationMode = "foreignKeys"
                  schemas    = ["app", "audit"]
                  extensions = [pg_trgm, citext]
                }

                enum AccountState {
                  ACTIVE
                  LOCKED

                  @@schema("app")
                }

                model Account {
                  id        String       @id @default(uuid()) @db.Uuid
                  email     String       @unique @db.Citext
                  state     AccountState @default(ACTIVE)
                  tags      String[]
                  profile   Json         @default("{}") @db.JsonB
                  network   String?      @db.Inet
                  events    AuditEvent[]

                  @@index([profile(ops: JsonbPathOps)], type: Gin, map: "account_profile_idx")
                  @@index([network(ops: InetOps)], type: Gist)
                  @@schema("app")
                }

                model AuditEvent {
                  id         BigInt   @id @default(autoincrement()) @db.BigInt
                  accountId  String?  @db.Uuid
                  occurredAt DateTime @default(now()) @db.Timestamptz(6)
                  search     Unsupported("tsvector")?
                  account    Account? @relation(fields: [accountId], references: [id], onDelete: SetNull)

                  @@index([occurredAt(sort: Desc)])
                  @@index([accountId], where: { accountId: { not: null } }, map: "audit_account_live_idx")
                  @@schema("audit")
                }
            `,
            'postgresql',
            ['Account', 'AuditEvent'],
        );

        expect(result.datasource).toEqual(
            expect.objectContaining({
                name: 'db',
                relationMode: 'foreignKeys',
                schemas: ['app', 'audit'],
                extensions: '[pg_trgm, citext]',
            }),
        );
        expect(result.schema.tables[0].columns.find((column) => column.name === 'tags')?.extras).toContain('Scalar list');
        expect(result.schema.tables[0].prisma.indexes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'index', fields: ['profile'], raw: expect.stringContaining('JsonbPathOps') }),
                expect.objectContaining({ kind: 'index', fields: ['network'], raw: expect.stringContaining('type: Gist') }),
            ]),
        );
        expect(result.schema.relations).toEqual([
            expect.objectContaining({
                from: { table: 'AuditEvent', column: 'accountId' },
                to: { table: 'Account', column: 'id' },
                actions: { onDelete: 'SetNull' },
            }),
        ]);
    });

    it('supports a connected MySQL schema with unsigned numbers, lengths, JSON, blobs, full-text, and prefix indexes', () => {
        const result = expectProviderSchema(
            `
                datasource mysql {
                  provider = "mysql"
                }

                enum ArticleState {
                  DRAFT
                  PUBLISHED
                }

                model Author {
                  id       BigInt    @id @default(autoincrement()) @mysql.UnsignedBigInt
                  email    String    @unique(length: 191) @mysql.VarChar(255)
                  articles Article[]
                }

                model Article {
                  id          BigInt       @id @default(autoincrement()) @mysql.UnsignedBigInt
                  authorId    BigInt       @mysql.UnsignedBigInt
                  slug        String       @mysql.VarChar(255)
                  title       String       @mysql.VarChar(300)
                  body        String       @mysql.LongText
                  state       ArticleState @default(DRAFT)
                  metadata    Json         @mysql.Json
                  attachment  Bytes?       @mysql.LongBlob
                  publishedAt DateTime?    @mysql.DateTime(6)
                  author      Author       @relation(fields: [authorId], references: [id], onDelete: Cascade)

                  @@unique([authorId, slug(length: 120)], map: "article_author_slug_key")
                  @@fulltext([title, body], map: "article_search_idx")
                  @@index([publishedAt(sort: Desc)])
                }
            `,
            'mysql',
            ['Author', 'Article'],
        );

        const article = result.schema.tables[1];
        expect(article.columns.find((column) => column.name === 'metadata')?.extras).toContain('Native: @mysql.Json');
        expect(article.columns.find((column) => column.name === 'attachment')?.extras).toContain('Native: @mysql.LongBlob');
        expect(article.prisma.indexes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'unique', fields: ['authorId', 'slug'] }),
                expect.objectContaining({ kind: 'fulltext', fields: ['title', 'body'] }),
            ]),
        );
        expect(result.schema.relations).toHaveLength(1);
    });

    it('supports a connected SQL Server schema with schemas, clustered indexes, native types, and NoAction relations', () => {
        const result = expectProviderSchema(
            `
                datasource db {
                  provider = "sqlserver"
                  schemas  = ["sales", "identity"]
                }

                model Customer {
                  id       String    @id(map: "customer_pkey", clustered: true) @db.UniqueIdentifier
                  email    String    @unique(map: "customer_email_key", clustered: false) @db.NVarChar(320)
                  invoices Invoice[]

                  @@schema("identity")
                }

                model Invoice {
                  id         BigInt   @id(map: "invoice_pkey", clustered: true) @db.BigInt
                  customerId String   @db.UniqueIdentifier
                  code       String   @db.VarChar(80)
                  total      Decimal  @db.Decimal(19, 4)
                  tax        Float    @db.Money
                  issuedAt   DateTime @db.DateTimeOffset
                  signature  Bytes?   @db.VarBinary(Max)
                  customer   Customer @relation(fields: [customerId], references: [id], onDelete: NoAction, onUpdate: NoAction)

                  @@unique([customerId, code], clustered: false, map: "invoice_customer_code_key")
                  @@index([issuedAt(sort: Desc)], clustered: false, map: "invoice_issued_idx")
                  @@schema("sales")
                }
            `,
            'sqlserver',
            ['Customer', 'Invoice'],
        );

        const invoice = result.schema.tables[1];
        expect(invoice.prisma.schemaName).toBe('sales');
        expect(invoice.columns.find((column) => column.name === 'issuedAt')?.extras).toContain('Native: @db.DateTimeOffset');
        expect(invoice.columns.find((column) => column.name === 'signature')?.extras).toContain('Native: @db.VarBinary(Max)');
        expect(invoice.prisma.indexes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'unique', raw: expect.stringContaining('clustered: false') }),
                expect.objectContaining({ kind: 'index', name: 'invoice_issued_idx' }),
            ]),
        );
        expect(result.schema.relations[0].actions).toEqual({ onDelete: 'NoAction', onUpdate: 'NoAction' });
    });

    it('supports a connected modern SQLite schema with enum, JSON, partial indexes, and optional relations', () => {
        const result = expectProviderSchema(
            `
                datasource db {
                  provider = "sqlite"
                }

                enum NoteState {
                  DRAFT
                  PUBLISHED
                }

                model Folder {
                  id    Int    @id @default(autoincrement())
                  name  String
                  notes Note[]
                }

                model Note {
                  id        Int       @id @default(autoincrement())
                  folderId  Int?
                  title     String
                  state     NoteState @default(DRAFT)
                  metadata  Json      @default("{}")
                  archived  Boolean   @default(false)
                  folder    Folder?   @relation(fields: [folderId], references: [id], onDelete: SetNull)

                  @@index([title], where: { archived: false }, map: "note_active_title_idx")
                }
            `,
            'sqlite',
            ['Folder', 'Note'],
        );

        expect(result.schema.enums[0]).toEqual(expect.objectContaining({ name: 'NoteState', values: ['DRAFT', 'PUBLISHED'] }));
        expect(result.schema.tables[1].columns.find((column) => column.name === 'metadata')?.type).toBe('Json');
        expect(result.schema.tables[1].prisma.indexes[0].raw).toContain('where: { archived: false }');
        expect(result.schema.relations[0]).toEqual(expect.objectContaining({ fromCard: '0..n', actions: { onDelete: 'SetNull' } }));
    });

    it.each([
        ['postgresql', '@db.VarChar(120)', '@db.Decimal(18, 6)', '@db.Timestamptz(3)', '@db.ByteA'],
        ['mysql', '@db.VarChar(120)', '@db.Decimal(18, 6)', '@db.DateTime(3)', '@db.LongBlob'],
        ['sqlserver', '@db.NVarChar(120)', '@db.Decimal(18, 6)', '@db.DateTime2', '@db.VarBinary(Max)'],
    ])('preserves common %s native type attributes without flattening them', (provider, stringType, decimalType, dateType, bytesType) => {
        const result = expectProviderSchema(
            `
                datasource db {
                  provider = "${provider}"
                }

                model NativeTypes {
                  id        Int      @id
                  label     String   ${stringType}
                  amount    Decimal  ${decimalType}
                  createdAt DateTime ${dateType}
                  payload   Bytes?   ${bytesType}
                }
            `,
            provider,
            ['NativeTypes'],
        );
        const extras = result.schema.tables[0].columns.flatMap((column) => column.extras);
        const normalizedDecimalType = decimalType.replace(/\s+/g, '');

        expect(extras).toEqual(expect.arrayContaining([`Native: ${stringType}`, `Native: ${normalizedDecimalType}`, `Native: ${dateType}`, `Native: ${bytesType}`]));
    });
});

describe('Prisma provider-aware diagnostics and recovery', () => {
    it('explains the mssql alias while preserving the ERD', () => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider = "mssql"
            }

            model User {
              id Int @id
            }
        `);

        expect(result.schema.tables.map((table) => table.name)).toEqual(['User']);
        expect(messages(result)).toEqual(expect.arrayContaining([expect.stringContaining('Use "sqlserver"')]));
    });

    it('reports MySQL-incompatible arrays and PostgreSQL index options without losing valid fields', () => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider = "mysql"
            }

            model Item {
              id     Int      @id
              labels String[]
              title  String

              @@index([title(ops: TextOps)], type: Gin, where: { title: { not: "" } })
            }
        `);

        expect(result.schema.tables[0].columns.map((column) => column.name)).toEqual(['id', 'labels', 'title']);
        expect(messages(result)).toEqual(
            expect.arrayContaining([
                expect.stringContaining('MySQL does not support scalar lists'),
                expect.stringContaining('PostgreSQL index type or operator-class'),
                expect.stringContaining('partial index predicates'),
            ]),
        );
    });

    it('reports SQL Server enum, JSON, scalar-list, and Restrict incompatibilities while drawing the relation', () => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider = "sqlserver"
            }

            enum Role {
              USER
              ADMIN
            }

            model User {
              id       Int    @id
              role     Role
              metadata Json
              labels   String[]
              posts    Post[]
            }

            model Post {
              id       Int  @id
              authorId Int
              author   User @relation(fields: [authorId], references: [id], onDelete: Restrict)
            }
        `);

        expect(result.schema.tables.map((table) => table.name)).toEqual(['User', 'Post']);
        expect(result.schema.relations).toHaveLength(1);
        expect(messages(result)).toEqual(
            expect.arrayContaining([
                expect.stringContaining('does not support Prisma enum blocks'),
                expect.stringContaining('does not support Prisma Json fields'),
                expect.stringContaining('does not support scalar lists'),
                expect.stringContaining('does not support the Restrict referential action'),
            ]),
        );
    });

    it('reports SQLite native types, scalar lists, schemas, and full-text indexes while retaining the model', () => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider = "sqlite"
              schemas  = ["main"]
            }

            model Document {
              id      Int      @id
              title   String   @db.Text
              aliases String[]

              @@fulltext([title])
              @@schema("main")
            }
        `);

        expect(result.schema.tables.map((table) => table.name)).toEqual(['Document']);
        expect(messages(result)).toEqual(
            expect.arrayContaining([
                expect.stringContaining('datasource schemas option'),
                expect.stringContaining('does not support @@schema'),
                expect.stringContaining('does not support Prisma native type attributes'),
                expect.stringContaining('does not support scalar lists'),
                expect.stringContaining('does not support Prisma @@fulltext'),
            ]),
        );
    });

    it('reports relational composite types while preserving models that reference them', () => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider = "postgresql"
            }

            type Address {
              city String
              zip  String
            }

            model User {
              id      Int     @id
              address Address
            }
        `);

        expect(result.schema.composites.map((item) => item.name)).toEqual(['Address']);
        expect(result.schema.tables.map((table) => table.name)).toEqual(['User']);
        expect(messages(result)).toEqual(expect.arrayContaining([expect.stringContaining('only available with MongoDB')]));
    });

    it('validates native type namespaces against the datasource name', () => {
        const result = convertPrismaToErdSchema(`
            datasource primary {
              provider = "postgresql"
            }

            model User {
              id String @id @db.Uuid
            }
        `);

        expect(result.schema.tables[0].columns[0].extras).toContain('Native: @db.Uuid');
        expect(messages(result)).toEqual(expect.arrayContaining([expect.stringContaining('datasource is named primary')]));
    });

    it('validates relationMode-specific referential actions', () => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider     = "postgresql"
              relationMode = "prisma"
            }

            model Parent {
              id       Int     @id
              children Child[]
            }

            model Child {
              id       Int    @id
              parentId Int?
              parent   Parent? @relation(fields: [parentId], references: [id], onDelete: NoAction, onUpdate: SetDefault)
            }
        `);

        expect(result.schema.relations).toHaveLength(1);
        expect(messages(result)).toEqual(
            expect.arrayContaining([
                expect.stringContaining('does not support SetDefault'),
                expect.stringContaining('does not support NoAction'),
            ]),
        );
    });

    it('uses Prisma relation emulation by default for MongoDB', () => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider = "mongodb"
            }

            model Parent {
              id       String  @id @map("_id") @db.ObjectId
              childIds String[] @db.ObjectId
              children Child[] @relation(fields: [childIds], references: [id], onDelete: SetDefault)
            }

            model Child {
              id String @id @map("_id") @db.ObjectId
            }
        `);

        expect(result.datasource).toEqual(expect.objectContaining({ provider: 'mongodb', relationMode: 'prisma' }));
        expect(result.schema.prisma.datasource).toEqual(expect.objectContaining({ provider: 'mongodb', relationMode: 'prisma' }));
        expect(messages(result)).toEqual(expect.arrayContaining([expect.stringContaining('does not support SetDefault')]));
    });

    it('rejects foreign-key relation mode for MongoDB while preserving a usable schema', () => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider     = "mongodb"
              relationMode = "foreignKeys"
            }

            model User {
              id String @id @map("_id") @db.ObjectId
            }
        `);

        expect(result.datasource).toEqual(expect.objectContaining({ provider: 'mongodb', relationMode: 'prisma' }));
        expect(result.schema.tables.map((table) => table.name)).toEqual(['User']);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'error',
                    message: expect.stringContaining('MongoDB, which only supports relationMode = "prisma"'),
                }),
            ]),
        );
    });

    it.each([
        ['postgresql', 'warning'],
        ['mysql', 'error'],
        ['sqlite', 'error'],
        ['sqlserver', 'error'],
    ])('diagnoses SetNull on required relation fields for %s without dropping the edge', (provider, severity) => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider = "${provider}"
            }

            model Parent {
              id       Int     @id
              children Child[]
            }

            model Child {
              id       Int    @id
              parentId Int
              parent   Parent @relation(fields: [parentId], references: [id], onDelete: SetNull)
            }
        `);
        const diagnostic = result.diagnostics.find((item) => item.message.includes('SetNull with required relation scalar fields'));

        expect(result.schema.relations).toHaveLength(1);
        expect(diagnostic).toEqual(expect.objectContaining({ severity }));
    });

    it('recovers models after a broken datasource block', () => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider = "postgresql"

            model User {
              id Int @id
            }

            model Post {
              id Int @id
            }
        `);

        expect(result.schema.tables.map((table) => table.name)).toEqual(['User', 'Post']);
        expect(messages(result)).toEqual(expect.arrayContaining([expect.stringContaining('Missing closing brace for datasource db')]));
    });

    it('reports duplicate datasources and still uses the first connector for compatibility checks', () => {
        const result = convertPrismaToErdSchema(`
            datasource primary {
              provider = "postgresql"
            }

            datasource secondary {
              provider = "mysql"
            }

            model User {
              id   Int      @id
              tags String[]
            }
        `);

        expect(result.datasource.provider).toBe('postgresql');
        expect(result.schema.tables.map((table) => table.name)).toEqual(['User']);
        expect(messages(result)).toEqual(expect.arrayContaining([expect.stringContaining('only one datasource')]));
        expect(messages(result).some((message) => message.includes('does not support scalar lists'))).toBe(false);
    });

    it('keeps model-only snippets permissive when no datasource was pasted', () => {
        const result = convertPrismaToErdSchema(`
            model PortableSnippet {
              id     Int      @id
              labels String[]
              data   Json
            }
        `);

        expect(result.datasource).toBeNull();
        expect(result.schema.tables.map((table) => table.name)).toEqual(['PortableSnippet']);
        expect(result.diagnostics).toEqual([]);
    });
});
