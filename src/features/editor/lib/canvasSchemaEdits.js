/** Atomic direct-canvas SQL edits, preserving native syntax and SQL-tab ownership. */
import { parseAST } from '@/lib/parse-ast/parseAst';
import { tokenize } from '@/lib/parse-ast/tokenize';
import { sqlToErdSchema } from '@/lib/erdJsonSchema';
import { identifierKey, identifierPartsEquivalent, identifierPartsFrom } from '@/lib/sqlIdentifierIdentity';
import { buildCombinedSql, findSqlTabTableLocation } from './sqlTabs';
import { isSqlColumnRequired, normalizedSqlColumnType } from '@/lib/sqlColumnTypes';
import { planColumnConnectionImpact, planColumnKeyImpact } from './canvasColumnImpact';
import { planCanvasSqlCascade } from './canvasSqlCascade';
import { planColumnHistoryCascade } from './canvasColumnHistory';
import { deleteRelationshipInTabs, hasRelationshipFieldMigration } from './relationshipReconnect';

const reject = (message) => ({ ok: false, message });
const kw = (t, word) => t?.type === 'KW' && t.value.toUpperCase() === word;
const punc = (t, value) => t?.type === 'PUNC' && t.value === value;
const fingerprint = (tabs) => JSON.stringify(tabs.map((tab) => [tab.id, tab.sql, tab.isInactive === true]));
const part = (token) => ({ value: token.value, quoted: /^["`[]/.test(token.raw) });
let cachedWorkspace;

function readWorkspace(sql) {
    // Keep one immutable baseline for pointer previews; never retain
    // an SQL history or reparse the unchanged workspace on each pointer movement.
    if (cachedWorkspace?.sql !== sql) cachedWorkspace = { sql, schema: sqlToErdSchema(sql), ast: parseAST(sql).ast };
    return cachedWorkspace;
}

function isPortableIdentifier(name) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && tokenize(name).tokens[0]?.type === 'IDENT';
}

function quote(name, dialect) {
    // Ambiguous SQL must not acquire a guessed engine's quoting rules.
    if (dialect === 'auto' && isPortableIdentifier(name)) return name;
    if (dialect === 'mysql') return '`' + name.replace(/`/g, '``') + '`';
    if (dialect === 'mssql') return '[' + name.replace(/]/g, ']]') + ']';
    return '"' + name.replace(/"/g, '""') + '"';
}

function closingParen(tokens, open) {
    let depth = 0;
    for (let i = open; i < tokens.length; i += 1) {
        if (punc(tokens[i], '(')) depth += 1;
        if (punc(tokens[i], ')') && --depth === 0) return i;
    }
    return -1;
}

function nameRange(tokens, start) {
    if (!tokens[start] || !['IDENT', 'KW'].includes(tokens[start].type)) return null;
    let end = start + 1;
    while (punc(tokens[end], '.') && tokens[end + 1]) end += 2;
    return { start: tokens[start].start.idx, end: tokens[end - 1].end.idx, next: end, parts: tokens.slice(start, end).filter((t) => !punc(t, '.')).map(part) };
}

function applyEdits(sql, edits) {
    // Each edit addresses original tokens. Descending application preserves
    // literal/comment bytes and avoids shifting subsequent source offsets.
    return [...edits].sort((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), sql);
}

/** Parse one native definition into editable rows without regenerating DDL. */
function readTableDefinition(sql, dialect = 'auto') {
    const parsed = parseAST(sql, { dialect });
    const lexed = tokenize(sql);
    const { tokens } = lexed;
    const table = parsed.ast.tables[0];
    // Parsed semantic errors (including STRICT type rules and unresolved old
    // key names) must remain editable. Token/body boundaries prove the draft
    // shape here; the complete repaired workspace is validated before committing.
    if (lexed.errors.length || parsed.ast.tables.length !== 1 || !table) return reject('Enter one complete CREATE TABLE statement.');
    const start = tokens.findIndex((t) => t.start.idx === table.position.start.idx);
    const tableWord = tokens.findIndex((t, i) => i > start && kw(t, 'TABLE'));
    let nameStart = tableWord + 1;
    if (kw(tokens[nameStart], 'IF')) nameStart += 3;
    const name = nameRange(tokens, nameStart);
    const open = name?.next;
    const close = punc(tokens[open], '(') ? closingParen(tokens, open) : -1;
    if (!name || close < 0 || tokens.some((t) => t.start.idx < table.position.start.idx || t.start.idx >= table.position.end.idx)) return reject('Enter one CREATE TABLE with a column list; additional statements belong in the SQL editor.');
    let depth = 0;
    const cuts = [tokens[open].end.idx];
    for (let i = open + 1; i < close; i += 1) {
        if (punc(tokens[i], '(')) depth += 1;
        if (punc(tokens[i], ')')) depth -= 1;
        if (depth === 0 && punc(tokens[i], ',')) cuts.push(tokens[i].start.idx, tokens[i].end.idx);
    }
    cuts.push(tokens[close].start.idx);
    const entries = [];
    for (let i = 0; i < cuts.length; i += 2) {
        const a = cuts[i]; const b = cuts[i + 1];
        if (!sql.slice(a, b).trim()) continue;
        const column = table.columns.find((c) => c._token?.start.idx >= a && c._token.start.idx < b);
        entries.push({ start: a, end: b, raw: sql.slice(a, b), ...(column ? { name: column.name } : {}) });
    }
    return { ok: true, sql, table, errors: parsed.errors, name: sql.slice(name.start, name.end), nameRange: name, entries, prefix: sql.slice(0, tokens[open].end.idx), suffix: sql.slice(tokens[close].start.idx) };
}

/** Assemble only changed rows, retaining table-level constraints and native options. */
function buildTableDefinition(model, entries, dialect) {
    return model.prefix + entries.map((entry) => entry.isNew
        ? `\n    ${quote(entry.name.trim(), dialect)} ${entry.definition.trim()}\n` : entry.raw).join(',') + model.suffix;
}

function getColumnSource(tabs, tableName) {
    const owner = findSqlTabTableLocation(tabs, tableName);
    if (!owner) return reject('This table has no unambiguous SQL source. Open its definition in the SQL editor.');
    const combined = buildCombinedSql(tabs);
    const { schema, ast } = readWorkspace(combined.sql);
    const table = schema.tables.find((t) => t.name === tableName);
    const origin = ast.tables.find((t) => t.position.start.idx === table?.sourcePosition?.index);
    const range = combined.ranges.find((r) => r.id === owner.tabId);
    if (!origin || !range) return reject('The original table definition could not be located.');
    const start = origin.position.start.idx - range.start;
    const end = origin.position.end.idx - range.start;
    if (start < 0 || end > owner.tab.sql.length) return reject('This definition spans SQL tabs. Edit it in the SQL editor.');
    const sql = owner.tab.sql.slice(start, end);
    const definition = readTableDefinition(sql, schema.dialect);
    if (!definition.ok) return definition;
    const matches = (name, parts) => identifierPartsEquivalent(identifierPartsFrom(origin), identifierPartsFrom(name, parts), ast.dialectProfile?.defaultSchema, schema.dialect);
    const lifecycleActions = new Set(['rename_table', 'rename_column', 'add_column', 'drop_column', 'alter_column', 'change_column', 'modify_column', 'set_schema']);
    const migrated = ast.alters.some((a) => matches(a.table, a.tableParts) && (lifecycleActions.has(a.action) || a.action.startsWith('alter_column'))) || ast.drops.some((d) => d.kind === 'table' && matches(d.name, d.nameParts)) || ast.tables.filter((t) => matches(t.name, t.nameParts)).length !== 1;
    return { ok: true, tableName, columns: table.columns, dialect: schema.dialect, owner: { id: owner.tabId, title: owner.tab.title, line: owner.line }, start, end, sql, definition, fingerprint: fingerprint(tabs),
        readOnlyReason: migrated ? 'This table is changed by an ALTER TABLE or drop/recreate migration. Edit its complete history in the SQL editor.' : null };
}

function diagnosticCounts(schema) {
    const counts = new Map();
    (schema._parseErrors || []).forEach((e) => counts.set(e.message, (counts.get(e.message) || 0) + 1));
    return counts;
}

function hasNewDiagnostic(before, after) {
    const counts = diagnosticCounts(before);
    return (after._parseErrors || []).find((e) => {
        const remaining = counts.get(e.message) || 0;
        counts.set(e.message, remaining - 1);
        return remaining <= 0;
    });
}

function checkColumnDependencies(sql, ast, target, removed, dialect) {
    const tokens = tokenize(sql).tokens;
    const same = (name, parts) => identifierPartsEquivalent(identifierPartsFrom(target), identifierPartsFrom(name, parts), ast.dialectProfile?.defaultSchema, dialect);
    const used = (list) => list.some((token, i) => ['IDENT', 'KW'].includes(token.type)
        && !punc(list[i + 1], '(') && !punc(list[i + 1], '.') && list[i - 1]?.value !== '::'
        && !kw(list[i - 1], 'AS') && !kw(list[i - 1], 'COLLATE') && removed.has(identifierKey([part(token)], dialect)));
    const owners = [...ast.tables.filter((t) => same(t)), ...ast.alters.filter((t) => same(t.table, t.tableParts))];
    for (const owner of owners) {
        const local = tokens.filter((t) => t.start.idx >= owner.position.start.idx && t.end.idx <= owner.position.end.idx);
        for (let i = 0; i < local.length; i += 1) {
            if (!kw(local[i], 'CHECK') && !kw(local[i], 'GENERATED') && !(kw(local[i], 'AS') && punc(local[i + 1], '('))) continue;
            let open = i + 1;
            while (local[open] && !punc(local[open], '(')) open += 1;
            const close = closingParen(local, open);
            if (close >= 0 && used(local.slice(open + 1, close))) return reject('A remaining check or generated field uses this column. Update that dependency in SQL first.');
            if (close >= 0) i = close;
        }
    }
    for (const index of ast.indexes.filter((i) => same(i.table, i.tableParts) && (i.expressions?.length || i.where))) {
        const local = tokens.filter((t) => t.start.idx >= index.position.start.idx && t.end.idx <= index.position.end.idx);
        const on = local.findIndex((t) => kw(t, 'ON'));
        const name = nameRange(local, on + 1);
        if (name && used(local.slice(name.next))) return reject('An expression or partial index uses this column. Update it together in SQL.');
    }
    // Adding/removing fields can invalidate positional INSERTs and unmodelled
    // view/trigger dependencies. Never rewrite those statements by text matching.
    const spans = [...ast.tables, ...ast.indexes, ...ast.types, ...ast.alters, ...ast.drops].filter((i) => i.position).map((i) => i.position);
    const leaf = identifierKey([identifierPartsFrom(target).at(-1)], dialect);
    if (tokens.some((t) => ['IDENT', 'KW'].includes(t.type) && !spans.some((p) => t.start.idx >= p.start.idx && t.start.idx < p.end.idx)
        && (identifierKey([part(t)], dialect) === leaf || removed.has(identifierKey([part(t)], dialect))))) return reject('Other SQL statements may depend on this table or its columns. Update them together in SQL.');
    return { ok: true };
}

function validateConnectionFields(schema, source, target) {
    const generated = (c) => (c?.extras || []).find((extra) => /^(GENERATED\b|AS\s*\()/i.test(extra));
    if (schema.dialect === 'mssql' && (generated(source) || generated(target))) return reject('SQL Server computed fields cannot be used for this foreign key.');
    if (schema.dialect === 'mysql') {
        if ([source, target].some((c) => generated(c) && !/\bSTORED\b/i.test(generated(c)))) return reject('MySQL virtual generated fields cannot be used for this foreign key.');
        if ([source, target].some((c) => /^(?:(?:TINY|MEDIUM|LONG)?(?:TEXT|BLOB))\b/i.test(c?.type || ''))) return reject('MySQL TEXT/BLOB fields cannot form this foreign key.');
    }
    const names = new Map(); const ambiguous = new Set();
    [...schema.enums, ...schema.composites].forEach(({ name }) => { const folded = name.toLowerCase(); if (names.has(folded) && names.get(folded) !== name) ambiguous.add(folded); names.set(folded, name); });
    if ([source?.type, target?.type].some((type) => ambiguous.has(String(type).replace(/(?:\[\])+$/, '').toLowerCase()))) return reject('Type identity is ambiguous. Verify this relationship in SQL.');
    if (!normalizedSqlColumnType(source, schema.dialect) || normalizedSqlColumnType(source, schema.dialect) !== normalizedSqlColumnType(target, schema.dialect)) return reject(`Types must match: ${source?.type || 'unknown'} → ${target?.type || 'unknown'}.`);
    return { ok: true };
}

function hasConstraintHistory(ast, table, dialect) {
    const same = (name, parts) => identifierPartsEquivalent(identifierPartsFrom(table), identifierPartsFrom(name, parts), ast.dialectProfile?.defaultSchema, dialect);
    return ast.alters.some((a) => same(a.table, a.tableParts) && ['drop_constraint', 'rename_constraint', 'rename_index'].includes(a.action));
}

function checkRemovedKeyHistory(baseline, table, removed, dialect) {
    if (!removed.size) return { ok: true };
    const fields = new Set(table.columns.filter((c) => removed.has(identifierKey([part(c._token)], dialect))).map((c) => dialect === 'postgres' ? c.name : c.name.toLowerCase()));
    const usesField = (columns) => (columns || []).some((name) => fields.has(dialect === 'postgres' ? name : name.toLowerCase()));
    const same = (name, parts) => identifierPartsEquivalent(identifierPartsFrom(table), identifierPartsFrom(name, parts), baseline.ast.dialectProfile?.defaultSchema, dialect);
    const affectedKey = table.columns.some((c) => fields.has(dialect === 'postgres' ? c.name : c.name.toLowerCase()) && (c.primary || c.unique || c.references))
        || table.constraints.some((c) => c && usesField(c.columns))
        || baseline.ast.alters.some((a) => same(a.table, a.tableParts) && ['add_primary', 'add_unique', 'add_foreign', 'add_index'].includes(a.action) && usesField(a.columns));
    const affectedIndexes = baseline.ast.indexes.filter((i) => same(i.table, i.tableParts) && usesField(i.columns));
    if ((affectedKey || affectedIndexes.length) && hasConstraintHistory(baseline.ast, table, dialect)
        || affectedIndexes.some((i) => baseline.ast.drops.some((d) => d.kind === 'index' && identifierPartsEquivalent(identifierPartsFrom(i), identifierPartsFrom(d), baseline.ast.dialectProfile?.defaultSchema, dialect)))) return reject('An affected key or index is dropped or renamed later in SQL. Update that history together before removing this column.');
    return { ok: true };
}

function hasUnresolvedConstraintHistory(ast, table, sql, dialect) {
    const same = (name, parts) => identifierPartsEquivalent(nativeTableParts(table, ast), identifierPartsFrom(name, parts), ast.dialectProfile?.defaultSchema, dialect);
    const key = (parts) => identifierKey(parts, dialect);
    const named = new Set();
    const declarations = ast.tables.filter((t) => t.position.start.idx === table.sourcePosition?.index);
    for (const declaration of declarations) {
        const tokens = tokenize(sql.slice(declaration.position.start.idx, declaration.position.end.idx)).tokens;
        tokens.forEach((t, i) => { if (kw(t, 'CONSTRAINT') && tokens[i + 1]) named.add(key([part(tokens[i + 1])])); });
    }
    const alters = ast.alters.filter((a) => same(a.table, a.tableParts));
    alters.forEach((a) => {
        if (a.action.startsWith('add_') && a.name) named.add(key(identifierPartsFrom(a.name, a.nameParts)));
        if (a.action === 'rename_constraint') named.add(key(identifierPartsFrom(a.newName, a.newNameParts)));
    });
    return alters.some((a) => a.action === 'drop_constraint' && (!a.name || !named.has(key(identifierPartsFrom(a.name, a.nameParts)))));
}

function prepareColumnChange(tabs, session, draftSql, removeColumn, cascade = false) {
    if (session.fingerprint !== fingerprint(tabs)) return reject('SQL changed during this action. Try again with the current table.');
    const draft = readTableDefinition(draftSql, session.dialect);
    if (!draft.ok) return draft;
    const current = buildCombinedSql(tabs);
    const baseline = readWorkspace(current.sql);
    const oldTable = session.definition.table;
    const key = (c) => identifierKey([part(c._token)], session.dialect);
    const newColumns = new Set(draft.table.columns.map(key));
    if (newColumns.size !== draft.table.columns.length) return reject('Column names must be unique for this database.');
    if (draft.table.columns.some((c) => !c.name.trim() || (c.declaredTypeMissing && session.dialect !== 'sqlite'))) return reject('Every column needs a name and a database type.');
    let removed = new Set(oldTable.columns.map(key).filter((k) => !newColumns.has(k)));
    let nextTabs = tabs.map((tab) => tab.id === session.owner.id ? { ...tab, sql: tab.sql.slice(0, session.start) + draftSql + tab.sql.slice(session.end) } : tab);
    let workspace = buildCombinedSql(nextTabs);
    const { ast } = parseAST(workspace.sql, { dialect: session.dialect });
    const ownerStart = workspace.ranges.find((r) => r.id === session.owner.id).start + session.start;
    const nextOwner = ast.tables.find((t) => t.position.start.idx === ownerStart);
    if (!nextOwner) return reject('The selected table definition could not be located.');
    let sourceRange = { start: ownerStart, end: nextOwner.position.end.idx };
    const details = [];
    const advance = (plan) => {
        if (!plan.ok) return plan;
        details.push(...plan.impacts);
        if (!plan.edits.length) return { ok: true };
        workspace = buildCombinedSql(nextTabs);
        if (plan.edits.some((e) => !workspace.ranges.some((r) => !r.isInactive && e.start >= r.start && e.end <= r.end))) return reject('An affected constraint spans SQL tabs. Edit its complete SQL statement together.');
        const text = applyEdits(workspace.sql, plan.edits);
        const map = (offset) => offset + plan.edits.filter((e) => e.end <= offset).reduce((delta, e) => delta + e.text.length - (e.end - e.start), 0);
        nextTabs = nextTabs.map((tab) => {
            if (tab.isInactive) return tab;
            const range = workspace.ranges.find((r) => r.id === tab.id);
            return { ...tab, sql: text.slice(map(range.start), map(range.end)) };
        });
        sourceRange = { start: map(sourceRange.start), end: map(sourceRange.end) };
        return { ok: true };
    };
    if (removeColumn) {
        let names = oldTable.columns.filter((c) => removed.has(key(c))).map((c) => c.name);
        const cascadePlan = planCanvasSqlCascade(workspace.sql, nextOwner, names, session.dialect, readTableDefinition, { columns: oldTable.columns });
        if (!cascadePlan.ok) return cascadePlan;
        if (cascadePlan.edits.length && !cascade) return { ...reject('Other SQL depends on this column. Review a cascade to remove it together.'), canCascade: true };
        if (cascade) {
            const applied = advance(cascadePlan); if (!applied.ok) return applied;
            names = cascadePlan.removedNames;
            removed = new Set(oldTable.columns.filter((c) => names.includes(c.name)).map(key));
        }
        const history = checkRemovedKeyHistory(baseline, oldTable, removed, session.dialect); if (!history.ok) return history;
        const keyPlan = advance(planColumnKeyImpact(buildCombinedSql(nextTabs).sql, nextOwner, names, session.dialect, readTableDefinition));
        if (!keyPlan.ok) return keyPlan;
        const nativeTarget = { ...nextOwner, position: { start: { idx: sourceRange.start } } };
        const fkPlan = advance(planColumnConnectionImpact(buildCombinedSql(nextTabs).sql, nativeTarget, baseline.schema, session.tableName, session.dialect, readTableDefinition));
        if (!fkPlan.ok) return fkPlan;
    } else {
        const dependency = checkColumnDependencies(workspace.sql, ast, oldTable, removed, session.dialect); if (!dependency.ok) return dependency;
    }
    const sql = buildCombinedSql(nextTabs).sql;
    const after = sqlToErdSchema(sql, { dialect: session.dialect });
    const changed = after.tables.find((t) => t.sourcePosition?.index === sourceRange.start);
    if (!changed || after.tables.length !== baseline.schema.tables.length) return reject('This action would change another table. Update it in SQL.');
    const ownerError = (after._parseErrors || []).find((e) => e.position?.index >= sourceRange.start && e.position.index < sourceRange.end);
    const error = ownerError || hasNewDiagnostic(baseline.schema, after);
    if (error) return reject(error.message);
    const groupKey = (r) => JSON.stringify([r.from.table, r.fromColumns || [r.from.column], r.to.table, r.toColumns || [r.to.column], r.fkName || '']);
    const beforeGroups = new Map(baseline.schema.relations.map((r) => [groupKey(r), r]));
    const afterGroups = new Map(after.relations.map((r) => [groupKey(r), r]));
    for (const relation of after.relations.filter((r) => !beforeGroups.has(groupKey(r)))) {
        const source = after.tables.find((t) => t.name === relation.from.table)?.columns.find((c) => c.name === relation.from.column);
        const target = after.tables.find((t) => t.name === relation.to.table)?.columns.find((c) => c.name === relation.to.column);
        const fields = validateConnectionFields(after, source, target);
        if (!fields.ok) return fields;
        if (Object.values(relation.actions || {}).includes('SET NULL') && isSqlColumnRequired(source, after.tables.find(t => t.name === relation.from.table), session.dialect)) return reject('SET NULL needs a nullable foreign-key field.');
        if (Object.values(relation.actions || {}).includes('SET DEFAULT') && isSqlColumnRequired(source, after.tables.find(t => t.name === relation.from.table), session.dialect) && !source.extras.some((e) => /^DEFAULT\b/i.test(e))) return reject('SET DEFAULT needs a default value on the required field.');
        if (session.dialect !== 'sqlite' && !sqlToErdSchema(sql.slice(0, sourceRange.end), { dialect: session.dialect }).relations.some((r) => groupKey(r) === groupKey(relation))) return reject('The referenced complete key must exist before this CREATE TABLE.');
    }
    const impacts = details.filter((i) => i.kind !== 'remove-relationship');
    for (const [key, relation] of beforeGroups) if (!afterGroups.has(key)) {
        if (!removeColumn) return reject('This action would remove an existing foreign key. Update it in SQL.');
        impacts.push({ kind: 'remove-relationship', label: `${relation.from.table}.${(relation.fromColumns || [relation.from.column]).join(', ')} → ${relation.to.table}.${(relation.toColumns || [relation.to.column]).join(', ')}` });
    }
    return { ok: true, nextTabs, impacts };
}

function prepareColumnAction(tabs, action) {
    const session = getColumnSource(tabs, action.table);
    if (!session.ok) return session;
    if (session.readOnlyReason && action.kind === 'add-column') return prepareHistoricalColumnAddition(tabs, session, action);
    if (session.readOnlyReason || action.kind === 'remove-column' && action.cascade === true) return prepareHistoricalColumnRemoval(tabs, session, action);
    const model = session.definition;
    let entries = model.entries;
    if (action.kind === 'add-column') {
        const name = String(action.column || '').trim();
        const definition = String(action.definition || '').trim();
        if (!name || !definition) return reject('Enter a column name and database type.');
        if (session.dialect === 'auto' && !isPortableIdentifier(name)) return reject('Use a simple column identifier, or database-specific SQL to choose its quoting.');
        if (name.length > 128 || definition.length > 1000) return reject('Keep the column name under 129 characters and its definition under 1001 characters.');
        const index = entries.findIndex((e) => !Object.hasOwn(e, 'name'));
        entries = [...entries];
        entries.splice(index < 0 ? entries.length : index, 0, { name, definition, isNew: true });
    } else {
        const column = entries.find((e) => e.name === action.column);
        if (!column) return reject('This column changed. Select its current row and try again.');
        if (entries.filter((e) => Object.hasOwn(e, 'name')).length < 2) return reject('A table must keep at least one column.');
        entries = entries.filter((e) => e !== column);
    }
    const draft = buildTableDefinition(model, entries, session.dialect);
    const parsed = readTableDefinition(draft, session.dialect);
    const expected = entries.filter((e) => Object.hasOwn(e, 'name')).map((e) => e.name.trim());
    if (!parsed.ok || JSON.stringify(parsed.table.columns.map((c) => c.name)) !== JSON.stringify(expected)
        || parsed.entries.length !== entries.length) return reject('Enter one column definition, without extra columns or statements.');
    const result = prepareColumnChange(tabs, session, draft, action.kind === 'remove-column', action.cascade === true);
    if (!result.ok) {
        // Keys/checks can have later history even without a column migration.
        // Offer the same reviewed history plan instead of leaving that valid
        // cascade inaccessible from the renderer's normal remove action.
        if (action.kind === 'remove-column' && action.cascade !== true && prepareHistoricalColumnRemoval(tabs, session, { ...action, cascade: true }).ok) return { ...result, canCascade: true };
        return result;
    }
    const impacts = [...result.impacts];
    if (action.kind === 'remove-column') {
        const original = model.table.columns.find((c) => c.name === action.column);
        // Inline keys disappear with their field; include them in the impact preview.
        if (original?.primary || original?.unique) impacts.unshift({ kind: 'remove-key', label: `${action.table}.${action.column}`, reason: 'Its inline key is removed with the column.' });
    }
    return { ...result, impacts, message: action.kind === 'add-column' ? 'Column added.' : 'Column removed.' };
}

function prepareHistoricalColumnAddition(tabs, session, action) {
    const name = String(action.column || '').trim(); const definition = String(action.definition || '').trim();
    if (!name || !definition) return reject('Enter a column name and database type.');
    if (name.length > 128 || definition.length > 1000) return reject('Keep the column name under 129 characters and its definition under 1001 characters.');
    if (session.dialect === 'auto' && !isPortableIdentifier(name)) return reject('Use a simple column identifier, or database-specific SQL to choose its quoting.');
    const current = buildCombinedSql(tabs); const { schema, ast } = readWorkspace(current.sql);
    const table = schema.tables.find((t) => t.name === action.table);
    const columnKey = (value) => identifierKey([{ value, quoted: session.dialect !== 'auto' }], session.dialect);
    if (table.columns.some((c) => columnKey(c.name) === columnKey(name))) return reject('Column names must be unique for this database.');
    // Validate exactly one field independently of old declarations and renamed
    // keys. The full chronological workspace remains the final semantic check.
    const strict = session.definition.table.options?.strict ? ' STRICT' : '';
    const draft = readTableDefinition(`CREATE TABLE ${session.definition.name} (${quote(name, session.dialect)} ${definition})${strict};`, session.dialect);
    if (!draft.ok || draft.table.columns.length !== 1 || draft.table.columns[0].name !== name || draft.entries.length !== 1) return reject('Enter one column definition, without extra columns or statements.');
    // Reference/type warnings in the isolated field are resolved against the
    // real workspace below; native syntax/type errors cannot be deferred.
    const draftError = draft.errors.find((e) => e.severity === 'error');
    if (draftError) return reject(draftError.message);
    const column = draft.table.columns[0];
    if (column.declaredTypeMissing && session.dialect !== 'sqlite') return reject('Every column needs a name and a database type.');
    if (column.primary && table.columns.some((c) => c.pk)) return reject('This table already has a primary key.');
    if (session.dialect === 'sqlite') {
        const tokens = tokenize(definition).tokens; const defaultIndex = tokens.findIndex((t) => kw(t, 'DEFAULT'));
        const value = tokens[defaultIndex + 1];
        const hasDefault = defaultIndex >= 0 && value && !kw(value, 'NULL');
        if (column.primary || column.unique) return reject('SQLite cannot add a PRIMARY KEY or UNIQUE field to an existing table. Add that key in SQL.');
        if (defaultIndex >= 0 && (punc(value, '(') || ['CURRENT_TIME', 'CURRENT_DATE', 'CURRENT_TIMESTAMP'].some((word) => kw(value, word)))) return reject('SQLite ADD COLUMN needs a literal default value.');
        if (column.notNull && !hasDefault) return reject('SQLite ADD COLUMN needs a non-NULL default for a NOT NULL field.');
        if (column.references && hasDefault) return reject('SQLite ADD COLUMN needs a NULL default for a referenced field.');
        if (column.generated && /\bSTORED\b/i.test(column.generated)) return reject('SQLite cannot add a STORED generated field to an existing table. Use VIRTUAL or edit SQL.');
    }
    const owner = [...tabs].reverse().find((tab) => !tab.isInactive);
    const last = tokenize(current.sql).tokens.at(-1); const terminator = last && !punc(last, ';') ? '\n;' : '';
    const nativeName = nativeTableParts(table, ast).map((p) => quote(p.value, session.dialect)).join('.');
    const keyword = ['mssql', 'auto'].includes(session.dialect) ? 'ADD' : 'ADD COLUMN';
    const nextTabs = tabs.map((tab) => tab === owner ? { ...tab, sql: tab.sql + `${terminator}\nALTER TABLE ${nativeName} ${keyword} ${quote(name, session.dialect)} ${definition};\n` } : tab);
    const after = sqlToErdSchema(buildCombinedSql(nextTabs).sql, { dialect: session.dialect });
    const error = hasNewDiagnostic(schema, after); if (error) return reject(error.message);
    const changed = after.tables.find((t) => t.name === table.name); const added = changed?.columns.find((c) => c.name === name);
    if (!added || JSON.stringify(after.tables.map((t) => t === changed ? { ...t, columns: t.columns.filter((c) => c !== added) } : t)) !== JSON.stringify(schema.tables)) return reject('This addition would affect another field or table. Update it in SQL.');
    const relationKey = (r) => JSON.stringify([r.from, r.to, r.fromColumns, r.toColumns, r.fkName, r.actions]);
    const additions = after.relations.filter((r) => r.from.table === table.name && r.from.column === name);
    if (JSON.stringify(after.relations.filter((r) => !additions.includes(r)).map(relationKey).sort()) !== JSON.stringify(schema.relations.map(relationKey).sort())) return reject('This addition would affect an existing connection. Update it in SQL.');
    for (const relation of additions) {
        const target = after.tables.find((t) => t.name === relation.to.table)?.columns.find((c) => c.name === relation.to.column);
        const fields = validateConnectionFields(after, added, target); if (!fields.ok) return fields;
        if (Object.values(relation.actions || {}).includes('SET NULL') && isSqlColumnRequired(added, changed, session.dialect)) return reject('SET NULL needs a nullable foreign-key field.');
        if (Object.values(relation.actions || {}).includes('SET DEFAULT') && isSqlColumnRequired(added, changed, session.dialect) && !added.extras.some((e) => /^DEFAULT\b/i.test(e))) return reject('SET DEFAULT needs a default value on the required field.');
    }
    return { ok: true, nextTabs, impacts: [], message: 'Column added.' };
}

function prepareHistoricalColumnRemoval(tabs, session, action) {
    const current = buildCombinedSql(tabs); const { schema } = readWorkspace(current.sql);
    const table = schema.tables.find((t) => t.name === action.table);
    const history = planColumnHistoryCascade(current.sql, table, action.column, session.dialect, readTableDefinition);
    if (!history.ok) return history;
    const external = planCanvasSqlCascade(current.sql, table, history.removedNames, session.dialect, readTableDefinition, { columns: table.columns, historyStateAt: history.stateAt });
    if (!external.ok) return external;
    const impacts = [...history.impacts, ...external.impacts];
    const declarationOnly = history.edits.length === 1 && history.edits[0].start === table.sourcePosition?.index;
    const simpleAdditionOnly = history.edits.length === 1 && !history.edits[0].text && history.impacts.length === 1 && /^.*:\s*ADD(?: COLUMN)?\s/i.test(history.impacts[0].label);
    if (action.cascade !== true && (external.edits.length || !declarationOnly && !simpleAdditionOnly || impacts.some((i) => !['remove-migration'].includes(i.kind)))) return { ...reject('Review the migration and dependency changes before removing this column.'), canCascade: true };
    const edits = [...history.edits, ...external.edits].sort((a, b) => a.start - b.start);
    if (edits.some((e, i) => i > 0 && e.start < edits[i - 1].end)) return reject('A dependency has overlapping SQL boundaries. Complete its statement in SQL first.');
    if (edits.some((e) => !current.ranges.some((r) => !r.isInactive && e.start >= r.start && e.end <= r.end))) return reject('A dependency spans SQL tabs. Keep its complete statement in one tab before cascading.');
    const text = applyEdits(current.sql, edits);
    const map = (offset) => offset + edits.filter((e) => e.end <= offset).reduce((delta, e) => delta + e.text.length - (e.end - e.start), 0);
    const nextTabs = tabs.map((tab) => { if (tab.isInactive) return tab; const r = current.ranges.find((r) => r.id === tab.id); return { ...tab, sql: text.slice(map(r.start), map(r.end)) }; });
    const after = sqlToErdSchema(buildCombinedSql(nextTabs).sql, { dialect: session.dialect });
    const error = hasNewDiagnostic(schema, after); if (error) return reject(error.message);
    const expected = schema.tables.map((t) => [t.name, t.columns.filter((c) => t !== table || !history.removedNames.includes(c.name)).map((c) => [c.name, c.type])]);
    if (JSON.stringify(after.tables.map((t) => [t.name, t.columns.map((c) => [c.name, c.type])])) !== JSON.stringify(expected)) return reject('The cascade would change an unrelated field or table. Review that SQL history first.');
    const groupKey = (r) => JSON.stringify([r.from, r.to, r.fromColumns, r.toColumns, r.fkName, r.actions]);
    const existing = new Set(schema.relations.map(groupKey));
    if (after.relations.some((r) => !existing.has(groupKey(r)))) return reject('The cascade would create a different connection. Review that SQL history first.');
    for (const relation of schema.relations) if (!after.relations.some((r) => groupKey(r) === groupKey(relation))) {
        const label = `${relation.from.table}.${(relation.fromColumns || [relation.from.column]).join(', ')} → ${relation.to.table}.${(relation.toColumns || [relation.to.column]).join(', ')}`;
        if (!impacts.some((i) => i.kind === 'remove-relationship' && i.label === label)) impacts.push({ kind: 'remove-relationship', label });
    }
    return { ok: true, nextTabs, impacts, message: 'Column removed.' };
}

function nativeTableParts(table, ast) {
    const origin = ast.tables.find((t) => t.position.start.idx === table.sourcePosition?.index);
    const originalParts = identifierPartsFrom(origin);
    // sourceName is a flattened display string. Original token parts preserve
    // quoted dots; renamed tables use the adapter's separate namespace/leaf.
    const prefix = table.schemaName ? `${table.schemaName}.` : '';
    const leaf = prefix && table.fullName?.startsWith(prefix) ? table.fullName.slice(prefix.length) : table.fullName || table.name;
    const parts = originalParts.map((p) => p.value).join('.') === table.sourceName ? originalParts
        : [...(table.hasExplicitSchema && table.schemaName ? [{ value: table.schemaName, quoted: true }] : []), { value: leaf, quoted: true }];
    return parts;
}

function tableSqlName(table, dialect, ast) {
    const parts = nativeTableParts(table, ast);
    return (dialect === 'sqlite' ? parts.slice(-1) : parts).map((p) => quote(p.value, dialect)).join('.');
}

function prepareConnection(tabs, action) {
    const combined = buildCombinedSql(tabs);
    const { schema, ast } = readWorkspace(combined.sql);
    const from = schema.tables.find((t) => t.name === action.from?.table);
    const to = schema.tables.find((t) => t.name === action.to?.table);
    const source = from?.columns.find((c) => c.name === action.from?.column);
    const target = to?.columns.find((c) => c.name === action.to?.column);
    if (!source || !target) return reject('Drop onto a table field.');
    if (from === to && source === target) return reject('Choose a different referenced field.');
    const fields = validateConnectionFields(schema, source, target);
    if (!fields.ok) return fields;
    if (!target.pk && !target.constraints.includes('UQ')) return reject('Drop onto a primary key or single-column unique key.');
    if (schema.relations.some((r) => r.from.table === from.name && r.from.column === source.name && r.to.table === to.name && r.to.column === target.name)) return reject('These fields already have this relationship.');
    const sqliteDatabase = (table) => table.hasExplicitSchema ? String(table.schemaName).toLowerCase() : 'main';
    if (schema.dialect === 'sqlite' && sqliteDatabase(from) !== sqliteDatabase(to)) return reject('SQLite connections must stay in the same database.');
    // The schema's UQ/PK badges can also label members of compound keys. The
    // generated relation is the final proof; validate it before choosing a slot.
    const clause = `FOREIGN KEY (${quote(source.name, schema.dialect)}) REFERENCES ${tableSqlName(to, schema.dialect, ast)} (${quote(target.name, schema.dialect)})`;
    if ([from, to].some((t) => hasUnresolvedConstraintHistory(ast, t, combined.sql, schema.dialect))) return reject('These keys use implicit or unresolved constraint history. Update the foreign key at the correct point in SQL.');
    const session = getColumnSource(tabs, from.name);
    const endpointHistory = hasRelationshipFieldMigration(ast, from, source, schema.dialect) || hasRelationshipFieldMigration(ast, to, target, schema.dialect);
    const needsLaterConstraint = [from, to].some((t) => hasConstraintHistory(ast, { nameParts: nativeTableParts(t, ast) }, schema.dialect));
    const sameRelation = (r) => r.from.table === from.name && r.from.column === source.name && r.to.table === to.name && r.to.column === target.name && !r.composite;
    let nextTabs;
    // Unrelated column migrations do not change these fields' availability.
    // Preserve them and prove the proposed FK at CREATE time and after replay.
    if (session.ok && !endpointHistory && !needsLaterConstraint) {
        const at = session.start + session.definition.prefix.length + session.definition.entries.map((e) => e.raw).join(',').length;
        nextTabs = tabs.map((tab) => tab.id === session.owner.id ? { ...tab, sql: tab.sql.slice(0, at) + `,\n    ${clause}\n` + tab.sql.slice(at) } : tab);
        const end = combined.ranges.find((r) => r.id === session.owner.id).start + session.end + clause.length + 7;
        const candidateSql = buildCombinedSql(nextTabs).sql;
        if (!sqlToErdSchema(candidateSql, { dialect: schema.dialect }).relations.some(sameRelation)) return reject('Choose a complete single-column primary or unique key; partial and expression keys cannot be connected.');
        if (schema.dialect !== 'sqlite' && !sqlToErdSchema(candidateSql.slice(0, end), { dialect: schema.dialect }).relations.some(sameRelation)) nextTabs = null;
    }
    if (!nextTabs) {
        if (schema.dialect === 'sqlite') return reject(endpointHistory ? 'These connection fields change in the migration history. Update their constraint at the correct point in SQL.' : session.message || 'Edit this table history in SQL before adding its connection.');
        if (schema.dialect === 'auto') return reject(endpointHistory ? 'These connection fields change in the migration history. Update their constraint at the correct point in SQL.' : 'The referenced key must exist before this table. Use database-specific SQL to add a later constraint.');
        // A later native ALTER handles forward tables and migrated fields without
        // changing CREATE execution order. Keep all inactive tabs byte-for-byte.
        const owner = [...tabs].reverse().find((tab) => !tab.isInactive);
        if (!owner) return reject('No active SQL tab is available.');
        const tokens = tokenize(combined.sql).tokens;
        const last = tokens.at(-1);
        const terminator = last && !punc(last, ';') ? '\n;' : '';
        nextTabs = tabs.map((tab) => tab === owner ? { ...tab, sql: tab.sql + `${terminator}\nALTER TABLE ${tableSqlName(from, schema.dialect, ast)} ADD ${clause};\n` } : tab);
    }
    const after = sqlToErdSchema(buildCombinedSql(nextTabs).sql, { dialect: schema.dialect });
    if (!after.relations.some(sameRelation)) return reject('Choose a complete single-column primary or unique key; partial and expression keys cannot be connected.');
    const error = hasNewDiagnostic(schema, after);
    const relationKey = (r) => JSON.stringify([r.from, r.to, r.fromColumns, r.toColumns, r.fkName, r.actions]);
    const oldKeys = schema.relations.map(relationKey).sort();
    const remaining = after.relations.filter((r) => !sameRelation(r)).map(relationKey).sort();
    if (error || JSON.stringify(oldKeys) !== JSON.stringify(remaining) || after.tables.length !== schema.tables.length) return reject(error?.message || 'This connection would affect another constraint. Update it in SQL.');
    // Lifecycle ALTERs are already replayed by the schema facade. No renderer
    // metadata or guessed key badge may bypass this complete-workspace check.
    return { ok: true, nextTabs, impacts: [], message: `${from.name}.${source.name} → ${to.name}.${target.name}` };
}

/** Preview and commit share this validator; only the hook commits returned tabs. */
export function prepareCanvasEditInTabs(tabs, action) {
    if (!Array.isArray(tabs) || !action) return reject('The SQL workspace is not ready.');
    if (action.kind === 'add-relationship') return prepareConnection(tabs, action);
    if (action.kind === 'remove-relationship') return deleteRelationshipInTabs(tabs, action.relation);
    if (['add-column', 'remove-column'].includes(action.kind)) return prepareColumnAction(tabs, action);
    return reject('Choose a column or connection action.');
}
