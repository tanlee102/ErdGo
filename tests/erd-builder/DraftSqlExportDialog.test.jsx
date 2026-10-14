// @vitest-environment jsdom
/** Conversion controls and keyboard containment before the route handoff. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DraftSqlExportDialog from '@/features/erd-draft/components/DraftSqlExportDialog';
import { healthcareDraft } from '@/features/erd-draft/data/draftTemplate';

const graph = {
    name: 'Accounts',
    nodes: [{ id: 'account', data: { shape: 'entity', label: 'Account' } }, { id: 'key', data: { shape: 'keyAttribute', label: 'id', domain: 'INT' } }],
    edges: [{ id: 'key', source: 'account', target: 'key' }],
};

describe('Builder SQL conversion dialog', () => {
    it('requires mapping before review and opens after both one-to-one choices without separate tables', () => {
        render(<DraftSqlExportDialog graph={healthcareDraft} onClose={vi.fn()} onOpenEditor={vi.fn()} />);
        const acknowledge = screen.getByRole('checkbox', { name: /I have reviewed/ });
        const separate = screen.getByRole('checkbox', { name: 'Prefer separate relationship tables', exact: true });
        const submit = screen.getByRole('button', { name: 'Open in SQL to ERD' });
        expect(acknowledge).toBeDisabled();
        expect(acknowledge).not.toBeChecked();
        expect(submit).toBeDisabled();
        expect(screen.getByRole('status')).toHaveTextContent('Complete 2 one-to-one mapping choices to continue.');
        expect(screen.getByLabelText('Mapping choices')).toHaveTextContent('Each one-to-one link can live in either table.');
        const generates = screen.getByRole('combobox', { name: 'generates: where should the one-to-one foreign key live?' });
        const has = screen.getByRole('combobox', { name: 'has: where should the one-to-one foreign key live?' });
        fireEvent.click(screen.getByRole('button', { name: 'Review mapping choices' }));
        expect(generates).toHaveFocus();
        expect(generates).toBeRequired();
        expect(generates).toHaveAttribute('aria-invalid', 'true');
        fireEvent.change(generates, { target: { value: '1' } });
        expect(screen.getByRole('status')).toHaveTextContent('Complete 1 one-to-one mapping choice to continue.');
        fireEvent.change(has, { target: { value: '0' } });
        expect(acknowledge).toBeEnabled();
        expect(screen.getByRole('status')).toHaveTextContent('Review the conversion notes and confirm the checkbox to continue.');
        fireEvent.click(screen.getByRole('button', { name: 'Review conversion notes' }));
        expect(screen.getByText('Conversion notes').closest('details')).toHaveAttribute('open');
        fireEvent.click(acknowledge);
        expect(submit).toBeEnabled();
        expect(separate).not.toBeChecked();
    });

    it('switches dialects, previews their SQL, and passes the reviewed result to the editor', async () => {
        const onOpenEditor = vi.fn().mockResolvedValue(true);
        render(<DraftSqlExportDialog graph={graph} onClose={vi.fn()} onOpenEditor={onOpenEditor} />);
        fireEvent.click(screen.getByRole('radio', { name: /MySQL/ }));
        fireEvent.click(screen.getByRole('button', { name: 'SQL preview' }));
        expect(screen.getByRole('textbox', { name: 'Generated SQL preview' }).value).toContain('CREATE TABLE `account`');
        fireEvent.click(screen.getByRole('button', { name: 'Open in SQL to ERD' }));
        await waitFor(() => expect(onOpenEditor).toHaveBeenCalledWith(expect.objectContaining({ dialect: 'mysql', name: 'Accounts', sql: expect.stringContaining('ENGINE=InnoDB') })));
    });

    it('keeps review for comment changes but requires it again for a different dialect or mapping', () => {
        const noKey = { ...graph, nodes: [graph.nodes[0]], edges: [] };
        render(<DraftSqlExportDialog graph={noKey} onClose={vi.fn()} onOpenEditor={vi.fn()} />);
        const submit = screen.getByRole('button', { name: 'Open in SQL to ERD' });
        expect(submit).toBeDisabled();
        fireEvent.click(screen.getByRole('checkbox', { name: /I have reviewed/ }));
        expect(submit).toBeEnabled();
        fireEvent.click(screen.getByRole('checkbox', { name: 'Include diagram notes and mapping comments' }));
        expect(screen.getByRole('checkbox', { name: /I have reviewed/ })).toBeChecked();
        expect(submit).toBeEnabled();
        fireEvent.click(screen.getByRole('radio', { name: /SQLite/ }));
        expect(screen.getByRole('checkbox', { name: /I have reviewed/ })).not.toBeChecked();
        expect(submit).toBeDisabled();
        fireEvent.change(screen.getByRole('combobox', { name: 'Entities without a key' }), { target: { value: 'require' } });
        expect(screen.getByRole('alert')).toHaveTextContent('needs a key attribute');
        expect(screen.queryByRole('checkbox', { name: /I have reviewed/ })).not.toBeInTheDocument();
        expect(submit).toBeDisabled();
    });

    it('explains composite references and uniqueness in the compact constraint preview', () => {
        const related = { nodes: [...graph.nodes, { id: 'tenant', data: { shape: 'keyAttribute', label: 'tenant_id', domain: 'INT' } }, { id: 'profile', data: { shape: 'entity', label: 'Profile' } }, { id: 'profileKey', data: { shape: 'keyAttribute', label: 'id', domain: 'INT' } }, { id: 'has', data: { shape: 'relationship', label: 'Has' } }], edges: [...graph.edges, { id: 'tenant', source: 'account', target: 'tenant' }, { id: 'profileKey', source: 'profile', target: 'profileKey' }, { id: 'a-h', source: 'account', target: 'has', data: { sourceLabel: '1' } }, { id: 'p-h', source: 'profile', target: 'has', data: { sourceLabel: '1', lineCount: 'double' } }] };
        render(<DraftSqlExportDialog graph={related} onClose={vi.fn()} onOpenEditor={vi.fn()} />);
        const constraints = screen.getByLabelText('Constraints for profile');
        expect(constraints).toHaveTextContent('has_account_id, has_account_tenant_id → account (id, tenant_id)');
        expect(constraints).toHaveTextContent('Required reference');
        expect(constraints).toHaveTextContent('Unique: has_account_id, has_account_tenant_id');
        fireEvent.click(screen.getByRole('radio', { name: /MySQL/ }));
        expect(screen.getByText(/MySQL 8.0.16\+/)).toBeInTheDocument();
    });

    it('blocks an oversized key and enables conversion after a type correction', () => {
        const oversized = { ...graph, nodes: [graph.nodes[0], { ...graph.nodes[1], data: { ...graph.nodes[1].data, domain: 'NVARCHAR(500)' } }] };
        render(<DraftSqlExportDialog graph={oversized} onClose={vi.fn()} onOpenEditor={vi.fn()} />);
        fireEvent.click(screen.getByRole('radio', { name: /SQL Server/ }));
        expect(screen.getByRole('alert')).toHaveTextContent('900-byte limit');
        const submit = screen.getByRole('button', { name: 'Open in SQL to ERD' });
        expect(submit).toBeDisabled();
        fireEvent.change(screen.getByRole('combobox', { name: 'SQL type for id' }), { target: { value: 'integer' } });
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(submit).toBeEnabled();
    });

    it('contains focus, consumes graph mutation shortcuts, and restores the trigger on Escape', () => {
        const close = vi.fn();
        const trigger = document.createElement('button');
        document.body.appendChild(trigger);
        trigger.focus();
        const { unmount } = render(<DraftSqlExportDialog graph={graph} onClose={close} onOpenEditor={vi.fn()} />);
        const dialog = screen.getByRole('dialog');
        expect(dialog).toContainElement(document.activeElement);
        const shortcut = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
        document.activeElement.dispatchEvent(shortcut);
        expect(shortcut.defaultPrevented).toBe(true);
        fireEvent.keyDown(document.activeElement, { key: 'Escape' });
        expect(close).toHaveBeenCalledOnce();
        unmount();
        expect(trigger).toHaveFocus();
        trigger.remove();
    });
});
