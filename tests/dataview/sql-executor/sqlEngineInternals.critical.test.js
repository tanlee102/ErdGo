/** Locks critical internal SQL-engine invariants not visible through simple result assertions. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SENTINEL, generateUuid, UUID_FN_NAMES } from '@/features/data-view/lib/dataValues.js';
import {
    isSqliteBlobValue,
    sqliteBinaryCompare,
    sqliteColumnAffinity,
    sqliteNumericValue,
    sqliteStorageClassLabel,
    sqliteStorageCompare,
    sqliteStrictTypeFamily,
} from '@/features/data-view/lib/sqliteSemantics.js';

describe('Data View internal value contracts', () => {
    it('uses an unforgeable DEFAULT sentinel', () => {
        expect(typeof DEFAULT_SENTINEL).toBe('symbol');
        expect(DEFAULT_SENTINEL).not.toBe('DEFAULT');
    });

    it('recognizes documented UUID generators and produces RFC-4122 v4 values', () => {
        expect(UUID_FN_NAMES).toEqual(new Set([
            'GEN_RANDOM_UUID', 'UUID_GENERATE_V1', 'UUID_GENERATE_V3', 'UUID_GENERATE_V4',
            'UUID_GENERATE_V5', 'UUID', 'NEWID', 'NEWSEQUENTIALID', 'SYS_GUID',
        ]));
        const values = Array.from({ length: 16 }, () => generateUuid());
        expect(new Set(values).size).toBe(values.length);
        values.forEach((value) => expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i));
    });
});

describe('SQLite semantic primitives', () => {
    it('accepts complete decimal/exponent numerics and rejects partial coercions', () => {
        expect(sqliteNumericValue('  -12.5e2 ')).toBe(-1250);
        expect(sqliteNumericValue('.25')).toBe(0.25);
        expect(sqliteNumericValue('12px')).toBeNull();
        expect(sqliteNumericValue('Infinity')).toBeNull();
        expect(sqliteNumericValue('0x10')).toBeNull();
    });

    it('classifies comparison affinity and STRICT storage families independently', () => {
        expect(sqliteColumnAffinity('VARCHAR(50)')).toBe('text');
        expect(sqliteColumnAffinity('DECIMAL(10,2)')).toBe('numeric');
        expect(sqliteColumnAffinity('BLOB')).toBeNull();
        expect(['INT', 'INTEGER'].map(sqliteStrictTypeFamily)).toEqual(['integer', 'integer']);
        expect(sqliteStrictTypeFamily('ANY')).toBe('any');
        expect(sqliteStrictTypeFamily('VARCHAR')).toBeNull();
    });

    it('uses SQLite BINARY ordering instead of locale-aware text ordering', () => {
        expect(sqliteBinaryCompare('Z', 'a')).toBeLessThan(0);
        expect(sqliteBinaryCompare('a', 'aa')).toBeLessThan(0);
        expect(sqliteBinaryCompare('é', 'z')).toBeGreaterThan(0);
    });

    it('orders storage classes as NULL, numeric, text, then blob-like values', () => {
        const blob = new Uint8Array([1]);
        expect(sqliteStorageCompare(null, 0)).toBeLessThan(0);
        expect(sqliteStorageCompare(1, '1')).toBeLessThan(0);
        expect(sqliteStorageCompare('z', blob)).toBeLessThan(0);
        expect(isSqliteBlobValue(blob)).toBe(true);
        expect(sqliteStorageClassLabel(blob)).toBe('BLOB');
        expect(sqliteStorageClassLabel('1.5')).toBe('REAL');
    });
});
