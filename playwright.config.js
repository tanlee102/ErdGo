import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT || 4173);
export default defineConfig({
    testDir: './tests/e2e',
    testMatch: '**/*.e2e.js',
    timeout: 45_000,
    expect: { timeout: 10_000 },
    workers: 2,
    reporter: 'list',
    outputDir: 'test-results/playwright',
    use: { baseURL: `http://127.0.0.1:${port}`, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) } }],
    webServer: { command: `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 30_000 },
});
