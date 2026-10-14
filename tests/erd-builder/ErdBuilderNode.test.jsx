// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ErdDraftNode from '@/features/erd-draft/components/ErdDraftNode.jsx';
import ErdDraftNodeContext from '@/features/erd-draft/contexts/ErdDraftNodeContext.js';

const updateNodeInternals = vi.hoisted(() => vi.fn());
vi.mock('@xyflow/react', () => ({
    Handle: ({ id }) => <span data-testid={`handle-${id}`} />,
    Position: { Top: 'top', Right: 'right', Bottom: 'bottom', Left: 'left' },
    useUpdateNodeInternals: () => updateNodeInternals,
}));

afterEach(() => cleanup());

describe('ERD Builder Chen nodes', () => {
    it('hides attribute-count controls by default and only renders them after opting in', () => {
        const data = Object.freeze({ shape: 'entity', label: 'Customer', color: '#2389dd' });
        const onToggleAttributes = vi.fn();
        const context = { readOnly: true, attributesByOwner: new Map([['customer', ['id', 'name']]]), onToggleAttributes };
        const node = value => <ErdDraftNodeContext.Provider value={value}><ErdDraftNode id="customer" data={data} /></ErdDraftNodeContext.Provider>;
        const { rerender } = render(node(context));
        expect(screen.queryByRole('button', { name: /attributes of Customer/ })).not.toBeInTheDocument();
        rerender(node({ ...context, showAttributeCounts: true }));
        const collapse = screen.getByRole('button', { name: 'Collapse attributes of Customer' });
        expect(collapse).toHaveTextContent('− 2');
        fireEvent.click(collapse);
        expect(onToggleAttributes).toHaveBeenCalledWith('customer');
        rerender(node({ ...context, showAttributeCounts: true, showAttributes: false }));
        expect(screen.getByRole('button', { name: 'Expand attributes of Customer' })).toHaveTextContent('+ 2');
        rerender(node({ ...context, showAttributeCounts: false, showAttributes: false }));
        expect(screen.queryByRole('button', { name: /attributes of Customer/ })).not.toBeInTheDocument();
        expect(data).toEqual({ shape: 'entity', label: 'Customer', color: '#2389dd' });
    });

    it('refreshes custom handles after notation or label-visibility changes, tolerating unusual legacy IDs', () => {
        updateNodeInternals.mockClear();
        const data = { shape: 'isa', label: 'ISA', showLabel: false };
        const { rerender } = render(<ErdDraftNode id="isa" data={data} />);
        expect(updateNodeInternals).toHaveBeenCalledWith('isa');
        updateNodeInternals.mockClear();
        rerender(<ErdDraftNode id="isa" data={{ ...data, showLabel: true }} />);
        expect(updateNodeInternals).toHaveBeenCalledWith('isa');
        updateNodeInternals.mockClear();
        rerender(<ErdDraftNode id="isa" data={{ ...data, shape: 'category' }} />);
        expect(updateNodeInternals).toHaveBeenCalledWith('isa');
        updateNodeInternals.mockClear();
        rerender(<ErdDraftNode id={'legacy"id'} data={data} />);
        expect(updateNodeInternals).not.toHaveBeenCalled();
        expect(screen.getByText('d · partial')).toBeInTheDocument();
    });

    it('defaults labels to white and uses an explicit black choice independently of the fill', () => {
        const light = Object.freeze({ shape: 'attribute', label: 'name', color: '#98c45f' });
        const { container, rerender } = render(<ErdDraftNode data={light} />);
        expect(container.querySelector('.erd-draft-node')).toHaveStyle({ '--draft-node-label-color': '#ffffff', '--draft-node-color': '#98c45f' });
        rerender(<ErdDraftNode data={{ ...light, color: '#6558d3' }} />);
        expect(container.querySelector('.erd-draft-node')).toHaveStyle({ '--draft-node-label-color': '#ffffff' });
        rerender(<ErdDraftNode data={{ ...light, color: '#fff' }} />);
        expect(container.querySelector('.erd-draft-node')).toHaveStyle({ '--draft-node-label-color': '#ffffff' });
        rerender(<ErdDraftNode data={{ ...light, color: '#6558d3', labelTextColor: 'black' }} />);
        expect(container.querySelector('.erd-draft-node')).toHaveStyle({ '--draft-node-label-color': '#000000', '--draft-node-color': '#6558d3' });
        expect(light.color).toBe('#98c45f');
    });

    it('uses theme text for legacy notes and only applies manual colors when explicitly chosen', () => {
        const data = Object.freeze({ shape: 'note', label: 'Review consent', labelTextColor: 'white' });
        const { container, rerender } = render(<ErdDraftNode data={data} />);
        const root = () => container.querySelector('.erd-draft-node');
        expect(root()).toHaveStyle({ '--draft-node-label-color': 'var(--draft-note-theme-color)' });
        rerender(<ErdDraftNode data={{ ...data, noteTextColorMode: 'invalid', labelTextColor: 'black' }} />);
        expect(root()).toHaveStyle({ '--draft-node-label-color': 'var(--draft-note-theme-color)' });
        for (const [labelTextColor, color] of [['black', '#000000'], ['white', '#ffffff']]) {
            rerender(<ErdDraftNode data={{ ...data, noteTextColorMode: 'custom', labelTextColor }} />);
            expect(root()).toHaveStyle({ '--draft-node-label-color': color });
        }
        expect(data).toEqual({ shape: 'note', label: 'Review consent', labelTextColor: 'white' });
    });
    it('renders a partial-key discriminator with its dedicated notation class', () => {
        const { container } = render(<ErdDraftNode data={{ shape: 'partialKeyAttribute', label: 'Line number', color: '#98c45f' }} />);

        expect(screen.getByText('Line number')).toBeInTheDocument();
        expect(container.querySelector('.erd-draft-node--partialKeyAttribute')).toBeInTheDocument();
    });

    it('retains the identifying relationship inner diamond during inline editing and resizing', () => {
        const { container, rerender } = render(
            <ErdDraftNodeContext.Provider value={{ readOnly: false, onLabelChange: vi.fn() }}>
                <ErdDraftNode id="owns" data={{ shape: 'identifyingRelationship', label: 'Owns', color: '#f5662b' }} />
            </ErdDraftNodeContext.Provider>,
        );
        const polygon = () => container.querySelector('.erd-draft-identifying-outline polygon');
        const initial = polygon().getAttribute('points');
        fireEvent.doubleClick(screen.getByText('Owns'));
        expect(polygon()).toBeInTheDocument();
        fireEvent.change(screen.getByRole('textbox', { name: 'Edit Owns label' }), { target: { value: 'A much longer identifying relationship label' } });
        expect(polygon().getAttribute('points')).not.toBe(initial);
        rerender(<ErdDraftNode data={{ shape: 'relationship', label: 'Owns' }} />);
        expect(polygon()).toBeNull();
    });

    it('renders ISA constraints, a category union symbol, and an aggregation boundary', () => {
        const { rerender, container } = render(<ErdDraftNode data={{
            shape: 'isa',
            label: 'ISA',
            color: '#6558d3',
            specializationConstraint: 'overlapping',
            specializationCompleteness: 'total',
        }} />);

        expect(screen.getByText('o · total')).toBeInTheDocument();

        rerender(<ErdDraftNode data={{ shape: 'category', label: 'Owner', color: '#6558d3', categoryCompleteness: 'partial' }} />);
        expect(screen.getByText('U')).toBeInTheDocument();
        expect(screen.getByText('Owner')).toBeInTheDocument();
        expect(container.querySelector('.erd-draft-node--category')).toHaveStyle({ '--draft-size-scale': '1' });

        rerender(<ErdDraftNode data={{ shape: 'aggregation', label: 'Assignment', color: '#65758b' }} />);
        expect(screen.getByText('Aggregation')).toBeInTheDocument();
        expect(screen.getByText('Assignment')).toBeInTheDocument();
        expect(container.querySelector('.erd-draft-node--aggregation')).toBeInTheDocument();
    });

    it('hides ISA labels explicitly and preserves legacy whitespace without hiding constraints', () => {
        const { container, rerender } = render(<ErdDraftNode data={{ shape: 'isa', label: 'Account type', showLabel: false }} />);
        expect(container.querySelector('.erd-draft-node-label')).not.toBeInTheDocument();
        expect(screen.getByText('d · partial')).toBeInTheDocument();
        rerender(<ErdDraftNode data={{ shape: 'isa', label: ' ' }} />);
        expect(container.querySelector('.erd-draft-node-label')).not.toBeInTheDocument();
        rerender(<ErdDraftNode data={{ shape: 'isa', label: ' ', showLabel: true }} />);
        expect(screen.getByText('ISA')).toBeInTheDocument();
        rerender(<ErdDraftNode data={{ shape: 'isa', label: '' }} />);
        expect(screen.getByText('ISA')).toBeInTheDocument();
    });

    it('can edit a hidden ISA label by double-clicking its shape', () => {
        const onLabelChange = vi.fn();
        const { container } = render(
            <ErdDraftNodeContext.Provider value={{ readOnly: false, onLabelChange }}>
                <ErdDraftNode id="isa" data={{ shape: 'isa', label: 'Account type', showLabel: false }} />
            </ErdDraftNodeContext.Provider>,
        );
        fireEvent.doubleClick(container.querySelector('.erd-draft-node-shape'));
        const editor = screen.getByRole('textbox', { name: 'Edit Account type label' });
        fireEvent.change(editor, { target: { value: '' } });
        fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
        expect(onLabelChange).toHaveBeenCalledWith('isa', '');
    });

    it('renders saved note text alignment without changing legacy left alignment', () => {
        const { rerender, container } = render(
            <ErdDraftNode data={{ shape: 'note', label: 'Legacy note', color: '#65758b' }} />,
        );

        expect(container.querySelector('.erd-draft-node--note')).toHaveStyle({ '--draft-text-align': 'left' });

        rerender(<ErdDraftNode data={{ shape: 'note', label: 'Centered note', color: '#65758b', textAlign: 'center' }} />);
        expect(container.querySelector('.erd-draft-node--note')).toHaveStyle({ '--draft-text-align': 'center' });
    });

    it('edits a multiline node label in place and commits with Ctrl+Enter', () => {
        const onLabelChange = vi.fn();
        render(
            <ErdDraftNodeContext.Provider value={{ readOnly: false, onLabelChange }}>
                <ErdDraftNode id="customer" data={{ shape: 'entity', label: 'Customer', color: '#2389dd' }} />
            </ErdDraftNodeContext.Provider>,
        );

        fireEvent.doubleClick(screen.getByText('Customer'));
        const editor = screen.getByRole('textbox', { name: 'Edit Customer label' });
        fireEvent.change(editor, { target: { value: 'Account\nholder' } });
        fireEvent.keyDown(editor, { key: 'Enter' });
        expect(onLabelChange).not.toHaveBeenCalled();
        fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });

        expect(onLabelChange).toHaveBeenCalledOnce();
        expect(onLabelChange).toHaveBeenCalledWith('customer', 'Account\nholder');
    });

    it('cancels inline editing with Escape and never opens it for a read-only node', () => {
        const onLabelChange = vi.fn();
        const { rerender } = render(
            <ErdDraftNodeContext.Provider value={{ readOnly: false, onLabelChange }}>
                <ErdDraftNode id="note" data={{ shape: 'note', label: 'Design note', color: '#65758b' }} />
            </ErdDraftNodeContext.Provider>,
        );

        fireEvent.doubleClick(screen.getByText('Design note'));
        const editor = screen.getByRole('textbox', { name: 'Edit Design note label' });
        fireEvent.change(editor, { target: { value: 'Discard this text' } });
        fireEvent.keyDown(editor, { key: 'Escape' });
        expect(onLabelChange).not.toHaveBeenCalled();

        rerender(
            <ErdDraftNodeContext.Provider value={{ readOnly: true, onLabelChange }}>
                <ErdDraftNode id="note" data={{ shape: 'note', label: 'Design note', color: '#65758b' }} />
            </ErdDraftNodeContext.Provider>,
        );
        fireEvent.doubleClick(screen.getByText('Design note'));
        expect(screen.queryByRole('textbox', { name: 'Edit Design note label' })).not.toBeInTheDocument();
    });
});
