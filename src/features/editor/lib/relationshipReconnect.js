/** Lossless, tab-aware reconnection and deletion of explicit foreign keys. */
import { parseAST } from '@/lib/parse-ast/parseAst';
import { tokenize } from '@/lib/parse-ast/tokenize';
import { sqlToErdSchema } from '@/lib/erdJsonSchema';
import { getSqlDialectProfile } from '@/lib/sqlDialectProfiles';
import { identifierKey, identifierPartsEquivalent, identifierPartsFrom, identifierPartsFromText } from '@/lib/sqlIdentifierIdentity';
import { buildCombinedSql } from './sqlTabs';
import { isSqlColumnRequired, isSqlNullLiteral, normalizedSqlColumnType as normalizedType } from '@/lib/sqlColumnTypes';

const reject = (message) => ({ ok: false, message });
const relationId = (r) => JSON.stringify([r?.from, r?.to, r?.fkName || '', r?.actions || {}]);
const sameField = (a, b) => a?.table === b?.table && a?.column === b?.column;
// A connector edit may change only FK flags, never field definitions or keys.
const fieldState = schema => schema.tables.map(table => [table.name, table.columns.map(({ fk: _fk, ...column }) => column)]);
/** Only migrations touching this endpoint or table identity affect FK timing. */
export function hasRelationshipFieldMigration(ast, table, column, dialect) {
    if (!table || !column) return true;
    const parts = identifierPartsFrom(table.sourceName || table.name, table.sourceParts);
    const sameTable = (name, native) => identifierPartsEquivalent(parts, identifierPartsFrom(name, native), ast.dialectProfile?.defaultSchema, dialect);
    const sameColumn = (name, native) => identifierKey(identifierPartsFrom(column), dialect) === identifierKey(identifierPartsFrom(name, native), dialect);
    const origin = table.sourcePosition?.index ?? -1;
    if (ast.drops.some(drop => drop.kind === 'table' && drop.position.start.idx >= origin && sameTable(drop.name, drop.nameParts))) return true;
    return ast.alters.some(alter => {
        if (alter.position.start.idx < origin) return false;
        if (alter.action === 'rename_table' && (sameTable(alter.table, alter.tableParts) || sameTable(alter.newName, alter.newTableParts))) return true;
        if (!sameTable(alter.table, alter.tableParts)) return false;
        if (alter.action === 'set_schema') return true;
        if (!['add_column', 'drop_column', 'rename_column', 'change_column', 'modify_column', 'alter_column'].includes(alter.action) && !alter.action.startsWith('alter_column')) return false;
        return sameColumn(alter.column, alter.columnParts) || sameColumn(alter.oldName, alter.oldNameParts) || sameColumn(alter.newName, alter.newNameParts);
    });
}
const keyword = (t, word) => t?.type === 'KW' && t.value.toUpperCase() === word;
// Quoted names and string defaults may themselves contain punctuation. Only
// punctuation tokens delimit SQL bodies, lists and qualified identifiers.
const punctuation = (t, value) => t?.type === 'PUNC' && t.value === value;
let cachedWorkspace;

function readWorkspace(sql) {
    // Pointer movement visits many fields in the same workspace. Retain one
    // immutable parse, never a growing SQL history; release still reads live SQL.
    if (cachedWorkspace?.sql !== sql) {
        const schema = sqlToErdSchema(sql);
        const fieldsByType = new Map();
        const typeNames = new Map();
        const ambiguousTypes = new Set();
        [...schema.enums, ...schema.composites].forEach(({ name }) => {
            const folded = name.toLowerCase();
            if (typeNames.has(folded) && typeNames.get(folded) !== name) ambiguousTypes.add(folded);
            typeNames.set(folded, name);
        });
        schema.tables.forEach((table) => table.columns.forEach((column) => {
            const type = normalizedType(column, schema.dialect);
            if (!type) return;
            if (!fieldsByType.has(type)) fieldsByType.set(type, []);
            fieldsByType.get(type).push({ table: table.name, column: column.name, type: column.type, keyed: column.pk || column.constraints.includes('UQ') });
        }));
        cachedWorkspace = { sql, schema, ast: parseAST(sql).ast, tokens: tokenize(sql).tokens, fieldsByType, ambiguousTypes, suggestions: null };
    }
    return cachedWorkspace;
}

function quoteIdentifier(value, dialect) {
    if (dialect === 'mysql') return '`' + String(value).replace(/`/g, '``') + '`';
    if (dialect === 'mssql') return '[' + String(value).replace(/]/g, ']]') + ']';
    return '"' + String(value).replace(/"/g, '""') + '"';
}

function tableSqlName(table, dialect) {
    // schemaName is separate from the leaf name, which may itself contain dots.
    const prefix = table.schemaName ? `${table.schemaName}.` : '';
    const leaf = prefix && table.fullName?.startsWith(prefix) ? table.fullName.slice(prefix.length) : table.name;
    // SQLite REFERENCES accepts an unqualified table name in its own database.
    // Keep implicit default namespaces implicit in the other dialects too.
    return table.hasExplicitSchema && dialect !== 'sqlite' && table.schemaName
        ? `${quoteIdentifier(table.schemaName, dialect)}.${quoteIdentifier(leaf, dialect)}`
        : quoteIdentifier(leaf, dialect);
}

function matchingParen(tokens, start) {
    let depth = 0;
    for (let i = start; i < tokens.length; i += 1) {
        if (punctuation(tokens[i], '(')) depth += 1;
        if (punctuation(tokens[i], ')') && --depth === 0) return i;
    }
    return -1;
}

function tableBody(tokens, table) {
    const start = tokens.findIndex((t) => t.start.idx === table.position?.start?.idx);
    if (start < 0) return null;
    const open = tokens.findIndex((t, i) => i > start && punctuation(t, '('));
    const close = matchingParen(tokens, open);
    return open >= 0 && close >= 0 ? { open, close } : null;
}

function findForeignKey(ast, tokens, relation) {
    const anchor = relation.position?.index;
    for (const table of ast.tables) {
        const inline = table.columns.find((c) => c.references && c._token?.start.idx === anchor);
        const constraint = table.constraints.find((c) => c?.kind === 'foreign' && c._token?.start.idx === anchor);
        if (!inline && !constraint) continue;
        const body = tableBody(tokens, table);
        if (!body) return null;
        let begin = body.open + 1;
        for (let i = begin; i < body.close; i += 1) {
            let end = i;
            for (; end < body.close; end += 1) {
                if (punctuation(tokens[end], '(')) end = matchingParen(tokens, end);
                if (end < 0 || punctuation(tokens[end], ',')) break;
            }
            if (end < 0) return null;
            if (tokens[i].start.idx <= anchor && (end === body.close || anchor < tokens[end].start.idx)) {
                return { inline: Boolean(inline), table, begin: i, end, body };
            }
            i = end;
            begin = end + 1;
        }
    }
    const alter = ast.alters.find((a) => a.action === 'add_foreign' && a.position?.start?.idx === anchor);
    if (alter) {
        const begin = tokens.findIndex((t) => t.start.idx === anchor);
        const end = tokens.findIndex((t, i) => i > begin && t.start.idx >= alter.position.end.idx);
        return { inline: false, alter, begin, end: end < 0 ? tokens.length : end };
    }
    return null;
}

function referenceRange(tokens, location) {
    const ref = tokens.findIndex((t, i) => i >= location.begin && i < location.end && keyword(t, 'REFERENCES'));
    if (ref < 0) return null;
    let endName = ref + 2;
    while (punctuation(tokens[endName], '.')) endName += 2;
    const close = punctuation(tokens[endName], '(') ? matchingParen(tokens, endName) : endName - 1;
    return close >= 0 ? { ref, start: tokens[ref + 1].start.idx, end: tokens[close].end.idx, after: close + 1 } : null;
}

function sourceColumnRange(tokens, location) {
    const foreign = tokens.findIndex((t, i) => i >= location.begin && i < location.end && keyword(t, 'FOREIGN'));
    if (foreign < 0) return null;
    const open = tokens.findIndex((t, i) => i > foreign && i < location.end && punctuation(t, '('));
    const close = matchingParen(tokens, open);
    return open >= 0 && close >= 0 ? { start: tokens[open].end.idx, end: tokens[close].start.idx } : null;
}

function hasSharedAlterOperations(tokens, location) {
    if (!location?.alter) return false;
    for (let i = location.begin; i < location.end; i += 1) {
        if (punctuation(tokens[i], '(')) i = matchingParen(tokens, i);
        if (i < 0 || punctuation(tokens[i], ',')) return true;
    }
    return false;
}

function referenceClauseEnd(tokens, range) {
    let i = range.after;
    // Read only FK actions. Trailing NOT NULL/DEFAULT/CHECK/UNIQUE belong to
    // the column and must stay there when an inline reference is moved.
    while (i < tokens.length) {
        if (keyword(tokens[i], 'ON') && (keyword(tokens[i + 1], 'DELETE') || keyword(tokens[i + 1], 'UPDATE'))) {
            i += 2;
            // NO is an identifier token in the shared lexer, despite being
            // part of the native NO ACTION option. Consume both words.
            if (keyword(tokens[i], 'SET') || keyword(tokens[i], 'NO') || (tokens[i]?.type === 'IDENT' && tokens[i].value.toUpperCase() === 'NO')) i += 2;
            else i += 1;
        } else if (keyword(tokens[i], 'MATCH') || keyword(tokens[i], 'INITIALLY')) i += 2;
        else if (keyword(tokens[i], 'NOT') && keyword(tokens[i + 1], 'DEFERRABLE')) i += 2;
        else if (keyword(tokens[i], 'DEFERRABLE')) i += 1;
        else break;
    }
    return tokens[i - 1].end.idx;
}

function applyEdits(sql, edits) {
    return [...edits].sort((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), sql);
}

function hasConstraintNameCollision(sql, table, nameToken) {
    if (!nameToken) return false;
    const { ast } = parseAST(sql);
    const { tokens } = tokenize(sql);
    const defaultSchema = getSqlDialectProfile(ast.dialect).defaultSchema;
    const targetParts = identifierPartsFrom(table.sourceName, table.sourceParts);
    const isTarget = (name, parts) => identifierPartsEquivalent(targetParts, identifierPartsFrom(name, parts), defaultSchema, ast.dialect);
    const origin = table.sourcePosition?.index;
    const declaration = ast.tables.find((t) => t.position?.start?.idx === origin);
    const body = declaration && tableBody(tokens, declaration);
    // Preserve raw quoting: unquoted FK folds to fk in PostgreSQL, while
    // quoted "FK" remains a different constraint. ALTER owners fold too.
    const nameKey = identifierKey(identifierPartsFromText(nameToken.raw), ast.dialect);
    const equal = (value, parts) => value && identifierKey(identifierPartsFrom(value, parts), ast.dialect) === nameKey;
    let count = 0;
    if (body) {
        for (let i = body.open + 1; i < body.close; i += 1) {
            if (punctuation(tokens[i], '(')) i = matchingParen(tokens, i);
            else if (keyword(tokens[i], 'CONSTRAINT') && tokens[i + 1] && equal(tokens[i + 1].value, identifierPartsFromText(tokens[i + 1].raw))) count += 1;
            if (i < 0) return true;
        }
    }
    count += ast.alters.filter((a) => a.position.start.idx >= origin && isTarget(a.table, a.tableParts) && a.action.startsWith('add_') && equal(a.name, a.nameParts)).length;
    return count > 1;
}

function buildEdits(sql, ast, tokens, schema, relation, endpoint, target) {
    const location = findForeignKey(ast, tokens, relation);
    const ref = location && referenceRange(tokens, location);
    if (!ref) return null;
    const dialect = ast.dialect;
    const targetTable = schema.tables.find((t) => t.name === target.table);
    if (endpoint === 'to') return [{ start: ref.start, end: ref.end, text: `${tableSqlName(targetTable, dialect)}(${quoteIdentifier(target.column, dialect)})` }];

    const source = sourceColumnRange(tokens, location);
    if (!location.inline && sameField({ table: relation.from.table, column: target.column }, target)) {
        return source ? [{ ...source, text: quoteIdentifier(target.column, dialect) }] : null;
    }
    if (location.alter && source) {
        let nameStart = location.begin + 2;
        if (keyword(tokens[nameStart], 'ONLY')) nameStart += 1;
        let nameEnd = nameStart + 1;
        while (punctuation(tokens[nameEnd], '.')) nameEnd += 2;
        return [{ ...source, text: quoteIdentifier(target.column, dialect) }, { start: tokens[nameStart].start.idx, end: tokens[nameEnd - 1].end.idx, text: tableSqlName(targetTable, dialect) }];
    }
    // Names can be reused after DROP. Only the surviving CREATE owns this field.
    const destTable = ast.tables.find((t) => t.position?.start?.idx === targetTable.sourcePosition?.index);
    const destBody = destTable && tableBody(tokens, destTable);
    if (!destBody) return null;
    let clause;
    let removal;
    if (location.inline) {
        const end = referenceClauseEnd(tokens, ref);
        let start = tokens[ref.ref].start.idx;
        if (keyword(tokens[ref.ref - 2], 'CONSTRAINT')) start = tokens[ref.ref - 2].start.idx;
        const namePrefix = sql.slice(start, tokens[ref.ref].start.idx);
        clause = `${namePrefix}FOREIGN KEY (${quoteIdentifier(target.column, dialect)}) ${sql.slice(tokens[ref.ref].start.idx, end)}`;
        removal = { start, end, text: '' };
    } else {
        if (!source) return null;
        const start = tokens[location.begin].start.idx;
        const end = tokens[location.end - 1].end.idx;
        clause = applyEdits(sql.slice(start, end), [{ start: source.start - start, end: source.end - start, text: quoteIdentifier(target.column, dialect) }]);
        removal = location.end < location.body.close
            ? { start, end: tokens[location.end].end.idx, text: '' }
            : { start: tokens[location.begin - 1].start.idx, end, text: '' };
    }
    return [removal, { start: tokens[destBody.close].start.idx, end: tokens[destBody.close].start.idx, text: `,\n    ${clause}\n` }];
}

function prepareReconnect(sql, requestedRelation, endpoint, target, workspace = readWorkspace(sql)) {
    if (!['from', 'to'].includes(endpoint) || !target?.table || !target?.column) return reject('Choose a table field.');
    target = { table: target.table, column: target.column };
    const { schema, ast, tokens, ambiguousTypes } = workspace;
    const relation = schema.relations.find((r) => relationId(r) === relationId(requestedRelation));
    if (!relation || requestedRelation.inferred) return reject('This relationship changed. Select its current connector and try again.');
    if (relation.composite) return reject('This foreign key has multiple columns. Edit the complete key together in SQL.');
    if (sameField(relation[endpoint], target)) return { ok: true, unchanged: true, message: 'Keep this field; drag across the table to change its side.' };
    const nextRelation = { ...relation, [endpoint]: target };
    // Replaying a migration can make a final field exist although it did not
    // exist when the original CREATE/FK ran. Do not emit a forward-invalid FK.
    if ([relation.from, relation.to, target].some(field => {
        const table = schema.tables.find(model => model.name === field.table);
        return hasRelationshipFieldMigration(ast, table, table?.columns.find(column => column.name === field.column), schema.dialect);
    })) return reject('These fields are changed by table or column migrations. Update the constraint at the correct point in SQL.');
    const fromTable = schema.tables.find((t) => t.name === nextRelation.from.table);
    const fromColumn = fromTable?.columns.find((c) => c.name === nextRelation.from.column);
    const toColumn = schema.tables.find((t) => t.name === nextRelation.to.table)?.columns.find((c) => c.name === nextRelation.to.column);
    if (!fromColumn || !toColumn) return reject('This field is no longer available.');
    // Array dimensions cannot hide a case-sensitive custom type identity. Cache
    // ambiguous names once instead of comparing every type pair on each hover.
    if ([fromColumn.type, toColumn.type].some((type) => ambiguousTypes.has(type.replace(/(?:\[\])+$/, '').toLowerCase()))) return reject('Type identity is ambiguous. Verify this relationship in SQL.');
    if (!normalizedType(fromColumn, schema.dialect) || !normalizedType(toColumn, schema.dialect)) return reject('The field type cannot be verified. Update this relationship in SQL.');
    if (normalizedType(fromColumn, schema.dialect) !== normalizedType(toColumn, schema.dialect)) {
        return reject(`Types must match: ${fromColumn.type || 'unknown'} → ${toColumn.type || 'unknown'}.`);
    }
    if (schema.relations.some((r) => sameField(r.from, nextRelation.from) && sameField(r.to, nextRelation.to))) return reject('These fields already have this relationship.');
    if (endpoint === 'from' && Object.values(relation.actions || {}).includes('SET NULL') && isSqlColumnRequired(fromColumn, fromTable, schema.dialect)) return reject('SET NULL needs a nullable foreign-key field.');
    if (endpoint === 'from' && Object.values(relation.actions || {}).includes('SET DEFAULT') && isSqlColumnRequired(fromColumn, fromTable, schema.dialect) && !fromColumn.extras.some((extra) => /^DEFAULT\b/i.test(extra) && !isSqlNullLiteral(extra.replace(/^DEFAULT\s*/i, '')))) return reject('SET DEFAULT needs a non-null default value on this required field.');
    const location = findForeignKey(ast, tokens, relation);
    if (endpoint === 'from' && target.table !== relation.from.table && hasSharedAlterOperations(tokens, location)) return reject('This foreign key shares an ALTER TABLE statement. Move only its constraint to the new table in SQL.');
    const edits = buildEdits(sql, ast, tokens, schema, relation, endpoint, target);
    if (!edits) return reject('The original constraint could not be safely located. Edit this relationship in SQL.');
    let executionEnd;
    if (schema.dialect !== 'sqlite') {
        const sourceTable = schema.tables.find((table) => table.name === nextRelation.from.table);
        const owner = location?.alter || (endpoint === 'from'
            ? ast.tables.find((table) => table.position?.start?.idx === sourceTable?.sourcePosition?.index)
            : location?.table);
        executionEnd = owner?.position?.end?.idx;
        const referencedTable = schema.tables.find((table) => table.name === nextRelation.to.table);
        // PostgreSQL/MySQL/SQL Server require the referenced table/key when the
        // CREATE or ALTER FK executes. SQLite can resolve forward targets.
        // Portable SQL uses the conservative rule until SQLite is detected.
        if (!Number.isFinite(executionEnd) || sourceTable.sourcePosition.index >= executionEnd || referencedTable.sourcePosition.index >= executionEnd) return reject('Both tables and the complete referenced key must exist when the constraint runs. Place the constraint later in SQL.');
    }
    if (endpoint === 'from' && !nextRelation.fkName) {
        const location = findForeignKey(ast, tokens, relation);
        const range = location?.inline && referenceRange(tokens, location);
        // Inline names are not exposed by the schema adapter. Moving the same
        // named clause into a table constraint makes that name visible again.
        if (range && keyword(tokens[range.ref - 2], 'CONSTRAINT')) nextRelation.fkName = tokens[range.ref - 1].value;
    }
    const nextSql = applyEdits(sql, edits);
    const nextSchema = sqlToErdSchema(nextSql);
    if (endpoint === 'from') {
        const location = findForeignKey(ast, tokens, relation);
        const nameIndex = location ? tokens.findIndex((token, i) => i >= location.begin && i < location.end && keyword(token, 'CONSTRAINT') && (keyword(tokens[i + 2], 'FOREIGN') || keyword(tokens[i + 2], 'REFERENCES'))) : -1;
        const nameToken = nameIndex >= 0 ? tokens[nameIndex + 1] : null;
        // Earlier edits shift CREATE offsets; use provenance from the edited SQL.
        if (hasConstraintNameCollision(nextSql, nextSchema.tables.find((t) => t.name === target.table), nameToken)) return reject('That table already has a constraint with this name. Rename the constraint in SQL first.');
    }
    const updated = nextSchema.relations.find((r) => relationId(r) === relationId(nextRelation));
    if (!updated) return reject(endpoint === 'to' ? 'Choose a primary key or a single-column unique key. The complete constraint must remain valid.' : 'This constraint cannot be moved safely to that field. Edit it in SQL.');
    const hasLaterKeyOperations = Number.isFinite(executionEnd) && (
        ast.indexes.some((index) => index.position?.start?.idx >= executionEnd)
        || ast.alters.some((alter) => ['add_primary', 'add_unique', 'drop_constraint'].includes(alter.action) && alter.position?.start?.idx >= executionEnd)
    );
    if (hasLaterKeyOperations) {
        // A final UQ badge may come from a later ALTER/index. Validate the
        // edited execution prefix only when later key operations can matter.
        const prefix = applyEdits(sql.slice(0, executionEnd), edits.filter((edit) => edit.end <= executionEnd));
        if (!sqlToErdSchema(prefix).relations.some((r) => relationId(r) === relationId(nextRelation))) return reject('The referenced table and complete key must exist when the constraint runs. Place the constraint later in SQL.');
    }
    // Reparse before committing. Lifecycle renames, ambiguous names, duplicate
    // constraint names and unsupported clauses cannot silently rewrite other FKs.
    const expected = schema.relations.filter((r) => r !== relation).map(relationId).concat(relationId(nextRelation)).sort();
    const actual = nextSchema.relations.map(relationId).sort();
    const errors = (s) => (s._parseErrors || []).filter((e) => e.severity !== 'warning').length;
    if (JSON.stringify(expected) !== JSON.stringify(actual) || JSON.stringify(fieldState(schema)) !== JSON.stringify(fieldState(nextSchema)) || errors(nextSchema) > errors(schema)) return reject('This edit would affect another field or constraint. Edit the relationship in SQL.');
    return { ok: true, edits, message: `${target.table}.${target.column} — release to update SQL.` };
}

export function reconnectRelationshipInTabs(tabs, relation, endpoint, target) {
    const combined = buildCombinedSql(tabs);
    return reconnectInCombinedTabs(tabs, combined, relation, endpoint, target);
}

/** Remove one complete SQL constraint, retaining its fields and other SQL bytes. */
export function deleteRelationshipInTabs(tabs, requestedRelation) {
    const combined = buildCombinedSql(tabs);
    const { schema, ast, tokens } = readWorkspace(combined.sql);
    const relation = schema.relations.find((r) => relationId(r) === relationId(requestedRelation)
        && r.position?.index === requestedRelation?.position?.index
        && JSON.stringify([r.fromColumns, r.toColumns]) === JSON.stringify([requestedRelation.fromColumns, requestedRelation.toColumns]));
    if (!relation || requestedRelation.inferred) return reject('This relationship changed. Select its current connector and try again.');
    const location = findForeignKey(ast, tokens, relation);
    const ref = location && referenceRange(tokens, location);
    if (!ref) return reject('The original constraint could not be safely located. Delete this relationship in SQL.');
    const removed = relation.composite
        ? schema.relations.filter((r) => r.relationGroup === relation.relationGroup && r.position?.index === relation.position.index)
        : [relation];
    if (relation.composite && removed.length !== relation.fromColumns.length) return reject('The complete foreign key could not be located. Delete its constraint in SQL.');

    const nameIndex = tokens.findIndex((t, i) => i >= location.begin && i < location.end && keyword(t, 'CONSTRAINT')
        && (keyword(tokens[i + 2], 'FOREIGN') || keyword(tokens[i + 2], 'REFERENCES')));
    const nameToken = nameIndex >= 0 ? tokens[nameIndex + 1] : null;
    const nameKey = nameToken && identifierKey(identifierPartsFromText(nameToken.raw), schema.dialect);
    const owner = location.table || location.alter;
    let ownerParts = location.table ? identifierPartsFrom(owner.name, owner.nameParts) : identifierPartsFrom(owner.table, owner.tableParts);
    // Follow table renames so a later constraint operation cannot become a
    // dangling migration. Unrelated keys on the same table remain editable.
    for (const alter of ast.alters) {
        if (alter.position.start.idx <= relation.position.index || !identifierPartsEquivalent(ownerParts, identifierPartsFrom(alter.table, alter.tableParts), ast.dialectProfile?.defaultSchema, schema.dialect)) continue;
        if (alter.action === 'rename_table') {
            const renamed = identifierPartsFrom(alter.newName, alter.newNameParts);
            ownerParts = renamed.length === 1 && ownerParts.length > 1 ? [...ownerParts.slice(0, -1), ...renamed] : renamed;
        }
        if (['drop_constraint', 'rename_constraint'].includes(alter.action)
            && ((!nameKey && alter.constraintKind !== 'primary' && alter.constraintKind !== 'index')
                || nameKey === identifierKey(identifierPartsFrom(alter.name || alter.oldName, alter.nameParts || alter.oldNameParts), schema.dialect))) {
            return reject('This foreign key is dropped or renamed later in SQL. Update its constraint history together in SQL.');
        }
    }
    // Constraint comments/validation commands are not schema relations. A
    // semantic reparse alone cannot detect their now-missing target. Recognized
    // declarations and migrations were handled above; block other named uses.
    const knownStatements = [...ast.tables, ...ast.alters].filter((statement) => statement.position);
    if (nameKey && tokens.some((token, i) => token.start.idx > relation.position.index && keyword(token, 'CONSTRAINT')
        && tokens[i + 1] && identifierKey(identifierPartsFromText(tokens[i + 1].raw), schema.dialect) === nameKey
        && !knownStatements.some((statement) => token.start.idx >= statement.position.start.idx && token.start.idx < statement.position.end.idx))) {
        return reject('Another SQL statement uses this foreign-key constraint. Update that statement together in SQL.');
    }

    let edit;
    if (location.inline) {
        const start = keyword(tokens[ref.ref - 2], 'CONSTRAINT') ? tokens[ref.ref - 2].start.idx : tokens[ref.ref].start.idx;
        edit = { start, end: referenceClauseEnd(tokens, ref), text: '' };
    } else if (location.alter) {
        // A shared ALTER may also add a column/key. Removing the whole statement
        // would discard that operation, so require a standalone FK declaration.
        if (hasSharedAlterOperations(tokens, location)) return reject('This foreign key shares an ALTER TABLE statement. Delete only its constraint clause in SQL.');
        edit = { start: location.alter.position.start.idx, end: location.alter.position.end.idx, text: '' };
    } else {
        edit = location.end < location.body.close
            ? { start: tokens[location.begin].start.idx, end: tokens[location.end].end.idx, text: '' }
            : { start: tokens[location.begin - 1].start.idx, end: tokens[location.end - 1].end.idx, text: '' };
    }
    const nextSchema = sqlToErdSchema(applyEdits(combined.sql, [edit]), { dialect: schema.dialect });
    const expected = schema.relations.filter((r) => !removed.includes(r)).map(relationId).sort();
    const actual = nextSchema.relations.map(relationId).sort();
    // Only FK flags may change on fields. Key badges, defaults, indexes,
    // generated expressions, table identities and all other relations stay.
    const diagnostics = (s) => (s._parseErrors || []).map((e) => JSON.stringify([e.severity, e.kind, e.message]));
    const beforeErrors = new Set(diagnostics(schema));
    if (JSON.stringify(expected) !== JSON.stringify(actual) || JSON.stringify(fieldState(schema)) !== JSON.stringify(fieldState(nextSchema))
        || diagnostics(nextSchema).some((e) => !beforeErrors.has(e))) return reject('This deletion would affect other schema definitions. Delete the constraint in SQL.');
    const range = combined.ranges.find((r) => !r.isInactive && edit.start >= r.start && edit.end <= r.end);
    if (!range) return reject('The owning SQL tab is unavailable. Keep each constraint in one active tab.');
    const nextTabs = tabs.map((tab) => tab.id === range.id ? { ...tab, sql: applyEdits(tab.sql, [{ ...edit, start: edit.start - range.start, end: edit.end - range.start }]) } : tab);
    const label = relation.composite
        ? `${relation.from.table}(${relation.fromColumns.join(', ')}) → ${relation.to.table}(${relation.toColumns.join(', ')})`
        : `${relation.from.table}.${relation.from.column} → ${relation.to.table}.${relation.to.column}`;
    return { ok: true, nextTabs, impacts: [{ kind: 'remove-relationship', label }], message: label };
}

function reconnectInCombinedTabs(tabs, combined, relation, endpoint, target, workspace) {
    const result = prepareReconnect(combined.sql, relation, endpoint, target, workspace);
    if (!result.ok || result.unchanged) return result;
    const byTab = new Map();
    for (const edit of result.edits) {
        const range = combined.ranges.find((r) => !r.isInactive && edit.start >= r.start && edit.end <= r.end);
        if (!range) return reject('The owning SQL tab is unavailable.');
        if (!byTab.has(range.id)) byTab.set(range.id, []);
        byTab.get(range.id).push({ ...edit, start: edit.start - range.start, end: edit.end - range.start });
    }
    const nextTabs = tabs.map((tab) => byTab.has(tab.id) ? { ...tab, sql: applyEdits(tab.sql, byTab.get(tab.id)) } : tab);
    return { ...result, nextTabs };
}

/** Fully validate popup alternatives without blocking input on large schemas. */
export async function getRelationshipReconnectTargetsInTabs(tabs, requestedRelation, endpoint) {
    const combined = buildCombinedSql(tabs);
    const workspace = readWorkspace(combined.sql);
    const { schema, fieldsByType } = workspace;
    const relation = schema.relations.find((r) => relationId(r) === relationId(requestedRelation));
    if (!['from', 'to'].includes(endpoint) || !relation || requestedRelation.inferred) return { ...reject('This relationship changed. Select its current connector and try again.'), targets: [] };
    if (relation.composite) return { ...reject('This foreign key has multiple columns. Edit the complete key together in SQL.'), targets: [] };
    // Bound the cache to one relationship in one SQL snapshot. Ownership ranges
    // matter even when tabs contain identical combined SQL; never reuse across
    // changed tab boundaries or active/inactive membership.
    const key = JSON.stringify([relationId(relation), combined.ranges]);
    if (workspace.suggestions?.key !== key) workspace.suggestions = { key, endpoints: {} };
    const cache = workspace.suggestions.endpoints;
    if (!cache[endpoint]) cache[endpoint] = collectTargets();
    const result = await cache[endpoint];
    // Callers cannot mutate the cached choices used by a later popup.
    return { ...result, targets: result.targets.map((target) => ({ ...target })) };

    async function collectTargets() {
        const fixed = relation[endpoint === 'from' ? 'to' : 'from'];
        const column = schema.tables.find((table) => table.name === fixed.table)?.columns.find((c) => c.name === fixed.column);
        const candidates = (fieldsByType.get(normalizedType(column, schema.dialect)) || [])
            .filter((field) => !sameField(field, relation[endpoint]) && (endpoint !== 'to' || field.keyed));
        // Keep nearby choices first without changing order within each table.
        candidates.sort((a, b) => Number(b.table === relation[endpoint].table) - Number(a.table === relation[endpoint].table));
        const targets = [];
        let deadline = performance.now() + 8;
        for (const candidate of candidates) {
            if (performance.now() >= deadline) {
                await new Promise((resolve) => setTimeout(resolve, 0));
                deadline = performance.now() + 8;
            }
            // Type/key badges are only a cheap filter. The exact SQL rewrite,
            // constraint actions, migrations, duplicates and owning tabs must
            // pass the same validator used on drop/apply before suggesting it.
            const result = reconnectInCombinedTabs(tabs, combined, relation, endpoint, candidate, workspace);
            if (result.ok && !result.unchanged) {
                const { keyed: _keyed, ...target } = candidate;
                targets.push(target);
            }
        }
        return { ok: true, targets, message: targets.length
            ? `${targets.length} compatible ${targets.length === 1 ? 'field' : 'fields'} available.`
            : endpoint === 'from' ? 'No compatible foreign-key fields available.' : 'No compatible referenced keys available.' };
    }
}
