// @vitest-environment jsdom
import React from 'react';
import { Blob as NodeBlob } from 'node:buffer';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ErdExportDialog from '@/features/editor/components/ErdExportDialog';
import { downloadErdExport } from '@/features/editor/lib/erdExport';
import { jsPDF } from 'jspdf';

vi.mock('jspdf', () => ({ jsPDF: vi.fn(function () { this.addImage = vi.fn(); this.save = vi.fn().mockResolvedValue(undefined); }) }));
const preset = { id: '4k', minWidth: 3840, minHeight: 2160, scale: 4 };
const snapshot = { dataUrl: 'data:image/png;base64,abc', width: 3840, height: 2160 };
let anchorClick;
beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('export file correctness', () => {
    it('preserves the original PDF pixel units and image dimensions', async () => {
        await downloadErdExport({ erdRendering: { exportPng: () => snapshot }, preset, format: 'pdf', scope: 'diagram' });
        expect(jsPDF).toHaveBeenLastCalledWith({ unit: 'px', orientation: 'landscape', format: [3840, 2160], compress: true });
        const pdf = jsPDF.mock.instances.at(-1);
        expect(pdf.addImage).toHaveBeenCalledWith(snapshot.dataUrl, 'PNG', 0, 0, 3840, 2160, undefined, 'FAST');
        expect(pdf.save).toHaveBeenCalledWith(expect.stringMatching(/-4k\.pdf$/));
    });
    it('preserves the original SVG filter and releases the download URL', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('Blob', NodeBlob);
        const create = vi.fn(() => 'blob:export');
        const revoke = vi.fn();
        vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
        await downloadErdExport({ erdRendering: { exportPng: () => snapshot }, preset, format: 'svg', scope: 'diagram' });
        const blob = create.mock.calls[0][0];
        const text = await blob.text();
        expect(text).toContain('viewBox="0 0 3840 2160"');
        expect(text).toContain(snapshot.dataUrl);
        expect(text).toContain('filter="url(#sharpen)"');
        expect(text).toContain('fill="#FFFFFF"');
        expect(anchorClick).toHaveBeenCalledTimes(1);
        expect(document.querySelector('a[download]')).toBeNull();
        await vi.runAllTimersAsync();
        expect(revoke).toHaveBeenCalledWith('blob:export');
    });
    it('reports an unavailable full-diagram snapshot instead of substituting a cropped viewport', async () => {
        await expect(downloadErdExport({ erdRendering: { exportPng: () => null }, preset, format: 'png', scope: 'diagram' })).rejects.toThrow(/not available/);
        expect(anchorClick).not.toHaveBeenCalled();
    });
    it('preserves the original visible-canvas fallback for current-view exports', async () => {
        const canvas = document.createElement('canvas');
        canvas.id = 'erd-canvas';
        canvas.toDataURL = vi.fn(() => snapshot.dataUrl);
        document.body.appendChild(canvas);
        await downloadErdExport({ erdRendering: { exportPng: () => null }, preset, format: 'png' });
        expect(canvas.toDataURL).toHaveBeenCalledWith('image/png', 1.0);
        expect(anchorClick).toHaveBeenCalledTimes(1);
        canvas.remove();
    });
});

describe('export dialog', () => {
    it('keeps failures visible, supports retry and blocks duplicate exports', async () => {
        const user = userEvent.setup();
        const exportPng = vi.fn().mockReturnValueOnce(null).mockReturnValue({ ...snapshot, width: 2560, height: 1440 });
        const onClose = vi.fn();
        render(<ErdExportDialog erdRendering={{ exportPng }} onClose={onClose} />);
        expect(screen.getByLabelText('Capture area')).toHaveValue('viewport');
        expect(screen.queryByRole('radio', { name: /Auto/ })).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Download PNG' }));
        expect(await screen.findByRole('alert')).toHaveTextContent(/not available/);
        expect(onClose).not.toHaveBeenCalled();
        const button = screen.getByRole('button', { name: 'Download PNG' });
        fireEvent.click(button);
        fireEvent.click(button);
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        expect(exportPng).toHaveBeenCalledTimes(2);
        expect(exportPng).toHaveBeenLastCalledWith({ minWidth: 2560, minHeight: 1440, scale: 3, maxSize: 8192 });
        expect(anchorClick).toHaveBeenCalledTimes(1);
    });
    it('discloses raster formats and supports optional entire-diagram capture', async () => {
        const user = userEvent.setup();
        const exportPng = vi.fn(() => ({ ...snapshot, width: 1280, height: 720 }));
        render(<ErdExportDialog erdRendering={{ exportPng }} onClose={vi.fn()} />);
        await user.click(screen.getByRole('radio', { name: /SVG/ }));
        expect(screen.getByText(/not editable vector shapes/)).toBeVisible();
        await user.click(screen.getByRole('radio', { name: /PDF/ }));
        expect(screen.getByText(/Text is not selectable/)).toBeVisible();
        await user.click(screen.getByRole('radio', { name: /HD/ }));
        await user.selectOptions(screen.getByLabelText('Capture area'), 'diagram');
        await user.click(screen.getByRole('button', { name: 'Download PDF' }));
        await waitFor(() => expect(exportPng).toHaveBeenCalledWith({ minWidth: 1280, minHeight: 720, scale: 2, maxSize: 8192, scope: 'diagram' }));
    });
    it('handles native Escape cancellation and restores focus on unmount', () => {
        const trigger = document.createElement('button');
        document.body.appendChild(trigger);
        trigger.focus();
        const onClose = vi.fn();
        const { unmount } = render(<ErdExportDialog erdRendering={{}} onClose={onClose} />);
        fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: false, cancelable: true }));
        expect(onClose).toHaveBeenCalledTimes(1);
        unmount();
        expect(trigger).toHaveFocus();
        trigger.remove();
    });
});
