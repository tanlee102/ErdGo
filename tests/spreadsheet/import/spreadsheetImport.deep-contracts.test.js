/** Protects difficult spreadsheet normalization, inference, and SQL-generation cases. */
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
    SPREADSHEET_IMPORT_LIMITS,
    createSqlModel,
    getSpreadsheetSqlDialect,
    parseDelimitedText,
    parseSimpleSpreadsheetXml,
    sanitizeSqlIdentifier,
    suggestTableName,
    parseSpreadsheetFile,
    unzipSpreadsheetArchive,
} from '@/features/spreadsheet-to-sql/lib/spreadsheetImport.js';

describe('spreadsheet import deep contracts', () => {
    it('rejects oversized uploads before reading their contents', async () => {
        let read = false;
        const file = {
            name: 'oversized.csv',
            size: SPREADSHEET_IMPORT_LIMITS.maxFileBytes + 1,
            text: async () => {
                read = true;
                return 'id\n1';
            },
        };

        await expect(parseSpreadsheetFile(file)).rejects.toThrow('too large to import safely');
        expect(read).toBe(false);
    });

    it('rejects ZIP expansion and archive-entry bombs before extracting XML', () => {
        const archive = zipSync({
            'xl/workbook.xml': strToU8('<workbook>' + 'x'.repeat(64) + '</workbook>'),
            'xl/styles.xml': strToU8('<styles/>'),
        });
        const baseLimits = { maxFileBytes: archive.length + 1, maxArchiveEntries: 10, maxUncompressedBytes: 16 };
        expect(() => unzipSpreadsheetArchive(archive, baseLimits)).toThrow('expands beyond the safe import limit');
        expect(() => unzipSpreadsheetArchive(archive, { ...baseLimits, maxArchiveEntries: 1, maxUncompressedBytes: 1024 })).toThrow('too many files');
    });

    it('fails closed on mismatched or unclosed XML in the non-DOM fallback parser', () => {
        expect(() => parseSimpleSpreadsheetXml('<workbook><sheet></workbook>')).toThrow('mismatched closing tag');
        expect(() => parseSimpleSpreadsheetXml('<workbook><sheet/></workbook')).toThrow('unclosed <workbook> tag');
        expect(parseSimpleSpreadsheetXml('<workbook><sheet name="A"/></workbook>').getElementsByTagName('sheet')).toHaveLength(1);
    });

    it('detects semicolon-delimited text while respecting quoted delimiters', () => {
        const rows = parseDelimitedText(`name;note
Ada;"hello;world"
Grace;plain`, ';');

        expect(rows).toEqual([
            ['name', 'note'],
            ['Ada', 'hello;world'],
            ['Grace', 'plain'],
        ]);
    });

    it.each([
        [' 123 total ', 'fallback_123_total'],
        ['select', 'select_value'],
        ['full name', 'full_name'],
        ['', 'fallback'],
    ])('sanitizes SQL identifiers from spreadsheet headers', (input, expected) => {
        expect(sanitizeSqlIdentifier(input, 'fallback')).toBe(expected);
    });

    it('combines file and sheet names when both are present', () => {
        expect(suggestTableName('report.csv', 'May Sales')).toBe('report_may_sales');
        expect(suggestTableName('Quarterly Report.xlsx', '')).toBe('quarterly_report');
    });

    it('falls back to sqlite dialect for unknown dialect ids', () => {
        expect(getSpreadsheetSqlDialect('unknown').id).toBe('sqlite');
    });

    it('creates SQL model with typed columns and dialect-specific insert batching', () => {
        const model = createSqlModel({
            tableName: 'Sales Upload',
            dialect: 'sqlserver',
            rows: [
                ['Order ID', 'Paid', 'Amount', 'Created At'],
                ['1', 'true', '12.50', '2026-05-23T10:00:00Z'],
                ['2', 'false', '7', '2026-05-24T10:00:00Z'],
            ],
        });

        expect(model.tableName).toBe('sales_upload');
        expect(model.columns.map((column) => column.name)).toEqual(['order_id', 'paid', 'amount', 'created_at']);
        expect(model.sql).toContain('[sales_upload]');
        expect(model.sql).toContain('BIT');
        expect(model.sql).toContain('DATETIME2');
    });
});
