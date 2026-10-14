/** Toolbar-owned help uses a portal so the ERD panel and scrolling sidebar cannot clip it. */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './index.css';

export default function ErdControlHelp({ children, placement = 'left', ...props }) {
    const [anchor, setAnchor] = useState(null);
    const [isOpen, setIsOpen] = useState(false);
    const [position, setPosition] = useState(null);
    const tooltipId = useId();
    const tooltipRef = useRef(null);
    const closeTimer = useRef(null);
    const hoverTimer = useRef(null);
    const pointerActivation = useRef(false);

    function cancelHover() {
        window.clearTimeout(hoverTimer.current);
    }

    function cancelClose() {
        window.clearTimeout(closeTimer.current);
    }

    function close(immediate = false) {
        cancelHover();
        cancelClose();
        setIsOpen(false);
        if (immediate) setAnchor(null);
    }

    function scheduleClose() {
        cancelClose();
        // Allow crossing the small gap between the button and its hoverable help.
        closeTimer.current = window.setTimeout(() => setIsOpen(false), 120);
    }

    function findButton(event) {
        const button = event.target.closest?.('button[data-erd-help]');
        return button && event.currentTarget.contains(button) && button.getAttribute('aria-expanded') !== 'true' ? button : null;
    }

    function show(button) {
        cancelClose();
        if (button !== anchor) {
            setPosition(null);
            setAnchor(button);
        }
        setIsOpen(true);
    }

    function queueHover(event) {
        if (pointerActivation.current) return;
        const button = findButton(event);
        if (!button || (event.relatedTarget instanceof Node && button.contains(event.relatedTarget))) return;
        if (button === anchor && isOpen) {
            cancelClose();
            return;
        }
        cancelHover();
        hoverTimer.current = window.setTimeout(() => {
            if (button.isConnected && button.getAttribute('aria-expanded') !== 'true') show(button);
        }, 800);
    }

    function focus(event) {
        cancelHover();
        // Pointer activation focuses a button before its click. Keep that
        // focus event from flashing help during an action.
        if (pointerActivation.current) return;
        const button = findButton(event);
        if (button) show(button);
    }

    function leave(event) {
        const button = event.target.closest?.('button[data-erd-help]');
        if (event.relatedTarget instanceof Node && (button?.contains(event.relatedTarget) || tooltipRef.current?.contains(event.relatedTarget))) return;
        cancelHover();
        scheduleClose();
    }

    useLayoutEffect(() => {
        if (!anchor || !isOpen || !tooltipRef.current) return;
        const button = anchor.getBoundingClientRect();
        const help = tooltipRef.current.getBoundingClientRect();
        const margin = 8;
        const gap = 10;
        let left = button.left - help.width - gap;
        let top = button.top + (button.height - help.height) / 2;
        const fitsRight = button.right + gap + help.width <= window.innerWidth - margin;
        // If neither side fits, stack the card instead of covering its trigger.
        if (placement === 'bottom' || (left < margin && !fitsRight)) {
            left = button.left + (button.width - help.width) / 2;
            top = button.bottom + gap;
            if (top + help.height > window.innerHeight - margin) top = button.top - help.height - gap;
        } else if (left < margin) {
            left = button.right + gap;
        }
        setPosition({
            left: Math.max(margin, Math.min(left, window.innerWidth - help.width - margin)),
            top: Math.max(margin, Math.min(top, window.innerHeight - help.height - margin)),
        });
    }, [anchor, isOpen, placement, children]);

    useEffect(() => {
        if (!anchor || !isOpen) return;
        const descriptions = (anchor.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
        anchor.setAttribute('aria-describedby', [...descriptions, tooltipId].join(' '));
        const dismiss = (immediate = false) => {
            window.clearTimeout(closeTimer.current);
            window.clearTimeout(hoverTimer.current);
            setIsOpen(false);
            if (immediate === true) setAnchor(null);
        };
        const onPointerDown = () => dismiss(true);
        const onKeyDown = (event) => {
            if (event.key === 'Escape') dismiss();
        };
        const onScroll = (event) => {
            // Editor/model scrolling can occur while an ERD button stays under
            // the pointer. Only scrolling its ancestors changes the anchor.
            if (event.target === document || event.target === window || (event.target instanceof Node && event.target.contains(anchor))) dismiss();
        };
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        const anchorBounds = anchor.getBoundingClientRect();
        const onResize = () => {
            const bounds = anchor.getBoundingClientRect();
            // Canvas refreshes dispatch resize without moving the viewport or
            // button. Keep hover help open through those renderer notifications.
            if (window.innerWidth !== viewport.width || window.innerHeight !== viewport.height || ['left', 'top', 'right', 'bottom'].some((key) => bounds[key] !== anchorBounds[key])) dismiss();
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('resize', onResize);
        window.addEventListener('scroll', onScroll, true);
        return () => {
            const remaining = (anchor.getAttribute('aria-describedby') || '').split(/\s+/).filter((id) => id && id !== tooltipId);
            if (remaining.length) anchor.setAttribute('aria-describedby', remaining.join(' '));
            else anchor.removeAttribute('aria-describedby');
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('pointerdown', onPointerDown, true);
            window.removeEventListener('resize', onResize);
            window.removeEventListener('scroll', onScroll, true);
        };
    }, [anchor, isOpen, tooltipId]);

    useEffect(() => {
        if (isOpen || !anchor) return;
        // Keep the portal mounted for the CSS opacity transition to finish.
        const fadeTimer = window.setTimeout(() => setAnchor(null), 140);
        return () => window.clearTimeout(fadeTimer);
    }, [anchor, isOpen]);

    useEffect(() => {
        // A press may end outside the toolbar after a drag or touch cancellation.
        const resetPointer = () => { pointerActivation.current = false; };
        document.addEventListener('pointerup', resetPointer, true);
        document.addEventListener('pointercancel', resetPointer, true);
        window.addEventListener('blur', resetPointer);
        return () => {
            window.clearTimeout(closeTimer.current);
            window.clearTimeout(hoverTimer.current);
            document.removeEventListener('pointerup', resetPointer, true);
            document.removeEventListener('pointercancel', resetPointer, true);
            window.removeEventListener('blur', resetPointer);
        };
    }, []);

    return (
        <>
            <div {...props} onMouseOver={queueHover} onMouseOut={leave} onFocus={focus} onBlur={leave}
                onPointerDownCapture={() => { pointerActivation.current = true; close(true); }}
                onPointerUpCapture={() => { pointerActivation.current = false; }}
                onPointerCancelCapture={() => { pointerActivation.current = false; close(true); }}
                onClickCapture={() => { pointerActivation.current = false; close(true); }}>
                {children}
            </div>
            {anchor && createPortal(
                <div ref={tooltipRef} id={tooltipId} className={`erd-control-help ${isOpen ? 'is-open' : ''}`} role="tooltip" aria-hidden={!isOpen}
                    style={position || { visibility: 'hidden' }} onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
                    <span>{anchor.dataset.erdHelp}</span>
                </div>,
                document.body,
            )}
        </>
    );
}
