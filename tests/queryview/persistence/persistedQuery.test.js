/** Verifies Query View state normalization and editor-context persistence. */
import { describe, expect, it } from 'vitest';

import { applyPersistedQueryToContext, getPersistedQueryFromContext, shouldPersistQueryValue } from '@/features/query-view/lib/persistedQuery';

describe('persisted query context helpers', () => {
    it('reads an absent query from old save contexts as empty', () => {
        expect(getPersistedQueryFromContext({ tablePositions: {} })).toBe('');
        expect(getPersistedQueryFromContext(null)).toBe('');
    });

    it('stores the query under the queryView namespace', () => {
        const context = { tablePositions: { users: { x: 1, y: 2 } } };

        expect(applyPersistedQueryToContext(context, 'SELECT * FROM users;')).toBe(true);

        expect(context).toEqual({
            tablePositions: { users: { x: 1, y: 2 } },
            queryView: {
                query: 'SELECT * FROM users;',
            },
        });
        expect(getPersistedQueryFromContext(context)).toBe('SELECT * FROM users;');
    });

    it('preserves future queryView fields while updating query', () => {
        const context = {
            queryView: {
                query: 'SELECT 1;',
                layout: 'split',
            },
        };

        applyPersistedQueryToContext(context, 'SELECT 2;');

        expect(context.queryView).toEqual({
            query: 'SELECT 2;',
            layout: 'split',
        });
    });

    it('removes only the query field when cleared', () => {
        const context = {
            tableColors: {},
            queryView: {
                query: 'SELECT 1;',
                layout: 'split',
            },
        };

        expect(applyPersistedQueryToContext(context, '')).toBe(true);

        expect(context).toEqual({
            tableColors: {},
            queryView: {
                layout: 'split',
            },
        });
    });

    it('removes queryView entirely when query was the only field', () => {
        const context = {
            tableColors: {},
            queryView: {
                query: 'SELECT 1;',
            },
        };

        applyPersistedQueryToContext(context, '');

        expect(context).toEqual({
            tableColors: {},
        });
    });

    it('reports no mutation when the query is unchanged', () => {
        const context = {
            queryView: {
                query: 'SELECT 1;',
            },
        };

        expect(applyPersistedQueryToContext(context, 'SELECT 1;')).toBe(false);
    });

    it('does not persist an untouched generated sample query', () => {
        expect(
            shouldPersistQueryValue({
                query: 'SELECT *\nFROM users\nLIMIT 100;',
                generatedQuery: 'SELECT *\nFROM users\nLIMIT 100;',
                userEdited: false,
            }),
        ).toBe(false);
    });

    it('persists a generated query after the user edits the query editor', () => {
        expect(
            shouldPersistQueryValue({
                query: 'SELECT *\nFROM users\nLIMIT 100;',
                generatedQuery: 'SELECT *\nFROM users\nLIMIT 100;',
                userEdited: true,
            }),
        ).toBe(true);
    });

    it('persists a restored saved query because it is not a generated sample', () => {
        expect(
            shouldPersistQueryValue({
                query: 'SELECT id FROM users;',
                generatedQuery: '',
                userEdited: false,
            }),
        ).toBe(true);
    });
});
