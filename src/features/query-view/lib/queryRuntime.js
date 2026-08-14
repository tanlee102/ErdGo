import { tokenize } from '@/lib/parse-ast/tokenize.js';

// Internal runtime composition. Product code should import queryExecutor.js;
// keeping that facade stable lets parser/evaluator modules evolve safely.

/**
 * Query View runs SELECT-style read queries against the in-memory tables built
 * by Data View. Keep this executor side-effect free: callers may reuse the same
 * table maps for ERD rendering, data preview, and follow-up query execution.
 */
import {
    AGGREGATE_NAMES,
    emptyResult,
    errorResult,
    isUnsupportedPostgresOperatorToken,
    QUERY_KEYWORDS,
    QueryError,
    SCALAR_FUNCTION_NAMES,
    SET_OPERATORS,
    unsupportedPostgresOperatorError,
    WINDOW_FUNCTION_NAMES,
} from './queryLanguage.js';
import {
    isClauseKeyword,
    isDistinctFromContinuation,
    isIdentifierLike,
    isJoinStart,
    isReservedAlias,
    isSelectStart,
    isTokenKW,
    isTokenWord,
    splitTopLevel,
    stripSchema,
    tokensToSql,
    trimStatement,
    trimTokens,
    unique,
} from './queryTokens.js';

export function executeSelectQuery({ tables, query }) {
    const sql = typeof query === 'string' ? query.trim() : '';
    if (!sql) return emptyResult();

    try {
        const { tokens, errors: tokenErrors } = tokenize(sql, {
            lowercaseIdentifiers: false,
            skipComments: true,
            keywords: QUERY_KEYWORDS,
        });
        // A best-effort token (for example an unterminated string) must not
        // become a valid query literal. Parser recovery is useful for the ERD
        // editor, but query execution needs to fail closed on lexical errors.
        const lexicalError = tokenErrors.find((error) => error?.severity !== 'warning');
        if (lexicalError) return errorResult(new QueryError(`SQL syntax error: ${lexicalError.message}`, lexicalError));
        const statementTokens = trimStatement(tokens);
        if (statementTokens.length === 0) return emptyResult();

        return executeQueryTokens(tables, statementTokens);
    } catch (error) {
        return errorResult(error instanceof QueryError ? error : 'Unable to run query.');
    }
}

function executeQueryTokens(tables, tokens, outerContext = null) {
    const { queryTokens, sourceTables } = resolveWithClause(tables, trimStatement(tokens), outerContext);
    const parts = splitBySetOperator(queryTokens);
    const compoundTail = extractCompoundTail(parts, sourceTables);

    const executed = [];
    for (const part of parts) {
        const result = executeSingleSelect(part.tokens, sourceTables, outerContext);
        if (result.errors.length > 0) return result;
        executed.push({ ...part, result });
    }

    for (let i = 1; i < executed.length;) {
        const current = executed[i];
        if (current.operator !== 'INTERSECT') {
            i++;
            continue;
        }
        const previous = executed[i - 1];
        executed.splice(i - 1, 2, {
            operator: previous.operator,
            all: previous.all,
            result: combineSetResults(previous.result, current.result, current.operator, current.all),
        });
        i = Math.max(1, i - 1);
    }

    let result = executed[0].result;
    for (let i = 1; i < executed.length; i++) {
        const current = executed[i];
        result = combineSetResults(result, current.result, current.operator, current.all);
    }
    return compoundTail ? applyCompoundTail(result, compoundTail) : result;
}

function executeSingleSelect(tokens, tables, outerContext) {
    const parser = new SelectParser(tokens, tables, outerContext);
    const plan = parser.parse();
    return runPlan(plan);
}

function splitBySetOperator(tokens) {
    const parts = [];
    let current = [];
    let depth = 0;
    let pendingOp = null;
    let pendingAll = false;

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.type === 'PUNC' && token.value === '(') depth++;
        if (token.type === 'PUNC' && token.value === ')') depth--;
        if (depth === 0 && (token.type === 'KW' || token.type === 'IDENT') && SET_OPERATORS.has(String(token.value).toUpperCase())) {
            if (current.length > 0) parts.push({ tokens: current, operator: pendingOp, all: pendingAll });
            pendingOp = String(token.value).toUpperCase();
            pendingAll = false;
            if (isTokenWord(tokens[i + 1], 'ALL')) { pendingAll = true; i++; }
            else if (isTokenWord(tokens[i + 1], 'DISTINCT')) { i++; }
            current = [];
            continue;
        }
        current.push(token);
    }
    if (current.length > 0) parts.push({ tokens: current, operator: pendingOp, all: pendingAll });
    if (parts.length === 0) parts.push({ tokens, operator: null, all: false });
    return parts;
}

function combineSetResults(left, right, operator, all) {
    if (left.columns.length !== right.columns.length) {
        throw new QueryError(`${operator} requires the same number of columns in each query (left has ${left.columns.length}, right has ${right.columns.length}).`);
    }
    switch (operator) {
        case 'UNION': {
            const combined = [...left.rows, ...right.rows];
            if (all) return { ...left, rows: combined, meta: { ...left.meta, rowCount: combined.length } };
            const seen = new Set();
            const unique = combined.filter((row) => { const k = JSON.stringify(row); if (seen.has(k)) return false; seen.add(k); return true; });
            return { ...left, rows: unique, meta: { ...left.meta, rowCount: unique.length } };
        }
        case 'INTERSECT': {
            if (all) {
                const rightCounts = countRows(right.rows);
                const rows = left.rows.filter((row) => consumeRowCount(rightCounts, row));
                return { ...left, rows, meta: { ...left.meta, rowCount: rows.length } };
            }
            const rightKeys = new Set(right.rows.map((row) => JSON.stringify(row)));
            const seen = new Set();
            const rows = left.rows.filter((row) => {
                const key = JSON.stringify(row);
                if (!rightKeys.has(key) || seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            return { ...left, rows, meta: { ...left.meta, rowCount: rows.length } };
        }
        case 'EXCEPT': {
            if (all) {
                const rightCounts = countRows(right.rows);
                const rows = left.rows.filter((row) => !consumeRowCount(rightCounts, row));
                return { ...left, rows, meta: { ...left.meta, rowCount: rows.length } };
            }
            const rightKeys = new Set(right.rows.map((row) => JSON.stringify(row)));
            const seen = new Set();
            const rows = left.rows.filter((row) => {
                const key = JSON.stringify(row);
                if (rightKeys.has(key) || seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            return { ...left, rows, meta: { ...left.meta, rowCount: rows.length } };
        }
        default:
            return left;
    }
}

function extractCompoundTail(parts, tables) {
    if (parts.length < 2) return null;
    if (parts.slice(0, -1).some((part) => hasTopLevelPagination(part.tokens))) return null;

    const lastPart = parts[parts.length - 1];
    const start = findTopLevelClauseStart(lastPart.tokens, ['ORDER', 'LIMIT', 'OFFSET', 'FETCH']);
    if (start < 0) return null;

    const selectTokens = trimTokens(lastPart.tokens.slice(0, start));
    const tailTokens = trimTokens(lastPart.tokens.slice(start));
    if (selectTokens.length === 0) throw new QueryError('Set-operation query is missing its final SELECT.');
    lastPart.tokens = selectTokens;
    return parseCompoundTail(tailTokens, tables);
}

function parseCompoundTail(tokens, tables) {
    let idx = 0;
    let orderBy = [];
    let limit = null;
    let offset = 0;

    const peek = () => tokens[idx] || null;
    const consumeWord = (word) => {
        if (!isTokenWord(peek(), word)) return false;
        idx++;
        return true;
    };
    const parseInteger = (label) => {
        const token = tokens[idx++];
        if (!token || token.type !== 'NUMBER') throw new QueryError(`${label} requires a number.`);
        const value = Number(token.value);
        if (!Number.isInteger(value) || value < 0) throw new QueryError(`${label} must be a non-negative integer.`);
        return value;
    };
    const readUntil = (words) => {
        const stop = new Set(words);
        const out = [];
        let depth = 0;
        while (idx < tokens.length) {
            const token = tokens[idx];
            if (token.type === 'PUNC' && token.value === '(') depth++;
            if (token.type === 'PUNC' && token.value === ')') depth--;
            if (depth === 0 && isIdentifierLike(token) && stop.has(String(token.value).toUpperCase())) break;
            out.push(token);
            idx++;
        }
        return trimTokens(out);
    };

    while (idx < tokens.length) {
        if (consumeWord('ORDER')) {
            if (!consumeWord('BY')) throw new QueryError('ORDER must be followed by BY.');
            const orderTokens = readUntil(['LIMIT', 'OFFSET', 'FETCH']);
            if (orderTokens.length === 0) throw new QueryError('ORDER BY requires at least one expression.');
            orderBy = splitTopLevel(orderTokens, ',').map((part) => parseOrderItem(part, tables));
            continue;
        }
        if (consumeWord('LIMIT')) {
            const first = parseInteger('LIMIT');
            if (peek()?.type === 'PUNC' && peek().value === ',') {
                idx++;
                offset = first;
                limit = parseInteger('LIMIT');
            } else {
                limit = first;
            }
            continue;
        }
        if (consumeWord('OFFSET')) {
            offset = parseInteger('OFFSET');
            consumeWord('ROW') || consumeWord('ROWS');
            continue;
        }
        if (consumeWord('FETCH')) {
            consumeWord('FIRST') || consumeWord('NEXT');
            limit = parseInteger('FETCH');
            consumeWord('ROW') || consumeWord('ROWS');
            if (!consumeWord('ONLY')) throw new QueryError('FETCH must end with ONLY.');
            continue;
        }
        throw new QueryError(`Unexpected compound-query token "${peek()?.raw || peek()?.value}".`);
    }

    return { orderBy, limit, offset };
}

function applyCompoundTail(result, tail) {
    let rows = result.rows;
    if (tail.orderBy.length > 0) {
        rows = rows
            .map((row, index) => ({ row, index }))
            .sort((a, b) => compareCompoundRows(a, b, tail.orderBy, result.columns, result.meta?.dialect))
            .map((entry) => entry.row);
    }

    const start = tail.offset || 0;
    const end = tail.limit == null ? undefined : start + tail.limit;
    rows = rows.slice(start, end);
    return { ...result, rows, meta: { ...result.meta, rowCount: rows.length } };
}

function compareCompoundRows(a, b, orderBy, columns, dialect = 'auto') {
    for (const item of orderBy) {
        const av = evaluateCompoundOrderValue(item.expr, a.row, columns);
        const bv = evaluateCompoundOrderValue(item.expr, b.row, columns);
        if (av == null && bv == null) continue;
        if (av == null || bv == null) {
            return nullsSortFirst(item, dialect) === (av == null) ? -1 : 1;
        }
        const cmp = compareValues(av, bv, dialect);
        if (cmp !== 0) return item.direction === 'DESC' ? -cmp : cmp;
    }
    return a.index - b.index;
}

function evaluateCompoundOrderValue(expr, row, columns) {
    if (expr.type === 'literal' && Number.isInteger(expr.value)) {
        if (expr.value < 1 || expr.value > columns.length) {
            throw new QueryError(`Compound ORDER BY position ${expr.value} is outside the select list.`);
        }
        return row[expr.value - 1];
    }
    if (expr.type === 'column' && !expr.qualifier) {
        const index = columns.findIndex((column) => column.label.toLowerCase() === expr.name.toLowerCase());
        if (index >= 0) return row[index];
    }
    throw new QueryError('Compound ORDER BY must reference an output column or select-list position.');
}

function hasTopLevelPagination(tokens) {
    return findTopLevelClauseStart(tokens, ['LIMIT', 'OFFSET', 'FETCH']) >= 0;
}

function findTopLevelClauseStart(tokens, words) {
    const clauses = new Set(words);
    let depth = 0;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.type === 'PUNC' && token.value === '(') depth++;
        if (token.type === 'PUNC' && token.value === ')') depth--;
        if (depth === 0 && isIdentifierLike(token) && clauses.has(String(token.value).toUpperCase())) return i;
    }
    return -1;
}

function countRows(rows) {
    const counts = new Map();
    for (const row of rows) {
        const key = JSON.stringify(row);
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
}

function consumeRowCount(counts, row) {
    const key = JSON.stringify(row);
    const count = counts.get(key) || 0;
    if (count === 0) return false;
    if (count === 1) counts.delete(key);
    else counts.set(key, count - 1);
    return true;
}

function resolveWithClause(tables, tokens, outerContext = null) {
    if (!isTokenKW(tokens[0], 'WITH')) {
        return { queryTokens: tokens, sourceTables: tables };
    }

    const sourceTables = new Map(tables || []);
    const cteNames = new Set();
    let idx = 1;
    const recursiveWith = isTokenKW(tokens[idx], 'RECURSIVE');
    if (recursiveWith) idx++;

    while (idx < tokens.length) {
        const nameToken = tokens[idx++];
        if (!isIdentifierLike(nameToken)) throw new QueryError('WITH requires a CTE name.');
        const cteName = String(nameToken.value);
        const cteKey = cteName.toLowerCase();
        if (cteNames.has(cteKey)) throw new QueryError(`CTE "${cteName}" is declared more than once.`);
        cteNames.add(cteKey);
        const columnAliases = [];

        if (tokens[idx]?.type === 'PUNC' && tokens[idx].value === '(') {
            const aliasTokens = [];
            idx++;
            let depth = 1;
            while (idx < tokens.length && depth > 0) {
                const token = tokens[idx++];
                if (token.type === 'PUNC' && token.value === '(') depth++;
                if (token.type === 'PUNC' && token.value === ')') {
                    depth--;
                    if (depth === 0) break;
                }
                if (depth > 0) aliasTokens.push(token);
            }
            if (depth !== 0 || aliasTokens.length === 0) throw new QueryError(`Invalid column alias in CTE "${cteName}".`);
            columnAliases.push(...splitTopLevel(aliasTokens, ',').map((part) => {
                const cleaned = trimTokens(part);
                const alias = cleaned[0];
                if (cleaned.length !== 1 || !isIdentifierLike(alias)) throw new QueryError(`Invalid column alias in CTE "${cteName}".`);
                return String(alias.value);
            }));
        }

        if (!isTokenKW(tokens[idx], 'AS')) throw new QueryError(`CTE "${cteName}" must use AS (...).`);
        idx++;
        if (!(tokens[idx]?.type === 'PUNC' && tokens[idx].value === '(')) throw new QueryError(`CTE "${cteName}" must wrap its query in parentheses.`);
        idx++;

        const cteTokens = [];
        let depth = 1;
        while (idx < tokens.length && depth > 0) {
            const token = tokens[idx++];
            if (token.type === 'PUNC' && token.value === '(') {
                depth++;
                cteTokens.push(token);
                continue;
            }
            if (token.type === 'PUNC' && token.value === ')') {
                depth--;
                if (depth === 0) break;
                cteTokens.push(token);
                continue;
            }
            cteTokens.push(token);
        }
        if (depth !== 0) throw new QueryError(`CTE "${cteName}" is missing a closing parenthesis.`);

        const cteResult = recursiveWith && isRecursiveCte(cteName, cteTokens)
            ? executeRecursiveCte(sourceTables, cteName, cteTokens, columnAliases, outerContext)
            : executeQueryTokens(sourceTables, cteTokens, outerContext);
        if (cteResult.errors.length > 0) {
            throw new QueryError(`CTE "${cteName}": ${cteResult.errors[0].message}`);
        }
        if (columnAliases.length > 0 && columnAliases.length !== cteResult.columns.length) {
            throw new QueryError(`CTE "${cteName}" declares ${columnAliases.length} column alias(es) but returns ${cteResult.columns.length} column(s).`);
        }
        sourceTables.set(cteName, resultToTable(cteName, cteResult, columnAliases));

        if (tokens[idx]?.type === 'PUNC' && tokens[idx].value === ',') {
            idx++;
            continue;
        }
        break;
    }

    return { queryTokens: tokens.slice(idx), sourceTables };
}

function isRecursiveCte(cteName, tokens) {
    const expected = String(cteName).toLowerCase();
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (!isIdentifierLike(token) || String(token.value).toLowerCase() !== expected) continue;
        const previous = tokens[index - 1];
        // A CTE becomes recursive only when it is used as a relation source.
        // Looking for a bare matching word would misclassify a harmless
        // `SELECT value AS cte_name` alias as recursion.
        if (isTokenWord(previous, 'FROM') || isTokenWord(previous, 'JOIN') || (previous?.type === 'PUNC' && previous.value === ',')) return true;
    }
    return false;
}

// Executes the portable core shared by SQLite, PostgreSQL, MySQL 8+, and
// SQL Server: `anchor UNION [ALL] recursive-member`.  Each iteration exposes
// only the previous delta to the recursive member, which avoids the duplicate
// growth bug caused by handing it the full accumulated result every round.
function executeRecursiveCte(sourceTables, cteName, cteTokens, columnAliases, outerContext) {
    const parts = splitBySetOperator(cteTokens);
    if (parts.length !== 2 || parts[1].operator !== 'UNION') {
        throw new QueryError(`Recursive CTE "${cteName}" must contain exactly an anchor query UNION or UNION ALL one recursive query.`);
    }
    if (isRecursiveCte(cteName, parts[0].tokens)) {
        throw new QueryError(`Recursive CTE "${cteName}" may reference itself only in its recursive query.`);
    }

    const anchor = executeQueryTokens(sourceTables, parts[0].tokens, outerContext);
    if (anchor.errors.length > 0) throw new QueryError(`CTE "${cteName}" anchor: ${anchor.errors[0].message}`);
    if (columnAliases.length > 0 && columnAliases.length !== anchor.columns.length) {
        throw new QueryError(`CTE "${cteName}" declares ${columnAliases.length} column alias(es) but returns ${anchor.columns.length} column(s).`);
    }

    const unionAll = parts[1].all;
    const accumulated = [...anchor.rows];
    let delta = [...anchor.rows];
    const seen = unionAll ? null : new Set(accumulated.map((row) => JSON.stringify(row)));
    const maxIterations = 1000;
    const maxRows = 100000;

    for (let iteration = 0; delta.length > 0; iteration++) {
        if (iteration >= maxIterations || accumulated.length > maxRows) {
            throw new QueryError(`Recursive CTE "${cteName}" exceeded the safety limit (${maxIterations} iterations / ${maxRows} rows). Add a terminating condition.`);
        }
        const iterationTables = new Map(sourceTables);
        iterationTables.set(cteName, resultToTable(cteName, {
            ...anchor,
            rows: delta,
            meta: { ...anchor.meta, rowCount: delta.length },
        }, columnAliases));
        const next = executeQueryTokens(iterationTables, parts[1].tokens, outerContext);
        if (next.errors.length > 0) throw new QueryError(`CTE "${cteName}" recursive query: ${next.errors[0].message}`);
        if (next.columns.length !== anchor.columns.length) {
            throw new QueryError(`Recursive CTE "${cteName}" requires the same number of columns in its anchor and recursive queries.`);
        }

        delta = unionAll
            ? next.rows
            : next.rows.filter((row) => {
                const key = JSON.stringify(row);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        accumulated.push(...delta);
    }

    return {
        ...anchor,
        rows: accumulated,
        meta: { ...anchor.meta, rowCount: accumulated.length },
    };
}

function resultToTable(name, result, columnAliases = []) {
    const columnNames = uniqueColumnNames(result.columns.map((column, index) => columnAliases[index] || column.label || `column_${index + 1}`));
    return {
        name,
        dialect: result.meta?.dialect || 'auto',
        columns: columnNames.map((columnName) => ({ name: columnName, type: 'QUERY' })),
        rows: result.rows.map((row) => {
            const out = {};
            columnNames.forEach((columnName, index) => {
                out[columnName] = row[index];
            });
            return out;
        }),
    };
}

function uniqueColumnNames(names) {
    const counts = new Map();
    return names.map((name, index) => {
        const base = String(name || `column_${index + 1}`);
        const key = base.toLowerCase();
        const count = counts.get(key) || 0;
        counts.set(key, count + 1);
        return count === 0 ? base : `${base}_${count + 1}`;
    });
}


// Parser stage: turn a token stream into a compact query plan. Execution is
// kept separate below so validation can reject unsupported SQL before rows are
// touched.
class SelectParser {
    constructor(tokens, tables, outerContext = null) {
        this.tokens = tokens;
        this.tables = tables;
        this.outerContext = outerContext;
        this.idx = 0;
    }

    parse() {
        this.expectKW('SELECT', 'Query must start with SELECT.');
        const distinct = this.consumeKW('DISTINCT');
        let distinctOn = null;
        if (distinct && this.consumeKW('ON')) {
            if (!(this.peek()?.type === 'PUNC' && this.peek()?.value === '(')) throw new QueryError('DISTINCT ON requires parenthesized expression list.');
            this.next();
            const onTokens = [];
            let d = 1;
            while (!this.eof() && d > 0) {
                const t = this.next();
                if (t.type === 'PUNC' && t.value === '(') { d++; onTokens.push(t); }
                else if (t.type === 'PUNC' && t.value === ')') { d--; if (d > 0) onTokens.push(t); }
                else onTokens.push(t);
            }
            distinctOn = splitTopLevel(onTokens, ',').map((part) => parseScalarExpression(part, this.tables));
        }
        let topLimit = null;
        if (this.consumeWord('TOP')) {
            topLimit = this.parseTopLimit();
        }
        const selectTokens = this.readUntilTopLevelKW(['FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH']);
        if (selectTokens.length === 0) throw new QueryError('SELECT list is empty.');
        const selectItems = splitTopLevel(selectTokens, ',').map((part) => parseSelectItem(part, this.tables));

        const source = this.consumeKW('FROM')
            ? attachOuterContext(this.parseSource(), this.outerContext)
            : this.createNoFromSource();

        let where = null;
        let groupBy = [];
        let having = null;
        let orderBy = [];
        let limit = topLimit;
        let offset = 0;

        while (!this.eof()) {
            if (this.consumeKW('WHERE')) {
                where = parseBooleanExpression(this.readUntilTopLevelKW(['GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH']), this.tables);
                continue;
            }
            if (this.consumeKW('GROUP')) {
                this.expectKW('BY', 'GROUP must be followed by BY.');
                groupBy = splitTopLevel(this.readUntilTopLevelKW(['HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH']), ',').map((part) => parseScalarExpression(part, this.tables));
                continue;
            }
            if (this.consumeKW('HAVING')) {
                having = parseBooleanExpression(this.readUntilTopLevelKW(['ORDER', 'LIMIT', 'OFFSET', 'FETCH']), this.tables);
                continue;
            }
            if (this.consumeKW('ORDER')) {
                this.expectKW('BY', 'ORDER must be followed by BY.');
                orderBy = splitTopLevel(this.readUntilTopLevelKW(['LIMIT', 'OFFSET', 'FETCH']), ',').map((part) => parseOrderItem(part, this.tables));
                continue;
            }
            if (this.consumeKW('LIMIT')) {
                const first = this.parseNonNegativeInteger('LIMIT');
                if (this.peek()?.type === 'PUNC' && this.peek()?.value === ',') {
                    this.next();
                    offset = first;
                    limit = this.parseNonNegativeInteger('LIMIT');
                } else {
                    limit = first;
                }
                continue;
            }
            if (this.consumeKW('OFFSET')) {
                offset = this.parseNonNegativeInteger('OFFSET');
                this.consumeWord('ROW') || this.consumeWord('ROWS');
                continue;
            }
            if (this.consumeKW('FETCH')) {
                this.consumeWord('FIRST') || this.consumeWord('NEXT');
                limit = this.parseNonNegativeInteger('FETCH');
                this.consumeWord('ROW') || this.consumeWord('ROWS');
                this.expectWord('ONLY', 'FETCH must end with ONLY.');
                continue;
            }
            throw new QueryError(`Unexpected token "${this.peek()?.raw || this.peek()?.value}".`);
        }

        const plan = { distinct, distinctOn, selectItems, source, where, groupBy, having, orderBy, limit, offset };
        validateQueryPlan(plan);
        return plan;
    }

    createNoFromSource() {
        const context = createContext([]);
        context.dialect = inferTablesDialect(this.tables) || this.outerContext?.dialect || 'auto';
        return attachOuterContext(withSample([context], context), this.outerContext);
    }

    parseSource() {
        let contexts = contextsForTable(this.tables, this.parseTableRef());

        while (!this.eof()) {
            const token = this.peek();
            if (isClauseKeyword(token)) break;

            if (token.type === 'PUNC' && token.value === ',') {
                this.next();
                const rightContexts = contextsForTable(this.tables, this.parseTableRef());
                assertDistinctSourceAliases(contexts, rightContexts);
                contexts = combineContexts(contexts, rightContexts);
                continue;
            }

            const joinKind = this.parseJoinKind();
            if (!joinKind) break;

            const rightContexts = contextsForTable(this.tables, this.parseTableRef());
            assertDistinctSourceAliases(contexts, rightContexts);
            let on = null;
            if (this.consumeKW('ON')) {
                on = parseBooleanExpression(this.readJoinConditionTokens(), this.tables);
                assertClauseHasNoAggregateOrWindow(on, 'JOIN ON');
            } else if (joinKind !== 'cross') {
                throw new QueryError('JOIN requires an ON condition.');
            }
            contexts = joinContexts(contexts, rightContexts, joinKind, on);
        }

        return contexts;
    }

    parseJoinKind() {
        if (this.consumeKW('JOIN')) return 'inner';
        if (this.consumeKW('INNER')) {
            this.expectKW('JOIN', 'INNER must be followed by JOIN.');
            return 'inner';
        }
        if (this.consumeKW('LEFT')) {
            this.consumeKW('OUTER');
            this.expectKW('JOIN', 'LEFT must be followed by JOIN.');
            return 'left';
        }
        if (this.consumeKW('RIGHT')) {
            this.consumeKW('OUTER');
            this.expectKW('JOIN', 'RIGHT must be followed by JOIN.');
            return 'right';
        }
        if (this.consumeKW('FULL')) {
            this.consumeKW('OUTER');
            this.expectKW('JOIN', 'FULL must be followed by JOIN.');
            return 'full';
        }
        if (this.consumeKW('CROSS')) {
            this.expectKW('JOIN', 'CROSS must be followed by JOIN.');
            return 'cross';
        }
        return null;
    }

    parseTableRef() {
        if (this.peek()?.type === 'PUNC' && this.peek()?.value === '(' && isSelectStart(this.peek(1))) {
            const subqueryTokens = this.readParenthesizedTokens('derived table');
            const parsedAlias = this.parseTableAlias('derived table');
            const alias = parsedAlias || 'subquery';
            const result = executeQueryTokens(this.tables, subqueryTokens, this.outerContext);
            if (result.errors.length > 0) throw new QueryError(`Derived table "${alias}": ${result.errors[0].message}`);
            return { table: resultToTable(alias, result), alias, explicitAlias: Boolean(parsedAlias) };
        }

        const name = this.parseQualifiedIdent();
        if (!name) throw new QueryError('Expected table name in FROM.');

        const alias = this.parseTableAlias(`table "${name}"`);

        return { name, alias, explicitAlias: Boolean(alias) };
    }

    parseTableAlias(label) {
        if (this.consumeKW('AS')) {
            const alias = this.parseIdent();
            if (!alias) throw new QueryError(`Expected alias after AS for ${label}.`);
            return alias;
        }

        const next = this.peek();
        if (isIdentifierLike(next) && !isReservedAlias(next)) {
            return this.parseIdent();
        }
        return null;
    }

    readJoinConditionTokens() {
        const out = [];
        let depth = 0;
        while (!this.eof()) {
            const token = this.peek();
            if (token.type === 'PUNC' && token.value === '(') depth++;
            if (token.type === 'PUNC' && token.value === ')') depth--;
            if (depth === 0 && (isClauseKeyword(token) || isJoinStart(token))) break;
            out.push(this.next());
        }
        return out;
    }

    readUntilTopLevelKW(words) {
        const stop = new Set(words);
        const out = [];
        let depth = 0;
        while (!this.eof()) {
            const token = this.peek();
            if (token.type === 'PUNC' && token.value === '(') depth++;
            if (token.type === 'PUNC' && token.value === ')') depth--;
            if (depth === 0 && isIdentifierLike(token) && stop.has(String(token.value).toUpperCase()) && !isDistinctFromContinuation(out, token)) break;
            out.push(this.next());
        }
        return out;
    }

    parseNonNegativeInteger(label) {
        const token = this.next();
        if (!token || token.type !== 'NUMBER') throw new QueryError(`${label} requires a number.`);
        const value = Number(token.value);
        if (!Number.isInteger(value) || value < 0) throw new QueryError(`${label} must be a non-negative integer.`);
        return value;
    }

    parseTopLimit() {
        if (this.peek()?.type === 'PUNC' && this.peek()?.value === '(') {
            this.next();
            const value = this.parseNonNegativeInteger('TOP');
            if (!(this.peek()?.type === 'PUNC' && this.peek()?.value === ')')) throw new QueryError('TOP (...) requires a closing parenthesis.');
            this.next();
            return value;
        }
        return this.parseNonNegativeInteger('TOP');
    }

    readParenthesizedTokens(label) {
        if (!(this.peek()?.type === 'PUNC' && this.peek()?.value === '(')) throw new QueryError(`${label} must start with "(".`);
        this.next();
        const out = [];
        let depth = 1;
        while (!this.eof() && depth > 0) {
            const token = this.next();
            if (token.type === 'PUNC' && token.value === '(') {
                depth++;
                out.push(token);
                continue;
            }
            if (token.type === 'PUNC' && token.value === ')') {
                depth--;
                if (depth === 0) break;
                out.push(token);
                continue;
            }
            out.push(token);
        }
        if (depth !== 0) throw new QueryError(`${label} is missing a closing parenthesis.`);
        return out;
    }

    parseQualifiedIdent() {
        let name = this.parseIdent();
        if (!name) return null;
        while (this.peek()?.type === 'PUNC' && this.peek()?.value === '.') {
            this.next();
            const part = this.parseIdent();
            if (!part) break;
            name = `${name}.${part}`;
        }
        return name;
    }

    parseIdent() {
        const token = this.peek();
        if (!isIdentifierLike(token)) return null;
        return String(this.next().value);
    }

    expectKW(value, message) {
        if (!this.consumeKW(value)) throw new QueryError(message);
    }

    expectWord(value, message) {
        if (!this.consumeWord(value)) throw new QueryError(message);
    }

    consumeKW(value) {
        if (this.isKW(value)) {
            this.next();
            return true;
        }
        return false;
    }

    consumeWord(value) {
        if (this.isWord(value)) {
            this.next();
            return true;
        }
        return false;
    }

    isKW(value) {
        const token = this.peek();
        return token?.type === 'KW' && token.value.toUpperCase() === value;
    }

    isWord(value) {
        return isTokenWord(this.peek(), value);
    }

    peek(offset = 0) {
        return this.tokens[this.idx + offset] || null;
    }

    next() {
        return this.tokens[this.idx++] || null;
    }

    eof() {
        return this.idx >= this.tokens.length;
    }
}

// Execution stage: evaluate the validated plan against row contexts, then apply
// SQL ordering, distinctness, and pagination rules in the same order users
// expect from a database.
function runPlan(plan) {
    let contexts = plan.source;

    if (plan.where) {
        contexts = contexts.filter((ctx) => truthy(evaluateBoolean(plan.where, ctx), ctx.dialect));
    }

    const hasAggregates = plan.selectItems.some((item) => item.expr && expressionHasAggregate(item.expr)) || (plan.having && expressionHasAggregate(plan.having)) || plan.orderBy.some((item) => expressionHasAggregate(item.expr));
    const grouped = hasAggregates || plan.groupBy.length > 0;

    let outputRows;
    let columns;
    let orderContexts = null;

    if (grouped) {
        const groups = buildGroups(contexts, plan.groupBy);
        const selectedGroups = plan.having ? groups.filter((group) => truthy(evaluateBoolean(plan.having, group.context, group.rows), group.context?.dialect)) : groups;
        const projection = projectGroups(selectedGroups, plan.selectItems, plan.orderBy);
        columns = projection.columns;
        outputRows = projection.rows;
        orderContexts = selectedGroups.map((group, index) => ({ group, output: outputRows[index], windowScope: { values: projection.windowValues, index } }));
    } else {
        const projection = projectContexts(contexts, plan.selectItems, plan.orderBy);
        columns = projection.columns;
        outputRows = projection.rows;
        orderContexts = contexts.map((context, index) => ({ context, output: outputRows[index], windowScope: { values: projection.windowValues, index } }));
    }

    if (plan.distinct && !(plan.distinctOn && plan.distinctOn.length > 0)) {
        const seen = new Set();
        const distinctRows = [];
        const distinctOrderContexts = [];
        outputRows.forEach((row, index) => {
            const key = JSON.stringify(row);
            if (seen.has(key)) return;
            seen.add(key);
            distinctRows.push(row);
            distinctOrderContexts.push(orderContexts[index]);
        });
        outputRows = distinctRows;
        orderContexts = distinctOrderContexts;
    }

    if (plan.orderBy.length > 0) {
        const indexed = outputRows.map((row, index) => ({ row, orderContext: orderContexts[index], index }));
        indexed.sort((a, b) => compareOrder(a, b, plan.orderBy, columns));
        outputRows = indexed.map((item) => item.row);
        orderContexts = indexed.map((item) => item.orderContext);
    }

    // PostgreSQL DISTINCT ON keeps the first row after ORDER BY has established precedence.
    if (plan.distinctOn && plan.distinctOn.length > 0) {
        const seen = new Set();
        const filteredRows = [];
        const filteredOrderContexts = [];
        outputRows.forEach((row, index) => {
            const oc = orderContexts[index];
            const ctx = grouped ? oc.group?.context : oc.context;
            const key = plan.distinctOn.map((expr) => JSON.stringify(evaluateScalar(expr, ctx, grouped ? oc.group?.rows : null))).join('\x01');
            if (seen.has(key)) return;
            seen.add(key);
            filteredRows.push(row);
            filteredOrderContexts.push(oc);
        });
        outputRows = filteredRows;
        orderContexts = filteredOrderContexts;
    }

    const start = plan.offset || 0;
    const end = plan.limit == null ? undefined : start + plan.limit;
    outputRows = outputRows.slice(start, end);

    return {
        columns,
        rows: outputRows,
        errors: [],
        warnings: [],
        meta: { rowCount: outputRows.length, dialect: getSampleContext(plan.source)?.dialect || 'auto' },
    };
}

// Validate SQL semantics before evaluation. The executor intentionally
// simulates more than one SQL dialect, so it must fail closed where accepting
// a query would otherwise invent a database-specific result (for example,
// selecting an arbitrary row from an aggregate group).
function validateQueryPlan(plan) {
    assertClauseHasNoAggregateOrWindow(plan.where, 'WHERE');
    for (const expression of plan.groupBy) {
        assertClauseHasNoAggregateOrWindow(expression, 'GROUP BY');
    }
    if (expressionHasWindow(plan.having)) {
        throw new QueryError('HAVING cannot contain window functions.');
    }
    validateDistinctOnOrdering(plan);

    const queryHasAggregate = plan.selectItems.some((item) => item.kind === 'expr' && expressionHasAggregate(item.expr))
        || expressionHasAggregate(plan.having)
        || plan.orderBy.some((item) => expressionHasAggregate(item.expr));
    const groupedQuery = queryHasAggregate || plan.groupBy.length > 0;

    const aggregateExpressions = [
        ...plan.selectItems.filter((item) => item.kind === 'expr').map((item) => item.expr),
        plan.having,
        ...plan.orderBy.map((item) => item.expr),
    ];
    aggregateExpressions.forEach((expression) => assertNoNestedAggregateOrWindow(expression));

    if (!groupedQuery) return;

    for (const item of plan.selectItems) {
        if (item.kind === 'star' || item.kind === 'tableStar') {
            throw new QueryError('SELECT * is not valid in an aggregate query. Select grouping columns explicitly.');
        }
        assertExpressionUsesOnlyGroupingColumns(item.expr, plan.groupBy, 'SELECT');
    }
    assertExpressionUsesOnlyGroupingColumns(plan.having, plan.groupBy, 'HAVING');

    const outputAliases = new Set(plan.selectItems
        .filter((item) => item.kind === 'expr' && item.alias)
        .map((item) => item.alias.toLowerCase()));
    for (const item of plan.orderBy) {
        // ORDER BY may legitimately refer to a SELECT-list alias, which is
        // resolved after projection rather than against source columns.
        if (item.expr?.type === 'column' && !item.expr.qualifier && outputAliases.has(item.expr.name.toLowerCase())) continue;
        assertExpressionUsesOnlyGroupingColumns(item.expr, plan.groupBy, 'ORDER BY');
    }
}

function validateDistinctOnOrdering(plan) {
    if (!plan.distinctOn || plan.distinctOn.length === 0) return;
    if (plan.orderBy.length < plan.distinctOn.length) {
        throw new QueryError('DISTINCT ON requires ORDER BY expressions that establish which row is kept.');
    }

    // Resolve DISTINCT ON columns before validating the ORDER BY contract so
    // users see the actionable source error (for example, an unknown column)
    // instead of a secondary ordering error.
    const sourceContext = getSampleContext(plan.source);
    plan.distinctOn.forEach((expression) => assertExpressionColumnsResolve(expression, sourceContext));

    const required = new Set(plan.distinctOn.map(expressionFingerprint));
    const leading = plan.orderBy.slice(0, plan.distinctOn.length).map((item) => expressionFingerprint(item.expr));
    if (leading.some((key) => !required.has(key)) || new Set(leading).size !== required.size) {
        throw new QueryError('DISTINCT ON expressions must match the leftmost ORDER BY expressions.');
    }
}

function assertExpressionColumnsResolve(expression, context) {
    if (!expression || typeof expression !== 'object' || expression.type === 'subquery') return;
    if (expression.type === 'column') {
        resolveColumn(context, expression);
        return;
    }
    for (const [key, value] of Object.entries(expression)) {
        if (key === 'tables' || key === 'type') continue;
        if (Array.isArray(value)) value.forEach((item) => assertExpressionColumnsResolve(item, context));
        else assertExpressionColumnsResolve(value, context);
    }
}

function assertClauseHasNoAggregateOrWindow(expression, clause) {
    if (!expression) return;
    if (expressionHasAggregate(expression)) throw new QueryError(`${clause} cannot contain aggregate functions.`);
    if (expressionHasWindow(expression)) throw new QueryError(`${clause} cannot contain window functions.`);
}

function assertNoNestedAggregateOrWindow(expression, insideAggregate = false) {
    if (!expression || typeof expression !== 'object') return;
    if (expression.type === 'subquery') return;

    const isAggregate = expression.type === 'aggregate';
    const isWindow = expression.type === 'window' || expression.type === 'windowAggregate';
    if (insideAggregate && (isAggregate || isWindow)) {
        throw new QueryError('Aggregate functions cannot contain aggregate or window functions.');
    }

    for (const [key, value] of Object.entries(expression)) {
        if (key === 'tables' || key === 'type') continue;
        if (Array.isArray(value)) {
            value.forEach((item) => assertNoNestedAggregateOrWindow(item, insideAggregate || isAggregate));
        } else {
            assertNoNestedAggregateOrWindow(value, insideAggregate || isAggregate);
        }
    }
}

function assertExpressionUsesOnlyGroupingColumns(expression, groupBy, clause) {
    if (!expression) return;
    const groupedExpressions = new Set(groupBy.map(expressionFingerprint));
    const ungroupedColumns = [];

    const visit = (current) => {
        if (!current || typeof current !== 'object') return;
        if (current.type === 'subquery' || current.type === 'aggregate' || current.type === 'window' || current.type === 'windowAggregate') return;
        if (groupedExpressions.has(expressionFingerprint(current))) return;
        if (current.type === 'column') {
            if (!isGroupingColumn(current, groupBy)) ungroupedColumns.push(current);
            return;
        }
        for (const [key, value] of Object.entries(current)) {
            if (key === 'tables' || key === 'type') continue;
            if (Array.isArray(value)) value.forEach(visit);
            else visit(value);
        }
    };

    visit(expression);
    const column = ungroupedColumns[0];
    if (column) {
        const label = column.qualifier ? `${column.qualifier}.${column.name}` : column.name;
        throw new QueryError(`${clause} column "${label}" must appear in GROUP BY or be used in an aggregate function.`);
    }
}

function isGroupingColumn(column, groupBy) {
    return groupBy.some((groupExpression) => {
        if (groupExpression?.type !== 'column') return false;
        if (groupExpression.name.toLowerCase() !== column.name.toLowerCase()) return false;
        if (groupExpression.qualifier && column.qualifier) {
            return groupExpression.qualifier.toLowerCase() === column.qualifier.toLowerCase();
        }
        // An unqualified column can only reach execution when it is unique in
        // the source. The resolver enforces that separately, so matching its
        // uniquely named grouping counterpart here is safe.
        return true;
    });
}

function expressionFingerprint(expression) {
    const normalize = (value) => {
        if (Array.isArray(value)) return value.map(normalize);
        if (!value || typeof value !== 'object') return value;
        const out = {};
        Object.keys(value).sort().forEach((key) => {
            if (key !== 'tables') out[key] = normalize(value[key]);
        });
        return out;
    };
    return JSON.stringify(normalize(expression));
}

function expressionHasWindow(expr) {
    if (!expr || typeof expr !== 'object') return false;
    if (expr.type === 'window' || expr.type === 'windowAggregate') return true;
    if (expr.type === 'subquery') return false;
    return Object.values(expr).some((value) => {
        if (Array.isArray(value)) return value.some(expressionHasWindow);
        return value && typeof value === 'object' && expressionHasWindow(value);
    });
}

function assertDistinctSourceAliases(leftContexts, rightContexts) {
    const used = new Set((getSampleContext(leftContexts)?.entries || []).map((entry) => String(entry.alias).toLowerCase()));
    for (const entry of getSampleContext(rightContexts)?.entries || []) {
        const key = String(entry.alias).toLowerCase();
        if (used.has(key)) throw new QueryError(`Duplicate table or alias "${entry.alias}" in FROM clause.`);
        used.add(key);
    }
}

function contextsForTable(tables, ref) {
    const table = ref.table || findTable(tables, ref.name);
    if (!table) throw new QueryError(`Table "${ref.name}" does not exist.`);
    const alias = ref.alias || table.name;
    const explicitAlias = ref.explicitAlias === true;
    const sampleContext = createContext([{ table, alias, explicitAlias, row: null }]);
    return withSample(table.rows.map((row) => createContext([{ table, alias, explicitAlias, row }])), sampleContext);
}

function attachOuterContext(contexts, outerContext) {
    if (!outerContext) return contexts;
    contexts.forEach((context) => {
        context.outer = outerContext;
    });
    const sample = getSampleContext(contexts);
    if (sample) sample.outer = outerContext;
    return contexts;
}

function createContext(entries) {
    const columns = [];
    const scopes = new Map();

    for (const entry of entries) {
        // Once a table has an explicit alias, SQL requires that alias for
        // qualification. Keeping the original table name in scope masks
        // mistakes such as `FROM users u ... users.id` and can silently bind
        // a column to the wrong source in a self-join.
        const aliases = entry.explicitAlias
            ? [entry.alias]
            : unique([entry.alias, entry.table.name, stripSchema(entry.table.name)]);
        for (const alias of aliases) {
            scopes.set(alias.toLowerCase(), entry);
        }
        for (const column of entry.table.columns) {
            columns.push({
                table: entry.table,
                tableName: entry.table.name,
                alias: entry.alias,
                columnName: column.name,
                type: column.type || null,
                value: entry.row ? getRowValue(entry.row, column.name) : null,
            });
        }
    }

    return { entries, columns, scopes, dialect: inferContextDialect(entries) };
}

function inferContextDialect(entries) {
    const dialects = new Set(entries
        .map((entry) => entry?.table?.dialect)
        .filter((dialect) => dialect && dialect !== 'auto'));
    return dialects.size === 1 ? Array.from(dialects)[0] : 'auto';
}

function inferTablesDialect(tables) {
    if (!tables) return 'auto';
    const dialects = new Set(Array.from(tables.values())
        .map((table) => table?.dialect)
        .filter((dialect) => dialect && dialect !== 'auto'));
    return dialects.size === 1 ? Array.from(dialects)[0] : 'auto';
}

function combineContexts(leftContexts, rightContexts) {
    const combined = [];
    for (const left of leftContexts) {
        for (const right of rightContexts) {
            combined.push(createContext([...left.entries, ...right.entries]));
        }
    }
    const leftSample = getSampleContext(leftContexts);
    const rightSample = getSampleContext(rightContexts);
    return withSample(combined, createContext([...(leftSample?.entries || []), ...(rightSample?.entries || [])]));
}

function joinContexts(leftContexts, rightContexts, joinKind, on) {
    if (joinKind === 'cross') return combineContexts(leftContexts, rightContexts);

    const joined = [];
    const leftSample = getSampleContext(leftContexts);
    const rightSample = getSampleContext(rightContexts);
    const rightNullEntries = rightSample?.entries.map((entry) => ({ ...entry, row: null })) || [];
    const leftNullEntries = leftSample?.entries.map((entry) => ({ ...entry, row: null })) || [];

    if (joinKind === 'right') {
        for (const right of rightContexts) {
            let matched = false;
            for (const left of leftContexts) {
                const context = createContext([...left.entries, ...right.entries]);
                if (!on || truthy(evaluateBoolean(on, context), context.dialect)) {
                    matched = true;
                    joined.push(context);
                }
            }
            if (!matched) joined.push(createContext([...leftNullEntries, ...right.entries]));
        }
    } else if (joinKind === 'full') {
        const matchedRight = new Set();
        for (const left of leftContexts) {
            let matched = false;
            for (let ri = 0; ri < rightContexts.length; ri++) {
                const context = createContext([...left.entries, ...rightContexts[ri].entries]);
                if (!on || truthy(evaluateBoolean(on, context), context.dialect)) {
                    matched = true;
                    matchedRight.add(ri);
                    joined.push(context);
                }
            }
            if (!matched) joined.push(createContext([...left.entries, ...rightNullEntries]));
        }
        for (let ri = 0; ri < rightContexts.length; ri++) {
            if (!matchedRight.has(ri)) joined.push(createContext([...leftNullEntries, ...rightContexts[ri].entries]));
        }
    } else {
        for (const left of leftContexts) {
            let matched = false;
            for (const right of rightContexts) {
                const context = createContext([...left.entries, ...right.entries]);
                if (!on || truthy(evaluateBoolean(on, context), context.dialect)) {
                    matched = true;
                    joined.push(context);
                }
            }
            if (!matched && joinKind === 'left') {
                joined.push(createContext([...left.entries, ...rightNullEntries]));
            }
        }
    }
    return withSample(joined, createContext([...(leftSample?.entries || []), ...(rightSample?.entries || [])]));
}

function projectContexts(contexts, selectItems, orderBy = []) {
    const expandedItems = expandSelectItems(selectItems, contexts[0] || getSampleContext(contexts));
    const columns = expandedItems.map((item, index) => ({ key: `c${index}`, label: itemLabel(item) }));
    const subjects = contexts.map((context) => ({ context, groupRows: null }));
    const windowValues = buildWindowValues([...expandedItems.map((item) => item.expr), ...orderBy.map((item) => item.expr)], subjects);
    const rows = contexts.map((context, index) => {
        const windowScope = { values: windowValues, index };
        return expandedItems.map((item) => evaluateScalar(item.expr, context, null, windowScope));
    });
    return { columns, rows, windowValues };
}

function projectGroups(groups, selectItems, orderBy = []) {
    const sample = groups[0]?.context || null;
    const expandedItems = expandSelectItems(selectItems, sample);
    const columns = expandedItems.map((item, index) => ({ key: `c${index}`, label: itemLabel(item) }));
    const subjects = groups.map((group) => ({ context: group.context, groupRows: group.rows }));
    const windowValues = buildWindowValues([...expandedItems.map((item) => item.expr), ...orderBy.map((item) => item.expr)], subjects);
    const rows = groups.map((group, index) => {
        const windowScope = { values: windowValues, index };
        return expandedItems.map((item) => evaluateScalar(item.expr, group.context, group.rows, windowScope));
    });
    return { columns, rows, windowValues };
}

function buildWindowValues(expressions, subjects) {
    const windows = collectWindowExpressions(expressions);
    const values = new Map();

    for (const windowExpr of windows) {
        if (windowExpr.type === 'windowAggregate') {
            values.set(windowExpr, evaluateAggregateWindow(windowExpr, subjects));
        } else {
            values.set(windowExpr, evaluateRankingWindow(windowExpr, subjects));
        }
    }

    return values;
}

function collectWindowExpressions(expressions) {
    const windows = new Set();
    const visit = (expr) => {
        if (!expr || typeof expr !== 'object') return;
        if (expr.type === 'window' || expr.type === 'windowAggregate') {
            windows.add(expr);
            return;
        }
        if (expr.type === 'subquery') return;
        Object.values(expr).forEach((value) => {
            if (Array.isArray(value)) {
                value.forEach(visit);
                return;
            }
            visit(value);
        });
    };

    expressions.forEach(visit);
    return Array.from(windows);
}

function evaluateRankingWindow(expr, subjects) {
    const values = Array(subjects.length).fill(null);
    const partitions = new Map();

    subjects.forEach((subject, index) => {
        const partitionKey = expr.partitionBy.length === 0 ? '__all__' : expr.partitionBy.map((part) => valueKey(evaluateScalar(part, subject.context, subject.groupRows))).join('\u0001');
        if (!partitions.has(partitionKey)) partitions.set(partitionKey, []);
        partitions.get(partitionKey).push({
            index,
            subject,
            orderValues: expr.orderBy.map((item) => evaluateScalar(item.expr, subject.context, subject.groupRows)),
        });
    });

    for (const partition of partitions.values()) {
        const ordered = orderWindowPartition(partition, expr.orderBy);

        const size = ordered.length;
        let denseRank = 0;
        let rank = 1;
        let previous = null;

        ordered.forEach((item, position) => {
            const peer = previous && sameWindowOrderValues(previous.orderValues, item.orderValues, item.subject.context?.dialect);
            const frame = expr.frame ? windowFrameEntries(expr.frame, ordered, position) : ordered;
            if (!peer) {
                denseRank += 1;
                rank = position + 1;
            }

            switch (expr.name) {
                case 'ROW_NUMBER':
                    values[item.index] = position + 1;
                    break;
                case 'RANK':
                    values[item.index] = expr.orderBy.length === 0 ? 1 : rank;
                    break;
                case 'DENSE_RANK':
                    values[item.index] = expr.orderBy.length === 0 ? 1 : denseRank;
                    break;
                case 'NTILE': {
                    const buckets = Number(evaluateScalar(expr.args[0], item.subject.context, item.subject.groupRows));
                    values[item.index] = buckets > 0 ? Math.min(Math.floor(position * buckets / size) + 1, buckets) : null;
                    break;
                }
                case 'LAG': {
                    const offset = expr.args[1] ? Number(evaluateScalar(expr.args[1], item.subject.context, item.subject.groupRows)) : 1;
                    const defaultVal = expr.args[2] ? evaluateScalar(expr.args[2], item.subject.context, item.subject.groupRows) : null;
                    const targetPos = position - offset;
                    if (targetPos >= 0 && targetPos < size) {
                        values[item.index] = evaluateScalar(expr.args[0], ordered[targetPos].subject.context, ordered[targetPos].subject.groupRows);
                    } else {
                        values[item.index] = defaultVal;
                    }
                    break;
                }
                case 'LEAD': {
                    const offset = expr.args[1] ? Number(evaluateScalar(expr.args[1], item.subject.context, item.subject.groupRows)) : 1;
                    const defaultVal = expr.args[2] ? evaluateScalar(expr.args[2], item.subject.context, item.subject.groupRows) : null;
                    const targetPos = position + offset;
                    if (targetPos >= 0 && targetPos < size) {
                        values[item.index] = evaluateScalar(expr.args[0], ordered[targetPos].subject.context, ordered[targetPos].subject.groupRows);
                    } else {
                        values[item.index] = defaultVal;
                    }
                    break;
                }
                case 'FIRST_VALUE':
                    values[item.index] = frame.length === 0 ? null : evaluateScalar(expr.args[0], frame[0].subject.context, frame[0].subject.groupRows);
                    break;
                case 'LAST_VALUE':
                    values[item.index] = frame.length === 0 ? null : evaluateScalar(expr.args[0], frame[frame.length - 1].subject.context, frame[frame.length - 1].subject.groupRows);
                    break;
            }
            previous = item;
        });
    }

    return values;
}

function sameWindowOrderValues(left, right, dialect = 'auto') {
    if (left.length !== right.length) return false;
    return left.every((value, index) => compareValues(value, right[index], dialect) === 0);
}

function orderWindowPartition(partition, orderBy) {
    return [...partition].sort((a, b) => {
        const dialect = a.subject.context?.dialect || 'auto';
        for (let i = 0; i < orderBy.length; i++) {
            const av = a.orderValues[i];
            const bv = b.orderValues[i];
            if (av == null && bv == null) continue;
            if (av == null || bv == null) {
                return nullsSortFirst(orderBy[i], dialect) === (av == null) ? -1 : 1;
            }
            const cmp = compareValues(av, bv, dialect);
            if (cmp !== 0) return orderBy[i].direction === 'DESC' ? -cmp : cmp;
        }
        return a.index - b.index;
    });
}

function windowFrameEntries(frame, ordered, position) {
    const size = ordered.length;
    const start = windowFrameBoundIndex(frame.start, position, size, true);
    const end = windowFrameBoundIndex(frame.end, position, size, false);
    if (start > end) return [];
    return ordered.slice(start, end + 1);
}

function windowFrameBoundIndex(bound, position, size, isStart) {
    let index;
    switch (bound.kind) {
        case 'UNBOUNDED_PRECEDING':
            index = 0;
            break;
        case 'UNBOUNDED_FOLLOWING':
            index = size - 1;
            break;
        case 'CURRENT_ROW':
            index = position;
            break;
        case 'PRECEDING':
            index = position - bound.offset;
            break;
        case 'FOLLOWING':
            index = position + bound.offset;
            break;
        default:
            index = position;
    }
    return isStart ? Math.max(0, Math.min(size, index)) : Math.max(-1, Math.min(size - 1, index));
}

function defaultOrderedAggregateEntries(ordered, position) {
    let end = position;
    while (end + 1 < ordered.length && sameWindowOrderValues(ordered[position].orderValues, ordered[end + 1].orderValues)) {
        end++;
    }
    return ordered.slice(0, end + 1);
}

function evaluateAggregateWindow(expr, subjects) {
    const values = Array(subjects.length).fill(null);
    const partitions = new Map();

    subjects.forEach((subject, index) => {
        const partitionKey = expr.partitionBy.length === 0 ? '__all__' : expr.partitionBy.map((part) => valueKey(evaluateScalar(part, subject.context, subject.groupRows))).join('\u0001');
        if (!partitions.has(partitionKey)) partitions.set(partitionKey, []);
        partitions.get(partitionKey).push({
            index,
            subject,
            orderValues: expr.orderBy.map((item) => evaluateScalar(item.expr, subject.context, subject.groupRows)),
        });
    });

    for (const partition of partitions.values()) {
        const ordered = orderWindowPartition(partition, expr.orderBy);
        ordered.forEach((item, position) => {
            let frameEntries = ordered;
            if (expr.frame) {
                frameEntries = windowFrameEntries(expr.frame, ordered, position);
            } else if (expr.orderBy.length > 0) {
                frameEntries = defaultOrderedAggregateEntries(ordered, position);
            }
            values[item.index] = evaluateAggregateForSubjects(expr, frameEntries.map((entry) => entry.subject));
        });
    }

    return values;
}

function expandSelectItems(selectItems, context) {
    const expanded = [];
    for (const item of selectItems) {
        if (item.kind === 'star') {
            if (!context) continue;
            for (const col of context.columns) {
                expanded.push({
                    kind: 'expr',
                    expr: { type: 'column', name: col.columnName, qualifier: col.alias },
                    alias: duplicateColumnLabel(context, col.columnName) ? `${col.alias}.${col.columnName}` : col.columnName,
                    raw: col.columnName,
                });
            }
            continue;
        }
        if (item.kind === 'tableStar') {
            if (!context) continue;
            const scope = context.scopes.get(item.qualifier.toLowerCase());
            if (!scope) throw new QueryError(`Unknown table or alias "${item.qualifier}" in SELECT list.`);
            for (const col of scope.table.columns) {
                expanded.push({
                    kind: 'expr',
                    expr: { type: 'column', name: col.name, qualifier: item.qualifier },
                    alias: col.name,
                    raw: `${item.qualifier}.${col.name}`,
                });
            }
            continue;
        }
        expanded.push(item);
    }
    return expanded;
}

function duplicateColumnLabel(context, columnName) {
    return context.columns.filter((col) => col.columnName.toLowerCase() === columnName.toLowerCase()).length > 1;
}

function itemLabel(item) {
    if (item.alias) return item.alias;
    if (item.expr?.type === 'column') return item.expr.name;
    return item.raw || 'expr';
}

function buildGroups(contexts, groupBy) {
    if (groupBy.length === 0) {
        return [{ key: '__all__', context: contexts[0] || getSampleContext(contexts) || createContext([]), rows: contexts }];
    }

    const groups = new Map();
    for (const context of contexts) {
        const values = groupBy.map((expr) => evaluateScalar(expr, context));
        const key = JSON.stringify(values);
        if (!groups.has(key)) groups.set(key, { key, context, rows: [] });
        groups.get(key).rows.push(context);
    }
    return Array.from(groups.values());
}

function withSample(contexts, sampleContext) {
    Object.defineProperty(contexts, 'sampleContext', {
        value: sampleContext,
        enumerable: false,
        configurable: true,
    });
    return contexts;
}

function getSampleContext(contexts) {
    return contexts?.sampleContext || contexts?.[0] || null;
}

function compareOrder(a, b, orderBy, columns) {
    const dialect = (a.orderContext.group?.context || a.orderContext.context)?.dialect || 'auto';
    for (const item of orderBy) {
        const av = evaluateOrderValue(item.expr, a.orderContext, columns);
        const bv = evaluateOrderValue(item.expr, b.orderContext, columns);
        if (av == null && bv == null) continue;
        if (av == null || bv == null) {
            return nullsSortFirst(item, dialect) === (av == null) ? -1 : 1;
        }
        const cmp = compareValues(av, bv, dialect);
        if (cmp !== 0) return item.direction === 'DESC' ? -cmp : cmp;
    }
    return a.index - b.index;
}

function nullsSortFirst(orderItem, dialect = 'auto') {
    if (orderItem.nulls === 'FIRST') return true;
    if (orderItem.nulls === 'LAST') return false;

    // SQLite, MySQL, and SQL Server treat NULL as lower than ordinary values
    // in their default ordering. PostgreSQL does the reverse. Keep the
    // legacy conservative `auto` behavior (NULLS LAST) for manually supplied
    // table maps where there is no trustworthy dialect signal.
    if (dialect === 'sqlite' || dialect === 'mysql' || dialect === 'mssql') {
        return orderItem.direction !== 'DESC';
    }
    if (dialect === 'postgres') return orderItem.direction === 'DESC';
    return false;
}

function evaluateOrderValue(expr, orderContext, columns) {
    if (expr.type === 'literal' && Number.isInteger(expr.value) && expr.value >= 1 && expr.value <= columns.length) {
        return orderContext.output[expr.value - 1];
    }
    if (expr.type === 'column' && !expr.qualifier) {
        const idx = columns.findIndex((col) => col.label.toLowerCase() === expr.name.toLowerCase());
        if (idx >= 0) return orderContext.output[idx];
    }
    if (orderContext.group) return evaluateScalar(expr, orderContext.group.context, orderContext.group.rows, orderContext.windowScope);
    return evaluateScalar(expr, orderContext.context, null, orderContext.windowScope);
}

function compareValues(a, b, dialect = 'auto') {
    if (a === b) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    if (dialect === 'sqlite') return compareSQLiteStorageValues(a, b);

    // Text stays text even when every character happens to be numeric. SQL
    // orders TEXT values lexically (`'10' < '2'`); coercing both strings with
    // Number() made range predicates, ORDER BY, MIN/MAX, and window peers
    // disagree with equality and with the source database. MySQL and SQL
    // Server commonly use case-insensitive default collations, matching the
    // equality contract used elsewhere in this executor.
    if (typeof a === 'string' && typeof b === 'string') {
        const caseInsensitive = dialect === 'mysql' || dialect === 'mssql';
        const left = caseInsensitive ? a.toLowerCase() : a;
        const right = caseInsensitive ? b.toLowerCase() : b;
        return compareBinaryText(left, right);
    }

    const an = Number(a);
    const bn = Number(b);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
    return compareBinaryText(String(a), String(b));
}

function roundHalfAwayFromZero(value, precision = 0) {
    if (!Number.isFinite(value) || !Number.isInteger(precision)) return null;
    const factor = 10 ** precision;
    if (!Number.isFinite(factor) || factor === 0) return null;
    const scaled = value * factor;
    if (!Number.isFinite(scaled)) return null;
    // Decimal SQL literals are exact, while JavaScript stores them as binary
    // floats (`1.005 * 100` becomes `100.49999999999999`). Correct only that
    // representation-sized drift before applying SQL's half-away-from-zero
    // rule; ordinary values remain on their original side of the boundary.
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
    const rounded = scaled >= 0
        ? Math.floor(scaled + 0.5 + tolerance)
        : Math.ceil(scaled - 0.5 - tolerance);
    return rounded / factor;
}

function compareSQLiteStorageValues(left, right) {
    const normalize = (value) => typeof value === 'boolean' ? Number(value) : value;
    const a = normalize(left);
    const b = normalize(right);
    if (a === b) return 0;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'string' && typeof b === 'string') return compareBinaryText(a, b);

    // SQLite sorts by storage class when no affinity conversion applies:
    // NULL < numeric < TEXT < BLOB. The in-memory model represents BLOB-like
    // values as objects, which intentionally sort after text here.
    const rank = (value) => {
        if (value == null) return 0;
        if (typeof value === 'number') return 1;
        if (typeof value === 'string') return 2;
        return 3;
    };
    return rank(a) - rank(b);
}

function compareBinaryText(left, right) {
    const leftChars = Array.from(left);
    const rightChars = Array.from(right);
    const length = Math.min(leftChars.length, rightChars.length);
    for (let index = 0; index < length; index++) {
        const diff = leftChars[index].codePointAt(0) - rightChars[index].codePointAt(0);
        if (diff !== 0) return diff;
    }
    return leftChars.length - rightChars.length;
}

function comparePredicateValues(left, right, op, options = {}) {
    const cmp = options.dialect === 'sqlite'
        ? compareSQLiteAffinityValues(left, right, options)
        : compareValues(left, right, options.dialect);
    if (op === '<') return cmp < 0;
    if (op === '<=') return cmp <= 0;
    if (op === '>') return cmp > 0;
    if (op === '>=') return cmp >= 0;
    return false;
}

function compareSQLiteAffinityValues(left, right, { leftAffinity = null, rightAffinity = null } = {}) {
    const mode = sqliteComparisonMode(leftAffinity, rightAffinity);
    if (mode === 'text') return compareBinaryText(String(left), String(right));
    if (mode === 'numeric') {
        const a = sqliteNumericValue(left);
        const b = sqliteNumericValue(right);
        if (a != null && b != null) return a - b;
    }
    return compareSQLiteStorageValues(left, right);
}

function parseSelectItem(tokens, tables) {
    const clean = trimTokens(tokens);
    if (clean.length === 0) throw new QueryError('Empty item in SELECT list.');

    if (clean.length === 1 && clean[0].type === 'OP' && clean[0].value === '*') {
        return { kind: 'star', raw: '*' };
    }
    if (clean.length === 3 && isIdentifierLike(clean[0]) && clean[1].type === 'PUNC' && clean[1].value === '.' && clean[2].type === 'OP' && clean[2].value === '*') {
        return { kind: 'tableStar', qualifier: clean[0].value, raw: `${clean[0].value}.*` };
    }

    const { exprTokens, alias } = splitAlias(clean);
    return {
        kind: 'expr',
        expr: parseScalarExpression(exprTokens, tables),
        alias,
        raw: tokensToSql(exprTokens),
    };
}

function parseOrderItem(tokens, tables) {
    const clean = trimTokens(tokens);
    let direction = 'ASC';
    let nulls = null;
    if (clean.length >= 2) {
        const last = clean[clean.length - 1];
        const prev = clean[clean.length - 2];
        if (isTokenWord(prev, 'NULLS') && (isTokenWord(last, 'FIRST') || isTokenWord(last, 'LAST'))) {
            nulls = String(last.value).toUpperCase();
            clean.splice(-2, 2);
        }
    }
    const last = clean[clean.length - 1];
    if (last?.type === 'KW' && ['ASC', 'DESC'].includes(last.value.toUpperCase())) {
        direction = last.value.toUpperCase();
        clean.pop();
    }
    return { expr: parseScalarExpression(clean, tables), direction, nulls };
}

function parseWindowSpecTokens(tokens, tables) {
    const clean = trimTokens(tokens);
    let idx = 0;
    let partitionBy = [];
    let orderBy = [];
    let frame = null;

    while (idx < clean.length) {
        if (isTokenWord(clean[idx], 'PARTITION')) {
            idx++;
            if (!isTokenWord(clean[idx], 'BY')) throw new QueryError('PARTITION must be followed by BY in OVER (...).');
            idx++;

            const { chunk, nextIdx } = readWindowSpecChunk(clean, idx, ['ORDER', 'ROWS', 'RANGE', 'GROUPS']);
            if (chunk.length === 0) throw new QueryError('PARTITION BY requires at least one expression.');
            partitionBy = splitTopLevel(chunk, ',').map((part) => parseScalarExpression(part, tables));
            idx = nextIdx;
            continue;
        }

        if (isTokenWord(clean[idx], 'ORDER')) {
            idx++;
            if (!isTokenWord(clean[idx], 'BY')) throw new QueryError('ORDER must be followed by BY in OVER (...).');
            idx++;

            const { chunk, nextIdx } = readWindowSpecChunk(clean, idx, ['ROWS', 'RANGE', 'GROUPS']);
            if (chunk.length === 0) throw new QueryError('ORDER BY requires at least one expression in OVER (...).');
            orderBy = splitTopLevel(chunk, ',').map((part) => parseOrderItem(part, tables));
            idx = nextIdx;
            continue;
        }

        if (isTokenWord(clean[idx], 'ROWS')) {
            if (frame) throw new QueryError('OVER (...) can only contain one window frame.');
            frame = parseRowsFrameTokens(clean.slice(idx + 1));
            idx = clean.length;
            continue;
        }

        if (isTokenWord(clean[idx], 'RANGE') || isTokenWord(clean[idx], 'GROUPS')) {
            throw new QueryError(`Window frame unit "${String(clean[idx].value).toUpperCase()}" is not supported yet. Use ROWS.`);
        }

        throw new QueryError(`Unexpected window token "${clean[idx]?.raw || clean[idx]?.value}".`);
    }

    return { partitionBy, orderBy, frame };
}

function parseRowsFrameTokens(tokens) {
    const clean = trimTokens(tokens);
    if (clean.length === 0) throw new QueryError('ROWS requires a frame boundary.');

    let idx = 0;
    let start;
    let end;

    if (isTokenWord(clean[idx], 'BETWEEN')) {
        const startResult = parseWindowFrameBound(clean, idx + 1);
        start = startResult.bound;
        idx = startResult.nextIdx;
        if (!isTokenWord(clean[idx], 'AND')) throw new QueryError('ROWS BETWEEN requires AND.');
        const endResult = parseWindowFrameBound(clean, idx + 1);
        end = endResult.bound;
        idx = endResult.nextIdx;
    } else {
        const startResult = parseWindowFrameBound(clean, idx);
        start = startResult.bound;
        end = { kind: 'CURRENT_ROW' };
        idx = startResult.nextIdx;
    }

    if (idx !== clean.length) {
        throw new QueryError(`Unexpected window frame token "${clean[idx]?.raw || clean[idx]?.value}".`);
    }

    validateWindowFrame(start, end);
    return { unit: 'ROWS', start, end };
}

function parseWindowFrameBound(tokens, startIdx) {
    let idx = startIdx;
    const token = tokens[idx];

    if (isTokenWord(token, 'UNBOUNDED')) {
        const direction = tokens[idx + 1];
        if (!isTokenWord(direction, 'PRECEDING') && !isTokenWord(direction, 'FOLLOWING')) {
            throw new QueryError('UNBOUNDED must be followed by PRECEDING or FOLLOWING.');
        }
        return {
            bound: { kind: isTokenWord(direction, 'PRECEDING') ? 'UNBOUNDED_PRECEDING' : 'UNBOUNDED_FOLLOWING' },
            nextIdx: idx + 2,
        };
    }

    if (isTokenWord(token, 'CURRENT')) {
        if (!isTokenWord(tokens[idx + 1], 'ROW')) throw new QueryError('CURRENT must be followed by ROW.');
        return { bound: { kind: 'CURRENT_ROW' }, nextIdx: idx + 2 };
    }

    if (token?.type === 'NUMBER') {
        const offset = Number(token.value);
        if (!Number.isInteger(offset) || offset < 0) throw new QueryError('Window frame offsets must be non-negative integers.');
        const direction = tokens[idx + 1];
        if (!isTokenWord(direction, 'PRECEDING') && !isTokenWord(direction, 'FOLLOWING')) {
            throw new QueryError('Window frame offsets must be followed by PRECEDING or FOLLOWING.');
        }
        return {
            bound: {
                kind: isTokenWord(direction, 'PRECEDING') ? 'PRECEDING' : 'FOLLOWING',
                offset,
            },
            nextIdx: idx + 2,
        };
    }

    throw new QueryError('Invalid ROWS frame boundary.');
}

function validateWindowFrame(start, end) {
    const positions = {
        UNBOUNDED_PRECEDING: Number.NEGATIVE_INFINITY,
        CURRENT_ROW: 0,
        UNBOUNDED_FOLLOWING: Number.POSITIVE_INFINITY,
    };
    const position = (bound) => {
        if (bound.kind === 'PRECEDING') return -bound.offset;
        if (bound.kind === 'FOLLOWING') return bound.offset;
        return positions[bound.kind];
    };

    if (start.kind === 'UNBOUNDED_FOLLOWING') {
        throw new QueryError('A window frame cannot start with UNBOUNDED FOLLOWING.');
    }
    if (end.kind === 'UNBOUNDED_PRECEDING') {
        throw new QueryError('A window frame cannot end with UNBOUNDED PRECEDING.');
    }
    if (position(start) > position(end)) {
        throw new QueryError('Window frame start must not be after its end.');
    }
}

function parseFunctionArguments(tokens, { allowOrderBy = false, tables = null } = {}) {
    let clean = trimTokens(tokens);
    let distinct = false;
    let orderBy = [];

    if (isTokenWord(clean[0], 'DISTINCT')) {
        distinct = true;
        clean = clean.slice(1);
    }

    const orderIdx = findTopLevelOrderBy(clean);
    let argTokens = clean;
    if (orderIdx >= 0) {
        if (!allowOrderBy) throw new QueryError('ORDER BY inside a function call is only supported for aggregate functions.');
        argTokens = trimTokens(clean.slice(0, orderIdx));
        const orderTokens = trimTokens(clean.slice(orderIdx + 2));
        if (orderTokens.length === 0) throw new QueryError('Aggregate ORDER BY requires at least one expression.');
        orderBy = splitTopLevel(orderTokens, ',').map((part) => parseOrderItem(part, tables));
    }

    const args = argTokens.length === 0 ? [] : splitTopLevel(argTokens, ',').map((part) => {
        const item = trimTokens(part);
        if (item.length === 0) throw new QueryError('Function argument is empty.');
        if (item.length === 1 && item[0].type === 'OP' && item[0].value === '*') return { type: 'star' };
        return parseScalarExpression(item, tables);
    });

    return { args, distinct, orderBy };
}

function parseTryCastExpression(tokens, tables = null) {
    const clean = trimTokens(tokens);
    const asIdx = findTopLevelWord(clean, 'AS');
    if (asIdx <= 0 || asIdx >= clean.length - 1) {
        throw new QueryError('TRY_CAST requires TRY_CAST(value AS type).');
    }

    const exprTokens = trimTokens(clean.slice(0, asIdx));
    const typeTokens = trimTokens(clean.slice(asIdx + 1));
    const targetType = tokensToSql(typeTokens).toUpperCase();
    if (!targetType) throw new QueryError('TRY_CAST requires a target type.');

    return {
        type: 'tryCast',
        expr: parseScalarExpression(exprTokens, tables),
        targetType,
    };
}

function parseConditionalFunction(tokens, name, tables) {
    const parts = splitTopLevel(tokens, ',');
    if (parts.length !== 3) throw new QueryError(`${name} requires exactly 3 arguments (condition, true_value, false_value).`);
    return {
        type: 'iif',
        condition: parseBooleanExpression(parts[0], tables),
        trueExpr: parseScalarExpression(parts[1], tables),
        falseExpr: parseScalarExpression(parts[2], tables),
    };
}

function parseExtractFunction(tokens, tables) {
    const fromIdx = findTopLevelWord(tokens, 'FROM');
    if (fromIdx < 0) {
        const { args } = parseFunctionArguments(tokens, { tables });
        return { type: 'function', name: 'EXTRACT', args };
    }

    const partTokens = trimTokens(tokens.slice(0, fromIdx));
    const valueTokens = trimTokens(tokens.slice(fromIdx + 1));
    if (partTokens.length !== 1 || !isIdentifierLike(partTokens[0]) || valueTokens.length === 0) {
        throw new QueryError('EXTRACT requires EXTRACT(part FROM value).');
    }
    return {
        type: 'function',
        name: 'EXTRACT',
        args: [
            { type: 'literal', value: String(partTokens[0].value) },
            parseScalarExpression(valueTokens, tables),
        ],
    };
}

function parsePositionFunction(tokens, tables) {
    const inIdx = findTopLevelWord(tokens, 'IN');
    if (inIdx < 0) {
        const { args } = parseFunctionArguments(tokens, { tables });
        return { type: 'function', name: 'POSITION', args };
    }

    const needleTokens = trimTokens(tokens.slice(0, inIdx));
    const haystackTokens = trimTokens(tokens.slice(inIdx + 1));
    if (needleTokens.length === 0 || haystackTokens.length === 0) {
        throw new QueryError('POSITION requires POSITION(substring IN string).');
    }
    return {
        type: 'function',
        name: 'POSITION',
        args: [
            parseScalarExpression(haystackTokens, tables),
            parseScalarExpression(needleTokens, tables),
        ],
    };
}

function parseDatePartFunction(tokens, name, tables) {
    const parts = splitTopLevel(tokens, ',');
    if (parts.length !== 3) throw new QueryError(`${name} requires exactly 3 arguments.`);
    const datePart = trimTokens(parts[0]);
    const firstArg = datePart.length === 1 && isIdentifierLike(datePart[0])
        ? { type: 'literal', value: String(datePart[0].value) }
        : parseScalarExpression(datePart, tables);
    return {
        type: 'function',
        name,
        args: [
            firstArg,
            parseScalarExpression(parts[1], tables),
            parseScalarExpression(parts[2], tables),
        ],
    };
}

function parseConvertFunction(tokens, name, tables) {
    const parts = splitTopLevel(tokens, ',');
    if (parts.length < 2 || parts.length > 3) {
        throw new QueryError(`${name} requires a type, value, and optional style argument.`);
    }
    if (parts.length === 3) {
        throw new QueryError(`${name} style arguments are not supported yet.`);
    }

    const targetType = tokensToSql(trimTokens(parts[0])).toUpperCase();
    if (isSqlTypeDeclaration(targetType)) {
        return {
            type: name === 'TRY_CONVERT' ? 'tryCast' : 'cast',
            expr: parseScalarExpression(parts[1], tables),
            targetType,
        };
    }

    const { args } = parseFunctionArguments(tokens, { tables });
    return { type: 'function', name, args };
}

function isSqlTypeDeclaration(value) {
    return /^(INT|INTEGER|BIGINT|SMALLINT|TINYINT|MEDIUMINT|FLOAT|DOUBLE|REAL|NUMERIC|DECIMAL|NUMBER|TEXT|VARCHAR|NVARCHAR|CHAR|NCHAR|STRING|CLOB|BOOL|BOOLEAN|DATE|DATETIME|DATETIME2|TIMESTAMP)\b/.test(value);
}

function parseGroupConcatArguments(tokens, tables) {
    const separatorIdx = findTopLevelWord(tokens, 'SEPARATOR');
    let separator = null;
    let aggregateTokens = tokens;

    if (separatorIdx >= 0) {
        const separatorTokens = trimTokens(tokens.slice(separatorIdx + 1));
        if (separatorTokens.length === 0) throw new QueryError('GROUP_CONCAT SEPARATOR requires a value.');
        separator = parseScalarExpression(separatorTokens, tables);
        aggregateTokens = trimTokens(tokens.slice(0, separatorIdx));
    }

    const parsed = parseFunctionArguments(aggregateTokens, { allowOrderBy: true, tables });
    if (separator) parsed.args.push(separator);
    return parsed;
}

function findTopLevelOrderBy(tokens) {
    const idx = findTopLevelWord(tokens, 'ORDER', 'BY');
    return idx;
}

function findTopLevelWord(tokens, word, nextWord = null) {
    let depth = 0;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.type === 'PUNC' && token.value === '(') depth++;
        if (token.type === 'PUNC' && token.value === ')') depth--;
        if (depth === 0 && isTokenWord(token, word) && (!nextWord || isTokenWord(tokens[i + 1], nextWord))) return i;
    }
    return -1;
}

function readWindowSpecChunk(tokens, startIdx, stopWords) {
    const stop = new Set(stopWords);
    const chunk = [];
    let idx = startIdx;
    let depth = 0;

    while (idx < tokens.length) {
        const token = tokens[idx];
        if (token.type === 'PUNC' && token.value === '(') depth++;
        if (token.type === 'PUNC' && token.value === ')') depth--;
        if (depth === 0 && stop.has(String(token.value).toUpperCase())) break;
        chunk.push(token);
        idx++;
    }

    return { chunk: trimTokens(chunk), nextIdx: idx };
}

function splitAlias(tokens) {
    let depth = 0;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.type === 'PUNC' && token.value === '(') depth++;
        if (token.type === 'PUNC' && token.value === ')') depth--;
        if (depth === 0 && token.type === 'KW' && token.value.toUpperCase() === 'AS') {
            const alias = tokens[i + 1];
            if (!isIdentifierLike(alias)) throw new QueryError('Expected alias after AS.');
            return { exprTokens: trimTokens(tokens.slice(0, i)), alias: String(alias.value) };
        }
    }

    const last = tokens[tokens.length - 1];
    const prev = tokens[tokens.length - 2];
    if (tokens.length > 1 && isIdentifierLike(last) && prev?.type !== 'OP' && !(prev?.type === 'PUNC' && prev.value === '.') && !isReservedAlias(last)) {
        const exprTokens = trimTokens(tokens.slice(0, -1));
        if (exprTokens.length > 0 && (exprTokens.length > 1 || exprTokens[0].type !== 'IDENT')) {
            return { exprTokens, alias: String(last.value) };
        }
    }

    return { exprTokens: tokens, alias: null };
}

function parseScalarExpression(tokens, tables = null) {
    const parser = new ExpressionParser(trimTokens(tokens), tables);
    const expr = parser.parseBoolean();
    if (!parser.eof()) throw new QueryError(`Unexpected expression token "${parser.peek()?.raw || parser.peek()?.value}".`);
    return expr;
}

function parseBooleanExpression(tokens, tables = null) {
    const parser = new ExpressionParser(trimTokens(tokens), tables);
    const expr = parser.parseBoolean();
    if (!parser.eof()) throw new QueryError(`Unexpected condition token "${parser.peek()?.raw || parser.peek()?.value}".`);
    return expr;
}

// Expression parser: a small Pratt-style parser for WHERE/HAVING/SELECT values.
// It intentionally accepts only the SQL surface Query View knows how to execute.
class ExpressionParser {
    constructor(tokens, tables = null) {
        this.tokens = tokens;
        this.tables = tables;
        this.idx = 0;
    }

    parseBoolean() {
        return this.parseOr();
    }

    parseOr() {
        let left = this.parseAnd();
        while (this.consumeKW('OR')) {
            left = { type: 'logical', op: 'OR', left, right: this.parseAnd() };
        }
        return left;
    }

    parseAnd() {
        let left = this.parseNot();
        while (this.consumeKW('AND')) {
            left = { type: 'logical', op: 'AND', left, right: this.parseNot() };
        }
        return left;
    }

    parseNot() {
        if (this.consumeKW('NOT')) {
            return { type: 'not', expr: this.parseNot() };
        }
        return this.parsePredicate();
    }

    parsePredicate() {
        if (this.consumeWord('EXISTS')) {
            return { type: 'predicate', op: 'EXISTS', subquery: { tokens: this.readParenthesizedTokens('EXISTS subquery'), tables: this.tables } };
        }

        const left = this.parseExpression();

        if (this.consumeKW('IS')) {
            const negated = this.consumeKW('NOT');
            if (this.consumeWord('DISTINCT')) {
                this.expectWord('FROM', 'IS DISTINCT must be followed by FROM.');
                return { type: 'predicate', op: negated ? 'IS NOT DISTINCT FROM' : 'IS DISTINCT FROM', left, right: this.parseExpression() };
            }
            if (this.consumeKW('NULL')) return { type: 'predicate', op: negated ? 'IS NOT NULL' : 'IS NULL', left };
            if (this.consumeKW('TRUE')) return { type: 'predicate', op: negated ? 'IS NOT TRUE' : 'IS TRUE', left };
            if (this.consumeKW('FALSE')) return { type: 'predicate', op: negated ? 'IS NOT FALSE' : 'IS FALSE', left };
            if (this.consumeKW('UNKNOWN')) return { type: 'predicate', op: negated ? 'IS NOT UNKNOWN' : 'IS UNKNOWN', left };
            return { type: 'predicate', op: negated ? 'IS NOT' : 'IS', left, right: this.parseExpression() };
        }

        const not = this.consumeKW('NOT');
        if (this.consumeKW('IN')) {
            const values = this.parseValueList();
            return { type: 'predicate', op: not ? 'NOT IN' : 'IN', left, values };
        }
        if (this.consumeKW('BETWEEN')) {
            const low = this.parseExpression();
            this.expectKW('AND', 'BETWEEN requires AND.');
            const high = this.parseExpression();
            return { type: 'predicate', op: not ? 'NOT BETWEEN' : 'BETWEEN', left, low, high };
        }
        if (this.consumeKW('LIKE')) {
            return { type: 'predicate', op: not ? 'NOT LIKE' : 'LIKE', left, right: this.parseExpression() };
        }
        if (this.consumeKW('ILIKE')) {
            return { type: 'predicate', op: not ? 'NOT ILIKE' : 'ILIKE', left, right: this.parseExpression() };
        }
        if (not) throw new QueryError('NOT must be followed by IN, BETWEEN, or LIKE.');

        const op = this.peek();
        if (op?.type === 'OP' && ['=', '!=', '<>', '<=>', '<', '<=', '>', '>='].includes(op.value)) {
            this.next();
            return { type: 'predicate', op: op.value, left, right: this.parseExpression() };
        }
        if (isUnsupportedPostgresOperatorToken(op)) {
            throw unsupportedPostgresOperatorError(op);
        }

        return left;
    }

    parseValueList() {
        if (!(this.peek()?.type === 'PUNC' && this.peek()?.value === '(')) throw new QueryError('IN requires a parenthesized value list.');
        if (isSelectStart(this.peek(1))) {
            return { type: 'subquery', tokens: this.readParenthesizedTokens('IN subquery'), tables: this.tables };
        }
        this.next();
        const values = [];
        let needsValue = true;
        while (!this.eof()) {
            if (this.peek()?.type === 'PUNC' && this.peek()?.value === ')') {
                if (values.length === 0) throw new QueryError('IN requires at least one value or a subquery.');
                if (needsValue) throw new QueryError('IN list cannot end with a comma.');
                this.next();
                return values;
            }
            if (!needsValue) {
                if (!(this.peek()?.type === 'PUNC' && this.peek()?.value === ',')) {
                    throw new QueryError('IN values must be separated by commas.');
                }
                this.next();
                needsValue = true;
                continue;
            }
            if (this.peek()?.type === 'PUNC' && this.peek()?.value === ',') {
                throw new QueryError('IN requires a value before a comma.');
            }
            values.push(this.parseExpression());
            needsValue = false;
        }
        throw new QueryError('IN list is missing a closing parenthesis.');
    }

    parseExpression() {
        return this.parseAdditive();
    }

    parseAdditive() {
        let left = this.parseMultiplicative();
        while (this.peek()?.type === 'OP' && ['+', '-', '||'].includes(this.peek().value)) {
            const op = this.next().value;
            left = { type: 'binary', op, left, right: this.parseMultiplicative() };
        }
        return left;
    }

    parseMultiplicative() {
        let left = this.parseUnary();
        while (this.peek()?.type === 'OP' && ['*', '/', '%'].includes(this.peek().value)) {
            const op = this.next().value;
            left = { type: 'binary', op, left, right: this.parseUnary() };
        }
        return left;
    }

    parseUnary() {
        if (this.peek()?.type === 'OP' && (this.peek()?.value === '-' || this.peek()?.value === '+')) {
            const op = this.next().value;
            return { type: 'unary', op, expr: this.parseUnary() };
        }
        return this.parsePrimary();
    }

    parsePrimary() {
        const token = this.peek();
        if (!token) throw new QueryError('Unexpected end of expression.');

        if (token.type === 'PUNC' && token.value === '(') {
            if (isSelectStart(this.peek(1))) {
                return { type: 'subquery', tokens: this.readParenthesizedTokens('scalar subquery'), tables: this.tables };
            }
            this.next();
            const expr = this.parseBoolean();
            if (!(this.peek()?.type === 'PUNC' && this.peek()?.value === ')')) throw new QueryError('Missing closing parenthesis.');
            this.next();
            return this.parsePostfix(expr);
        }

        if (token.type === 'STRING') {
            this.next();
            return { type: 'literal', value: token.value };
        }
        if (token.type === 'NUMBER') {
            this.next();
            return { type: 'literal', value: Number(token.value), numericLiteral: String(token.value) };
        }
        if (token.type === 'KW') {
            const kw = token.value.toUpperCase();
            if (kw === 'CASE') {
                return this.parseCase();
            }
            if (kw === 'CAST') {
                return this.parseCast();
            }
            if (kw === 'NULL') {
                this.next();
                return { type: 'literal', value: null };
            }
            if (kw === 'TRUE' || kw === 'FALSE') {
                this.next();
                return { type: 'literal', value: kw === 'TRUE' };
            }
            if ((kw === 'CURRENT_DATE' || kw === 'CURRENT_TIMESTAMP') && !(this.peek(1)?.type === 'PUNC' && this.peek(1).value === '(')) {
                this.next();
                return { type: 'function', name: kw, args: [] };
            }
        }

        if (isIdentifierLike(token)) {
            const name = String(this.next().value);
            if (this.peek()?.type === 'PUNC' && this.peek()?.value === '(') {
                return this.parsePostfix(this.parseFunction(name));
            }
            if (this.peek()?.type === 'PUNC' && this.peek()?.value === '.') {
                this.next();
                const col = this.next();
                if (!isIdentifierLike(col)) throw new QueryError(`Expected column after "${name}.". `);
                return this.parsePostfix({ type: 'column', qualifier: name, name: String(col.value) });
            }
            return this.parsePostfix({ type: 'column', qualifier: null, name });
        }

        throw new QueryError(`Unexpected expression token "${token.raw || token.value}".`);
    }

    // Handle postfix operators: :: (PG cast), -> / ->> (JSON access)
    parsePostfix(expr) {
        while (true) {
            const op = this.peek();
            if (op?.type === 'OP' && op.value === '::') {
                this.next();
                const typeTokens = [];
                while (!this.eof()) {
                    const t = this.peek();
                    if (!t) break;
                    if (isIdentifierLike(t) || t.type === 'NUMBER') { typeTokens.push(this.next()); continue; }
                    if (t.type === 'PUNC' && t.value === '(') {
                        typeTokens.push(this.next());
                        let d = 1;
                        while (!this.eof() && d > 0) {
                            const inner = this.next();
                            typeTokens.push(inner);
                            if (inner.type === 'PUNC' && inner.value === '(') d++;
                            if (inner.type === 'PUNC' && inner.value === ')') d--;
                        }
                        continue;
                    }
                    break;
                }
                const targetType = typeTokens.map((t) => String(t.value).toUpperCase()).join(' ');
                expr = { type: 'cast', expr, targetType };
                continue;
            }
            if (op?.type === 'OP' && (op.value === '->' || op.value === '->>')) {
                this.next();
                const key = this.parsePrimary();
                expr = { type: 'jsonAccess', op: op.value, left: expr, key };
                continue;
            }
            if (isUnsupportedPostgresOperatorToken(op)) {
                throw unsupportedPostgresOperatorError(op);
            }
            break;
        }
        return expr;
    }

    parseCase() {
        this.expectKW('CASE', 'CASE expression must start with CASE.');
        const base = this.isKW('WHEN') ? null : this.parseExpression();
        const branches = [];

        while (this.consumeKW('WHEN')) {
            const when = base ? this.parseExpression() : this.parseBoolean();
            this.expectKW('THEN', 'CASE WHEN requires THEN.');
            branches.push({ when, then: this.parseExpression() });
        }

        if (branches.length === 0) throw new QueryError('CASE expression requires at least one WHEN branch.');

        const elseExpr = this.consumeKW('ELSE') ? this.parseExpression() : { type: 'literal', value: null };
        this.expectKW('END', 'CASE expression requires END.');

        return { type: 'case', base, branches, elseExpr };
    }

    parseCast() {
        this.expectKW('CAST', 'CAST expression must start with CAST.');
        if (!(this.peek()?.type === 'PUNC' && this.peek()?.value === '(')) throw new QueryError('CAST requires parentheses.');
        this.next();
        const expr = this.parseBoolean();
        this.expectKW('AS', 'CAST requires AS.');
        const typeTokens = [];
        let depth = 0;
        while (!this.eof()) {
            const t = this.peek();
            if (t.type === 'PUNC' && t.value === '(') depth++;
            if (t.type === 'PUNC' && t.value === ')') { if (depth === 0) break; depth--; }
            typeTokens.push(this.next());
        }
        if (!(this.peek()?.type === 'PUNC' && this.peek()?.value === ')')) throw new QueryError('CAST is missing closing parenthesis.');
        this.next();
        const targetType = typeTokens.map((t) => String(t.value).toUpperCase()).join(' ');
        return { type: 'cast', expr, targetType };
    }

    parseFunction(name) {
        this.next();
        const callTokens = this.readFunctionCallTokens(name);
        const upper = name.toUpperCase();

        if (upper === 'IIF' || upper === 'IF') {
            return parseConditionalFunction(callTokens, upper, this.tables);
        }

        if (upper === 'TRY_CAST') {
            return parseTryCastExpression(callTokens, this.tables);
        }

        if (upper === 'EXTRACT') {
            return parseExtractFunction(callTokens, this.tables);
        }

        if (upper === 'POSITION') {
            return parsePositionFunction(callTokens, this.tables);
        }

        if (upper === 'DATEADD' || upper === 'DATEDIFF') {
            return parseDatePartFunction(callTokens, upper, this.tables);
        }

        if (upper === 'CONVERT' || upper === 'TRY_CONVERT') {
            return parseConvertFunction(callTokens, upper, this.tables);
        }

        if (WINDOW_FUNCTION_NAMES.has(upper)) {
            const noArgWindows = new Set(['ROW_NUMBER', 'RANK', 'DENSE_RANK']);
            const { args, distinct, orderBy } = parseFunctionArguments(callTokens, { allowOrderBy: false, tables: this.tables });
            if (distinct) throw new QueryError(`Window function "${upper}" does not support DISTINCT.`);
            if (noArgWindows.has(upper)) {
                if (args.length > 0) throw new QueryError(`Window function "${upper}" does not accept arguments.`);
            } else if (upper === 'NTILE') {
                if (args.length !== 1) throw new QueryError('Window function "NTILE" requires exactly 1 argument.');
            } else if (upper === 'LAG' || upper === 'LEAD') {
                if (args.length < 1 || args.length > 3) throw new QueryError(`Window function "${upper}" requires 1 to 3 arguments.`);
            } else if (upper === 'FIRST_VALUE' || upper === 'LAST_VALUE') {
                if (args.length !== 1) throw new QueryError(`Window function "${upper}" requires exactly 1 argument.`);
            }
            if (orderBy.length > 0) throw new QueryError(`Window function "${upper}" does not support ORDER BY inside the function call.`);
            if (!this.isWord('OVER')) throw new QueryError(`Window function "${upper}" requires OVER (...).`);
            return { type: 'window', name: upper, args, ...this.parseWindowSpec(upper) };
        }

        if (AGGREGATE_NAMES.has(upper)) {
            const { args, distinct, orderBy } = upper === 'GROUP_CONCAT'
                ? parseGroupConcatArguments(callTokens, this.tables)
                : parseFunctionArguments(callTokens, { allowOrderBy: true, tables: this.tables });
            if (upper === 'STRING_AGG') {
                if (args.length !== 2) throw new QueryError('Aggregate "STRING_AGG" requires a value and separator argument.');
            } else if (upper === 'GROUP_CONCAT') {
                if (args.length < 1 || args.length > 2) throw new QueryError('Aggregate "GROUP_CONCAT" requires one value argument and optional separator.');
            } else if (args.length !== 1) {
                throw new QueryError(`Aggregate "${upper}" requires exactly one argument.`);
            }
            if (distinct && args[0]?.type === 'star') throw new QueryError('COUNT(DISTINCT *) is not supported.');
            if (upper !== 'COUNT' && args[0]?.type === 'star') throw new QueryError(`Aggregate "${upper}" does not support "*".`);
            if (upper === 'ARRAY_AGG' && args[0]?.type === 'star') throw new QueryError('ARRAY_AGG requires a value expression.');
            const filter = this.parseAggregateFilter(upper);
            if (this.isWord('OVER')) {
                return {
                    type: 'windowAggregate',
                    name: upper,
                    args,
                    distinct,
                    aggregateOrderBy: orderBy,
                    filter,
                    ...this.parseWindowSpec(upper),
                };
            }
            return { type: 'aggregate', name: upper, args, distinct, orderBy, filter };
        }

        const { args, distinct, orderBy } = parseFunctionArguments(callTokens, { allowOrderBy: false, tables: this.tables });
        if (distinct) throw new QueryError(`DISTINCT is only supported inside aggregate functions.`);
        if (orderBy.length > 0) throw new QueryError(`ORDER BY inside function "${upper}" is only supported for aggregate functions.`);
        if (this.isWord('OVER')) throw new QueryError(`Function "${upper}" cannot use OVER (...).`);
        if (!SCALAR_FUNCTION_NAMES.has(upper)) throw new QueryError(`Function "${name}" is not supported yet.`);
        return { type: 'function', name: upper, args };
    }

    parseAggregateFilter(name) {
        if (!this.consumeWord('FILTER')) return null;
        if (!(this.peek()?.type === 'PUNC' && this.peek()?.value === '(')) throw new QueryError(`Aggregate "${name}" FILTER requires parentheses.`);
        this.next();
        this.expectWord('WHERE', `Aggregate "${name}" FILTER requires WHERE.`);

        const whereTokens = [];
        let depth = 1;
        while (!this.eof() && depth > 0) {
            const token = this.next();
            if (token.type === 'PUNC' && token.value === '(') {
                depth++;
                whereTokens.push(token);
                continue;
            }
            if (token.type === 'PUNC' && token.value === ')') {
                depth--;
                if (depth === 0) break;
                whereTokens.push(token);
                continue;
            }
            whereTokens.push(token);
        }

        if (depth !== 0) throw new QueryError(`Aggregate "${name}" FILTER is missing a closing parenthesis.`);
        return parseBooleanExpression(whereTokens, this.tables);
    }

    readFunctionCallTokens(name) {
        const tokens = [];
        let depth = 1;

        while (!this.eof() && depth > 0) {
            const token = this.next();
            if (token.type === 'PUNC' && token.value === '(') {
                depth++;
                tokens.push(token);
                continue;
            }
            if (token.type === 'PUNC' && token.value === ')') {
                depth--;
                if (depth === 0) break;
                tokens.push(token);
                continue;
            }
            tokens.push(token);
        }

        if (depth !== 0) throw new QueryError(`Function "${name}" is missing a closing parenthesis.`);
        return tokens;
    }

    parseWindowSpec(name) {
        this.expectWord('OVER', `Window function "${name}" requires OVER (...).`);
        if (!(this.peek()?.type === 'PUNC' && this.peek()?.value === '(')) throw new QueryError(`Window function "${name}" requires OVER (...).`);
        this.next();

        const specTokens = [];
        let depth = 1;
        while (!this.eof() && depth > 0) {
            const token = this.next();
            if (token.type === 'PUNC' && token.value === '(') {
                depth++;
                specTokens.push(token);
                continue;
            }
            if (token.type === 'PUNC' && token.value === ')') {
                depth--;
                if (depth === 0) break;
                specTokens.push(token);
                continue;
            }
            specTokens.push(token);
        }

        if (depth !== 0) throw new QueryError(`Window function "${name}" is missing a closing parenthesis.`);
        return parseWindowSpecTokens(specTokens, this.tables);
    }

    readParenthesizedTokens(label) {
        if (!(this.peek()?.type === 'PUNC' && this.peek()?.value === '(')) throw new QueryError(`${label} must start with "(".`);
        this.next();
        const out = [];
        let depth = 1;
        while (!this.eof() && depth > 0) {
            const token = this.next();
            if (token.type === 'PUNC' && token.value === '(') {
                depth++;
                out.push(token);
                continue;
            }
            if (token.type === 'PUNC' && token.value === ')') {
                depth--;
                if (depth === 0) break;
                out.push(token);
                continue;
            }
            out.push(token);
        }
        if (depth !== 0) throw new QueryError(`${label} is missing a closing parenthesis.`);
        return out;
    }

    expectKW(value, message) {
        if (!this.consumeKW(value)) throw new QueryError(message);
    }

    expectWord(value, message) {
        if (!this.consumeWord(value)) throw new QueryError(message);
    }

    consumeKW(value) {
        if (this.peek()?.type === 'KW' && this.peek().value.toUpperCase() === value) {
            this.next();
            return true;
        }
        return false;
    }

    consumeWord(value) {
        if (this.isWord(value)) {
            this.next();
            return true;
        }
        return false;
    }

    isKW(value) {
        return this.peek()?.type === 'KW' && this.peek().value.toUpperCase() === value;
    }

    isWord(value) {
        const token = this.peek();
        return isTokenWord(token, value);
    }

    peek(offset = 0) {
        return this.tokens[this.idx + offset] || null;
    }

    next() {
        return this.tokens[this.idx++] || null;
    }

    eof() {
        return this.idx >= this.tokens.length;
    }
}

function evaluateBoolean(expr, context, groupRows = null, windowScope = null) {
    if (!expr) return true;
    switch (expr.type) {
        case 'logical': {
            const left = evaluateBoolean(expr.left, context, groupRows, windowScope);
            if (expr.op === 'AND') {
                if (left === false) return false;
                const right = evaluateBoolean(expr.right, context, groupRows, windowScope);
                if (right === false) return false;
                return left == null || right == null ? null : true;
            }
            if (left === true) return true;
            const right = evaluateBoolean(expr.right, context, groupRows, windowScope);
            if (right === true) return true;
            return left == null || right == null ? null : false;
        }
        case 'not': {
            const value = evaluateBoolean(expr.expr, context, groupRows, windowScope);
            return value == null ? null : !truthy(value, context?.dialect);
        }
        case 'predicate':
            return evaluatePredicate(expr, context, groupRows, windowScope);
        default: {
            const value = evaluateScalar(expr, context, groupRows, windowScope);
            return value == null ? null : truthy(value, context?.dialect);
        }
    }
}

function evaluatePredicate(expr, context, groupRows, windowScope) {
    if (expr.op === 'EXISTS') {
        const result = executeQueryTokens(expr.subquery.tables, expr.subquery.tokens, context);
        if (result.errors.length > 0) throw new QueryError(result.errors[0].message);
        return result.rows.length > 0;
    }

    const left = evaluateScalar(expr.left, context, groupRows, windowScope);
    const leftNull = left === null || left === undefined;

    switch (expr.op) {
        case 'IS NULL':
            return leftNull;
        case 'IS NOT NULL':
            return !leftNull;
        case 'IS TRUE':
            return !leftNull && truthy(left, context?.dialect);
        case 'IS NOT TRUE':
            return leftNull || !truthy(left, context?.dialect);
        case 'IS FALSE':
            return !leftNull && !truthy(left, context?.dialect);
        case 'IS NOT FALSE':
            return leftNull || truthy(left, context?.dialect);
        case 'IS UNKNOWN':
            return leftNull;
        case 'IS NOT UNKNOWN':
            return !leftNull;
        case 'IS':
        case 'IS NOT':
        case 'IS DISTINCT FROM':
        case 'IS NOT DISTINCT FROM':
        case '<=>': {
            const right = evaluateScalar(expr.right, context, groupRows, windowScope);
            const rightNull = right === null || right === undefined;
            const same = leftNull || rightNull ? leftNull && rightNull : valuesEqual(left, right, comparisonOptions(expr.left, expr.right, context));
            if (expr.op === 'IS NOT' || expr.op === 'IS DISTINCT FROM') return !same;
            return same;
        }
        case 'IN':
        case 'NOT IN': {
            if (leftNull) return null;
            if (expr.values && expr.values.type === 'subquery') {
                const result = executeQueryTokens(expr.values.tables, expr.values.tokens, context);
                if (result.errors.length > 0) throw new QueryError(result.errors[0].message);
                if (result.columns.length !== 1) {
                    throw new QueryError(`IN subquery must return exactly one column, but returned ${result.columns.length}.`);
                }
                const vals = result.rows.map((r) => r[0]);
                const found = vals.some((value) => value != null && valuesEqual(value, left, comparisonOptions(expr.left, null, context)));
                if (found) return expr.op === 'IN';
                if (vals.some((value) => value == null)) return null;
                return expr.op === 'NOT IN';
            }
            let hasNull = false;
            for (const valueExpr of expr.values) {
                const value = evaluateScalar(valueExpr, context, groupRows, windowScope);
                if (value == null) hasNull = true;
                if (value != null && valuesEqual(value, left, comparisonOptions(expr.left, valueExpr, context))) return expr.op === 'IN';
            }
            if (hasNull) return null;
            return expr.op === 'NOT IN';
        }
        case 'BETWEEN':
        case 'NOT BETWEEN': {
            const low = evaluateScalar(expr.low, context, groupRows, windowScope);
            const high = evaluateScalar(expr.high, context, groupRows, windowScope);
            if (leftNull || low == null || high == null) return null;
            const inRange = comparePredicateValues(left, low, '>=', comparisonOptions(expr.left, expr.low, context))
                && comparePredicateValues(left, high, '<=', comparisonOptions(expr.left, expr.high, context));
            return expr.op === 'BETWEEN' ? inRange : !inRange;
        }
        case 'LIKE':
        case 'NOT LIKE': {
            const right = evaluateScalar(expr.right, context, groupRows, windowScope);
            if (leftNull || right == null) return null;
            if (typeof right !== 'string') return false;
            // Default collations in SQLite, MySQL, and SQL Server commonly
            // make LIKE case-insensitive. PostgreSQL/neutral LIKE remains
            // case-sensitive; ILIKE below is explicitly insensitive.
            const caseInsensitive = ['sqlite', 'mysql', 'mssql'].includes(context?.dialect);
            const matched = likeRegex(right, caseInsensitive).test(String(left));
            return expr.op === 'LIKE' ? matched : !matched;
        }
        case 'ILIKE':
        case 'NOT ILIKE': {
            const right = evaluateScalar(expr.right, context, groupRows, windowScope);
            if (leftNull || right == null) return null;
            if (typeof right !== 'string') return false;
            const matched = likeRegex(right, true).test(String(left));
            return expr.op === 'ILIKE' ? matched : !matched;
        }
        default: {
            const right = evaluateScalar(expr.right, context, groupRows, windowScope);
            if (leftNull || right == null) return null;
            if (expr.op === '=' || expr.op === '!=') {
                const matched = valuesEqual(left, right, comparisonOptions(expr.left, expr.right, context));
                return expr.op === '=' ? matched : !matched;
            }
            if (expr.op === '<>') return !valuesEqual(left, right, comparisonOptions(expr.left, expr.right, context));
            return comparePredicateValues(left, right, expr.op, comparisonOptions(expr.left, expr.right, context));
        }
    }
}

function evaluateScalar(expr, context, groupRows = null, windowScope = null) {
    switch (expr.type) {
        case 'literal':
            return scalarizeDialectValue(expr.value, context);
        case 'column':
            return resolveColumn(context, expr);
        case 'binary': {
            const left = evaluateScalar(expr.left, context, groupRows, windowScope);
            const right = evaluateScalar(expr.right, context, groupRows, windowScope);
            if (left == null || right == null) return null;
            if (expr.op === '||') return `${String(left)}${String(right)}`;
            if (expr.op === '+') return numericOrConcat(left, right);
            const ln = Number(left);
            const rn = Number(right);
            if (Number.isNaN(ln) || Number.isNaN(rn)) return null;
            if (expr.op === '-') return ln - rn;
            if (expr.op === '*') return ln * rn;
            if (expr.op === '/') {
                if (rn === 0) return null;
                if (context?.dialect === 'sqlite' && isSQLiteIntegerOperand(expr.left, left, context) && isSQLiteIntegerOperand(expr.right, right, context)) return Math.trunc(ln / rn);
                return ln / rn;
            }
            if (expr.op === '%') {
                if (rn === 0) return null;
                if (context?.dialect === 'sqlite') {
                    const divisor = Math.trunc(rn);
                    return divisor === 0 ? null : Math.trunc(ln) % divisor;
                }
                return ln % rn;
            }
            return null;
        }
        case 'jsonAccess': {
            const left = evaluateScalar(expr.left, context, groupRows, windowScope);
            const key = evaluateScalar(expr.key, context, groupRows, windowScope);
            if (left == null) return null;
            const obj = typeof left === 'string' ? safeJsonParse(left) : left;
            if (obj == null || typeof obj !== 'object') return null;
            const val = Array.isArray(obj) ? obj[Number(key)] : obj[String(key)];
            if (val === undefined) return null;
            if (expr.op === '->>') {
                if (val == null) return null;
                if (typeof val === 'object') return JSON.stringify(val);
                // SQLite's JSON1 ->> operator returns SQL INTEGER/REAL/TEXT
                // scalars, while PostgreSQL/MySQL return unquoted text.
                return context?.dialect === 'sqlite' ? scalarizeDialectValue(val, context) : String(val);
            }
            return val;
        }
        case 'unary': {
            const value = evaluateScalar(expr.expr, context, groupRows, windowScope);
            if (value == null) return null;
            const num = Number(value);
            if (Number.isNaN(num)) return null;
            return expr.op === '-' ? -num : num;
        }
        case 'cast':
            return evaluateCast(expr, context, groupRows, windowScope);
        case 'tryCast':
            return evaluateCast(expr, context, groupRows, windowScope);
        case 'iif':
            return truthy(evaluateBoolean(expr.condition, context, groupRows, windowScope), context?.dialect)
                ? evaluateScalar(expr.trueExpr, context, groupRows, windowScope)
                : evaluateScalar(expr.falseExpr, context, groupRows, windowScope);
        case 'case':
            return evaluateCase(expr, context, groupRows, windowScope);
        case 'function':
            return evaluateFunction(expr, context, groupRows, windowScope);
        case 'window':
            return evaluateWindowValue(expr, windowScope);
        case 'windowAggregate':
            return evaluateWindowValue(expr, windowScope);
        case 'subquery':
            return evaluateSubquery(expr, context);
        case 'aggregate':
            return evaluateAggregate(expr, groupRows || [context]);
        default:
            return scalarizeDialectValue(evaluateBoolean(expr, context, groupRows, windowScope), context);
    }
}

function scalarizeDialectValue(value, context) {
    if (context?.dialect === 'sqlite' && typeof value === 'boolean') return value ? 1 : 0;
    return value;
}

function isSQLiteIntegerOperand(expr, value, context) {
    if (!Number.isInteger(value)) return false;
    if (expr?.type === 'literal' && Object.hasOwn(expr, 'numericLiteral')) {
        return /^[+-]?\d+$/.test(expr.numericLiteral);
    }
    if (expr?.type === 'column') {
        const type = resolveColumnMetadata(context, expr)?.type || '';
        return /INT/i.test(type);
    }
    if (expr?.type === 'cast' || expr?.type === 'tryCast') return /INT/i.test(expr.targetType || '');
    return true;
}

function evaluateCast(expr, context, groupRows, windowScope) {
    const value = evaluateScalar(expr.expr, context, groupRows, windowScope);
    if (value === null || value === undefined) return null;
    const t = expr.targetType;
    const sqlite = context?.dialect === 'sqlite';
    if (/^(INT|INTEGER|BIGINT|SMALLINT|TINYINT|MEDIUMINT)/.test(t)) {
        if (sqlite) return sqliteIntegerCast(value);
        const n = Number(value);
        return Number.isNaN(n) ? null : Math.trunc(n);
    }
    if (/^(FLOAT|DOUBLE|REAL|NUMERIC|DECIMAL|NUMBER)/.test(t)) {
        if (sqlite) return sqliteRealCast(value);
        const n = Number(value);
        return Number.isNaN(n) ? null : n;
    }
    if (/^(TEXT|VARCHAR|NVARCHAR|CHAR|NCHAR|STRING|CLOB)/.test(t)) return String(value);
    if (/^(BOOL|BOOLEAN)/.test(t)) return truthy(value, context?.dialect);
    return value;
}

function sqliteIntegerCast(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
    if (typeof value === 'boolean') return Number(value);
    const match = String(value).trim().match(/^[+-]?\d+/);
    return match ? Number(match[0]) : 0;
}

function sqliteRealCast(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'boolean') return Number(value);
    const match = String(value).trim().match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    return match ? Number(match[0]) : 0;
}

function evaluateWindowValue(expr, windowScope) {
    const values = windowScope?.values?.get(expr);
    if (!values) throw new QueryError(`Window function "${expr.name}" can only be used in SELECT or ORDER BY.`);
    return values[windowScope.index];
}

function evaluateSubquery(expr, context) {
    const result = executeQueryTokens(expr.tables, expr.tokens, context);
    if (result.errors.length > 0) throw new QueryError(result.errors[0].message);
    if (result.columns.length !== 1) {
        throw new QueryError(`Scalar subquery must return exactly one column, but returned ${result.columns.length}.`);
    }
    if (result.rows.length > 1) {
        throw new QueryError(`Scalar subquery returned ${result.rows.length} rows; expected at most one.`);
    }
    if (result.rows.length === 0) return null;
    return result.rows[0]?.[0] ?? null;
}

function evaluateCase(expr, context, groupRows, windowScope) {
    if (expr.base) {
        const baseValue = evaluateScalar(expr.base, context, groupRows, windowScope);
        for (const branch of expr.branches) {
            if (valuesEqual(baseValue, evaluateScalar(branch.when, context, groupRows, windowScope), comparisonOptions(expr.base, branch.when, context))) {
                return evaluateScalar(branch.then, context, groupRows, windowScope);
            }
        }
        return evaluateScalar(expr.elseExpr, context, groupRows, windowScope);
    }

    for (const branch of expr.branches) {
        if (truthy(evaluateBoolean(branch.when, context, groupRows, windowScope), context?.dialect)) {
            return evaluateScalar(branch.then, context, groupRows, windowScope);
        }
    }
    return evaluateScalar(expr.elseExpr, context, groupRows, windowScope);
}

function evaluateFunction(expr, context, groupRows, windowScope) {
    switch (expr.name) {
        case 'COALESCE': {
            requireArgRange(expr, 1);
            for (const arg of expr.args) {
                const value = evaluateScalar(arg, context, groupRows, windowScope);
                if (value !== null && value !== undefined) return value;
            }
            return null;
        }
        case 'IFNULL': {
            requireArgRange(expr, 2, 2);
            const first = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            return first !== null && first !== undefined ? first : evaluateScalar(expr.args[1], context, groupRows, windowScope);
        }
        case 'ISNULL':
        case 'NVL': {
            requireArgRange(expr, 2, 2);
            const first = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            return first !== null && first !== undefined ? first : evaluateScalar(expr.args[1], context, groupRows, windowScope);
        }
        case 'NULLIF': {
            requireArgRange(expr, 2, 2);
            const first = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            const second = evaluateScalar(expr.args[1], context, groupRows, windowScope);
            return valuesEqual(first, second, comparisonOptions(expr.args[0], expr.args[1], context)) ? null : first;
        }
        case 'LOWER': {
            requireArgRange(expr, 1, 1);
            const value = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            return value == null ? null : String(value).toLowerCase();
        }
        case 'UPPER': {
            requireArgRange(expr, 1, 1);
            const value = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            return value == null ? null : String(value).toUpperCase();
        }
        case 'LENGTH': {
            requireArgRange(expr, 1, 1);
            const value = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            return value == null ? null : String(value).length;
        }
        case 'ABS': {
            requireArgRange(expr, 1, 1);
            const raw = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (raw == null) return null;
            const value = Number(raw);
            return Number.isNaN(value) ? null : Math.abs(value);
        }
        case 'ROUND': {
            requireArgRange(expr, 1, 2);
            const raw = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (raw == null) return null;
            const value = Number(raw);
            if (Number.isNaN(value)) return null;
            const precision = expr.args[1] ? Number(evaluateScalar(expr.args[1], context, groupRows, windowScope)) : 0;
            return roundHalfAwayFromZero(value, precision);
        }
        case 'CONCAT': {
            requireArgRange(expr, 1);
            return expr.args.map((arg) => {
                const value = evaluateScalar(arg, context, groupRows, windowScope);
                return value == null ? '' : String(value);
            }).join('');
        }
        case 'CEIL':
        case 'CEILING': {
            requireArgRange(expr, 1, 1);
            const raw = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (raw == null) return null;
            const v = Number(raw); return Number.isNaN(v) ? null : Math.ceil(v);
        }
        case 'FLOOR': {
            requireArgRange(expr, 1, 1);
            const raw = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (raw == null) return null;
            const v = Number(raw); return Number.isNaN(v) ? null : Math.floor(v);
        }
        case 'SIGN': {
            requireArgRange(expr, 1, 1);
            const raw = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (raw == null) return null;
            const v = Number(raw); return Number.isNaN(v) ? null : Math.sign(v);
        }
        case 'POWER':
        case 'POW': {
            requireArgRange(expr, 2, 2);
            const base = Number(evaluateScalar(expr.args[0], context, groupRows, windowScope));
            const exp = Number(evaluateScalar(expr.args[1], context, groupRows, windowScope));
            return (Number.isNaN(base) || Number.isNaN(exp)) ? null : Math.pow(base, exp);
        }
        case 'SQRT': {
            requireArgRange(expr, 1, 1);
            const raw = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (raw == null) return null;
            const v = Number(raw); return (Number.isNaN(v) || v < 0) ? null : Math.sqrt(v);
        }
        case 'MOD': {
            requireArgRange(expr, 2, 2);
            const a = Number(evaluateScalar(expr.args[0], context, groupRows, windowScope));
            const b = Number(evaluateScalar(expr.args[1], context, groupRows, windowScope));
            return (Number.isNaN(a) || Number.isNaN(b) || b === 0) ? null : a % b;
        }
        case 'CHAR_LENGTH':
        case 'CHARACTER_LENGTH': {
            requireArgRange(expr, 1, 1);
            const value = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            return value == null ? null : String(value).length;
        }
        case 'TRIM': {
            requireArgRange(expr, 1, 1);
            const value = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            return value == null ? null : String(value).trim();
        }
        case 'LTRIM': {
            requireArgRange(expr, 1, 2);
            const value = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (value == null) return null;
            if (expr.args[1]) { const chars = String(evaluateScalar(expr.args[1], context, groupRows, windowScope)); let s = String(value); while (s.length > 0 && chars.includes(s[0])) s = s.slice(1); return s; }
            return String(value).trimStart();
        }
        case 'RTRIM': {
            requireArgRange(expr, 1, 2);
            const value = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (value == null) return null;
            if (expr.args[1]) { const chars = String(evaluateScalar(expr.args[1], context, groupRows, windowScope)); let s = String(value); while (s.length > 0 && chars.includes(s[s.length - 1])) s = s.slice(0, -1); return s; }
            return String(value).trimEnd();
        }
        case 'SUBSTR':
        case 'SUBSTRING': {
            requireArgRange(expr, 2, 3);
            const value = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (value == null) return null;
            const str = String(value);
            const sqlStart = Number(evaluateScalar(expr.args[1], context, groupRows, windowScope));
            if (!Number.isFinite(sqlStart)) return null;
            const start = sqlStart > 0 ? sqlStart - 1 : sqlStart < 0 ? str.length + sqlStart : 0;
            if (expr.args[2]) {
                const len = Number(evaluateScalar(expr.args[2], context, groupRows, windowScope));
                if (!Number.isFinite(len)) return null;
                return len < 0 ? str.slice(Math.max(0, start + len), Math.max(0, start)) : str.substr(Math.max(0, start), len);
            }
            return str.substr(Math.max(0, start));
        }
        case 'REPLACE': {
            requireArgRange(expr, 3, 3);
            const value = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (value == null) return null;
            const search = String(evaluateScalar(expr.args[1], context, groupRows, windowScope));
            const replacement = String(evaluateScalar(expr.args[2], context, groupRows, windowScope) ?? '');
            return String(value).split(search).join(replacement);
        }
        case 'REVERSE': {
            requireArgRange(expr, 1, 1);
            const value = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            return value == null ? null : String(value).split('').reverse().join('');
        }
        case 'LPAD': {
            requireArgRange(expr, 2, 3);
            const value = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (value == null) return null;
            const len = Number(evaluateScalar(expr.args[1], context, groupRows, windowScope));
            const pad = expr.args[2] ? String(evaluateScalar(expr.args[2], context, groupRows, windowScope)) : ' ';
            return String(value).padStart(len, pad);
        }
        case 'RPAD': {
            requireArgRange(expr, 2, 3);
            const value = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (value == null) return null;
            const len = Number(evaluateScalar(expr.args[1], context, groupRows, windowScope));
            const pad = expr.args[2] ? String(evaluateScalar(expr.args[2], context, groupRows, windowScope)) : ' ';
            return String(value).padEnd(len, pad);
        }
        case 'REPEAT': {
            requireArgRange(expr, 2, 2);
            const value = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (value == null) return null;
            const count = Number(evaluateScalar(expr.args[1], context, groupRows, windowScope));
            return count >= 0 ? String(value).repeat(count) : null;
        }
        case 'INSTR':
        case 'POSITION':
        case 'STRPOS': {
            requireArgRange(expr, 2, 2);
            const haystack = String(evaluateScalar(expr.args[0], context, groupRows, windowScope) ?? '');
            const needle = String(evaluateScalar(expr.args[1], context, groupRows, windowScope) ?? '');
            if (expr.name === 'STRPOS') return haystack.indexOf(needle) + 1;
            if (expr.name === 'INSTR') return haystack.indexOf(needle) + 1;
            return haystack.indexOf(needle) + 1;
        }
        case 'CHARINDEX': {
            requireArgRange(expr, 2, 2);
            const needle = String(evaluateScalar(expr.args[0], context, groupRows, windowScope) ?? '');
            const haystack = String(evaluateScalar(expr.args[1], context, groupRows, windowScope) ?? '');
            return haystack.indexOf(needle) + 1;
        }
        case 'LEN': {
            requireArgRange(expr, 1, 1);
            const value = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            return value == null ? null : String(value).trimEnd().length;
        }
        case 'INITCAP': {
            requireArgRange(expr, 1, 1);
            const value = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (value == null) return null;
            return String(value).replace(/\b\w/g, (c) => c.toUpperCase());
        }
        case 'TRANSLATE': {
            requireArgRange(expr, 3, 3);
            const value = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (value == null) return null;
            const from = String(evaluateScalar(expr.args[1], context, groupRows, windowScope));
            const to = String(evaluateScalar(expr.args[2], context, groupRows, windowScope));
            let result = String(value);
            for (let i = 0; i < from.length; i++) {
                result = result.split(from[i]).join(i < to.length ? to[i] : '');
            }
            return result;
        }
        case 'GREATEST': {
            requireArgRange(expr, 1);
            let best = null;
            for (const arg of expr.args) { const v = evaluateScalar(arg, context, groupRows, windowScope); if (v != null && (best == null || compareValues(v, best, context?.dialect) > 0)) best = v; }
            return best;
        }
        case 'LEAST': {
            requireArgRange(expr, 1);
            let best = null;
            for (const arg of expr.args) { const v = evaluateScalar(arg, context, groupRows, windowScope); if (v != null && (best == null || compareValues(v, best, context?.dialect) < 0)) best = v; }
            return best;
        }
        case 'TYPEOF': {
            requireArgRange(expr, 1, 1);
            const value = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (value === null || value === undefined) return 'null';
            if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'real';
            if (typeof value === 'boolean') return 'integer';
            return 'text';
        }
        case 'JSON_BUILD_OBJECT':
        case 'JSONB_BUILD_OBJECT':
        case 'JSON_OBJECT':
            return evaluateJsonObject(expr, context, groupRows, windowScope);
        case 'CONCAT_WS': {
            requireArgRange(expr, 2);
            const sep = String(evaluateScalar(expr.args[0], context, groupRows, windowScope) ?? '');
            return expr.args.slice(1).map((arg) => {
                const v = evaluateScalar(arg, context, groupRows, windowScope);
                return v == null ? null : String(v);
            }).filter((v) => v !== null).join(sep);
        }
        case 'LEFT': {
            requireArgRange(expr, 2, 2);
            const value = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (value == null) return null;
            const n = Number(evaluateScalar(expr.args[1], context, groupRows, windowScope));
            return String(value).substring(0, Math.max(0, n));
        }
        case 'RIGHT': {
            requireArgRange(expr, 2, 2);
            const value = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (value == null) return null;
            const n = Number(evaluateScalar(expr.args[1], context, groupRows, windowScope));
            const s = String(value);
            return n >= s.length ? s : s.substring(s.length - Math.max(0, n));
        }
        case 'CONVERT':
        case 'TRY_CONVERT': {
            requireArgRange(expr, 2, 2);
            // CONVERT(type, value) or CONVERT(value, type) — we support both orderings
            const a0 = expr.args[0];
            const a1 = expr.args[1];
            // If first arg is a type-like literal or column, try heuristic
            let targetType, sourceExpr;
            if (a0.type === 'column' && /^(INT|INTEGER|VARCHAR|TEXT|FLOAT|NUMERIC|DECIMAL|BOOLEAN|DATE|REAL|BIGINT|CHAR|NVARCHAR)$/i.test(a0.name)) {
                targetType = a0.name.toUpperCase();
                sourceExpr = a1;
            } else {
                sourceExpr = a0;
                targetType = a1.type === 'column' ? a1.name.toUpperCase() : String(evaluateScalar(a1, context, groupRows, windowScope)).toUpperCase();
            }
            const castExpr = { type: 'cast', expr: sourceExpr, targetType };
            try { return evaluateCast(castExpr, context, groupRows, windowScope); }
            catch (e) { return expr.name === 'TRY_CONVERT' ? null : (() => { throw e; })(); }
        }
        case 'JSON_EXTRACT':
        case 'JSON_EXTRACT_PATH_TEXT': {
            requireArgRange(expr, 2);
            const source = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (source == null) return null;
            const obj = typeof source === 'string' ? safeJsonParse(source) : source;
            if (obj == null) return null;
            // Support json path like '$.name' or just 'name'
            for (let i = 1; i < expr.args.length; i++) {
                const path = String(evaluateScalar(expr.args[i], context, groupRows, windowScope));
                return jsonExtractPath(obj, path, expr.name === 'JSON_EXTRACT_PATH_TEXT');
            }
            return null;
        }
        case 'JSON_VALUE': {
            requireArgRange(expr, 2, 2);
            const source = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (source == null) return null;
            const obj = typeof source === 'string' ? safeJsonParse(source) : source;
            if (obj == null) return null;
            const path = String(evaluateScalar(expr.args[1], context, groupRows, windowScope));
            const val = jsonExtractPath(obj, path, true);
            return val;
        }
        case 'JSON_UNQUOTE': {
            requireArgRange(expr, 1, 1);
            const v = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (v == null) return null;
            const s = String(v);
            if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
            return s;
        }
        case 'NOW':
        case 'CURRENT_TIMESTAMP': {
            return new Date().toISOString();
        }
        case 'CURRENT_DATE':
            return new Date().toISOString().substring(0, 10);
        case 'DATE':
        case 'DATETIME': {
            requireArgRange(expr, 1);
            const v = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (v == null) return null;
            const d = new Date(v);
            if (isNaN(d.getTime())) return null;
            for (const modifierExpr of expr.args.slice(1)) {
                const modifier = evaluateScalar(modifierExpr, context, groupRows, windowScope);
                if (modifier == null || !applyDateModifier(d, String(modifier))) return null;
            }
            const iso = d.toISOString();
            return expr.name === 'DATE' ? iso.substring(0, 10) : iso.substring(0, 19).replace('T', ' ');
        }
        case 'YEAR': {
            requireArgRange(expr, 1, 1);
            const v = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (v == null) return null;
            const d = new Date(v);
            return isNaN(d.getTime()) ? null : d.getUTCFullYear();
        }
        case 'MONTH': {
            requireArgRange(expr, 1, 1);
            const v = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (v == null) return null;
            const d = new Date(v);
            return isNaN(d.getTime()) ? null : d.getUTCMonth() + 1;
        }
        case 'DAY': {
            requireArgRange(expr, 1, 1);
            const v = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (v == null) return null;
            const d = new Date(v);
            return isNaN(d.getTime()) ? null : d.getUTCDate();
        }
        case 'HOUR': {
            requireArgRange(expr, 1, 1);
            const v = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (v == null) return null;
            const d = new Date(v);
            return isNaN(d.getTime()) ? null : d.getUTCHours();
        }
        case 'MINUTE': {
            requireArgRange(expr, 1, 1);
            const v = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (v == null) return null;
            const d = new Date(v);
            return isNaN(d.getTime()) ? null : d.getUTCMinutes();
        }
        case 'SECOND': {
            requireArgRange(expr, 1, 1);
            const v = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            if (v == null) return null;
            const d = new Date(v);
            return isNaN(d.getTime()) ? null : d.getUTCSeconds();
        }
        case 'DATE_PART':
        case 'EXTRACT': {
            requireArgRange(expr, 2, 2);
            const part = String(evaluateScalar(expr.args[0], context, groupRows, windowScope)).toUpperCase();
            const v = evaluateScalar(expr.args[1], context, groupRows, windowScope);
            if (v == null) return null;
            const d = new Date(v);
            if (isNaN(d.getTime())) return null;
            switch (part) {
                case 'YEAR': return d.getUTCFullYear();
                case 'MONTH': return d.getUTCMonth() + 1;
                case 'DAY': return d.getUTCDate();
                case 'HOUR': return d.getUTCHours();
                case 'MINUTE': return d.getUTCMinutes();
                case 'SECOND': return d.getUTCSeconds();
                case 'DOW': return d.getUTCDay();
                case 'DOY': { const start = Date.UTC(d.getUTCFullYear(), 0, 0); return Math.floor((d.getTime() - start) / 86400000); }
                case 'EPOCH': return Math.floor(d.getTime() / 1000);
                case 'QUARTER': return Math.ceil((d.getUTCMonth() + 1) / 3);
                default: return null;
            }
        }
        case 'STRFTIME': {
            requireArgRange(expr, 2, 2);
            const fmt = String(evaluateScalar(expr.args[0], context, groupRows, windowScope));
            const v = evaluateScalar(expr.args[1], context, groupRows, windowScope);
            if (v == null) return null;
            const d = new Date(v);
            if (isNaN(d.getTime())) return null;
            return formatDate(d, fmt);
        }
        case 'DATE_FORMAT':
        case 'FORMAT': {
            requireArgRange(expr, 2, 2);
            const v = evaluateScalar(expr.args[0], context, groupRows, windowScope);
            const fmt = String(evaluateScalar(expr.args[1], context, groupRows, windowScope));
            if (v == null) return null;
            const d = new Date(v);
            if (isNaN(d.getTime())) return String(v);
            return formatDate(d, fmt);
        }
        case 'DATE_TRUNC': {
            requireArgRange(expr, 2, 2);
            const part = String(evaluateScalar(expr.args[0], context, groupRows, windowScope)).toUpperCase();
            const v = evaluateScalar(expr.args[1], context, groupRows, windowScope);
            if (v == null) return null;
            const d = new Date(v);
            if (isNaN(d.getTime())) return null;
            switch (part) {
                case 'YEAR': return new Date(Date.UTC(d.getUTCFullYear(), 0, 1)).toISOString();
                case 'MONTH': return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
                case 'DAY': return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
                case 'HOUR': { const r = new Date(d); r.setUTCMinutes(0, 0, 0); return r.toISOString(); }
                default: return d.toISOString();
            }
        }
        case 'DATEADD': {
            requireArgRange(expr, 3, 3);
            const part = String(evaluateScalar(expr.args[0], context, groupRows, windowScope)).toUpperCase();
            const n = Number(evaluateScalar(expr.args[1], context, groupRows, windowScope));
            const v = evaluateScalar(expr.args[2], context, groupRows, windowScope);
            if (v == null || isNaN(n)) return null;
            const d = new Date(v);
            if (isNaN(d.getTime())) return null;
            switch (part) {
                case 'DAY': d.setUTCDate(d.getUTCDate() + n); break;
                case 'MONTH': d.setUTCMonth(d.getUTCMonth() + n); break;
                case 'YEAR': d.setUTCFullYear(d.getUTCFullYear() + n); break;
                case 'HOUR': d.setUTCHours(d.getUTCHours() + n); break;
                case 'MINUTE': d.setUTCMinutes(d.getUTCMinutes() + n); break;
                case 'SECOND': d.setUTCSeconds(d.getUTCSeconds() + n); break;
            }
            return d.toISOString();
        }
        case 'DATEDIFF': {
            requireArgRange(expr, 3, 3);
            const part = String(evaluateScalar(expr.args[0], context, groupRows, windowScope)).toUpperCase();
            const v1 = evaluateScalar(expr.args[1], context, groupRows, windowScope);
            const v2 = evaluateScalar(expr.args[2], context, groupRows, windowScope);
            if (v1 == null || v2 == null) return null;
            const d1 = new Date(v1); const d2 = new Date(v2);
            if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return null;
            const diffMs = d2.getTime() - d1.getTime();
            switch (part) {
                case 'DAY': return Math.floor(diffMs / 86400000);
                case 'HOUR': return Math.floor(diffMs / 3600000);
                case 'MINUTE': return Math.floor(diffMs / 60000);
                case 'SECOND': return Math.floor(diffMs / 1000);
                case 'MONTH': return (d2.getUTCFullYear() - d1.getUTCFullYear()) * 12 + (d2.getUTCMonth() - d1.getUTCMonth());
                case 'YEAR': return d2.getUTCFullYear() - d1.getUTCFullYear();
                default: return Math.floor(diffMs / 86400000);
            }
        }
        default:
            throw new QueryError(`Function "${expr.name}" is not supported yet.`);
    }
}

function safeJsonParse(s) {
    try { return JSON.parse(s); }
    catch { return null; }
}

function jsonExtractPath(obj, path, asText = false) {
    // Support JSON paths: $.key.sub, $[0], key, $.key[0]
    let current = obj;
    const cleanPath = path.startsWith('$.') ? path.substring(2) : path.startsWith('$') ? path.substring(1) : path;
    if (!cleanPath) return asText ? (typeof current === 'object' ? JSON.stringify(current) : String(current)) : current;
    const parts = cleanPath.match(/\[(\d+)\]|[^.\[\]]+/g) || [];
    for (const part of parts) {
        if (current == null) return null;
        if (part.startsWith('[') && part.endsWith(']')) {
            const idx = Number(part.slice(1, -1));
            current = Array.isArray(current) ? current[idx] : null;
        } else {
            current = typeof current === 'object' ? current[part] : null;
        }
    }
    if (current === undefined) return null;
    if (asText) return current == null ? null : (typeof current === 'object' ? JSON.stringify(current) : String(current));
    return current;
}

function applyDateModifier(date, modifier) {
    const normalized = modifier.trim().toLowerCase();
    const amountMatch = normalized.match(/^([+-]?\d+(?:\.\d+)?)\s+(second|minute|hour|day|month|year)s?$/);
    if (amountMatch) {
        const amount = Number(amountMatch[1]);
        switch (amountMatch[2]) {
            case 'second':
                date.setUTCSeconds(date.getUTCSeconds() + amount);
                return true;
            case 'minute':
                date.setUTCMinutes(date.getUTCMinutes() + amount);
                return true;
            case 'hour':
                date.setUTCHours(date.getUTCHours() + amount);
                return true;
            case 'day':
                date.setUTCDate(date.getUTCDate() + amount);
                return true;
            case 'month':
                date.setUTCMonth(date.getUTCMonth() + amount);
                return true;
            case 'year':
                date.setUTCFullYear(date.getUTCFullYear() + amount);
                return true;
        }
    }

    if (normalized === 'start of day') {
        date.setUTCHours(0, 0, 0, 0);
        return true;
    }
    if (normalized === 'start of month') {
        date.setUTCDate(1);
        date.setUTCHours(0, 0, 0, 0);
        return true;
    }
    if (normalized === 'start of year') {
        date.setUTCMonth(0, 1);
        date.setUTCHours(0, 0, 0, 0);
        return true;
    }

    const weekdayMatch = normalized.match(/^weekday\s+([0-6])$/);
    if (weekdayMatch) {
        const target = Number(weekdayMatch[1]);
        date.setUTCDate(date.getUTCDate() + ((target - date.getUTCDay() + 7) % 7));
        return true;
    }

    return false;
}

function formatDate(d, fmt) {
    return fmt
        .replace(/%Y/g, String(d.getUTCFullYear()))
        .replace(/%m/g, String(d.getUTCMonth() + 1).padStart(2, '0'))
        .replace(/%d/g, String(d.getUTCDate()).padStart(2, '0'))
        .replace(/%H/g, String(d.getUTCHours()).padStart(2, '0'))
        .replace(/%M/g, String(d.getUTCMinutes()).padStart(2, '0'))
        .replace(/%S/g, String(d.getUTCSeconds()).padStart(2, '0'))
        .replace(/%y/g, String(d.getUTCFullYear()).slice(-2))
        .replace(/yyyy/gi, String(d.getUTCFullYear()))
        .replace(/MM/g, String(d.getUTCMonth() + 1).padStart(2, '0'))
        .replace(/dd/gi, String(d.getUTCDate()).padStart(2, '0'));
}

function evaluateJsonObject(expr, context, groupRows, windowScope) {
    if (expr.args.length % 2 !== 0) throw new QueryError(`Function "${expr.name}" requires key/value argument pairs.`);
    const out = {};
    for (let i = 0; i < expr.args.length; i += 2) {
        const key = evaluateScalar(expr.args[i], context, groupRows, windowScope);
        out[String(key)] = evaluateScalar(expr.args[i + 1], context, groupRows, windowScope);
    }
    return out;
}

function evaluateAggregate(expr, rows) {
    return evaluateAggregateForSubjects(expr, rows.map((context, index) => ({ context, groupRows: null, index })));
}

function evaluateAggregateForSubjects(expr, subjects) {
    const filteredSubjects = expr.filter ? subjects.filter((subject) => truthy(evaluateBoolean(expr.filter, subject.context, subject.groupRows), subject.context?.dialect)) : subjects;
    let entries = expr.args[0]?.type === 'star' ? filteredSubjects.map((subject, index) => ({ ...subject, index, value: 1 })) : filteredSubjects.map((subject, index) => ({ ...subject, index, value: evaluateScalar(expr.args[0], subject.context, subject.groupRows) })).filter((entry) => entry.value !== null && entry.value !== undefined);

    if (expr.distinct) {
        const seen = new Set();
        entries = entries.filter((entry) => {
            const key = valueKey(entry.value);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    const aggregateOrderBy = expr.type === 'windowAggregate' ? expr.aggregateOrderBy : expr.orderBy;
    if (aggregateOrderBy?.length > 0) {
        entries = [...entries].sort((a, b) => {
            const dialect = a.context?.dialect || 'auto';
            for (const item of aggregateOrderBy) {
                const av = evaluateScalar(item.expr, a.context, a.groupRows);
                const bv = evaluateScalar(item.expr, b.context, b.groupRows);
                if (av == null && bv == null) continue;
                if (av == null || bv == null) {
                    return nullsSortFirst(item, dialect) === (av == null) ? -1 : 1;
                }
                const cmp = compareValues(av, bv, dialect);
                if (cmp !== 0) return item.direction === 'DESC' ? -cmp : cmp;
            }
            return a.index - b.index;
        });
    }

    const values = entries.map((entry) => entry.value);
    const dialect = subjects[0]?.context?.dialect || 'auto';
    const numericValues = values.map((value) => {
        if (dialect === 'sqlite') return sqliteNumericValue(value) ?? 0;
        return Number(value || 0);
    });
    switch (expr.name) {
        case 'COUNT':
            return expr.args[0]?.type === 'star' ? entries.length : values.length;
        case 'ARRAY_AGG':
            return values;
        case 'GROUP_CONCAT':
        case 'STRING_AGG': {
            const firstSubject = filteredSubjects[0] || { context: createContext([]), groupRows: null };
            const separator = expr.args[1] ? evaluateScalar(expr.args[1], firstSubject.context, firstSubject.groupRows) : ',';
            return values.map((value) => String(value)).join(separator == null ? ',' : String(separator));
        }
        case 'SUM':
            return values.length === 0 ? null : numericValues.reduce((sum, value) => sum + value, 0);
        case 'AVG':
            return values.length === 0 ? null : numericValues.reduce((sum, value) => sum + value, 0) / values.length;
        case 'MIN':
            return values.length === 0 ? null : values.reduce((min, value) => (compareValues(value, min, subjects[0]?.context?.dialect) < 0 ? value : min), values[0]);
        case 'MAX':
            return values.length === 0 ? null : values.reduce((max, value) => (compareValues(value, max, subjects[0]?.context?.dialect) > 0 ? value : max), values[0]);
        default:
            return null;
    }
}

function requireArgRange(expr, min, max = Infinity) {
    if (expr.args.length >= min && expr.args.length <= max) return;
    if (min === max) throw new QueryError(`Function "${expr.name}" requires ${min} argument(s).`);
    if (max === Infinity) throw new QueryError(`Function "${expr.name}" requires at least ${min} argument(s).`);
    throw new QueryError(`Function "${expr.name}" requires between ${min} and ${max} arguments.`);
}

function comparisonOptions(leftExpr, rightExpr, context) {
    return {
        dialect: context?.dialect || 'auto',
        leftAffinity: expressionAffinity(leftExpr, context),
        rightAffinity: expressionAffinity(rightExpr, context),
        leftType: expressionSqlType(leftExpr, context),
        rightType: expressionSqlType(rightExpr, context),
    };
}

function expressionSqlType(expr, context) {
    if (!expr || typeof expr !== 'object') return null;
    if (expr.type === 'cast' || expr.type === 'tryCast') return expr.targetType || null;
    if (expr.type !== 'column') return null;
    return resolveColumnMetadata(context, expr)?.type || null;
}

function expressionAffinity(expr, context) {
    if (!expr || typeof expr !== 'object') return null;
    if (expr.type === 'cast' || expr.type === 'tryCast') return sqliteAffinity(expr.targetType);
    if (expr.type !== 'column') return null;

    const column = resolveColumnMetadata(context, expr);
    return sqliteAffinity(column?.type);
}

function resolveColumnMetadata(context, expr) {
    if (!context || !expr?.name) return null;
    if (expr.qualifier) {
        const scope = context.scopes.get(expr.qualifier.toLowerCase());
        return scope?.table?.columns?.find((column) => column.name.toLowerCase() === expr.name.toLowerCase()) || null;
    }
    const matches = context.columns.filter((column) => column.columnName.toLowerCase() === expr.name.toLowerCase());
    return matches.length === 1 ? matches[0] : null;
}

function sqliteAffinity(type) {
    const normalized = String(type || '').toUpperCase();
    if (!normalized) return null;
    if (/CHAR|CLOB|TEXT/.test(normalized)) return 'text';
    if (/INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL|BOOLEAN|DATE|TIME/.test(normalized)) return 'numeric';
    return null;
}

function sqliteComparisonMode(leftAffinity, rightAffinity) {
    // SQLite applies affinity only when one side is a column/cast and the
    // other side has no affinity. If both sides are typed columns with
    // incompatible affinities, their storage classes are compared instead.
    if (leftAffinity === 'numeric' && (rightAffinity === 'text' || rightAffinity == null)) return 'numeric';
    if (rightAffinity === 'numeric' && (leftAffinity === 'text' || leftAffinity == null)) return 'numeric';
    if (leftAffinity === 'text' && rightAffinity == null) return 'text';
    if (rightAffinity === 'text' && leftAffinity == null) return 'text';
    return 'storage';
}

function sqliteNumericValue(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'boolean') return Number(value);
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) return null;
    const numeric = Number(normalized);
    return Number.isFinite(numeric) ? numeric : null;
}

function valuesEqual(left, right, { dialect = 'auto', leftAffinity = null, rightAffinity = null, leftType = null, rightType = null } = {}) {
    if (left === null || left === undefined || right === null || right === undefined) return false;
    if (dialect === 'sqlite') {
        const normalizedLeft = typeof left === 'boolean' ? Number(left) : left;
        const normalizedRight = typeof right === 'boolean' ? Number(right) : right;
        const mode = sqliteComparisonMode(leftAffinity, rightAffinity);
        if (mode === 'text') return String(normalizedLeft) === String(normalizedRight);
        if (mode === 'numeric') {
            const ln = sqliteNumericValue(normalizedLeft);
            const rn = sqliteNumericValue(normalizedRight);
            return ln != null && rn != null && ln === rn;
        }
        return typeof normalizedLeft === typeof normalizedRight && normalizedLeft === normalizedRight;
    }
    // Boolean coercion
    if (typeof left === 'boolean' || typeof right === 'boolean') return Boolean(left) === Boolean(right);
    if (typeof left === 'string' && typeof right === 'string') {
        const uuidComparison = /\bUUID\b/i.test(String(leftType || '')) || /\bUUID\b/i.test(String(rightType || ''));
        if (uuidComparison || dialect === 'mysql' || dialect === 'mssql') {
            return left.toLowerCase() === right.toLowerCase();
        }
        return left === right;
    }
    const ln = Number(left);
    const rn = Number(right);
    if (!Number.isNaN(ln) && !Number.isNaN(rn)) return ln === rn;
    return String(left) === String(right);
}

function valueKey(value) {
    return `${typeof value}:${String(value)}`;
}

function resolveColumn(context, expr) {
    if (!context) return undefined;

    if (expr.qualifier) {
        const scope = context.scopes.get(expr.qualifier.toLowerCase());
        if (!scope) {
            if (context.outer) return resolveColumn(context.outer, expr);
            throw new QueryError(`Unknown table or alias "${expr.qualifier}".`);
        }
        if (!scope.row) return null;
        const value = getRowValue(scope.row, expr.name);
        if (value === undefined && !scope.table.columns.some((col) => col.name.toLowerCase() === expr.name.toLowerCase())) {
            throw new QueryError(`Unknown column "${expr.qualifier}.${expr.name}".`);
        }
        return value;
    }

    const matches = context.columns.filter((col) => col.columnName.toLowerCase() === expr.name.toLowerCase());
    if (matches.length === 0) {
        if (context.outer) return resolveColumn(context.outer, expr);
        throw new QueryError(`Unknown column "${expr.name}".`);
    }
    if (matches.length > 1) throw new QueryError(`Column "${expr.name}" is ambiguous. Qualify it with a table or alias.`);
    return matches[0].value;
}

function expressionHasAggregate(expr) {
    if (!expr || typeof expr !== 'object') return false;
    if (expr.type === 'aggregate') return true;
    if (expr.type === 'windowAggregate') return expr.args?.some(expressionHasAggregate) || expr.orderBy?.some((item) => expressionHasAggregate(item.expr)) || expressionHasAggregate(expr.filter);
    if (expr.type === 'subquery') return false;
    return Object.values(expr).some((value) => {
        if (Array.isArray(value)) return value.some(expressionHasAggregate);
        return value && typeof value === 'object' && expressionHasAggregate(value);
    });
}

function findTable(tables, name) {
    if (!tables) return null;
    const clean = stripSchema(name).toLowerCase();
    for (const [key, table] of tables) {
        if (String(key).toLowerCase() === clean || table.name.toLowerCase() === clean) return table;
    }
    return null;
}

function getRowValue(row, name) {
    const key = Object.keys(row || {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key ? row[key] : undefined;
}

function numericOrConcat(left, right) {
    const ln = Number(left);
    const rn = Number(right);
    if (!Number.isNaN(ln) && !Number.isNaN(rn)) return ln + rn;
    return `${left}${right}`;
}

function truthy(value, dialect = 'auto') {
    if (value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true') return true;
    if (dialect === 'sqlite' || dialect === 'mysql') {
        if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
        if (typeof value === 'string') {
            const numeric = Number(value.trim());
            return !Number.isNaN(numeric) && numeric !== 0;
        }
    }
    return false;
}

function likeRegex(pattern, caseInsensitive = false) {
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i];
        if (char === '\\' && i + 1 < pattern.length) {
            const next = pattern[i + 1];
            if (next === '%' || next === '_' || next === '\\') {
                out += escapeRegex(next);
                i++;
                continue;
            }
        }
        if (char === '%') {
            out += '.*';
            continue;
        }
        if (char === '_') {
            out += '.';
            continue;
        }
        out += escapeRegex(char);
    }
    return new RegExp(`^${out}$`, caseInsensitive ? 'i' : '');
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
