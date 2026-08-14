/**
 * Shared SQL-dialect profiles.
 *
 * These profiles deliberately describe only semantic differences that an
 * in-browser SQL preview can model reliably. Parsing remains shared: the
 * tokenizer and AST continue to accept mixed-dialect scripts, while callers
 * opt into a profile when they need native execution semantics.
 */

import { tokenize } from './parse-ast/tokenize.js';

const DIALECT_ALIASES = Object.freeze({
    auto: 'auto',
    postgres: 'postgres',
    postgresql: 'postgres',
    pg: 'postgres',
    mysql: 'mysql',
    mariadb: 'mysql',
    mssql: 'mssql',
    sqlserver: 'mssql',
    'sql-server': 'mssql',
    'sql_server': 'mssql',
    sqlite: 'sqlite',
    sqlite3: 'sqlite',
});

const RAW_PROFILES = {
    auto: {
        label: 'Auto / mixed SQL',
        identifierQuote: 'mixed',
        defaultSchema: null,
        implicitIntegerPrimaryKey: false,
        supportsWithoutRowid: false,
    },
    postgres: {
        label: 'PostgreSQL',
        identifierQuote: 'double',
        defaultSchema: 'public',
        implicitIntegerPrimaryKey: false,
        supportsWithoutRowid: false,
    },
    mysql: {
        label: 'MySQL',
        identifierQuote: 'backtick',
        defaultSchema: null,
        implicitIntegerPrimaryKey: false,
        supportsWithoutRowid: false,
    },
    mssql: {
        label: 'SQL Server',
        identifierQuote: 'bracket',
        defaultSchema: 'dbo',
        implicitIntegerPrimaryKey: false,
        supportsWithoutRowid: false,
    },
    sqlite: {
        label: 'SQLite',
        identifierQuote: 'double',
        defaultSchema: 'main',
        // SQLite's exact `INTEGER PRIMARY KEY` aliases the rowid and assigns
        // a value when omitted. It is deliberately not shared by the other
        // supported engines.
        implicitIntegerPrimaryKey: true,
        supportsWithoutRowid: true,
    },
};

export function normalizeSqlDialect(value = 'auto') {
    const key = String(value || 'auto').trim().toLowerCase();
    return DIALECT_ALIASES[key] || 'auto';
}

export function getSqlDialectProfile(value = 'auto') {
    const id = normalizeSqlDialect(value);
    return Object.freeze({ id, ...RAW_PROFILES[id] });
}

function structuralSqlForDetection(sql) {
    try {
        const { tokens, errors } = tokenize(String(sql || ''), { skipComments: true });
        // A partial lexical token stream is useful for editor recovery, but
        // never reliable enough to choose execution semantics. Stay neutral
        // until the user finishes the malformed string/comment/token.
        if (errors.some((error) => error?.severity !== 'warning')) return '';
        // Do not treat a marker in a string literal as syntax. Preserve raw
        // identifier spellings so backticks and SQL Server brackets remain
        // available to the dialect matcher.
        return tokens
            .filter((token) => token.type !== 'STRING')
            .map((token) => token.raw || token.value)
            .join(' ');
    } catch {
        // Detection is advisory. The parser/executor will surface malformed
        // SQL separately, so a failed lexical pass simply stays in auto mode.
        return '';
    }
}

/**
 * Inspect CREATE TABLE entry boundaries without attempting to parse their
 * contents. A single identifier between top-level commas is a typeless
 * SQLite column; an entirely empty body is a PostgreSQL-only table shape.
 * Keeping this structural avoids false positives from `PRIMARY KEY (id)` or
 * function calls, whose identifiers occur at a nested parenthesis depth.
 */
function createTableShapeSignals(sql) {
    try {
        const { tokens, errors } = tokenize(String(sql || ''), { skipComments: true });
        if (errors.some((error) => error?.severity !== 'warning')) return { typelessColumn: false, emptyBody: false };

        let typelessColumn = false;
        let emptyBody = false;
        const isWord = (token, value) => token && (token.type === 'KW' || token.type === 'IDENT') && String(token.value).toUpperCase() === value;
        const isSingleColumnName = (entry) => {
            if (entry.length !== 1) return false;
            const token = entry[0];
            if (!token || (token.type !== 'IDENT' && token.type !== 'KW')) return false;
            const word = String(token.value).toUpperCase();
            return !['PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'CONSTRAINT', 'EXCLUDE', 'LIKE'].includes(word);
        };

        for (let index = 0; index < tokens.length; index += 1) {
            if (!isWord(tokens[index], 'CREATE')) continue;
            let cursor = index + 1;
            while (cursor < tokens.length && !isWord(tokens[cursor], 'TABLE')) {
                const word = String(tokens[cursor]?.value || '').toUpperCase();
                if (!['GLOBAL', 'LOCAL', 'TEMP', 'TEMPORARY', 'UNLOGGED'].includes(word)) break;
                cursor += 1;
            }
            if (!isWord(tokens[cursor], 'TABLE')) continue;
            while (cursor < tokens.length && !(tokens[cursor].type === 'PUNC' && ['(', ';'].includes(tokens[cursor].value))) cursor += 1;
            if (tokens[cursor]?.value !== '(') continue;

            let depth = 1;
            let entry = [];
            let sawEntry = false;
            for (cursor += 1; cursor < tokens.length && depth > 0; cursor += 1) {
                const token = tokens[cursor];
                if (token.type === 'PUNC' && token.value === '(') {
                    depth += 1;
                    entry.push(token);
                    continue;
                }
                if (token.type === 'PUNC' && token.value === ')') {
                    depth -= 1;
                    if (depth === 0) {
                        if (entry.length > 0) {
                            sawEntry = true;
                            if (isSingleColumnName(entry)) typelessColumn = true;
                        }
                        break;
                    }
                    entry.push(token);
                    continue;
                }
                if (depth === 1 && token.type === 'PUNC' && token.value === ',') {
                    if (entry.length > 0) {
                        sawEntry = true;
                        if (isSingleColumnName(entry)) typelessColumn = true;
                    }
                    entry = [];
                    continue;
                }
                entry.push(token);
            }
            if (!sawEntry && entry.length === 0) emptyBody = true;
        }

        return { typelessColumn, emptyBody };
    } catch {
        return { typelessColumn: false, emptyBody: false };
    }
}

/**
 * Detect only high-confidence dialect signatures. A generic `CREATE TABLE`
 * with common types deliberately stays `auto`; guessing a server dialect from
 * portable SQL would be less correct than retaining shared semantics.
 */
export function detectSqlDialectProfile(sql) {
    const text = structuralSqlForDetection(sql);
    const tableShapes = createTableShapeSignals(sql);
    const scores = {
        postgres: 0,
        mysql: 0,
        mssql: 0,
        sqlite: 0,
    };

    if (/\b(?:BIGSERIAL|SMALLSERIAL|SERIAL|JSONB|TIMESTAMPTZ|ILIKE)\b/i.test(text)) scores.postgres += 8;
    if (/::\s*[a-z_][\w.]*/i.test(text)) scores.postgres += 8;
    if (/\bCREATE\s+TYPE\s+[\w".]+\s+AS\s+ENUM\b/i.test(text)) scores.postgres += 8;
    if (/\bCONSTRAINT\s+"[^"]+_pkey"\s+PRIMARY\s+KEY\b/i.test(text)) scores.postgres += 8;

    if (/`[^`]+`/.test(text)) scores.mysql += 8;
    if (/\bAUTO_INCREMENT\b/i.test(text)) scores.mysql += 8;
    if (/\bENGINE\s*=/i.test(text)) scores.mysql += 8;
    if (/\b(?:DEFAULT\s+)?CHARSET\s*=/i.test(text)) scores.mysql += 4;

    if (/\[[^\]]+\]/.test(text)) scores.mssql += 8;
    if (/\bGO\b/i.test(text)) scores.mssql += 8;
    if (/\bIDENTITY\s*\(/i.test(text)) scores.mssql += 8;
    if (/\b(?:NVARCHAR|UNIQUEIDENTIFIER|DATETIME2)\b/i.test(text)) scores.mssql += 8;

    if (/\bPRAGMA\b/i.test(text)) scores.sqlite += 8;
    if (/\bAUTOINCREMENT\b/i.test(text)) scores.sqlite += 8;
    if (/\bSTRICT\b/i.test(text)) scores.sqlite += 8;
    if (/\bWITHOUT\s+ROWID\b/i.test(text)) scores.sqlite += 8;
    if (/\bCREATE\s+(?:TEMP|TEMPORARY)\s+TABLE\b/i.test(text)) scores.sqlite += 4;
    if (tableShapes.typelessColumn) scores.sqlite += 10;

    // PostgreSQL explicitly permits CREATE TABLE name (); the other three
    // supported engines require at least one column in this form.
    if (tableShapes.emptyBody) scores.postgres += 10;

    const ranked = Object.entries(scores).sort((left, right) => right[1] - left[1]);
    const [id, score] = ranked[0];
    const runnerUpScore = ranked[1]?.[1] || 0;
    // A pasted migration can deliberately contain examples from multiple
    // engines. In that case no single engine's identifier folding/default
    // schema rules are safe, even when one happens to have more markers.
    const strongProfiles = Object.values(scores).filter((value) => value >= 8).length;
    const confident = strongProfiles === 1 && score >= 8 && score > runnerUpScore;
    return {
        profile: getSqlDialectProfile(confident ? id : 'auto'),
        confidence: confident ? 'high' : 'low',
        scores,
    };
}
