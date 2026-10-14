/** Shared React Testing Library render wrappers, providers, and DOM helpers. */
import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { RootLayoutContext } from '@/contexts/RootLayoutContext';
import { ThemeContext } from '@/contexts/ThemeContext';
import { ConfirmProvider } from '@/components/ConfirmDialog';
import { NavigationGuardProvider } from '@/components/NavigationGuard';
import { NotificationProvider } from '@/components/Notifications';

export function createLayoutValue(overrides = {}) {
    return {
        sqlInput: '',
        setSqlInput: vi.fn(),
        setDisplayModalListFile: vi.fn(),
        setDisplayModalAddTable: vi.fn(),
        openTypedFileList: vi.fn(),
        ...overrides,
    };
}

export function createThemeValue(overrides = {}) {
    return {
        theme: 'light',
        isLight: true,
        isDark: false,
        toggleTheme: vi.fn(),
        setTheme: vi.fn(),
        ...overrides,
    };
}

export function renderWithProviders(ui, options = {}) {
    const {
        route = '/',
        layout = {},
        theme = {},
    } = options;
    const layoutValue = createLayoutValue(layout);
    const themeValue = createThemeValue(theme);

    const Providers = ({ children }) => (
        <MemoryRouter initialEntries={[route]}>
            <ThemeContext.Provider value={themeValue}>
                <NotificationProvider>
                    <ConfirmProvider>
                        <NavigationGuardProvider>
                            <RootLayoutContext.Provider value={layoutValue}>
                                {children}
                            </RootLayoutContext.Provider>
                        </NavigationGuardProvider>
                    </ConfirmProvider>
                </NotificationProvider>
            </ThemeContext.Provider>
        </MemoryRouter>
    );

    const view = render(ui, {
        wrapper: Providers,
    });

    return {
        ...view,
        layoutValue,
        themeValue,
    };
}

export function createMockFile(name, contents = 'id,name\n1,Ada', type = 'text/csv') {
    return new File([contents], name, { type });
}
