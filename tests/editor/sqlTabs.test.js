/** Defines SQL tab creation, persistence, ordering, and combined-workspace contracts. */
import { describe, expect, it } from 'vitest';
import {
    SQL_TABS_CONTEXT_KEY,
    INACTIVE_TAB_PLACEHOLDER_SQL,
    buildCombinedSql,
    findCreateTableMatchInSql,
    findSqlTabForTable,
    findSqlTabTableLocation,
    getActiveSqlTabIdFromContext,
    getDirtySqlTabIds,
    hydrateSqlTabsFromContext,
    mapDiagnosticsToActiveSqlTab,
    mapDiagnosticsToSqlTabs,
    mergeActiveSqlTabs,
    reconcileSqlTabsFromCombinedSql,
    serializeSqlTabs,
} from '@/features/editor/lib/sqlTabs';

function tab(id, title, sql) {
    return { id, title, sql, createdAt: 1 };
}

describe('SQL tabs utilities', () => {
    it('counts a trailing CR and separator LF as one newline for diagnostic ownership', () => {
        const tabs = [tab('a', 'First', 'CREATE TABLE p(id INTEGER);\r'), tab('b', 'Last', '-- header\rCREATE TABLE c(id INTEGER);')];
        const combined = buildCombinedSql(tabs);
        expect(combined.ranges[0]).toMatchObject({ startLine: 1, endLine: 2, lineCount: 2 });
        expect(combined.ranges[1]).toMatchObject({ startLine: 3, endLine: 4, lineCount: 2 });
        expect(mapDiagnosticsToSqlTabs([{ position: { line: 4, column: 1 } }], tabs)[0]).toMatchObject({ tabId: 'b', line: 2, globalLine: 4 });
    });
    it.each(['\n', '\r\n'])('retains independent edits when final lines are appended or removed with %j endings', (eol) => {
        const initial = [tab('a', 'First', 'CREATE TABLE p(id INTEGER PRIMARY KEY);'), tab('b', 'Last', `-- header${eol}CREATE TABLE c(id INTEGER);`)];
        for (const suffix of ['', eol]) {
            const tabs = initial.map((item) => item.id === 'b' ? { ...item, sql: item.sql + suffix } : item);
            const changed = tabs.map((item) => item.id === 'a' ? { ...item, sql: item.sql.replace('INTEGER', 'BIGINT') } : { ...item, sql: item.sql + eol + '-- appended' });
            expect(reconcileSqlTabsFromCombinedSql(tabs, buildCombinedSql(changed).sql)).toEqual(changed);
            const restored = changed.map((item) => item.id === 'a' ? { ...item, sql: item.sql.replace('BIGINT', 'SMALLINT') } : tabs[1]);
            expect(reconcileSqlTabsFromCombinedSql(changed, buildCombinedSql(restored).sql)).toEqual(restored);
        }
    });
    it('merges an active-only result without losing or moving inactive drafts', () => {
        const currentTabs = [
            tab('users', 'Users', 'CREATE TABLE users (id INT);'),
            { ...tab('private', 'Private draft', 'CREATE TABLE secrets (id INT);'), isInactive: true },
            tab('orders', 'Orders', 'CREATE TABLE orders (id INT);'),
        ];
        const nextActiveTabs = [
            tab('orders', 'Orders', 'CREATE TABLE orders (id INT, total NUMERIC);'),
            tab('users', 'Users', 'CREATE TABLE users (id INT, email TEXT);'),
            tab('audit', 'Audit', 'CREATE TABLE audit (id INT);'),
        ];

        const merged = mergeActiveSqlTabs(currentTabs, nextActiveTabs);

        expect(merged.map((item) => item.id)).toEqual(['orders', 'private', 'users', 'audit']);
        expect(merged[1]).toMatchObject({
            id: 'private',
            title: 'Private draft',
            sql: 'CREATE TABLE secrets (id INT);',
            isInactive: true,
        });
        expect(buildCombinedSql(merged).sql).toBe(
            ['CREATE TABLE orders (id INT, total NUMERIC);', 'CREATE TABLE users (id INT, email TEXT);', 'CREATE TABLE audit (id INT);'].join('\n\n'),
        );
    });

    it('repairs active ids that collide with inactive drafts during a merge', () => {
        const currentTabs = [
            tab('schema', 'Schema', 'CREATE TABLE users (id INT);'),
            { ...tab('ai_tab_1', 'Saved draft', '-- private'), isInactive: true },
        ];
        const nextActiveTabs = [tab('ai_tab_1', 'AI result', 'CREATE TABLE orders (id INT);')];

        const merged = mergeActiveSqlTabs(currentTabs, nextActiveTabs);

        expect(merged).toHaveLength(2);
        expect(new Set(merged.map((item) => item.id)).size).toBe(2);
        expect(merged.find((item) => item.isInactive)).toMatchObject({ id: 'ai_tab_1', sql: '-- private' });
        expect(merged.find((item) => !item.isInactive)).toMatchObject({ title: 'AI result', sql: 'CREATE TABLE orders (id INT);' });
    });

    it('keeps accepted inactive state for AI-visible tabs while protecting excluded drafts', () => {
        const currentTabs = [
            tab('schema', 'Schema', 'CREATE TABLE users (id INT);'),
            { ...tab('private', 'Private draft', '-- private'), isInactive: true },
        ];
        const nextWorkspaceTabs = [{ ...currentTabs[0], isInactive: true }];

        const merged = mergeActiveSqlTabs(currentTabs, nextWorkspaceTabs, new Set(['private']));

        expect(merged).toEqual([
            expect.objectContaining({ id: 'schema', isInactive: true, sql: 'CREATE TABLE users (id INT);' }),
            expect.objectContaining({ id: 'private', isInactive: true, sql: '-- private' }),
        ]);
        expect(buildCombinedSql(merged).sql).toBe(INACTIVE_TAB_PLACEHOLDER_SQL);
    });

    it('combines non-empty tabs in workspace order and records restorable ranges', () => {
        const tabs = [tab('a', 'SQL 1', 'CREATE TABLE users (id INT);'), tab('b', 'SQL 2', ''), tab('c', 'SQL 3', 'CREATE TABLE orders (id INT);')];

        const combined = buildCombinedSql(tabs);
        expect(combined.sql).toBe('CREATE TABLE users (id INT);\n\nCREATE TABLE orders (id INT);');
        expect(combined.ranges.map((range) => [range.id, range.start, range.end])).toEqual([
            ['a', 0, 28],
            ['b', 28, 28],
            ['c', 30, 59],
        ]);
    });

    it('hydrates saved tabs from combined SQL plus context metadata', () => {
        const tabs = [tab('a', 'Core', 'CREATE TABLE users (id INT);'), tab('b', 'Billing', 'CREATE TABLE invoices (id INT);')];
        const combined = buildCombinedSql(tabs).sql;
        const context = { [SQL_TABS_CONTEXT_KEY]: serializeSqlTabs(tabs, 'b') };

        const hydrated = hydrateSqlTabsFromContext(combined, context);

        expect(hydrated.map(({ id, title, sql }) => ({ id, title, sql }))).toEqual([
            { id: 'a', title: 'Core', sql: 'CREATE TABLE users (id INT);' },
            { id: 'b', title: 'Billing', sql: 'CREATE TABLE invoices (id INT);' },
        ]);
        expect(getActiveSqlTabIdFromContext(context, hydrated)).toBe('b');
    });

    it('round-trips whitespace-heavy active tabs and inactive drafts without changing ownership', () => {
        const tabs = [
            tab('schema', 'Schema', '\nCREATE TABLE users (id INT);\n'),
            tab('empty', 'Empty', ''),
            { ...tab('draft', 'Private draft', '\n-- private\n\nSELECT 1;\n'), isInactive: true },
            tab('seed', 'Seed', '\n\nINSERT INTO users (id) VALUES (1);\n'),
        ];
        const combined = buildCombinedSql(tabs).sql;
        const context = { [SQL_TABS_CONTEXT_KEY]: serializeSqlTabs(tabs, 'draft') };

        const hydrated = hydrateSqlTabsFromContext(combined, context);

        expect(hydrated).toEqual(tabs.map((item) => ({ ...item, isInactive: Boolean(item.isInactive) })));
        expect(getActiveSqlTabIdFromContext(context, hydrated)).toBe('draft');
        expect(buildCombinedSql(hydrated).sql).toBe(combined);
    });

    it('keeps inactive tab SQL in metadata while excluding it from the combined document', () => {
        const tabs = [tab('a', 'Core', 'CREATE TABLE users (id INT);'), { ...tab('b', 'Scratch', 'CREATE TABLE drafts (id INT);'), isInactive: true }];
        const combined = buildCombinedSql(tabs);
        const context = { [SQL_TABS_CONTEXT_KEY]: serializeSqlTabs(tabs, 'b') };
        const hydrated = hydrateSqlTabsFromContext(combined.sql, context);

        expect(combined.sql).toBe('CREATE TABLE users (id INT);');
        expect(combined.ranges[1]).toMatchObject({ id: 'b', lineCount: 0, isInactive: true });
        expect(context[SQL_TABS_CONTEXT_KEY].tabs[1]).toMatchObject({ isInactive: true, inactiveSql: 'CREATE TABLE drafts (id INT);' });
        expect(hydrated[1]).toMatchObject({ id: 'b', sql: 'CREATE TABLE drafts (id INT);', isInactive: true });
        expect(buildCombinedSql([hydrated[1]]).sql).toBe(INACTIVE_TAB_PLACEHOLDER_SQL);
    });

    it('restores all-inactive drafts from older saves with an empty combined SQL field', () => {
        const context = {
            [SQL_TABS_CONTEXT_KEY]: {
                version: 1,
                activeTabId: 'draft',
                tabs: [{ id: 'draft', title: 'Saved draft', createdAt: 1, isInactive: true, inactiveSql: 'CREATE TABLE drafts (id INT);' }],
            },
        };

        expect(hydrateSqlTabsFromContext('', context)).toEqual([
            expect.objectContaining({ id: 'draft', title: 'Saved draft', sql: 'CREATE TABLE drafts (id INT);', isInactive: true }),
        ]);
    });

    it('falls back to one tab for old files without tab metadata', () => {
        const sql = 'CREATE TABLE users (id INT);';
        const hydrated = hydrateSqlTabsFromContext(sql, null);

        expect(hydrated).toHaveLength(1);
        expect(hydrated[0].sql).toBe(sql);
    });

    it('reconciles a full-document rewrite back into one changed tab when safe', () => {
        const tabs = [tab('a', 'SQL 1', 'CREATE TABLE users (id INT);'), tab('b', 'SQL 2', 'CREATE TABLE orders (id INT);')];
        const nextSql = 'CREATE TABLE users (id INT);\n\nCREATE TABLE orders (id INT, total NUMERIC);';

        const reconciled = reconcileSqlTabsFromCombinedSql(tabs, nextSql);

        expect(reconciled).toHaveLength(2);
        expect(reconciled[0].sql).toBe('CREATE TABLE users (id INT);');
        expect(reconciled[1].sql).toBe('CREATE TABLE orders (id INT, total NUMERIC);');
        expect(buildCombinedSql(reconciled).sql).toBe(nextSql);
    });

    it('collapses to one safe tab when a full-document rewrite crosses tab boundaries', () => {
        const tabs = [tab('a', 'SQL 1', 'CREATE TABLE users (id INT);'), tab('b', 'SQL 2', 'CREATE TABLE orders (id INT);')];
        const nextSql = 'CREATE TABLE accounts (id INT);';

        const reconciled = reconcileSqlTabsFromCombinedSql(tabs, nextSql);

        expect(reconciled).toHaveLength(1);
        expect(reconciled[0].sql).toBe(nextSql);
    });

    it('preserves inactive drafts when a full-document rewrite cannot be mapped to one active tab', () => {
        const inactiveSql = 'INSERT INTO private_notes (note) VALUES (\'do not lose\');';
        const tabs = [
            tab('a', 'SQL 1', 'CREATE TABLE users (id INT);'),
            tab('b', 'SQL 2', 'CREATE TABLE orders (id INT);'),
            { ...tab('draft', 'Private draft', inactiveSql), isInactive: true },
        ];
        const nextSql = 'CREATE TABLE accounts (id INT);';

        const reconciled = reconcileSqlTabsFromCombinedSql(tabs, nextSql);

        expect(reconciled).toEqual([
            expect.objectContaining({ id: 'a', title: 'SQL 1', sql: nextSql, isInactive: false }),
            expect.objectContaining({ id: 'draft', title: 'Private draft', sql: inactiveSql, isInactive: true }),
        ]);
    });

    it('repairs duplicate saved tab ids and preserves inactive drafts when metadata is malformed', () => {
        const usersSql = 'CREATE TABLE users (id INT);';
        const ordersSql = 'CREATE TABLE orders (id INT);';
        const sourceSql = `${usersSql}\n\n${ordersSql}`;
        const duplicatedIdContext = {
            [SQL_TABS_CONTEXT_KEY]: {
                tabs: [
                    { id: 'duplicate', title: 'Users', start: 0, end: usersSql.length },
                    { id: 'duplicate', title: 'Orders', start: usersSql.length + 2, end: sourceSql.length },
                ],
            },
        };
        const malformedContext = {
            [SQL_TABS_CONTEXT_KEY]: {
                tabs: [
                    { id: 'broken', title: 'Broken', start: 'nope', end: sourceSql.length },
                    { id: 'draft', title: 'Draft', isInactive: true, inactiveSql: 'CREATE TABLE drafts (id INT);' },
                ],
            },
        };

        const repaired = hydrateSqlTabsFromContext(sourceSql, duplicatedIdContext);
        const fallback = hydrateSqlTabsFromContext(sourceSql, malformedContext);

        expect(repaired.map((item) => item.sql)).toEqual([usersSql, ordersSql]);
        expect(new Set(repaired.map((item) => item.id)).size).toBe(2);
        expect(fallback).toEqual([
            expect.objectContaining({ sql: sourceSql, isInactive: false }),
            expect.objectContaining({ id: 'draft', sql: 'CREATE TABLE drafts (id INT);', isInactive: true }),
        ]);
    });

    it('rejects overlapping saved ranges even when repeated SQL recombines to the same text', () => {
        const text = 'CREATE TABLE repeated(id INT);';
        const sql = `${text}\n\n${text}`;
        const context = { sqlTabs: { tabs: [
            { id: 'one', start: 0, end: text.length },
            { id: 'draft', isInactive: true, inactiveSql: '-- keep draft' },
            { id: 'two', start: 0, end: text.length },
        ] } };
        const result = hydrateSqlTabsFromContext(sql, context);
        expect(result.filter((item) => !item.isInactive)).toEqual([expect.objectContaining({ sql })]);
        expect(result.find((item) => item.id === 'draft').sql).toBe('-- keep draft');
    });

    it.each([[-1, 10], [0, 11]])('rejects out-of-document ranges rather than silently clamping them: %i–%i', (start, end) => {
        const sql = 'SELECT 1; ';
        const context = { sqlTabs: { tabs: [{ id: 'corrupt', start, end }] } };
        expect(hydrateSqlTabsFromContext(sql, context)[0].id).not.toBe('corrupt');
        expect(hydrateSqlTabsFromContext(sql, context)[0].sql).toBe(sql);
    });

    it('retains tab identities, empty tabs and inactive drafts for independent global edits in multiple tabs', () => {
        const tabs = [
            tab('users', 'Users', 'CREATE TABLE users (\n id INT,\n name TEXT\n);'),
            tab('empty', 'Empty', ''),
            { ...tab('private', 'Private', '-- untouched'), isInactive: true },
            tab('orders', 'Orders', 'CREATE TABLE orders (\n id INT,\n amount NUMERIC\n);'),
        ];
        const nextSql = buildCombinedSql(tabs).sql.replace('name TEXT', 'name VARCHAR(100)').replace('amount NUMERIC', 'amount NUMERIC(18, 2)');
        const result = reconcileSqlTabsFromCombinedSql(tabs, nextSql);
        expect(result.map((item) => item.id)).toEqual(['users', 'empty', 'private', 'orders']);
        expect(result[0].sql).toContain('name VARCHAR(100)');
        expect(result[3].sql).toContain('amount NUMERIC(18, 2)');
        expect(result[1]).toBe(tabs[1]);
        expect(result[2]).toBe(tabs[2]);
        expect(buildCombinedSql(result).sql).toBe(nextSql);
    });

    it('preserves exact per-tab SQL across generated independent rewrites and persistence cycles', () => {
        for (let run = 0; run < 40; run += 1) {
            const tabs = Array.from({ length: 5 }, (_, i) => tab(`id${i}`, `Tab ${i}`, `-- repeat\nCREATE TABLE t${i}(\n id INT,\n value TEXT DEFAULT 'same; value'\n);\n-- repeat`));
            tabs.splice(2, 0, tab('empty', 'Empty', ''));
            tabs.splice(4, 0, { ...tab('draft', 'Draft', '-- keep me'), isInactive: true });
            const expected = tabs.map((item, i) => !item.isInactive && item.sql && (i + run) % 2 === 0 ? { ...item, sql: item.sql.replace('id INT', 'id BIGINT').replace('value TEXT', 'value VARCHAR(50)') } : item);
            const nextSql = buildCombinedSql(expected).sql;
            const result = reconcileSqlTabsFromCombinedSql(tabs, nextSql);
            expect(result).toEqual(expected);
            const restored = hydrateSqlTabsFromContext(nextSql, { sqlTabs: serializeSqlTabs(result, 'draft') });
            expect(restored.map((item) => [item.id, item.sql, Boolean(item.isInactive)])).toEqual(expected.map((item) => [item.id, item.sql, Boolean(item.isInactive)]));
        }
    });

    it('keeps an ambiguous reordered/replaced global document lossless without inventing tab ownership', () => {
        const tabs = [tab('a', 'A', 'CREATE TABLE a(id INT);'), { ...tab('private', 'Private', '-- retained'), isInactive: true }, tab('b', 'B', 'CREATE TABLE b(id INT);')];
        const nextSql = `${tabs[2].sql}\n\n${tabs[0].sql}`;
        const result = reconcileSqlTabsFromCombinedSql(tabs, nextSql);
        expect(result.filter((item) => !item.isInactive)).toHaveLength(1);
        expect(result.find((item) => item.id === 'private').sql).toBe('-- retained');
        expect(buildCombinedSql(result).sql).toBe(nextSql);
    });

    it.each([
        "DO $$ BEGIN CREATE TABLE fake(id INT); END $$;",
        "DO $body$ BEGIN CREATE TABLE fake(id INT); END $body$;",
        '# CREATE TABLE fake(id INT);',
        '/* outer /* nested */ CREATE TABLE fake(id INT); */',
        "SELECT E'escaped\\\' CREATE TABLE fake(id INT);';",
    ])('does not assign table ownership to quoted/commented SQL: %s', (prefix) => {
        const sql = `${prefix}\nCREATE /* comment */ TABLE real(id INT);`;
        expect(findCreateTableMatchInSql(sql, 'fake')).toBeNull();
        expect(findCreateTableMatchInSql(sql, 'real')).toMatchObject({ line: 2 });
    });

    it('refuses ambiguous unqualified owners instead of choosing the first schema', () => {
        const tabs = [tab('sales', 'Sales', 'CREATE TABLE sales.users(id INT);'), tab('audit', 'Audit', 'CREATE TABLE audit.users(id INT);')];
        expect(findSqlTabTableLocation(tabs, 'users')).toBeNull();
        expect(findSqlTabTableLocation(tabs, 'audit.users')).toMatchObject({ tabId: 'audit' });
    });

    it('maps combined diagnostics to local tab lines', () => {
        const tabs = [tab('a', 'SQL 1', 'CREATE TABLE users (\nid INT\n);'), tab('b', 'SQL 2', 'CREATE TABLE orders (\nid INT\n);')];
        const diagnostics = [{ id: 'err', severity: 'error', line: 6, column: 1, message: 'Bad column' }];

        const all = mapDiagnosticsToSqlTabs(diagnostics, tabs);
        const active = mapDiagnosticsToActiveSqlTab(diagnostics, tabs, 'b');

        expect(all[0]).toMatchObject({ tabId: 'b', tabTitle: 'SQL 2', globalLine: 6, line: 2 });
        expect(active).toHaveLength(1);
        expect(active[0].line).toBe(2);
    });

    it('finds the tab that declares a table', () => {
        const tabs = [tab('a', 'SQL 1', 'CREATE TABLE users (id INT);'), tab('b', 'SQL 2', 'CREATE TABLE "Order Items" (id INT);')];

        expect(findSqlTabForTable(tabs, 'users')?.id).toBe('a');
        expect(findSqlTabForTable(tabs, 'Order Items')?.id).toBe('b');
    });

    it('identifies tabs changed since the saved snapshot', () => {
        const savedTabs = [tab('a', 'Users', 'CREATE TABLE users (id INT);'), tab('b', 'Orders', 'CREATE TABLE orders (id INT);')];
        const currentTabs = [
            tab('a', 'Users', 'CREATE TABLE users (id INT);'),
            { ...tab('b', 'Billing', 'CREATE TABLE orders (id INT);'), isInactive: true },
            tab('c', 'Draft', ''),
        ];

        expect([...getDirtySqlTabIds(currentTabs, savedTabs)]).toEqual(['b', 'c']);
    });

    it('marks tabs dirty when their persisted order changes', () => {
        const savedTabs = [tab('a', 'Users', 'CREATE TABLE users (id INT);'), tab('b', 'Orders', 'CREATE TABLE orders (id INT);')];
        const reorderedTabs = [savedTabs[1], savedTabs[0]];

        expect([...getDirtySqlTabIds(reorderedTabs, savedTabs)]).toEqual(['b', 'a']);
    });

    it('finds exact CREATE TABLE locations across SQL dialect quoting', () => {
        const sql = [
            '-- CREATE TABLE users (id INT);',
            'CREATE TABLE public.accounts (id INT);',
            '',
            'CREATE TEMP TABLE IF NOT EXISTS [sales].[Order Items] (',
            'id INT',
            ');',
            'CREATE OR REPLACE TABLE `app`.`sessions` (id INT);',
            'CREATE TABLE "audit"."Events" (id INT);',
        ].join('\n');

        expect(findCreateTableMatchInSql(sql, 'users')).toBeNull();
        expect(findCreateTableMatchInSql(sql, 'accounts')).toMatchObject({
            line: 2,
            column: 1,
            identifier: 'public.accounts',
            tableParts: ['public', 'accounts'],
        });
        expect(findCreateTableMatchInSql(sql, 'sales.Order Items')).toMatchObject({
            line: 4,
            column: 1,
            identifier: '[sales].[Order Items]',
            tableParts: ['sales', 'Order Items'],
        });
        expect(findCreateTableMatchInSql(sql, 'sessions')).toMatchObject({
            line: 7,
            identifier: '`app`.`sessions`',
            tableParts: ['app', 'sessions'],
        });
        expect(findCreateTableMatchInSql(sql, 'audit.Events')).toMatchObject({
            line: 8,
            identifier: '"audit"."Events"',
            tableParts: ['audit', 'Events'],
        });
        expect(findCreateTableMatchInSql('CREATE TABLE users (id INT);', 'public.users')).toMatchObject({
            line: 1,
            identifier: 'users',
            tableParts: ['users'],
        });
        expect(findCreateTableMatchInSql('CREATE TABLE custom.users (id INT);', 'public.users')).toBeNull();
        expect(findCreateTableMatchInSql('CREATE TABLE mydb.public.users (id INT);', 'public.users')).toBeNull();
        expect(findCreateTableMatchInSql('CREATE TABLE "tenant.users" (id INT);', '"tenant.users"')).toMatchObject({
            identifier: '"tenant.users"',
            tableParts: ['tenant.users'],
        });
        expect(findCreateTableMatchInSql('CREATE TABLE tenant.users (id INT);', '"tenant.users"')).toBeNull();
    });

    it('returns the matched tab and local line for ERD table jumps', () => {
        const tabs = [
            tab('a', 'Core', 'CREATE TABLE users (id INT);'),
            { ...tab('b', 'Inactive billing', ['-- generated by importer', 'CREATE TEMP TABLE IF NOT EXISTS [sales].[Order Items] (', 'id INT', ');'].join('\n')), isInactive: true },
            tab('c', 'Billing', ['-- generated by importer', 'CREATE TEMP TABLE IF NOT EXISTS [sales].[Order Items] (', 'id INT', ');'].join('\n')),
        ];

        expect(findSqlTabTableLocation(tabs, 'Order Items')).toMatchObject({
            tabId: 'c',
            line: 2,
            column: 1,
            match: {
                identifier: '[sales].[Order Items]',
                tableName: 'Order Items',
            },
        });
    });

    it('routes table jumps with schema-aware defaults and quoted dotted identifiers', () => {
        const tabs = [
            tab('ops', 'Operations', 'CREATE TABLE operations.users (id INT);'),
            tab('literal', 'Literal tenant', 'CREATE TABLE "tenant.users" (id INT);'),
            tab('schema', 'Tenant schema', 'CREATE TABLE tenant.users (id INT);'),
        ];

        // Both operations.users and tenant.users expose that leaf name.
        expect(findSqlTabTableLocation(tabs, 'users')).toBeNull();
        expect(findSqlTabTableLocation(tabs, '"tenant.users"')).toMatchObject({
            tabId: 'literal',
            match: {
                identifier: '"tenant.users"',
                tableParts: ['tenant.users'],
            },
        });
        expect(findSqlTabTableLocation(tabs, 'tenant.users')).toMatchObject({
            tabId: 'schema',
            match: {
                identifier: 'tenant.users',
                tableParts: ['tenant', 'users'],
            },
        });
    });

    it('prefers exact-case PostgreSQL table ownership across tabs', () => {
        const tabs = [
            tab('quoted', 'Quoted users', 'CREATE TABLE "Users" (id BIGSERIAL PRIMARY KEY);'),
            tab('folded', 'Folded users', 'CREATE TABLE users (id BIGSERIAL PRIMARY KEY);'),
        ];

        expect(findSqlTabTableLocation(tabs, 'users')).toMatchObject({
            tabId: 'folded',
            match: { identifier: 'users' },
        });
        expect(findSqlTabTableLocation(tabs, 'Users')).toMatchObject({
            tabId: 'quoted',
            match: { identifier: '"Users"' },
        });
    });

    it('binds renamed and recreated tables to the surviving CREATE tab', () => {
        const tabs = [
            tab('original', 'Original', '-- origin\nCREATE TABLE items(id INT);'),
            tab('migration', 'Migration', 'ALTER TABLE items RENAME TO archived_items;'),
            tab('replacement', 'Replacement', 'CREATE TABLE items(id INT);'),
        ];
        expect(findSqlTabTableLocation(tabs, 'items')).toMatchObject({ tabId: 'replacement', line: 1 });
        expect(findSqlTabTableLocation(tabs, 'archived_items')).toMatchObject({ tabId: 'original', line: 2, match: { identifier: 'items' } });
        tabs.push(tab('drop', 'Drop', 'DROP TABLE archived_items;'));
        expect(findSqlTabTableLocation(tabs, 'archived_items')).toBeNull();
    });

    it.each([
        ['CREATE TABLE accounts(id BIGSERIAL);', 'public.accounts'],
        ['CREATE TABLE [accounts](id INT IDENTITY(1,1));', 'dbo.accounts'],
        ['PRAGMA foreign_keys=ON; CREATE TABLE accounts(id INTEGER PRIMARY KEY);', 'main.accounts'],
        ['CREATE TABLE `app`.`accounts`(id INT AUTO_INCREMENT PRIMARY KEY);', 'app.accounts'],
    ])('resolves dialect-aware default/schema-qualified owners: %s', (sql, name) => {
        expect(findSqlTabTableLocation([tab('owner', 'Owner', sql)], name)).toMatchObject({ tabId: 'owner' });
    });
});
