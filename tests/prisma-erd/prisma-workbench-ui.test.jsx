// @vitest-environment jsdom

import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PrismaToErdTool from '@/features/prisma-erd/components/PrismaToErdTool';
import { renderWithProviders } from '../utils/uiTestUtils.jsx';

const prismaHookMocks = vi.hoisted(() => ({
    setErdContextVersion: vi.fn(),
    requestRender: vi.fn(),
    setJumpToTableCallback: vi.fn(),
    triggerAutoColor: vi.fn(),
    exportPng: vi.fn(),
    setFullConnect: vi.fn(),
    getPanelStyle: vi.fn(() => ({})),
    handleSplitterMouseDown: vi.fn(),
    toggleCollapse: vi.fn(),
    setPanelSize: vi.fn(),
    splitterRef: { current: null },
}));


vi.mock('@monaco-editor/react', () => ({
    default: ({ value, onChange }) => <textarea aria-label="Prisma editor" value={value} onChange={(event) => onChange(event.target.value)} />,
}));

vi.mock('@/features/prisma-erd/hooks/usePrismaErdRendering', () => ({
    usePrismaErdRendering: () => ({
        erdContextVersion: 0,
        renderError: null,
        setErdContextVersion: prismaHookMocks.setErdContextVersion,
        setFlag: prismaHookMocks.requestRender,
        setJumpToTableCallback: prismaHookMocks.setJumpToTableCallback,
        triggerAutoColor: prismaHookMocks.triggerAutoColor,
        exportPng: prismaHookMocks.exportPng,
        fullConnect: false,
        setFullConnect: prismaHookMocks.setFullConnect,
    }),
}));

vi.mock('@/features/prisma-erd/hooks/usePrismaCanvasResize', () => ({
    usePrismaCanvasResize: vi.fn(),
}));

vi.mock('@/features/prisma-erd/hooks/usePrismaSplitter', () => ({
    default: () => ({
        containerClassName: '',
        getPanelStyle: prismaHookMocks.getPanelStyle,
        handleSplitterMouseDown: prismaHookMocks.handleSplitterMouseDown,
        toggleButtonText: '',
        toggleButtonTitle: '',
        toggleCollapse: prismaHookMocks.toggleCollapse,
        splitterRef: prismaHookMocks.splitterRef,
        setPanelSize: prismaHookMocks.setPanelSize,
    }),
}));

vi.mock('@/features/prisma-erd/components/PrismaSplitter', () => ({
    default: () => <div data-testid="prisma-splitter" />,
}));

vi.mock('@/features/editor/components/ErdControls', () => ({
    default: () => <div data-testid="erd-controls" />,
}));

vi.mock('@/features/editor/components/ErdTopControls', () => ({
    default: () => <div data-testid="erd-top-controls" />,
}));

describe('Prisma workbench UI', () => {
    beforeEach(() => {
        window.localStorage.clear();
        Object.values(prismaHookMocks).forEach((value) => {
            if (typeof value?.mockClear === 'function') value.mockClear();
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('ignores retired browser drafts', () => {
        window.localStorage.setItem('erdgo:prisma-to-erd:draft', 'model Retired { id Int @id }');
        window.localStorage.setItem('erdgo:prisma-to-erd:history', '[{"value":"retired"}]');

        renderWithProviders(<PrismaToErdTool />);

        expect(screen.getByLabelText('Prisma editor').value).toMatch(/^\/\/ Replace this sample/);
    });

    it('asks new documents to start with a Prisma sample or an empty file', () => {
        renderWithProviders(<PrismaToErdTool />);

        expect(screen.getByRole('dialog', { name: 'Create New Prisma ERD' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Create Empty Prisma File/i }));
        expect(screen.getByLabelText('Prisma editor')).toHaveValue('');
        expect(screen.queryByRole('dialog', { name: 'Create New Prisma ERD' })).not.toBeInTheDocument();
    });

    it('protects an edited Prisma document from browser unload after choosing a starter', () => {
        renderWithProviders(<PrismaToErdTool />);

        const chooserEvent = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(chooserEvent);
        expect(chooserEvent.defaultPrevented).toBe(false);

        fireEvent.click(screen.getByRole('button', { name: /Create Empty Prisma File/i }));
        fireEvent.change(screen.getByLabelText('Prisma editor'), {
            target: { value: 'model UnsavedUser { id Int @id }' },
        });

        const dirtyEvent = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(dirtyEvent);
        expect(dirtyEvent.defaultPrevented).toBe(true);
    });

    it('does not render removed sample, copy, undo, or history actions', () => {
        renderWithProviders(<PrismaToErdTool />);

        expect(screen.queryByRole('button', { name: 'Sample' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Copy Prisma schema' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Undo to previous Prisma change' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Open recent Prisma changes' })).not.toBeInTheDocument();
        expect(screen.queryByRole('menu', { name: 'Recent Prisma changes' })).not.toBeInTheDocument();
    });

    it('uses isolated Prisma file-list and save button treatments', () => {
        renderWithProviders(<PrismaToErdTool />);

        expect(screen.getByRole('button', { name: 'Open Prisma ERD files' })).toHaveClass('prisma-erd-toolbar-button', 'prisma-erd-files-button');
        expect(screen.getByRole('button', { name: 'Save Prisma ERD locally' })).toHaveClass('prisma-erd-save-button');
    });

    it('shows compact accessible icons for Prisma schema counts', () => {
        renderWithProviders(<PrismaToErdTool />);

        expect(screen.getByLabelText(/Models: \d+/)).toHaveClass('schema-stat--models');
        expect(screen.getByLabelText(/Relations: \d+/)).toHaveClass('schema-stat--relations');
        expect(screen.getByLabelText(/Enums: \d+/)).toHaveClass('schema-stat--enums');
        expect(screen.queryByText(/Models: \d+/)).not.toBeInTheDocument();
    });

    it('shows a repair hint for nullable ownership and clears it after correcting the relation', async () => {
        renderWithProviders(<PrismaToErdTool />);
        fireEvent.click(screen.getByRole('button', { name: /Create Empty Prisma File/i }));
        const source = `model Parent {
            id Int @id
            children Child[]
        }
        model Child {
            id Int @id
            parentId Int?
            parent Parent @relation(fields: [parentId], references: [id])
        }`;

        fireEvent.change(screen.getByLabelText('Prisma editor'), { target: { value: source } });
        expect(await screen.findByRole('button', { name: /must be optional because.*nullable/ })).toBeInTheDocument();
        expect(screen.getByText('Make the relation field nullable with ?, or make all of its foreign-key scalars required.')).toBeInTheDocument();
        expect(screen.getByLabelText('Models: 2')).toBeInTheDocument();
        expect(screen.getByLabelText('Relations: 1')).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Prisma editor'), { target: { value: source.replace('parent Parent @relation', 'parent Parent? @relation') } });
        await waitFor(() => expect(screen.queryByRole('region', { name: 'Prisma diagnostics' })).not.toBeInTheDocument());
        expect(screen.getByLabelText('Relations: 1')).toBeInTheDocument();
    });

    it('does not read or write localStorage while editing', () => {
        const storageRead = vi.spyOn(Storage.prototype, 'getItem');
        const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
        renderWithProviders(<PrismaToErdTool />);
        fireEvent.change(screen.getByLabelText('Prisma editor'), { target: { value: 'model LocalOnly { id Int @id }' } });

        expect(storageRead).not.toHaveBeenCalled();
        expect(storageWrite).not.toHaveBeenCalled();
    });

    it('keeps editor content when the clear confirmation is canceled', async () => {
        renderWithProviders(<PrismaToErdTool />);
        const original = 'model KeepMe { id Int @id }';
        fireEvent.change(screen.getByLabelText('Prisma editor'), { target: { value: original } });
        fireEvent.click(screen.getByRole('button', { name: 'Clear Prisma editor' }));

        expect(screen.getByRole('dialog', { name: 'Clear Prisma editor?' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Clear Prisma editor?' })).not.toBeInTheDocument());
        expect(screen.getByLabelText('Prisma editor')).toHaveValue(original);
    });

    it('confirms clearing and leaves the editor empty', async () => {
        renderWithProviders(<PrismaToErdTool />);
        const original = 'model KeepMe { id Int @id }';
        fireEvent.change(screen.getByLabelText('Prisma editor'), { target: { value: original } });
        fireEvent.click(screen.getByRole('button', { name: 'Clear Prisma editor' }));
        expect(screen.getByRole('dialog', { name: 'Clear Prisma editor?' })).toHaveTextContent('This cannot be undone.');
        fireEvent.click(screen.getByRole('button', { name: 'Clear editor' }));

        await waitFor(() => expect(screen.getByLabelText('Prisma editor')).toHaveValue(''));
    });

    it('searches mapped Prisma fields and opens related model relations', async () => {
        renderWithProviders(<PrismaToErdTool />);

        fireEvent.change(screen.getByRole('searchbox', { name: 'Search Prisma schema' }), { target: { value: 'display_name' } });
        fireEvent.click(await screen.findByRole('option', { name: /field user\.displayname/i }));

        expect(screen.queryByRole('listbox', { name: 'Prisma search results' })).not.toBeInTheDocument();
        expect(screen.getByLabelText('User relations')).toBeInTheDocument();
        expect(screen.getByText('Post.editor -> User.id')).toBeInTheDocument();

        fireEvent.change(screen.getByRole('searchbox', { name: 'Search Prisma schema' }), { target: { value: '' } });
        expect(screen.queryByLabelText('User relations')).not.toBeInTheDocument();
    });

    it('clears model relation context while typing a different Prisma search', async () => {
        renderWithProviders(<PrismaToErdTool />);
        const search = screen.getByRole('searchbox', { name: 'Search Prisma schema' });

        fireEvent.change(search, { target: { value: 'display_name' } });
        fireEvent.click(await screen.findByRole('option', { name: /field user\.displayname/i }));
        expect(screen.getByLabelText('User relations')).toBeInTheDocument();

        fireEvent.change(search, { target: { value: 'administrator' } });
        expect(screen.queryByLabelText('User relations')).not.toBeInTheDocument();
        fireEvent.click(await screen.findByRole('option', { name: /enum value userrole\.admin/i }));

        expect(screen.queryByText('Model Relations')).not.toBeInTheDocument();
        expect(screen.queryByRole('article', { name: 'Prisma relation inspector' })).not.toBeInTheDocument();
    });

    it('searches relation names and shows Prisma relation inspector details', async () => {
        renderWithProviders(<PrismaToErdTool />);

        fireEvent.change(screen.getByRole('searchbox', { name: 'Search Prisma schema' }), { target: { value: 'PostEditor' } });
        fireEvent.click(await screen.findByRole('option', { name: /relation post\.editor/i }));

        expect(screen.queryByRole('listbox', { name: 'Prisma search results' })).not.toBeInTheDocument();
        const inspector = screen.getByRole('article', { name: 'Prisma relation inspector' });
        expect(inspector).toHaveTextContent('Post.editor -> User.id');
        expect(inspector).toHaveTextContent('[editorId]');
        expect(inspector).toHaveTextContent('[id]');
        expect(inspector).toHaveTextContent('onDelete: SetNull');

        fireEvent.click(screen.getByRole('button', { name: 'Focus User' }));
        expect(screen.getByRole('article', { name: 'Prisma relation inspector' })).toHaveTextContent('Post.editor -> User.id');

        fireEvent.click(screen.getByRole('button', { name: 'Close relation inspector' }));
        expect(screen.queryByRole('article', { name: 'Prisma relation inspector' })).not.toBeInTheDocument();
        expect(screen.queryByLabelText('User relations')).not.toBeInTheDocument();
    });

    it('clears a stale relation inspector as soon as the search query changes', async () => {
        renderWithProviders(<PrismaToErdTool />);
        const search = screen.getByRole('searchbox', { name: 'Search Prisma schema' });

        fireEvent.change(search, { target: { value: 'PostEditor' } });
        fireEvent.click(await screen.findByRole('option', { name: /relation post\.editor/i }));
        expect(screen.getByRole('article', { name: 'Prisma relation inspector' })).toHaveTextContent('Post.editor -> User.id');

        fireEvent.change(search, { target: { value: 'not_a_schema_symbol' } });

        expect(screen.queryByRole('article', { name: 'Prisma relation inspector' })).not.toBeInTheDocument();
        expect(screen.queryByText('Model Relations')).not.toBeInTheDocument();
        expect(await screen.findByText('No matches')).toBeInTheDocument();
    });

    it('clears a previous relation inspector when selecting a scalar field', async () => {
        renderWithProviders(<PrismaToErdTool />);
        const search = screen.getByRole('searchbox', { name: 'Search Prisma schema' });

        fireEvent.change(search, { target: { value: 'PostEditor' } });
        fireEvent.click(await screen.findByRole('option', { name: /relation post\.editor/i }));
        expect(screen.getByRole('article', { name: 'Prisma relation inspector' })).toHaveTextContent('Post.editor -> User.id');

        fireEvent.change(search, { target: { value: 'published' } });
        fireEvent.click(await screen.findByRole('option', { name: /field post\.published/i }));

        expect(screen.queryByRole('article', { name: 'Prisma relation inspector' })).not.toBeInTheDocument();
        expect(screen.getByLabelText('Post relations')).toBeInTheDocument();
    });

    it('clears explorer table context when schema edits remove the selected model', async () => {
        renderWithProviders(<PrismaToErdTool />);

        fireEvent.change(screen.getByRole('searchbox', { name: 'Search Prisma schema' }), { target: { value: 'display_name' } });
        fireEvent.click(await screen.findByRole('option', { name: /field user\.displayname/i }));
        expect(screen.getByLabelText('User relations')).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Prisma editor'), { target: { value: 'model Fresh { id Int @id }' } });

        await waitFor(() => expect(screen.queryByLabelText('User relations')).not.toBeInTheDocument());
        expect(screen.queryByText('Model Relations')).not.toBeInTheDocument();
    });

    it('shows an empty state and clears Prisma search results', async () => {
        renderWithProviders(<PrismaToErdTool />);

        const search = screen.getByRole('searchbox', { name: 'Search Prisma schema' });
        fireEvent.change(search, { target: { value: 'not_a_schema_symbol' } });
        expect(await screen.findByText('No matches')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Clear Prisma search' }));
        expect(search).toHaveValue('');
        expect(screen.queryByRole('listbox', { name: 'Prisma search results' })).not.toBeInTheDocument();
        expect(screen.queryByText('Model Relations')).not.toBeInTheDocument();
    });

});
