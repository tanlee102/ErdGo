/** Protects CSV export against unsafe formulas, binary values, and edge-case cells. */
import { describe, expect, it } from 'vitest';
import { buildTableCsv, buildTableCsvDownload, escapeCsvCell, sanitizeCsvFileName } from '@/features/data-view/lib/exportTableData.js';

describe('CSV export deep contracts', () => {
    it.each([
        ['=1+1', "'=1+1"],
        ['+cmd', "'+cmd"],
        ['-cmd', "'-cmd"],
        ['@cmd', "'@cmd"],
        ['\t=cmd', "'\t=cmd"],
        ['\r=cmd', '"\'\r=cmd"'],
    ])('neutralizes spreadsheet formula prefix %s', (input, expected) => {
        expect(escapeCsvCell(input)).toBe(expected);
    });

    it('formats dates, invalid dates, booleans, bigint, and nullish values', () => {
        expect(escapeCsvCell(new Date('2026-05-23T01:02:03Z'))).toBe('2026-05-23T01:02:03.000Z');
        expect(escapeCsvCell(new Date('bad'))).toBe('');
        expect(escapeCsvCell(10n)).toBe('10');
        expect(escapeCsvCell(false)).toBe('FALSE');
        expect(escapeCsvCell(undefined)).toBe('');
    });

    it('keeps empty tables exportable with only the header row', () => {
        const csv = buildTableCsv({ columns: [{ name: 'id' }, { name: 'name' }], rows: [] });

        expect(csv).toBe('id,name\r\n');
    });

    it('drops unnamed columns from export output', () => {
        const csv = buildTableCsv({
            columns: [{ name: 'id' }, {}, { name: 'name' }],
            rows: [{ id: 1, ignored: 'x', name: 'Ada' }],
        });

        expect(csv).toBe('id,name\r\n1,Ada\r\n');
    });

    it('bounds sanitized filenames and falls back for symbol-only names', () => {
        expect(sanitizeCsvFileName('///')).toBe('table');
        expect(sanitizeCsvFileName('a'.repeat(120))).toHaveLength(80);
    });

    it('uses table-data fallback for download payload names', () => {
        const download = buildTableCsvDownload({ name: '', columns: [], rows: [] }, new Date('2026-05-23T00:00:00Z'));

        expect(download.fileName).toBe('table-data-2026-05-23-00-00-00.csv');
        expect(download.csv.startsWith('\uFEFF')).toBe(true);
    });
});
