import { parseAST } from './parse-ast/parseAst.js';
import {
    DEFAULT_SCHEMA_NAME,
    buildIdentifierDisplayContext,
    effectiveIdentifierParts,
    identifierFullName,
    identifierKey,
    identifierLeafKey,
    identifierLeafName,
    identifierNamespaceParts,
    identifierPartsFrom,
} from './sqlIdentifierIdentity.js';

/**
 * ════════════════════════════════════════════════════════════════════════════
 *  erdJsonSchema — AST → ERD-renderer schema bridge
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  PURPOSE
 *  -------
 *  This is the *only* adapter between the dialect-aware AST produced by
 *  `parseAST` and the canvas renderer in `genErdScript.js`. Whenever the
 *  renderer needs a new field on a column or a new property on a relation,
 *  it must be materialised here.
 *
 *  PIPELINE STAGES (run in order inside `convertAstToErdSchema`)
 *  -------------------------------------------------------------
 *    1. Types       — `CREATE TYPE … AS ENUM` / composite → `schema.enums` /
 *                     `schema.composites`, with dialect-aware qualified-name
 *                     resolution for column types.
 *    2. Tables      — the final CREATE/DROP lifecycle state is converted
 *                     column-by-column
 *                     via `convertColumnToErdFormat`, then table-level
 *                     constraints (PK / UQ / FK / CHECK) are layered on
 *                     top. `tableColumnsMap` tracks each table's columns
 *                     and accumulating foreign keys for stage 4.
 *    3. Migration   — `ALTER TABLE` and `CREATE INDEX` operations are replayed
 *                     in source order against `tableColumnsMap`, including
 *                     column shape/order, constraints, renames, and badges.
 *    4. Relations   — every accumulated FK becomes renderer-compatible
 *                     relation entries. Composite FKs keep grouped metadata
 *                     while still exposing per-column rows to the renderer.
 *                     Crow's-Foot cardinality is derived from the FK source
 *                     column set, not just one column.
 *    5. Validation  — `validateSchema` filters out relations that point at
 *                     non-existent tables or columns and pushes a
 *                     `warning`-severity entry into `schema._parseErrors`
 *                     for every drop, so the editor surfaces actionable
 *                     feedback instead of silently losing FKs.
 *
 *  RENDERER CONTRACT (frozen — `genErdScript.js` reads these fields directly)
 *  ------------------------------------------------------------------------
 *    schema = {
 *      enums:      Array<{ name, values:string[] }>,
 *      composites: Array<{ name, fields }>,
 *      tables:     Array<{
 *        name,
 *        columns: Array<{
 *          name, type,
 *          constraints: string[],   // any of 'PK','UQ','NN','IDX' (badge text)
 *          extras:      string[],   // free-text (DEFAULT/CHECK/AUTO_INC/…)
 *          pk?: true, fk?: true,
 *          compositePk?: true, compositeUq?: true, compositeIdx?: true,
 *          autoIncrement?: true,
 *        }>
 *      }>,
 *      relations:  Array<{
 *        from: { table, column },
 *        to:   { table, column },
 *        fromCard: '0..1' | '0..n',
 *        toCard:   '1' | '0..1',
 *        fkName?:  string,          // only when SQL declared a named FK
 *      }>,
 *      _parseErrors: ParseError[],   // tokenizer + parser + validator diags
 *    }
 *
 *  AI-FRIENDLY GOTCHAS (read before refactoring)
 *  ---------------------------------------------
 *  • Table/type identity is dialect-aware. PostgreSQL quoted identifiers are
 *    case-sensitive; its unquoted identifiers fold to lower-case. Column
 *    comparisons remain normalized inside their already-resolved table.
 *  • Qualified identifiers are kept structurally during resolution. Display
 *    names are simplified only when that does not collide with another table.
 *  • PK columns are NOT given a separate `'NN'` badge — `'PK'` already
 *    implies NOT NULL. `convertColumnToErdFormat` enforces this with
 *    `if (col.notNull && !col.primary)`.
 *  • Composite PK / UNIQUE columns are flagged with `compositePk` /
 *    `compositeUq` for drawing, while relation cardinality uses tracked
 *    PK/UQ column groups to decide whether the whole FK source set is unique.
 *  • `_parseErrors` is the single channel the editor reads for both
 *    tokenizer errors AND validator warnings — keep `position` shaped as
 *    `{ line, column, index }` so the Monaco gutter can jump to it.
 * ════════════════════════════════════════════════════════════════════════════
 */

/**
 * Public entry point — parse + convert + validate in one call.
 *
 * Behaviour contract:
 *   • Non-string input → throws `Error('SQL input must be a string')`.
 *   • Empty / whitespace-only string → returns the canonical empty schema
 *     (no exception, empty arrays). Lets the live preview render a blank
 *     canvas while the user is still typing.
 *   • Any internal error is re-thrown as `Error('Failed to parse SQL: …')`
 *     after being logged via `console.error` for browser-devtools triage.
 *
 * @param {string} sql - SQL DDL string (SQLite, PostgreSQL, MySQL, or MSSQL).
 * @param {{dialect?: 'auto'|'sqlite'|'postgres'|'mysql'|'mssql', defaultSchema?: string|null}|string} [options]
 * @returns {object} ERD schema (see file-level docblock for the full shape).
 */
export function sqlToErdSchema(sql, options = {}) {
    try {
        if (typeof sql !== 'string') throw new Error('SQL input must be a string');
        if (!sql.trim()) {
            // Return an empty but well-formed schema so callers (editor live-
            // preview and validators) can render a blank ERD without
            // hitting an exception. The renderer contract still holds.
            return { enums: [], composites: [], tables: [], relations: [], _parseErrors: [] };
        }

        // Preserve the caller's exact SQL when parsing so diagnostics remain
        // line/column/index-correct for editor buffers that start with
        // whitespace or comments.
        const parseResult = parseAST(sql, options);

        const { ast } = parseResult;
        const schema = convertAstToErdSchema(ast);
        // Carry parse errors forward BEFORE validateSchema so that any
        // additional warnings emitted while pruning bad relations land in
        // the same list that the editor surfaces to the user.
        schema._parseErrors = [...(parseResult.errors || []), ...(schema._parseErrors || [])];
        validateSchema(schema);

        return schema;
    } catch (err) {
        console.error('SQL parsing error:', err);
        throw new Error(`Failed to parse SQL: ${err.message}`);
    }
}

/**
 * Strip schema prefix from a qualified identifier.
 *   `dbo.users`     → `users`
 *   `public.mood`   → `mood`
 *   `users`         → `users`   (unchanged)
 *   null/undefined  → returned as-is so callers don't need to null-guard.
 *
 * Uses `lastIndexOf('.')` so dotted-but-already-stripped identifiers and
 * fully-qualified `db.schema.table` triples both collapse to the leaf name.
 */
function stripSchema(name) {
    if (!name) return name;
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.substring(dot + 1) : name;
}

/**
 * Convert a parseAst-emitted token into the `{ line, column, index }` shape
 * the editor's gutter / Monaco markers expect. Tokens carry a `start`
 * field with `{ idx, line, col }` (the tokenizer's native shape); this
 * helper normalises that to the public `position` contract.
 *
 * Returns `null` when no usable position is present so callers can fall
 * back to the conservative `{ line: 1, column: 1, index: 0 }` default.
 */
function tokenToPosition(token) {
    if (!token || !token.start) return null;
    return {
        // `??` (not `||`) preserves a legitimate 0 char-offset / 1-based
        // first line — `||` would mask both.
        line: token.start.line ?? 1,
        column: token.start.col ?? 1,
        index: token.start.idx ?? 0,
    };
}

/**
 * Convert an ALTER statement's `position: { start, end }` (which itself
 * uses the `{ idx, line, col }` shape from the tokenizer) into the public
 * `{ line, column, index }` position contract. Used so dropped-FK
 * warnings on ALTER-introduced relations can jump the user back to the
 * `ALTER TABLE` line, not the unrelated CREATE TABLE earlier in the file.
 */
function alterPositionToPos(alterPosition) {
    const start = alterPosition && alterPosition.start;
    if (!start) return null;
    return {
        line: start.line ?? 1,
        column: start.col ?? 1,
        index: start.idx ?? 0,
    };
}

/** Conservative fallback when no token-level position is available. */
const DEFAULT_POSITION = { line: 1, column: 1, index: 0 };

function attachHiddenIdentifierMeta(target, values) {
    if (!target || !values) return target;
    Object.entries(values).forEach(([key, value]) => {
        Object.defineProperty(target, key, {
            value,
            enumerable: false,
            configurable: true,
            writable: true,
        });
    });
    return target;
}

function makeIdentifierResolver({ dialect = 'auto', defaultSchema = null } = {}) {
    const byFullKey = new Map();
    const byLeafKey = new Map();
    const byDisplayName = new Map();

    return {
        add(entry) {
            if (!entry?.meta) return;
            byFullKey.set(entry.meta.fullKey, entry);
            if (!byLeafKey.has(entry.meta.leafKey)) byLeafKey.set(entry.meta.leafKey, []);
            byLeafKey.get(entry.meta.leafKey).push(entry);
            byDisplayName.set(entry.displayName, entry);
        },
        remove(entry) {
            if (!entry?.meta) return;
            if (byFullKey.get(entry.meta.fullKey) === entry) byFullKey.delete(entry.meta.fullKey);
            const leafMatches = byLeafKey.get(entry.meta.leafKey) || [];
            const filtered = leafMatches.filter((candidate) => candidate !== entry);
            if (filtered.length > 0) byLeafKey.set(entry.meta.leafKey, filtered);
            else byLeafKey.delete(entry.meta.leafKey);
            if (byDisplayName.get(entry.displayName) === entry) byDisplayName.delete(entry.displayName);
        },
        clear() {
            byFullKey.clear();
            byLeafKey.clear();
            byDisplayName.clear();
        },
        resolve(name, parts = null) {
            const resolvedParts = identifierPartsFrom(name, parts);
            const fullKey = identifierKey(resolvedParts, dialect);
            if (byFullKey.has(fullKey)) return byFullKey.get(fullKey);
            if (defaultSchema && resolvedParts.length === 1) {
                const defaultQualifiedKey = identifierKey(effectiveIdentifierParts(resolvedParts, defaultSchema), dialect);
                if (byFullKey.has(defaultQualifiedKey)) return byFullKey.get(defaultQualifiedKey);
            }

            // An explicitly qualified identifier must match that exact
            // qualified object. Falling back to the only matching leaf would
            // silently turn `s2.users` into `s1.users`.
            const hasExplicitParts = Array.isArray(parts) && parts.length > 0;
            const isLiteralDottedIdentifier = resolvedParts.length === 1 && String(resolvedParts[0]?.value || '').includes('.');
            if (hasExplicitParts && isLiteralDottedIdentifier) return null;
            if (hasExplicitParts && resolvedParts.length > 1) return null;

            const display = identifierFullName(resolvedParts);
            if (byDisplayName.has(display)) return byDisplayName.get(display);

            if (resolvedParts.length > 1) return null;

            const leafMatches = byLeafKey.get(identifierLeafKey(resolvedParts, dialect)) || [];
            if (resolvedParts.length === 1 && leafMatches.length === 1) return leafMatches[0];
            return null;
        },
    };
}

function makeTableResolver(options) {
    return makeIdentifierResolver(options);
}

function lifecycleIdentifierKey(value, explicitParts, dialect, defaultSchema) {
    const parts = identifierPartsFrom(value, explicitParts);
    const effective = defaultSchema ? effectiveIdentifierParts(parts, defaultSchema) : parts;
    return identifierKey(effective, dialect);
}

function finalNamedObjectsAfterDrops(items, drops, { kind, dialect, defaultSchema, keyForItem = null, keyForDrop = null }) {
    const liveItems = Array.isArray(items) ? items.filter(Boolean) : [];
    const matchingDrops = Array.isArray(drops) ? drops.filter((drop) => drop?.kind === kind && drop.name) : [];
    if (matchingDrops.length === 0) return liveItems;

    const itemKey = keyForItem || ((item) => lifecycleIdentifierKey(item, item?.nameParts, dialect, defaultSchema));
    const dropKey = keyForDrop || ((drop) => lifecycleIdentifierKey(drop.name, drop.nameParts, dialect, defaultSchema));
    const latest = new Map();
    liveItems.forEach((item, order) => {
        const key = itemKey(item);
        if (!key) return;
        const index = item.position?.start?.idx ?? order;
        const current = latest.get(key);
        if (!current || index >= current.index) latest.set(key, { kind: 'create', value: item, index });
    });
    matchingDrops.forEach((drop, order) => {
        const key = dropKey(drop);
        if (!key) return;
        const index = drop.position?.start?.idx ?? Number.MAX_SAFE_INTEGER - matchingDrops.length + order;
        const current = latest.get(key);
        if (!current || index >= current.index) latest.set(key, { kind: 'drop', value: drop, index });
    });

    return liveItems.filter((item) => {
        const key = itemKey(item);
        // Unnamed inline indexes cannot be targeted by DROP INDEX and must
        // remain in the replay stream even when named indexes are dropped.
        if (!key) return true;
        const finalEvent = latest.get(key);
        return finalEvent?.kind === 'create' && finalEvent.value === item;
    });
}

function resolveLifecycleTable(active, name, explicitParts, dialect, defaultSchema) {
    const parts = identifierPartsFrom(name, explicitParts);
    const exactKey = lifecycleIdentifierKey(name, explicitParts, dialect, defaultSchema);
    if (exactKey && active.has(exactKey)) return active.get(exactKey);
    if (parts.length !== 1) return null;

    // In no-default-schema modes (notably MySQL and auto), retain the parser's
    // established unique-leaf fallback for an unqualified operation. Never
    // guess when two live schemas expose the same leaf name.
    const leafKey = identifierLeafKey(parts, dialect);
    const matches = Array.from(active.values()).filter((record) => identifierLeafKey(record.currentParts, dialect) === leafKey);
    return matches.length === 1 ? matches[0] : null;
}

function tableReferenceObjects(table) {
    const references = [];
    (table?.columns || []).forEach((column) => {
        if (column?.references) references.push(column.references);
    });
    (table?.constraints || []).forEach((constraint) => {
        if (constraint?.references) references.push(constraint.references);
    });
    return references;
}

/**
 * Build a chronological table-incarnation plan without mutating the parser
 * AST. Final-name filtering alone is insufficient for migration scripts such
 * as `CREATE t; RENAME t TO old_t; CREATE t`: both live objects originated
 * with the same name, and every later operation must remain bound to the
 * incarnation that was active when the statement occurred.
 */
function buildTableLifecyclePlan(ast, dialect, defaultSchema) {
    const tables = Array.isArray(ast?.tables) ? ast.tables.filter(Boolean) : [];
    const alters = Array.isArray(ast?.alters) ? ast.alters.filter(Boolean) : [];
    const indexes = Array.isArray(ast?.indexes) ? ast.indexes.filter(Boolean) : [];
    const tableDrops = Array.isArray(ast?.drops) ? ast.drops.filter((drop) => drop?.kind === 'table' && drop.name) : [];
    const records = [];
    const operationTargets = new WeakMap();
    const referenceTargets = new WeakMap();
    const unresolvedReferences = [];
    const active = new Map();
    const events = [];

    tables.forEach((table, order) => events.push({ kind: 'create', value: table, order, index: table.position?.start?.idx ?? order }));
    alters.forEach((alter, order) => events.push({ kind: 'alter', value: alter, order: order + 1000000, index: alter.position?.start?.idx ?? Number.MAX_SAFE_INTEGER }));
    indexes.forEach((index, order) => events.push({ kind: 'index', value: index, order: order + 2000000, index: index.position?.start?.idx ?? Number.MAX_SAFE_INTEGER }));
    tableDrops.forEach((drop, order) => events.push({ kind: 'drop', value: drop, order: order + 3000000, index: drop.position?.start?.idx ?? Number.MAX_SAFE_INTEGER }));

    const bindReference = (reference, index) => {
        if (!reference?.table) return;
        const target = resolveLifecycleTable(active, reference.table, reference.tableParts, dialect, defaultSchema);
        if (target) referenceTargets.set(reference, target);
        else unresolvedReferences.push({ reference, index });
    };

    events.sort((left, right) => left.index - right.index || left.order - right.order).forEach((event) => {
        if (event.kind === 'create') {
            const currentParts = identifierPartsFrom(event.value, event.value.nameParts);
            const key = lifecycleIdentifierKey(event.value, event.value.nameParts, dialect, defaultSchema);
            if (!key) return;
            const record = {
                table: event.value,
                currentParts,
                currentKey: key,
                createIndex: event.index,
                aliasKeys: new Set([key]),
            };
            records.push(record);
            if (active.has(key)) {
                // Keep duplicate CREATE definitions visible so schema quality
                // can report the invalid repeated identity. The first live
                // incarnation remains the only legal target for later DDL.
                record.duplicateConflict = true;
            } else {
                active.set(key, record);
            }
            // Register the table before its references so self-referential FKs
            // bind to this exact incarnation.
            tableReferenceObjects(event.value).forEach((reference) => bindReference(reference, event.index));
            return;
        }

        if (event.kind === 'drop') {
            const record = resolveLifecycleTable(active, event.value.name, event.value.nameParts, dialect, defaultSchema);
            if (!record) return;
            operationTargets.set(event.value, record);
            record.dropKey = record.currentKey;
            record.dropBehavior = event.value.behavior || null;
            active.delete(record.currentKey);
            return;
        }

        const record = resolveLifecycleTable(active, event.value.table, event.value.tableParts, dialect, defaultSchema);
        if (!record) return;
        operationTargets.set(event.value, record);

        if (event.kind === 'index') return;
        if (event.value.references) bindReference(event.value.references, event.index);
        if (event.value.column?.references) bindReference(event.value.column.references, event.index);
        if (event.value.action !== 'rename_table' || !event.value.newName) return;

        let nextParts = identifierPartsFrom(event.value.newName, event.value.newTableParts);
        if (nextParts.length === 1) {
            const namespace = identifierNamespaceParts(record.currentParts);
            if (namespace.length > 0) nextParts = [...namespace, ...nextParts];
        }
        const nextKey = lifecycleIdentifierKey(identifierFullName(nextParts), nextParts, dialect, defaultSchema);
        if (!nextKey || (active.has(nextKey) && active.get(nextKey) !== record)) return;
        active.delete(record.currentKey);
        record.currentParts = nextParts;
        record.currentKey = nextKey;
        record.aliasKeys.add(nextKey);
        active.set(nextKey, record);
    });

    // SQLite permits forward FK references, and pasted migration corpora can
    // contain them for other dialects. Resolve an initially missing target to
    // the earliest later incarnation that ever owned that identifier, even if
    // the target was subsequently renamed.
    unresolvedReferences.forEach(({ reference, index }) => {
        const key = lifecycleIdentifierKey(reference.table, reference.tableParts, dialect, defaultSchema);
        const later = records
            .filter((record) => record.createIndex >= index && record.aliasKeys.has(key))
            .sort((left, right) => left.createIndex - right.createIndex)[0];
        const target = later || resolveLifecycleTable(active, reference.table, reference.tableParts, dialect, defaultSchema);
        if (target) referenceTargets.set(reference, target);
    });

    const survivingRecords = new Set([
        ...active.values(),
        ...records.filter((record) => record.duplicateConflict),
    ]);
    const orderedSurvivors = records.filter((record) => survivingRecords.has(record));
    const replacementByDroppedRecord = new Map();
    records.filter((record) => record.dropKey).forEach((record) => {
        const replacement = active.get(record.dropKey);
        if (replacement && replacement !== record) replacementByDroppedRecord.set(record, replacement);
    });
    const displayEntries = new Map(orderedSurvivors.map((record) => {
        const entry = { name: identifierFullName(record.currentParts) };
        attachHiddenIdentifierMeta(entry, { nameParts: record.currentParts });
        return [record.table, entry];
    }));

    return {
        records: orderedSurvivors,
        tables: orderedSurvivors.map((record) => record.table),
        displayEntries,
        operationTargets,
        referenceTargets,
        survivingRecords,
        replacementByDroppedRecord,
        dialect,
    };
}

function finalTypesAfterDrops(ast, dialect, defaultSchema) {
    return finalNamedObjectsAfterDrops(ast?.types, ast?.drops, {
        kind: 'type',
        dialect,
        defaultSchema,
    });
}

function referenceForTableLifecycle(reference, lifecyclePlan) {
    if (!reference || !lifecyclePlan?.referenceTargets?.has(reference)) return reference;
    const target = lifecyclePlan.referenceTargets.get(reference);
    // A reference bound to an object that was later dropped must not silently
    // rebind under PostgreSQL DROP ... CASCADE, which removes the referencing
    // constraint. SQLite keeps the FK declaration in the child schema and it
    // becomes valid again if a table with the same identity is recreated.
    let effectiveTarget = target;
    if (!lifecyclePlan.survivingRecords.has(target)) {
        if (lifecyclePlan.dialect === 'postgres' && target.dropBehavior === 'CASCADE') return null;
        effectiveTarget = lifecyclePlan.replacementByDroppedRecord.get(target);
        if (!effectiveTarget) return null;
    }
    const next = {
        ...reference,
        table: identifierFullName(effectiveTarget.currentParts),
    };
    attachHiddenIdentifierMeta(next, { tableParts: effectiveTarget.currentParts });
    return next;
}

function alterForTableLifecycle(alter, lifecyclePlan) {
    if (!alter) return alter;
    let next = alter;
    if (alter.references) {
        const references = referenceForTableLifecycle(alter.references, lifecyclePlan);
        if (!references && alter.action === 'add_foreign') return null;
        if (references !== alter.references) next = { ...next, references };
    }
    if (alter.column?.references) {
        const references = referenceForTableLifecycle(alter.column.references, lifecyclePlan);
        next = {
            ...next,
            column: {
                ...alter.column,
                references,
            },
        };
    }
    return next;
}

/**
 * The main AST→schema transform. Runs the four-stage pipeline described in
 * the file-level docblock: types → tables → alters → relations. Mutates a
 * fresh `schema` object and returns it; never mutates the input AST.
 *
 * Internal scratch state (lives only inside this call):
 *   • `tableColumnsMap : Map<tableName, { columns, foreignKeys }>` — used by
 *     stages 3 (ALTER replay) and 4 (relation generation) to look tables up
 *     after stage 2 has finished writing them.
 *   • `enumTypes      : Set<lowercased name>` — used by
 *     `convertColumnToErdFormat` (presently informational; reserved for
 *     future enum-aware badging).
 *   • `typeResolver` — schema-aware lookup for enum/composite type names
 *     so columns can point at the renderer display name without collapsing
 *     distinct domains like `s1.status` and `s2.status`.
 */
function convertAstToErdSchema(ast) {
    const schema = {
        enums: [],
        composites: [],
        tables: [],
        relations: [],
        _parseErrors: [],
    };

    const dialect = ast?.dialect || 'auto';
    attachHiddenIdentifierMeta(schema, { dialect });
    const hasConfiguredDefaultSchema = ast?.parseOptions && Object.prototype.hasOwnProperty.call(ast.parseOptions, 'defaultSchema');
    const defaultSchema = hasConfiguredDefaultSchema
        ? ast.parseOptions.defaultSchema
        : ast?.dialectProfile?.defaultSchema ?? (dialect === 'auto' ? DEFAULT_SCHEMA_NAME : null);
    const tableLifecycle = buildTableLifecyclePlan(ast, dialect, defaultSchema);
    const effectiveTables = tableLifecycle.tables;
    const effectiveTypes = finalTypesAfterDrops(ast, dialect, defaultSchema);
    // Index state is replayed chronologically below. Do not pre-filter CREATE
    // INDEX entries against later DROP names: an intervening RENAME changes
    // which identity a later DROP targets (for example `ix_old -> ix_new`
    // followed by `DROP INDEX ix_old`, which must leave ix_new alive).
    const effectiveIndexes = Array.isArray(ast?.indexes) ? ast.indexes.filter(Boolean) : [];
    const tableColumnsMap = new Map();
    const tableEntryByAst = new WeakMap();
    const tableResolver = makeTableResolver({ dialect, defaultSchema });
    const tableDisplayEntries = effectiveTables.map((table) => tableLifecycle.displayEntries.get(table));
    const tableDisplayContext = buildIdentifierDisplayContext(tableDisplayEntries, { schemaAware: !!defaultSchema, defaultSchema: defaultSchema || DEFAULT_SCHEMA_NAME, dialect });
    const typeResolver = makeIdentifierResolver({ dialect, defaultSchema });
    // Type names stay compact when their leaf names are unique. Resolution is
    // still default-schema-aware through typeResolver, while display only
    // qualifies actual leaf collisions (for example public.state/app.state).
    const typeDisplayContext = buildIdentifierDisplayContext(effectiveTypes, { dialect });
    const enumTypes = new Set();

    // 1. Process types (enums and composites)
    if (effectiveTypes.length > 0) {
        effectiveTypes.forEach((type) => {
            if (!type) return;
            const meta = typeDisplayContext.get(type) || {
                parts: identifierPartsFrom(type),
                fullName: type.name,
                fullKey: identifierKey(identifierPartsFrom(type), dialect),
                leafName: stripSchema(type.name),
                leafKey: identifierLeafKey(identifierPartsFrom(type), dialect),
                displayName: stripSchema(type.name),
            };
            const name = meta.displayName;
            const typeEntry = {
                displayName: name,
                meta,
                kind: type.kind,
            };
            typeResolver.add(typeEntry);

            if (type.kind === 'enum') {
                schema.enums.push({
                    name,
                    values: type.values || [],
                });
                enumTypes.add(name.toLowerCase());
            } else if (type.kind === 'composite') {
                schema.composites.push({
                    name,
                    fields: type.fields || [],
                });
            }
        });
    }

    // 2. Process tables
    if (effectiveTables.length > 0) {
        effectiveTables.forEach((table) => {
            if (!table || !table.name) return;
            const displayEntry = tableLifecycle.displayEntries.get(table);
            const meta = tableDisplayContext.get(displayEntry) || {
                parts: identifierPartsFrom(displayEntry || table),
                fullName: displayEntry?.name || table.name,
                fullKey: identifierKey(identifierPartsFrom(displayEntry || table), dialect),
                leafName: stripSchema(displayEntry?.name || table.name),
                leafKey: identifierLeafKey(identifierPartsFrom(displayEntry || table), dialect),
                displayName: stripSchema(displayEntry?.name || table.name),
            };
            const erdTable = {
                name: meta.displayName,
                columns: [],
            };
            attachHiddenIdentifierMeta(erdTable, {
                displayName: meta.displayName,
                fullName: meta.fullName,
                sourceName: meta.sourceFullName,
                schemaName: meta.namespaceName,
                hasExplicitSchema: meta.hasExplicitSchema,
                hasImplicitDefaultSchema: meta.hasImplicitDefaultSchema,
            });

            const tableEntry = {
                table: erdTable,
                displayName: meta.displayName,
                columns: erdTable.columns,
                foreignKeys: [],
                primaryColumns: [],
                primaryConstraintName: null,
                primaryConstraintNameParts: null,
                uniqueColumnGroups: [],
                uniqueConstraints: [],
                partialUniqueIndexes: [],
                plainIndexes: [],
                checkConstraints: [],
                defaultConstraints: [],
                period: null,
                dialect,
                defaultSchema,
                options: { ...(table.options || {}) },
                lifecycleStartIndex: table.position?.start?.idx ?? Number.NEGATIVE_INFINITY,
                meta,
            };
            const tableConstraintUniqueMembers = new Set(
                (table.constraints || [])
                    .filter((constraint) => constraint?.kind === 'unique' && constraint.columns?.length > 0)
                    .flatMap((constraint) => constraint.columns.map((column, index) => identifierKey(
                        columnPartsAt(constraint.columns, index) || [{ value: column, quoted: false }],
                        dialect,
                    ))),
            );

            if (table.columns && Array.isArray(table.columns)) {
                table.columns.filter(Boolean).forEach((col) => {
                    if (!col.name) return;
                    const erdColumn = convertColumnToErdFormat(col, enumTypes, typeResolver);
                    const lifecycleReference = referenceForTableLifecycle(col.references, tableLifecycle);
                    if (col.references && !lifecycleReference) delete erdColumn.fk;
                    erdTable.columns.push(erdColumn);
                    if (erdColumn.pk) tableEntry.primaryColumns.push(col.name);
                    const columnKey = identifierKey(columnIdentityParts(erdColumn), dialect);
                    if (erdColumn.constraints.includes('UQ') && !tableConstraintUniqueMembers.has(columnKey)) {
                        addUniqueColumnGroup(tableEntry, [col.name]);
                    }

                    if (lifecycleReference?.table) {
                        tableEntry.foreignKeys.push(addReferenceOptionsToForeignKey({
                            sourceColumns: [col.name],
                            sourceColumnParts: [col.nameParts || [{ value: col.name, quoted: false }]],
                            referencedTable: lifecycleReference.table,
                            referencedTableParts: lifecycleReference.tableParts,
                            referencedColumns: lifecycleReference.columns || [],
                            referencedColumnParts: lifecycleReference.columns?.identifierParts || [],
                            position: tokenToPosition(col._token),
                        }, lifecycleReference));
                    }
                });
            }

            // Process table-level constraints
            if (table.constraints && Array.isArray(table.constraints)) {
                table.constraints.filter(Boolean).forEach((constraint) => {
                    if (constraint.kind === 'foreign' && constraint.columns?.length && constraint.references?.table) {
                        const lifecycleReference = referenceForTableLifecycle(constraint.references, tableLifecycle);
                        if (!lifecycleReference) return;
                        const canonicalSourceColumns = constraint.columns.map((columnName, index) => (
                            findColumn(tableEntry, columnName, columnPartsAt(constraint.columns, index))?.name || columnName
                        ));
                        const foreignKey = addReferenceOptionsToForeignKey({
                            sourceColumns: canonicalSourceColumns,
                            sourceColumnParts: constraint.columns.identifierParts || [],
                            referencedTable: lifecycleReference.table,
                            referencedTableParts: lifecycleReference.tableParts,
                            referencedColumns: lifecycleReference.columns || [],
                            referencedColumnParts: lifecycleReference.columns?.identifierParts || [],
                            position: tokenToPosition(constraint._token),
                        }, lifecycleReference);
                        if (constraint.name) foreignKey.name = constraint.name;
                        if (constraint.nameParts) foreignKey.nameParts = constraint.nameParts;
                        tableEntry.foreignKeys.push(foreignKey);

                        constraint.columns.forEach((col, index) => {
                            const colObj = findColumn(tableEntry, col, columnPartsAt(constraint.columns, index));
                            if (colObj) colObj.fk = true;
                        });
                    } else if (constraint.kind === 'primary' && constraint.columns?.length) {
                        const isComposite = constraint.columns.length > 1;
                        tableEntry.primaryColumns = [];
                        tableEntry.primaryConstraintName = constraint.name || tableEntry.primaryConstraintName || null;
                        tableEntry.primaryConstraintNameParts = constraint.nameParts || tableEntry.primaryConstraintNameParts || null;
                        constraint.columns.forEach((colName, index) => {
                            const col = findColumn(tableEntry, colName, columnPartsAt(constraint.columns, index));
                            if (col) {
                                col.pk = true;
                                col.constraints = ['PK'];
                                if (isComposite) col.compositePk = true;
                                tableEntry.primaryColumns.push(col.name);
                            }
                        });
                    } else if (constraint.kind === 'unique' && constraint.columns?.length) {
                        const isComposite = constraint.columns.length > 1;
                        addUniqueColumnGroup(tableEntry, constraint.columns, constraint.name, {
                            columnParts: constraint.columns.identifierParts || [],
                            nameParts: constraint.nameParts || null,
                        });
                        constraint.columns.forEach((colName, index) => {
                            const col = findColumn(tableEntry, colName, columnPartsAt(constraint.columns, index));
                            if (col) {
                                if (!col.constraints.includes('UQ')) col.constraints.push('UQ');
                                if (isComposite) col.compositeUq = true;
                            }
                        });
                    } else if (constraint.kind === 'check') {
                        if (constraint.name || constraint.expression) {
                            tableEntry.checkConstraints.push({ name: constraint.name || null, nameParts: constraint.nameParts || null, expression: constraint.expression || null });
                        }
                        addCheckConstraintToColumns(erdTable.columns, constraint);
                    } else if (constraint.kind === 'default' && constraint.column) {
                        const col = erdTable.columns.find((candidate) => candidate.name.toLowerCase() === String(constraint.column).toLowerCase());
                        if (col && constraint.expression) {
                            const extra = `DEFAULT ${constraint.expression}`;
                            if (!col.extras.includes(extra)) col.extras.push(extra);
                            tableEntry.defaultConstraints.push({
                                name: constraint.name || null,
                                nameParts: constraint.nameParts || null,
                                column: col.name,
                                expression: constraint.expression,
                            });
                        }
                    } else if (constraint.kind === 'period' && constraint.columns?.length === 2) {
                        tableEntry.period = { columns: [...constraint.columns] };
                        constraint.columns.forEach((columnName, index) => {
                            const col = findColumn(tableEntry, columnName, columnPartsAt(constraint.columns, index));
                            if (!col) return;
                            const extra = `PERIOD FOR SYSTEM_TIME ${index === 0 ? 'START' : 'END'}`;
                            if (!col.extras.includes(extra)) col.extras.push(extra);
                        });
                    }
                });
            }

            schema.tables.push(erdTable);
            tableColumnsMap.set(meta.displayName, tableEntry);
            tableResolver.add(tableEntry);
            tableEntryByAst.set(table, tableEntry);
        });
    }

    // 3. Process migration operations in source order: ALTER TABLE changes
    //    and CREATE INDEX statements both affect the final table shape.
    const replayOperations = [];
    if (ast.alters && Array.isArray(ast.alters)) {
        ast.alters.filter(Boolean).forEach((alter, order) => {
            replayOperations.push({ kind: 'alter', value: alter, order, index: alter.position?.start?.idx ?? Number.MAX_SAFE_INTEGER });
        });
    }
    if (effectiveIndexes.length > 0) {
        effectiveIndexes.forEach((index, order) => {
            replayOperations.push({ kind: 'index', value: index, order: order + 1000000, index: index.position?.start?.idx ?? Number.MAX_SAFE_INTEGER });
        });
    }
    if (ast.drops && Array.isArray(ast.drops)) {
        ast.drops.filter((drop) => drop?.kind === 'index' && drop.name).forEach((drop, order) => {
            replayOperations.push({ kind: 'index_drop', value: drop, order: order + 2000000, index: drop.position?.start?.idx ?? Number.MAX_SAFE_INTEGER });
        });
    }
    replayOperations
        .sort((left, right) => left.index - right.index || left.order - right.order)
        .forEach((operation) => {
            if (operation.kind === 'alter') {
                if (operation.value?.action === 'rename_index_global') {
                    tableColumnsMap.forEach((tableEntry) => renameIndex(tableEntry, operation.value));
                    return;
                }
                const targetRecord = tableLifecycle.operationTargets.get(operation.value);
                const targetTableEntry = targetRecord ? tableEntryByAst.get(targetRecord.table) : null;
                if (targetRecord && !targetTableEntry) return;
                const lifecycleAlter = alterForTableLifecycle(operation.value, tableLifecycle);
                if (!lifecycleAlter) return;
                applyAlterOperation(lifecycleAlter, {
                    tableColumnsMap,
                    tableResolver,
                    enumTypes,
                    typeResolver,
                    targetTableEntry,
                });
            } else if (operation.kind === 'index') {
                const targetRecord = tableLifecycle.operationTargets.get(operation.value);
                const targetTableEntry = targetRecord ? tableEntryByAst.get(targetRecord.table) : null;
                if (targetRecord && !targetTableEntry) return;
                applyIndexes([operation.value], tableResolver, targetTableEntry);
            } else {
                applyIndexDrop(operation.value, tableColumnsMap, tableResolver);
            }
        });
    refreshTableDisplayNames(tableColumnsMap, tableResolver);

    // 3.5 Process CREATE [UNIQUE] INDEX statements + inline MySQL
    //     `KEY/INDEX/FULLTEXT/SPATIAL` entries (parser surfaces both as
    //     `ast.indexes`). Each global unique index promotes a column to UQ,
    //     filtered unique indexes show a PUQ badge without becoming FK targets,
    //     and non-unique indexes stamp an `IDX` badge. Composite indexes
    //     additionally set `compositeUq` / `compositePartialUq` / `compositeIdx` so the renderer
    //     knows to use the muted "composite" pill style.
    //     Replayed above in source order so migration scripts can create,
    //     rename, drop, and index columns in one pass.

    // 4. Generate relations from foreign keys
    generateRelations(schema, tableColumnsMap, tableResolver);

    return schema;
}

/**
 * Apply parsed indexes to their target columns. Mirrors the table-level
 * UNIQUE constraint logic so `CREATE UNIQUE INDEX x ON t(a)` produces the
 * same UQ badge as `UNIQUE (a)` would. Partial / filtered unique indexes
 * (for example `... WHERE deleted_at IS NULL`) get a visible `PUQ` badge
 * and predicate tooltip, but they are intentionally NOT added to
 * `uniqueColumnGroups` because they are not globally unique FK targets.
 *
 * Silently ignores indexes that target unknown tables / columns — those
 * usually mean the user is mid-typing or referring to a table defined in
 * another script. The schema validator handles surface-level diagnostics.
 */
function sameForeignKeyShape(fk, sourceColumns, references, dialect = 'auto') {
    if (!fk || !Array.isArray(fk.sourceColumns) || !Array.isArray(sourceColumns)) return false;
    if (!sameColumnSet(fk.sourceColumns, sourceColumns, dialect)) return false;
    if (identifierKey(identifierPartsFrom(fk.referencedTable, fk.referencedTableParts), dialect) !== identifierKey(identifierPartsFrom(references?.table, references?.tableParts), dialect)) return false;
    const leftCols = fk.referencedColumns || [];
    const rightCols = references?.columns || [];
    return sameColumnSet(leftCols, rightCols, dialect);
}

const FK_REFERENCE_OPTION_KEYS = ['onDelete', 'onUpdate', 'match', 'deferrable', 'initially'];

function copyReferenceOptions(reference) {
    const options = {};
    FK_REFERENCE_OPTION_KEYS.forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(reference || {}, key)) {
            options[key] = reference[key];
        }
    });
    return options;
}

function addReferenceOptionsToForeignKey(foreignKey, reference) {
    Object.assign(foreignKey, copyReferenceOptions(reference));
    return foreignKey;
}

function mergeReferenceOptionsIntoForeignKey(foreignKey, reference) {
    addReferenceOptionsToForeignKey(foreignKey, reference);
    return foreignKey;
}

function relationActionsFromForeignKey(fk) {
    return copyReferenceOptions(fk);
}

function shouldMaterializeAlterColumn(column) {
    return !!column;
}

function applyColumnPlacement(tableEntry, column, placement) {
    if (!tableEntry || !column || !placement || !Array.isArray(tableEntry.columns)) return;
    const currentIndex = tableEntry.columns.indexOf(column);
    if (currentIndex >= 0) tableEntry.columns.splice(currentIndex, 1);

    if (placement.first) {
        tableEntry.columns.unshift(column);
        return;
    }

    const afterName = placement.after ? String(placement.after).toLowerCase() : null;
    const afterIndex = afterName
        ? tableEntry.columns.findIndex((candidate) => String(candidate?.name || '').toLowerCase() === afterName)
        : -1;
    if (afterIndex >= 0) tableEntry.columns.splice(afterIndex + 1, 0, column);
    else tableEntry.columns.push(column);
}

function normalizeColumnGroupKey(columns, dialect = 'auto') {
    return Array.from(new Set((columns || []).map((column) => {
        const value = String(column || '');
        return dialect === 'postgres' ? value : value.toLowerCase();
    }))).sort().join('|');
}

function sameColumnSet(left, right, dialect = 'auto') {
    return normalizeColumnGroupKey(left, dialect) === normalizeColumnGroupKey(right, dialect);
}

function addColumnGroup(groups, columns, dialect = 'auto') {
    if (!Array.isArray(groups) || !Array.isArray(columns) || columns.length === 0) return;
    if (groups.some((group) => sameColumnSet(group, columns, dialect))) return;
    groups.push([...columns]);
}

function addUniqueColumnGroup(tableEntry, columns, name = null, options = {}) {
    if (!tableEntry || !Array.isArray(columns) || columns.length === 0) return;
    const canonicalColumns = columns
        .map((colName, index) => findColumn(tableEntry, colName, options.columnParts?.[index] || columnPartsAt(columns, index))?.name || colName)
        .filter(Boolean);
    addColumnGroup(tableEntry.uniqueColumnGroups, canonicalColumns, tableEntry.dialect);
    if (!Array.isArray(tableEntry.uniqueConstraints)) tableEntry.uniqueConstraints = [];
    const existing = tableEntry.uniqueConstraints.find((constraint) => {
        if (!sameColumnSet(constraint.columns, canonicalColumns, tableEntry.dialect)) return false;
        if (name) return metadataNamesEqual(constraint.name, constraint.nameParts, name, options.nameParts, tableEntry.dialect);
        return !constraint.name;
    });
    if (existing) {
        if (name && !existing.name) {
            existing.name = name;
            existing.nameParts = options.nameParts || null;
        }
        if (options.displayOnPrimary !== false) existing.displayOnPrimary = true;
        return;
    }
    tableEntry.uniqueConstraints.push({
        name: name || null,
        nameParts: options.nameParts || null,
        columns: [...canonicalColumns],
        displayOnPrimary: options.displayOnPrimary !== false,
    });
}

function removeConstraintBadge(column, badge) {
    if (!column || !Array.isArray(column.constraints)) return;
    column.constraints = column.constraints.filter((constraint) => constraint !== badge);
}

function addConstraintBadge(column, badge) {
    if (!column) return;
    if (!Array.isArray(column.constraints)) column.constraints = [];
    if (!column.constraints.includes(badge)) column.constraints.push(badge);
}

function indexWherePredicate(index) {
    const where = String(index?.where || '').trim();
    return where || null;
}

function partialUniqueIndexExtra(index) {
    const name = index?.name ? ` ${index.name}` : '';
    const where = indexWherePredicate(index);
    return `PARTIAL UNIQUE INDEX${name}${where ? ` WHERE ${where}` : ''}`;
}

function addPartialUniqueIndexMetadata(tableEntry, index) {
    if (!tableEntry || !Array.isArray(index?.columns) || index.columns.length === 0) return;
    if (!Array.isArray(tableEntry.partialUniqueIndexes)) tableEntry.partialUniqueIndexes = [];

    const normalizedName = index.name ? String(index.name) : null;
    const normalizedWhere = indexWherePredicate(index);
    const existing = tableEntry.partialUniqueIndexes.find((candidate) => {
        if (normalizedName) return metadataNamesEqual(candidate.name, candidate.nameParts, normalizedName, index.nameParts, tableEntry.dialect);
        return !candidate.name && sameColumnSet(candidate.columns, index.columns, tableEntry.dialect) && indexWherePredicate(candidate) === normalizedWhere;
    });

    const next = {
        name: index.name || null,
        nameParts: index.nameParts || null,
        columns: [...index.columns],
        where: normalizedWhere,
    };

    if (existing) {
        Object.assign(existing, next);
    } else {
        tableEntry.partialUniqueIndexes.push(next);
    }
}

function removePartialUniqueDecorations(tableEntry) {
    (tableEntry?.columns || []).forEach((column) => {
        removeConstraintBadge(column, 'PUQ');
        column.compositePartialUq = undefined;
        column.extras = (column.extras || []).filter((extra) => !String(extra || '').toUpperCase().startsWith('PARTIAL UNIQUE INDEX'));
    });
}

function syncPartialUniqueBadges(tableEntry) {
    if (!tableEntry) return;
    removePartialUniqueDecorations(tableEntry);

    (tableEntry.partialUniqueIndexes || []).forEach((index) => {
        const columns = Array.isArray(index.columns) ? index.columns : [];
        if (columns.length === 0) return;
        const isComposite = columns.length > 1;
        const extra = partialUniqueIndexExtra(index);

        columns.forEach((columnName) => {
            const column = findColumn(tableEntry, columnName);
            if (!column) return;
            if (!Array.isArray(column.extras)) column.extras = [];
            if (extra && !column.extras.includes(extra)) column.extras.push(extra);

            const hasGlobalKeyGuarantee = column.pk || (column.constraints || []).includes('UQ');
            if (hasGlobalKeyGuarantee) return;

            addConstraintBadge(column, 'PUQ');
            if (isComposite) column.compositePartialUq = true;
        });
    });
}

function columnPartsAt(columns, index) {
    return columns?.identifierParts?.[index] || null;
}

function columnIdentityParts(column) {
    return column?.nameParts?.length ? column.nameParts : [{ value: column?.name || '', quoted: false }];
}

function findColumn(tableEntry, columnName, requestedParts = null) {
    if (!tableEntry || !columnName) return null;
    if (requestedParts?.length) {
        const requestedKey = identifierKey(requestedParts, tableEntry.dialect);
        return (tableEntry.columns || []).find((column) => identifierKey(columnIdentityParts(column), tableEntry.dialect) === requestedKey) || null;
    }
    const exact = (tableEntry.columns || []).find((column) => column.name === String(columnName));
    if (exact || tableEntry.dialect === 'postgres') return exact || null;
    return (tableEntry.columns || []).find((column) => column.name.toLowerCase() === String(columnName).toLowerCase()) || null;
}

function columnNamesEqual(left, right, dialect = 'auto') {
    if (dialect === 'postgres') return String(left) === String(right);
    return String(left).toLowerCase() === String(right).toLowerCase();
}

function metadataNamesEqual(left, leftParts, right, rightParts, dialect = 'auto') {
    if (left == null || right == null) return false;
    if (dialect !== 'postgres') return String(left).toLowerCase() === String(right).toLowerCase();
    return identifierKey(identifierPartsFrom(String(left), leftParts), dialect)
        === identifierKey(identifierPartsFrom(String(right), rightParts), dialect);
}

function indexNamePartsForTable(name, parts, tableEntry) {
    const resolvedParts = identifierPartsFrom(String(name || ''), parts);
    if (tableEntry?.dialect !== 'postgres' || resolvedParts.length !== 1) return resolvedParts;

    // PostgreSQL creates an unqualified index in its table's schema. Keep
    // that implicit namespace in metadata so later `DROP INDEX app.ix` and
    // `ALTER INDEX app.ix` target the same object without conflating ix names
    // that belong to two different schemas.
    const tableParts = tableEntry?.meta?.sourceParts || tableEntry?.meta?.parts || [];
    const tableNamespace = identifierNamespaceParts(tableParts);
    if (tableNamespace.length > 0) return [...tableNamespace, ...resolvedParts];
    if (tableEntry?.defaultSchema) return [{ value: tableEntry.defaultSchema, quoted: false }, ...resolvedParts];
    return resolvedParts;
}

function removeColumnFromGroupList(groups, columnName, dialect = 'auto') {
    if (!Array.isArray(groups) || !columnName) return groups || [];
    return groups.filter((group) => !group.some((column) => columnNamesEqual(column, columnName, dialect)));
}

function addPlainIndexMetadata(tableEntry, index) {
    if (!tableEntry || !Array.isArray(index?.columns) || index.columns.length === 0) return;
    if (!Array.isArray(tableEntry.plainIndexes)) tableEntry.plainIndexes = [];
    const existing = index.name
        ? tableEntry.plainIndexes.find((candidate) => metadataNamesEqual(candidate.name, candidate.nameParts, index.name, index.nameParts, tableEntry.dialect))
        : tableEntry.plainIndexes.find((candidate) => !candidate.name && sameColumnSet(candidate.columns, index.columns, tableEntry.dialect));
    const next = { name: index.name || null, nameParts: index.nameParts || null, columns: [...index.columns] };
    if (existing) Object.assign(existing, next);
    else tableEntry.plainIndexes.push(next);
}

function syncPlainIndexBadges(tableEntry) {
    if (!tableEntry) return;
    (tableEntry.columns || []).forEach((column) => {
        removeConstraintBadge(column, 'IDX');
        column.compositeIdx = undefined;
    });
    (tableEntry.plainIndexes || []).forEach((index) => {
        const isComposite = index.columns.length > 1;
        index.columns.forEach((columnName) => {
            const column = findColumn(tableEntry, columnName);
            if (!column || column.pk || column.constraints.includes('UQ')) return;
            addConstraintBadge(column, 'IDX');
            if (isComposite) column.compositeIdx = true;
        });
    });
}

function syncKeyBadges(tableEntry) {
    if (!tableEntry) return;
    const columnKey = (value) => tableEntry.dialect === 'postgres' ? String(value) : String(value).toLowerCase();
    const primaryColumns = new Set((tableEntry.primaryColumns || []).map(columnKey));
    const compositePk = primaryColumns.size > 1;
    const uniqueGroups = tableEntry.uniqueColumnGroups || [];

    (tableEntry.columns || []).forEach((column) => {
        const originalConstraints = [...(column.constraints || [])];
        const originalUqIndex = originalConstraints.indexOf('UQ');
        const isPrimary = primaryColumns.has(columnKey(column.name));
        const uniqueGroup = uniqueGroups.find((group) => group.some((member) => columnKey(member) === columnKey(column.name)));
        const matchingUniqueConstraints = (tableEntry.uniqueConstraints || []).filter((constraint) => sameColumnSet(constraint.columns, uniqueGroup, tableEntry.dialect));
        const displayUniqueOnPrimary = matchingUniqueConstraints.some((constraint) => constraint.displayOnPrimary !== false);
        const shouldShowUnique = !!uniqueGroup && (!isPrimary || (displayUniqueOnPrimary && uniqueGroup.length > 1));

        removeConstraintBadge(column, 'PK');
        removeConstraintBadge(column, 'UQ');
        column.pk = isPrimary || undefined;
        column.compositePk = isPrimary && compositePk ? true : undefined;
        column.compositeUq = shouldShowUnique && uniqueGroup.length > 1 ? true : undefined;

        const restoreUniqueBadge = () => {
            if (originalUqIndex >= 0) {
                column.constraints.splice(Math.min(originalUqIndex, column.constraints.length), 0, 'UQ');
            } else {
                addConstraintBadge(column, 'UQ');
            }
        };

        if (isPrimary) {
            column.constraints = ['PK', ...(column.constraints || []).filter((constraint) => constraint !== 'NN')];
            if (shouldShowUnique) restoreUniqueBadge();
        } else if (shouldShowUnique) {
            restoreUniqueBadge();
        }
    });

    syncPartialUniqueBadges(tableEntry);
    syncPlainIndexBadges(tableEntry);
}

function applyPrimaryColumns(tableEntry, columns, name = null, nameParts = null) {
    if (!tableEntry || !Array.isArray(columns) || columns.length === 0) return;
    tableEntry.primaryColumns = [];
    tableEntry.primaryConstraintName = name || tableEntry.primaryConstraintName || null;
    tableEntry.primaryConstraintNameParts = nameParts || tableEntry.primaryConstraintNameParts || null;
    columns.forEach((colName, index) => {
        const col = findColumn(tableEntry, colName, columnPartsAt(columns, index));
        if (col) tableEntry.primaryColumns.push(col.name);
    });
    syncKeyBadges(tableEntry);
}

function applyUniqueColumns(tableEntry, columns, name = null, nameParts = null) {
    if (!tableEntry || !Array.isArray(columns) || columns.length === 0) return;
    addUniqueColumnGroup(tableEntry, columns, name, { columnParts: columns.identifierParts || [], nameParts });
    syncKeyBadges(tableEntry);
}

function applyColumnNotNull(tableEntry, columnName, notNull, columnParts = null) {
    const column = findColumn(tableEntry, columnName, columnParts);
    if (!column || column.pk) return;
    if (notNull) addConstraintBadge(column, 'NN');
    else removeConstraintBadge(column, 'NN');
}

function tableIdentityEntry(tableEntry) {
    const sourceParts = tableEntry?.meta?.sourceParts || tableEntry?.meta?.parts || identifierPartsFrom(tableEntry?.table?.name || tableEntry?.displayName || '');
    return {
        name: identifierFullName(sourceParts),
        nameParts: sourceParts,
    };
}

function syncTableObjectIdentity(tableEntry) {
    if (!tableEntry?.table || !tableEntry?.meta) return;
    tableEntry.table.name = tableEntry.meta.displayName;
    attachHiddenIdentifierMeta(tableEntry.table, {
        displayName: tableEntry.meta.displayName,
        fullName: tableEntry.meta.fullName,
        sourceName: tableEntry.meta.sourceFullName,
        schemaName: tableEntry.meta.namespaceName,
        hasExplicitSchema: tableEntry.meta.hasExplicitSchema,
        hasImplicitDefaultSchema: tableEntry.meta.hasImplicitDefaultSchema,
    });
}

function refreshTableDisplayNames(tableColumnsMap, tableResolver) {
    if (!tableColumnsMap || !tableResolver) return;
    const entries = Array.from(tableColumnsMap.values()).filter(Boolean);
    const identityEntries = entries.map(tableIdentityEntry);
    const dialect = entries[0]?.dialect || 'auto';
    const defaultSchema = entries[0]?.defaultSchema || null;
    const displayContext = buildIdentifierDisplayContext(identityEntries, { schemaAware: !!defaultSchema, defaultSchema: defaultSchema || DEFAULT_SCHEMA_NAME, dialect });

    tableColumnsMap.clear();
    tableResolver.clear();

    entries.forEach((entry, index) => {
        const meta = displayContext.get(identityEntries[index]);
        if (!meta) return;
        entry.meta = meta;
        entry.displayName = meta.displayName;
        syncTableObjectIdentity(entry);
        tableColumnsMap.set(meta.displayName, entry);
        tableResolver.add(entry);
    });
}

function tableRenameSourceParts(tableEntry, alter) {
    const newParts = identifierPartsFrom(alter.newName, alter.newTableParts);
    if (newParts.length !== 1) return newParts;

    const currentSourceParts = tableEntry?.meta?.sourceParts || tableEntry?.meta?.parts || [];
    const currentNamespaceParts = identifierNamespaceParts(currentSourceParts);
    return currentNamespaceParts.length > 0 ? [...currentNamespaceParts, ...newParts] : newParts;
}

function syncForeignKeyBadges(tableEntry) {
    if (!tableEntry) return;
    (tableEntry.columns || []).forEach((column) => {
        column.fk = undefined;
    });
    (tableEntry.foreignKeys || []).forEach((fk) => {
        (fk.sourceColumns || []).forEach((columnName) => {
            const column = findColumn(tableEntry, columnName);
            if (column) column.fk = true;
        });
    });
}

function recordForeignKey(tableEntry, sourceColumns, references, name, position, nameParts = null) {
    if (!tableEntry || !Array.isArray(sourceColumns) || sourceColumns.length === 0 || !references?.table) return;
    const sourceColumnParts = sourceColumns.identifierParts || [];
    const canonicalSourceColumns = sourceColumns.map((columnName, index) => findColumn(tableEntry, columnName, sourceColumnParts[index])?.name || columnName);
    const existing = tableEntry.foreignKeys.find((fk) => sameForeignKeyShape(fk, canonicalSourceColumns, references, tableEntry.dialect));
    if (!existing) {
        const foreignKey = addReferenceOptionsToForeignKey({
            sourceColumns: canonicalSourceColumns,
            sourceColumnParts,
            referencedTable: references.table,
            referencedTableParts: references.tableParts,
            referencedColumns: references.columns || [],
            referencedColumnParts: references.columns?.identifierParts || [],
            position,
        }, references);
        if (name) foreignKey.name = name;
        if (nameParts) foreignKey.nameParts = nameParts;
        tableEntry.foreignKeys.push(foreignKey);
    } else {
        if (!existing.name && name) existing.name = name;
        if (!existing.nameParts && nameParts) existing.nameParts = nameParts;
        mergeReferenceOptionsIntoForeignKey(existing, references);
    }
    syncForeignKeyBadges(tableEntry);
}

function applyDefaultConstraint(tableEntry, payload) {
    if (!tableEntry || !payload?.column || !payload.expression) return;
    const column = findColumn(tableEntry, payload.column, payload.columnParts);
    if (!column) return;
    const extra = `DEFAULT ${payload.expression}`;
    column.extras = (column.extras || []).filter((item) => !String(item || '').toUpperCase().startsWith('DEFAULT '));
    column.extras.push(extra);
    if (!Array.isArray(tableEntry.defaultConstraints)) tableEntry.defaultConstraints = [];
    tableEntry.defaultConstraints = tableEntry.defaultConstraints.filter((constraint) => {
        if (payload.name && metadataNamesEqual(constraint.name, constraint.nameParts, payload.name, payload.nameParts, tableEntry.dialect)) return false;
        return !columnNamesEqual(constraint.column, column.name, tableEntry.dialect);
    });
    tableEntry.defaultConstraints.push({
        name: payload.name || null,
        nameParts: payload.nameParts || null,
        column: column.name,
        expression: payload.expression,
    });
}

function applyAlterColumnDefault(tableEntry, alter) {
    if (!tableEntry || !alter?.column) return;
    const column = findColumn(tableEntry, alter.column, alter.columnParts);
    if (!column) return;
    column.extras = (column.extras || []).filter((item) => !String(item || '').toUpperCase().startsWith('DEFAULT '));
    tableEntry.defaultConstraints = (tableEntry.defaultConstraints || []).filter(
        (constraint) => !columnNamesEqual(constraint.column, column.name, tableEntry.dialect),
    );
    if (alter.expression) {
        column.extras.push(`DEFAULT ${alter.expression}`);
        tableEntry.defaultConstraints.push({ name: null, column: column.name, expression: alter.expression });
    }
}

function applyPeriodConstraint(tableEntry, columns) {
    if (!tableEntry || !Array.isArray(columns) || columns.length !== 2) return;
    const resolved = columns.map((columnName, index) => findColumn(tableEntry, columnName, columnPartsAt(columns, index))?.name || columnName);
    tableEntry.period = { columns: resolved };
    resolved.forEach((columnName, index) => {
        const column = findColumn(tableEntry, columnName);
        if (!column) return;
        const extra = `PERIOD FOR SYSTEM_TIME ${index === 0 ? 'START' : 'END'}`;
        if (!column.extras.includes(extra)) column.extras.push(extra);
    });
}

function applyAddedColumn(tableEntry, alter, enumTypes, typeResolver) {
    if (!alter?.column?.name || !shouldMaterializeAlterColumn(alter.column)) return;
    const existing = findColumn(tableEntry, alter.column.name);
    if (existing) return;
    const erdColumn = convertColumnToErdFormat(alter.column, enumTypes, typeResolver);
    tableEntry.columns.push(erdColumn);
    applyColumnPlacement(tableEntry, erdColumn, alter.column.placement);
    if (erdColumn.pk) applyPrimaryColumns(tableEntry, [...(tableEntry.primaryColumns || []), erdColumn.name]);
    if (erdColumn.constraints.includes('UQ')) applyUniqueColumns(tableEntry, [erdColumn.name]);
    if (alter.column.references?.table) {
        recordForeignKey(
            tableEntry,
            [erdColumn.name],
            alter.column.references,
            null,
            alterPositionToPos(alter.position),
        );
    }
    syncKeyBadges(tableEntry);
}

function renameColumnInList(columns, oldName, newName, dialect = 'auto') {
    return (columns || []).map((column) => (columnNamesEqual(column, oldName, dialect) ? newName : column));
}

function renameColumn(tableEntry, oldName, newName, context, oldNameParts = null, newNameParts = null) {
    const column = findColumn(tableEntry, oldName, oldNameParts);
    if (!column || !newName) return;
    const oldActualName = column.name;
    column.name = newName;
    attachHiddenIdentifierMeta(column, {
        nameParts: newNameParts?.length ? newNameParts : [{ value: newName, quoted: false }],
    });
    tableEntry.primaryColumns = renameColumnInList(tableEntry.primaryColumns, oldActualName, newName, tableEntry.dialect);
    tableEntry.uniqueColumnGroups = (tableEntry.uniqueColumnGroups || []).map((group) => renameColumnInList(group, oldActualName, newName, tableEntry.dialect));
    tableEntry.uniqueConstraints = (tableEntry.uniqueConstraints || []).map((constraint) => ({
        ...constraint,
        columns: renameColumnInList(constraint.columns, oldActualName, newName, tableEntry.dialect),
    }));
    tableEntry.partialUniqueIndexes = (tableEntry.partialUniqueIndexes || []).map((index) => ({
        ...index,
        columns: renameColumnInList(index.columns, oldActualName, newName, tableEntry.dialect),
    }));
    tableEntry.plainIndexes = (tableEntry.plainIndexes || []).map((index) => ({
        ...index,
        columns: renameColumnInList(index.columns, oldActualName, newName, tableEntry.dialect),
    }));
    (tableEntry.foreignKeys || []).forEach((fk) => {
        fk.sourceColumns = renameColumnInList(fk.sourceColumns, oldActualName, newName, tableEntry.dialect);
    });

    context.tableColumnsMap.forEach((entry) => {
        (entry.foreignKeys || []).forEach((fk) => {
            const targetEntry = context.tableResolver.resolve(fk.referencedTable, fk.referencedTableParts);
            if (targetEntry === tableEntry) {
                fk.referencedColumns = renameColumnInList(fk.referencedColumns, oldActualName, newName, tableEntry.dialect);
            }
        });
    });
    syncKeyBadges(tableEntry);
    syncForeignKeyBadges(tableEntry);
}

function dropColumn(tableEntry, columnName, context, columnParts = null) {
    const column = findColumn(tableEntry, columnName, columnParts);
    if (!column) return;
    const actualName = column.name;
    tableEntry.columns = tableEntry.columns.filter((candidate) => candidate !== column);
    if (tableEntry.table) tableEntry.table.columns = tableEntry.columns;

    if ((tableEntry.primaryColumns || []).some((member) => columnNamesEqual(member, actualName, tableEntry.dialect))) {
        tableEntry.primaryColumns = [];
        tableEntry.primaryConstraintName = null;
    }
    tableEntry.uniqueColumnGroups = removeColumnFromGroupList(tableEntry.uniqueColumnGroups, actualName, tableEntry.dialect);
    tableEntry.uniqueConstraints = (tableEntry.uniqueConstraints || []).filter((constraint) => !constraint.columns.some((member) => columnNamesEqual(member, actualName, tableEntry.dialect)));
    tableEntry.partialUniqueIndexes = (tableEntry.partialUniqueIndexes || []).filter((index) => !index.columns.some((member) => columnNamesEqual(member, actualName, tableEntry.dialect)));
    tableEntry.plainIndexes = (tableEntry.plainIndexes || []).filter((index) => !index.columns.some((member) => columnNamesEqual(member, actualName, tableEntry.dialect)));
    tableEntry.foreignKeys = (tableEntry.foreignKeys || []).filter((fk) => !(fk.sourceColumns || []).some((member) => columnNamesEqual(member, actualName, tableEntry.dialect)));

    context.tableColumnsMap.forEach((entry) => {
        entry.foreignKeys = (entry.foreignKeys || []).filter((fk) => {
            const targetEntry = context.tableResolver.resolve(fk.referencedTable, fk.referencedTableParts);
            if (targetEntry !== tableEntry) return true;
            return !(fk.referencedColumns || []).some((member) => columnNamesEqual(member, actualName, tableEntry.dialect));
        });
        syncForeignKeyBadges(entry);
    });
    syncKeyBadges(tableEntry);
}

function dropConstraint(tableEntry, alter) {
    if (!tableEntry) return;
    const rawName = alter.name ? String(alter.name) : null;
    const name = rawName?.toLowerCase() || null;
    const kind = alter.constraintKind || 'constraint';
    const requestedNameParts = kind === 'index'
        ? indexNamePartsForTable(rawName, alter.nameParts, tableEntry)
        : alter.nameParts;
    const matchesName = (candidate, candidateParts = null) => !rawName || metadataNamesEqual(
        candidate,
        candidateParts,
        rawName,
        requestedNameParts,
        tableEntry.dialect,
    );

    if (kind === 'foreign' || kind === 'constraint') {
        tableEntry.foreignKeys = (tableEntry.foreignKeys || []).filter((fk) => !matchesName(fk.name, fk.nameParts));
        syncForeignKeyBadges(tableEntry);
    }

    const dropsPrimary = kind === 'primary' || (rawName && matchesName(tableEntry.primaryConstraintName, tableEntry.primaryConstraintNameParts)) || name === 'primary';
    if (dropsPrimary) {
        tableEntry.primaryColumns = [];
        tableEntry.primaryConstraintName = null;
        syncKeyBadges(tableEntry);
    }

    if (kind === 'index' || kind === 'constraint') {
        const before = tableEntry.uniqueConstraints || [];
        const remaining = before.filter((constraint) => !matchesName(constraint.name, constraint.nameParts));
        if (remaining.length !== before.length) {
            tableEntry.uniqueConstraints = remaining;
            tableEntry.uniqueColumnGroups = remaining.map((constraint) => [...constraint.columns]);
            syncKeyBadges(tableEntry);
        }

        const beforePartial = tableEntry.partialUniqueIndexes || [];
        const remainingPartial = beforePartial.filter((index) => !matchesName(index.name, index.nameParts));
        if (remainingPartial.length !== beforePartial.length) {
            tableEntry.partialUniqueIndexes = remainingPartial;
            syncPartialUniqueBadges(tableEntry);
        }

        const beforePlain = tableEntry.plainIndexes || [];
        const remainingPlain = beforePlain.filter((index) => !matchesName(index.name, index.nameParts));
        if (remainingPlain.length !== beforePlain.length) {
            tableEntry.plainIndexes = remainingPlain;
            syncPlainIndexBadges(tableEntry);
        }
    }

    if (kind === 'constraint' && rawName) {
        (tableEntry.columns || []).forEach((column) => {
            column.extras = (column.extras || []).filter((extra) => !String(extra).toLowerCase().startsWith(`${name}: check`));
        });
        tableEntry.checkConstraints = (tableEntry.checkConstraints || []).filter((constraint) => !matchesName(constraint.name, constraint.nameParts));

        const droppedDefaults = (tableEntry.defaultConstraints || []).filter((constraint) => matchesName(constraint.name, constraint.nameParts));
        tableEntry.defaultConstraints = (tableEntry.defaultConstraints || []).filter((constraint) => !matchesName(constraint.name, constraint.nameParts));
        droppedDefaults.forEach((constraint) => {
            const column = findColumn(tableEntry, constraint.column);
            if (column) column.extras = (column.extras || []).filter((extra) => !String(extra || '').toUpperCase().startsWith('DEFAULT '));
        });
    }
}

function renameNamedMetadata(items, oldName, newName, dialect, oldNameParts = null, newNameParts = null) {
    (items || []).forEach((item) => {
        if (metadataNamesEqual(item?.name, item?.nameParts, oldName, oldNameParts, dialect)) {
            item.name = newName;
            item.nameParts = newNameParts || null;
        }
    });
}

function renameIndex(tableEntry, alter) {
    if (!tableEntry || !alter?.oldName || !alter.newName) return;
    const oldNameParts = indexNamePartsForTable(alter.oldName, alter.oldNameParts, tableEntry);
    const newNameParts = indexNamePartsForTable(alter.newName, alter.newNameParts, tableEntry);
    renameNamedMetadata(tableEntry.uniqueConstraints, alter.oldName, alter.newName, tableEntry.dialect, oldNameParts, newNameParts);
    renameNamedMetadata(tableEntry.partialUniqueIndexes, alter.oldName, alter.newName, tableEntry.dialect, oldNameParts, newNameParts);
    renameNamedMetadata(tableEntry.plainIndexes, alter.oldName, alter.newName, tableEntry.dialect, oldNameParts, newNameParts);
    syncKeyBadges(tableEntry);
}

function renameConstraint(tableEntry, alter) {
    if (!tableEntry || !alter?.oldName || !alter.newName) return;
    if (metadataNamesEqual(tableEntry.primaryConstraintName, tableEntry.primaryConstraintNameParts, alter.oldName, alter.oldNameParts, tableEntry.dialect)) {
        tableEntry.primaryConstraintName = alter.newName;
        tableEntry.primaryConstraintNameParts = alter.newNameParts || null;
    }
    renameNamedMetadata(tableEntry.foreignKeys, alter.oldName, alter.newName, tableEntry.dialect, alter.oldNameParts, alter.newNameParts);
    renameNamedMetadata(tableEntry.uniqueConstraints, alter.oldName, alter.newName, tableEntry.dialect, alter.oldNameParts, alter.newNameParts);
    renameNamedMetadata(tableEntry.checkConstraints, alter.oldName, alter.newName, tableEntry.dialect, alter.oldNameParts, alter.newNameParts);
    renameNamedMetadata(tableEntry.defaultConstraints, alter.oldName, alter.newName, tableEntry.dialect, alter.oldNameParts, alter.newNameParts);
    (tableEntry.columns || []).forEach((column) => {
        column.extras = (column.extras || []).map((extra) => {
            const prefix = `${alter.oldName}:`;
            return String(extra).slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
                ? `${alter.newName}:${String(extra).slice(prefix.length)}`
                : extra;
        });
    });
}

function renameTable(tableEntry, alter, context) {
    if (!tableEntry || !alter.newName) return;
    const newSourceParts = tableRenameSourceParts(tableEntry, alter);
    const newSourceName = identifierFullName(newSourceParts);

    context.tableColumnsMap.forEach((entry) => {
        (entry.foreignKeys || []).forEach((fk) => {
            const targetEntry = context.tableResolver.resolve(fk.referencedTable, fk.referencedTableParts);
            if (targetEntry === tableEntry) {
                fk.referencedTable = newSourceName;
                fk.referencedTableParts = newSourceParts;
            }
        });
    });

    tableEntry.meta = {
        ...(tableEntry.meta || {}),
        parts: newSourceParts,
        sourceParts: newSourceParts,
        sourceFullName: newSourceName,
        sourceFullKey: identifierKey(newSourceParts, tableEntry.dialect),
        fullName: newSourceName,
        fullKey: identifierKey(newSourceParts, tableEntry.dialect),
        leafName: identifierLeafName(newSourceParts),
        leafKey: identifierLeafKey(newSourceParts, tableEntry.dialect),
    };
    refreshTableDisplayNames(context.tableColumnsMap, context.tableResolver);
}

function applyColumnDefinitionChange(tableEntry, alter, enumTypes, typeResolver, context) {
    if (!alter?.column?.name) return;
    if (alter.oldName && !columnNamesEqual(alter.oldName, alter.column.name, tableEntry.dialect)) {
        renameColumn(tableEntry, alter.oldName, alter.column.name, context, alter.oldNameParts, alter.column.nameParts);
    }
    const column = findColumn(tableEntry, alter.column.name, alter.column.nameParts) || findColumn(tableEntry, alter.oldName, alter.oldNameParts);
    if (!column) {
        applyAddedColumn(tableEntry, { ...alter, action: 'add_column' }, enumTypes, typeResolver);
        return;
    }
    const erdColumn = convertColumnToErdFormat(alter.column, enumTypes, typeResolver);
    column.type = erdColumn.type;
    applyColumnNotNull(tableEntry, column.name, !!alter.column.notNull);
    if (alter.column.primary) applyPrimaryColumns(tableEntry, [...(tableEntry.primaryColumns || []), column.name]);
    if (alter.column.unique) applyUniqueColumns(tableEntry, [column.name]);
    if (erdColumn.autoIncrement) column.autoIncrement = true;
    else delete column.autoIncrement;
    replaceColumnDefinitionExtras(column, erdColumn.extras);
    if (alter.column.references?.table) {
        recordForeignKey(tableEntry, [column.name], alter.column.references, null, alterPositionToPos(alter.position));
    }
    applyColumnPlacement(tableEntry, column, alter.column.placement);
}

function replaceColumnDefinitionExtras(column, nextExtras) {
    const replacedPrefixes = ['DEFAULT ', 'GENERATED ', 'AUTO_INCREMENT'];
    column.extras = (column.extras || []).filter((extra) => {
        const normalized = String(extra || '').toUpperCase();
        return !replacedPrefixes.some((prefix) => normalized.startsWith(prefix));
    });
    (nextExtras || []).forEach((extra) => {
        if (!column.extras.includes(extra)) column.extras.push(extra);
    });
}

function applyAlterOperation(alter, context) {
    if (!alter?.table) return;
    const tableEntry = context.targetTableEntry || context.tableResolver.resolve(alter.table, alter.tableParts);
    if (!tableEntry) return;
    const operationIndex = alter.position?.start?.idx;
    if (Number.isFinite(operationIndex) && operationIndex < tableEntry.lifecycleStartIndex) return;

    if (alter.action === 'add_foreign' && alter.columns?.length && alter.references?.table) {
        recordForeignKey(tableEntry, alter.columns, alter.references, alter.name, alterPositionToPos(alter.position), alter.nameParts);
    } else if (alter.action === 'add_primary' && alter.columns?.length) {
        applyPrimaryColumns(tableEntry, alter.columns, alter.name || null, alter.nameParts || null);
    } else if (alter.action === 'add_unique' && alter.columns?.length) {
        applyUniqueColumns(tableEntry, alter.columns, alter.name || null, alter.nameParts || null);
    } else if (alter.action === 'add_check' && alter.expression) {
        tableEntry.checkConstraints.push({ name: alter.name || null, nameParts: alter.nameParts || null, expression: alter.expression });
        addCheckConstraintToColumns(tableEntry.columns, {
            name: alter.name || null,
            kind: 'check',
            expression: alter.expression,
        });
    } else if (alter.action === 'add_default') {
        applyDefaultConstraint(tableEntry, alter);
    } else if (alter.action === 'alter_column_default') {
        applyAlterColumnDefault(tableEntry, alter);
    } else if (alter.action === 'add_period') {
        applyPeriodConstraint(tableEntry, alter.columns);
    } else if (alter.action === 'add_column') {
        applyAddedColumn(tableEntry, alter, context.enumTypes, context.typeResolver);
    } else if (alter.action === 'rename_column') {
        renameColumn(tableEntry, alter.oldName, alter.newName, context, alter.oldNameParts, alter.newNameParts);
    } else if (alter.action === 'rename_table') {
        renameTable(tableEntry, alter, context);
    } else if (alter.action === 'rename_index') {
        renameIndex(tableEntry, alter);
    } else if (alter.action === 'rename_constraint') {
        renameConstraint(tableEntry, alter);
    } else if (alter.action === 'drop_column') {
        dropColumn(tableEntry, alter.column, context, alter.columnParts);
    } else if (alter.action === 'drop_constraint') {
        dropConstraint(tableEntry, alter);
    } else if (alter.action === 'alter_column_set_not_null') {
        applyColumnNotNull(tableEntry, alter.column, !!alter.notNull, alter.columnParts);
    } else if (alter.action === 'alter_column_type') {
        const column = findColumn(tableEntry, alter.column, alter.columnParts);
        if (column && alter.type) column.type = normalizeColumnType(alter.type, context.typeResolver) || alter.type;
        if (column && alter.notNull !== null && alter.notNull !== undefined) applyColumnNotNull(tableEntry, alter.column, !!alter.notNull, alter.columnParts);
    } else if (alter.action === 'modify_column') {
        applyColumnDefinitionChange(tableEntry, alter, context.enumTypes, context.typeResolver, context);
    } else if (alter.action === 'change_column') {
        applyColumnDefinitionChange(tableEntry, alter, context.enumTypes, context.typeResolver, context);
    }
}

function applyIndexes(indexes, tableResolver, targetTableEntry = null) {
    indexes.forEach((ix) => {
        if (!ix || !ix.table || !Array.isArray(ix.columns) || ix.columns.length === 0) return;
        const tableEntry = targetTableEntry || tableResolver.resolve(ix.table, ix.tableParts);
        if (!tableEntry) return;
        const operationIndex = ix.position?.start?.idx;
        if (Number.isFinite(operationIndex) && operationIndex < tableEntry.lifecycleStartIndex) return;
        const isComposite = ix.columns.length > 1;
        const isPartialUnique = ix.unique && !!indexWherePredicate(ix);
        const badge = isPartialUnique ? 'PUQ' : ix.unique ? 'UQ' : 'IDX';
        const validIndexColumns = [];
        const indexNameParts = indexNamePartsForTable(ix.name, ix.nameParts, tableEntry);

        ix.columns.forEach((colName, columnIndex) => {
            if (!colName) return;
            const col = findColumn(tableEntry, colName, columnPartsAt(ix.columns, columnIndex));
            if (!col) return;
            validIndexColumns.push(col.name);

            if (!Array.isArray(col.constraints)) col.constraints = [];

            if (badge === 'PUQ') {
                return;
            }

            // PK already implies UQ — don't double-badge.
            if (badge === 'UQ' && !col.pk && !col.constraints.includes('UQ')) {
                removeConstraintBadge(col, 'PUQ');
                col.compositePartialUq = undefined;
                col.constraints.push('UQ');
                if (isComposite) col.compositeUq = true;
            } else if (badge === 'IDX' && !col.constraints.includes('IDX')) {
                // Skip the IDX badge when the column is already PK/UQ —
                // those are stronger guarantees that already imply an index.
                const alreadyIndexed = col.pk || col.constraints.includes('UQ');
                if (!alreadyIndexed) {
                    col.constraints.push('IDX');
                    if (isComposite) col.compositeIdx = true;
                }
            }
        });

        if (isPartialUnique && validIndexColumns.length === ix.columns.length) {
            addPartialUniqueIndexMetadata(tableEntry, {
                name: ix.name || null,
                nameParts: indexNameParts,
                columns: validIndexColumns,
                where: indexWherePredicate(ix),
            });
            syncPartialUniqueBadges(tableEntry);
            return;
        }

        if (!ix.unique && validIndexColumns.length === ix.columns.length) {
            addPlainIndexMetadata(tableEntry, {
                name: ix.name || null,
                nameParts: indexNameParts,
                columns: validIndexColumns,
            });
            syncPlainIndexBadges(tableEntry);
            return;
        }

        if (ix.unique && validIndexColumns.length === ix.columns.length) {
            addUniqueColumnGroup(tableEntry, validIndexColumns, ix.name || null, {
                displayOnPrimary: false,
                nameParts: indexNameParts,
            });
            syncKeyBadges(tableEntry);
        }
    });
}

function applyIndexDrop(drop, tableColumnsMap, tableResolver) {
    if (!drop?.name) return;
    const candidates = drop.table
        ? [tableResolver.resolve(drop.table, drop.tableParts)].filter(Boolean)
        : Array.from(tableColumnsMap.values()).filter(Boolean);
    const operationIndex = drop.position?.start?.idx;

    candidates.forEach((tableEntry) => {
        if (Number.isFinite(operationIndex) && operationIndex < tableEntry.lifecycleStartIndex) return;
        dropConstraint(tableEntry, {
            name: drop.name,
            nameParts: drop.nameParts,
            constraintKind: 'index',
        });
    });
}

/** Normalize column type so qualified user-defined types (e.g. `public.mood`)
 *  match their renderer display name in `enumMap`/`compositeMap`. Anything
 *  that doesn't look like a simple identifier or identifier array is left
 *  untouched. */
function normalizeColumnType(rawType, typeResolver) {
    if (!rawType || !typeResolver) return rawType;
    const typeText = String(rawType).trim();
    const arrayMatch = typeText.match(/^(.+?)((?:\[\])+)\s*$/);
    const baseType = arrayMatch ? arrayMatch[1].trim() : typeText;
    const suffix = arrayMatch ? arrayMatch[2] : '';

    if (!/^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*$/.test(baseType)) return rawType;

    const resolved = typeResolver.resolve(baseType) || (baseType.includes('.') ? typeResolver.resolve(baseType, [{ value: baseType, quoted: true }]) : null);
    return resolved ? `${resolved.displayName}${suffix}` : rawType;
}

/**
 * Map one parseAST column object to the renderer-facing column shape.
 *
 * Translation table (parseAST → ERD column):
 *   col.primary    →   pk: true,   constraints += 'PK'
 *   col.unique     →   constraints += 'UQ'   (skipped if PK — implied)
 *   col.notNull    →   constraints += 'NN'   (skipped if PK — implied)
 *   col.references →   fk: true               (relation built later in stage 4)
 *   col.autoIncrement → autoIncrement: true,  extras += 'AUTO_INCREMENT'
 *   col.default    →   extras += `DEFAULT ${value}`
 *   col.check      →   extras += `CHECK (${expr})`
 *   col.generated  →   extras += <generated-column expression as-is>
 *
 * The renderer treats `constraints` as ordered badges (rendered next to the
 * column name) and `extras` as overflow tooltip text — keep them disjoint.
 */
function convertColumnToErdFormat(col, enumTypes, typeResolver) {
    const erdColumn = {
        name: col.name,
        type: normalizeColumnType(col.type, typeResolver) || 'text',
        constraints: [],
        extras: [],
    };
    attachHiddenIdentifierMeta(erdColumn, {
        nameParts: col?.nameParts?.length ? col.nameParts : [{ value: col.name, quoted: false }],
    });

    if (col.primary) {
        erdColumn.pk = true;
        erdColumn.constraints.push('PK');
    }

    if (col.unique && !col.primary) {
        erdColumn.constraints.push('UQ');
    }

    if (col.notNull && !col.primary) {
        erdColumn.constraints.push('NN');
    }

    if (col.references) {
        erdColumn.fk = true;
    }

    if (col.autoIncrement) {
        erdColumn.autoIncrement = true;
        erdColumn.extras.push('AUTO_INCREMENT');
    }

    if (col.default) {
        erdColumn.extras.push(`DEFAULT ${col.default}`);
    }

    if (col.check) {
        erdColumn.extras.push(`CHECK (${col.check})`);
    }

    if (col.generated) {
        erdColumn.extras.push(col.generated);
    }

    return erdColumn;
}

/**
 * Attach a table-level `CHECK (expr)` to every column whose name appears in
 * the expression. The renderer surfaces CHECK constraints as part of each
 * column's `extras` tooltip text rather than as a global badge.
 *
 * Implementation notes:
 *   • Column refs are extracted with a permissive `\b[a-zA-Z_]\w*\b` regex,
 *     which means SQL keywords inside the expression (`AND`, `OR`, `IN`,
 *     literals, function names) will also be matched but harmlessly miss
 *     because no table has a column with that name.
 *   • De-duplicates against existing `extras` so the same CHECK isn't
 *     attached twice when an inline CHECK and a named CONSTRAINT alias
 *     share an expression.
 */
function addCheckConstraintToColumns(columns, constraint) {
    if (!constraint || !constraint.expression) return;

    let checkText = `CHECK (${constraint.expression})`;
    if (constraint.name) {
        checkText = `${constraint.name}: ${checkText}`;
    }

    const columnRefs = constraint.expression.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g) || [];

    columnRefs.forEach((colRef) => {
        const col = columns.find((c) => c.name.toLowerCase() === colRef.toLowerCase());
        if (col) {
            const isDuplicate = col.extras.some((extra) => extra.includes('CHECK') && extra.includes(constraint.expression));
            if (!isDuplicate) {
                col.extras.push(checkText);
            }
        }
    });
}

/**
 * Walk the accumulated foreign-key list for every table and emit renderer-
 * compatible relation rows. Cardinality is inferred from the FK source column
 * set as follows (Crow's-Foot, reading child/FK -> parent/key):
 *
 *   fromCard = children per parent. SQL declares no mandatory parent-side
 *              participation, so the minimum is zero; a unique FK caps the
 *              maximum at one and a non-unique FK caps it at many.
 *   toCard   = parents per child. A fully required FK has exactly one parent;
 *              a nullable FK has zero or one parent.
 *
 *   PostgreSQL/MySQL/MSSQL PK columns are required. SQLite rowid-table PKs
 *   are only implicitly required for exact `INTEGER PRIMARY KEY`; STRICT and
 *   WITHOUT ROWID tables enforce required PK columns for every allowed type.
 *
 * De-duplicates relations that would be identical (same from→to pair). This
 * matters when an inline `REFERENCES` is later restated by an
 * `ALTER TABLE ADD CONSTRAINT FOREIGN KEY` — we want one arrow, not two.
 */
function generateRelations(schema, tableColumnsMap, tableResolver) {
    // FK badges describe relations that actually survive final-state
    // validation. Clear optimistic parse-time markers first so an unknown or
    // no-longer-unique target cannot leave a misleading FK pill behind.
    tableColumnsMap.forEach((tableEntry) => {
        (tableEntry.columns || []).forEach((column) => {
            column.fk = undefined;
        });
    });

    tableColumnsMap.forEach((tableEntry, tableName) => {
        const { foreignKeys } = tableEntry;
        if (!foreignKeys) return;
        foreignKeys.forEach((fk, fkIndex) => {
            if (!fk || !Array.isArray(fk.sourceColumns) || fk.sourceColumns.length === 0 || !fk.referencedTable) return;
            const targetEntry = tableResolver.resolve(fk.referencedTable, fk.referencedTableParts);
            if (!targetEntry) {
                schema._parseErrors?.push({
                    kind: 'relation_dropped_unknown_table',
                    severity: 'warning',
                    message: `Relation dropped: column '${tableName}.${fk.sourceColumns.join(', ')}' references table '${unresolvedIdentifierDisplayName(fk.referencedTable, fk.referencedTableParts)}' which is not defined in this script.`,
                    position: fk.position || DEFAULT_POSITION,
                });
                return;
            }
            let resolvedRefColumns = resolveReferencedColumns(schema, fk, targetEntry);
            if (resolvedRefColumns.length === 0) return;
            if (resolvedRefColumns.length !== fk.sourceColumns.length) {
                if (resolvedRefColumns.length === 1) {
                    resolvedRefColumns = fk.sourceColumns.map(() => resolvedRefColumns[0]);
                } else {
                    schema._parseErrors?.push({
                        kind: 'relation_dropped_column_count_mismatch',
                        severity: 'warning',
                        message: `Relation dropped: foreign key from '${tableName}(${fk.sourceColumns.join(', ')})' references '${(targetEntry?.displayName || fk.referencedTable)}(${resolvedRefColumns.join(', ')})' with a different column count.`,
                        position: fk.position || DEFAULT_POSITION,
                    });
                    return;
                }
            }

            if (targetEntry) {
                const missingTargetColumn = findMissingTargetColumn(targetEntry, resolvedRefColumns);
                if (missingTargetColumn) {
                    schema._parseErrors?.push({
                        kind: 'relation_dropped_unknown_column',
                        severity: 'warning',
                        message: `Relation dropped: foreign key from '${tableName}(${fk.sourceColumns.join(', ')})' references column '${targetEntry.displayName}.${missingTargetColumn}' which does not exist on table '${targetEntry.displayName}'.`,
                        position: fk.position || DEFAULT_POSITION,
                    });
                    return;
                }
                if (!isReferencedColumnSetKeyed(targetEntry, resolvedRefColumns)) {
                    schema._parseErrors?.push({
                        kind: 'relation_dropped_non_unique_target',
                        severity: 'warning',
                        message: `Relation dropped: foreign key from '${tableName}(${fk.sourceColumns.join(', ')})' references '${targetEntry.displayName}(${resolvedRefColumns.join(', ')})', but the referenced columns are not a primary key or unique key.`,
                        position: fk.position || DEFAULT_POSITION,
                    });
                    return;
                }
            }

            const targetTableName = targetEntry.displayName;
            if (!targetTableName) return;

            const relationGroup = `${tableName}:${fk.sourceColumns.join(',')}->${targetTableName}:${resolvedRefColumns.join(',')}:${fk.name || fkIndex}`;
            const composite = fk.sourceColumns.length > 1;
            const isUnique = isForeignKeySourceUnique(tableEntry, fk.sourceColumns);
            const isRequired = areForeignKeySourceColumnsRequired(tableEntry, fk.sourceColumns);
            const { fromCard, toCard } = relationCardinality(isUnique, isRequired);

            fk.sourceColumns.forEach((sourceColumn) => {
                const column = findColumn(tableEntry, sourceColumn);
                if (column) column.fk = true;
            });

            fk.sourceColumns.forEach((sourceColumn, idx) => {
                const referencedColumn = resolvedRefColumns[idx];
                if (!sourceColumn || !referencedColumn) return;

                const exists = schema.relations.some((r) => r.from.table === tableName && r.from.column === sourceColumn && r.to.table === targetTableName && r.to.column === referencedColumn);
                if (exists) return;

                const relation = {
                    from: { table: tableName, column: sourceColumn },
                    to: { table: targetTableName, column: referencedColumn },
                    fromCard,
                    toCard,
                };
                if (fk.name) relation.fkName = fk.name;
                const actions = relationActionsFromForeignKey(fk);
                if (Object.keys(actions).length > 0) relation.actions = actions;
                if (composite) {
                    relation.composite = true;
                    relation.relationGroup = relationGroup;
                    relation.fromColumns = [...fk.sourceColumns];
                    relation.toColumns = [...resolvedRefColumns];
                }
                // Carry the FK source position so the validator's drop-warnings
                // (and any future relation-level diagnostics) can anchor at the
                // exact byte / line the user wrote.
                if (fk.position) relation.position = fk.position;
                schema.relations.push(relation);
            });
        });
    });
}

function relationCardinality(isUnique, isRequired) {
    return {
        fromCard: isUnique ? '0..1' : '0..n',
        toCard: isRequired ? '1' : '0..1',
    };
}

function areForeignKeySourceColumnsRequired(tableEntry, sourceColumns) {
    const columns = tableEntry?.columns || [];
    return sourceColumns.every((sourceColumn) => {
        const col = columns.find((column) => column.name.toLowerCase() === sourceColumn.toLowerCase());
        if (!col) return false;
        if (col.constraints.includes('NN')) return true;
        if (!col.pk) return false;
        if (tableEntry.dialect !== 'sqlite') return true;
        if (tableEntry.options?.strict || tableEntry.options?.withoutRowid) return true;
        return String(col.type || '').trim().toUpperCase() === 'INTEGER';
    });
}

function isForeignKeySourceUnique(tableEntry, sourceColumns) {
    if (!Array.isArray(sourceColumns) || sourceColumns.length === 0) return false;
    const groups = [];
    if (Array.isArray(tableEntry.primaryColumns) && tableEntry.primaryColumns.length > 0) {
        groups.push(tableEntry.primaryColumns);
    }
    if (Array.isArray(tableEntry.uniqueColumnGroups)) {
        groups.push(...tableEntry.uniqueColumnGroups);
    }
    return groups.some((group) => sameColumnSet(group, sourceColumns, tableEntry.dialect));
}

function isReferencedColumnSetKeyed(targetEntry, referencedColumns) {
    if (!targetEntry || !Array.isArray(referencedColumns) || referencedColumns.length === 0) return false;
    const groups = [];
    if (Array.isArray(targetEntry.primaryColumns) && targetEntry.primaryColumns.length > 0) {
        groups.push(targetEntry.primaryColumns);
    }
    if (Array.isArray(targetEntry.uniqueColumnGroups)) {
        groups.push(...targetEntry.uniqueColumnGroups);
    }
    return groups.some((group) => sameColumnSet(group, referencedColumns, targetEntry.dialect));
}

function findMissingTargetColumn(targetEntry, referencedColumns) {
    if (!targetEntry || !Array.isArray(referencedColumns)) return null;
    return referencedColumns.find((column) => !findColumn(targetEntry, column)) || null;
}

function unresolvedIdentifierDisplayName(name, parts = null) {
    return identifierFullName(identifierPartsFrom(name, parts));
}

function resolveReferencedColumns(schema, fk, targetEntry) {
    if (!targetEntry) {
        return fk.referencedColumns?.length ? fk.referencedColumns : ['id'];
    }
    if (Array.isArray(fk.referencedColumns) && fk.referencedColumns.length > 0) {
        return fk.referencedColumns.map((columnName, index) => (
            findColumn(targetEntry, columnName, fk.referencedColumnParts?.[index] || null)?.name || columnName
        ));
    }
    if (Array.isArray(targetEntry.primaryColumns) && targetEntry.primaryColumns.length > 0) {
        return [...targetEntry.primaryColumns];
    }

    schema._parseErrors?.push({
        kind: 'relation_dropped_missing_target_columns',
        severity: 'warning',
        message: `Relation dropped: foreign key from '${fk.sourceColumns.join(', ')}' references table '${targetEntry.displayName}' without specifying columns, and that table has no primary key.`,
        position: fk.position || DEFAULT_POSITION,
    });
    return [];
}

/**
 * Final stage — prune relations that point at non-existent tables/columns
 * and normalise cardinality strings. Runs *in-place* on the schema.
 *
 * Drop policy (each emits a `warning` entry into `schema._parseErrors`):
 *   • `relation_dropped_unknown_table`   — source or target table missing.
 *   • `relation_dropped_unknown_column`  — source or target column missing.
 *
 * Lookups follow the selected dialect. PostgreSQL quoted identifiers retain
 * exact case identity; other dialects and neutral mode use case-insensitive
 * fallback so `Users` and `users` continue to interoperate.
 *
 * Cardinality normalisation: any value not in `validCards` is coerced to
 * `'0..n'` (from-side) / `'1'` (to-side) so the renderer never has to handle
 * unknown enum values.
 *
 * Why `_parseErrors` and not throw: the editor surfaces these in a list
 * the user can dismiss; throwing would blank the entire ERD on a single
 * dangling FK, which is hostile during live editing.
 */
function validateSchema(schema) {
    if (!schema || !schema.tables) return;

    if (!Array.isArray(schema._parseErrors)) schema._parseErrors = [];

    const dialect = schema.dialect || 'auto';
    const tableMap = new Map();
    const tableMapCI = new Map();
    schema.tables.forEach((table) => {
        if (!table || !table.columns) return;
        const colSet = new Set(table.columns.map((c) => c.name));
        const colSetCI = new Set(table.columns.map((c) => c.name.toLowerCase()));
        const meta = { original: table.name, columns: colSet, columnsCI: colSetCI };
        tableMap.set(table.name, meta);
        tableMapCI.set(table.name.toLowerCase(), meta);
    });

    const canonicalColumnName = (meta, columnName) => {
        if (meta.columns.has(columnName)) return columnName;
        if (dialect === 'postgres') return columnName;
        for (const existingName of meta.columns) {
            if (existingName.toLowerCase() === columnName.toLowerCase()) return existingName;
        }
        return columnName;
    };

    const resolveTableMeta = (tableName) => {
        const exact = tableMap.get(tableName);
        if (exact || dialect === 'postgres') return exact || null;
        return tableMapCI.get(String(tableName || '').toLowerCase()) || null;
    };

    const hasColumn = (meta, columnName) => (
        dialect === 'postgres'
            ? meta.columns.has(columnName)
            : meta.columnsCI.has(String(columnName || '').toLowerCase())
    );

    const invalidCompositeGroups = new Set();
    const markInvalidCompositeGroup = (rel) => {
        if (rel?.composite && rel.relationGroup) invalidCompositeGroups.add(rel.relationGroup);
    };

    schema.relations = (schema.relations || []).filter((rel) => {
        if (!rel || !rel.from || !rel.to) return false;
        const { from, to } = rel;
        // Use the relation's source position when available so the editor's
        // gutter marker jumps to the actual REFERENCES / FOREIGN KEY line
        // instead of the top of the file. Falls back to `DEFAULT_POSITION`
        // only when upstream couldn't attach a token (e.g. legacy AST shape).
        const pos = rel.position || DEFAULT_POSITION;

        const fromMeta = resolveTableMeta(from.table);
        const toMeta = resolveTableMeta(to.table);

        if (!fromMeta) {
            schema._parseErrors.push({
                kind: 'relation_dropped_unknown_table',
                severity: 'warning',
                message: `Relation dropped: source table '${from.table}' is not defined in this script.`,
                position: pos,
            });
            markInvalidCompositeGroup(rel);
            return false;
        }
        if (!toMeta) {
            schema._parseErrors.push({
                kind: 'relation_dropped_unknown_table',
                severity: 'warning',
                message: `Relation dropped: column '${from.table}.${from.column}' references table '${to.table}' which is not defined in this script.`,
                position: pos,
            });
            markInvalidCompositeGroup(rel);
            return false;
        }
        if (!hasColumn(fromMeta, from.column)) {
            schema._parseErrors.push({
                kind: 'relation_dropped_unknown_column',
                severity: 'warning',
                message: `Relation dropped: source column '${from.table}.${from.column}' does not exist on table '${from.table}'.`,
                position: pos,
            });
            markInvalidCompositeGroup(rel);
            return false;
        }
        if (!hasColumn(toMeta, to.column)) {
            schema._parseErrors.push({
                kind: 'relation_dropped_unknown_column',
                severity: 'warning',
                message: `Relation dropped: foreign key '${from.table}.${from.column}' references column '${to.table}.${to.column}' which does not exist on table '${to.table}'.`,
                position: pos,
            });
            markInvalidCompositeGroup(rel);
            return false;
        }

        from.table = fromMeta.original;
        to.table = toMeta.original;
        from.column = canonicalColumnName(fromMeta, from.column);
        to.column = canonicalColumnName(toMeta, to.column);
        if (Array.isArray(rel.fromColumns)) {
            rel.fromColumns = rel.fromColumns.map((column) => canonicalColumnName(fromMeta, column));
        }
        if (Array.isArray(rel.toColumns)) {
            rel.toColumns = rel.toColumns.map((column) => canonicalColumnName(toMeta, column));
        }

        return true;
    });

    if (invalidCompositeGroups.size > 0) {
        const warnedGroups = new Set();
        schema.relations = schema.relations.filter((rel) => {
            if (!rel?.composite || !rel.relationGroup || !invalidCompositeGroups.has(rel.relationGroup)) return true;
            if (!warnedGroups.has(rel.relationGroup)) {
                warnedGroups.add(rel.relationGroup);
                schema._parseErrors.push({
                    kind: 'relation_dropped_composite_group_partial',
                    severity: 'warning',
                    message: `Relation dropped: composite foreign key '${rel.from.table}(${(rel.fromColumns || [rel.from.column]).join(', ')})' has an invalid endpoint, so the whole relationship group was removed.`,
                    position: rel.position || DEFAULT_POSITION,
                });
            }
            return false;
        });
    }

    // Accept legacy renderer values while normalizing malformed generated
    // relations to the current SQL-to-ERD cardinality contract.
    const validCards = new Set(['1', 'n', '1+', '0..1', '0..n']);
    schema.relations.forEach((r) => {
        if (!r.fromCard || !validCards.has(r.fromCard)) r.fromCard = '0..n';
        if (!r.toCard || !validCards.has(r.toCard)) r.toCard = '1';
    });
}
