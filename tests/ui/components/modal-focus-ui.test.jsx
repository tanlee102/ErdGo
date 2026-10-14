// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Modal from '@/components/Modal';
import CreateNewFileDialog from '@/components/CreateNewFileDialog';
import { ConfirmProvider, useConfirm } from '@/components/ConfirmDialog';

vi.mock('@/components/Notifications', () => ({ useNotifications: () => ({ notifyError: vi.fn() }) }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

function OverlayHarness({ kind }) {
    const [active, setActive] = useState(false);
    const body = <><input aria-label="Overlay entry" /><button>Last action</button></>;
    return <>
        <button onClick={() => setActive(true)}>Open overlay</button>
        {kind === 'generic' && <Modal displayModal={active} setDisplayModal={setActive} title="Overlay" body={body} />}
        {kind === 'files' && <Modal displayModal={active} setDisplayModal={setActive} title="Saved files" body={body} />}
    </>;
}

describe('shared modal keyboard boundaries', () => {
    it('contains global confirmations and restores their trigger after cancellation', async () => {
        function ConfirmationTrigger() {
            const { confirm } = useConfirm();
            return <button onClick={() => confirm({ title: 'Replace canvas', confirmText: 'Replace' })}>Open confirmation</button>;
        }
        render(<ConfirmProvider><ConfirmationTrigger /></ConfirmProvider>);
        const trigger = screen.getByRole('button', { name: 'Open confirmation' });
        trigger.focus();
        fireEvent.click(trigger);
        const confirm = screen.getByRole('button', { name: 'Replace', exact: true });
        const close = screen.getByRole('button', { name: 'Close confirmation' });
        await waitFor(() => expect(confirm).toHaveFocus());
        const undo = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
        confirm.dispatchEvent(undo);
        expect(undo.defaultPrevented).toBe(true);
        fireEvent.keyDown(confirm, { key: 'Tab' });
        expect(close).toHaveFocus();
        trigger.focus();
        expect(close).toHaveFocus();
        fireEvent.keyDown(close, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(trigger).toHaveFocus();
    });
    it.each(['generic', 'files'])('contains focus, closes with Escape, and restores the %s trigger', async kind => {
        render(<OverlayHarness kind={kind} />);
        expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
        const trigger = screen.getByRole('button', { name: 'Open overlay' });
        trigger.focus();
        fireEvent.click(trigger);
        const dialog = screen.getByRole('dialog');
        await waitFor(() => expect(dialog).toContainElement(document.activeElement));
        const controls = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
        trigger.focus();
        expect(controls[0]).toHaveFocus();
        controls.at(-1).focus();
        fireEvent.keyDown(document.activeElement, { key: 'Tab' });
        expect(controls[0]).toHaveFocus();
        fireEvent.keyDown(document.activeElement, { key: 'Tab', shiftKey: true });
        expect(controls.at(-1)).toHaveFocus();
        fireEvent.keyDown(document.activeElement, { key: 'Escape' });
        expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
        expect(trigger).toHaveFocus();
    });

    it('keeps the required starter chooser focused until the user selects a document', () => {
        const selectBlank = vi.fn();
        render(<><button>Behind chooser</button><CreateNewFileDialog isDisplay onSelectSample={vi.fn()} onSelectBlank={selectBlank} /></>);
        const sample = screen.getByRole('button', { name: /Create with Sample/ });
        const blank = screen.getByRole('button', { name: /Create Blank File/ });
        expect(sample).toHaveFocus();
        screen.getByRole('button', { name: 'Behind chooser' }).focus();
        expect(sample).toHaveFocus();
        fireEvent.keyDown(sample, { key: 'Escape' });
        expect(screen.getByRole('dialog')).toBeVisible();
        fireEvent.keyDown(sample, { key: 'Tab', shiftKey: true });
        expect(blank).toHaveFocus();
        fireEvent.click(blank);
        expect(selectBlank).toHaveBeenCalledOnce();
    });

    it('consumes native mutation shortcuts on buttons while allowing text-field undo', () => {
        render(<OverlayHarness kind="files" />);
        fireEvent.click(screen.getByRole('button', { name: 'Open overlay' }));
        const button = screen.getByRole('button', { name: 'Last action' });
        const entry = screen.getByRole('textbox', { name: 'Overlay entry' });
        for (const target of [button, entry]) {
            target.focus();
            const undo = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
            target.dispatchEvent(undo);
            expect(undo.defaultPrevented).toBe(target === button);
        }
    });

    it('leaves a focused nested confirmation in control of Escape', () => {
        function NestedHarness() {
            const [nested, setNested] = useState(false);
            return <>
                <Modal displayModal title="Saved files" setDisplayModal={vi.fn()} body={<button onClick={() => setNested(true)}>Open confirmation</button>} />
                {nested && <section role="dialog" aria-modal="true" aria-label="Confirmation" onKeyDown={event => { if (event.key === 'Escape') setNested(false); }}>
                    <button autoFocus>Cancel confirmation</button>
                </section>}
            </>;
        }
        render(<NestedHarness />);
        fireEvent.click(screen.getByRole('button', { name: 'Open confirmation' }));
        fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel confirmation' }), { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: 'Confirmation' })).toBeNull();
        expect(screen.getByRole('dialog', { name: 'Saved files' })).toBeVisible();
    });
});
