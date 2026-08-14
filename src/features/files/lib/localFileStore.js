export const LOCAL_DOCUMENTS_KEY = 'erdgo:documents:v1';
export const LOCAL_DOCUMENTS_CHANGED_EVENT = 'erdgo:documents-changed';
const STORE_VERSION = 1;

function getStorage(storage) {
    if (storage) return storage;
    if (typeof window === 'undefined' || !window.localStorage) throw new Error('Local browser storage is unavailable.');
    return window.localStorage;
}

function cloneJson(value, fallback = null) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return fallback;
    }
}

function normalizeDocument(value) {
    if (!value || typeof value !== 'object') return null;
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    if (!id) return null;
    return {
        id,
        name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : 'untitled',
        sql: typeof value.sql === 'string' ? value.sql : '',
        context: value.context && typeof value.context === 'object' ? cloneJson(value.context, {}) : {},
        createdAt: typeof value.createdAt === 'string' ? value.createdAt : null,
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    };
}

function readEnvelope(storage) {
    const target = getStorage(storage);
    let raw;
    try {
        raw = target.getItem(LOCAL_DOCUMENTS_KEY);
    } catch {
        throw new Error('ERD Go cannot read local browser storage.');
    }
    if (!raw) return { version: STORE_VERSION, documents: [] };
    try {
        const parsed = JSON.parse(raw);
        const candidates = Array.isArray(parsed) ? parsed : parsed?.documents;
        if (!Array.isArray(candidates)) return { version: STORE_VERSION, documents: [] };
        const byId = new Map();
        candidates.forEach((candidate) => {
            const document = normalizeDocument(candidate);
            if (document) byId.set(document.id, document);
        });
        return { version: STORE_VERSION, documents: Array.from(byId.values()) };
    } catch {
        return { version: STORE_VERSION, documents: [] };
    }
}

function writeEnvelope(envelope, storage) {
    const target = getStorage(storage);
    try {
        target.setItem(LOCAL_DOCUMENTS_KEY, JSON.stringify(envelope));
    } catch (error) {
        if (error?.name === 'QuotaExceededError') throw new Error('Local browser storage is full. Delete an old diagram and try again.');
        throw new Error('ERD Go cannot write to local browser storage.');
    }
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(LOCAL_DOCUMENTS_CHANGED_EVENT));
}

function createDocumentId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `erd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function listLocalDocuments(storage) {
    return readEnvelope(storage).documents.map((document) => cloneJson(document)).sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
}

export function getLocalDocument(id, storage) {
    const normalizedId = typeof id === 'string' ? id.trim() : '';
    if (!normalizedId) return null;
    const document = readEnvelope(storage).documents.find((candidate) => candidate.id === normalizedId);
    return document ? cloneJson(document) : null;
}

export function saveLocalDocument({ id, name, sql, context }, storage) {
    const envelope = readEnvelope(storage);
    const now = new Date().toISOString();
    const normalizedId = typeof id === 'string' && id.trim() ? id.trim() : createDocumentId();
    const existingIndex = envelope.documents.findIndex((document) => document.id === normalizedId);
    const existing = existingIndex >= 0 ? envelope.documents[existingIndex] : null;
    const document = normalizeDocument({ id: normalizedId, name, sql, context, createdAt: existing?.createdAt || now, updatedAt: now });
    if (!document) throw new Error('The local diagram could not be prepared for saving.');
    if (existingIndex >= 0) envelope.documents[existingIndex] = document;
    else envelope.documents.push(document);
    writeEnvelope(envelope, storage);
    return cloneJson(document);
}

export function deleteLocalDocument(id, storage) {
    const envelope = readEnvelope(storage);
    const nextDocuments = envelope.documents.filter((document) => document.id !== id);
    if (nextDocuments.length === envelope.documents.length) return false;
    writeEnvelope({ version: STORE_VERSION, documents: nextDocuments }, storage);
    return true;
}

export function subscribeToLocalDocuments(callback) {
    if (typeof window === 'undefined') return () => {};
    const handleStorage = (event) => {
        if (!event || event.key === LOCAL_DOCUMENTS_KEY) callback();
    };
    window.addEventListener('storage', handleStorage);
    window.addEventListener(LOCAL_DOCUMENTS_CHANGED_EVENT, callback);
    return () => {
        window.removeEventListener('storage', handleStorage);
        window.removeEventListener(LOCAL_DOCUMENTS_CHANGED_EVENT, callback);
    };
}
