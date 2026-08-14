/**
 * Build a stable identifier for a suggested relationship.
 *
 * Table names are deliberately kept intact so schemas with duplicate leaf
 * names (for example `auth.users` and `billing.users`) never share a decision
 * id. The renderer-facing table names are already canonicalized by the SQL to
 * ERD adapter, so no additional identifier rewriting belongs here.
 */
export function buildInferredRelationId(from, to) {
    const fromTable = String(from?.table || '').trim();
    const fromColumn = String(from?.column || '').trim();
    const toTable = String(to?.table || '').trim();
    const toColumn = String(to?.column || '').trim();
    return `inferred:${fromTable}.${fromColumn}->${toTable}.${toColumn}`;
}

const IRREGULAR_SINGULARS = new Map([
    ['children', 'child'],
    ['people', 'person'],
    ['men', 'man'],
    ['women', 'woman'],
]);

function compareText(left, right) {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function endpointKey(table, column) {
    return `${String(table || '').trim().toLowerCase()}\u001f${String(column || '').trim().toLowerCase()}`;
}

function lastUnquotedDot(value) {
    const text = String(value || '');
    let state = null;
    let lastDot = -1;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];

        if (state === 'double') {
            if (char === '"' && next === '"') index += 1;
            else if (char === '"') state = null;
            continue;
        }
        if (state === 'backtick') {
            if (char === '`' && next === '`') index += 1;
            else if (char === '`') state = null;
            continue;
        }
        if (state === 'bracket') {
            if (char === ']' && next === ']') index += 1;
            else if (char === ']') state = null;
            continue;
        }

        if (char === '"') state = 'double';
        else if (char === '`') state = 'backtick';
        else if (char === '[') state = 'bracket';
        else if (char === '.') lastDot = index;
    }

    return lastDot;
}

function identifierLeaf(value) {
    const text = String(value || '').trim();
    const dot = lastUnquotedDot(text);
    return dot >= 0 ? text.slice(dot + 1) : text;
}

function identifierNamespace(value) {
    const text = String(value || '').trim();
    const dot = lastUnquotedDot(text);
    return dot >= 0 ? text.slice(0, dot).toLowerCase() : '';
}

function stripIdentifierQuotes(value) {
    const text = String(value || '').trim();
    if (text.length < 2) return text;
    if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replace(/""/g, '"');
    if (text.startsWith('`') && text.endsWith('`')) return text.slice(1, -1).replace(/``/g, '`');
    if (text.startsWith('[') && text.endsWith(']')) return text.slice(1, -1).replace(/]]/g, ']');
    return text;
}

function identifierWords(value) {
    const text = stripIdentifierQuotes(value)
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[^A-Za-z0-9]+/g, ' ')
        .trim()
        .toLowerCase();
    return text ? text.split(/\s+/).filter(Boolean) : [];
}

function singularizeWord(value) {
    const word = String(value || '').toLowerCase();
    if (IRREGULAR_SINGULARS.has(word)) return IRREGULAR_SINGULARS.get(word);
    if (word.length > 3 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
    if (word.length > 4 && /(ches|shes|sses|xes|zes)$/.test(word)) return word.slice(0, -2);
    if (word.length > 3 && word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
    return word;
}

function singularTableWords(tableName) {
    const words = identifierWords(identifierLeaf(tableName));
    if (words.length === 0) return [];
    return [...words.slice(0, -1), singularizeWord(words[words.length - 1])];
}

function wordsEqual(left, right) {
    return left.length === right.length && left.every((word, index) => word === right[index]);
}

function wordsEndWith(words, suffix) {
    if (suffix.length === 0 || words.length <= suffix.length) return false;
    const offset = words.length - suffix.length;
    return suffix.every((word, index) => words[offset + index] === word);
}

function wordsStartWith(words, prefix) {
    return prefix.length <= words.length && prefix.every((word, index) => words[index] === word);
}

function getNameSignal(sourceColumnName, targetTableName, targetColumnName) {
    const sourceWords = identifierWords(sourceColumnName);
    const targetColumnWords = identifierWords(targetColumnName);
    const rawTableWords = identifierWords(identifierLeaf(targetTableName));
    const tableWords = singularTableWords(targetTableName);
    if (sourceWords.length < 2 || targetColumnWords.length === 0 || tableWords.length === 0) return null;

    const singularPattern = [...tableWords, ...targetColumnWords];
    const pluralPattern = [...rawTableWords, ...targetColumnWords];
    const targetColumnAlreadyQualified = wordsStartWith(targetColumnWords, tableWords);

    if (wordsEqual(sourceWords, singularPattern) || (targetColumnAlreadyQualified && wordsEqual(sourceWords, targetColumnWords))) {
        return {
            score: 62,
            reason: `Column name matches ${identifierLeaf(targetTableName)}.${targetColumnName}`,
        };
    }

    if (!wordsEqual(rawTableWords, tableWords) && wordsEqual(sourceWords, pluralPattern)) {
        return {
            score: 55,
            reason: `Column name matches the plural table name and key ${identifierLeaf(targetTableName)}.${targetColumnName}`,
        };
    }

    if (wordsEndWith(sourceWords, singularPattern)) {
        return {
            score: 45,
            reason: `Column name ends with the table and key name ${identifierLeaf(targetTableName)}.${targetColumnName}`,
        };
    }

    return null;
}

function normalizedType(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/\s*([(),\[\]])\s*/g, '$1');
}

function canonicalType(value) {
    let type = normalizedType(value);
    if (!type) return '';

    type = type
        .replace(/^character varying\b/, 'varchar')
        .replace(/^national character varying\b/, 'nvarchar')
        .replace(/^double precision\b/, 'double')
        .replace(/^timestamp without time zone\b/, 'timestamp')
        .replace(/^timestamp with time zone\b/, 'timestamptz');

    const aliases = [
        [/^(smallserial|int2|smallint)\b/, 'smallint'],
        [/^(bigserial|int8|bigint)\b/, 'bigint'],
        [/^(serial|int4|integer|int)\b/, 'integer'],
        [/^(decimal|numeric)\b/, 'numeric'],
        [/^(boolean|bool)\b/, 'boolean'],
    ];
    for (const [pattern, replacement] of aliases) {
        if (pattern.test(type)) return type.replace(pattern, replacement);
    }
    return type;
}

function getTypeSignal(sourceType, targetType) {
    const source = normalizedType(sourceType);
    const target = normalizedType(targetType);
    if (!source || !target) return null;
    if (source === target) {
        return {
            score: 20,
            reason: `Column types match exactly (${sourceType})`,
        };
    }
    if (canonicalType(source) === canonicalType(target)) {
        return {
            score: 15,
            reason: `Column types are compatible (${sourceType} and ${targetType})`,
        };
    }
    return null;
}

function constraintsFor(column) {
    return new Set((Array.isArray(column?.constraints) ? column.constraints : []).map((constraint) => String(constraint).toUpperCase()));
}

function isPrimaryColumn(column) {
    return column?.pk === true || constraintsFor(column).has('PK');
}

function isUniqueColumn(column) {
    return column?.unique === true || constraintsFor(column).has('UQ');
}

function getTargetKeys(table) {
    const columns = Array.isArray(table?.columns) ? table.columns.filter(Boolean) : [];
    const primaryColumns = columns.filter(isPrimaryColumn);
    const hasCompositePrimaryKey = primaryColumns.length > 1 || primaryColumns.some((column) => column.compositePk === true);

    return columns.flatMap((column) => {
        if (isPrimaryColumn(column) && !hasCompositePrimaryKey) {
            return [{ column, kind: 'primary' }];
        }
        if (isUniqueColumn(column) && column.compositeUq !== true) {
            return [{ column, kind: 'unique' }];
        }
        return [];
    });
}

function isRequiredColumn(column) {
    const constraints = constraintsFor(column);
    return isPrimaryColumn(column) || column?.notNull === true || constraints.has('NN');
}

function isSingleColumnUnique(column) {
    if (isPrimaryColumn(column)) return column?.compositePk !== true;
    return isUniqueColumn(column) && column?.compositeUq !== true;
}

function getCardinalities(column) {
    const required = isRequiredColumn(column);
    const unique = isSingleColumnUnique(column);
    return {
        fromCard: unique ? '0..1' : '0..n',
        toCard: required ? '1' : '0..1',
    };
}

function explicitSourceEndpoints(relations) {
    const endpoints = new Set();
    (Array.isArray(relations) ? relations : []).forEach((relation) => {
        if (!relation || relation.inferred === true || !relation.from) return;
        endpoints.add(endpointKey(relation.from.table, relation.from.column));
    });
    return endpoints;
}

function buildProposal(sourceTable, sourceColumn, targetTable, targetKey) {
    const nameSignal = getNameSignal(sourceColumn.name, targetTable.name, targetKey.column.name);
    if (!nameSignal) return null;

    const typeSignal = getTypeSignal(sourceColumn.type, targetKey.column.type);
    if (!typeSignal) return null;

    const from = { table: sourceTable.name, column: sourceColumn.name };
    const to = { table: targetTable.name, column: targetKey.column.name };
    const reasons = [nameSignal.reason];
    let confidence = nameSignal.score;

    if (targetKey.kind === 'primary') {
        confidence += 15;
        reasons.push('Target column is a non-composite primary key');
    } else {
        confidence += 12;
        reasons.push('Target column is a non-composite unique key');
    }

    confidence += typeSignal.score;
    reasons.push(typeSignal.reason);

    const sourceNamespace = identifierNamespace(sourceTable.name);
    const targetNamespace = identifierNamespace(targetTable.name);
    if (sourceNamespace && sourceNamespace === targetNamespace) {
        confidence += 2;
        reasons.push('Tables are in the same schema');
    }

    confidence = Math.min(100, Math.round(confidence));
    const cardinalities = getCardinalities(sourceColumn);
    return {
        id: buildInferredRelationId(from, to),
        from,
        to,
        ...cardinalities,
        inferred: true,
        confidence,
        confidenceLevel: confidence >= 90 ? 'high' : 'medium',
        reasons,
    };
}

/**
 * Infer high-confidence, single-column relationships from an ERD schema.
 *
 * This function never mutates the schema and never treats a suggestion as a
 * real FK. At most one candidate is emitted for each source column; a tie for
 * the best score is considered ambiguous and omitted.
 */
export function inferRelationships(schema) {
    const tables = (Array.isArray(schema?.tables) ? schema.tables : [])
        .filter((table) => table && typeof table.name === 'string' && Array.isArray(table.columns))
        .map((table) => ({ ...table, columns: table.columns.filter((column) => column && typeof column.name === 'string') }))
        .sort((left, right) => compareText(left.name, right.name));
    const usedSources = explicitSourceEndpoints(schema?.relations);
    const proposalsBySource = new Map();

    tables.forEach((sourceTable) => {
        sourceTable.columns.forEach((sourceColumn) => {
            const sourceKey = endpointKey(sourceTable.name, sourceColumn.name);
            if (usedSources.has(sourceKey)) return;

            const proposals = [];
            tables.forEach((targetTable) => {
                getTargetKeys(targetTable).forEach((targetKey) => {
                    if (sourceTable.name === targetTable.name && sourceColumn.name === targetKey.column.name) return;
                    const proposal = buildProposal(sourceTable, sourceColumn, targetTable, targetKey);
                    if (proposal && proposal.confidence >= 75) proposals.push(proposal);
                });
            });

            if (proposals.length > 0) proposalsBySource.set(sourceKey, proposals);
        });
    });

    const inferred = [];
    proposalsBySource.forEach((proposals) => {
        const uniqueById = new Map();
        proposals.forEach((proposal) => {
            const existing = uniqueById.get(proposal.id);
            if (!existing || proposal.confidence > existing.confidence) uniqueById.set(proposal.id, proposal);
        });
        const ranked = [...uniqueById.values()].sort((left, right) => right.confidence - left.confidence || compareText(left.id, right.id));
        if (ranked.length > 1 && ranked[0].confidence === ranked[1].confidence) return;
        inferred.push(ranked[0]);
    });

    return inferred.sort((left, right) => compareText(left.id, right.id));
}
