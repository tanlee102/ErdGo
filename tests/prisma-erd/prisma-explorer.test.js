/** Verifies searchable Prisma model cards and relation-inspector records. */
import { describe, expect, it } from 'vitest';
import { convertPrismaToErdSchema, SAMPLE_PRISMA_SCHEMA } from '@/features/prisma-erd/lib/prismaToSql.js';
import {
    buildPrismaExplorer,
    buildPrismaRelationSummaries,
    getPrismaExplorerRelationsForTable,
    searchPrismaExplorerItems,
} from '@/features/prisma-erd/lib/prismaExplorer.js';

describe('Prisma explorer search and relation inspector data', () => {
    it('indexes models, fields, mapped database names, enums, and relations', () => {
        const { schema } = convertPrismaToErdSchema(SAMPLE_PRISMA_SCHEMA);
        const explorer = buildPrismaExplorer(schema);

        expect(searchPrismaExplorerItems(explorer.items, 'display_name')[0]).toEqual(
            expect.objectContaining({
                type: 'field',
                label: 'User.displayName',
                tableName: 'User',
            }),
        );
        expect(searchPrismaExplorerItems(explorer.items, 'administrator')[0]).toEqual(
            expect.objectContaining({
                type: 'enumValue',
                label: 'UserRole.ADMIN',
            }),
        );
        expect(searchPrismaExplorerItems(explorer.items, 'PostEditor')).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: 'relation',
                    label: 'Post.editor -> User.id',
                    relationId: expect.any(String),
                }),
            ]),
        );
    });

    it('groups composite relation rows into one inspector summary', () => {
        const { schema } = convertPrismaToErdSchema(`
            model Workspace {
              tenantId Int
              slug     String
              tasks    Task[]

              @@id([tenantId, slug])
            }

            model Task {
              id            Int       @id
              workspaceId   Int
              workspaceSlug String
              workspace     Workspace @relation(fields: [workspaceId, workspaceSlug], references: [tenantId, slug], onDelete: Cascade, map: "task_workspace_fkey")
            }
        `);
        const [relation] = buildPrismaRelationSummaries(schema.relations);

        expect(relation).toEqual(
            expect.objectContaining({
                title: 'Task.workspace -> Workspace.tenantId, slug',
                fromColumns: ['workspaceId', 'workspaceSlug'],
                toColumns: ['tenantId', 'slug'],
                fkName: 'task_workspace_fkey',
                actionText: 'onDelete: Cascade',
                composite: true,
            }),
        );
    });

    it('returns the relations attached to a selected model', () => {
        const { schema } = convertPrismaToErdSchema(SAMPLE_PRISMA_SCHEMA);
        const explorer = buildPrismaExplorer(schema);
        const postRelations = getPrismaExplorerRelationsForTable(explorer, 'Post');
        const userRelations = getPrismaExplorerRelationsForTable(explorer, 'User');

        expect(postRelations.map((relation) => relation.title)).toEqual(
            expect.arrayContaining([
                'Post.author -> User.id',
                'Post.editor -> User.id',
                'Comment.post -> Post.id',
            ]),
        );
        expect(userRelations.filter((relation) => relation.title === 'User.followedBy <-> User.following')).toHaveLength(1);
    });

    it('keeps relation source lines available for editor jumps', () => {
        const { schema } = convertPrismaToErdSchema(`
            model User {
              id    Int    @id
              posts Post[]
            }

            model Post {
              id       Int  @id
              authorId Int
              author   User @relation(fields: [authorId], references: [id])
            }
        `);
        const explorer = buildPrismaExplorer(schema);
        const results = searchPrismaExplorerItems(explorer.items, 'Post.author');
        const relationField = results.find((item) => item.type === 'relationField');
        const relation = results.find((item) => item.type === 'relation');

        expect(relationField).toEqual(expect.objectContaining({ line: 10, relationId: expect.any(String) }));
        expect(relation).toEqual(expect.objectContaining({ type: 'relation', line: 10, relationId: relationField.relationId }));
    });

    it('does not collapse separate explicit relations that reuse a pasted relation name', () => {
        const { schema } = convertPrismaToErdSchema(`
            model User {
              id Int @id
            }

            model Post {
              id       Int  @id
              authorId Int
              editorId Int
              author   User @relation("DuplicateName", fields: [authorId], references: [id])
              editor   User @relation("DuplicateName", fields: [editorId], references: [id])
            }
        `);

        const relations = buildPrismaRelationSummaries(schema.relations);
        expect(relations.map((relation) => relation.title)).toEqual(expect.arrayContaining(['Post.author -> User.id', 'Post.editor -> User.id']));
        expect(relations).toHaveLength(2);
    });
});
