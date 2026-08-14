/**
 * Query View language and diagnostic contracts.
 *
 * Parser and evaluator modules must share these exact keyword/function sets.
 * Adding syntax in only one layer can make a valid token impossible to parse,
 * or allow a parsed function to fail later during evaluation. Update the
 * relevant conformance validation whenever this vocabulary changes.
 */
export const QUERY_KEYWORDS = [
    'WITH',
    'RECURSIVE',
    'SELECT',
    'TOP',
    'DISTINCT',
    'FROM',
    'AS',
    'WHERE',
    'FILTER',
    'EXISTS',
    'AND',
    'OR',
    'NOT',
    'IN',
    'BETWEEN',
    'LIKE',
    'ILIKE',
    'IS',
    'NULL',
    'TRUE',
    'FALSE',
    'UNKNOWN',
    'CURRENT_DATE',
    'CURRENT_TIMESTAMP',
    'JOIN',
    'INNER',
    'LEFT',
    'RIGHT',
    'FULL',
    'OUTER',
    'CROSS',
    'ON',
    'ORDER',
    'BY',
    'ASC',
    'DESC',
    'LIMIT',
    'OFFSET',
    'FETCH',
    'FIRST',
    'NEXT',
    'ROW',
    'ROWS',
    'ONLY',
    'GROUP',
    'HAVING',
    'OVER',
    'PARTITION',
    'RANGE',
    'GROUPS',
    'UNBOUNDED',
    'PRECEDING',
    'CURRENT',
    'FOLLOWING',
    'CASE',
    'WHEN',
    'THEN',
    'ELSE',
    'END',
    'UNION',
    'INTERSECT',
    'EXCEPT',
    'ALL',
    'CAST',
    'NULLS',
    'ROW_NUMBER',
    'RANK',
    'DENSE_RANK',
    'NTILE',
    'LAG',
    'LEAD',
    'FIRST_VALUE',
    'LAST_VALUE',
    'COUNT',
    'SUM',
    'AVG',
    'MIN',
    'MAX',
    'ARRAY_AGG',
    'GROUP_CONCAT',
    'STRING_AGG',
];

export const CLAUSE_KEYWORDS = new Set(['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT']);
export const JOIN_KEYWORDS = new Set(['JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS']);
export const SET_OPERATORS = new Set(['UNION', 'INTERSECT', 'EXCEPT']);
export const RESERVED_ALIAS_KEYWORDS = new Set([...CLAUSE_KEYWORDS, ...JOIN_KEYWORDS, 'ON', 'BY', 'ASC', 'DESC', 'OUTER', 'AS', 'OVER', 'PARTITION', 'FILTER', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'UNION', 'INTERSECT', 'EXCEPT', 'UNKNOWN']);
export const AGGREGATE_NAMES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'ARRAY_AGG', 'GROUP_CONCAT', 'STRING_AGG']);
export const SCALAR_FUNCTION_NAMES = new Set([
    'COALESCE', 'IFNULL', 'ISNULL', 'NVL', 'NULLIF',
    'LOWER', 'UPPER', 'LENGTH', 'LEN', 'CHAR_LENGTH', 'CHARACTER_LENGTH',
    'ABS', 'ROUND', 'CEIL', 'CEILING', 'FLOOR', 'SIGN', 'POWER', 'POW', 'SQRT', 'MOD',
    'CONCAT', 'CONCAT_WS', 'TRIM', 'LTRIM', 'RTRIM', 'SUBSTR', 'SUBSTRING', 'REPLACE', 'REVERSE',
    'LPAD', 'RPAD', 'REPEAT', 'INSTR', 'POSITION', 'CHARINDEX', 'STRPOS', 'LEFT', 'RIGHT',
    'INITCAP', 'TRANSLATE',
    'GREATEST', 'LEAST', 'TYPEOF',
    'JSON_BUILD_OBJECT', 'JSONB_BUILD_OBJECT', 'JSON_OBJECT',
    'JSON_EXTRACT', 'JSON_VALUE', 'JSON_UNQUOTE', 'JSON_EXTRACT_PATH_TEXT',
    'CONVERT', 'TRY_CAST', 'TRY_CONVERT', 'IIF',
    'DATE', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND',
    'DATETIME',
    'NOW', 'CURRENT_TIMESTAMP', 'CURRENT_DATE',
    'DATE_PART', 'EXTRACT', 'STRFTIME', 'DATE_FORMAT', 'FORMAT',
    'DATE_TRUNC', 'DATEADD', 'DATEDIFF',
]);
export const WINDOW_FUNCTION_NAMES = new Set(['ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE']);
const UNSUPPORTED_POSTGRES_OPERATORS = new Set(['@>', '<@', '?', '?|', '?&', '#>', '#>>', '&&', '~', '~*', '!~', '!~*']);

export class QueryError extends Error {
    constructor(message, token = null) {
        super(message);
        this.name = 'QueryError';
        this.token = token;
        this.position = toErrorPosition(token);
    }
}

export function emptyResult(message = '') {
    return {
        columns: [],
        rows: [],
        errors: message ? [{ type: 'info', message }] : [],
        warnings: [],
        meta: { rowCount: 0 },
    };
}

export function errorResult(error) {
    const message = error instanceof Error ? error.message : String(error || 'Unable to run query.');
    const position = error?.position || toErrorPosition(error?.token);
    const entry = { type: 'error', message };
    if (position) entry.position = position;

    return {
        columns: [],
        rows: [],
        errors: [entry],
        warnings: [],
        meta: { rowCount: 0 },
    };
}

function toErrorPosition(token) {
    const start = token?.start || token;
    if (!start || typeof start !== 'object') return null;
    return {
        line: start.line ?? 1,
        column: start.col ?? start.column ?? 1,
        index: start.idx ?? start.index ?? 0,
    };
}

function formatTokenLocation(token) {
    const position = toErrorPosition(token);
    return position ? ` at line ${position.line}, column ${position.column}` : '';
}

export function unsupportedPostgresOperatorError(token, surface = 'Query View') {
    const operator = String(token?.raw || token?.value || '?');
    return new QueryError(
        `Unsupported PostgreSQL operator ${operator}${formatTokenLocation(token)}. ${surface} cannot execute this operator yet.`,
        token,
    );
}

export function isUnsupportedPostgresOperatorToken(token) {
    return token?.type === 'OP' && UNSUPPORTED_POSTGRES_OPERATORS.has(String(token.value));
}
