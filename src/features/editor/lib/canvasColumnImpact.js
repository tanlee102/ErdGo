/** Build explicit dependency-removal plans; no SQL is committed by this module. */
import { parseAST } from '@/lib/parse-ast/parseAst';
import { tokenize } from '@/lib/parse-ast/tokenize';
import { sqlToErdSchema } from '@/lib/erdJsonSchema';
import { identifierPartsEquivalent, identifierPartsFrom } from '@/lib/sqlIdentifierIdentity';

const kw = (token, word) => token?.type === 'KW' && token.value.toUpperCase() === word;
const punc = (token, value) => token?.type === 'PUNC' && token.value === value;
const reject = (message) => ({ ok: false, message });
const apply = (sql, edits) => [...edits].sort((a, b) => b.start - a.start).reduce((text, e) => text.slice(0, e.start) + e.text + text.slice(e.end), sql);
const fieldKey = (name, dialect) => dialect === 'postgres' ? name : name.toLowerCase();

function sameTable(left, right, ast, dialect) {
    return identifierPartsEquivalent(identifierPartsFrom(left), identifierPartsFrom(right), ast.dialectProfile?.defaultSchema, dialect);
}

function constraintHead(entry) {
    const tokens = tokenize(entry.raw).tokens;
    const head = kw(tokens[0], 'CONSTRAINT') ? tokens[2] : tokens[0];
    return { tokens, head };
}

function singleAlter(ast, alter) {
    return ast.alters.filter((a) => a.position.start.idx === alter.position.start.idx).length === 1;
}

/** Remove complete keys/indexes using deleted columns, rather than inventing a smaller key. */
export function planColumnKeyImpact(sql, target, removedNames, dialect, readDefinition) {
    if (!removedNames.length) return { ok: true, edits: [], impacts: [] };
    const { ast } = parseAST(sql, { dialect });
    const removed = new Set(removedNames.map((name) => fieldKey(name, dialect)));
    const edits = []; const impacts = [];
    const hasRemoved = (columns) => (columns || []).some((name) => removed.has(fieldKey(name, dialect)));
    for (const table of ast.tables.filter((t) => sameTable(t, target, ast, dialect))) {
        const model = readDefinition(sql.slice(table.position.start.idx, table.position.end.idx), dialect);
        if (!model.ok) return model;
        const entries = model.entries.filter((entry) => {
            if (Object.hasOwn(entry, 'name')) return true;
            const { tokens, head } = constraintHead(entry);
            if (!['PRIMARY', 'UNIQUE', 'KEY', 'INDEX', 'EXCLUDE', 'FOREIGN'].some((word) => kw(head, word))) return true;
            const open = tokens.findIndex((t) => punc(t, '('));
            let depth = 1; let close = open + 1;
            while (close < tokens.length && depth) { if (punc(tokens[close], '(')) depth += 1; if (punc(tokens[close], ')')) depth -= 1; close += 1; }
            const used = tokens.some((t, i) => i > open && i < close - 1 && ['IDENT', 'KW'].includes(t.type) && !punc(tokens[i + 1], '(') && !kw(tokens[i - 1], 'COLLATE') && removed.has(fieldKey(t.value, dialect)));
            if (!used) return true;
            const kind = kw(head, 'FOREIGN') ? 'remove-relationship' : kw(head, 'KEY') || kw(head, 'INDEX') ? 'remove-index' : 'remove-key';
            impacts.push({ kind, label: entry.raw.trim(), reason: 'Uses a removed column.', requiresApproval: true });
            return false;
        });
        if (entries.length !== model.entries.length) edits.push({ start: table.position.start.idx, end: table.position.end.idx, text: model.prefix + entries.map((e) => e.raw).join(',') + model.suffix });
    }
    for (const index of ast.indexes.filter((i) => sameTable({ name: i.table, nameParts: i.tableParts }, target, ast, dialect))) {
        if (!hasRemoved(index.columns)) continue;
        if (index.expressions?.length || index.where) return reject('Update this expression or partial index in SQL before removing its column.');
        edits.push({ start: index.position.start.idx, end: index.position.end.idx, text: '' });
        impacts.push({ kind: 'remove-index', label: index.name, reason: 'Uses a removed column.', requiresApproval: true });
    }
    for (const alter of ast.alters.filter((a) => sameTable({ name: a.table, nameParts: a.tableParts }, target, ast, dialect) && ['add_primary', 'add_unique', 'add_index'].includes(a.action) && hasRemoved(a.columns))) {
        if (!singleAlter(ast, alter)) return reject('This key belongs to a multi-action ALTER TABLE. Edit that statement together in SQL.');
        edits.push({ start: alter.position.start.idx, end: alter.position.end.idx, text: '' });
        impacts.push({ kind: alter.action === 'add_index' ? 'remove-index' : 'remove-key', label: alter.name || alter.columns.join(', '), reason: 'Uses a removed column.', requiresApproval: true });
    }
    return { ok: true, edits, impacts };
}

function foreignDefinitions(ast) {
    const definitions = [];
    ast.tables.forEach((table) => {
        table.columns.filter((c) => c.references).forEach((column) => definitions.push({ table, columns: [column.name], references: column.references, anchor: column._token.start.idx, inline: true }));
        table.constraints.filter((c) => c?.kind === 'foreign').forEach((constraint) => definitions.push({ table, columns: constraint.columns, references: constraint.references, anchor: constraint._token?.start?.idx, name: constraint.name }));
    });
    ast.alters.filter((a) => a.action === 'add_foreign').forEach((alter) => definitions.push({ table: { name: alter.table, nameParts: alter.tableParts }, columns: alter.columns, references: alter.references, anchor: alter.position.start.idx, name: alter.name, alter }));
    return definitions;
}

function removeInlineReference(raw) {
    const tokens = tokenize(raw).tokens;
    const at = tokens.findIndex((t) => kw(t, 'REFERENCES'));
    if (at < 0) return null;
    let cursor = at + 2;
    while (punc(tokens[cursor], '.')) cursor += 2;
    if (punc(tokens[cursor], '(')) {
        let depth = 0;
        do {
            if (punc(tokens[cursor], '(')) depth += 1;
            if (punc(tokens[cursor], ')')) depth -= 1;
            cursor += 1;
        } while (cursor < tokens.length && depth);
    }
    while (cursor < tokens.length) {
        if (kw(tokens[cursor], 'ON') && (kw(tokens[cursor + 1], 'DELETE') || kw(tokens[cursor + 1], 'UPDATE'))) {
            cursor += 2;
            cursor += kw(tokens[cursor], 'SET') || kw(tokens[cursor], 'NO') ? 2 : 1;
        } else if (kw(tokens[cursor], 'MATCH') || kw(tokens[cursor], 'INITIALLY')) cursor += 2;
        else if (kw(tokens[cursor], 'NOT') && kw(tokens[cursor + 1], 'DEFERRABLE')) cursor += 2;
        else if (kw(tokens[cursor], 'DEFERRABLE')) cursor += 1;
        else break;
    }
    const start = kw(tokens[at - 2], 'CONSTRAINT') ? tokens[at - 2].start.idx : tokens[at].start.idx;
    return apply(raw, [{ start, end: tokens[cursor - 1].end.idx, text: '' }]);
}

function groups(schema) {
    const seen = new Set();
    return schema.relations.filter((r) => {
        const key = JSON.stringify([r.from.table, r.fromColumns || [r.from.column], r.to.table, r.toColumns || [r.to.column], r.fkName || '']);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Existing connections can be removed only as a visible, explicit impact plan. New invalid FKs stay errors. */
export function planColumnConnectionImpact(sql, target, before, tableName, dialect, readDefinition) {
    const { ast } = parseAST(sql, { dialect });
    const schema = sqlToErdSchema(sql, { dialect });
    const targetTable = schema.tables.find((t) => t.sourcePosition?.index === target.position.start.idx);
    if (!targetTable) return reject('The edited table could not be identified.');
    const schemaTable = (native) => {
        const origin = ast.tables.find((t) => sameTable(t, native, ast, dialect));
        return schema.tables.find((t) => t.sourcePosition?.index === origin?.position.start.idx);
    };
    const baseline = groups(before).filter((r) => r.from.table === tableName || r.to.table === tableName);
    const removals = []; const impacts = [];
    for (const fk of foreignDefinitions(ast)) {
        const source = schemaTable(fk.table);
        const referenced = schemaTable({ name: fk.references.table, nameParts: fk.references.tableParts });
        if (!source || (source !== targetTable && referenced !== targetTable)) continue;
        const wasPresent = baseline.some((r) => r.from.table === source.name && r.to.table === referenced?.name
            && JSON.stringify((r.fromColumns || [r.from.column])) === JSON.stringify(fk.columns)
            && (!fk.references.columns.length || JSON.stringify((r.toColumns || [r.to.column])) === JSON.stringify(fk.references.columns))
            && (!fk.name || !r.fkName || fk.name === r.fkName));
        if (!wasPresent) continue;
        const relations = schema.relations.filter((r) => r.position?.index === fk.anchor);
        let reason;
        if (relations.length !== fk.columns.length) reason = 'A field or its complete primary/unique key was removed.';
        for (const relation of relations) {
            const from = source.columns.find((c) => c.name === relation.from.column);
            const to = referenced?.columns.find((c) => c.name === relation.to.column);
            if (!from || !to) reason = 'A field or its complete primary/unique key was removed.';
        }
        if (!reason) continue;
        if (fk.alter && !singleAlter(ast, fk.alter)) return reject('An affected connection belongs to a multi-action ALTER TABLE. Edit that statement together in SQL.');
        removals.push(fk);
        impacts.push({ kind: 'remove-relationship', label: `${source.name}.${fk.columns.join(', ')} → ${referenced?.name || fk.references.table}.${fk.references.columns.join(', ') || 'primary key'}`, reason, requiresApproval: true, anchor: fk.anchor });
    }
    const edits = [];
    for (const table of ast.tables) {
        const affected = removals.filter((fk) => !fk.alter && fk.table === table);
        if (!affected.length) continue;
        const model = readDefinition(sql.slice(table.position.start.idx, table.position.end.idx), dialect);
        if (!model.ok) return model;
        const entries = [];
        for (const entry of model.entries) {
            const fk = affected.find((item) => item.anchor - table.position.start.idx >= entry.start && item.anchor - table.position.start.idx < entry.end);
            if (!fk) entries.push(entry.raw);
            else if (fk.inline) {
                const raw = removeInlineReference(entry.raw);
                if (raw === null) return reject('The original connection clause could not be located.');
                entries.push(raw);
            }
        }
        edits.push({ start: table.position.start.idx, end: table.position.end.idx, text: model.prefix + entries.join(',') + model.suffix });
    }
    removals.filter((fk) => fk.alter).forEach((fk) => edits.push({ start: fk.alter.position.start.idx, end: fk.alter.position.end.idx, text: '' }));
    return { ok: true, edits, impacts };
}
