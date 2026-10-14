/** Deterministic Chen/EER graph -> relational model -> dialect DDL; never edits the graph. */
import { getDraftAttributeTrees } from './erdDraftModelTools';
import { isDraftAttributeShape, isDraftEntityShape, isDraftRelationshipShape, normalizeDraftEdgeSemantics, validateErdDraftGraph } from './erdDraftSemantics';
import { draftSqlIdentifier, quoteDraftSqlIdentifier, resolveDraftSqlType, validateDraftSqlTable } from './erdDraftSqlDialect';

const label = node => String(node?.data?.label || node?.id || 'Untitled').replace(/\s+/g, ' ').trim();
const cleanComment = value => Array.from(String(value || ''), char => char.charCodeAt(0) < 32 || /[\u2028\u2029]/.test(char) ? ' ' : char).join('').trim();
const sorted = items => [...items].sort((a, b) => String(a.id).localeCompare(String(b.id), 'en'));

function allocator() {
    const used = new Set();
    return (name, fallback) => {
        const base = draftSqlIdentifier(name, fallback);
        let result = base;
        for (let n = 2; used.has(result); n++) {
            const suffix = `_${n}`;
            result = `${base.slice(0, 63 - suffix.length)}${suffix}`;
        }
        used.add(result);
        return result;
    };
}

/** Classic labels count the opposite role; min-max labels count this role's participations. */
function readCardinality(edge, end) {
    const data = normalizeDraftEdgeSemantics(edge.data);
    const mandatory = data.lineCount === 'double';
    if (data.cardinalityMode !== 'manual' && !data[`${end}CardinalityEnabled`]) return { max: null, min: mandatory ? 1 : 0, mode: 'classic' };
    if (data.cardinalityMode === 'minmax') {
        const bound = data[`${end}Max`].replace(/^0+(?=\d)/, '');
        return { max: bound === '1' ? 'one' : 'many', min: Number(data[`${end}Min`]), minExplicit: true, bound, mode: 'minmax' };
    }
    if (data.cardinalityMode === 'classic') return { max: data[`${end}Max`] === '1' ? 'one' : 'many', min: mandatory ? 1 : 0, mode: 'classic' };
    const text = data[`${end}Label`].trim().toUpperCase();
    const interval = text.match(/^\(\s*(\d+)\s*,\s*(\d+|N|M|\*)\s*\)$/);
    if (interval && (['N', 'M', '*'].includes(interval[2]) || Number(interval[1]) <= Number(interval[2]))) {
        const bound = interval[2].replace(/^0+(?=\d)/, '');
        return { max: bound === '1' ? 'one' : 'many', min: Number(interval[1]), minExplicit: true, bound, mode: 'minmax' };
    }
    // Old starter labels use maximum,minimum. Free-form prose is intentionally not parsed.
    const classic = text.match(/^(1|N|M|\*)(?:\s*,\s*(0|1))?$/);
    return { max: classic ? (classic[1] === '1' ? 'one' : 'many') : null, min: classic?.[2] ? Number(classic[2]) : mandatory ? 1 : 0, minExplicit: Boolean(classic?.[2]), mode: 'classic' };
}

export function convertErdDraftToSql(graph, rawOptions = {}) {
    const options = { dialect: 'postgres', missingKeys: 'generate', derivedAttributes: 'omit', relationshipTables: false, includeComments: true, attributeTypes: {}, decisions: {}, ...rawOptions };
    const dialect = ['sqlite', 'postgres', 'mysql', 'mssql'].includes(options.dialect) ? options.dialect : 'postgres';
    const nodes = sorted((Array.isArray(graph?.nodes) ? graph.nodes : []).filter(node => node && node.id != null && node.data).map(node => ({ ...node, id: String(node.id) })));
    const decisions = options.decisions || {};
    const issues = [];
    const choices = [];
    const mappings = [];
    const tables = [];
    const tableByNode = new Map();
    const byId = new Map(nodes.map(node => [String(node.id), node]));
    const tableName = allocator();
    const objectName = allocator();
    const report = (code, message, nodeId, level = 'warning') => {
        if (!issues.some(item => item.code === code && item.nodeId === nodeId && item.message === message)) issues.push({ code, message, nodeId, level });
    };
    const choose = (key, title, entries, kind = 'select') => {
        const value = decisions[key];
        const valid = kind === 'text' ? typeof value === 'string' && value.trim() : entries.some(entry => entry.value === value);
        choices.push({ key, title, options: entries, kind, value: valid ? value : '', resolved: Boolean(valid) });
        return valid ? value : null;
    };
    const checkParticipation = (bounds, participant, relationship) => {
        if (bounds.bound === '0') report('zero-participation-maximum', `“${label(participant)}” has maximum participation 0 in “${label(relationship)}”. Remove that participation or change its bound before converting.`, relationship.id, 'error');
        if (bounds.mode === 'minmax' && (bounds.min > 1 || (bounds.bound && !['0', '1', 'N', 'M', '*'].includes(bounds.bound)))) report('participation-bounds-enforcement', `Exact participation counts on “${label(relationship)}” need application rules or triggers.`, relationship.id);
    };
    if (byId.size !== nodes.length) report('duplicate-node-id', 'Two shapes have the same ID. Repair the diagram before converting.', null, 'error');
    const knownShapes = new Set(['entity', 'weakEntity', 'relationship', 'identifyingRelationship', 'isa', 'category', 'aggregation', 'note']);
    for (const node of nodes) if (!knownShapes.has(node.data.shape) && !isDraftAttributeShape(node.data.shape)) report('unknown-shape', `“${label(node)}” has an unsupported notation. Choose a supported shape before converting.`, node.id, 'error');
    const edges = sorted((Array.isArray(graph?.edges) ? graph.edges : []).filter(Boolean))
        .filter(edge => edge.data?.connectionKind !== 'annotation').map(edge => {
            const data = normalizeDraftEdgeSemantics(edge.data);
            for (const [shape, field, roles] of [['isa', 'isaRole', ['supertype', 'subtype']], ['category', 'categoryRole', ['member', 'result']]]) {
                const branch = [byId.get(String(edge.source)), byId.get(String(edge.target))].find(node => node?.data?.shape === shape);
                if (!branch || data[field] !== 'unspecified') continue;
                const entity = byId.get(String(edge.source) === String(branch.id) ? String(edge.target) : String(edge.source));
                if (!isDraftEntityShape(entity?.data.shape)) continue;
                const role = choose(`${field}:${edge.id}`, `${label(branch)}: role of ${label(entity)}`, roles.map(value => ({ value, label: { supertype: 'Supertype', subtype: 'Subtype', member: 'Union member', result: 'Resulting subtype' }[value] })));
                if (role) data[field] = role;
            }
            return { ...edge, source: String(edge.source), target: String(edge.target), data };
        });
    const adjacency = new Map(nodes.map(node => [String(node.id), []]));
    if (new Set(edges.map(edge => String(edge.id))).size !== edges.length) report('duplicate-edge-id', 'Two semantic connectors have the same ID. Repair the diagram before converting.', null, 'error');
    for (const edge of edges) {
        if (!byId.has(edge.source) || !byId.has(edge.target)) report('dangling-connector', 'A semantic connector has a missing endpoint.', String(edge.id), 'error');
        adjacency.get(edge.source)?.push(edge);
        adjacency.get(edge.target)?.push(edge);
    }
    const other = (edge, id) => byId.get(edge.source === String(id) ? edge.target : edge.source);
    const connections = node => adjacency.get(String(node.id)) || [];
    const structuralChoicesPending = choices.some(choice => !choice.resolved);
    for (const issue of validateErdDraftGraph(nodes, edges)) {
        if (issue.code.endsWith('role-unspecified') || (structuralChoicesPending && ['isa-needs-supertype-and-subtype', 'category-needs-union-members'].includes(issue.code))) continue;
        if (issue.code === 'recursive-relationship-duplicate-role') continue; // Export-only role choices below resolve these without changing saved data.
        if (issue.code === 'duplicate-semantic-connection') {
            const edge = edges.find(edge => String(edge.id) === issue.edgeId);
            const endpoints = [byId.get(edge?.source), byId.get(edge?.target)];
            if (endpoints.some(node => isDraftRelationshipShape(node?.data.shape)) && endpoints.some(node => isDraftEntityShape(node?.data.shape))) continue;
        }
        const blocking = ['attribute-multiple-owners', 'attribute-is-disconnected', 'duplicate-semantic-connection', 'partial-key-missing-weak-entity', 'isa-duplicate-entity', 'category-duplicate-entity'].includes(issue.code);
        report(issue.code, issue.message, issue.nodeId || issue.edgeId, blocking || issue.level === 'error' ? 'error' : 'warning');
    }
    const trees = getDraftAttributeTrees(nodes, edges);
    for (const node of nodes.filter(node => isDraftAttributeShape(node.data.shape))) {
        if (!trees.ownerByAttribute.has(node.id)) report('invalid-attribute-tree', `Attribute “${label(node)}” must belong to one acyclic attribute tree with one owner.`, String(node.id), 'error');
    }
    const attributes = new Map();
    const multivalues = new Map();
    const roots = owner => (trees.attributesByOwner.get(owner.id) || []).filter(id => trees.parentByAttribute.get(id) === owner.id);
    const children = id => (trees.attributesByOwner.get(trees.ownerByAttribute.get(id)) || []).filter(child => trees.parentByAttribute.get(child) === id);
    const descriptor = (node, path, key, partial) => ({ node, name: path.map(label).join('_'), key, partial });
    for (const owner of nodes.filter(node => isDraftEntityShape(node.data.shape) || isDraftRelationshipShape(node.data.shape))) {
        const ordinary = [];
        const multiple = [];
        const visit = (id, path = [], inheritedKey = false, inheritedPartial = false, destination = ordinary, insideMultiple = false) => {
            const node = byId.get(String(id));
            if (!node) return;
            const shape = node.data.shape;
            const nextPath = [...path, node];
            const key = inheritedKey || shape === 'keyAttribute';
            const partial = inheritedPartial || shape === 'partialKeyAttribute';
            const descendants = children(id);
            if (shape === 'derivedAttribute' && options.derivedAttributes !== 'store') {
                report('derived-attribute-omitted', `Derived attribute “${label(node)}” is documented, not stored${node.data.derivation ? `: ${node.data.derivation}` : '.'}`, String(node.id));
                return;
            }
            if (shape === 'derivedAttribute') report('derived-attribute-stored', `“${label(node)}” is stored as an ordinary column; its calculation must be maintained by your application.`, String(node.id));
            if (shape === 'multivaluedAttribute') {
                if (insideMultiple || key || partial) { report('invalid-multivalued-key', `“${label(node)}” cannot be a key or nested multivalued group.`, String(node.id), 'error'); return; }
                const values = [];
                if (descendants.length) descendants.forEach(child => visit(child, [], false, false, values, true));
                else values.push(descriptor(node, [node], false, false));
                if (!values.length) report('empty-multivalued-values', `“${label(node)}” needs at least one stored value attribute. Include a value or choose to store its derived attributes.`, String(node.id), 'error');
                multiple.push({ node, name: nextPath.map(label).join('_'), values });
                return;
            }
            if (shape === 'compositeAttribute') {
                if (!descendants.length) report('empty-composite', `Composite attribute “${label(node)}” needs child attributes.`, String(node.id), 'error');
                descendants.forEach(child => visit(child, nextPath, key, partial, destination, insideMultiple));
            } else if (descendants.length) report('non-composite-parent', `“${label(node)}” has child attributes but is not a composite or multivalued attribute.`, String(node.id), 'error');
            else destination.push(descriptor(node, nextPath, key, partial));
        };
        roots(owner).forEach(id => visit(id));
        attributes.set(String(owner.id), ordinary);
        if (isDraftRelationshipShape(owner.data.shape) && ordinary.some(attr => attr.key || attr.partial)) report('relationship-key-attribute', `“${label(owner)}” is identified by its participant keys. Change relationship key attributes to ordinary attributes before converting.`, owner.id, 'error');
        multivalues.set(String(owner.id), multiple);
    }
    const makeTable = (name, sourceId, kind) => {
        const table = { name: tableName(name, 'table'), sourceId, kind, columns: [], primaryKey: [], foreignKeys: [], unique: [], checks: [], comments: [], allocateColumn: allocator() };
        tables.push(table);
        return table;
    };
    const addColumn = (table, name, type, nullable, sourceId) => {
        const result = { name: table.allocateColumn(name, 'column'), type, nullable, sourceId };
        table.columns.push(result);
        return result.name;
    };
    const addAttribute = (table, attr, forceKey = false) => {
        const type = resolveDraftSqlType(attr.node.data.domain, options.attributeTypes?.[attr.node.id], dialect, forceKey || attr.key || attr.partial);
        if (type.assumed) report('attribute-type-assumed', `“${label(attr.node)}” uses ${type.type}. ${type.reason || 'No SQL domain was specified; review its column type.'}`, String(attr.node.id));
        const name = addColumn(table, attr.name, type.type, !(forceKey || attr.key || attr.partial), String(attr.node.id));
        if (type.boolean && ['sqlite', 'mysql'].includes(dialect)) table.checks.push({ kind: 'boolean', columns: [name] });
        if (attr.node.data.description) table.comments.push(`${name}: ${attr.node.data.description}`);
        return name;
    };
    const addUnique = (table, columns) => {
        if (columns.length && !table.unique.some(item => JSON.stringify(item) === JSON.stringify(columns))) table.unique.push(columns);
    };
    const copyKey = (table, target, prefix, nullable = false) => {
        if (!target?.primaryKey.length) return [];
        const columns = target.primaryKey.map(name => {
            const original = target.columns.find(column => column.name === name);
            return addColumn(table, `${prefix}_${name}`, original.type, nullable, null);
        });
        table.foreignKeys.push({ columns, target: target.name, references: [...target.primaryKey], nullable });
        // Composite optional references must be all NULL or all populated on every dialect.
        if (nullable && columns.length > 1) table.checks.push({ kind: 'all-or-none', columns });
        return columns;
    };

    const entities = nodes.filter(node => isDraftEntityShape(node.data.shape));
    if (!entities.length) report('no-entities', 'Add an entity before converting the diagram.', null, 'error');
    const inheritance = new Map();
    const categories = [];
    for (const node of nodes.filter(node => ['isa', 'category'].includes(node.data.shape))) {
        if (node.data.shape === 'isa') {
            const parentEdges = connections(node).filter(edge => edge.data.isaRole === 'supertype');
            const childEdges = connections(node).filter(edge => edge.data.isaRole === 'subtype');
            if (parentEdges.length === 1) for (const edge of childEdges) {
                const child = other(edge, node.id);
                const parent = other(parentEdges[0], node.id);
                if (!child || !parent) continue;
                inheritance.set(String(child.id), [...(inheritance.get(String(child.id)) || []), parent]);
            }
            report('specialization-enforcement', `“${label(node)}” uses shared primary keys and subtype foreign keys. ${node.data.specializationConstraint === 'overlapping' ? 'Overlapping' : 'Disjoint'} / ${node.data.specializationCompleteness === 'total' ? 'total' : 'partial'} membership needs application rules or triggers.`, String(node.id));
        } else {
            const result = connections(node).find(edge => edge.data.categoryRole === 'result');
            const members = connections(node).filter(edge => edge.data.categoryRole === 'member').map(edge => other(edge, node.id)).filter(Boolean);
            if (result && members.length >= 2) categories.push({ node, result: other(result, node.id), members });
        }
    }
    const identifying = new Map();
    const identifyingNodes = new Set();
    for (const relationship of nodes.filter(node => node.data.shape === 'identifyingRelationship')) {
        const participants = connections(relationship).filter(edge => isDraftEntityShape(other(edge, relationship.id)?.data.shape));
        const weak = participants.filter(edge => other(edge, relationship.id)?.data.shape === 'weakEntity');
        if (weak.length !== 1 || participants.length < 2) { report('ambiguous-weak-owner', `“${label(relationship)}” needs exactly one weak entity and at least one owner.`, String(relationship.id), 'error'); continue; }
        const child = other(weak[0], relationship.id);
        const owners = participants.filter(edge => edge !== weak[0]).map(edge => {
            const owner = other(edge, relationship.id);
            const end = edge.source === String(owner.id) ? 'source' : 'target';
            let role = edge.data[`${end}Role`].trim();
            if (!role && participants.filter(edge => String(other(edge, relationship.id)?.id) === String(owner.id)).length > 1) role = choose(`role:${edge.id}`, `${label(relationship)}: name for owner role ${edge.id}`, [], 'text') || '';
            return { node: owner, edge, role, bounds: readCardinality(edge, end) };
        });
        const ownerRoles = new Set();
        for (const owner of owners) {
            const role = `${owner.node.id}:${draftSqlIdentifier(owner.role || label(owner.node))}`;
            if (ownerRoles.has(role) && owner.role) report('duplicate-export-role', `“${label(relationship)}” needs distinct owner role names after SQL name normalization.`, String(relationship.id), 'error');
            ownerRoles.add(role);
        }
        const weakEnd = weak[0].source === String(child.id) ? 'source' : 'target';
        const weakBounds = readCardinality(weak[0], weakEnd);
        checkParticipation(weakBounds, child, relationship);
        for (const owner of owners) {
            checkParticipation(owner.bounds, owner.node, relationship);
            if (owner.bounds.mode === 'classic' && owner.bounds.max === 'many') report('weak-ownership-cardinality', `Each ${label(child)} must have one owner per role in “${label(relationship)}”. Its cardinality allows multiple owners; fix the identifying relationship before converting.`, String(relationship.id), 'error');
        }
        if (weakBounds.mode === 'minmax' && weakBounds.max === 'many') report('weak-ownership-cardinality', `Each ${label(child)} must participate exactly once in “${label(relationship)}”. Fix its identifying cardinality before converting.`, String(relationship.id), 'error');
        if (weakBounds.minExplicit && weakBounds.min === 0) report('weak-ownership-optional', `“${label(child)}” cannot have optional identifying ownership. Set its minimum participation to 1 before converting.`, String(relationship.id), 'error');
        const perOwner = owners.length === 1 && owners[0].bounds.mode === 'minmax' ? owners[0].bounds.max : null;
        const perTuple = weakBounds.mode === 'classic' ? weakBounds.max : null;
        if (perOwner && perTuple && perOwner !== perTuple) report('conflicting-cardinality-notations', `Classic and min-max labels disagree about the maximum dependents per owner in “${label(relationship)}”. Align the labels before converting.`, String(relationship.id), 'error');
        let childMaximum = perOwner || perTuple;
        if (!childMaximum && (owners.length === 1 || weakBounds.mode === 'classic')) childMaximum = choose(`weakMaximum:${relationship.id}`, `${label(relationship)}: maximum ${label(child)} per ${owners.length === 1 ? label(owners[0].node) : 'combination of owner roles'}`, [{ value: 'one', label: 'One (1)' }, { value: 'many', label: 'Many (N)' }]);
        identifying.set(String(child.id), [...(identifying.get(String(child.id)) || []), { relationship, owners, childMaximum }]);
        identifyingNodes.add(String(relationship.id));
    }
    const buildingEntities = new Set();
    const builtEntities = new Set();
    const buildEntity = node => {
        const id = String(node.id);
        if (builtEntities.has(id)) return tableByNode.get(id);
        if (buildingEntities.has(id)) { report('identity-cycle', `“${label(node)}” participates in an inheritance or weak-identity cycle.`, id, 'error'); return null; }
        buildingEntities.add(id);
        let table = tableByNode.get(id);
        if (!table) { table = makeTable(label(node), id, node.data.shape); tableByNode.set(id, table); }
        if (node.data.description) table.comments.push(node.data.description);
        const ownKeys = [];
        const partialKeys = [];
        for (const attr of attributes.get(id) || []) {
            const name = addAttribute(table, attr);
            if (attr.key) ownKeys.push(name);
            if (attr.partial) partialKeys.push(name);
        }
        const parents = inheritance.get(id) || [];
        if (parents.length) {
            let inherited = [];
            for (const parent of parents) {
                const parentTable = buildEntity(parent);
                if (!parentTable?.primaryKey.length) continue;
                if (!inherited.length) inherited = copyKey(table, parentTable, parentTable.name);
                else {
                    const types = inherited.map(name => table.columns.find(column => column.name === name).type);
                    const parentTypes = parentTable.primaryKey.map(name => parentTable.columns.find(column => column.name === name).type);
                    if (JSON.stringify(types) !== JSON.stringify(parentTypes)) report('incompatible-inherited-keys', `“${label(node)}” has parents with incompatible identity types. Align their primary keys before conversion.`, id, 'error');
                    else table.foreignKeys.push({ columns: [...inherited], target: parentTable.name, references: [...parentTable.primaryKey], nullable: false });
                }
            }
            table.primaryKey = inherited;
            addUnique(table, ownKeys);
            if (parents.length > 1) report('multiple-inheritance-identity', `All parents of “${label(node)}” must share the same identity values; the subtype key references each parent.`, id);
        } else if (node.data.shape === 'weakEntity') {
            const ownerColumns = [];
            for (const { relationship, owners, childMaximum } of identifying.get(id) || []) {
                const groupKeys = [];
                for (const owner of owners) {
                    const target = buildEntity(owner.node);
                    const columns = copyKey(table, target, `${owner.role || target?.name || 'owner'}_${label(relationship)}`);
                    ownerColumns.push(...columns);
                    groupKeys.push(...columns);
                    const bounds = owner.bounds;
                    if (bounds.mode === 'minmax' && bounds.max === 'one') addUnique(table, columns);
                    if (bounds.min > 0) report('weak-owner-participation', `Every ${label(owner.node)} must own a ${label(node)}; that requirement needs application rules or triggers.`, id);
                }
                if (childMaximum === 'one') addUnique(table, groupKeys);
                for (const attr of attributes.get(String(relationship.id)) || []) addAttribute(table, attr);
                tableByNode.set(String(relationship.id), table);
                mappings.push({ sourceId: String(relationship.id), label: label(relationship), target: table.name, detail: 'Owner foreign keys form the weak entity’s composite primary key.' });
            }
            if (!partialKeys.length || !ownerColumns.length) report('weak-identity-incomplete', `“${label(node)}” needs owner keys and a partial key; a surrogate cannot replace weak identity.`, id, 'error');
            table.primaryKey = [...ownerColumns, ...partialKeys];
            addUnique(table, ownKeys);
        } else if (ownKeys.length) table.primaryKey = ownKeys;
        else if (options.missingKeys === 'require') report('entity-key-missing', `“${label(node)}” needs a key attribute, or enable generated keys.`, id, 'error');
        else {
            // BIGINT avoids SQLite's special INTEGER PRIMARY KEY rowid alias;
            // generated missing keys consistently require explicit inserted values.
            table.primaryKey = [addColumn(table, 'id', 'BIGINT', false, null)];
            report('surrogate-key-added', `“${label(node)}” has no key attribute; an integer primary key was added. Supply its values when inserting rows.`, id);
        }
        if (node.data.shape === 'weakEntity' && parents.length) report('weak-subtype-identity', `“${label(node)}” combines weak identity with subtype identity. Resolve that identity strategy before converting.`, id, 'error');
        mappings.push({ sourceId: id, label: label(node), target: table.name, detail: parents.length ? 'Subtype table with an inherited primary key.' : node.data.shape === 'weakEntity' ? 'Owner key + partial key.' : 'Entity table.' });
        buildingEntities.delete(id);
        builtEntities.add(id);
        return table;
    };
    entities.forEach(buildEntity);

    for (const { node, result, members } of categories) {
        const table = tableByNode.get(String(result?.id));
        if (!table) continue;
        const groups = members.map(member => copyKey(table, tableByNode.get(String(member.id)), `${label(node)}_${label(member)}`, true)).filter(group => group.length);
        for (const group of groups) addUnique(table, group);
        table.checks.push({ kind: 'exactly-one', groups });
        tableByNode.set(String(node.id), table);
        mappings.push({ sourceId: String(node.id), label: label(node), target: table.name, detail: 'Union subtype with exactly one populated member reference.' });
        if (node.data.categoryCompleteness === 'total') report('category-total-enforcement', `Total category “${label(node)}” needs application rules or triggers to cover every member row.`, String(node.id));
    }

    const aggregationTargets = new Map();
    const reified = new Set();
    for (const node of nodes.filter(node => node.data.shape === 'aggregation')) {
        const candidates = connections(node).map(edge => other(edge, node.id)).filter(node => isDraftRelationshipShape(node?.data.shape));
        const chosen = choose(`aggregation:${node.id}`, `Which relationship is represented by ${label(node)}?`, candidates.map(candidate => ({ value: String(candidate.id), label: label(candidate) })));
        if (chosen) { aggregationTargets.set(String(node.id), chosen); reified.add(chosen); }
    }
    const buildingRelationships = new Set();
    const builtRelationships = new Set();
    const resolveParticipant = node => {
        if (node?.data.shape === 'aggregation') {
            const target = aggregationTargets.get(String(node.id));
            return target ? buildRelationship(byId.get(target)) : null;
        }
        return tableByNode.get(String(node?.id));
    };
    const buildRelationship = relationship => {
        const id = String(relationship.id);
        if (identifyingNodes.has(id) || builtRelationships.has(id)) return tableByNode.get(id);
        if (buildingRelationships.has(id)) { report('aggregation-cycle', `Aggregation around “${label(relationship)}” contains a cycle.`, id, 'error'); return null; }
        buildingRelationships.add(id);
        const participants = connections(relationship).filter(edge => {
            const node = other(edge, id);
            return isDraftEntityShape(node?.data.shape) || ['category', 'aggregation'].includes(node?.data.shape);
        }).filter(edge => {
            const node = other(edge, id);
            return node?.data.shape !== 'aggregation' || aggregationTargets.get(String(node.id)) !== id;
        }).map(edge => {
            const node = other(edge, id);
            const end = edge.source === String(node.id) ? 'source' : 'target';
            const cardinality = readCardinality(edge, end);
            checkParticipation(cardinality, node, relationship);
            let role = edge.data[`${end}Role`].trim();
            const repeated = connections(relationship).filter(otherEdge => String(other(otherEdge, id)?.id) === String(node.id)).length > 1;
            if (repeated && !role) role = choose(`role:${edge.id}`, `${label(relationship)}: name for role ${edge.id}`, [], 'text') || '';
            return { node, edge, role, cardinality, table: resolveParticipant(node) };
        });
        participants.forEach((part, index) => {
            if (part.cardinality.max) return;
            const opposite = participants.length === 2 ? participants[1 - index] : null;
            if (part.cardinality.mode === 'classic' && opposite?.cardinality.mode === 'minmax' && opposite.cardinality.max) part.cardinality.max = opposite.cardinality.max;
            else part.cardinality.max = choose(`cardinality:${part.edge.id}`, `${label(relationship)}: maximum ${label(part.node)} per combination of the other roles`, [{ value: 'one', label: 'One (1)' }, { value: 'many', label: 'Many (N)' }]);
        });
        if (participants.length < 2) report('relationship-incomplete', `“${label(relationship)}” needs at least two participating roles after aggregation mapping.`, id, 'error');
        const seenRoles = new Set();
        for (const part of participants) {
            const role = `${part.node.id}:${draftSqlIdentifier(part.role || label(part.node))}`;
            if (seenRoles.has(role) && part.role) report('duplicate-export-role', `“${label(relationship)}” needs distinct role names after SQL name normalization.`, id, 'error');
            seenRoles.add(role);
        }
        // For binary Chen, classic maxima and per-entity min-max bounds face opposite directions.
        const originalBounds = participants.map(part => ({ ...part.cardinality }));
        const limits = participants.map((part, index) => {
            if (participants.length !== 2) return null;
            const opposite = participants[1 - index];
            const own = originalBounds[index].mode === 'minmax' ? originalBounds[index].max : null;
            const inverse = originalBounds[1 - index].mode === 'classic' ? originalBounds[1 - index].max : null;
            if (own && inverse && own !== inverse) report('conflicting-cardinality-notations', `Classic and min-max labels disagree about the maximum relationships per ${label(part.node)} in “${label(relationship)}”. Align the labels before converting.`, id, 'error');
            if (own || inverse) return own || inverse;
            if (!part.cardinality.max || !opposite.cardinality.max) return null;
            const limit = choose(`participation:${part.edge.id}`, `${label(relationship)}: maximum relationships per ${label(part.node)}`, [{ value: 'one', label: 'One (1)' }, { value: 'many', label: 'Many (N)' }]);
            if (limit) part.cardinality = { ...part.cardinality, max: limit, mode: 'minmax' };
            return limit;
        });
        let holder = null;
        const hasMultivalues = (multivalues.get(id) || []).length > 0;
        // Value rows must reference the relationship tuple itself, not just an entity
        // that may have no relationship (or may later change its related entity).
        let junction = options.relationshipTables || participants.length !== 2 || reified.has(id) || hasMultivalues;
        if (hasMultivalues && participants.length === 2 && !options.relationshipTables && !reified.has(id)) report('multivalued-relationship-reified', `“${label(relationship)}” uses a separate relationship table so its multivalued attributes reference an existing participant tuple.`, id);
        if (!junction && limits.every(limit => limit === 'one')) {
            const required = participants.map(part => part.cardinality.min > 0);
            if (required[0] !== required[1]) holder = required[0] ? 0 : 1;
            else {
                const chosen = choose(`holder:${id}`, `${label(relationship)}: where should the one-to-one foreign key live?`, participants.map((part, index) => ({ value: String(index), label: `${label(part.node)}${part.role ? ` (${part.role})` : ''}` })).concat({ value: 'junction', label: 'Separate relationship table' }));
                if (chosen === 'junction') junction = true;
                else if (chosen !== null) holder = Number(chosen);
            }
        } else if (!junction && limits.includes('one')) holder = limits.indexOf('one');
        else junction = true;
        const relationshipAttributes = attributes.get(id) || [];
        let table;
        if (!junction && holder !== null && participants.every(part => part.table?.primaryKey.length)) {
            const owner = participants[holder];
            const target = participants[1 - holder];
            table = owner.table;
            const foreignColumns = copyKey(table, target.table, `${label(relationship)}_${target.role || target.table.name}`, owner.cardinality.min === 0);
            if (limits.every(limit => limit === 'one')) addUnique(table, foreignColumns);
            const transferred = relationshipAttributes.map(attr => addAttribute(table, { ...attr, name: `${label(relationship)}_${attr.name}` }));
            if (owner.cardinality.min === 0 && transferred.length) table.checks.push({ kind: 'absent-relationship', reference: foreignColumns, attributes: transferred });
            if (target.cardinality.min > 0) report('mandatory-inverse-enforcement', `Every ${label(target.node)} must participate in “${label(relationship)}”; that inverse requirement needs application rules or triggers.`, id);
            mappings.push({ sourceId: id, label: label(relationship), target: table.name, detail: `${limits.every(limit => limit === 'one') ? 'Unique foreign key' : 'Foreign key'} to ${target.table.name}${owner.cardinality.min > 0 ? ' (required)' : ' (optional)'}.` });
        } else {
            table = makeTable(label(relationship), id, 'relationship');
            const groups = participants.map(part => copyKey(table, part.table, part.role || label(part.node)));
            table.primaryKey = groups.flat();
            for (const attr of relationshipAttributes) addAttribute(table, attr);
            participants.forEach((part, index) => {
                if (participants.length === 2 ? limits[index] === 'one' : part.cardinality.max === 'one') {
                    // N-ary classic 1 is a functional dependency of all other roles.
                    const columns = participants.length === 2 || part.cardinality.mode === 'minmax' ? groups[index] : groups.filter((_, i) => i !== index).flat();
                    addUnique(table, columns);
                }
                if (part.cardinality.min > 0) report('junction-participation-enforcement', `Mandatory participation of ${label(part.node)} in “${label(relationship)}” needs application rules or triggers.`, id);
            });
            if (!table.primaryKey.length) report('relationship-key-incomplete', `“${label(relationship)}” has no resolved participant keys.`, id, 'error');
            mappings.push({ sourceId: id, label: label(relationship), target: table.name, detail: `${participants.length > 2 ? 'N-ary' : 'Junction'} table with participant foreign keys and a composite primary key.` });
        }
        if (relationship.data.description) table.comments.push(relationship.data.description);
        tableByNode.set(id, table);
        buildingRelationships.delete(id);
        builtRelationships.add(id);
        return table;
    };
    nodes.filter(node => isDraftRelationshipShape(node.data.shape)).forEach(buildRelationship);

    for (const [ownerId, groups] of multivalues) {
        const ownerTable = tableByNode.get(ownerId);
        for (const group of groups) {
            if (!ownerTable?.primaryKey.length) continue;
            const table = makeTable(`${ownerTable.name}_${group.name}`, String(group.node.id), 'multivalued');
            const ownerKeys = copyKey(table, ownerTable, ownerTable.name);
            const valueKeys = group.values.map(attr => addAttribute(table, attr, true));
            table.primaryKey = [...ownerKeys, ...valueKeys];
            mappings.push({ sourceId: String(group.node.id), label: label(group.node), target: table.name, detail: 'Multivalued attribute table: owner key + value key.' });
        }
    }
    for (const table of tables) {
        for (const issue of validateDraftSqlTable(table, dialect)) report(issue.code, issue.message, issue.sourceId || table.sourceId, 'error');
        for (const name of [...table.primaryKey, ...table.unique.flat()]) {
            const column = table.columns.find(column => column.name === name);
            if (!column) { report('missing-key-column', `A key on ${table.name} has no matching column.`, table.sourceId, 'error'); continue; }
            if ((dialect === 'mysql' && /^(TEXT|BLOB|JSON)/.test(column.type)) || (dialect === 'mssql' && /MAX\)|^(TEXT|BLOB)/.test(column.type)) || (dialect === 'postgres' && column.type === 'JSON')) report('unindexable-key-type', `${table.name}.${name} uses ${column.type}, which cannot be used in this key. Choose a bounded text or scalar column type.`, column.sourceId || table.sourceId, 'error');
        }
    }
    const canConvert = tables.length > 0 && !issues.some(issue => issue.level === 'error') && choices.every(choice => choice.resolved);
    const q = value => quoteDraftSqlIdentifier(value, dialect);
    const list = columns => columns.map(q).join(', ');
    const checkSql = check => {
        if (check.kind === 'boolean') return `(${q(check.columns[0])} IN (0, 1))`;
        if (check.kind === 'all-or-none') return `((${check.columns.map(name => `${q(name)} IS NULL`).join(' AND ')}) OR (${check.columns.map(name => `${q(name)} IS NOT NULL`).join(' AND ')}))`;
        if (check.kind === 'exactly-one') return `(${check.groups.map(group => `(CASE WHEN ${group.map(name => `${q(name)} IS NOT NULL`).join(' AND ')} THEN 1 ELSE 0 END)`).join(' + ')} = 1)`;
        return `(${q(check.reference[0])} IS NOT NULL OR (${check.attributes.map(name => `${q(name)} IS NULL`).join(' AND ')}))`;
    };
    const fkSql = fk => `FOREIGN KEY (${list(fk.columns)}) REFERENCES ${q(fk.target)} (${list(fk.references)})`;
    const lines = [];
    if (canConvert) {
        if (options.includeComments) {
            lines.push(`-- Generated from ERD Builder: ${cleanComment(graph?.name || 'Untitled ERD')}`, `-- Dialect: ${dialect}. Review mapping notes before using this schema.`, ...issues.map(issue => `-- ${cleanComment(issue.message)}`));
            for (const note of nodes.filter(node => node.data.shape === 'note')) lines.push(`-- Note: ${cleanComment(note.data.label)} ${cleanComment(note.data.description)}`);
            lines.push('');
        }
        if (dialect === 'sqlite') lines.push('PRAGMA foreign_keys = ON;', '');
        for (const table of tables) {
            if (options.includeComments) lines.push(...table.comments.map(comment => `-- ${cleanComment(comment)}`));
            const definitions = table.columns.map(column => `    ${q(column.name)} ${column.type}${column.nullable ? '' : ' NOT NULL'}`);
            definitions.push(`    PRIMARY KEY (${list(table.primaryKey)})`);
            for (const columns of table.unique) {
                const nullable = columns.some(name => table.columns.find(column => column.name === name)?.nullable);
                if (dialect !== 'mssql' || !nullable) definitions.push(`    UNIQUE (${list(columns)})`);
            }
            definitions.push(...table.checks.map(check => `    CHECK ${checkSql(check)}`));
            if (dialect === 'sqlite') definitions.push(...table.foreignKeys.map(fk => `    ${fkSql(fk)}`));
            lines.push(`CREATE TABLE ${q(table.name)} (`, definitions.join(',\n'), `)${dialect === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC' : ''};`, '');
        }
        // Create all targets before adding non-SQLite FKs; circular relationships remain valid.
        if (dialect !== 'sqlite') for (const table of tables) for (const fk of table.foreignKeys) lines.push(`ALTER TABLE ${q(table.name)} ADD CONSTRAINT ${q(objectName(`fk_${table.name}_${fk.columns.join('_')}`))} ${fkSql(fk)};`);
        for (const table of tables) {
            if (dialect === 'mssql') for (const columns of table.unique.filter(columns => columns.some(name => table.columns.find(column => column.name === name)?.nullable))) lines.push(`CREATE UNIQUE INDEX ${q(objectName(`uq_${table.name}_${columns.join('_')}`))} ON ${q(table.name)} (${list(columns)}) WHERE ${columns.map(name => `${q(name)} IS NOT NULL`).join(' AND ')};`);
            for (const fk of table.foreignKeys) {
                const covered = [table.primaryKey, ...table.unique].some(key => fk.columns.every((name, index) => key[index] === name));
                if (!covered) lines.push(`CREATE INDEX ${q(objectName(`ix_${table.name}_${fk.columns.join('_')}`))} ON ${q(table.name)} (${list(fk.columns)});`);
            }
        }
    }
    return { dialect, canConvert, sql: lines.length ? `${lines.join('\n').trim()}\n` : '', issues, choices, mappings, tables: tables.map(({ allocateColumn: _allocateColumn, ...table }) => table) };
}
