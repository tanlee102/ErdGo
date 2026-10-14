/** Verifies Prisma Monaco language registration and completion configuration. */
import { describe, expect, it, vi } from 'vitest';
import { configurePrismaMonaco, PRISMA_DARK_THEME, PRISMA_LIGHT_THEME } from '@/features/prisma-erd/lib/prismaMonaco.js';

describe('Prisma Monaco configuration', () => {
    it('registers the language, tokenizer, and both production themes', () => {
        const register = vi.fn();
        const setLanguageConfiguration = vi.fn();
        const setMonarchTokensProvider = vi.fn();
        const defineTheme = vi.fn();
        const monaco = {
            languages: {
                getLanguages: () => [],
                register,
                setLanguageConfiguration,
                setMonarchTokensProvider,
            },
            editor: { defineTheme },
        };

        configurePrismaMonaco(monaco);

        expect(register).toHaveBeenCalledWith({ id: 'prisma' });
        expect(setLanguageConfiguration).toHaveBeenCalledWith('prisma', expect.any(Object));
        expect(setMonarchTokensProvider).toHaveBeenCalledWith(
            'prisma',
            expect.objectContaining({
                tokenPostfix: '.prisma',
                tokenizer: expect.objectContaining({ root: expect.any(Array) }),
            }),
        );
        expect(defineTheme).toHaveBeenCalledWith(PRISMA_LIGHT_THEME, expect.objectContaining({ base: 'vs' }));
        expect(defineTheme).toHaveBeenCalledWith(PRISMA_DARK_THEME, expect.objectContaining({ base: 'vs-dark' }));

        const lightTheme = defineTheme.mock.calls.find(([name]) => name === PRISMA_LIGHT_THEME)?.[1];
        const darkTheme = defineTheme.mock.calls.find(([name]) => name === PRISMA_DARK_THEME)?.[1];
        const tokenizer = setMonarchTokensProvider.mock.calls[0][1];
        const rootPatterns = tokenizer.tokenizer.root.map(([pattern]) => pattern.toString()).join('\n');
        const languageConfiguration = setLanguageConfiguration.mock.calls[0][1];

        expect(languageConfiguration.comments).toEqual({
            lineComment: '//',
            blockComment: ['/*', '*/'],
        });
        expect(rootPatterns).toContain('directUrl');
        expect(rootPatterns).toContain('onDelete');
        expect(rootPatterns).toContain('SetDefault');
        expect(rootPatterns).toContain('Brin');
        expect(rootPatterns).toContain('nanoid');
        expect(rootPatterns).toContain('raw');
        expect(rootPatterns).toContain('where');
        expect(rootPatterns).toContain('generatedFileExtension');
        expect(lightTheme.rules).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ token: 'keyword.prisma', foreground: '0550AE' }),
                expect.objectContaining({ token: 'type.declaration.prisma', foreground: '087F8C' }),
                expect.objectContaining({ token: 'string.prisma', foreground: 'A65320' }),
                expect.objectContaining({ token: 'comment.prisma', foreground: '5A7D4E' }),
                expect.objectContaining({ token: 'constant.relation.prisma', foreground: '0550AE' }),
                expect.objectContaining({ token: 'constant.index.prisma', foreground: '067A63' }),
            ]),
        );
        expect(lightTheme.colors['editor.background']).toBe('#FBFCFE');
        expect(darkTheme.rules).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ token: 'keyword.prisma', foreground: '569CD6' }),
                expect.objectContaining({ token: 'annotation.prisma', foreground: 'DCDCAA' }),
                expect.objectContaining({ token: 'string.prisma', foreground: 'CE9178' }),
                expect.objectContaining({ token: 'constant.relation.prisma', foreground: '569CD6' }),
            ]),
        );
        expect(darkTheme.rules.some((rule) => rule.foreground === 'C586C0')).toBe(false);
    });
});
