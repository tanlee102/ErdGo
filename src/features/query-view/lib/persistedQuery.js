/** Validates and normalizes Query View state stored inside the shared editor context. */
export const QUERY_VIEW_CONTEXT_KEY = 'queryView';

function normalizeQuery(value) {
    return typeof value === 'string' ? value : '';
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function shouldPersistQueryValue({ query, generatedQuery = '', userEdited = false }) {
    if (userEdited) return true;
    return normalizeQuery(query) !== normalizeQuery(generatedQuery);
}

export function getPersistedQueryFromContext(context) {
    if (!isPlainObject(context)) return '';
    return normalizeQuery(context[QUERY_VIEW_CONTEXT_KEY]?.query);
}

export function applyPersistedQueryToContext(context, query) {
    if (!isPlainObject(context)) return false;

    const nextQuery = normalizeQuery(query);
    const currentQuery = getPersistedQueryFromContext(context);
    if (currentQuery === nextQuery) return false;

    if (nextQuery) {
        const currentQueryView = isPlainObject(context[QUERY_VIEW_CONTEXT_KEY]) ? context[QUERY_VIEW_CONTEXT_KEY] : {};
        context[QUERY_VIEW_CONTEXT_KEY] = {
            ...currentQueryView,
            query: nextQuery,
        };
        return true;
    }

    const currentQueryView = context[QUERY_VIEW_CONTEXT_KEY];
    if (!isPlainObject(currentQueryView)) return false;

    const { query: _query, ...rest } = currentQueryView;
    if (Object.keys(rest).length > 0) {
        context[QUERY_VIEW_CONTEXT_KEY] = rest;
    } else {
        delete context[QUERY_VIEW_CONTEXT_KEY];
    }

    return true;
}
