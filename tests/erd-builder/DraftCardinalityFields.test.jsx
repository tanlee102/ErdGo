// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DraftCardinalityFields from '@/features/erd-draft/components/DraftCardinalityFields';

afterEach(cleanup);
const data = { sourceMin: '0', sourceMax: '1', sourceRole: 'member' };
describe('cardinality editing transactions', () => {
    it('keeps empty and invalid input local until the whole range is valid', () => {
        const onChange = vi.fn();
        render(<DraftCardinalityFields end="source" data={data} mode="minmax" onChange={onChange} />);
        const minimum = screen.getByRole('textbox', { name: 'Minimum' });
        fireEvent.change(minimum, { target: { value: '' } });
        fireEvent.blur(minimum);
        expect(minimum).toHaveValue('');
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.getByRole('alert')).toHaveTextContent('not applied');
        fireEvent.change(minimum, { target: { value: '2' } });
        fireEvent.blur(minimum);
        expect(onChange).not.toHaveBeenCalled();
        const maximum = screen.getByRole('textbox', { name: 'Maximum' });
        fireEvent.change(maximum, { target: { value: '10' } });
        fireEvent.blur(maximum);
        expect(onChange).toHaveBeenCalledWith({ sourceMin: '2', sourceMax: '10', sourceRole: 'member' });
    });
    it('cancels on Escape, commits on Enter, and reflects undo or external changes', () => {
        const onChange = vi.fn();
        const { rerender } = render(<DraftCardinalityFields end="source" data={data} mode="minmax" onChange={onChange} />);
        const maximum = screen.getByRole('textbox', { name: 'Maximum' });
        fireEvent.change(maximum, { target: { value: '5' } });
        fireEvent.keyDown(maximum, { key: 'Escape' });
        fireEvent.blur(maximum);
        expect(maximum).toHaveValue('1');
        expect(onChange).not.toHaveBeenCalled();
        fireEvent.change(maximum, { target: { value: 'N' } });
        maximum.focus();
        fireEvent.keyDown(maximum, { key: 'Enter' });
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith({ ...data, sourceMax: 'N' });
        rerender(<DraftCardinalityFields end="source" data={{ ...data, sourceMax: '9' }} mode="minmax" onChange={onChange} />);
        expect(maximum).toHaveValue('9');
        rerender(<DraftCardinalityFields end="source" data={data} mode="minmax" onChange={onChange} />);
        expect(maximum).toHaveValue('1');
    });
    it('keeps invalid saved classic values visible for repair and disables public editing', () => {
        render(<DraftCardinalityFields end="source" data={{ ...data, sourceMax: 'BANANA' }} mode="classic" onChange={vi.fn()} readOnly />);
        expect(screen.getByRole('combobox', { name: 'Maximum cardinality' })).toHaveValue('BANANA');
        expect(screen.getByRole('combobox')).toBeDisabled();
        expect(screen.getByRole('alert')).toHaveTextContent('Classic cardinality');
    });
});
