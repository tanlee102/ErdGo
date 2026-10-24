// @vitest-environment jsdom

import React from 'react';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RootLayoutContext } from '@/contexts/RootLayoutContext';
import { ConfirmProvider } from '@/components/ConfirmDialog';
import { useErdRendering } from '@/features/editor/hooks/useErdRendering';
import runErdScript from '@/lib/genErdScript';

vi.mock('@/lib/genErdScript', () => ({
    default: vi.fn(() => Promise.resolve({})),
}));

describe('useErdRendering AI preview', () => {
    beforeEach(() => {
        runErdScript.mockReset().mockResolvedValue({});
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('does not mutate committed SQL or schema when a pending preview table is deleted from the canvas', async () => {
        const erdContextRef = { current: {} };
        const schemaRef = {
            current: {
                tables: [{ name: 'users' }],
                relations: [],
            },
        };
        const setSqlInput = vi.fn();
        const layoutValue = {
            sqlInput: 'CREATE TABLE users (id INT);',
            setSqlInput,
            schemaRef,
        };
        const wrapper = ({ children }) => (
            <RootLayoutContext.Provider value={layoutValue}>
                <ConfirmProvider>{children}</ConfirmProvider>
            </RootLayoutContext.Provider>
        );

        const { result } = renderHook(
            () =>
                useErdRendering({
                    theme: 'light',
                    erdContextRef,
                    isLoading: false,
                    isAiPreview: true,
                }),
            { wrapper },
        );

        await act(async () => {
            await result.current.handleTableDelete('users');
        });

        expect(schemaRef.current.tables).toEqual([{ name: 'users' }]);
        expect(setSqlInput).not.toHaveBeenCalled();
    });

    it('shows the tab-aware deletion preview before deleting from the workspace', async () => {
        const erdContextRef = { current: {} };
        const user = userEvent.setup();
        const schemaRef = {
            current: {
                tables: [{ name: 'users' }],
                relations: [],
            },
        };
        const setSqlInput = vi.fn();
        const runSqlTabOperation = vi.fn((name) => {
            if (name === 'getTableDeletionPreview') {
                return {
                    tableName: 'users',
                    owner: { tabId: 'schema', title: 'Schema', line: 1 },
                    references: [{ tabId: 'orders', tabTitle: 'Orders', description: 'orders(user_id)' }],
                };
            }
            if (name === 'deleteTableFromTabs') return true;
            return undefined;
        });
        const layoutValue = {
            sqlInput: 'CREATE TABLE users (id INT);',
            setSqlInput,
            schemaRef,
            runSqlTabOperation,
        };
        const wrapper = ({ children }) => (
            <RootLayoutContext.Provider value={layoutValue}>
                <ConfirmProvider>{children}</ConfirmProvider>
            </RootLayoutContext.Provider>
        );

        const { result } = renderHook(
            () =>
                useErdRendering({
                    theme: 'light',
                    erdContextRef,
                    isLoading: false,
                }),
            { wrapper },
        );

        let deletePromise;
        act(() => {
            deletePromise = result.current.handleTableDelete('users');
        });

        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent('Tab: "Schema" (line 1).');
        expect(dialog).toHaveTextContent('Orders: orders(user_id)');
        await user.click(screen.getByRole('button', { name: 'Delete table' }));
        await act(async () => {
            await deletePromise;
        });

        expect(runSqlTabOperation).toHaveBeenCalledWith('deleteTableFromTabs', 'users');
        expect(setSqlInput).not.toHaveBeenCalled();
        expect(schemaRef.current.tables).toEqual([]);
    });

    it('passes preview rendering an isolated ERD context so nested layout maps cannot leak into saved state', async () => {
        const erdContextRef = {
            current: {
                tablePositions: { users: { x: 80, y: 120 } },
                tableColors: { users: '#123456' },
                tableHeaderTextModes: { users: 'white' },
                tableCompactModes: { users: true },
            },
        };
        const schemaRef = { current: { tables: [{ name: 'users' }], relations: [] } };
        const originalContext = JSON.parse(JSON.stringify(erdContextRef.current));
        let renderContext;
        runErdScript.mockImplementation((_schema, options) => {
            renderContext = options.initialContext;
            renderContext.tablePositions.users.x = 999;
            renderContext.tableColors.users = '#abcdef';
            renderContext.tableHeaderTextModes.users = 'black';
            renderContext.tableCompactModes.users = false;
            return Promise.resolve({});
        });
        const layoutValue = {
            sqlInput: 'CREATE TABLE users (id INT);',
            setSqlInput: vi.fn(),
            schemaRef,
        };
        const wrapper = ({ children }) => (
            <RootLayoutContext.Provider value={layoutValue}>
                <ConfirmProvider>{children}</ConfirmProvider>
            </RootLayoutContext.Provider>
        );

        renderHook(
            () =>
                useErdRendering({
                    theme: 'light',
                    erdContextRef,
                    isLoading: false,
                    isAiPreview: true,
                }),
            { wrapper },
        );

        await waitFor(() => expect(runErdScript).toHaveBeenCalled());
        expect(renderContext).not.toBe(erdContextRef.current);
        expect(renderContext.tablePositions).not.toBe(erdContextRef.current.tablePositions);
        expect(renderContext.tableHeaderTextModes).not.toBe(erdContextRef.current.tableHeaderTextModes);
        expect(erdContextRef.current).toEqual(originalContext);
    });

    it('persists canvas display preferences in file context while preserving the tab ownership map for ERD actions', async () => {
        const schemaRef = { current: { tables: [{ name: 'users' }], relations: [] } };
        const erdContextRef = { current: { tablePositions: { users: { x: 80, y: 120 } } } };
        const runSqlTabOperation = vi.fn((operation) => (operation === 'getTableOwners' ? { users: { tabId: 'schema', title: 'Schema', line: 1 } } : undefined));
        const layoutValue = {
            sqlInput: 'CREATE TABLE users (id INT);',
            setSqlInput: vi.fn(),
            schemaRef,
            runSqlTabOperation,
        };
        const wrapper = ({ children }) => (
            <RootLayoutContext.Provider value={layoutValue}>
                <ConfirmProvider>{children}</ConfirmProvider>
            </RootLayoutContext.Provider>
        );

        runErdScript.mockImplementation(() => Promise.resolve({}));
        const { result } = renderHook(
            () =>
                useErdRendering({
                    theme: 'light',
                    erdContextRef,
                    isLoading: false,
                    contextLoadVersion: 1,
                }),
            { wrapper },
        );

        await waitFor(() => expect(runErdScript).toHaveBeenCalled());
        expect(runErdScript.mock.calls.at(-1)[1]).toEqual(
            expect.objectContaining({
                showTableOwnerLabels: false,
                fullConnect: false,
                tableOwners: { users: { tabId: 'schema', title: 'Schema', line: 1 } },
            }),
        );

        act(() => {
            result.current.setShowTableOwnerLabels(true);
            result.current.setFullConnect(true);
        });

        expect(erdContextRef.current).toMatchObject({ showTableOwnerLabels: true, fullConnect: true });
        await waitFor(() => expect(runErdScript.mock.calls.at(-1)[1]).toEqual(expect.objectContaining({ showTableOwnerLabels: true, fullConnect: true })));
        expect(runErdScript.mock.calls.at(-1)[1].tableOwners).toEqual({ users: { tabId: 'schema', title: 'Schema', line: 1 } });

        const canvasContextChange = runErdScript.mock.calls.at(-1)[1].onContextChange;
        act(() => {
            canvasContextChange({ tablePositions: { users: { x: 90, y: 140 } } });
        });
        expect(erdContextRef.current).toMatchObject({
            tablePositions: { users: { x: 90, y: 140 } },
            showTableOwnerLabels: true,
            fullConnect: true,
        });
    });

    it('keeps legacy and malformed display preferences disabled without rewriting the loaded file context', async () => {
        const erdContextRef = {
            current: {
                tablePositions: { users: { x: 80, y: 120 } },
                showTableOwnerLabels: 'true',
                fullConnect: 1,
            },
        };
        const originalContext = JSON.parse(JSON.stringify(erdContextRef.current));
        const schemaRef = { current: { tables: [{ name: 'users' }], relations: [] } };
        const layoutValue = {
            sqlInput: 'CREATE TABLE users (id INT);',
            setSqlInput: vi.fn(),
            schemaRef,
        };
        const wrapper = ({ children }) => (
            <RootLayoutContext.Provider value={layoutValue}>
                <ConfirmProvider>{children}</ConfirmProvider>
            </RootLayoutContext.Provider>
        );

        runErdScript.mockImplementation(() => Promise.resolve({}));
        const { result } = renderHook(
            () => useErdRendering({ theme: 'light', erdContextRef, isLoading: false, contextLoadVersion: 1 }),
            { wrapper },
        );

        await waitFor(() => expect(runErdScript).toHaveBeenCalled());
        expect(result.current.showTableOwnerLabels).toBe(false);
        expect(result.current.fullConnect).toBe(false);
        expect(runErdScript.mock.calls.at(-1)[1]).toEqual(expect.objectContaining({ showTableOwnerLabels: false, fullConnect: false }));
        expect(erdContextRef.current).toEqual(originalContext);
    });

    it('renders scored suggestions on review and persists accepted or rejected diagram decisions', async () => {
        const suggestionId = 'inferred:posts.user_id->users.id';
        const schemaRef = {
            current: {
                tables: [
                    { name: 'users', columns: [{ name: 'id', type: 'BIGINT', pk: true, constraints: ['PK'] }] },
                    { name: 'posts', columns: [{ name: 'id', type: 'BIGINT', pk: true, constraints: ['PK'] }, { name: 'user_id', type: 'BIGINT', constraints: [] }] },
                ],
                relations: [],
            },
        };
        const erdContextRef = { current: { tablePositions: {} } };
        const layoutValue = {
            sqlInput: 'CREATE TABLE users (id BIGINT PRIMARY KEY); CREATE TABLE posts (id BIGINT PRIMARY KEY, user_id BIGINT);',
            setSqlInput: vi.fn(),
            schemaRef,
        };
        const wrapper = ({ children }) => (
            <RootLayoutContext.Provider value={layoutValue}>
                <ConfirmProvider>{children}</ConfirmProvider>
            </RootLayoutContext.Provider>
        );

        runErdScript.mockImplementation(() => Promise.resolve({}));
        const { result } = renderHook(
            () => useErdRendering({ theme: 'light', erdContextRef, isLoading: false, contextLoadVersion: 1, schemaVersion: 1 }),
            { wrapper },
        );

        await waitFor(() => expect(result.current.relationshipInference.pendingCount).toBe(1));
        expect(result.current.schemaQuality).toMatchObject({ score: 67, label: 'Fair' });
        expect(runErdScript.mock.calls.at(-1)[1].inferredRelations).toEqual([]);

        act(() => result.current.relationshipInference.setIsOpen(true));
        await waitFor(() => expect(runErdScript.mock.calls.at(-1)[1].inferredRelations).toEqual([]));
        expect(result.current.relationshipInference.showConnectors).toBe(false);

        act(() => result.current.relationshipInference.setShowConnectors(true));
        await waitFor(() => expect(runErdScript.mock.calls.at(-1)[1].inferredRelations).toEqual([
            expect.objectContaining({ id: suggestionId, confidence: 97, inferenceStatus: 'pending' }),
        ]));

        act(() => result.current.relationshipInference.accept(suggestionId));
        await waitFor(() => expect(erdContextRef.current.relationshipInferenceDecisions).toEqual({ accepted: [suggestionId], rejected: [] }));
        await waitFor(() => expect(result.current.schemaQuality).toMatchObject({ score: 77, label: 'Good' }));
        await waitFor(() => expect(runErdScript.mock.calls.at(-1)[1].inferredRelations).toEqual([
            expect.objectContaining({ id: suggestionId, inferenceStatus: 'accepted' }),
        ]));

        act(() => result.current.relationshipInference.setIsOpen(false));
        await waitFor(() => expect(runErdScript.mock.calls.at(-1)[1].inferredRelations).toHaveLength(1));

        act(() => result.current.relationshipInference.setShowConnectors(false));
        await waitFor(() => expect(runErdScript.mock.calls.at(-1)[1].inferredRelations).toEqual([
            expect.objectContaining({ id: suggestionId, inferenceStatus: 'accepted' }),
        ]));

        const canvasContextChange = runErdScript.mock.calls.at(-1)[1].onContextChange;
        act(() => canvasContextChange({ tablePositions: { posts: { x: 20, y: 30 } }, relationshipInferenceDecisions: { accepted: [], rejected: [] } }));
        expect(erdContextRef.current.relationshipInferenceDecisions).toEqual({ accepted: [suggestionId], rejected: [] });

        act(() => result.current.relationshipInference.reject(suggestionId));
        await waitFor(() => expect(result.current.relationshipInference.suggestions).toEqual([]));
        expect(erdContextRef.current.relationshipInferenceDecisions).toEqual({ accepted: [], rejected: [suggestionId] });
        await waitFor(() => expect(result.current.schemaQuality).toMatchObject({ score: 88, label: 'Strong' }));
        expect(result.current.schemaQuality.stats).toMatchObject({ missingRelationshipCandidates: 0, rejectedRelationshipCandidates: 1 });
        await waitFor(() => expect(runErdScript.mock.calls.at(-1)[1].inferredRelations).toEqual([]));

        act(() => result.current.relationshipInference.resetRejected());
        await waitFor(() => expect(result.current.relationshipInference.pendingCount).toBe(1));
        await waitFor(() => expect(result.current.schemaQuality).toMatchObject({ score: 67, label: 'Fair' }));
        expect(erdContextRef.current.relationshipInferenceDecisions).toEqual({ accepted: [], rejected: [] });
    });

    it('keeps relationship decisions read-only during an AI preview', async () => {
        const schemaRef = {
            current: {
                tables: [
                    { name: 'users', columns: [{ name: 'id', type: 'BIGINT', pk: true, constraints: ['PK'] }] },
                    { name: 'posts', columns: [{ name: 'user_id', type: 'BIGINT', constraints: [] }] },
                ],
                relations: [],
            },
        };
        const erdContextRef = { current: {} };
        const layoutValue = { sqlInput: 'preview', setSqlInput: vi.fn(), schemaRef };
        const wrapper = ({ children }) => (
            <RootLayoutContext.Provider value={layoutValue}>
                <ConfirmProvider>{children}</ConfirmProvider>
            </RootLayoutContext.Provider>
        );
        const { result } = renderHook(
            () => useErdRendering({ theme: 'light', erdContextRef, isLoading: false, isAiPreview: true, schemaVersion: 1 }),
            { wrapper },
        );

        await waitFor(() => expect(result.current.relationshipInference.pendingCount).toBe(1));
        expect(result.current.relationshipInference.disabled).toBe(true);
        expect(result.current.relationshipInference.accept('inferred:posts.user_id->users.id')).toBe(false);
        expect(result.current.relationshipInference.reject('inferred:posts.user_id->users.id')).toBe(false);
        expect(erdContextRef.current).toEqual({});
    });
});
