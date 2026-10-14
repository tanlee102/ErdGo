/** Semantic normalization and validation for backward-compatible Chen/EER drafts. */

const ATTRIBUTE_SHAPES = new Set([
    'attribute',
    'keyAttribute',
    'partialKeyAttribute',
    'multivaluedAttribute',
    'derivedAttribute',
    'compositeAttribute',
]);
const ENTITY_SHAPES = new Set(['entity', 'weakEntity']);
const RELATIONSHIP_SHAPES = new Set(['relationship', 'identifyingRelationship']);
const CARDINALITY_MODES = new Set(['manual', 'classic', 'minmax']);
const TEXT_ALIGNMENTS = new Set(['left', 'center', 'right']);

export function isDraftAttributeShape(shape) {
    return ATTRIBUTE_SHAPES.has(String(shape || ''));
}

export function isDraftEntityShape(shape) {
    return ENTITY_SHAPES.has(String(shape || ''));
}

export function isDraftRelationshipShape(shape) {
    return RELATIONSHIP_SHAPES.has(String(shape || ''));
}

function text(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}

function cardinalityBound(value, fallback) {
    const normalized = text(value, fallback).trim().toUpperCase();
    return normalized || fallback;
}

export function normalizeDraftNodeSemantics(shape, data = {}) {
    const normalized = { ...data };
    // Manual label colors default to white; notes opt into them through their mode.
    normalized.labelTextColor = data.labelTextColor === 'black' ? 'black' : 'white';
    // Older snapshots omit this field; only an explicit boolean true locks position.
    if ('positionLocked' in data) normalized.positionLocked = data.positionLocked === true;
    if (isDraftAttributeShape(shape)) {
        normalized.domain = text(data.domain);
        if (shape === 'derivedAttribute') normalized.derivation = text(data.derivation);
    }
    if (shape === 'isa') {
        // Preserve the old whitespace workaround; an empty legacy label still displays ISA.
        normalized.showLabel = typeof data.showLabel === 'boolean'
            ? data.showLabel
            : !(text(data.label).length > 0 && !text(data.label).trim());
        normalized.specializationConstraint = data.specializationConstraint === 'overlapping' ? 'overlapping' : 'disjoint';
        normalized.specializationCompleteness = data.specializationCompleteness === 'total' ? 'total' : 'partial';
    }
    if (shape === 'category') {
        normalized.categoryCompleteness = data.categoryCompleteness === 'total' ? 'total' : 'partial';
    }
    if (shape === 'note') {
        normalized.textAlign = TEXT_ALIGNMENTS.has(data.textAlign) ? data.textAlign : 'left';
        // Older notes follow the theme; only an explicit custom mode overrides it.
        normalized.noteTextColorMode = data.noteTextColorMode === 'custom' ? 'custom' : 'theme';
    }
    return normalized;
}

export function normalizeDraftEdgeSemantics(data = {}) {
    const cardinalityMode = CARDINALITY_MODES.has(data.cardinalityMode) ? data.cardinalityMode : 'manual';
    return {
        ...data,
        cardinalityMode,
        connectionKind: data.connectionKind === 'annotation' ? 'annotation' : 'semantic',
        categoryRole: ['member', 'result'].includes(data.categoryRole) ? data.categoryRole : 'unspecified',
        isaRole: ['supertype', 'subtype'].includes(data.isaRole) ? data.isaRole : 'unspecified',
        sourceLabel: text(data.sourceLabel),
        targetLabel: text(data.targetLabel),
        sourceRole: text(data.sourceRole),
        targetRole: text(data.targetRole),
        sourceMin: cardinalityBound(data.sourceMin, '0'),
        sourceMax: cardinalityBound(data.sourceMax, 'N'),
        targetMin: cardinalityBound(data.targetMin, '0'),
        targetMax: cardinalityBound(data.targetMax, 'N'),
        sourceCardinalityEnabled: data.sourceCardinalityEnabled !== false,
        targetCardinalityEnabled: data.targetCardinalityEnabled !== false,
    };
}

/** ISA roles describe the connected entity, regardless of connector direction. */
export function getDraftIsaConnection(source, target) {
    if (source?.data?.shape === 'isa' && isDraftEntityShape(target?.data?.shape)) return { isa: source, entity: target };
    if (target?.data?.shape === 'isa' && isDraftEntityShape(source?.data?.shape)) return { isa: target, entity: source };
    return null;
}

/** Supported Chen/EER links; annotation lines have no schema meaning. */
export function isDraftSemanticConnection(first, second) {
    if (isDraftEntityShape(first)) {
        return isDraftRelationshipShape(second) || isDraftAttributeShape(second) || ['isa', 'category'].includes(second);
    }
    if (isDraftEntityShape(second)) return isDraftSemanticConnection(second, first);
    if (isDraftRelationshipShape(first)) return isDraftAttributeShape(second) || ['aggregation', 'category'].includes(second);
    if (isDraftRelationshipShape(second)) return isDraftSemanticConnection(second, first);
    if (isDraftAttributeShape(first) && isDraftAttributeShape(second)) return first === 'compositeAttribute' || second === 'compositeAttribute';
    return false;
}

export function getDraftCategoryConnection(source, target) {
    if (source?.data?.shape === 'category' && isDraftEntityShape(target?.data?.shape)) return { category: source, entity: target };
    if (target?.data?.shape === 'category' && isDraftEntityShape(source?.data?.shape)) return { category: target, entity: source };
    return null;
}

/** Validate raw editor input before normalization can apply legacy defaults. */
export function validateDraftCardinality(data, end) {
    const maximum = text(data[`${end}Max`]).trim().toUpperCase();
    if (data.cardinalityMode === 'classic') {
        return ['1', 'N', 'M', '*'].includes(maximum) ? null : {
            code: 'invalid-cardinality-value', message: 'Classic cardinality must be 1, N, M, or * (many).',
        };
    }
    if (data.cardinalityMode !== 'minmax') return null;
    const minimum = parseBound(data[`${end}Min`]);
    const upper = parseBound(maximum, { maximum: true });
    if (minimum === null || upper === null) return {
        code: 'invalid-cardinality-value', message: 'Use non-negative whole numbers; the maximum may also be N, M, or *.',
    };
    // Compare decimal strings exactly, without rounding through JavaScript Number.
    if (upper !== '*' && (minimum.length > upper.length || (minimum.length === upper.length && minimum > upper))) return {
        code: 'invalid-cardinality-range', message: 'Minimum cannot exceed maximum.',
    };
    return null;
}

export function formatDraftEdgeEndLabel(data, end) {
    const normalized = normalizeDraftEdgeSemantics(data);
    const prefix = end === 'target' ? 'target' : 'source';
    const manualLabel = normalized[`${prefix}Label`].trim();
    if (normalized.connectionKind === 'annotation' || normalized.cardinalityMode === 'manual' || !normalized[`${prefix}CardinalityEnabled`]) return manualLabel;
    const role = normalized[`${prefix}Role`].trim();
    let cardinality = manualLabel;
    if (normalized.cardinalityMode === 'classic') {
        cardinality = normalized[`${prefix}Max`];
    } else if (normalized.cardinalityMode === 'minmax') {
        cardinality = `(${normalized[`${prefix}Min`]}, ${normalized[`${prefix}Max`]})`;
    }
    return [role, cardinality].filter(Boolean).join(' · ');
}

function issue(code, message, target, level = 'warning') {
    return {
        id: `${code}:${target.nodeId || target.edgeId || 'graph'}${target.end ? `:${target.end}` : ''}`,
        code,
        level,
        message,
        ...target,
    };
}

function parseBound(value, { maximum = false } = {}) {
    const normalized = String(value || '').trim().toUpperCase();
    if (maximum && ['N', 'M', '*'].includes(normalized)) return '*';
    if (!/^\d+$/.test(normalized)) return null;
    return normalized.replace(/^0+(?=\d)/, '');
}

function labelOf(node) {
    const fallback = node?.data?.shape === 'isa' ? 'ISA' : 'Untitled';
    return String(node?.data?.label || fallback).replace(/\s+/g, ' ').trim()
        || (node?.data?.shape === 'isa' ? fallback : '');
}

export function validateErdDraftGraph(rawNodes, rawEdges) {
    const nodes = Array.isArray(rawNodes) ? rawNodes.filter(Boolean) : [];
    const edges = (Array.isArray(rawEdges) ? rawEdges.filter(Boolean) : []).filter(edge => edge.data?.connectionKind !== 'annotation');
    const nodeById = new Map(nodes.map((node) => [String(node.id), node]));
    const connectedEdges = new Map(nodes.map((node) => [String(node.id), []]));
    edges.forEach((edge) => {
        const source = nodeById.get(String(edge.source));
        const target = nodeById.get(String(edge.target));
        if (!isDraftSemanticConnection(source?.data?.shape, target?.data?.shape)) return;
        connectedEdges.get(String(edge.source))?.push(edge);
        connectedEdges.get(String(edge.target))?.push(edge);
    });
    const otherNode = (edge, nodeId) => nodeById.get(String(edge.source) === String(nodeId) ? String(edge.target) : String(edge.source));
    const issues = [];
    const inheritance = [];

    // Attribute ownership follows undirected composite links, never screen position
    // or edge direction. Inspect each component once; annotations are excluded above.
    const visitedAttributes = new Set();
    nodes.filter(node => isDraftAttributeShape(node.data?.shape)).forEach(root => {
        if (visitedAttributes.has(String(root.id))) return;
        const pending = [String(root.id)];
        const owners = new Set();
        let count = 0;
        let degree = 0;
        while (pending.length) {
            const id = pending.pop();
            if (visitedAttributes.has(id)) continue;
            visitedAttributes.add(id);
            count++;
            const neighbors = new Set((connectedEdges.get(id) || []).map(edge => String(otherNode(edge, id)?.id)));
            neighbors.forEach(neighborId => {
                const shape = nodeById.get(neighborId)?.data?.shape;
                if (isDraftAttributeShape(shape)) { degree++; pending.push(neighborId); }
                else if (isDraftEntityShape(shape) || isDraftRelationshipShape(shape)) owners.add(neighborId);
            });
        }
        if (owners.size > 1) issues.push(issue('attribute-multiple-owners', `Attribute group “${labelOf(root)}” belongs to multiple entities or relationships. Use separate attributes for each owner.`, { nodeId: String(root.id) }));
        if (degree / 2 >= count) issues.push(issue('composite-attribute-cycle', `Attribute group “${labelOf(root)}” contains a cycle. Composite attributes must form a hierarchy.`, { nodeId: String(root.id) }, 'error'));
    });

    const entityNames = new Map();
    nodes.filter((node) => isDraftEntityShape(node.data?.shape)).forEach((node) => {
        const name = labelOf(node).toLocaleLowerCase();
        if (!name) return;
        const existing = entityNames.get(name);
        if (existing) {
            issues.push(issue(
                'duplicate-entity-name',
                `“${labelOf(node)}” is used by more than one entity.`,
                { nodeId: String(node.id) },
            ));
        } else {
            entityNames.set(name, node.id);
        }
    });

    nodes.forEach((node) => {
        const nodeId = String(node.id);
        const shape = node.data?.shape;
        const connections = connectedEdges.get(nodeId) || [];
        const neighbors = connections.map((edge) => otherNode(edge, nodeId)).filter(Boolean);

        if (shape === 'weakEntity') {
            const identifyingEdges = connections.filter((edge) => otherNode(edge, nodeId)?.data?.shape === 'identifyingRelationship');
            if (!identifyingEdges.length) {
                issues.push(issue(
                    'weak-entity-missing-identifying-relationship',
                    `Weak entity “${labelOf(node)}” needs an identifying relationship.`,
                    { nodeId },
                    'error',
                ));
            } else if (identifyingEdges.every((edge) => edge.data?.lineCount !== 'double')) {
                issues.push(issue(
                    'weak-identifying-participation-not-total',
                    `Weak entity “${labelOf(node)}” should participate totally in its identifying relationship.`,
                    { edgeId: String(identifyingEdges[0].id) },
                ));
            }
            if (!neighbors.some((neighbor) => neighbor.data?.shape === 'partialKeyAttribute')) {
                issues.push(issue(
                    'weak-entity-missing-partial-key',
                    `Weak entity “${labelOf(node)}” needs a partial-key discriminator.`,
                    { nodeId },
                    'error',
                ));
            }
        }

        if (shape === 'identifyingRelationship' && !neighbors.some((neighbor) => neighbor.data?.shape === 'weakEntity')) {
            issues.push(issue(
                'identifying-relationship-missing-weak-entity',
                `Identifying relationship “${labelOf(node)}” is not connected to a weak entity.`,
                { nodeId },
                'error',
            ));
        }

        if (shape === 'partialKeyAttribute' && !neighbors.some((neighbor) => neighbor.data?.shape === 'weakEntity')) {
            issues.push(issue(
                'partial-key-missing-weak-entity',
                `Partial key “${labelOf(node)}” must identify a weak entity.`,
                { nodeId },
            ));
        }

        if (isDraftAttributeShape(shape) && !connections.length) {
            issues.push(issue(
                'attribute-is-disconnected',
                `Attribute “${labelOf(node)}” is not connected to an entity, relationship, or attribute.`,
                { nodeId },
            ));
        }

        if (isDraftRelationshipShape(shape)) {
            const participantEdges = connections.filter((edge) => {
                const participantShape = otherNode(edge, nodeId)?.data?.shape;
                return isDraftEntityShape(participantShape) || participantShape === 'aggregation' || participantShape === 'category';
            });
            if (participantEdges.length < 2) {
                issues.push(issue(
                    'relationship-needs-two-roles',
                    `Relationship “${labelOf(node)}” needs at least two participating roles.`,
                    { nodeId },
                    'error',
                ));
            }

            const edgesByParticipant = new Map();
            participantEdges.forEach((edge) => {
                const participant = otherNode(edge, nodeId);
                const list = edgesByParticipant.get(participant.id) || [];
                list.push(edge);
                edgesByParticipant.set(participant.id, list);
            });
            edgesByParticipant.forEach((participantConnections, participantId) => {
                if (participantConnections.length < 2) return;
                const roles = participantConnections.map((edge) => {
                    const end = String(edge.source) === String(participantId) ? 'source' : 'target';
                    return normalizeDraftEdgeSemantics(edge.data)[`${end}Role`].trim().toLocaleLowerCase();
                });
                if (roles.some((role) => !role) || new Set(roles).size !== roles.length) {
                    issues.push(issue(
                        'recursive-relationship-duplicate-role',
                        `Recursive relationship “${labelOf(node)}” needs a distinct role name for each participation.`,
                        { nodeId },
                    ));
                }
            });
        }

        if (shape === 'isa') {
            const parents = new Set();
            const children = new Set();
            const participants = new Set();
            let unspecified = false;
            connections.forEach((edge) => {
                const entity = otherNode(edge, nodeId);
                if (!isDraftEntityShape(entity?.data?.shape)) return;
                const entityId = String(entity.id);
                if (participants.has(entityId)) {
                    issues.push(issue('isa-duplicate-entity', `ISA “${labelOf(node)}” connects to “${labelOf(entity)}” more than once.`, { edgeId: String(edge.id) }));
                }
                participants.add(entityId);
                const role = normalizeDraftEdgeSemantics(edge.data).isaRole;
                if (role === 'supertype') parents.add(entityId);
                else if (role === 'subtype') children.add(entityId);
                else {
                    unspecified = true;
                    issues.push(issue('isa-role-unspecified', `Choose Supertype or Subtype for “${labelOf(entity)}” in ISA “${labelOf(node)}”.`, { edgeId: String(edge.id) }));
                }
            });
            // Missing roles in older documents remain unknown; never infer from layout or text.
            if (participants.size < 2 || parents.size > 1 || (!unspecified && (parents.size !== 1 || !children.size))) {
                issues.push(issue(
                    'isa-needs-supertype-and-subtype',
                    `ISA “${labelOf(node)}” needs exactly one supertype and at least one distinct subtype.`,
                    { nodeId },
                    'error',
                ));
            }
            if ([...children].some((child) => parents.has(child))) {
                issues.push(issue('isa-self-inheritance', `ISA “${labelOf(node)}” cannot make an entity its own subtype.`, { nodeId }, 'error'));
            }
            if (parents.size === 1) {
                const [parent] = parents;
                children.forEach((child) => {
                    if (child !== parent) inheritance.push({ parent, child, nodeId });
                });
            }
        }

        if (shape === 'category') {
            const members = new Set();
            const results = new Set();
            const participants = new Set();
            let unspecified = false;
            connections.forEach((edge) => {
                const entity = otherNode(edge, nodeId);
                if (!isDraftEntityShape(entity?.data?.shape)) return;
                const entityId = String(entity.id);
                if (participants.has(entityId)) issues.push(issue('category-duplicate-entity', `Category “${labelOf(node)}” connects to “${labelOf(entity)}” more than once.`, { edgeId: String(edge.id) }));
                participants.add(entityId);
                const role = normalizeDraftEdgeSemantics(edge.data).categoryRole;
                if (role === 'member') members.add(entityId);
                else if (role === 'result') results.add(entityId);
                else {
                    unspecified = true;
                    issues.push(issue('category-role-unspecified', `Choose Union member or Resulting subtype for “${labelOf(entity)}” in category “${labelOf(node)}”.`, { edgeId: String(edge.id) }));
                }
            });
            if (participants.size < 3 || results.size > 1 || (!unspecified && (members.size < 2 || results.size !== 1))) {
                issues.push(issue('category-needs-union-members', `Category “${labelOf(node)}” needs at least two union members and exactly one distinct resulting subtype.`, { nodeId }, 'error'));
            }
            if ([...results].some(id => members.has(id))) issues.push(issue('category-self-membership', `Category “${labelOf(node)}” cannot use a union member as its own resulting subtype.`, { nodeId }, 'error'));
        }

        if (shape === 'aggregation' && !neighbors.some((neighbor) => isDraftRelationshipShape(neighbor.data?.shape))) {
            issues.push(issue(
                'aggregation-needs-relationship',
                `Aggregation “${labelOf(node)}” should connect to the relationship it treats as a higher-level object.`,
                { nodeId },
            ));
        }
    });

    const childrenByParent = new Map();
    inheritance.forEach(({ parent, child }) => {
        if (!childrenByParent.has(parent)) childrenByParent.set(parent, new Set());
        childrenByParent.get(parent).add(child);
    });
    const cyclicNodes = new Set();
    inheritance.forEach(({ parent, child, nodeId }) => {
        if (cyclicNodes.has(nodeId)) return;
        const pending = [child];
        const visited = new Set();
        while (pending.length) {
            const current = pending.pop();
            if (current === parent) {
                cyclicNodes.add(nodeId);
                issues.push(issue('isa-inheritance-cycle', `ISA “${labelOf(nodeById.get(nodeId))}” is part of an inheritance cycle.`, { nodeId }, 'error'));
                break;
            }
            if (visited.has(current)) continue;
            visited.add(current);
            childrenByParent.get(current)?.forEach((next) => pending.push(next));
        }
    });

    const seenConnections = new Set();
    edges.forEach((edge) => {
        const source = nodeById.get(String(edge.source));
        const target = nodeById.get(String(edge.target));
        const data = normalizeDraftEdgeSemantics(edge.data);
        if (!isDraftSemanticConnection(source?.data?.shape, target?.data?.shape)) {
            const isa = source?.data?.shape === 'isa' || target?.data?.shape === 'isa';
            issues.push(issue(isa ? 'isa-invalid-endpoint' : 'unsupported-semantic-connection', isa
                ? 'An ISA connector must join the ISA branch to an entity. Connect nested branches through their shared entity.'
                : 'These shapes do not form a supported Chen/EER relationship. Choose compatible endpoints or mark this connector as an annotation.', { edgeId: String(edge.id) }, 'error'));
        }
        // Recursive relationships may intentionally reuse a participant with distinct roles.
        if (!getDraftIsaConnection(source, target) && !getDraftCategoryConnection(source, target)) {
            const key = JSON.stringify([
                [String(edge.source), data.sourceRole.trim().toLocaleLowerCase()],
                [String(edge.target), data.targetRole.trim().toLocaleLowerCase()],
            ].sort((a, b) => a[0].localeCompare(b[0])));
            if (seenConnections.has(key)) issues.push(issue('duplicate-semantic-connection', 'This connection repeats the same endpoints and roles. Remove the duplicate or give recursive participations distinct roles.', { edgeId: String(edge.id) }));
            seenConnections.add(key);
        }
        ['source', 'target'].forEach((end) => {
            if (!data[`${end}CardinalityEnabled`]) return;
            const problem = validateDraftCardinality(data, end);
            if (problem) issues.push(issue(problem.code, `${end === 'source' ? 'From' : 'To'} cardinality: ${problem.message}`, { edgeId: String(edge.id), end }, 'error'));
            const participant = end === 'source' ? source : target;
            const relationship = end === 'source' ? target : source;
            if (!problem && data.cardinalityMode === 'minmax'
                && (isDraftEntityShape(participant?.data?.shape) || ['aggregation', 'category'].includes(participant?.data?.shape))
                && isDraftRelationshipShape(relationship?.data?.shape)) {
                const mandatory = parseBound(data[`${end}Min`]) !== '0';
                if (mandatory !== (edge.data?.lineCount === 'double')) {
                    issues.push(issue('participation-cardinality-mismatch', 'Participation and minimum cardinality disagree. Use a double line for a positive minimum or a single line for zero.', { edgeId: String(edge.id), end }));
                }
            }
        });
    });

    return issues;
}
