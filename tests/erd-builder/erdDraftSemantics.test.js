import { describe, expect, it } from 'vitest';
import { healthcareDraft } from '@/features/erd-draft/data/draftTemplate';
import {
    formatDraftEdgeEndLabel,
    normalizeDraftEdgeSemantics,
    normalizeDraftNodeSemantics,
    validateErdDraftGraph,
    validateDraftCardinality,
    isDraftSemanticConnection,
} from '@/features/erd-draft/lib/erdDraftSemantics';

const node = (id, shape, label = id, data = {}) => ({
    id,
    data: { shape, label, ...data },
});

const edge = (id, source, target, data = {}) => ({ id, source, target, data });

describe('ERD Builder Chen semantics', () => {
    it('normalizes explicit white/black label choices and defaults missing or malformed legacy values to white', () => {
        for (const value of [undefined, null, 'auto', '#000000', 1, 'BLACK', 'white', 'black']) {
            const data = Object.freeze({ labelTextColor: value, color: '#2389dd' });
            expect(normalizeDraftNodeSemantics('entity', data).labelTextColor).toBe(value === 'black' ? 'black' : 'white');
            expect(data.labelTextColor).toBe(value);
        }
    });

    it('defaults notes to theme text and preserves explicit manual overrides without mutating old snapshots', () => {
        for (const mode of [undefined, null, 'white', true, 'theme', 'custom']) {
            const data = Object.freeze({ labelTextColor: 'black', noteTextColorMode: mode });
            const normalized = normalizeDraftNodeSemantics('note', data);
            expect(normalized.noteTextColorMode).toBe(mode === 'custom' ? 'custom' : 'theme');
            expect(normalized.labelTextColor).toBe('black');
            expect(data.noteTextColorMode).toBe(mode);
        }
        expect(normalizeDraftNodeSemantics('note', {}).noteTextColorMode).toBe('theme');
    });

    it('ships a healthcare starter without structural warnings or shared key ownership', () => {
        expect(validateErdDraftGraph(healthcareDraft.nodes, healthcareDraft.edges)).toEqual([]);
    });

    it('detects shared attribute ownership through composite chains and ignores annotations', () => {
        const nodes = [node('a', 'entity'), node('b', 'entity'), node('c', 'compositeAttribute'), node('d', 'attribute')];
        const edges = [edge('ac', 'a', 'c'), edge('cd', 'c', 'd'), edge('db', 'd', 'b')];
        expect(validateErdDraftGraph(nodes, edges).map(item => item.code)).toContain('attribute-multiple-owners');
        edges[2].data.connectionKind = 'annotation';
        expect(validateErdDraftGraph(nodes, edges).map(item => item.code)).not.toContain('attribute-multiple-owners');
    });

    it('detects composite cycles without treating duplicate links as cycles', () => {
        const nodes = ['a', 'b', 'c'].map(id => node(id, 'compositeAttribute'));
        const edges = [edge('ab', 'a', 'b'), edge('bc', 'b', 'c')];
        expect(validateErdDraftGraph(nodes, [...edges, edge('ba', 'b', 'a')]).map(item => item.code)).not.toContain('composite-attribute-cycle');
        expect(validateErdDraftGraph(nodes, [...edges, edge('ca', 'c', 'a')]).map(item => item.code)).toContain('composite-attribute-cycle');
    });

    it.each([['double', '0', true], ['single', '1', true], ['double', '1', false], ['single', '0', false]])('checks %s participation against minimum %s', (lineCount, minimum, mismatch) => {
        const nodes = [node('e', 'entity'), node('r', 'relationship')];
        const data = { cardinalityMode: 'minmax', lineCount, sourceMin: minimum, sourceMax: 'N', targetCardinalityEnabled: false };
        const codes = validateErdDraftGraph(nodes, [edge('er', 'e', 'r', data)]).map(item => item.code);
        expect(codes.includes('participation-cardinality-mismatch')).toBe(mismatch);
        for (const change of [{ cardinalityMode: 'manual' }, { connectionKind: 'annotation' }, { sourceCardinalityEnabled: false }]) {
            expect(validateErdDraftGraph(nodes, [edge('er', 'e', 'r', { ...data, ...change })]).map(item => item.code)).not.toContain('participation-cardinality-mismatch');
        }
    });
    it('keeps legacy manual labels while normalizing optional semantic fields', () => {
        const normalized = normalizeDraftEdgeSemantics({
            sourceLabel: '1, 1',
            targetLabel: 'N, 0',
        });

        expect(normalized).toMatchObject({
            cardinalityMode: 'manual',
            sourceLabel: '1, 1',
            targetLabel: 'N, 0',
            sourceRole: '',
            targetRole: '',
            sourceMin: '0',
            sourceMax: 'N',
            targetMin: '0',
            targetMax: 'N',
            sourceCardinalityEnabled: true,
            targetCardinalityEnabled: true,
        });
        expect(formatDraftEdgeEndLabel(normalized, 'source')).toBe('1, 1');
        expect(formatDraftEdgeEndLabel(normalized, 'target')).toBe('N, 0');
    });

    it('formats structured classic and min-max cardinality with role names', () => {
        const classic = normalizeDraftEdgeSemantics({
            cardinalityMode: 'classic',
            sourceRole: 'manager',
            sourceMax: '1',
        });
        const minMax = normalizeDraftEdgeSemantics({
            cardinalityMode: 'minmax',
            targetRole: 'dependent',
            targetMin: '1',
            targetMax: 'N',
        });

        expect(formatDraftEdgeEndLabel(classic, 'source')).toBe('manager · 1');
        expect(formatDraftEdgeEndLabel(minMax, 'target')).toBe('dependent · (1, N)');
    });

    it('keeps manual labels exact and suppresses structured labels on non-participant ends', () => {
        expect(formatDraftEdgeEndLabel({
            cardinalityMode: 'manual',
            sourceLabel: 'legacy',
            sourceRole: 'stale role',
        }, 'source')).toBe('legacy');
        expect(formatDraftEdgeEndLabel({
            cardinalityMode: 'minmax',
            sourceRole: 'relationship side',
            sourceMin: '0',
            sourceMax: 'N',
            sourceCardinalityEnabled: false,
        }, 'source')).toBe('');
    });

    it('normalizes partial-key, ISA, category, and aggregation details without changing old nodes', () => {
        expect(normalizeDraftNodeSemantics('partialKeyAttribute', {})).toMatchObject({ domain: '' });
        expect(normalizeDraftNodeSemantics('isa', {})).toMatchObject({
            specializationConstraint: 'disjoint',
            specializationCompleteness: 'partial',
        });
        expect(normalizeDraftNodeSemantics('category', {})).toMatchObject({ categoryCompleteness: 'partial' });
        expect(normalizeDraftNodeSemantics('aggregation', { description: 'Process boundary' })).toMatchObject({
            description: 'Process boundary',
        });
        expect(normalizeDraftNodeSemantics('note', {})).toMatchObject({ textAlign: 'left' });
        expect(normalizeDraftNodeSemantics('note', { textAlign: 'center' })).toMatchObject({ textAlign: 'center' });
        expect(normalizeDraftNodeSemantics('entity', { description: 'Legacy entity' })).toEqual({
            description: 'Legacy entity',
            labelTextColor: 'white',
        });
    });

    it('reports weak-entity, identifying-relationship, and partial-key mistakes', () => {
        const issues = validateErdDraftGraph([
            node('owner', 'entity', 'Owner'),
            node('weak', 'weakEntity', 'Dependent'),
            node('identifies', 'identifyingRelationship', 'Identifies'),
            node('wrong-key', 'keyAttribute', 'Name'),
        ], [
            edge('owner-rel', 'owner', 'identifies'),
            edge('weak-key', 'weak', 'wrong-key'),
        ]);

        expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
            'weak-entity-missing-identifying-relationship',
            'weak-entity-missing-partial-key',
            'identifying-relationship-missing-weak-entity',
        ]));
    });

    it('accepts a complete weak-entity pattern', () => {
        const issues = validateErdDraftGraph([
            node('owner', 'entity', 'Employee'),
            node('weak', 'weakEntity', 'Dependent'),
            node('identifies', 'identifyingRelationship', 'Has'),
            node('partial', 'partialKeyAttribute', 'Name'),
        ], [
            edge('owner-rel', 'owner', 'identifies'),
            edge('weak-rel', 'weak', 'identifies', { lineCount: 'double' }),
            edge('weak-key', 'weak', 'partial'),
        ]);

        expect(issues.map((issue) => issue.code)).not.toEqual(expect.arrayContaining([
            'weak-entity-missing-identifying-relationship',
            'weak-entity-missing-partial-key',
            'identifying-relationship-missing-weak-entity',
        ]));
    });

    it('validates relationship degree, recursive roles, structured bounds, ISA, and categories', () => {
        const issues = validateErdDraftGraph([
            node('person', 'entity', 'Person'),
            node('manages', 'relationship', 'Manages'),
            node('isa', 'isa', 'ISA'),
            node('union', 'category', 'Owner'),
        ], [
            edge('person-manages-a', 'person', 'manages', {
                cardinalityMode: 'minmax', sourceMin: '2', sourceMax: '1', sourceRole: 'manager',
            }),
            edge('person-manages-b', 'person', 'manages', {
                cardinalityMode: 'classic', sourceRole: 'manager', sourceMax: 'N',
            }),
            edge('person-isa', 'person', 'isa'),
            edge('person-union', 'person', 'union'),
        ]);

        expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
            'invalid-cardinality-range',
            'recursive-relationship-duplicate-role',
            'isa-needs-supertype-and-subtype',
            'category-needs-union-members',
        ]));
    });
    it('normalizes label visibility and ISA roles without guessing legacy inheritance', () => {
        expect(normalizeDraftNodeSemantics('isa', { label: ' ' }).showLabel).toBe(false);
        expect(normalizeDraftNodeSemantics('isa', { label: '' }).showLabel).toBe(true);
        expect(normalizeDraftNodeSemantics('isa', { label: 'ISA', showLabel: false }).showLabel).toBe(false);
        expect(normalizeDraftNodeSemantics('isa', { label: ' ', showLabel: true }).showLabel).toBe(true);
        expect(normalizeDraftNodeSemantics('isa', { showLabel: 'false' }).showLabel).toBe(true);
        expect(normalizeDraftEdgeSemantics({ isaRole: 'invalid' }).isaRole).toBe('unspecified');
        expect(normalizeDraftEdgeSemantics({}).isaRole).toBe('unspecified');
    });

    it('requires explicit ISA roles even when two entities are connected', () => {
        const nodes = [node('isa', 'isa', ' '), node('parent', 'entity'), node('child', 'entity')];
        const edges = [edge('p', 'parent', 'isa'), edge('c', 'isa', 'child')];
        const snapshot = JSON.stringify({ nodes, edges });
        const issues = validateErdDraftGraph(nodes, edges);
        expect(issues.filter(({ code }) => code === 'isa-role-unspecified').map(({ edgeId }) => edgeId)).toEqual(['p', 'c']);
        expect(issues.every(({ message }) => !message.includes('“”'))).toBe(true);
        expect(JSON.stringify({ nodes, edges })).toBe(snapshot);
    });

    it('validates explicit roles independently of labels, direction, positions, and handles', () => {
        const nodes = [node('isa', 'isa', ' ', { showLabel: false }), node('parent', 'entity'), node('child', 'entity')];
        const edges = [
            { ...edge('p', 'isa', 'parent', { isaRole: 'supertype' }), sourceHandle: 'bottom' },
            { ...edge('c', 'child', 'isa', { isaRole: 'subtype' }), targetHandle: 'top' },
        ];
        expect(validateErdDraftGraph(nodes, edges)).toEqual([]);
        expect(validateErdDraftGraph(nodes.map(n => ({ ...n, position: { x: 900, y: -500 } })), edges)).toEqual([]);
    });

    it('rejects missing or multiple supertypes and missing subtypes', () => {
        const nodes = [node('isa', 'isa'), node('a', 'entity'), node('b', 'entity')];
        for (const isaRole of ['subtype', 'supertype']) {
            const issues = validateErdDraftGraph(nodes, [edge('a', 'a', 'isa', { isaRole }), edge('b', 'isa', 'b', { isaRole })]);
            expect(issues.map(({ code }) => code)).toContain('isa-needs-supertype-and-subtype');
        }
    });

    it('reports invalid ISA endpoints, duplicate branches, and self inheritance', () => {
        const nodes = [node('isa', 'isa'), node('a', 'entity'), node('note', 'note')];
        const issues = validateErdDraftGraph(nodes, [
            edge('parent', 'a', 'isa', { isaRole: 'supertype' }),
            edge('child', 'isa', 'a', { isaRole: 'subtype' }),
            edge('note', 'isa', 'note'),
        ]);
        expect(issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
            'isa-invalid-endpoint', 'isa-duplicate-entity', 'isa-self-inheritance',
        ]));
    });

    it('detects inheritance cycles across ISA branches but permits a shared subtype', () => {
        const nodes = ['a', 'b', 'c'].map(id => node(id, 'entity')).concat(['ab', 'bc', 'ca'].map(id => node(id, 'isa')));
        const branch = (id, parent, child) => [edge(`${id}-p`, parent, id, { isaRole: 'supertype' }), edge(`${id}-c`, id, child, { isaRole: 'subtype' })];
        const edges = [...branch('ab', 'a', 'b'), ...branch('bc', 'b', 'c'), ...branch('ca', 'c', 'a')];
        expect(validateErdDraftGraph(nodes, edges).filter(({ code }) => code === 'isa-inheritance-cycle')).toHaveLength(3);
        expect(validateErdDraftGraph(nodes, [...branch('ab', 'a', 'c'), ...branch('bc', 'b', 'c'), ...branch('ca', 'a', 'b')])).toEqual([]);
    });

    it('rejects invalid classic values and compares arbitrarily large bounds exactly', () => {
        expect(validateDraftCardinality({ cardinalityMode: 'classic', sourceMax: 'banana' }, 'source')?.code).toBe('invalid-cardinality-value');
        expect(validateDraftCardinality({ cardinalityMode: 'minmax', sourceMin: '9007199254740993', sourceMax: '9007199254740992' }, 'source')?.code).toBe('invalid-cardinality-range');
        expect(validateDraftCardinality({ cardinalityMode: 'minmax', sourceMin: '0002', sourceMax: '2' }, 'source')).toBeNull();
        for (const sourceMin of ['', '-1', '1.2', 'Infinity', '1e3']) {
            expect(validateDraftCardinality({ cardinalityMode: 'minmax', sourceMin, sourceMax: 'N' }, 'source')?.code).toBe('invalid-cardinality-value');
        }
        for (const sourceMax of ['1', 'N', 'm', '*']) {
            expect(validateDraftCardinality({ cardinalityMode: 'classic', sourceMax }, 'source')).toBeNull();
        }
    });

    it('keeps annotations out of model checks and flags unsupported semantic links', () => {
        const nodes = [node('key', 'keyAttribute'), node('note', 'note')];
        for (const connectionKind of ['semantic', 'annotation']) {
            const issues = validateErdDraftGraph(nodes, [edge('e', 'key', 'note', { connectionKind })]);
            expect(issues.map(i => i.code)).toContain('attribute-is-disconnected');
            expect(issues.some(i => i.code === 'unsupported-semantic-connection')).toBe(connectionKind === 'semantic');
        }
        expect(isDraftSemanticConnection('entity', 'relationship')).toBe(true);
        expect(isDraftSemanticConnection('entity', 'entity')).toBe(false);
        expect(isDraftSemanticConnection('attribute', 'compositeAttribute')).toBe(true);
    });

    it('warns on duplicate semantic connections without rejecting distinct recursive roles', () => {
        const nodes = [node('person', 'entity'), node('rel', 'relationship')];
        const edges = [edge('a', 'person', 'rel', { sourceRole: 'manager' }), edge('b', 'rel', 'person', { targetRole: 'manager' })];
        expect(validateErdDraftGraph(nodes, edges).map(i => i.code)).toContain('duplicate-semantic-connection');
        edges[1].data.targetRole = 'report';
        expect(validateErdDraftGraph(nodes, edges)).toEqual([]);
    });

    it('requires category member/result roles and rejects a result that is also a member', () => {
        const nodes = [node('union', 'category'), ...['a', 'b', 'c'].map(id => node(id, 'entity'))];
        const edges = ['a', 'b', 'c'].map(id => edge(id, 'union', id));
        expect(validateErdDraftGraph(nodes, edges).filter(i => i.code === 'category-role-unspecified')).toHaveLength(3);
        edges.forEach((e, i) => { e.data.categoryRole = i === 2 ? 'result' : 'member'; });
        expect(validateErdDraftGraph(nodes, edges)).toEqual([]);
        edges[2].target = 'a';
        expect(validateErdDraftGraph(nodes, edges).map(i => i.code)).toContain('category-self-membership');
        expect(normalizeDraftEdgeSemantics({ categoryRole: 'wrong' }).categoryRole).toBe('unspecified');
        expect(normalizeDraftEdgeSemantics({}).connectionKind).toBe('semantic');
    });

});
