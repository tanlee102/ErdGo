/** Protects dialect hints shared by the editor footer and Add Table defaults. */
import { describe, expect, it } from 'vitest';
import { detectEditorSqlDialect } from '@/features/editor/lib/sqlDialectDetection';

describe('editor SQL dialect detection', () => {
    it.each([
        ['postgres', 'SET search_path=public;'],
        ['postgres', 'SET LOCAL statement_timeout TO 1000;'],
        ['mysql', 'SET NAMES utf8mb4;'],
        ['mssql', 'SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER OFF;'],
    ])('inherits native %s dump directives from a separate tab', (id, directive) => {
        const portable = 'CREATE TABLE items(id INTEGER PRIMARY KEY);';
        expect(detectEditorSqlDialect(portable, `${directive}\n\n${portable}`)).toMatchObject({ id, scope: 'workspace', confidence: 'high' });
        expect(detectEditorSqlDialect(`-- ${directive}\n${portable}`)).toMatchObject({ id: 'auto' });
        expect(detectEditorSqlDialect(`CREATE TABLE notes(body TEXT DEFAULT '${directive}');`)).toMatchObject({ id: 'auto' });
    });
    it.each([
        ['sqlite', 'SQLite', 'CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT);'],
        ['postgres', 'PostgreSQL', 'CREATE TABLE items (id BIGSERIAL PRIMARY KEY, metadata JSONB);'],
        ['mysql', 'MySQL', 'CREATE TABLE `items` (id INT AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB;'],
        ['mssql', 'MSSQL', 'CREATE TABLE [items] (id INT IDENTITY(1,1) PRIMARY KEY);'],
    ])('detects %s in the focused tab', (id, label, sql) => {
        expect(detectEditorSqlDialect(sql, sql)).toMatchObject({ id, label, scope: 'tab', confidence: 'high' });
    });

    it('inherits the workspace dialect for an empty or portable tab', () => {
        const workspace = 'PRAGMA foreign_keys = ON; CREATE TABLE items (id INTEGER PRIMARY KEY);';
        for (const sql of ['', 'SELECT * FROM items;', 'CREATE TABLE tags (id INTEGER PRIMARY KEY);']) {
            expect(detectEditorSqlDialect(sql, workspace)).toMatchObject({ id: 'sqlite', scope: 'workspace' });
        }
    });

    it.each([
        ['mysql', 'CREATE TABLE `items` (id INTEGER);'],
        ['mssql', 'CREATE TABLE [items] (id INTEGER);'],
    ])('marks a quote-only %s match as likely rather than certain', (id, sql) => {
        expect(detectEditorSqlDialect(sql)).toMatchObject({ id, confidence: 'medium', description: expect.stringContaining('Likely') });
    });

    it('prefers the focused tab in a mixed workspace', () => {
        const mysql = 'CREATE TABLE items (id INT AUTO_INCREMENT PRIMARY KEY);';
        const postgres = 'CREATE TABLE tags (id SERIAL PRIMARY KEY);';
        expect(detectEditorSqlDialect(mysql, `${mysql}\n${postgres}`)).toMatchObject({ id: 'mysql', scope: 'tab' });
        expect(detectEditorSqlDialect(postgres, `${mysql}\n${postgres}`)).toMatchObject({ id: 'postgres', scope: 'tab' });
        expect(detectEditorSqlDialect('', `${mysql}\n${postgres}`)).toMatchObject({ id: 'auto', label: 'Mixed SQL' });
    });

    it('does not resolve a mixed tab using another tab', () => {
        const mixed = 'CREATE TABLE a (id SERIAL); CREATE TABLE b (id INT AUTO_INCREMENT);';
        expect(detectEditorSqlDialect(mixed, 'CREATE TABLE a (id SERIAL);')).toMatchObject({ id: 'auto', label: 'Mixed SQL', scope: 'tab' });
    });

    it.each([
        '',
        'CREATE TABLE go (id INTEGER, strict TEXT, jsonb TEXT, serial TEXT, auto_increment TEXT);',
        'CREATE TABLE unfinished (',
        'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);',
        "-- MySQL AUTO_INCREMENT\nCREATE TABLE notes (note TEXT DEFAULT 'PRAGMA AUTOINCREMENT');",
        "CREATE TABLE unfinished (note TEXT DEFAULT 'IDENTITY(1,1)",
        'CREATE TABLE "strict" ("go" INTEGER, "jsonb" TEXT, "auto_increment" INTEGER);',
    ])('keeps ambiguous or malformed SQL neutral: %s', sql => {
        expect(detectEditorSqlDialect(sql)).toMatchObject({ id: 'auto', label: 'SQL', confidence: 'low' });
    });

    it('detects computed SQL Server columns and real GO batches without mistaking names for syntax', () => {
        expect(detectEditorSqlDialect('CREATE TABLE totals(amount INT, total AS (amount * 2) PERSISTED);')).toMatchObject({ id: 'mssql', confidence: 'high' });
        expect(detectEditorSqlDialect('CREATE TABLE records(id INT);\nGO\n')).toMatchObject({ id: 'mssql', confidence: 'high' });
        expect(detectEditorSqlDialect('CREATE TABLE go(id INT);')).toMatchObject({ id: 'auto' });
    });

    it.each(['`', '['])('lets native SQLite syntax outweigh ambiguous %s quoting', quote => {
        const endQuote = quote === '[' ? ']' : quote;
        const sql = `PRAGMA foreign_keys = ON; CREATE TABLE ${quote}items${endQuote} (id INTEGER PRIMARY KEY AUTOINCREMENT);`;
        expect(detectEditorSqlDialect(sql)).toMatchObject({ id: 'sqlite', confidence: 'high' });
    });
});
