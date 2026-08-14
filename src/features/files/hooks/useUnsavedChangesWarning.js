import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useNavigationGuard } from '@/components/NavigationGuard';

const UNSAVED_CHANGES_CONFIRM = {
    title: 'Unsaved changes',
    message: 'You have unsaved changes. Are you sure you want to leave this page?',
    confirmText: 'Leave page',
    tone: 'danger',
};

/**
 * Protects a persisted workspace while its current snapshot is unsaved.
 * Covers browser reload/close, internal links, and browser back/forward.
 *
 * @param {boolean} hasUnsavedChanges - Whether the workspace differs from its saved snapshot.
 * @param {boolean} canPersist - Whether the current workspace can be persisted.
 */
export function useUnsavedChangesWarning(hasUnsavedChanges, canPersist = true) {
    const shouldBlock = hasUnsavedChanges && canPersist;
    const navigate = useNavigate();
    const { confirmNavigation, registerNavigationBlocker } = useNavigationGuard();
    const location = useLocation();
    const skipNextPopRef = useRef(false);

    // Read the latest dirty state when navigation happens instead of capturing stale render state.
    const shouldBlockRef = useRef(shouldBlock);
    useEffect(() => {
        shouldBlockRef.current = shouldBlock;
    }, [shouldBlock]);

    useEffect(() => {
        return registerNavigationBlocker({
            shouldBlock: () => shouldBlockRef.current,
            confirmOptions: UNSAVED_CHANGES_CONFIRM,
        });
    }, [registerNavigationBlocker]);

    // Block same-origin links without replacing React Router's navigator.
    useEffect(() => {
        const handleDocumentClick = (event) => {
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;

            const target = event.target instanceof Element ? event.target : null;
            const anchor = target?.closest('a[href]');
            if (!anchor || anchor.hasAttribute('download')) return;

            const targetWindow = anchor.getAttribute('target');
            if (targetWindow && targetWindow.toLowerCase() !== '_self') return;

            const href = anchor.getAttribute('href');
            if (!href || href.startsWith('#')) return;

            let url;
            try {
                url = new URL(anchor.href, window.location.href);
            } catch {
                return;
            }

            if (url.origin !== window.location.origin) return;

            const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
            const nextPath = `${url.pathname}${url.search}${url.hash}`;
            if (nextPath === currentPath || !shouldBlockRef.current) return;

            event.preventDefault();
            event.stopPropagation();
            confirmNavigation().then((confirmed) => {
                if (!confirmed) return;
                navigate(`${url.pathname}${url.search}${url.hash}`);
            });
        };

        document.addEventListener('click', handleDocumentClick, true);
        return () => {
            document.removeEventListener('click', handleDocumentClick, true);
        };
    }, [confirmNavigation, navigate]);

    useEffect(() => {
        if (!shouldBlock) return;

        const handlePopState = () => {
            if (skipNextPopRef.current) {
                skipNextPopRef.current = false;
                return;
            }

            // Restore the current URL while the app-level confirm dialog is open.
            window.history.pushState(null, '', location.pathname + location.search);

            confirmNavigation().then((confirmed) => {
                if (!confirmed) return;
                skipNextPopRef.current = true;
                window.history.back();
            });
        };

        // Add a same-route history entry so the first Back action can be confirmed.
        window.history.pushState(null, '', location.pathname + location.search);
        window.addEventListener('popstate', handlePopState);

        return () => {
            window.removeEventListener('popstate', handlePopState);
        };
    }, [shouldBlock, location.pathname, location.search, confirmNavigation]);

    useEffect(() => {
        if (!shouldBlock) return;

        const handleBeforeUnload = (event) => {
            event.preventDefault();
            event.returnValue = '';
            return 'You have unsaved changes. Are you sure you want to leave this page?';
        };

        window.addEventListener('beforeunload', handleBeforeUnload);

        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload);
        };
    }, [shouldBlock]);
}
