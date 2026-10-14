/** Exercises deep parser contracts across nested and dialect-specific syntax. */
import { describe, expect, it } from 'vitest';
import { parseAST } from '@/lib/parse-ast/parseAst.js';
import { tokenize } from '@/lib/parse-ast/tokenize.js';

const validCases = [
    {
        name: 'schema-qualified create type and table',
        sql: `
            CREATE TYPE app.money AS (amount NUMERIC(12,2), currency CHAR(3));
            CREATE TABLE app.wallets (
                id BIGSERIAL PRIMARY KEY,
                balance app.money,
                tags TEXT[] DEFAULT '{}'
            );
        `,
        tables: ['app.wallets'],
        types: ['app.money'],
    },
    {
        name: 'reserved words as quoted identifiers',
        sql: `
            CREATE TABLE "order" (
                "select" INT PRIMARY KEY,
                "from" TEXT NOT NULL,
                "group" TEXT UNIQUE
            );
        `,
        tables: ['order'],
        types: [],
    },
    {
        name: 'MSSQL table options after create table',
        sql: `
            CREATE TABLE [dbo].[Audit] (
                [AuditID] BIGINT IDENTITY(10,5) NOT NULL,
                [Actor] NVARCHAR(256) NOT NULL,
                [Summary] AS ([Actor] + N':event') PERSISTED,
                CONSTRAINT [PK_Audit] PRIMARY KEY ([AuditID])
            ) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY];
        `,
        tables: ['dbo.Audit'],
        types: [],
    },
    {
        name: 'MySQL inline index variants are collected',
        sql: `
            CREATE TABLE \`search_docs\` (
                \`id\` BIGINT NOT NULL AUTO_INCREMENT,
                \`body\` TEXT,
                \`point\` POINT,
                PRIMARY KEY (\`id\`),
                FULLTEXT KEY \`ft_body\` (\`body\`),
                SPATIAL KEY \`sp_point\` (\`point\`)
            ) ENGINE=InnoDB;
        `,
        tables: ['search_docs'],
        types: [],
        indexes: ['ft_body', 'sp_point'],
    },
    {
        name: 'SQLite generated column and WITHOUT ROWID suffix',
        sql: `
            CREATE TABLE pages (
                id TEXT NOT NULL,
                slug TEXT NOT NULL,
                slug_key TEXT GENERATED ALWAYS AS (lower(slug)) STORED,
                PRIMARY KEY (id, slug)
            ) WITHOUT ROWID;
        `,
        tables: ['pages'],
        types: [],
    },
];

describe('parseAST deep contracts', () => {
    it.each(validCases)('parses $name without diagnostics', ({ sql, tables, types, indexes = [] }) => {
        const parsed = parseAST(sql);

        expect(parsed.errors).toEqual([]);
        expect(parsed.ast.tables.map((table) => table.name)).toEqual(tables);
        expect(parsed.ast.types.map((type) => type.name)).toEqual(types);
        for (const indexName of indexes) {
            expect(parsed.ast.indexes.map((index) => index.name)).toContain(indexName);
        }
    });

    it('reports tokenizer errors with increasing source positions', () => {
        const sql = `
            CREATE TABLE ok_one (id INT);
            CREATE TABLE broken_one (name TEXT DEFAULT 'unterminated);
            CREATE TABLE broken_two (name TEXT DEFAULT "unterminated);
        `;
        const parsed = parseAST(sql);
        const tokenizerErrors = parsed.errors.filter((error) => error.kind);
        const indexes = tokenizerErrors.map((error) => error.position.index);
        const structuralError = parsed.errors.find((error) => /Unclosed parenthesis in table 'broken_one'/i.test(error.message));

        expect(tokenizerErrors).toHaveLength(2);
        expect(new Set(indexes).size).toBe(2);
        for (const index of indexes) {
            expect(index).toBeGreaterThan(0);
        }
        expect(structuralError).toMatchObject({ severity: 'error' });
        expect(structuralError.position.index).toBeGreaterThan(0);
        expect(parsed.ast.tables.map((table) => table.name)).toContain('ok_one');
    });

    it('keeps comments out of token stream while preserving token positions', () => {
        const sql = `-- lead comment\nCREATE TABLE demo (id INT);`;
        const { tokens, errors } = tokenize(sql, { skipComments: true, lowercaseIdentifiers: false });

        expect(errors).toEqual([]);
        expect(tokens[0].value).toBe('CREATE');
        expect(tokens[0].start.line).toBe(2);
        expect(tokens[0].start.col).toBe(1);
    });
});
