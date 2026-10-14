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

function structuralSqlForDetection(tokens, names) {
    try {
        // Literals and quoted names are not keywords. Preserve only the quote
        // style (and pg_dump's constraint suffix) as advisory evidence; a table
        // named "strict" or a column named "jsonb" must not select an engine.
        return tokens
            .map((token, index) => {
                const separator = index && token.start.line > tokens[index - 1].end.line ? '\n' : ' ';
                if (token.type === 'STRING') return separator;
                const raw = token.raw || token.value;
                if (raw.startsWith('"')) return separator + (raw.endsWith('_pkey"') ? '"quoted_pkey"' : '"quoted_identifier"');
                if (raw.startsWith('`')) return separator + '`quoted_identifier`';
                if (raw.startsWith('[')) return separator + '[quoted_identifier]';
                return separator + (names.has(token) ? 'unquoted_identifier' : raw);
            })
            .join('');
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
function createTableShapeSignals(tokens) {
    try {
        const names = new Set();
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
        const recordEntry = entry => {
            if (!entry.length) return;
            const offset = isWord(entry[0], 'CONSTRAINT') ? 2 : 0;
            if (offset && entry[1]) names.add(entry[1]);
            const head = String(entry[offset]?.value || '').toUpperCase();
            if (!['PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'CONSTRAINT', 'EXCLUDE', 'LIKE'].includes(head)) names.add(entry[0]);
            if (['PRIMARY', 'UNIQUE', 'FOREIGN'].includes(head)) {
                const open = entry.findIndex(token => token.type === 'PUNC' && token.value === '(');
                if (open >= 0) for (let i = open + 1; i < entry.length && !(entry[i].type === 'PUNC' && entry[i].value === ')'); i += 1) names.add(entry[i]);
            }
            if (isSingleColumnName(entry)) typelessColumn = true;
        };

        // REFERENCES names are identities, including names such as serial/go.
        for (let i = 0; i < tokens.length; i += 1) if (isWord(tokens[i], 'REFERENCES')) {
            if (tokens[i + 1]) names.add(tokens[i + 1]);
            let j = i + 2;
            while (tokens[j]?.type === 'PUNC' && tokens[j].value === '.') { if (tokens[j + 1]) names.add(tokens[j + 1]); j += 2; }
            if (tokens[j]?.type === 'PUNC' && tokens[j].value === '(') for (j += 1; j < tokens.length && !(tokens[j].type === 'PUNC' && tokens[j].value === ')'); j += 1) names.add(tokens[j]);
        }

        for (let index = 0; index < tokens.length; index += 1) {
            if (!isWord(tokens[index], 'CREATE')) continue;
            let cursor = index + 1;
            while (cursor < tokens.length && !isWord(tokens[cursor], 'TABLE')) {
                const word = String(tokens[cursor]?.value || '').toUpperCase();
                if (!['GLOBAL', 'LOCAL', 'TEMP', 'TEMPORARY', 'UNLOGGED'].includes(word)) break;
                cursor += 1;
            }
            if (!isWord(tokens[cursor], 'TABLE')) continue;
            cursor += 1;
            while (cursor < tokens.length && !(tokens[cursor].type === 'PUNC' && ['(', ';'].includes(tokens[cursor].value))) { names.add(tokens[cursor]); cursor += 1; }
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
                            recordEntry(entry);
                        }
                        break;
                    }
                    entry.push(token);
                    continue;
                }
                if (depth === 1 && token.type === 'PUNC' && token.value === ',') {
                    if (entry.length > 0) {
                        sawEntry = true;
                        recordEntry(entry);
                    }
                    entry = [];
                    continue;
                }
                entry.push(token);
            }
            if (depth === 0 && !sawEntry && entry.length === 0) emptyBody = true;
        }

        return { typelessColumn, emptyBody, names };
    } catch {
        return { typelessColumn: false, emptyBody: false, names: new Set() };
    }
}

/**
 * Prefer native dialect signatures, with identifier quoting as a likely hint.
 * A generic `CREATE TABLE`
 * with common types deliberately stays `auto`; guessing a server dialect from
 * portable SQL would be less correct than retaining shared semantics.
 */
export function detectSqlDialectProfile(sql) {
    const lexed = tokenize(String(sql || ''), { skipComments: true });
    // Malformed lexical input cannot safely select execution semantics.
    const tokens = lexed.errors.some(error => error?.severity !== 'warning') ? [] : lexed.tokens;
    const tableShapes = createTableShapeSignals(tokens);
    const text = structuralSqlForDetection(tokens, tableShapes.names);
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
    if (/\bSET\s+(?:(?:LOCAL|SESSION)\s+)?(?:SEARCH_PATH|STATEMENT_TIMEOUT|LOCK_TIMEOUT|CLIENT_ENCODING)\s*(?:=|TO\b)/i.test(text)) scores.postgres += 8;

    if (/\bAUTO_INCREMENT\b/i.test(text)) scores.mysql += 8;
    if (/\bENGINE\s*=/i.test(text)) scores.mysql += 8;
    if (/\b(?:DEFAULT\s+)?CHARSET\s*=/i.test(text)) scores.mysql += 4;
    if (/\bSET\s+NAMES\b/i.test(text)) scores.mysql += 8;

    if (/^\s*GO(?:\s+\d+)?\s*$/im.test(text)) scores.mssql += 8;
    if (/\)\s+PERSISTED\b/i.test(text)) scores.mssql += 8;
    if (/\bIDENTITY\s*\(/i.test(text)) scores.mssql += 8;
    if (/\b(?:NVARCHAR|UNIQUEIDENTIFIER|DATETIME2)\b/i.test(text)) scores.mssql += 8;
    if (/\bSET\s+(?:ANSI_NULLS|QUOTED_IDENTIFIER|ANSI_PADDING)\s+(?:ON|OFF)\b/i.test(text)) scores.mssql += 8;

    if (/\bPRAGMA\b/i.test(text)) scores.sqlite += 8;
    if (/\bAUTOINCREMENT\b/i.test(text)) scores.sqlite += 8;
    if (/\)\s*(?:,\s*)?STRICT\b/i.test(text)) scores.sqlite += 8;
    if (/\bWITHOUT\s+ROWID\b/i.test(text)) scores.sqlite += 8;
    if (/\bCREATE\s+(?:TEMP|TEMPORARY)\s+TABLE\b/i.test(text)) scores.sqlite += 4;
    if (tableShapes.typelessColumn) scores.sqlite += 10;

    // PostgreSQL explicitly permits CREATE TABLE name (); the other three
    // supported engines require at least one column in this form.
    if (tableShapes.emptyBody) scores.postgres += 10;

    // SQLite accepts both backticks and brackets. Quote style is a fallback
    // hint only: it must not contradict a native PRAGMA/AUTOINCREMENT/STRICT
    // marker or turn an otherwise identified engine into a mixed script.
    const quoteHint = !Object.values(scores).some((score) => score >= 8);
    if (quoteHint) {
        if (/`[^`]+`/.test(text)) scores.mysql += 8;
        if (/\[[^\]]+\]/.test(text)) scores.mssql += 8;
    }

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
        confidence: confident ? (quoteHint ? 'medium' : 'high') : 'low',
        scores,
    };
}
