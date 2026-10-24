// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SampleDataDialog from '@/features/data-view/components/SampleDataDialog';
import { inspectSampleSchema } from '@/features/data-view/lib/sampleData';

const { workers, workerOptions } = vi.hoisted(() => ({ workers: [], workerOptions: { inspect: true } }));
vi.mock('@/features/data-view/lib/sampleData.worker.js?worker', () => ({ default: class {
    constructor() { workers.push(this); }
    postMessage = vi.fn(data => {
        if (data.type === 'inspect' && workerOptions.inspect) this.onmessage({ data: { type: 'schema', model: inspectSampleSchema(data.sql, data.dialect) } });
    }); terminate = vi.fn();
} }));

const SQL = "CREATE TABLE users(id INT PRIMARY KEY, name TEXT, age INT CHECK(age >= 18), state TEXT CHECK(state IN ('active','pending')));";
const RESULT = { sql: 'INSERT INTO users(id) VALUES(1);', totalRows: 1, previews: [{ name: 'users', count: 1, columns: ['id'], rows: [{ id: 1 }] }], notes: [] };

describe('sample data workbench', () => {
    beforeEach(() => { workers.length = 0; workerOptions.inspect = true; });
    it('configures columns, stages a worker preview and inserts only on explicit action', async () => {
        const user = userEvent.setup(); const onInsert = vi.fn(() => ({ ok: true })); const onClose = vi.fn();
        render(<SampleDataDialog sql={SQL} onClose={onClose} onInsert={onInsert} />);
        await user.click(screen.getByText('users', { exact: true }));
        expect(screen.getByLabelText('Values for users.state')).toHaveValue('active\npending');
        fireEvent.change(screen.getByLabelText('Rows for users'), { target: { value: '1' } });
        await user.selectOptions(screen.getByLabelText('Generator for users.name'), 'company');
        expect(screen.getByLabelText('Name dictionary').options).toHaveLength(27);
        await user.selectOptions(screen.getByLabelText('Name dictionary'), 'ja-JP');
        expect(workers).toHaveLength(1);
        expect(workers[0].postMessage).toHaveBeenCalledOnce();
        expect(workers[0].postMessage).toHaveBeenCalledWith({ type: 'inspect', sql: SQL, dialect: 'auto' });
        await user.click(screen.getByRole('button', { name: 'Generate preview' }));
        expect(onInsert).not.toHaveBeenCalled();
        expect(workers[0].postMessage).toHaveBeenCalledWith(expect.objectContaining({ sql: SQL, locale: 'ja-JP', tables: { users: expect.objectContaining({ count: '1', columns: { name: { generator: 'company' } } }) } }));
        act(() => workers[0].onmessage({ data: { type: 'result', result: RESULT } }));
        expect(screen.getByRole('table', { name: 'Generated sample rows' })).toBeVisible();
        await user.click(screen.getByRole('button', { name: 'Insert into SQL tab' }));
        expect(onInsert).toHaveBeenCalledWith(RESULT.sql); expect(onClose).toHaveBeenCalledOnce();
    });
    it('mounts column controls only for expanded tables and preserves edited settings', async () => {
        const user = userEvent.setup();
        render(<SampleDataDialog sql={SQL} onClose={vi.fn()} onInsert={vi.fn()} />);
        expect(screen.queryByLabelText('Generator for users.name')).not.toBeInTheDocument();
        const summary = screen.getByText('users', { exact: true });
        await user.click(summary);
        await user.selectOptions(await screen.findByLabelText('Generator for users.name'), 'company');
        await user.click(summary);
        expect(screen.queryByLabelText('Generator for users.name')).not.toBeInTheDocument();
        await user.click(summary);
        expect(await screen.findByLabelText('Generator for users.name')).toHaveValue('company');
    });
    it.each(['constructor', '__proto__', 'toString'])('initializes and preserves settings for the SQL table %s', async name => {
        const user = userEvent.setup();
        const sql = `CREATE TABLE "${name}"(id INT PRIMARY KEY, title TEXT);`;
        render(<SampleDataDialog sql={sql} onClose={vi.fn()} onInsert={vi.fn()} />);
        expect(screen.getByRole('button', { name: 'Generate preview' })).toBeEnabled();
        await user.click(screen.getByText(name, { exact: true }));
        expect(screen.getByLabelText(`Generate rows for ${name}`)).toBeChecked();
        fireEvent.change(screen.getByLabelText(`Rows for ${name}`), { target: { value: '3' } });
        await user.selectOptions(screen.getByLabelText(`Generator for ${name}.title`), 'company');
        await user.selectOptions(screen.getByLabelText('SQL dialect'), 'postgres');
        expect(screen.getByLabelText(`Rows for ${name}`)).toHaveValue(3);
        expect(screen.getByLabelText(`Generator for ${name}.title`)).toHaveValue('company');
        await user.click(screen.getByRole('button', { name: 'Generate preview' }));
        const message = workers[1].postMessage.mock.calls.at(-1)[0];
        expect(Object.hasOwn(message.tables, name)).toBe(true);
        expect(message.tables[name]).toEqual({ enabled: true, count: '3', columns: { title: { generator: 'company' } } });
    });
    it('keeps inspection asynchronous, ignores replaced workers and terminates on close', () => {
        workerOptions.inspect = false;
        const view = render(<SampleDataDialog sql={SQL} onClose={vi.fn()} onInsert={vi.fn()} />);
        expect(screen.getByRole('status')).toHaveTextContent('Inspecting SQL schema');
        expect(screen.getByLabelText('Repeatable seed')).toHaveFocus();
        expect(screen.getByRole('button', { name: 'Generate preview' })).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Rows for all tables'), { target: { value: '12' } });
        fireEvent.change(screen.getByLabelText('SQL dialect'), { target: { value: 'mysql' } });
        expect(workers[0].terminate).toHaveBeenCalledOnce();
        act(() => workers[0].onmessage({ data: { type: 'schema', model: inspectSampleSchema('CREATE TABLE stale(id INT);') } }));
        expect(screen.queryByText('stale', { exact: true })).not.toBeInTheDocument();
        act(() => workers[1].onmessage({ data: { type: 'schema', model: inspectSampleSchema(SQL, 'mysql') } }));
        expect(screen.getByRole('button', { name: 'Generate preview' })).toBeEnabled();
        expect(screen.getByText('12', { exact: true })).toBeInTheDocument();
        view.unmount();
        expect(workers[1].terminate).toHaveBeenCalledOnce();
    });
    it('reuses the open worker for regeneration and restarts after cancellation', async () => {
        const user = userEvent.setup();
        const view = render(<SampleDataDialog sql={SQL} onClose={vi.fn()} onInsert={vi.fn()} />);
        await user.click(screen.getByRole('button', { name: 'Generate preview' }));
        act(() => workers[0].onmessage({ data: { type: 'result', result: RESULT } }));
        expect(workers[0].terminate).not.toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Regenerate' }));
        expect(workers).toHaveLength(1);
        await user.click(screen.getByRole('button', { name: 'Cancel generation' }));
        await user.click(screen.getByRole('button', { name: 'Generate preview' }));
        expect(workers).toHaveLength(2);
        expect(workers[1].postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'generate', sql: SQL }));
        view.unmount(); expect(workers[1].terminate).toHaveBeenCalledOnce();
    });
    it('invalidates generated results when settings change and shows stale-insert feedback', async () => {
        const user = userEvent.setup(); const onClose = vi.fn();
        render(<SampleDataDialog sql={SQL} onClose={onClose} onInsert={() => ({ ok: false, message: 'SQL changed; reopen the generator.' })} />);
        await user.click(screen.getByRole('button', { name: 'Generate preview' }));
        act(() => workers[0].onmessage({ data: { type: 'result', result: RESULT } }));
        await user.click(screen.getByRole('button', { name: 'Insert into SQL tab' }));
        expect(screen.getByRole('alert')).toHaveTextContent('SQL changed'); expect(onClose).not.toHaveBeenCalled();
        fireEvent.change(screen.getByLabelText('Repeatable seed'), { target: { value: 'new seed' } });
        expect(screen.queryByRole('button', { name: 'Insert into SQL tab' })).not.toBeInTheDocument();
    });
    it('cancels generation, contains keyboard focus and restores the trigger', async () => {
        const user = userEvent.setup(); const onClose = vi.fn();
        const trigger = document.createElement('button'); trigger.textContent = 'Open generator'; document.body.appendChild(trigger); trigger.focus();
        const view = render(<SampleDataDialog sql={SQL} onClose={onClose} onInsert={vi.fn()} />);
        expect(screen.getByLabelText('Repeatable seed')).toHaveFocus();
        await user.click(screen.getByRole('button', { name: 'Generate preview' }));
        expect(screen.getByLabelText('Repeatable seed')).toBeDisabled();
        await user.click(screen.getByRole('button', { name: 'Cancel generation' }));
        expect(workers[0].terminate).toHaveBeenCalled();
        act(() => workers[0].onmessage({ data: { type: 'result', result: RESULT } }));
        expect(screen.queryByRole('button', { name: 'Insert into SQL tab' })).not.toBeInTheDocument();
        await user.keyboard('{Escape}'); expect(onClose).toHaveBeenCalledOnce();
        view.unmount(); expect(trigger).toHaveFocus(); trigger.remove();
    });
    it('blocks invalid counts and existing SQL errors', () => {
        const view = render(<SampleDataDialog sql={SQL} onClose={vi.fn()} onInsert={vi.fn()} />);
        fireEvent.change(screen.getByLabelText('Rows for all tables'), { target: { value: '5001' } });
        expect(screen.getByRole('button', { name: 'Generate preview' })).toBeDisabled();
        view.unmount();
        render(<SampleDataDialog sql="" onClose={vi.fn()} onInsert={vi.fn()} />);
        expect(screen.getByRole('alert')).toHaveTextContent('CREATE TABLE');
        expect(screen.getByRole('alert')).toHaveTextContent('make unrelated data tabs inactive');
        expect(screen.getByRole('button', { name: 'Generate preview' })).toBeDisabled();
    });
});
