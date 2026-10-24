import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readSource(path) {
    return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('public repository application boundary', () => {
    it('exposes only the SQL editor, homepage, and SQL guide', () => {
        const app = readSource('src/App.jsx');
        expect(app).toContain('path="/"');
        expect(app).toContain('path="/e/:index"');
        expect(app).toContain('HomePage');
        expect(app).not.toMatch(/Admin|AuthAction|PostsPage|PrivacyPolicyPage|Prisma|ErdDraft|Spreadsheet|UmlClass|Sequence/);
    });

    it('keeps account, share, and file API dependencies out of the editor shell', () => {
        const sources = [
            readSource('src/App.jsx'),
            readSource('src/contexts/RootLayoutContext.js'),
            readSource('src/features/editor/hooks/useErdData.js'),
            readSource('src/features/editor/hooks/useSaveLogic.js'),
            readSource('src/features/editor/components/SqlHeader.js'),
        ].join('\n');
        expect(sources).not.toMatch(/firebase|RootClientContext|myUser|@\/api\/file|SharePopup|access_token/);
        expect(sources).toContain('localFileStore');
    });
});
