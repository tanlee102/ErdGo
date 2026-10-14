// @vitest-environment jsdom
import React, { useContext, useRef, useState } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AddTable } from '@/components/AddTable';
import Modal from '@/components/Modal';
import { RootLayoutContext } from '@/contexts/RootLayoutContext';
import { sqlToErdSchema } from '@/lib/erdJsonSchema';
import { renderWithProviders } from '../../utils/uiTestUtils.jsx';

function Dialog() {
    const outer = useContext(RootLayoutContext); const [open, setOpen] = useState(true); const close = useRef(null);
    return <RootLayoutContext.Provider value={{ ...outer, displayModalAddTable: open, setDisplayModalAddTable: setOpen }}>
        <button onClick={() => setOpen(true)}>Open table form</button>
        <Modal title="Add Table" displayModal={open} setDisplayModal={setOpen} onRequestClose={() => close.current?.()} body={<AddTable closeRequestRef={close} />} />
    </RootLayoutContext.Provider>;
}
function setup(sqlInput = '', extra = {}, wrapped = false) {
    return renderWithProviders(wrapped ? <Dialog /> : <AddTable />, { layout: { sqlInput, schemaRef: { current: sqlToErdSchema(sqlInput) }, displayModalAddTable: true, ...extra } });
}
async function fill(user, table = 'child', type = 'INTEGER', column = 'pid') {
    // Paste complete fixture values; per-key validation is covered separately.
    // This avoids unfinished typing spilling into another test under CPU load.
    for (const [placeholder, value] of [['users', table], ['column_name', column], ['data type', type]]) {
        if (!value) continue;
        const field = screen.getByPlaceholderText(placeholder);
        await user.click(field); await user.paste(value);
        expect(field).toHaveValue(value);
    }
}
describe('Add Table production workflow', () => {
    beforeEach(() => localStorage.clear());
    it('supports keyboard database choices and only puts the selected radio in the tab order', async () => {
        const user = userEvent.setup(); setup();
        const radios = screen.getAllByRole('radio'); const selected = radios.find(r => r.getAttribute('aria-checked') === 'true');
        selected.focus(); await user.keyboard('{End}'); expect(radios.at(-1)).toHaveFocus(); expect(radios.at(-1)).toHaveAttribute('aria-checked', 'true');
        expect(radios.filter(r => r.tabIndex === 0)).toEqual([radios.at(-1)]);
        await user.keyboard('{Home}'); expect(radios[0]).toHaveFocus(); expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    });
    it('filters references to compatible complete keys and preserves an invalidated choice for correction', async () => {
        const user = userEvent.setup(); setup('CREATE TABLE parent(id INTEGER PRIMARY KEY, note TEXT UNIQUE, plain INTEGER); CREATE TABLE compound(a INTEGER,b INTEGER,PRIMARY KEY(a,b));');
        await fill(user); await user.click(screen.getByRole('button', { name: 'Options for column pid' }));
        const table = await screen.findByRole('combobox', { name: 'Reference table' });
        expect(within(table).getAllByRole('option').map(o => o.value)).toEqual(['', 'parent']);
        await user.selectOptions(table, 'parent');
        const field = screen.getByRole('combobox', { name: 'Reference column' });
        expect(within(field).getAllByRole('option').map(o => o.value)).toEqual(['', 'id']);
        await user.selectOptions(field, 'id');
        await user.click(screen.getByRole('button', { name: 'Options for column pid' }));
        await user.clear(screen.getByPlaceholderText('data type')); await user.type(screen.getByPlaceholderText('data type'), 'TEXT');
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('foreign-key types must match'));
        await user.click(screen.getByRole('button', { name: 'Options for column pid' }));
        expect(await screen.findByRole('combobox', { name: 'Reference column' })).toHaveValue('id');
        expect(screen.getByRole('option', { name: 'id · unavailable' })).toBeDisabled();
        await user.click(screen.getByTitle('Clear foreign key'));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Insert into SQL' })).toBeEnabled());
    });
    it('does not fall back to replacing combined SQL when the tab operation rejects insertion', async () => {
        const user = userEvent.setup(); const run = vi.fn(name => name === 'appendSqlToActiveTab' ? false : undefined);
        const { layoutValue } = setup('', { runSqlTabOperation: run }); await fill(user);
        await waitFor(() => expect(screen.getByRole('button', { name: 'Insert into SQL' })).toBeEnabled());
        await user.click(screen.getByRole('button', { name: 'Insert into SQL' }));
        expect(layoutValue.setSqlInput).not.toHaveBeenCalled(); expect(layoutValue.setDisplayModalAddTable).not.toHaveBeenCalled();
        expect(screen.getByPlaceholderText('users')).toHaveValue('child'); expect(screen.getByRole('alert')).toHaveTextContent('SQL changed');
    });
    it('revalidates live SQL at submit and retains the draft when a table appeared meanwhile', async () => {
        const user = userEvent.setup(); let beforeSql = '';
        const run = vi.fn(name => name === 'getAddTableContext' ? { beforeSql, afterSql: '', revision: 'live' } : undefined);
        setup('', { runSqlTabOperation: run }); await fill(user);
        await waitFor(() => expect(screen.getByRole('button', { name: 'Insert into SQL' })).toBeEnabled());
        beforeSql = 'CREATE TABLE child(id INTEGER);'; await user.click(screen.getByRole('button', { name: 'Insert into SQL' }));
        expect(run).not.toHaveBeenCalledWith('appendSqlToActiveTab', expect.anything(), expect.anything());
        expect(screen.getByPlaceholderText('users')).toHaveValue('child'); expect(screen.getAllByRole('alert').some(alert => alert.textContent.includes('already exists'))).toBe(true);
    });
    it('keeps an invalid generated expression editable and enables insertion after correcting its reference', async () => {
        const user = userEvent.setup(); const run = vi.fn(name => name === 'appendSqlToActiveTab' ? true : undefined);
        setup('', { runSqlTabOperation: run }); await user.click(screen.getByRole('radio', { name: 'SQLite', exact: true })); await fill(user, 'child', 'INTEGER', 'id');
        await user.click(screen.getByRole('button', { name: '+ Add Column' }));
        for (const [placeholder, value] of [['column_name', 'total'], ['data type', 'INTEGER']]) { await user.click(screen.getAllByPlaceholderText(placeholder)[1]); await user.paste(value); }
        await user.click(screen.getByRole('button', { name: 'Options for column total' }));
        const expression = screen.getByPlaceholderText('expression — e.g. price * qty');
        await user.click(expression); await user.paste('child.id + 1');
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('unqualified'));
        expect(screen.getByRole('button', { name: 'Insert into SQL' })).toBeDisabled(); expect(expression).toHaveValue('child.id + 1');
        expect(run.mock.calls.some(([name]) => name === 'appendSqlToActiveTab')).toBe(false);
        await user.clear(expression); await user.paste('id + 1');
        await waitFor(() => expect(screen.getByRole('button', { name: 'Insert into SQL' })).toBeEnabled());
        await user.click(screen.getByRole('button', { name: 'Insert into SQL' }));
        expect(run).toHaveBeenCalledWith('appendSqlToActiveTab', expect.stringContaining('total INTEGER GENERATED ALWAYS AS (id + 1) STORED'));
    });
    it('auto-increment works without a manually supplied type and prevents repeated submit events', async () => {
        const user = userEvent.setup(); const run = vi.fn(name => name === 'appendSqlToActiveTab' ? true : undefined);
        setup('', { runSqlTabOperation: run }); await fill(user, 'automatic', '', 'id');
        await user.click(screen.getByRole('button', { name: 'Options for column id' })); await user.click(screen.getByLabelText(/AUTO-INCREMENT/));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Insert into SQL' })).toBeEnabled());
        const form = screen.getByRole('button', { name: 'Insert into SQL' }).closest('form'); fireEvent.submit(form); fireEvent.submit(form);
        expect(run.mock.calls.filter(([name]) => name === 'appendSqlToActiveTab')).toHaveLength(1);
        expect(run).toHaveBeenCalledWith('appendSqlToActiveTab', expect.stringContaining('INTEGER PRIMARY KEY AUTOINCREMENT'));
    });
    it('keeps options attached to the original column when rows are moved', async () => {
        const user = userEvent.setup(); setup(); await fill(user, 'moved', 'INTEGER', 'first');
        await user.click(screen.getByRole('button', { name: 'Options for column first' })); await user.click(screen.getByLabelText('NOT NULL'));
        await user.click(screen.getByRole('button', { name: '+ Add Column' }));
        const names = screen.getAllByPlaceholderText('column_name'); await user.type(names[1], 'second');
        await user.click(screen.getAllByRole('button', { name: 'Move column down' })[0]);
        expect(screen.queryByRole('dialog', { name: 'Options for column first' })).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Options for column first' })); expect(screen.getByLabelText('NOT NULL')).toBeChecked();
        await user.click(screen.getByRole('button', { name: 'Options for column second' })); expect(screen.getByLabelText('NOT NULL')).not.toBeChecked();
    });
    it('closes options on the first Escape, then reviews all draft changes before closing the form', async () => {
        const user = userEvent.setup(); setup('', {}, true);
        expect(screen.getByPlaceholderText('users')).toHaveFocus();
        await user.click(screen.getByRole('button', { name: 'Options for column 1' })); await user.click(screen.getByLabelText('NOT NULL'));
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).not.toBeInTheDocument();
        expect(screen.queryByRole('dialog', { name: 'Options for column new column' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Options for column 1' })).toHaveFocus();
        await user.keyboard('{Escape}'); const confirmation = screen.getByRole('dialog', { name: 'Discard changes?' });
        await user.click(within(confirmation).getByRole('button', { name: 'Cancel', exact: true }));
        await user.click(screen.getByRole('button', { name: 'Close Add Table' }));
        await user.click(within(screen.getByRole('dialog', { name: 'Discard changes?' })).getByRole('button', { name: 'Discard' }));
        expect(screen.queryByRole('dialog', { name: 'Add Table', exact: true })).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Open table form' })); await user.click(screen.getByRole('button', { name: 'Options for column 1' }));
        expect(screen.getByLabelText('NOT NULL')).not.toBeChecked();
    });
    it('checks IF NOT EXISTS-only drafts on backdrop dismissal', async () => {
        const user = userEvent.setup(); setup('', {}, true); await user.click(screen.getByLabelText('IF NOT EXISTS'));
        fireEvent.click(document.querySelector('.modal'));
        expect(screen.getByRole('dialog', { name: 'Discard changes?' })).toBeInTheDocument();
    });
    it('supports self-reference choices without showing unsupported SQL Server actions', async () => {
        const user = userEvent.setup(); setup(); await user.click(screen.getByRole('radio', { name: 'MSSQL' }));
        await fill(user, 'tree', 'INT', 'id'); await user.click(screen.getByRole('button', { name: 'Options for column id' })); await user.click(screen.getByLabelText('PRIMARY KEY'));
        await user.click(screen.getByRole('button', { name: '+ Add Column' })); await user.type(screen.getAllByPlaceholderText('column_name')[1], 'parent_id'); await user.type(screen.getAllByPlaceholderText('data type')[1], 'INT');
        await user.click(screen.getByRole('button', { name: 'Options for column parent_id' })); await user.selectOptions(await screen.findByRole('combobox', { name: 'Reference table' }), 'tree'); await user.selectOptions(screen.getByRole('combobox', { name: 'Reference column' }), 'id');
        expect(within(screen.getByRole('combobox', { name: 'On delete' })).queryByRole('option', { name: 'ON DELETE RESTRICT' })).not.toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Insert into SQL' })).toBeEnabled());
    });
});
