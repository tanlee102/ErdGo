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

test('homepage exposes every local tool and saved documents on desktop and mobile', async ({ page }) => {
    await seed(page);
    await page.goto('/');
    for (const name of ['Prisma to ERD', 'ERD Builder', 'Spreadsheet to SQL', 'Legacy diagram']) await expect(page.getByRole('link', { name: new RegExp(name) }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(page.locator('html')).toHaveClass(/dark-theme/);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('link', { name: 'Tool guides', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Tool guides', exact: true })).toBeVisible();
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

test('Prisma saves and reopens source and diagram without a service request', async ({ page }) => {
    const serviceRequests = [];
    page.on('request', request => { if (/firebase|google-analytics|\/api\//i.test(request.url())) serviceRequests.push(request.url()); });
    await page.goto('/prisma-to-erd/new');
    await page.getByRole('button', { name: /Create with Prisma Sample/ }).click();
    await expect(page.locator('.monaco-editor').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add Table', exact: true })).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Prisma ERD local file name' }).fill('Local Prisma');
    await page.getByRole('button', { name: 'Save Prisma ERD locally' }).click();
    await expect(page).toHaveURL(/\/prisma-to-erd\/(?!new)[^/]+$/);
    const documents = await readDocuments(page);
    expect(documents[0]).toMatchObject({ name: 'Local Prisma', kind: 'prisma-erd', payload: { schemaVersion: 1 } });
    expect(documents[0].payload.source).toContain('model User');
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Prisma ERD local file name' })).toHaveValue('Local Prisma');
    await expect(page.getByRole('status', { name: 'Opening Prisma ERD file' })).toHaveCount(0);
    await expect(page.locator('.monaco-editor').first()).toBeVisible();
    expect(serviceRequests).toEqual([]);
});

test('Builder saves graph edits, reloads, and transfers reviewed SQL to a new editor', async ({ page }) => {
    await page.goto('/erd-builder/new');
    await page.getByRole('button', { name: /Create Empty ERD/ }).click();
    await page.getByRole('button', { name: 'Add Entity', exact: true }).click();
    await page.getByRole('textbox', { name: 'Diagram name' }).fill('Local Builder');
    await page.getByRole('button', { name: 'Save ERD Builder file locally' }).click();
    await expect(page).toHaveURL(/\/erd-builder\/(?!new)[^/]+$/);
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Diagram name' })).toHaveValue('Local Builder');
    await expect(page.getByRole('status', { name: 'Opening ERD Builder file' })).toHaveCount(0);
    const documents = await readDocuments(page);
    expect(documents[0]).toMatchObject({ name: 'Local Builder', kind: 'erd-builder' });
    expect(documents[0].payload.nodes).toHaveLength(1);
    await page.getByRole('button', { name: 'Convert ERD to SQL', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('SQL');
    const reviewed = page.getByRole('checkbox', { name: 'I have reviewed the assumptions and constraints above.' });
    if (await reviewed.isVisible()) await reviewed.check();
    await page.getByRole('button', { name: 'Open in SQL to ERD', exact: true }).click();
    await expect(page).toHaveURL('/e/new');
    await expect(page.locator('.monaco-editor').first()).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Create New File' })).toHaveCount(0);
});

test('spreadsheet import produces SQL and downloads in the browser', async ({ page }) => {
    await page.goto('/spreadsheet-to-sql');
    await page.locator('input[type="file"]').setInputFiles({ name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from('id,name\n1,Ada\n2,Grace\n') });
    await expect(page.locator('.monaco-editor')).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/\.sql$/);
});

test('local file list opens typed documents and wrong-tool routes cannot overwrite them', async ({ page }) => {
    await seed(page, [legacy, { id: 'prisma', kind: 'prisma-erd', name: 'Saved Prisma', payload: { schemaVersion: 1, source: 'model User {\n id Int @id\n}', rendererContext: {} } }]);
    await page.goto('/e/legacy');
    await expect(page.locator('.monaco-editor').first()).toBeVisible();
    await page.getByRole('button', { name: 'Open local diagrams' }).click();
    await page.getByRole('button', { name: /^Saved Prisma Prisma to ERD/ }).click();
    await expect(page).toHaveURL('/prisma-to-erd/prisma');
    await expect(page.getByRole('textbox', { name: 'Prisma ERD local file name' })).toHaveValue('Saved Prisma');
    await page.goto('/e/prisma');
    await expect(page.locator('.sql-panel')).toContainText('different ERD tool');
    await expect(page.getByTitle('Update SQL and ERD')).toHaveCount(0);
    expect((await readDocuments(page)).find(document => document.id === 'prisma').kind).toBe('prisma-erd');
});
