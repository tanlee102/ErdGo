import { describe, expect, it } from 'vitest';
import { deleteLocalDocument, getLocalDocument, getLocalToolDocument, listLocalDocuments, LOCAL_DOCUMENTS_KEY, saveLocalDocument } from '@/features/files/lib/localFileStore';
import { FILE_KINDS, getDocumentRoute } from '@/features/files/lib/fileDocuments';

class MemoryStorage {
    constructor(entries = {}) {
        this.entries = new Map(Object.entries(entries));
    }
    getItem(key) {
        return this.entries.has(key) ? this.entries.get(key) : null;
    }
    setItem(key, value) {
        this.entries.set(key, String(value));
    }
}

describe('local diagram repository', () => {
    it('creates, updates, lists, reads, and deletes a diagram', () => {
        const storage = new MemoryStorage();
        const created = saveLocalDocument({ name: 'Commerce', sql: 'CREATE TABLE users (id INT);', context: { zoom: 1 } }, storage);

        expect(created.id).toBeTruthy();
        expect(listLocalDocuments(storage)).toHaveLength(1);
        expect(getLocalDocument(created.id, storage)).toMatchObject({ name: 'Commerce', context: { zoom: 1 } });

        const updated = saveLocalDocument({ id: created.id, name: 'Commerce v2', sql: 'CREATE TABLE users (id INT);', context: { zoom: 2 } }, storage);
        expect(updated.createdAt).toBe(created.createdAt);
        expect(getLocalDocument(created.id, storage)).toMatchObject({ name: 'Commerce v2', context: { zoom: 2 } });

        expect(deleteLocalDocument(created.id, storage)).toBe(true);
        expect(deleteLocalDocument(created.id, storage)).toBe(false);
        expect(listLocalDocuments(storage)).toEqual([]);
    });

    it('tolerates malformed and legacy stored values', () => {
        expect(listLocalDocuments(new MemoryStorage({ [LOCAL_DOCUMENTS_KEY]: '{bad json' }))).toEqual([]);

        const legacy = new MemoryStorage({
            [LOCAL_DOCUMENTS_KEY]: JSON.stringify([{ id: 'legacy', name: '', sql: 42, context: null }]),
        });
        expect(listLocalDocuments(legacy)).toEqual([
            { id: 'legacy', name: 'untitled', sql: '', context: {}, createdAt: null, updatedAt: null },
        ]);
    });

    it('returns clones so callers cannot mutate persisted data', () => {
        const storage = new MemoryStorage();
        const created = saveLocalDocument({ name: 'Safe', sql: 'CREATE TABLE safe (id INT);', context: { nested: { x: 1 } } }, storage);
        const loaded = getLocalDocument(created.id, storage);
        loaded.context.nested.x = 99;
        expect(getLocalDocument(created.id, storage).context.nested.x).toBe(1);
    });

    it('surfaces quota failures with an actionable message', () => {
        const storage = new MemoryStorage();
        storage.setItem = () => {
            const error = new Error('quota');
            error.name = 'QuotaExceededError';
            throw error;
        };
        expect(() => saveLocalDocument({ name: 'Full', sql: 'CREATE TABLE full (id INT);', context: {} }, storage)).toThrow(/storage is full/i);
    });

    it('preserves legacy SQL and renderer context while saving documents from other tools', () => {
        const legacy = { id: 'legacy', name: 'Original', sql: 'CREATE TABLE users(id INT);', context: { tablePositions: { users: { x: 42, y: 17 } }, sqlTabs: { version: 1, tabs: [] }, queryView: { query: 'SELECT 1;' } }, createdAt: '2026-01-01', updatedAt: '2026-02-01' };
        const storage = new MemoryStorage({ [LOCAL_DOCUMENTS_KEY]: JSON.stringify({ version: 1, documents: [legacy] }) });
        const prisma = saveLocalDocument({ kind: FILE_KINDS.PRISMA_ERD, name: 'Prisma', payload: { schemaVersion: 1, source: 'model User { id Int @id }', rendererContext: { zoom: 2 } } }, storage);
        const builder = saveLocalDocument({ kind: FILE_KINDS.ERD_BUILDER, name: 'Builder', payload: { schemaVersion: 3, nodes: [{ id: 'entity' }], edges: [], viewport: { x: 1, y: 2, zoom: 0.5 } } }, storage);

        expect(getLocalToolDocument('legacy', FILE_KINDS.SQL_ERD, storage)).toEqual(legacy);
        expect(getLocalToolDocument(prisma.id, FILE_KINDS.PRISMA_ERD, storage).payload.source).toContain('model User');
        expect(getLocalToolDocument(builder.id, FILE_KINDS.ERD_BUILDER, storage).payload.viewport.zoom).toBe(0.5);
        expect(listLocalDocuments(storage)).toHaveLength(3);
        expect(getDocumentRoute(legacy)).toBe('/e/legacy');
        expect(getDocumentRoute(prisma)).toBe(`/prisma-to-erd/${prisma.id}`);
        expect(getDocumentRoute(builder)).toBe(`/erd-builder/${builder.id}`);
    });

    it('rejects opening or overwriting a document from the wrong tool without changing storage', () => {
        const storage = new MemoryStorage();
        const saved = saveLocalDocument({ kind: FILE_KINDS.ERD_BUILDER, name: 'Builder', payload: { nodes: [], edges: [] } }, storage);
        const before = storage.getItem(LOCAL_DOCUMENTS_KEY);
        expect(() => getLocalToolDocument(saved.id, FILE_KINDS.SQL_ERD, storage)).toThrow(/different ERD tool/);
        expect(() => saveLocalDocument({ id: saved.id, sql: 'SELECT 1;', name: 'Wrong tool' }, storage)).toThrow(/different ERD tool/);
        expect(storage.getItem(LOCAL_DOCUMENTS_KEY)).toBe(before);
        expect(() => getLocalToolDocument('missing', FILE_KINDS.PRISMA_ERD, storage)).toThrow(/does not exist in this browser/);
    });

    it('clones typed payloads on write and read and preserves creation time on update', () => {
        const storage = new MemoryStorage();
        const payload = { source: 'model User { id Int @id }', rendererContext: { zoom: 1 } };
        const saved = saveLocalDocument({ kind: FILE_KINDS.PRISMA_ERD, name: 'Prisma', payload }, storage);
        payload.rendererContext.zoom = 3;
        saved.payload.source = 'corrupted';
        const loaded = getLocalToolDocument(saved.id, FILE_KINDS.PRISMA_ERD, storage);
        expect(loaded.payload).toMatchObject({ source: 'model User { id Int @id }', rendererContext: { zoom: 1 } });
        const updated = saveLocalDocument({ id: saved.id, kind: FILE_KINDS.PRISMA_ERD, name: 'Renamed Prisma', payload: loaded.payload }, storage);
        expect(updated.createdAt).toBe(saved.createdAt);
        expect(listLocalDocuments(storage)).toHaveLength(1);
        expect(getLocalDocument(saved.id, storage).name).toBe('Renamed Prisma');
    });
});
