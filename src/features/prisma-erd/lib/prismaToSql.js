import { normalizePrismaDiagnostics } from './prismaDiagnostics.js';

/**
 * Prisma import bridge. The parser keeps Prisma-specific details in metadata
 * while producing the same ERD schema shape used by the SQL editor, plus a
 * SQL-like export for users who want to inspect the relational equivalent.
 */
const PRISMA_SCALAR_TYPES = new Set(['String', 'Boolean', 'Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Json', 'Bytes']);
const PRISMA_PROVIDERS = new Set(['postgresql', 'mysql', 'sqlite', 'sqlserver', 'mongodb', 'cockroachdb']);
const PROVIDER_LABELS = {
    postgresql: 'PostgreSQL',
    mysql: 'MySQL',
    sqlite: 'SQLite',
    sqlserver: 'SQL Server',
    mongodb: 'MongoDB',
    cockroachdb: 'CockroachDB',
};

export const SAMPLE_PRISMA_SCHEMA = `// Replace this sample with your own Prisma schema.

generator client {
  provider        = "prisma-client"
  output          = "../generated/prisma"
}

datasource db {
  provider = "postgresql"
}

enum UserRole {
  MEMBER
  MANAGER
  ADMIN @map("administrator")

  @@map("user_role")
}

enum ProjectStatus {
  DRAFT
  ACTIVE
  ARCHIVED
}

model User {
  id            String       @id @default(uuid()) @db.Uuid
  email         String       @unique(map: "users_email_key") @db.VarChar(320)
  displayName   String?      @map("display_name") @db.VarChar(120)
  role          UserRole     @default(MEMBER)
  preferences   Json?
  skills        String[]
  avatar        Bytes?
  organizations Organization[] @relation("OrganizationOwner")
  memberships   Membership[]
  ledProjects   Project[]      @relation("ProjectLead")
  assignedTasks Task[]       @relation("TaskAssignee")
  authoredPosts Post[]       @relation("PostAuthor")
  editedPosts   Post[]       @relation("PostEditor")
  comments      Comment[]
  followedBy    User[]       @relation("UserFollows")
  following     User[]       @relation("UserFollows")
  legacyCode    String?      @ignore
  createdAt     DateTime     @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt     DateTime     @updatedAt @map("updated_at") @db.Timestamptz(3)

  @@index([role, createdAt(sort: Desc)], map: "users_role_created_idx")
  @@map("users")
}

model Organization {
  id          String       @id @default(cuid())
  ownerId     String       @map("owner_id") @db.Uuid
  slug        String       @unique
  name        String
  billingRate Decimal      @default(0) @map("billing_rate") @db.Decimal(12, 2)
  active      Boolean      @default(true)
  owner       User         @relation("OrganizationOwner", fields: [ownerId], references: [id], onDelete: Restrict)
  members     Membership[]
  projects    Project[]
  createdAt   DateTime     @default(now())

  @@map("organizations")
}

model Membership {
  organizationId String       @map("organization_id")
  userId         String       @map("user_id") @db.Uuid
  title          String?
  joinedAt       DateTime     @default(now()) @map("joined_at")
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  user           User         @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([organizationId, userId], map: "memberships_pkey")
  @@index([userId], map: "memberships_user_idx")
  @@map("memberships")
}

model Project {
  id             String        @id @default(cuid())
  organizationId String        @map("organization_id")
  leadId         String?       @map("lead_id") @db.Uuid
  code           String        @db.VarChar(24)
  name           String
  status         ProjectStatus @default(DRAFT)
  budget         Decimal?      @db.Decimal(14, 2)
  organization   Organization  @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  lead           User?         @relation("ProjectLead", fields: [leadId], references: [id], onDelete: SetNull)
  tasks          Task[]

  @@unique([organizationId, code], map: "projects_org_code_key")
  @@index([status])
  @@index([leadId], map: "projects_lead_idx")
  @@map("projects")
}

model Task {
  id             BigInt  @id @default(autoincrement())
  organizationId String  @map("organization_id")
  projectCode    String  @map("project_code") @db.VarChar(24)
  assigneeId     String? @map("assignee_id") @db.Uuid
  title          String
  estimateHours  Float?  @map("estimate_hours")
  completed      Boolean @default(false)
  project        Project @relation(
    fields: [organizationId, projectCode],
    references: [organizationId, code],
    onDelete: Cascade,
    onUpdate: Cascade,
    map: "tasks_project_fkey"
  )
  assignee       User?   @relation("TaskAssignee", fields: [assigneeId], references: [id], onDelete: SetNull)

  @@index([organizationId, projectCode], map: "tasks_project_idx")
  @@index([assigneeId], map: "tasks_assignee_idx")
  @@map("tasks")
}

model Post {
  id         String     @id @default(cuid())
  title      String     @db.VarChar(180)
  slug       String     @unique
  published  Boolean    @default(false)
  authorId   String     @map("author_id") @db.Uuid
  editorId   String?    @map("editor_id") @db.Uuid
  author     User       @relation("PostAuthor", fields: [authorId], references: [id], onDelete: Restrict)
  editor     User?      @relation(name: "PostEditor", fields: [editorId], references: [id], onDelete: SetNull)
  comments   Comment[]
  createdAt  DateTime   @default(now()) @map("created_at")

  @@index([authorId, createdAt(sort: Desc)], map: "posts_author_created_idx")
  @@map("posts")
}

model Comment {
  id        String   @id @default(cuid())
  postId    String   @map("post_id")
  authorId  String?  @map("author_id") @db.Uuid
  body      String
  post      Post     @relation(fields: [postId], references: [id], onDelete: Cascade)
  author    User?    @relation(fields: [authorId], references: [id], onDelete: SetNull)
  createdAt DateTime @default(now()) @map("created_at")

  @@index([postId, createdAt])
  @@map("comments")
}
`;

function createSourceLocator(source) {
    const lineStarts = [0];
    for (let index = 0; index < source.length; index += 1) {
        if (source[index] === '\n') lineStarts.push(index + 1);
    }

    return (index) => {
        const target = Math.max(0, Math.min(index, source.length));
        let low = 0;
        let high = lineStarts.length - 1;

        while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            if (lineStarts[middle] <= target) low = middle + 1;
            else high = middle - 1;
        }

        const lineIndex = Math.max(0, high);
        return {
            line: lineIndex + 1,
            column: target - lineStarts[lineIndex] + 1,
        };
    };
}

function isIdentifierChar(char) {
    return /[A-Za-z0-9_]/.test(char || '');
}

function readIdentifier(source, index) {
    let cursor = index;
    while (cursor < source.length && isIdentifierChar(source[cursor])) cursor += 1;
    return { value: source.slice(index, cursor), end: cursor };
}

function readString(source, index) {
    const quote = source[index];
    let cursor = index + 1;

    while (cursor < source.length) {
        if (source[cursor] === '\\') {
            cursor += 2;
            continue;
        }
        if (source[cursor] === quote) return { end: cursor + 1, closed: true };
        if (source[cursor] === '\n' || source[cursor] === '\r') return { end: cursor, closed: false };
        cursor += 1;
    }

    return { end: cursor, closed: false };
}

function skipString(source, index) {
    return readString(source, index).end;
}

function skipLineComment(source, index) {
    const newline = source.indexOf('\n', index + 2);
    return newline === -1 ? source.length : newline + 1;
}

function skipBlockComment(source, index) {
    const end = source.indexOf('*/', index + 2);
    return end === -1 ? findNextBlockHeader(source, index + 2)?.index ?? source.length : end + 2;
}

function matchBlockHeaderAt(source, index) {
    if (index > 0 && source[index - 1] !== '\n' && source[index - 1] !== '\r') return null;
    const match = source.slice(index).match(/^[ \t]*(model|view|enum|type|generator|datasource)[ \t]+([A-Za-z_]\w*)[ \t]*\{/);
    if (!match) return null;
    return {
        index,
        kind: match[1],
        name: match[2],
        openIndex: index + match[0].lastIndexOf('{'),
    };
}

function findNextBlockHeader(source, fromIndex) {
    let cursor = Math.max(0, fromIndex);
    if (cursor > 0 && source[cursor - 1] !== '\n' && source[cursor - 1] !== '\r') {
        const newline = source.indexOf('\n', cursor);
        if (newline === -1) return null;
        cursor = newline + 1;
    }

    while (cursor < source.length) {
        const header = matchBlockHeaderAt(source, cursor);
        if (header) return header;

        const char = source[cursor];
        const next = source[cursor + 1];
        if (char === '"' || char === "'") {
            cursor = skipString(source, cursor);
            continue;
        }
        if (char === '/' && next === '/') {
            cursor = skipLineComment(source, cursor);
            continue;
        }
        if (char === '/' && next === '*') {
            const commentEnd = source.indexOf('*/', cursor + 2);
            if (commentEnd !== -1) {
                cursor = commentEnd + 2;
                continue;
            }
        }

        const newline = source.indexOf('\n', cursor);
        if (newline === -1) return null;
        cursor = newline + 1;
    }

    return null;
}

function findBlockEnd(source, openIndex) {
    let depth = 1;
    let cursor = openIndex + 1;
    const attributeDelimiters = [];

    while (cursor < source.length) {
        if (depth === 1) {
            const nextHeader = matchBlockHeaderAt(source, cursor);
            if (nextHeader) return { closeIndex: -1, recoveryIndex: nextHeader.index };
        }

        const char = source[cursor];
        const next = source[cursor + 1];

        if (char === '"' || char === "'") {
            const string = readString(source, cursor);
            cursor = string.end;
            continue;
        }
        if (char === '/' && next === '/') {
            cursor = skipLineComment(source, cursor);
            continue;
        }
        if (char === '/' && next === '*') {
            const commentEnd = source.indexOf('*/', cursor + 2);
            if (commentEnd === -1) {
                const recovery = findNextBlockHeader(source, cursor + 2);
                return { closeIndex: -1, recoveryIndex: recovery?.index ?? source.length };
            }
            cursor = commentEnd + 2;
            continue;
        }
        if (char === '(' || char === '[') {
            attributeDelimiters.push(char);
            cursor += 1;
            continue;
        }
        if (char === '{' && attributeDelimiters.length > 0) {
            attributeDelimiters.push(char);
            cursor += 1;
            continue;
        }
        if (char === ')' || char === ']') {
            const expected = char === ')' ? '(' : '[';
            if (attributeDelimiters[attributeDelimiters.length - 1] === expected) {
                attributeDelimiters.pop();
            } else {
                const matchingIndex = attributeDelimiters.lastIndexOf(expected);
                if (matchingIndex !== -1) attributeDelimiters.splice(matchingIndex);
            }
            cursor += 1;
            continue;
        }
        if (char === '{' && attributeDelimiters.length === 0) depth += 1;
        if (char === '}') {
            if (attributeDelimiters[attributeDelimiters.length - 1] === '{') {
                attributeDelimiters.pop();
                cursor += 1;
                continue;
            }
            const lineStart = Math.max(source.lastIndexOf('\n', cursor - 1), source.lastIndexOf('\r', cursor - 1)) + 1;
            const isStandaloneClose = /^[ \t]*$/.test(source.slice(lineStart, cursor));
            if (attributeDelimiters.length > 0 && !isStandaloneClose) {
                cursor += 1;
                continue;
            }
            depth -= 1;
        }
        if (depth === 0) return { closeIndex: cursor, recoveryIndex: cursor + 1 };
        cursor += 1;
    }

    return { closeIndex: -1, recoveryIndex: source.length };
}

function skipWhitespace(source, index) {
    let cursor = index;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    return cursor;
}

function collectBlocks(source) {
    const blocks = [];
    const diagnostics = [];
    const locate = createSourceLocator(source);
    let cursor = 0;

    while (cursor < source.length) {
        const char = source[cursor];
        const next = source[cursor + 1];

        if (char === '"' || char === "'") {
            cursor = skipString(source, cursor);
            continue;
        }
        if (char === '/' && next === '/') {
            cursor = skipLineComment(source, cursor);
            continue;
        }
        if (char === '/' && next === '*') {
            cursor = skipBlockComment(source, cursor);
            continue;
        }
        if (char === '}') {
            const position = locate(cursor);
            diagnostics.push({
                severity: 'error',
                message: `Unexpected closing brace near line ${position.line}.`,
                ...position,
            });
            cursor += 1;
            continue;
        }

        if ((cursor === 0 || !isIdentifierChar(source[cursor - 1])) && /[A-Za-z_]/.test(char)) {
            const keyword = readIdentifier(source, cursor);
            if (keyword.value === 'model' || keyword.value === 'view' || keyword.value === 'enum' || keyword.value === 'type' || keyword.value === 'generator' || keyword.value === 'datasource') {
                let nameStart = skipWhitespace(source, keyword.end);
                const name = readIdentifier(source, nameStart);
                let openIndex = skipWhitespace(source, name.end);

                if (!name.value || source[openIndex] !== '{') {
                    const position = locate(cursor);
                    diagnostics.push({
                        severity: 'error',
                        message: `Invalid Prisma ${keyword.value} block near line ${position.line}.`,
                        ...position,
                    });
                    cursor = keyword.end;
                    continue;
                }

                const { closeIndex, recoveryIndex } = findBlockEnd(source, openIndex);
                const blockPosition = locate(cursor);
                if (closeIndex === -1) {
                    diagnostics.push({
                        severity: 'error',
                        message: `Missing closing brace for ${keyword.value} ${name.value}.`,
                        ...blockPosition,
                    });
                }

                const bodyEnd = closeIndex === -1 ? recoveryIndex : closeIndex;
                const bodyPosition = locate(openIndex + 1);
                blocks.push({
                    kind: keyword.value,
                    name: name.value,
                    body: source.slice(openIndex + 1, bodyEnd),
                    line: blockPosition.line,
                    bodyLine: bodyPosition.line,
                    bodyColumn: bodyPosition.column,
                    incomplete: closeIndex === -1,
                });
                cursor = closeIndex === -1 ? recoveryIndex : closeIndex + 1;
                continue;
            }
            cursor = keyword.end;
            continue;
        }

        cursor += 1;
    }

    return { blocks, diagnostics };
}

function collectLexicalDiagnostics(source) {
    const diagnostics = [];
    const locate = createSourceLocator(source);
    let cursor = 0;

    while (cursor < source.length) {
        const char = source[cursor];
        const next = source[cursor + 1];

        if (char === '"' || char === "'") {
            const string = readString(source, cursor);
            if (!string.closed) {
                const position = locate(cursor);
                diagnostics.push({
                    severity: 'error',
                    message: `Unterminated string near line ${position.line}.`,
                    ...position,
                });
            }
            cursor = string.end;
            continue;
        }
        if (char === '/' && next === '/') {
            cursor = skipLineComment(source, cursor);
            continue;
        }
        if (char === '/' && next === '*') {
            const end = source.indexOf('*/', cursor + 2);
            if (end === -1) {
                const position = locate(cursor);
                diagnostics.push({
                    severity: 'error',
                    message: `Unterminated block comment near line ${position.line}.`,
                    ...position,
                });
                const recovery = findNextBlockHeader(source, cursor + 2);
                cursor = recovery?.index ?? source.length;
                continue;
            }
            cursor = end + 2;
            continue;
        }
        cursor += 1;
    }

    return diagnostics;
}

function removeComments(text) {
    let output = '';
    let cursor = 0;

    while (cursor < text.length) {
        const char = text[cursor];
        const next = text[cursor + 1];

        if (char === '"' || char === "'") {
            const end = skipString(text, cursor);
            output += text.slice(cursor, end);
            cursor = end;
            continue;
        }

        if (char === '/' && next === '/') {
            const end = text.indexOf('\n', cursor + 2);
            if (end === -1) break;
            output += '\n';
            cursor = end + 1;
            continue;
        }

        if (char === '/' && next === '*') {
            const end = text.indexOf('*/', cursor + 2);
            const comment = end === -1 ? text.slice(cursor) : text.slice(cursor, end + 2);
            output += comment.replace(/[^\n]/g, '');
            cursor = end === -1 ? text.length : end + 2;
            continue;
        }

        output += char;
        cursor += 1;
    }

    return output;
}

function getDelimiterState(text) {
    const stack = [];
    const opening = new Set(['(', '[', '{']);
    const matchingOpening = {
        ')': '(',
        ']': '[',
        '}': '{',
    };
    let mismatched = false;
    let issue = null;

    for (let cursor = 0; cursor < text.length; cursor += 1) {
        const char = text[cursor];
        if (char === '"' || char === "'") {
            cursor = skipString(text, cursor) - 1;
            continue;
        }
        if (opening.has(char)) {
            stack.push(char);
            continue;
        }
        if (!matchingOpening[char]) continue;

        const expected = matchingOpening[char];
        if (stack[stack.length - 1] === expected) {
            stack.pop();
            continue;
        }

        mismatched = true;
        if (!issue) {
            const currentOpening = stack[stack.length - 1];
            const closing = { '(': ')', '[': ']', '{': '}' };
            issue = {
                kind: 'mismatch',
                found: char,
                expected: currentOpening ? closing[currentOpening] : null,
            };
        }
        const matchingIndex = stack.lastIndexOf(expected);
        if (matchingIndex !== -1) stack.splice(matchingIndex);
    }

    if (!issue && stack.length > 0) {
        const closing = { '(': ')', '[': ']', '{': '}' };
        issue = {
            kind: 'unclosed',
            found: null,
            expected: closing[stack[stack.length - 1]],
        };
    }

    return {
        depth: stack.length,
        unbalanced: mismatched || stack.length > 0,
        issue,
    };
}

function formatDelimiterIssue(issue) {
    if (!issue) return 'Check (), [], and {}.';
    if (issue.kind === 'mismatch' && issue.expected) return `Found ${issue.found} where ${issue.expected} was expected.`;
    if (issue.kind === 'mismatch') return `Found an unmatched ${issue.found}.`;
    return `Missing a closing ${issue.expected}.`;
}

function looksLikeNewBlockStatement(text) {
    return text.startsWith('@@') || /^[A-Za-z_]\w*\s+[A-Za-z_]/.test(text);
}

function splitBlockStatements(body, startLine, startColumn = 1) {
    const cleanBody = removeComments(body);
    const lines = cleanBody.split('\n');
    const statements = [];
    let buffer = '';
    let statementLine = startLine;
    let statementColumn = 1;
    let delimiterState = { depth: 0, unbalanced: false, issue: null };

    lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed && !buffer) return;

        if (buffer && delimiterState.depth > 0 && looksLikeNewBlockStatement(trimmed)) {
            statements.push({ text: buffer.trim(), line: statementLine, column: statementColumn, unbalanced: true, delimiterIssue: delimiterState.issue });
            buffer = '';
            delimiterState = { depth: 0, unbalanced: false, issue: null };
        }

        if (!buffer && /^@(?!@)/.test(trimmed) && statements.length > 0 && !statements[statements.length - 1].text.startsWith('@@')) {
            const previous = statements.pop();
            buffer = previous.text;
            statementLine = previous.line;
            statementColumn = previous.column;
        }

        if (!buffer) {
            statementLine = startLine + index;
            const contentOffset = Math.max(0, line.search(/\S/));
            statementColumn = index === 0 ? startColumn + contentOffset : contentOffset + 1;
        }
        buffer += buffer ? ` ${trimmed}` : trimmed;
        delimiterState = getDelimiterState(buffer);

        if (delimiterState.depth === 0 && buffer.trim()) {
            statements.push({
                text: buffer.trim(),
                line: statementLine,
                column: statementColumn,
                unbalanced: delimiterState.unbalanced,
                delimiterIssue: delimiterState.issue,
            });
            buffer = '';
            delimiterState = { depth: 0, unbalanced: false, issue: null };
        }
    });

    if (buffer.trim()) {
        statements.push({
            text: buffer.trim(),
            line: statementLine,
            column: statementColumn,
            unbalanced: delimiterState.unbalanced,
            delimiterIssue: delimiterState.issue,
        });
    }

    return statements;
}

function splitTopLevel(text, separator = ',') {
    const parts = [];
    let cursor = 0;
    let start = 0;
    let parens = 0;
    let brackets = 0;

    while (cursor < text.length) {
        const char = text[cursor];
        if (char === '"' || char === "'") {
            cursor = skipString(text, cursor);
            continue;
        }
        if (char === '(') parens += 1;
        else if (char === ')') parens -= 1;
        else if (char === '[') brackets += 1;
        else if (char === ']') brackets -= 1;
        else if (char === separator && parens === 0 && brackets === 0) {
            parts.push(text.slice(start, cursor).trim());
            start = cursor + 1;
        }
        cursor += 1;
    }

    parts.push(text.slice(start).trim());
    return parts.filter(Boolean);
}

function splitFieldStatement(statement) {
    const parts = [];
    let cursor = 0;
    let tokenStart = 0;
    let parens = 0;
    let brackets = 0;

    while (cursor < statement.length && parts.length < 2) {
        const char = statement[cursor];
        if (char === '"' || char === "'") {
            cursor = skipString(statement, cursor);
            continue;
        }
        if (char === '(') parens += 1;
        else if (char === ')') parens -= 1;
        else if (char === '[') brackets += 1;
        else if (char === ']') brackets -= 1;
        else if (/\s/.test(char) && parens === 0 && brackets === 0) {
            const token = statement.slice(tokenStart, cursor).trim();
            if (token) parts.push(token);
            while (cursor < statement.length && /\s/.test(statement[cursor])) cursor += 1;
            tokenStart = cursor;
            continue;
        }
        cursor += 1;
    }

    const rest = statement.slice(tokenStart).trim();
    if (parts.length < 2) {
        const [type = '', ...tail] = rest.split(/\s+/);
        parts.push(type);
        return { name: parts[0] || '', type: parts[1] || '', attributes: tail.join(' ') };
    }

    return {
        name: parts[0] || '',
        type: parts[1] || '',
        attributes: statement.slice(cursor).trim(),
    };
}

function hasAttribute(attributes, name) {
    return new RegExp(`(^|\\s)@${name}\\b`).test(attributes || '');
}

function parsePrismaStringLiteral(value) {
    const text = String(value || '').trim();
    if (!/^"(?:\\.|[^"\\])*"$/.test(text)) return null;

    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function extractStringArg(text, attrName) {
    const call = findBalancedAttributeCall(text, attrName);
    if (!call) return null;
    const [firstArg] = splitTopLevel(call.args);
    const positional = parsePrismaStringLiteral(firstArg);
    if (positional !== null) return positional;
    return extractNamedStringArg(call.args, 'name');
}

function extractNamedStringArg(text, name) {
    return parsePrismaStringLiteral(getNamedPrismaArgument(text, name));
}

function extractFirstArrayArg(text) {
    const value = splitTopLevel(String(text || '')).find(part => part.trim().startsWith('['));
    return value?.trim().endsWith(']') ? splitFieldList(value.trim().slice(1, -1)) : [];
}

function extractNamedArrayArg(text, name) {
    const value = getNamedPrismaArgument(text, name);
    return value?.startsWith('[') && value.endsWith(']') ? splitFieldList(value.slice(1, -1)) : [];
}

function hasNamedArgument(text, name) {
    return getNamedPrismaArgument(text, name) !== null;
}

// Read argument boundaries before names: quoted relation/index names can contain
// colons, commas, brackets, or text such as "fields: [id]" without declaring it.
function getNamedPrismaArgument(text, name) {
    const part = splitTopLevel(String(text || '')).find(argument => argument.trim().match(/^([A-Za-z_]\w*)\s*:/)?.[1] === name);
    return part === undefined ? null : part.slice(part.indexOf(':') + 1).trim();
}

function splitFieldList(text) {
    return splitTopLevel(text).map((part) => part.replace(/^["']|["']$/g, '').replace(/\(.+$/, '').trim()).filter(Boolean);
}

function parseType(typeText) {
    const type = typeText.trim();
    const modifier = type.endsWith('[]') ? '[]' : type.endsWith('?') ? '?' : '';
    const baseType = modifier ? type.slice(0, -modifier.length) : type;
    const validBaseType = /^[A-Za-z_]\w*$/.test(baseType) || /^Unsupported\("(?:\\.|[^"\\])*"\)$/.test(baseType);
    return {
        baseType,
        isList: modifier === '[]',
        isOptional: modifier === '?',
        valid: validBaseType && !/[?\[\]]/.test(baseType),
    };
}

function validateFieldAttributes(attributes) {
    const source = String(attributes || '');
    let cursor = 0;

    while (cursor < source.length) {
        while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
        if (cursor >= source.length) return null;
        if (source[cursor] !== '@' || source[cursor + 1] === '@') return source.slice(cursor).split(/\s+/)[0] || source[cursor];

        cursor += 1;
        const name = source.slice(cursor).match(/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?/);
        if (!name) return source.slice(cursor - 1).split(/\s+/)[0] || '@';
        cursor += name[0].length;

        if (source[cursor] !== '(') continue;
        let depth = 1;
        cursor += 1;
        while (cursor < source.length && depth > 0) {
            const char = source[cursor];
            if (char === '"' || char === "'") {
                cursor = skipString(source, cursor);
                continue;
            }
            if (char === '(') depth += 1;
            if (char === ')') depth -= 1;
            cursor += 1;
        }
    }

    return null;
}

function parseEnumBlock(block, diagnostics) {
    const statements = splitBlockStatements(block.body, block.bodyLine ?? block.line, block.bodyColumn);
    const values = [];
    const seenValues = new Set();
    let dbName = block.name;
    let schemaName = null;

    statements.forEach(({ text, line, column, unbalanced, delimiterIssue }) => {
        if (unbalanced) {
            diagnostics.push({
                severity: 'error',
                message: `enum ${block.name} has unbalanced attribute delimiters. ${formatDelimiterIssue(delimiterIssue)}`,
                line,
                column,
            });
        }
        if (text.startsWith('@@map')) {
            dbName = extractStringArg(text, '@@map') || dbName;
            return;
        }
        if (text.startsWith('@@schema')) {
            schemaName = extractStringArg(text, '@@schema') || schemaName;
            return;
        }
        if (text.startsWith('@') || text.startsWith('@@')) return;
        const [name, ...tail] = text.split(/\s+/);
        if (!name) return;
        if (!/^[A-Za-z]\w*$/.test(name)) {
            diagnostics.push({
                severity: 'error',
                message: `${block.name} enum value ${name} must start with a letter and contain only letters, numbers, or underscores.`,
                line,
                column,
            });
        }
        if (tail.length > 0 && !tail.join(' ').trim().startsWith('@map')) {
            diagnostics.push({
                severity: 'error',
                message: `enum ${block.name} has an invalid value declaration for ${name}.`,
                line,
                column,
            });
            return;
        }
        if (seenValues.has(name)) {
            diagnostics.push({
                severity: 'error',
                message: `${block.name} defines duplicate enum value ${name}.`,
                line,
                column,
            });
            return;
        }
        seenValues.add(name);
        values.push({
            name,
            dbName: extractStringArg(tail.join(' '), '@map') || name,
        });
    });

    return { name: block.name, dbName, schemaName, values, line: block.line };
}

function parseModelBlock(block, diagnostics) {
    const statements = splitBlockStatements(block.body, block.bodyLine ?? block.line, block.bodyColumn);
    const fields = [];
    const blockAttributes = [];
    const seenFields = new Set();
    let dbName = block.name;
    let schemaName = null;
    let ignored = false;

    statements.forEach(({ text, line, column, unbalanced, delimiterIssue }) => {
        if (text.startsWith('@@')) {
            if (unbalanced) {
                diagnostics.push({
                    severity: 'error',
                    message: `${block.kind} ${block.name} has unbalanced field or attribute delimiters in a block attribute. ${formatDelimiterIssue(delimiterIssue)}`,
                    line,
                    column,
                });
            }
            if (text.startsWith('@@map')) dbName = extractStringArg(text, '@@map') || dbName;
            if (text.startsWith('@@schema')) schemaName = extractStringArg(text, '@@schema') || schemaName;
            if (text.startsWith('@@ignore')) ignored = true;
            blockAttributes.push({ text, line, unbalanced });
            return;
        }
        if (text.startsWith('@')) return;

        const field = splitFieldStatement(text);
        if (!field.name || !field.type) {
            diagnostics.push({
                severity: 'error',
                message: unbalanced
                    ? `${block.kind} ${block.name} has unbalanced field or attribute delimiters. ${formatDelimiterIssue(delimiterIssue)}`
                    : `${block.kind} ${block.name} has an invalid field declaration.`,
                line,
                column,
            });
            return;
        }
        const parsedType = parseType(field.type);
        if (!/^[A-Za-z]\w*$/.test(field.name)) {
            diagnostics.push({
                severity: 'error',
                message: `${block.name} field ${field.name} must start with a letter and contain only letters, numbers, or underscores.`,
                line,
                column,
            });
        }
        if (!parsedType.valid) {
            diagnostics.push({
                severity: 'error',
                message: `${block.kind} ${block.name} field ${field.name || '(unknown)'} has an invalid field type ${field.type || '(missing)'}.`,
                line,
                column,
            });
            return;
        }
        const unexpectedAttributeContent = validateFieldAttributes(field.attributes);
        if (!unbalanced && unexpectedAttributeContent) {
            diagnostics.push({
                severity: 'error',
                message: `${block.kind} ${block.name} field ${field.name} has unexpected content after the field type: ${unexpectedAttributeContent}.`,
                line,
                column,
            });
        }
        if (unbalanced) {
            diagnostics.push({
                severity: 'error',
                message: `${block.kind} ${block.name} field ${field.name} has unbalanced field or attribute delimiters. ${formatDelimiterIssue(delimiterIssue)}`,
                line,
                column,
            });
        }
        if (seenFields.has(field.name)) {
            diagnostics.push({
                severity: 'error',
                message: `${block.name} defines duplicate field ${field.name}.`,
                line,
                column,
            });
            return;
        }
        seenFields.add(field.name);
        fields.push({
            ...field,
            ...parsedType,
            dbName: extractStringArg(field.attributes, '@map') || field.name,
            ignored: hasAttribute(field.attributes, 'ignore'),
            unbalanced,
            invalidSyntax: Boolean(unexpectedAttributeContent),
            line,
            column,
        });
    });

    return { kind: block.kind, name: block.name, dbName, schemaName, fields, blockAttributes, ignored, line: block.line };
}

function parseCompositeBlock(block, diagnostics) {
    const statements = splitBlockStatements(block.body, block.bodyLine ?? block.line, block.bodyColumn);
    const fields = [];
    const seenFields = new Set();

    statements.forEach(({ text, line, column, unbalanced, delimiterIssue }) => {
        if (!text || text.startsWith('@')) return;

        const field = splitFieldStatement(text);
        if (!field.name || !field.type) {
            diagnostics.push({
                severity: 'error',
                message: unbalanced
                    ? `type ${block.name} has unbalanced field or attribute delimiters. ${formatDelimiterIssue(delimiterIssue)}`
                    : `type ${block.name} has an invalid field declaration.`,
                line,
                column,
            });
            return;
        }
        const parsedType = parseType(field.type);
        if (!/^[A-Za-z]\w*$/.test(field.name)) {
            diagnostics.push({
                severity: 'error',
                message: `${block.name} field ${field.name} must start with a letter and contain only letters, numbers, or underscores.`,
                line,
                column,
            });
        }
        if (!parsedType.valid) {
            diagnostics.push({
                severity: 'error',
                message: `type ${block.name} field ${field.name || '(unknown)'} has an invalid field type ${field.type || '(missing)'}.`,
                line,
                column,
            });
            return;
        }
        const unexpectedAttributeContent = validateFieldAttributes(field.attributes);
        if (!unbalanced && unexpectedAttributeContent) {
            diagnostics.push({
                severity: 'error',
                message: `type ${block.name} field ${field.name} has unexpected content after the field type: ${unexpectedAttributeContent}.`,
                line,
                column,
            });
        }
        if (unbalanced) {
            diagnostics.push({
                severity: 'error',
                message: `type ${block.name} field ${field.name} has unbalanced field or attribute delimiters. ${formatDelimiterIssue(delimiterIssue)}`,
                line,
                column,
            });
        }
        if (seenFields.has(field.name)) {
            diagnostics.push({
                severity: 'error',
                message: `${block.name} defines duplicate field ${field.name}.`,
                line,
                column,
            });
            return;
        }
        seenFields.add(field.name);
        fields.push({
            ...field,
            ...parsedType,
            dbName: extractStringArg(field.attributes, '@map') || field.name,
            unbalanced,
            invalidSyntax: Boolean(unexpectedAttributeContent),
            line,
            column,
        });
    });

    return { name: block.name, fields, line: block.line };
}

function parseQuotedConfigValue(value) {
    return parsePrismaStringLiteral(value);
}

function parseQuotedConfigArray(value) {
    const text = String(value || '').trim();
    if (!text.startsWith('[') || !text.endsWith(']')) return null;

    const items = splitTopLevel(text.slice(1, -1));
    const values = items.map(parseQuotedConfigValue);
    return values.every((item) => typeof item === 'string') ? values : null;
}

function parseDatasourceBlock(block, diagnostics) {
    const statements = splitBlockStatements(block.body, block.bodyLine ?? block.line, block.bodyColumn);
    const settings = new Map();

    statements.forEach(({ text, line, column, unbalanced, delimiterIssue }) => {
        if (unbalanced) {
            diagnostics.push({
                severity: 'error',
                message: `datasource ${block.name} has unbalanced configuration delimiters. ${formatDelimiterIssue(delimiterIssue)}`,
                line,
                column,
            });
        }

        const assignment = text.match(/^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/);
        if (!assignment) {
            diagnostics.push({
                severity: 'error',
                message: `datasource ${block.name} has an invalid configuration entry.`,
                line,
                column,
            });
            return;
        }

        const [, key, rawValue] = assignment;
        if (settings.has(key)) {
            diagnostics.push({
                severity: 'error',
                message: `datasource ${block.name} defines ${key} more than once.`,
                line,
                column,
            });
            return;
        }
        settings.set(key, { rawValue: rawValue.trim(), line, column });
    });

    const providerSetting = settings.get('provider');
    const relationModeSetting = settings.get('relationMode');
    const schemasSetting = settings.get('schemas');
    const extensionsSetting = settings.get('extensions');
    const provider = parseQuotedConfigValue(providerSetting?.rawValue);
    const relationMode = parseQuotedConfigValue(relationModeSetting?.rawValue);
    const schemas = schemasSetting ? parseQuotedConfigArray(schemasSetting.rawValue) : [];

    if (!providerSetting) {
        diagnostics.push({
            severity: 'error',
            message: `datasource ${block.name} is missing a provider.`,
            line: block.line,
        });
    } else if (!provider) {
        diagnostics.push({
            severity: 'error',
            message: `datasource ${block.name} provider must be a quoted Prisma connector name.`,
            line: providerSetting.line,
            column: providerSetting.column,
        });
    } else if (!PRISMA_PROVIDERS.has(provider)) {
        const sqlServerHint = provider === 'mssql' ? ' Use "sqlserver" for Microsoft SQL Server.' : '';
        diagnostics.push({
            severity: 'error',
            message: `datasource ${block.name} uses unsupported provider "${provider}".${sqlServerHint}`,
            line: providerSetting.line,
            column: providerSetting.column,
        });
    }

    if (relationModeSetting && !['foreignKeys', 'prisma'].includes(relationMode)) {
        diagnostics.push({
            severity: 'error',
            message: `datasource ${block.name} relationMode must be "foreignKeys" or "prisma".`,
            line: relationModeSetting.line,
            column: relationModeSetting.column,
        });
    }

    if (provider === 'mongodb' && relationModeSetting && relationMode === 'foreignKeys') {
        diagnostics.push({
            severity: 'error',
            message: `datasource ${block.name} uses MongoDB, which only supports relationMode = "prisma".`,
            line: relationModeSetting.line,
            column: relationModeSetting.column,
        });
    }

    if (schemasSetting && !schemas) {
        diagnostics.push({
            severity: 'error',
            message: `datasource ${block.name} schemas must be an array of quoted schema names.`,
            line: schemasSetting.line,
            column: schemasSetting.column,
        });
    }

    return {
        name: block.name,
        provider,
        // MongoDB always uses Prisma's relation emulation. Relational
        // connectors default to database foreign keys when the setting is
        // omitted. Invalid MongoDB input is diagnosed above, but normalizing
        // here keeps downstream relation validation aligned with the actual
        // connector contract.
        relationMode: provider === 'mongodb' ? 'prisma' : relationMode || 'foreignKeys',
        schemas: schemas || [],
        extensions: extensionsSetting?.rawValue || null,
        line: block.line,
        providerLine: providerSetting?.line || block.line,
        schemasLine: schemasSetting?.line || block.line,
        extensionsLine: extensionsSetting?.line || block.line,
    };
}

// First pass: collect top-level Prisma blocks and normalize them into models,
// enums, composites, datasource config, and diagnostics with source positions.
function parsePrismaSchema(source) {
    const { blocks, diagnostics } = collectBlocks(source);
    diagnostics.unshift(...collectLexicalDiagnostics(source));
    const enums = [];
    const models = [];
    const composites = [];
    const datasources = [];
    const seenDefinitions = new Map();

    blocks.forEach((block) => {
        if (block.kind === 'generator') return;
        if (block.kind === 'datasource') {
            datasources.push(parseDatasourceBlock(block, diagnostics));
            return;
        }

        if (!/^[A-Za-z]\w*$/.test(block.name)) {
            diagnostics.push({
                severity: 'error',
                message: `${block.kind} name ${block.name} must start with a letter and contain only letters, numbers, or underscores.`,
                line: block.line,
            });
        }

        const previous = seenDefinitions.get(block.name);
        if (previous) {
            diagnostics.push({
                severity: 'error',
                message: `${block.kind} ${block.name} conflicts with the ${previous.kind} declared on line ${previous.line}.`,
                line: block.line,
            });
            return;
        }
        seenDefinitions.set(block.name, { kind: block.kind, line: block.line });

        if (block.kind === 'enum') {
            enums.push(parseEnumBlock(block, diagnostics));
        } else if (block.kind === 'type') {
            composites.push(parseCompositeBlock(block, diagnostics));
        } else if (block.kind === 'model' || block.kind === 'view') {
            models.push(parseModelBlock(block, diagnostics));
        }
    });

    if (datasources.length > 1) {
        datasources.slice(1).forEach((datasource) => {
            diagnostics.push({
                severity: 'error',
                message: `Prisma schemas can define only one datasource; remove datasource ${datasource.name}.`,
                line: datasource.line,
            });
        });
    }

    return { enums, models, composites, datasource: datasources[0] || null, diagnostics };
}

function quoteIdentifier(identifier) {
    return `"${String(identifier || '').replace(/"/g, '""')}"`;
}

function quoteDatabaseObject(name, schemaName = null) {
    const objectName = quoteIdentifier(name);
    return schemaName ? `${quoteIdentifier(schemaName)}.${objectName}` : objectName;
}

function quoteLiteral(value) {
    return `'${String(value || '').replace(/'/g, "''")}'`;
}

function safeIdentifierName(value) {
    return String(value || 'item')
        .replace(/[^A-Za-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48) || 'item';
}

function extractNativeDbType(attributes) {
    const match = String(attributes || '').match(/(?:^|\s)@([A-Za-z_]\w*)\.([A-Za-z0-9_]+)/);
    if (!match) return null;
    const attributeName = `@${match[1]}.${match[2]}`;
    const call = findBalancedAttributeCall(attributes, attributeName);

    return {
        namespace: match[1],
        name: match[2],
        args: call?.args ? call.args.replace(/\s+/g, '') : '',
    };
}

function mapNativeDbType(nativeType) {
    if (!nativeType) return null;
    const name = nativeType.name.toLowerCase();
    const args = nativeType.args ? `(${nativeType.args})` : '';

    const exact = {
        uuid: 'UUID',
        text: 'TEXT',
        citext: 'TEXT',
        mediumtext: 'TEXT',
        longtext: 'TEXT',
        tinytext: 'TEXT',
        boolean: 'BOOLEAN',
        bool: 'BOOLEAN',
        date: 'DATE',
        datetime: 'TIMESTAMP',
        timestamp: 'TIMESTAMP',
        timestamptz: 'TIMESTAMPTZ',
        time: 'TIME',
        json: 'JSON',
        jsonb: 'JSONB',
        bytea: 'BYTEA',
        bytes: 'BYTEA',
        smallint: 'SMALLINT',
        int: 'INTEGER',
        integer: 'INTEGER',
        bigint: 'BIGINT',
        real: 'REAL',
        double: 'DOUBLE PRECISION',
        doubleprecision: 'DOUBLE PRECISION',
        money: 'DECIMAL',
    };

    if (name === 'varchar' || name === 'nvarchar' || name === 'char' || name === 'nchar') return `${name.toUpperCase()}${args || '(255)'}`;
    if (name === 'decimal' || name === 'numeric') return `${name.toUpperCase()}${args}`;
    return exact[name] || null;
}

function mapPrismaTypeToSql(field, enumByName, compositeByName, diagnostics) {
    const nativeSqlType = mapNativeDbType(extractNativeDbType(field.attributes));
    if (nativeSqlType) return nativeSqlType;

    if (field.baseType.startsWith('Unsupported(')) {
        const unsupported = field.baseType.match(/Unsupported\("([^"]+)"\)/);
        if (unsupported?.[1]) return unsupported[1].toUpperCase();
        diagnostics.push({
            severity: 'warning',
            message: `${field.name} uses Unsupported(), so it was rendered as TEXT.`,
            line: field.line,
        });
        return 'TEXT';
    }

    if (enumByName.has(field.baseType)) {
        const enumType = enumByName.get(field.baseType);
        return quoteDatabaseObject(enumType.dbName, enumType.schemaName);
    }
    if (compositeByName.has(field.baseType)) return 'JSONB';

    const map = {
        String: 'TEXT',
        Boolean: 'BOOLEAN',
        Int: 'INTEGER',
        BigInt: 'BIGINT',
        Float: 'DOUBLE PRECISION',
        Decimal: 'DECIMAL',
        DateTime: 'TIMESTAMP',
        Json: 'JSONB',
        Bytes: 'BYTEA',
    };

    const sqlType = map[field.baseType];
    if (!sqlType) {
        diagnostics.push({
            severity: 'warning',
            message: `${field.name} uses custom type ${field.baseType}; rendered as TEXT for the ERD preview.`,
            line: field.line,
        });
        return 'TEXT';
    }

    if (field.isList) {
        diagnostics.push({
            severity: 'warning',
            message: `${field.name} is a scalar list; rendered as JSONB for the ERD preview.`,
            line: field.line,
        });
        return 'JSONB';
    }

    return sqlType;
}

function parseBlockAttribute(attribute) {
    const text = attribute.text;
    const attributeName = text.match(/^@@[A-Za-z_]\w*/)?.[0];
    const args = attributeName ? findBalancedAttributeCall(text, attributeName)?.args : '';
    const columns = hasNamedArgument(args, 'fields') ? extractNamedArrayArg(args, 'fields') : extractFirstArrayArg(args);
    const name = extractNamedStringArg(args, 'map') || extractNamedStringArg(args, 'name');
    const base = { columns, name, line: attribute.line, raw: text, partial: hasNamedArgument(args, 'where') };

    if (text.startsWith('@@id')) return { kind: 'id', ...base };
    if (text.startsWith('@@unique')) return { kind: 'unique', ...base };
    if (text.startsWith('@@index')) return { kind: 'index', ...base };
    if (text.startsWith('@@fulltext')) return { kind: 'fulltext', ...base };
    return null;
}

function makeModelIndexes(model, fieldByName, diagnostics) {
    return model.blockAttributes.filter((attribute) => !attribute.unbalanced).map(parseBlockAttribute).filter(Boolean).map((attribute) => ({
        ...attribute,
        validKey: isValidPrismaKeyGroup(attribute.columns, fieldByName, true),
        dbColumns: attribute.columns
            .map((column) => {
                const field = fieldByName.get(column) || fieldByName.get(column.split('.')[0]);
                if (!field) {
                    diagnostics.push({
                        severity: 'warning',
                        message: `${model.name} has ${attribute.kind} on unknown field ${column}.`,
                        line: attribute.line,
                    });
                    return null;
                }
                return field.dbName;
            })
            .filter(Boolean),
    }));
}

function buildRelationConstraints(model, modelByName, fieldByName, diagnostics) {
    const constraints = [];
    const relationFields = model.fields.filter((field) => field.kind === 'relation' && !field.ignored);

    relationFields.forEach((field) => {
        if (field.unbalanced || field.invalidSyntax) return;
        const relationArgs = extractRelationCall(field)?.args || '';
        const sourceFieldNames = extractNamedArrayArg(relationArgs, 'fields');
        const targetFieldNames = extractNamedArrayArg(relationArgs, 'references');

        if (!sourceFieldNames.length && field.isList) {
            const targetModel = modelByName.get(field.baseType);
            const explicitOpposite = targetModel?.fields?.some((candidate) => {
                const candidateArgs = extractRelationCall(candidate)?.args || '';
                return candidate.baseType === model.name && extractRelationName(candidate) === extractRelationName(field) && extractNamedArrayArg(candidateArgs, 'fields').length > 0 && extractNamedArrayArg(candidateArgs, 'references').length > 0;
            });

            if (!explicitOpposite) {
                diagnostics.push({
                    severity: 'warning',
                    message: `${model.name}.${field.name} uses an implicit many-to-many relation; SQL export omits implicit join tables. Add an explicit join model when you need join-table SQL.`,
                    line: field.line,
                });
            }
            return;
        }

        if (!sourceFieldNames.length && !targetFieldNames.length) return;

        if (sourceFieldNames.length !== targetFieldNames.length || sourceFieldNames.length === 0) {
            diagnostics.push({
                severity: 'warning',
                message: `${model.name}.${field.name} has a relation with incomplete fields/references metadata.`,
                line: field.line,
            });
            return;
        }
        if (new Set(sourceFieldNames).size !== sourceFieldNames.length || new Set(targetFieldNames).size !== targetFieldNames.length) return;

        const targetModel = modelByName.get(field.baseType);
        if (!targetModel) {
            diagnostics.push({
                severity: 'warning',
                message: `${model.name}.${field.name} references unknown model ${field.baseType}.`,
                line: field.line,
            });
            return;
        }

        const targetFieldByName = new Map(targetModel.fields.filter((candidate) => candidate.kind === 'scalar' && !candidate.ignored).map((candidate) => [candidate.name, candidate]));
        const sourceColumns = sourceFieldNames.map((name) => fieldByName.get(name)?.dbName || name);
        const targetColumns = targetFieldNames.map((name) => targetFieldByName.get(name)?.dbName || name);
        const missingSource = sourceFieldNames.find((name) => !fieldByName.has(name));
        const missingTarget = targetFieldNames.find((name) => !targetFieldByName.has(name));

        if (missingSource || missingTarget) {
            diagnostics.push({
                severity: 'warning',
                message: `${model.name}.${field.name} references ${missingSource || missingTarget}, but that scalar field was not found.`,
                line: field.line,
            });
            return;
        }

        const fkName = extractNamedStringArg(relationArgs, 'map') || `fk_${safeIdentifierName(model.dbName)}_${sourceColumns.map(safeIdentifierName).join('_')}`;
        const actions = relationActionsFromPrismaField(field);
        const actionSql = {
            Cascade: 'CASCADE',
            Restrict: 'RESTRICT',
            NoAction: 'NO ACTION',
            SetNull: 'SET NULL',
            SetDefault: 'SET DEFAULT',
        };
        const clauses = [];
        if (actionSql[actions.onDelete]) clauses.push(`ON DELETE ${actionSql[actions.onDelete]}`);
        if (actionSql[actions.onUpdate]) clauses.push(`ON UPDATE ${actionSql[actions.onUpdate]}`);
        constraints.push(`CONSTRAINT ${quoteIdentifier(fkName)} FOREIGN KEY (${sourceColumns.map(quoteIdentifier).join(', ')}) REFERENCES ${quoteDatabaseObject(targetModel.dbName, targetModel.schemaName)} (${targetColumns.map(quoteIdentifier).join(', ')})${clauses.length > 0 ? ` ${clauses.join(' ')}` : ''}`);
    });

    return constraints;
}

function normalizeModels(parsed, diagnostics) {
    const enumByName = new Map(parsed.enums.map((item) => [item.name, item]));
    const compositeByName = new Map(parsed.composites.map((item) => [item.name, item]));
    const activeModels = parsed.models.filter((model) => !model.ignored);
    const modelByName = new Map(activeModels.map((model) => [model.name, model]));

    activeModels.forEach((model) => {
        const seenDbNames = new Set();
        model.fields.forEach((field) => {
            field.kind = modelByName.has(field.baseType) || hasAttribute(field.attributes, 'relation') ? 'relation' : 'scalar';
            if (field.ignored || field.unbalanced || field.invalidSyntax || field.kind !== 'scalar') return;
            const foldColumnCase = ['mysql', 'sqlite', 'sqlserver'].includes(parsed.datasource?.provider);
            const key = foldColumnCase ? field.dbName.toLowerCase() : field.dbName;
            if (seenDbNames.has(key)) {
                diagnostics.push({
                    severity: 'warning',
                    message: `${model.name} maps multiple fields to column ${field.dbName}.`,
                    line: field.line,
                });
            }
            seenDbNames.add(key);
            if (!PRISMA_SCALAR_TYPES.has(field.baseType) && !enumByName.has(field.baseType) && !compositeByName.has(field.baseType) && !field.baseType.startsWith('Unsupported(')) {
                diagnostics.push({
                    severity: 'warning',
                    message: `${model.name}.${field.name} uses unknown scalar type ${field.baseType}.`,
                    line: field.line,
                });
            }
        });
    });

    return { enumByName, compositeByName, activeModels, modelByName };
}

function getModelIdentityMetadata(model) {
    const scalarFields = model.fields.filter((field) => field.kind === 'scalar' && !field.ignored && !field.unbalanced && !field.invalidSyntax);
    const scalarFieldByName = new Map(scalarFields.map((field) => [field.name, field]));
    const fieldIds = scalarFields.filter((field) => hasAttribute(field.attributes, 'id'));
    const fieldUniques = scalarFields.filter((field) => hasAttribute(field.attributes, 'unique'));
    const groups = model.blockAttributes
        .filter((attribute) => !attribute.unbalanced)
        .map(parseBlockAttribute)
        .filter(Boolean);

    return {
        scalarFieldByName,
        fieldIds,
        fieldUniques,
        blockIds: groups.filter((group) => group.kind === 'id'),
        blockUniques: groups.filter((group) => group.kind === 'unique'),
    };
}

function isPartialUniqueField(field) {
    const uniqueAttribute = findBalancedAttributeCall(field?.attributes, 'unique');
    return hasNamedArgument(uniqueAttribute?.args, 'where');
}

function isPartialUniqueGroup(group) {
    return group?.kind === 'unique' && group.partial;
}

function validateModelIdentitySemantics(parsed, helpers, diagnostics) {
    // Model-only snippets remain useful in the workbench. Connector-level
    // identity validation begins when the input includes a supported
    // datasource and therefore represents a complete Prisma schema.
    if (!parsed.datasource || !PRISMA_PROVIDERS.has(parsed.datasource.provider)) return;

    const configuredSchemas = parsed.datasource.schemas || [];
    if (configuredSchemas.length > 0) {
        [...parsed.enums, ...helpers.activeModels].forEach((item) => {
            if (!item.schemaName) {
                diagnostics.push({
                    severity: 'error',
                    message: `${item.name} must declare @@schema because datasource ${parsed.datasource.name} lists database schemas.`,
                    line: item.line,
                });
                return;
            }
            if (!configuredSchemas.includes(item.schemaName)) {
                diagnostics.push({
                    severity: 'error',
                    message: `${item.name} uses @@schema(${JSON.stringify(item.schemaName)}), which is not listed in datasource ${parsed.datasource.name} schemas.`,
                    line: item.line,
                });
            }
        });
    }

    // Prisma model names can differ while @@map points them at the same
    // database object. Qualify the key by @@schema so legitimate same-name
    // tables in separate database schemas remain valid.
    const databaseObjectOwners = new Map();
    helpers.activeModels.forEach((model) => {
        const databaseObjectKey = `${model.schemaName || ''}\u0000${model.dbName}`;
        const previous = databaseObjectOwners.get(databaseObjectKey);
        if (!previous) {
            databaseObjectOwners.set(databaseObjectKey, model);
            return;
        }
        const qualifiedName = model.schemaName ? `${model.schemaName}.${model.dbName}` : model.dbName;
        diagnostics.push({
            severity: 'error',
            message: `${previous.name} and ${model.name} both map to ${qualifiedName}; give each model or view a distinct database object.`,
            line: model.line,
        });
    });

    helpers.activeModels.filter((model) => model.kind === 'model').forEach((model) => {
        const identity = getModelIdentityMetadata(model);
        const idDefinitionCount = identity.fieldIds.length + identity.blockIds.length;

        if (idDefinitionCount > 1) {
            diagnostics.push({
                severity: 'error',
                message: `${model.name} can define only one ID; use one @id field or one @@id block.`,
                line: identity.fieldIds[1]?.line || identity.blockIds[0]?.line || model.line,
            });
        }

        identity.fieldIds.forEach((field) => {
            if (!field.isOptional && !field.isList) return;
            diagnostics.push({
                severity: 'error',
                message: `${model.name}.${field.name} uses @id but is ${field.isList ? 'a list' : 'optional'}; Prisma IDs must be required scalar fields.`,
                line: field.line,
                column: field.column,
            });
        });

        identity.blockIds.forEach((group) => {
            const invalidField = group.columns
                .map((fieldName) => identity.scalarFieldByName.get(fieldName))
                .find((field) => field && (field.isOptional || field.isList));
            if (!invalidField) return;
            diagnostics.push({
                severity: 'error',
                message: `${model.name} @@id fields must be required scalars; ${invalidField.name} is ${invalidField.isList ? 'a list' : 'optional'}.`,
                line: group.line,
            });
        });

        identity.blockUniques.forEach((group) => {
            const optionalFields = group.columns.filter((fieldName) => identity.scalarFieldByName.get(fieldName)?.isOptional);
            if (optionalFields.length === 0) return;
            diagnostics.push({
                severity: 'error',
                message: `${model.name} @@unique fields must be required; make ${optionalFields.join(', ')} required.`,
                line: group.line,
            });
        });

        const hasRequiredUniqueField = identity.fieldUniques.some((field) => !field.isOptional && !field.isList && !isPartialUniqueField(field));
        const hasValidBlockUnique = identity.blockUniques.some((group) => {
            if (group.columns.length === 0) return false;
            // A partial unique index describes only a subset of rows and
            // therefore cannot be the criterion that identifies every record.
            if (isPartialUniqueGroup(group)) return false;
            return group.columns.every((fieldName) => {
                const field = identity.scalarFieldByName.get(fieldName);
                return field && !field.isOptional && !field.isList;
            });
        });
        const hasValidId = idDefinitionCount === 1 && (
            (identity.fieldIds.length === 1 && !identity.fieldIds[0].isOptional && !identity.fieldIds[0].isList) ||
            (identity.blockIds.length === 1 && identity.blockIds[0].columns.length > 0 && identity.blockIds[0].columns.every((fieldName) => {
                const field = identity.scalarFieldByName.get(fieldName);
                return field && !field.isOptional && !field.isList;
            }))
        );

        if (!hasValidId && !hasRequiredUniqueField && !hasValidBlockUnique) {
            diagnostics.push({
                severity: 'error',
                message: `${model.name} has no unique identifier; add @id, @@id, a required @unique field, or a valid @@unique group.`,
                line: model.line,
            });
        }

        if (parsed.datasource.provider !== 'mongodb') return;

        if (identity.blockIds.length > 0) {
            diagnostics.push({
                severity: 'error',
                message: `MongoDB does not support @@id on ${model.name}; use exactly one field-level @id.`,
                line: identity.blockIds[0].line,
            });
        }
        if (identity.fieldIds.length !== 1) {
            diagnostics.push({
                severity: 'error',
                message: `${model.name} must define exactly one field-level @id for MongoDB.`,
                line: model.line,
            });
            return;
        }

        const [idField] = identity.fieldIds;
        if (idField.dbName !== '_id') {
            diagnostics.push({
                severity: 'error',
                message: `${model.name}.${idField.name} must map to MongoDB _id with @map("_id").`,
                line: idField.line,
                column: idField.column,
            });
        }
        const idNativeType = extractNativeDbType(idField.attributes);
        const defaultValue = getDefaultValueExpression(idField);
        if (idNativeType?.name.toLowerCase() === 'objectid' && defaultValue && defaultValue !== 'auto()') {
            diagnostics.push({
                severity: 'error',
                message: `${model.name}.${idField.name} uses @${idNativeType.namespace}.ObjectId and must use @default(auto()) when the ID is generated.`,
                line: idField.line,
                column: idField.column,
            });
        }
    });
}

function getProviderLabel(provider) {
    return PROVIDER_LABELS[provider] || provider || 'This provider';
}

function pushConnectorDiagnostic(diagnostics, { severity = 'error', message, line, column }) {
    diagnostics.push({
        severity,
        message,
        line: line || 1,
        ...(column && { column }),
    });
}

function validateDatasourceCompatibility(parsed, helpers, diagnostics) {
    const datasource = parsed.datasource;
    const provider = datasource?.provider;
    if (!datasource || !PRISMA_PROVIDERS.has(provider)) return;

    const providerLabel = getProviderLabel(provider);
    const supportsScalarLists = new Set(['postgresql', 'cockroachdb', 'mongodb']);
    const supportsSchemas = new Set(['postgresql', 'cockroachdb', 'sqlserver']);
    const supportsPartialIndexes = new Set(['postgresql', 'cockroachdb', 'sqlite', 'sqlserver']);
    const supportsFullTextIndexes = new Set(['mysql', 'mongodb']);

    if (datasource.schemas.length > 0 && !supportsSchemas.has(provider)) {
        pushConnectorDiagnostic(diagnostics, {
            message: `${providerLabel} does not support the datasource schemas option.`,
            line: datasource.schemasLine,
        });
    }

    if (datasource.extensions && provider !== 'postgresql') {
        pushConnectorDiagnostic(diagnostics, {
            message: `${providerLabel} does not support PostgreSQL extensions in the datasource block.`,
            line: datasource.extensionsLine,
        });
    }

    if (provider === 'sqlserver') {
        parsed.enums.forEach((item) => {
            pushConnectorDiagnostic(diagnostics, {
                message: `SQL Server does not support Prisma enum blocks; enum ${item.name} cannot be represented by this connector.`,
                line: item.line,
            });
        });
    }

    if (provider !== 'mongodb') {
        parsed.composites.forEach((item) => {
            pushConnectorDiagnostic(diagnostics, {
                message: `${providerLabel} does not support Prisma composite type blocks; type ${item.name} is only available with MongoDB.`,
                line: item.line,
            });
        });
    }

    [...parsed.enums, ...helpers.activeModels].forEach((item) => {
        if (item.schemaName && !supportsSchemas.has(provider)) {
            pushConnectorDiagnostic(diagnostics, {
                message: `${providerLabel} does not support @@schema on ${item.name}.`,
                line: item.line,
            });
        }
    });

    const validateIndexOptions = (model, attribute) => {
        const raw = attribute.text || '';
        const attributeName = raw.match(/^@@(?:id|unique|index|fulltext)\b/)?.[0];
        if (!attributeName) return;
        const args = findBalancedAttributeCall(raw, attributeName)?.args || '';
        const fields = getNamedPrismaArgument(args, 'fields') ?? splitTopLevel(args).find(part => part.startsWith('['));
        // Options belong to the index call or a field call inside its array;
        // quoted names/predicates cannot declare connector-specific options.
        const fieldOptions = fields?.startsWith('[') && fields.endsWith(']')
            ? splitTopLevel(fields.slice(1, -1)).map(part => part.match(/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s*\(([\s\S]*)\)$/)?.[1]).filter(Boolean)
            : [];
        const hasIndexOption = name => [args, ...fieldOptions].some(options => hasNamedArgument(options, name));
        const kind = raw.startsWith('@@fulltext') ? 'full-text index' : 'index';

        if (raw.startsWith('@@fulltext') && !supportsFullTextIndexes.has(provider)) {
            pushConnectorDiagnostic(diagnostics, {
                message: `${providerLabel} does not support Prisma @@fulltext indexes.`,
                line: attribute.line,
            });
        }
        if ((hasIndexOption('type') || hasIndexOption('ops')) && provider !== 'postgresql') {
            pushConnectorDiagnostic(diagnostics, {
                message: `${providerLabel} does not support PostgreSQL index type or operator-class options on ${model.name}.`,
                line: attribute.line,
            });
        }
        if (hasIndexOption('length') && provider !== 'mysql') {
            pushConnectorDiagnostic(diagnostics, {
                message: `${providerLabel} does not support MySQL index length options on ${model.name}.`,
                line: attribute.line,
            });
        }
        if (hasIndexOption('clustered') && provider !== 'sqlserver') {
            pushConnectorDiagnostic(diagnostics, {
                message: `${providerLabel} does not support SQL Server clustered options on ${model.name}.`,
                line: attribute.line,
            });
        }
        if (hasIndexOption('where') && !supportsPartialIndexes.has(provider)) {
            pushConnectorDiagnostic(diagnostics, {
                message: `${providerLabel} does not support partial ${kind} predicates in Prisma.`,
                line: attribute.line,
            });
        }
    };

    helpers.activeModels.forEach((model) => {
        model.blockAttributes.forEach((attribute) => validateIndexOptions(model, attribute));
        const scalarFieldByName = new Map(model.fields.filter((field) => field.kind === 'scalar' && !field.ignored).map((field) => [field.name, field]));

        model.fields.forEach((field) => {
            if (field.ignored || field.unbalanced || field.invalidSyntax) return;
            const nativeType = extractNativeDbType(field.attributes);
            const defaultValue = getDefaultValueExpression(field);

            if (/^auto\s*\(/.test(defaultValue || '') && provider !== 'mongodb') {
                pushConnectorDiagnostic(diagnostics, {
                    message: `auto() is only supported by MongoDB; ${model.name}.${field.name} uses it with ${providerLabel}.`,
                    line: field.line,
                    column: field.column,
                });
            }
            if (/^sequence\s*\(/.test(defaultValue || '') && provider !== 'cockroachdb') {
                pushConnectorDiagnostic(diagnostics, {
                    message: `sequence() is only supported by CockroachDB; ${model.name}.${field.name} uses it with ${providerLabel}.`,
                    line: field.line,
                    column: field.column,
                });
            }
            if (/^autoincrement\s*\(/.test(defaultValue || '') && provider === 'mongodb') {
                pushConnectorDiagnostic(diagnostics, {
                    message: `MongoDB does not support autoincrement(); remove it from ${model.name}.${field.name}.`,
                    line: field.line,
                    column: field.column,
                });
            }
            if (/^auto\s*\(/.test(defaultValue || '') && provider === 'mongodb') {
                const isObjectId = nativeType?.name.toLowerCase() === 'objectid';
                if (!isObjectId || !hasAttribute(field.attributes, 'id')) {
                    pushConnectorDiagnostic(diagnostics, {
                        message: `${model.name}.${field.name} uses auto(), which requires a field-level @id with @${datasource.name}.ObjectId.`,
                        line: field.line,
                        column: field.column,
                    });
                }
            }

            if (nativeType && nativeType.namespace !== datasource.name) {
                pushConnectorDiagnostic(diagnostics, {
                    message: `${model.name}.${field.name} uses native type namespace @${nativeType.namespace}, but the datasource is named ${datasource.name}.`,
                    line: field.line,
                    column: field.column,
                });
            }
            if (nativeType && provider === 'sqlite') {
                pushConnectorDiagnostic(diagnostics, {
                    message: `SQLite does not support Prisma native type attributes; remove @${nativeType.namespace}.${nativeType.name} from ${model.name}.${field.name}.`,
                    line: field.line,
                    column: field.column,
                });
            }
            if (field.kind === 'scalar' && field.isList && !supportsScalarLists.has(provider)) {
                pushConnectorDiagnostic(diagnostics, {
                    message: `${providerLabel} does not support scalar lists; ${model.name}.${field.name} uses ${formatPrismaFieldType(field)}.`,
                    line: field.line,
                    column: field.column,
                });
            }
            if (field.kind === 'scalar' && field.baseType === 'Json' && provider === 'sqlserver') {
                pushConnectorDiagnostic(diagnostics, {
                    message: `SQL Server does not support Prisma Json fields; ${model.name}.${field.name} must use a supported scalar or Unsupported("...") type.`,
                    line: field.line,
                    column: field.column,
                });
            }
            if (/\blength\s*:/.test(field.attributes) && provider !== 'mysql') {
                pushConnectorDiagnostic(diagnostics, {
                    message: `${providerLabel} does not support MySQL index length options on ${model.name}.${field.name}.`,
                    line: field.line,
                    column: field.column,
                });
            }
            if (/\bclustered\s*:/.test(field.attributes) && provider !== 'sqlserver') {
                pushConnectorDiagnostic(diagnostics, {
                    message: `${providerLabel} does not support SQL Server clustered options on ${model.name}.${field.name}.`,
                    line: field.line,
                    column: field.column,
                });
            }

            if (field.kind !== 'relation') return;
            const relation = extractRelationCall(field);
            const relationArgs = relation?.args || '';
            const onDelete = extractNamedValueArg(relationArgs, 'onDelete');
            const onUpdate = extractNamedValueArg(relationArgs, 'onUpdate');
            const actions = [onDelete, onUpdate].filter(Boolean);

            if (provider === 'sqlserver' && actions.includes('Restrict')) {
                pushConnectorDiagnostic(diagnostics, {
                    message: `SQL Server does not support the Restrict referential action on ${model.name}.${field.name}; use NoAction instead.`,
                    line: field.line,
                    column: field.column,
                });
            }
            if (provider === 'mysql' && datasource.relationMode !== 'prisma' && actions.includes('SetDefault')) {
                pushConnectorDiagnostic(diagnostics, {
                    severity: 'warning',
                    message: `MySQL does not reliably support SetDefault on ${model.name}.${field.name}; use NoAction, Restrict, Cascade, or SetNull.`,
                    line: field.line,
                    column: field.column,
                });
            }
            if (datasource.relationMode === 'prisma' && actions.includes('SetDefault')) {
                pushConnectorDiagnostic(diagnostics, {
                    message: `relationMode = "prisma" does not support SetDefault on ${model.name}.${field.name}.`,
                    line: field.line,
                    column: field.column,
                });
            }
            if (datasource.relationMode === 'prisma' && (provider === 'postgresql' || provider === 'sqlite') && actions.includes('NoAction')) {
                pushConnectorDiagnostic(diagnostics, {
                    message: `${providerLabel} with relationMode = "prisma" does not support NoAction on ${model.name}.${field.name}; use Restrict instead.`,
                    line: field.line,
                    column: field.column,
                });
            }

            if (!actions.includes('SetNull')) return;
            const sourceFields = extractNamedArrayArg(relationArgs, 'fields');
            const hasRequiredSourceField = sourceFields.some((fieldName) => {
                const sourceField = scalarFieldByName.get(fieldName);
                return sourceField && isFieldRequired(sourceField);
            });
            if (!hasRequiredSourceField) return;

            pushConnectorDiagnostic(diagnostics, {
                severity: provider === 'postgresql' ? 'warning' : 'error',
                message: `${providerLabel} relation ${model.name}.${field.name} uses SetNull with required relation scalar fields; make those fields optional.`,
                line: field.line,
                column: field.column,
            });
        });
    });
}

// SQL export path for relational models. The ERD path below uses richer Prisma
// metadata, but generated SQL intentionally stays close to CREATE TABLE/INDEX.
function buildCreateTable(model, helpers, diagnostics) {
    const { enumByName, compositeByName, modelByName } = helpers;
    const scalarFields = model.fields.filter((field) => field.kind === 'scalar' && !field.ignored);
    const fieldByName = new Map(scalarFields.map((field) => [field.name, field]));
    const blockIndexes = makeModelIndexes(model, fieldByName, diagnostics);
    const compositePrimaryKey = blockIndexes.find((item) => item.kind === 'id' && item.validKey);
    const tableItems = [];

    scalarFields.forEach((field) => {
        const parts = [quoteIdentifier(field.dbName), mapPrismaTypeToSql(field, enumByName, compositeByName, diagnostics)];
        const isSinglePrimaryKey = hasAttribute(field.attributes, 'id') && !compositePrimaryKey;

        if (isSinglePrimaryKey) {
            parts.push('PRIMARY KEY');
        } else if (!field.isOptional && !field.isList) {
            parts.push('NOT NULL');
        }

        if (hasAttribute(field.attributes, 'unique') && !isSinglePrimaryKey && !isPartialUniqueField(field)) parts.push('UNIQUE');
        if (isPartialUniqueField(field)) diagnostics.push({ severity: 'warning', message: `${model.name}.${field.name} partial unique predicate is omitted from SQL export; it is not a global UNIQUE constraint.`, line: field.line });
        tableItems.push(`  ${parts.join(' ')}`);
    });

    if (compositePrimaryKey) {
        tableItems.push(`  PRIMARY KEY (${compositePrimaryKey.dbColumns.map(quoteIdentifier).join(', ')})`);
    }

    blockIndexes.filter((item) => item.kind === 'unique' && item.validKey && !item.partial).forEach((item) => {
        const prefix = item.name ? `CONSTRAINT ${quoteIdentifier(item.name)} ` : '';
        tableItems.push(`  ${prefix}UNIQUE (${item.dbColumns.map(quoteIdentifier).join(', ')})`);
    });

    buildRelationConstraints(model, modelByName, fieldByName, diagnostics).forEach((constraint) => {
        tableItems.push(`  ${constraint}`);
    });

    if (tableItems.length === 0) {
        diagnostics.push({
            severity: 'warning',
            message: `${model.name} has no scalar fields, so it was skipped.`,
            line: model.line,
        });
        return { createTableSql: '', indexSql: [] };
    }

    const tableName = quoteDatabaseObject(model.dbName, model.schemaName);
    const createTableSql = `CREATE TABLE ${tableName} (\n${tableItems.join(',\n')}\n);`;
    blockIndexes.filter(item => item.partial).forEach(item => diagnostics.push({ severity: 'warning', message: `${model.name} partial ${item.kind} predicate is omitted from SQL export to avoid changing its scope.`, line: item.line }));
    const indexSql = blockIndexes.filter((item) => item.kind === 'index' && item.dbColumns.length > 0 && !item.partial).map((item) => {
        const name = item.name || `idx_${safeIdentifierName(model.dbName)}_${item.dbColumns.map(safeIdentifierName).join('_')}`;
        return `CREATE INDEX ${quoteIdentifier(name)} ON ${tableName} (${item.dbColumns.map(quoteIdentifier).join(', ')});`;
    });

    return { createTableSql, indexSql };
}

function normalizeColumnGroupKey(columns) {
    return [...(columns || [])].sort().join('|');
}

function sameColumnSet(left, right) {
    return normalizeColumnGroupKey(left) === normalizeColumnGroupKey(right);
}

function findBalancedAttributeCall(text, attrName) {
    const source = String(text || '');
    const needle = attrName.startsWith('@') ? attrName : `@${attrName}`;
    let cursor = source.indexOf(needle);

    while (cursor !== -1) {
        const prev = source[cursor - 1];
        const next = source[cursor + needle.length];
        if ((cursor === 0 || /\s/.test(prev)) && (next === '(' || /\s/.test(next || '') || next === undefined)) {
            if (next !== '(') return { full: needle, args: '', start: cursor, end: cursor + needle.length };
            let depth = 1;
            let index = cursor + needle.length + 1;
            const argsStart = index;
            while (index < source.length) {
                const char = source[index];
                if (char === '"' || char === "'") {
                    index = skipString(source, index);
                    continue;
                }
                if (char === '(') depth += 1;
                if (char === ')') depth -= 1;
                if (depth === 0) {
                    return {
                        full: source.slice(cursor, index + 1),
                        args: source.slice(argsStart, index).trim(),
                        start: cursor,
                        end: index + 1,
                    };
                }
                index += 1;
            }
            return null;
        }
        cursor = source.indexOf(needle, cursor + needle.length);
    }

    return null;
}

function extractNamedValueArg(text, name) {
    const prefix = `${name}:`;
    const argument = splitTopLevel(String(text || '')).find((part) => {
        const compact = part.replace(/\s+/g, '');
        return compact.startsWith(prefix);
    });
    if (!argument) return null;
    return argument.slice(argument.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '');
}

function extractRelationCall(field) {
    return findBalancedAttributeCall(field.attributes, 'relation');
}

function extractRelationName(field) {
    const relation = extractRelationCall(field);
    if (!relation?.args) return null;
    const [firstArg] = splitTopLevel(relation.args);
    return parsePrismaStringLiteral(firstArg) ?? extractNamedStringArg(relation.args, 'name');
}

function formatPrismaFieldType(field) {
    let type = field.baseType || field.type || 'Unknown';
    if (field.isList) type += '[]';
    if (field.isOptional) type += '?';
    return type;
}

function getDefaultAttribute(field) {
    const call = findBalancedAttributeCall(field.attributes, 'default');
    return call?.args || null;
}

function getDefaultValueExpression(field) {
    const args = getDefaultAttribute(field);
    if (!args) return null;
    const parts = splitTopLevel(args);
    const namedValue = parts.find((part) => /^\s*value\s*:/.test(part));
    if (namedValue) return namedValue.slice(namedValue.indexOf(':') + 1).trim();
    return (parts[0] || '').trim();
}

function getNativeDbTypeLabel(field) {
    const nativeType = extractNativeDbType(field.attributes);
    if (!nativeType) return null;
    return `@${nativeType.namespace}.${nativeType.name}${nativeType.args ? `(${nativeType.args})` : ''}`;
}

function formatPrismaStringAttribute(name, value) {
    return `${name}(${JSON.stringify(String(value))})`;
}

function getPrismaFieldExtras(field) {
    const extras = [];
    const defaultValue = getDefaultAttribute(field);
    const nativeType = getNativeDbTypeLabel(field);

    if (defaultValue) extras.push(`Default: ${defaultValue}`);
    if (hasAttribute(field.attributes, 'updatedAt')) extras.push('@updatedAt');
    if (nativeType) extras.push(`Native: ${nativeType}`);
    if (field.dbName && field.dbName !== field.name) extras.push(formatPrismaStringAttribute('@map', field.dbName));
    if (field.isList && field.kind === 'scalar') extras.push('Scalar list');

    return extras;
}

function resolvePrismaFieldPath(path, fieldByName, compositeByName) {
    const [root, ...children] = path.split('.');
    let field = fieldByName.get(root);
    for (const name of children) {
        field = compositeByName.get(field?.baseType)?.fields.find(candidate => candidate.name === name);
    }
    return field;
}

function makePrismaModelGroups(model, scalarFieldByName, diagnostics, compositeByName) {
    return model.blockAttributes.filter((attribute) => !attribute.unbalanced).map(parseBlockAttribute).filter(Boolean).map((attribute) => {
        if (new Set(attribute.columns).size !== attribute.columns.length) {
            diagnostics.push({ severity: 'warning', message: `${model.name} ${attribute.kind} repeats a field; list each key field once.`, line: attribute.line });
        }
        const fields = attribute.columns
            .map((fieldName) => {
                const field = resolvePrismaFieldPath(fieldName, scalarFieldByName, compositeByName);
                if (!field) {
                    diagnostics.push({
                        severity: 'warning',
                        message: `${model.name} has ${attribute.kind} on unknown field ${fieldName}.`,
                        line: attribute.line,
                    });
                    return null;
                }
                return fieldName.split('.')[0];
            })
            .filter(Boolean);

        return { ...attribute, fields, fieldPaths: attribute.columns, fieldsComplete: fields.length === attribute.columns.length && new Set(attribute.columns).size === attribute.columns.length, validKey: isValidPrismaKeyGroup(attribute.columns, scalarFieldByName, true) };
    });
}

function addColumnBadge(column, badge) {
    if (!column.constraints.includes(badge)) column.constraints.push(badge);
}

function isFieldRequired(field) {
    return !field.isOptional && !field.isList;
}

function isValidPrismaKeyGroup(columns, fieldByName, required = false) {
    if (!columns?.length || new Set(columns).size !== columns.length) return false;
    return columns.every(name => {
        const field = fieldByName.get(name);
        return field && !field.ignored && !field.unbalanced && !field.invalidSyntax && !field.isList && (!required || !field.isOptional);
    });
}

function createPrismaScalarColumn(field, model, modelGroups) {
    const compositePrimaryKey = modelGroups.find((item) => item.kind === 'id' && item.validKey);
    const isSinglePrimaryKey = hasAttribute(field.attributes, 'id') && !compositePrimaryKey;
    const isCompositePrimaryKey = !!compositePrimaryKey?.fields.includes(field.name);
    const uniqueGroups = modelGroups.filter((item) => item.kind === 'unique' && (item.validKey || (item.fieldsComplete && item.columns.some(name => name.includes('.')))) && item.fields.includes(field.name));
    const indexGroups = modelGroups.filter((item) => (item.kind === 'index' || item.kind === 'fulltext') && item.fields.includes(field.name));
    const column = {
        name: field.name,
        type: formatPrismaFieldType(field),
        constraints: [],
        extras: getPrismaFieldExtras(field),
        prisma: {
            kind: 'scalar',
            modelName: model.name,
            dbName: field.dbName,
            attributes: field.attributes,
            optional: field.isOptional,
            list: field.isList,
            line: field.line,
        },
    };

    if (isSinglePrimaryKey || isCompositePrimaryKey) {
        column.pk = true;
        addColumnBadge(column, 'PK');
    }
    if (isCompositePrimaryKey) column.compositePk = true;

    if (hasAttribute(field.attributes, 'unique') && !column.pk) {
        addColumnBadge(column, isPartialUniqueField(field) ? 'PUQ' : 'UQ');
    }

    if (uniqueGroups.length > 0 && !column.pk) {
        const globalGroups = uniqueGroups.filter(group => !group.partial);
        const partialGroups = uniqueGroups.filter(group => group.partial);
        if (globalGroups.length) addColumnBadge(column, 'UQ');
        if (partialGroups.length) addColumnBadge(column, 'PUQ');
        if (globalGroups.some(group => group.fields.length > 1)) column.compositeUq = true;
        if (partialGroups.some(group => group.fields.length > 1)) column.compositePartialUq = true;
    }

    if (indexGroups.length > 0 && !column.pk && !column.constraints.includes('UQ')) {
        addColumnBadge(column, 'IDX');
        if (indexGroups.some((group) => group.fields.length > 1)) column.compositeIdx = true;
    }

    if (isFieldRequired(field) && !column.pk) addColumnBadge(column, 'NN');
    if (getDefaultAttribute(field)?.startsWith('autoincrement(') || getDefaultAttribute(field) === 'autoincrement()') {
        column.autoIncrement = true;
    }

    return column;
}

function relationActionsFromPrismaField(field) {
    const relation = extractRelationCall(field);
    const args = relation?.args || '';
    const actions = {};
    const onDelete = extractNamedValueArg(args, 'onDelete');
    const onUpdate = extractNamedValueArg(args, 'onUpdate');

    if (onDelete) actions.onDelete = onDelete;
    if (onUpdate) actions.onUpdate = onUpdate;
    return actions;
}

function getPrismaRelationNameOrMap(field, sourceModel) {
    const relation = extractRelationCall(field);
    const mappedName = extractNamedStringArg(relation?.args || '', 'map');
    const relationName = extractRelationName(field);
    if (mappedName) return mappedName;
    if (relationName) return relationName;
    return `${sourceModel.name}.${field.name}`;
}

function relationCardinalityFromPrisma(isUnique, isRequired) {
    if (isUnique) return isRequired ? '1' : '0..1';
    return isRequired ? 'n' : '0..n';
}

function buildPrismaTableInfo(model, diagnostics, compositeByName) {
    const scalarFields = model.fields.filter((field) => field.kind === 'scalar' && !field.ignored);
    const relationFields = model.fields.filter((field) => field.kind === 'relation' && !field.ignored);
    const scalarFieldByName = new Map(scalarFields.map((field) => [field.name, field]));
    const modelGroups = makePrismaModelGroups(model, scalarFieldByName, diagnostics, compositeByName);
    const columns = scalarFields.map((field) => createPrismaScalarColumn(field, model, modelGroups));
    const annotations = [];
    if (model.dbName !== model.name) annotations.push(formatPrismaStringAttribute('@@map', model.dbName));
    if (model.schemaName) annotations.push(formatPrismaStringAttribute('@@schema', model.schemaName));
    // Preserve declarations in metadata, but never shorten a damaged compound
    // key or combine several invalid IDs into an invented unique criterion.
    const fieldIds = scalarFields.filter(field => hasAttribute(field.attributes, 'id'));
    const blockIds = modelGroups.filter(group => group.kind === 'id');
    const primaryColumns = fieldIds.length + blockIds.length !== 1 ? []
        : fieldIds.length ? (isValidPrismaKeyGroup([fieldIds[0].name], scalarFieldByName, true) ? [fieldIds[0].name] : [])
            : blockIds[0].validKey ? blockIds[0].fields : [];
    const uniqueColumnGroups = [
        // Partial unique indexes remain visible as PUQ annotations, but they do
        // not establish global one-to-one cardinality or a valid FK target.
        ...scalarFields.filter((field) => hasAttribute(field.attributes, 'unique') && !isPartialUniqueField(field) && isValidPrismaKeyGroup([field.name], scalarFieldByName)).map((field) => [field.name]),
        ...modelGroups.filter((item) => item.kind === 'unique' && item.validKey && !isPartialUniqueGroup(item)).map((item) => item.fields),
    ];
    const table = {
        name: model.name,
        columns,
        prisma: {
            kind: model.kind,
            dbName: model.dbName,
            schemaName: model.schemaName,
            mapped: model.dbName !== model.name,
            line: model.line,
            annotations,
            indexes: modelGroups.map((group) => ({
                kind: group.kind,
                fields: group.fieldPaths || group.fields,
                name: group.name,
                raw: group.raw,
            })),
            blockAttributes: model.blockAttributes.map((attribute) => ({
                text: attribute.text,
                line: attribute.line,
            })),
            relationFields: relationFields.map((field) => ({
                name: field.name,
                type: formatPrismaFieldType(field),
                targetModel: field.baseType,
                relationName: extractRelationName(field),
                attributes: field.attributes,
                line: field.line,
            })),
        },
    };

    if (annotations.length > 0 && table.columns[0]) {
        table.columns[0].extras = [...annotations, ...(table.columns[0].extras || [])];
    }
    if (model.kind === 'view' && table.columns[0]) {
        table.columns[0].extras = ['Prisma view', ...(table.columns[0].extras || [])];
    }

    return {
        model,
        table,
        scalarFields,
        relationFields,
        scalarFieldByName,
        primaryColumns: Array.from(new Set(primaryColumns)),
        uniqueColumnGroups,
        modelGroups,
    };
}

function isPrismaFieldGroupUnique(tableInfo, fieldNames) {
    if (!Array.isArray(fieldNames) || fieldNames.length === 0) return false;
    if (sameColumnSet(tableInfo.primaryColumns, fieldNames)) return true;
    return tableInfo.uniqueColumnGroups.some((group) => sameColumnSet(group, fieldNames));
}

function arePrismaFieldsRequired(tableInfo, fieldNames) {
    return fieldNames.every((fieldName) => {
        const field = tableInfo.scalarFieldByName.get(fieldName);
        return !!field && isFieldRequired(field);
    });
}

function markPrismaForeignKeyColumns(tableInfo, fieldNames) {
    fieldNames.forEach((fieldName) => {
        const column = tableInfo.table.columns.find((candidate) => candidate.name === fieldName);
        if (column) column.fk = true;
    });
}

function getImplicitManyToManyAnchorField(tableInfo) {
    if (tableInfo.primaryColumns.length !== 1) return null;
    const primaryField = tableInfo.scalarFieldByName.get(tableInfo.primaryColumns[0]);
    return primaryField && hasAttribute(primaryField.attributes, 'id') ? primaryField.name : null;
}

function getPrismaDiagnosticPosition(item) {
    return {
        line: item.line || 1,
        column: item.column || 1,
        index: item.index || 0,
    };
}

function getExplicitRelationStructureIssue(tableInfo, targetInfo, field, sourceFields, targetFields, provider) {
    const sourceScalars = sourceFields.map((fieldName) => tableInfo.scalarFieldByName.get(fieldName));
    const targetScalars = targetFields.map((fieldName) => targetInfo.scalarFieldByName.get(fieldName));
    const actions = relationActionsFromPrismaField(field);
    const relationLabel = `${tableInfo.model.name}.${field.name}`;
    if (new Set(sourceFields).size !== sourceFields.length || new Set(targetFields).size !== targetFields.length) {
        return `${relationLabel} repeats a field in fields/references; list each relation scalar once.`;
    }

    if (provider === 'mongodb' && field.isList) {
        if (sourceFields.length !== 1 || targetFields.length !== 1) {
            return `${relationLabel} is a MongoDB many-to-many relation and must use exactly one list field and one referenced @id field.`;
        }
        if (!sourceScalars[0]?.isList) {
            return `${relationLabel} is a MongoDB list relation, so its fields argument must contain one scalar list field.`;
        }
        if (targetScalars[0]?.isList || !hasAttribute(targetScalars[0]?.attributes, 'id')) {
            return `${relationLabel} is a MongoDB many-to-many relation and must reference one singular @id field.`;
        }
        if (Object.keys(actions).length > 0) {
            return `${relationLabel} is a MongoDB many-to-many relation and cannot define referential actions.`;
        }
        return null;
    }

    if (provider && provider !== 'mongodb') {
        if (field.isList) {
            return `${relationLabel} is a list relation with fields/references metadata; relational Prisma many-to-many relations need an implicit relation or an explicit join model.`;
        }
        if (sourceScalars.some((sourceField) => sourceField?.isList)) {
            return `${relationLabel} uses a scalar list as a relation field; relational Prisma foreign keys must use singular scalar fields.`;
        }
    }

    if (provider === 'mongodb' && sourceScalars.some((sourceField) => sourceField?.isList)) {
        return `${relationLabel} uses a scalar list, so the annotated MongoDB relation field must also be a list.`;
    }

    return null;
}

function findMatchingOppositeRelationFields(tableInfoByName, sourceInfo, field) {
    const targetInfo = tableInfoByName.get(field.baseType);
    if (!targetInfo) return [];
    const relationName = extractRelationName(field);

    return targetInfo.relationFields.filter((candidate) => {
        if (candidate === field || candidate.unbalanced || candidate.invalidSyntax) return false;
        if (candidate.baseType !== sourceInfo.model.name) return false;
        const candidateName = extractRelationName(candidate);
        if (relationName || candidateName) return relationName === candidateName;
        return true;
    });
}

function validatePrismaRelationPairs(tableInfos, tableInfoByName, provider, diagnostics) {
    tableInfos.forEach((tableInfo) => {
        tableInfo.relationFields.forEach((field) => {
            if (field.unbalanced || field.invalidSyntax || !tableInfoByName.has(field.baseType)) return;
            const relationCall = extractRelationCall(field);
            const isAnnotatedOwner = hasNamedArgument(relationCall?.args, 'fields') || hasNamedArgument(relationCall?.args, 'references');
            const relationName = extractRelationName(field);

            // Existing implicit-relation validation owns unnamed, unannotated
            // fields. This pass protects the annotated/named cases where a
            // mismatched opposite name previously looked valid in the ERD.
            if (!isAnnotatedOwner && !relationName) return;

            const matches = findMatchingOppositeRelationFields(tableInfoByName, tableInfo, field);
            if (matches.length === 1) {
                const opposite = matches[0];
                const oppositeArgs = extractRelationCall(opposite)?.args;
                const oppositeOwns = hasNamedArgument(oppositeArgs, 'fields') || hasNamedArgument(oppositeArgs, 'references');
                if (isAnnotatedOwner && oppositeOwns && !(provider === 'mongodb' && field.isList && opposite.isList)) {
                    diagnostics.push({ severity: 'warning', message: `${tableInfo.model.name}.${field.name} and ${field.baseType}.${opposite.name} both own this relation; fields/references must be defined on only one side.`, line: field.line, column: field.column });
                }
                if (tableInfo.model.name === field.baseType && !relationName) {
                    diagnostics.push({ severity: 'warning', message: `${tableInfo.model.name}.${field.name} is a self relation and requires the same explicit @relation("Name") on both fields.`, line: field.line, column: field.column });
                }
                return;
            }
            const nameHint = relationName ? ` using @relation(${JSON.stringify(relationName)})` : '';
            diagnostics.push({
                severity: 'warning',
                message: matches.length === 0
                    ? `${tableInfo.model.name}.${field.name} has no matching opposite relation field on ${field.baseType}${nameHint}.`
                    : `${tableInfo.model.name}.${field.name} has ${matches.length} possible opposite relation fields on ${field.baseType}${nameHint}; give each relation a distinct name.`,
                line: field.line,
                column: field.column,
            });
        });
    });
}

function buildExplicitPrismaRelations(tableInfos, tableInfoByName, provider, diagnostics) {
    const relations = [];
    const validReferentialActions = new Set(['Cascade', 'Restrict', 'NoAction', 'SetNull', 'SetDefault']);

    tableInfos.forEach((tableInfo) => {
        tableInfo.relationFields.forEach((field) => {
            if (field.unbalanced || field.invalidSyntax) return;
            const relationCall = extractRelationCall(field);
            const relationArgs = relationCall?.args || '';
            const hasSourceArgument = hasNamedArgument(relationArgs, 'fields');
            const hasTargetArgument = hasNamedArgument(relationArgs, 'references');
            const sourceFields = extractNamedArrayArg(relationArgs, 'fields');
            const targetFields = extractNamedArrayArg(relationArgs, 'references');

            if (!hasSourceArgument && !hasTargetArgument) return;

            if (!hasSourceArgument || !hasTargetArgument || sourceFields.length !== targetFields.length || sourceFields.length === 0) {
                diagnostics.push({
                    severity: 'warning',
                    message: `${tableInfo.model.name}.${field.name} has a relation with incomplete fields/references metadata.`,
                    line: field.line,
                    column: field.column,
                });
                return;
            }

            const targetInfo = tableInfoByName.get(field.baseType);
            if (!targetInfo) {
                diagnostics.push({
                    severity: 'warning',
                    message: `${tableInfo.model.name}.${field.name} references unknown model ${field.baseType}.`,
                    line: field.line,
                    column: field.column,
                });
                return;
            }

            const missingSource = sourceFields.find((fieldName) => !tableInfo.scalarFieldByName.has(fieldName));
            const missingTarget = targetFields.find((fieldName) => !targetInfo.scalarFieldByName.has(fieldName));
            if (missingSource || missingTarget) {
                diagnostics.push({
                    severity: 'warning',
                    message: `${tableInfo.model.name}.${field.name} references ${missingSource || missingTarget}, but that scalar field was not found.`,
                    line: field.line,
                    column: field.column,
                });
                return;
            }

            const structureIssue = getExplicitRelationStructureIssue(tableInfo, targetInfo, field, sourceFields, targetFields, provider);
            if (structureIssue) {
                diagnostics.push({
                    severity: 'warning',
                    message: structureIssue,
                    line: field.line,
                    column: field.column,
                });
                return;
            }

            if (!field.isList && !field.isOptional && sourceFields.some(name => tableInfo.scalarFieldByName.get(name).isOptional)) {
                diagnostics.push({ severity: 'warning', message: `${tableInfo.model.name}.${field.name} must be optional because at least one foreign-key scalar is nullable.`, line: field.line, column: field.column });
            }
            const opposites = findMatchingOppositeRelationFields(tableInfoByName, tableInfo, field);
            if (!field.isList && opposites.length === 1 && !opposites[0].isList) {
                const opposite = opposites[0];
                const oppositeArgs = extractRelationCall(opposite)?.args;
                const oppositeOwns = hasNamedArgument(oppositeArgs, 'fields') || hasNamedArgument(oppositeArgs, 'references');
                if (!oppositeOwns) {
                    if (!isPrismaFieldGroupUnique(tableInfo, sourceFields)) diagnostics.push({ severity: 'warning', message: `${tableInfo.model.name}.${field.name} one-to-one relation requires a global unique constraint on its foreign-key fields; add @unique/@@unique or use a list opposite.`, line: field.line, column: field.column });
                    if (!opposite.isOptional) diagnostics.push({ severity: 'warning', message: `${targetInfo.model.name}.${opposite.name} without foreign-key scalars must be optional in a one-to-one relation.`, line: opposite.line, column: opposite.column });
                }
            }

            const incompatiblePair = sourceFields
                .map((sourceField, index) => [tableInfo.scalarFieldByName.get(sourceField), targetInfo.scalarFieldByName.get(targetFields[index])])
                .find(([sourceField, targetField]) => sourceField?.baseType !== targetField?.baseType);
            if (incompatiblePair) {
                diagnostics.push({
                    severity: 'warning',
                    message: `${tableInfo.model.name}.${field.name} uses incompatible field types ${incompatiblePair[0].baseType} and ${incompatiblePair[1].baseType}.`,
                    line: field.line,
                    column: field.column,
                });
            }

            const incompatibleNativePair = sourceFields
                .map((sourceField, index) => [tableInfo.scalarFieldByName.get(sourceField), targetInfo.scalarFieldByName.get(targetFields[index])])
                .find(([sourceField, targetField]) => {
                    const sourceNative = extractNativeDbType(sourceField?.attributes);
                    const targetNative = extractNativeDbType(targetField?.attributes);
                    const sourceIsObjectId = sourceNative?.name.toLowerCase() === 'objectid';
                    const targetIsObjectId = targetNative?.name.toLowerCase() === 'objectid';
                    if (provider === 'mongodb' && sourceIsObjectId !== targetIsObjectId) return true;
                    if (!sourceNative || !targetNative) return false;
                    // The length of a character column does not establish the
                    // relation identity and can legitimately differ across a FK.
                    if (sourceField.baseType === 'String' && sourceNative.name.toLowerCase() === targetNative.name.toLowerCase()) return false;
                    const sourceKey = `${sourceNative.name.toLowerCase()}(${sourceNative.args.toLowerCase()})`;
                    const targetKey = `${targetNative.name.toLowerCase()}(${targetNative.args.toLowerCase()})`;
                    return sourceKey !== targetKey;
                });
            if (incompatibleNativePair) {
                const sourceNative = extractNativeDbType(incompatibleNativePair[0]?.attributes);
                const targetNative = extractNativeDbType(incompatibleNativePair[1]?.attributes);
                const objectIdNative = [sourceNative, targetNative].find((nativeType) => nativeType?.name.toLowerCase() === 'objectid');
                diagnostics.push({
                    severity: 'warning',
                    message: provider === 'mongodb' && objectIdNative
                        ? `${tableInfo.model.name}.${field.name} must use @${objectIdNative.namespace}.ObjectId on both relation scalar fields when either side stores an ObjectId.`
                        : `${tableInfo.model.name}.${field.name} uses incompatible native types ${getNativeDbTypeLabel(incompatibleNativePair[0])} and ${getNativeDbTypeLabel(incompatibleNativePair[1])}.`,
                    line: field.line,
                    column: field.column,
                });
            }

            if (!isPrismaFieldGroupUnique(targetInfo, targetFields)) {
                diagnostics.push({
                    severity: 'warning',
                    message: `${tableInfo.model.name}.${field.name} must reference a unique field set on ${targetInfo.model.name}.`,
                    line: field.line,
                    column: field.column,
                });
            }

            markPrismaForeignKeyColumns(tableInfo, sourceFields);
            const fromCard = relationCardinalityFromPrisma(isPrismaFieldGroupUnique(tableInfo, sourceFields), arePrismaFieldsRequired(tableInfo, sourceFields));
            const relationGroup = `${tableInfo.model.name}:${sourceFields.join(',')}->${targetInfo.model.name}:${targetFields.join(',')}:${field.name}`;
            const composite = sourceFields.length > 1;
            const actions = relationActionsFromPrismaField(field);
            const fkName = getPrismaRelationNameOrMap(field, tableInfo.model);
            Object.entries(actions).forEach(([name, value]) => {
                if (!validReferentialActions.has(value)) {
                    diagnostics.push({
                        severity: 'warning',
                        message: `${tableInfo.model.name}.${field.name} uses unsupported ${name} action ${value}.`,
                        line: field.line,
                        column: field.column,
                    });
                }
            });
            if (actions.onDelete === 'SetNull' && arePrismaFieldsRequired(tableInfo, sourceFields)) {
                diagnostics.push({
                    severity: 'warning',
                    message: `${tableInfo.model.name}.${field.name} uses onDelete: SetNull with required foreign-key fields.`,
                    line: field.line,
                    column: field.column,
                });
            }

            sourceFields.forEach((sourceField, index) => {
                const targetField = targetFields[index];
                if (!sourceField || !targetField) return;

                const relation = {
                    from: { table: tableInfo.model.name, column: sourceField },
                    to: { table: targetInfo.model.name, column: targetField },
                    fromCard,
                    toCard: '1',
                    fkName,
                    prisma: {
                        kind: 'explicit',
                        relationField: field.name,
                        relationName: extractRelationName(field),
                        line: field.line,
                    },
                };

                if (Object.keys(actions).length > 0) relation.actions = actions;
                if (composite) {
                    relation.composite = true;
                    relation.relationGroup = relationGroup;
                    relation.fromColumns = [...sourceFields];
                    relation.toColumns = [...targetFields];
                }

                relations.push(relation);
            });
        });
    });

    return relations;
}

function findImplicitOppositeRelations(tableInfoByName, sourceInfo, field) {
    const targetInfo = tableInfoByName.get(field.baseType);
    if (!targetInfo) return [];
    return targetInfo.relationFields.filter((candidate) => {
        if (candidate === field) return false;
        if (candidate.unbalanced || candidate.invalidSyntax) return false;
        if (candidate.baseType !== sourceInfo.model.name) return false;
        const candidateRelation = extractRelationCall(candidate);
        if (hasNamedArgument(candidateRelation?.args, 'fields')) return false;
        if (hasNamedArgument(candidateRelation?.args, 'references')) return false;
        const leftName = extractRelationName(field);
        const rightName = extractRelationName(candidate);
        if (leftName || rightName) return leftName === rightName;
        return true;
    });
}

function buildImplicitPrismaRelations(tableInfos, tableInfoByName, provider, diagnostics) {
    const relations = [];
    const seen = new Set();

    tableInfos.forEach((tableInfo) => {
        tableInfo.relationFields.forEach((field) => {
            if (field.unbalanced || field.invalidSyntax) return;
            const relationCall = extractRelationCall(field);
            const hasExplicitArguments = hasNamedArgument(relationCall?.args, 'fields') || hasNamedArgument(relationCall?.args, 'references');
            if (hasExplicitArguments) return;

            const targetInfo = tableInfoByName.get(field.baseType);
            const oppositeCandidates = findImplicitOppositeRelations(tableInfoByName, tableInfo, field);
            const opposite = oppositeCandidates.length === 1 ? oppositeCandidates[0] : null;
            const explicitOpposite = targetInfo?.relationFields?.some((candidate) => {
                if (candidate.baseType !== tableInfo.model.name) return false;
                // A syntax diagnostic already explains a damaged owner. Do not
                // add a misleading missing-owner warning to its healthy inverse.
                if (candidate.unbalanced || candidate.invalidSyntax) return true;
                if (extractRelationName(candidate) !== extractRelationName(field)) return false;
                const candidateRelation = extractRelationCall(candidate);
                return (
                    hasNamedArgument(candidateRelation?.args, 'fields') &&
                    hasNamedArgument(candidateRelation?.args, 'references')
                );
            });

            if (!targetInfo) {
                diagnostics.push({
                    severity: 'warning',
                    message: `${tableInfo.model.name}.${field.name} references unknown model ${field.baseType}.`,
                    line: field.line,
                    column: field.column,
                });
                return;
            }

            if (oppositeCandidates.length > 1) {
                diagnostics.push({
                    severity: 'warning',
                    message: `${tableInfo.model.name}.${field.name} has an ambiguous relation to ${field.baseType}.`,
                    line: field.line,
                    column: field.column,
                });
                return;
            }

            if (!targetInfo || !opposite) {
                if (explicitOpposite) return;
                diagnostics.push({
                    severity: 'warning',
                    message: `${tableInfo.model.name}.${field.name} is a relation field without fields/references metadata, so only the field row is shown.`,
                    line: field.line,
                    column: field.column,
                });
                return;
            }

            const endpointA = `${tableInfo.model.name}.${field.name}`;
            const endpointB = `${targetInfo.model.name}.${opposite.name}`;
            const key = [endpointA, endpointB].sort().join('|');
            if (seen.has(key)) return;
            seen.add(key);

            // Prisma only infers a relation when both sides are list fields in
            // a relational datasource. A pair of singular fields (or one list
            // and one singular field) needs an annotated @relation on the side
            // that owns the relation scalar. Rendering one as a virtual edge
            // makes an invalid schema look like a valid 1:1 or 1:n relation.
            if (!field.isList || !opposite.isList) {
                diagnostics.push({
                    severity: 'warning',
                    message: `${endpointA} and ${endpointB} require an annotated @relation(fields: [...], references: [...]); only list-to-list relations can be implicit.`,
                    line: field.line,
                    column: field.column,
                });
                return;
            }
            if (Object.keys(relationActionsFromPrismaField(field)).length || Object.keys(relationActionsFromPrismaField(opposite)).length) {
                diagnostics.push({ severity: 'warning', message: `${endpointA} and ${endpointB} implicit many-to-many relations cannot define referential actions; use an explicit join model.`, line: field.line, column: field.column });
                return;
            }

            // MongoDB models many-to-many links with an ID array and an
            // explicit @relation on both sides. It has no implicit join-table
            // convention, unlike relational Prisma connectors.
            if (provider === 'mongodb') {
                diagnostics.push({
                    severity: 'warning',
                    message: `MongoDB does not support implicit many-to-many relations; ${endpointA} and ${endpointB} must define @relation(fields: [...], references: [...]) on both sides.`,
                    line: field.line,
                    column: field.column,
                });
                return;
            }

            // Self-relations are always named in Prisma. Without a name,
            // pairing the two lists by position can silently attach the wrong
            // fields when the schema is edited.
            if (tableInfo.model.name === targetInfo.model.name && !extractRelationName(field) && !extractRelationName(opposite)) {
                diagnostics.push({
                    severity: 'warning',
                    message: `${endpointA} and ${endpointB} are a self relation and require the same explicit @relation("Name").`,
                    line: field.line,
                    column: field.column,
                });
                return;
            }

            const relationName = extractRelationName(field) || extractRelationName(opposite) || `${endpointA}<->${endpointB}`;
            // Prisma's relational implicit many-to-many convention requires
            // one scalar field-level @id on each model. Composite @@id groups,
            // single-field @@id groups, and @unique fields cannot stand in for
            // that contract, so do not invent a renderer edge for them.
            const sourceAnchor = getImplicitManyToManyAnchorField(tableInfo);
            const targetAnchor = getImplicitManyToManyAnchorField(targetInfo);
            if (!sourceAnchor || !targetAnchor) {
                diagnostics.push({
                    severity: 'warning',
                    message: `${endpointA} and ${endpointB} form an implicit many-to-many relation, but both models must each define one scalar @id field; use an explicit join model for composite or unique-only keys.`,
                    line: field.line,
                    column: field.column,
                });
                return;
            }
            relations.push({
                from: { table: tableInfo.model.name, column: sourceAnchor },
                to: { table: targetInfo.model.name, column: targetAnchor },
                fromCard: 'n',
                toCard: 'n',
                fkName: relationName,
                prisma: {
                    kind: 'implicit-many-to-many',
                    relationName,
                    fromRelationField: field.name,
                    toRelationField: opposite.name,
                    fromLine: field.line,
                    toLine: opposite.line,
                },
            });
        });
    });

    return relations;
}

function countRelationGroups(relations) {
    const groups = new Set();
    (relations || []).forEach((relation) => {
        const relationName = relation.prisma?.relationName;
        const namedGroup = relationName ? `${relation.prisma?.kind || 'relation'}:${relationName}:${relation.from.table}->${relation.to.table}` : null;
        groups.add(relation.relationGroup || namedGroup || `${relation.from.table}.${relation.from.column}->${relation.to.table}.${relation.to.column}`);
    });
    return groups.size;
}

function createPrismaEmptySchema(diagnostics) {
    return {
        sourceType: 'prisma',
        enums: [],
        composites: [],
        tables: [],
        relations: [],
        _parseErrors: diagnostics.map((item) => ({
            kind: `prisma_${item.severity || 'info'}`,
            severity: item.severity || 'info',
            message: item.message,
            position: getPrismaDiagnosticPosition(item),
        })),
    };
}

// Main ERD conversion path used by the Prisma tool and renderer.
export function convertPrismaToErdSchema(source) {
    const prisma = typeof source === 'string' ? source : '';
    const parsed = parsePrismaSchema(prisma);
    const diagnostics = [...parsed.diagnostics];
    const helpers = normalizeModels(parsed, diagnostics);
    validateDatasourceCompatibility(parsed, helpers, diagnostics);
    validateModelIdentitySemantics(parsed, helpers, diagnostics);

    if (!helpers.activeModels.length && !diagnostics.some((item) => item.severity === 'error')) {
        diagnostics.push({
            severity: prisma.trim() ? 'warning' : 'info',
            message: prisma.trim() ? 'No Prisma model blocks were found.' : 'Paste a Prisma schema to generate an ERD.',
            line: 1,
        });
    }

    const tableInfos = helpers.activeModels.map((model) => buildPrismaTableInfo(model, diagnostics, helpers.compositeByName));
    const tableInfoByName = new Map(tableInfos.map((info) => [info.model.name, info]));
    validatePrismaRelationPairs(tableInfos, tableInfoByName, parsed.datasource?.provider, diagnostics);
    const relations = [
        ...buildExplicitPrismaRelations(tableInfos, tableInfoByName, parsed.datasource?.provider, diagnostics),
        ...buildImplicitPrismaRelations(tableInfos, tableInfoByName, parsed.datasource?.provider, diagnostics),
    ];
    const normalizedDiagnostics = normalizePrismaDiagnostics(diagnostics);
    const schema = createPrismaEmptySchema(normalizedDiagnostics);

    schema.enums = parsed.enums
        .filter((item) => item.values.length > 0)
        .map((item) => ({
            name: item.name,
            values: item.values.map((value) => value.name),
            prisma: {
                dbName: item.dbName,
                schemaName: item.schemaName,
                mapped: item.dbName !== item.name,
                values: item.values,
                line: item.line,
            },
        }));
    schema.composites = parsed.composites.map((item) => ({
        name: item.name,
        fields: item.fields.map((field) => {
            const output = {
                name: field.name,
                type: formatPrismaFieldType(field),
            };
            if (field.attributes) {
                output.prisma = {
                    dbName: field.dbName,
                    attributes: field.attributes,
                    line: field.line,
                };
            }
            return output;
        }),
        prisma: {
            line: item.line,
        },
    }));
    schema.tables = tableInfos.map((info) => info.table);
    schema.relations = relations;
    schema.prisma = {
        datasource: parsed.datasource,
    };

    return {
        schema,
        diagnostics: normalizedDiagnostics,
        datasource: parsed.datasource,
        models: helpers.activeModels,
        enums: parsed.enums,
        composites: parsed.composites,
        stats: {
            modelCount: helpers.activeModels.filter((model) => model.kind === 'model').length,
            viewCount: helpers.activeModels.filter((model) => model.kind === 'view').length,
            enumCount: parsed.enums.length,
            compositeCount: parsed.composites.length,
            relationCount: countRelationGroups(relations),
        },
    };
}

// Secondary export path for users who want SQL text from the same parsed model.
export function convertPrismaToSql(source) {
    const prisma = typeof source === 'string' ? source : '';
    const parsed = parsePrismaSchema(prisma);
    const diagnostics = [...parsed.diagnostics];
    const helpers = normalizeModels(parsed, diagnostics);
    validateDatasourceCompatibility(parsed, helpers, diagnostics);
    validateModelIdentitySemantics(parsed, helpers, diagnostics);
    const tableInfos = helpers.activeModels.map((model) => buildPrismaTableInfo(model, diagnostics, helpers.compositeByName));
    const tableInfoByName = new Map(tableInfos.map((info) => [info.model.name, info]));
    validatePrismaRelationPairs(tableInfos, tableInfoByName, parsed.datasource?.provider, diagnostics);
    const relations = [
        ...buildExplicitPrismaRelations(tableInfos, tableInfoByName, parsed.datasource?.provider, diagnostics),
        ...buildImplicitPrismaRelations(tableInfos, tableInfoByName, parsed.datasource?.provider, diagnostics),
    ];
    const enumSql = parsed.enums
        .filter((item) => item.values.length > 0)
        .map((item) => `CREATE TYPE ${quoteDatabaseObject(item.dbName, item.schemaName)} AS ENUM (${item.values.map((value) => quoteLiteral(value.dbName)).join(', ')});`);
    const tableSql = [];
    const indexSql = [];

    helpers.activeModels.filter((model) => model.kind === 'model').forEach((model) => {
        const result = buildCreateTable(model, helpers, diagnostics);
        if (result.createTableSql) tableSql.push(result.createTableSql);
        indexSql.push(...result.indexSql);
    });

    helpers.activeModels.filter((model) => model.kind === 'view').forEach((model) => {
        diagnostics.push({
            severity: 'info',
            message: `view ${model.name} is shown in the Prisma ERD but omitted from generated SQL.`,
            line: model.line,
        });
    });

    if (!helpers.activeModels.length && !diagnostics.some((item) => item.severity === 'error')) {
        diagnostics.push({
            severity: prisma.trim() ? 'warning' : 'info',
            message: prisma.trim() ? 'No Prisma model blocks were found.' : 'Paste a Prisma schema to generate an ERD.',
            line: 1,
        });
    }

    const sql = [...enumSql, ...tableSql, ...indexSql].join('\n\n');
    const normalizedDiagnostics = normalizePrismaDiagnostics(diagnostics);

    return {
        sql,
        diagnostics: normalizedDiagnostics,
        datasource: parsed.datasource,
        models: helpers.activeModels,
        enums: parsed.enums,
        composites: parsed.composites,
        stats: {
            modelCount: helpers.activeModels.filter((model) => model.kind === 'model').length,
            viewCount: helpers.activeModels.filter((model) => model.kind === 'view').length,
            enumCount: parsed.enums.length,
            compositeCount: parsed.composites.length,
            relationCount: countRelationGroups(relations),
        },
    };
}
