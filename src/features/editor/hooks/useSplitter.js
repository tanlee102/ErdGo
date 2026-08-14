import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * Custom hook for managing resizable panel splitter
 * Desktop: Draggable splitter with snap thresholds
 * Mobile: Toggle between full-width panels
 *
 * @param {Object} options
 * @param {number} options.initialSize - Initial panel size percentage (0-100)
 * @param {Object} options.minThreshold - Min threshold before snap to 0
 * @param {Object} options.maxThreshold - Max threshold before snap to 100
 * @param {number} options.defaultRestoreSize - Default size when restoring from collapsed
 * @param {Function} options.onSizeChange - Callback when panel size changes (for persistence)
 * @param {number} options.forceUpdateVersion - Version number that forces size re-application when incremented (for file switching)
 */
export default function useSplitter({ initialSize = 35, minThreshold = { desktop: 12, mobile: 15 }, maxThreshold = { desktop: 88, mobile: 85 }, defaultRestoreSize = 35, onSizeChange = null, forceUpdateVersion = 0 } = {}) {
    // Panel size state
    const [panelSize, setPanelSize] = useState(initialSize);
    const [isCollapsed, setIsCollapsed] = useState(false);
    const [lastPanelSize, setLastPanelSize] = useState(initialSize);

    // Track size changes for persistence (debounced)
    const sizeChangeTimeoutRef = useRef(null);

    // UI state
    const [isDragging, setIsDragging] = useState(false);
    const [isMobile, setIsMobile] = useState(false);
    const [showEditor, setShowEditor] = useState(true); // Mobile: true = editor, false = ERD
    const [isClient, setIsClient] = useState(false); // Prevent SSR hydration mismatch

    const splitterRef = useRef(null);
    const rafRef = useRef(null); // RequestAnimationFrame for smooth dragging
    const hasToggledToErdRef = useRef(false); // Track if user has toggled to ERD at least once

    const MOBILE_BREAKPOINT = 768;

    // Check if viewport is mobile size
    const checkMobile = useCallback(() => {
        const mobile = window.innerWidth <= MOBILE_BREAKPOINT;
        const wasMobile = isMobile;
        setIsMobile(mobile);

        // Reset flag when switching from desktop to mobile
        if (mobile && !wasMobile) {
            hasToggledToErdRef.current = false;
        }

        return mobile;
    }, [isMobile]);

    // Toggle panel visibility (mobile) or collapse/expand (desktop)
    const toggleCollapse = useCallback(() => {
        const mobile = window.innerWidth <= MOBILE_BREAKPOINT;

        if (mobile) {
            // Mobile: Toggle between editor and ERD
            setShowEditor((prev) => {
                const newValue = !prev;
                // When switching to ERD for the first time (!newValue = false means showEditor = false -> show ERD)
                // Dispatch custom event to force fit canvas ERD ONLY ONCE
                if (!newValue && !hasToggledToErdRef.current) {
                    hasToggledToErdRef.current = true; // Mark as toggled for the first time
                    setTimeout(() => {
                        // Dispatch custom force-fit event
                        window.dispatchEvent(new CustomEvent('erd-force-fit'));
                    }, 150); // Delay to ensure DOM has updated display
                }
                return newValue;
            });
        } else {
            // Desktop: Collapse or restore panel
            if (panelSize === 0) {
                const restoreSize = lastPanelSize > 5 ? lastPanelSize : defaultRestoreSize;
                setPanelSize(restoreSize);
                setIsCollapsed(false);
            } else {
                setLastPanelSize(panelSize);
                setPanelSize(0);
                setIsCollapsed(true);
            }
        }
    }, [panelSize, lastPanelSize, defaultRestoreSize]);

    // Handle splitter drag (desktop only)
    const handleSplitterMouseDown = useCallback(
        (e) => {
            // Ignore if clicking on toggle button
            if (e.target.classList.contains('splitter-toggle-btn')) {
                return;
            }

            // Only allow dragging on desktop
            const mobile = window.innerWidth <= MOBILE_BREAKPOINT;
            if (mobile) return;

            e.preventDefault();
            const startPos = e.clientX;
            const startSize = panelSize;
            const containerSize = window.innerWidth;

            setIsDragging(true);

            // Cache DOM elements
            const sqlPanel = document.querySelector('.sql-panel');
            const erdPanel = document.querySelector('.erd-panel');

            // Handle mouse move during drag
            const handleMouseMove = (e) => {
                // Cancel previous animation frame
                if (rafRef.current) {
                    cancelAnimationFrame(rafRef.current);
                }

                // Schedule update for next frame (smooth 60fps)
                rafRef.current = requestAnimationFrame(() => {
                    const currentPos = e.clientX;
                    const delta = currentPos - startPos;
                    const deltaPercent = (delta / containerSize) * 100;
                    let newSize = startSize + deltaPercent;

                    // Clamp between 0-100%
                    newSize = Math.min(Math.max(newSize, 0), 100);

                    // Direct DOM manipulation for instant feedback
                    if (sqlPanel) sqlPanel.style.width = `${newSize}%`;
                    if (erdPanel) erdPanel.style.flex = '1';
                });
            };

            // Handle mouse up (end drag)
            const handleMouseUp = (e) => {
                // Cleanup event listeners
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
                document.body.style.cursor = '';
                document.body.style.userSelect = '';

                // Cancel any pending animation frame
                if (rafRef.current) {
                    cancelAnimationFrame(rafRef.current);
                    rafRef.current = null;
                }

                setIsDragging(false);

                // Calculate final size
                const currentPos = e.clientX;
                const delta = currentPos - startPos;
                const deltaPercent = (delta / containerSize) * 100;
                let finalSize = startSize + deltaPercent;

                const threshold = minThreshold.desktop;
                const maxThresh = maxThreshold.desktop;

                // Apply snap logic
                if (finalSize < threshold) {
                    // Snap to collapsed (0%)
                    setLastPanelSize(startSize);
                    setPanelSize(0);
                    setIsCollapsed(true);
                } else if (finalSize > maxThresh) {
                    // Snap to full width (100%)
                    setPanelSize(100);
                    setIsCollapsed(false);
                } else {
                    // Normal range (5-95%)
                    finalSize = Math.min(Math.max(finalSize, 5), 95);
                    setPanelSize(finalSize);
                    setIsCollapsed(false);
                }

                // Reset inline styles, let React control rendering
                if (sqlPanel) {
                    sqlPanel.style.width = '';
                    sqlPanel.style.height = '';
                }
                if (erdPanel) {
                    erdPanel.style.width = '';
                    erdPanel.style.height = '';
                    erdPanel.style.flex = '';
                }
            };

            // Attach event listeners
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        },
        [panelSize, minThreshold, maxThreshold],
    );

    // Get inline styles for panels based on current state
    const getPanelStyle = useCallback(
        (isMainPanel = true) => {
            // Server render: Use desktop layout to prevent hydration mismatch
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

            // Mobile: Full width toggle layout
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

            // Desktop: Resizable splitter layout
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

    // Toggle button text and title
    const toggleButtonText = isMobile ? (showEditor ? '>' : '<') : panelSize === 0 ? '>' : '<';

    const toggleButtonTitle = isMobile ? (showEditor ? 'Show ERD' : 'Show Editor') : panelSize === 0 ? 'Expand Panel' : 'Collapse Panel';

    const containerClassName = isDragging ? 'dragging' : '';

    // Initialize client state on mount
    useEffect(() => {
        setIsClient(true);
        checkMobile();
    }, [checkMobile]);

    // Listen to window resize
    useEffect(() => {
        const handleResize = () => {
            checkMobile();
        };

        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, [checkMobile]);

    // Track if this is initial mount to avoid triggering change on load
    const isInitialMountRef = useRef(true);
    const lastNotifiedSizeRef = useRef(initialSize);

    // Notify parent when panel size changes (debounced to avoid too many calls)
    useEffect(() => {
        if (!onSizeChange || isMobile) return;

        // Skip notification on initial mount
        if (isInitialMountRef.current) {
            isInitialMountRef.current = false;
            lastNotifiedSizeRef.current = panelSize;
            return;
        }

        // Skip if size hasn't actually changed (avoids duplicate notifications)
        if (panelSize === lastNotifiedSizeRef.current) {
            return;
        }

        // Clear previous timeout
        if (sizeChangeTimeoutRef.current) {
            clearTimeout(sizeChangeTimeoutRef.current);
        }

        // Debounce the callback - only call after 500ms of no changes
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

    // Update panel size when initialSize changes or forceUpdateVersion increments
    // forceUpdateVersion is the KEY mechanism for ensuring size re-applies on file switch
    const prevInitialSizeRef = useRef(initialSize);
    const prevForceVersionRef = useRef(forceUpdateVersion);

    useEffect(() => {
        // Don't apply during dragging
        if (isDragging) return;

        // Check if this is a force update (file switch) or just initial size change
        const isForceUpdate = forceUpdateVersion !== prevForceVersionRef.current;
        const isSizeChange = initialSize !== prevInitialSizeRef.current;

        // Apply if either force update OR size changed
        if (isForceUpdate || isSizeChange) {
            if (initialSize !== undefined && initialSize !== null) {
                setPanelSize(initialSize);
                setLastPanelSize(initialSize);
                // Update lastNotifiedSize to prevent false change detection
                lastNotifiedSizeRef.current = initialSize;
                // Update collapsed state
                setIsCollapsed(initialSize === 0);
            }
            prevInitialSizeRef.current = initialSize;
            prevForceVersionRef.current = forceUpdateVersion;
        }
    }, [initialSize, forceUpdateVersion, isDragging]);

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
        toggleButtonText,
        toggleButtonTitle,
        containerClassName,
        getPanelStyle,
        splitterRef,
        setPanelSize,
        setIsMobile,
        setShowEditor,
    };
}
