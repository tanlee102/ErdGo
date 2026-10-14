/** Defines the normal CSV/XLSX import and multi-dialect SQL-generation contract. */
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { SPREADSHEET_SQL_DIALECTS, createIssueReportCsv, createSqlModel, parseDelimitedText, parseSpreadsheetFile, sanitizeSqlIdentifier, suggestTableName } from '@/features/spreadsheet-to-sql/lib/spreadsheetImport.js';

function makeTextFile(name, text) {
    return {
        name,
        size: text.length,
        text: async () => text,
    };
}

function makeBinaryFile(name, bytes) {
    return {
        name,
        size: bytes.length,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
}

function makeXlsxFile() {
    const files = {
        '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
            <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
                <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
                <Default Extension="xml" ContentType="application/xml"/>
                <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
                <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
                <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
                <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
                <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
            </Types>`),
        '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
            <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
                <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
            </Relationships>`),
        'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
            <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
                <sheets>
                    <sheet name="Customers" sheetId="1" r:id="rId1"/>
                    <sheet name="Orders" sheetId="2" r:id="rId2"/>
                </sheets>
            </workbook>`),
        'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
            <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
                <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
                <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
            </Relationships>`),
        'xl/sharedStrings.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
            <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
                <si><t>Name</t></si>
                <si><t>Age</t></si>
                <si><t>Joined</t></si>
                <si><t>Active</t></si>
                <si><t>Note</t></si>
                <si><t>Formula</t></si>
                <si><t>Ada</t></si>
                <si><t>Grace</t></si>
                <si><t>Order Id</t></si>
                <si><t>Total</t></si>
                <si><t>Precise</t></si>
            </sst>`),
        'xl/styles.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
            <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
                <cellXfs count="2">
                    <xf numFmtId="0"/>
                    <xf numFmtId="14"/>
                </cellXfs>
            </styleSheet>`),
        'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
            <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
                <sheetData>
                    <row r="1">
                        <c r="A1" t="s"><v>0</v></c>
                        <c r="B1" t="s"><v>1</v></c>
                        <c r="C1" t="s"><v>2</v></c>
                        <c r="D1" t="s"><v>3</v></c>
                        <c r="E1" t="s"><v>4</v></c>
                        <c r="F1" t="s"><v>5</v></c>
                        <c r="G1" t="s"><v>10</v></c>
                    </row>
                    <row r="2">
                        <c r="A2" t="s"><v>6</v></c>
                        <c r="B2"><v>36</v></c>
                        <c r="C2" s="1"><v>44927</v></c>
                        <c r="D2" t="b"><v>1</v></c>
                        <c r="E2" t="inlineStr"><is><t>likes, commas &amp; quotes</t></is></c>
                        <c r="F2"><f>1+1</f><v>2</v></c>
                        <c r="G2"><v>90071992547409931234</v></c>
                    </row>
                    <row r="4">
                        <c r="A4" t="s"><v>7</v></c>
                        <c r="C4" s="1"><v>44928</v></c>
                        <c r="E4" t="inlineStr"><is><t>skipped row</t></is></c>
                    </row>
                </sheetData>
            </worksheet>`),
        'xl/worksheets/sheet2.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
            <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
                <sheetData>
                    <row r="1">
                        <c r="A1" t="s"><v>8</v></c>
                        <c r="B1" t="s"><v>9</v></c>
                    </row>
                    <row r="2">
                        <c r="A2"><v>101</v></c>
                        <c r="B2"><v>98.75</v></c>
                    </row>
                </sheetData>
            </worksheet>`),
    };

    return makeBinaryFile('sample workbook.xlsx', zipSync(files));
}

describe('spreadsheetImport', () => {
    it('parses quoted CSV cells with commas, newlines, escaped quotes, and inferred SQL types', async () => {
        const file = makeTextFile('people.csv', 'Name,Note,Amount,Active\n"Ada","Ada\'s hello, world",12.50,true\n"Grace","two\nlines with ""quotes""",-7,false\n');
        const workbook = await parseSpreadsheetFile(file);
        const model = createSqlModel({ rows: workbook.sheets[0].rows, tableName: 'People Upload', hasHeader: true, dialect: 'postgresql' });

        expect(workbook.kind).toBe('csv');
        expect(workbook.sheets[0].rows[2][1]).toBe('two\nlines with "quotes"');
        expect(model.columns.map((column) => [column.name, column.sqlType])).toEqual([
            ['name', 'TEXT'],
            ['note', 'TEXT'],
            ['amount', 'NUMERIC'],
            ['active', 'BOOLEAN'],
        ]);
        expect(model.sql).toContain("('Ada', 'Ada''s hello, world', 12.5, TRUE)");
        expect(model.sql).toContain("('Grace', 'two\nlines with \"quotes\"', -7, FALSE)");
    });

    it('preserves ordinary quotes in unquoted cells and rejects unclosed quoted CSV fields', async () => {
        expect(parseDelimitedText('Name,Note\nAda,Ada says "hello"')).toEqual([
            ['Name', 'Note'],
            ['Ada', 'Ada says "hello"'],
        ]);

        expect(() => parseDelimitedText('Name,Note\nAda,"missing close')).toThrow('This CSV has an unclosed quoted field.');
        await expect(parseSpreadsheetFile(makeTextFile('broken.csv', 'Name,Note\nAda,"missing close'))).rejects.toThrow('This CSV has an unclosed quoted field.');
    });

    it('reads CSV files from arrayBuffer when File.text is not available', async () => {
        const workbook = await parseSpreadsheetFile(makeBinaryFile('fallback.csv', strToU8('id,name\n1,Ada')));

        expect(workbook.kind).toBe('csv');
        expect(workbook.sheets[0].rows).toEqual([
            ['id', 'name'],
            ['1', 'Ada'],
        ]);
    });

    it('auto-detects semicolon CSV files', async () => {
        const workbook = await parseSpreadsheetFile(makeTextFile('orders.csv', 'id;total\n1;9.99\n2;15.50'));

        expect(workbook.delimiter).toBe(';');
        expect(workbook.sheets[0].rows).toEqual([
            ['id', 'total'],
            ['1', '9.99'],
            ['2', '15.50'],
        ]);
    });

    it('parses TSV files by extension without delimiter guessing', async () => {
        const workbook = await parseSpreadsheetFile(makeTextFile('inventory.tsv', 'sku\tqty\twarehouse\nA-1\t12\tNorth\nB-2\t0\tSouth'));
        const model = createSqlModel({ rows: workbook.sheets[0].rows, tableName: 'Inventory', hasHeader: true });

        expect(workbook.kind).toBe('tsv');
        expect(workbook.delimiter).toBe('\t');
        expect(model.columns.map((column) => [column.name, column.sqlType])).toEqual([
            ['sku', 'TEXT'],
            ['qty', 'INTEGER'],
            ['warehouse', 'TEXT'],
        ]);
    });

    it('auto-detects pipe-delimited TXT files and preserves trailing empty cells', async () => {
        const workbook = await parseSpreadsheetFile(makeTextFile('pipe-export.txt', 'id|name|optional|\r\n1|Ada||\r\n2|Grace|present|'));
        const model = createSqlModel({ rows: workbook.sheets[0].rows, tableName: 'Pipe Export', hasHeader: true });

        expect(workbook.delimiter).toBe('|');
        expect(workbook.sheets[0].rows[1]).toEqual(['1', 'Ada', '', '']);
        expect(model.columns.map((column) => column.name)).toEqual(['id', 'name', 'optional', 'column_4']);
        expect(model.sql).toContain("(1, 'Ada', NULL, NULL)");
    });

    it('keeps all rows when the source has no header row', () => {
        const rows = parseDelimitedText('Ada,36\nGrace,41');
        const model = createSqlModel({ rows, tableName: 'No Header', hasHeader: false });

        expect(model.columns.map((column) => column.name)).toEqual(['column_1', 'column_2']);
        expect(model.rows).toEqual([
            ['Ada', '36'],
            ['Grace', '41'],
        ]);
        expect(model.sql).toContain('INSERT INTO "no_header" ("column_1", "column_2") VALUES');
    });

    it('returns a clean empty model for blank files', async () => {
        const workbook = await parseSpreadsheetFile(makeTextFile('empty.csv', '\n\n  \n'));
        const model = createSqlModel({ rows: workbook.sheets[0].rows, tableName: 'Empty Upload', hasHeader: true });

        expect(workbook.sheets[0].rows).toEqual([]);
        expect(model.columns).toEqual([]);
        expect(model.sql).toBe('');
        expect(model.warnings).toEqual(['No rows were found in this file.']);
    });

    it('normalizes blank, duplicate, numeric, and reserved SQL column names', () => {
        const model = createSqlModel({
            rows: [
                ['Select', 'Select', '', '123 code'],
                ['a', 'b', 'c', 'd'],
            ],
            tableName: 'Import Table',
            hasHeader: true,
        });

        expect(model.columns.map((column) => column.name)).toEqual(['select_value', 'select_value_2', 'column_3', 'column_123_code']);
        expect(model.warnings).toContain('Select was normalized to select_value.');
    });

    it('infers DATE, TIMESTAMP, BOOLEAN, INTEGER, NUMERIC, and TEXT in one import', () => {
        const model = createSqlModel({
            rows: [
                ['created_on', 'updated_at', 'enabled', 'count', 'ratio', 'notes'],
                ['2026-05-02', '2026-05-02T09:30:00Z', 'yes', '10', '0.25', 'alpha'],
                ['2026-05-03', '2026-05-03 10:45:00', 'no', '-2', '99.5', 'beta'],
            ],
            tableName: 'Type Coverage',
            hasHeader: true,
            dialect: 'postgresql',
        });

        expect(model.columns.map((column) => [column.name, column.sqlType])).toEqual([
            ['created_on', 'DATE'],
            ['updated_at', 'TIMESTAMP'],
            ['enabled', 'BOOLEAN'],
            ['count', 'INTEGER'],
            ['ratio', 'NUMERIC'],
            ['notes', 'TEXT'],
        ]);
    });

    it('handles messy business exports with leading zeros, money, percentages, null markers, slash dates, and escaped SQL-looking text', () => {
        const model = createSqlModel({
            rows: [
                ['Order ID', 'Revenue', 'Discount', 'Ship Date', 'Updated At', 'Paid', 'Notes'],
                ['00123', '$1,234.50', '12.5%', '05/02/2026', '5/2/2026 9:30 PM', 'Y', "O'Brien); DROP TABLE users; --"],
                ['00456', '(99.99)', '0%', '05/03/2026', '2026-05-03T10:45:00Z', 'N', 'N/A'],
            ],
            tableName: 'Messy Export',
            hasHeader: true,
            dialect: 'postgresql',
        });

        expect(model.columns.map((column) => [column.name, column.inferredType, column.sqlType])).toEqual([
            ['order_id', 'TEXT', 'TEXT'],
            ['revenue', 'NUMERIC', 'NUMERIC'],
            ['discount', 'NUMERIC', 'NUMERIC'],
            ['ship_date', 'DATE', 'DATE'],
            ['updated_at', 'TIMESTAMP', 'TIMESTAMP'],
            ['paid', 'BOOLEAN', 'BOOLEAN'],
            ['notes', 'TEXT', 'TEXT'],
        ]);
        expect(model.warnings).toContain('order_id was kept as TEXT to preserve leading-zero values such as "00123".');
        expect(model.sql).toContain("('00123', 1234.5, 0.125, '2026-05-02', '2026-05-02T21:30:00', TRUE, 'O''Brien); DROP TABLE users; --')");
        expect(model.sql).toContain("('00456', -99.99, 0, '2026-05-03', '2026-05-03T10:45:00Z', FALSE, NULL)");
        expect(model.issues).toEqual([]);
    });

    it('honors column type overrides and exports a review report for values that cannot be coerced', () => {
        const model = createSqlModel({
            rows: [
                ['Amount', 'Created On', 'Active'],
                ['$1,200.00', '05/02/2026', '1'],
                ['TBD', 'not a date', 'maybe'],
            ],
            tableName: 'Override Audit',
            hasHeader: true,
            dialect: 'postgresql',
            columnTypeOverrides: {
                amount: 'NUMERIC',
                created_on: 'DATE',
                active: 'BOOLEAN',
            },
        });

        expect(model.columns.map((column) => [column.name, column.inferredType, column.selectedType, column.isTypeOverridden])).toEqual([
            ['amount', 'TEXT', 'NUMERIC', true],
            ['created_on', 'TEXT', 'DATE', true],
            ['active', 'TEXT', 'BOOLEAN', true],
        ]);
        expect(model.sql).toContain("(1200, '2026-05-02', TRUE)");
        expect(model.sql).toContain('(NULL, NULL, NULL)');
        expect(model.issues.map((issue) => [issue.rowNumber, issue.columnName, issue.expectedType, issue.value])).toEqual([
            [3, 'amount', 'NUMERIC', 'TBD'],
            [3, 'created_on', 'DATE', 'not a date'],
            [3, 'active', 'BOOLEAN', 'maybe'],
        ]);
        expect(model.issueSummary).toEqual({ total: 3, affectedRows: 1 });

        const report = createIssueReportCsv(model);
        expect(report).toContain('row_number,column,expected_type,raw_value,action,message');
        expect(report).toContain('3,amount,NUMERIC,TBD,inserted_as_null');
        expect(report).toContain('3,created_on,DATE,not a date,inserted_as_null');
    });

    it('does not silently normalize impossible dates into valid calendar days', () => {
        const model = createSqlModel({
            rows: [
                ['Due Date'],
                ['2026-02-31'],
                ['2026-02-28'],
            ],
            tableName: 'Date Audit',
            hasHeader: true,
            dialect: 'postgresql',
        });

        expect(model.columns[0].inferredType).toBe('TEXT');
        expect(model.warnings).toContain('due_date was kept as TEXT because values mix DATE, TEXT.');
    });

    it('generates SQL literals for nulls, quotes, booleans, negative numbers, and decimal numbers', () => {
        const model = createSqlModel({
            rows: [
                ['name', 'empty_value', 'flag', 'debt', 'price'],
                ["O'Brien", '', 'N', '-42', '12.340'],
                ['Plain', null, 'Y', '0', '0.5'],
            ],
            tableName: 'Literal Test',
            hasHeader: true,
            dialect: 'postgresql',
        });

        expect(model.sql).toContain("('O''Brien', NULL, FALSE, -42, 12.34)");
        expect(model.sql).toContain("('Plain', NULL, TRUE, 0, 0.5)");
    });

    it('preserves high-precision numeric literals without JavaScript rounding', () => {
        const model = createSqlModel({
            rows: [
                ['Big Integer', 'Precise Decimal', 'Scientific', 'Tiny Percent'],
                ['90071992547409931234', '12345678901234567890.1234567890', '1.23E+5', '0.10%'],
                ['42', '-0.000000000000000001', '9.99e-3', '12.5%'],
            ],
            tableName: 'Precision Audit',
            hasHeader: true,
            dialect: 'postgresql',
        });

        expect(model.columns.map((column) => [column.name, column.inferredType, column.sqlType])).toEqual([
            ['big_integer', 'INTEGER', 'INTEGER'],
            ['precise_decimal', 'NUMERIC', 'NUMERIC'],
            ['scientific', 'NUMERIC', 'NUMERIC'],
            ['tiny_percent', 'NUMERIC', 'NUMERIC'],
        ]);
        expect(model.sql).toContain('(90071992547409931234, 12345678901234567890.123456789, 123000, 0.001)');
        expect(model.sql).toContain('(42, -0.000000000000000001, 0.00999, 0.125)');
    });

    it('exposes production database dialects for the spreadsheet converter UI', () => {
        expect(SPREADSHEET_SQL_DIALECTS.map((dialect) => dialect.id)).toEqual(['sqlite', 'postgresql', 'mysql', 'sqlserver']);
        expect(SPREADSHEET_SQL_DIALECTS.map((dialect) => dialect.label)).toEqual(['SQLite', 'PostgreSQL', 'MySQL', 'MSSQL']);
    });

    it('generates MySQL SQL with backticks, mapped types, numeric booleans, and DATETIME literals', () => {
        const model = createSqlModel({
            rows: [
                ['Name', 'Active', 'Total', 'Created At'],
                ['Ada', 'yes', '12.30', '2026-05-02T09:30:00Z'],
            ],
            tableName: 'Orders Export',
            hasHeader: true,
            dialect: 'mysql',
        });

        expect(model.dialect.id).toBe('mysql');
        expect(model.columns.map((column) => [column.name, column.inferredType, column.sqlType])).toEqual([
            ['name', 'TEXT', 'TEXT'],
            ['active', 'BOOLEAN', 'TINYINT(1)'],
            ['total', 'NUMERIC', 'DECIMAL(38, 10)'],
            ['created_at', 'TIMESTAMP', 'DATETIME'],
        ]);
        expect(model.sql).toContain('CREATE TABLE `orders_export`');
        expect(model.sql).toContain('`active` TINYINT(1)');
        expect(model.sql).toContain("('Ada', 1, 12.3, '2026-05-02 09:30:00')");
    });

    it('generates SQL Server SQL with brackets, NVARCHAR text, BIT booleans, and DATETIME2 literals', () => {
        const model = createSqlModel({
            rows: [
                ['Name', 'Active', 'Total', 'Created At'],
                ["O'Brien", 'false', '12.30', '2026-05-02T09:30:00Z'],
            ],
            tableName: 'Sales Export',
            hasHeader: true,
            dialect: 'sqlserver',
        });

        expect(model.dialect.id).toBe('sqlserver');
        expect(model.columns.map((column) => [column.name, column.inferredType, column.sqlType])).toEqual([
            ['name', 'TEXT', 'NVARCHAR(MAX)'],
            ['active', 'BOOLEAN', 'BIT'],
            ['total', 'NUMERIC', 'DECIMAL(38, 10)'],
            ['created_at', 'TIMESTAMP', 'DATETIME2'],
        ]);
        expect(model.sql).toContain('CREATE TABLE [sales_export]');
        expect(model.sql).toContain('[active] BIT');
        expect(model.sql).toContain("(N'O''Brien', 0, 12.3, N'2026-05-02T09:30:00')");
    });

    it('splits SQL Server INSERT statements into 1000-row batches', () => {
        const rows = [['id'], ...Array.from({ length: 1001 }, (_, index) => [String(index + 1)])];
        const model = createSqlModel({
            rows,
            tableName: 'Large Export',
            hasHeader: true,
            dialect: 'sqlserver',
        });

        expect(model.sql.match(/INSERT INTO/g)).toHaveLength(2);
        expect(model.sql).toContain('    (1000);');
        expect(model.sql).toContain('    (1001);');
    });

    it('generates SQLite SQL with affinity-friendly types and integer booleans', () => {
        const model = createSqlModel({
            rows: [
                ['Name', 'Active', 'Joined'],
                ['Ada', 'true', '2026-05-02'],
            ],
            tableName: 'SQLite Export',
            hasHeader: true,
            dialect: 'sqlite',
        });

        expect(model.dialect.id).toBe('sqlite');
        expect(model.columns.map((column) => [column.name, column.inferredType, column.sqlType])).toEqual([
            ['name', 'TEXT', 'TEXT'],
            ['active', 'BOOLEAN', 'INTEGER'],
            ['joined', 'DATE', 'TEXT'],
        ]);
        expect(model.sql).toContain('CREATE TABLE "sqlite_export"');
        expect(model.sql).toContain('"active" INTEGER');
        expect(model.sql).toContain("('Ada', 1, '2026-05-02')");
    });

    it('sanitizes table names and identifiers consistently', () => {
        expect(suggestTableName('Quarterly Revenue.xlsx', 'North America')).toBe('quarterly_revenue_north_america');
        expect(suggestTableName('Quarterly Revenue.xlsx', 'Sheet 1')).toBe('quarterly_revenue');
        expect(sanitizeSqlIdentifier('99 Problems', 'table')).toBe('table_99_problems');
        expect(sanitizeSqlIdentifier('Order', 'column')).toBe('order_value');
    });

    it('reads multi-sheet XLSX workbooks with shared strings, inline strings, dates, booleans, formulas, and sparse rows', async () => {
        const workbook = await parseSpreadsheetFile(makeXlsxFile());

        expect(workbook.kind).toBe('xlsx');
        expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(['Customers', 'Orders']);
        expect(workbook.sheets[0].rows[1]).toEqual(['Ada', '36', '2023-01-01', true, 'likes, commas & quotes', '2', '90071992547409931234']);
        expect(workbook.sheets[0].rows[2].every((value) => value === '')).toBe(true);
        expect(workbook.sheets[0].rows[3][0]).toBe('Grace');

        const model = createSqlModel({ rows: workbook.sheets[0].rows, tableName: 'Customers', hasHeader: true, dialect: 'postgresql' });
        expect(model.rows).toHaveLength(2);
        expect(model.columns.map((column) => [column.name, column.sqlType])).toEqual([
            ['name', 'TEXT'],
            ['age', 'INTEGER'],
            ['joined', 'DATE'],
            ['active', 'BOOLEAN'],
            ['note', 'TEXT'],
            ['formula', 'INTEGER'],
            ['precise', 'INTEGER'],
        ]);
        expect(model.sql).toContain("('Ada', 36, '2023-01-01', TRUE, 'likes, commas & quotes', 2, 90071992547409931234)");
    });

    it('rejects unsupported spreadsheet formats with a useful message', async () => {
        await expect(parseSpreadsheetFile(makeTextFile('legacy.xls', 'not real excel'))).rejects.toThrow('Supported files are .csv, .tsv, .txt and .xlsx.');
    });

    it('rejects malformed XLSX files with a useful message', async () => {
        await expect(parseSpreadsheetFile(makeBinaryFile('broken.xlsx', new Uint8Array([1, 2, 3, 4])))).rejects.toThrow('Could not unzip this Excel file. Please use a valid .xlsx workbook.');
    });
});
