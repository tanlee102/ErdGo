import { useCallback, useEffect, useMemo, useRef } from 'react';
import { flushSync } from 'react-dom';
import { buildCombinedSql } from '../lib/sqlTabs';
import { createAiTabDiffReview } from '../lib/aiTabDiff';

export function useAiTabDiff({ tabs, preferredTabId, showAiSuggestions, setShowAiSuggestions, aiSuggestedCode, tabChanges: aiTabChanges, acceptedBlocks, setAcceptedBlocks, rejectedBlocks, setRejectedBlocks, setOriginalSqlInput, onApplyTabs, onClearReview, onBeforeFinalize }) {
    const acceptedBlocksRef = useRef(acceptedBlocks);
    const rejectedBlocksRef = useRef(rejectedBlocks);

    useEffect(() => {
        acceptedBlocksRef.current = acceptedBlocks;
    }, [acceptedBlocks]);

    useEffect(() => {
        rejectedBlocksRef.current = rejectedBlocks;
    }, [rejectedBlocks]);

    // The caller provides the immutable workspace snapshot captured when the
    // request starts. Keep this review tied to its response, not to tab edits
    // committed while individual blocks are accepted.
    const review = useMemo(() => {
        if (!showAiSuggestions || (!aiSuggestedCode && !aiTabChanges)) return null;
        return createAiTabDiffReview({ tabs, preferredTabId, suggestedSql: aiSuggestedCode, tabChanges: aiTabChanges });
        // `tabs` and `preferredTabId` deliberately stay out of this key: they
        // are the request snapshot and live tabs change after each acceptance.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [aiSuggestedCode, aiTabChanges, showAiSuggestions]);

    const allBlocks = useMemo(() => review?.getAllBlocks() || [], [review]);
    const remainingBlocksCount = allBlocks.filter((block) => !acceptedBlocks.has(block.id) && !rejectedBlocks.has(block.id)).length;
    const allBlocksProcessed = allBlocks.length > 0 && remainingBlocksCount === 0;
    const tabChanges = useMemo(() => review?.getTabChanges(acceptedBlocks, rejectedBlocks) || {}, [acceptedBlocks, rejectedBlocks, review]);
    const tabActions = useMemo(() => review?.getTabActions(acceptedBlocks, rejectedBlocks) || [], [acceptedBlocks, rejectedBlocks, review]);
    // Preview is the optimistic candidate used by parser/ERD/data/next AI call.
    // Display keeps review decorations visible in Monaco until the user accepts
    // or rejects each block.
    const previewTabs = useMemo(() => (review && review.mode !== 'invalid' ? review.getPreviewTabs(acceptedBlocks, rejectedBlocks) : null), [acceptedBlocks, rejectedBlocks, review]);
    const previewSql = useMemo(() => review?.getPreviewSql(acceptedBlocks, rejectedBlocks) || '', [acceptedBlocks, rejectedBlocks, review]);
    const displayTabs = useMemo(() => (review?.mode === 'tabs' ? review.getDisplayTabs(acceptedBlocks, rejectedBlocks) : null), [acceptedBlocks, rejectedBlocks, review]);
    const displaySql = useMemo(() => review?.getDisplaySql(acceptedBlocks, rejectedBlocks) || '', [acceptedBlocks, rejectedBlocks, review]);

    const getDisplayData = useCallback(
        (tabId) => review?.getDisplayData(tabId, acceptedBlocks, rejectedBlocks) || { code: '', visibleBlocks: [] },
        [acceptedBlocks, rejectedBlocks, review],
    );

    const commitSelection = useCallback(
        (nextAccepted) => {
            if (!review || review.mode === 'invalid' || !showAiSuggestions) return null;

            // Accepting a block immediately commits that accepted subset to the
            // tab workspace. Rejected/pending blocks remain review-only.
            const nextTabs = review.applySelectedChanges(nextAccepted);
            onApplyTabs?.(nextTabs);
            return buildCombinedSql(nextTabs).sql;
        },
        [onApplyTabs, review, showAiSuggestions],
    );

    const updateSelection = useCallback(
        (updater) => {
            const currentAccepted = acceptedBlocksRef.current;
            const currentRejected = rejectedBlocksRef.current;
            const { accepted, rejected } = updater(currentAccepted, currentRejected);

            acceptedBlocksRef.current = accepted;
            rejectedBlocksRef.current = rejected;

            // Diff action controls live outside React in Monaco. Flush this
            // small, user-initiated transition so the old diff model cannot
            // remain painted until the next tab change causes a render.
            flushSync(() => {
                setAcceptedBlocks(accepted);
                setRejectedBlocks(rejected);
                commitSelection(accepted);
            });
        },
        [commitSelection, setAcceptedBlocks, setRejectedBlocks],
    );

    const finalizeReview = useCallback(
        ({ acceptRemaining = true } = {}) => {
            if (!review || review.mode === 'invalid' || !showAiSuggestions) return null;

            const finalAccepted = new Set(acceptedBlocksRef.current);
            if (acceptRemaining) {
                allBlocks.forEach((block) => {
                    if (!rejectedBlocksRef.current.has(block.id)) {
                        finalAccepted.add(block.id);
                    }
                });
            }

            // Capture Monaco scroll/cursor before replacing the review model so
            // Accept All does not jump the user to the top of the current tab.
            onBeforeFinalize?.();
            const combinedSql = commitSelection(finalAccepted);
            setOriginalSqlInput('');
            setShowAiSuggestions(false);
            acceptedBlocksRef.current = new Set();
            rejectedBlocksRef.current = new Set();
            setAcceptedBlocks(new Set());
            setRejectedBlocks(new Set());
            onClearReview?.();

            return combinedSql;
        },
        [allBlocks, commitSelection, onBeforeFinalize, onClearReview, review, setAcceptedBlocks, setOriginalSqlInput, setRejectedBlocks, setShowAiSuggestions, showAiSuggestions],
    );

    useEffect(() => {
        if (!allBlocksProcessed || review?.mode === 'invalid' || !showAiSuggestions) return undefined;

        const timer = window.setTimeout(() => finalizeReview({ acceptRemaining: false }), 300);
        return () => window.clearTimeout(timer);
    }, [allBlocksProcessed, finalizeReview, review?.mode, showAiSuggestions]);

    const discardReview = useCallback(() => {
        setOriginalSqlInput('');
        setShowAiSuggestions(false);
        acceptedBlocksRef.current = new Set();
        rejectedBlocksRef.current = new Set();
        setAcceptedBlocks(new Set());
        setRejectedBlocks(new Set());
        onClearReview?.();
    }, [onClearReview, setAcceptedBlocks, setOriginalSqlInput, setRejectedBlocks, setShowAiSuggestions]);

    const handleAcceptBlock = useCallback(
        (blockId) => {
            updateSelection((previousAccepted, previousRejected) => {
                const accepted = new Set(previousAccepted);
                const rejected = new Set(previousRejected);
                accepted.add(blockId);
                rejected.delete(blockId);
                return { accepted, rejected };
            });
        },
        [updateSelection],
    );

    const handleRejectBlock = useCallback(
        (blockId) => {
            updateSelection((previousAccepted, previousRejected) => {
                const accepted = new Set(previousAccepted);
                const rejected = new Set(previousRejected);
                // Reject dependent structural actions with their prerequisite.
                // Otherwise an action could remain accepted even though the tab
                // it targets or follows will never exist in the final workspace.
                [blockId, ...(review?.getDependentBlockIds?.(blockId) || [])].forEach((rejectedId) => {
                    rejected.add(rejectedId);
                    accepted.delete(rejectedId);
                });
                return { accepted, rejected };
            });
        },
        [review, updateSelection],
    );

    const handleAcceptAllRemain = useCallback(() => {
        updateSelection((previousAccepted, previousRejected) => {
            const accepted = new Set(previousAccepted);
            const rejected = new Set(previousRejected);
            allBlocks.forEach((block) => {
                if (!rejected.has(block.id)) {
                    accepted.add(block.id);
                }
            });
            return { accepted, rejected };
        });
    }, [allBlocks, updateSelection]);

    const handleRejectAllRemain = useCallback(() => {
        updateSelection((previousAccepted, previousRejected) => {
            const accepted = new Set(previousAccepted);
            const rejected = new Set(previousRejected);
            allBlocks.forEach((block) => {
                if (!accepted.has(block.id)) {
                    rejected.add(block.id);
                }
            });
            return { accepted, rejected };
        });
    }, [allBlocks, updateSelection]);

    return {
        allBlocks,
        allBlocksProcessed,
        remainingBlocksCount,
        reviewMode: review?.mode || 'tabs',
        reviewError: review?.reviewError || null,
        tabChanges,
        tabActions,
        previewTabs,
        previewSql,
        displayTabs,
        displaySql,
        getDisplayData,
        handleAcceptBlock,
        handleRejectBlock,
        handleAcceptAllRemain,
        handleRejectAllRemain,
        acceptAllRemainAndFinalize: () => finalizeReview({ acceptRemaining: true }),
        discardReview,
    };
}
