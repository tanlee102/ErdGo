/** Groups, limits, and summarizes Prisma parser diagnostics for editor and status UI. */
const SEVERITY_ORDER = {
    error: 0,
    warning: 1,
    info: 2,
};

const GROUP_LABELS = {
    error: 'Errors',
    warning: 'Warnings',
    info: 'Notes',
};

const DEFAULT_GROUP_LIMITS = {
    error: 100,
    warning: 80,
    info: 40,
};

function normalizeSeverity(severity) {
    return Object.hasOwn(SEVERITY_ORDER, severity) ? severity : 'warning';
}

function isLexicalRootCause(diagnostic) {
    return diagnostic.severity === 'error' && /Unterminated (?:string|block comment)/.test(diagnostic.message);
}

function isGenericDelimiterError(diagnostic) {
    return diagnostic.severity === 'error' && /unbalanced .*delimiters/i.test(diagnostic.message);
}

function normalizePosition(value, fallback) {
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

function hasSyntaxErrorOnLine(diagnostic, errorLines) {
    return diagnostic.severity !== 'error' && diagnostic.line && errorLines.has(diagnostic.line);
}

export function normalizePrismaDiagnostics(diagnostics) {
    const normalized = (Array.isArray(diagnostics) ? diagnostics : [])
        .filter((item) => item && typeof item.message === 'string' && item.message.trim())
        .map((item, index) => ({
            ...item,
            severity: normalizeSeverity(item.severity),
            message: item.message.trim(),
            line: normalizePosition(item.line, undefined),
            column: normalizePosition(item.column, undefined),
            endLine: normalizePosition(item.endLine, undefined),
            endColumn: normalizePosition(item.endColumn, undefined),
            _order: index,
        }));
    const lexicalErrorLines = new Set(normalized.filter(isLexicalRootCause).map((item) => item.line).filter(Boolean));
    const errorLines = new Set(normalized.filter((item) => item.severity === 'error').map((item) => item.line).filter(Boolean));
    const seen = new Set();

    return normalized
        .filter((item) => !(item.line && lexicalErrorLines.has(item.line) && isGenericDelimiterError(item)))
        .filter((item) => !hasSyntaxErrorOnLine(item, errorLines))
        .filter((item) => {
            const key = [item.severity, item.line || 0, item.column || 0, item.message].join('|');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .sort((left, right) => {
            const leftLine = left.line || Number.MAX_SAFE_INTEGER;
            const rightLine = right.line || Number.MAX_SAFE_INTEGER;
            if (leftLine !== rightLine) return leftLine - rightLine;
            const severityDifference = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
            return severityDifference || left._order - right._order;
        })
        .map(({ _order, ...item }) =>
            Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined)),
        );
}

export function getPrismaDiagnosticHint(diagnostic) {
    const message = String(diagnostic?.message || '');

    if (/Unterminated string/i.test(message)) return 'Close the string with a double quote before the end of this line.';
    if (/Unterminated block comment/i.test(message)) return 'Add */ to close the comment. Parsing resumes at the next Prisma block.';
    if (/Missing closing brace/i.test(message)) return 'Add a closing } before the next model, view, enum, type, generator, or datasource block.';
    if (/Unexpected closing brace/i.test(message)) return 'Remove this } or add the matching opening brace.';
    if (/Invalid Prisma .* block/i.test(message)) return 'Use a block header such as model User { and close it with }.';
    if (/unbalanced .*delimiters/i.test(message)) return 'Check the (), [], and {} pairs on this declaration.';
    if (/invalid field declaration/i.test(message)) return 'A field needs a name and type, for example: id Int @id.';
    if (/invalid field type/i.test(message)) return 'Use a Prisma scalar, enum, model, or composite type followed by only ? or [].';
    if (/must start with a letter/i.test(message)) return 'Rename the Prisma identifier to begin with A-Z or a-z; use @map or @@map for a database name that starts differently.';
    if (/unexpected content after the field type/i.test(message)) return 'Field attributes must begin with @, for example: @default(now()).';
    if (/duplicate field|duplicate enum value|conflicts with the/i.test(message)) return 'Rename or remove one of the conflicting declarations.';
    if (/can define only one ID/i.test(message)) return 'Keep one @id field or one @@id block and remove the other ID definitions.';
    if (/uses @id but is|@@id fields must be required/i.test(message)) return 'Make every ID field required and singular by removing ? or [].';
    if (/@@unique fields must be required/i.test(message)) return 'Make every compound unique field required; a partial predicate does not make nullable @@unique fields valid.';
    if (/has no unique identifier/i.test(message)) return 'Add @id, @@id, or a non-partial required unique criterion that identifies every record.';
    if (/must declare @@schema/i.test(message)) return 'Add @@schema("name") using one of the schemas listed in the datasource block.';
    if (/uses @@schema\(.+not listed/i.test(message)) return 'Add this schema to datasource schemas or change @@schema to a listed value.';
    if (/both map to/i.test(message)) return 'Change @@map or @@schema so each model and view owns a distinct database object.';
    if (/ambiguous relation/i.test(message)) return 'Add the same explicit @relation("Name") to the two fields that belong together.';
    if (/no matching opposite relation field|possible opposite relation fields/i.test(message)) return 'Add exactly one opposite field with the same @relation("Name"), and use distinct names for parallel relations.';
    if (/unknown model/i.test(message)) return 'Declare the target model or correct the relation field type.';
    if (/incomplete fields\/references metadata/i.test(message)) return 'Provide matching fields: [...] and references: [...] arrays.';
    if (/scalar field was not found|on unknown field/i.test(message)) return 'Correct the field name or add the missing scalar field.';
    if (/incompatible field types/i.test(message)) return 'Use matching scalar types for each foreign-key and referenced-field pair.';
    if (/incompatible native types/i.test(message)) return 'Use the same datasource native type and arguments on both relation scalar fields.';
    if (/ObjectId on both relation scalar fields/i.test(message)) return 'Add the same datasource ObjectId native type to the foreign-key field and referenced ID field.';
    if (/must reference a unique field set/i.test(message)) return 'Reference an @id, @unique, @@id, or @@unique field set.';
    if (/must be optional because.+nullable/i.test(message)) return 'Make the relation field nullable with ?, or make all of its foreign-key scalars required.';
    if (/without foreign-key scalars must be optional/i.test(message)) return 'Add ? to the inverse one-to-one field; keep fields/references on the owning side.';
    if (/one-to-one relation requires/i.test(message)) return 'Add a global @unique or @@unique on the owning foreign-key fields, or change the opposite field to a list.';
    if (/both own this relation/i.test(message)) return 'Choose which model stores the foreign key and remove fields/references from the other relation field.';
    if (/repeats a field/i.test(message)) return 'List each key or relation scalar once; keep fields and references in matching order.';
    if (/implicit many-to-many relations cannot define/i.test(message)) return 'Use an explicit join model when you need referential actions on a many-to-many relation.';
    if (/partial.+omitted from SQL/i.test(message)) return 'The ERD preserves this predicate. Add its filtered index deliberately when preparing database DDL.';
    if (/list relation .* cannot own/i.test(message)) return 'Move fields/references to the singular relation field on the other model.';
    if (/only list-to-list relations can be implicit/i.test(message)) return 'Add @relation(fields: [...], references: [...]) to the singular field that owns the foreign key.';
    if (/MongoDB does not support implicit many-to-many/i.test(message)) return 'Add scalar ID arrays and @relation(fields: [...], references: [...]) to both MongoDB relation fields.';
    if (/relational Prisma many-to-many relations need an implicit relation or an explicit join model/i.test(message)) return 'Remove fields/references for an implicit many-to-many relation, or model the join table explicitly.';
    if (/MongoDB many-to-many relation/i.test(message)) return 'Use one ID array and one singular @id reference on each side, without referential actions.';
    if (/self relation and require the same explicit @relation/i.test(message)) return 'Give both self-relation fields the same @relation("Name") value.';
    if (/without fields\/references metadata/i.test(message)) return 'Add the opposite relation field or explicit fields/references metadata.';
    if (/unsupported provider "mssql"/i.test(message)) return 'Use provider = "sqlserver" for Microsoft SQL Server.';
    if (/unsupported provider|provider must be a quoted/i.test(message)) return 'Use postgresql, mysql, sqlite, sqlserver, mongodb, or cockroachdb.';
    if (/missing a provider/i.test(message)) return 'Add provider = "postgresql" or another supported connector inside the datasource block.';
    if (/native type namespace/i.test(message)) return 'Prefix native types with the datasource name, such as @db.VarChar(255) for datasource db.';
    if (/must map to MongoDB _id/i.test(message)) return 'Add @map("_id") to the MongoDB field-level @id.';
    if (/must define exactly one field-level @id for MongoDB|MongoDB does not support @@id/i.test(message)) return 'Replace @@id with one field-level @id and map that field to _id.';
    if (/ObjectId and must use @default\(auto\(\)\)/i.test(message)) return 'Use @default(auto()) for a generated ObjectId, or remove the default for an externally supplied ID.';
    if (/auto\(\) is only supported by MongoDB/i.test(message)) return 'Use a connector-supported default such as uuid(), cuid(), or autoincrement(), or switch to MongoDB.';
    if (/sequence\(\) is only supported by CockroachDB/i.test(message)) return 'Use autoincrement() or another connector-supported default, or switch to CockroachDB.';
    if (/MongoDB does not support autoincrement/i.test(message)) return 'Use @default(auto()) with a mapped ObjectId ID, or supply the MongoDB ID yourself.';
    if (/uses auto\(\).+requires a field-level @id/i.test(message)) return 'Move auto() to the model ID and add the datasource ObjectId native type.';
    if (/does not support scalar lists/i.test(message)) return 'Use a related model or a Json field when the selected connector has no array support.';
    if (/does not support Prisma enum blocks/i.test(message)) return 'For SQL Server, use a String field or a related lookup model instead.';
    if (/does not support Prisma composite type blocks/i.test(message)) return 'Replace the type block with a model relation; composite types are MongoDB-only.';
    if (/does not support Prisma Json fields/i.test(message)) return 'Use String, Bytes, or Unsupported("...") to represent the SQL Server column.';
    if (/does not support .*index|does not support @@schema|does not support the datasource schemas option/i.test(message)) return 'Remove the connector-specific option or select the matching datasource provider.';
    if (/does not support the Restrict referential action/i.test(message)) return 'Use NoAction for SQL Server.';
    if (/SetNull with required relation scalar fields/i.test(message)) return 'Add ? to every scalar field listed in relation fields: [...].';
    if (/relationMode = "prisma" does not support/i.test(message)) return 'Choose a referential action supported by Prisma relation emulation.';
    return null;
}

export function getPrismaDiagnosticKey(diagnostic, index = 0) {
    return [diagnostic?.severity || 'warning', diagnostic?.line || 0, diagnostic?.column || 0, diagnostic?.message || '', index].join('|');
}

export function groupPrismaDiagnostics(diagnostics, limits = null) {
    const groups = new Map([
        ['error', []],
        ['warning', []],
        ['info', []],
    ]);

    (Array.isArray(diagnostics) ? diagnostics : []).forEach((item) => {
        const severity = normalizeSeverity(item?.severity);
        groups.get(severity).push({ ...item, severity });
    });

    return Array.from(groups, ([severity, items]) => ({
        severity,
        label: GROUP_LABELS[severity],
        total: items.length,
        items: limits ? items.slice(0, Math.max(0, limits[severity] ?? DEFAULT_GROUP_LIMITS[severity])) : items,
        hiddenCount: limits ? Math.max(0, items.length - Math.max(0, limits[severity] ?? DEFAULT_GROUP_LIMITS[severity])) : 0,
    })).filter((group) => group.items.length > 0);
}

export function getPrismaDiagnosticGroupLimits() {
    return { ...DEFAULT_GROUP_LIMITS };
}

export function countPrismaDiagnostics(diagnostics) {
    return (Array.isArray(diagnostics) ? diagnostics : []).reduce(
        (counts, item) => {
            counts[normalizeSeverity(item?.severity)] += 1;
            return counts;
        },
        { error: 0, warning: 0, info: 0 },
    );
}
