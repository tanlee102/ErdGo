// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeContext } from '@/contexts/ThemeContext';
import MonacoEditorWrapper from '@/features/editor/components/MonacoEditorWrapper';

vi.mock('@monaco-editor/react', () => ({
    default: ({ theme, options }) => <div data-testid="monaco" data-theme={theme} data-option-theme={options.theme || ''} />,
}));

afterEach(cleanup);

function renderEditor(theme) {
    return render(
        <ThemeContext.Provider value={{ theme }}>
            <MonacoEditorWrapper
                sqlInput="SELECT 1;"
                setSqlInput={() => {}}
                setIsEditorReady={() => {}}
                showAiSuggestions={false}
                currentlyProcessingAi={false}
                parseErrors={[]}
            />
        </ThemeContext.Provider>,
    );
}

describe('Monaco editor theme', () => {
    it('uses the reactive Monaco theme prop across editor remounts', () => {
        const firstMount = renderEditor('dark');
        expect(screen.getByTestId('monaco').getAttribute('data-theme')).toBe('vs-dark');
        expect(screen.getByTestId('monaco').getAttribute('data-option-theme')).toBe('');
        firstMount.unmount();

        renderEditor('dark');
        expect(screen.getByTestId('monaco').getAttribute('data-theme')).toBe('vs-dark');
    });

    it('keeps the light theme mapping', () => {
        renderEditor('light');
        expect(screen.getByTestId('monaco').getAttribute('data-theme')).toBe('vs');
    });
});
