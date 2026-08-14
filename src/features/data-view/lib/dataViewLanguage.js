/**
 * Data View language-level contracts shared by parsing and diagnostics.
 *
 * Keep operator acceptance explicit. Silently treating an unknown operator as
 * a supported comparison is dangerous because it can mutate the wrong rows.
 * Unsupported syntax must produce a positioned execution-log entry instead.
 */
const UNSUPPORTED_POSTGRES_OPERATORS = new Set(['@>', '<@', '?', '?|', '?&', '#>', '#>>', '&&', '~', '~*', '!~', '!~*']);

export const SUPPORTED_DATA_VIEW_WHERE_OPERATORS = new Set(['=', '!=', '<>', '<', '<=', '>', '>=']);

export function toTokenPosition(token) {
    if (!token?.start) return null;
    return {
        line: token.start.line ?? 1,
        column: token.start.col ?? 1,
        index: token.start.idx ?? 0,
    };
}

function formatTokenLocation(token) {
    const position = toTokenPosition(token);
    return position ? ` at line ${position.line}, column ${position.column}` : '';
}

function isUnsupportedPostgresOperatorToken(token) {
    return token?.type === 'OP' && UNSUPPORTED_POSTGRES_OPERATORS.has(String(token.value));
}

export function unsupportedOperatorMessage(token, surface) {
    const operator = String(token?.raw || token?.value || '?');
    const dialectLabel = isUnsupportedPostgresOperatorToken(token) ? 'PostgreSQL' : 'SQL';
    return `Unsupported ${dialectLabel} operator ${operator}${formatTokenLocation(token)}. ${surface} cannot execute this operator yet.`;
}
