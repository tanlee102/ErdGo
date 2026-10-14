/** Protects critical tokenizer, planner, and evaluator internals. */
import { describe, expect, it } from 'vitest';
import { QueryError } from '@/features/query-view/lib/queryLanguage.js';
import { splitTopLevel, trimStatement } from '@/features/query-view/lib/queryTokens.js';

const token = (type, value, column = 1) => ({
    type,
    value,
    raw: value,
    start: { idx: column - 1, line: 1, col: column },
});

describe('Query View internal parser contracts', () => {
    it('splits only top-level commas and preserves nested function arguments', () => {
        const tokens = [
            token('IDENT', 'a'), token('PUNC', ','),
            token('IDENT', 'COALESCE'), token('PUNC', '('), token('IDENT', 'b'),
            token('PUNC', ','), token('NUMBER', '0'), token('PUNC', ')'),
        ];
        expect(splitTopLevel(tokens, ',').map((chunk) => chunk.map((item) => item.value))).toEqual([
            ['a'],
            ['COALESCE', '(', 'b', ',', '0', ')'],
        ]);
    });

    it('preserves empty list items so malformed SQL cannot be normalized away', () => {
        const chunks = splitTopLevel([token('IDENT', 'a'), token('PUNC', ',')], ',');
        expect(chunks).toHaveLength(2);
        expect(chunks[1]).toEqual([]);
    });

    it('rejects both directions of unbalanced parentheses with positions', () => {
        expect(() => splitTopLevel([token('PUNC', ')', 7)], ',')).toThrow(QueryError);
        expect(() => splitTopLevel([token('PUNC', '(', 5), token('NUMBER', '1', 6)], ',')).toThrowError(
            expect.objectContaining({
                message: expect.stringContaining('Unclosed opening parenthesis'),
                position: { line: 1, column: 5, index: 4 },
            }),
        );
    });

    it('allows a trailing terminator but rejects a second statement', () => {
        expect(trimStatement([token('KW', 'SELECT'), token('NUMBER', '1'), token('PUNC', ';')])).toHaveLength(2);
        expect(() => trimStatement([
            token('KW', 'SELECT'), token('NUMBER', '1'), token('PUNC', ';'),
            token('KW', 'SELECT'), token('NUMBER', '2'),
        ])).toThrow(/exactly one SELECT statement/i);
    });
});
