/** Global toast queue with typed helpers, bounded visibility, timers, and accessible dismissal. */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import './index.css';

const DEFAULT_DURATION = 5200;
const MAX_VISIBLE_NOTIFICATIONS = 5;

const NotificationContext = createContext({
    notify: () => null,
    notifyError: () => null,
    notifySuccess: () => null,
    notifyWarning: () => null,
    notifyInfo: () => null,
    dismissNotification: () => {},
});

function normalizeMessage(message) {
    if (message instanceof Error) return message.message;
    if (message === null || message === undefined) return 'Something went wrong';
    return String(message);
}

function getNotificationTitle(type, title) {
    if (title) return title;

    switch (type) {
        case 'success':
            return 'Done';
        case 'warning':
            return 'Check this';
        case 'error':
            return 'Something went wrong';
        case 'info':
        default:
            return 'Heads up';
    }
}

function NotificationItem({ item, onDismiss }) {
    useEffect(() => {
        if (!item.duration || item.duration <= 0) return undefined;
        const timer = window.setTimeout(() => onDismiss(item.id), item.duration);
        return () => window.clearTimeout(timer);
    }, [item.duration, item.id, onDismiss]);

    return (
        <div className={`app-toast app-toast--${item.type}`} role={item.type === 'error' ? 'alert' : 'status'} aria-live={item.type === 'error' ? 'assertive' : 'polite'}>
            <div className="app-toast__stripe" aria-hidden="true" />
            <div className="app-toast__content">
                <div className="app-toast__title">{item.title}</div>
                <div className="app-toast__message">{item.message}</div>
            </div>
            <button type="button" className="app-toast__close" onClick={() => onDismiss(item.id)} aria-label="Dismiss notification">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                </svg>
            </button>
        </div>
    );
}

export function NotificationProvider({ children }) {
    const [items, setItems] = useState([]);
    const idRef = useRef(0);

    const dismissNotification = useCallback((id) => {
        setItems((current) => current.filter((item) => item.id !== id));
    }, []);

    // A generated id is both the React key and the stable handle returned for dismissal.
    const notify = useCallback(({ type = 'info', title, message, duration = DEFAULT_DURATION } = {}) => {
        const id = `toast-${Date.now()}-${idRef.current++}`;
        const nextItem = {
            id,
            type,
            title: getNotificationTitle(type, title),
            message: normalizeMessage(message),
            duration,
        };

        setItems((current) => [...current, nextItem].slice(-MAX_VISIBLE_NOTIFICATIONS));
        return id;
    }, []);

    const notifyError = useCallback((message, options = {}) => notify({ type: 'error', title: options.title, message, duration: options.duration ?? DEFAULT_DURATION }), [notify]);
    const notifySuccess = useCallback((message, options = {}) => notify({ type: 'success', title: options.title, message, duration: options.duration ?? DEFAULT_DURATION }), [notify]);
    const notifyWarning = useCallback((message, options = {}) => notify({ type: 'warning', title: options.title, message, duration: options.duration ?? DEFAULT_DURATION }), [notify]);
    const notifyInfo = useCallback((message, options = {}) => notify({ type: 'info', title: options.title, message, duration: options.duration ?? DEFAULT_DURATION }), [notify]);

    const value = useMemo(
        () => ({
            notify,
            notifyError,
            notifySuccess,
            notifyWarning,
            notifyInfo,
            dismissNotification,
        }),
        [dismissNotification, notify, notifyError, notifyInfo, notifySuccess, notifyWarning],
    );

    return (
        <NotificationContext.Provider value={value}>
            {children}
            <div className="app-toast-region" role="region" aria-label="Notifications">
                {items.map((item) => (
                    <NotificationItem key={item.id} item={item} onDismiss={dismissNotification} />
                ))}
            </div>
        </NotificationContext.Provider>
    );
}

export function useNotifications() {
    return useContext(NotificationContext);
}
