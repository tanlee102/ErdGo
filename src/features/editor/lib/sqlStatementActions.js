const DML_STATEMENT_TYPES = new Set(['INSERT', 'UPDATE', 'DELETE']);
const MOVABLE_STATEMENT_TYPES = new Set(['INSERT', 'UPDATE', 'DELETE', 'DML']);

function normalizeSql(value) {
    return typeof value === 'string' ? value : '';
}

function getDollarQuoteTag(sql, index) {
    const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
    return match ? match[0] : null;
}

function splitSqlStatements(sql) {
    const source = normalizeSql(sql);
    const statements = [];
    let statementStart = 0;
    let quote = null;
    let dollarQuoteTag = null;
    let lineComment = false;
    let blockComment = false;

    // Split only on top-level semicolons. DML moves must not break on
    // semicolons inside strings, quoted identifiers, comments, or dollar quotes.
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        const next = source[index + 1];

        if (lineComment) {
            if (char === '\n') lineComment = false;
            continue;
        }

        if (blockComment) {
            if (char === '*' && next === '/') {
                blockComment = false;
                index += 1;
            }
            continue;
        }

        if (dollarQuoteTag) {
            if (source.startsWith(dollarQuoteTag, index)) {
                index += dollarQuoteTag.length - 1;
                dollarQuoteTag = null;
            }
            continue;
        }

        if (quote) {
            if (quote !== '[' && char === '\\' && next != null) {
                index += 1;
                continue;
            }
            if (quote === "'" && char === "'" && next === "'") {
                index += 1;
                continue;
            }
            if (quote === '"' && char === '"' && next === '"') {
                index += 1;
                continue;
            }
            if (quote === '`' && char === '`' && next === '`') {
                index += 1;
                continue;
            }
            if (quote === '[' && char === ']') {
                quote = null;
                continue;
            }
            if (quote !== '[' && char === quote) {
                quote = null;
            }
            continue;
        }

        if (char === '-' && next === '-') {
            lineComment = true;
            index += 1;
            continue;
        }
        if (char === '/' && next === '*') {
            blockComment = true;
            index += 1;
            continue;
        }

        const tag = char === '$' ? getDollarQuoteTag(source, index) : null;
        if (tag) {
            dollarQuoteTag = tag;
            index += tag.length - 1;
            continue;
        }

        if (char === "'" || char === '"' || char === '`' || char === '[') {
            quote = char;
            continue;
        }

        if (char === ';') {
            statements.push(source.slice(statementStart, index + 1));
            statementStart = index + 1;
        }
    }

    if (statementStart < source.length) {
        statements.push(source.slice(statementStart));
    }

    return statements;
}

function getLeadingStatementWord(statement) {
    const source = normalizeSql(statement);
    let index = 0;

    while (index < source.length) {
        if (/\s/.test(source[index])) {
            index += 1;
            continue;
        }
        if (source[index] === '-' && source[index + 1] === '-') {
            const nextLine = source.indexOf('\n', index + 2);
            index = nextLine === -1 ? source.length : nextLine + 1;
            continue;
        }
        if (source[index] === '/' && source[index + 1] === '*') {
            const close = source.indexOf('*/', index + 2);
            index = close === -1 ? source.length : close + 2;
            continue;
        }
        break;
    }

    const match = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_$]*/);
    return match ? match[0].toUpperCase() : '';
}

function cleanupSqlAfterRemoval(sql) {
    return normalizeSql(sql)
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function statementMatchesType(statement, statementType) {
    const normalizedType = normalizeSql(statementType).trim().toUpperCase();
    const leadingWord = getLeadingStatementWord(statement);

    if (normalizedType === 'DML') {
        return DML_STATEMENT_TYPES.has(leadingWord);
    }

    return leadingWord === normalizedType;
}

export function isMovableStatementType(statementType) {
    return Boolean(normalizeMovableStatementType(statementType));
}

export function normalizeMovableStatementType(statementType) {
    const normalized = normalizeSql(statementType).trim().toUpperCase();
    if (normalized === 'DML') return 'DML';

    const firstWord = normalized.match(/^[A-Z]+/)?.[0] || '';
    return MOVABLE_STATEMENT_TYPES.has(firstWord) ? firstWord : '';
}

export function extractStatementsByType(sql, statementType) {
    const source = normalizeSql(sql);
    const normalizedType = normalizeMovableStatementType(statementType);

    if (!normalizedType) {
        return {
            success: false,
            matchedCount: 0,
            extractedSql: '',
            remainingSql: source,
        };
    }

    const extracted = [];
    const kept = [];

    // Keep original statement text as much as possible. This powers the AI
    // <move_statements> action without asking the model to rewrite repeated DML.
    splitSqlStatements(source).forEach((statement) => {
        if (!statement.trim()) {
            kept.push(statement);
            return;
        }

        if (statementMatchesType(statement, normalizedType)) {
            extracted.push(statement.trim());
        } else {
            kept.push(statement);
        }
    });

    const extractedSql = extracted.join('\n\n');

    return {
        success: extracted.length > 0,
        matchedCount: extracted.length,
        extractedSql,
        remainingSql: extracted.length > 0 ? cleanupSqlAfterRemoval(kept.join('')) : source,
    };
}
