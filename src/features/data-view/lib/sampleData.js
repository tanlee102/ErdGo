/** Schema-aware fixture planning and generation. All SQL is staged until the complete result validates. */
import { createSqlExecutor } from './sqlExecutor';
import { createSampleRandom, samplePerson, sampleValue, sampleValueKey } from './sampleDataValues';
import { normalizeSampleValue } from './sampleDataTypes';

import { prepareSampleSchema, SAMPLE_DATA_LIMITS } from './sampleDataSchema';

// Preserve the public generation/inspection facade for existing callers.
export { inspectSampleSchema, SAMPLE_DATA_LIMITS } from './sampleDataSchema';

function quoteName(value, dialect) {
    if (dialect === 'mysql') return '`' + String(value).replace(/`/g, '``') + '`';
    if (dialect === 'mssql') return '[' + String(value).replace(/]/g, ']]') + ']';
    return '"' + String(value).replace(/"/g, '""') + '"';
}

function literal(value, dialect) {
    if (value == null) return 'NULL';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('Generated numbers must be finite.');
        return String(value);
    }
    if (typeof value === 'boolean') return dialect === 'postgres' ? String(value).toUpperCase() : value ? '1' : '0';
    let text = String(value);
    if (text.includes('\0')) throw new Error('Custom values cannot contain a zero byte.');
    if (dialect === 'mysql') text = text.replace(/\\/g, '\\\\');
    return (dialect === 'mssql' ? 'N' : '') + "'" + text.replace(/'/g, "''") + "'";
}

const findColumn = (table, name) => {
    const key = String(name).toLowerCase();
    return table.columns.find(column => column.name.toLowerCase() === key);
};
const findTable = (tables, name) => {
    const key = String(name).toLowerCase();
    for (const table of tables.values()) if (table.name.toLowerCase() === key) return table;
};
const requiredColumn = column => Boolean(column?.notNull || column?.pk);
const nullRule = (pattern, name) => pattern && Object.hasOwn(pattern, name) ? pattern[name] : undefined;

function insertSql(table, columns, tuples, dialect) {
    if (!columns.length) return tuples.map(() => dialect === 'mysql' ? `INSERT INTO ${table.sqlName} () VALUES ();` : `INSERT INTO ${table.sqlName} DEFAULT VALUES;`).join('\n');
    return `INSERT INTO ${table.sqlName} (${columns.map(column => quoteName(column.sqlColumnName || column.name, dialect)).join(', ')}) VALUES\n${tuples.map(tuple => `  (${tuple.join(', ')})`).join(',\n')};`;
}

function tableOrder(selected, runtimeTables) {
    const pending = [...selected]; const ordered = [];
    while (pending.length) {
        const readyIndex = allowNullable => pending.findIndex(item => (findTable(runtimeTables, item.name).foreignKeys || []).every(fk => {
            if (fk.refTable.toLowerCase() === item.name.toLowerCase()) return true;
            const parentPending = pending.find(parent => parent.name.toLowerCase() === fk.refTable.toLowerCase());
            if (!parentPending) return true;
            return allowNullable && fk.columns.some(name => !requiredColumn(findColumn(findTable(runtimeTables, item.name), name)));
        }));
        let index = readyIndex(false);
        if (index < 0) index = readyIndex(true);
        if (index < 0) {
            // Existing parent keys can satisfy a required cycle without inserting
            // or disabling constraints. Empty required cycles need an explicit design choice.
            const ready = pending.findIndex(item => (findTable(runtimeTables, item.name).foreignKeys || []).every(fk => findTable(runtimeTables, fk.refTable)?.rows.length));
            if (ready < 0) throw new Error(`Required foreign-key cycle between ${pending.map(table => table.label).join(', ')}. Add parent rows first or make a cycle-breaking reference nullable.`);
            ordered.push(...pending.splice(ready, 1));
        } else ordered.push(...pending.splice(index, 1));
    }
    return ordered;
}

function junctionKeyLayout(table, runtimeTables, uniqueNames) {
    const key = new Set((table.compositePk || []).map(name => name.toLowerCase()));
    if (key.size < 2) return null;
    const groups = (table.foreignKeys || []).map((fk, index) => ({ fk, index }))
        .filter(({ fk }) => fk.columns.every(name => key.has(name.toLowerCase())));
    const fields = groups.flatMap(({ fk }) => fk.columns.map(name => name.toLowerCase()));
    // Only independent FK groups that fully own the compound key form a
    // Cartesian domain. Overlapping, self and individually unique keys retain
    // the normal constraint-checked selection path.
    if (groups.length < 2 || fields.length !== key.size || new Set(fields).size !== key.size || fields.some(name => uniqueNames.has(findColumn(table, name)?.name))) return null;
    for (const group of groups) {
        const parent = findTable(runtimeTables, group.fk.refTable);
        if (!parent || parent.name === table.name) return null;
        const references = group.fk.refColumns?.length ? group.fk.refColumns : parent.compositePk?.length ? parent.compositePk : parent.columns.filter(column => column.pk).map(column => column.name);
        group.count = parent.rows.filter(row => references.every(name => row[findColumn(parent, name)?.name] != null)).length;
        if (!group.count) return null;
    }
    groups.sort((left, right) => right.count - left.count || left.index - right.index);
    let factor = 1;
    groups.forEach(group => { group.factor = factor; factor *= group.count; });
    return groups;
}

function junctionKeyPosition(layout, fkIndex, ordinal, requestedCount) {
    const group = layout?.find(item => item.index === fkIndex);
    if (!group) return null;
    const largest = layout[0].count;
    if (requestedCount < largest && ordinal < requestedCount) return Math.floor(ordinal * group.count / requestedCount);
    const base = ordinal % largest;
    if (group === layout[0]) return base;
    // Mixed-radix digits visit every independent key combination once. Rotate
    // each digit by the first key so early rows also cover all parent groups.
    return (Math.floor(base * group.count / largest) + Math.floor(ordinal / group.factor)) % group.count;
}

export function generateSampleData({ sql, dialect = 'auto', seed = 'erdgo', locale = 'en', nullPercent = 0, tables: settings }, onProgress = () => {}, prepared) {
    const context = prepared && !prepared.consumed && prepared.sql === sql && prepared.requestedDialect === dialect ? prepared : prepareSampleSchema(sql, dialect);
    context.consumed = true;
    const model = context.model;
    if (model.errors.length) throw new Error(model.errors[0]);
    const selected = model.tables.filter(table => settings?.[table.name]?.enabled);
    if (!selected.length) throw new Error('Select at least one table.');
    if (!Number.isFinite(Number(nullPercent)) || Number(nullPercent) < 0 || Number(nullPercent) > 100) throw new Error('Nullable values must be between 0% and 100%.');
    let total = 0; let cells = 0;
    for (const table of selected) {
        const count = Number(settings[table.name].count);
        if (!Number.isInteger(count) || count < 1 || count > SAMPLE_DATA_LIMITS.rowsPerTable) throw new Error(`${table.label}: choose 1–${SAMPLE_DATA_LIMITS.rowsPerTable} rows.`);
        total += count; cells += count * table.columns.length;
    }
    if (total > SAMPLE_DATA_LIMITS.totalRows || cells > SAMPLE_DATA_LIMITS.cells) throw new Error(`Use at most ${SAMPLE_DATA_LIMITS.totalRows.toLocaleString()} rows and ${SAMPLE_DATA_LIMITS.cells.toLocaleString()} cells per generation.`);
    let executor = context.executor;
    const ordered = tableOrder(selected, executor.tables);
    const random = createSampleRandom(seed);
    const statements = []; const previews = []; const notes = new Set();
    let completed = 0; let bytes = 0; let attempts = 0;
    const encoder = new TextEncoder();
    const prefix = `-- Sample data generated by Erd Go. Seed: ${String(seed).replace(/[\r\n\u2028\u2029]/g, ' ').slice(0, 100)}\n`;
    for (const table of ordered) {
        const config = settings[table.name];
        if (table.nullabilityPatterns?.length === 0) throw new Error(`${table.label}: its NULL CHECK constraints conflict with each other or with required columns.`);
        if (table.nullabilityPatterns) notes.add(`${table.label}: NULL and non-NULL values follow CHECK constraints; the optional NULL percentage applies to other fields.`);
        const runtime = findTable(executor.tables, table.name);
        const columns = table.columns.filter(column => !column.generatedExpr?.length && !column.autoIncrement && (config.columns?.[column.name]?.generator || column.suggested) !== 'default');
        const uniqueNames = new Set(table.columns.filter(column => column.unique || column.pk && !runtime.compositePk?.length).map(column => column.name));
        const junctionLayout = junctionKeyLayout(runtime, executor.tables, uniqueNames);
        const offsets = new Map(columns.map(column => [column.name, runtime.rows.reduce((max, row) => Math.max(max, typeof row[column.name] === 'number' ? row[column.name] : 0), 0)]));
        const usedValues = new Map(columns.map(column => [column.name, new Set(runtime.rows.map(row => sampleValueKey(row[column.name])).filter(value => value !== null))]));
        const spreads = new Map(columns.map(column => [column.name, random()]));
        const locationSpread = random();
        const fkSpreads = (runtime.foreignKeys || []).map(() => random());
        const parentCache = new Map();
        let candidateIndex = 0;
        let batch = []; const rows = [];
        const flush = () => { if (batch.length) { statements.push(insertSql(table, columns, batch, model.dialect)); batch = []; } };
        for (let rowIndex = 0; rowIndex < Number(config.count); rowIndex++) {
            let lastError = ''; let accepted = false;
            candidate: for (let retry = 0; retry < 50; retry++) {
                const pattern = table.nullabilityPatterns?.[(rowIndex + retry) % table.nullabilityPatterns.length];
                const requiredValue = pattern ? column => requiredColumn(column) || nullRule(pattern, column?.name) === false : requiredColumn;
                if (++attempts > 50000) throw new Error('Generation reached its validation limit. Reduce row counts or adjust constrained columns.');
                const person = samplePerson(random, locale, rowIndex + retry, locationSpread);
                const values = Object.create(null);
                const candidateOrdinal = candidateIndex++;
                for (const column of columns) {
                    const override = config.columns?.[column.name] || {};
                    const generator = override.generator && override.generator !== 'auto' ? override.generator : column.suggested;
                    if (pattern && nullRule(pattern, column.name) === true) { values[column.name] = null; continue; }
                    if (/\[\]|BLOB|BINARY|BYTEA|GEOMETRY|GEOGRAPHY|XML|INTERVAL/i.test(column.type) || column.isComposite) {
                        if (!requiredValue(column)) { values[column.name] = null; notes.add(`${table.label}.${column.name}: unsupported complex type generated as NULL.`); continue; }
                        lastError = `${table.label}.${column.name}: complex type ${column.type} needs a database default or a nullable column.`;
                        if (table.nullabilityPatterns?.length > 1) continue candidate;
                        throw new Error(lastError);
                    }
                    const nullable = !requiredValue(column) && random() * 100 < Number(nullPercent);
                    const ordinal = candidateOrdinal + (generator === 'sequence' ? offsets.get(column.name) || 0 : 0);
                    try {
                        values[column.name] = nullable ? null : sampleValue({ column, config: { ...override, generator }, ordinal, random, person, unique: uniqueNames.has(column.name), hints: column.hints, used: usedValues.get(column.name), spread: spreads.get(column.name) });
                    } catch (error) { throw new Error(`${table.label}, row ${rowIndex + 1}: ${error.message}`); }
                }
                // Copy whole FK tuples from one parent row. Overlapping FK groups
                // must agree; a retry chooses a different tuple rather than breaking a link.
                let conflict = false;
                const assigned = new Map();
                for (const [fkIndex, fk] of (findTable(executor.tables, table.name).foreignKeys || []).entries()) {
                    const parent = findTable(executor.tables, fk.refTable);
                    const refColumns = fk.refColumns?.length ? fk.refColumns : parent?.compositePk?.length ? parent.compositePk : parent?.columns.filter(column => column.pk).map(column => column.name) || [];
                    if (!parent || fk.columns.length !== refColumns.length) throw new Error(`${table.label}: cannot resolve the complete foreign key to ${fk.refTable}.`);
                    let cached = parentCache.get(fkIndex);
                    // A completed parent table stays unchanged while its child is
                    // generated. Refresh self references as they grow, and refresh
                    // rebuilt executor tables after any failed candidate INSERT.
                    if (!cached || cached.parent !== parent || cached.count !== parent.rows.length) {
                        const referenceNames = refColumns.map(name => findColumn(parent, name)?.name);
                        const childNames = fk.columns.map(name => findColumn(runtime, name)?.name);
                        cached = { parent, count: parent.rows.length, referenceNames, uniqueFields: childNames.map((name, index) => uniqueNames.has(name) ? [name, referenceNames[index]] : null).filter(Boolean), rows: parent.rows.filter(row => referenceNames.every(name => row[name] != null)) };
                        parentCache.set(fkIndex, cached);
                    }
                    const parents = cached.uniqueFields.length ? cached.rows.filter(row => cached.uniqueFields.every(([name, reference]) => !usedValues.get(name)?.has(sampleValueKey(row[reference])))) : cached.rows;
                    const self = parent.name === table.name && refColumns.every(name => values[findColumn(parent, name)?.name] != null);
                    const junctionPosition = junctionKeyPosition(junctionLayout, fkIndex, candidateOrdinal, Number(config.count));
                    const position = junctionPosition ?? (Number(config.count) >= parents.length ? rowIndex : Math.floor(rowIndex * parents.length / Number(config.count)));
                    const forcedNullReference = pattern && fk.columns.some(name => nullRule(pattern, findColumn(runtime, name)?.name) === true);
                    const nullableReference = forcedNullReference || fk.columns.some(name => !requiredValue(findColumn(runtime, name))) && random() * 100 < Number(nullPercent);
                    const parentRow = nullableReference ? null : parents.length ? parents[(Math.floor(fkSpreads[fkIndex] * parents.length) + position + (junctionPosition === null ? retry : 0)) % parents.length] : self ? values : null;
                    if (!parentRow && !fk.columns.some(name => !requiredValue(findColumn(runtime, name)))) {
                        lastError = `${table.label}: generate rows for ${fk.refTable} too, or add parent rows first.`;
                        // A different CHECK branch may use an available parent.
                        if (table.nullabilityPatterns?.length > 1) continue candidate;
                        throw new Error(lastError);
                    }
                    if (!parentRow && !parents.length && !self) notes.add(`${table.label}: nullable references to empty ${fk.refTable} generated as NULL.`);
                    fk.columns.forEach((name, index) => {
                        const column = findColumn(runtime, name);
                        const value = parentRow ? parentRow[findColumn(parent, refColumns[index])?.name] : requiredValue(column) ? values[column.name] : null;
                        if (assigned.has(column.name) && assigned.get(column.name) !== value) conflict = true;
                        assigned.set(column.name, value); values[column.name] = value;
                    });
                }
                if (conflict) { lastError = 'Overlapping foreign keys have no matching tuple.'; continue; }
                const tuple = columns.map(column => literal(normalizeSampleValue(values[column.name], column, model.dialect), model.dialect));
                const statement = insertSql(table, columns, [tuple], model.dialect);
                const currentTable = findTable(executor.tables, table.name);
                const beforeRows = currentTable.rows.length; const beforeLog = executor.executionLog.length;
                const result = executor.execute(statement);
                const diagnostics = result.log.slice(beforeLog).filter(entry => entry.type !== 'success');
                if (findTable(executor.tables, table.name).rows.length === beforeRows + 1 && !diagnostics.length) {
                    bytes += encoder.encode(statement).byteLength;
                    if (bytes > SAMPLE_DATA_LIMITS.bytes) throw new Error('Generated SQL is too large. Reduce row counts or text lengths (5 MB limit).');
                    batch.push(tuple);
                    for (const column of columns) {
                        const key = sampleValueKey(findTable(executor.tables, table.name).rows.at(-1)[column.name]);
                        if (key !== null) usedValues.get(column.name).add(key);
                    }
                    if (rows.length < 5) rows.push({ ...findTable(executor.tables, table.name).rows.at(-1) });
                    if (batch.length >= 100) flush();
                    accepted = true; completed++;
                    if (completed % Math.max(25, Math.ceil(total / 100)) === 0 || completed === total) onProgress({ completed, total, table: table.label });
                    break;
                }
                lastError = diagnostics[0]?.message || 'The row could not be validated.';
                // Failed INSERTs can advance native identity counters. Rebuild only
                // from accepted SQL so emitted defaults and child references replay identically.
                executor = createSqlExecutor({ dialect: model.dialect, cacheInsertConstraints: true });
                executor.execute(sql + '\n' + statements.join('\n') + '\n' + (batch.length ? insertSql(table, columns, batch, model.dialect) : ''));
            }
            if (!accepted) throw new Error(`${table.label}, row ${rowIndex + 1}: ${lastError} Adjust the generator, allowed values, range, or row count.`);
        }
        flush();
        previews.push({ name: table.label, count: Number(config.count), columns: table.columns.map(column => column.name), rows });
    }
    const generatedSql = prefix + statements.join('\n\n') + '\n';
    // Per-row accounting bounds work early; the complete artifact also includes
    // the UTF-8 seed comment and separators between serialized batches.
    if (encoder.encode(generatedSql).byteLength > SAMPLE_DATA_LIMITS.bytes) throw new Error('Generated SQL is too large. Reduce row counts or text lengths (5 MB limit).');
    // Replay the exact artifact, including original DML and batched INSERTs.
    // No preview or partial output can be committed when replay disagrees.
    const validation = createSqlExecutor({ dialect: model.dialect }).execute(sql + '\n' + generatedSql);
    const failure = validation.log.find(entry => entry.type === 'error');
    if (failure) throw new Error(`Generated SQL did not pass complete replay: ${failure.message}`);
    for (const table of selected) {
        const actual = findTable(validation.tables, table.name)?.rows.length;
        if (actual !== table.existingRows + Number(settings[table.name].count)) throw new Error(`${table.label}: generated row count changed during replay. Use stable defaults and review the existing SQL.`);
        const preview = previews.find(item => item.name === table.label);
        preview.rows = findTable(validation.tables, table.name).rows.slice(table.existingRows, table.existingRows + 5).map(row => ({ ...row }));
    }
    return { sql: generatedSql, previews, totalRows: total, notes: [...notes], dialect: model.dialect };
}
