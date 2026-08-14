import React, { createContext, useEffect, useState, useCallback } from 'react';

// Create the context for the theme
export const ThemeContext = createContext();

// Helper to apply theme class to document
const applyThemeClass = (theme, withTransition = false) => {
    const themeClass = theme === 'dark' ? 'dark-theme' : 'light-theme';

    if (withTransition) {
        // Add transition class for smooth theme change
        document.documentElement.classList.add('theme-transition');
        document.documentElement.className = `${themeClass} theme-transition`;

        // Remove transition class after animation completes
        setTimeout(() => {
            document.documentElement.classList.remove('theme-transition');
        }, 300);
    } else {
        document.documentElement.className = themeClass;
    }

    // Also update meta theme-color for mobile browsers
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
        metaThemeColor.setAttribute('content', theme === 'dark' ? '#0a0a0f' : '#667eea');
    }
};

/**
 * ThemeProvider - Handles theme state and persistence
 *
 * Reads theme directly from cookie on mount (no SSR, no prop needed)
 */
const ThemeProvider = ({ children }) => {
    // Reuse the theme resolved by index.html so React never reverses the first paint.
    const [theme, setThemeState] = useState(() => {
        if (typeof window !== 'undefined') {
            let savedTheme = null;
            try {
                savedTheme = window.localStorage.getItem('erdgo:theme');
            } catch {
                // Storage can be unavailable in privacy modes; use the document theme.
            }
            if (savedTheme === 'dark' || savedTheme === 'light') {
                return savedTheme;
            }
            if (document.documentElement.classList.contains('dark-theme')) {
                return 'dark';
            }
        }
        return 'light';
    });
    const isFirstMount = React.useRef(true);

    // Apply theme class on mount and whenever theme changes
    useEffect(() => {
        applyThemeClass(theme, !isFirstMount.current);
        isFirstMount.current = false;
    }, [theme]);

    const toggleTheme = useCallback(() => {
        const newTheme = theme === 'light' ? 'dark' : 'light';
        setThemeState(newTheme);
        try {
            window.localStorage.setItem('erdgo:theme', newTheme);
        } catch {
            // Theme still applies for this session when persistence is unavailable.
        }
    }, [theme]);

    // Provide setTheme directly for programmatic theme changes
    const setTheme = useCallback((newTheme) => {
        if (newTheme === 'dark' || newTheme === 'light') {
            setThemeState(newTheme);
            try {
                window.localStorage.setItem('erdgo:theme', newTheme);
            } catch {
                // Theme still applies for this session when persistence is unavailable.
            }
        }
    }, []);

    const value = {
        theme,
        toggleTheme,
        setTheme,
        isDark: theme === 'dark',
        isLight: theme === 'light',
    };

    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export default ThemeProvider;
