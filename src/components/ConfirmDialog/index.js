/** Promise-based global confirmation service used by destructive and unsaved-change flows. */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import './index.css';

const ConfirmContext = createContext({
    confirm: async () => false,
});

function getDefaultTitle(tone) {
    if (tone === 'danger') return 'Are you sure?';
    return 'Please confirm';
}

export function ConfirmProvider({ children }) {
    const [request, setRequest] = useState(null);
    const resolverRef = useRef(null);
    const confirmButtonRef = useRef(null);

    const close = useCallback((value) => {
        const resolver = resolverRef.current;
        resolverRef.current = null;
        setRequest(null);
        if (resolver) resolver(value);
    }, []);

    // Keep the resolver outside React state so callers can await one boolean result.
    const confirm = useCallback((options = {}) => {
        return new Promise((resolve) => {
            resolverRef.current?.(false);
            resolverRef.current = resolve;
            setRequest({
                title: options.title || getDefaultTitle(options.tone),
                message: options.message || '',
                confirmText: options.confirmText || 'Confirm',
                cancelText: options.cancelText || 'Cancel',
                tone: options.tone || 'default',
            });
        });
    }, []);

    useEffect(() => {
        if (!request) return undefined;

        const focusTimer = window.setTimeout(() => {
            confirmButtonRef.current?.focus();
        }, 0);

        const handleKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                close(false);
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => {
            window.clearTimeout(focusTimer);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [close, request]);

    const value = useMemo(() => ({ confirm }), [confirm]);

    return (
        <ConfirmContext.Provider value={value}>
            {children}
            {request && (
                <div className="app-confirm-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close(false)}>
                    <section className="app-confirm" role="dialog" aria-modal="true" aria-labelledby="app-confirm-title" aria-describedby="app-confirm-message">
                        <header className="app-confirm__header">
                            <h3 id="app-confirm-title">{request.title}</h3>
                            <button type="button" className="app-confirm__close" onClick={() => close(false)} aria-label="Close confirmation">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M18 6 6 18" />
                                    <path d="m6 6 12 12" />
                                </svg>
                            </button>
                        </header>
                        <div className="app-confirm__body">
                            <p id="app-confirm-message">{request.message}</p>
                        </div>
                        <footer className="app-confirm__footer">
                            <button type="button" className="app-confirm__btn app-confirm__btn--secondary" onClick={() => close(false)}>
                                {request.cancelText}
                            </button>
                            <button ref={confirmButtonRef} type="button" className={`app-confirm__btn app-confirm__btn--primary app-confirm__btn--${request.tone}`} onClick={() => close(true)}>
                                {request.confirmText}
                            </button>
                        </footer>
                    </section>
                </div>
            )}
        </ConfirmContext.Provider>
    );
}

export function useConfirm() {
    return useContext(ConfirmContext);
}
