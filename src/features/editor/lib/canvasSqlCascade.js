/** Explicit SQL dependency plans for a reviewed canvas column cascade. */
import { parseAST } from '@/lib/parse-ast/parseAst';
import { tokenize } from '@/lib/parse-ast/tokenize';
import { identifierKey, identifierPartsEquivalent, identifierPartsFrom } from '@/lib/sqlIdentifierIdentity';

const punc = (t, value) => t?.type === 'PUNC' && t.value === value;
const quoted = (t) => /^["`[]/.test(t?.raw || '');
const word = (t, value) => t && ['KW', 'IDENT'].includes(t.type) && !quoted(t) && t.value.toUpperCase() === value;
const part = (t) => ({ value: t.value, quoted: quoted(t) });
const reject = (message) => ({ ok: false, message });
const apply = (sql, edits) => [...edits].sort((a, b) => b.start - a.start).reduce((text, e) => text.slice(0, e.start) + e.text + text.slice(e.end), sql);

function nameAt(tokens, index) {
    const first = tokens[index]; if (!first || !['KW', 'IDENT'].includes(first.type)) return null;
    const parts = [part(first)]; let next = index + 1;
    while (punc(tokens[next], '.') && ['KW', 'IDENT'].includes(tokens[next + 1]?.type)) { parts.push(part(tokens[next + 1])); next += 2; }
    return { parts, next, start: first.start.idx, end: tokens[next - 1].end.idx };
}

function closeParen(tokens, open) {
    let depth = 0;
    for (let i = open; i < tokens.length; i += 1) {
        if (punc(tokens[i], '(')) depth += 1;
        if (punc(tokens[i], ')') && --depth === 0) return i;
    }
    return -1;
}

function fieldsUsed(tokens, removed, dialect) {
    return tokens.some((t, i) => ['IDENT', 'KW'].includes(t.type) && removed.has(identifierKey([part(t)], dialect))
        && !punc(tokens[i + 1], '(') && !punc(tokens[i + 1], '.') && tokens[i - 1]?.value !== '::'
        && !word(tokens[i - 1], 'AS') && !word(tokens[i - 1], 'COLLATE'));
}

function expressionRanges(raw, removed, dialect) {
    const tokens = tokenize(raw).tokens; const ranges = [];
    for (let i = 0; i < tokens.length; i += 1) {
        if (!word(tokens[i], 'CHECK') && !word(tokens[i], 'GENERATED') && !(word(tokens[i], 'AS') && punc(tokens[i + 1], '('))) continue;
        let open = i + 1; while (tokens[open] && !punc(tokens[open], '(')) open += 1;
        const close = closeParen(tokens, open);
        if (close >= 0 && fieldsUsed(tokens.slice(open + 1, close), removed, dialect)) {
            const start = word(tokens[i - 2], 'CONSTRAINT') ? tokens[i - 2].start.idx : tokens[i].start.idx;
            let end = close;
            if (word(tokens[end + 1], 'NOT') && word(tokens[end + 2], 'ENFORCED')) end += 2;
            else if (word(tokens[end + 1], 'ENFORCED')) end += 1;
            ranges.push({ start, end: tokens[end].end.idx, text: '', generated: !word(tokens[i], 'CHECK') });
        }
        if (close >= 0) i = close;
    }
    return ranges;
}

function statements(tokens, dialect) {
    const result = []; let start = 0; let blocks = 0; let trigger = false;
    for (let i = 0; i < tokens.length; i += 1) {
        if (i - start < 6 && word(tokens[start], 'CREATE') && word(tokens[i], 'TRIGGER')) trigger = true;
        if (trigger && (word(tokens[i], 'BEGIN') || word(tokens[i], 'CASE'))) blocks += 1;
        if (trigger && word(tokens[i], 'END')) blocks = Math.max(0, blocks - 1);
        const batchEnd = dialect === 'mssql' && word(tokens[i], 'GO');
        if (batchEnd || punc(tokens[i], ';') && !blocks && !(trigger && dialect === 'mssql')) {
            result.push(tokens.slice(start, i + 1)); start = i + 1; blocks = 0; trigger = false;
        }
    }
    if (start < tokens.length) result.push(tokens.slice(start));
    return { lists: result, incomplete: blocks > 0 };
}

function references(tokens, same, dialect) {
    const aliases = new Map(); const refs = [];
    const isTrigger = tokens.slice(0, 6).some((t) => word(t, 'TRIGGER'));
    const triggerOwner = isTrigger ? nameAt(tokens, tokens.findIndex((t) => word(t, 'ON')) + 1) : null;
    const triggerMatches = triggerOwner && same(triggerOwner.parts);
    const pseudoTables = new Set(['NEW', 'OLD', 'INSERTED', 'DELETED']);
    const matchesName = (parts) => isTrigger && parts.length === 1 && pseudoTables.has(parts[0].value.toUpperCase()) ? Boolean(triggerMatches) : same(parts);
    const insert = insertTarget(tokens);
    if (insert) { const matches = matchesName(insert.parts); refs.push({ ...insert, matches }); aliases.set(identifierKey([insert.parts.at(-1)], dialect), matches); }
    for (let i = 0; i < tokens.length; i += 1) {
        if (!['FROM', 'JOIN', 'INTO', 'UPDATE', 'ON'].some((v) => word(tokens[i], v))) continue;
        const name = nameAt(tokens, i + 1); if (!name) continue;
        const matches = matchesName(name.parts); refs.push({ ...name, matches });
        aliases.set(identifierKey([name.parts.at(-1)], dialect), matches);
        let alias = name.next; if (word(tokens[alias], 'AS')) alias += 1;
        if (tokens[alias]?.type === 'IDENT') aliases.set(identifierKey([part(tokens[alias])], dialect), matches);
    }
    if (isTrigger) for (const value of pseudoTables) aliases.set(identifierKey([{ value, quoted: false }], dialect), Boolean(triggerMatches));
    return { refs, aliases };
}

function insertTarget(tokens) {
    if (!word(tokens[0], 'INSERT') && !word(tokens[0], 'REPLACE')) return null;
    let at = 1;
    if (word(tokens[at], 'OR')) at += 2;
    while (['LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY', 'IGNORE'].some((v) => word(tokens[at], v))) at += 1;
    if (word(tokens[at], 'INTO')) at += 1;
    return nameAt(tokens, at);
}

function depends(tokens, context, removed, dialect) {
    if (!context.refs.some((r) => r.matches)) return false;
    return tokens.some((t, i) => {
        if (context.refs.some((r) => t.start.idx >= r.start && t.start.idx < r.end) || context.object && t.start.idx >= context.object.start && t.start.idx < context.object.end) return false;
        const wildcard = t.value === '*' && (punc(tokens[i - 1], '.') || punc(tokens[i - 1], ',') || word(tokens[i - 1], 'SELECT') || word(tokens[i - 1], 'DISTINCT'));
        if (!wildcard && (!['IDENT', 'KW'].includes(t.type) || !removed.has(identifierKey([part(t)], dialect)))) return false;
        if (punc(tokens[i + 1], '(') || punc(tokens[i + 1], '.') || word(tokens[i - 1], 'AS') || word(tokens[i - 1], 'COLLATE') || tokens[i - 1]?.value === '::') return false;
        if (punc(tokens[i - 1], '.')) return context.aliases.get(identifierKey([part(tokens[i - 2])], dialect)) !== false;
        return true;
    });
}

function listEntries(tokens, open, close) {
    let depth = 0; let start = open + 1; let sourceStart = tokens[open].end.idx; const entries = [];
    for (let i = start; i <= close; i += 1) {
        if (i === close || depth === 0 && punc(tokens[i], ',')) { entries.push(Object.assign(tokens.slice(start, i), { sourceStart, sourceEnd: tokens[i].start.idx })); start = i + 1; sourceStart = tokens[i].end.idx; }
        else if (punc(tokens[i], '(')) depth += 1;
        else if (punc(tokens[i], ')')) depth -= 1;
    }
    return entries;
}

function rewriteInsert(sql, tokens, removed, columns, dialect) {
    const name = insertTarget(tokens); if (!name) return null;
    let at = name.next; let fields = columns.map((c) => identifierPartsFrom(c)); const edits = [];
    const content = (entries) => entries.map((entry) => {
        const text = sql.slice(entry.sourceStart, entry.sourceEnd).trim();
        // A surviving line comment must not swallow the following comma/paren.
        return /--[^\n]*$/.test(text) ? text + '\n' : text;
    }).join(', ');
    if (punc(tokens[at], '(')) {
        const close = closeParen(tokens, at); if (close < 0) return null;
        const entries = listEntries(tokens, at, close); if (entries.some((e) => e.length !== 1)) return null;
        fields = entries.map((e) => [part(e[0])]); const kept = entries.filter((e) => !removed.has(identifierKey([part(e[0])], dialect)));
        if (!kept.length) return null;
        if (kept.length !== entries.length) edits.push({ start: tokens[at].end.idx, end: tokens[close].start.idx, text: content(kept) });
        at = close + 1;
    }
    const keep = fields.map((parts) => !removed.has(identifierKey(parts, dialect)));
    if (keep.every(Boolean)) return { edits: [], rows: 0 };
    if (word(tokens[at], 'DEFAULT') && word(tokens[at + 1], 'VALUES') && !punc(tokens[name.next], '(')) return { edits: [], rows: 0 };
    if (!keep.some(Boolean) || !word(tokens[at], 'VALUES') && !word(tokens[at], 'VALUE')) return null;
    at += 1; let rows = 0;
    while (punc(tokens[at], '(')) {
        const close = closeParen(tokens, at); if (close < 0) return null;
        const entries = listEntries(tokens, at, close); if (entries.length !== fields.length || entries.some((e) => !e.length)) return null;
        edits.push({ start: tokens[at].end.idx, end: tokens[close].start.idx, text: content(entries.filter((_e, i) => keep[i])) }); rows += 1; at = close + 1;
        if (!punc(tokens[at], ',')) break; at += 1;
    }
    if (!rows || tokens.slice(at).some((t) => !punc(t, ';'))) return null;
    return { edits, rows };
}

/** Only returns token-addressed edits and labelled impacts; commits need a fresh review. */
export function planCanvasSqlCascade(sql, target, removedNames, dialect, readDefinition, { columns = target.columns || [], minStatementPosition = 0, historyStateAt = null } = {}) {
    const lexed = tokenize(sql); if (lexed.errors.length) return reject('Fix incomplete SQL before removing its dependencies.');
    const { ast } = parseAST(sql, { dialect }); const edits = []; const impacts = [];
    const columnParts = (name) => { const column = columns.find((c) => c.name === name); return column ? identifierPartsFrom(column) : [{ value: name, quoted: true }]; };
    const removed = new Set(removedNames.map((value) => identifierKey(columnParts(value), dialect)));
    const same = (parts) => identifierPartsEquivalent(identifierPartsFrom(target), parts, ast.dialectProfile?.defaultSchema, dialect);
    const owner = ast.tables.find((t) => same(identifierPartsFrom(t)) && (!target.position || t.position.start.idx === target.position.start.idx));
    if (owner && !historyStateAt) {
        const model = readDefinition(sql.slice(owner.position.start.idx, owner.position.end.idx), dialect); if (!model.ok) return model;
        let entries = model.entries; let changed = true;
        while (changed) {
            changed = false;
            entries = entries.filter((entry) => {
                if (!entry.name || !model.table.columns.find((c) => c.name === entry.name)?.generated || !expressionRanges(entry.raw, removed, dialect).some((r) => r.generated)) return true;
                const field = model.table.columns.find((c) => c.name === entry.name);
                removed.add(identifierKey(identifierPartsFrom(field), dialect)); removedNames = [...removedNames, entry.name]; changed = true;
                impacts.push({ kind: 'remove-column', label: `${target.name || owner.name}.${entry.name}`, reason: 'Generated from a removed field.' });
                if (field.primary || field.unique) impacts.push({ kind: 'remove-key', label: `${target.name || owner.name}.${entry.name}`, reason: 'Removed with the generated field.' });
                return false;
            });
        }
        entries = entries.flatMap((entry) => {
            const ranges = expressionRanges(entry.raw, removed, dialect).filter((r) => !r.generated); if (!ranges.length) return [entry];
            impacts.push({ kind: 'remove-check', label: entry.raw.trim(), reason: 'Checks a removed field.' });
            return entry.name ? [{ ...entry, raw: apply(entry.raw, ranges) }] : [];
        });
        if (!entries.some((e) => e.name)) return reject('The cascade would remove every field. A table must keep at least one column.');
        if (impacts.length) edits.push({ start: owner.position.start.idx, end: owner.position.end.idx, text: model.prefix + entries.map((e) => e.raw).join(',') + model.suffix });
    }
    const removedObjects = []; const external = [];
    const spans = [...ast.tables, ...ast.indexes, ...ast.types, ...ast.alters, ...ast.drops].filter((s) => s.position).map((s) => s.position);
    for (const index of ast.indexes.filter((i) => !historyStateAt && same(identifierPartsFrom(i.table, i.tableParts)) && (i.expressions?.length || i.where))) {
        const tokens = lexed.tokens.filter((t) => t.start.idx >= index.position.start.idx && t.end.idx <= index.position.end.idx);
        const on = tokens.findIndex((t) => word(t, 'ON')); const name = nameAt(tokens, on + 1);
        if (!name || !fieldsUsed(tokens.slice(name.next), removed, dialect)) continue;
        if (!word(tokens[0], 'CREATE')) return reject('An expression index shares ALTER history. Update that statement in SQL.');
        edits.push({ start: index.position.start.idx, end: index.position.end.idx, text: '' }); impacts.push({ kind: 'remove-index', label: index.name || 'Expression index' });
        removedObjects.push({ kind: 'index', parts: identifierPartsFrom(index) });
    }
    if (ast.alters.some((a) => a.action === 'rename_index' && removedObjects.some((o) => o.kind === 'index' && identifierPartsEquivalent(o.parts, identifierPartsFrom(a.oldName, a.oldNameParts), ast.dialectProfile?.defaultSchema, dialect)))) return reject('A dependent index is renamed later. Update that index history in SQL.');
    for (const alter of ast.alters.filter((a) => !historyStateAt && same(identifierPartsFrom(a.table, a.tableParts)) && a.action === 'add_check')) {
        const raw = sql.slice(alter.position.start.idx, alter.position.end.idx);
        if (!expressionRanges(raw, removed, dialect).length) continue;
        if (ast.alters.filter((a) => a.position.start.idx === alter.position.start.idx).length !== 1) return reject('A dependent CHECK shares an ALTER statement. Edit it in SQL.');
        edits.push({ start: alter.position.start.idx, end: alter.position.end.idx, text: '' }); impacts.push({ kind: 'remove-check', label: alter.name || raw.trim() });
    }
    if (impacts.some((i) => i.kind === 'remove-check') && ast.alters.some((a) => same(identifierPartsFrom(a.table, a.tableParts)) && ['drop_constraint', 'rename_constraint'].includes(a.action))) return reject('A dependent CHECK has later constraint history. Update those statements together in SQL.');
    const split = statements(lexed.tokens, dialect); if (split.incomplete) return reject('A trigger body is incomplete. Fix its SQL before cascading.');
    for (const tokens of split.lists) {
        const start = tokens[0].start.idx; const end = tokens.at(-1).end.idx;
        if (start < minStatementPosition || spans.some((p) => start >= p.start.idx && start < p.end.idx)) continue;
        const state = historyStateAt?.(start);
        const matches = state ? (parts) => identifierPartsEquivalent(state.parts, parts, ast.dialectProfile?.defaultSchema, dialect) : same;
        const localColumns = state?.columns || columns;
        const localRemoved = state ? new Set(state.removedNames.map((name) => identifierKey(identifierPartsFrom(localColumns.find((c) => c.name === name) || { name, nameParts: [{ value: name, quoted: true }] }), dialect))) : removed;
        if (historyStateAt && !state) continue;
        if (word(tokens[0], 'COMMENT') && word(tokens[1], 'ON') && word(tokens[2], 'COLUMN')) {
            const field = nameAt(tokens, 3);
            if (field && matches(field.parts.slice(0, -1)) && localRemoved.has(identifierKey(field.parts.slice(-1), dialect))) { edits.push({ start, end, text: '' }); impacts.push({ kind: 'remove-statement', label: `Column comment: ${field.parts.map((p) => p.value).join('.')}` }); }
            continue;
        }
        let kind = tokens[0].value.toUpperCase(); let object;
        if (word(tokens[0], 'CREATE')) {
            const type = tokens.findIndex((t, i) => i < 6 && (word(t, 'VIEW') || word(t, 'TRIGGER')));
            if (type >= 0) { kind = tokens[type].value.toLowerCase(); let at = type + 1; if (word(tokens[at], 'IF')) at += 3; object = nameAt(tokens, at); }
        } else if (word(tokens[0], 'DROP') && (word(tokens[1], 'VIEW') || word(tokens[1], 'TRIGGER'))) {
            kind = `drop-${tokens[1].value.toLowerCase()}`; let at = 2; if (word(tokens[at], 'IF')) at += 2; object = nameAt(tokens, at);
        }
        external.push({ tokens, start, end, kind, object, matches, fields: localRemoved, columns: localColumns, context: { ...references(tokens, matches, dialect), object }, removed: false });
    }
    let changed = true;
    while (changed) {
        changed = false;
        for (const item of external) {
            if (item.removed) continue;
            const transitive = item.context.refs.some((reference) => {
                const definitions = external.filter((candidate) => candidate.kind === 'view' && candidate.object && candidate.start < item.start && identifierPartsEquivalent(reference.parts, candidate.object.parts, ast.dialectProfile?.defaultSchema, dialect));
                return definitions.at(-1)?.removed === true;
            });
            const direct = ['INSERT', 'REPLACE'].includes(item.kind) && insertTarget(item.tokens) && item.matches(insertTarget(item.tokens).parts)
                ? depends(item.tokens, item.context, item.fields, dialect) || !punc(item.tokens[insertTarget(item.tokens).next], '(')
                : depends(item.tokens, item.context, item.fields, dialect);
            if (item.kind === 'COPY' && item.tokens.some((_t, i) => { const name = nameAt(item.tokens, i); return name && item.matches(name.parts); })) return reject('COPY data needs its column mapping updated in SQL before removal.');
            if (!direct && !transitive) continue;
            if (['INSERT', 'REPLACE'].includes(item.kind) && !transitive) {
                const rewrite = rewriteInsert(sql, item.tokens, item.fields, item.columns, dialect);
                if (rewrite && rewrite.edits.length) {
                    edits.push(...rewrite.edits); impacts.push({ kind: 'rewrite-data', label: `INSERT · ${rewrite.rows} row${rewrite.rows === 1 ? '' : 's'} kept`, reason: 'Removed only deleted fields and their values.' }); item.removed = true; continue;
                }
                if (rewrite && !rewrite.edits.length && !depends(item.tokens, item.context, item.fields, dialect)) continue;
            }
            if (!['view', 'trigger', 'INSERT', 'REPLACE', 'UPDATE', 'DELETE', 'SELECT', 'WITH', 'MERGE'].includes(item.kind)) return reject(`A ${item.kind} dependency cannot be cascaded safely. Edit that statement in SQL.`);
            edits.push({ start: item.start, end: item.end, text: '' });
            impacts.push({ kind: item.object ? `remove-${item.kind}` : 'remove-statement', label: item.object ? item.object.parts.map((p) => p.value).join('.') : `${item.kind}: ${sql.slice(item.start, item.end).replace(/\s+/g, ' ').slice(0, 100)}`, reason: 'Depends on a removed field or SQL object.' });
            item.removed = true; changed = true;
            if (item.object) removedObjects.push({ kind: item.kind, parts: item.object.parts });
        }
    }
    for (const drop of ast.drops) if (removedObjects.some((o) => o.kind === drop.kind && (!drop.table || same(identifierPartsFrom(drop.table, drop.tableParts))) && identifierPartsEquivalent(o.parts, identifierPartsFrom(drop), ast.dialectProfile?.defaultSchema, dialect))) {
        edits.push({ start: drop.position.start.idx, end: drop.position.end.idx, text: '' }); impacts.push({ kind: 'remove-statement', label: `DROP ${drop.kind} ${drop.name}`, reason: 'The corresponding definition is removed.' });
    }
    for (const object of removedObjects.filter((o) => ['view', 'trigger'].includes(o.kind))) {
        const matches = (item) => item.object && identifierPartsEquivalent(object.parts, item.object.parts, ast.dialectProfile?.defaultSchema, dialect);
        for (const item of external.filter((item) => item.kind === `drop-${object.kind}` && matches(item) && !item.removed)) {
            const definition = external.filter((candidate) => candidate.kind === object.kind && candidate.start < item.start && matches(candidate)).at(-1);
            if (!definition?.removed) continue;
            if (item.tokens.slice(item.object.next).some((t) => punc(t, ','))) return reject('A dependent object shares a DROP list. Edit that statement together in SQL.');
            edits.push({ start: item.start, end: item.end, text: '' }); impacts.push({ kind: 'remove-statement', label: `DROP ${object.kind} ${object.parts.map((p) => p.value).join('.')}` }); item.removed = true;
        }
    }
    return { ok: true, edits, impacts, removedNames };
}
