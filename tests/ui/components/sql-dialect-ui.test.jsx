// @vitest-environment jsdom

/** Covers dialect selection, manual overrides, and the live footer label. */
import React from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AddTable } from '@/components/AddTable';
import StatusBar from '@/features/editor/components/StatusBar';
import { detectEditorSqlDialect } from '@/features/editor/lib/sqlDialectDetection';
import { renderWithProviders } from '../../utils/uiTestUtils.jsx';

const DIALECT_CASES = [
    ['SQLite', 'CREATE TABLE existing (id INTEGER PRIMARY KEY AUTOINCREMENT);'],
    ['PostgreSQL', 'CREATE TABLE existing (id SERIAL PRIMARY KEY);'],
    ['MySQL', 'CREATE TABLE existing (id INT AUTO_INCREMENT PRIMARY KEY);'],
    ['MSSQL', 'CREATE TABLE existing (id INT IDENTITY(1,1) PRIMARY KEY);'],
];

describe('SQL language UI', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    it.each(DIALECT_CASES)('shows %s in the SQL footer and selects it for Add Table', (label, sqlInput) => {
        renderWithProviders(<><StatusBar /><AddTable /></>, {
            layout: { sqlInput, schemaRef: { current: { tables: [] } }, displayModalAddTable: true },
        });
        expect(screen.getByLabelText(`SQL language: ${label}`)).toHaveTextContent(label);
        expect(screen.getByRole('radio', { name: label, exact: true })).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByText(/Target Database selected automatically/)).toBeInTheDocument();
        // Automatic selection must not replace the remembered manual fallback.
        expect(window.localStorage.getItem('addTable.dialect')).toBe('sqlite');
    });

    it('updates the footer after SQL edits and keeps mixed SQL explicit', () => {
        const { rerender, layoutValue } = renderWithProviders(<StatusBar />, {
            layout: { sqlInput: DIALECT_CASES[1][1], schemaRef: { current: { tables: [] } } },
        });
        expect(screen.getByLabelText('SQL language: PostgreSQL')).toBeInTheDocument();
        layoutValue.sqlInput = DIALECT_CASES[2][1];
        rerender(<StatusBar />);
        expect(screen.getByLabelText('SQL language: MySQL')).toBeInTheDocument();
        layoutValue.sqlInput += DIALECT_CASES[1][1];
        rerender(<StatusBar />);
        expect(screen.getByLabelText('SQL language: Mixed SQL')).toHaveAttribute('title', expect.stringContaining('Multiple database dialects'));
    });

    it('selects a likely match from quoting and explains its uncertainty', () => {
        renderWithProviders(<AddTable />, {
            layout: { sqlInput: 'CREATE TABLE `items` (id INTEGER);', schemaRef: { current: { tables: [] } }, displayModalAddTable: true },
        });
        expect(screen.getByRole('radio', { name: 'MySQL' })).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByText(/Likely MySQL based on identifier quoting/)).toHaveTextContent('Target Database selected automatically');
    });

    it('remembers manual overrides for neutral SQL and detects again on reopening without resetting form input', async () => {
        const user = userEvent.setup();
        const { rerender, layoutValue } = renderWithProviders(<AddTable />, {
            layout: { sqlInput: DIALECT_CASES[2][1], schemaRef: { current: { tables: [] } }, displayModalAddTable: true },
        });
        await user.type(screen.getByPlaceholderText('users'), 'new_table');
        await user.click(screen.getByRole('radio', { name: 'MSSQL' }));
        expect(window.localStorage.getItem('addTable.dialect')).toBe('mssql');

        layoutValue.sqlInput = DIALECT_CASES[1][1];
        rerender(<AddTable />);
        expect(screen.getByRole('radio', { name: 'MSSQL' })).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByText(/selected manually/)).toBeInTheDocument();

        layoutValue.displayModalAddTable = false;
        rerender(<AddTable />);
        layoutValue.displayModalAddTable = true;
        rerender(<AddTable />);
        expect(screen.getByRole('radio', { name: 'PostgreSQL' })).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByPlaceholderText('users')).toHaveValue('new_table');

        layoutValue.sqlInput = 'CREATE TABLE portable (id INTEGER PRIMARY KEY);';
        rerender(<AddTable />);
        expect(screen.getByRole('radio', { name: 'MSSQL' })).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByText(/Using MSSQL as the default/)).toBeInTheDocument();
    });

    it('reads the focused tab when opening even if combined SQL did not change', () => {
        const sqlInput = DIALECT_CASES[1][1] + DIALECT_CASES[2][1];
        let focusedSql = DIALECT_CASES[1][1];
        const runSqlTabOperation = vi.fn(name => name === 'getSqlDialectDetection' ? detectEditorSqlDialect(focusedSql, sqlInput) : undefined);
        const { rerender, layoutValue } = renderWithProviders(<AddTable />, {
            layout: { sqlInput, schemaRef: { current: { tables: [] } }, displayModalAddTable: true, runSqlTabOperation },
        });
        expect(screen.getByRole('radio', { name: 'PostgreSQL' })).toHaveAttribute('aria-checked', 'true');
        layoutValue.displayModalAddTable = false;
        rerender(<AddTable />);
        focusedSql = DIALECT_CASES[2][1];
        layoutValue.displayModalAddTable = true;
        rerender(<AddTable />);
        expect(screen.getByRole('radio', { name: 'MySQL' })).toHaveAttribute('aria-checked', 'true');
    });

    it('uses the saved preference for mixed SQL and tolerates unavailable storage', () => {
        window.localStorage.setItem('addTable.dialect', 'postgresql');
        window.localStorage.setItem('addTable.dialect.version', '2');
        const storageSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
        try {
            renderWithProviders(<AddTable />, {
                layout: { sqlInput: DIALECT_CASES[1][1] + DIALECT_CASES[2][1], schemaRef: { current: { tables: [] } }, displayModalAddTable: true },
            });
            expect(screen.getByRole('radio', { name: 'PostgreSQL' })).toHaveAttribute('aria-checked', 'true');
            expect(screen.getByText(/Multiple database dialects detected/)).toBeInTheDocument();
        } finally {
            storageSpy.mockRestore();
        }
    });
});
