export const DEFAULT_SCHEMA_NAME = 'public';
export const IDENTIFIER_PART_SEPARATOR = '\u001f';

export function normalizeIdentifierPart(part) {
    if (part && typeof part === 'object') {
        return {
            value: String(part.value ?? ''),
            quoted: !!part.quoted,
            raw: part.raw,
        };
    }
    return { value: String(part ?? ''), quoted: false };
}

function cleanIdentifierTextPart(part) {
    const value = String(part || '').trim();
    if (!value) return null;

    if (value.startsWith('"') && value.endsWith('"')) {
        return { value: value.slice(1, -1).replace(/""/g, '"'), quoted: true, raw: value };
    }
    if (value.startsWith('`') && value.endsWith('`')) {
        return { value: value.slice(1, -1).replace(/``/g, '`'), quoted: true, raw: value };
    }
    if (value.startsWith('[') && value.endsWith(']')) {
        return { value: value.slice(1, -1).replace(/]]/g, ']'), quoted: true, raw: value };
    }

    return { value, quoted: false };
}

export function identifierPartsFromText(value) {
    const text = String(value || '').trim();
    if (!text) return [];

    const parts = [];
    let current = '';
    let state = null;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];

        if (state === 'doubleQuote') {
            current += char;
            if (char === '"' && next === '"') {
                current += next;
                index += 1;
            } else if (char === '"') {
                state = null;
            }
            continue;
        }

        if (state === 'backtick') {
            current += char;
            if (char === '`' && next === '`') {
                current += next;
                index += 1;
            } else if (char === '`') {
                state = null;
            }
            continue;
        }

        if (state === 'bracket') {
            current += char;
            if (char === ']' && next === ']') {
                current += next;
                index += 1;
            } else if (char === ']') {
                state = null;
            }
            continue;
        }

        if (char === '"') {
            state = 'doubleQuote';
            current += char;
        } else if (char === '`') {
            state = 'backtick';
            current += char;
        } else if (char === '[') {
            state = 'bracket';
            current += char;
        } else if (char === '.') {
            const part = cleanIdentifierTextPart(current);
            if (part) parts.push(part);
            current = '';
        } else {
            current += char;
        }
    }

    const part = cleanIdentifierTextPart(current);
    if (part) parts.push(part);
    return parts;
}

export function identifierPartsFrom(value, explicitParts = null) {
    const parts = explicitParts || value?.nameParts || value?.tableParts || null;
    if (Array.isArray(parts) && parts.length > 0) return parts.map(normalizeIdentifierPart);
    const name = typeof value === 'string' ? value : value?.name || value?.table || '';
    if (!name) return [];
    return identifierPartsFromText(name);
}

export function identifierFullName(parts) {
    return (parts || []).map((part) => part.value).join('.');
}

export function identifierLeafName(parts) {
    if (!parts || parts.length === 0) return '';
    return parts[parts.length - 1].value;
}

function dialectIdentifierValue(part, dialect = 'auto') {
    const normalized = normalizeIdentifierPart(part);
    // PostgreSQL folds unquoted identifiers to lower-case, but quoted names
    // remain byte-for-byte case-sensitive. A quoted lower-case name therefore
    // still resolves to the same object as its unquoted spelling.
    if (dialect === 'postgres') return normalized.quoted ? normalized.value : normalized.value.toLowerCase();
    // SQLite identifiers, SQL Server's default collations, MySQL columns, and
    // the legacy mixed-dialect mode are compared case-insensitively here.
    return normalized.value.toLowerCase();
}

export function identifierKey(parts, dialect = 'auto') {
    return (parts || []).map((part) => dialectIdentifierValue(part, dialect)).join(IDENTIFIER_PART_SEPARATOR);
}

export function identifierLeafKey(parts, dialect = 'auto') {
    if (!parts || parts.length === 0) return '';
    return dialectIdentifierValue(parts[parts.length - 1], dialect);
}

export function identifierNamespaceParts(parts) {
    return parts && parts.length > 1 ? parts.slice(0, -1) : [];
}

export function canApplyDefaultSchema(parts) {
    if (!parts || parts.length !== 1) return false;
    // A single quoted identifier like "tenant.users" is a table name that
    // happens to contain a dot, not an unqualified table in the public schema.
    return !String(parts[0]?.value || '').includes('.');
}

export function effectiveIdentifierParts(parts, defaultSchema = DEFAULT_SCHEMA_NAME) {
    return canApplyDefaultSchema(parts) ? [{ value: defaultSchema, quoted: false }, ...parts] : parts;
}

export function identifierPartsEquivalent(leftParts, rightParts, defaultSchema = DEFAULT_SCHEMA_NAME, dialect = 'auto') {
    const leftKey = identifierKey(leftParts, dialect);
    const rightKey = identifierKey(rightParts, dialect);
    if (leftKey && leftKey === rightKey) return true;
    return identifierKey(effectiveIdentifierParts(leftParts, defaultSchema), dialect) === identifierKey(effectiveIdentifierParts(rightParts, defaultSchema), dialect);
}

function displayCollisionKey(value, dialect = 'auto') {
    const text = String(value || '');
    return dialect === 'postgres' ? text : text.toLowerCase();
}

function quoteIdentifierDisplayName(value) {
    return `"${String(value || '').replace(/"/g, '""')}"`;
}

function canQuoteSourceForDisplay(info) {
    const sourcePart = info?.sourceParts?.[0];
    return info?.sourceParts?.length === 1 && String(sourcePart?.value || '').includes('.');
}

function disambiguateDisplayNameCollisions(infos, dialect = 'auto') {
    const groups = new Map();
    infos.forEach((info) => {
        const key = displayCollisionKey(info.displayName, dialect);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(info);
    });

    groups.forEach((group) => {
        if (group.length < 2) return;
        group.forEach((info) => {
            if (canQuoteSourceForDisplay(info)) {
                info.displayName = quoteIdentifierDisplayName(info.sourceFullName);
            }
        });
    });
}

export function buildIdentifierDisplayContext(entries, { schemaAware = false, defaultSchema = DEFAULT_SCHEMA_NAME, dialect = 'auto' } = {}) {
    const infos = new Map();
    const leafCounts = new Map();
    const defaultSchemaPart = { value: defaultSchema, quoted: false };

    (entries || []).forEach((entry) => {
        if (!entry || !entry.name) return;
        const sourceParts = identifierPartsFrom(entry);
        const sourceFullName = identifierFullName(sourceParts);
        const sourceFullKey = identifierKey(sourceParts, dialect);
        const leafName = identifierLeafName(sourceParts);
        const leafKey = identifierLeafKey(sourceParts, dialect);
        leafCounts.set(leafKey, (leafCounts.get(leafKey) || 0) + 1);
        const explicitNamespaceParts = identifierNamespaceParts(sourceParts);
        infos.set(entry, {
            parts: sourceParts,
            sourceParts,
            sourceFullName,
            sourceFullKey,
            fullName: sourceFullName,
            fullKey: sourceFullKey,
            leafName,
            leafKey,
            namespaceName: explicitNamespaceParts.length > 0 ? identifierFullName(explicitNamespaceParts) : null,
            namespaceKey: identifierKey(explicitNamespaceParts, dialect),
            hasExplicitSchema: explicitNamespaceParts.length > 0,
            hasImplicitDefaultSchema: false,
            canApplyDefaultSchema: schemaAware && canApplyDefaultSchema(sourceParts),
        });
    });

    let hasMixedSchemaContext = false;
    if (schemaAware) {
        const schemaKeys = new Set();
        infos.forEach((info) => {
            if (info.hasExplicitSchema) schemaKeys.add(info.namespaceKey);
            else schemaKeys.add(identifierKey([defaultSchemaPart], dialect));
        });
        hasMixedSchemaContext = schemaKeys.size > 1;
    }

    infos.forEach((info) => {
        const collides = (leafCounts.get(info.leafKey) || 0) > 1;

        if (schemaAware && info.canApplyDefaultSchema && !info.hasExplicitSchema) {
            info.hasImplicitDefaultSchema = true;
            info.parts = [defaultSchemaPart, ...info.sourceParts];
            info.fullName = identifierFullName(info.parts);
            info.fullKey = identifierKey(info.parts, dialect);
            info.namespaceName = defaultSchema;
            info.namespaceKey = identifierKey([defaultSchemaPart], dialect);
        }

        const hasSchema = info.parts.length > 1;
        info.displayName = hasSchema && (hasMixedSchemaContext || collides) ? info.fullName : info.leafName || info.fullName;
        if (schemaAware && canQuoteSourceForDisplay(info)) {
            info.displayName = quoteIdentifierDisplayName(info.sourceFullName);
        }
    });

    disambiguateDisplayNameCollisions(infos, dialect);

    return infos;
}
