/** Defines schema quality scoring, issue severity, and recommendation contracts. */
import { describe, expect, it } from 'vitest';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';
import { inferRelationships } from '@/lib/relationshipInference.js';
import { scoreErdSchema } from '@/lib/schemaQualityScore.js';

function column(name, type, { pk = false, unique = false, indexed = false, notNull = false, fk = false, extras = [], compositePk = false, compositeUq = false, compositeIdx = false, autoIncrement = false } = {}) {
    return {
        name,
        type,
        constraints: [
            ...(pk ? ['PK'] : []),
            ...(unique ? ['UQ'] : []),
            ...(indexed ? ['IDX'] : []),
            ...(notNull ? ['NN'] : []),
        ],
        extras,
        ...(pk ? { pk: true } : {}),
        ...(fk ? { fk: true } : {}),
        ...(compositePk ? { compositePk: true } : {}),
        ...(compositeUq ? { compositeUq: true } : {}),
        ...(compositeIdx ? { compositeIdx: true } : {}),
        ...(autoIncrement ? { autoIncrement: true } : {}),
    };
}

function relation(fromTable, fromColumn, toTable, toColumn, extra = {}) {
    return {
        from: { table: fromTable, column: fromColumn },
        to: { table: toTable, column: toColumn },
        fromCard: '0..n',
        toCard: '1',
        ...extra,
    };
}

function schema(tables, relations = [], extra = {}) {
    return { enums: [], composites: [], tables, relations, ...extra };
}

function healthySchema() {
    return schema(
        [
            { name: 'users', columns: [column('id', 'BIGINT', { pk: true })] },
            { name: 'posts', columns: [column('id', 'BIGINT', { pk: true }), column('user_id', 'BIGINT', { indexed: true, notNull: true, fk: true })] },
        ],
        [relation('posts', 'user_id', 'users', 'id')],
    );
}

describe('scoreErdSchema v2', () => {
    it('returns a neutral not-scored state for an empty ERD', () => {
        const result = scoreErdSchema(schema([]));

        expect(result).toMatchObject({ score: 0, scoreVersion: 2, label: 'Not scored', assessmentCoverage: 0 });
        expect(result.categories.map((item) => item.maxScore)).toEqual([12, 14, 16, 10, 10, 8, 6, 8, 8, 8]);
        expect(result.findings).toEqual([]);
    });

    it('normalizes N/A criteria and awards 100 to a coherent keyed, linked, indexed schema', () => {
        const result = scoreErdSchema(healthySchema());

        expect(result).toMatchObject({ score: 100, label: 'Excellent', assessmentCoverage: 92, capApplied: null });
        expect(result.categories.map((item) => [item.id, item.score, item.maxScore, item.applicable])).toEqual([
            ['structuralValidity', 12, 12, true],
            ['primaryKeys', 14, 14, true],
            ['relationships', 16, 16, true],
            ['typeCompatibility', 10, 10, true],
            ['relationshipIndexes', 10, 10, true],
            ['lifecycleSafety', 8, 8, true],
            ['cardinalityCoherence', 6, 6, true],
            ['columnCoherence', 8, 8, true],
            ['columnSafeguards', null, 8, false],
            ['naming', 8, 8, true],
        ]);
        expect(result.findings).toEqual([]);
    });

    it('heavily penalizes broad primary-key gaps and reports affected tables', () => {
        const result = scoreErdSchema(schema([
            { name: 'users', columns: [column('id', 'BIGINT', { pk: true })] },
            { name: 'posts', columns: [column('user_id', 'BIGINT')] },
        ]));

        expect(result.categories.find((item) => item.id === 'primaryKeys')).toMatchObject({ score: 7, maxScore: 14 });
        expect(result.score).toBeLessThanOrEqual(69);
        expect(result.findings.find((item) => item.code === 'missing_primary_keys')).toMatchObject({ tables: ['posts'] });
    });

    it('scores pending inference only as relationship integrity, then evaluates accepted type and index readiness', () => {
        const source = schema([
            { name: 'users', columns: [column('id', 'BIGINT', { pk: true })] },
            { name: 'posts', columns: [column('id', 'BIGINT', { pk: true }), column('user_id', 'BIGINT')] },
        ]);
        const candidate = inferRelationships(source)[0];

        const before = scoreErdSchema(source, { relationshipCandidates: [candidate] });
        const after = scoreErdSchema(source, { acceptedInferredRelations: [candidate], relationshipCandidates: [candidate] });

        expect(before).toMatchObject({ score: 67, label: 'Fair', assessmentCoverage: 66 });
        expect(before.categories.find((item) => item.id === 'typeCompatibility')).toMatchObject({ score: null, applicable: false });
        expect(before.categories.find((item) => item.id === 'relationshipIndexes')).toMatchObject({ score: null, applicable: false });
        expect(before.findings.find((item) => item.code === 'missing_relationship_links')).toBeTruthy();

        expect(after).toMatchObject({ score: 77, label: 'Good', assessmentCoverage: 92 });
        expect(after.categories.find((item) => item.id === 'relationships')).toMatchObject({ score: 10, maxScore: 16 });
        expect(after.categories.find((item) => item.id === 'relationshipIndexes')).toMatchObject({ score: 0, maxScore: 10 });
        expect(after.stats).toMatchObject({ acceptedInferredRelationships: 1, unindexedRelationshipSources: 1 });
    });

    it('can reuse already-computed relationship candidates without changing the result', () => {
        const source = schema([
            { name: 'users', columns: [column('id', 'BIGINT', { pk: true })] },
            { name: 'posts', columns: [column('id', 'BIGINT', { pk: true }), column('user_id', 'BIGINT')] },
        ]);

        expect(scoreErdSchema(source, { relationshipCandidates: inferRelationships(source) })).toEqual(scoreErdSchema(source));
    });

    it('excludes a current candidate the user rejected as a false match instead of granting free relationship points', () => {
        const source = schema([
            { name: 'users', columns: [column('id', 'BIGINT', { pk: true })] },
            { name: 'posts', columns: [column('id', 'BIGINT', { pk: true }), column('user_id', 'BIGINT')] },
        ]);
        const candidates = inferRelationships(source);
        const result = scoreErdSchema(source, { relationshipCandidates: candidates, rejectedInferredRelationIds: [candidates[0].id, 'stale-id'] });

        expect(result).toMatchObject({ score: 88, label: 'Strong', assessmentCoverage: 50 });
        expect(result.categories.find((item) => item.id === 'relationships')).toMatchObject({ score: null, applicable: false });
        expect(result.findings.find((item) => item.code === 'missing_relationship_links')).toBeUndefined();
        expect(result.stats).toMatchObject({ missingRelationshipCandidates: 0, rejectedRelationshipCandidates: 1 });
    });

    it('does not double-count an accepted relation already declared by SQL', () => {
        const source = healthySchema();
        const result = scoreErdSchema(source, { acceptedInferredRelations: [relation('posts', 'user_id', 'users', 'id')] });

        expect(result.score).toBe(100);
        expect(result.stats).toMatchObject({ explicitRelationships: 1, acceptedInferredRelationships: 0 });
        expect(result.categories.find((item) => item.id === 'relationships')).toMatchObject({ score: 16 });
    });

    it('identifies unindexed relationship sources without claiming composite index order', () => {
        const source = healthySchema();
        source.tables[1].columns[1].constraints = source.tables[1].columns[1].constraints.filter((constraint) => constraint !== 'IDX');
        const result = scoreErdSchema(source);

        expect(result).toMatchObject({ score: 89, label: 'Strong' });
        expect(result.categories.find((item) => item.id === 'relationshipIndexes')).toMatchObject({ score: 0, maxScore: 10 });
        expect(result.findings.find((item) => item.code === 'unindexed_relationship_sources')).toBeTruthy();
    });

    it('caps incompatible relationship key types even when every other category is healthy', () => {
        const source = healthySchema();
        source.tables[1].columns[1].type = 'TEXT';
        const result = scoreErdSchema(source);

        expect(result).toMatchObject({ score: 79, label: 'Good' });
        expect(result.capApplied).toMatchObject({ cap: 79, reasons: ['Incompatible relationship key types'] });
        expect(result.stats.relationshipTypeMismatches).toBe(1);
    });

    it('treats DEFAULT NULL as no safeguard and recognizes computed AS expressions', () => {
        const result = scoreErdSchema(schema([
            {
                name: 'profiles',
                columns: [
                    column('id', 'BIGINT', { pk: true }),
                    column('nickname', 'TEXT', { extras: ['DEFAULT NULL'] }),
                    column('display_key', 'COMPUTED', { extras: ['AS (nickname) PERSISTED'] }),
                ],
            },
        ]));

        expect(result.categories.find((item) => item.id === 'columnSafeguards')).toMatchObject({ score: 5, maxScore: 8 });
        expect(result.stats).toMatchObject({ eligibleBusinessColumns: 2, safeguardedBusinessColumns: 1 });
    });

    it('flags mixed identifier styles with column style weighted more than table style', () => {
        const result = scoreErdSchema(schema([
            { name: 'users', columns: [column('id', 'BIGINT', { pk: true })] },
            { name: 'postItems', columns: [column('id', 'BIGINT', { pk: true })] },
        ]));

        expect(result.categories.find((item) => item.id === 'naming')).toMatchObject({ score: 6, maxScore: 8 });
        expect(result.findings.find((item) => item.code === 'inconsistent_naming')).toBeTruthy();
    });

    it('caps parser errors and duplicate definitions as critical structural failures', () => {
        const result = scoreErdSchema(schema([
            { name: 'users', columns: [column('id', 'BIGINT', { pk: true }), column('id', 'TEXT')] },
        ], [], {
            enums: [{ name: 'status', values: ['open', 'open'] }],
            _parseErrors: [{ severity: 'error', kind: 'syntax', message: 'Broken definition' }],
        }));

        expect(result).toMatchObject({ score: 49, label: 'Needs work' });
        expect(result.categories.find((item) => item.id === 'structuralValidity')).toMatchObject({ score: 0, maxScore: 12 });
        expect(result.stats).toMatchObject({ duplicateColumnNames: 1, duplicateEnumValues: 1, schemaErrors: 1 });
        expect(result.findings[0]).toMatchObject({ code: 'critical_score_cap' });
    });

    it('detects incompatible SET NULL and deferred lifecycle actions', () => {
        const source = healthySchema();
        source.relations[0].actions = { onDelete: 'SET NULL', deferrable: false, initially: 'DEFERRED' };
        const result = scoreErdSchema(source);

        expect(result.score).toBe(69);
        expect(result.categories.find((item) => item.id === 'lifecycleSafety')).toMatchObject({ score: 0, maxScore: 8 });
        expect(result.stats.unsafeLifecycleRelationships).toBe(1);
        expect(result.findings.find((item) => item.code === 'incompatible_referential_actions')).toBeTruthy();
    });

    it('detects delete-cascade cycles, including their score cap', () => {
        const source = schema([
            { name: 'a', columns: [column('id', 'BIGINT', { pk: true }), column('b_id', 'BIGINT', { indexed: true, fk: true })] },
            { name: 'b', columns: [column('id', 'BIGINT', { pk: true }), column('a_id', 'BIGINT', { indexed: true, fk: true })] },
        ], [
            relation('a', 'b_id', 'b', 'id', { fromCard: '0..n', actions: { onDelete: 'CASCADE' } }),
            relation('b', 'a_id', 'a', 'id', { fromCard: '0..n', actions: { onDelete: 'CASCADE' } }),
        ]);
        const result = scoreErdSchema(source);

        expect(result.capApplied).toMatchObject({ cap: 79 });
        expect(result.stats.cascadeCycleDetected).toBe(true);
        expect(result.findings.find((item) => item.code === 'cascade_delete_cycle')).toBeTruthy();
    });

    it('checks cardinality against source nullability and uniqueness', () => {
        const source = healthySchema();
        source.relations[0].fromCard = '0..1';
        const result = scoreErdSchema(source);

        expect(result.categories.find((item) => item.id === 'cardinalityCoherence')).toMatchObject({ score: 3, maxScore: 6 });
        expect(result.stats.incoherentCardinalities).toBe(1);
        expect(result.findings.find((item) => item.code === 'incoherent_cardinalities')).toBeTruthy();
    });

    it('checks contradictory defaults, generated rules, and auto-increment types', () => {
        const result = scoreErdSchema(schema([
            {
                name: 'items',
                columns: [
                    column('id', 'BIGINT', { pk: true }),
                    column('required_name', 'TEXT', { notNull: true, extras: ['DEFAULT NULL'] }),
                    column('computed_total', 'COMPUTED', { extras: ['AS (1) PERSISTED', 'DEFAULT 1'] }),
                    column('sequence', 'TEXT', { autoIncrement: true, extras: ['AUTO_INCREMENT'] }),
                ],
            },
        ]));

        expect(result.categories.find((item) => item.id === 'columnCoherence')).toMatchObject({ score: 3, maxScore: 8 });
        expect(result.stats.incoherentColumnDefinitions).toBe(3);
        expect(result.findings.find((item) => item.code === 'incoherent_column_definitions')).toBeTruthy();
    });

    it('counts a composite FK once and marks flattened composite-index evidence N/A', () => {
        const group = 'child:pa,pb->parent:a,b:fk_parent';
        const relationMeta = {
            composite: true,
            relationGroup: group,
            fromColumns: ['pa', 'pb'],
            toColumns: ['a', 'b'],
            fromCard: '0..n',
        };
        const source = schema([
            { name: 'parent', columns: [column('a', 'BIGINT', { pk: true, compositePk: true }), column('b', 'BIGINT', { pk: true, compositePk: true })] },
            { name: 'child', columns: [column('id', 'BIGINT', { pk: true }), column('pa', 'BIGINT', { indexed: true, compositeIdx: true, fk: true }), column('pb', 'BIGINT', { indexed: true, compositeIdx: true, fk: true })] },
        ], [
            relation('child', 'pa', 'parent', 'a', relationMeta),
            relation('child', 'pb', 'parent', 'b', relationMeta),
        ]);
        const result = scoreErdSchema(source);

        expect(result.stats).toMatchObject({ explicitRelationships: 1, unassessableIndexGroups: 1 });
        expect(result.categories.find((item) => item.id === 'relationshipIndexes')).toMatchObject({ score: null, applicable: false });
        expect(result.categories.find((item) => item.id === 'typeCompatibility')).toMatchObject({ score: 10, applicable: true });
    });

    it('preserves quoted dotted column identities instead of collapsing them to the same leaf name', () => {
        const result = scoreErdSchema(sqlToErdSchema('CREATE TABLE t ("a.id" INT PRIMARY KEY, "b.id" INT);'));

        expect(result.stats.duplicateColumnNames).toBe(0);
        expect(result.capApplied).toBeNull();
        expect(result.findings.find((item) => item.code === 'structural_definition_flaws')).toBeUndefined();
    });

    it('does not claim that one member of a composite primary key is independently indexed', () => {
        const result = scoreErdSchema(sqlToErdSchema(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (
                a INT,
                b INT,
                PRIMARY KEY (a, b),
                FOREIGN KEY (b) REFERENCES p(id)
            );
        `));

        expect(result.categories.find((item) => item.id === 'relationshipIndexes')).toMatchObject({ score: null, applicable: false });
        expect(result.stats.unassessableIndexGroups).toBe(1);
    });

    it('allows nullable SET DEFAULT while still normalizing compact Prisma-style SET NULL actions', () => {
        const nullableDefault = scoreErdSchema(sqlToErdSchema(`
            CREATE TABLE p (id INT PRIMARY KEY);
            CREATE TABLE c (pid INT REFERENCES p(id) ON DELETE SET DEFAULT);
        `));
        expect(nullableDefault.categories.find((item) => item.id === 'lifecycleSafety')).toMatchObject({ score: 8, maxScore: 8 });
        expect(nullableDefault.stats.unsafeLifecycleRelationships).toBe(0);

        const requiredSetNull = healthySchema();
        requiredSetNull.relations[0].actions = { onDelete: 'SetNull' };
        const prismaStyle = scoreErdSchema(requiredSetNull);
        expect(prismaStyle.score).toBe(69);
        expect(prismaStyle.stats.unsafeLifecycleRelationships).toBe(1);
    });

    it('recognizes supported identity types and bare-AS computed expressions', () => {
        const result = scoreErdSchema(sqlToErdSchema(`
            CREATE TABLE tiny_ids (id TINYINT AUTO_INCREMENT PRIMARY KEY);
            CREATE TABLE medium_ids (id MEDIUMINT AUTO_INCREMENT PRIMARY KEY);
            CREATE TABLE numeric_ids (id DECIMAL(10,0) IDENTITY(1,1) PRIMARY KEY);
            CREATE TABLE computed_values (
                id INT PRIMARY KEY,
                source_date DATETIME,
                next_date AS DATEADD(DAY, 1, source_date) PERSISTED
            );
        `));

        expect(result.categories.find((item) => item.id === 'columnCoherence')).toMatchObject({ score: 8, maxScore: 8 });
        expect(result.stats.incoherentColumnDefinitions).toBe(0);
        expect(result.stats.safeguardedBusinessColumns).toBeGreaterThanOrEqual(1);
    });

    it('recognizes parenthesized and cast NULL defaults as incoherent on required columns', () => {
        const result = scoreErdSchema(schema([
            {
                name: 'items',
                columns: [
                    column('id', 'BIGINT', { pk: true }),
                    column('a', 'TEXT', { notNull: true, extras: ['DEFAULT (NULL)'] }),
                    column('b', 'TEXT', { notNull: true, extras: ['DEFAULT ((NULL))'] }),
                    column('c', 'TEXT', { notNull: true, extras: ['DEFAULT NULL::TEXT'] }),
                ],
            },
        ]));

        expect(result.stats.incoherentColumnDefinitions).toBe(3);
        expect(result.stats.safeguardedBusinessColumns).toBe(0);
    });

    it('does not grant ambiguous leaf-name enum credit and catches duplicate type definitions', () => {
        const ambiguous = scoreErdSchema(schema([
            { name: 'events', columns: [column('id', 'BIGINT', { pk: true }), column('status', 'status')] },
        ], [], {
            enums: [{ name: 's1.status', values: ['open'] }, { name: 's2.status', values: ['closed'] }],
        }));
        expect(ambiguous.categories.find((item) => item.id === 'columnSafeguards')).toMatchObject({ score: 2, maxScore: 8 });

        const duplicateTypes = scoreErdSchema(sqlToErdSchema(`
            CREATE TYPE mood AS ENUM ('a');
            CREATE TYPE mood AS ENUM ('b');
            CREATE TABLE t (id INT PRIMARY KEY);
        `));
        expect(duplicateTypes.score).toBe(49);
        expect(duplicateTypes.stats.duplicateEnumNames).toBe(1);
    });

    it('treats same-family type modifiers as compatible without a critical cap', () => {
        const source = schema([
            { name: 'parents', columns: [column('code', 'VARCHAR(100)', { pk: true })] },
            { name: 'children', columns: [column('id', 'BIGINT', { pk: true }), column('parent_code', 'VARCHAR(255)', { indexed: true, fk: true })] },
        ], [relation('children', 'parent_code', 'parents', 'code', { fromCard: '0..n' })]);
        const result = scoreErdSchema(source);

        expect(result.categories.find((item) => item.id === 'typeCompatibility')).toMatchObject({ score: 10, maxScore: 10 });
        expect(result.capApplied).toBeNull();
    });

    it('still treats scalar and array key types as clearly incompatible', () => {
        const source = schema([
            { name: 'parents', columns: [column('code', 'VARCHAR(100)', { pk: true })] },
            { name: 'children', columns: [column('id', 'BIGINT', { pk: true }), column('parent_code', 'VARCHAR(100)[]', { indexed: true, fk: true })] },
        ], [relation('children', 'parent_code', 'parents', 'code', { fromCard: '0..n' })]);
        const result = scoreErdSchema(source);

        expect(result.categories.find((item) => item.id === 'typeCompatibility')).toMatchObject({ score: 0, maxScore: 10 });
        expect(result.capApplied).toMatchObject({ cap: 79 });
    });

    it('applies the 89 cap when a minority of tables still lacks identity', () => {
        const source = schema([
            { name: 'one', columns: [column('id', 'BIGINT', { pk: true })] },
            { name: 'two', columns: [column('id', 'BIGINT', { pk: true })] },
            { name: 'three', columns: [column('id', 'BIGINT', { pk: true })] },
            { name: 'four', columns: [column('code', 'TEXT', { extras: ['CHECK (code <> \'\')'] })] },
        ]);
        const result = scoreErdSchema(source);

        expect(result.score).toBe(89);
        expect(result.capApplied).toMatchObject({ cap: 89, reasons: ['At least one table lacks a primary key'] });
    });

    it('caps dropped SQL relationships even when the remaining schema looks healthy', () => {
        const source = healthySchema();
        source._parseErrors = [{ severity: 'warning', kind: 'relation_dropped_unknown_table', message: 'A relationship target is missing.' }];
        const result = scoreErdSchema(source);

        expect(result.score).toBe(69);
        expect(result.capApplied).toMatchObject({ cap: 69, reasons: ['One or more SQL relationships were dropped'] });
        expect(result.stats.droppedRelationWarnings).toBe(1);
    });

    it('detects repeated source table and type identities after adapter display-name disambiguation', () => {
        const result = scoreErdSchema(sqlToErdSchema(`
            CREATE TABLE t (id INT PRIMARY KEY);
            CREATE TABLE t (other_id INT PRIMARY KEY);
            CREATE TYPE mood AS ENUM ('a');
            CREATE TYPE mood AS ENUM ('b');
        `));

        expect(result.score).toBe(49);
        expect(result.stats).toMatchObject({ duplicateTableNames: 1, duplicateEnumNames: 1 });
    });

    it('requires a meaningful default only for required SET DEFAULT sources', () => {
        const missingDefault = healthySchema();
        missingDefault.relations[0].actions = { onDelete: 'SET DEFAULT' };
        const unsafe = scoreErdSchema(missingDefault);
        expect(unsafe.score).toBe(69);

        missingDefault.tables[1].columns[1].extras.push('DEFAULT 0');
        const safe = scoreErdSchema(missingDefault);
        expect(safe.stats.unsafeLifecycleRelationships).toBe(0);
        expect(safe.categories.find((item) => item.id === 'lifecycleSafety')).toMatchObject({ score: 8, maxScore: 8 });
    });

    it('is deterministic, input-immutable, and always keeps non-empty schemas within 1–100', () => {
        const source = schema([
            { name: 'users', columns: [column('id', 'BIGINT', { pk: true })] },
            { name: 'posts', columns: [column('id', 'BIGINT', { pk: true }), column('user_id', 'BIGINT')] },
        ]);
        const before = JSON.parse(JSON.stringify(source));
        const first = scoreErdSchema(source);

        expect(scoreErdSchema(source)).toEqual(first);
        expect(source).toEqual(before);
        expect(first.score).toBeGreaterThanOrEqual(1);
        expect(first.score).toBeLessThanOrEqual(100);
    });
});
