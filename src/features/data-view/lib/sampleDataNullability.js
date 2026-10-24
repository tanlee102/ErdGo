/** Bounded inference for CHECKs composed entirely of IS [NOT] NULL, AND and OR. */
import { tokenize } from '@/lib/parse-ast/tokenize';

const MAX_PATTERNS = 32;

function minimize(patterns) {
    // Drop covered branches, then merge complementary predicates. A tautology
    // must not force NULLs that the user's sampling percentage would avoid.
    const result = patterns.filter((pattern, index) => !patterns.some((other, otherIndex) =>
        otherIndex !== index && (other.size < pattern.size || otherIndex < index) &&
        [...other].every(([name, value]) => pattern.has(name) && pattern.get(name) === value),
    ));
    for (let i = 0; i < result.length; i++) for (let j = i + 1; j < result.length; j++) {
        const a = result[i]; const b = result[j];
        if (a.size !== b.size || [...a.keys()].some(name => !b.has(name))) continue;
        const different = [...a.keys()].filter(name => a.get(name) !== b.get(name));
        if (different.length === 1) return minimize([
            ...result.filter((_, index) => index !== i && index !== j),
            new Map([...a].filter(([name]) => name !== different[0])),
        ]);
    }
    return result;
}

function combine(left, right) {
    if (left.length * right.length > MAX_PATTERNS) return null;
    const result = [];
    for (const a of left) for (const b of right) {
        if ([...b].some(([name, value]) => a.has(name) && a.get(name) !== value)) continue;
        result.push(new Map([...a, ...b]));
    }
    return result;
}

function parseNullCheck(expression, columns) {
    const { tokens, errors } = tokenize(expression, { keywords: ['IS', 'NOT', 'NULL', 'AND', 'OR'] });
    if (errors.length) return null;
    let index = 0; let depth = 0;
    const word = value => tokens[index]?.type === 'KW' && String(tokens[index].value).toUpperCase() === value;
    const punctuation = value => tokens[index]?.type === 'PUNC' && tokens[index].value === value;
    function term() {
        if (punctuation('(')) {
            if (++depth > 32) return null;
            index++;
            const result = or();
            if (!result || !punctuation(')')) return null;
            index++; depth--;
            return result;
        }
        const token = tokens[index];
        if (!token || !['IDENT', 'KW'].includes(token.type)) return null;
        const column = columns.get(String(token.value).toLowerCase());
        if (!column) return null;
        index++;
        if (!word('IS')) return null;
        index++;
        const nonNull = word('NOT');
        if (nonNull) index++;
        if (!word('NULL')) return null;
        index++;
        return [new Map([[column.name, !nonNull]])];
    }
    function and() {
        let result = term();
        while (result && word('AND')) {
            index++;
            const right = term();
            if (!right) return null;
            result = combine(result, right);
        }
        return result;
    }
    function or() {
        let result = and();
        while (result && word('OR')) {
            index++;
            const right = and();
            if (!right || result.length + right.length > MAX_PATTERNS) return null;
            result = [...result, ...right];
        }
        return result;
    }
    const result = or();
    return index === tokens.length ? result : null;
}

export function inferSampleNullability(columns, expressions) {
    const byName = new Map(columns.map(column => [column.name.toLowerCase(), column]));
    let patterns = [new Map()]; let inferred = false;
    for (const expression of expressions) {
        if (!/\bIS\s+(?:NOT\s+)?NULL\b/i.test(expression)) continue;
        const parsed = parseNullCheck(expression, byName);
        // Never infer one branch of an unsupported expression. The executor
        // still validates every CHECK, including expressions outside this grammar.
        if (!parsed) continue;
        const combined = combine(patterns, parsed);
        if (!combined) return undefined;
        patterns = minimize(combined); inferred = true;
    }
    if (!inferred) return undefined;
    const valid = minimize(patterns.filter(pattern => ![...pattern].some(([name, isNull]) => {
        const column = byName.get(name.toLowerCase());
        return isNull && (column.notNull || column.pk || column.autoIncrement);
    })));
    return valid.length === 1 && valid[0].size === 0 ? undefined : valid.map(pattern => Object.fromEntries(pattern));
}
