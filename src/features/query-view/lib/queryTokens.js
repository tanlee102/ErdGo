import { CLAUSE_KEYWORDS, JOIN_KEYWORDS, QueryError, RESERVED_ALIAS_KEYWORDS } from './queryLanguage.js';

/**
 * Token-stream helpers used by the Query View parser.
 *
 * These helpers know token shape and SQL statement boundaries, but never read
 * table data or evaluate expressions. Keeping that rule prevents parsing code
 * from accidentally acquiring execution side effects.
 */
export function trimStatement(tokens) {
    const out = [];
    let terminated = false;
    for (const token of tokens) {
        if (token.type === 'PUNC' && token.value === ';') {
            terminated = true;
            continue;
        }
        if (terminated) {
            throw new QueryError('Query View accepts exactly one SELECT statement.');
        }
        out.push(token);
    }
    return out;
}

export function splitTopLevel(tokens, delimiter) {
    const chunks = [];
    let current = [];
    let depth = 0;
    const openingParentheses = [];
    for (const token of tokens) {
        if (token.type === 'PUNC' && token.value === '(') {
            depth++;
            openingParentheses.push(token);
        }
        if (token.type === 'PUNC' && token.value === ')') {
            // Fail at the parser boundary. Letting depth become negative can
            // cause later commas or clauses to be grouped into the wrong AST.
            if (depth === 0) throw new QueryError('Unmatched closing parenthesis.', token);
            depth--;
            openingParentheses.pop();
        }
        if (depth === 0 && token.type === 'PUNC' && token.value === delimiter) {
            chunks.push(trimTokens(current));
            current = [];
            continue;
        }
        current.push(token);
    }
    if (depth !== 0) {
        throw new QueryError('Unclosed opening parenthesis.', openingParentheses.at(-1));
    }
    // Preserve the empty tail: `SELECT a, FROM t` must fail rather than look
    // like the valid but different query `SELECT a FROM t`.
    chunks.push(trimTokens(current));
    return chunks;
}

export function trimTokens(tokens) {
    return tokens.filter(Boolean);
}

export function tokensToSql(tokens) {
    return tokens.map((token) => token.raw || token.value).join(' ').replace(/\s+\./g, '.').replace(/\.\s+/g, '.').replace(/\s+\)/g, ')').replace(/\(\s+/g, '(');
}

export function stripSchema(name) {
    if (!name) return name;
    const dot = String(name).lastIndexOf('.');
    return dot >= 0 ? String(name).slice(dot + 1) : String(name);
}

export function unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
}

export function isIdentifierLike(token) {
    return token && (token.type === 'IDENT' || token.type === 'KW' || token.type === 'STRING');
}

export function isTokenKW(token, value) {
    return token?.type === 'KW' && token.value.toUpperCase() === value;
}

export function isTokenWord(token, value) {
    return token && (token.type === 'KW' || token.type === 'IDENT') && String(token.value).toUpperCase() === value;
}

export function isSelectStart(token) {
    return isTokenWord(token, 'SELECT') || isTokenWord(token, 'WITH');
}

export function isDistinctFromContinuation(tokens, token) {
    if (!isTokenWord(token, 'FROM')) return false;
    const previous = tokens[tokens.length - 1];
    const beforePrevious = tokens[tokens.length - 2];
    const threeBack = tokens[tokens.length - 3];
    return isTokenWord(previous, 'DISTINCT')
        && (isTokenWord(beforePrevious, 'IS') || (isTokenWord(beforePrevious, 'NOT') && isTokenWord(threeBack, 'IS')));
}

export function isClauseKeyword(token) {
    return token?.type === 'KW' && CLAUSE_KEYWORDS.has(token.value.toUpperCase());
}

export function isJoinStart(token) {
    return token?.type === 'KW' && JOIN_KEYWORDS.has(token.value.toUpperCase());
}

export function isReservedAlias(token) {
    return token?.type === 'KW' && RESERVED_ALIAS_KEYWORDS.has(token.value.toUpperCase());
}
