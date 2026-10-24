// @vitest-environment jsdom
/** Group editing preserves table identities and keeps all changes behind an explicit save. */
import React, { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ErdTableGroupsControl from '@/features/editor/components/ErdTableGroupsControl';
import ErdControls from '@/features/editor/components/ErdControls';
import { renderWithProviders } from '../../utils/uiTestUtils.jsx';

const tables = [{ name: 'users' }, { name: 'orders' }, { name: 'invoices' }];
const accounts = { id: 'accounts', name: 'Accounts', tableNames: ['users', 'missing_table'], color: '#3b82f6' };
const sales = { id: 'sales', name: 'Sales', tableNames: ['orders', 'invoices'], color: '#14b8a6' };

function setup({ groups = [], selectedTableName, ...overrides } = {}) {
    const update = vi.fn();
    function Harness() {
        const [current, setCurrent] = useState(groups);
        return <ErdTableGroupsControl controller={{ groups: current, tables, selectedTableName, disabled: false, update: (next) => { update(next); setCurrent(next); return true; }, ...overrides }} />;
    }
    const view = render(<Harness />);
    return { ...view, update, user: userEvent.setup() };
}

describe('SQL table-group controls', () => {
    it('is absent from canvases without the SQL group controller', () => {
        renderWithProviders(<ErdControls erdRendering={{ fullConnect: false }} />);
        expect(screen.queryByRole('button', { name: 'Table groups' })).not.toBeInTheDocument();
    });

    it('creates a named colored group with the selected table and saves only on submit', async () => {
        const { user, update } = setup({ selectedTableName: 'users' });
        await user.click(screen.getByRole('button', { name: 'Table groups' }));
        await user.click(screen.getByRole('button', { name: 'New group' }));
        expect(screen.getByRole('textbox', { name: 'Group name' })).toHaveFocus();
        expect(screen.getByRole('checkbox', { name: 'Include users' })).toBeChecked();
        await user.type(screen.getByRole('textbox', { name: 'Group name' }), 'Identity');
        await user.click(screen.getByRole('checkbox', { name: 'Include orders' }));
        await user.click(screen.getByRole('button', { name: 'Group color #8b5cf6' }));
        expect(update).not.toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Create group' }));
        expect(update).toHaveBeenCalledWith([expect.objectContaining({ name: 'Identity', color: '#8b5cf6', tableNames: ['users', 'orders'] })]);
        expect(screen.getByRole('button', { name: /Identity 2 tables/ })).toBeInTheDocument();
    });

    it('requires a name and at least one table without silently creating empty groups', async () => {
        const { user, update } = setup();
        await user.click(screen.getByRole('button', { name: 'Table groups' }));
        await user.click(screen.getByRole('button', { name: 'New group' }));
        await user.click(screen.getByRole('button', { name: 'Create group' }));
        expect(screen.getByRole('alert')).toHaveTextContent('Give this group a name.');
        await user.type(screen.getByRole('textbox', { name: 'Group name' }), 'Accounts');
        await user.click(screen.getByRole('button', { name: 'Create group' }));
        expect(screen.getByRole('alert')).toHaveTextContent('Choose at least one table.');
        expect(update).not.toHaveBeenCalled();
    });

    it('preserves unavailable members and makes moves from another group explicit', async () => {
        const { user, update } = setup({ groups: [accounts, sales] });
        await user.click(screen.getByRole('button', { name: 'Table groups' }));
        await user.click(screen.getByRole('button', { name: /Accounts 2 tables/ }));
        expect(screen.getByRole('checkbox', { name: 'Include missing_table' })).toBeChecked();
        expect(screen.getByText('Not in current SQL · retained in this group')).toBeInTheDocument();
        expect(screen.getAllByText('Move from Sales')).toHaveLength(2);
        await user.type(screen.getByRole('searchbox', { name: 'Find tables to group' }), 'orders');
        expect(screen.queryByRole('checkbox', { name: 'Include users' })).not.toBeInTheDocument();
        await user.click(screen.getByRole('checkbox', { name: 'Include orders' }));
        expect(screen.getByText('Selected tables move out of their current groups. Groups left empty are removed.')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Save group' }));
        expect(update).toHaveBeenCalledWith([{ ...accounts, tableNames: ['users', 'missing_table', 'orders'] }, { ...sales, tableNames: ['invoices'] }]);
    });

    it('ungroups without deleting tables and supports Escape and outside dismissal', async () => {
        const { user, update } = setup({ groups: [accounts, sales] });
        const trigger = screen.getByRole('button', { name: 'Table groups' });
        await user.click(trigger);
        await user.click(screen.getByRole('button', { name: /Accounts 2 tables/ }));
        await user.click(screen.getByRole('button', { name: 'Ungroup tables' }));
        expect(update).toHaveBeenCalledWith([sales]);
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
        await user.click(trigger);
        fireEvent.pointerDown(document.body);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('opens the requested canvas group and keeps drafts through context updates', async () => {
        const update = vi.fn(() => true);
        const request = { id: 'accounts', version: 1 };
        const controller = { groups: [accounts], tables, disabled: false, update, editRequest: request };
        const { rerender } = render(<ErdTableGroupsControl controller={controller} />);
        const user = userEvent.setup();
        const dialog = screen.getByRole('dialog', { name: 'Table groups' });
        await user.clear(within(dialog).getByRole('textbox', { name: 'Group name' }));
        await user.type(within(dialog).getByRole('textbox', { name: 'Group name' }), 'Changed name');
        rerender(<ErdTableGroupsControl controller={{ ...controller, groups: [{ ...accounts }] }} />);
        expect(screen.getByRole('textbox', { name: 'Group name' })).toHaveValue('Changed name');
        rerender(<ErdTableGroupsControl controller={{ ...controller, disabled: true }} />);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(update).not.toHaveBeenCalled();
    });

    it('keeps the open popup attached when its canvas toolbar scrolls', async () => {
        render(<div id="erd-controls"><ErdTableGroupsControl controller={{ groups: [], tables, disabled: false, update: vi.fn() }} /></div>);
        const trigger = screen.getByRole('button', { name: 'Table groups' });
        let anchorTop = 400;
        vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(() => ({ left: 900, right: 938, top: anchorTop, bottom: anchorTop + 38, width: 38, height: 38 }));
        await userEvent.setup().click(trigger);
        const popup = screen.getByRole('dialog', { name: 'Table groups' });
        Object.defineProperties(popup, { offsetWidth: { value: 320 }, offsetHeight: { value: 200 } });
        fireEvent(window, new Event('resize'));
        const previousTop = Number.parseFloat(popup.style.top);
        anchorTop -= 100;
        fireEvent.scroll(trigger.closest('#erd-controls'));
        expect(previousTop - Number.parseFloat(popup.style.top)).toBe(100);
        expect(popup.dataset.placement).toBe('left');
    });
});
