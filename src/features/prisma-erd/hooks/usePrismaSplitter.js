/** Owns desktop/mobile splitter state, drag cleanup, collapse behavior, and size persistence. */
import { useCallback, useEffect, useRef, useState } from 'react';

const MOBILE_BREAKPOINT = 768;

export default function usePrismaSplitter({ initialSize = 35, minThreshold = { desktop: 12, mobile: 15 }, maxThreshold = { desktop: 88, mobile: 85 }, defaultRestoreSize = 35, onSizeChange = null } = {}) {
    const [panelSize, setPanelSize] = useState(initialSize);
    const [isCollapsed, setIsCollapsed] = useState(false);
    const [lastPanelSize, setLastPanelSize] = useState(initialSize);
    const [isDragging, setIsDragging] = useState(false);
    const [isMobile, setIsMobile] = useState(false);
    const [showEditor, setShowEditor] = useState(true);
    const [isClient, setIsClient] = useState(false);
    const splitterRef = useRef(null);
    const rafRef = useRef(null);
    const dragCleanupRef = useRef(null);
    const mobileToggleTimerRef = useRef(null);
    const sizeChangeTimeoutRef = useRef(null);
    const hasToggledToErdRef = useRef(false);
    const isInitialMountRef = useRef(true);
    const lastNotifiedSizeRef = useRef(initialSize);

    const checkMobile = useCallback(() => {
        const mobile = window.innerWidth <= MOBILE_BREAKPOINT;
        const wasMobile = isMobile;
        setIsMobile(mobile);
        if (mobile && !wasMobile) {
            hasToggledToErdRef.current = false;
        }
        return mobile;
    }, [isMobile]);

    const toggleCollapse = useCallback(() => {
        const mobile = window.innerWidth <= MOBILE_BREAKPOINT;

        if (mobile) {
            setShowEditor((previous) => {
                const next = !previous;
                if (!next && !hasToggledToErdRef.current) {
                    hasToggledToErdRef.current = true;
                    if (mobileToggleTimerRef.current) clearTimeout(mobileToggleTimerRef.current);
                    mobileToggleTimerRef.current = setTimeout(() => {
                        mobileToggleTimerRef.current = null;
                        window.dispatchEvent(new CustomEvent('erd-force-fit'));
                    }, 150);
                }
                return next;
            });
            return;
        }

        if (panelSize === 0) {
            const restoreSize = lastPanelSize > 5 ? lastPanelSize : defaultRestoreSize;
            setPanelSize(restoreSize);
            setIsCollapsed(false);
        } else {
            setLastPanelSize(panelSize);
            setPanelSize(0);
            setIsCollapsed(true);
        }
    }, [panelSize, lastPanelSize, defaultRestoreSize]);

    const handleSplitterMouseDown = useCallback(
        (event) => {
            if (event.target.closest?.('.prisma-erd-splitter-toggle')) return;
            if (window.innerWidth <= MOBILE_BREAKPOINT) return;

            event.preventDefault();
            const startPosition = event.clientX;
            const startSize = panelSize;
            const mainPanel = document.querySelector('.prisma-erd-source-panel');
            const secondaryPanel = document.querySelector('.prisma-erd-diagram-panel');
            const splitterContainer = splitterRef.current?.parentElement || mainPanel?.parentElement || secondaryPanel?.parentElement;
            const containerSize = splitterContainer?.getBoundingClientRect().width || window.innerWidth;

            setIsDragging(true);

            const cleanupDrag = () => {
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
                document.body.style.cursor = '';
                document.body.style.userSelect = '';

                if (rafRef.current) {
                    cancelAnimationFrame(rafRef.current);
                    rafRef.current = null;
                }
                dragCleanupRef.current = null;
            };

            const handleMouseMove = (moveEvent) => {
                if (rafRef.current) cancelAnimationFrame(rafRef.current);

                rafRef.current = requestAnimationFrame(() => {
                    const delta = moveEvent.clientX - startPosition;
                    const deltaPercent = (delta / containerSize) * 100;
                    const newSize = Math.min(Math.max(startSize + deltaPercent, 0), maxThreshold.desktop);

                    if (mainPanel) mainPanel.style.width = `${newSize}%`;
                    if (secondaryPanel) secondaryPanel.style.flex = '1';
                });
            };

            const handleMouseUp = (upEvent) => {
                cleanupDrag();
                setIsDragging(false);

                const delta = upEvent.clientX - startPosition;
                const deltaPercent = (delta / containerSize) * 100;
                let finalSize = startSize + deltaPercent;

                if (finalSize < minThreshold.desktop) {
                    setLastPanelSize(startSize);
                    setPanelSize(0);
                    setIsCollapsed(true);
                } else if (finalSize > maxThreshold.desktop) {
                    setPanelSize(maxThreshold.desktop);
                    setIsCollapsed(false);
                } else {
                    finalSize = Math.min(Math.max(finalSize, 5), maxThreshold.desktop);
                    setPanelSize(finalSize);
                    setIsCollapsed(false);
                }

                if (mainPanel) {
                    mainPanel.style.width = '';
                    mainPanel.style.height = '';
                }
                if (secondaryPanel) {
                    secondaryPanel.style.width = '';
                    secondaryPanel.style.height = '';
                    secondaryPanel.style.flex = '1';
                }
            };

            dragCleanupRef.current?.();
            dragCleanupRef.current = cleanupDrag;
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        },
        [panelSize, minThreshold.desktop, maxThreshold.desktop],
    );

    const getPanelStyle = useCallback(
        (isMainPanel = true) => {
            if (!isClient) {
                if (isMainPanel) {
                    return {
                        width: `${panelSize}%`,
                        height: '100%',
                        display: panelSize === 0 ? 'none' : 'flex',
                        transition: 'width 0.2s ease',
                    };
                }
                return {
                    height: '100%',
                    flex: 1,
                    transition: 'flex 0.2s ease',
                };
            }

            if (isMobile) {
                if (isMainPanel) {
                    return {
                        width: '100%',
                        height: '100%',
                        display: showEditor ? 'flex' : 'none',
                        transition: 'none',
                    };
                }
                return {
                    width: '100%',
                    height: '100%',
                    display: showEditor ? 'none' : 'flex',
                    transition: 'none',
                };
            }

            if (isMainPanel) {
                return {
                    width: `${panelSize}%`,
                    height: '100%',
                    display: panelSize === 0 ? 'none' : 'flex',
                    transition: isDragging ? 'none' : 'width 0.2s ease',
                };
            }
            return {
                height: '100%',
                flex: 1,
                transition: isDragging ? 'none' : 'flex 0.2s ease',
            };
        },
        [panelSize, isMobile, isDragging, showEditor, isClient],
    );

    useEffect(() => {
        setIsClient(true);
        checkMobile();
    }, [checkMobile]);

    useEffect(() => {
        const handleResize = () => {
            checkMobile();
        };

        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, [checkMobile]);

    useEffect(() => {
        return () => {
            dragCleanupRef.current?.();
            if (mobileToggleTimerRef.current) clearTimeout(mobileToggleTimerRef.current);
            if (sizeChangeTimeoutRef.current) clearTimeout(sizeChangeTimeoutRef.current);
        };
    }, []);

    useEffect(() => {
        if (!onSizeChange || isMobile) return;

        if (isInitialMountRef.current) {
            isInitialMountRef.current = false;
            lastNotifiedSizeRef.current = panelSize;
            return;
        }

        if (panelSize === lastNotifiedSizeRef.current) return;

        if (sizeChangeTimeoutRef.current) {
            clearTimeout(sizeChangeTimeoutRef.current);
        }

        sizeChangeTimeoutRef.current = setTimeout(() => {
            lastNotifiedSizeRef.current = panelSize;
            onSizeChange(panelSize);
        }, 500);

        return () => {
            if (sizeChangeTimeoutRef.current) {
                clearTimeout(sizeChangeTimeoutRef.current);
            }
        };
    }, [panelSize, onSizeChange, isMobile]);

    return {
        panelSize,
        isCollapsed,
        isDragging,
        isMobile,
        showEditor,
        isClient,
        toggleCollapse,
        handleSplitterMouseDown,
        checkMobile,
        toggleButtonText: isMobile ? (showEditor ? '>' : '<') : panelSize === 0 ? '>' : '<',
        toggleButtonTitle: isMobile ? (showEditor ? 'Show ERD' : 'Show Editor') : panelSize === 0 ? 'Expand Panel' : 'Collapse Panel',
        containerClassName: isDragging ? 'dragging' : '',
        getPanelStyle,
        splitterRef,
        setPanelSize,
        setIsMobile,
        setShowEditor,
    };
}
