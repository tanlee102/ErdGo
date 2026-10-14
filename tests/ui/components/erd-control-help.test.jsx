// @vitest-environment jsdom
/** Hover/focus help must escape clipped toolbars without intercepting their actions. */
import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ErdControls from '@/features/editor/components/ErdControls';
import ErdTopControls from '@/features/editor/components/ErdTopControls';
import { renderWithProviders } from '../../utils/uiTestUtils.jsx';

describe('ERD control help', () => {
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

    it('waits briefly before hover help and cancels it if the pointer leaves', () => {
        vi.useFakeTimers();
        renderWithProviders(<ErdControls erdRendering={{ fullConnect: false }} />);
        const button = document.getElementById('fit-btn');
        fireEvent.mouseOver(button);
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
        act(() => vi.advanceTimersByTime(799));
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
        act(() => vi.advanceTimersByTime(1));
        expect(screen.getByRole('tooltip')).toHaveTextContent('Fit the whole diagram on screen');

        fireEvent.mouseOut(button);
        act(() => vi.advanceTimersByTime(1000));
        fireEvent.mouseOver(button);
        fireEvent.mouseOut(button);
        act(() => vi.advanceTimersByTime(1000));
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    it('cancels queued and visible help on press without a focus flash or delayed reappearance', () => {
        vi.useFakeTimers();
        renderWithProviders(<ErdControls erdRendering={{ fullConnect: false }} />);
        const button = document.getElementById('fit-btn');
        fireEvent.mouseOver(button);
        act(() => vi.advanceTimersByTime(400));
        fireEvent.pointerDown(button);
        fireEvent.focus(button);
        act(() => vi.advanceTimersByTime(1000));
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
        fireEvent.pointerUp(button);
        fireEvent.click(button);

        fireEvent.mouseOver(button);
        act(() => vi.advanceTimersByTime(800));
        const help = screen.getByRole('tooltip');
        fireEvent.pointerDown(button);
        expect(help).not.toBeInTheDocument();
        const nextButton = document.getElementById('zoom-out');
        fireEvent.mouseOver(nextButton);
        act(() => vi.advanceTimersByTime(1000));
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
        fireEvent.pointerUp(document);
        fireEvent.focus(nextButton);
        expect(screen.getByRole('tooltip')).toHaveTextContent('Zoom out to see more tables');
    });

    it('explains a hovered icon outside the scrolling toolbar and fades out on Escape', async () => {
        renderWithProviders(<ErdControls erdRendering={{ fullConnect: false }} />);
        const button = document.getElementById('fit-btn');
        fireEvent.mouseOver(button.querySelector('svg'));

        const help = await screen.findByRole('tooltip');
        expect(help).toHaveTextContent('Fit the whole diagram on screen');
        expect(help.querySelector('strong')).toBeNull();
        expect(document.getElementById('erd-controls')).not.toContainElement(help);
        expect(button).toHaveAccessibleDescription('Fit the whole diagram on screen');
        expect(button).not.toHaveAttribute('title');

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
        expect(button).not.toHaveAttribute('aria-describedby');
        expect(help).toBeInTheDocument();
        expect(help).toHaveAttribute('aria-hidden', 'true');
        expect(help).not.toHaveClass('is-open');
        await waitFor(() => expect(help).not.toBeInTheDocument());
    });

    it('supports keyboard focus and dismisses help when activating a control', () => {
        const setDisplayModalAddTable = vi.fn();
        renderWithProviders(<ErdControls erdRendering={{ fullConnect: false }} />, { layout: { setDisplayModalAddTable } });
        const button = screen.getByRole('button', { name: 'Add Table' });
        fireEvent.focus(button);
        expect(screen.getByRole('tooltip')).toHaveTextContent('Add a new table to your schema');

        fireEvent.click(button);
        expect(setDisplayModalAddTable).toHaveBeenCalledWith(true);
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    it('lets users move onto the help, then closes it when they leave', async () => {
        const { unmount } = renderWithProviders(<ErdControls erdRendering={{ fullConnect: false }} />);
        const button = document.getElementById('zoom-in');
        fireEvent.mouseOver(button);
        const help = await screen.findByRole('tooltip');
        fireEvent.mouseOut(button, { relatedTarget: help });
        fireEvent.mouseEnter(help);
        expect(help).toBeInTheDocument();
        fireEvent.mouseLeave(help);
        await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());

        fireEvent.mouseOver(button);
        unmount();
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    it('explains the next toggle action and updates the help when its state changes', () => {
        const erdRendering = { setHeaderActionsAlwaysVisible: vi.fn(), headerActionsAlwaysVisible: true };
        const { rerender } = renderWithProviders(<ErdTopControls erdRendering={erdRendering} viewMode="erd" toggleTheme={vi.fn()} isMinimapOpen={false} onMinimapOpenChange={vi.fn()} />);
        fireEvent.focus(screen.getByRole('button', { name: 'Show ERD minimap' }));
        expect(screen.getByRole('tooltip')).toHaveTextContent('Open an overview to navigate the diagram');

        rerender(<ErdTopControls erdRendering={erdRendering} viewMode="erd" toggleTheme={vi.fn()} isMinimapOpen={true} onMinimapOpenChange={vi.fn()} />);
        expect(screen.getByRole('button', { name: 'Hide ERD minimap' })).toBeInTheDocument();
        expect(screen.getByRole('tooltip')).toHaveTextContent('Hide the diagram overview');
        fireEvent.focus(screen.getByRole('button', { name: 'Toggle table header tools visibility' }));
        expect(screen.getByRole('tooltip')).toHaveTextContent('Show table tools only on hover');
    });

    it('closes help on toolbar scrolling and window resizing', async () => {
        renderWithProviders(<ErdControls erdRendering={{ fullConnect: false }} />);
        const button = document.getElementById('zoom-out');
        fireEvent.mouseOver(button);
        await screen.findByRole('tooltip');
        fireEvent.scroll(document.getElementById('erd-controls'));
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
        fireEvent.focus(button);
        vi.stubGlobal('innerWidth', window.innerWidth - 1);
        fireEvent.resize(window);
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    it('keeps help visible when an unrelated panel scrolls', async () => {
        renderWithProviders(<><div data-testid="other-panel" /><ErdControls erdRendering={{ fullConnect: false }} /></>);
        fireEvent.mouseOver(document.getElementById('fit-btn'));
        await screen.findByRole('tooltip');
        fireEvent.scroll(screen.getByTestId('other-panel'));
        expect(screen.getByRole('tooltip')).toHaveTextContent('Fit the whole diagram');
    });

    it('keeps help visible through canvas resize notifications without geometry changes', () => {
        renderWithProviders(<ErdControls erdRendering={{ fullConnect: false }} />);
        fireEvent.focus(document.getElementById('fit-btn'));
        fireEvent.resize(window);
        expect(screen.getByRole('tooltip')).toHaveTextContent('Fit the whole diagram');
    });

    it('stacks help above the trigger when neither side fits a tiny screen', async () => {
        vi.stubGlobal('innerWidth', 240);
        vi.stubGlobal('innerHeight', 200);
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
            return this.classList.contains('erd-control-help')
                ? { left: 0, top: 0, right: 224, bottom: 48, width: 224, height: 48 }
                : { left: 202, top: 152, right: 240, bottom: 190, width: 38, height: 38 };
        });
        renderWithProviders(<ErdControls erdRendering={{ fullConnect: false }} />);
        fireEvent.mouseOver(document.getElementById('fit-btn'));
        const help = await screen.findByRole('tooltip');
        expect(Number.parseFloat(help.style.left)).toBeGreaterThanOrEqual(8);
        expect(Number.parseFloat(help.style.left) + 224).toBeLessThanOrEqual(232);
        expect(Number.parseFloat(help.style.top) + 48).toBeLessThanOrEqual(142);
    });
});
