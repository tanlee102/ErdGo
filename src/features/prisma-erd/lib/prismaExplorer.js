/** Builds searchable model cards and relation-inspector records from renderer-ready Prisma ERD data. */
const TYPE_LABELS = {
    model: 'Model',
    view: 'View',
    field: 'Field',
    relationField: 'Relation field',
    relation: 'Relation',
    enum: 'Enum',
    enumValue: 'Enum value',
    composite: 'Type',
};

const TYPE_PRIORITY = {
    model: 0,
    view: 1,
    relation: 2,
    relationField: 3,
    field: 4,
    enum: 5,
    enumValue: 6,
    composite: 7,
};

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function compact(values) {
    return values.filter((value) => value !== null && value !== undefined && String(value).trim() !== '');
}

function unique(values) {
    return Array.from(new Set(compact(values).map(String)));
}

function normalizeSearchText(value) {
    return String(value || '').toLowerCase();
}

function joinSearchText(values) {
    return compact(values).join(' ').toLowerCase();
}

function formatColumns(columns) {
    const names = unique(columns);
    return `[${names.join(', ')}]`;
}

function formatActions(actions) {
    const entries = Object.entries(actions || {});
    if (entries.length === 0) return null;
    return entries.map(([name, value]) => `${name}: ${value}`).join(', ');
}

export function formatPrismaCardinality(value) {
    const labels = {
        '1': '1 required',
        '0..1': '0..1 optional',
        n: 'n many',
        '0..n': '0..n optional many',
    };
    return labels[value] || value || 'unknown';
}

function relationKey(relation, index) {
    if (relation?.relationGroup) return `group:${relation.relationGroup}`;
    const prisma = relation?.prisma || {};
    const named = prisma.relationName || relation?.fkName;
    if (prisma.kind === 'explicit') {
        const fieldKey = prisma.relationField || relation?.from?.column || index;
        return `explicit:${named || fieldKey}:${relation.from?.table || ''}.${fieldKey}:${relation.to?.table || ''}.${relation.to?.column || ''}`;
    }
    if (named) return `${prisma.kind || 'relation'}:${named}:${relation.from?.table || ''}:${relation.to?.table || ''}`;
    return `${relation?.from?.table || 'from'}.${relation?.from?.column || index}->${relation?.to?.table || 'to'}.${relation?.to?.column || index}`;
}

function createRelationGroup(relation, index) {
    const prisma = relation.prisma || {};
    const fromColumns = relation.fromColumns || [relation.from?.column];
    const toColumns = relation.toColumns || [relation.to?.column];
    return {
        id: relationKey(relation, index),
        kind: prisma.kind || 'relation',
        fromTable: relation.from?.table || '',
        toTable: relation.to?.table || '',
        fromColumns: unique(fromColumns),
        toColumns: unique(toColumns),
        fromCard: relation.fromCard || '',
        toCard: relation.toCard || '',
        fkName: relation.fkName || '',
        relationName: prisma.relationName || '',
        relationField: prisma.relationField || prisma.fromRelationField || '',
        oppositeRelationField: prisma.toRelationField || '',
        actions: relation.actions || {},
        line: prisma.line || prisma.fromLine || null,
        oppositeLine: prisma.toLine || null,
        relationGroup: relation.relationGroup || null,
        composite: Boolean(relation.composite),
    };
}

function mergeRelationGroup(group, relation) {
    group.fromColumns = unique([...group.fromColumns, relation.from?.column, ...asArray(relation.fromColumns)]);
    group.toColumns = unique([...group.toColumns, relation.to?.column, ...asArray(relation.toColumns)]);
    group.composite = group.composite || Boolean(relation.composite) || group.fromColumns.length > 1 || group.toColumns.length > 1;
    group.actions = { ...group.actions, ...(relation.actions || {}) };
}

function finalizeRelationGroup(group) {
    const isVirtual = group.kind === 'implicit-many-to-many' || group.kind === 'virtual';
    const left = group.relationField ? `${group.fromTable}.${group.relationField}` : `${group.fromTable}.${group.fromColumns.join(', ')}`;
    const right = group.oppositeRelationField ? `${group.toTable}.${group.oppositeRelationField}` : `${group.toTable}.${group.toColumns.join(', ')}`;
    const connector = isVirtual ? '<->' : '->';
    const title = `${left} ${connector} ${right}`;
    const actionText = formatActions(group.actions);
    const name = group.relationName || group.fkName;
    const detail = compact([
        `${formatColumns(group.fromColumns)} -> ${formatColumns(group.toColumns)}`,
        name,
        actionText,
    ]).join(' | ');

    return {
        ...group,
        title,
        detail,
        actionText,
        searchText: joinSearchText([
            title,
            detail,
            group.kind,
            group.fromTable,
            group.toTable,
            group.fromColumns.join(' '),
            group.toColumns.join(' '),
            group.relationField,
            group.oppositeRelationField,
            group.relationName,
            group.fkName,
            actionText,
        ]),
    };
}

export function buildPrismaRelationSummaries(relations = []) {
    const groups = new Map();

    asArray(relations).forEach((relation, index) => {
        if (!relation?.from?.table || !relation?.to?.table) return;
        const key = relationKey(relation, index);
        if (!groups.has(key)) {
            groups.set(key, createRelationGroup(relation, index));
        } else {
            mergeRelationGroup(groups.get(key), relation);
        }
    });

    return Array.from(groups.values()).map(finalizeRelationGroup);
}

function makeItem({ id, type, label, detail, tableName, relationId, line, searchText }) {
    return {
        id,
        type,
        typeLabel: TYPE_LABELS[type] || 'Item',
        label,
        detail: detail || '',
        tableName: tableName || null,
        relationId: relationId || null,
        line: line || null,
        searchText: joinSearchText([label, detail, tableName, searchText]),
    };
}

export function buildPrismaExplorer(schema = {}) {
    const tables = asArray(schema.tables);
    const relations = buildPrismaRelationSummaries(schema.relations);
    const relationById = new Map(relations.map((relation) => [relation.id, relation]));
    const relationsByTable = new Map();
    const items = [];

    relations.forEach((relation) => {
        unique([relation.fromTable, relation.toTable]).forEach((tableName) => {
            if (!tableName) return;
            if (!relationsByTable.has(tableName)) relationsByTable.set(tableName, []);
            relationsByTable.get(tableName).push(relation);
        });
    });

    tables.forEach((table) => {
        const tableKind = table.prisma?.kind === 'view' ? 'view' : 'model';
        const mappedName = table.prisma?.dbName && table.prisma.dbName !== table.name ? `@@map("${table.prisma.dbName}")` : '';
        const schemaName = table.prisma?.schemaName ? `@@schema("${table.prisma.schemaName}")` : '';
        const columns = asArray(table.columns);
        const relationFields = asArray(table.prisma?.relationFields);
        items.push(
            makeItem({
                id: `${tableKind}:${table.name}`,
                type: tableKind,
                label: table.name,
                detail: compact([`${columns.length} fields`, mappedName, schemaName]).join(' | '),
                tableName: table.name,
                line: table.prisma?.line,
                searchText: [table.prisma?.dbName, table.prisma?.schemaName, table.prisma?.annotations?.join(' ')].join(' '),
            }),
        );

        columns.forEach((column) => {
            items.push(
                makeItem({
                    id: `field:${table.name}.${column.name}`,
                    type: 'field',
                    label: `${table.name}.${column.name}`,
                    detail: compact([column.type, column.constraints?.join(' '), column.extras?.join(' ')]).join(' | '),
                    tableName: table.name,
                    line: column.prisma?.line,
                    searchText: [column.prisma?.dbName, column.prisma?.attributes].join(' '),
                }),
            );
        });

        relationFields.forEach((field) => {
            const relation = relations.find((candidate) => {
                if (candidate.fromTable === table.name && (candidate.relationField === field.name || candidate.oppositeRelationField === field.name)) return true;
                if (candidate.toTable === table.name && (candidate.relationField === field.name || candidate.oppositeRelationField === field.name)) return true;
                return false;
            });
            items.push(
                makeItem({
                    id: `relation-field:${table.name}.${field.name}`,
                    type: 'relationField',
                    label: `${table.name}.${field.name}`,
                    detail: compact([field.type, field.targetModel, field.relationName]).join(' | '),
                    tableName: table.name,
                    relationId: relation?.id,
                    line: field.line,
                    searchText: [field.attributes, field.relationName].join(' '),
                }),
            );
        });
    });

    relations.forEach((relation) => {
        items.push(
            makeItem({
                id: `relation:${relation.id}`,
                type: 'relation',
                label: relation.title,
                detail: relation.detail,
                tableName: relation.fromTable,
                relationId: relation.id,
                line: relation.line,
                searchText: relation.searchText,
            }),
        );
    });

    asArray(schema.enums).forEach((item) => {
        items.push(
            makeItem({
                id: `enum:${item.name}`,
                type: 'enum',
                label: item.name,
                detail: `${asArray(item.values).length} values`,
                line: item.prisma?.line,
                searchText: [item.prisma?.dbName, asArray(item.values).join(' ')].join(' '),
            }),
        );
        asArray(item.prisma?.values).forEach((value) => {
            items.push(
                makeItem({
                    id: `enum-value:${item.name}.${value.name}`,
                    type: 'enumValue',
                    label: `${item.name}.${value.name}`,
                    detail: value.dbName && value.dbName !== value.name ? `@map("${value.dbName}")` : '',
                    line: value.line || item.prisma?.line,
                    searchText: value.dbName,
                }),
            );
        });
    });

    asArray(schema.composites).forEach((item) => {
        items.push(
            makeItem({
                id: `type:${item.name}`,
                type: 'composite',
                label: item.name,
                detail: `${asArray(item.fields).length} fields`,
                line: item.prisma?.line,
                searchText: asArray(item.fields)
                    .map((field) => `${field.name} ${field.type}`)
                    .join(' '),
            }),
        );
    });

    return {
        items,
        relations,
        relationById,
        relationsByTable,
    };
}

function scoreItem(item, tokens) {
    const label = normalizeSearchText(item.label);
    const detail = normalizeSearchText(item.detail);
    const searchText = item.searchText || '';
    let score = TYPE_PRIORITY[item.type] ?? 20;

    for (const token of tokens) {
        if (!token) continue;
        if (label === token) {
            score += 0;
        } else if (label.startsWith(token)) {
            score += 2;
        } else if (label.includes(token)) {
            score += 6;
        } else if (detail.includes(token)) {
            score += 10;
        } else if (searchText.includes(token)) {
            score += 14;
        } else {
            return null;
        }
    }

    return score;
}

export function searchPrismaExplorerItems(items = [], query = '', limit = 12) {
    const tokens = normalizeSearchText(query).split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];

    return asArray(items)
        .map((item, index) => {
            const score = scoreItem(item, tokens);
            return score === null ? null : { item, score, index };
        })
        .filter(Boolean)
        .sort((left, right) => left.score - right.score || left.item.label.localeCompare(right.item.label) || left.index - right.index)
        .slice(0, Math.max(0, limit))
        .map((entry) => entry.item);
}

export function getPrismaExplorerRelationsForTable(explorer, tableName) {
    if (!explorer?.relationsByTable || !tableName) return [];
    return explorer.relationsByTable.get(tableName) || [];
}
