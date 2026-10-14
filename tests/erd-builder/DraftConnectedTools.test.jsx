// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DraftConnectedTools from '@/features/erd-draft/components/DraftConnectedTools';

const node = { id: 'customer', data: { shape: 'entity', label: 'Customer' } };

describe('Connected shape forms', () => {
    it('preserves separate unfinished names when changing modes or reselecting the active mode', () => {
        render(<DraftConnectedTools node={node} nodes={[node]} onCreate={() => true} />);
        fireEvent.change(screen.getByLabelText('Attribute name'), { target: { value: 'phone' } });
        fireEvent.click(screen.getByRole('button', { name: 'Attribute', exact: true }));
        expect(screen.getByLabelText('Attribute name')).toHaveValue('phone');
        fireEvent.click(screen.getByRole('button', { name: 'Relationship', exact: true }));
        fireEvent.change(screen.getByLabelText('Relationship name'), { target: { value: 'places' } });
        fireEvent.click(screen.getByRole('button', { name: 'Attribute', exact: true }));
        expect(screen.getByLabelText('Attribute name')).toHaveValue('phone');
        fireEvent.click(screen.getByRole('button', { name: 'Relationship', exact: true }));
        expect(screen.getByLabelText('Relationship name')).toHaveValue('places');
    });
    it('creates an attribute from Enter and clears the name for the next attribute', () => {
        const onCreate = vi.fn(() => true);
        render(<DraftConnectedTools node={node} nodes={[node]} onCreate={onCreate} />);
        expect(screen.getByRole('button', { name: 'Add connected attribute' })).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Attribute name'), { target: { value: 'customer_id' } });
        fireEvent.change(screen.getByLabelText('Attribute type'), { target: { value: 'keyAttribute' } });
        fireEvent.submit(screen.getByLabelText('Attribute name').closest('form'));
        expect(onCreate).toHaveBeenCalledWith({ ownerId: 'customer', shape: 'keyAttribute', label: 'customer_id' });
        expect(screen.getByLabelText('Attribute name')).toHaveValue('');
    });

    it('requires a new entity name, supports existing targets and retains a rejected edit', () => {
        const onCreate = vi.fn(() => false);
        render(<DraftConnectedTools node={node} nodes={[node]} onCreate={onCreate} />);
        fireEvent.click(screen.getByRole('button', { name: 'Relationship', exact: true }));
        fireEvent.change(screen.getByLabelText('Relationship name'), { target: { value: 'supervises' } });
        expect(screen.getByRole('button', { name: 'Create relationship' })).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Related entity'), { target: { value: 'customer' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create relationship' }));
        expect(onCreate).toHaveBeenCalledWith({ ownerId: 'customer', shape: 'relationship', relationshipLabel: 'supervises', targetId: 'customer', entityLabel: '' });
        expect(screen.getByLabelText('Relationship name')).toHaveValue('supervises');
    });
});
