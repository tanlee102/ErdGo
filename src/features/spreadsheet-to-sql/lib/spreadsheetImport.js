import { strFromU8, unzipSync } from 'fflate';

/**
 * Client-side spreadsheet import pipeline:
 * file bytes -> normalized worksheet rows -> inferred column profile -> SQL.
 * Keep each step deterministic so changing settings in the UI regenerates the
 * same model from the same workbook without hidden state.
 */
const SUPPORTED_EXTENSIONS = new Set(['csv', 'tsv', 'txt', 'xlsx']);
const DATE_NUM_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
export const SPREADSHEET_IMPORT_LIMITS = Object.freeze({
    maxFileBytes: 25 * 1024 * 1024,
    maxArchiveEntries: 2048,
    maxUncompressedBytes: 100 * 1024 * 1024,
});
export const DEFAULT_SPREADSHEET_SQL_DIALECT = 'sqlite';
// UI order standard: SQLite, PostgreSQL, MySQL, MSSQL.
export const SPREADSHEET_SQL_DIALECTS = [
    {
        id: 'sqlite',
        label: 'SQLite',
        description: 'Double-quoted identifiers, integer booleans, and TEXT dates for SQLite affinity.',
        quoteStart: '"',
        quoteEnd: '"',
        stringPrefix: '',
        typeMap: {
            TEXT: 'TEXT',
            BOOLEAN: 'INTEGER',
            INTEGER: 'INTEGER',
            NUMERIC: 'NUMERIC',
            DATE: 'TEXT',
            TIMESTAMP: 'TEXT',
        },
        booleanLiterals: { true: '1', false: '0' },
        timestampStyle: 'iso',
        maxRowsPerInsert: Infinity,
    },
    {
        id: 'postgresql',
        label: 'PostgreSQL',
        description: 'Double-quoted identifiers, native boolean values, and PostgreSQL-friendly timestamps.',
        quoteStart: '"',
        quoteEnd: '"',
        stringPrefix: '',
        typeMap: {
            TEXT: 'TEXT',
            BOOLEAN: 'BOOLEAN',
            INTEGER: 'INTEGER',
            NUMERIC: 'NUMERIC',
            DATE: 'DATE',
            TIMESTAMP: 'TIMESTAMP',
        },
        booleanLiterals: { true: 'TRUE', false: 'FALSE' },
        timestampStyle: 'iso',
        maxRowsPerInsert: Infinity,
    },
    {
        id: 'mysql',
        label: 'MySQL',
        description: 'Backtick identifiers, TINYINT booleans, DECIMAL numbers, and DATETIME values.',
        quoteStart: '`',
        quoteEnd: '`',
        stringPrefix: '',
        typeMap: {
            TEXT: 'TEXT',
            BOOLEAN: 'TINYINT(1)',
            INTEGER: 'INT',
            NUMERIC: 'DECIMAL(38, 10)',
            DATE: 'DATE',
            TIMESTAMP: 'DATETIME',
        },
        booleanLiterals: { true: '1', false: '0' },
        timestampStyle: 'space',
        maxRowsPerInsert: Infinity,
    },
    {
        id: 'sqlserver',
        label: 'MSSQL',
        description: 'Bracketed identifiers, NVARCHAR text, BIT booleans, and DATETIME2 values.',
        quoteStart: '[',
        quoteEnd: ']',
        stringPrefix: 'N',
        typeMap: {
            TEXT: 'NVARCHAR(MAX)',
            BOOLEAN: 'BIT',
            INTEGER: 'INT',
            NUMERIC: 'DECIMAL(38, 10)',
            DATE: 'DATE',
            TIMESTAMP: 'DATETIME2',
        },
        booleanLiterals: { true: '1', false: '0' },
        timestampStyle: 'sqlserver',
        maxRowsPerInsert: 1000,
    },
];

export const SPREADSHEET_SQL_TYPES = [
    {
        id: 'TEXT',
        label: 'Text',
        description: 'Preserves values exactly as quoted SQL strings.',
    },
    {
        id: 'BOOLEAN',
        label: 'Boolean',
        description: 'Accepts true/false, yes/no, y/n, and 1/0 when selected manually.',
    },
    {
        id: 'INTEGER',
        label: 'Integer',
        description: 'Whole numbers without decimal places.',
    },
    {
        id: 'NUMERIC',
        label: 'Numeric',
        description: 'Decimals, currency-like strings, negatives in parentheses, and percentages.',
    },
    {
        id: 'DATE',
        label: 'Date',
        description: 'Calendar dates normalized to YYYY-MM-DD.',
    },
    {
        id: 'TIMESTAMP',
        label: 'Timestamp',
        description: 'Date and time values normalized for the selected SQL dialect.',
    },
];

const SPREADSHEET_SQL_TYPE_IDS = new Set(SPREADSHEET_SQL_TYPES.map((type) => type.id));
const NULL_LIKE_VALUES = new Set(['n/a', 'na', 'null', 'nil', 'none', '#n/a', '#null!', '-']);

const RESERVED_WORDS = new Set([
    'add',
    'all',
    'alter',
    'and',
    'as',
    'between',
    'by',
    'case',
    'check',
    'column',
    'constraint',
    'create',
    'delete',
    'default',
    'drop',
    'else',
    'exists',
    'false',
    'foreign',
    'from',
    'group',
    'having',
    'in',
    'index',
    'insert',
    'into',
    'is',
    'join',
    'key',
    'like',
    'limit',
    'not',
    'null',
    'on',
    'or',
    'order',
    'primary',
    'references',
    'select',
    'set',
    'table',
    'then',
    'true',
    'unique',
    'update',
    'values',
    'where',
]);

export function getSpreadsheetSqlDialect(dialectId = DEFAULT_SPREADSHEET_SQL_DIALECT) {
    return SPREADSHEET_SQL_DIALECTS.find((dialect) => dialect.id === dialectId) || SPREADSHEET_SQL_DIALECTS[0];
}

function getExtension(fileName = '') {
    const dot = fileName.lastIndexOf('.');
    return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

function normalizeCellValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    return value;
}

function isBlankValue(value) {
    return value === null || value === undefined || String(value).trim() === '';
}

function rowHasValue(row) {
    return Array.isArray(row) && row.some((cell) => !isBlankValue(cell));
}

function trimEmptyRows(rows) {
    let lastRow = rows.length - 1;
    while (lastRow >= 0 && !rowHasValue(rows[lastRow])) {
        lastRow -= 1;
    }
    return rows.slice(0, lastRow + 1);
}

function normalizeRows(rows) {
    const cleanRows = trimEmptyRows(
        rows.map((row) => {
            const sourceRow = Array.isArray(row) ? row : [];
            return sourceRow.map(normalizeCellValue);
        }),
    );

    const columnCount = cleanRows.reduce((max, row) => Math.max(max, row.length), 0);
    return cleanRows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] ?? ''));
}

function countDelimiter(line, delimiter) {
    let count = 0;
    let inQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === '"') {
            if (inQuotes && line[index + 1] === '"') {
                index += 1;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === delimiter && !inQuotes) {
            count += 1;
        }
    }

    return count;
}

function detectCsvDelimiter(text) {
    const candidates = [',', ';', '\t', '|'];
    const lines = text
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .slice(0, 8);

    let bestDelimiter = ',';
    let bestScore = -1;

    candidates.forEach((delimiter) => {
        const counts = lines.map((line) => countDelimiter(line, delimiter)).filter((count) => count > 0);
        if (!counts.length) return;

        const score = counts.reduce((sum, count) => sum + count, 0) - new Set(counts).size;
        if (score > bestScore) {
            bestScore = score;
            bestDelimiter = delimiter;
        }
    });

    return bestDelimiter;
}

export function parseDelimitedText(text, delimiter = ',') {
    const source = String(text || '').replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;

    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];

        if (inQuotes) {
            if (char === '"') {
                if (source[index + 1] === '"') {
                    cell += '"';
                    index += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                cell += char;
            }
            continue;
        }

        if (char === '"') {
            if (cell.trim() === '') {
                cell = '';
                inQuotes = true;
            } else {
                cell += char;
            }
        } else if (char === delimiter) {
            row.push(cell);
            cell = '';
        } else if (char === '\n') {
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
        } else if (char === '\r') {
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
            if (source[index + 1] === '\n') index += 1;
        } else {
            cell += char;
        }
    }

    if (inQuotes) {
        throw new Error('This CSV has an unclosed quoted field. Check for a missing closing double quote.');
    }

    row.push(cell);
    rows.push(row);

    return normalizeRows(rows);
}

function decodeXmlText(value = '') {
    return String(value)
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function createSimpleXmlNode(name, attributes = {}) {
    return {
        nodeName: name,
        localName: name.includes(':') ? name.split(':').pop() : name,
        attributes,
        children: [],
        text: '',
        getAttribute(attributeName) {
            return this.attributes[attributeName] ?? null;
        },
        get textContent() {
            return this.text + this.children.map((child) => child.textContent).join('');
        },
        getElementsByTagName(tagName) {
            const matches = [];
            const visit = (node) => {
                node.children.forEach((child) => {
                    if (child.nodeName === tagName || child.localName === tagName) {
                        matches.push(child);
                    }
                    visit(child);
                });
            };
            visit(this);
            return matches;
        },
    };
}

function parseXmlAttributes(source = '') {
    const attributes = {};
    const attrRegex = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let match;

    while ((match = attrRegex.exec(source))) {
        attributes[match[1]] = decodeXmlText(match[3] ?? match[4] ?? '');
    }

    return attributes;
}

export function parseSimpleSpreadsheetXml(xml) {
    const root = createSimpleXmlNode('__root__');
    const stack = [root];
    const tokenRegex = /<!\[CDATA\[([\s\S]*?)]]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<([^>]+)>|([^<]+)/g;
    let match;

    while ((match = tokenRegex.exec(xml))) {
        if (match[1] !== undefined) {
            stack[stack.length - 1].text += match[1];
            continue;
        }

        if (match[3] !== undefined) {
            stack[stack.length - 1].text += decodeXmlText(match[3]);
            continue;
        }

        const rawTag = match[2]?.trim();
        if (!rawTag || rawTag.startsWith('!')) continue;

        if (rawTag.startsWith('/')) {
            const closingName = rawTag.slice(1).trim().split(/\s+/)[0];
            const openNode = stack[stack.length - 1];
            if (stack.length === 1 || openNode.nodeName !== closingName) {
                throw new Error(`Could not read Excel XML content: mismatched closing tag </${closingName}>`);
            }
            stack.pop();
            continue;
        }

        const selfClosing = rawTag.endsWith('/');
        const tagContent = selfClosing ? rawTag.slice(0, -1).trim() : rawTag;
        const nameMatch = /^([^\s/>]+)/.exec(tagContent);
        if (!nameMatch) continue;

        const node = createSimpleXmlNode(nameMatch[1], parseXmlAttributes(tagContent.slice(nameMatch[0].length)));
        stack[stack.length - 1].children.push(node);

        if (!selfClosing) {
            stack.push(node);
        }
    }

    if (stack.length !== 1) {
        throw new Error(`Could not read Excel XML content: unclosed <${stack[stack.length - 1].nodeName}> tag`);
    }

    return root;
}

function xmlToDoc(xml) {
    if (typeof DOMParser !== 'undefined') {
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        const parseError = doc.getElementsByTagName('parsererror')[0];
        if (parseError) {
            throw new Error('Could not read Excel XML content');
        }
        return doc;
    }

    return parseSimpleSpreadsheetXml(xml);
}

function directChildren(element, localName) {
    return Array.from(element?.children || []).filter((child) => child.localName === localName);
}

function getZipText(zip, path) {
    const entry = zip[path];
    return entry ? strFromU8(entry) : '';
}

function resolveWorkbookTarget(target) {
    if (!target) return '';
    if (target.startsWith('/')) return target.slice(1);
    if (target.startsWith('xl/')) return target;
    return `xl/${target.replace(/^\.\//, '')}`;
}

function readWorkbookRelationships(zip) {
    const relXml = getZipText(zip, 'xl/_rels/workbook.xml.rels');
    if (!relXml) return {};

    const relDoc = xmlToDoc(relXml);
    const relationships = {};
    Array.from(relDoc.getElementsByTagName('Relationship')).forEach((relationship) => {
        const id = relationship.getAttribute('Id');
        const target = relationship.getAttribute('Target');
        if (id && target) {
            relationships[id] = resolveWorkbookTarget(target);
        }
    });
    return relationships;
}

function readWorkbookSheets(zip) {
    const workbookXml = getZipText(zip, 'xl/workbook.xml');
    if (!workbookXml) {
        throw new Error('This Excel file is missing workbook metadata');
    }

    const workbookDoc = xmlToDoc(workbookXml);
    const relationships = readWorkbookRelationships(zip);

    return Array.from(workbookDoc.getElementsByTagName('sheet'))
        .map((sheet, index) => {
            const relId = sheet.getAttribute('r:id') || sheet.getAttribute('id');
            return {
                name: sheet.getAttribute('name') || `Sheet ${index + 1}`,
                path: relationships[relId] || `xl/worksheets/sheet${index + 1}.xml`,
            };
        })
        .filter((sheet) => sheet.path);
}

function readSharedStrings(zip) {
    const sharedStringsXml = getZipText(zip, 'xl/sharedStrings.xml');
    if (!sharedStringsXml) return [];

    const doc = xmlToDoc(sharedStringsXml);
    return Array.from(doc.getElementsByTagName('si')).map((item) => {
        const textNodes = Array.from(item.getElementsByTagName('t'));
        if (textNodes.length) {
            return textNodes.map((node) => node.textContent || '').join('');
        }
        return item.textContent || '';
    });
}

function isDateFormat(formatCode = '') {
    const stripped = formatCode
        .replace(/"[^"]*"/g, '')
        .replace(/\[[^\]]*]/g, '')
        .replace(/\\./g, '')
        .toLowerCase();

    return /[ymdhs]/.test(stripped) && (/[dy]/.test(stripped) || /h/.test(stripped));
}

function readDateStyleIndexes(zip) {
    const stylesXml = getZipText(zip, 'xl/styles.xml');
    if (!stylesXml) return new Set();

    const doc = xmlToDoc(stylesXml);
    const customDateFormats = new Set();

    Array.from(doc.getElementsByTagName('numFmt')).forEach((numFmt) => {
        const id = Number.parseInt(numFmt.getAttribute('numFmtId'), 10);
        const code = numFmt.getAttribute('formatCode') || '';
        if (Number.isInteger(id) && isDateFormat(code)) {
            customDateFormats.add(id);
        }
    });

    const cellXfs = doc.getElementsByTagName('cellXfs')[0];
    const dateStyleIndexes = new Set();
    directChildren(cellXfs, 'xf').forEach((xf, index) => {
        const numFmtId = Number.parseInt(xf.getAttribute('numFmtId'), 10);
        if (DATE_NUM_FORMAT_IDS.has(numFmtId) || customDateFormats.has(numFmtId)) {
            dateStyleIndexes.add(index);
        }
    });

    return dateStyleIndexes;
}

function columnLettersToIndex(letters) {
    return String(letters || '')
        .toUpperCase()
        .split('')
        .reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function parseCellRef(ref, fallbackRow, fallbackColumn) {
    const match = /^([A-Z]+)(\d+)$/i.exec(ref || '');
    if (!match) {
        return { rowIndex: fallbackRow, columnIndex: fallbackColumn };
    }
    return {
        rowIndex: Number.parseInt(match[2], 10) - 1,
        columnIndex: columnLettersToIndex(match[1]),
    };
}

function excelSerialToIso(serial) {
    const dayMs = 24 * 60 * 60 * 1000;
    const wholeDays = Math.floor(serial);
    const dayFraction = serial - wholeDays;
    const date = new Date(Date.UTC(1899, 11, 30) + wholeDays * dayMs + Math.round(dayFraction * dayMs));
    const iso = date.toISOString();
    return dayFraction === 0 ? iso.slice(0, 10) : iso.replace(/\.\d{3}Z$/, 'Z');
}

function getFirstText(element, tagName) {
    const node = element.getElementsByTagName(tagName)[0];
    return node ? node.textContent || '' : '';
}

function readCellValue(cell, sharedStrings, dateStyleIndexes) {
    const type = cell.getAttribute('t');
    const valueText = getFirstText(cell, 'v');

    if (type === 'inlineStr') {
        const inlineTextNodes = Array.from(cell.getElementsByTagName('t'));
        return inlineTextNodes.map((node) => node.textContent || '').join('');
    }

    if (type === 's') {
        const stringIndex = Number.parseInt(valueText, 10);
        return sharedStrings[stringIndex] ?? '';
    }

    if (type === 'b') {
        return valueText === '1';
    }

    if (type === 'str') {
        return valueText;
    }

    if (!valueText) return '';

    const styleIndex = Number.parseInt(cell.getAttribute('s'), 10);
    const numericValue = Number(valueText);
    if (Number.isFinite(numericValue) && dateStyleIndexes.has(styleIndex)) {
        return excelSerialToIso(numericValue);
    }

    return valueText;
}

function readWorksheetRows(zip, sheetPath, sharedStrings, dateStyleIndexes) {
    const sheetXml = getZipText(zip, sheetPath);
    if (!sheetXml) return [];

    const doc = xmlToDoc(sheetXml);
    const rows = [];

    Array.from(doc.getElementsByTagName('row')).forEach((rowElement, fallbackRowIndex) => {
        const rowIndex = Number.parseInt(rowElement.getAttribute('r'), 10) - 1 || fallbackRowIndex;
        if (!rows[rowIndex]) rows[rowIndex] = [];

        directChildren(rowElement, 'c').forEach((cell, fallbackColumnIndex) => {
            const { columnIndex } = parseCellRef(cell.getAttribute('r'), rowIndex, fallbackColumnIndex);
            rows[rowIndex][columnIndex] = readCellValue(cell, sharedStrings, dateStyleIndexes);
        });
    });

    return normalizeRows(Array.from({ length: rows.length }, (_, index) => rows[index] || []));
}

function spreadsheetLimitError(message) {
    const error = new Error(message);
    error.code = 'SPREADSHEET_IMPORT_LIMIT';
    return error;
}

/**
 * Unzip only XML parts used by the importer and enforce declared ZIP sizes
 * before fflate allocates output buffers. The optional limits argument exists
 * for deterministic low-memory contract tests; production uses the frozen
 * limits above.
 */
export function unzipSpreadsheetArchive(bytes, limits = SPREADSHEET_IMPORT_LIMITS) {
    const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (source.byteLength > limits.maxFileBytes) {
        throw spreadsheetLimitError('This spreadsheet is too large to import safely. Use a file smaller than 25 MB.');
    }

    let entryCount = 0;
    let uncompressedBytes = 0;
    return unzipSync(source, {
        filter(entry) {
            entryCount += 1;
            if (entryCount > limits.maxArchiveEntries) {
                throw spreadsheetLimitError('This Excel archive contains too many files to import safely.');
            }
            const requiredXml = entry.name === 'xl/workbook.xml'
                || entry.name === 'xl/_rels/workbook.xml.rels'
                || entry.name === 'xl/sharedStrings.xml'
                || entry.name === 'xl/styles.xml'
                || /^xl\/worksheets\/.*\.xml$/i.test(entry.name);
            if (!requiredXml) return false;

            uncompressedBytes += entry.originalSize;
            if (uncompressedBytes > limits.maxUncompressedBytes) {
                throw spreadsheetLimitError('This Excel archive expands beyond the safe import limit.');
            }
            return true;
        },
    });
}

async function parseXlsxFile(file) {
    let zip;
    try {
        zip = unzipSpreadsheetArchive(new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
        if (error?.code === 'SPREADSHEET_IMPORT_LIMIT') throw error;
        throw new Error('Could not unzip this Excel file. Please use a valid .xlsx workbook.');
    }

    const sheets = readWorkbookSheets(zip);
    if (!sheets.length) {
        throw new Error('No worksheets were found in this Excel file.');
    }

    const sharedStrings = readSharedStrings(zip);
    const dateStyleIndexes = readDateStyleIndexes(zip);

    return {
        kind: 'xlsx',
        fileName: file.name,
        sheets: sheets.map((sheet) => ({
            name: sheet.name,
            rows: readWorksheetRows(zip, sheet.path, sharedStrings, dateStyleIndexes),
        })),
    };
}

async function readTextFile(file) {
    if (typeof file.text === 'function') {
        return file.text();
    }

    if (typeof file.arrayBuffer === 'function') {
        return new TextDecoder('utf-8').decode(await file.arrayBuffer());
    }

    throw new Error('Could not read this text file. Please try a different CSV export.');
}

async function parseCsvFile(file, extension) {
    const text = await readTextFile(file);
    const delimiter = extension === 'tsv' ? '\t' : detectCsvDelimiter(text);

    return {
        kind: delimiter === '\t' ? 'tsv' : 'csv',
        fileName: file.name,
        delimiter,
        sheets: [
            {
                name: file.name.replace(/\.[^.]+$/, '') || 'Uploaded data',
                rows: parseDelimitedText(text, delimiter),
            },
        ],
    };
}

export async function parseSpreadsheetFile(file) {
    if (!file) {
        throw new Error('Please choose a CSV or Excel file.');
    }

    const extension = getExtension(file.name);
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
        throw new Error('Supported files are .csv, .tsv, .txt and .xlsx.');
    }
    if (Number.isFinite(file.size) && file.size > SPREADSHEET_IMPORT_LIMITS.maxFileBytes) {
        throw spreadsheetLimitError('This spreadsheet is too large to import safely. Use a file smaller than 25 MB.');
    }

    if (extension === 'xlsx') {
        return parseXlsxFile(file);
    }

    return parseCsvFile(file, extension);
}

export function sanitizeSqlIdentifier(value, fallback = 'column') {
    const normalized = String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_');

    let identifier = normalized || fallback;
    if (/^\d/.test(identifier)) identifier = `${fallback.replace(/_\d+$/, '')}_${identifier}`;
    if (RESERVED_WORDS.has(identifier)) identifier = `${identifier}_value`;
    return identifier;
}

function uniqueIdentifiers(values, fallback) {
    const seen = new Map();

    return values.map((value, index) => {
        const base = sanitizeSqlIdentifier(value, `${fallback}_${index + 1}`);
        const count = seen.get(base) || 0;
        seen.set(base, count + 1);
        return count === 0 ? base : `${base}_${count + 1}`;
    });
}

export function suggestTableName(fileName = 'uploaded_table', sheetName = '') {
    const baseName = String(fileName || 'uploaded_table').replace(/\.[^.]+$/, '');
    const suffix = sheetName && !/^sheet\s*\d+$/i.test(sheetName) ? `_${sheetName}` : '';
    return sanitizeSqlIdentifier(`${baseName}${suffix}`, 'uploaded_table');
}

function isSqlNullValue(value) {
    if (isBlankValue(value)) return true;
    return NULL_LIKE_VALUES.has(String(value).trim().toLowerCase());
}

function parseBoolean(value, { allowNumeric = false } = {}) {
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (['true', 'yes', 'y'].includes(normalized)) return true;
    if (['false', 'no', 'n'].includes(normalized)) return false;
    if (allowNumeric && normalized === '1') return true;
    if (allowNumeric && normalized === '0') return false;
    return null;
}

function hasLeadingZeroNumericText(value) {
    if (typeof value !== 'string') return false;
    return /^[+-]?0\d+$/.test(value.trim());
}

function normalizeDecimalLiteral(value) {
    const source = String(value || '').trim();
    if (!source) return null;

    let sign = '';
    let unsigned = source;
    if (unsigned.startsWith('+') || unsigned.startsWith('-')) {
        sign = unsigned[0] === '-' ? '-' : '';
        unsigned = unsigned.slice(1);
    }

    let [integerPart, decimalPart = ''] = unsigned.split('.');
    integerPart = integerPart.replace(/^0+(?=\d)/, '') || '0';
    decimalPart = decimalPart.replace(/0+$/, '');

    const literal = decimalPart ? `${integerPart}.${decimalPart}` : integerPart;
    return literal === '0' ? '0' : `${sign}${literal}`;
}

function expandExponentDecimal(value) {
    const source = String(value || '').trim();
    if (source.length > 512) return null;

    const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(source);
    if (!match) return null;

    const sign = match[1] === '-' ? '-' : '';
    const integerPart = match[2] || '';
    const decimalPart = match[3] ?? match[4] ?? '';
    const exponent = Number.parseInt(match[5] || '0', 10);
    if (Math.abs(exponent) > 1000) return null;

    const digits = `${integerPart}${decimalPart}` || '0';
    const decimalPlaces = decimalPart.length - exponent;
    let expanded;

    if (decimalPlaces <= 0) {
        expanded = `${digits}${'0'.repeat(Math.abs(decimalPlaces))}`;
    } else if (decimalPlaces >= digits.length) {
        expanded = `0.${'0'.repeat(decimalPlaces - digits.length)}${digits}`;
    } else {
        expanded = `${digits.slice(0, digits.length - decimalPlaces)}.${digits.slice(digits.length - decimalPlaces)}`;
    }

    return normalizeDecimalLiteral(`${sign}${expanded}`);
}

function shiftDecimalLeft(value, places) {
    const literal = normalizeDecimalLiteral(value);
    if (!literal) return null;

    const sign = literal.startsWith('-') ? '-' : '';
    const unsigned = sign ? literal.slice(1) : literal;
    const [integerPart, decimalPart = ''] = unsigned.split('.');
    const digits = `${integerPart}${decimalPart}`;
    const decimalPlaces = decimalPart.length + places;
    let shifted;

    if (decimalPlaces >= digits.length) {
        shifted = `0.${'0'.repeat(decimalPlaces - digits.length)}${digits}`;
    } else {
        shifted = `${digits.slice(0, digits.length - decimalPlaces)}.${digits.slice(digits.length - decimalPlaces)}`;
    }

    return normalizeDecimalLiteral(`${sign}${shifted}`);
}

function parseNumberLike(value) {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null;
        const literal = expandExponentDecimal(String(value));
        return literal ? { literal, isInteger: !literal.includes('.'), precisionRisk: Number.isInteger(value) && !Number.isSafeInteger(value) } : null;
    }

    let normalized = String(value).trim();
    if (!normalized) return null;

    let isParenthesizedNegative = false;
    const wrappedNegative = /^\((.*)\)$/.exec(normalized);
    if (wrappedNegative) {
        isParenthesizedNegative = true;
        normalized = wrappedNegative[1].trim();
    }

    const isPercent = /%$/.test(normalized);
    normalized = normalized
        .replace(/%$/, '')
        .replace(/[$€£¥₫]/g, '')
        .replace(/\b(?:usd|eur|gbp|cad|aud|jpy|vnd)\b/gi, '')
        .replace(/,/g, '')
        .replace(/\s+/g, '')
        .trim();

    let literal = expandExponentDecimal(normalized);
    if (!literal) return null;

    if (isParenthesizedNegative && literal !== '0' && !literal.startsWith('-')) {
        literal = `-${literal}`;
    }

    if (isPercent) {
        literal = shiftDecimalLeft(literal, 2);
    }

    return literal ? { literal, isInteger: !literal.includes('.') } : null;
}

function padNumber(value, length = 2) {
    return String(value).padStart(length, '0');
}

function normalizeYear(value) {
    const parsed = Number.parseInt(value, 10);
    if (String(value).length === 2) {
        return parsed >= 70 ? 1900 + parsed : 2000 + parsed;
    }
    return parsed;
}

function normalizeDateParts(year, month, day) {
    const parsedYear = normalizeYear(year);
    const parsedMonth = Number.parseInt(month, 10);
    const parsedDay = Number.parseInt(day, 10);
    if (!Number.isInteger(parsedYear) || !Number.isInteger(parsedMonth) || !Number.isInteger(parsedDay)) return null;
    if (parsedYear < 1000 || parsedYear > 9999 || parsedMonth < 1 || parsedMonth > 12 || parsedDay < 1 || parsedDay > 31) return null;

    const date = new Date(Date.UTC(parsedYear, parsedMonth - 1, parsedDay));
    if (date.getUTCFullYear() !== parsedYear || date.getUTCMonth() !== parsedMonth - 1 || date.getUTCDate() !== parsedDay) return null;

    return `${padNumber(parsedYear, 4)}-${padNumber(parsedMonth)}-${padNumber(parsedDay)}`;
}

function normalizeTimeParts(hour, minute, second = '0', meridiem = '') {
    let parsedHour = Number.parseInt(hour, 10);
    const parsedMinute = Number.parseInt(minute, 10);
    const parsedSecond = Number.parseInt(second || '0', 10);
    if (!Number.isInteger(parsedHour) || !Number.isInteger(parsedMinute) || !Number.isInteger(parsedSecond)) return null;

    const normalizedMeridiem = meridiem.toLowerCase();
    if (normalizedMeridiem) {
        if (parsedHour < 1 || parsedHour > 12) return null;
        if (normalizedMeridiem === 'pm' && parsedHour !== 12) parsedHour += 12;
        if (normalizedMeridiem === 'am' && parsedHour === 12) parsedHour = 0;
    }

    if (parsedHour < 0 || parsedHour > 23 || parsedMinute < 0 || parsedMinute > 59 || parsedSecond < 0 || parsedSecond > 59) return null;
    return `${padNumber(parsedHour)}:${padNumber(parsedMinute)}:${padNumber(parsedSecond)}`;
}

function normalizeTimezone(value = '') {
    if (!value) return '';
    if (value.toUpperCase() === 'Z') return 'Z';
    const match = /^([+-]\d{2}):?(\d{2})$/.exec(value);
    return match ? `${match[1]}:${match[2]}` : '';
}

function parseTemporalValue(value) {
    const normalized = String(value).trim();
    const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
    if (isoDate) {
        const date = normalizeDateParts(isoDate[1], isoDate[2], isoDate[3]);
        return date ? { kind: 'DATE', normalized: date } : null;
    }

    const isoTimestamp = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(normalized);
    if (isoTimestamp) {
        const date = normalizeDateParts(isoTimestamp[1], isoTimestamp[2], isoTimestamp[3]);
        const time = normalizeTimeParts(isoTimestamp[4], isoTimestamp[5], isoTimestamp[6] || '0');
        if (!date || !time) return null;
        return { kind: 'TIMESTAMP', normalized: `${date}T${time}${normalizeTimezone(isoTimestamp[7])}` };
    }

    const slashDate = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(normalized);
    if (slashDate) {
        const date = normalizeDateParts(slashDate[3], slashDate[1], slashDate[2]);
        if (!date) return null;
        if (!slashDate[4]) return { kind: 'DATE', normalized: date };

        const time = normalizeTimeParts(slashDate[4], slashDate[5], slashDate[6] || '0', slashDate[7] || '');
        return time ? { kind: 'TIMESTAMP', normalized: `${date}T${time}` } : null;
    }

    return null;
}

function classifyValueKind(value) {
    if (isSqlNullValue(value)) return null;
    if (parseBoolean(value) !== null) return { type: 'BOOLEAN' };
    if (hasLeadingZeroNumericText(value)) return { type: 'TEXT', reason: 'leading-zero-number' };

    const parsedNumber = parseNumberLike(value);
    if (parsedNumber !== null) {
        return { type: parsedNumber.isInteger ? 'INTEGER' : 'NUMERIC' };
    }

    const parsedTemporal = parseTemporalValue(value);
    if (parsedTemporal) return { type: parsedTemporal.kind };

    return { type: 'TEXT' };
}

function inferColumnProfile(values) {
    const kindCounts = new Map();
    const textReasons = new Map();
    const samplesByKind = new Map();
    let nullLikeCount = 0;

    values.forEach((value) => {
        if (isSqlNullValue(value)) {
            nullLikeCount += 1;
            return;
        }

        const kind = classifyValueKind(value);
        if (!kind) return;

        kindCounts.set(kind.type, (kindCounts.get(kind.type) || 0) + 1);
        if (!samplesByKind.has(kind.type)) samplesByKind.set(kind.type, value);
        if (kind.reason && !textReasons.has(kind.reason)) textReasons.set(kind.reason, value);
    });

    const detectedTypes = Array.from(kindCounts.keys());
    if (!detectedTypes.length) {
        return {
            inferredType: 'TEXT',
            confidence: 1,
            kindCounts,
            nullLikeCount,
            textReasons,
            samplesByKind,
        };
    }

    let inferredType = 'TEXT';
    if (detectedTypes.length === 1) {
        inferredType = detectedTypes[0];
    } else if (detectedTypes.every((type) => type === 'INTEGER' || type === 'NUMERIC')) {
        inferredType = detectedTypes.includes('NUMERIC') ? 'NUMERIC' : 'INTEGER';
    } else if (detectedTypes.every((type) => type === 'DATE' || type === 'TIMESTAMP')) {
        inferredType = detectedTypes.includes('TIMESTAMP') ? 'TIMESTAMP' : 'DATE';
    }

    return {
        inferredType,
        confidence: inferredType === 'TEXT' && detectedTypes.length > 1 ? 0.5 : 1,
        kindCounts,
        nullLikeCount,
        textReasons,
        samplesByKind,
    };
}

function isValueCompatibleWithType(value, type) {
    if (isSqlNullValue(value)) return true;
    if (type === 'TEXT') return true;
    if (type === 'BOOLEAN') return parseBoolean(value, { allowNumeric: true }) !== null;
    if (type === 'INTEGER') {
        const parsed = parseNumberLike(value);
        return parsed !== null && parsed.isInteger;
    }
    if (type === 'NUMERIC') return parseNumberLike(value) !== null;
    if (type === 'DATE') return parseTemporalValue(value)?.kind === 'DATE';
    if (type === 'TIMESTAMP') return parseTemporalValue(value)?.kind === 'TIMESTAMP';
    return true;
}

function formatDetectedTypes(kindCounts) {
    return Array.from(kindCounts.keys())
        .sort()
        .join(', ');
}

function escapeSqlString(value) {
    return String(value).replace(/'/g, "''");
}

function quoteSqlIdentifier(identifier, dialect) {
    const value = String(identifier || '');
    if (dialect.quoteStart === '[' && dialect.quoteEnd === ']') {
        return `[${value.replace(/]/g, ']]')}]`;
    }
    return `${dialect.quoteStart}${value.split(dialect.quoteEnd).join(`${dialect.quoteEnd}${dialect.quoteEnd}`)}${dialect.quoteEnd}`;
}

function toSqlStringLiteral(value, dialect) {
    return `${dialect.stringPrefix}'${escapeSqlString(value)}'`;
}

function formatTimestampForDialect(value, dialect) {
    const normalized = parseTemporalValue(value)?.normalized || String(value).trim();

    if (dialect.timestampStyle === 'space') {
        return normalized.replace('T', ' ').replace(/(?:Z|[+-]\d{2}:\d{2})$/i, '');
    }

    if (dialect.timestampStyle === 'sqlserver') {
        return normalized.replace(/(?:Z|[+-]\d{2}:\d{2})$/i, '');
    }

    return normalized;
}

function toSqlLiteral(value, type, dialect) {
    if (isSqlNullValue(value)) return 'NULL';

    if (type === 'BOOLEAN') {
        const parsed = parseBoolean(value, { allowNumeric: true });
        return parsed === null ? 'NULL' : parsed ? dialect.booleanLiterals.true : dialect.booleanLiterals.false;
    }

    if (type === 'INTEGER' || type === 'NUMERIC') {
        const parsed = parseNumberLike(value);
        if (parsed === null) return 'NULL';
        if (type === 'INTEGER' && !parsed.isInteger) return 'NULL';
        return parsed.literal;
    }

    if (type === 'DATE') {
        const parsed = parseTemporalValue(value);
        return parsed?.kind === 'DATE' ? toSqlStringLiteral(parsed.normalized, dialect) : 'NULL';
    }

    if (type === 'TIMESTAMP') {
        const parsed = parseTemporalValue(value);
        return parsed?.kind === 'TIMESTAMP' ? toSqlStringLiteral(formatTimestampForDialect(value, dialect), dialect) : 'NULL';
    }

    return toSqlStringLiteral(value, dialect);
}

function chunkRows(rows, chunkSize) {
    if (!Number.isFinite(chunkSize) || rows.length <= chunkSize) return [rows];

    const chunks = [];
    for (let index = 0; index < rows.length; index += chunkSize) {
        chunks.push(rows.slice(index, index + chunkSize));
    }
    return chunks;
}

function generateSql({ tableName, columns, rows, dialect }) {
    const quotedTableName = quoteSqlIdentifier(tableName, dialect);
    const columnDefinitions = columns.map((column) => `    ${quoteSqlIdentifier(column.name, dialect)} ${column.sqlType}`).join(',\n');
    const columnNames = columns.map((column) => quoteSqlIdentifier(column.name, dialect)).join(', ');
    const createStatement = `CREATE TABLE ${quotedTableName} (\n${columnDefinitions}\n);`;
    const dataRows = rows.filter(rowHasValue);

    if (!dataRows.length) {
        return createStatement;
    }

    const insertStatements = chunkRows(dataRows, dialect.maxRowsPerInsert)
        .map((rowBatch) => {
            const values = rowBatch
                .map((row) => {
                    const rowValues = columns.map((column, index) => toSqlLiteral(row[index], column.selectedType || column.inferredType, dialect)).join(', ');
                    return `    (${rowValues})`;
                })
                .join(',\n');

            return `INSERT INTO ${quotedTableName} (${columnNames}) VALUES\n${values};`;
        })
        .join('\n\n');

    return `${createStatement}\n\n${insertStatements}`;
}

function normalizeColumnTypeOverride(value) {
    const normalized = String(value || '').trim().toUpperCase();
    return SPREADSHEET_SQL_TYPE_IDS.has(normalized) ? normalized : '';
}

function formatIssueValue(value) {
    const text = String(value ?? '');
    const compact = text.replace(/\s+/g, ' ').trim();
    if (!compact) return 'blank value';
    return compact.length > 80 ? `"${compact.slice(0, 77)}..."` : `"${compact}"`;
}

function buildConversionIssues(columns, dataEntries) {
    const issues = [];

    dataEntries.forEach(({ row, rowNumber }) => {
        columns.forEach((column, columnIndex) => {
            const selectedType = column.selectedType || column.inferredType;
            const value = row[columnIndex];
            if (isValueCompatibleWithType(value, selectedType)) return;

            issues.push({
                id: `${rowNumber}:${column.name}:${columnIndex}`,
                severity: 'warning',
                rowNumber,
                columnName: column.name,
                originalColumnName: column.originalName,
                expectedType: selectedType,
                value,
                action: 'inserted_as_null',
                message: `Row ${rowNumber}, ${column.name}: ${formatIssueValue(value)} cannot be converted to ${selectedType} and will be inserted as NULL.`,
            });
        });
    });

    return issues;
}

function buildIssueRows(issues, dataEntries) {
    const entriesByRowNumber = new Map(dataEntries.map((entry) => [entry.rowNumber, entry]));
    const rowsByNumber = new Map();

    issues.forEach((issue) => {
        if (!rowsByNumber.has(issue.rowNumber)) {
            rowsByNumber.set(issue.rowNumber, {
                rowNumber: issue.rowNumber,
                row: entriesByRowNumber.get(issue.rowNumber)?.row || [],
                issues: [],
            });
        }
        rowsByNumber.get(issue.rowNumber).issues.push(issue);
    });

    return Array.from(rowsByNumber.values());
}

function compactWarnings(warnings, limit = 12) {
    const unique = [...new Set(warnings)];
    if (unique.length <= limit) return unique;
    return [...unique.slice(0, limit - 1), `${unique.length - limit + 1} more conversion notes hidden.`];
}

function escapeCsvCell(value) {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function createIssueReportCsv(model) {
    const issues = model?.issues || [];
    const rows = [['row_number', 'column', 'expected_type', 'raw_value', 'action', 'message']];

    issues.forEach((issue) => {
        rows.push([issue.rowNumber, issue.columnName, issue.expectedType, issue.value, issue.action, issue.message]);
    });

    return rows.map((row) => row.map(escapeCsvCell).join(',')).join('\n');
}

// Public model builder used by the converter UI. It returns both generated SQL
// and the metadata needed for previews, warnings, issue exports, and type
// override controls.
export function createSqlModel({ rows, tableName, hasHeader = true, dialect = DEFAULT_SPREADSHEET_SQL_DIALECT, columnTypeOverrides = {} }) {
    const normalizedRows = normalizeRows(rows || []);
    const sqlDialect = getSpreadsheetSqlDialect(dialect);

    if (!normalizedRows.length) {
        return {
            tableName: sanitizeSqlIdentifier(tableName, 'uploaded_table'),
            dialect: {
                id: sqlDialect.id,
                label: sqlDialect.label,
                description: sqlDialect.description,
            },
            columns: [],
            rows: [],
            previewRows: [],
            rowNumbers: [],
            previewRowNumbers: [],
            sql: '',
            warnings: ['No rows were found in this file.'],
            issues: [],
            issueRows: [],
            issueSummary: { total: 0, affectedRows: 0 },
        };
    }

    const columnCount = normalizedRows.reduce((max, row) => Math.max(max, row.length), 0);
    const headerValues = hasHeader ? normalizedRows[0] : Array.from({ length: columnCount }, (_, index) => `column_${index + 1}`);
    const sourceRows = hasHeader ? normalizedRows.slice(1) : normalizedRows;
    const dataEntries = sourceRows
        .map((row, index) => ({
            row: Array.from({ length: columnCount }, (_, columnIndex) => row[columnIndex] ?? ''),
            rowNumber: index + (hasHeader ? 2 : 1),
        }))
        .filter((entry) => rowHasValue(entry.row));
    const dataRows = dataEntries.map((entry) => entry.row);
    const columnNames = uniqueIdentifiers(headerValues, 'column');
    const warnings = [];

    const columns = columnNames.map((name, index) => {
        const values = dataRows.map((row) => row[index]);
        const nonEmptyCount = values.filter((value) => !isSqlNullValue(value)).length;
        const typeProfile = inferColumnProfile(values);
        const inferredType = typeProfile.inferredType;
        const selectedOverride = normalizeColumnTypeOverride(columnTypeOverrides[name]);
        const selectedType = selectedOverride || inferredType;
        const originalName = String(headerValues[index] || '').trim();
        const plainOriginalName = originalName.toLowerCase();
        const hasSqlSafeOriginalName = /^[a-z_][a-z0-9_]*$/.test(plainOriginalName) && !RESERVED_WORDS.has(plainOriginalName);

        if (hasHeader && !originalName) {
            warnings.push(`Blank header at column ${index + 1} was renamed to ${name}.`);
        } else if (originalName && (!hasSqlSafeOriginalName || plainOriginalName !== name)) {
            warnings.push(`${originalName} was normalized to ${name}.`);
        }

        if (typeProfile.textReasons.has('leading-zero-number')) {
            warnings.push(`${name} was kept as TEXT to preserve leading-zero values such as ${formatIssueValue(typeProfile.textReasons.get('leading-zero-number'))}.`);
        } else if (inferredType === 'TEXT' && typeProfile.kindCounts.size > 1) {
            warnings.push(`${name} was kept as TEXT because values mix ${formatDetectedTypes(typeProfile.kindCounts)}.`);
        }

        if (selectedOverride && selectedOverride !== inferredType) {
            warnings.push(`${name} is forced to ${selectedOverride}; auto-detected ${inferredType}.`);
        }

        return {
            name,
            originalName: originalName || name,
            inferredType,
            selectedType,
            isTypeOverridden: Boolean(selectedOverride),
            typeConfidence: typeProfile.confidence,
            detectedTypes: Array.from(typeProfile.kindCounts.keys()),
            sqlType: sqlDialect.typeMap[selectedType],
            nonEmptyCount,
            emptyCount: Math.max(dataRows.length - nonEmptyCount, 0),
            nullLikeCount: typeProfile.nullLikeCount,
            sample: values.find((value) => !isSqlNullValue(value)) ?? '',
        };
    });

    const safeTableName = sanitizeSqlIdentifier(tableName, 'uploaded_table');
    if (safeTableName !== tableName) {
        warnings.push(`Table name was normalized to ${safeTableName}.`);
    }

    const issues = buildConversionIssues(columns, dataEntries);
    if (issues.length) {
        warnings.push(`${issues.length} values need review before they can match the selected SQL types.`);
    }

    const issueRows = buildIssueRows(issues, dataEntries);

    return {
        tableName: safeTableName,
        dialect: {
            id: sqlDialect.id,
            label: sqlDialect.label,
            description: sqlDialect.description,
        },
        columns,
        rows: dataRows,
        rowNumbers: dataEntries.map((entry) => entry.rowNumber),
        previewRows: dataRows.slice(0, 100),
        previewRowNumbers: dataEntries.slice(0, 100).map((entry) => entry.rowNumber),
        sql: generateSql({ tableName: safeTableName, columns, rows: dataRows, dialect: sqlDialect }),
        warnings: compactWarnings(warnings),
        issues,
        issueRows,
        issueSummary: { total: issues.length, affectedRows: issueRows.length },
    };
}

export function formatCellForDisplay(value) {
    if (value === true) return 'TRUE';
    if (value === false) return 'FALSE';
    if (isBlankValue(value)) return '';
    return String(value);
}
