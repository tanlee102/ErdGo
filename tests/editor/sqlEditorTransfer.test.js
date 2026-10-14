/** Malformed or unrelated history state cannot initialize an SQL workspace. */
import { describe, expect, it } from 'vitest';
import { readSqlEditorTransfer } from '@/features/editor/lib/sqlEditorTransfer';

describe('SQL editor route transfer', () => {
    it.each([null, {}, { sqlEditorTransfer: {} }, { sqlEditorTransfer: { version: 2, sql: 'SELECT 1', dialect: 'sqlite' } }, { sqlEditorTransfer: { version: 1, sql: ' ', dialect: 'postgres' } }, { sqlEditorTransfer: { version: 1, sql: 'SELECT 1', dialect: 'invalid' } }])('rejects invalid handoff %j', state => {
        expect(readSqlEditorTransfer(state)).toBeNull();
    });
    it('preserves SQL verbatim and normalizes the independent new-document name', () => {
        expect(readSqlEditorTransfer({ sqlEditorTransfer: { version: 1, sql: '\nCREATE TABLE a (id INT);\n', name: '  Shop  ', dialect: 'postgres', uuid: 'source-builder-file' } })).toEqual({ sql: '\nCREATE TABLE a (id INT);\n', name: 'Shop', dialect: 'postgres' });
    });
});
