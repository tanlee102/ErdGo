// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DraftSelectionTools from '@/features/erd-draft/components/DraftSelectionTools';

afterEach(cleanup);
const nodes = [
    { id: 'a', selected: true, data: { shape: 'entity', label: 'Patient', description: 'Medical record', positionLocked: true } },
    { id: 'b', selected: true, data: { shape: 'relationship', label: 'Treats' } },
];

describe('Builder selection tools', () => {
    it('finds labels, types, and descriptions, and focuses the chosen identity', () => {
        const onFocus = vi.fn();
        render(<DraftSelectionTools nodes={nodes} selectionCount={2} onFocus={onFocus} />);
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'medical' } });
        fireEvent.click(screen.getByRole('button', { name: 'Patient entity' }));
        expect(onFocus).toHaveBeenCalledWith('a');
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'RELATIONSHIP' } });
        expect(screen.getByRole('button', { name: 'Treats relationship' })).toBeInTheDocument();
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'absent' } });
        expect(screen.getByText('0 matches')).toBeInTheDocument();
    });

    it('protects read-only files and enables alignment only for enough unlocked shapes', () => {
        const props = { nodes, selectionCount: 2, onLock: vi.fn() };
        const { rerender } = render(<DraftSelectionTools {...props} />);
        fireEvent.click(screen.getByText('Selection actions (2)'));
        expect(screen.getByRole('button', { name: 'Align left' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Paste' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Lock positions' }));
        expect(props.onLock).toHaveBeenCalledWith(true);
        rerender(<DraftSelectionTools {...props} readOnly />);
        expect(screen.queryByRole('button', { name: 'Delete selected' })).not.toBeInTheDocument();
        expect(screen.getByRole('searchbox')).toBeEnabled();
    });
});
