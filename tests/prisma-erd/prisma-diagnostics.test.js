/** Verifies Prisma diagnostic grouping, ordering, counts, and display limits. */
import { describe, expect, it } from 'vitest';
import {
    countPrismaDiagnostics,
    getPrismaDiagnosticHint,
    groupPrismaDiagnostics,
    normalizePrismaDiagnostics,
} from '@/features/prisma-erd/lib/prismaDiagnostics.js';

describe('Prisma diagnostics', () => {
    it('deduplicates identical diagnostics and suppresses delimiter fallout from lexical errors', () => {
        const result = normalizePrismaDiagnostics([
            { severity: 'error', line: 4, message: 'Unterminated string near line 4.' },
            { severity: 'error', line: 4, message: 'model User field name has unbalanced field or attribute delimiters.' },
            { severity: 'error', line: 4, message: 'Unterminated string near line 4.' },
            { severity: 'warning', line: 8, message: 'Useful warning.' },
        ]);

        expect(result).toEqual([
            { severity: 'error', line: 4, message: 'Unterminated string near line 4.' },
            { severity: 'warning', line: 8, message: 'Useful warning.' },
        ]);
    });

    it('counts notes separately from warnings and creates stable severity groups', () => {
        const diagnostics = [
            { severity: 'warning', message: 'Warning' },
            { severity: 'info', message: 'Note' },
            { severity: 'error', message: 'Error' },
        ];

        expect(countPrismaDiagnostics(diagnostics)).toEqual({ error: 1, warning: 1, info: 1 });
        expect(groupPrismaDiagnostics(diagnostics).map((group) => [group.label, group.items.length])).toEqual([
            ['Errors', 1],
            ['Warnings', 1],
            ['Notes', 1],
        ]);
    });

    it('suppresses semantic fallout on a line that already has a syntax error', () => {
        const diagnostics = normalizePrismaDiagnostics([
            { severity: 'error', line: 8, column: 3, message: 'model User field email has unexpected content after the field type: nope.' },
            { severity: 'warning', line: 8, column: 3, message: 'User.email uses unknown scalar type nope.' },
            { severity: 'warning', line: 12, message: 'Independent warning.' },
        ]);

        expect(diagnostics).toEqual([
            { severity: 'error', line: 8, column: 3, message: 'model User field email has unexpected content after the field type: nope.' },
            { severity: 'warning', line: 12, message: 'Independent warning.' },
        ]);
    });

    it('limits each rendered group without losing total counts and provides repair hints', () => {
        const diagnostics = Array.from({ length: 5 }, (_, index) => ({
            severity: 'error',
            line: index + 1,
            message: `Invalid Prisma model block near line ${index + 1}.`,
        }));
        const [group] = groupPrismaDiagnostics(diagnostics, { error: 2, warning: 0, info: 0 });

        expect(group).toEqual(
            expect.objectContaining({
                label: 'Errors',
                total: 5,
                hiddenCount: 3,
                items: diagnostics.slice(0, 2),
            }),
        );
        expect(getPrismaDiagnosticHint(diagnostics[0])).toContain('model User {');
        expect(getPrismaDiagnosticHint({ message: 'MongoDB does not support implicit many-to-many relations.' })).toContain('scalar ID arrays');
        expect(getPrismaDiagnosticHint({ message: 'User.groups and Group.users require an annotated @relation(fields: [...], references: [...]); only list-to-list relations can be implicit.' })).toContain('singular field');
        expect(getPrismaDiagnosticHint({ message: 'Audit has no unique identifier.' })).toContain('identifies every record');
        expect(getPrismaDiagnosticHint({ message: 'Order must declare @@schema because datasource db lists database schemas.' })).toContain('datasource block');
        expect(getPrismaDiagnosticHint({ message: 'Post.author must use @mongo.ObjectId on both relation scalar fields.' })).toContain('referenced ID field');
        expect(getPrismaDiagnosticHint({ message: 'sequence() is only supported by CockroachDB.' })).toContain('autoincrement()');
    });
});
