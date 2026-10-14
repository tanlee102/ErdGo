import { describe, expect, it } from 'vitest';
import { convertPrismaToErdSchema } from '@/features/prisma-erd/lib/prismaToSql.js';

function tableNames(result) {
    return result.schema.tables.map((table) => table.name);
}

function columnNames(result, tableName) {
    return result.schema.tables.find((table) => table.name === tableName)?.columns.map((column) => column.name) || [];
}

describe('Prisma resilient paste recovery', () => {
    it('recovers at the next model after a missing closing brace', () => {
        const result = convertPrismaToErdSchema(`
            model Before {
              id Int @id
            }

            model Damaged {
              id    Int @id
              title String

            model After {
              id        Int @id
              damagedId Int
            }
        `);

        expect(tableNames(result)).toEqual(['Before', 'Damaged', 'After']);
        expect(columnNames(result, 'Damaged')).toEqual(['id', 'title']);
        expect(columnNames(result, 'After')).toEqual(['id', 'damagedId']);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'error',
                    message: 'Missing closing brace for model Damaged.',
                }),
            ]),
        );
    });

    it('recovers multiple consecutive blocks with missing closing braces', () => {
        const result = convertPrismaToErdSchema(`
            model First {
              id Int @id

            model Second {
              id Int @id

            model Third {
              id Int @id
            }
        `);

        expect(tableNames(result)).toEqual(['First', 'Second', 'Third']);
        expect(result.diagnostics.filter((item) => item.message.includes('Missing closing brace'))).toHaveLength(2);
    });

    it('recovers after an invalid model header without an opening brace', () => {
        const result = convertPrismaToErdSchema(`
            model Before {
              id Int @id
            }

            model InvalidHeader

            model After {
              id Int @id
            }
        `);

        expect(tableNames(result)).toEqual(['Before', 'After']);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'error',
                    message: expect.stringContaining('Invalid Prisma model block'),
                }),
            ]),
        );
    });

    it('recovers later fields and models after an unterminated string', () => {
        const result = convertPrismaToErdSchema(`
            model Before {
              id Int @id
            }

            model Damaged {
              id      Int    @id
              bad     String @default("unfinished)
              healthy String
            }

            model After {
              id Int @id
            }
        `);

        expect(tableNames(result)).toEqual(['Before', 'Damaged', 'After']);
        expect(columnNames(result, 'Damaged')).toEqual(['id', 'bad', 'healthy']);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'error',
                    message: expect.stringContaining('Unterminated string'),
                }),
            ]),
        );
    });

    it('recovers at the next model after an unterminated block comment', () => {
        const result = convertPrismaToErdSchema(`
            model Before {
              id Int @id
            }

            model Damaged {
              id Int @id
              /* unfinished explanation
            }

            model After {
              id Int @id
              name String
            }
        `);

        expect(tableNames(result)).toEqual(['Before', 'Damaged', 'After']);
        expect(columnNames(result, 'Damaged')).toEqual(['id']);
        expect(columnNames(result, 'After')).toEqual(['id', 'name']);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'error',
                    message: expect.stringContaining('Unterminated block comment'),
                }),
                expect.objectContaining({
                    severity: 'error',
                    message: 'Missing closing brace for model Damaged.',
                }),
            ]),
        );
    });

    it('recovers models after an unfinished enum block', () => {
        const result = convertPrismaToErdSchema(`
            enum BrokenState {
              ACTIVE
              PAUSED

            model Account {
              id    Int         @id
              state BrokenState
            }

            model Audit {
              id Int @id
            }
        `);

        expect(tableNames(result)).toEqual(['Account', 'Audit']);
        expect(result.schema.enums).toEqual([
            expect.objectContaining({
                name: 'BrokenState',
                values: ['ACTIVE', 'PAUSED'],
            }),
        ]);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'error',
                    message: 'Missing closing brace for enum BrokenState.',
                }),
            ]),
        );
    });

    it('recovers models after an unfinished composite type block', () => {
        const result = convertPrismaToErdSchema(`
            type Address {
              street String
              city   String

            model User {
              id      Int     @id
              address Address
            }

            model Session {
              id Int @id
            }
        `);

        expect(tableNames(result)).toEqual(['User', 'Session']);
        expect(result.schema.composites).toEqual([
            expect.objectContaining({
                name: 'Address',
                fields: [
                    { name: 'street', type: 'String' },
                    { name: 'city', type: 'String' },
                ],
            }),
        ]);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'error',
                    message: 'Missing closing brace for type Address.',
                }),
            ]),
        );
    });

    it('isolates a broken relation attribute while preserving scalar fields and other relations', () => {
        const result = convertPrismaToErdSchema(`
            model User {
              id       Int     @id
              posts    Post[]
              comments Comment[]
            }

            model Post {
              id       Int  @id
              authorId Int
              author   User @relation(fields: [authorId], references: [id]
              title    String
            }

            model Comment {
              id       Int  @id
              authorId Int
              author   User @relation(fields: [authorId], references: [id])
            }
        `);

        expect(tableNames(result)).toEqual(['User', 'Post', 'Comment']);
        expect(columnNames(result, 'Post')).toEqual(['id', 'authorId', 'title']);
        expect(result.schema.relations).toEqual([
            expect.objectContaining({
                from: { table: 'Comment', column: 'authorId' },
                to: { table: 'User', column: 'id' },
            }),
        ]);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'error',
                    message: expect.stringContaining('unbalanced field or attribute delimiters'),
                }),
            ]),
        );
    });

    it('isolates a broken block attribute and preserves later fields and models', () => {
        const result = convertPrismaToErdSchema(`
            model User {
              id    Int    @id
              email String

              @@index([email]
            }

            model After {
              id Int @id
            }
        `);

        expect(tableNames(result)).toEqual(['User', 'After']);
        expect(columnNames(result, 'User')).toEqual(['id', 'email']);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'error',
                    message: expect.stringContaining('unbalanced field or attribute delimiters'),
                }),
            ]),
        );
    });

    it('keeps valid relations around one malformed model', () => {
        const result = convertPrismaToErdSchema(`
            model User {
              id       Int       @id
              posts    Post[]
              comments Comment[]
            }

            model Post {
              id       Int  @id
              authorId Int
              author   User @relation(fields: [authorId], references: [id])
            }

            model Broken {
              id Int @id
              invalid
            }

            model Comment {
              id       Int  @id
              authorId Int
              author   User @relation(fields: [authorId], references: [id])
            }
        `);

        expect(tableNames(result)).toEqual(['User', 'Post', 'Broken', 'Comment']);
        expect(result.schema.relations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ from: { table: 'Post', column: 'authorId' }, to: { table: 'User', column: 'id' } }),
                expect.objectContaining({ from: { table: 'Comment', column: 'authorId' }, to: { table: 'User', column: 'id' } }),
            ]),
        );
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'error',
                    message: expect.stringContaining('invalid field declaration'),
                }),
            ]),
        );
    });

    it('recovers several independent errors and still renders every valid block', () => {
        const result = convertPrismaToErdSchema(`
            model Alpha {
              id Int @id

            model Beta {
              id   Int    @id
              note String @default("unfinished)
              code String
            }

            model Invalid

            model Gamma {
              id Int @id
            }

            model Delta {
              id Int @id
            }
        `);

        expect(tableNames(result)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
        expect(columnNames(result, 'Beta')).toEqual(['id', 'note', 'code']);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ message: 'Missing closing brace for model Alpha.' }),
                expect.objectContaining({ message: expect.stringContaining('Unterminated string') }),
                expect.objectContaining({ message: expect.stringContaining('Invalid Prisma model block') }),
            ]),
        );
    });

    it('ignores an extra closing brace between otherwise valid models', () => {
        const result = convertPrismaToErdSchema(`
            model Before {
              id Int @id
            }

            }

            model After {
              id Int @id
            }
        `);

        expect(tableNames(result)).toEqual(['Before', 'After']);
        expect(result.schema.tables.every((table) => table.columns.length === 1)).toBe(true);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'error',
                    message: expect.stringContaining('Unexpected closing brace'),
                }),
            ]),
        );
    });

    it('isolates many mismatched attributes without producing derivative semantic warnings', () => {
        const result = convertPrismaToErdSchema(`
            model Organization {
              id       String    @id
              projects Project[]
            }

            model Project {
              organizationId String
              code           String
              status         String @default(DRAFT])
              organization   Organization @relation(fields: [organizationId], references: [id])
              tasks          Task[]

              @@unique([organizationId, code])
            }

            model Task {
              id             Int     @id
              organizationId String
              projectCode    String
              project        Project @relation(fields: [organizationId, projectCode], references: [organizationId, code]]

              @@index([organizationId, projectCode})
            }

            model Post {
              id    String @id
              title String
            }
        `);

        expect(tableNames(result)).toEqual(['Organization', 'Project', 'Task', 'Post']);
        expect(columnNames(result, 'Post')).toEqual(['id', 'title']);
        expect(result.diagnostics.filter((item) => item.severity === 'error')).toHaveLength(3);
        expect(result.diagnostics.filter((item) => item.severity === 'warning')).toHaveLength(0);
        expect(result.schema.relations).toEqual([
            expect.objectContaining({
                from: { table: 'Project', column: 'organizationId' },
                to: { table: 'Organization', column: 'id' },
            }),
        ]);
    });

    it('detects crossed delimiters that previously cancelled each other numerically', () => {
        const result = convertPrismaToErdSchema(`
            model Broken {
              id    Int    @id
              value String @default((])
              next  String
            }

            model Healthy {
              id Int @id
            }
        `);

        expect(tableNames(result)).toEqual(['Broken', 'Healthy']);
        expect(columnNames(result, 'Broken')).toEqual(['id', 'value', 'next']);
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                severity: 'error',
                line: 4,
                message: expect.stringContaining('unbalanced field or attribute delimiters'),
            }),
        ]);
    });

    it.each([
        ['unfinished default call', 'value String @default(cuid('],
        ['crossed default delimiters', 'value String @default(foo])'],
        ['unexpected brace in an attribute', 'value String @default(foo})'],
        ['unfinished relation', 'target Target @relation(fields: [targetId], references: [id]'],
        ['crossed relation delimiters', 'target Target @relation(fields: [targetId], references: [id]]'],
        ['unfinished block index', '@@index([id]'],
        ['crossed block index', '@@index([id})'],
        ['unterminated string', 'value String @default("unfinished)'],
        ['invalid field declaration', 'invalid'],
        ['unterminated block comment', '/* unfinished comment'],
    ])('preserves a healthy tail model after %s', (_label, damagedStatement) => {
        const result = convertPrismaToErdSchema(`
            model Target {
              id Int @id
            }

            model Damaged {
              id       Int @id
              targetId Int
              ${damagedStatement}
            }

            model HealthyTail {
              id    Int    @id
              label String
            }
        `);

        expect(tableNames(result)).toContain('HealthyTail');
        expect(columnNames(result, 'HealthyTail')).toEqual(['id', 'label']);
        expect(result.diagnostics.some((item) => item.severity === 'error')).toBe(true);
    });

    it('uses generator and datasource blocks as recovery boundaries', () => {
        const result = convertPrismaToErdSchema(`
            model Damaged {
              id Int @id

            generator client {
              provider = "prisma-client"
              output   = "./generated"
            }

            datasource db {
              provider = "postgresql"
            }

            model After {
              id Int @id
            }
        `);

        expect(tableNames(result)).toEqual(['Damaged', 'After']);
        expect(columnNames(result, 'Damaged')).toEqual(['id']);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'error',
                    message: 'Missing closing brace for model Damaged.',
                }),
            ]),
        );
        expect(result.diagnostics.some((item) => item.message.includes('invalid field declaration'))).toBe(false);
    });

    it('recovers every later model in a long file with repeated missing braces', () => {
        const modelCount = 40;
        const brokenIndexes = new Set([3, 8, 13, 18, 23, 28, 33, 38]);
        const source = Array.from({ length: modelCount }, (_, index) => {
            return `
                model Recovery${index} {
                  id    Int    @id
                  value String
                ${brokenIndexes.has(index) ? '' : '}'}
            `;
        }).join('\n');

        const result = convertPrismaToErdSchema(source);

        expect(tableNames(result)).toEqual(Array.from({ length: modelCount }, (_, index) => `Recovery${index}`));
        expect(result.schema.tables.every((table) => table.columns.map((column) => column.name).join(',') === 'id,value')).toBe(true);
        expect(result.diagnostics.filter((item) => item.message.includes('Missing closing brace'))).toHaveLength(brokenIndexes.size);
    });

    it('recovers a valid model after a damaged view', () => {
        const result = convertPrismaToErdSchema(`
            model User {
              id Int @id
            }

            view BrokenSummary {
              userId Int
              label  String

            model Session {
              id     Int @id
              userId Int
              user   User @relation(fields: [userId], references: [id])
            }
        `);

        expect(tableNames(result)).toEqual(['User', 'BrokenSummary', 'Session']);
        expect(result.schema.tables.find((table) => table.name === 'BrokenSummary')?.prisma.kind).toBe('view');
        expect(result.schema.relations).toEqual([
            expect.objectContaining({
                from: { table: 'Session', column: 'userId' },
                to: { table: 'User', column: 'id' },
            }),
        ]);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: 'error',
                    message: 'Missing closing brace for view BrokenSummary.',
                }),
            ]),
        );
    });

    it('keeps multiline object arguments inside block attributes', () => {
        const result = convertPrismaToErdSchema(`
            model Article {
              id        Int       @id
              active    Boolean
              deletedAt DateTime?

              @@index(
                [id],
                where: {
                  active: true,
                  deletedAt: null
                },
                map: "article_live_idx"
              )
            }

            model Audit {
              id Int @id
            }
        `);

        expect(tableNames(result)).toEqual(['Article', 'Audit']);
        expect(result.schema.tables[0].prisma.indexes).toEqual([
            expect.objectContaining({
                kind: 'index',
                fields: ['id'],
                name: 'article_live_idx',
            }),
        ]);
        expect(result.diagnostics).toEqual([]);
    });

    it('does not add a no-model warning after a broken block header', () => {
        const result = convertPrismaToErdSchema('model Broken');

        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                severity: 'error',
                message: expect.stringContaining('Invalid Prisma model block'),
            }),
        ]);
    });

    it('reports the real source column for compact one-line blocks', () => {
        const result = convertPrismaToErdSchema('model User { email String unique }');

        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                severity: 'error',
                line: 1,
                column: 14,
                message: expect.stringContaining('unexpected content after the field type'),
            }),
        ]);
    });

    it('contains repeated damage across a large pasted schema', () => {
        const modelCount = 120;
        const source = Array.from({ length: modelCount }, (_, index) => {
            const damagedDefault = index % 3 === 0 ? '@default(foo])' : '@default("ok")';
            return `
                model Stress${index} {
                  id    Int    @id
                  value String ${damagedDefault}
                  next  String
                }
            `;
        }).join('\n');
        const result = convertPrismaToErdSchema(`${source}\nmodel HealthyTail {\n id Int @id\n}`);

        expect(result.schema.tables).toHaveLength(modelCount + 1);
        expect(columnNames(result, 'HealthyTail')).toEqual(['id']);
        expect(result.diagnostics.filter((item) => item.severity === 'error')).toHaveLength(modelCount / 3);
        expect(result.diagnostics.filter((item) => item.severity === 'warning')).toHaveLength(0);
    });
});
