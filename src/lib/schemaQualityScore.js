import { inferRelationships } from './relationshipInference.js';

const SCORE_VERSION = 2;
const CATEGORY_MAX = Object.freeze({
    structuralValidity: 12,
    primaryKeys: 14,
    relationships: 16,
    typeCompatibility: 10,
    relationshipIndexes: 10,
    lifecycleSafety: 8,
    cardinalityCoherence: 6,
    columnCoherence: 8,
    columnSafeguards: 8,
    naming: 8,
});

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function endpointKey(endpoint) {
    return `${String(endpoint?.table || '').trim().toLowerCase()}\u001f${String(endpoint?.column || '').trim().toLowerCase()}`;
}

function relationKey(relation) {
    return `${endpointKey(relation?.from)}→${endpointKey(relation?.to)}`;
}

function normalizedName(value) {
    return String(value || '').trim().toLowerCase();
}

function constraintsFor(column) {
    return new Set((Array.isArray(column?.constraints) ? column.constraints : []).map((constraint) => String(constraint).toUpperCase()));
}

function isPrimaryKeyColumn(column) {
    return column?.pk === true || constraintsFor(column).has('PK');
}

function isRequiredColumn(column) {
    return isPrimaryKeyColumn(column) || constraintsFor(column).has('NN');
}

function isIndependentlyUnique(column) {
    const constraints = constraintsFor(column);
    return isPrimaryKeyColumn(column) || (constraints.has('UQ') && column?.compositeUq !== true);
}

function columnExtras(column) {
    return (Array.isArray(column?.extras) ? column.extras : []).map((extra) => String(extra || '').trim());
}

function hasDefaultValue(column) {
    return columnExtras(column).some((extra) => extra.toUpperCase().startsWith('DEFAULT '));
}

function hasNullDefault(column) {
    return columnExtras(column).some((extra) => /^DEFAULT\s+\(*\s*NULL\s*\)*(?:::[A-Z0-9_.\[\]\s]+)?$/i.test(extra));
}

function hasMeaningfulDefault(column) {
    return hasDefaultValue(column) && !hasNullDefault(column);
}

function isGeneratedColumn(column) {
    return columnExtras(column).some((extra) => {
        const value = extra.toUpperCase();
        return value.startsWith('GENERATED ')
            || value.includes(' GENERATED ')
            || value.startsWith('AS ')
            || value.startsWith('AS (')
            || value.includes(' AS (');
    });
}

function hasCheckConstraint(column) {
    return columnExtras(column).some((extra) => {
        const value = extra.toUpperCase();
        return value.startsWith('CHECK ') || value.includes(': CHECK ');
    });
}

function isAutoIncrementColumn(column) {
    return column?.autoIncrement === true || columnExtras(column).some((extra) => extra.toUpperCase().includes('AUTO_INCREMENT'));
}

function normalizeType(type) {
    return String(type || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/\s*([(),\[\]])\s*/g, '$1');
}

function canonicalType(type) {
    const raw = normalizeType(type);
    if (!raw) return '';
    const value = raw
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
        if (pattern.test(value)) return value.replace(pattern, replacement);
    }
    return value;
}

function typeFamily(type) {
    const value = canonicalType(type);
    const base = value.replace(/\(.*/, '');
    if (/\[\]$/.test(value)) return `array:${base.replace(/\[\]$/, '')}`;
    if (['tinyint', 'mediumint', 'smallint', 'integer', 'bigint', 'numeric', 'float', 'double', 'real'].includes(base)) return 'number';
    if (['char', 'nchar', 'varchar', 'nvarchar', 'text', 'tinytext', 'mediumtext', 'longtext', 'citext'].includes(base)) return 'string';
    if (['date', 'time', 'timestamp', 'timestamptz', 'datetime'].includes(base)) return 'temporal';
    if (['binary', 'varbinary', 'blob', 'bytea'].includes(base)) return 'binary';
    if (['boolean', 'uuid', 'json', 'jsonb'].includes(base)) return base;
    return `custom:${base}`;
}

function typeCompatibilityFactor(source, target) {
    const left = normalizeType(source?.type);
    const right = normalizeType(target?.type);
    if (!left || !right) return 0.25;
    const canonicalLeft = canonicalType(left);
    const canonicalRight = canonicalType(right);
    if (left === right || canonicalLeft === canonicalRight) return 1;
    if (/\[\]$/.test(canonicalLeft) !== /\[\]$/.test(canonicalRight)) return 0;
    const baseLeft = canonicalLeft.replace(/\(.*/, '');
    const baseRight = canonicalRight.replace(/\(.*/, '');
    if (baseLeft === baseRight) return 1;
    const familyLeft = typeFamily(canonicalLeft);
    const familyRight = typeFamily(canonicalRight);
    if (familyLeft === familyRight) return 0.5;
    if (familyLeft.startsWith('custom:') || familyRight.startsWith('custom:')) return 0.25;
    return 0;
}

function isIntegerType(type) {
    const value = canonicalType(type);
    return /^(tinyint|mediumint|smallint|integer|bigint)\b/.test(value)
        || /^numeric\(\d+,0\)$/.test(value);
}

function findTable(schema, tableName) {
    const target = String(tableName || '').toLowerCase();
    return (schema?.tables || []).find((table) => String(table?.name || '').toLowerCase() === target) || null;
}

function findColumn(schema, endpoint) {
    const table = findTable(schema, endpoint?.table);
    const columnName = String(endpoint?.column || '').toLowerCase();
    return table?.columns?.find((column) => String(column?.name || '').toLowerCase() === columnName) || null;
}

function identifierStyle(value, { stripQualifier = false } = {}) {
    const raw = String(value || '').trim();
    const name = stripQualifier ? raw.replace(/^.*\./, '') : raw;
    if (!name) return null;
    if (/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(name) || /^[A-Z0-9]+(?:_[A-Z0-9]+)*$/.test(name)) return 'snake';
    if (/^[a-z]+(?:[A-Z][A-Za-z0-9]*)+$/.test(name)) return 'camel';
    if (/^[A-Z][A-Za-z0-9]*$/.test(name)) return 'pascal';
    return 'other';
}

function namingConsistency(values, options) {
    const styles = values.map((value) => identifierStyle(value, options)).filter(Boolean);
    if (styles.length <= 1) return { coverage: 1, dominant: styles[0] || null };

    const counts = new Map();
    styles.filter((style) => style !== 'other').forEach((style) => counts.set(style, (counts.get(style) || 0) + 1));
    if (counts.size === 0) return { coverage: 0, dominant: null };

    const [dominant, count] = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
    return { coverage: count / styles.length, dominant };
}

function relationGroupKey(relation) {
    return relation?.relationGroup || relationKey(relation);
}

function groupRelations(relations) {
    const groups = new Map();
    relations.forEach((relation) => {
        const key = relationGroupKey(relation);
        if (groups.has(key)) {
            groups.get(key).relations.push(relation);
        } else {
            groups.set(key, { key, relation, relations: [relation] });
        }
    });
    return [...groups.values()];
}

function groupSourceColumns(group) {
    const declared = Array.isArray(group?.relation?.fromColumns) ? group.relation.fromColumns.filter(Boolean) : [];
    if (declared.length > 0) return [...new Set(declared.map(String))];
    return [...new Set((group?.relations || []).map((relation) => relation?.from?.column).filter(Boolean))];
}

function groupTargetColumns(group) {
    const declared = Array.isArray(group?.relation?.toColumns) ? group.relation.toColumns.filter(Boolean) : [];
    if (declared.length > 0) return [...new Set(declared.map(String))];
    return [...new Set((group?.relations || []).map((relation) => relation?.to?.column).filter(Boolean))];
}

function groupSignature(group) {
    const relation = group?.relation;
    return [
        String(relation?.from?.table || '').toLowerCase(),
        groupSourceColumns(group).map((column) => String(column).toLowerCase()).join(','),
        String(relation?.to?.table || '').toLowerCase(),
        groupTargetColumns(group).map((column) => String(column).toLowerCase()).join(','),
    ].join('→');
}

function groupPairs(group) {
    const relation = group?.relation;
    const sourceColumns = groupSourceColumns(group);
    const targetColumns = groupTargetColumns(group);
    if (sourceColumns.length > 0 && sourceColumns.length === targetColumns.length) {
        return sourceColumns.map((column, index) => ({
            from: { table: relation?.from?.table, column },
            to: { table: relation?.to?.table, column: targetColumns[index] },
        }));
    }
    return (group?.relations || []).map((item) => ({ from: item.from, to: item.to }));
}

function confidenceWeight(relation) {
    const confidence = Number.isFinite(relation?.confidence) ? relation.confidence / 100 : 1;
    return clamp(confidence, 0.75, 1);
}

function normalizeAction(value) {
    const normalized = String(value || '').trim().toUpperCase().replace(/\s+/g, ' ');
    if (normalized === 'SETNULL') return 'SET NULL';
    if (normalized === 'SETDEFAULT') return 'SET DEFAULT';
    if (normalized === 'NOACTION') return 'NO ACTION';
    return normalized;
}

function sameColumnSet(left, right) {
    const normalize = (values) => [...new Set((values || []).map((value) => normalizedName(value)))].sort().join('|');
    return normalize(left) === normalize(right);
}

function primaryKeyColumns(table) {
    return (table?.columns || []).filter(isPrimaryKeyColumn).map((column) => column.name);
}

function singleColumnIndexAssessment(column) {
    if (!column) return 0;
    const constraints = constraintsFor(column);
    if (column.compositePk === true || column.compositeIdx === true || column.compositeUq === true) return null;
    if (isPrimaryKeyColumn(column)) return 1;
    if (constraints.has('UQ') || constraints.has('IDX')) return 1;
    return 0;
}

function groupIndexAssessment(schema, group) {
    const table = findTable(schema, group?.relation?.from?.table);
    const sourceColumns = groupSourceColumns(group);
    if (!table || sourceColumns.length === 0) return null;
    if (sourceColumns.length === 1) {
        const column = table.columns.find((item) => normalizedName(item.name) === normalizedName(sourceColumns[0]));
        return singleColumnIndexAssessment(column);
    }
    return sameColumnSet(sourceColumns, primaryKeyColumns(table)) ? 1 : null;
}

function uniqueSourceStatus(schema, group) {
    const table = findTable(schema, group?.relation?.from?.table);
    const sourceColumns = groupSourceColumns(group);
    if (!table || sourceColumns.length === 0) return null;
    if (sourceColumns.length === 1) {
        const column = table.columns.find((item) => normalizedName(item.name) === normalizedName(sourceColumns[0]));
        if (!column) return null;
        if (column.compositePk === true || column.compositeUq === true) return null;
        return isIndependentlyUnique(column);
    }
    if (sameColumnSet(sourceColumns, primaryKeyColumns(table))) return true;
    if (sourceColumns.some((columnName) => {
        const column = table.columns.find((item) => normalizedName(item.name) === normalizedName(columnName));
        return column?.compositeUq === true;
    })) return null;
    return false;
}

function cascadeCycleGroupKeys(groups) {
    const edges = groups
        .filter((group) => normalizeAction(group.relation?.actions?.onDelete) === 'CASCADE')
        .map((group) => ({
            key: group.key,
            from: String(group.relation?.to?.table || '').toLowerCase(),
            to: String(group.relation?.from?.table || '').toLowerCase(),
        }));
    const graph = new Map();
    edges.forEach((edge) => {
        if (!graph.has(edge.from)) graph.set(edge.from, new Set());
        graph.get(edge.from).add(edge.to);
    });
    const pathExists = (start, target, visited = new Set()) => {
        if (start === target) return true;
        if (visited.has(start)) return false;
        visited.add(start);
        for (const next of graph.get(start) || []) {
            if (pathExists(next, target, visited)) return true;
        }
        return false;
    };
    return new Set(edges.filter((edge) => pathExists(edge.to, edge.from)).map((edge) => edge.key));
}

function scoreLabel(score, hasSchema) {
    if (!hasSchema) return 'Not scored';
    if (score >= 95) return 'Excellent';
    if (score >= 85) return 'Strong';
    if (score >= 72) return 'Good';
    if (score >= 55) return 'Fair';
    return 'Needs work';
}

function scoreSummary(score, hasSchema, capApplied = null) {
    if (!hasSchema) return 'Add a table to calculate an ERD quality score.';
    if (capApplied) return `Critical integrity findings cap this score at ${capApplied.cap}.`;
    if (score >= 95) return 'Well structured across identity, integrity, safety, and maintainability checks.';
    if (score >= 85) return 'A strong design with a small number of practical improvements.';
    if (score >= 72) return 'A good foundation; review the checks below before production.';
    if (score >= 55) return 'The main structure is present, but important checks still need attention.';
    return 'Address the structural checks below before relying on this design.';
}

function category(id, label, factor, maxScore, summary, { applicable = true, applicability = applicable ? 1 : 0 } = {}) {
    const safeApplicability = clamp(Number.isFinite(applicability) ? applicability : 0, 0, 1);
    if (!applicable || safeApplicability === 0) {
        return { id, label, score: null, maxScore, effectiveScore: null, effectiveMaxScore: 0, percentage: null, factor: null, applicable: false, applicability: 0, summary };
    }
    const safeFactor = clamp(Number.isFinite(factor) ? factor : 0, 0, 1);
    const effectiveMaxScore = Math.round(maxScore * safeApplicability * 10) / 10;
    return {
        id,
        label,
        score: Math.round(maxScore * safeFactor),
        maxScore,
        effectiveScore: Math.round(effectiveMaxScore * safeFactor * 10) / 10,
        effectiveMaxScore,
        percentage: Math.round(safeFactor * 100),
        factor: Math.round(safeFactor * 1000) / 1000,
        applicable: true,
        applicability: Math.round(safeApplicability * 1000) / 1000,
        summary,
    };
}

function emptyCategories() {
    return [
        category('structuralValidity', 'Structural validity', 0, CATEGORY_MAX.structuralValidity, 'No schema to evaluate.'),
        category('primaryKeys', 'Entity identity', 0, CATEGORY_MAX.primaryKeys, 'No tables to evaluate.'),
        category('relationships', 'Relationship integrity', 0, CATEGORY_MAX.relationships, 'No relationships to evaluate.', { applicable: false }),
        category('typeCompatibility', 'Key types', 0, CATEGORY_MAX.typeCompatibility, 'No relationships to evaluate.', { applicable: false }),
        category('relationshipIndexes', 'Relationship indexes', 0, CATEGORY_MAX.relationshipIndexes, 'No relationships to evaluate.', { applicable: false }),
        category('lifecycleSafety', 'Lifecycle safety', 0, CATEGORY_MAX.lifecycleSafety, 'No relationships to evaluate.', { applicable: false }),
        category('cardinalityCoherence', 'Cardinality coherence', 0, CATEGORY_MAX.cardinalityCoherence, 'No relationships to evaluate.', { applicable: false }),
        category('columnCoherence', 'Column definitions', 0, CATEGORY_MAX.columnCoherence, 'No columns to evaluate.', { applicable: false }),
        category('columnSafeguards', 'Data safeguards', 0, CATEGORY_MAX.columnSafeguards, 'No business columns to evaluate.', { applicable: false }),
        category('naming', 'Naming consistency', 0, CATEGORY_MAX.naming, 'No identifiers to evaluate.'),
    ];
}

/**
 * Calculate a deterministic, explainable ERD design-review score.
 * Version 2 evaluates only signals preserved by the parser. Categories with
 * no relevant evidence are N/A and are excluded from normalization.
 */
export function scoreErdSchema(schema, { acceptedInferredRelations = [], rejectedInferredRelationIds = [], relationshipCandidates = null } = {}) {
    const rawTables = Array.isArray(schema?.tables) ? schema.tables.filter(Boolean) : [];
    const tables = rawTables.filter((table) => table?.name && Array.isArray(table.columns));
    const rawRelations = Array.isArray(schema?.relations) ? schema.relations.filter((relation) => relation?.inferred !== true) : [];
    const explicitRelations = rawRelations.filter((relation) => relation?.from?.table && relation?.from?.column && relation?.to?.table && relation?.to?.column);
    const acceptedRelations = Array.isArray(acceptedInferredRelations)
        ? acceptedInferredRelations.filter((relation) => relation?.from?.table && relation?.from?.column && relation?.to?.table && relation?.to?.column)
        : [];
    const tableCount = tables.length;
    const columnCount = tables.reduce((count, table) => count + table.columns.length, 0);

    if (tableCount === 0) {
        return {
            score: 0,
            scoreVersion: SCORE_VERSION,
            label: scoreLabel(0, false),
            summary: scoreSummary(0, false),
            assessmentCoverage: 0,
            categories: emptyCategories(),
            findings: [],
            capApplied: null,
            stats: {
                tableCount: 0,
                columnCount: 0,
                applicableCriteria: 0,
                totalCriteria: Object.keys(CATEGORY_MAX).length,
            },
        };
    }

    const findings = [];

    // 1. Structural validity: diagnostics plus definition-level invariants.
    const diagnosticMap = new Map();
    (Array.isArray(schema?._parseErrors) ? schema._parseErrors : []).filter(Boolean).forEach((diagnostic) => {
        const position = diagnostic?.position || {};
        const key = `${diagnostic?.kind || ''}|${position?.line || position?.start?.line || ''}|${position?.column || position?.start?.column || ''}|${diagnostic?.message || ''}`;
        if (!diagnosticMap.has(key)) diagnosticMap.set(key, diagnostic);
    });
    const diagnostics = [...diagnosticMap.values()];
    const schemaErrors = diagnostics.filter((item) => String(item?.severity || '').toLowerCase() === 'error');
    const warningDiagnostics = diagnostics.filter((item) => String(item?.severity || '').toLowerCase() === 'warning');
    const droppedRelationWarnings = warningDiagnostics.filter((item) => String(item?.kind || '').startsWith('relation_dropped_'));
    const otherWarnings = warningDiagnostics.length - droppedRelationWarnings.length;

    const tableNameCounts = new Map();
    tables.forEach((table) => {
        const identity = String(table.fullName || table.name).trim().toLowerCase();
        tableNameCounts.set(identity, (tableNameCounts.get(identity) || 0) + 1);
    });
    const duplicateTableNames = [...tableNameCounts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
    let duplicateColumnNames = 0;
    let blankColumnNames = 0;
    let blankColumnTypes = 0;
    tables.forEach((table) => {
        const names = new Map();
        table.columns.forEach((column) => {
            if (!String(column?.name || '').trim()) blankColumnNames += 1;
            if (!String(column?.type || '').trim()) blankColumnTypes += 1;
            const key = normalizedName(column?.name);
            names.set(key, (names.get(key) || 0) + 1);
        });
        duplicateColumnNames += [...names.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
    });
    const blankTableNames = rawTables.length - tables.length;
    const emptyTables = tables.filter((table) => table.columns.length === 0);
    const malformedRelationEndpoints = rawRelations.length - explicitRelations.length
        + explicitRelations.filter((relation) => !findColumn(schema, relation.from) || !findColumn(schema, relation.to)).length;
    const enums = Array.isArray(schema?.enums) ? schema.enums.filter(Boolean) : [];
    const enumNameCounts = new Map();
    enums.forEach((enumType) => enumNameCounts.set(normalizedName(enumType?.name), (enumNameCounts.get(normalizedName(enumType?.name)) || 0) + 1));
    const blankEnumNames = enums.filter((enumType) => !normalizedName(enumType?.name)).length;
    const duplicateEnumNames = [...enumNameCounts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
    const emptyEnums = enums.filter((enumType) => !Array.isArray(enumType?.values) || enumType.values.length === 0).length;
    const duplicateEnumValues = enums.reduce((total, enumType) => {
        const counts = new Map();
        (Array.isArray(enumType?.values) ? enumType.values : []).forEach((value) => counts.set(String(value), (counts.get(String(value)) || 0) + 1));
        return total + [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
    }, 0);
    const composites = Array.isArray(schema?.composites) ? schema.composites.filter(Boolean) : [];
    const compositeNameCounts = new Map();
    composites.forEach((composite) => compositeNameCounts.set(normalizedName(composite?.name), (compositeNameCounts.get(normalizedName(composite?.name)) || 0) + 1));
    const blankCompositeNames = composites.filter((composite) => !normalizedName(composite?.name)).length;
    const duplicateCompositeNames = [...compositeNameCounts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
    let duplicateCompositeFields = 0;
    let blankCompositeFields = 0;
    composites.forEach((composite) => {
        const fieldCounts = new Map();
        (Array.isArray(composite?.fields) ? composite.fields : []).forEach((field) => {
            const key = normalizedName(field?.name);
            if (!key) blankCompositeFields += 1;
            fieldCounts.set(key, (fieldCounts.get(key) || 0) + 1);
        });
        duplicateCompositeFields += [...fieldCounts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
    });
    const hardStructuralFlaws = blankTableNames
        + duplicateTableNames
        + duplicateColumnNames
        + blankColumnNames
        + blankColumnTypes
        + emptyTables.length
        + malformedRelationEndpoints
        + blankEnumNames
        + duplicateEnumNames
        + emptyEnums
        + duplicateEnumValues
        + blankCompositeNames
        + duplicateCompositeNames
        + duplicateCompositeFields
        + blankCompositeFields;
    const structuralFactor = schemaErrors.length > 0
        ? 0
        : clamp(1 - Math.min(0.8, hardStructuralFlaws * 0.2) - Math.min(0.6, droppedRelationWarnings.length * 0.15) - Math.min(0.1, otherWarnings * 0.025), 0, 1);
    if (schemaErrors.length > 0 || warningDiagnostics.length > 0) {
        findings.push({
            code: 'unresolved_schema_diagnostics',
            severity: schemaErrors.length > 0 ? 'warning' : 'suggestion',
            title: `${schemaErrors.length + warningDiagnostics.length} unresolved schema diagnostic${schemaErrors.length + warningDiagnostics.length === 1 ? '' : 's'}`,
            detail: 'Resolve parser errors and dropped-relationship warnings before treating this ERD as production-ready.',
            errorCount: schemaErrors.length,
            warningCount: warningDiagnostics.length,
        });
    }
    if (hardStructuralFlaws > 0) {
        findings.push({
            code: 'structural_definition_flaws',
            severity: 'warning',
            title: `${hardStructuralFlaws} structural definition flaw${hardStructuralFlaws === 1 ? '' : 's'}`,
            detail: 'Fix blank or duplicate identifiers, blank types, empty definitions, malformed endpoints, and duplicate type values.',
        });
    }

    // 2. Entity identity.
    const tablesWithPrimaryKey = tables.filter((table) => table.columns.some(isPrimaryKeyColumn));
    const missingPrimaryKeys = tables.filter((table) => !table.columns.some(isPrimaryKeyColumn));
    const primaryKeyFactor = tablesWithPrimaryKey.length / tableCount;
    if (missingPrimaryKeys.length > 0) {
        findings.push({
            code: 'missing_primary_keys',
            severity: 'warning',
            title: `${missingPrimaryKeys.length} table${missingPrimaryKeys.length === 1 ? '' : 's'} without a primary key`,
            detail: 'Add a stable primary key so every entity has a clear identity.',
            tables: missingPrimaryKeys.map((table) => table.name).sort(),
        });
    }

    // 3. Logical relationship integrity, including reviewed inferences.
    const explicitGroups = groupRelations(explicitRelations);
    const explicitSignatures = new Set(explicitGroups.map(groupSignature));
    const acceptedGroups = groupRelations(acceptedRelations).filter((group) => !explicitSignatures.has(groupSignature(group)));
    const acceptedIds = new Set(acceptedRelations.map((relation) => relation?.id).filter(Boolean));
    const acceptedSignatures = new Set(acceptedGroups.map(groupSignature));
    const candidateList = Array.isArray(relationshipCandidates) ? relationshipCandidates : inferRelationships(schema);
    const currentCandidateIds = new Set(candidateList.map((candidate) => candidate?.id).filter(Boolean));
    const rejectedCandidateIds = new Set((Array.isArray(rejectedInferredRelationIds) ? rejectedInferredRelationIds : [])
        .filter((id) => typeof id === 'string' && currentCandidateIds.has(id)));
    const pendingCandidates = candidateList.filter((candidate) => {
        if (!candidate?.id || rejectedCandidateIds.has(candidate.id) || acceptedIds.has(candidate.id)) return false;
        const signature = groupSignature({ relation: candidate, relations: [candidate] });
        return !explicitSignatures.has(signature) && !acceptedSignatures.has(signature);
    });
    const relationshipOpportunities = [
        ...explicitGroups.map((group) => ({ kind: 'explicit', group, weight: 1, credit: 1 })),
        ...acceptedGroups.map((group) => ({ kind: 'accepted', group, weight: confidenceWeight(group.relation), credit: 0.65 })),
        ...pendingCandidates.map((candidate) => ({ kind: 'pending', candidate, weight: confidenceWeight(candidate), credit: 0 })),
    ];
    const relationshipWeight = relationshipOpportunities.reduce((total, item) => total + item.weight, 0);
    const relationshipFactor = relationshipWeight === 0
        ? 0
        : relationshipOpportunities.reduce((total, item) => total + item.weight * item.credit, 0) / relationshipWeight;
    if (pendingCandidates.length > 0) {
        findings.push({
            code: 'missing_relationship_links',
            severity: 'warning',
            title: `${pendingCandidates.length} high-confidence relationship${pendingCandidates.length === 1 ? '' : 's'} missing from the ERD`,
            detail: 'Review the relationship suggestions and accept only the links that belong in this diagram.',
            relationships: pendingCandidates.map((candidate) => ({ id: candidate.id, from: candidate.from, to: candidate.to, confidence: candidate.confidence })),
        });
    }
    if (acceptedGroups.length > 0) {
        findings.push({
            code: 'diagram_only_relationships',
            severity: 'info',
            title: `${acceptedGroups.length} accepted diagram-only relationship${acceptedGroups.length === 1 ? '' : 's'}`,
            detail: 'These links receive partial relationship credit because they do not add foreign-key constraints to SQL.',
        });
    }

    const assessedGroups = [
        ...explicitGroups.map((group) => ({ group, kind: 'explicit', weight: 1 })),
        ...acceptedGroups.map((group) => ({ group, kind: 'accepted', weight: confidenceWeight(group.relation) })),
    ];

    // 4. Key type compatibility, grouped so composite FKs count once.
    const typeAssessments = assessedGroups.map((item) => {
        const pairs = groupPairs(item.group);
        let factor = 1;
        if (pairs.length === 0) factor = 0.25;
        pairs.forEach((pair) => {
            const source = findColumn(schema, pair.from);
            const target = findColumn(schema, pair.to);
            factor = Math.min(factor, typeCompatibilityFactor(source, target));
        });
        return { ...item, factor };
    });
    const typeWeight = typeAssessments.reduce((total, item) => total + item.weight, 0);
    const typeFactor = typeWeight === 0 ? 0 : typeAssessments.reduce((total, item) => total + item.weight * item.factor, 0) / typeWeight;
    const incompatibleTypeGroups = typeAssessments.filter((item) => item.factor === 0);
    const fullyCompatibleTypeGroups = typeAssessments.filter((item) => item.factor === 1);
    const uncertainTypeGroups = typeAssessments.filter((item) => item.factor > 0 && item.factor < 1);
    if (incompatibleTypeGroups.length > 0) {
        findings.push({
            code: 'incompatible_relationship_types',
            severity: 'warning',
            title: `${incompatibleTypeGroups.length} relationship${incompatibleTypeGroups.length === 1 ? '' : 's'} with incompatible key types`,
            detail: 'Use matching key types across every member of a relationship.',
            relationships: incompatibleTypeGroups.map((item) => ({ from: item.group.relation.from, to: item.group.relation.to })),
        });
    }

    // 5. Index readiness. Composite index order is N/A until ordered index
    // metadata is retained by the ERD adapter.
    const indexAssessments = assessedGroups.map((item) => ({ ...item, factor: groupIndexAssessment(schema, item.group) }));
    const applicableIndexAssessments = indexAssessments.filter((item) => item.factor !== null);
    const indexWeight = applicableIndexAssessments.reduce((total, item) => total + item.weight, 0);
    const indexFactor = indexWeight === 0 ? 0 : applicableIndexAssessments.reduce((total, item) => total + item.weight * item.factor, 0) / indexWeight;
    const unindexedGroups = applicableIndexAssessments.filter((item) => item.factor === 0);
    const unassessableIndexGroups = indexAssessments.length - applicableIndexAssessments.length;
    if (unindexedGroups.length > 0) {
        findings.push({
            code: 'unindexed_relationship_sources',
            severity: 'suggestion',
            title: `${unindexedGroups.length} relationship source${unindexedGroups.length === 1 ? '' : 's'} without an index`,
            detail: 'Index foreign-key columns to keep joins and deletes predictable as the schema grows.',
            relationships: unindexedGroups.map((item) => ({ from: item.group.relation.from, to: item.group.relation.to })),
        });
    }

    // 6. Referential-action safety.
    const lifecycleIssues = [];
    const cascadeCycleKeys = cascadeCycleGroupKeys(explicitGroups);
    const lifecycleAssessments = explicitGroups.map((group) => {
        const sourceTable = findTable(schema, group.relation?.from?.table);
        const sourceColumns = groupSourceColumns(group)
            .map((columnName) => sourceTable?.columns?.find((column) => normalizedName(column.name) === normalizedName(columnName)))
            .filter(Boolean);
        const actions = group.relation?.actions || {};
        let factor = 1;
        ['onDelete', 'onUpdate'].forEach((actionKey) => {
            const action = normalizeAction(actions[actionKey]);
            if (action === 'SET NULL' && sourceColumns.some(isRequiredColumn)) {
                factor = 0;
                lifecycleIssues.push({ group, actionKey, action, reason: 'SET NULL requires nullable source columns.' });
            }
            if (action === 'SET DEFAULT' && sourceColumns.some((column) => isRequiredColumn(column) && !hasMeaningfulDefault(column))) {
                factor = Math.min(factor, 0.25);
                lifecycleIssues.push({ group, actionKey, action, reason: 'SET DEFAULT requires a usable non-null default on required source columns.' });
            }
        });
        if (actions.deferrable === false && normalizeAction(actions.initially).includes('DEFERRED')) {
            factor = 0;
            lifecycleIssues.push({ group, actionKey: 'initially', action: normalizeAction(actions.initially), reason: 'INITIALLY DEFERRED requires a deferrable relationship.' });
        }
        if (cascadeCycleKeys.has(group.key)) factor = Math.min(factor, 0.25);
        return { group, factor };
    });
    const lifecycleFactor = lifecycleAssessments.length === 0
        ? 0
        : lifecycleAssessments.reduce((total, item) => total + item.factor, 0) / lifecycleAssessments.length;
    const unsafeLifecycleGroups = new Set(lifecycleIssues.map((issue) => issue.group.key));
    if (lifecycleIssues.length > 0) {
        findings.push({
            code: 'incompatible_referential_actions',
            severity: 'warning',
            title: `${unsafeLifecycleGroups.size} relationship${unsafeLifecycleGroups.size === 1 ? '' : 's'} with incompatible lifecycle actions`,
            detail: 'Make SET NULL columns nullable, provide usable SET DEFAULT values, and align deferred settings.',
            relationships: lifecycleIssues.map((issue) => ({ from: issue.group.relation.from, to: issue.group.relation.to, action: issue.action, reason: issue.reason })),
        });
    }
    if (cascadeCycleKeys.size > 0) {
        findings.push({
            code: 'cascade_delete_cycle',
            severity: 'warning',
            title: `${cascadeCycleKeys.size} cascading relationship${cascadeCycleKeys.size === 1 ? '' : 's'} in a delete cycle`,
            detail: 'Review cyclic cascades, including self-cascades, for platform-specific or recursive delete behavior.',
        });
    }

    // 7. Cardinality coherence against nullability and provable uniqueness.
    const cardinalityAssessments = assessedGroups.map((item) => {
        const relation = item.group.relation;
        const sourceTable = findTable(schema, relation?.from?.table);
        const sourceColumns = groupSourceColumns(item.group)
            .map((columnName) => sourceTable?.columns?.find((column) => normalizedName(column.name) === normalizedName(columnName)))
            .filter(Boolean);
        let checks = 0;
        let passed = 0;
        if (sourceColumns.length > 0) {
            const expectedRequired = sourceColumns.every(isRequiredColumn);
            const actualRequired = relation?.toCard === '1';
            checks += 1;
            if (expectedRequired === actualRequired) passed += 1;
        }
        const uniqueStatus = uniqueSourceStatus(schema, item.group);
        if (uniqueStatus !== null) {
            const actualOne = relation?.fromCard === '1' || relation?.fromCard === '0..1';
            checks += 1;
            if (actualOne === uniqueStatus) passed += 1;
        }
        return { ...item, factor: checks === 0 ? 1 : passed / checks };
    });
    const cardinalityWeight = cardinalityAssessments.reduce((total, item) => total + item.weight, 0);
    const cardinalityFactor = cardinalityWeight === 0 ? 0 : cardinalityAssessments.reduce((total, item) => total + item.weight * item.factor, 0) / cardinalityWeight;
    const incoherentCardinalityGroups = cardinalityAssessments.filter((item) => item.factor < 1);
    if (incoherentCardinalityGroups.length > 0) {
        findings.push({
            code: 'incoherent_cardinalities',
            severity: 'warning',
            title: `${incoherentCardinalityGroups.length} relationship cardinalit${incoherentCardinalityGroups.length === 1 ? 'y' : 'ies'} inconsistent with its columns`,
            detail: 'Align optionality and one-to-one markers with source nullability and provable uniqueness.',
        });
    }

    // 8. Column-definition coherence, macro-averaged per table.
    const columnDefinitionIssues = [];
    const tableColumnFactors = tables.map((table) => {
        if (table.columns.length === 0) return 0;
        const factors = table.columns.map((column) => {
            const generated = isGeneratedColumn(column);
            const autoIncrement = isAutoIncrementColumn(column);
            let factor = 1;
            let reason = null;
            if (!normalizeType(column?.type)) {
                factor = 0;
                reason = 'Column type is blank.';
            } else if (generated && (hasDefaultValue(column) || autoIncrement)) {
                factor = 0;
                reason = 'Generated columns should not also declare defaults or auto-increment behavior.';
            } else if (autoIncrement && !isIntegerType(column.type)) {
                factor = 0;
                reason = 'Auto-increment requires an integer-compatible type.';
            } else if (isRequiredColumn(column) && hasNullDefault(column)) {
                factor = 0.25;
                reason = 'A required column cannot use DEFAULT NULL coherently.';
            }
            if (reason) columnDefinitionIssues.push({ table: table.name, column: column.name, reason });
            return factor;
        });
        return factors.reduce((total, factor) => total + factor, 0) / factors.length;
    });
    const columnCoherenceFactor = tableColumnFactors.reduce((total, factor) => total + factor, 0) / tableColumnFactors.length;
    if (columnDefinitionIssues.length > 0) {
        findings.push({
            code: 'incoherent_column_definitions',
            severity: 'warning',
            title: `${columnDefinitionIssues.length} incoherent column definition${columnDefinitionIssues.length === 1 ? '' : 's'}`,
            detail: 'Review generated/default combinations, auto-increment types, and required columns with NULL defaults.',
            columns: columnDefinitionIssues,
        });
    }
    const incoherentColumnKeys = new Set(columnDefinitionIssues.map((issue) => endpointKey({ table: issue.table, column: issue.column })));

    // 9. Declarative safeguards. FK and PK columns are evaluated elsewhere.
    const enumNames = new Set(enums.map((enumType) => normalizedName(enumType?.name)));
    const explicitSourceEndpointKeys = new Set(explicitRelations.map((relation) => endpointKey(relation.from)));
    const safeguardTables = [];
    let eligibleBusinessColumns = 0;
    let safeguardedBusinessColumns = 0;
    tables.forEach((table) => {
        const columns = table.columns.filter((column) => !isPrimaryKeyColumn(column)
            && column?.fk !== true
            && !explicitSourceEndpointKeys.has(endpointKey({ table: table.name, column: column.name })));
        if (columns.length === 0) return;
        const factors = columns.map((column) => {
            const signals = [];
            const coherent = !incoherentColumnKeys.has(endpointKey({ table: table.name, column: column.name }));
            if (coherent && (hasCheckConstraint(column) || isGeneratedColumn(column))) signals.push(1);
            if (coherent && (isIndependentlyUnique(column) || enumNames.has(normalizedName(column?.type)))) signals.push(0.85);
            if (coherent && constraintsFor(column).has('NN')) signals.push(0.6);
            if (coherent && hasMeaningfulDefault(column)) signals.push(0.25);
            const explicitSignal = 1 - signals.reduce((remaining, signal) => remaining * (1 - signal), 1);
            if (explicitSignal > 0) safeguardedBusinessColumns += 1;
            eligibleBusinessColumns += 1;
            return 0.25 + 0.75 * explicitSignal;
        });
        safeguardTables.push({ table, factor: factors.reduce((total, factor) => total + factor, 0) / factors.length, hasSignal: factors.some((factor) => factor > 0.25) });
    });
    const safeguardFactor = safeguardTables.length === 0 ? 0 : safeguardTables.reduce((total, item) => total + item.factor, 0) / safeguardTables.length;
    const tablesWithoutSafeguards = safeguardTables.filter((item) => !item.hasSignal);
    if (tablesWithoutSafeguards.length > 0) {
        findings.push({
            code: 'tables_without_column_safeguards',
            severity: 'suggestion',
            title: `${tablesWithoutSafeguards.length} table${tablesWithoutSafeguards.length === 1 ? '' : 's'} with no visible business-column safeguards`,
            detail: 'Review whether business columns need NOT NULL, UNIQUE, CHECK, meaningful defaults, enums, or generated rules.',
            tables: tablesWithoutSafeguards.map((item) => item.table.name).sort(),
        });
    }

    // 10. Naming consistency, without enforcing singular/plural ideology.
    const tableNaming = namingConsistency(tables.map((table) => table.name), { stripQualifier: true });
    const columnNaming = namingConsistency(tables.flatMap((table) => table.columns.map((column) => column.name)));
    const namingFactor = 0.4 * tableNaming.coverage + 0.6 * columnNaming.coverage;
    if (namingFactor < 0.95) {
        findings.push({
            code: 'inconsistent_naming',
            severity: 'suggestion',
            title: 'Naming styles are inconsistent',
            detail: 'Use a consistent identifier style so the ERD remains easy to scan.',
            tableStyle: tableNaming.dominant,
            columnStyle: columnNaming.dominant,
        });
    }

    const categories = [
        category('structuralValidity', 'Structural validity', structuralFactor, CATEGORY_MAX.structuralValidity, `${schemaErrors.length} errors, ${droppedRelationWarnings.length} dropped relations, and ${hardStructuralFlaws} definition flaws.`),
        category('primaryKeys', 'Entity identity', primaryKeyFactor, CATEGORY_MAX.primaryKeys, `${tablesWithPrimaryKey.length}/${tableCount} tables have a primary key.`),
        category('relationships', 'Relationship integrity', relationshipFactor, CATEGORY_MAX.relationships, relationshipOpportunities.length === 0 ? 'No relationship signals are present.' : `${explicitGroups.length} SQL, ${acceptedGroups.length} diagram-only, and ${pendingCandidates.length} pending.`, { applicable: relationshipOpportunities.length > 0 }),
        category('typeCompatibility', 'Key types', typeFactor, CATEGORY_MAX.typeCompatibility, assessedGroups.length === 0 ? 'No declared or accepted relationships to compare.' : `${fullyCompatibleTypeGroups.length} compatible, ${uncertainTypeGroups.length} uncertain, and ${incompatibleTypeGroups.length} incompatible logical relationships.`, { applicable: assessedGroups.length > 0 }),
        category('relationshipIndexes', 'Relationship indexes', indexFactor, CATEGORY_MAX.relationshipIndexes, indexAssessments.length === 0 ? 'No declared or accepted relationships to inspect.' : applicableIndexAssessments.length === 0 ? `${unassessableIndexGroups} composite relationship index group${unassessableIndexGroups === 1 ? ' is' : 's are'} N/A because ordered index metadata is unavailable.` : `${applicableIndexAssessments.length - unindexedGroups.length}/${applicableIndexAssessments.length} assessable sources are indexed; ${unassessableIndexGroups} composite groups are N/A.`, { applicable: applicableIndexAssessments.length > 0, applicability: indexAssessments.length === 0 ? 0 : applicableIndexAssessments.length / indexAssessments.length }),
        category('lifecycleSafety', 'Lifecycle safety', lifecycleFactor, CATEGORY_MAX.lifecycleSafety, explicitGroups.length === 0 ? 'No SQL relationships need action checks.' : `${explicitGroups.length - unsafeLifecycleGroups.size}/${explicitGroups.length} relationship actions are compatible; ${cascadeCycleKeys.size} are in cascade cycles.`, { applicable: explicitGroups.length > 0 }),
        category('cardinalityCoherence', 'Cardinality coherence', cardinalityFactor, CATEGORY_MAX.cardinalityCoherence, assessedGroups.length === 0 ? 'No relationships need cardinality checks.' : `${cardinalityAssessments.length - incoherentCardinalityGroups.length}/${cardinalityAssessments.length} logical relationships agree with column constraints.`, { applicable: assessedGroups.length > 0 }),
        category('columnCoherence', 'Column definitions', columnCoherenceFactor, CATEGORY_MAX.columnCoherence, `${columnCount - columnDefinitionIssues.length}/${columnCount} columns have coherent type, default, and generation rules.`, { applicable: columnCount > 0 }),
        category('columnSafeguards', 'Data safeguards', safeguardFactor, CATEGORY_MAX.columnSafeguards, safeguardTables.length === 0 ? 'No non-key, non-FK business columns need review.' : `${safeguardedBusinessColumns}/${eligibleBusinessColumns} business columns expose at least one safeguard.`, { applicable: safeguardTables.length > 0 }),
        category('naming', 'Naming consistency', namingFactor, CATEGORY_MAX.naming, `Table names: ${tableNaming.dominant || 'mixed'}; column names: ${columnNaming.dominant || 'mixed'}.`),
    ];

    const applicableCategories = categories.filter((item) => item.applicable !== false);
    const applicableWeight = applicableCategories.reduce((total, item) => total + item.maxScore * item.applicability, 0);
    const weightedEarned = applicableCategories.reduce((total, item) => total + item.maxScore * item.applicability * item.factor, 0);
    const uncappedScore = clamp(Math.round((weightedEarned / applicableWeight) * 100), 1, 100);

    const capReasons = [];
    let scoreCap = 100;
    const applyCap = (cap, reason) => {
        scoreCap = Math.min(scoreCap, cap);
        capReasons.push(reason);
    };
    if (schemaErrors.length > 0 || hardStructuralFlaws > 0 || malformedRelationEndpoints > 0) applyCap(49, 'Critical structural validity failure');
    if (missingPrimaryKeys.length / tableCount > 0.25) applyCap(69, 'More than 25% of tables lack primary keys');
    else if (missingPrimaryKeys.length > 0) applyCap(89, 'At least one table lacks a primary key');
    if (droppedRelationWarnings.length > 0) applyCap(69, 'One or more SQL relationships were dropped');
    if (unsafeLifecycleGroups.size > 0) applyCap(69, 'Incompatible referential actions');
    if (cascadeCycleKeys.size > 0) applyCap(79, 'Delete cascade cycle');
    if (incompatibleTypeGroups.length > 0) applyCap(79, 'Incompatible relationship key types');
    const score = Math.min(uncappedScore, scoreCap);
    const capApplied = score < uncappedScore ? { cap: scoreCap, reasons: [...new Set(capReasons)] } : null;
    if (capApplied) {
        findings.unshift({
            code: 'critical_score_cap',
            severity: 'warning',
            title: `Score capped at ${capApplied.cap} by critical findings`,
            detail: capApplied.reasons.join('; '),
        });
    }

    const severityOrder = { warning: 0, suggestion: 1, info: 2 };
    const orderedFindings = findings
        .map((finding, index) => ({ finding, index }))
        .sort((left, right) => (severityOrder[left.finding.severity] ?? 3) - (severityOrder[right.finding.severity] ?? 3) || left.index - right.index)
        .map((item) => item.finding);
    const assessmentCoverage = Math.round(applicableWeight);

    return {
        score,
        scoreVersion: SCORE_VERSION,
        label: scoreLabel(score, true),
        summary: scoreSummary(score, true, capApplied),
        assessmentCoverage,
        categories,
        findings: orderedFindings,
        capApplied,
        stats: {
            tableCount,
            columnCount,
            applicableCriteria: applicableCategories.length,
            totalCriteria: categories.length,
            uncappedScore,
            tablesWithPrimaryKey: tablesWithPrimaryKey.length,
            explicitRelationships: explicitGroups.length,
            acceptedInferredRelationships: acceptedGroups.length,
            missingRelationshipCandidates: pendingCandidates.length,
            rejectedRelationshipCandidates: rejectedCandidateIds.size,
            relationshipTypeMismatches: incompatibleTypeGroups.length,
            uncertainRelationshipTypes: uncertainTypeGroups.length,
            unindexedRelationshipSources: unindexedGroups.length,
            unassessableIndexGroups,
            unsafeLifecycleRelationships: unsafeLifecycleGroups.size,
            cascadeCycleDetected: cascadeCycleKeys.size > 0,
            incoherentCardinalities: incoherentCardinalityGroups.length,
            incoherentColumnDefinitions: columnDefinitionIssues.length,
            eligibleBusinessColumns,
            safeguardedBusinessColumns,
            duplicateTableNames,
            duplicateColumnNames,
            duplicateEnumNames,
            duplicateEnumValues,
            duplicateCompositeNames,
            duplicateCompositeFields,
            blankColumnTypes,
            schemaErrors: schemaErrors.length,
            schemaWarnings: warningDiagnostics.length,
            droppedRelationWarnings: droppedRelationWarnings.length,
        },
    };
}
