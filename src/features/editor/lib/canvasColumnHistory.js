/** Follow field identity through DDL; produce a reviewable plan, never commit SQL. */
import { parseAST } from '@/lib/parse-ast/parseAst';
import { tokenize } from '@/lib/parse-ast/tokenize';
import { effectiveIdentifierParts, identifierKey, identifierPartsEquivalent, identifierPartsFrom } from '@/lib/sqlIdentifierIdentity';

const punct = (t, value) => t?.type === 'PUNC' && t.value === value;
const word = (t, value) => t && !/^["`[]/.test(t.raw || '') && t.value.toUpperCase() === value;
const tokenPart = (t) => ({ value: t.value, quoted: /^["`[]/.test(t.raw || '') });
const reject = (message) => ({ ok: false, message });
const apply = (text, edits) => [...edits].sort((a, b) => b.start - a.start).reduce((sql, e) => sql.slice(0, e.start) + e.text + sql.slice(e.end), text);

function alterClauses(sql, start, end, dialect) {
    const raw = sql.slice(start, end); const tokens = tokenize(raw).tokens;
    const table = tokens.findIndex((t) => word(t, 'TABLE'));
    let at = table + 1; if (word(tokens[at], 'ONLY')) at += 1;
    at += 1; while (punct(tokens[at], '.')) at += 2;
    if (!tokens[at]) return [];
    const prefix = raw.slice(0, tokens[at].start.idx);
    let depth = 0; let from = tokens[at].start.idx; const chunks = [];
    for (let i = at; i < tokens.length; i += 1) {
        if (punct(tokens[i], '(')) depth += 1;
        if (punct(tokens[i], ')')) depth -= 1;
        if (!depth && (punct(tokens[i], ',') || punct(tokens[i], ';'))) { chunks.push(raw.slice(from, tokens[i].start.idx)); from = tokens[i].end.idx; }
    }
    if (raw.slice(from).trim()) chunks.push(raw.slice(from));
    let inherited = '';
    return chunks.map((chunk) => {
        const head = tokenize(chunk).tokens[0];
        const explicit = ['ADD', 'DROP', 'ALTER', 'MODIFY', 'CHANGE', 'RENAME', 'SET'].some((v) => word(head, v));
        // SQL Server supports ADD a INT, b INT. Give each preserved action its
        // own verb so deleting the first one cannot leave an invalid statement.
        if (explicit) inherited = word(head, 'ADD') ? 'ADD ' : '';
        const clause = explicit ? chunk : inherited + chunk;
        const parsed = parseAST(prefix + clause + ';', { dialect });
        return { raw: clause, prefix, ast: parsed.ast, actions: parsed.ast.alters, indexes: parsed.ast.indexes, remove: false };
    });
}

/** Token names, rather than substrings, keep literals/functions/qualified owners out of dependency checks. */
function usedSlots(raw, fields, key) {
    const tokens = tokenize(raw).tokens; const result = new Set();
    tokens.forEach((t, i) => {
        if (!['IDENT', 'KW'].includes(t.type) || punct(tokens[i + 1], '(') || punct(tokens[i + 1], '.') || word(tokens[i - 1], 'AS') || word(tokens[i - 1], 'COLLATE') || tokens[i - 1]?.value === '::') return;
        const slot = fields.get(key([tokenPart(t)])); if (slot) result.add(slot);
    });
    return result;
}

function checkEdits(raw, fields, removed, key) {
    const tokens = tokenize(raw).tokens; const edits = [];
    for (let i = 0; i < tokens.length; i += 1) {
        if (!word(tokens[i], 'CHECK') || !punct(tokens[i + 1], '(')) continue;
        let depth = 1; let end = i + 2;
        while (tokens[end] && depth) { if (punct(tokens[end], '(')) depth += 1; if (punct(tokens[end], ')')) depth -= 1; end += 1; }
        if (depth || ![...usedSlots(raw.slice(tokens[i + 1].end.idx, tokens[end - 1].start.idx), fields, key)].some((slot) => removed.has(slot))) continue;
        const start = word(tokens[i - 2], 'CONSTRAINT') ? tokens[i - 2].start.idx : tokens[i].start.idx;
        if (word(tokens[end], 'NOT') && word(tokens[end + 1], 'ENFORCED')) end += 2;
        else if (word(tokens[end], 'ENFORCED')) end += 1;
        edits.push({ start, end: tokens[end - 1].end.idx, text: '' });
    }
    return edits;
}

function stripReference(raw) {
    const tokens = tokenize(raw).tokens; const ref = tokens.findIndex((t) => word(t, 'REFERENCES'));
    if (ref < 0) return raw;
    let end = ref + 2; while (punct(tokens[end], '.')) end += 2;
    if (punct(tokens[end], '(')) { let depth = 0; do { if (punct(tokens[end], '(')) depth += 1; if (punct(tokens[end], ')')) depth -= 1; end += 1; } while (tokens[end] && depth); }
    while (tokens[end]) {
        if (word(tokens[end], 'ON') && (word(tokens[end + 1], 'DELETE') || word(tokens[end + 1], 'UPDATE'))) { end += 2; end += word(tokens[end], 'SET') || word(tokens[end], 'NO') ? 2 : 1; }
        else if (word(tokens[end], 'MATCH') || word(tokens[end], 'INITIALLY')) end += 2;
        else if (word(tokens[end], 'NOT') && word(tokens[end + 1], 'DEFERRABLE')) end += 2;
        else if (word(tokens[end], 'DEFERRABLE')) end += 1;
        else break;
    }
    const start = word(tokens[ref - 2], 'CONSTRAINT') ? tokens[ref - 2].start.idx : tokens[ref].start.idx;
    return raw.slice(0, start) + raw.slice(tokens[end - 1].end.idx);
}

export function planColumnHistoryCascade(sql, table, fieldName, dialect, readDefinition) {
    const { ast } = parseAST(sql, { dialect }); const tokens = tokenize(sql).tokens;
    const origin = ast.tables.find((t) => t.position.start.idx === table.sourcePosition?.index);
    if (!origin) return reject('The current table incarnation could not be located.');
    const key = (parts) => identifierKey(parts, dialect);
    const same = (a, b) => identifierPartsEquivalent(a, b, ast.dialectProfile?.defaultSchema, dialect);
    const fieldKey = (name) => key([{ value: name, quoted: true }]);
    const fields = new Map(); const fieldNames = new Map(); let parts = identifierPartsFrom(origin); let sequence = 0;
    const definitions = []; const records = []; const snapshots = [];
    const addSlot = (column) => { const slot = { id: sequence++, name: column.name, column, initial: false }; const id = key(identifierPartsFrom(column)); fields.set(id, slot); fieldNames.set(id, column.name); return slot; };
    const initial = origin.columns.map((c) => { const slot = addSlot(c); slot.initial = true; return slot; });
    const initialFields = new Map(fields);
    definitions.push(...initial.map((slot) => ({ slot, column: slot.column, fields: initialFields, parts, start: origin.position.start.idx })));
    const snapshot = (end) => snapshots.push({ end, parts: [...parts], fields: new Map(fields), names: new Map(fieldNames) });
    snapshot(origin.position.end.idx);
    // AST positions for actions are whole-statement ranges. Split only at
    // token-level commas outside parentheses, then parse each native action.
    const spans = new Map();
    ast.alters.forEach((a) => spans.set(a.position.start.idx, a.position.end.idx));
    for (const index of ast.indexes) {
        const idx = tokens.findIndex((t) => t.start.idx === index.position.start.idx);
        if (word(tokens[idx], 'CREATE')) continue;
        let at = idx; while (at >= 0 && !word(tokens[at], 'ALTER') && !punct(tokens[at], ';')) at -= 1;
        if (!word(tokens[at], 'ALTER')) continue;
        let end = idx; while (tokens[end] && !punct(tokens[end], ';')) end += 1;
        spans.set(tokens[at].start.idx, (tokens[end] || tokens.at(-1)).end.idx);
    }
    for (const [start, end] of [...spans].sort(([a], [b]) => a - b)) {
        if (start < origin.position.end.idx) continue;
        const clauses = alterClauses(sql, start, end, dialect);
        for (const clause of clauses) {
            const representative = clause.actions[0] || clause.indexes[0];
            const native = representative ? identifierPartsFrom(representative.table, representative.tableParts) : [];
            const own = Boolean(representative) && same(parts, native);
            const record = { start, end, clause, own, parts: [...parts], fields: new Map(fields), slots: new Set() }; records.push(record);
            if (!own) continue;
            for (const action of clause.actions) {
                if (action.action === 'add_column') {
                    const slot = addSlot(action.column); record.slots.add(slot);
                    definitions.push({ slot, column: action.column, fields: new Map(fields), parts: [...parts], record });
                } else if (action.action === 'rename_column' || action.action === 'change_column') {
                    const old = key(identifierPartsFrom(action.oldName, action.oldNameParts)); const slot = fields.get(old);
                    if (slot) { record.slots.add(slot); fields.delete(old); fieldNames.delete(old); const id = key(action.action === 'rename_column' ? identifierPartsFrom(action.newName, action.newNameParts) : identifierPartsFrom(action.column)); fields.set(id, slot); fieldNames.set(id, action.newName || action.column.name); if (action.column) definitions.push({ slot, column: action.column, fields: new Map(fields), parts: [...parts], record }); }
                } else if (typeof action.column === 'string' || action.action === 'modify_column') {
                    const slot = fields.get(key(typeof action.column === 'string' ? identifierPartsFrom(action.column, action.columnParts) : identifierPartsFrom(action.column)));
                    if (slot) { record.slots.add(slot); if (action.action === 'drop_column') { const id = key(identifierPartsFrom(action.column, action.columnParts)); fields.delete(id); fieldNames.delete(id); } else if (typeof action.column === 'object') definitions.push({ slot, column: action.column, fields: new Map(fields), parts: [...parts], record }); }
                } else if (action.action === 'rename_table') parts = identifierPartsFrom(action.newName, action.newTableParts);
                else if (action.action === 'set_schema') parts = [...identifierPartsFrom(action.schema, action.schemaParts), parts.at(-1)];
            }
        }
        snapshot(end);
    }
    const selected = fields.get(fieldKey(fieldName));
    if (!selected) return reject('This field changed. Select its current row and try again.');
    const removed = new Set([selected]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const def of definitions) if (!removed.has(def.slot) && def.column.generated && [...usedSlots(def.column.generated, def.fields, key)].some((s) => removed.has(s))) { removed.add(def.slot); changed = true; }
    }
    if ([...fields.values()].every((s) => removed.has(s))) return reject('The cascade would remove every field. A table must keep at least one column.');
    const affected = (names, state) => (names || []).some((name) => removed.has(state.get(fieldKey(name))));
    const stateAt = (position) => { let state; for (const candidate of snapshots) { if (candidate.end > position) break; state = candidate; } return state; };
    const impactedNames = table.columns.filter((c) => removed.has(fields.get(fieldKey(c.name))));
    const impacts = []; const edits = []; const objectEvents = [];
    const objectKey = (owner, name, kind = 'constraint') => `${kind}:${snapshots.some((s) => same(s.parts, owner)) ? '@owner' : key(effectiveIdentifierParts(owner, ast.dialectProfile?.defaultSchema))}:${fieldKey(name)}`;
    const nativeIndexParts = (indexParts, ownerParts = []) => indexParts.length > 1 ? indexParts : [...(ownerParts.length > 1 ? ownerParts.slice(0, -1) : [{ value: ast.dialectProfile?.defaultSchema || 'public', quoted: false }]), ...indexParts];
    const declareObject = (owner, name, start, removed, indexParts) => { if (name) objectEvents.push({ id: objectKey(owner, name, indexParts ? 'index' : 'constraint'), start, removed, indexParts: indexParts ? nativeIndexParts(indexParts, owner) : null }); };
    const referenceAffected = (reference, state, sourceParts = []) => {
        if (!reference || !state) return false;
        let referenceParts = identifierPartsFrom(reference.table, reference.tableParts);
        if (dialect === 'sqlite' && referenceParts.length === 1 && sourceParts.length > 1) referenceParts = [...sourceParts.slice(0, -1), ...referenceParts];
        if (!same(referenceParts, state.parts)) return false;
        if (reference.columns?.length) return affected(reference.columns, state.fields);
        return [...state.fields.values()].some((slot) => slot.column.primary && removed.has(slot)) || origin.constraints.some((c) => c?.kind === 'primary' && affected(c.columns, state.fields));
    };
    const modelEdits = new Map();
    for (const declaration of ast.tables) {
        const own = declaration === origin; const state = own ? { parts: identifierPartsFrom(origin), fields: initialFields } : stateAt(declaration.position.start.idx);
        const model = readDefinition(sql.slice(declaration.position.start.idx, declaration.position.end.idx), dialect); if (!model.ok) return model;
        const entries = [];
        for (const entry of model.entries) {
            const column = declaration.columns.find((c) => c.name === entry.name);
            const local = tokenize(entry.raw).tokens;
            for (const [i, token] of local.entries()) if (word(token, 'CONSTRAINT')) declareObject(identifierPartsFrom(declaration), local[i + 1]?.value, declaration.position.start.idx + token.start.idx, false);
            if (own && column && removed.has(initialFields.get(key(identifierPartsFrom(column))))) {
                if (column.primary || column.unique) impacts.push({ kind: 'remove-key', label: `${table.name}.${column.name}` });
                for (const [i, token] of local.entries()) if (word(token, 'CONSTRAINT')) declareObject(identifierPartsFrom(declaration), local[i + 1]?.value, declaration.position.start.idx + token.start.idx, true);
                continue;
            }
            const constraint = declaration.constraints.find((c) => c?._token?.start?.idx - declaration.position.start.idx >= entry.start && c._token.start.idx - declaration.position.start.idx < entry.end);
            const ownKey = own && constraint && affected(constraint.columns, initialFields);
            const inbound = referenceAffected(column?.references || constraint?.references, state, identifierPartsFrom(declaration));
            let text = entry.raw;
            if (ownKey || inbound && !column) {
                impacts.push({ kind: constraint?.kind === 'foreign' ? 'remove-relationship' : 'remove-key', label: entry.raw.trim() });
                if (constraint?.name) declareObject(identifierPartsFrom(declaration), constraint.name, declaration.position.start.idx + local[0].start.idx, true);
                continue;
            }
            if (inbound) { text = stripReference(text); impacts.push({ kind: 'remove-relationship', label: `${declaration.name}.${column.name} → ${table.name}` }); }
            if (own) {
                const checks = checkEdits(text, initialFields, removed, key);
                if (checks.length) {
                    impacts.push({ kind: 'remove-check', label: entry.raw.trim() });
                    for (const [i, token] of local.entries()) if (word(token, 'CONSTRAINT') && checks.some((e) => e.start === token.start.idx)) declareObject(identifierPartsFrom(declaration), local[i + 1].value, declaration.position.start.idx + token.start.idx, true);
                    if (!column) continue;
                    text = apply(text, checks);
                }
            }
            entries.push(text);
        }
        if (own && !entries.some((raw) => tokenize(raw).tokens.length && model.table.columns.some((c) => !removed.has(initialFields.get(key(identifierPartsFrom(c))))))) return reject('The original CREATE TABLE must keep a field before later migrations run.');
        const text = model.prefix + entries.join(',') + model.suffix;
        if (text !== model.sql) modelEdits.set(declaration.position.start.idx, { start: declaration.position.start.idx, end: declaration.position.end.idx, text });
    }
    for (const record of records) {
        const { clause } = record;
        const state = { parts: record.parts, fields: record.fields };
        const action = clause.actions[0]; const index = clause.indexes[0];
        const ownRemoval = record.own && ([...record.slots].some((s) => removed.has(s)) || affected(action?.columns || index?.columns, record.fields)
            || ['add_check', 'add_index'].includes(action?.action) && [...usedSlots(action.expression || clause.raw, record.fields, key)].some((s) => removed.has(s))
            || index && [...usedSlots(clause.raw, record.fields, key)].some((s) => removed.has(s)));
        const nativeSource = action ? identifierPartsFrom(action.table, action.tableParts) : [];
        const inbound = referenceAffected(action?.references || action?.column?.references, state, nativeSource);
        if (inbound && action?.action === 'add_column' && !ownRemoval) {
            clause.raw = stripReference(clause.raw); clause.changed = true;
            impacts.push({ kind: 'remove-relationship', label: `${action.table}.${action.column.name} → ${table.name}` });
        } else if (ownRemoval || inbound) {
            clause.remove = true;
            impacts.push({ kind: action?.action === 'add_foreign' ? 'remove-relationship' : action?.action === 'add_check' ? 'remove-check' : 'remove-migration', label: `${(action || index)?.table}: ${clause.raw.trim()}` });
        }
    }
    for (const index of ast.indexes) {
        if (records.some((r) => index.position.start.idx >= r.start && index.position.end.idx <= r.end)) continue;
        const state = stateAt(index.position.start.idx); if (!state || !same(identifierPartsFrom(index.table, index.tableParts), state.parts)) continue;
        const usesRemoved = affected(index.columns, state.fields) || [...usedSlots(index.expressions?.join(' ') + ' ' + (index.where || ''), state.fields, key)].some((s) => removed.has(s));
        declareObject(state.parts, identifierPartsFrom(index).at(-1)?.value || index.name, index.position.start.idx, usesRemoved, identifierPartsFrom(index));
        if (!usesRemoved) continue;
        edits.push({ start: index.position.start.idx, end: index.position.end.idx, text: '' });
        impacts.push({ kind: 'remove-index', label: index.name });
    }
    // Remove matching DROP/RENAME history by native object identity. Keep all
    // unrelated clauses, even when they share one ALTER statement.
    const liveObjects = new Map(); const indexObjects = new Map();
    const events = [...objectEvents, ...records.map((record) => ({ start: record.start, record })), ...ast.drops.filter((d) => d.kind === 'index').map((drop) => ({ start: drop.position.start.idx, drop }))].sort((a, b) => a.start - b.start);
    for (const event of events) {
        if (event.id) { liveObjects.set(event.id, event.removed); if (event.indexParts) indexObjects.set(key(event.indexParts), event.id); continue; }
        if (event.drop) {
            const drop = event.drop; const state = stateAt(drop.position.start.idx); if (!state) continue;
            const id = indexObjects.get(key(nativeIndexParts(identifierPartsFrom(drop)))) || (identifierPartsFrom(drop).length < 2 ? objectKey(drop.table ? identifierPartsFrom(drop.table, drop.tableParts) : state.parts, identifierPartsFrom(drop).at(-1)?.value || drop.name, 'index') : null);
            if (liveObjects.get(id)) {
                if (ast.drops.filter((d) => d.position.start.idx === drop.position.start.idx).length > 1) return reject('Keep a dependent DROP INDEX in its own statement before cascading.');
                edits.push({ start: drop.position.start.idx, end: drop.position.end.idx, text: '' }); impacts.push({ kind: 'remove-migration', label: `DROP INDEX ${drop.name}` });
            }
            liveObjects.delete(id); continue;
        }
        const { record } = event; const action = record.clause.actions[0]; const index = record.clause.indexes[0]; if (!action && !index) continue;
        const owner = identifierPartsFrom((action || index).table, (action || index).tableParts);
        if (action?.action.startsWith('add_') || index) { const name = action?.name || index?.name; if (name) liveObjects.set(objectKey(owner, name, index ? 'index' : 'constraint'), record.clause.remove); }
        if (['drop_constraint', 'rename_constraint', 'rename_index', 'rename_index_global'].includes(action?.action)) {
            const globalIndex = action.action === 'rename_index_global'; const kind = action.action.includes('index') ? 'index' : 'constraint';
            const oldParts = globalIndex ? nativeIndexParts(identifierPartsFrom(action.oldName, action.oldNameParts)) : null;
            const id = globalIndex ? indexObjects.get(key(oldParts)) : objectKey(owner, action.name || action.oldName, kind); const removedObject = liveObjects.get(id); liveObjects.delete(id);
            if (removedObject) { record.clause.remove = true; impacts.push({ kind: 'remove-migration', label: `${action.table || `Index ${action.oldName}`}: ${record.clause.raw.trim()}` }); }
            if (action.newName && id) {
                const leaf = identifierPartsFrom(action.newName, action.newNameParts).at(-1).value;
                const newId = globalIndex ? id.slice(0, id.lastIndexOf(':') + 1) + fieldKey(leaf) : objectKey(owner, leaf, kind);
                liveObjects.set(newId, Boolean(removedObject));
                if (globalIndex) { indexObjects.delete(key(oldParts)); indexObjects.set(key(nativeIndexParts(identifierPartsFrom(action.newName, action.newNameParts))), newId); }
            }
        }
    }
    for (const [start, end] of spans) {
        const group = records.filter((r) => r.start === start); if (!group.some((r) => r.clause.remove || r.clause.changed)) continue;
        const kept = group.filter((r) => !r.clause.remove).map((r) => r.clause.raw);
        edits.push({ start, end, text: kept.length ? group[0].clause.prefix + kept.join(',') + ';' : '' });
    }
    edits.push(...modelEdits.values());
    for (const column of impactedNames) if (fields.get(fieldKey(column.name)) !== selected) impacts.push({ kind: 'remove-column', label: `${table.name}.${column.name}`, reason: 'Generated from a removed field.' });
    return { ok: true, edits, impacts, removedNames: table.columns.filter((c) => removed.has(fields.get(fieldKey(c.name)))).map((c) => c.name),
        stateAt: (position) => { const state = stateAt(position); if (!state) return null; return { parts: state.parts, columns: [...state.fields].map(([id, slot]) => ({ ...slot.column, name: state.names.get(id), nameParts: [{ value: state.names.get(id), quoted: true }] })), removedNames: [...state.fields].filter(([, s]) => removed.has(s)).map(([id]) => state.names.get(id)) }; } };
}
