/** Regression coverage for structural Prisma semantics and SQL export fidelity. */
import { describe, expect, it } from 'vitest';
import {
    convertPrismaToErdSchema,
    convertPrismaToSql,
} from '@/features/prisma-erd/lib/prismaToSql.js';

function messages(result) {
    return result.diagnostics.map((diagnostic) => diagnostic.message);
}

describe('Prisma conversion correctness regressions', () => {
    it('diagnoses invalid identity definitions without dropping healthy neighboring models', () => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider = "postgresql"
            }

            model Healthy {
              id Int @id
            }

            model MultipleIds {
              first  Int @id
              second Int @id
            }

            model OptionalId {
              id Int? @id
            }

            model OptionalCompoundUnique {
              tenantId  Int
              externalId String?

              @@unique([tenantId, externalId])
            }

            model NoIdentity {
              value String
            }
        `);

        expect(result.schema.tables.map((table) => table.name)).toEqual([
            'Healthy',
            'MultipleIds',
            'OptionalId',
            'OptionalCompoundUnique',
            'NoIdentity',
        ]);
        expect(messages(result)).toEqual(expect.arrayContaining([
            expect.stringContaining('MultipleIds can define only one ID'),
            expect.stringContaining('OptionalId.id uses @id but is optional'),
            expect.stringContaining('OptionalCompoundUnique @@unique fields must be required'),
            expect.stringContaining('NoIdentity has no unique identifier'),
        ]));
    });

    it('does not treat multiple invalid IDs as one compound unique target', () => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider = "postgresql"
            }

            model Parent {
              first    Int @id
              second   Int @id
              children Child[]
            }

            model Child {
              id       Int @id
              parentId Int
              parent   Parent @relation(fields: [parentId], references: [first])
            }
        `);

        expect(result.schema.relations).toHaveLength(1);
        expect(messages(result)).toEqual(expect.arrayContaining([
            expect.stringContaining('Parent can define only one ID'),
            expect.stringContaining('must reference a unique field set on Parent'),
        ]));
    });

    it('reports mismatched opposite relation names while retaining the recoverable foreign-key edge', () => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider = "postgresql"
            }

            model User {
              id      Int    @id
              written Post[] @relation("WrittenPosts")
            }

            model Post {
              id       Int  @id
              authorId Int
              author   User @relation("AuthoredPosts", fields: [authorId], references: [id])
            }
        `);

        expect(result.schema.relations).toHaveLength(1);
        expect(messages(result)).toEqual(expect.arrayContaining([
            expect.stringContaining('User.written has no matching opposite relation field'),
            expect.stringContaining('Post.author has no matching opposite relation field'),
        ]));
    });

    it('reports incompatible native database types on relation scalar pairs', () => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider = "postgresql"
            }

            model User {
              id    String @id @db.Uuid
              posts Post[]
            }

            model Post {
              id       Int    @id
              authorId String @db.VarChar(36)
              author   User   @relation(fields: [authorId], references: [id])
            }
        `);

        expect(result.schema.relations).toHaveLength(1);
        expect(messages(result)).toContain(
            'Post.author uses incompatible native types @db.VarChar(36) and @db.Uuid.',
        );
    });

    it('enforces MongoDB identity rules while preserving valid ObjectId relations', () => {
        const result = convertPrismaToErdSchema(`
            datasource mongo {
              provider = "mongodb"
            }

            model User {
              id    String @id @default(auto()) @map("_id") @mongo.ObjectId
              posts Post[]
            }

            model Post {
              id       String @id @default(auto()) @map("_id") @mongo.ObjectId
              authorId String @mongo.ObjectId
              author   User   @relation(fields: [authorId], references: [id])
            }

            model InvalidCompound {
              tenant String
              key    String

              @@id([tenant, key])
            }

            model MissingIdMap {
              id String @id
            }
        `);

        expect(result.schema.relations).toHaveLength(1);
        expect(messages(result)).toEqual(expect.arrayContaining([
            expect.stringContaining('MongoDB does not support @@id'),
            expect.stringContaining('InvalidCompound must define exactly one field-level @id'),
            expect.stringContaining('MissingIdMap.id must map to MongoDB _id'),
        ]));
    });

    it('qualifies mapped schemas and preserves referential actions in SQL export', () => {
        const result = convertPrismaToSql(`
            datasource db {
              provider = "postgresql"
              schemas  = ["auth", "content"]
            }

            enum Role {
              MEMBER
              ADMIN

              @@map("roles")
              @@schema("auth")
            }

            model User {
              id    Int    @id @map("user_id")
              role  Role
              posts Post[]

              @@map("users")
              @@schema("auth")
            }

            model Post {
              id       Int  @id
              authorId Int  @map("author_id")
              author   User @relation(
                fields: [authorId],
                references: [id],
                onDelete: Cascade,
                onUpdate: Restrict,
                map: "posts_author_fkey"
              )

              @@index([authorId], map: "posts_author_idx")
              @@map("posts")
              @@schema("content")
            }
        `);

        expect(result.sql).toContain('CREATE TYPE "auth"."roles" AS ENUM');
        expect(result.sql).toContain('CREATE TABLE "auth"."users"');
        expect(result.sql).toContain('"role" "auth"."roles" NOT NULL');
        expect(result.sql).toContain('CREATE TABLE "content"."posts"');
        expect(result.sql).toContain(
            'CONSTRAINT "posts_author_fkey" FOREIGN KEY ("author_id") REFERENCES "auth"."users" ("user_id") ON DELETE CASCADE ON UPDATE RESTRICT',
        );
        expect(result.sql).toContain(
            'CREATE INDEX "posts_author_idx" ON "content"."posts" ("author_id")',
        );
        expect(result.stats.relationCount).toBe(1);
    });

    it('validates multi-schema membership and mapped table collisions by schema', () => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider = "postgresql"
              schemas  = ["base", "shop"]
            }

            model MissingSchema {
              id Int @id
            }

            model UnknownSchema {
              id Int @id

              @@schema("other")
            }

            model BaseConfig {
              id Int @id

              @@map("config")
              @@schema("base")
            }

            model DuplicateConfig {
              id Int @id

              @@map("config")
              @@schema("base")
            }

            model ShopConfig {
              id Int @id

              @@map("config")
              @@schema("shop")
            }
        `);

        expect(result.schema.tables).toHaveLength(5);
        expect(messages(result)).toEqual(expect.arrayContaining([
            expect.stringContaining('MissingSchema must declare @@schema'),
            expect.stringContaining('UnknownSchema uses @@schema("other"), which is not listed'),
            expect.stringContaining('BaseConfig and DuplicateConfig both map to base.config'),
        ]));
        expect(messages(result).some((message) => message.includes('BaseConfig and ShopConfig'))).toBe(false);
    });

    it('validates MongoDB ObjectId relation scalars and ObjectId defaults', () => {
        const result = convertPrismaToErdSchema(`
            datasource mongo {
              provider = "mongodb"
            }

            model User {
              id    String @id @default(auto()) @map("_id") @mongo.ObjectId
              posts Post[]
            }

            model Post {
              id       String @id @default(auto()) @map("_id") @mongo.ObjectId
              authorId String
              author   User   @relation(fields: [authorId], references: [id])
            }

            model WrongDefault {
              id String @id @default(uuid()) @map("_id") @mongo.ObjectId
            }

            model MisplacedDefaults {
              id     String @id @map("_id")
              serial Int    @default(autoincrement())
              token  String @default(auto())
            }
        `);

        expect(result.schema.relations).toHaveLength(1);
        expect(messages(result)).toEqual(expect.arrayContaining([
            expect.stringContaining('Post.author must use @mongo.ObjectId on both relation scalar fields'),
            expect.stringContaining('WrongDefault.id uses @mongo.ObjectId and must use @default(auto())'),
            expect.stringContaining('MongoDB does not support autoincrement()'),
            expect.stringContaining('MisplacedDefaults.token uses auto(), which requires a field-level @id'),
        ]));
    });

    it('validates connector-specific default functions without losing parsed defaults', () => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider = "postgresql"
            }

            model GeneratedValues {
              id       Int    @id @default(sequence())
              external String @default(auto())
            }
        `);

        const table = result.schema.tables[0];
        expect(table.columns.find((column) => column.name === 'id')?.extras).toContain('Default: sequence()');
        expect(table.columns.find((column) => column.name === 'external')?.extras).toContain('Default: auto()');
        expect(messages(result)).toEqual(expect.arrayContaining([
            expect.stringContaining('sequence() is only supported by CockroachDB'),
            expect.stringContaining('auto() is only supported by MongoDB'),
        ]));
    });

    it('diagnoses model and field identifiers that do not start with a letter', () => {
        const result = convertPrismaToErdSchema(`
            datasource db {
              provider = "postgresql"
            }

            model _Hidden {
              id Int @id
            }

            model Visible {
              _id Int @id
            }

            enum Visibility {
              PUBLIC
              _INTERNAL @map("internal")
            }
        `);

        expect(result.schema.tables.map((table) => table.name)).toEqual(['_Hidden', 'Visible']);
        expect(result.schema.enums[0].values).toEqual(['PUBLIC', '_INTERNAL']);
        expect(messages(result)).toEqual(expect.arrayContaining([
            expect.stringContaining('model name _Hidden must start with a letter'),
            expect.stringContaining('Visible field _id must start with a letter'),
            expect.stringContaining('Visibility enum value _INTERNAL must start with a letter'),
        ]));
    });

    it('does not use partial unique indexes as global identities or relation keys', () => {
        const result = convertPrismaToErdSchema(`
            generator client {
              provider        = "prisma-client"
              previewFeatures = ["partialIndexes"]
            }

            datasource db {
              provider = "postgresql"
            }

            model PartialOnly {
              email  String
              active Boolean

              @@unique([email], where: { active: true })
            }

            model Parent {
              id       Int     @id
              code     String
              active   Boolean
              children Child[] @relation("ByActiveCode")

              @@unique([code], where: raw("active"), map: "parent_active_code")
            }

            model Child {
              id         Int    @id
              parentCode String @unique(where: { parentCode: { not: "" } })
              parent     Parent @relation("ByActiveCode", fields: [parentCode], references: [code])
            }
        `);

        expect(result.schema.relations).toHaveLength(1);
        expect(result.schema.relations[0].fromCard).toBe('n');
        expect(messages(result)).toEqual(expect.arrayContaining([
            expect.stringContaining('PartialOnly has no unique identifier'),
            expect.stringContaining('Child.parent must reference a unique field set on Parent'),
        ]));
        expect(result.schema.tables.find((table) => table.name === 'Parent')
            ?.columns.find((column) => column.name === 'code')?.constraints).toContain('PUQ');
    });

    it('keeps complex cross-schema composite relations and nested attributes coherent', () => {
        const result = convertPrismaToErdSchema(`
            generator client {
              provider        = "prisma-client"
              previewFeatures = ["partialIndexes", "multiSchema"]
            }

            datasource warehouse {
              provider = "postgresql"
              schemas  = ["identity", "commerce"]
            }

            enum TenantState {
              ACTIVE   @map("active")
              ARCHIVED @map("archived")

              @@map("tenant_state")
              @@schema("identity")
            }

            model Tenant {
              region String      @warehouse.VarChar(12)
              code   String      @warehouse.VarChar(32)
              state  TenantState @default(ACTIVE)
              orders Order[]     @relation("TenantOrders")

              @@id([region, code], name: "tenantIdentity", map: "tenants_pkey")
              @@index(
                [code(ops: TextOps)],
                where: { state: "active" },
                map: "tenant_live_search"
              )
              @@map("tenants")
              @@schema("identity")
            }

            model Order {
              id           BigInt @id @default(autoincrement())
              tenantRegion String @warehouse.VarChar(12)
              tenantCode   String @warehouse.VarChar(32)
              note         String @default("braces { } and // comments")
              tenant       Tenant @relation(
                "TenantOrders",
                fields: [tenantRegion, tenantCode],
                references: [region, code],
                onDelete: Cascade,
                onUpdate: NoAction,
                map: "orders_tenant_fkey"
              )

              @@index([tenantRegion, tenantCode], map: "orders_tenant_idx")
              @@map("orders")
              @@schema("commerce")
            }
        `);

        expect(messages(result)).toEqual([]);
        expect(result.stats).toEqual(expect.objectContaining({
            modelCount: 2,
            enumCount: 1,
            relationCount: 1,
        }));
        expect(result.schema.relations).toHaveLength(2);
        expect(result.schema.relations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                composite: true,
                fromColumns: ['tenantRegion', 'tenantCode'],
                toColumns: ['region', 'code'],
                actions: { onDelete: 'Cascade', onUpdate: 'NoAction' },
            }),
        ]));
        expect(result.schema.tables.find((table) => table.name === 'Order')
            ?.columns.find((column) => column.name === 'note')?.extras)
            .toContain('Default: "braces { } and // comments"');
    });
});
