/** Verifies SQL file decoding, preflight, dialect hints, and local diagnostic mapping. */
import { describe, expect, it } from 'vitest';
import {
    analyzeSqlImportCandidates,
    decodeSqlFileBuffer,
    detectSqlDialect,
    getSqlImportTitle,
    MAX_SQL_IMPORT_FILE_BYTES,
    MAX_SQL_IMPORT_TOTAL_BYTES,
    readSqlImportCandidates,
} from '@/features/editor/lib/sqlImport';

function candidate(name, text, overrides = {}) {
    return {
        sourceKey: `${name}:${text.length}`,
        name,
        title: getSqlImportTitle(name),
        size: text.length,
        text,
        encoding: 'utf-8',
        ...overrides,
    };
}

function uploadFile(name, size, sql = 'CREATE TABLE imported_table (id INTEGER PRIMARY KEY);') {
    return {
        name,
        size,
        lastModified: 1,
        arrayBuffer: async () => new TextEncoder().encode(sql).buffer,
    };
}

describe('SQL file import', () => {
    it.each([
        [
            'PostgreSQL',
            `-- PostgreSQL database dump\nSET search_path = public;\nCREATE TABLE users (id BIGSERIAL PRIMARY KEY, settings JSONB);`,
            'postgresql',
        ],
        [
            'MySQL',
            `-- MySQL dump\nCREATE TABLE \`users\` (id BIGINT AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB;`,
            'mysql',
        ],
        [
            'SQL Server',
            `SET ANSI_NULLS ON\nGO\nCREATE TABLE [dbo].[users] ([id] INT IDENTITY(1,1) PRIMARY KEY);\nGO`,
            'mssql',
        ],
        [
            'SQLite',
            `PRAGMA foreign_keys=OFF;\nCREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT);`,
            'sqlite',
        ],
    ])('detects %s dump syntax', (_label, sql, dialectId) => {
        const dialect = detectSqlDialect(sql);
        expect(dialect.id).toBe(dialectId);
        expect(dialect.score).toBeGreaterThan(3);
        expect(dialect.signals.length).toBeGreaterThan(0);
    });

    it('labels portable DDL as dialect-neutral instead of inventing certainty', () => {
        expect(detectSqlDialect('CREATE TABLE users (id INTEGER PRIMARY KEY);')).toMatchObject({
            id: 'generic',
            label: 'Standard SQL',
            confidence: 'neutral',
        });
    });

    it('decodes UTF-16 SQL Server exports and rejects binary database formats with actionable guidance', () => {
        const sql = 'CREATE TABLE [users] ([id] INT);';
        const utf16Bytes = new Uint8Array(2 + sql.length * 2);
        utf16Bytes.set([0xff, 0xfe]);
        Array.from(sql).forEach((character, index) => {
            utf16Bytes[2 + index * 2] = character.charCodeAt(0);
            utf16Bytes[3 + index * 2] = 0;
        });

        expect(decodeSqlFileBuffer(utf16Bytes)).toMatchObject({ text: sql, encoding: 'utf-16le' });
        expect(decodeSqlFileBuffer(new TextEncoder().encode('PGDMP\u0001\u000e'))?.blockedReason).toMatch(/pg_dump --format=plain/i);
        expect(decodeSqlFileBuffer(new TextEncoder().encode('SQLite format 3\u0000'))?.blockedReason).toMatch(/binary SQLite database/i);
    });

    it('preflights multiple files as one workspace and maps diagnostics back to file-local lines', () => {
        const users = candidate('01-users.sql', 'CREATE TABLE users (id INTEGER PRIMARY KEY);');
        const posts = candidate(
            '02-posts.sql',
            [
                'CREATE TABLE posts (',
                '  id INTEGER PRIMARY KEY,',
                '  user_id INTEGER NOT NULL,',
                '  FOREIGN KEY (user_id) REFERENCES users(id)',
                ');',
            ].join('\n'),
        );
        const broken = candidate('03-broken.sql', 'CREATE TABLE broken (\n  id INTEGER,\n  FOREIGN KEY (missing_id) REFERENCES nowhere(id)\n);');

        const report = analyzeSqlImportCandidates([users, posts, broken]);

        expect(report.readyFiles).toHaveLength(3);
        expect(report.tableCount).toBe(3);
        expect(posts.diagnostics).toBeUndefined();
        expect(report.files[1].diagnostics).toEqual([]);
        expect(report.files[2].diagnostics.length).toBeGreaterThan(0);
        expect(report.files[2].diagnostics[0]).toMatchObject({ fileName: '03-broken.sql' });
        expect(report.files[2].diagnostics[0].line).toBeGreaterThanOrEqual(1);
    });

    it('blocks empty and duplicate selections without discarding valid files', () => {
        const schema = candidate('schema.sql', 'CREATE TABLE users (id INTEGER);');
        const duplicate = { ...schema, selectionId: 'second-copy' };
        const empty = candidate('empty.sql', '   ');

        const report = analyzeSqlImportCandidates([schema, duplicate, empty]);

        expect(report.readyFiles).toHaveLength(1);
        expect(report.blockedFiles).toHaveLength(2);
        expect(report.blockedFiles.map((file) => file.blockedReason)).toEqual(
            expect.arrayContaining([expect.stringMatching(/already in the import selection/i), expect.stringMatching(/empty/i)]),
        );
    });

    it('accepts a 30 MB SQL file and rejects the first byte above the per-file limit', async () => {
        const [atLimit, overLimit] = await readSqlImportCandidates([
            uploadFile('at-limit.sql', MAX_SQL_IMPORT_FILE_BYTES),
            uploadFile('over-limit.sql', MAX_SQL_IMPORT_FILE_BYTES + 1),
        ]);

        expect(atLimit.blockedReason).toBeUndefined();
        expect(atLimit.text).toContain('CREATE TABLE');
        expect(overLimit.blockedReason).toMatch(/larger than 30 MB/i);
    });

    it('allows up to 90 MB across a selection and blocks the first byte above it', async () => {
        const files = await readSqlImportCandidates([
            uploadFile('part-1.sql', MAX_SQL_IMPORT_FILE_BYTES),
            uploadFile('part-2.sql', MAX_SQL_IMPORT_FILE_BYTES),
            uploadFile('part-3.sql', MAX_SQL_IMPORT_FILE_BYTES),
            uploadFile('part-4.sql', 1),
        ]);

        expect(files.slice(0, 3).every((file) => !file.blockedReason)).toBe(true);
        expect(files[3].blockedReason).toMatch(/90 MB total import limit/i);
        expect(MAX_SQL_IMPORT_TOTAL_BYTES).toBe(MAX_SQL_IMPORT_FILE_BYTES * 3);
    });

    it('creates concise tab titles from supported dump filenames', () => {
        expect(getSqlImportTitle('/exports/customer-schema.sql')).toBe('customer-schema');
        expect(getSqlImportTitle('nightly.backup')).toBe('nightly');
        expect(getSqlImportTitle('schema.custom')).toBe('schema.custom');
    });
});
