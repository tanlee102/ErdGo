/** Keyboard containment and trigger restoration for the shared overlay shells. */
import { useEffect, useRef } from 'react';

export default function useModalFocus(dialogRef, active, onClose) {
    const closeRef = useRef(onClose);
    useEffect(() => { closeRef.current = onClose; }, [onClose]);
    useEffect(() => {
        if (!active) return undefined;
        const dialog = dialogRef.current;
        const trigger = document.activeElement;
        const controls = () => [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]')].filter(control => {
            if (control.tabIndex < 0) return false;
            for (let element = control; element && element !== dialog.parentElement; element = element.parentElement) {
                const style = getComputedStyle(element);
                if (element.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
            }
            return true;
        });
        (dialog.querySelector('[data-modal-autofocus="true"]') || controls()[0] || dialog).focus();
        const handleKeyDown = event => {
            // Nested confirmation/export dialogs own their keyboard interaction.
            const focusedModal = document.activeElement?.closest('dialog[open], [role="dialog"][aria-modal="true"]');
            if (focusedModal && focusedModal !== dialog) return;
            const target = event.target;
            const editable = target instanceof Node && dialog.contains(target) && (target?.isContentEditable
                || (target instanceof HTMLTextAreaElement && !target.readOnly && !target.disabled)
                || (target instanceof HTMLInputElement && !target.readOnly && !target.disabled
                    && !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'file', 'color', 'hidden'].includes(target.type)));
            // Native Undo can reach a previously focused field behind an ARIA overlay.
            // Consume mutation shortcuts on modal buttons/read-only controls, while
            // keeping normal text editing inside the overlay's editable fields.
            const mutation = ['Delete', 'Backspace'].includes(event.key)
                || ((event.ctrlKey || event.metaKey) && !event.altKey && ['z', 'y', 'd', 'v', 'x', 's'].includes(event.key.toLowerCase()));
            if (!editable && mutation) { event.preventDefault(); event.stopPropagation(); return; }
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                // A required starter chooser stays open until a choice is made.
                closeRef.current?.();
            } else if (event.key === 'Tab') {
                const items = controls();
                const first = items[0];
                const last = items.at(-1);
                if (!first) { event.preventDefault(); dialog.focus(); }
                else if (!dialog.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
                else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
            }
        };
        const containFocus = event => {
            if (dialog.contains(event.target)) return;
            // A nested confirmation can be portaled outside the parent shell.
            if (event.target?.closest?.('dialog[open], [role="dialog"][aria-modal="true"]')) return;
            (controls()[0] || dialog).focus();
        };
        document.addEventListener('keydown', handleKeyDown, true);
        document.addEventListener('focusin', containFocus);
        return () => {
            document.removeEventListener('keydown', handleKeyDown, true);
            document.removeEventListener('focusin', containFocus);
            if (trigger?.isConnected) trigger.focus?.();
        };
    }, [active, dialogRef]);
}
