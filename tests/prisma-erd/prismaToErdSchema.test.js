/** Defines the renderer-ready ERD shape produced from Prisma schemas. */
import { describe, expect, it } from 'vitest';
import { convertPrismaToErdSchema, SAMPLE_PRISMA_SCHEMA } from '@/features/prisma-erd/lib/prismaToSql.js';
import { analyzeErdLayoutGraph, chooseBestLayoutStrategy, SMART_LAYOUT_STRATEGIES } from '@/lib/erd-renderer/layoutSystem.js';

describe('prismaToErdSchema', () => {
    it('converts the sample schema directly into renderer-ready Prisma ERD data', () => {
        const result = convertPrismaToErdSchema(SAMPLE_PRISMA_SCHEMA);
        const { schema } = result;

        expect(schema.sourceType).toBe('prisma');
        expect(schema.tables.map((table) => table.name)).toEqual([
            'User',
            'Organization',
            'Membership',
            'Project',
            'Task',
            'Post',
            'Comment',
        ]);
        expect(schema.enums).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: 'UserRole',
                    values: ['MEMBER', 'MANAGER', 'ADMIN'],
                    prisma: expect.objectContaining({
                        dbName: 'user_role',
                        values: expect.arrayContaining([expect.objectContaining({ name: 'ADMIN', dbName: 'administrator' })]),
                    }),
                }),
                expect.objectContaining({
                    name: 'ProjectStatus',
                    values: ['DRAFT', 'ACTIVE', 'ARCHIVED'],
                }),
            ]),
        );
        expect(schema.relations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    from: { table: 'Task', column: 'organizationId' },
                    to: { table: 'Project', column: 'organizationId' },
                    composite: true,
                    fromColumns: ['organizationId', 'projectCode'],
                    toColumns: ['organizationId', 'code'],
                    actions: { onDelete: 'Cascade', onUpdate: 'Cascade' },
                }),
                expect.objectContaining({
                    from: { table: 'Post', column: 'editorId' },
                    to: { table: 'User', column: 'id' },
                    fromCard: '0..n',
                    fkName: 'PostEditor',
                    actions: { onDelete: 'SetNull' },
                    prisma: expect.objectContaining({ relationName: 'PostEditor' }),
                }),
                expect.objectContaining({
                    from: { table: 'User', column: 'id' },
                    to: { table: 'User', column: 'id' },
                    fromCard: 'n',
                    toCard: 'n',
                    prisma: expect.objectContaining({
                        kind: 'implicit-many-to-many',
                        relationName: 'UserFollows',
                        fromRelationField: 'followedBy',
                        toRelationField: 'following',
                    }),
                }),
                expect.objectContaining({
                    from: { table: 'Task', column: 'assigneeId' },
                    to: { table: 'User', column: 'id' },
                    fkName: 'TaskAssignee',
                    actions: { onDelete: 'SetNull' },
                }),
                expect.objectContaining({
                    from: { table: 'Comment', column: 'postId' },
                    to: { table: 'Post', column: 'id' },
                    actions: { onDelete: 'Cascade' },
                }),
            ]),
        );

        const user = schema.tables.find((table) => table.name === 'User');
        const task = schema.tables.find((table) => table.name === 'Task');
        expect(user.columns.some((column) => column.name === 'legacyCode')).toBe(false);
        expect(user.columns.find((column) => column.name === 'skills')?.extras).toContain('Scalar list');
        expect(user.columns.find((column) => column.name === 'id')?.extras).toEqual(expect.arrayContaining(['Default: uuid()', 'Native: @db.Uuid']));
        expect(task.columns.find((column) => column.name === 'organizationId')?.fk).toBe(true);
        expect(task.columns.find((column) => column.name === 'projectCode')?.fk).toBe(true);
        expect(task.columns.find((column) => column.name === 'assigneeId')?.fk).toBe(true);
        expect(user.prisma.relationFields).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: 'authoredPosts',
                    type: 'Post[]',
                    targetModel: 'Post',
                    relationName: 'PostAuthor',
                }),
            ]),
        );
        expect(result.stats).toEqual({
            modelCount: 7,
            viewCount: 0,
            enumCount: 2,
            compositeCount: 0,
            relationCount: 12,
        });
        expect(result.diagnostics).toHaveLength(0);
    });

    it('keeps the seven-model sample compact enough for the radial auto layout', () => {
        const { schema } = convertPrismaToErdSchema(SAMPLE_PRISMA_SCHEMA);
        const profile = analyzeErdLayoutGraph(schema.tables, schema.relations);

        expect(schema.tables).toHaveLength(7);
        expect(profile.hubName).toBe('User');
        expect(profile.maxDegree).toBe(6);
        expect(profile.isHubLike).toBe(true);
        expect(chooseBestLayoutStrategy(profile)).toBe(SMART_LAYOUT_STRATEGIES.RADIAL);
    });

    it('keeps every visible sample table connected to the same ERD graph', () => {
        const { schema } = convertPrismaToErdSchema(SAMPLE_PRISMA_SCHEMA);
        const neighbors = new Map(schema.tables.map((table) => [table.name, new Set()]));

        schema.relations.forEach((relation) => {
            neighbors.get(relation.from.table)?.add(relation.to.table);
            neighbors.get(relation.to.table)?.add(relation.from.table);
        });

        const visited = new Set();
        const queue = [schema.tables[0].name];
        while (queue.length > 0) {
            const tableName = queue.shift();
            if (visited.has(tableName)) continue;
            visited.add(tableName);
            neighbors.get(tableName)?.forEach((neighbor) => {
                if (!visited.has(neighbor)) queue.push(neighbor);
            });
        }

        expect([...visited].sort()).toEqual(schema.tables.map((table) => table.name).sort());
        expect([...neighbors.entries()].filter(([, linkedTables]) => linkedTables.size === 0)).toEqual([]);
    });

    it('keeps Prisma names visible and stores mapped database names as metadata', () => {
        const result = convertPrismaToErdSchema(`
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

        const account = result.schema.tables.find((table) => table.name === 'Account');
        const ownerId = account.columns.find((column) => column.name === 'ownerId');

        expect(account.prisma.dbName).toBe('accounts');
        expect(account.prisma.annotations).toContain('@@map("accounts")');
        expect(account.columns[0].extras).toContain('@@map("accounts")');
        expect(ownerId.prisma.dbName).toBe('owner_id');
        expect(ownerId.extras).toContain('@map("owner_id")');
        expect(ownerId.constraints).toContain('IDX');
        expect(result.schema.relations).toEqual([
            expect.objectContaining({
                from: { table: 'Account', column: 'ownerId' },
                to: { table: 'User', column: 'id' },
            }),
        ]);
    });

    it('marks composite primary keys and unique groups without SQL parsing', () => {
        const result = convertPrismaToErdSchema(`
            model TeamMember {
              teamId Int
              userId Int
              role   String

              @@id([teamId, userId])
              @@unique([teamId, role], name: "team_role_unique")
            }
        `);

        const table = result.schema.tables[0];
        const teamId = table.columns.find((column) => column.name === 'teamId');
        const userId = table.columns.find((column) => column.name === 'userId');
        const role = table.columns.find((column) => column.name === 'role');

        expect(teamId.pk).toBe(true);
        expect(teamId.compositePk).toBe(true);
        expect(userId.pk).toBe(true);
        expect(role.constraints).toContain('UQ');
        expect(role.compositeUq).toBe(true);
    });

    it('draws implicit many-to-many relation fields as Prisma-native virtual relations', () => {
        const result = convertPrismaToErdSchema(`
            model Post {
              id   Int   @id
              tags Tag[]
            }

            model Tag {
              id    Int    @id
              posts Post[]
            }
        `);

        const post = result.schema.tables.find((table) => table.name === 'Post');
        const tag = result.schema.tables.find((table) => table.name === 'Tag');

        expect(post.columns.map((column) => column.name)).toEqual(['id']);
        expect(tag.columns.map((column) => column.name)).toEqual(['id']);
        expect(post.prisma.relationFields).toEqual([expect.objectContaining({ name: 'tags', type: 'Tag[]' })]);
        expect(tag.prisma.relationFields).toEqual([expect.objectContaining({ name: 'posts', type: 'Post[]' })]);
        expect(result.schema.relations).toEqual([
            expect.objectContaining({
                from: { table: 'Post', column: 'id' },
                to: { table: 'Tag', column: 'id' },
                fromCard: 'n',
                toCard: 'n',
                prisma: expect.objectContaining({
                    kind: 'implicit-many-to-many',
                    fromRelationField: 'tags',
                    toRelationField: 'posts',
                }),
            }),
        ]);
        expect(result.diagnostics).toHaveLength(0);
    });
});
