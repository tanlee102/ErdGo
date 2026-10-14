/** Shared storage-type compatibility for visual SQL edits; modifiers stay significant. */
import { tokenize } from './parse-ast/tokenize.js';
const TYPE_ALIASES = Object.entries({ INT: 'INTEGER', INT4: 'INTEGER', SERIAL: 'INTEGER', SERIAL4: 'INTEGER', INT8: 'BIGINT', BIGSERIAL: 'BIGINT', SERIAL8: 'BIGINT', INT2: 'SMALLINT', SMALLSERIAL: 'SMALLINT', SERIAL2: 'SMALLINT', 'CHARACTER VARYING': 'VARCHAR', CHARACTER: 'CHAR', DEC: 'DECIMAL', NUMERIC: 'DECIMAL', 'DOUBLE PRECISION': 'DOUBLE' }).sort(([a], [b]) => b.length - a.length);

function normalizeTypeText(value, dialect) {
    const quoted = [];
    // Lexing discards comments without touching quoted names or enum values.
    const text = tokenize(String(value || '')).tokens.map(token => token.raw || token.value).join(' ');
    const masked = text.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"/g, (raw) => {
        const name = raw.slice(1, -1).replace(/""/g, '"');
        // PostgreSQL folds unquoted names. Lowercase quoted bare names refer to
        // that same identity, while "Foo" and "foo" remain different types.
        if (raw[0] === '"' && /^[a-z_][a-z0-9_$]*$/.test(name) && dialect === 'postgres') return name;
        const index = quoted.push(raw) - 1; return `\uFDD0${index}\uFDD1`;
    });
    return masked.trim().toUpperCase().replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').replace(/\s*\.\s*/g, '.').replace(/\[\s*\]/g, '[]').replace(/\uFDD0(\d+)\uFDD1/g, (_, index) => quoted[Number(index)]);
}

/** Recognize a literal NULL, including wrapping parentheses and comments. */
export function isSqlNullLiteral(value) {
    const { tokens, errors } = tokenize(String(value || ''));
    if (errors.length) return false;
    let start = 0; let end = tokens.length;
    while (tokens[start]?.type === 'PUNC' && tokens[start].value === '(' && tokens[end - 1]?.type === 'PUNC' && tokens[end - 1].value === ')') { start += 1; end -= 1; }
    return end - start === 1 && tokens[start]?.type === 'KW' && tokens[start].value.toUpperCase() === 'NULL';
}

export function isSqlColumnRequired(column, table, dialect) {
    if (column?.explicitNotNull || column?.constraints?.includes('NN')) return true;
    if (!column?.pk) return false;
    if (dialect !== 'sqlite' || table?.options?.strict || table?.options?.withoutRowid) return true;
    // Ordinary SQLite rowid tables allow NULL in non-rowid primary keys.
    return !column.compositePk && String(column.type || '').trim().toUpperCase() === 'INTEGER';
}

export function normalizedSqlColumnType(column, dialect) {
    // SQL Server infers a computed column's type from its expression. The
    // parser's fallback display type cannot prove FK compatibility.
    if (dialect === 'mssql' && column?.extras?.some(extra => /^AS\s*\(/i.test(extra))) return '';
    let type = normalizeTypeText(column?.declaredTypeSql || column?.type, dialect);
    for (const [alias, canonical] of TYPE_ALIASES) {
        if (type === alias || type.startsWith(`${alias}(`) || type.startsWith(`${alias} `) || type.startsWith(`${alias}[`)) {
            type = canonical + type.slice(alias.length);
            break;
        }
    }
    if (dialect === 'mysql') type = type.replace(/^(INTEGER|BIGINT|SMALLINT|TINYINT|MEDIUMINT)\(\d+\)/, '$1');
    const modifiers = (column?.extras || []).filter((extra) => /^(UNSIGNED|ZEROFILL|COLLATE\b|CHARACTER SET\b)/i.test(extra)).map((extra) => normalizeTypeText(extra, dialect)).sort();
    return type ? `${type}|${modifiers.join('|')}` : '';
}
