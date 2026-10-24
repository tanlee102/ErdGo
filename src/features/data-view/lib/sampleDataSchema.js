/** Dictionary-free schema inspection for the generator dialog and generation facade. */
import { createSqlExecutor } from './sqlExecutor';
import { sqlToErdSchema } from '@/lib/erdJsonSchema';
import { identifierPartsFromText } from '@/lib/sqlIdentifierIdentity';
import { detectSqlDialectProfile } from '@/lib/sqlDialectProfiles';
import { tokenize } from '@/lib/parse-ast/tokenize';
import { inferSampleGenerator } from './sampleDataGenerators';
import { inferSampleNullability } from './sampleDataNullability';

export { SAMPLE_DATA_LIMITS } from './sampleDataGenerators';

function quoteName(value, dialect) {
    if (dialect === 'mysql') return '`' + String(value).replace(/`/g, '``') + '`';
    if (dialect === 'mssql') return '[' + String(value).replace(/]/g, ']]') + ']';
    return '"' + String(value).replace(/"/g, '""') + '"';
}

const findTable = (tables, name) => [...tables.values()].find(table => table.name.toLowerCase() === String(name).toLowerCase());
const expressionSql = expression => typeof expression === 'string' ? expression : (expression || []).map(token => token.raw || token.value).join(' ');

function namespaceChanges(sql) {
    const { tokens } = tokenize(sql);
    const word = token => token && ['KW', 'IDENT'].includes(token.type) ? String(token.value).toUpperCase() : '';
    let statementStart = true;
    const changes = [];
    tokens.forEach((token, index) => {
        const value = word(token);
        if (token.value === ';' || value === 'GO') { statementStart = true; return; }
        if (!statementStart) return;
        statementStart = false;
        const offset = ['LOCAL', 'SESSION'].includes(word(tokens[index + 1])) ? 2 : 1;
        if (value === 'USE' || value === 'SET' && ['SEARCH_PATH', 'SCHEMA'].includes(word(tokens[index + offset]))) changes.push(token.start.idx);
    });
    return changes;
}

function columnHints(table, column) {
    const hints = {};
    const escaped = column.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const field = `(?:"${escaped}"|\u0060${escaped}\u0060|\\[${escaped}\\]|\\b${escaped}\\b)`;
    const expressions = [column.check, ...(table.checks || []).map(check => check.expression)].filter(Boolean);
    for (const expression of expressions) {
        const sql = expressionSql(expression);
        // Disjunctions do not imply an individual bound. The executor remains
        // authoritative for every CHECK, including expressions we cannot infer.
        if (/\bOR\b/i.test(sql)) continue;
        const list = sql.match(new RegExp(`${field}\\s+IN\\s*\\(([^)]+)\\)`, 'i'));
        if (list) {
            const { tokens } = tokenize(list[1]);
            if (tokens.every(token => ['STRING', 'NUMBER'].includes(token.type) || token.value === ',')) {
                hints.choices = tokens.filter(token => token.value !== ',').map(token => token.type === 'NUMBER' ? Number(token.value) : token.value);
            }
        }
        const between = sql.match(new RegExp(`${field}\\s+BETWEEN\\s+(-?\\s*\\d+(?:\\.\\d+)?)\\s+AND\\s+(-?\\s*\\d+(?:\\.\\d+)?)`, 'i'));
        if (between) { hints.min = Number(between[1].replace(/\s/g, '')); hints.max = Number(between[2].replace(/\s/g, '')); }
        for (const match of sql.matchAll(new RegExp(`${field}\\s*(>=|<=|>|<|=)\\s*(-?\\s*\\d+(?:\\.\\d+)?)`, 'gi'))) {
            const value = Number(match[2].replace(/\s/g, ''));
            const step = /INT|SERIAL/.test(column.type.toUpperCase()) ? 1 : 0.01;
            if (match[1].startsWith('>') || match[1] === '=') hints.min = Math.max(hints.min ?? -Infinity, value + (match[1] === '>' ? step : 0));
            if (match[1].startsWith('<') || match[1] === '=') hints.max = Math.min(hints.max ?? Infinity, value - (match[1] === '<' ? step : 0));
        }
    }
    return hints;
}

export function inspectSampleSchema(sql, requestedDialect = 'auto') {
    return prepareSampleSchema(sql, requestedDialect).model;
}

// Worker-local preparation is consumed once by generation. Never send the
// executor to the UI or reuse it after generation has started mutating rows.
export function prepareSampleSchema(sql, requestedDialect = 'auto') {
    const dialect = requestedDialect === 'auto' ? detectSqlDialectProfile(sql).profile.id : requestedDialect;
    const schema = sqlToErdSchema(sql, { dialect });
    const executor = createSqlExecutor({ dialect, cacheInsertConstraints: true });
    const result = executor.execute(sql);
    const errors = [...new Set([
        ...result.log.filter(entry => entry.type === 'error').map(entry => entry.message),
        ...(schema._parseErrors || []).filter(entry => entry.severity === 'error').map(entry => entry.message),
    ])];
    const seen = new Set();
    const tables = [];
    const contextChanges = namespaceChanges(sql);
    for (const source of schema.tables) {
        const parts = source.sourceParts?.length ? source.sourceParts : identifierPartsFromText(source.sourceName || source.name);
        const leaf = parts.at(-1)?.value;
        const key = leaf?.toLowerCase();
        if (seen.has(key)) {
            errors.push(`Multiple tables use the name "${leaf}" in different schemas or letter cases. Sample generation cannot validate them separately yet.`);
            continue;
        }
        seen.add(key);
        if (parts.length === 1 && contextChanges.some(index => index > (source.sourcePosition?.index ?? 0))) errors.push(`${leaf}: the SQL changes its database/search_path after this table was created. Qualify the table name in SQL before generating data.`);
        const table = findTable(result.tables, leaf);
        if (!table || table.isView) continue;
        const columnKeys = table.columns.map(column => column.name.toLowerCase());
        if (new Set(columnKeys).size !== columnKeys.length) errors.push(`${leaf}: columns that differ only in letter case cannot be validated separately in Data View.`);
        const columns = table.columns.map(column => {
            const hints = columnHints(table, column);
            const sourceColumn = source.columns.find(item => item.name.toLowerCase() === column.name.toLowerCase());
            const quoted = sourceColumn?.nameParts?.[0]?.quoted;
            const sqlColumnName = dialect === 'postgres' && !quoted ? column.name.toLowerCase() : column.name;
            return { ...column, sqlColumnName, hints, suggested: hints.choices?.length ? 'choice' : inferSampleGenerator(column) };
        });
        // An implicit renderer namespace is not the database's connection
        // context. Preserve unqualified declarations (including temp tables)
        // instead of inventing public/dbo/main prefixes in exported SQL.
        const sqlParts = parts;
        const nullabilityPatterns = inferSampleNullability(columns, [
            ...columns.map(column => column.check), ...(table.checks || []).map(check => check.expression),
        ].filter(Boolean).map(expressionSql));
        tables.push({ name: table.name, label: parts.map(part => part.value).join('.'), sqlName: sqlParts.map(part => quoteName(dialect === 'postgres' && !part.quoted ? part.value.toLowerCase() : part.value, dialect)).join('.'), columns, existingRows: table.rows.length, ...(nullabilityPatterns ? { nullabilityPatterns } : {}) });
    }
    if (!tables.length && !errors.length) errors.push('Add a CREATE TABLE statement before generating sample data.');
    return { sql, requestedDialect, consumed: false, executor, model: { dialect, tables, errors, warnings: [...new Set(result.log.filter(entry => entry.type === 'warning').map(entry => entry.message))] } };
}
