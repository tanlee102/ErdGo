/**
 * Pure SQL import pipeline for validating browser files before editor-tab creation.
 * It owns size/type limits, text decoding, dialect hints, combined-workspace parsing,
 * and conversion of global parser diagnostics back to file-local line numbers.
 */
import { sqlToErdSchema } from '@/lib/erdJsonSchema';

export const SQL_IMPORT_ACCEPT = '.sql,.ddl,.dump,.backup,.psql,.mysql,.sqlite,.sqlite3,.txt,application/sql,text/sql,text/plain';
export const MAX_SQL_IMPORT_FILES = 24;
export const MAX_SQL_IMPORT_FILE_BYTES = 30 * 1024 * 1024;
export const MAX_SQL_IMPORT_TOTAL_BYTES = 90 * 1024 * 1024;

const DIALECT_DEFINITIONS = [
    {
        id: 'postgresql',
        label: 'PostgreSQL',
        signals: [
            [/\bpg_dump\b|\bPostgreSQL database dump\b/gi, 8, 'pg_dump header'],
            [/\bSET\s+(?:search_path|statement_timeout|lock_timeout|client_encoding)\b/gi, 5, 'PostgreSQL SET command'],
            [/\bCOPY\s+[\s\S]{0,160}\sFROM\s+stdin\s*;/gi, 6, 'COPY FROM stdin'],
            [/\b(?:BIG|SMALL)?SERIAL\b/gi, 4, 'SERIAL type'],
            [/::\s*(?:[A-Za-z_][\w$]*|"[^"]+")/g, 3, 'PostgreSQL cast'],
            [/\bCREATE\s+TYPE\s+[\s\S]{0,120}\bAS\s+(?:ENUM|\()/gi, 4, 'CREATE TYPE'],
            [/\bOWNER\s+TO\b|\bALTER\s+(?:TABLE|TYPE|SEQUENCE)\b[\s\S]{0,100}\bOWNER\s+TO\b/gi, 4, 'object ownership'],
            [/\bJSONB\b|\bBYTEA\b|\bTIMESTAMPTZ\b|\bUUID\s+DEFAULT\s+(?:gen_random_uuid|uuid_generate_v4)\s*\(/gi, 3, 'PostgreSQL type or function'],
            [/\$[A-Za-z_\d]*\$[\s\S]*?\$[A-Za-z_\d]*\$/g, 3, 'dollar-quoted body'],
        ],
    },
    {
        id: 'mysql',
        label: 'MySQL',
        signals: [
            [/\bMySQL dump\b|\bmysqldump\b/gi, 8, 'mysqldump header'],
            [/\/\*!\d{5}[\s\S]*?\*\//g, 6, 'versioned MySQL comment'],
            [/\bENGINE\s*=\s*(?:InnoDB|MyISAM|MEMORY|NDB|ARCHIVE)\b/gi, 5, 'storage engine'],
            [/\bAUTO_INCREMENT\b/gi, 3, 'AUTO_INCREMENT'],
            [/\b(?:UN)?LOCK\s+TABLES\b|\bLOCK\s+TABLES\b/gi, 4, 'table locking command'],
            [/\bSET\s+NAMES\b|\bCHARACTER\s+SET\b|\bCOLLATE\s*=\s*[A-Za-z0-9_]+/gi, 3, 'MySQL charset setting'],
            [/\bDELIMITER\s+\S+/gi, 4, 'DELIMITER command'],
            [/`[^`]+`/g, 1, 'backtick identifier'],
            [/\bTINYINT\s*\(\s*1\s*\)|\bMEDIUMINT\b|\bDATETIME\s*\(\s*\d+\s*\)/gi, 2, 'MySQL type'],
        ],
    },
    {
        id: 'mssql',
        label: 'SQL Server',
        signals: [
            [/\bSQL Server database script\b|\bMicrosoft SQL Server\b/gi, 8, 'SQL Server header'],
            [/^\s*GO\s*(?:--.*)?$/gim, 5, 'GO batch separator'],
            [/\bSET\s+(?:ANSI_NULLS|QUOTED_IDENTIFIER|ANSI_PADDING)\s+(?:ON|OFF)\b/gi, 5, 'SQL Server SET command'],
            [/\bIDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)/gi, 4, 'IDENTITY property'],
            [/\b(?:N?VARCHAR|VARBINARY)\s*\(\s*MAX\s*\)|\bUNIQUEIDENTIFIER\b|\bDATETIMEOFFSET\b/gi, 3, 'SQL Server type'],
            [/\[(?:[^\]]|\]\])+\]/g, 1, 'bracket identifier'],
            [/\b(?:CLUSTERED|NONCLUSTERED)\b/gi, 2, 'SQL Server index'],
            [/\bUSE\s+\[[^\]]+\]|\bON\s+\[PRIMARY\]\b/gi, 3, 'SQL Server database directive'],
        ],
    },
    {
        id: 'sqlite',
        label: 'SQLite',
        signals: [
            [/\bSQLite database dump\b|\bSQLite format 3\b/gi, 8, 'SQLite header'],
            [/^\s*PRAGMA\s+[A-Za-z_][\w]*\s*(?:=|;|\()/gim, 6, 'PRAGMA command'],
            [/\bsqlite_(?:sequence|stat\d*|schema|master)\b/gi, 5, 'SQLite system table'],
            [/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, 4, 'SQLite AUTOINCREMENT'],
            [/\bWITHOUT\s+ROWID\b/gi, 5, 'WITHOUT ROWID'],
            [/\bCREATE\s+(?:TEMP\s+)?TABLE\b[\s\S]{0,500}\)\s*STRICT\s*;/gi, 4, 'STRICT table'],
            [/\bBEGIN\s+TRANSACTION\s*;[\s\S]{0,160}\bCREATE\s+TABLE\b/gi, 2, 'SQLite dump transaction'],
        ],
    },
];

const SQL_FILE_EXTENSIONS = new Set(['sql', 'ddl', 'dump', 'backup', 'psql', 'mysql', 'sqlite', 'sqlite3', 'txt']);
const SQL_STATEMENT_PATTERN = /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|SELECT|WITH|PRAGMA|COPY|SET|USE|BEGIN|COMMIT)\b/i;

function countMatches(source, pattern) {
    pattern.lastIndex = 0;
    let count = 0;
    while (pattern.exec(source)) {
        count += 1;
        if (!pattern.global) break;
    }
    pattern.lastIndex = 0;
    return count;
}

function normalizeFileName(name) {
    const normalized = String(name || 'Imported SQL').replace(/\\/g, '/').split('/').pop().trim();
    return normalized || 'Imported SQL';
}

function getFileExtension(name) {
    const match = normalizeFileName(name).toLowerCase().match(/\.([a-z0-9]+)$/);
    return match?.[1] || '';
}

export function getSqlImportTitle(name) {
    const fileName = normalizeFileName(name);
    const extension = getFileExtension(fileName);
    const withoutExtension = extension && SQL_FILE_EXTENSIONS.has(extension) ? fileName.slice(0, -(extension.length + 1)) : fileName;
    return (withoutExtension.trim() || 'Imported SQL').slice(0, 80);
}

export function detectSqlDialect(sql) {
    const source = typeof sql === 'string' ? sql.slice(0, 1_500_000) : '';
    const scored = DIALECT_DEFINITIONS.map((definition) => {
        const matchedSignals = [];
        let score = 0;

        definition.signals.forEach(([pattern, weight, label]) => {
            const occurrences = countMatches(source, pattern);
            if (occurrences === 0) return;
            score += weight + Math.min(occurrences - 1, 3);
            matchedSignals.push(label);
        });

        return { id: definition.id, label: definition.label, score, signals: matchedSignals };
    }).sort((left, right) => right.score - left.score);

    const best = scored[0];
    const runnerUp = scored[1];
    if (!best || best.score === 0) {
        return { id: 'generic', label: 'Standard SQL', confidence: 'neutral', score: 0, signals: [] };
    }

    const margin = best.score - (runnerUp?.score || 0);
    const confidence = best.score >= 8 && margin >= 3 ? 'high' : best.score >= 4 && margin >= 1 ? 'medium' : 'low';
    return { ...best, confidence };
}

function hasUtf16BytePattern(bytes) {
    const sampleLength = Math.min(bytes.length, 4000);
    if (sampleLength < 8) return null;
    let evenNulls = 0;
    let oddNulls = 0;
    for (let index = 0; index < sampleLength; index += 1) {
        if (bytes[index] !== 0) continue;
        if (index % 2 === 0) evenNulls += 1;
        else oddNulls += 1;
    }
    const pairs = sampleLength / 2;
    if (oddNulls / pairs > 0.35 && evenNulls / pairs < 0.05) return 'utf-16le';
    if (evenNulls / pairs > 0.35 && oddNulls / pairs < 0.05) return 'utf-16be';
    return null;
}

function looksBinary(bytes) {
    const sampleLength = Math.min(bytes.length, 16_384);
    if (sampleLength === 0) return false;
    let suspicious = 0;
    for (let index = 0; index < sampleLength; index += 1) {
        const value = bytes[index];
        if (value === 0 || (value < 7 || (value > 13 && value < 32))) suspicious += 1;
    }
    return suspicious / sampleLength > 0.02;
}

function startsWithAscii(bytes, value) {
    if (bytes.length < value.length) return false;
    return Array.from(value).every((character, index) => bytes[index] === character.charCodeAt(0));
}

export function decodeSqlFileBuffer(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || 0);
    if (startsWithAscii(bytes, 'PGDMP')) {
        return { blockedReason: 'PostgreSQL custom-format dumps are binary. Export this database with pg_dump --format=plain and import the resulting .sql file.' };
    }
    if (startsWithAscii(bytes, 'SQLite format 3')) {
        return { blockedReason: 'This is a binary SQLite database. Export it with .dump (or sqlite3 database.db .dump) and import the resulting text SQL.' };
    }

    let encoding = 'utf-8';
    let offset = 0;
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        offset = 3;
    } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
        encoding = 'utf-16le';
        offset = 2;
    } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
        encoding = 'utf-16be';
        offset = 2;
    } else {
        encoding = hasUtf16BytePattern(bytes) || 'utf-8';
    }

    if (encoding === 'utf-8' && looksBinary(bytes)) {
        return { blockedReason: 'This file appears to be binary. Import a plain-text SQL dump instead.' };
    }

    try {
        const text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset));
        return { text: text.replace(/^\uFEFF/, ''), encoding };
    } catch {
        if (encoding !== 'utf-8') {
            return { blockedReason: `This file could not be decoded as ${encoding.toUpperCase()} text.` };
        }
        try {
            const text = new TextDecoder('windows-1252', { fatal: true }).decode(bytes);
            return { text, encoding: 'windows-1252' };
        } catch {
            return { blockedReason: 'This file is not valid plain-text SQL.' };
        }
    }
}

function createSourceKey(file) {
    return `${normalizeFileName(file?.name)}:${Number(file?.size) || 0}:${Number(file?.lastModified) || 0}`;
}

export async function readSqlImportCandidates(fileList) {
    const files = Array.from(fileList || []);
    let acceptedBytes = 0;

    return Promise.all(
        files.map(async (file, index) => {
            const base = {
                sourceKey: createSourceKey(file),
                name: normalizeFileName(file?.name),
                title: getSqlImportTitle(file?.name),
                size: Number(file?.size) || 0,
                lastModified: Number(file?.lastModified) || 0,
            };

            if (index >= MAX_SQL_IMPORT_FILES) {
                return { ...base, blockedReason: `Only the first ${MAX_SQL_IMPORT_FILES} files can be imported at once.` };
            }
            if (base.size > MAX_SQL_IMPORT_FILE_BYTES) {
                return { ...base, blockedReason: `File is larger than ${Math.round(MAX_SQL_IMPORT_FILE_BYTES / 1024 / 1024)} MB. Export a schema-only or smaller plain-text dump.` };
            }
            acceptedBytes += base.size;
            if (acceptedBytes > MAX_SQL_IMPORT_TOTAL_BYTES) {
                return { ...base, blockedReason: `The selection exceeds the ${Math.round(MAX_SQL_IMPORT_TOTAL_BYTES / 1024 / 1024)} MB total import limit.` };
            }

            try {
                const decoded = decodeSqlFileBuffer(await file.arrayBuffer());
                return { ...base, ...decoded };
            } catch (error) {
                return { ...base, blockedReason: `Could not read this file: ${error?.message || 'unknown file error'}` };
            }
        }),
    );
}

function countSqlTables(sql) {
    return countMatches(sql, /\bCREATE\s+(?:(?:OR\s+REPLACE|TEMP(?:ORARY)?|UNLOGGED)\s+)*TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/gi);
}

function normalizeDiagnostic(diagnostic, index) {
    const line = diagnostic?.position?.line || diagnostic?.start?.line || diagnostic?.line || null;
    const column = diagnostic?.position?.column || diagnostic?.start?.col || diagnostic?.column || null;
    return {
        id: `import-diagnostic-${index}-${line || 0}-${column || 0}`,
        severity: diagnostic?.severity === 'warning' ? 'warning' : 'error',
        kind: diagnostic?.kind || null,
        message: diagnostic?.message || 'Unknown SQL parsing issue',
        globalLine: line,
        line,
        column,
    };
}

function assignDiagnosticsToFiles(files, diagnostics) {
    diagnostics.forEach((diagnostic) => {
        const line = diagnostic.globalLine;
        const owner = line ? files.find((file) => line >= file.startLine && line <= file.endLine) : files[0];
        if (!owner) return;
        owner.diagnostics.push({
            ...diagnostic,
            line: line ? line - owner.startLine + 1 : null,
            fileName: owner.name,
        });
    });
}

// Parse one concatenated workspace so references may resolve across imported files.
export function analyzeSqlImportCandidates(candidates) {
    const sourceCandidates = Array.isArray(candidates) ? candidates : [];
    const seenSourceKeys = new Set();
    let selectedBytes = 0;
    const files = sourceCandidates.map((candidate, index) => {
        const sourceKey = candidate?.sourceKey || `${normalizeFileName(candidate?.name)}:${index}`;
        let blockedReason = candidate?.blockedReason || '';
        const sql = typeof candidate?.text === 'string' ? candidate.text : '';
        selectedBytes += Number(candidate?.size) || 0;
        if (!blockedReason && index >= MAX_SQL_IMPORT_FILES) blockedReason = `Only the first ${MAX_SQL_IMPORT_FILES} files can be imported at once.`;
        if (!blockedReason && selectedBytes > MAX_SQL_IMPORT_TOTAL_BYTES) blockedReason = `The selection exceeds the ${Math.round(MAX_SQL_IMPORT_TOTAL_BYTES / 1024 / 1024)} MB total import limit.`;
        if (seenSourceKeys.has(sourceKey)) blockedReason = 'This file is already in the import selection.';
        seenSourceKeys.add(sourceKey);
        if (!blockedReason && !sql.trim()) blockedReason = 'This file is empty.';
        if (!blockedReason && !SQL_STATEMENT_PATTERN.test(sql)) blockedReason = 'No recognizable SQL statements were found in this file.';

        return {
            ...candidate,
            sourceKey,
            name: normalizeFileName(candidate?.name),
            title: candidate?.title || getSqlImportTitle(candidate?.name),
            sql,
            dialect: sql ? detectSqlDialect(sql) : { id: 'generic', label: 'Unknown', confidence: 'neutral', score: 0, signals: [] },
            tableCount: sql ? countSqlTables(sql) : 0,
            diagnostics: [],
            blockedReason,
        };
    });

    const readyFiles = files.filter((file) => !file.blockedReason);
    let combinedSql = '';
    let nextStartLine = 1;
    readyFiles.forEach((file, index) => {
        const lineCount = file.sql.split('\n').length;
        file.startLine = nextStartLine;
        file.endLine = nextStartLine + lineCount - 1;
        combinedSql += `${index > 0 ? '\n\n' : ''}${file.sql}`;
        nextStartLine = file.endLine + 2;
    });

    let schema = null;
    let diagnostics = [];
    if (combinedSql.trim()) {
        try {
            schema = sqlToErdSchema(combinedSql);
            diagnostics = (schema?._parseErrors || []).map(normalizeDiagnostic);
            assignDiagnosticsToFiles(readyFiles, diagnostics);
        } catch (error) {
            diagnostics = [{ id: 'import-fatal', severity: 'error', kind: 'import_parse_failed', message: error?.message || 'The selected SQL could not be parsed.', line: null, column: null }];
            if (readyFiles[0]) readyFiles[0].diagnostics.push(diagnostics[0]);
        }
    }

    const detectedDialectIds = new Set(readyFiles.map((file) => file.dialect.id).filter((id) => id !== 'generic'));
    const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity !== 'warning').length;
    const warningCount = diagnostics.length - errorCount;

    return {
        files,
        readyFiles,
        blockedFiles: files.filter((file) => Boolean(file.blockedReason)),
        combinedSql,
        schema,
        tableCount: schema?.tables?.length || readyFiles.reduce((total, file) => total + file.tableCount, 0),
        diagnostics,
        errorCount,
        warningCount,
        hasMixedDialects: detectedDialectIds.size > 1,
    };
}

export function formatSqlImportBytes(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
