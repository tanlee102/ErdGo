/** Native SQL generation and validation for the Add Table draft. */
import { formatDefault, FK_ACTIONS } from './dialectConfig';
import { identifierKey, identifierPartsFromText, identifierPartsFrom, identifierPartsEquivalent } from '@/lib/sqlIdentifierIdentity';
import { tokenize } from '@/lib/parse-ast/tokenize';
import { parseAST } from '@/lib/parse-ast/parseAst';
import { sqlToErdSchema } from '@/lib/erdJsonSchema';
import { isSqlNullLiteral, normalizedSqlColumnType } from '@/lib/sqlColumnTypes';
import { getSqlDialectProfile } from '@/lib/sqlDialectProfiles';
import { validateSqlTableLimits } from '@/lib/sqlTableLimits';

export function generateColumnLine(col, dialect) {
    const q = dialect.quoteColumn;
    const parts = [q(col.name || 'col')];

    // Generated/computed column — special-cased; no default/check/fk allowed.
    if (col.generated && col.generated.trim()) {
        if (!dialect.computedTypeInferred) parts.push(col.type || 'TEXT');
        parts.push(dialect.generatedSql(col.generated.trim()));
        if (col.notNull) parts.push('NOT NULL');
        return '  ' + parts.join(' ');
    }

    // Auto-increment column — translate type + suffix per dialect.
    //
    // `placement` controls when the suffix is emitted:
    //   • 'after-type' (default — MySQL/MSSQL): suffix follows the type, e.g.
    //     `id INT AUTO_INCREMENT PRIMARY KEY`.
    //   • 'after-pk'   (SQLite):                suffix follows PRIMARY KEY,
    //     e.g. `id INTEGER PRIMARY KEY AUTOINCREMENT`.
    //
    // For SQLite composite-PK columns the inline `PRIMARY KEY` is suppressed,
    // so the `after-pk` suffix is naturally suppressed too (which is correct —
    // SQLite forbids AUTOINCREMENT on composite PKs).
    let aiSuffix = '';
    let aiPlacement = 'after-type';
    if (col.autoIncrement) {
        const ai = dialect.autoIncrement(col.type);
        parts.push(ai.type);
        aiSuffix = ai.suffix || '';
        aiPlacement = ai.placement || 'after-type';
        if (aiSuffix && aiPlacement === 'after-type') parts.push(aiSuffix);
    } else {
        parts.push(col.type || 'TEXT');
    }

    // Inline PRIMARY KEY only when this is the *single* PK column. Composite
    // PKs are emitted as a table-level constraint by the caller.
    if (col.primaryKey && !col._isComposite) {
        parts.push('PRIMARY KEY');
        if (aiSuffix && aiPlacement === 'after-pk') parts.push(aiSuffix);
    }
    if (col.unique) parts.push('UNIQUE');
    if ((col.notNull && !col.primaryKey) || (col.primaryKey && col._isComposite)) parts.push('NOT NULL');

    if (col.defaultValue?.trim() && !col.autoIncrement) {
        parts.push(`DEFAULT ${formatDefault(col.defaultValue, dialect, col.type)}`);
    }

    if (col.check && col.check.trim()) {
        parts.push(`CHECK (${col.check.trim()})`);
    }

    if (col.references?.table && col.references?.column && dialect.id !== 'mysql') {
        const reference = dialect.id === 'sqlite' ? dialect.quoteColumn(identifierPartsFromText(col.references.table).at(-1)?.value || col.references.table) : dialect.quoteIdent(col.references.table);
        parts.push(`REFERENCES ${reference}(${dialect.quoteColumn(col.references.column, col.references.columnQuoted === true)})`);
        if (dialect.supportsFkActions) {
            if (col.references.onDelete) parts.push(`ON DELETE ${col.references.onDelete}`);
            if (col.references.onUpdate) parts.push(`ON UPDATE ${col.references.onUpdate}`);
        }
    }

    return '  ' + parts.join(' ');
}

export function generateSql({ tableName, columns, dialect, ifNotExists }) {
    if (!tableName) return '';

    const q = dialect.quoteIdent;
    const pkCols = columns.filter((c) => c.primaryKey);
    const isComposite = pkCols.length >= 2;
    const taggedCols = columns.map((c) => ({ ...c, _isComposite: isComposite }));

    const colLines = taggedCols.map((c) => generateColumnLine(c, dialect));

    if (isComposite) {
        const pkList = pkCols.map((c) => dialect.quoteColumn(c.name || 'col')).join(', ');
        colLines.push(`  PRIMARY KEY (${pkList})`);
    }

    // MySQL parses inline REFERENCES but does not enforce them. Emit actual
    // table foreign keys so the native engine and the diagram agree.
    if (dialect.id === 'mysql') for (const col of columns) {
        if (col.generated?.trim() || !col.references?.table || !col.references?.column) continue;
        let clause = `  FOREIGN KEY (${dialect.quoteColumn(col.name)}) REFERENCES ${q(col.references.table)}(${dialect.quoteColumn(col.references.column, col.references.columnQuoted === true)})`;
        if (col.references.onDelete) clause += ` ON DELETE ${col.references.onDelete}`;
        if (col.references.onUpdate) clause += ` ON UPDATE ${col.references.onUpdate}`;
        colLines.push(clause);
    }

    const tablePart = q(tableName);
    const head =
        ifNotExists && dialect.supportsIfNotExists
            ? `CREATE TABLE IF NOT EXISTS ${tablePart}`
            : `CREATE TABLE ${tablePart}`;

    let sql = `${head} (\n${colLines.join(',\n')}\n)`;
    if (dialect.tableSuffix) sql += ` ${dialect.tableSuffix}`;
    sql += ';';

    // MSSQL `IF NOT EXISTS` uses a native OBJECT_ID guard.
    if (ifNotExists && !dialect.supportsIfNotExists && dialect.id === 'mssql') {
        const objId = `OBJECT_ID(N'${tablePart.replace(/'/g, "''")}', N'U')`;
        sql = `IF ${objId} IS NULL\nBEGIN\n${sql}\nEND;`;
    }

    return sql;
}

function getColumnLabel(col, index) {
    const name = typeof col?.name === 'string' ? col.name.trim() : '';
    return name || `column ${index + 1}`;
}

export function getAddTableValidationErrors({ columns, dialect }) {
    const safeColumns = Array.isArray(columns) ? columns : [];
    const errors = [];

    safeColumns.forEach((col, index) => {
        const label = getColumnLabel(col, index);
        const references = col?.references || {};
        const hasReferenceIntent = Boolean(references.table || references.column || references.onDelete || references.onUpdate);
        const hasGenerated = Boolean(col?.generated && col.generated.trim());

        if (col?.autoIncrement && !col?.primaryKey) {
            errors.push(`${label}: auto-increment requires PRIMARY KEY`);
        }

        if (hasReferenceIntent && !(references.table && references.column)) {
            errors.push(`${label}: choose both reference table and reference column`);
        }
        const actions = [references.onDelete, references.onUpdate].filter(Boolean);
        for (const action of actions) if (!(dialect.fkActions || FK_ACTIONS).includes(action)) errors.push(`${label}: ${dialect.label} does not support ${action}`);
        if (actions.includes('SET NULL') && (col.notNull || col.primaryKey)) errors.push(`${label}: SET NULL requires a nullable foreign-key field`);
        if (actions.includes('SET DEFAULT') && (col.notNull || col.primaryKey) && (!col.defaultValue?.trim() || isSqlNullLiteral(col.defaultValue))) errors.push(`${label}: SET DEFAULT requires a non-null default on this required field`);

        if (hasGenerated) {
            const hasGeneratedConflict = Boolean(
                col?.autoIncrement ||
                col?.primaryKey ||
                col?.unique ||
                col?.defaultValue ||
                col?.check ||
                references.table ||
                references.column,
            );
            if (hasGeneratedConflict) {
                errors.push(`${label}: generated columns cannot also use PK, UNIQUE, DEFAULT, CHECK, FK, or auto-increment`);
            }
        }
    });

    if (['mysql', 'mssql'].includes(dialect?.id) && safeColumns.filter((col) => col?.autoIncrement).length > 1) errors.push(`${dialect.label} allows only one auto-increment column per table`);

    if (dialect?.id === 'sqlite') {
        const primaryKeyColumns = safeColumns.filter((col) => col?.primaryKey);
        const hasCompositeAutoIncrement = primaryKeyColumns.length >= 2 && primaryKeyColumns.some((col) => col?.autoIncrement);
        if (hasCompositeAutoIncrement) {
            errors.push('SQLite AUTOINCREMENT requires a single INTEGER PRIMARY KEY column');
        }
    }

    return errors;
}

function fieldIsSafe(value, typeOnly = false) {
    const { tokens, errors } = tokenize(value, { skipComments: false });
    let depth = 0;
    for (const token of tokens) {
        if (token.type === 'COMMENT') return false;
        if (token.type === 'PUNC') {
            if (token.value === ';' || (token.value === ',' && depth === 0)) return false;
            if (token.value === '(') depth += 1;
            if (token.value === ')' && --depth < 0) return false;
        }
        if (typeOnly && depth === 0 && token.type === 'KW' && /^(PRIMARY|UNIQUE|NOT|NULL|DEFAULT|CHECK|REFERENCES|CONSTRAINT|GENERATED|AS|IDENTITY|AUTO_INCREMENT|AUTOINCREMENT)$/.test(token.value.toUpperCase())) return false;
    }
    return !errors.length && depth === 0;
}

function nativeTypeError(type, dialect, keyed) {
    const raw = type.trim().toUpperCase().replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1');
    if (keyed && (dialect === 'mysql' && /^(?:(?:TINY|MEDIUM|LONG)?(?:TEXT|BLOB)|JSON)\b/.test(raw) || dialect === 'mssql' && /^(TEXT|NTEXT|IMAGE|XML)\b|\(MAX\)/.test(raw) || dialect === 'postgres' && raw === 'JSON')) return 'choose an indexable type for a primary or unique key';
    if (dialect === 'sqlite') return null; // Native affinity tables permit arbitrary declared types.
    const params = raw.match(/^(\w+(?: \w+)*)\(([^)]*)\)/);
    if (!params) return null;
    const [, base, argumentsText] = params;
    const args = argumentsText.split(',');
    const n = Number(args[0]);
    let valid = true;
    if (['DECIMAL', 'NUMERIC'].includes(base)) {
        const scale = args[1] === undefined ? 0 : Number(args[1]);
        valid = args.length <= 2 && args.every(arg => /^-?\d+$/.test(arg)) && n >= 1 && n <= (dialect === 'postgres' ? 1000 : dialect === 'mysql' ? 65 : 38)
            && (dialect === 'postgres' ? Math.abs(scale) <= 1000 : scale >= 0 && scale <= n && scale <= (dialect === 'mysql' ? 30 : 38));
    } else if (base === 'BIT' && dialect !== 'mssql' || dialect === 'postgres' && ['BIT VARYING', 'VARBIT'].includes(base)) {
        // PostgreSQL bit strings have a positive length; MySQL caps it at 64.
        // SQL Server BIT has no length parameter and falls through below.
        valid = args.length === 1 && /^\d+$/.test(args[0]) && n >= 1 && (dialect !== 'mysql' || n <= 64);
    } else if (base === 'FLOAT' && ['postgres', 'mssql'].includes(dialect)) {
        valid = args.length === 1 && /^\d+$/.test(args[0]) && n >= 1 && n <= 53;
    } else if (['VARCHAR', 'NVARCHAR', 'CHAR', 'NCHAR', 'BINARY', 'VARBINARY'].includes(base)) {
        const max = dialect === 'mssql' ? base.startsWith('N') ? 4000 : 8000 : dialect === 'mysql' ? ['CHAR', 'NCHAR', 'BINARY'].includes(base) ? 255 : base.includes('BINARY') ? 65535 : 16383 : 10485760;
        valid = args.length === 1 && (dialect === 'mssql' && ['VARCHAR', 'NVARCHAR', 'VARBINARY'].includes(base) && args[0] === 'MAX' || /^\d+$/.test(args[0]) && n >= 1 && n <= max);
    } else if (dialect === 'mssql' && ['TIMESTAMP', 'DATETIME'].includes(base)) valid = false;
    else if (['TIME', 'TIMESTAMP', 'DATETIME', 'DATETIME2', 'DATETIMEOFFSET'].includes(base)) valid = args.length === 1 && /^\d+$/.test(args[0]) && n <= (dialect === 'mssql' ? 7 : 6);
    else if (dialect !== 'mysql' && ['INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'REAL', 'BOOLEAN', 'BIT', 'TEXT'].includes(base)) valid = false;
    return valid ? null : `invalid ${base} size or precision for ${dialect}`;
}

function markCastTypeSymbols(tokens, start, symbols) {
    const isName = token => token && ['IDENT', 'KW'].includes(token.type);
    if (!isName(tokens[start])) return;
    let at = start;
    symbols.add(at++);
    while (tokens[at]?.value === '.' && isName(tokens[at + 1])) { symbols.add(at++); symbols.add(at++); }
    // Consume type grammar only. IS/AND/CASE and the following field belong to
    // the expression, even when the lexer represents them as identifiers.
    const continuations = new Set(['PRECISION', 'VARYING', 'CHARACTER', 'CHAR', 'LARGE', 'OBJECT', 'WITH', 'WITHOUT', 'TIME', 'ZONE', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'TO', 'INTEGER']);
    while (at < tokens.length) {
        if (tokens[at].type === 'PUNC' && tokens[at].value === '(') {
            let depth = 0;
            do {
                if (tokens[at].value === '(') depth += 1;
                if (tokens[at].value === ')') depth -= 1;
                symbols.add(at++);
            } while (at < tokens.length && depth > 0);
        } else if (isName(tokens[at]) && !/^["`[]/.test(tokens[at].raw) && continuations.has(tokens[at].value.toUpperCase())) symbols.add(at++);
        else break;
    }
}

function expressionDependencies(columns, dialect, tableName) {
    const errors = [];
    const names = new Map(columns.map(col => [identifierKey(identifierPartsFromText(dialect.quoteColumn(col.name)), dialect.id), col]));
    const generated = new Map();
    const constants = new Set(['CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'LOCALTIME', 'LOCALTIMESTAMP', 'CURRENT_USER', 'SESSION_USER', 'CURRENT_SCHEMA', 'ARRAY', 'INTERVAL']);
    const grammar = new Set(['IS', 'AND', 'OR', 'NOT', 'NULL', 'TRUE', 'FALSE', 'BETWEEN', 'IN', 'LIKE', 'ILIKE', 'SIMILAR', 'TO', 'ESCAPE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'DISTINCT', 'FROM', 'AS', 'COLLATE']);
    const ownerParts = identifierPartsFromText(dialect.quoteIdent(tableName));
    for (const col of columns) for (const field of ['check', 'generated']) {
        if (!col[field]?.trim()) continue;
        const tokens = tokenize(col[field]).tokens;
        const dependencies = new Set();
        const symbols = new Set();
        const dateFunctions = new Set(['EXTRACT', 'DATEADD', 'DATEDIFF', 'DATEDIFF_BIG', 'DATEPART', 'DATENAME']);
        for (let i = 0; i < tokens.length; i += 1) {
            // TIME/ZONE can also be field names; ignore them only in this grammar.
            if (tokens.slice(i, i + 3).map(token => !/^["`[]/.test(token.raw) ? token.value.toUpperCase() : '').join(' ') === 'AT TIME ZONE') {
                symbols.add(i); symbols.add(i + 1); symbols.add(i + 2);
            }
            if (dateFunctions.has(tokens[i].value.toUpperCase()) && tokens[i + 1]?.value === '(') {
                // A date-part name is SQL grammar, not a field reference.
                let at = i + 2; while (tokens[at] && ![',', 'FROM', ')'].includes(tokens[at].value.toUpperCase())) { symbols.add(at); at += 1; }
                if (tokens[at]?.value.toUpperCase() === 'FROM') symbols.add(at);
            }
            if (tokens[i - 1]?.value === '::' || tokens[i - 1]?.value.toUpperCase() === 'AS') {
                // Cast targets may be qualified custom types or multiword types.
                markCastTypeSymbols(tokens, i, symbols);
            }
        }
        if (tokens.at(-1)?.type === 'OP' || tokens.some(t => t.type === 'KW' && /^(SELECT|INSERT|UPDATE|DELETE)$/.test(t.value.toUpperCase()))) errors.push(`${col.name}: ${field} needs a complete expression without a subquery`);
        for (let i = 0; i < tokens.length; i += 1) {
            let token = tokens[i];
            if (symbols.has(i) || !['KW', 'IDENT'].includes(token.type) || /^(AS|COLLATE)$/i.test(tokens[i - 1]?.value || '')) continue;
            const parts = identifierPartsFromText(token.raw);
            while (tokens[i + 1]?.value === '.' && ['KW', 'IDENT'].includes(tokens[i + 2]?.type)) {
                i += 2; token = tokens[i]; parts.push(...identifierPartsFromText(token.raw));
            }
            if (tokens[i + 1]?.value === '(') continue; // Includes schema-qualified functions.
            if (parts.length > 1) {
                const qualifier = parts.slice(0, -1);
                if (field === 'generated' && dialect.id === 'sqlite') errors.push(`${col.name}: use unqualified column names in SQLite generated expressions`);
                else if (!identifierPartsEquivalent(qualifier, ownerParts, getSqlDialectProfile(dialect.id).defaultSchema, dialect.id)
                    && identifierKey(qualifier, dialect.id) !== identifierKey(ownerParts.slice(-1), dialect.id)) errors.push(`${col.name}: ${field} references unknown table ${qualifier.map(part => part.value).join('.')}`);
            }
            if (parts.length === 1 && !parts[0]?.quoted && (constants.has(token.value.toUpperCase()) || grammar.has(token.value.toUpperCase()))) continue;
            const key = identifierKey(identifierPartsFromText(token.raw), dialect.id);
            const reference = names.get(key);
            if (reference) dependencies.add(reference.name);
            else if (token.type === 'IDENT' || parts.length > 1) errors.push(`${col.name}: ${field} references unknown field ${token.value}`);
        }
        if (field === 'generated') generated.set(col.name, dependencies);
    }
    for (const [name, refs] of generated) for (const ref of refs) {
        if (ref === name) errors.push(`${name}: generated expressions cannot reference themselves`);
        else if (['postgres', 'mssql'].includes(dialect.id) && generated.has(ref)) errors.push(`${name}: ${dialect.label} generated expressions cannot reference another generated field`);
    }
    const counts = new Map(); const dependents = new Map(); const queue = [];
    for (const [name, refs] of generated) {
        const dependencies = [...refs].filter(ref => generated.has(ref)); counts.set(name, dependencies.length);
        if (!dependencies.length) queue.push(name);
        for (const dependency of dependencies) { if (!dependents.has(dependency)) dependents.set(dependency, []); dependents.get(dependency).push(name); }
    }
    // A linear topological walk handles long chains without recursion.
    for (let i = 0; i < queue.length; i += 1) for (const dependent of dependents.get(queue[i]) || []) {
        counts.set(dependent, counts.get(dependent) - 1); if (!counts.get(dependent)) queue.push(dependent);
    }
    if (queue.length !== generated.size) errors.push('Generated fields contain a circular dependency');
    return errors;
}

function referenceName(table, dialect) {
    if (table.sourceParts?.length) {
        const parts = dialect.id === 'sqlite' ? table.sourceParts.slice(-1) : table.sourceParts;
        return parts.map(part => dialect.quoteColumn(part.value, part.quoted)).join('.');
    }
    const prefix = table.schemaName ? `${table.schemaName}.` : '';
    const leaf = prefix && table.fullName?.startsWith(prefix) ? table.fullName.slice(prefix.length) : table.name;
    return table.hasExplicitSchema && dialect.id !== 'sqlite'
        ? `${dialect.quoteColumn(table.schemaName)}.${dialect.quoteColumn(leaf)}`
        : dialect.quoteColumn(leaf);
}

/** Indexed schema metadata excludes composite, partial and expression keys. */
export function getAddTableReferenceTargets({ schema, column, dialect, tableName = '' }) {
    if (!column || column.generated?.trim() || !column.type?.trim() && !column.autoIncrement || column.type?.trim() && !fieldIsSafe(column.type, true)) return [];
    const sourceSql = generateSql({ tableName: 'erdgo_type_probe', columns: [{ ...column, name: 'value', references: {} }], dialect });
    const source = sqlToErdSchema(sourceSql, { dialect: dialect.id }).tables[0]?.columns[0];
    const type = normalizedSqlColumnType(source, dialect.id);
    if (!type) return [];
    const namespace = identifierPartsFromText(dialect.quoteIdent(tableName)).at(-2)?.value?.toLowerCase() || 'main';
    return (schema?.tables || []).flatMap(table => {
        if (dialect.id === 'sqlite' && String(table.schemaName || 'main').toLowerCase() !== namespace) return [];
        const primary = table.columns.filter(c => c.pk);
        const unique = new Set((table.candidateKeyColumnGroups || []).filter(group => group.length === 1).map(group => group[0]));
        const columns = table.columns.filter(c => (primary.length === 1 && c.pk || unique.has(c.name) || c.constraints?.includes('UQ') && !c.compositeUq && !c.compositePartialUq)
            && !c.extras?.some(extra => /^(GENERATED|AS\s*\()/i.test(extra))
            && normalizedSqlColumnType(c, dialect.id) === type);
        return columns.length ? [{ name: table.name, value: referenceName(table, dialect), columns }] : [];
    });
}

/** Validate the exact insertion, including native dialect and execution order. */
export function validateAddTableDraft({ tableName, columns, dialect, ifNotExists = false, beforeSql = '', afterSql = '' }) {
    if (!Array.isArray(columns) || columns.some(col => !col || typeof col !== 'object')) return { ok: false, errors: ['Complete the table fields.'] };
    const errors = getAddTableValidationErrors({ columns, dialect });
    if (!tableName?.trim() || !columns?.length || columns.some(c => !c.name?.trim() || (!c.type?.trim() && !c.autoIncrement && !(c.generated?.trim() && (dialect.computedTypeInferred || dialect.id === 'sqlite'))))) return { ok: false, errors };
    const seen = new Set();
    const parts = identifierPartsFromText(dialect.quoteIdent(tableName));
    if (parts.length > (dialect.id === 'mssql' ? 3 : 2)) errors.push(`${dialect.label} does not support this many table-name qualifiers`);
    const limit = { postgres: 63, mysql: 64, mssql: 128 }[dialect.id];
    const size = name => dialect.id === 'postgres' ? new TextEncoder().encode(name).length : Array.from(name).length;
    if (limit && parts.some(part => size(part.value) > limit)) errors.push(`${dialect.label} table-name parts must fit within ${limit} ${dialect.id === 'postgres' ? 'UTF-8 bytes' : 'characters'}`);
    for (const col of columns) {
        if (limit && size(col.name) > limit) errors.push(`${col.name}: column names must fit within ${limit} ${dialect.id === 'postgres' ? 'UTF-8 bytes' : 'characters'}`);
        const key = identifierKey(identifierPartsFromText(dialect.quoteColumn(col.name)), dialect.id);
        if (seen.has(key)) errors.push(`${col.name}: duplicate column name`);
        seen.add(key);
        if (col.type?.trim() && !(dialect.computedTypeInferred && col.generated?.trim()) && !fieldIsSafe(col.type, true)) errors.push(`${col.name}: enter a data type; configure constraints in column options`);
        for (const name of ['check', 'generated']) if (col[name]?.trim() && !fieldIsSafe(col[name])) errors.push(`${col.name}: ${name} must be one balanced SQL expression`);
        if (col.defaultValue?.trim() && !fieldIsSafe(formatDefault(col.defaultValue, dialect, col.type))) errors.push(`${col.name}: default must be one balanced SQL expression or literal`);
        if (!col.autoIncrement && !(dialect.computedTypeInferred && col.generated?.trim())) {
            const typeError = nativeTypeError(col.type || '', dialect.id, col.primaryKey || col.unique);
            if (typeError) errors.push(`${col.name}: ${typeError}`);
        }
    }
    if (dialect.id === 'sqlite' && columns.every(c => c.generated?.trim())) errors.push('SQLite requires at least one non-generated column');
    if (errors.length) return { ok: false, errors };
    errors.push(...expressionDependencies(columns, dialect, tableName));
    if (errors.length) return { ok: false, errors: [...new Set(errors)] };
    const sql = generateSql({ tableName, columns, dialect, ifNotExists });
    const parsed = parseAST(sql, { dialect: dialect.id });
    if (parsed.errors.some(e => e.severity !== 'warning') || parsed.ast.tables.length !== 1 || parsed.ast.tables[0].columns.length !== columns.length) return { ok: false, errors: ['The generated table is not valid SQL. Check the field types and expressions.'] };
    const limits = validateSqlTableLimits({ name: tableName, columns: parsed.ast.tables[0].columns.map(col => ({ name: col.name, type: String(col.type).toUpperCase().replace(/\s*([(),])\s*/g, '$1') })), primaryKey: columns.filter(col => col.primaryKey).map(col => col.name), unique: columns.filter(col => col.unique).map(col => [col.name]), foreignKeys: columns.filter(col => col.references?.table && col.references?.column).map(col => ({ columns: [col.name] })) }, dialect.id);
    if (limits.length) return { ok: false, errors: limits.map(issue => issue.message) };
    const { original, prefix } = readBaseline(beforeSql, afterSql, dialect.id);
    const draft = parsed.ast.tables[0];
    const same = t => identifierPartsEquivalent(identifierPartsFrom(t.sourceName || t.name, t.sourceParts), identifierPartsFrom(draft), getSqlDialectProfile(dialect.id).defaultSchema, dialect.id);
    if (original.tables.some(same)) return { ok: false, errors: [`Table "${tableName}" already exists`] };
    const inserted = sqlToErdSchema(`${beforeSql}\n\n${sql}`, { dialect: dialect.id });
    const final = afterSql.trim() ? sqlToErdSchema(`${beforeSql}\n\n${sql}\n\n${afterSql}`, { dialect: dialect.id }) : inserted;
    const referenceSchema = dialect.id === 'sqlite' ? final : inserted;
    const table = inserted.tables.find(t => same(t) && t.sourcePosition?.index >= beforeSql.length);
    if (!table) return { ok: false, errors: ['The new table could not be created at this SQL insertion point.'] };
    for (const col of columns) if (col.references?.table && col.references?.column) {
        if (dialect.id === 'sqlite') {
            const sourceDatabase = identifierPartsFromText(dialect.quoteIdent(tableName)).at(-2)?.value?.toLowerCase() || 'main';
            const targetParts = identifierPartsFromText(col.references.table);
            if (targetParts.length > 1 && targetParts.at(-2).value.toLowerCase() !== sourceDatabase) { errors.push(`${col.name}: SQLite references must stay in the same database`); continue; }
        }
        const from = table.columns.find(c => c.name === col.name);
        const relation = referenceSchema.relations.find(r => r.from.table === table.name && r.from.column === from?.name);
        if (!relation) errors.push(`${col.name}: choose a complete primary or single-column unique key ${dialect.id === 'sqlite' ? 'in the same SQLite database' : 'available before this table'}`);
        else {
            const to = referenceSchema.tables.find(t => t.name === relation.to.table)?.columns.find(c => c.name === relation.to.column);
            if (normalizedSqlColumnType(from, dialect.id) !== normalizedSqlColumnType(to, dialect.id)) errors.push(`${col.name}: foreign-key types must match (${from.type} → ${to.type})`);
        }
    }
    const counts = schema => (schema._parseErrors || []).filter(e => e.severity !== 'warning').length;
    if (counts(inserted) > counts(prefix)) errors.push('The new table introduces SQL validation errors. Check its fields and constraints.');
    if (afterSql.trim()) {
        if (!final.tables.some(same) || counts(final) > counts(original)) errors.push('Later SQL changes or removes this table. Update its complete history in the SQL editor.');
    }
    return { ok: !errors.length, errors, sql, tableName: table.name };
}

let baselineCache;
function readBaseline(beforeSql, afterSql, dialect) {
    // One bounded workspace cache avoids reparsing unchanged SQL while typing.
    if (baselineCache?.beforeSql !== beforeSql || baselineCache.afterSql !== afterSql || baselineCache.dialect !== dialect) {
        const prefix = sqlToErdSchema(beforeSql, { dialect });
        baselineCache = { beforeSql, afterSql, dialect, prefix, original: afterSql.trim() ? sqlToErdSchema(`${beforeSql}\n\n${afterSql}`, { dialect }) : prefix };
    }
    return baselineCache;
}
