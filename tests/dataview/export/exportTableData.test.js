/** Verifies the normal Data View CSV export contract. */
import { describe, expect, it } from 'vitest';
import { buildTableCsv, buildTableCsvDownload, escapeCsvCell, sanitizeCsvFileName } from '@/features/data-view/lib/exportTableData.js';

const table = {
    name: 'public.users',
    columns: [{ name: 'id' }, { name: 'name' }, { name: 'note' }, { name: 'active' }],
    rows: [
        { id: 1, name: 'Ada', note: 'hello, world', active: true },
        { id: 2, name: 'Grace "Amazing" Hopper', note: 'line one\nline two', active: false },
        { id: 3, name: null, note: undefined, active: null },
    ],
};

describe('Data View CSV export', () => {
    it('exports table headers and rows in the visible column order', () => {
        expect(buildTableCsv(table)).toBe('id,name,note,active\r\n1,Ada,"hello, world",TRUE\r\n2,"Grace ""Amazing"" Hopper","line one\nline two",FALSE\r\n3,,,\r\n');
    });

    it('keeps spreadsheet formulas inert for text values', () => {
        expect(escapeCsvCell('=IMPORTXML("https://example.com")')).toBe('"\'=IMPORTXML(""https://example.com"")"');
        expect(escapeCsvCell('+SUM(1,2)')).toBe(`"'+SUM(1,2)"`);
        expect(escapeCsvCell('-unsafe')).toBe("'-unsafe");
        expect(escapeCsvCell('@user')).toBe("'@user");
    });

    it('does not change numeric negative values', () => {
        expect(escapeCsvCell(-42)).toBe('-42');
    });

    it('sanitizes table names for download filenames', () => {
        expect(sanitizeCsvFileName('sales orders / archive')).toBe('sales-orders-archive');
        expect(sanitizeCsvFileName('   ')).toBe('table');
    });

    it('creates an Excel-friendly CSV download payload with a stable filename', () => {
        const result = buildTableCsvDownload(table, new Date('2026-05-02T12:34:56Z'));

        expect(result.fileName).toBe('public.users-2026-05-02-12-34-56.csv');
        expect(result.csv.startsWith('\uFEFF')).toBe(true);
        expect(result.csv).toContain('id,name,note,active');
    });
});
