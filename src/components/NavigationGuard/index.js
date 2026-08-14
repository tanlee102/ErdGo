/** Global registry that lets editor surfaces block navigation while unsaved work exists. */
import React, { createContext, useCallback, useContext, useMemo, useRef } from 'react';

import { useConfirm } from '@/components/ConfirmDialog';

const NavigationGuardContext = createContext({
    registerNavigationBlocker: () => () => {},
    confirmNavigation: async () => true,
    runAfterNavigationConfirm: async (action) => {
        action?.();
        return true;
    },
});

export function NavigationGuardProvider({ children }) {
    const { confirm } = useConfirm();
    const blockersRef = useRef([]);

    const registerNavigationBlocker = useCallback((blocker) => {
        blockersRef.current = [...blockersRef.current, blocker];

        return () => {
            blockersRef.current = blockersRef.current.filter((currentBlocker) => currentBlocker !== blocker);
        };
    }, []);

    const getActiveBlocker = useCallback(() => {
        for (let index = blockersRef.current.length - 1; index >= 0; index -= 1) {
            const blocker = blockersRef.current[index];
            if (blocker?.shouldBlock?.()) {
                return blocker;
            }
        }

        return null;
    }, []);

    const confirmNavigation = useCallback(async () => {
        const blocker = getActiveBlocker();
        if (!blocker) return true;
        return confirm(blocker.confirmOptions);
    }, [confirm, getActiveBlocker]);

    const runAfterNavigationConfirm = useCallback(
        async (action) => {
            const confirmed = await confirmNavigation();
            if (!confirmed) return false;

            action?.();
            return true;
        },
        [confirmNavigation],
    );

    const value = useMemo(
        () => ({
            registerNavigationBlocker,
            confirmNavigation,
            runAfterNavigationConfirm,
        }),
        [confirmNavigation, registerNavigationBlocker, runAfterNavigationConfirm],
    );

    return <NavigationGuardContext.Provider value={value}>{children}</NavigationGuardContext.Provider>;
}

export function useNavigationGuard() {
    return useContext(NavigationGuardContext);
}
