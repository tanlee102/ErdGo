import { expect, test } from '@playwright/test';

const KEY = 'erdgo:documents:v1';
const SQL = "CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT);\nCREATE TABLE audit(id INTEGER PRIMARY KEY);\nINSERT INTO users VALUES (1, 'Ada'), (2, 'Grace');";
const legacy = { id: 'legacy', name: 'Legacy diagram', sql: SQL, context: { tablePositions: { users: { x: 40, y: 60 }, audit: { x: 380, y: 60 } }, zoom: 1, offsetX: 0, offsetY: 0, selectedNodeName: 'audit', queryView: { query: 'SELECT name FROM users ORDER BY id;' } }, createdAt: '2026-01-01', updatedAt: '2026-02-01' };

async function seed(page, documents = [legacy]) {
    await page.addInitScript(({ key, documents }) => {
        if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ version: 1, documents }));
    }, { key: KEY, documents });
}

async function readDocuments(page) {
    return page.evaluate(key => JSON.parse(localStorage.getItem(key)).documents, KEY);
}

test('homepage exposes SQL editing and saved diagrams on desktop and mobile', async ({ page }) => {
    await seed(page);
    await page.goto('/');
    for (const name of ['Open Editor', 'Legacy diagram']) await expect(page.getByRole('link', { name: new RegExp(name) }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(page.locator('html')).toHaveClass(/dark-theme/);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('link', { name: 'SQL guide', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'SQL to ERD', level: 1 })).toBeVisible();
});

test('table groups save display metadata without changing SQL', async ({ page }) => {
    await seed(page);
    await page.goto('/e/legacy');
    await page.getByRole('button', { name: 'Table groups', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Table groups', exact: true });
    await dialog.getByRole('button', { name: 'New group', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Group name', exact: true }).fill('Core tables');
    await dialog.getByRole('checkbox', { name: 'Include users', exact: true }).check();
    await dialog.getByRole('checkbox', { name: 'Include audit', exact: true }).check();
    await dialog.getByRole('button', { name: 'Create group', exact: true }).click();
    await dialog.getByRole('button', { name: 'Close table groups' }).click();
    await page.getByTitle('Update SQL and ERD').click();
    await expect.poll(async () => (await readDocuments(page))[0].context.tableGroups?.[0]?.name).toBe('Core tables');
    expect((await readDocuments(page))[0].sql).toBe(SQL);
    await page.reload();
    await page.getByRole('button', { name: 'Table groups', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Table groups', exact: true })).toContainText('Core tables');
});

test('local sample generation previews and inserts into a new tab', async ({ page }) => {
    await seed(page);
    await page.goto('/e/legacy');
    await page.getByRole('button', { name: 'Data', exact: true }).click();
    await page.getByRole('button', { name: 'Generate sample data', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Generate sample data', exact: true });
    await dialog.getByRole('spinbutton', { name: 'Rows for all tables', exact: true }).fill('3');
    await dialog.getByRole('button', { name: 'Generate preview', exact: true }).click();
    await expect(dialog.getByRole('table', { name: 'Generated sample rows' })).toBeVisible();
    await expect(dialog).toContainText('6 rows ready');
    await dialog.getByRole('button', { name: 'Insert into SQL tab', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /Sample Data/ })).toBeVisible();
    await page.getByTitle('Update SQL and ERD').click();
    await expect.poll(async () => (await readDocuments(page))[0].sql).toContain('INSERT INTO');
    await expect.poll(async () => (await readDocuments(page))[0].context.sqlTabs.tabs.length).toBe(2);
});

test('source and canvas work before local Monaco loads and retry preserves edits', async ({ page }) => {
    await seed(page);
    const externalRequests = [];
    page.on('request', request => { if (new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url()); });
    const runtime = /\/(?:monacoRuntime|vendor-monaco)[^/]*\.js(?:\?|$)/;
    await page.route(runtime, route => route.abort());
    await page.goto('/e/legacy');
    const source = page.locator('textarea.code-editor-source').first();
    await expect(source).toHaveValue(SQL);
    await expect(page.getByRole('button', { name: 'Add column to audit', exact: true })).toBeVisible();
    const edited = 'CREATE TABLE recovered(id INTEGER PRIMARY KEY, label TEXT);';
    await source.fill(edited);
    await expect(page.locator('.schema-stat--tables')).toHaveAttribute('aria-label', 'Tables: 1');
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await page.unroute(runtime);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.locator('.monaco-editor').first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.monaco?.editor.getModels().some(model => model.getValue().includes('CREATE TABLE recovered')))).toBe(true);
    expect(externalRequests).toEqual([]);
});

test('SQL-only lists preserve legacy non-SQL records without exposing or overwriting them', async ({ page }) => {
    const hidden = { id: 'old-tool', name: 'Legacy other tool', kind: 'erd-builder', sql: '', context: {}, payload: { nodes: [{ id: 'keep' }], edges: [] }, createdAt: null, updatedAt: null };
    await seed(page, [legacy, hidden]);
    await page.goto('/');
    await expect(page.getByRole('link', { name: /Legacy other tool/ })).toHaveCount(0);
    for (const path of ['/prisma-to-erd/new', '/erd-builder/new', '/spreadsheet-to-sql', '/class-diagram/new', '/sequence-diagram/new']) {
        await page.goto(path);
        await expect(page).toHaveURL('/');
    }
    await page.goto('/e/legacy');
    await page.getByRole('button', { name: 'Open local diagrams' }).click();
    await expect(page.getByRole('dialog', { name: 'Local diagrams' })).not.toContainText('Legacy other tool');
    await page.getByRole('button', { name: 'Close local diagrams' }).click();
    await page.getByRole('textbox', { name: 'File name', exact: true }).fill('Updated SQL');
    await page.getByTitle('Update SQL and ERD').click();
    await expect.poll(async () => (await readDocuments(page)).find(document => document.id === 'legacy').name).toBe('Updated SQL');
    expect((await readDocuments(page)).find(document => document.id === hidden.id)).toEqual(hidden);
    await page.goto('/e/old-tool');
    await expect(page.locator('.sql-panel')).toContainText('different ERD tool');
    await expect(page.getByTitle('Update SQL and ERD')).toHaveCount(0);
});

test('New SQL file resets an unsaved new document within the same route', async ({ page }) => {
    await page.goto('/e/new');
    await page.getByRole('button', { name: /Create with Sample/ }).click();
    await page.getByRole('textbox', { name: 'File name', exact: true }).fill('Unsaved sample');
    await page.getByRole('button', { name: 'New SQL file', exact: true }).click();
    await page.getByRole('button', { name: 'Leave page', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Create New File', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Create Blank File/ }).click();
    await expect(page.getByRole('textbox', { name: 'File name', exact: true })).not.toHaveValue('Unsaved sample');
    await expect(page.getByRole('tab', { name: 'Schema', exact: true })).toBeVisible();
});

test('legacy SQL reloads, canvas edits save locally, and Data/Query work across view switches', async ({ page }) => {
    await seed(page);
    await page.goto('/e/legacy');
    await expect(page.locator('.monaco-editor').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add column to audit', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add column to audit', exact: true }).click();
    const form = page.getByRole('form', { name: 'Add column' });
    await form.getByRole('textbox', { name: 'Column name', exact: true }).fill('status');
    await form.getByRole('textbox', { name: 'Column type and options' }).fill('TEXT');
    await form.getByRole('button', { name: 'Add column', exact: true }).click();
    await page.getByTitle('Update SQL and ERD').click();
    await expect.poll(async () => (await readDocuments(page))[0].sql).toMatch(/"?status"? TEXT/);
    await page.reload();
    await expect(page.locator('.monaco-editor').first()).toBeVisible();
    await page.getByRole('button', { name: 'Data', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open table users' })).toBeVisible();
    await expect(page.locator('.erd-data-view')).toContainText('Ada');
    await page.getByRole('button', { name: 'Query', exact: true }).click();
    await page.getByTitle('Run query', { exact: true }).click();
    await expect(page.getByRole('table', { name: 'Query result table' })).toContainText('Grace');
    await page.getByRole('button', { name: 'ERD', exact: true }).click();
    await page.getByRole('button', { name: 'Query', exact: true }).click();
    await expect(page.getByRole('table', { name: 'Query result table' })).toContainText('Ada');
    await page.getByRole('button', { name: 'Data', exact: true }).click();
    await expect(page.locator('.erd-data-view')).toContainText('Grace');
    await page.getByRole('button', { name: 'ERD', exact: true }).click();
    await page.getByRole('button', { name: 'Export ERD', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download PNG', exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/\.png$/);
});
